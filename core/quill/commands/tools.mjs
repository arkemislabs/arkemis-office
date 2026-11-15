// Developer › Code (Macros, Record Macro) and Developer › Templates (Document Template): Quill's macros and the
// document template, and the Organizer's commands (copy styles from a template, rename).
//
// Translated from wordcraft crates/engine/src/cmd/tools/specs.rs and tools/actions.rs (`macros`, `record_macro`),
// session/run.rs (what a recording keeps) and crates/engine/src/cmd/templates.rs (`templates`, `attach`, `update_styles`,
// `copy_styles`, `organizer`, `copy_from`, `rename`) at aadb077e072b7de05f724e359d8db82e151f125c; checked again against
// wordcraft 0.13.1 (f2dfa0d). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A macro is a recorded or defined list of Quill commands ({command, params}), never code. Record Macro keeps every
// command that changes the document and every caret and selection command run until it is turned off (a password never
// lands in one); Macros runs them again, each step as the command would run alone, in one undo step. Upstream keeps
// macros in the session; Quill keeps them in the person's settings (preference `macros`, per user profile) so they last,
// never in the document. A macro can only hold commands that edit the document or move the caret (not file, tools or
// window commands) and a protected document refuses what protection refuses. A .docx's VBA project is neither read, run
// nor kept: Visual Basic, Macro Security and Pause Recording have no engine upstream and stay hidden.
// The template is a name (path) the document records (w:attachedTemplate) and whether its styles update automatically
// (w:linkStyles); it is never read on its own: only tools.updateStyles, or tools.attachTemplate with `update`, reads it
// (`data` gives the bytes, else the host reads the file). Not here: the Organizer's dialog (its commands are), global
// templates and add-ins, XML schemas and linked CSS.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {Document} from '../model/document.mjs';
import {getStyle, upsertStyle, newStyleId} from '../model/styles.mjs';
import {checkBefore} from '../lib/review-protect.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/tools/specs.rs', 'crates/engine/src/cmd/tools/actions.rs', 'crates/engine/src/session/run.rs', 'crates/engine/src/cmd/templates.rs']};

const bad = m => new CommandError('invalid_params', m);
const failed = m => new CommandError('failed', m);
const MAX_MACROS = 100;
const MAX_STEPS = 10_000;
const MAX_PATH = 32 * 1024;
const MAX_COPY = 10_000;
const MAX_NAME = 253;
const STEP = s.object({command: s.string({min: 1, max: 100}), params: s.optional(s.any())});

// ---- macros -------------------------------------------------------------------------------------------------

export const macrosOf = ctx => (ctx?.prefs?.macros && typeof ctx.prefs.macros === 'object' && !Array.isArray(ctx.prefs.macros) ? ctx.prefs.macros : {});
const saveMacros = (ctx, macros) => ctx.updatePrefs({macros});

/** Whether a macro may hold `id`: a command that edits the document or moves the caret (not file, tools, window or dialog commands); the reason when not. */
function stepProblem(ctx, id) {
  const cmd = ctx.registry?.get?.(id);
  if (!cmd) return `no command ${id}`;
  if (/^(tools|file|ui|app|dialog)\./.test(id)) return `${id} can't be part of a macro`;
  const edits = cmd.risk === 'edit' && cmd.effect === 'content';
  const moves = /^(caret|select)\./.test(id);
  return edits || moves ? null : `${id} doesn't edit the document, so a macro can't hold it`;
}

function checkedSteps(ctx, steps) {
  if (!Array.isArray(steps)) throw bad('a macro has steps: [{command, params}]');
  if (steps.length > MAX_STEPS) throw bad(`a macro has at most ${MAX_STEPS} steps`);
  const out = [];
  for (const st of steps) {
    if (!st || typeof st !== 'object' || typeof st.command !== 'string') continue;   // as upstream, a step without a command is skipped
    const why = stepProblem(ctx, st.command);
    if (why) throw bad(why);
    const params = st.params === undefined || st.params === null ? {} : st.params;
    if (typeof params !== 'object' || Array.isArray(params)) throw bad(`${st.command}: params is an object`);
    out.push({command: st.command, params: JSON.parse(JSON.stringify(params))});
  }
  return out;
}

