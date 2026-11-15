// Combine files: its own workspace (page.combine) with the list of files to combine, in order, each with
// the pages to take; Add files through the system Open dialog (several at once), Remove, Move up and down,
// the pages of each file, Unlock for a password-protected one, Undo and Redo of the list, and Combine.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:187                page.combine, Needs::Nothing
//   crates/ui-egui/src/workflows/combine_ui.rs, combine_ui/actions.rs, files.rs, view.rs
//                                                    the list, selecting rows like files in a file manager, moving,
//                                                    removing, sorting, Unlock, the undo history (100 steps), "Leave
//                                                    out files that can't be read?", the Combine button
//   crates/engine/src/sources.rs, session/files.rs   what a file may be combined for; page ranges; one bookmark per file
// The grid view (page cards), drag and drop of rows, sort by column, duplicate warnings, Add open documents and
// Options are not translated: hidden (docs/spec/patches/folio/combine.json).
//
// The list lives in the document's view state (names, sizes, pages, ranges, problems: no bytes); the files'
// bytes and passwords are kept in memory only, for as long as the window is open: a password is never written
// anywhere, logged or put in the view.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/combine.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {readOther, writeOther, interactive, readState, writeState, stem, baseName} from '../lib/page-files.mjs';
import {readSource, combineFiles, MAX_FILES} from '../lib/combine.mjs';
import {optimizePdf, DEFAULTS as OPTIMIZE} from '../lib/optimize.mjs';
import {parseRanges} from './page.mjs';
import {createPdfContent} from '../../pdf-document.mjs';
import {migrateContent} from '../migrate.mjs';
import {PDF_MAX_BYTES} from '../../pdf-model.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/workflows/combine_ui.rs', 'crates/ui-egui/src/workflows/combine_ui/actions.rs',
    'crates/ui-egui/src/workflows/combine_ui/files.rs', 'crates/ui-egui/src/workflows/combine_ui/view.rs', 'crates/engine/src/sources.rs', 'crates/engine/src/session/files.rs']};

const HISTORY = 100;
const MAX_FILE_BYTES = 30_000_000;

/** The files' bytes and passwords: memory only, by window and entry. */
const held = new Map();
const keyOf = (ctx, id) => `${ctx.docId ?? ''}|${id}`;

const emptyTab = () => ({open: false, files: [], selected: [], undo: [], redo: [], next: 1});
const tabOf = ctx => ({...emptyTab(), ...(ctx.view?.combine ?? {})});
const snapshot = tab => JSON.parse(JSON.stringify(tab.files));

/** Record the list for Undo before it changes (redo is dropped, the history kept to 100 steps). */
function record(tab) {
  tab.undo = [...tab.undo, snapshot(tab)].slice(-HISTORY);
  tab.redo = [];
}
const save = (ctx, tab) => { ctx.setView({combine: tab}); return tab; };

const entryOf = (name, size, r, range = '') => ({name, size, pages: r.pages, range, problem: r.problem, message: r.message});

/** Why a file is flagged in the list (printcraft's row warning). */
export const warningOf = f => (f.problem ? `${f.name} ${f.message}` : null);

function rows(tab, ids) {
  const want = ids?.length ? new Set(ids) : new Set(tab.selected);
  return tab.files.filter(f => want.has(f.id));
}

const idsParam = s.optional(s.array(s.integer({min: 1, max: 1e9}), {max: 100000, description: 'File ids in the list (default: the selected files)'}));
const source = s.object({modified: s.optional(s.number({description: 'When the file was last changed (ms since 1970), for sorting by Modified'})), path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 45_000_000})), name: s.optional(s.string({min: 1, max: 500})),
  range: s.optional(s.string({max: 1000})), password: s.optional(s.secret({max: 1000}))});

