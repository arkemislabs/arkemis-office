// Page Layout view geometry: a sheet shown as printed pages side by side.
//
// The view uses the print pagination (page-layout.mjs `splitBands`) over the sheet from A1, so its page edges are
// the printed ones whenever the print area starts at A1. Pages keep going right and down past the data ("Click to
// add data" pages), as far as the view needs.
//
// Coordinates are layout units: sheet pixels (96 dpi) at the print scale, so a cell keeps its sheet size and a page
// is paper / scale big. The surface multiplies by its zoom. Pages sit in a grid with a gap around each: page
// (row band, column band) starts at (gap + j * (pageW + gap), gap + i * (pageH + gap)), and its cells start at its
// top-left margin.
//
// Translated from gridcraft crates/engine/src/paper.rs (PageGrid, HfZone, need_for) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {lineIndex, rowAt, colAt} from '../model/sheet.mjs';
import {layoutRange, printRanges, splitBands, PX_TO_PT} from './page-layout.mjs';
import {HF_FIXED_SIDE_MARGIN} from './page-setup.mjs';

const MAX_ROWS = 1_048_576, MAX_COLS = 16_384;
/** Gap between pages on screen, in pixels at 100% zoom (`PAGE_GAP`). */
export const PAGE_GAP = 14;
/** Ruler thickness in screen points (paper_view.rs `RULER`). */
export const RULER = 18;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** One sheet paginated for the Page Layout view. */
export class PageGrid {
  /**
   * Paginates `sheet` far enough to cover row `needRow` and column `needCol` (and at least the printed area).
   * `sheet` is a schema-2 sheet; null when it is not one.
   */
  static build(sheet, needRow = 0, needCol = 0) {
    if (!sheet) return null;
    const area0 = printRanges(sheet)[0] ?? {start: {row: 0, col: 0}, end: {row: 0, col: 0}};
    const printed = layoutRange(sheet, area0);
    const endRow = Math.min(Math.max(needRow, printed.area.end.row), MAX_ROWS - 1);
    const endCol = Math.min(Math.max(needCol, printed.area.end.col), MAX_COLS - 1);
    const lay = {...printed, area: {start: {row: 0, col: 0}, end: {row: endRow, col: endCol}}};
    const {rowBands, colBands} = splitBands(sheet, lay, MAX_ROWS);
    const s = clamp(lay.scale, 0.1, 4);
    const toLayout = pt => pt / PX_TO_PT / s;
    const hf = lay.setup.headerFooter ?? {};
    const sidesPt = hf.alignWithMargins === false ? (() => { const side = Math.min(HF_FIXED_SIDE_MARGIN, lay.pageW / 4); return [side, side]; })() : [lay.margins[0], lay.margins[1]];
    const bandRange = (bands, lo, hi) => {
      let first = bands.findIndex(b => b[1] >= lo);
      if (first < 0) first = 0;
      let last = -1;
      for (let k = bands.length - 1; k >= 0; k--) if (bands[k][0] <= hi) { last = k; break; }
      if (last < 0) last = first;
      return [first, Math.max(first, last)];
    };
    const g = new PageGrid();
    g.sheet = sheet;
    g.pageW = toLayout(lay.pageW);
    g.pageH = toLayout(lay.pageH);
    g.margins = lay.margins.map(toLayout);
    g.gap = PAGE_GAP / s;
    g.scale = lay.scale;
    g.hfSides = sidesPt.map(toLayout);
    g.hfTextK = (hf.scaleWithDoc === false ? 1 : lay.scale) / s;
    g.paperPt = [lay.pageW, lay.pageH];
    g.rowBands = rowBands;
    g.colBands = colBands;
    g.rowsComplete = rowBands.length > 0 && rowBands[rowBands.length - 1][1] >= MAX_ROWS - 1;
    g.colsComplete = colBands.length > 0 && colBands[colBands.length - 1][1] >= MAX_COLS - 1;
    g.dataRows = bandRange(rowBands, printed.area.start.row, printed.area.end.row);
    g.dataCols = bandRange(colBands, printed.area.start.col, printed.area.end.col);
    g.ri = lineIndex(sheet, 'rows');
    g.ci = lineIndex(sheet, 'cols');
    return g;
  }

  /** The grid covers row `r` and column `c` (else it needs a rebuild with more pages). */
  covers(r, c) {
    const rb = this.rowBands, cb = this.colBands;
    return (this.rowsComplete || (rb.length > 0 && rb[rb.length - 1][1] >= r)) && (this.colsComplete || (cb.length > 0 && cb[cb.length - 1][1] >= c));
  }