function macroName(v, fallback) {
  const name = v === undefined || v === null ? fallback : v;
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\u0000-\u001f]/.test(name)) throw bad('a macro name is 1 to 64 characters');
  return name;
}

function runMacro(ctx, name) {
  const steps = macrosOf(ctx)[name];
  if (!steps) throw bad(`no macro \`${name}\``);
  const d = new Document(ctx.doc);
  const author = T.authorOf(ctx.prefs);
  for (const st of checkedSteps(ctx, steps)) {
    // Each step goes through the protection the document has, as the command alone would.
    checkBefore(d, author, st.command, st.params);
    ctx.run(st.command, st.params);
  }
  return {ran: name, steps: steps.length};
}

function macros(ctx, p) {
  const all = macrosOf(ctx);
  let now = all;
  if (p.define !== undefined) {
    const name = macroName(p.define.name, 'Macro');
    const steps = checkedSteps(ctx, p.define.steps);
    if (!now[name] && Object.keys(now).length >= MAX_MACROS) throw failed(`at most ${MAX_MACROS} macros are kept`);
    now = {...now, [name]: steps};
    saveMacros(ctx, now);
  }
  if (p.delete !== undefined) {
    now = {...now};
    delete now[p.delete];
    saveMacros(ctx, now);
  }
  if (p.run !== undefined) return runMacro(ctx, p.run);
  return now;
}

/** What a recording keeps: a command that changes the document or moves the caret or selection, but not the macro commands, undo, redo or repeat (session/run.rs). */
export function recordStep(ctx, cmd, params) {
  const rec = ctx.view?.recording;
  if (!rec || ['tools.recordMacro', 'tools.macros', 'edit.undo', 'edit.redo', 'edit.repeat'].includes(cmd.id) || rec.steps.length >= MAX_STEPS) return;
  const mutates = cmd.risk !== 'read' && cmd.effect === 'content';
  if (!(mutates || /^(caret|select)\./.test(cmd.id))) return;
  if (stepProblem(ctx, cmd.id)) return;
  const kept = JSON.parse(JSON.stringify(params ?? {}));
  delete kept.password;
  ctx.setView({recording: {...rec, steps: [...rec.steps, {command: cmd.id, params: kept}]}});
}

function recordMacro(ctx, p) {
  const rec = ctx.view?.recording;
  if (rec) {
    ctx.setView({recording: null});
    saveMacros(ctx, {...macrosOf(ctx), [rec.name]: rec.steps});
    return {recording: false, saved: rec.name, steps: rec.steps.length};
  }
  const name = macroName(p.name, 'Macro1');
  ctx.setView({recording: {name, steps: []}});
  return {recording: true, name};
}

// ---- the document template ----------------------------------------------------------------------------------

const settingsOf = ctx => ctx.doc?.settings ?? {};
const templateState = ctx => ({template: settingsOf(ctx).attachedTemplate ?? null, linkStyles: !!settingsOf(ctx).linkStyles});
const setSettings = (S, patch) => S.d.updateField('settings', st => { for (const [k, v] of Object.entries(patch)) st[k] = v; });

async function bytesOf(ctx, p) {
  if (typeof p.data === 'string') return Uint8Array.from(atob(p.data.replace(/^data:[^,]*,/, '')), c => c.charCodeAt(0));
  const path = p.path ?? settingsOf(ctx).attachedTemplate;
  if (!path) throw bad('no template is attached; give `path`');
  if (typeof ctx.host?.readFile !== 'function') throw new CommandError('unavailable', 'reading the template by path is not available here; pass `data` (base64)');
  const got = await ctx.host.readFile(path);
  return got instanceof Uint8Array ? got : Uint8Array.from(atob(String(got)), c => c.charCodeAt(0));
}