async function addSources(ctx, list) {
  const tab = tabOf(ctx);
  if (tab.files.length + list.length > MAX_FILES) throw new CommandError('too_large', `Combine files takes up to ${MAX_FILES} files`);
  record(tab);
  const added = [];
  for (const item of list) {
    const file = await readOther(ctx, item.path || item.base64 ? item : {...item}, {title: 'Add files to combine'});
    if (!file) continue;
    if (file.bytes.length > MAX_FILE_BYTES) throw new CommandError('too_large', `${file.name} is over 30 MB`);
    const r = await readSource(file.bytes, item.password ?? '');
    let range = String(item.range ?? '').trim();
    if (range && r.pages) { try { parseRanges(range, r.pages); } catch (e) { throw new CommandError('invalid_params', `${file.name}: ${e.message}`, {path: '/range'}); } }
    const id = tab.next++;
    held.set(keyOf(ctx, id), {bytes: file.bytes, password: item.password ?? ''});
    const entry = {id, ...entryOf(file.name, file.bytes.length, r, range), modified: Number.isFinite(item.modified) ? item.modified : null};
    tab.files.push(entry);
    added.push(entry.id);
  }
  tab.selected = added;
  if (!added.length) { tab.undo = tab.undo.slice(0, -1); }
  save(ctx, tab);
  return added;
}

const state = ctx => ({enabled: true, checked: false, ...(ctx.view?.combine?.open ? {checked: true} : {})});

