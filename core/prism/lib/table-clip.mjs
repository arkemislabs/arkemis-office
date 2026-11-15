// Copy, Cut and Paste of a range of table cells, as PowerPoint does it: the selected cells (merged
// cells whole) go on the clipboard as cells with their text and formatting, and as plain text with a
// tab between cells and a paragraph per row (deckcraft `selected_cells_text`); Cut clears them (deckcraft
// `clear_selected_cells`). Pasting cells into a table puts them cell by cell from the first selected cell
// (one cell fills the whole selected range) and adds the rows and columns it needs; pasted outside a
// table they make a new table. Pasting tab-separated text from another app over a selected range fills
// the cells the same way. Not checked against upstream (deckcraft copies the cells' text only).
// No DOM, no Node built-ins.

import {findShape, shape as newShape} from '../model/presentation.mjs';
import {currentSlideId, slideById, shapeJsonPath} from '../model/doc.mjs';
import {bodyText, bodyFromText} from '../model/text.mjs';
import {newCell, insertRow, insertCol, split, normalizeTable, tableWidth, tableHeight, isCovered} from '../model/table.mjs';
import {cellSelection, cellBlock, currentCell, selectCellsOf} from './table-sel.mjs';
import {addShape} from './shape-common.mjs';

/** The copied cells: the selected block grown over merges, as {rows: [[cell]], plain, style, flags, cols, heights}, or null. */
export function cellsOnClipboard(ctx) {
  const cs = cellSelection(ctx.doc, ctx.selection);
  if (!cs) return null;
  const sh = findShape(slideById(ctx.doc, cs.slide)?.shapes, cs.shape);
  if (sh?.kind?.type !== 'table') return null;
  const t = sh.kind;
  const [a, b] = cellBlock(t, cs.from, cs.to);
  const [r0, r1, c0, c1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const rows = [];
  for (let r = r0; r <= r1; r++) rows.push(t.rows[r].cells.slice(c0, c1 + 1).map(c => structuredClone(c)));
  const plain = rows.map(row => row.filter(c => !isCovered(c)).map(c => bodyText(c.text)).join('\t')).join('\n');
  const flags = {firstRow: t.firstRow, firstCol: t.firstCol, lastRow: t.lastRow, lastCol: t.lastCol, bandRow: t.bandRow, bandCol: t.bandCol};
  return {rows, plain, style: t.style, flags, cols: t.cols.slice(c0, c1 + 1), heights: t.rows.slice(r0, r1 + 1).map(r => r.height)};
}

/** Where a paste of cells lands: the table, its first target cell and the selected block's size (null without a table). */
function target(ctx) {
  const cs = cellSelection(ctx.doc, ctx.selection);
  const cur = currentCell(ctx.doc, ctx.selection);
  if (!cur) return null;
  const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
  const sh = findShape(sl?.shapes, cur.shape);
  if (sh?.kind?.type !== 'table') return null;
  if (cs && cs.shape === cur.shape) {
    const [a, b] = cellBlock(sh.kind, cs.from, cs.to);
    return {sl, sh, r0: Math.min(a[0], b[0]), c0: Math.min(a[1], b[1]), rows: Math.abs(a[0] - b[0]) + 1, cols: Math.abs(a[1] - b[1]) + 1, range: true};
  }
  return {sl, sh, r0: cur.cell[0], c0: cur.cell[1], rows: 1, cols: 1, range: false};
}

/** Whether a paste of cells goes into a table: a range of cells is selected, or the caret is in a cell. */
export const pastesIntoTable = ctx => !!target(ctx);

/** Put `grid` ([[cell | null]]) into table `t` from (r0, c0); `fill` repeats it over `rows` x `cols`. Returns the new table and the pasted block. */
function putCells(table, grid, r0, c0, fill) {
  let t = structuredClone(table);
  const gh = grid.length, gw = Math.max(...grid.map(r => r.length));
  const hR = fill && gh === 1 && gw === 1 ? fill.rows : gh, hC = fill && gh === 1 && gw === 1 ? fill.cols : gw;
  // The table grows by the rows and columns the block needs.
  while (t.rows.length < r0 + hR) t = insertRow(t, t.rows.length);
  while (t.cols.length < c0 + hC) t = insertCol(t, t.cols.length);
  // Merged cells the block touches come apart first, so the block lands on single cells.
  for (let r = 0; r < t.rows.length; r++) {
    for (let c = 0; c < t.cols.length; c++) {
      const cell = t.rows[r].cells[c];
      if (isCovered(cell) || (cell.gridSpan <= 1 && cell.rowSpan <= 1)) continue;
      const r1 = r + cell.rowSpan - 1, c1 = c + cell.gridSpan - 1;
      if (r <= r0 + hR - 1 && r1 >= r0 && c <= c0 + hC - 1 && c1 >= c0) t = split(t, r, c) ?? t;
    }
  }
  for (let i = 0; i < hR; i++) {
    for (let j = 0; j < hC; j++) {
      const src = grid[fill && gh === 1 && gw === 1 ? 0 : i]?.[fill && gh === 1 && gw === 1 ? 0 : j];
      if (src) t.rows[r0 + i].cells[c0 + j] = structuredClone(src);
    }
  }
  return {table: normalizeTable(t), rows: hR, cols: hC};
}

/** Paste copied cells (`data` from `cellsOnClipboard`) into the table at the selection, or as a new table. */
export function pasteCells(ctx, cmd, data) {
  const tg = target(ctx);
  if (!tg) return newTableFrom(ctx, cmd, data);
  const {table, rows, cols} = putCells(tg.sh.kind, data.rows, tg.r0, tg.c0, tg.range ? {rows: tg.rows, cols: tg.cols} : null);
  const path = shapeJsonPath(ctx.doc, tg.sl.id, tg.sh.id);
  const sh = structuredClone(tg.sh);
  sh.kind = {...table, type: 'table'};
  if (sh.xfrm) { sh.xfrm = {...sh.xfrm, w: tableWidth(table), h: tableHeight(table)}; }
  ctx.change.set(path, sh);
  ctx.setSelection(selectCellsOf(ctx.doc, tg.sl.id, tg.sh.id, [tg.r0, tg.c0], [tg.r0 + rows - 1, tg.c0 + cols - 1]));
  return {cells: rows * cols};
}

/** Pasted outside a table: the cells make a new table of their own, centred on the slide. */
function newTableFrom(ctx, cmd, data) {
  const sw = ctx.doc.slideSize.width, sh = ctx.doc.slideSize.height;
  const cols = data.cols.slice(0, data.rows[0].length), widths = cols.length ? cols : data.rows[0].map(() => 100);
  const rows = data.rows.map((cells, i) => ({height: data.heights[i] ?? 40, cells: cells.map(c => structuredClone(c))}));
  const t = normalizeTable({type: 'table', cols: widths, rows, style: data.style, ...data.flags});
  const w = tableWidth(t), h = tableHeight(t);
  const id = addShape(ctx, cmd, newShape({xfrm: {x: Math.max((sw - w) / 2, 0), y: Math.max((sh - h) / 2, 0), w, h}, kind: {...t, type: 'table'}}), true);
  return {id};
}

/** Tab-separated text from another app over a selected range of cells (or from the caret's cell): one cell per field. Null when it is a single field. */
export function textGrid(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
  return lines.length === 1 && lines[0].length === 1 ? null : lines.map(r => r.map(v => ({...newCell(''), text: bodyFromText(v)})));
}

/** Paste external text as cells (see `textGrid`). */
export function pasteTextCells(ctx, cmd, text) {
  const grid = textGrid(text);
  const tg = target(ctx);
  if (!grid || !tg || !tg.range) return null;
  const merged = grid.map(row => row.map(c => ({...structuredClone(tg.sh.kind.rows[tg.r0]?.cells[tg.c0] ?? c), text: c.text, gridSpan: 1, rowSpan: 1, hMerge: false, vMerge: false})));
  return pasteCells(ctx, cmd, {rows: merged});
}