/** Another document or template, from its bytes (`path` only names its format) (load_other). */
async function loadOther(ctx, p) {
  const bin = await bytesOf(ctx, p);
  const name = String(p.path ?? settingsOf(ctx).attachedTemplate ?? '');
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (['', 'txt', 'text'].includes(ext) && p.data !== undefined) throw bad(`\`${name}\` is not a document or template with styles`);
  if (!(bin[0] === 0x50 && bin[1] === 0x4b)) throw failed(`\`${name}\` is not a Word document or template`);
  const {read} = await import('../formats/docx-read.mjs');
  return new Document(await read(bin));
}

/**
 * Copy styles `ids` of `src` into the document, Organizer-style: a style replaces the document's style of the same name (and
 * kind), or is added (under its own id when that is free). The styles they are based on that the document lacks, and their
 * linked halves, come too; `based on`, `next` and `linked` are mapped to the document's ids, and lists a style numbers with
 * are copied. Returns {added, replaced, skipped} (names) (copy_styles).
 */
export function copyStyles(S, src, ids) {
  const sheet = src.c.styles ?? {styles: []};
  let cur = {...S.d.c.styles, styles: [...S.d.c.styles.styles]};
  const sameName = st => cur.styles.find(d => String(d.name).toLowerCase() === String(st.name).toLowerCase())?.id ?? null;
  const want = [], seen = new Set();
  const queue = [...ids].reverse();
  while (queue.length) {
    const id = queue.pop();
    if (want.length >= MAX_COPY) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const st = getStyle(sheet, id);
    if (!st) continue;
    want.push(id);
    if (st.linked && getStyle(sheet, st.linked)?.linked === st.id) queue.push(st.linked);
    const base = st.basedOn ? getStyle(sheet, st.basedOn) : null;
    if (base && sameName(base) === null) queue.push(st.basedOn);
  }
  const map = new Map(), order = [];
  const added = [], replaced = [], skipped = [];
  const wanted = new Set(want);
  for (const st of sheet.styles.filter(x => wanted.has(x.id))) {
    let target = sameName(st);
    if (target !== null) {
      if (getStyle(cur, target).kind !== st.kind) { skipped.push(st.name); continue; }
      replaced.push(st.name);
    } else {
      added.push(st.name);
      target = !getStyle(cur, st.id) ? st.id : newStyleId(cur, st.name);
    }
    const builtin = !!getStyle(cur, target)?.builtin || !!st.builtin;
    cur = upsertStyle(cur, {...structuredClone(st), id: target, builtin});
    map.set(st.id, target);
    order.push([st.id, target]);
  }
  const resolve = r => map.get(r) ?? (getStyle(sheet, r) ? sameName(getStyle(sheet, r)) : null);
  let numbering = S.d.c.numbering ?? {abstracts: [], nums: []};
  const startNumbering = numbering;
  const nums = new Map();
  const importNum = num => {
    if (nums.has(num)) return nums.get(num);
    const n = (src.c.numbering?.nums ?? []).find(x => x.id === num);
    const abs = n ? (src.c.numbering?.abstracts ?? []).find(a => a.id === n.abstractId) : null;
    if (!n || !abs) return null;
    const newAbs = numbering.abstracts.length ? Math.max(...numbering.abstracts.map(a => a.id)) + 1 : 0;
    const newNum = numbering.nums.length ? Math.max(...numbering.nums.map(x => x.id)) + 1 : 1;
    const levels = (abs.levels ?? []).map(l => ({...l, style: l.style ? (map.get(l.style) ?? getStyle(cur, l.style)?.id ?? null) : l.style}));
    numbering = {...numbering, abstracts: [...numbering.abstracts, {...structuredClone(abs), id: newAbs, levels}], nums: [...numbering.nums, {...structuredClone(n), id: newNum, abstractId: newAbs}]};
    nums.set(num, newNum);
    return newNum;
  };
  for (const [srcId, target] of order) {
    const st = getStyle(sheet, srcId);
    const basedOn = st.basedOn ? resolve(st.basedOn) : null;
    const d = getStyle(cur, target);
    let para = d.para;
    if (st.para?.numbering) {
      const n = {...st.para.numbering};
      if (n.num !== 0) n.num = importNum(n.num) ?? 0;
      if (n.num !== 0 || st.para.numbering.num === 0) para = {...st.para, numbering: n};
      else { para = {...st.para}; delete para.numbering; }
    }
    cur = upsertStyle(cur, {...d, basedOn: basedOn && basedOn !== target ? basedOn : null, next: st.next ? resolve(st.next) : null, linked: st.linked ? map.get(st.linked) ?? null : null, para});
  }
  S.d.updateField('styles', () => cur);
  if (numbering !== startNumbering) S.d.updateField('numbering', () => numbering);
  return {added, replaced, skipped};
}

