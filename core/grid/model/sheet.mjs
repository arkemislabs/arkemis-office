// Worksheet geometry and view state: row heights and column widths (with hidden lines), the
// O(log n) position ↔ line index, merged ranges, frozen panes, sheet names.
// Translated from gridcraft crates/model/src/sheet.rs (Sheet geometry, LineIndex, line_at,
// points_to_chars) and crates/model/src/workbook.rs (check_sheet_name, next_sheet_name, name, table)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored form (schema 2): `rows`/`cols` map a 0-based index to {size?: px at 96 dpi, hidden?,
// outline?, collapsed?, s?: style id, custom?}; `merges` is a list of 'A1:B2'; `freeze` is
// {rows, cols} or absent. Schema-1 sheets keep `xlsxLayout` {rowHeights (points, 1-based),
// columnWidths (characters, 1-based), merges, freeze: {xSplit, ySplit}}, read here the same way.
// No DOM, no Node built-ins.

import {MAX_COLS, MAX_ROWS, parseRange, contains as rangeContains, intersects} from '../lib/addr.mjs';
import {isLegacySheet} from './store.mjs';

export const DEFAULT_COL_WIDTH = 64;
export const DEFAULT_ROW_HEIGHT = 20;

/** Column width in pixels → the characters the Column Width dialog shows. */
export const pointsToChars = px => (px <= 12 ? Math.round((px / 12) * 100) / 100 : Math.trunc(((px - 5) / 7) * 100 + 0.5) / 100);
/** Characters (Column Width dialog) → pixels. */
export const charsToPixels = ch => (ch <= 1 ? Math.round(ch * 12) : Math.round(ch * 7 + 5));

const lineCache = new WeakMap();
/** Line infos of a sheet axis as a sorted array of [index, info] (cached per map object). */
function linesOf(sheet, axis) {
  if (isLegacySheet(sheet)) return legacyLines(sheet, axis);
  const map = sheet?.[axis];
  if (!map) return EMPTY;
  let v = lineCache.get(map);
  if (v) return v;
  v = Object.keys(map).map(k => [Number(k), map[k]]).filter(([k]) => Number.isInteger(k) && k >= 0).sort((p, q) => p[0] - q[0]);
  lineCache.set(map, v);
  return v;
}
const EMPTY = Object.freeze([]);
const legacyCache = new WeakMap();
function legacyLines(sheet, axis) {
  const layout = sheet.xlsxLayout;
  if (!layout) return EMPTY;
  const src = axis === 'rows' ? layout.rowHeights : layout.columnWidths;
  if (!src) return EMPTY;
  let v = legacyCache.get(src);
  if (v) return v;
  v = Object.entries(src).map(([k, x]) => [Number(k) - 1, axis === 'rows' ? {size: (x * 4) / 3, custom: true} : x === 0 ? {hidden: true} : {size: charsToPixels(x)}])
    .sort((p, q) => p[0] - q[0]);
  legacyCache.set(src, v);
  return v;
}
/** Info of one line (row or column), or null. */
export function lineInfo(sheet, axis, i) {
  if (isLegacySheet(sheet)) return linesOf(sheet, axis).find(([k]) => k === i)?.[1] ?? null;
  return sheet?.[axis]?.[i] ?? null;
}
export const defaultColWidth = sheet => sheet?.defaultColWidth ?? DEFAULT_COL_WIDTH;
export const defaultRowHeight = sheet => sheet?.defaultRowHeight ?? DEFAULT_ROW_HEIGHT;
/** Column width in px (0 when hidden). */
export function colWidth(sheet, col) {
  const i = lineInfo(sheet, 'cols', col);
  if (i?.hidden) return 0;
  return i?.size ?? defaultColWidth(sheet);
}
/** Row height in px (0 when hidden). */
export function rowHeight(sheet, row) {
  const i = lineInfo(sheet, 'rows', row);
  if (i?.hidden) return 0;
  return i?.size ?? defaultRowHeight(sheet);
}
export const isRowHidden = (sheet, row) => !!lineInfo(sheet, 'rows', row)?.hidden;
export const isColHidden = (sheet, col) => !!lineInfo(sheet, 'cols', col)?.hidden;

/**
 * Prefix sums over the custom-sized lines of an axis (gridcraft LineIndex): start(line) and
 * at(pos) in O(log n) even when every line has its own size.
 */
export class LineIndex {
  constructor(lines, def, max) {
    this.def = def; this.max = max;
    this.lines = [];
    let pos = 0, prev = 0;
    for (const [line, info] of lines) {
      if (line >= max) break;
      pos += (line - prev) * def;
      const size = info.hidden ? 0 : info.size ?? def;
      this.lines.push([line, pos, size]);
      pos += size;
      prev = line + 1;
    }
  }
  start(line) {
    const L = this.lines;
    let lo = 0, hi = L.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (L[mid][0] < line) lo = mid + 1; else hi = mid; }
    if (lo < L.length && L[lo][0] === line) return L[lo][1];
    if (lo === 0) return line * this.def;
    const [l, p, s] = L[lo - 1];
    return p + s + (line - l - 1) * this.def;
  }
  size(line) {
    const L = this.lines;
    let lo = 0, hi = L.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (L[mid][0] < line) lo = mid + 1; else hi = mid; }
    return lo < L.length && L[lo][0] === line ? L[lo][2] : this.def;
  }
  at(pos) {
    if (pos <= 0) return 0;
    const L = this.lines;
    let lo = 0, hi = L.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (L[mid][1] <= pos) lo = mid + 1; else hi = mid; }
    let baseLine = 0, basePos = 0;
    if (lo > 0) {
      const [l, p, s] = L[lo - 1];
      if (pos < p + s) return Math.min(l, this.max - 1);
      baseLine = l + 1; basePos = p + s;
    }
    if (this.def <= 0) return Math.min(baseLine, this.max - 1);
    const r = baseLine + Math.floor((pos - basePos) / this.def);
    return r >= this.max ? this.max - 1 : r;
  }
  /** Total extent of the axis. */
  get total() { return this.start(this.max); }
}
const indexCache = new WeakMap();
/** The LineIndex of a sheet axis, cached per sheet object. */
export function lineIndex(sheet, axis) {
  let per = indexCache.get(sheet);
  if (!per) { per = {}; indexCache.set(sheet, per); }
  if (!per[axis]) per[axis] = new LineIndex(linesOf(sheet, axis), axis === 'rows' ? defaultRowHeight(sheet) : defaultColWidth(sheet), axis === 'rows' ? MAX_ROWS : MAX_COLS);
  return per[axis];
}
export const rowTop = (sheet, row) => lineIndex(sheet, 'rows').start(row);
export const colLeft = (sheet, col) => lineIndex(sheet, 'cols').start(col);
export const rowAt = (sheet, y) => lineIndex(sheet, 'rows').at(y);
export const colAt = (sheet, x) => lineIndex(sheet, 'cols').at(x);

