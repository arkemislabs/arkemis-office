// Draw Table: the pencil splits cells along the line you draw, the table eraser merges the two
// cells on either side of the border you click. Pure operations on a table in its own coordinates
// (points from its top-left corner). Both work on the table's anchors (each visible cell with its
// row and column span), edit that list, then lay the grid back out, so merges anywhere in the table
// survive.
// Translated from deckcraft crates/engine/src/drawtable.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {newCell, isCovered, normalizeTable} from './table.mjs';
import {bodyEmpty} from './text.mjs';

/** A line closer than this to an existing grid line reuses it rather than adding a sliver. */
const SNAP = 4;
/** Cap on the grid so a runaway pencil can't build an enormous table. */
export const MAX_GRID = 200;

function anchorsOf(t) {
  const v = [];
  t.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
    if (isCovered(cell)) return;
    const rs = Math.max(Math.min(Math.max(cell.rowSpan ?? 1, 1), t.rows.length - r), 1);
    const cs = Math.max(Math.min(Math.max(cell.gridSpan ?? 1, 1), t.cols.length - c), 1);
    v.push({r, c, rs, cs, cell: structuredClone(cell)});
  }));
  return v;
}

/** Lay `anchors` out into `t`'s grid (its rows and columns already sized). */
function rebuild(t, anchors) {
  const nr = t.rows.length, nc = t.cols.length;
  for (const row of t.rows) row.cells = Array.from({length: nc}, () => newCell(''));
  for (const a of anchors) {
    for (let r = a.r; r < Math.min(a.r + a.rs, nr); r++) {
      for (let c = a.c; c < Math.min(a.c + a.cs, nc); c++) {
        const x = t.rows[r]?.cells[c];
        if (x) { x.hMerge = c > a.c; x.vMerge = r > a.r; }
      }
    }
    if (t.rows[a.r]?.cells[a.c]) t.rows[a.r].cells[a.c] = {...a.cell, gridSpan: a.cs, rowSpan: a.rs, hMerge: false, vMerge: false};
  }
  return normalizeTable(t);
}

/** Swap rows and columns, so the vertical case reuses the horizontal one. */
function transpose(t) {
  const heights = t.rows.map(r => r.height);
  const a = anchorsOf(t);
  for (const x of a) {
    [x.r, x.c] = [x.c, x.r];
    [x.rs, x.cs] = [x.cs, x.rs];
    const [l, r, tp, b] = x.cell.borders ?? [null, null, null, null];
    x.cell.borders = [tp, b, l, r];
  }
  const widths = t.cols;
  t.cols = heights;
  t.rows = widths.map(h => ({height: h, cells: []}));
  return rebuild(t, a);
}

const edgesOf = list => { const e = [0]; let acc = 0; for (const s of list) { acc += s; e.push(acc); } return e; };
const finite = (...v) => v.every(Number.isFinite);

/** Least height (pt) of a row, and width of a column, the pencil leaves when it splits one. */
const MIN_ROW = 18, MIN_COL = 40;

/** A horizontal line at `y` from `x0` to `x1` (the pencil). Returns [table, changed]. */
function splitRows(t0, y0, x0, x1, minPiece = 0) {
  let y = y0;
  let t = structuredClone(t0);
  const ys = edgesOf(t.rows.map(r => r.height));
  const xs = edgesOf(t.cols);
  const total = ys[ys.length - 1] ?? 0;
  if (y <= SNAP || y >= total - SNAP || x1 - x0 < SNAP) return [t0, false];
  let a = anchorsOf(t);
  // Boundary index b: an existing grid line near y, or a new one splitting row k.
  let b = ys.findIndex(e => Math.abs(e - y) <= SNAP);
  if (b < 0) {
    if (t.rows.length >= MAX_GRID) return [t0, false];
    const k = ys.findIndex((e, i) => i + 1 < ys.length && e < y && y < ys[i + 1]);
    if (k < 0) return [t0, false];
    const top = ys[k];
    // A new line leaves each piece at least `minPiece` wide (a column the pencil cut hair-thin would wrap its text a letter a line); a
    // cell too small to give both pieces that is left alone.
    if (minPiece > 0) {
      if (ys[k + 1] - top < minPiece * 2) return [t0, false];
      y = Math.min(Math.max(y, top + minPiece), ys[k + 1] - minPiece);
    }
    const h0 = y - top, h1 = ys[k + 1] - y;
    t.rows[k].height = h0;
    t.rows.splice(k + 1, 0, {height: h1, cells: []});
    for (const x of a) {
      if (x.r > k) x.r += 1;
      else if (x.r + x.rs > k) x.rs += 1;
    }
    b = k + 1;
  }
  let changed = false;
  const out = [];
  for (const x of a) {
    const l = xs[x.c] ?? 0, r = xs[x.c + x.cs] ?? 0;
    // The line divides a cell it crosses for more than half of the cell's width.
    const overlap = Math.max(Math.min(r, x1) - Math.max(l, x0), 0);
    if (x.r < b && b < x.r + x.rs && overlap * 2 > r - l) {
      const below = {r: b, c: x.c, rs: x.r + x.rs - b, cs: x.cs, cell: {...structuredClone(x.cell), text: {body: {}, paragraphs: []}}};
      out.push({...x, rs: b - x.r});
      out.push(below);
      changed = true;
    } else out.push(x);
  }
  t = rebuild(t, out);
  return [t, changed];
}

