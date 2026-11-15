// What the Data tab draws on the worksheet besides the outline: the AutoFilter drop-down buttons in
// header cells (a chevron, or a funnel on a filtered column), the in-cell drop-down arrow of a list
// validation, and the red circles of Circle Invalid Data.
// Translated from gridcraft crates/ui-egui/src/grid/tables.rs (`filter_button_rect`,
// `paint_filter_button`), grid/quadrant.rs (`paint_filter_buttons`), grid/editor.rs (`validation_arrow`)
// and crates/model/src/sheet.rs (`has_filter_button`, `filter_button_space`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {Geo, Rect, Cell} from './geo';
import {parseRange} from '../../../../core/grid/lib/addr.mjs';
import {hasFilterButton, isColumnFiltered} from '../../../../core/grid/lib/data-filter.mjs';
import {validationAt} from '../../../../core/grid/lib/data-validation.mjs';

/** Horizontal header space a filter button takes in unzoomed units (12.5 pt, as Excel's AutoFit reserves). */
export function filterSpace(sheet: any, row: number, col: number, zoom: number): number {
  return hasFilterButton(sheet, row, col) ? (12.5 * 96 / 72) / Math.min(Math.max(zoom, 0.1), 1) : 0;
}

export function filterButtonRect(geo: Geo, sheet: any, c: Cell): Rect {
  const r = geo.cellRect(c);
  const pad = 2 * geo.z;
  const s = Math.min(Math.min(Math.max(r.h - 4, 10), 18), Math.max(filterSpace(sheet, c.row, c.col, geo.z) * geo.z - pad, 0));
  return {x: r.x + r.w - s - pad, y: r.y + r.h - s - pad, w: s, h: s};
}

/** The header cells of the sheet's filters: the AutoFilter's header row and the header rows of tables with filter buttons. */
export function filterCells(sheet: any): Cell[] {
  const out: Cell[] = [];
  const af = sheet?.autofilter?.range ? parseRange(sheet.autofilter.range) : null;
  if (af) for (let c = af.start.col; c <= af.end.col; c++) out.push({row: af.start.row, col: c});
  for (const t of sheet?.tables ?? []) {
    if (t.headerRow === false || t.autoFilter === false) continue;
    const r = parseRange(t.range);
    if (r && !(af && af.start.row === r.start.row && af.start.col === r.start.col)) for (let c = r.start.col; c <= r.end.col; c++) out.push({row: r.start.row, col: c});
  }
  return out;
}

/** The filter button under a point, as the header cell it belongs to. */
export function filterButtonAt(geo: Geo, sheet: any, x: number, y: number): Cell | null {
  const c = geo.cellAt(x, y);
  if (!hasFilterButton(sheet, c.row, c.col) || geo.hiddenUnderFrozen(c)) return null;
  const r = filterButtonRect(geo, sheet, c);
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? c : null;
}

/** The drop-down arrow beside a cell with an in-cell list validation. */
export function validationArrow(geo: Geo, sheet: any, c: Cell): Rect | null {
  const rule = validationAt(sheet, c);
  if (!rule || rule.type !== 'list' || rule.inCellDropdown === false || geo.hiddenUnderFrozen(c)) return null;
  const r = geo.cellRect(c);
  const s = Math.min(Math.max(r.h, 14), 22);
  return {x: r.x + r.w + 1, y: r.y + r.h - s, w: s, h: s};
}

function funnel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cx = x + w / 2, top = y + h * 0.28, bottom = y + h * 0.72;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.2, top); ctx.lineTo(x + w * 0.8, top); ctx.lineTo(cx + w * 0.08, y + h * 0.52); ctx.lineTo(cx + w * 0.08, bottom);
  ctx.lineTo(cx - w * 0.08, bottom - h * 0.06); ctx.lineTo(cx - w * 0.08, y + h * 0.52); ctx.closePath();
  ctx.fill();
}

