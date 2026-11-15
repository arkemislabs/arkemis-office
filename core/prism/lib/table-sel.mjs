// Cells of a table on the slide: a selected range of cells (kept in the kernel selection as one
// range whose two ends are cell addresses with no text offset), the range grown over merged cells,
// the table as drawn (its cell rectangles and the borders that can be dragged) and which cell or
// border is at a point.
// Translated from deckcraft crates/engine/src/cmd/table.rs (`TableFrame`, `cell_block`,
// `selected_range`, `in_range`, `border_at`, `cell_at`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {parseSel, shapeAddress, shapeChain, slideById, textSelection} from '../model/doc.mjs';
import {cellRects, edges} from '../model/table-style.mjs';

/** Narrowest a column gets when its border is dragged (points). */
export const MIN_COLUMN_WIDTH = 12;

const isCovered = c => !!(c?.hMerge || c?.vMerge);

/**
 * The selected range of cells: {slide, chain, shape, from: [r, c], to: [r, c]} when the primary
 * kernel range is two cell addresses, else null.
 */
export function cellSelection(content, selection) {
  const r = selection?.ranges?.[selection.primary ?? 0];
  if (!r) return null;
  const a = parseSel(r.anchor), f = parseSel(r.focus ?? r.anchor);
  if (!a || !f || a.text !== null || f.text !== null || !a.cell || !f.cell || !a.chain.length) return null;
  return {slide: a.slide, chain: a.chain, shape: a.chain[a.chain.length - 1], from: a.cell, to: f.cell};
}

/** The kernel selection of the cells from `from` to `to` of table `id` on slide `slideId`. */
export function selectCellsOf(content, slideId, id, from, to) {
  const sl = slideById(content, slideId);
  const base = shapeAddress(slideId, (sl && shapeChain(sl, id)) ?? [id]);
  return {ranges: [{anchor: `${base}/r:${from[0]}/c:${from[1]}`, focus: `${base}/r:${to[0]}/c:${to[1]}`}], primary: 0};
}

/**
 * The cell range from `a` to `b` in `t`, grown until every merged cell it touches lies inside it,
 * as [the corner on `a`'s side, the corner on `b`'s side]. Cells past the table's edge are clamped.
 */
export function cellBlock(t, a, b) {
  const nr = Math.max(t.rows.length, 1), nc = Math.max(t.cols.length, 1);
  a = [Math.min(a[0], nr - 1), Math.min(a[1], nc - 1)];
  b = [Math.min(b[0], nr - 1), Math.min(b[1], nc - 1)];
  let [r0, r1, c0, c1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  // Each pass takes in the merged cells that overlap the block; stop when one adds nothing.
  for (let pass = 0; pass < nr + nc; pass++) {
    let grown = false;
    t.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
      if (isCovered(cell)) return;
      const er = Math.min(r + Math.max(cell.rowSpan ?? 1, 1) - 1, nr - 1), ec = Math.min(c + Math.max(cell.gridSpan ?? 1, 1) - 1, nc - 1);
      const overlaps = r <= r1 && er >= r0 && c <= c1 && ec >= c0;
      if (overlaps && (r < r0 || er > r1 || c < c0 || ec > c1)) {
        [r0, r1, c0, c1] = [Math.min(r0, r), Math.max(r1, er), Math.min(c0, c), Math.max(c1, ec)];
        grown = true;
      }
    }));
    if (!grown) break;
  }
  const pick = (lo, hi, first) => (first ? lo : hi);
  return [[pick(r0, r1, a[0] <= b[0]), pick(c0, c1, a[1] <= b[1])], [pick(r0, r1, a[0] > b[0]), pick(c0, c1, a[1] > b[1])]];
}

/** The selected range of cells of table `id` (`t`), grown over merged cells, as [top-left, bottom-right]; null when none of that table is selected. */
export function selectedRange(cells, id, t) {
  if (!cells || cells.shape !== id) return null;
  const [x, y] = cellBlock(t, cells.from, cells.to);
  return [[Math.min(x[0], y[0]), Math.min(x[1], y[1])], [Math.max(x[0], y[0]), Math.max(x[1], y[1])]];
}

/** Whether cell (r, c) lies in `range` (from `selectedRange`); without a range every cell does. */
export const inRange = (range, r, c) => !range || (r >= range[0][0] && r <= range[1][0] && c >= range[0][1] && c <= range[1][1]);

/** The cell the caret is in, or the first cell of the selected range: where row and column commands act. */
export function currentCell(content, selection) {
  const t = textSelection(content, selection);
  if (t?.cell && !t.notes) return {shape: t.shape, cell: t.cell};
  const c = cellSelection(content, selection);
  return c ? {shape: c.shape, cell: c.from} : null;
}

/**
 * A table as drawn on the slide: where it is (`m`, table space to slide space), its drawn row
 * heights and its visible cells. `affine` is [a, b, c, d, e, f] (kurbo order, as the pointer's).
 */
export function tableFrame(t, heights, apply, inverse) {
  const cells = cellRects(t, heights);
  const width = t.cols.reduce((a, w) => a + Math.max(w, 0), 0), height = heights.reduce((a, h) => a + Math.max(h, 0), 0);
  const f = {cols: t.cols, heights, cells, width, height};
  /** Table-local point for slide point `p`. */
  f.local = p => inverse(p);
  f.slide = q => apply(q);
  f.cellRect = (r, c) => cells.find(x => x.r === r && x.c === c) ?? null;
  /** The visible cell at table-local `p` (points outside the table go to the nearest cell). */
  f.cellAt = p => {
    const q = {x: Math.min(Math.max(p.x, 0), Math.max(width, 0)), y: Math.min(Math.max(p.y, 0), Math.max(height, 0))};
    const inside = x => q.x >= x.x0 && q.x <= x.x1 && q.y >= x.y0 && q.y <= x.y1;
    // Edges are shared: prefer the cell the point is strictly inside.
    const hit = cells.find(x => q.x >= x.x0 && q.x < x.x1 && q.y >= x.y0 && q.y < x.y1) ?? [...cells].reverse().find(inside);
    return hit ? [hit.r, hit.c] : null;
  };
  /** Whether table-local `p` is in a cell, not in the grab band around the table. */
  f.inCell = p => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height && f.cellAt(p) !== null;
  /**
   * The draggable border within `tol` of table-local `p`: the inner borders and the right and bottom
   * edges (the left and top edges move the table). Borders hidden inside merged cells don't count.
   * Returns {column: i} or {row: i}.
   */
  f.borderAt = (p, tol) => {
    if (!(p.x >= -tol && p.y >= -tol && p.x <= width + tol && p.y <= height + tol)) return null;
    const q = {x: Math.min(Math.max(p.x, 0), width), y: Math.min(Math.max(p.y, 0), height)};
    let best = null;
    let x = 0;
    t.cols.forEach((cw, i) => {
      x += Math.max(cw, 0);
      const d = Math.abs(p.x - x);
      const shown = cells.some(r => Math.abs(r.x1 - x) < 1e-6 && q.y >= r.y0 && q.y <= r.y1);
      if (d <= tol && shown && (!best || d < best[0])) best = [d, {column: i}];
    });
    let y = 0;
    heights.forEach((rh, i) => {
      y += Math.max(rh, 0);
      const d = Math.abs(p.y - y);
      const shown = cells.some(r => Math.abs(r.y1 - y) < 1e-6 && q.x >= r.x0 && q.x <= r.x1);
      if (d <= tol && shown && (!best || d < best[0])) best = [d, {row: i}];
    });
    return best ? best[1] : null;
  };
  return f;
}

export {edges};
