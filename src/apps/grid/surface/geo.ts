// Grid geometry for one frame: zoom, headers, frozen panes, scroll, cell <-> point.
// Translated from gridcraft crates/ui-egui/src/grid/geo.rs (Geo) and crates/ui-egui/src/grid.rs
// (COL_HEADER_H, heading_font_size, wheel_zoom_step) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Units: sheet units are 96-dpi pixels (as in XLSX). Upstream draws one unit at 0.8 egui points
// (DISPLAY_SCALE) to match desktop density in egui; one CSS pixel already is a 96-dpi pixel, so
// here a unit is drawn at one CSS pixel at 100% (a default row is 20 px tall, as in Excel).
// Right-to-left sheets and Page Layout view are not part of the foundation surface (openIssues).

import {lineIndex, freeze as freezeOf} from '../../../../core/grid/model/sheet.mjs';
import {sheetView} from '../../../../core/grid/model/workbook.mjs';
import {MAX_ROWS, MAX_COLS} from '../../../../core/grid/lib/addr.mjs';
import {maxLevel} from '../../../../core/grid/lib/data-outline.mjs';

export const COL_HEADER_H = 21;
export const DISPLAY_SCALE = 1;

export interface Rect { x: number; y: number; w: number; h: number }
export interface Cell { row: number; col: number }
export interface Range { start: Cell; end: Cell }
interface LineIdx { start(line: number): number; at(pos: number): number; size(line: number): number; readonly total: number }

/** One outline level's lane at this zoom (outline.rs `lane`). */
export const outlineLane = (zoom: number) => Math.round(15 * Math.max(zoom, 0.75));
/** Thickness of an outline band `levels` deep: a lane per level plus one for the level button that shows everything (outline.rs `band`). */
export const outlineBand = (levels: number, zoom: number) => (levels === 0 ? 0 : (levels + 1) * outlineLane(zoom) + 3);

export const rectContains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Heading labels grow with the zoom as the cells do, and never get smaller than 8.5 points. */
export const headingFontSize = (zoom: number) => Math.max(11.5 * (zoom / DISPLAY_SCALE), 8.5);

/** The zoom ladder a Ctrl+wheel notch steps between (grid.rs WHEEL_ZOOM_LADDER). */
export const WHEEL_ZOOM_LADDER = [10, 12, 15, 18, 21, 25, 30, 35, 42, 50, 60, 70, 85, 100, 120, 140, 170, 200, 240, 280, 340, 400];
/** The zoom one Ctrl+wheel notch goes to (grid.rs `wheel_zoom_step`). */
export function wheelZoomStep(zoom0: number, zoomIn: boolean): number {
  const zoom = Math.min(400, Math.max(10, zoom0));
  const far = (l: number) => (zoomIn ? l * 100 >= zoom * 105 : l * 105 <= zoom * 100);
  const ahead = WHEEL_ZOOM_LADDER.filter(l => (zoomIn ? l > zoom : l < zoom));
  if (!zoomIn) ahead.reverse();
  const limit = ahead.length ? ahead[ahead.length - 1] : zoom;
  return ahead.find(l => l === 100 || far(l)) ?? limit;
}

export class Geo {
  readonly rect: Rect;
  readonly cells: Rect;
  readonly z: number;
  readonly headerW: number;
  readonly headerH: number;
  /** The outline bands (grouped rows / columns): left of the row headers and above the column headers; 0 without an outline. */
  readonly bandW: number;
  readonly bandH: number;
  readonly fr: number;
  readonly fc: number;
  readonly frozenW: number;
  readonly frozenH: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly ri: LineIdx;
  readonly ci: LineIdx;
  readonly sheet: any;

