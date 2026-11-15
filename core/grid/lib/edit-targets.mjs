// Where a Grid edit command acts: the sheet, the ranges and single cells its params name, and
// the selection it reads and leaves (U:grid/edit; other units may import, not edit).
// Translated from gridcraft crates/engine/src/cmd.rs (`target_sheet`, `target_ranges`,
// `target_range`, `cell_param`, `cell_param_on`, `has_doc`, `has_clipboard`) and
// crates/core/src/addr.rs (`split_sheet`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Params take the section 14.3 canonical forms (`/sh:<id>/B7`, `/sh:<id>/A1:B2,D4`,
// `/sh:<id>/cols:B-D`, `/sh:<id>/rows:5-9`) and gridcraft's friendly forms (`B7`, `Sheet2!A1:C3`,
// `'My sheet'!B2`, `B:D`, `3:5`); anything else goes through the address resolver (defined
// names, tables). The active sheet is the sheet the selection is on (the sheet the surface shows,
// gridcraft `wb.active_sheet()` with `wb_switch_sheet`). No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, parseRange, parseCell, rangeA1, a1, unquoteSheet, quoteSheet, rangeOf} from './addr.mjs';
import {fromKernelSelection, toKernelSelection, expandMerges, selectionAt} from '../model/workbook.mjs';
import {sheetIndex} from '../model/sheet.mjs';
import {isLegacySheet} from '../model/store.mjs';

export const bad = (what, message) => new CommandError('invalid_params', `${what}: ${message}`);
export const failed = message => new CommandError('failed', message);

// The kernel's transaction mutates the objects it copied in place (core/kernel/change.mjs
// `owned`), and the calc engine (model/calc.mjs `engineFor`) caches by content identity and
// diffs by identity. Reading the engine on `ctx.doc` after a write in the same transaction would
// cache a draft that later writes change underneath it, so every later value read goes stale.
// Edit commands read values from the content as the transaction found it (`baseDoc`, recorded
// before their first write; for a top-level command that is the committed content), and report
// values that need the edit's result lazily, after the commit (`lazyValue`). See
// design note U-grid-edit--F-grid--engine-draft-cache.
const bases = new WeakMap();
/** The content as this transaction found it (call before the command's first write). */
export function baseDoc(ctx) {
  const key = ctx.change;
  if (!key || typeof key !== 'object') return ctx.doc;
  let b = bases.get(key);
  if (!b) { b = ctx.doc; bases.set(key, b); }
  return b;
}
/** Defines `name` on `obj` as a getter computed from the committed content on first read. */
export function lazyValue(obj, name, ctx, compute) {
  let done = false, value;
  Object.defineProperty(obj, name, {
    enumerable: true, configurable: true,
    get() { if (!done) { value = compute(ctx.doc); done = true; } return value; },
  });
  return obj;
}

/** gridcraft `has_doc`. */
export const hasDoc = ctx => (Array.isArray(ctx.doc?.sheets) && ctx.doc.sheets.length ? {enabled: true} : {enabled: false, reason: 'no workbook open'});

/** The grid selection ({sheet, active, anchor, ranges}) with merged cells taken whole. */
export function gridSel(ctx) {
  const content = ctx.doc;
  const sel = expandMerges(fromKernelSelection(content, ctx.selection), content.sheets[fromKernelSelection(content, ctx.selection).sheet]);
  // The kernel selection names areas and their anchors; an active cell moved inside the
  // selection by Enter/Tab (selection.next) lives beside it in view state while the selection stays.
  const ga = ctx.view?.gridActive;
  if (ga && ga.sel === selectionKey(ctx.selection) && sel.ranges.some(r => r.start.row <= ga.row && ga.row <= r.end.row && r.start.col <= ga.col && ga.col <= r.end.col)) {
    return {...sel, active: {row: ga.row, col: ga.col}};
  }
  return sel;
}
/** The sheet the selection is on (gridcraft `wb.active_sheet()`). */
export const activeSheet = ctx => gridSel(ctx).sheet;

