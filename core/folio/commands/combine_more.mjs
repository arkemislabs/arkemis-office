// Combine files, the list's order and columns: Sort by a column, drag a file (a row or a grid card) to a new place, the columns' order and Reset columns, Add folder (and
// subfolders), and the Combine options.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/workflows/combine_ui/files.rs      SortKey (Name, Pages, Size, Modified, Warnings), Columns (the order and widths, Reset columns), `severity`
//                                                         (0 can't be combined, 1 has warnings, 2 fine: the Warnings column's order)
//   crates/ui-egui/src/workflows/combine_ui/actions.rs    RowAction::Sort (a second click on the same column reverses it; sorting is one undo step), Drop and DropAt (dragging a
//                                                         selected file takes the whole selection along; dropped on the selection nothing happens; "below the row when dragged
//                                                         down, above it when dragged up"; a hand-made order is not sorted any more)
//   crates/ui-egui/src/workflows/combine_ui/session.rs    combine_sort (natural order for names; unknown times last whichever the direction; ties by name), combine_move_to_gap,
//                                                         combine_add_folder, add_folder_to_combine ("No PDFs ... found in {folder}", "Added the first {n} files in {folder}")
//   crates/ui-egui/src/workflows/combine_ui/parts.rs      combinable_in (the files of a folder in natural order, subfolders when asked, not hidden ones), natural
// Not translated: images and text files joining the list (the folder adds the PDFs in it), Add open documents (the other documents of the window are not reachable from
// one document), column widths. The Combine options (bookmarks, a blank page after an odd file, the file size) are Acrobat's, not printcraft's: not checked against upstream.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/combine-more.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {interactive} from '../lib/page-files.mjs';
import {recordCombine as record, combineTab as tabOf, saveCombine as save, addCombineSources as addSources} from './combine.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/workflows/combine_ui/files.rs', 'crates/ui-egui/src/workflows/combine_ui/actions.rs',
  'crates/ui-egui/src/workflows/combine_ui/session.rs', 'crates/ui-egui/src/workflows/combine_ui/parts.rs']};

export const SORT_KEYS = ['name', 'pages', 'size', 'modified', 'warnings'];
/** The list's columns in their order (files.rs Columns::default, with this window's Take pages beside Pages). */
export const COLUMNS = ['name', 'pages', 'take', 'size', 'modified', 'warnings'];
export const COLUMN_LABELS = {name: 'File name', pages: 'Pages', take: 'Take pages', size: 'Size', modified: 'Modified', warnings: 'Warnings'};
export const MAX_FOLDER_FILES = 1000;

/** parts.rs `natural`: case-insensitive, numbers by value ("scan2" before "scan10"). */
export function natural(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (/\d/.test(x[i]) && /\d/.test(y[j])) {
      let ei = i, ej = j;
      while (ei < x.length && /\d/.test(x[ei])) ei++;
      while (ej < y.length && /\d/.test(y[ej])) ej++;
      const na = x.slice(i, ei).replace(/^0+(?=\d)/, ''), nb = y.slice(j, ej).replace(/^0+(?=\d)/, '');
      if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
      if (na !== nb) return na < nb ? -1 : 1;
      i = ei; j = ej;
    } else {
      if (x[i] !== y[j]) return x[i] < y[j] ? -1 : 1;
      i++; j++;
    }
  }
  return (x.length - i) - (y.length - j) < 0 ? -1 : (x.length - i) - (y.length - j) > 0 ? 1 : 0;
}

/** files.rs `severity`: 0 can't be combined, 1 has warnings, 2 fine. */
export const severity = f => (f.problem ? 0 : f.note ? 1 : 2);

/** session.rs `combine_sort`: the files in the order of `key`, ties by name; unknown times last whichever the direction. */
export function sorted(files, key, ascending) {
  const list = files.map(f => ({f, sev: severity(f)}));
  list.sort((A, B) => {
    const a = A.f, b = B.f;
    let order;
    switch (key) {
      case 'name': order = natural(a.name, b.name); break;
      case 'pages': order = (a.pages ?? 0) - (b.pages ?? 0); break;
      case 'size': order = (a.size ?? 0) - (b.size ?? 0); break;
      case 'modified': {
        const x = Number.isFinite(a.modified) ? a.modified : null, y = Number.isFinite(b.modified) ? b.modified : null;
        if (x === null || y === null) return (x === null) - (y === null) || natural(a.name, b.name);
        order = x - y;
        break;
      }
      default: order = A.sev - B.sev;
    }
    return (ascending ? order : -order) || natural(a.name, b.name);
  });
  return list.map(x => x.f);
}

