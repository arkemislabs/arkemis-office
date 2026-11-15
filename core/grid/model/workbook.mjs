// Workbook and sheet records (schema 2), view flags, style lookup per cell, and the grid selection
// carried in the kernel's selection.
// Translated from gridcraft crates/model/src/workbook.rs (Workbook::new, add_sheet, sheet names),
// crates/model/src/sheet.rs (Sheet::new defaults, style_id, value_ref) and
// crates/engine/src/selection.rs (Selection) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema-2 workbook content (docs/architecture.md 14.3, 16.2):
//   {sheets: Sheet[], activeSheetId, styles: Style[] (0 = Normal), names: {name, formula, scope?, comment?}[],
//    dateSystem?: 1900|1904, calc?: {mode: 'auto'|'manual'|'autoNoTables', iterative?, maxIterations?, maxChange?},
//    customLists?: string[][]}
//   Sheet: {id, name, blocks: {[rowBlock]: {[A1]: StoredCell}}, rows?: {[row]: Line}, cols?: {[col]: Line},
//    merges?: 'A1:B2'[], freeze?: {rows, cols}, tables?: Table[], zoom?: 10..400, tabColor?: '#RRGGBB',
//    hidden?: 'hidden'|'veryHidden', showGridlines?: false, showHeadings?: false, showZeros?: false,
//    showFormulas?: true, rightToLeft?: true, defaultRowHeight?, defaultColWidth?, autofilter?}
//   Line: {size?: px at 96 dpi, hidden?, s?: style id, custom?: true}
//   StoredCell: see store.mjs.
//
// The kernel's selection is a list of {anchor, focus} addresses. A grid selection is the
// gridcraft Selection {sheet, active, anchor, ranges}: each area is one kernel range whose
// anchor is the area's anchor cell and whose focus is the opposite corner, the primary range is
// the current (last) area and its anchor is the active cell (Excel: the white cell).
// No DOM, no Node built-ins.

import {MAX_ROWS, MAX_COLS, a1, colToLetters, parseCell, range as mkRange, rangeOf, rangeA1, isFullCols, isFullRows, contains, union, intersects} from '../lib/addr.mjs';
import {cellAt, storedValue} from './store.mjs';
import {merges, sheetIndex, activeSheetIndex, nextSheetName} from './sheet.mjs';
import {resolveStyle, styleById} from './style.mjs';

export const DEFAULT_ZOOM = 100;
export const MAX_SHEETS = 255;

/** A blank worksheet (gridcraft Sheet::new): defaults are implied by absent keys. */
export const newSheet = (id, name) => ({id, name, blocks: {}});

/** A new workbook with one sheet, `Sheet1` (Workbook::new + add_sheet). */
export function createWorkbook(uid = () => Math.random().toString(36).slice(2, 10)) {
  const id = uid();
  return {sheets: [newSheet(id, 'Sheet1')], activeSheetId: id, styles: [{}], names: []};
}

export {sheetIndex, activeSheetIndex, nextSheetName};

/** View flags of a sheet with their defaults (Sheet::new). */
export function sheetView(sheet) {
  return {
    zoom: Math.min(400, Math.max(10, sheet?.zoom ?? DEFAULT_ZOOM)),
    showGridlines: sheet?.showGridlines !== false,
    showHeadings: sheet?.showHeadings !== false,
    showZeros: sheet?.showZeros !== false,
    showFormulas: sheet?.showFormulas === true,
    rightToLeft: sheet?.rightToLeft === true,
  };
}

/** The style id of a cell: its own, else its row's, else its column's (Sheet::style_id). */
export function styleIdAt(sheet, row, col) {
  const c = cellAt(sheet, row, col);
  if (c) return c.s ?? 0;
  const r = sheet?.rows;
  if (r && typeof r === 'object' && r[row]?.s) return r[row].s;
  const k = sheet?.cols;
  if (k && typeof k === 'object' && k[col]?.s) return k[col].s;
  return 0;
}
/** The resolved style of a cell (schema-1 inline styles included). */
export function styleAt(content, sheet, row, col) {
  const c = cellAt(sheet, row, col);
  if (c?.style) return resolveStyle(c.style);
  if (c?.autoFmt && !c.style) return resolveStyle({numFmt: c.autoFmt});
  return resolveStyle(styleById(content, styleIdAt(sheet, row, col)));
}

