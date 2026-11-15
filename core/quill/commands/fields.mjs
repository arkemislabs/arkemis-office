// Field keys (U:quill/references): show codes instead of results (Alt+F9 for the document, Shift+F9
// for the selected fields), edit a field's code, unlink a field to its text (Ctrl+Shift+F9), lock
// and unlock it (Ctrl+F11, Ctrl+Shift+F11) and move from field to field (Alt+F1, Shift+F11). The
// right-click menu of a field (Update Field, Edit Field…, Toggle Field Codes) runs these.
//
// Translated from wordcraft crates/engine/src/cmd/fields.rs (`specs`, FieldAt, story_fields,
// selected, toggle_code, show_results, set_code, set_locked, shown_text, unlink, go) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Two kinds of field: a simple field (one `field` object with its cached result) and a range field
// (fieldStart … fieldEnd, the result is the text between). Showing the code applies to simple fields.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import * as P from '../model/para.mjs';
import {cmpPos, samePath} from '../model/document.mjs';
import * as T from '../lib/table-session.mjs';
import {UPSTREAM_COMMIT, layoutFor} from '../lib/caret-session.mjs';
import {fieldCtx, fieldText} from '../layout/fields.mjs';
import {sectionOf} from '../model/section.mjs';
import {formatDate} from './insert.mjs';
import {updateFieldsIn} from '../lib/references-toc.mjs';
import {updateCitations} from '../lib/references-lists.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/fields.rs']};
const MAX_CODE = 4096;
const NONE = s.object({});

/** Every field of a story in document order: {at, end (range fields), instr, locked, code} (story_fields). */
export function storyFields(d, story) {
  const out = [];
  for (const path of d.paraPaths(story)) {
    const p = d.para(story, path);
    if (!p) continue;
    for (const [off, o] of P.objectsWithOffsets(p)) if (o.type === 'field') out.push({at: {story, path, off}, end: null, instr: o.instr ?? '', locked: !!o.locked, code: !!o.code});
  }
  for (const r of d.fieldRanges(story)) out.push({at: r.start, end: r.end, instr: r.instr, locked: !!r.locked, code: false});
  return out.sort((a, b) => cmpPos(a.at, b.at));
}

/** The fields the selection holds (selected). */
export function selectedFields(d, sel) {
  const [a, b] = T.ordered(sel);
  const all = storyFields(d, a.story);
  if (cmpPos(a, b) !== 0) {
    const inside = all.filter(f => cmpPos(f.at, a) >= 0 && cmpPos(f.at, b) < 0);
    if (inside.length) return inside;
  }
  const simple = off => all.find(f => !f.end && samePath(f.at.path, a.path) && f.at.off === off);
  const hit = simple(a.off) ?? (a.off > 0 ? simple(a.off - 1) : undefined);
  if (hit) return [hit];
  const around = [...all].reverse().find(f => f.end && cmpPos(f.at, a) < 0 && cmpPos(a, f.end) <= 0);
  return around ? [around] : [];
}

const noneSelected = () => T.failed('there is no field in the selection');
function withField(d, at, f) {
  const q = d.paraMut(at.story, at.path);
  const k = P.objectsWithOffsets(q).findIndex(([off]) => off === at.off);
  if (k < 0) return;
  q.objects = q.objects.map((o, i) => (i === k ? f({...o}) : o));
}

/** The text a simple field shows now (shown_text). */
function shownText(S, f) {
  const o = P.objectAt(S.d.paraAt(f.at), f.at.off);
  if (o?.type !== 'field') return '';
  const l = layoutFor(S.ctx, S.d.content);
  const c = l?.caret(f.at);
  const page = c ? l.pages[c.page] : null;
  const secs = S.d.sections();
  const ctx = fieldCtx({page: page?.number ?? 1, pages: l?.pages.length ?? 1, section: (page?.section ?? 0) + 1,
    sectionPages: page ? l.pages.filter(x => x.section === page.section).length : l?.pages.length ?? 1,
    pageFormat: page ? sectionOf(secs[page.section]?.[1]).pageNumFormat ?? 'decimal' : 'decimal',
    title: S.d.c.core?.title ?? '', author: S.d.c.core?.creator ?? '', filename: S.ctx.file?.name ?? '', filepath: S.ctx.file?.path ?? ''});
  const t = fieldText(o.instr ?? '', o.result ?? '', ctx);
  return Array.isArray(t) ? t[0] : typeof t === 'string' ? t : t?.text ?? '';
}

function toggleCode(S) {
  const fields = selectedFields(S.d, S.sel).filter(f => !f.end);
  if (!fields.length) throw noneSelected();
  for (const f of fields) withField(S.d, f.at, o => ({...o, code: !o.code}));
  return {fields: fields.length};
}

function setCode(S, p) {
  const code = String(p.code ?? '').trim();
  if (!code || code.length > MAX_CODE || code.includes(P.OBJ)) throw T.params('bad field code');
  const f = selectedFields(S.d, S.sel)[0];
  if (!f) throw noneSelected();
  withField(S.d, f.at, o => ({...o, instr: code}));
  updateFieldsIn(S, false, {formatDate, nowMs: () => S.ctx.host?.now?.() ?? Date.now(), afterBody: () => updateCitations(S)});
  return {instr: code};
}