async function updateStyles(ctx, p) {
  const src = await loadOther(ctx, p);
  const S = T.open(ctx);
  // The template's own defaults come with its styles (apply_template_styles).
  if (src.c.styles) S.d.updateField('styles', sh => ({...sh, defaultChr: structuredClone(src.c.styles.defaultChr ?? sh.defaultChr), defaultPara: structuredClone(src.c.styles.defaultPara ?? sh.defaultPara)}));
  return T.finish(S, copyStyles(S, src, (src.c.styles?.styles ?? []).map(x => x.id)));
}

async function attachTemplate(ctx, p) {
  const path = String(p.path ?? '').trim();
  if (!path) throw bad('`path` is empty');
  if (path.length > MAX_PATH) throw bad('`path` is too long');
  const S = T.open(ctx);
  setSettings(S, {attachedTemplate: path, ...(typeof p.linkStyles === 'boolean' ? {linkStyles: p.linkStyles} : {})});
  T.finish(S, {});
  const out = templateState(ctx);
  if (p.update === true) out.updated = await updateStyles(ctx, {path, data: p.data});
  return out;
}

function styleList(d) {
  return [...d.c.styles.styles].sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()))
    .map(st => ({id: st.id, name: st.name, type: st.kind, builtIn: !!st.builtin}));
}

async function organizer(ctx, p) {
  const out = {document: styleList(new Document(ctx.doc))};
  if (typeof p.path === 'string') out.file = {path: p.path, styles: styleList(await loadOther(ctx, p))};
  return out;
}

async function copyFrom(ctx, p) {
  const src = await loadOther(ctx, p);
  const names = (Array.isArray(p.styles) ? p.styles : typeof p.styles === 'string' ? [p.styles] : null);
  if (!names) throw bad('`styles` (list of style names) is required');
  const picked = names.filter(n => typeof n === 'string').slice(0, MAX_COPY);
  if (!picked.length) throw bad('`styles` is empty');
  const sheet = src.c.styles;
  const find = n => sheet.styles.find(x => x.id === n) ?? sheet.styles.find(x => String(x.name).toLowerCase() === n.toLowerCase());
  const ids = picked.map(n => { const st = find(n); if (!st) throw bad(`\`${p.path}\` has no style \`${n}\``); return st.id; });
  const S = T.open(ctx);
  return T.finish(S, copyStyles(S, src, ids));
}

function renameStyle(ctx, p) {
  const S = T.open(ctx);
  const name = String(p.name ?? '').trim();
  if (!name || [...name].length > MAX_NAME) throw bad(`a style name has 1 to ${MAX_NAME} characters`);
  const sheet = S.d.c.styles;
  const st = sheet.styles.find(x => x.id === p.style) ?? sheet.styles.find(x => String(x.name).toLowerCase() === String(p.style).toLowerCase());
  if (!st) throw bad(`no style \`${p.style}\``);
  if (st.builtin) throw failed(`\`${st.name}\` is a built-in style and can't be renamed`);
  if (sheet.styles.some(o => o.id !== st.id && String(o.name).toLowerCase() === name.toLowerCase())) throw failed(`a style named \`${name}\` already exists`);
  S.d.updateField('styles', sh => upsertStyle(sh, {...st, name}));
  return T.finish(S, {id: st.id, name});
}