// ---------------------------------------------------------------------------------------------
// Merges and freeze

const mergeCache = new WeakMap();
/** Merged ranges of a sheet as range objects. */
export function merges(sheet) {
  const src = isLegacySheet(sheet) ? sheet.xlsxLayout?.merges : sheet?.merges;
  if (!src || !src.length) return EMPTY;
  let v = mergeCache.get(src);
  if (!v) { v = src.map(parseRange).filter(Boolean); mergeCache.set(src, v); }
  return v;
}
/** The merged range containing (row, col), or null. */
export function mergeAt(sheet, row, col) {
  for (const m of merges(sheet)) if (rangeContains(m, {row, col})) return m;
  return null;
}
export const mergesIntersecting = (sheet, range) => merges(sheet).filter(m => intersects(m, range));
/** Frozen rows and columns: {rows, cols} (zeros when not frozen). */
export function freeze(sheet) {
  if (isLegacySheet(sheet)) {
    const f = sheet.xlsxLayout?.freeze;
    return {rows: f?.ySplit ?? 0, cols: f?.xSplit ?? 0};
  }
  return {rows: sheet?.freeze?.rows ?? 0, cols: sheet?.freeze?.cols ?? 0};
}

// ---------------------------------------------------------------------------------------------
// Workbook-level (workbook.rs)

/** Index of a sheet by id, or by name (case-insensitive); -1 when absent. */
export function sheetIndex(content, idOrName) {
  const sheets = content?.sheets ?? [];
  let i = sheets.findIndex(s => s.id === idOrName);
  if (i < 0 && typeof idOrName === 'string') { const l = idOrName.toLowerCase(); i = sheets.findIndex(s => s.name.toLowerCase() === l); }
  return i;
}
export const activeSheetIndex = content => Math.max(0, (content?.sheets ?? []).findIndex(s => s.id === content.activeSheetId));
/** A fresh `SheetN` name not in use. */
export function nextSheetName(content) {
  for (let n = 1; ; n++) if (sheetIndex(content, `Sheet${n}`) < 0 || !(content.sheets ?? []).some(s => s.name.toLowerCase() === `sheet${n}`)) {
    if (!(content.sheets ?? []).some(s => s.name.toLowerCase() === `sheet${n}`)) return `Sheet${n}`;
  }
}
/** Validates a sheet name like Excel; returns null when fine, else the message. */
export function checkSheetName(content, name, exceptIndex = -1) {
  const n = [...name].length;
  if (n === 0) return "A sheet name can't be blank.";
  if (n > 31) return "A sheet name can't be longer than 31 characters.";
  if (/[:\\/?*[\]]/.test(name)) return "A sheet name can't contain any of these characters: : \\ / ? * [ ]";
  if (name.startsWith("'") || name.endsWith("'")) return "A sheet name can't begin or end with an apostrophe.";
  if (name.toLowerCase() === 'history') return '"History" is a reserved name.';
  const i = (content.sheets ?? []).findIndex(s => s.name.toLowerCase() === name.toLowerCase());
  if (i >= 0 && i !== exceptIndex) return 'That name is already taken. Try a different one.';
  return null;
}
/** A defined name visible from sheet index `si`: sheet scope first, then workbook scope. */
export function definedName(content, name, si) {
  const names = content?.names ?? [];
  const l = name.toLowerCase();
  const sheetId = content?.sheets?.[si]?.id;
  return names.find(n => n.scope && n.scope === sheetId && n.name.toLowerCase() === l)
    ?? names.find(n => !n.scope && n.name.toLowerCase() === l) ?? null;
}
/** A table by name across sheets: [sheetIndex, table] or null. */
export function tableByName(content, name) {
  const l = name.toLowerCase();
  const sheets = content?.sheets ?? [];
  for (let si = 0; si < sheets.length; si++) {
    const t = (sheets[si].tables ?? []).find(x => x.name.toLowerCase() === l);
    if (t) return [si, t];
  }
  return null;
}
/** Table geometry from its stored form ({range: 'A1:C9', headerRow, totalsRow, columns}). */
export function tableRanges(t) {
  const range = typeof t.range === 'string' ? parseRange(t.range) : t.range;
  const headerRow = t.headerRow !== false, totalsRow = !!t.totalsRow;
  const r0 = range.start.row + (headerRow ? 1 : 0), r1 = range.end.row - (totalsRow ? 1 : 0);
  const data = r1 >= r0 ? {start: {row: r0, col: range.start.col}, end: {row: r1, col: range.end.col}} : null;
  return {range, data, headerRow, totalsRow};
}