  static bandOf(bands, line) {
    // The first band whose last line reaches `line` (partition_point), the last band when none does.
    let lo = 0, hi = bands.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bands[mid][1] < line) lo = mid + 1; else hi = mid; }
    return Math.min(lo, Math.max(0, bands.length - 1));
  }

  /** Left edge of page column `j` / top edge of page row `i`. */
  pageX(j) { return this.gap + j * (this.pageW + this.gap); }
  pageY(i) { return this.gap + i * (this.pageH + this.gap); }
  /** The page rectangle [x, y, w, h] of page (i, j). */
  pageRect(i, j) { return [this.pageX(j), this.pageY(i), this.pageW, this.pageH]; }
  /** Where the cells of page (i, j) go: inside the margins. */
  contentRect(i, j) {
    const [l, r, t, b] = this.margins;
    return [this.pageX(j) + l, this.pageY(i) + t, Math.max(1, this.pageW - l - r), Math.max(1, this.pageH - t - b)];
  }

  /** Left edge of column `col`. */
  colX(col) {
    const j = PageGrid.bandOf(this.colBands, col);
    const start = this.colBands[j]?.[0] ?? 0;
    return this.pageX(j) + this.margins[0] + (this.ci.start(col) - this.ci.start(start));
  }
  /** Top edge of row `row`. */
  rowY(row) {
    const i = PageGrid.bandOf(this.rowBands, row);
    const start = this.rowBands[i]?.[0] ?? 0;
    return this.pageY(i) + this.margins[2] + (this.ri.start(row) - this.ri.start(start));
  }

  /** Page column under `x` (the nearest one in gaps). */
  pageColAt(x) { return Math.min(Math.max(0, Math.floor((x - this.gap / 2) / (this.pageW + this.gap))), Math.max(0, this.colBands.length - 1)); }
  pageRowAt(y) { return Math.min(Math.max(0, Math.floor((y - this.gap / 2) / (this.pageH + this.gap))), Math.max(0, this.rowBands.length - 1)); }

  /** Column under `x`, clamped to the page's columns (margins and gaps hit the nearest one). */
  colAt(x) {
    const j = this.pageColAt(x);
    const band = this.colBands[j];
    if (!band) return 0;
    const [a, b] = band;
    const local = x - this.pageX(j) - this.margins[0];
    return local <= 0 ? a : clamp(this.ci.at(this.ci.start(a) + local), a, b);
  }
  rowAt(y) {
    const i = this.pageRowAt(y);
    const band = this.rowBands[i];
    if (!band) return 0;
    const [a, b] = band;
    const local = y - this.pageY(i) - this.margins[2];
    return local <= 0 ? a : clamp(this.ri.at(this.ri.start(a) + local), a, b);
  }

  /** The page [i, j] whose paper contains the point, if any. */
  pageAt(x, y) {
    const i = this.pageRowAt(y), j = this.pageColAt(x);
    const [px, py, w, h] = this.pageRect(i, j);
    return x >= px && x < px + w && y >= py && y < py + h ? [i, j] : null;
  }

  /** The point lies on cells (inside a page's margins, on a cell of that page). */
  onCells(x, y) {
    const p = this.pageAt(x, y);
    if (!p) return false;
    const [i, j] = p;
    const [cx, cy, w, h] = this.contentRect(i, j);
    const cb = this.colBands[j], rb = this.rowBands[i];
    if (!cb || !rb) return false;
    // Cells end where the band ends (the rest of the printable area stays blank).
    const right = Math.min(this.colX(cb[1]) + this.ci.start(cb[1] + 1) - this.ci.start(cb[1]), cx + w);
    const bottom = Math.min(this.rowY(rb[1]) + this.ri.start(rb[1] + 1) - this.ri.start(rb[1]), cy + h);
    return x >= cx && x < right && y >= cy && y < bottom;
  }

  /** The header or footer section under the point: the top or bottom margin of a page, split into thirds between the side margins: {page: [i, j], footer, section} or null. */
  hfZoneAt(x, y) {
    const p = this.pageAt(x, y);
    if (!p) return null;
    const [i, j] = p;
    const [px, py] = this.pageRect(i, j);
    const [, , t, b] = this.margins;
    const [l, r] = this.hfSides;
    let footer;
    if (y < py + t) footer = false;
    else if (y >= py + this.pageH - b) footer = true;
    else return null;
    const inner = Math.max(3, this.pageW - l - r);
    const section = Math.min(2, Math.max(0, Math.floor((x - px - l) / (inner / 3))));
    return {page: [i, j], footer, section};
  }

  /** Page (i, j) holds printed data (others are "Click to add data" pages). */
  isDataPage(i, j) { return i >= this.dataRows[0] && i <= this.dataRows[1] && j >= this.dataCols[0] && j <= this.dataCols[1]; }
  /** Printed page number of page (i, j) (down, then over) and the printed page count: [n, total] or null. */
  pageNumber(i, j) {
    if (!this.isDataPage(i, j)) return null;
    const rows = this.dataRows[1] - this.dataRows[0] + 1, cols = this.dataCols[1] - this.dataCols[0] + 1;
    return [(j - this.dataCols[0]) * rows + (i - this.dataRows[0]) + 1, rows * cols];
  }

  /** Page rows and columns overlapping the layout rectangle: [[firstRow, lastRow], [firstCol, lastCol]]. */
  pagesIn(x0, y0, x1, y1) { return [[this.pageRowAt(y0), this.pageRowAt(y1)], [this.pageColAt(x0), this.pageColAt(x1)]]; }
  /** Width and height of everything laid out so far. */
  extent() { return [this.pageX(this.colBands.length), this.pageY(this.rowBands.length)]; }
  rowBand(i) { return this.rowBands[i] ?? null; }
  colBand(j) { return this.colBands[j] ?? null; }
}