/** session.rs `combine_move_to_gap`: the moving files, in their order, put at `gap` (0 before the first file, n after the last) of the others. */
export function movedToGap(files, moving, gap) {
  const set = new Set(moving);
  const take = files.filter(f => set.has(f.id));
  const rest = files.filter(f => !set.has(f.id));
  const before = files.slice(0, Math.max(0, Math.min(gap, files.length))).filter(f => set.has(f.id)).length;
  const at = Math.max(0, Math.min(rest.length, gap - before));
  return [...rest.slice(0, at), ...take, ...rest.slice(at)];
}

const columnsOf = tab => (Array.isArray(tab.columns) && COLUMNS.every(c => tab.columns.includes(c)) && tab.columns.length === COLUMNS.length ? tab.columns : COLUMNS);
const open = ctx => (ctx.view?.combine?.open ? {enabled: true} : {enabled: false, reason: 'Combine files is not open'});
const hasFiles = ctx => { const st = open(ctx); return st.enabled ? (tabOf(ctx).files.length > 1 ? st : {enabled: false, reason: 'there is only one file to put in order'}) : st; };

export default defineCommands({
  family: 'combine_more',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'combine.sort', label: 'Sort files', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Sort the list by a column (`key`: name, pages, size, modified or warnings). A second click on the column sorts the other way round (`ascending` says which); names sort in natural order ("scan2" before "scan10"), files with an unknown time are last whichever way, ties go by name, and Warnings puts the files that can\'t be combined first. One undo step; moving a file by hand ends the sorting.',
      params: s.object({key: s.enum(SORT_KEYS), ascending: s.optional(s.boolean())}),
      state: hasFiles,
      run(ctx, p) {
        const tab = tabOf(ctx);
        const ascending = p.ascending ?? !(tab.sort?.key === p.key && tab.sort.ascending);
        record(tab);
        tab.files = sorted(tab.files, p.key, ascending);
        tab.sort = {key: p.key, ascending};
        save(ctx, tab);
        return {sort: tab.sort, order: tab.files.map(f => f.id)};
      },
    },
    {
      id: 'combine.drop', label: 'Move files to a place', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Drag a file to a new place: `file` is the file dragged (the whole selection goes with it when it is selected); `onto` drops it on another file\'s row (below it when dragged down, above it when dragged up), `gap` between files (0 before the first, n after the last: a card dropped in the grid). Dropped on the selection itself nothing happens. One undo step; the order made by hand is not sorted any more.',
      params: s.object({file: s.integer({min: 1, max: 1e9}), onto: s.optional(s.integer({min: 1, max: 1e9})), gap: s.optional(s.integer({min: 0, max: 100000}))}),
      state: hasFiles,
      run(ctx, p) {
        const tab = tabOf(ctx);
        const ids = tab.files.map(f => f.id);
        const from = ids.indexOf(p.file);
        if (from < 0) throw new CommandError('not_found', `no file ${p.file} in the list`, {path: '/file'});
        const moving = tab.selected.includes(p.file) ? tab.selected : [p.file];
        let gap;
        if (p.onto !== undefined) {
          const to = ids.indexOf(p.onto);
          if (to < 0) throw new CommandError('not_found', `no file ${p.onto} in the list`, {path: '/onto'});
          if (moving.includes(p.onto)) return {moved: false};
          gap = from < to ? to + 1 : to;
        } else if (p.gap !== undefined) gap = Math.min(p.gap, ids.length);
        else throw new CommandError('invalid_params', 'give `onto` or `gap`');
        const next = movedToGap(tab.files, moving, gap);
        if (next.map(f => f.id).join() === ids.join()) return {moved: false};
        record(tab);
        tab.files = next;
        tab.sort = null;
        save(ctx, tab);
        return {moved: true, order: next.map(f => f.id)};
      },
    },
    {
      id: 'combine.columns', label: 'Columns', risk: 'read', effect: 'view', undo: 'none',
      description: 'The list\'s columns: `order` puts them in that order (all of name, pages, take, size, modified, warnings, each once; a column dragged to a new place); `reset` puts them back (Reset columns).',
      params: s.object({order: s.optional(s.array(s.enum(COLUMNS), {min: 6, max: 6})), reset: s.optional(s.boolean())}),
      state(ctx, p) { const st = open(ctx); return st.enabled && p?.reset && columnsOf(tabOf(ctx)).join() === COLUMNS.join() ? {enabled: false, reason: 'the columns are already in their usual order'} : st; },
      run(ctx, p) {
        const tab = tabOf(ctx);
        if (p.reset) tab.columns = undefined;
        else if (p.order) {
          if (new Set(p.order).size !== COLUMNS.length) throw new CommandError('invalid_params', 'name every column once', {path: '/order'});
          tab.columns = p.order;
        } else return {columns: columnsOf(tab)};
        save(ctx, tab);
        return {columns: columnsOf(tab)};
      },
    },
    {
      id: 'combine.options', label: 'Options…', risk: 'read', effect: 'view', undo: 'none', dialog: 'dialog.combine-options',
      description: 'Combine options: `bookmarks` (one bookmark per file, on), `blankAfterOdd` (a blank page after a file that adds an odd number of pages, for double-sided printing, off) and `size` ("default", or "smaller" to save the combined file with the optimizer\'s structural settings). They apply to the next Combine. Not checked against upstream (printcraft has no options).',
      params: s.object({bookmarks: s.optional(s.boolean()), blankAfterOdd: s.optional(s.boolean()), size: s.optional(s.enum(['default', 'smaller']))}),
      state: open,
      run(ctx, p) {
        const tab = tabOf(ctx);
        const options = {bookmarks: true, blankAfterOdd: false, size: 'default', ...(tab.options ?? {})};
        for (const k of ['bookmarks', 'blankAfterOdd', 'size']) if (p[k] !== undefined) options[k] = p[k];
        tab.options = options;
        save(ctx, tab);
        return {options};
      },
    },
    {
      id: 'combine.add_folder', label: 'Add folder…', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Add the PDFs in a folder to the list (and, with `recursive`, in the folders inside it; hidden folders are left out), in natural order, up to 1000, as one undo step. From the window the system folder dialog asks for the folder. A program passes the files it read: `files` ([{name, base64, modified?}]). Images and text files are not added.',
      params: s.object({recursive: s.optional(s.boolean()), folder: s.optional(s.string({max: 500})),
        files: s.optional(s.array(s.object({name: s.string({min: 1, max: 500}), base64: s.string({max: 45_000_000}), modified: s.optional(s.number())}), {max: 1000}))}),
      state(ctx) { return open(ctx).enabled ? {enabled: true} : {enabled: true}; },
      async run(ctx, p) {
        let list = p.files, folder = p.folder ?? 'the folder', more = false;
        if (!list) {
          const f = ctx.host?.files;
          if (!interactive(ctx)) throw new CommandError('invalid_params', 'give the PDFs as `files`', {path: '/files'});
          if (typeof f?.pickFolder !== 'function' || typeof f?.readFolderPdfs !== 'function') throw new CommandError('unavailable', "this build can't read a folder yet");
          const picked = await f.pickFolder({kind: ctx.app, title: p.recursive ? 'Add folder and subfolders' : 'Add folder'});
          if (!picked) return {added: [], canceled: true};
          const r = await f.readFolderPdfs({folder: picked.folder, recursive: p.recursive === true});
          list = r.files; folder = r.name; more = r.more;
        }
        const tab = tabOf(ctx);
        tab.open = true;
        save(ctx, tab);
        if (!list.length) return {added: [], message: `No PDFs found in ${folder}`};
        const items = [...list].sort((a, b) => natural(a.name, b.name)).slice(0, MAX_FOLDER_FILES);
        const added = await addSources(ctx, items.map(x => ({base64: x.base64, name: x.name.split('/').pop(), modified: x.modified})));
        return {added, folder, message: more || list.length > MAX_FOLDER_FILES ? `Added the first ${items.length} files in ${folder}` : `Added ${added.length} file${added.length === 1 ? '' : 's'} from ${folder}`};
      },
    },
  ],
});