// ---------------------------------------------------------------------------------------------
// Selection (crates/engine/src/selection.rs)

/** A selection at one cell. */
export const selectionAt = (sheet, cell) => ({sheet, active: {...cell}, anchor: {...cell}, ranges: [mkRange(cell)]});
/** The current (last) area. */
export const currentArea = sel => sel.ranges[sel.ranges.length - 1] ?? mkRange(sel.active);
/** Bounding range of all areas. */
export const selectionBounds = sel => sel.ranges.reduce((a, b) => union(a, b));
export const selectionContains = (sel, c) => sel.ranges.some(r => contains(r, c));
export const isSingleCell = sel => sel.ranges.length === 1 && sel.ranges[0].start.row === sel.ranges[0].end.row && sel.ranges[0].start.col === sel.ranges[0].end.col;

/** The corner of the current area opposite the anchor: the end Shift+arrows move. */
export function movingEnd(sel) {
  const r = currentArea(sel);
  return {row: sel.anchor.row === r.start.row ? r.end.row : r.start.row, col: sel.anchor.col === r.start.col ? r.end.col : r.start.col};
}
/** Extends the current area from the anchor to `to` (Shift+click / Shift+arrows). */
export function extendTo(sel, to) {
  const ranges = sel.ranges.slice(0, -1);
  ranges.push(mkRange(sel.anchor, to));
  return {...sel, ranges};
}
/**
 * Expands areas so merged cells are included whole. Whole columns and whole rows stay as they
 * are: clicking column B's header selects just B even when B1:C1 is merged, as in Excel.
 */
export function expandMerges(sel, sheet) {
  const ms = merges(sheet);
  if (!ms.length) return sel;
  const ranges = sel.ranges.map(r => {
    if (isFullCols(r) || isFullRows(r)) return r;
    let cur = r;
    for (;;) {
      let grown = cur;
      for (const m of ms) if (intersects(m, grown)) grown = union(grown, m);
      if (grown.start.row === cur.start.row && grown.start.col === cur.start.col && grown.end.row === cur.end.row && grown.end.col === cur.end.col) break;
      cur = grown;
    }
    return cur;
  });
  return {...sel, ranges};
}
/** Moves the active cell within the selection (Enter/Tab inside a multi-cell selection). */
export function cycle(sel, forward, byRow) {
  const r = currentArea(sel);
  if (sel.ranges.length === 1 && r.start.row === r.end.row && r.start.col === r.end.col) return sel;
  let row = sel.active.row, col = sel.active.col;
  const step = forward ? 1 : -1;
  if (byRow) {
    col += step;
    if (col > r.end.col) { col = r.start.col; row += 1; } else if (col < r.start.col) { col = r.end.col; row -= 1; }
    if (row > r.end.row) row = r.start.row; else if (row < r.start.row) row = r.end.row;
  } else {
    row += step;
    if (row > r.end.row) { row = r.start.row; col += 1; } else if (row < r.start.row) { row = r.end.row; col -= 1; }
    if (col > r.end.col) col = r.start.col; else if (col < r.start.col) col = r.end.col;
  }
  return {...sel, active: {row: Math.min(Math.max(row, 0), MAX_ROWS - 1), col: Math.min(Math.max(col, 0), MAX_COLS - 1)}};
}

/** Whether the cell shows a non-empty value (stored constant or computed by `valueOf`). */
const filledWith = valueOf => c => { const v = valueOf(c.row, c.col); return v !== null && v !== undefined && v !== ''; };

/**
 * Ctrl+arrow: jump to the edge of the current data region (Excel's End mode). `valueOf(row, col)`
 * gives the value a cell shows; `used` is the used range ({start, end}) or null.
 */
