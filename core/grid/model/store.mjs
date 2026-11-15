// Sparse cell storage in 256-row blocks over the immutable document content.
// Translated from gridcraft crates/model/src/store.rs (CellStore: bands of rows behind shared
// pointers, copy-on-write per band) and crates/model/src/cell.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream keeps 64-row bands behind `Arc`; here a sheet holds `blocks[floor(row / 256)][A1]`
// (docs/architecture.md 4.2) and the kernel's structural sharing copies only the block an edit
// touches. Stored cell: {v?: value, f?: formula text without '=', s?: style id, a?: 'A1:B2'
// (legacy array formula range), d?: true (dynamic-array mark)}. A blank cell (no value, formula
// or style) is never stored.
//
// Schema-1 documents (today's legacy editor: `sheets[i].cells[A1] = {value: text, bold?, ...}`)
// are read through the same functions: `cellAt` normalises such a cell to the stored-cell shape
// with an inline `style` object instead of a style id. Writes to schema-1 sheets keep schema 1.
// No DOM, no Node built-ins.

import {MAX_COLS, MAX_ROWS, a1, colToLetters, lettersToCol} from '../lib/addr.mjs';
import {fromJSONValue} from '../lib/value.mjs';
import {parseInput} from '../lib/parse.mjs';

export const BLOCK_ROWS = 256;
export const blockOf = row => Math.floor(row / BLOCK_ROWS);

/** Whether a sheet uses schema-1 storage (`cells`) rather than blocks. */
export const isLegacySheet = sheet => !!sheet && !sheet.blocks && !!sheet.cells;

const KEY_RE = /^([A-Z]{1,3})([0-9]{1,7})$/;
const keyCache = new Map();
/** `B7` → [row, col] (0-based), cached. null for anything else. */
export function parseKey(k) {
  let p = keyCache.get(k);
  if (p !== undefined) return p;
  const m = KEY_RE.exec(k);
  p = m ? [Number(m[2]) - 1, lettersToCol(m[1])] : null;
  if (keyCache.size > 200_000) keyCache.clear();
  keyCache.set(k, p);
  return p;
}

const parsedBlocks = new WeakMap();
/** A block's cells as parallel arrays sorted row-major: {rows, cols, keys, cells}. Cached per block object. */
export function blockEntries(block) {
  let e = parsedBlocks.get(block);
  if (e) return e;
  const list = [];
  for (const k in block) {
    const p = parseKey(k);
    if (p) list.push([p[0], p[1], k, block[k]]);
  }
  list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  e = {rows: list.map(x => x[0]), cols: list.map(x => x[1]), keys: list.map(x => x[2]), cells: list.map(x => x[3])};
  parsedBlocks.set(block, e);
  return e;
}

const legacyIndex = new WeakMap();
/** Schema-1 sheets: their `cells` regrouped into blocks once per cells object (read-only). */
function legacyBlocks(sheet) {
  let b = legacyIndex.get(sheet.cells);
  if (b) return b;
  b = {};
  for (const k in sheet.cells) {
    const p = parseKey(k);
    if (!p) continue;
    (b[blockOf(p[0])] ??= {})[k] = sheet.cells[k];
  }
  legacyIndex.set(sheet.cells, b);
  return b;
}
/** The blocks object of a sheet (schema 1 sheets get a derived one). */
export const sheetBlocks = sheet => (isLegacySheet(sheet) ? legacyBlocks(sheet) : sheet?.blocks ?? EMPTY_BLOCKS);
const EMPTY_BLOCKS = Object.freeze({});

// ---------------------------------------------------------------------------------------------
// Schema-1 cells → stored-cell shape

const legacyCells = new WeakMap();
/** A schema-1 cell `{value: text, bold?, ...}` as a stored cell {v, f, style} (cached per object). */
export function fromLegacyCell(c, sys = 1900) {
  let n = legacyCells.get(c);
  if (n) return n;
  const text = typeof c.value === 'string' ? c.value : '';
  const style = legacyStyle(c);
  n = {};
  if (c.valueType === 'text') { if (text !== '') n.v = text; }
  else if (text.startsWith('=') && text.length > 1) n.f = text.slice(1);
  else if (text !== '') {
    const p = parseInput(text, sys);
    if (p.value !== null) n.v = p.value instanceof Object && 'text' in p.value ? {e: p.value.text} : p.value;
    if (p.format && !style?.numFmt) n.autoFmt = p.format;
  }
  if (style) n.style = style;
  legacyCells.set(c, n);
  return n;
}
/** Schema-1 inline style props → a sparse style object (style.mjs shape). */
export function legacyStyle(c) {
  const st = {};
  const font = {};
  if (c.fontFamily) font.name = c.fontFamily;
  if (c.fontSize) font.size = c.fontSize;
  if (c.bold) font.bold = true;
  if (c.italic) font.italic = true;
  if (c.underline && c.underline !== 'none') font.underline = c.underline;
  if (c.strike) font.strike = true;
  if (c.color) font.color = c.color;
  if (Object.keys(font).length) st.font = font;
  if (c.background) st.fill = {pattern: 'solid', fg: c.background};
  const align = {};
  if (c.align) align.h = c.align;
  if (c.verticalAlign && c.verticalAlign !== 'bottom') align.v = c.verticalAlign === 'middle' ? 'center' : c.verticalAlign;
  if (c.wrap) align.wrap = true;
  if (c.rotation) align.rotation = c.rotation;
  if (c.indent) align.indent = c.indent;
  if (Object.keys(align).length) st.align = align;
  if (c.numFmt && c.numFmt !== 'General') st.numFmt = c.numFmt;
  if (c.borders && Object.keys(c.borders).length) {
    st.borders = {};
    for (const [edge, b] of Object.entries(c.borders)) st.borders[edge] = {style: b.style, color: b.color};
  }
  return Object.keys(st).length ? st : null;
}