/** A stable key of a kernel selection (gridActive is valid only while it holds). */
export const selectionKey = ksel => JSON.stringify({r: ksel?.ranges ?? [], p: ksel?.primary ?? 0});

/** Sets the kernel selection from a grid selection (`*cx.sel = ...`), the active cell too. */
export function setGridSelection(ctx, sel) {
  const ksel = toKernelSelection(ctx.doc, sel);
  ctx.setSelection(ksel);
  const atAnchor = sel.active.row === sel.anchor.row && sel.active.col === sel.anchor.col;
  if (!atAnchor) ctx.setView({gridActive: {sel: selectionKey(ksel), row: sel.active.row, col: sel.active.col}});
  else if (ctx.view?.gridActive) ctx.setView({gridActive: null});
}
/** A selection of one range with its first cell active (gridcraft `Selection::range`). */
export const rangeSelection = (sheet, r, active = r.start) => ({sheet, active: {...active}, anchor: {...r.start}, ranges: [r]});
export {selectionAt};

/** `/sh:<id>` of a sheet index. */
export const sheetPath = (content, si) => `/sh:${encodeURIComponent(content.sheets[si].id)}`;
/** Canonical address of an area on a sheet. */
export function areaAddress(content, si, r) {
  const p = sheetPath(content, si);
  const fullRows = r.start.col === 0 && r.end.col === MAX_COLS - 1, fullCols = r.start.row === 0 && r.end.row === MAX_ROWS - 1;
  if (fullCols && !fullRows) {
    const t = rangeA1(r).split(':');
    return t[0] === t[1] ? `${p}/col:${t[0]}` : `${p}/cols:${t[0]}-${t[1]}`;
  }
  if (fullRows && !fullCols) return r.start.row === r.end.row ? `${p}/row:${r.start.row + 1}` : `${p}/rows:${r.start.row + 1}-${r.end.row + 1}`;
  return `${p}/${rangeA1(r)}`;
}
/** `Sheet1!A1:B2` of an area (the friendly form results carry beside the canonical one). */
export const areaA1 = (content, si, r) => `${quoteSheet(content.sheets[si].name)}!${rangeA1(r)}`;

/**
 * Splits a reference into its sheet (index, or null when it names none) and the rest:
 * `/sh:<id>/rest`, `Sheet!rest`, `'My sheet'!rest` (gridcraft `split_sheet`).
 */
export function splitRef(content, text) {
  const t = String(text).trim();
  let m = /^\/sh:([^/]+)(?:\/(.*))?$/.exec(t);
  if (m) {
    let id;
    try { id = decodeURIComponent(m[1]); } catch { throw new CommandError('invalid_address', `Bad escape in ${t}`, {address: t}); }
    const i = content.sheets.findIndex(s => s.id === id);
    if (i < 0) throw new CommandError('not_found', `No sheet ${id}`, {address: t});
    return {sheet: i, body: m[2] ?? '', canonical: true};
  }
  const bang = t.lastIndexOf('!');
  if (bang > 0) {
    const name = unquoteSheet(t.slice(0, bang));
    const i = sheetIndex(content, name);
    if (i < 0) throw bad('range', `no sheet named \`${name}\``);
    return {sheet: i, body: t.slice(bang + 1), canonical: false};
  }
  return {sheet: null, body: t, canonical: false};
}

/** One area of a reference body: A1 forms, `B:D`, `3:5`, `col:C`, `cols:C-F`, `row:5`, `rows:5-9`. */
export function parseArea(text) {
  const t = String(text).trim();
  let m = /^rows?:\$?(\d{1,7})(?:-\$?(\d{1,7}))?$/i.exec(t);
  if (m) return parseRange(`${m[1]}:${m[2] ?? m[1]}`);
  m = /^cols?:\$?([A-Za-z]{1,3})(?:-\$?([A-Za-z]{1,3}))?$/i.exec(t);
  if (m) return parseRange(`${m[1]}:${m[2] ?? m[1]}`);
  return parseRange(t.replace(/\$/g, ''));
}

/** Areas of a body (`A1:B2,D4`); null when a part is not a range. */
export function parseAreas(body) {
  const parts = String(body).split(',');
  const out = [];
  for (const p of parts) {
    const r = parseArea(p);
    if (!r) return null;
    out.push(r);
  }
  return out.length ? out : null;
}