export function jump(valueOf, used, from, dr, dc) {
  if (dr === 0 && dc === 0) return from;
  const filled = filledWith(valueOf);
  const off = (c) => {
    const row = c.row + dr, col = c.col + dc;
    return row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS ? null : {row, col};
  };
  let cur = off(from);
  if (!cur) return from;
  const here = filled(from), next = filled(cur);
  if (here && next) {
    for (let n = off(cur); n && filled(n); n = off(cur)) cur = n;
    return cur;
  }
  for (;;) {
    if (filled(cur)) return cur;
    const beyond = !used || (dr > 0 && cur.row > used.end.row) || (dc > 0 && cur.col > used.end.col)
      || (dr < 0 && cur.row < used.start.row) || (dc < 0 && cur.col < used.start.col);
    if (beyond) return {row: dr > 0 ? MAX_ROWS - 1 : dr < 0 ? 0 : cur.row, col: dc > 0 ? MAX_COLS - 1 : dc < 0 ? 0 : cur.col};
    const n = off(cur);
    if (!n) return cur;
    cur = n;
  }
}

/** The contiguous data region around `c` (Ctrl+A, Ctrl+Shift+8, AutoSum, sort, tables). */
export function currentRegion(filledAt, c) {
  const rowHas = (row, a, b) => { for (let col = a; col <= b; col++) if (filledAt(row, col)) return true; return false; };
  const colHas = (col, a, b) => { for (let row = a; row <= b; row++) if (filledAt(row, col)) return true; return false; };
  let r0 = c.row, r1 = c.row, c0 = c.col, c1 = c.col;
  for (;;) {
    const before = [r0, r1, c0, c1].join();
    const loC = Math.max(c0 - 1, 0), hiC = Math.min(c1 + 1, MAX_COLS - 1);
    while (r0 > 0 && rowHas(r0 - 1, loC, hiC)) r0--;
    while (r1 + 1 < MAX_ROWS && rowHas(r1 + 1, loC, hiC)) r1++;
    const loR = Math.max(r0 - 1, 0), hiR = Math.min(r1 + 1, MAX_ROWS - 1);
    while (c0 > 0 && colHas(c0 - 1, loR, hiR)) c0--;
    while (c1 + 1 < MAX_COLS && colHas(c1 + 1, loR, hiR)) c1++;
    if ([r0, r1, c0, c1].join() === before) break;
  }
  return rangeOf(r0, c0, r1, c1);
}

// ---------------------------------------------------------------------------------------------
// Kernel selection <-> grid selection

const lineText = (r, sheetId) => {
  const p = `/sh:${encodeURIComponent(sheetId)}/`;
  if (isFullCols(r) && isFullRows(r)) return [`${p}A1`, `${p}${a1(MAX_ROWS - 1, MAX_COLS - 1)}`];
  if (isFullCols(r)) return [`${p}col:${colToLetters(r.start.col)}`, `${p}col:${colToLetters(r.end.col)}`];
  if (isFullRows(r)) return [`${p}row:${r.start.row + 1}`, `${p}row:${r.end.row + 1}`];
  return null;
};

/** The kernel selection for a grid selection: areas in order, the current one primary. */
export function toKernelSelection(content, sel) {
  const id = content.sheets[sel.sheet]?.id ?? content.sheets[0].id;
  const p = `/sh:${encodeURIComponent(id)}/`;
  const ranges = sel.ranges.map((r, i) => {
    const last = i === sel.ranges.length - 1;
    const line = lineText(r, id);
    if (line) {
      // Whole lines: anchor names the line holding the anchor, focus the far one.
      if (!last) return {anchor: line[0], focus: line[1]};
      const full = isFullCols(r) ? 'col' : 'row';
      const at = full === 'col' ? sel.anchor.col : sel.anchor.row;
      const lo = full === 'col' ? r.start.col : r.start.row, hi = full === 'col' ? r.end.col : r.end.row;
      const far = at === lo ? hi : lo;
      const name = n => (full === 'col' ? `${p}col:${colToLetters(n)}` : `${p}row:${n + 1}`);
      return isFullCols(r) && isFullRows(r) ? {anchor: line[0], focus: line[1]} : {anchor: name(at), focus: name(far)};
    }
    if (!last) return {anchor: p + a1(r.start.row, r.start.col), focus: p + a1(r.end.row, r.end.col)};
    const anchor = contains(r, sel.anchor) ? sel.anchor : r.start;
    const far = {row: anchor.row === r.start.row ? r.end.row : r.start.row, col: anchor.col === r.start.col ? r.end.col : r.start.col};
    return {anchor: p + a1(anchor.row, anchor.col), focus: p + a1(far.row, far.col)};
  });
  return {ranges, primary: ranges.length - 1};
}