// ---------------------------------------------------------------------------------------------
// Reads

/** The stored cell at (row, col) of a sheet object, or null (schema-1 cells normalised). */
export function cellAt(sheet, row, col) {
  if (!sheet) return null;
  if (isLegacySheet(sheet)) {
    const c = sheet.cells[a1(row, col)];
    return c ? fromLegacyCell(c) : null;
  }
  const b = sheet.blocks?.[blockOf(row)];
  if (!b) return null;
  return b[colToLetters(col) + (row + 1)] ?? null;
}
/** Raw stored object (schema-1 cells unnormalised). */
export function rawCellAt(sheet, row, col) {
  if (!sheet) return null;
  if (isLegacySheet(sheet)) return sheet.cells[a1(row, col)] ?? null;
  return sheet.blocks?.[blockOf(row)]?.[colToLetters(col) + (row + 1)] ?? null;
}
/** A stored cell's own value (constant, or the cached result a file carried for a formula). */
export const storedValue = cell => (cell ? fromJSONValue(cell.v) : null);
/** Whether the stored cell has a value or a formula (gridcraft `CellStore::has`). */
export const hasContent = cell => !!cell && (cell.f !== undefined || (cell.v !== undefined && cell.v !== null));

/**
 * Calls fn(row, col, cell, key) for every stored cell in rows r0..r1 and columns c0..c1, row-major,
 * until fn returns false. Cells are normalised for schema-1 sheets.
 */
export function forEachCell(sheet, r0, c0, r1, c1, fn) {
  if (!sheet) return;
  const legacy = isLegacySheet(sheet);
  const blocks = sheetBlocks(sheet);
  const b0 = blockOf(r0), b1 = blockOf(Math.min(r1, MAX_ROWS - 1));
  const keys = blockKeysBetween(blocks, b0, b1);
  for (const bk of keys) {
    const e = blockEntries(blocks[bk]);
    const n = e.rows.length;
    // Rows ascend: binary search the first row >= r0.
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (e.rows[mid] < r0) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < n; i++) {
      const row = e.rows[i];
      if (row > r1) break;
      const col = e.cols[i];
      if (col < c0 || col > c1) continue;
      const cell = legacy ? fromLegacyCell(e.cells[i]) : e.cells[i];
      if (fn(row, col, cell, e.keys[i]) === false) return;
    }
  }
}
/** Block keys (numbers) of a blocks object between b0 and b1, ascending. */
export function blockKeysBetween(blocks, b0, b1) {
  const out = [];
  if (b1 - b0 < 64) {
    for (let b = b0; b <= b1; b++) if (blocks[b] !== undefined) out.push(b);
    return out;
  }
  for (const k in blocks) { const b = Number(k); if (b >= b0 && b <= b1) out.push(b); }
  return out.sort((x, y) => x - y);
}
/** Smallest range holding every stored cell: {r0, c0, r1, c1} or null. */
export function usedBounds(sheet) {
  if (!sheet) return null;
  const blocks = sheetBlocks(sheet);
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  for (const k in blocks) {
    const e = blockEntries(blocks[k]);
    if (!e.rows.length) continue;
    r0 = Math.min(r0, e.rows[0]);
    r1 = Math.max(r1, e.rows[e.rows.length - 1]);
    for (const c of e.cols) { if (c < c0) c0 = c; if (c > c1) c1 = c; }
  }
  return r1 < 0 ? null : {r0, c0, r1, c1};
}
/** Number of stored cells. */
export function cellCount(sheet) {
  if (!sheet) return 0;
  if (isLegacySheet(sheet)) return Object.keys(sheet.cells).length;
  let n = 0;
  for (const k in sheet.blocks ?? {}) n += blockEntries(sheet.blocks[k]).rows.length;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Writes (through ctx.change: kernel ChangeApi, paths relative to content)

const isBlank = c => !c || (c.v === undefined && c.f === undefined && (c.s === undefined || c.s === 0) && c.a === undefined);

/** Stores a cell (a blank one removes it), creating the block as needed. Schema 2 only. */
export function writeCell(change, content, si, row, col, cell) {
  const key = colToLetters(col) + (row + 1);
  const b = blockOf(row);
  if (!change.get(['sheets', si, 'blocks'])) change.set(['sheets', si, 'blocks'], {});
  const block = change.get(['sheets', si, 'blocks', String(b)]);
  if (isBlank(cell)) {
    if (!block || !(key in block)) return false;
    if (Object.keys(block).length === 1) change.delete(['sheets', si, 'blocks', String(b)]);
    else change.delete(['sheets', si, 'blocks', String(b), key]);
    return true;
  }
  const clean = {};
  if (cell.v !== undefined && cell.v !== null) clean.v = cell.v;
  if (cell.f !== undefined) clean.f = cell.f;
  if (cell.s) clean.s = cell.s;
  if (cell.a !== undefined) clean.a = cell.a;
  if (cell.d) clean.d = true;
  if (!block) { change.set(['sheets', si, 'blocks', String(b)], {[key]: clean}); return true; }
  change.set(['sheets', si, 'blocks', String(b), key], clean);
  return true;
}
/** Schema-1 write: the legacy cell object at a key (null removes it). */
export function writeLegacyCell(change, si, row, col, cell) {
  const key = a1(row, col);
  if (!cell) change.delete(['sheets', si, 'cells', key]);
  else change.set(['sheets', si, 'cells', key], cell);
}

export {MAX_ROWS, MAX_COLS};