/** Paints the filter buttons of every header cell in the range of cells shown in a pane. */
export function paintFilterButtons(ctx: CanvasRenderingContext2D, geo: Geo, sheet: any, rows: [number, number], cols: [number, number], open: Cell | null) {
  for (const c of filterCells(sheet)) {
    if (c.row < rows[0] || c.row > rows[1] || c.col < cols[0] || c.col > cols[1] || geo.colWidth(c.col) === 0 || geo.rowHeight(c.row) === 0) continue;
    const r = filterButtonRect(geo, sheet, c);
    if (r.w <= 0) continue;
    const on = isColumnFiltered(sheet, c.row, c.col);
    const pressed = !!open && open.row === c.row && open.col === c.col;
    ctx.fillStyle = pressed ? '#d6e4f7' : '#f3f3f3';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#8d8d8d'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
    ctx.fillStyle = on ? '#107c41' : '#3b3b3b';
    if (on) funnel(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    else {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = Math.max(r.w * 0.2, 2.2);
      ctx.beginPath(); ctx.moveTo(cx - a, cy - a * 0.45); ctx.lineTo(cx + a, cy - a * 0.45); ctx.lineTo(cx, cy + a * 0.75); ctx.closePath(); ctx.fill();
    }
  }
}

/** The arrow of a list validation next to the active cell. */
export function paintValidationArrow(ctx: CanvasRenderingContext2D, r: Rect, pressed: boolean) {
  ctx.fillStyle = pressed ? '#d6e4f7' : '#f3f3f3';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = '#8d8d8d'; ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = Math.max(r.w * 0.2, 3);
  ctx.fillStyle = '#3b3b3b';
  ctx.beginPath(); ctx.moveTo(cx - a, cy - a * 0.45); ctx.lineTo(cx + a, cy - a * 0.45); ctx.lineTo(cx, cy + a * 0.75); ctx.closePath(); ctx.fill();
}

/** The +/- button of a PivotTable item, drawn at the left edge of its cell. */
export function pivotButtonRect(geo: Geo, c: Cell): Rect {
  const r = geo.cellRect(c);
  const s = Math.min(10 * geo.z, Math.max(r.h - 6, 6));
  return {x: r.x + 3 * geo.z, y: r.y + (r.h - s) / 2, w: s, h: s};
}
export interface PivotButton { row: number; col: number; pivot: string; collapsed: boolean }
/** The PivotTable button under a point. */
export function pivotButtonAt(geo: Geo, buttons: PivotButton[], x: number, y: number): PivotButton | null {
  if (!buttons.length) return null;
  const c = geo.cellAt(x, y);
  const b = buttons.find(q => q.row === c.row && q.col === c.col);
  if (!b || geo.hiddenUnderFrozen(c)) return null;
  const r = pivotButtonRect(geo, c);
  return x >= r.x - 2 && x < r.x + r.w + 2 && y >= r.y - 2 && y < r.y + r.h + 2 ? b : null;
}
/** Paints the +/- buttons in the range of cells shown in a pane: a box with a minus, or a plus while the item is collapsed. */
export function paintPivotButtons(ctx: CanvasRenderingContext2D, geo: Geo, buttons: PivotButton[], rows: [number, number], cols: [number, number]) {
  for (const b of buttons) {
    if (b.row < rows[0] || b.row > rows[1] || b.col < cols[0] || b.col > cols[1] || geo.colWidth(b.col) === 0 || geo.rowHeight(b.row) === 0) continue;
    const r = pivotButtonRect(geo, b);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#7a7a7a'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
    ctx.strokeStyle = '#3b3b3b';
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = r.w * 0.28;
    ctx.beginPath();
    ctx.moveTo(cx - a, cy); ctx.lineTo(cx + a, cy);
    if (b.collapsed) { ctx.moveTo(cx, cy - a); ctx.lineTo(cx, cy + a); }
    ctx.stroke();
  }
}

/** A red ellipse around each cell of Circle Invalid Data. */
export function paintCircles(ctx: CanvasRenderingContext2D, geo: Geo, cells: Cell[]) {
  ctx.save();
  ctx.strokeStyle = '#e11d1d'; ctx.lineWidth = 2;
  for (const c of cells) {
    if (geo.rowHeight(c.row) === 0 || geo.colWidth(c.col) === 0) continue;
    const r = geo.cellRect(c);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 + 3, r.h / 2 + 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
