// Worksheets: Insert Sheet, Delete Sheet, Rename Sheet, Move or Copy Sheet…, Tab Color, Hide Sheet,
// Unhide Sheet…, and switching sheets (Activate, Next Sheet Ctrl+PageDown, Previous Sheet Ctrl+PageUp).
// Translated from gridcraft crates/engine/src/cmd/sheet/tabs.rs (`insert_sheet`, `delete_sheet`,
// `rename_sheet`, `move_sheet`, `tab_color`, `hide_sheet`, `unhide_sheet`, `activate`,
// `step_sheet`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The active sheet is the sheet the selection is on; sheet changes that make another sheet active
// also record it in `content.activeSheetId` (what a saved file opens on). Switching sheets is a
// view change (no undo step) and brings back the selection the sheet had (gridcraft
// `sheet_selections`), kept in the document's view state.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {parse, parseName, print, renameSheet as renameRefs, deleteSheet as deleteRefs} from '../../lib/formula.mjs';
import {targetSheet, gridSel, setGridSelection, failed, hasDoc, selectionAt} from '../../lib/edit-targets.mjs';
import {colorParam} from '../../lib/format-ranges.mjs';
import {COLOR, UPSTREAM_COMMIT} from '../../lib/format-params.mjs';
import {checkSheetName, nextSheetName, sheetIndex} from '../../model/sheet.mjs';
import {toKernelSelection, fromKernelSelection} from '../../model/workbook.mjs';
import {colorHex} from '../../model/style.mjs';
import {MAX_SHEETS} from '../../model/workbook.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/sheet/tabs.rs']};
const STRUCTURE = 'The workbook is protected and cannot be changed.';
const ONE_VISIBLE = 'A workbook must contain at least one visible worksheet.';
const SHEET_PARAM = s.union([s.integer({min: 0, max: 254}), s.string({min: 1, max: 300})], {description: 'Sheet: index, name, id or /sh:<id>'});
const OPT_SHEET = s.optional(SHEET_PARAM);

const isVisible = sh => !sh.hidden;
/** Workbook structure protection (Review › Protect Workbook, U:grid/review). */
const structureProtected = content => !!(content.protection && content.protection.structure);
const checkStructure = ctx => { if (structureProtected(ctx.doc)) throw failed(STRUCTURE); };

/** A sheet param: index, name, id or /sh:<id>. */
function sheetParam(ctx, v) {
  if (v === undefined || v === null) return gridSel(ctx).sheet;
  if (typeof v === 'string' && !/^\/sh:/.test(v)) {
    const i = sheetIndex(ctx.doc, v);
    if (i >= 0) return i;
  }
  return targetSheet(ctx, {sheet: v}, []);
}

// ---------------------------------------------------------------------------------------------
// Switching sheets (view only)

const SHEET_SELECTIONS = 'gridSheetSelections';
/** Shows sheet `i` with the selection it had (A1 the first time), remembering the current one. */
function switchTo(ctx, i) {
  const content = ctx.doc;
  const cur = gridSel(ctx);
  const saved = {...(ctx.view?.[SHEET_SELECTIONS] ?? {})};
  if (content.sheets[cur.sheet]) saved[content.sheets[cur.sheet].id] = ctx.selection;
  const id = content.sheets[i].id;
  let sel = selectionAt(i, {row: 0, col: 0});
  const prev = saved[id];
  if (prev) { try { const g = fromKernelSelection(content, prev); if (g.sheet === i) sel = g; } catch { /* A1 */ } }
  ctx.setView({[SHEET_SELECTIONS]: saved});
  setGridSelection(ctx, sel);
}

/** Makes sheet `i` the active one as part of an edit (gridcraft `set_active_sheet`). */
function activateInEdit(ctx, i) {
  const id = ctx.doc.sheets[i].id;
  if (ctx.doc.activeSheetId !== id) ctx.change.set(['activeSheetId'], id);
  ctx.setSelection(toKernelSelection(ctx.doc, selectionAt(i, {row: 0, col: 0})));
}

// ---------------------------------------------------------------------------------------------
// Formula rewrites across the workbook