/**
 * Draw a line from `a` to `b` (table points). Mostly-horizontal lines split rows, mostly-vertical
 * ones split columns; only the cells the line crosses are divided. Returns the new table, or null
 * when nothing changed.
 */
export function drawLine(table, a, b) {
  if (![a[0], a[1], b[0], b[1]].every(Number.isFinite) || !table.rows.length || !table.cols.length) return null;
  if (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])) {
    const [t, changed] = splitRows(table, (a[1] + b[1]) / 2, Math.min(a[0], b[0]), Math.max(a[0], b[0]), MIN_ROW);
    return changed ? t : null;
  }
  const flipped = transpose(structuredClone(table));
  const [t, changed] = splitRows(flipped, (a[0] + b[0]) / 2, Math.min(a[1], b[1]), Math.max(a[1], b[1]), MIN_COL);
  return changed ? transpose(t) : null;
}

/**
 * Erase the border nearest `p` (within `tol` points): the two cells it separates merge, when
 * together they make a rectangle. Returns the new table, or null when no border was erased.
 */
export function eraseAt(table, p, tol) {
  if (!finite(p[0], p[1])) return null;
  const t = structuredClone(table);
  const ys = edgesOf(t.rows.map(r => r.height));
  const xs = edgesOf(t.cols);
  const a = anchorsOf(t);
  const rect = x => [xs[x.c], ys[x.r], xs[x.c + x.cs], ys[x.r + x.rs]];
  let best = null;
  a.forEach((u, i) => a.forEach((v, j) => {
    const [ul, ut, ur, ub] = rect(u);
    // v directly right of u with the same rows, or directly below with the same columns.
    let d;
    if (v.c === u.c + u.cs && v.r === u.r && v.rs === u.rs && p[1] > ut && p[1] < ub) d = Math.abs(p[0] - ur);
    else if (v.r === u.r + u.rs && v.c === u.c && v.cs === u.cs && p[0] > ul && p[0] < ur) d = Math.abs(p[1] - ub);
    else return;
    if (d <= tol && (!best || d < best[0])) best = [d, i, j];
  }));
  if (!best) return null;
  const [, i, j] = best;
  const v = a[j];
  const u = a[i];
  if (v.r === u.r) u.cs += v.cs; else u.rs += v.rs;
  if (!bodyEmpty(v.cell.text)) {
    const more = v.cell.text.paragraphs ?? [];
    if (bodyEmpty(u.cell.text)) u.cell.text = {...u.cell.text, paragraphs: more};
    else u.cell.text = {...u.cell.text, paragraphs: [...u.cell.text.paragraphs, ...more]};
  }
  a.splice(j, 1);
  return rebuild(t, a);
}

// ---------------------------------------------------------------------------------------------
// Split Cells (PowerPoint's Split Cells dialog: number of columns and rows; not in deckcraft, whose
// table.split only undoes a merge; not checked against upstream)

/** Replace grid column `c0` by `parts` columns of an equal share of its width; the cells of other rows over it widen to cover them. */
function splitGridColumn(t, c0, parts, rowFrom, rowTo) {
  const a = anchorsOf(t);
  const w = t.cols[c0];
  const out = [];
  t.cols.splice(c0, 1, ...Array.from({length: parts}, () => w / parts));
  for (const x of a) {
    if (x.c > c0) out.push({...x, c: x.c + parts - 1});
    else if (x.c <= c0 && c0 < x.c + x.cs) {
      if (x.c === c0 && x.cs === 1 && x.r >= rowFrom && x.r + x.rs - 1 <= rowTo) {
        for (let k = 0; k < parts; k++) out.push({...x, c: c0 + k, cell: k === 0 ? x.cell : {...structuredClone(x.cell), text: {body: {}, paragraphs: []}}});
      } else out.push({...x, cs: x.cs + parts - 1});
    } else out.push(x);
  }
  for (const row of t.rows) row.cells = Array.from({length: t.cols.length}, () => newCell(''));
  return rebuild(t, out);
}

/** Divide the cell at (r, c) into `cols` columns by `rows` rows (a merged cell is unmerged first). Returns the new table or null. */
export function splitCell(table, r, c, cols, rows) {
  cols = Math.max(Math.trunc(cols) || 1, 1);
  rows = Math.max(Math.trunc(rows) || 1, 1);
  let t = structuredClone(table);
  const cell = t.rows[r]?.cells?.[c];
  if (!cell) return null;
  const gs = Math.max(cell.gridSpan ?? 1, 1), rs = Math.max(cell.rowSpan ?? 1, 1);
  if (cell.hMerge || cell.vMerge) return null;
  const merged = gs > 1 || rs > 1;
  if (merged) {
    for (let rr = r; rr < Math.min(r + rs, t.rows.length); rr++) for (let cc = c; cc < Math.min(c + gs, t.cols.length); cc++) {
      Object.assign(t.rows[rr].cells[cc], {hMerge: false, vMerge: false, gridSpan: 1, rowSpan: 1});
    }
    if ((cols === gs && rows === rs) || (cols === 1 && rows === 1)) return t;
  } else if (cols === 1 && rows === 1) return null;
  if (t.cols.length + cols - 1 > MAX_GRID || t.rows.length + rows - 1 > MAX_GRID) return null;
  if (cols > 1) t = splitGridColumn(t, c, cols, r, r);
  if (rows > 1) {
    // Rows: the same on the transposed table (rows become columns).
    const flip = transpose(t);
    const r2 = splitGridColumn(flip, r, rows, c, c + cols - 1);
    t = transpose(r2);
  }
  return t;
}