/** One kernel address (cell, or row:/col: line) on a sheet → {row?, col?, line?}. */
function endpoint(text) {
  let m = /^row:(\d{1,7})$/i.exec(text);
  if (m) return {line: 'row', row: Number(m[1]) - 1};
  m = /^col:([A-Za-z]{1,3})$/i.exec(text);
  if (m) {
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
    return {line: 'col', col: n - 1};
  }
  const c = parseCell(text.replace(/\$/g, ''));
  return c ? {row: c.row, col: c.col} : null;
}

/**
 * The grid selection a kernel selection describes, or the active sheet's A1 when it names no
 * cells of the workbook. Areas on other sheets than the primary one's are dropped.
 */
export function fromKernelSelection(content, ksel) {
  const fallbackSheet = activeSheetIndex(content);
  const list = ksel?.ranges ?? [];
  const primary = Math.min(Math.max(ksel?.primary ?? list.length - 1, 0), Math.max(list.length - 1, 0));
  const parsed = list.map(r => {
    const a = /^\/sh:([^/]+)\/(.+)$/.exec(r.anchor ?? ''), f = /^\/sh:([^/]+)\/(.+)$/.exec(r.focus ?? r.anchor ?? '');
    if (!a || !f || a[1] !== f[1]) return null;
    const si = sheetIndex(content, decodeURIComponent(a[1]));
    if (si < 0) return null;
    const x = endpoint(a[2]), y = endpoint(f[2]);
    if (!x || !y) return null;
    if (x.line === 'col' && y.line === 'col') return {si, range: rangeOf(0, Math.min(x.col, y.col), MAX_ROWS - 1, Math.max(x.col, y.col)), anchor: {row: 0, col: x.col}};
    if (x.line === 'row' && y.line === 'row') return {si, range: rangeOf(Math.min(x.row, y.row), 0, Math.max(x.row, y.row), MAX_COLS - 1), anchor: {row: x.row, col: 0}};
    if (x.line || y.line) return null;
    return {si, range: mkRange(x, y), anchor: x};
  });
  const main = parsed[primary];
  if (!main) {
    // A selected object (`/sh:<id>/chart:3`, `/slicer:7`) keeps its own sheet in view; the cell selection falls back to A1 there.
    const anchor = list[primary]?.anchor ?? '';
    const onSheet = /^\/sh:([^/]+)\//.exec(anchor), slicer = /^\/slicer:(\d+)$/.exec(anchor);
    let si = onSheet ? sheetIndex(content, decodeURIComponent(onSheet[1])) : -1;
    if (slicer) si = (content.sheets ?? []).findIndex(s => (s.slicers ?? []).some(o => o.id === Number(slicer[1])));
    return selectionAt(si >= 0 ? si : fallbackSheet, {row: 0, col: 0});
  }
  const ranges = [];
  parsed.forEach((p, i) => { if (p && p.si === main.si && i !== primary) ranges.push(p.range); });
  ranges.push(main.range);
  return {sheet: main.si, active: {...main.anchor}, anchor: {...main.anchor}, ranges};
}

/** `A1:B2,D4` text of a selection's areas (the Name Box shows the current area). */
export const selectionA1 = sel => sel.ranges.map(rangeA1).join(',');

/** The value a cell shows, as stored (no calculation): constants only. */
export const storedValueAt = (sheet, row, col) => storedValue(cellAt(sheet, row, col));