function rewriteFormulas(sheets, fix) {
  return sheets.map(sh => {
    let blocks = null;
    for (const bk of Object.keys(sh.blocks ?? {})) {
      const b = sh.blocks[bk];
      let nb = null;
      for (const k of Object.keys(b)) {
        const c = b[k];
        if (c.f === undefined) continue;
        const f = fix(c.f, false);
        if (f !== c.f) { nb ??= {...b}; nb[k] = {...c, f}; }
      }
      if (nb) { blocks ??= {...sh.blocks}; blocks[bk] = nb; }
    }
    return blocks ? {...sh, blocks} : sh;
  });
}
const fixer = map => (text, named) => {
  let e;
  try { e = named ? parseName(String(text).replace(/^=/, '')) : parse(text); } catch { return text; }
  const out = print(map(e));
  if (named) return String(text).startsWith('=') ? `=${out}` : out;
  return out;
};
const fixNames = (names, fix) => (Array.isArray(names) ? names.map(n => { const f = fix(n.formula, true); return f === n.formula ? n : {...n, formula: f}; }) : names);

// ---------------------------------------------------------------------------------------------
// Commands

function insertSheet(ctx, p) {
  checkStructure(ctx);
  const content = ctx.doc;
  if (content.sheets.length >= MAX_SHEETS) throw failed(`A workbook can have at most ${MAX_SHEETS} sheets.`);
  const name = p.name ?? nextSheetName(content);
  const err = checkSheetName(content, name);
  if (err) throw new CommandError('invalid_params', err, {path: '/name'});
  // Excel inserts before the active sheet; the "+" button (and gridcraft's default) appends after it.
  const at = Math.min(p.before ?? gridSel(ctx).sheet + 1, content.sheets.length);
  let id;
  do { id = ctx.host?.uid?.() ?? Math.random().toString(36).slice(2, 10); } while (content.sheets.some(x => x.id === id));
  ctx.change.splice(['sheets'], at, 0, {id, name, blocks: {}});
  activateInEdit(ctx, at);
  return {index: at, name, sheet: `/sh:${encodeURIComponent(id)}`};
}

function deleteSheet(ctx, p) {
  const i = sheetParam(ctx, p.sheet);
  checkStructure(ctx);
  const content = ctx.doc;
  if (content.sheets.filter(isVisible).length <= 1) throw failed(ONE_VISIBLE);
  const victim = content.sheets[i];
  const order = content.sheets.map(x => x.name);
  const fix = fixer(e => deleteRefs(e, victim.name, order));
  const rest = content.sheets.filter((_, k) => k !== i);
  const sheets = rewriteFormulas(rest, fix);
  // Names scoped to the sheet go; names referring to it become #REF!.
  const names = Array.isArray(content.names) ? fixNames(content.names.filter(n => n.scope !== victim.id), fix) : content.names;
  const active = gridSel(ctx).sheet;
  ctx.change.apply({op: 'grid.replace', sheets, names});
  let next = active > i ? active - 1 : active === i ? Math.min(i, sheets.length - 1) : active;
  if (next >= sheets.length) next = sheets.length - 1;
  if (!isVisible(sheets[next])) next = Math.max(0, sheets.findIndex(isVisible));
  activateInEdit(ctx, next);
  return {deleted: victim.name};
}

function renameSheet(ctx, p) {
  checkStructure(ctx);
  const i = sheetParam(ctx, p.sheet);
  const name = String(p.name ?? '').trim();
  const err = checkSheetName(ctx.doc, name, i);
  if (err) throw new CommandError('invalid_params', err, {path: '/name'});
  const content = ctx.doc;
  const old = content.sheets[i].name;
  if (old === name) return {name};
  const fix = fixer(e => renameRefs(e, old, name));
  const sheets = rewriteFormulas(content.sheets, fix).map((sh, k) => (k === i ? {...sh, name} : sh));
  ctx.change.apply({op: 'grid.replace', sheets, names: fixNames(content.names, fix)});
  return {name, previous: old};
}