/**
 * The bottom-right cell a page grid for this sheet must reach so that the layout rectangle up to (x, y) is covered.
 * Layout coordinates never run ahead of sheet coordinates (pages only add margins and gaps), so the sheet position
 * is a safe bound (`need_for`): [row, col].
 */
export function needFor(sheet, x, y) {
  return [Math.min(MAX_ROWS - 1, rowAt(sheet, Math.max(0, y)) + 1), Math.min(MAX_COLS - 1, colAt(sheet, Math.max(0, x)) + 1)];
}

// ---------------------------------------------------------------------------------------------
// Margins dragged on the rulers (paper_view.rs `margin_from_drag`, `Edge`)

/** The page edges a ruler can drag, with their index in the margins and their name in `pageLayout.pageSetup`. */
export const EDGES = Object.freeze({
  left: {index: 0, key: 'left', label: 'Left Margin', horizontal: true},
  right: {index: 1, key: 'right', label: 'Right Margin', horizontal: true},
  top: {index: 2, key: 'top', label: 'Top Margin', horizontal: false},
  bottom: {index: 3, key: 'bottom', label: 'Bottom Margin', horizontal: false},
  header: {index: 4, key: 'header', label: 'Header Margin', horizontal: false},
  footer: {index: 5, key: 'footer', label: 'Footer Margin', horizontal: false},
});
/** Content that must stay between the margins, in points. */
export const MIN_CONTENT_PT = 36;

/**
 * The margin (inches, rounded to 0.01) for `edge` dragged to `relPt` points from the page's left or top edge. The
 * margin stays on the page and leaves MIN_CONTENT_PT between the two margins of its axis; the header and footer
 * stay within their page margin, which cannot be dragged inside them. null for NaN or infinite input, or a page
 * without a size. `pagePt` is [width, height] in points, `marginsIn` the six margins in inches.
 */
export function marginFromDrag(edge, relPt, pagePt, marginsIn) {
  const e = EDGES[edge];
  const page = e.horizontal ? pagePt[0] : pagePt[1];
  if (!Number.isFinite(relPt) || !Number.isFinite(page) || page <= 0) return null;
  const otherRaw = marginsIn[e.index ^ 1];
  if (!Number.isFinite(otherRaw)) return null;
  const other = Math.max(0, otherRaw) * 72;
  const raw = edge === 'left' || edge === 'top' || edge === 'header' ? relPt : page - relPt;
  let max = Math.max(0, page - other - MIN_CONTENT_PT);
  let min = 0;
  const ptOf = i => Math.max(0, Number.isFinite(marginsIn[i]) ? marginsIn[i] : 0) * 72;
  if (edge === 'header') max = Math.min(max, ptOf(2));
  else if (edge === 'footer') max = Math.min(max, ptOf(3));
  else if (edge === 'top') min = ptOf(4);
  else if (edge === 'bottom') min = ptOf(5);
  const pt = clamp(raw, Math.min(min, max), max);
  return Math.round(pt / 72 * 100) / 100;
}