function setLocked(S, value) {
  const fields = selectedFields(S.d, S.sel);
  if (!fields.length) throw noneSelected();
  for (const f of fields) withField(S.d, f.at, o => ({...o, locked: value}));
  return {fields: fields.length, locked: value};
}

function unlink(S) {
  const fields = selectedFields(S.d, S.sel);
  if (!fields.length) throw noneSelected();
  const texts = fields.map(f => (f.end ? '' : shownText(S, f)));
  const edits = [];
  fields.forEach((f, i) => { if (f.end) edits.push([f.end, '']); edits.push([f.at, texts[i]]); });
  edits.sort((a, b) => cmpPos(b[0], a[0]));
  const seen = new Set();
  for (const [at, text] of edits) {
    const key = `${at.story}|${at.path.join('/')}|${at.off}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const para = S.d.paraAt(at);
    if (!para || !P.objectAt(para, at.off)) continue;
    const props = P.propsOfChar(para, at.off) ?? {};
    S.d.deleteRange(at, {...at, off: at.off + 1});
    if (text) S.d.insertText(at, text, props);
  }
  S.sel = {anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)};
  return {fields: fields.length};
}

function go(S, forward) {
  const [a] = T.ordered(S.sel);
  const all = storyFields(S.d, a.story);
  const collapsed = T.isCollapsed(S.sel);
  const f = forward ? all.find(x => (collapsed ? cmpPos(x.at, a) >= 0 : cmpPos(x.at, a) > 0)) ?? all[0]
    : [...all].reverse().find(x => cmpPos(x.at, a) < 0) ?? all.at(-1);
  if (!f) throw T.failed('the document has no fields');
  const end = f.end ? {...f.end, off: f.end.off + 1} : {...f.at, off: f.at.off + 1};
  S.sel = {anchor: f.at, focus: end};
  S.cells = null;
}

const run = f => (ctx, p) => { const S = T.open(ctx); const r = f(S, p ?? {}); const out = T.finish(S); return r === undefined ? out : r; };
const fieldState = ctx => {
  const r = T.ready(ctx);
  if (!r.enabled) return r;
  const S = T.open(ctx);
  return selectedFields(S.d, S.sel).length ? {enabled: true} : {enabled: false, reason: 'There is no field in the selection'};
};

export default defineCommands({
  family: 'fields',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'view.fieldCodes', label: 'Field Codes', risk: 'read', effect: 'view', shortcut: 'Alt+F9',
      state: ctx => { const r = T.ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.fieldCodes} : r; },
      description: 'Field Codes: every field shows its code instead of its result (or back); `value` sets it.',
      params: s.object({value: s.optional(s.boolean())}),
      run(ctx, p) { T.ready(ctx); const value = p?.value ?? !ctx.view?.fieldCodes; ctx.setView({fieldCodes: value}); return {value}; }},
    {id: 'fields.toggleCode', label: 'Toggle Field Codes', risk: 'edit', shortcut: 'Shift+F9', state: fieldState,
      description: 'Toggle Field Codes: the selected fields switch between showing their code and their result.', params: NONE, run: run(toggleCode)},
    {id: 'fields.setCode', label: 'Edit Field Code', risk: 'edit', state: fieldState, dialog: 'dialog.fieldCode',
      description: 'Edit Field: the selected field\'s code becomes `code`, then fields update.', params: s.object({code: s.string({max: MAX_CODE})}), run: run(setCode)},
    {id: 'fields.unlink', label: 'Unlink Fields', risk: 'edit', shortcut: 'Mod+Shift+F9', state: fieldState,
      description: 'Unlink Fields: the selected fields become the text they show.', params: NONE, run: run(unlink)},
    {id: 'fields.lock', label: 'Lock Fields', risk: 'edit', shortcut: 'Mod+F11', state: fieldState,
      description: 'Lock Fields: the selected fields keep their results when fields update.', params: NONE, run: run(S => setLocked(S, true))},
    {id: 'fields.unlock', label: 'Unlock Fields', risk: 'edit', shortcut: 'Mod+Shift+F11', state: fieldState,
      description: 'Unlock Fields: the selected fields update again.', params: NONE, run: run(S => setLocked(S, false))},
    {id: 'fields.next', label: 'Next Field', risk: 'read', effect: 'view', shortcut: 'Alt+F1', state: T.ready,
      description: 'Next Field: selects the next field in the story (wrapping).', params: NONE, run: run(S => go(S, true))},
    {id: 'fields.previous', label: 'Previous Field', risk: 'read', effect: 'view', shortcut: ['Shift+F11', 'Alt+Shift+F1'], state: T.ready,
      description: 'Previous Field: selects the previous field in the story (wrapping).', params: NONE, run: run(S => go(S, false))},
    {id: 'fields.selected', label: 'Selected Fields', risk: 'read', state: T.ready,
      description: 'The fields in the selection: [{address, instr, locked, range, code}].', params: NONE,
      run(ctx) {
        const S = T.open(ctx);
        return selectedFields(S.d, S.sel).map(f => ({address: ctx.model.addressOf(ctx, f.at), instr: f.instr, locked: f.locked, range: !!f.end, code: f.code}));
      }},
  ],
});