/** `Name (2)`: the name shortened so the suffix fits in Excel's 31 characters. */
function copyName(content, base) {
  for (let k = 2; ; k++) {
    const suffix = ` (${k})`;
    const keep = Math.max(0, 31 - [...suffix].length);
    const name = `${[...base].slice(0, keep).join('').trimEnd()}${suffix}`;
    if (sheetIndex(content, name) < 0 && !content.sheets.some(x => x.name.toLowerCase() === name.toLowerCase())) return name;
  }
}

function moveSheet(ctx, p) {
  checkStructure(ctx);
  const i = sheetParam(ctx, p.sheet);
  const content = ctx.doc;
  const n = content.sheets.length;
  const src = content.sheets[i];
  if (p.copy) {
    if (n >= MAX_SHEETS) throw failed(`A workbook can have at most ${MAX_SHEETS} sheets.`);
    let id;
    do { id = ctx.host?.uid?.() ?? Math.random().toString(36).slice(2, 10); } while (content.sheets.some(x => x.id === id));
    const name = copyName(content, src.name);
    const copy = structuredClone({...src, id, name});
    delete copy.tables; // table names must be unique
    delete copy.preserved; // kept file content stays with the original
    const at = Math.min(p.to, n);
    const fix = fixer(e => renameRefs(e, src.name, name));
    // The copy gets its own copies of the sheet's names, referring to the copy.
    const copies = (content.names ?? []).filter(x => x.scope === src.id).map(x => ({...x, scope: id, formula: fix(x.formula, true)}));
    const sheets = content.sheets.slice();
    sheets.splice(at, 0, copy);
    ctx.change.apply({op: 'grid.replace', sheets, names: Array.isArray(content.names) ? [...content.names, ...copies] : content.names});
    activateInEdit(ctx, at);
    return {index: at, name, sheet: `/sh:${encodeURIComponent(id)}`, copy: true};
  }
  const at = Math.min(p.to, n - 1);
  if (at === i) return {index: i, name: src.name, copy: false};
  const sheets = content.sheets.slice();
  sheets.splice(i, 1);
  sheets.splice(at, 0, src);
  ctx.change.apply({op: 'grid.replace', sheets, names: content.names});
  activateInEdit(ctx, at);
  return {index: at, name: src.name, copy: false};
}

function tabColor(ctx, p) {
  const i = sheetParam(ctx, p.sheet);
  const c = colorParam(p.color);
  const hexValue = c === undefined || c === null ? null : typeof c === 'string' ? c : colorHex(c, ctx.doc.theme);
  if (hexValue) ctx.change.set(['sheets', i, 'tabColor'], hexValue);
  else if (ctx.doc.sheets[i].tabColor !== undefined) ctx.change.delete(['sheets', i, 'tabColor']);
  return {sheet: i, color: hexValue};
}

function hideSheet(ctx, p) {
  checkStructure(ctx);
  const i = sheetParam(ctx, p.sheet);
  if (ctx.doc.sheets.filter(isVisible).length <= 1) throw failed(ONE_VISIBLE);
  if (!isVisible(ctx.doc.sheets[i])) return {sheet: i, hidden: true};
  ctx.change.set(['sheets', i, 'hidden'], 'hidden');
  if (gridSel(ctx).sheet === i) activateInEdit(ctx, Math.max(0, ctx.doc.sheets.findIndex(isVisible)));
  return {sheet: i, hidden: true};
}

function unhideSheet(ctx, p) {
  checkStructure(ctx);
  const i = sheetParam(ctx, p.sheet);
  if (ctx.doc.sheets[i].hidden !== undefined) ctx.change.delete(['sheets', i, 'hidden']);
  activateInEdit(ctx, i);
  return {sheet: i, name: ctx.doc.sheets[i].name};
}

function stepSheet(ctx, dir) {
  const sheets = ctx.doc.sheets;
  for (let i = gridSel(ctx).sheet + dir; i >= 0 && i < sheets.length; i += dir) {
    if (isVisible(sheets[i])) { switchTo(ctx, i); return {sheet: i, name: sheets[i].name}; }
  }
  // No visible sheet in this direction: keep the current sheet and its selection.
  return {sheet: gridSel(ctx).sheet, name: sheets[gridSel(ctx).sheet].name};
}

