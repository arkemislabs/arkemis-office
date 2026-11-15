// Tables (graphic frames with a:tbl): cells, rows, merges and the built-in table style list.
// Translated from deckcraft crates/model/src/table.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Table JSON (deckcraft serde, as the `kind` of a table shape: `{type:'table', cols, rows, style,
// firstRow, firstCol, lastRow, lastCol, bandRow, bandCol, background?}`). The mutating functions
// below work on a copy and return it, so commands write the result through ctx.change.

import {bodyFromText, bodyEmpty, bodyText} from './text.mjs';

export const newCell = (text = '') => ({text: bodyFromText(text), fill: null, borders: [null, null, null, null], diagDown: null, diagUp: null,
  margins: null, anchor: null, gridSpan: 1, rowSpan: 1, hMerge: false, vMerge: false, vertical: null});
export const isCovered = c => !!(c.hMerge || c.vMerge);

/** deckcraft `Table::default()`. */
export const defaultTable = () => ({cols: [], rows: [], style: 'medium2-accent1', firstRow: true, firstCol: false, lastRow: false, lastCol: false, bandRow: true, bandCol: false});

export function newTable(rowsIn, colsIn, width, rowHeight) {
  const rows = Math.min(Math.max(rowsIn, 1), 1000), cols = Math.min(Math.max(colsIn, 1), 1000);
  const cw = cols > 0 ? width / cols : width;
  return {...defaultTable(), cols: Array(cols).fill(cw), rows: Array.from({length: rows}, () => ({height: rowHeight, cells: Array.from({length: cols}, () => newCell(''))}))};
}
export const nRows = t => t.rows.length;
export const nCols = t => t.cols.length;
export const cellAt = (t, r, c) => t.rows[r]?.cells?.[c] ?? null;
export const tableWidth = t => t.cols.reduce((a, b) => a + b, 0);
export const tableHeight = t => t.rows.reduce((a, r) => a + r.height, 0);

/** The merged areas: every uncovered cell spanning more than one cell, clipped to the grid. */
function merges(t) {
  const nr = t.rows.length, nc = t.cols.length;
  const out = [];
  t.rows.forEach((row, r) => row.cells.slice(0, nc).forEach((cell, c) => {
    if (isCovered(cell)) return;
    const rs = Math.min(Math.max(cell.rowSpan ?? 1, 1), nr - r), gs = Math.min(Math.max(cell.gridSpan ?? 1, 1), nc - c);
    if (rs > 1 || gs > 1) out.push({r, c, rs, gs});
  }));
  return out;
}
function setMerges(t, ms) {
  for (const row of t.rows) for (const cell of row.cells) Object.assign(cell, {gridSpan: 1, rowSpan: 1, hMerge: false, vMerge: false});
  for (const m of ms) {
    if (m.rs <= 1 && m.gs <= 1) continue;
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.gs; c++) {
      const cell = cellAt(t, r, c);
      if (cell) { cell.hMerge = c > m.c; cell.vMerge = r > m.r; }
    }
    const a = cellAt(t, m.r, m.c);
    if (a) { a.gridSpan = m.gs; a.rowSpan = m.rs; }
  }
}
const mInsertRow = (m, at) => (at <= m.r ? {...m, r: m.r + 1} : at < m.r + m.rs ? {...m, rs: m.rs + 1} : m);
const mInsertCol = (m, at) => (at <= m.c ? {...m, c: m.c + 1} : at < m.c + m.gs ? {...m, gs: m.gs + 1} : m);
const keep = m => (m.rs >= 1 && m.gs >= 1 && (m.rs > 1 || m.gs > 1) ? m : null);
const mDeleteRow = (m, at) => keep(at < m.r ? {...m, r: m.r - 1} : at < m.r + m.rs ? {...m, rs: m.rs - 1} : m);
const mDeleteCol = (m, at) => keep(at < m.c ? {...m, c: m.c - 1} : at < m.c + m.gs ? {...m, gs: m.gs - 1} : m);
function moveAnchor(t, [fr, fc], [tr, tc]) {
  const a = cellAt(t, fr, fc), b = cellAt(t, tr, tc);
  if (!a || !b) return;
  t.rows[tr].cells[tc] = a;
  t.rows[fr].cells[fc] = b;
}