export default defineCommands({
  family: 'tools',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'tools.macros', label: 'Macros', risk: 'edit', state: T.ready,
      description: 'Macros: `define` ({name, steps: [{command, params}]}) keeps one, `delete` removes one, `run` plays one by name (one undo step); with none of these it answers every macro kept. A macro holds document-editing and caret commands only and lives in the person\'s settings, never in the document.',
      params: s.object({run: s.optional(s.string({max: 64})), define: s.optional(s.object({name: s.optional(s.string({max: 64})), steps: s.array(STEP, {max: MAX_STEPS})})), delete: s.optional(s.string({max: 64}))}),
      run: macros},
    {id: 'tools.recordMacro', label: 'Record Macro', risk: 'read', effect: 'view',
      state: ctx => { const r = T.ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.recording} : r; },
      description: 'Record Macro: starts recording the commands that change the document or move the caret (as `name`, else Macro1); call again to stop and keep the macro.',
      params: s.object({name: s.optional(s.string({max: 64}))}), run: recordMacro},
    {id: 'tools.templates', label: 'Templates and Add-ins', risk: 'read', effect: 'view', state: T.ready,
      description: 'Templates and Add-ins: answers {template: path|null, linkStyles: bool} (from the ribbon the dialog opens).', params: s.object({}), run: ctx => templateState(ctx)},
    {id: 'tools.attachTemplate', label: 'Attach Template', risk: 'edit', state: T.ready,
      description: 'Attach Template: the document records `path` as its template, with `linkStyles`; `update` also copies the template\'s styles now (`data`: the template\'s bytes, base64).',
      params: s.object({path: s.string({min: 1, max: MAX_PATH}), linkStyles: s.optional(s.boolean()), update: s.optional(s.boolean()), data: s.optional(s.string({max: 60_000_000}))}), run: attachTemplate},
    {id: 'tools.detachTemplate', label: 'Detach Template', risk: 'edit', description: 'Detach Template: the document has no template and its styles stop updating.', params: s.object({}),
      state: T.ready, run(ctx) { const S = T.open(ctx); setSettings(S, {attachedTemplate: null, linkStyles: false}); return T.finish(S, {template: null, linkStyles: false}); }},
    {id: 'tools.linkStyles', label: 'Automatically Update Document Styles', risk: 'edit', description: 'Automatically Update Document Styles: `value` sets it (default: toggles).',
      params: s.object({value: s.optional(s.boolean())}), state: ctx => { const r = T.ready(ctx); return r.enabled ? {enabled: true, checked: !!settingsOf(ctx).linkStyles} : r; },
      run(ctx, p) { const S = T.open(ctx); const value = typeof p.value === 'boolean' ? p.value : !settingsOf(ctx).linkStyles; setSettings(S, {linkStyles: value}); return T.finish(S, {template: settingsOf(ctx).attachedTemplate ?? null, linkStyles: value}); }},
    {id: 'tools.updateStyles', label: 'Update Styles from Template', risk: 'edit', state: T.ready,
      description: 'Update Styles from Template: copies the template\'s styles (`path`, default the attached one; `data`: its bytes, base64) and defaults into the document, replacing styles of the same name; answers {added, replaced, skipped}.',
      params: s.object({path: s.optional(s.string({max: MAX_PATH})), data: s.optional(s.string({max: 60_000_000}))}), run: updateStyles},
    {id: 'styles.organizer', label: 'Organizer', risk: 'read', effect: 'view', state: T.ready,
      description: 'Organizer: the document\'s styles by name, and those of another document or template (`path`, `data`: its bytes, base64).',
      params: s.object({path: s.optional(s.string({max: MAX_PATH})), data: s.optional(s.string({max: 60_000_000}))}), run: organizer},
    {id: 'styles.copyFrom', label: 'Copy Styles', risk: 'edit', state: T.ready,
      description: 'Copy Styles: the named styles of another document or template (`path`, `data`) into this one, with the styles they are based on; answers {added, replaced, skipped}.',
      params: s.object({path: s.string({min: 1, max: MAX_PATH}), data: s.optional(s.string({max: 60_000_000})), styles: s.union([s.string({max: 1024}), s.array(s.string({max: 1024}), {max: MAX_COPY})])}), run: copyFrom},
    {id: 'styles.rename', label: 'Rename Style', risk: 'edit', state: T.ready,
      description: 'Rename Style: a custom style (by name or id) gets a new name.', params: s.object({style: s.string({min: 1, max: 1024}), name: s.string({min: 1, max: 4096})}), run: renameStyle},
  ],
});