const structureState = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return structureProtected(ctx.doc) ? {enabled: false, reason: STRUCTURE} : {enabled: true};
};
const VIEW = {risk: 'read', effect: 'view', undo: 'none', repeatable: false};

export default defineCommands({
  family: 'sheet/tabs',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'home.insertSheet', label: 'Insert Sheet', shortcut: 'Shift+F11', risk: 'edit',
      description: 'Insert a new worksheet after the active one (or before index `before`), named `name` or the next free SheetN.',
      params: s.object({name: s.optional(s.string({min: 1, max: 31})), before: s.optional(s.integer({min: 0, max: 255}))}), state: structureState, run: insertSheet},
    {id: 'home.deleteSheet', label: 'Delete Sheet', risk: 'edit',
      description: 'Delete a worksheet (default: the active one); formulas that referred to it show #REF!.',
      params: s.object({sheet: OPT_SHEET}), state: structureState, run: deleteSheet},
    {id: 'sheet.rename', label: 'Rename Sheet', risk: 'edit', dialog: 'dialog.renameSheet',
      description: 'Rename a worksheet (default: the active one); formulas and names that refer to it follow.',
      params: s.object({sheet: OPT_SHEET, name: s.string({min: 1, max: 100})}), state: structureState, run: renameSheet},
    {id: 'sheet.move', label: 'Move or Copy Sheet…', risk: 'edit', dialog: 'dialog.moveSheet',
      description: 'Move a worksheet (default: the active one) to position `to`, or with `copy` insert a copy there named "Name (2)".',
      params: s.object({sheet: OPT_SHEET, to: s.integer({min: 0, max: 255}), copy: s.optional(s.boolean())}), state: structureState, run: moveSheet},
    {id: 'sheet.tabColor', label: 'Tab Color', risk: 'edit',
      description: 'Colour a worksheet\'s tab (default: the active one): "#FF0000", or "none" for No Color.',
      params: s.object({sheet: OPT_SHEET, color: COLOR}), state: hasDoc, run: tabColor},
    {id: 'sheet.hide', label: 'Hide Sheet', risk: 'edit',
      description: 'Hide a worksheet (default: the active one); a workbook keeps at least one visible sheet.',
      params: s.object({sheet: OPT_SHEET}),
      state: ctx => { const st = structureState(ctx); if (!st.enabled) return st; return ctx.doc.sheets.filter(isVisible).length > 1 ? st : {enabled: false, reason: ONE_VISIBLE}; },
      run: hideSheet},
    {id: 'sheet.unhide', label: 'Unhide Sheet…', risk: 'edit', dialog: 'dialog.unhideSheet',
      description: 'Show a hidden worksheet and make it active; without `sheet` the Unhide dialog lists the hidden sheets.',
      params: s.object({sheet: SHEET_PARAM}),
      state: ctx => { const st = structureState(ctx); if (!st.enabled) return st; return ctx.doc.sheets.some(x => !isVisible(x)) ? st : {enabled: false, reason: 'No sheets are hidden.'}; },
      run: unhideSheet},
    {id: 'sheet.activate', label: 'Activate Sheet', ...VIEW,
      description: 'Show a worksheet (index, name or id) with the selection it had.',
      params: s.object({sheet: SHEET_PARAM}), state: hasDoc,
      run(ctx, p) {
        const i = sheetParam(ctx, p.sheet);
        if (i !== gridSel(ctx).sheet) switchTo(ctx, i);
        return {sheet: i, name: ctx.doc.sheets[i].name};
      }},
    {id: 'sheet.next', label: 'Next Sheet', shortcut: 'Ctrl+PageDown', ...VIEW, description: 'Show the next visible worksheet.',
      params: s.object({}), state: hasDoc, run: ctx => stepSheet(ctx, 1)},
    {id: 'sheet.previous', label: 'Previous Sheet', shortcut: 'Ctrl+PageUp', ...VIEW, description: 'Show the previous visible worksheet.',
      params: s.object({}), state: hasDoc, run: ctx => stepSheet(ctx, -1)},
  ],
});

export {copyName, structureProtected};