export default defineCommands({
  family: 'combine', app: 'folio', upstream: UPSTREAM,
  commands: [
    {
      id: 'page.combine', label: 'Combine files…', risk: 'read', effect: 'view', undo: 'none',
      description: 'Combine files: open the Combine files workspace (the list of files to combine, in order, with the pages to take from each). `files` ([{path | base64, name?, range?, password?}]) adds those files to the list at once.',
      params: s.object({files: s.optional(s.array(source, {max: 1000}))}),
      state: () => ({enabled: true}),
      async run(ctx, p) {
        const tab = tabOf(ctx);
        tab.open = true;
        save(ctx, tab);
        const added = p.files?.length ? await addSources(ctx, p.files) : [];
        return {open: true, files: tabOf(ctx).files.length, added};
      },
    },
    {
      id: 'combine.close', label: 'Close Combine files', risk: 'read', effect: 'view', undo: 'none',
      description: 'Close the Combine files workspace; the list is kept for when it is opened again.',
      params: s.object({}),
      state: () => ({enabled: true}),
      run(ctx) { const tab = tabOf(ctx); tab.open = false; save(ctx, tab); return {open: false}; },
    },
    {
      id: 'combine.read', label: 'Read the Combine files list', risk: 'read', effect: 'view', undo: 'none',
      description: 'The files in the Combine files list: id, name, size, pages, page range, what stops it being combined; the selection; whether undo and redo have steps.',
      params: s.object({}),
      state: () => ({enabled: true}),
      run(ctx) {
        const t = tabOf(ctx);
        return {open: t.open, files: t.files.map(f => ({...f, warning: warningOf(f)})), selected: t.selected, canUndo: t.undo.length > 0, canRedo: t.redo.length > 0};
      },
    },
    {
      id: 'combine.add', label: 'Add files…', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Add files to combine: `files` ([{path | base64, name?, range?, password?}]), or, from the window, several files picked in the system Open dialog. Each is checked: a file that needs a password, has the wrong one, forbids assembling pages or can\'t be read stays in the list with the reason and is left out of the combine until fixed. The added files are selected.',
      params: s.object({files: s.optional(s.array(source, {max: 1000}))}),
      state: ctx => readState(ctx),
      async run(ctx, p) {
        let list = p.files;
        if (!list?.length) {
          if (!interactive(ctx)) throw new CommandError('invalid_params', 'files is required: programmatic calls never open the Open dialog', {path: '/files'});
          const f = ctx.host?.files;
          if (typeof f?.pickOpen !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
          const picked = await f.pickOpen({kind: ctx.app, doc: ctx.docId, title: 'Add files to combine', filters: [{name: 'Adobe PDF Files', extensions: ['pdf']}], multiple: true});
          const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
          if (!paths.length) return {added: []};
          list = paths.map(path => ({path}));
        }
        return {added: await addSources(ctx, list)};
      },
    },
    {
      id: 'combine.select', label: 'Select files', risk: 'read', effect: 'view', undo: 'none',
      description: 'Select files in the list, as in a file manager: `ids` replace the selection, or with `mode` "toggle" (Ctrl or Command click) add or remove them, or "range" (Shift click) select from the last selected one to the first of `ids`; "all" selects every file.',
      params: s.object({ids: s.optional(s.array(s.integer({min: 1, max: 1e9}), {max: 100000})), mode: s.optional(s.enum(['replace', 'toggle', 'range', 'all']))}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const tab = tabOf(ctx);
        const all = tab.files.map(f => f.id);
        const ids = (p.ids ?? []).filter(i => all.includes(i));
        const mode = p.mode ?? 'replace';
        if (mode === 'all') tab.selected = all;
        else if (mode === 'toggle') { const set = new Set(tab.selected); for (const i of ids) { if (!set.delete(i)) set.add(i); } tab.selected = all.filter(i => set.has(i)); }
        else if (mode === 'range' && ids.length) {
          const anchor = all.indexOf(tab.selected.at(-1) ?? ids[0]);
          const to = all.indexOf(ids[0]);
          tab.selected = all.slice(Math.min(anchor, to), Math.max(anchor, to) + 1);
        } else tab.selected = all.filter(i => ids.includes(i));
        save(ctx, tab);
        return {selected: tab.selected};
      },
    },
    {
      id: 'combine.remove', label: 'Remove', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Remove files from the list (`ids`, else the selected ones). Undo brings them back.',
      params: s.object({ids: idsParam}),
      state: ctx => (tabOf(ctx).selected.length ? {enabled: true} : {enabled: false, reason: 'select a file first'}),
      run(ctx, p) {
        const tab = tabOf(ctx);
        const gone = rows(tab, p.ids).map(f => f.id);
        if (!gone.length) return {removed: 0};
        record(tab);
        tab.files = tab.files.filter(f => !gone.includes(f.id));
        tab.selected = tab.selected.filter(i => !gone.includes(i));
        save(ctx, tab);
        return {removed: gone.length};
      },
    },
    {
      id: 'combine.move', label: 'Move files', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Move the selected files (or `ids`) up (`by` -1) or down (+1) one place; a block of selected files moves together and each steps past its unselected neighbour.',
      params: s.object({by: s.integer({min: -1, max: 1}), ids: idsParam}),
      state(ctx, p) {
        const tab = tabOf(ctx);
        const sel = tab.files.map(f => tab.selected.includes(f.id));
        const up = (p?.by ?? -1) < 0;
        const movable = up ? sel.slice(sel.findIndex(x => !x)).some(Boolean) && sel.some(Boolean) : [...sel].reverse().slice([...sel].reverse().findIndex(x => !x)).some(Boolean);
        return movable ? {enabled: true} : {enabled: false, reason: up ? 'the selected files are already first' : 'the selected files are already last'};
      },
      run(ctx, p) {
        if (!p.by) return {moved: false};
        const tab = tabOf(ctx);
        const want = new Set(p.ids?.length ? p.ids : tab.selected);
        const list = [...tab.files];
        const before = list.map(f => f.id).join();
        if (p.by < 0) { for (let i = 1; i < list.length; i++) if (want.has(list[i].id) && !want.has(list[i - 1].id)) [list[i], list[i - 1]] = [list[i - 1], list[i]]; }
        else for (let i = list.length - 2; i >= 0; i--) if (want.has(list[i].id) && !want.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]];
        if (list.map(f => f.id).join() === before) return {moved: false};
        record(tab);
        tab.files = list;
        tab.sort = null;   // an order made by hand is not sorted any more
        save(ctx, tab);
        return {moved: true, order: list.map(f => f.id)};
      },
    },
    {
      id: 'combine.range', label: 'Pages of a file', risk: 'edit', effect: 'view', undo: 'none',
      description: 'The pages to take from a file: `range` such as "1-3, 6" (empty: all its pages).',
      params: s.object({id: s.integer({min: 1, max: 1e9}), range: s.string({max: 1000})}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const tab = tabOf(ctx);
        const f = tab.files.find(x => x.id === p.id);
        if (!f) throw new CommandError('not_found', `no file ${p.id} in the list`, {path: '/id'});
        const range = p.range.trim();
        if (range && f.pages) { try { parseRanges(range, f.pages); } catch (e) { throw new CommandError('invalid_params', `${f.name}: ${e.message}`, {path: '/range'}); } }
        if (f.range === range) return {range};
        record(tab);
        f.range = range;
        save(ctx, tab);
        return {range};
      },
    },
    {
      id: 'combine.unlock', label: 'Unlock…', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Unlock a password-protected file of the list with its password (the open password, or the permissions password to lift a restriction on assembling pages): `id` (default: the first selected locked file). A wrong password leaves it locked. The password is kept in memory only.',
      params: s.object({id: s.optional(s.integer({min: 1, max: 1e9})), password: s.secret({max: 1000})}),
      state(ctx) { const t = tabOf(ctx); return t.files.some(f => ['password', 'wrong-password', 'not-permitted'].includes(f.problem)) ? {enabled: true} : {enabled: false, reason: 'no file in the list is locked'}; },
      async run(ctx, p) {
        const tab = tabOf(ctx);
        const locked = tab.files.filter(f => ['password', 'wrong-password', 'not-permitted'].includes(f.problem));
        const f = p.id ? tab.files.find(x => x.id === p.id) : tab.files.find(x => tab.selected.includes(x.id) && locked.includes(x)) ?? locked[0];
        if (!f) throw new CommandError('not_found', 'no locked file in the list', {path: '/id'});
        const bytes = held.get(keyOf(ctx, f.id))?.bytes;
        if (!bytes) throw new CommandError('failed', `${f.name} is no longer held: add it again`);
        const r = await readSource(bytes, p.password);
        if (r.problem === 'wrong-password' || r.problem === 'password') throw new CommandError('invalid_params', 'The password is incorrect.', {path: '/password'});
        record(tab);
        held.set(keyOf(ctx, f.id), {bytes, password: p.password});
        Object.assign(f, {pages: r.pages, problem: r.problem, message: r.message});
        tab.selected = [f.id];
        save(ctx, tab);
        return {unlocked: !r.problem, problem: r.problem};
      },
    },
    {
      id: 'combine.undo', label: 'Undo', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Undo the last change to the Combine files list.',
      params: s.object({}),
      state: ctx => (tabOf(ctx).undo.length ? {enabled: true} : {enabled: false, reason: 'nothing to undo'}),
      run(ctx) {
        const tab = tabOf(ctx);
        const prev = tab.undo.at(-1);
        if (!prev) return {undone: false};
        tab.redo = [...tab.redo, snapshot(tab)];
        tab.files = prev;
        tab.undo = tab.undo.slice(0, -1);
        tab.selected = tab.selected.filter(i => tab.files.some(f => f.id === i));
        save(ctx, tab);
        return {undone: true};
      },
    },
    {
      id: 'combine.redo', label: 'Redo', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Redo the last undone change to the Combine files list.',
      params: s.object({}),
      state: ctx => (tabOf(ctx).redo.length ? {enabled: true} : {enabled: false, reason: 'nothing to redo'}),
      run(ctx) {
        const tab = tabOf(ctx);
        const next = tab.redo.at(-1);
        if (!next) return {redone: false};
        tab.undo = [...tab.undo, snapshot(tab)].slice(-HISTORY);
        tab.files = next;
        tab.redo = tab.redo.slice(0, -1);
        tab.selected = tab.selected.filter(i => tab.files.some(f => f.id === i));
        save(ctx, tab);
        return {redone: true};
      },
    },
    {
      id: 'combine.go', label: 'Combine', risk: 'edit', needs: 'worker',
      description: 'Combine the files of the list, in order, into one PDF: the pages of each file\'s range, one bookmark per file, fields whose names collide renamed. A file that can\'t be combined stops it (`skipUnreadable` leaves such files out, as "Combine the rest" does). The result becomes this document when it is empty, else it is written to `path` or the file picked in the system Save dialog; without either from a program the bytes come back as `base64`.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), skipUnreadable: s.optional(s.boolean()), name: s.optional(s.string({min: 1, max: 200}))}),
      state(ctx) {
        const t = tabOf(ctx);
        if (!t.files.length) return {enabled: false, reason: 'add files to combine first'};
        return writeState(ctx);
      },
      async run(ctx, p) {
        const tab = tabOf(ctx);
        let skip = !!p.skipUnreadable;
        const bad = tab.files.filter(f => f.problem);
        if (bad.length && !skip) {
          if (interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
            const v = await ctx.host.openDialog('dialog.combine-unreadable', {files: bad.map(warningOf).join('\n')});
            if (!v) throw new CommandError('canceled', 'Canceled');
            skip = true;
          } else throw new CommandError('failed', `${warningOf(bad[0])}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}`, {files: bad.map(f => f.id)});
        }
        const sources = tab.files.map(f => ({name: f.name, bytes: held.get(keyOf(ctx, f.id))?.bytes, password: held.get(keyOf(ctx, f.id))?.password, range: f.range}));
        if (sources.some(x => !x.bytes)) throw new CommandError('failed', 'A file of the list is no longer held: add it again');
        let result;
        const options = {bookmarks: true, blankAfterOdd: false, size: 'default', ...(tab.options ?? {})};
        try { result = await combineFiles(sources, {skipUnreadable: skip, bookmarks: options.bookmarks !== false, blankAfterOdd: options.blankAfterOdd === true}); } catch (e) { throw new CommandError(e.problem ? 'failed' : 'invalid_params', e.message); }
        if (options.size === 'smaller') { const o = await optimizePdf(result.bytes, OPTIMIZE); if (o.after < o.before) result = {...result, bytes: o.bytes}; }
        if (result.bytes.length > PDF_MAX_BYTES && !(ctx.doc?.pages?.length)) throw new CommandError('too_large', 'The combined PDF would exceed the 10 MB limit: combine fewer files or pages');
        const out = {pages: result.pages, files: result.files, renamedFields: result.renamedFields, skipped: result.skipped};
        if (!ctx.doc?.pages?.length && !ctx.doc?.locked) {
          const base = await createPdfContent(result.bytes, p.name ?? 'Combined.pdf');
          const next = await migrateContent(base);
          for (const [k, v] of Object.entries(next)) ctx.change.set([k], v);
          ctx.setUndoLabel('Combine files');
          for (const f of tab.files) held.delete(keyOf(ctx, f.id));
          ctx.setView({combine: {...emptyTab(), open: false}});
          return {...out, opened: true};
        }
        const w = await writeOther(ctx, p, result.bytes, {title: 'Save the combined PDF', name: p.name ?? 'Combined.pdf'});
        if (w.canceled) return {canceled: true};
        return {...out, path: w.path, ...(w.base64 ? {base64: w.base64} : {})};
      },
    },
  ],
});

/** The bytes of a file of the list (memory only), for the grid's thumbnails: {bytes, password} or null. */
export const heldFile = (docId, id) => held.get(`${docId ?? ''}|${id}`) ?? null;

export {state as combineState, stem, baseName};
// For combine_more.mjs: the list's history and storage.
export {record as recordCombine, tabOf as combineTab, save as saveCombine, addSources as addCombineSources, held as heldFiles, keyOf as heldKey};