/** Insert an empty row before `at`. A merge the new row falls inside grows to cover it. */
export function insertRow(table, atIn) {
  const t = structuredClone(table);
  const at = Math.min(atIn, t.rows.length);
  const ms = merges(t);
  const h = t.rows[Math.max(at - 1, 0)]?.height ?? 30;
  t.rows.splice(at, 0, {height: h, cells: t.cols.map(() => newCell(''))});
  setMerges(t, ms.map(m => mInsertRow(m, at)));
  return t;
}
/** Insert an empty column before `at`. */
export function insertCol(table, atIn) {
  const t = structuredClone(table);
  const at = Math.min(atIn, t.cols.length);
  const ms = merges(t);
  const w = t.cols[Math.max(at - 1, 0)] ?? 80;
  t.cols.splice(at, 0, w);
  for (const r of t.rows) r.cells.splice(Math.min(at, r.cells.length), 0, newCell(''));
  setMerges(t, ms.map(m => mInsertCol(m, at)));
  return t;
}
/** Delete row `at` (null when it can't: the last row, or out of range). */
export function deleteRow(table, at) {
  if (table.rows.length <= 1 || at >= table.rows.length) return null;
  const t = structuredClone(table);
  const ms = merges(t);
  for (const m of ms) if (m.r === at && m.rs > 1) moveAnchor(t, [m.r, m.c], [m.r + 1, m.c]);
  t.rows.splice(at, 1);
  setMerges(t, ms.map(m => mDeleteRow(m, at)).filter(Boolean));
  return t;
}
/** Delete column `at` (null when it can't). */
export function deleteCol(table, at) {
  if (table.cols.length <= 1 || at >= table.cols.length) return null;
  const t = structuredClone(table);
  const ms = merges(t);
  for (const m of ms) if (m.c === at && m.gs > 1) moveAnchor(t, [m.r, m.c], [m.r, m.c + 1]);
  t.cols.splice(at, 1);
  for (const r of t.rows) if (at < r.cells.length) r.cells.splice(at, 1);
  setMerges(t, ms.map(m => mDeleteCol(m, at)).filter(Boolean));
  return t;
}
/** Merge the rectangle (r0,c0)–(r1,c1) inclusive into its top-left cell (null when it can't). */
export function merge(table, a0, b0, a1, b1) {
  let r0 = Math.min(a0, a1), r1 = Math.max(a0, a1), c0 = Math.min(b0, b1), c1 = Math.max(b0, b1);
  if (r1 >= table.rows.length || c1 >= table.cols.length || (r0 === r1 && c0 === c1)) return null;
  const t = structuredClone(table);
  for (;;) {
    const before = [r0, c0, r1, c1].join();
    t.rows.forEach((row, r) => row.cells.slice(0, t.cols.length).forEach((cell, c) => {
      if (isCovered(cell)) return;
      const ar1 = Math.min(r + Math.max(cell.rowSpan ?? 1, 1) - 1, t.rows.length - 1);
      const ac1 = Math.min(c + Math.max(cell.gridSpan ?? 1, 1) - 1, t.cols.length - 1);
      if (r <= r1 && ar1 >= r0 && c <= c1 && ac1 >= c0) { r0 = Math.min(r0, r); c0 = Math.min(c0, c); r1 = Math.max(r1, ar1); c1 = Math.max(c1, ac1); }
    }));
    if ([r0, c0, r1, c1].join() === before) break;
  }
  const text = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cell = cellAt(t, r, c);
    if (!cell) continue;
    // Rust `append` drains the cell's paragraphs into the anchor's.
    if (!bodyEmpty(cell.text)) { text.push(...cell.text.paragraphs); cell.text = {...cell.text, paragraphs: []}; }
    Object.assign(cell, {hMerge: c > c0, vMerge: r > r0, gridSpan: 1, rowSpan: 1});
  }
  const a = cellAt(t, r0, c0);
  Object.assign(a, {gridSpan: c1 - c0 + 1, rowSpan: r1 - r0 + 1, hMerge: false, vMerge: false});
  if (text.length) a.text = {...a.text, paragraphs: text};
  return t;
}
/** Undo a merge at (r, c) (null when the cell isn't merged). */
export function split(table, r, c) {
  const cell = cellAt(table, r, c);
  if (!cell) return null;
  const gs = Math.max(cell.gridSpan ?? 1, 1), rs = Math.max(cell.rowSpan ?? 1, 1);
  if (gs === 1 && rs === 1) return null;
  const t = structuredClone(table);
  for (let rr = r; rr < Math.min(r + rs, t.rows.length); rr++) for (let cc = c; cc < Math.min(c + gs, t.cols.length); cc++) {
    Object.assign(t.rows[rr].cells[cc], {hMerge: false, vMerge: false, gridSpan: 1, rowSpan: 1});
  }
  return t;
}
/** Make every row have exactly cols.length cells (repair after loading). */
export function normalizeTable(table) {
  const t = structuredClone(table);
  const n = t.cols.length;
  for (const r of t.rows) {
    while (r.cells.length < n) r.cells.push(newCell(''));
    r.cells.length = n;
    for (const c of r.cells) { c.gridSpan = Math.max(c.gridSpan ?? 1, 1); c.rowSpan = Math.max(c.rowSpan ?? 1, 1); }
  }
  return t;
}
export const cellText = (t, r, c) => bodyText(cellAt(t, r, c)?.text);

/** Built-in table styles: [id, label]. Styles are generated from the theme accents. */
export function tableStyles() {
  const v = [['none', 'No Style, No Grid'], ['grid', 'No Style, Table Grid']];
  for (const [kind, label] of [['light1', 'Light Style 1'], ['light2', 'Light Style 2'], ['medium2', 'Medium Style 2'], ['medium4', 'Medium Style 4'], ['dark1', 'Dark Style 1']]) {
    v.push([`${kind}-tx1`, label]);
    for (let a = 1; a <= 6; a++) v.push([`${kind}-accent${a}`, `${label} - Accent ${a}`]);
  }
  return v;
}