const paramText = (p, keys) => {
  for (const k of keys) if (typeof p?.[k] === 'string' && p[k] !== '') return p[k];
  return null;
};

/** gridcraft `target_sheet`: the `sheet` param, a sheet named in the range/cell param, else the active sheet. */
export function targetSheet(ctx, p, keys = ['range', 'cell']) {
  const content = ctx.doc;
  const v = p?.sheet;
  if (v !== undefined && v !== null) {
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v < content.sheets.length) return v;
      throw bad('sheet', 'no such sheet');
    }
    const text = String(v);
    const m = /^\/sh:([^/]+)$/.exec(text);
    const i = m ? content.sheets.findIndex(s => s.id === decodeURIComponent(m[1])) : sheetIndex(content, text);
    if (i < 0) throw bad('sheet', `no sheet named \`${text}\``);
    return i;
  }
  const r = paramText(p, keys);
  if (r) {
    const split = splitRef(content, r);
    if (split.sheet !== null) return split.sheet;
  }
  return activeSheet(ctx);
}

/**
 * gridcraft `target_ranges`: the areas the `range` (or `cell`) param names, else the selection's.
 * Returns {sheet, areas}. Defined names and tables resolve through the address resolver.
 */
export function targetRanges(ctx, p, keys = ['range', 'cell']) {
  const content = ctx.doc;
  const text = paramText(p, keys);
  if (!text) {
    const sel = gridSel(ctx);
    const sheet = p?.sheet !== undefined ? targetSheet(ctx, p, keys) : sel.sheet;
    return {sheet, areas: sel.ranges.map(r => ({start: {...r.start}, end: {...r.end}})), fromSelection: true};
  }
  const sheet = targetSheet(ctx, p, keys);
  const split = splitRef(content, text);
  const areas = parseAreas(split.body);
  if (areas) return {sheet, areas};
  // A defined name or a table (friendly forms the resolver knows).
  let res;
  try { res = ctx.resolve(text); } catch (e) {
    if (e?.code === 'not_found' || e?.code === 'invalid_address') throw bad(keys[0], `not a range: \`${split.body}\``);
    throw e;
  }
  if (!Array.isArray(res.areas) || !res.areas.length) throw bad(keys[0], `not a range: \`${split.body}\``);
  return {sheet: res.sheet ?? sheet, areas: res.areas};
}
/** gridcraft `target_range`: the first target area. */
export function targetRange(ctx, p, keys) {
  const t = targetRanges(ctx, p, keys);
  return {sheet: t.sheet, range: t.areas[0] ?? rangeOf(0, 0, 0, 0), fromSelection: t.fromSelection};
}

/**
 * gridcraft `cell_param_on`: a single cell param, or null when absent. A value that is not a
 * cell, or that names another sheet than `sheet`, is an error.
 */
export function cellParamOn(ctx, p, key, sheet) {
  const t = p?.[key];
  if (t === undefined || t === null) return null;
  if (typeof t !== 'string') throw bad('cell', `invalid cell reference \`${JSON.stringify(t)}\` for \`${key}\``);
  const split = splitRef(ctx.doc, t);
  const c = parseCell(split.body.replace(/\$/g, ''));
  if (!c) throw bad('cell', `invalid cell reference \`${t}\` for \`${key}\``);
  if (split.sheet !== null && split.sheet !== sheet) throw bad('cell', `\`${t}\` for \`${key}\` names a sheet other than the one this command works on`);
  return c;
}

/** Schema-2 sheets only: the commands here write blocks, styles and side tables. */
export function requireSchema2(ctx, si) {
  const sheet = ctx.doc.sheets[si];
  if (!sheet) throw new CommandError('not_found', 'No such sheet');
  if (isLegacySheet(sheet)) throw new CommandError('unavailable', 'This workbook is in the old format; open it in the new editor to convert it first.');
  return sheet;
}

/** `A1` key of a cell. */
export const keyOf = c => a1(c.row, c.col);