  /** `scroll` is in sheet units past the frozen panes. */
  constructor(sheet: any, rect: Rect, scrollX: number, scrollY: number, zoomPercent?: number) {
    const view = sheetView(sheet);
    // The zoom the window shows (view.zoom), else the one the sheet is saved with.
    const zoom = Math.min(4, Math.max(0.1, (zoomPercent ?? view.zoom) / 100));
    this.sheet = sheet;
    this.rect = rect;
    this.z = zoom * DISPLAY_SCALE;
    this.headerH = view.showHeadings ? Math.round(COL_HEADER_H * Math.max(zoom, 0.75)) : 0;
    this.ri = lineIndex(sheet, 'rows') as LineIdx;
    this.ci = lineIndex(sheet, 'cols') as LineIdx;
    const lastRow = this.ri.at(scrollY + rect.h / this.z + 200) + 1;
    const digits = Math.floor(Math.log10(Math.max(lastRow, 1))) + 1;
    this.headerW = view.showHeadings ? Math.round((Math.max(digits, 2) * 7 + 14) * Math.max(zoom, 0.75)) : 0;
    const f = freezeOf(sheet);
    this.fr = f.rows; this.fc = f.cols;
    this.frozenW = this.ci.start(this.fc) * this.z;
    this.frozenH = this.ri.start(this.fr) * this.z;
    this.scrollX = Math.max(0, scrollX); this.scrollY = Math.max(0, scrollY);
    // Show Outline Symbols off (or no outline): no bands (the outline's hidden lines stay hidden).
    const symbols = sheet?.showOutlineSymbols !== false;
    this.bandW = symbols ? outlineBand(maxLevel(sheet?.rows), zoom) : 0;
    this.bandH = symbols ? outlineBand(maxLevel(sheet?.cols), zoom) : 0;
    this.cells = {x: rect.x + this.bandW + this.headerW, y: rect.y + this.bandH + this.headerH, w: Math.max(0, rect.w - this.bandW - this.headerW), h: Math.max(0, rect.h - this.bandH - this.headerH)};
  }
  colWidth(col: number) { return this.ci.size(col); }
  rowHeight(row: number) { return this.ri.size(row); }
  /** Scroll offset at which `row` reaches the top of the scrolled area. */
  scrollTopOf(row: number) { return this.ri.start(row) - this.ri.start(this.fr); }
  scrollLeftOf(col: number) { return this.ci.start(col) - this.ci.start(this.fc); }
  x(col: number) {
    if (col < this.fc) return this.cells.x + this.ci.start(col) * this.z;
    return this.cells.x + this.frozenW + (this.ci.start(col) - this.ci.start(this.fc) - this.scrollX) * this.z;
  }
  y(row: number) {
    if (row < this.fr) return this.cells.y + this.ri.start(row) * this.z;
    return this.cells.y + this.frozenH + (this.ri.start(row) - this.ri.start(this.fr) - this.scrollY) * this.z;
  }
  cellRect(c: Cell): Rect {
    const x = this.x(c.col), y = this.y(c.row);
    return {x, y, w: this.colWidth(c.col) * this.z, h: this.rowHeight(c.row) * this.z};
  }
  rangeRect(r: Range): Rect {
    const a = this.cellRect(r.start), b = this.cellRect(r.end);
    return {x: a.x, y: a.y, w: b.x + b.w - a.x, h: b.y + b.h - a.y};
  }
  colAt(px: number) {
    const dx = (px - this.cells.x) / this.z;
    if (dx < this.frozenW / this.z) return this.ci.at(Math.max(dx, 0));
    return this.ci.at(this.ci.start(this.fc) + this.scrollX + (dx - this.frozenW / this.z));
  }
  rowAt(py: number) {
    const dy = (py - this.cells.y) / this.z;
    if (dy < this.frozenH / this.z) return this.ri.at(Math.max(dy, 0));
    return this.ri.at(this.ri.start(this.fr) + this.scrollY + (dy - this.frozenH / this.z));
  }
  cellAt(px: number, py: number): Cell { return {row: this.rowAt(py), col: this.colAt(px)}; }
  /** Visible scrolled rows (from the first visible row after the frozen ones). */
  scrollRows(): [number, number] {
    const top = this.ri.start(this.fr) + this.scrollY;
    return [Math.max(this.ri.at(top), this.fr), Math.min(this.ri.at(top + (this.cells.h - this.frozenH) / this.z), MAX_ROWS - 1)];
  }
  scrollCols(): [number, number] {
    const left = this.ci.start(this.fc) + this.scrollX;
    return [Math.max(this.ci.at(left), this.fc), Math.min(this.ci.at(left + (this.cells.w - this.frozenW) / this.z), MAX_COLS - 1)];
  }
  /** The panes: [rows, cols, clip] for frozen corner, frozen rows, frozen cols, scrolling part. */
  panes(): {rows: [number, number]; cols: [number, number]; clip: Rect}[] {
    const out: {rows: [number, number]; cols: [number, number]; clip: Rect}[] = [];
    const sr = this.scrollRows(), sc = this.scrollCols();
    const splitX = this.cells.x + this.frozenW, splitY = this.cells.y + this.frozenH;
    const right = this.cells.x + this.cells.w, bottom = this.cells.y + this.cells.h;
    const rowsParts: {rows: [number, number]; y0: number; y1: number}[] = [];
    if (this.fr > 0) rowsParts.push({rows: [0, this.fr - 1], y0: this.cells.y, y1: splitY});
    rowsParts.push({rows: sr, y0: splitY, y1: bottom});
    const colsParts: {cols: [number, number]; x0: number; x1: number}[] = [];
    if (this.fc > 0) colsParts.push({cols: [0, this.fc - 1], x0: this.cells.x, x1: splitX});
    colsParts.push({cols: sc, x0: splitX, x1: right});
    for (const r of rowsParts) for (const c of colsParts) {
      if (r.y1 <= r.y0 || c.x1 <= c.x0) continue;
      out.push({rows: r.rows, cols: c.cols, clip: {x: c.x0, y: r.y0, w: c.x1 - c.x0, h: r.y1 - r.y0}});
    }
    return out;
  }
  /** Screen areas of the panes that hold part of `r` (a range is clipped to the panes it lives in). */
  rangePanes(r: Range): Rect[] {
    const splitX = this.cells.x + this.frozenW, splitY = this.cells.y + this.frozenH;
    const xs: [number, number][] = [], ys: [number, number][] = [];
    if (r.start.col < this.fc) xs.push([this.cells.x, splitX]);
    if (r.end.col >= this.fc) xs.push([splitX, this.cells.x + this.cells.w]);
    if (r.start.row < this.fr) ys.push([this.cells.y, splitY]);
    if (r.end.row >= this.fr) ys.push([splitY, this.cells.y + this.cells.h]);
    const out: Rect[] = [];
    for (const [y0, y1] of ys) for (const [x0, x1] of xs) out.push({x: x0, y: y0, w: x1 - x0, h: y1 - y0});
    return out;
  }
  /** Cell `c` is in the scrolling pane but scrolled entirely under the frozen rows or columns. */
  hiddenUnderFrozen(c: Cell) {
    const r = this.cellRect(c);
    return (this.fc > 0 && c.col >= this.fc && r.x + r.w <= this.cells.x + this.frozenW)
      || (this.fr > 0 && c.row >= this.fr && r.y + r.h <= this.cells.y + this.frozenH);
  }
  /** Column whose right edge is within 4 px of `px` in the column header (interact.rs `col_edge`). */
  colEdge(px: number): [number, number] | null {
    const c = this.colAt(px);
    for (const cc of [c, Math.max(c - 1, 0)]) {
      const edge = this.x(cc) + this.colWidth(cc) * this.z;
      if (Math.abs(px - edge) <= 4) return [cc, edge];
    }
    return null;
  }
  rowEdge(py: number): [number, number] | null {
    const r = this.rowAt(py);
    for (const rr of [r, Math.max(r - 1, 0)]) {
      const edge = this.y(rr) + this.rowHeight(rr) * this.z;
      if (Math.abs(py - edge) <= 3) return [rr, edge];
    }
    return null;
  }
}
