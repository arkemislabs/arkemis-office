// Home › Cells › Insert and Delete: Insert/Delete Sheet Rows and Columns, Insert Cells… and Delete
// Cells… (shift right/down/left/up or entire rows/columns), Insert Copied Cells / Insert Cut Cells,
// and Move Columns (dragging column headers).
// Translated from gridcraft crates/engine/src/cmd/sheet.rs (`lines`, `check_push_off_sheet`,
// `insert_lines`, `delete_areas`, `delete_lines`, `move_columns`, `insert_cells`, `delete_cells`,
// `insert_copied_cells`, `insert_copied_steps`, `check_lines_protection`, `cancel_copy_mode`,
// `inherit_line_format`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Whole lines go through the foundation's `grid.structure` op (one undoable op that moves cells,
// lines, merges, tables, the freeze, formulas and names); the side tables follow
// (lib/sheet-shift.mjs). Cell-level shifts and column moves apply new sheets as one `grid.replace`.
// Inserting or deleting ends copy mode for this workbook, as Excel does: the copied block may
// have moved.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, rangeA1, parseRange, rowsRange, colsRange, colToLetters, isFullRows, isFullCols, height, width, offset, a1, rangeOf} from '../lib/addr.mjs';
import {targetRanges, targetSheet, gridSel, setGridSelection, cellParamOn, bad, failed, baseDoc, requireSchema2, hasDoc} from '../lib/edit-targets.mjs';
import {parseLines} from '../lib/format-lines.mjs';
import {PROTECTED, protectionOf, styleOfId, cellsIn} from '../lib/format-ranges.mjs';
import {RANGE, SHEET, ROWS, COLS, UPSTREAM_COMMIT} from '../lib/format-params.mjs';
import {shiftSideTables, fixTableColumns, transformSheets, cellShift, checkTableShift, mapRangeThrough} from '../lib/sheet-shift.mjs';
import {usedBounds} from '../model/store.mjs';
import {currentArea} from '../model/workbook.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/sheet.rs']};
const PUSH_OFF = 'To prevent possible loss of data, Excel cannot shift nonblank cells off of the worksheet.';
const CLIP_KIND = 'grid.range';

/** The grid range on the session clipboard (U:grid/edit's `edit.copy`/`edit.cut`), or null. */
export function gridClipEntry(ctx) {
  const c = ctx.clipboard;
  return c && c.app === 'grid' && c.kind === CLIP_KIND && c.data ? c : null;
}
/** sheet.rs `cancel_copy_mode`: inserting or deleting cells ends copy mode for this workbook. */
export function cancelCopyMode(ctx) {
  const c = gridClipEntry(ctx);
  if (c && c.data.docId === ctx.docId) ctx.setClipboard(null);
}

const axisKey = axis => (axis === 'rows' ? 'rows' : 'cols');
const limitOf = axis => (axis === 'rows' ? MAX_ROWS : MAX_COLS);

/** sheet.rs `lines`: (first line, count) from rows/cols (or range), else the selection's current area. */
function lines(ctx, p, axis) {
  const key = axisKey(axis);
  const text = typeof p[key] === 'string' && p[key] ? p[key] : typeof p.range === 'string' && p.range ? p.range : null;
  let a, b, sheet = null;
  if (text) {
    const parsed = parseLines(ctx.doc, text, axis === 'rows', key);
    [a, b] = parsed.spans[0];
    sheet = parsed.sheet;
  } else {
    const r = currentArea(gridSel(ctx));
    [a, b] = axis === 'rows' ? [r.start.row, r.end.row] : [r.start.col, r.end.col];
  }
  const count = Math.max(1, p.count ?? (Math.max(a, b) - Math.min(a, b) + 1));
  return {at: Math.min(a, b), count, sheet};
}

/** The sheet a line command works on: `sheet`, else the one its lines name, else the active one. */
function lineSheet(ctx, p, axis) {
  const key = axisKey(axis);
  if (p.sheet !== undefined && p.sheet !== null) return targetSheet(ctx, {sheet: p.sheet}, []);
  const text = typeof p[key] === 'string' && p[key] ? p[key] : typeof p.range === 'string' && p.range ? p.range : null;
  if (text) { const parsed = parseLines(ctx.doc, text, axis === 'rows', key); if (parsed.sheet !== null) return parsed.sheet; }
  return gridSel(ctx).sheet;
}

/** sheet.rs `check_lines_protection`. */
function checkLinesProtection(ctx, si, axis, at, count, insert) {
  const sh = ctx.doc.sheets[si];
  const pr = protectionOf(sh);
  if (!pr) return;
  const allowed = axis === 'rows' ? (insert ? pr.insertRows : pr.deleteRows) : (insert ? pr.insertColumns : pr.deleteColumns);
  if (!allowed) throw failed(PROTECTED);
  if (insert) return;
  const end = Math.min(at + count - 1, limitOf(axis) - 1);
  const locked = id => styleOfId(ctx, id ?? 0).protection.locked;
  const infos = sh[axisKey(axis)] ?? {};
  for (const k of Object.keys(infos)) { const i = Number(k); if (i >= at && i <= end && locked(infos[k]?.s ?? 0)) throw failed(PROTECTED); }
  const block = axis === 'rows' ? rowsRange(at, end) : colsRange(at, end);
  if (cellsIn(sh, block.start.row, block.start.col, block.end.row, block.end.col).some(([, , cell]) => locked(cell.s))) throw failed(PROTECTED);
}

/** sheet.rs `check_push_off_sheet`. */
function checkPushOff(ctx, si, axis, at, count) {
  const u = usedBounds(ctx.doc.sheets[si]);
  if (!u) return;
  const last = axis === 'rows' ? u.r1 : u.c1;
  if (last >= at && last + count >= limitOf(axis)) throw failed(PUSH_OFF);
}

/** sheet.rs `inherit_line_format`: new lines take the format of the line before (Format Same As Above). */
function inheritLineFormat(ctx, si, axis, at, count) {
  if (at === 0) return;
  const key = axisKey(axis);
  const map = ctx.doc.sheets[si][key];
  const prev = map?.[at - 1];
  if (!prev) return;
  const next = {...map};
  for (let i = at; i < at + count && i < limitOf(axis); i++) {
    const {hidden, outline, collapsed, ...rest} = prev;
    if (Object.keys(rest).length) next[i] = rest; else delete next[i];
  }
  ctx.change.set(['sheets', si, key], next);
}

/** One whole-line insert or delete through the foundation op, with what it leaves. */
function structure(ctx, si, edit) {
  const before = ctx.doc.sheets[si];
  ctx.change.apply({op: 'grid.structure', sheet: before.id, edit});
  shiftSideTables(ctx.change, ctx.doc, si, edit, before);
  fixTableColumns(ctx.change, ctx.doc, si, before, edit);
}

/** The selection stays where it was (gridcraft leaves cx.sel alone; Excel keeps the cells selected, not what moved). */
const keepSelection = ctx => { const sel = gridSel(ctx); return () => setGridSelection(ctx, sel); };

/** sheet.rs `insert_lines`. */
function insertLines(ctx, p, axis) {
  baseDoc(ctx);
  const restore = keepSelection(ctx);
  const {at, count} = lines(ctx, p, axis);
  const limit = limitOf(axis);
  if (at + count > limit) throw bad(axis === 'rows' ? 'home.insertRows' : 'home.insertColumns', 'the inserted lines would extend past the end of the worksheet');
  const si = lineSheet(ctx, p, axis);
  requireSchema2(ctx, si);
  checkLinesProtection(ctx, si, axis, at, count, true);
  checkPushOff(ctx, si, axis, at, count);
  structure(ctx, si, {type: 'insert', axis, at, count});
  // New lines take the format of the line before (Excel's "Format Same As Above").
  inheritLineFormat(ctx, si, axis, at, count);
  restore();
  cancelCopyMode(ctx);
  const r = axis === 'rows' ? rowsRange(at, at + count - 1) : colsRange(at, at + count - 1);
  return {sheet: si, inserted: rangeA1(r)};
}

/** sheet.rs `delete_areas`: (first, count) per area, merged and sorted last to first. */
function deleteAreas(ctx, p, axis) {
  const key = axisKey(axis);
  let spans;
  if (p.count !== undefined) {
    const {at, count} = lines(ctx, p, axis);
    const n = Math.max(1, Math.min(count, limitOf(axis) - at));
    spans = [[at, at + n - 1]];
  } else {
    const text = typeof p[key] === 'string' && p[key] ? p[key] : typeof p.range === 'string' && p.range ? p.range : null;
    if (text) spans = parseLines(ctx.doc, text, axis === 'rows', key).spans;
    else spans = gridSel(ctx).ranges.map(r => (axis === 'rows' ? [r.start.row, r.end.row] : [r.start.col, r.end.col]));
  }
  spans = spans.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  return merged.reverse().map(([a, b]) => [a, b - a + 1]);
}

/** sheet.rs `delete_lines`. */
function deleteLines(ctx, p, axis) {
  baseDoc(ctx);
  const restore = keepSelection(ctx);
  const areas = deleteAreas(ctx, p, axis);
  const si = lineSheet(ctx, p, axis);
  requireSchema2(ctx, si);
  for (const [at, count] of areas) checkLinesProtection(ctx, si, axis, at, count, false);
  // Last area first, so the earlier ones keep their positions.
  for (const [at, count] of areas) structure(ctx, si, {type: 'delete', axis, at, count});
  restore();
  cancelCopyMode(ctx);
  // The selection stays where it was (Excel keeps the lines that moved up selected).
  return {sheet: si, deleted: areas.map(([at, count]) => rangeA1(axis === 'rows' ? rowsRange(at, at + count - 1) : colsRange(at, at + count - 1))).reverse()};
}

/** Re-creates every block object (same cells) so no cached entry list of a block written in place is read again. */
function freshBlocks(ctx) {
  const sheets = ctx.doc.sheets.map(sh => (sh.blocks ? {...sh, blocks: Object.fromEntries(Object.entries(sh.blocks).map(([k, b]) => [k, {...b}]))} : sh));
  ctx.change.apply({op: 'grid.replace', sheets, names: ctx.doc.names});
}

/** Applies a cell-level edit on sheet si as one grid.replace op. */
function replaceWith(ctx, si, edit, move, after) {
  const {sheets, names} = transformSheets(ctx.doc, si, edit, move);
  if (after) after(sheets[si]);
  ctx.change.apply({op: 'grid.replace', sheets, names});
}

/** sheet.rs `move_columns`: reorders a contiguous block of whole columns before column `before`. */
function moveColumns(ctx, p) {
  baseDoc(ctx);
  const {at: from, count} = lines(ctx, p, 'cols');
  const before = p.before;
  const end = from + count;
  if (end > MAX_COLS) throw bad('sheet.moveColumns', 'source columns are outside the worksheet');
  if (before >= MAX_COLS || before + count > MAX_COLS) throw bad('sheet.moveColumns', 'destination columns are outside the worksheet');
  const colsA1 = (a, b) => rangeA1(colsRange(a, b));
  if (before >= from && before <= end) return {cols: colsA1(from, end - 1)};
  const si = lineSheet(ctx, p, 'cols');
  requireSchema2(ctx, si);
  const u = usedBounds(ctx.doc.sheets[si]);
  if (u && u.c1 >= before && u.c1 + count >= MAX_COLS) throw failed('To prevent possible loss of data, columns cannot be shifted off of the worksheet.');
  checkLinesProtection(ctx, si, 'cols', before, count, true);
  checkLinesProtection(ctx, si, 'cols', from, count, false);
  const movedFrom = before <= from ? from + count : from;
  if (movedFrom + count > MAX_COLS) throw bad('sheet.moveColumns', 'the move is too close to the worksheet boundary');
  const destination = before, deleteAt = movedFrom;
  const finalStart = before > from ? before - count : before;
  const activeRow = gridSel(ctx).active.row;
  structure(ctx, si, {type: 'insert', axis: 'cols', at: before, count});
  const source = colsRange(movedFrom, movedFrom + count - 1);
  const edit = {type: 'move', from: source, toRow: 0, toCol: destination};
  const moving = (row, col) => (col >= movedFrom && col < movedFrom + count ? [row, destination + (col - movedFrom)] : [row, col]);
  replaceWith(ctx, si, edit, moving, sh => {
    if (!sh.cols) return;
    const cols = {...sh.cols};
    const moved = [];
    for (let k = 0; k < count; k++) if (cols[movedFrom + k] !== undefined) { moved.push([k, cols[movedFrom + k]]); delete cols[movedFrom + k]; }
    for (const [k, info] of moved) cols[destination + k] = info;
    sh.cols = cols;
  });
  structure(ctx, si, {type: 'delete', axis: 'cols', at: deleteAt, count});
  const r = colsRange(finalStart, finalStart + count - 1);
  setGridSelection(ctx, {sheet: si, active: {row: activeRow, col: finalStart}, anchor: {row: activeRow, col: finalStart}, ranges: [r]});
  cancelCopyMode(ctx);
  return {cols: colsA1(finalStart, finalStart + count - 1)};
}

/** The first target area of a cell command. */
function firstArea(ctx, p) {
  const t = targetRanges(ctx, p);
  return {sheet: t.sheet, r: t.fromSelection ? currentArea(gridSel(ctx)) : t.areas[0]};
}

/** sheet.rs `insert_cells`. */
function insertCells(ctx, p) {
  baseDoc(ctx);
  const restore = keepSelection(ctx);
  const shift = p.shift ?? 'down';
  const {sheet: si, r} = firstArea(ctx, p);
  if (shift === 'row' || shift === 'entireRow') return insertLines(ctx, {rows: `${r.start.row + 1}:${r.end.row + 1}`, sheet: si}, 'rows');
  if (shift === 'column' || shift === 'entireColumn') return insertLines(ctx, {cols: `${colToLetters(r.start.col)}:${colToLetters(r.end.col)}`, sheet: si}, 'cols');
  requireSchema2(ctx, si);
  const right = shift === 'right';
  const edit = {type: 'insertCells', axis: right ? 'cols' : 'rows', range: r};
  const sh = ctx.doc.sheets[si];
  checkTableShift(sh, edit);
  // Refuse to push data off the sheet: cells in the last width/height positions would be dropped.
  const doomed = right
    ? rangeOf(r.start.row, Math.max(r.start.col, MAX_COLS - width(r)), r.end.row, MAX_COLS - 1)
    : rangeOf(Math.max(r.start.row, MAX_ROWS - height(r)), r.start.col, MAX_ROWS - 1, r.end.col);
  const full = cellsIn(sh, doomed.start.row, doomed.start.col, doomed.end.row, doomed.end.col)
    .some(([, , cell]) => cell.f !== undefined || (cell.v !== undefined && cell.v !== null && cell.v !== ''));
  if (full) throw failed(PUSH_OFF);
  replaceWith(ctx, si, edit, cellShift(edit));
  restore();
  cancelCopyMode(ctx);
  return {sheet: si, inserted: rangeA1(r), shift: right ? 'right' : 'down'};
}

/** sheet.rs `delete_cells`. */
function deleteCells(ctx, p) {
  baseDoc(ctx);
  const restore = keepSelection(ctx);
  const shift = p.shift ?? 'up';
  const {sheet: si, r} = firstArea(ctx, p);
  if (shift === 'row' || shift === 'entireRow') return deleteLines(ctx, {rows: `${r.start.row + 1}:${r.end.row + 1}`, sheet: si}, 'rows');
  if (shift === 'column' || shift === 'entireColumn') return deleteLines(ctx, {cols: `${colToLetters(r.start.col)}:${colToLetters(r.end.col)}`, sheet: si}, 'cols');
  requireSchema2(ctx, si);
  const left = shift === 'left';
  const edit = {type: 'deleteCells', axis: left ? 'cols' : 'rows', range: r};
  checkTableShift(ctx.doc.sheets[si], edit);
  // References into the deleted cells become #REF!; the rest move.
  replaceWith(ctx, si, edit, cellShift(edit));
  restore();
  cancelCopyMode(ctx);
  return {sheet: si, deleted: rangeA1(r), shift: left ? 'left' : 'up'};
}

/** sheet.rs `insert_copied_cells` + `insert_copied_steps`: room at the destination, then the paste (or the move), as one undo step. */
async function insertCopiedCells(ctx, p) {
  baseDoc(ctx);
  const entry = gridClipEntry(ctx);
  if (!entry) throw failed('Nothing to paste.');
  const clip = entry.data;
  const si = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, si);
  const at = cellParamOn(ctx, p, 'at', si) ?? currentArea(gridSel(ctx)).start;
  const shift = p.shift ?? 'down';
  if (shift !== 'down' && shift !== 'right') throw bad('home.insertCopiedCells', `unknown \`shift\`: ${shift} (down or right)`);
  const sel = parseRange(clip.selected ?? clip.range);
  const range = parseRange(clip.range);
  if (!sel || !range) throw failed('Nothing to paste.');
  const rows = isFullRows(sel), cols = isFullCols(sel);
  if (rows && cols) throw failed('The copy area is the whole sheet; there is no room to insert it.');
  const sameDoc = ctx.docId === clip.docId;
  const cut = !!clip.cut && sameDoc;
  if (cut && !rows && !cols) throw failed('Insert Cut Cells works on whole rows or columns; cut whole rows or columns, or use Paste.');
  const clipSheet = ctx.doc.sheets.findIndex(x => x.id === clip.sheetId);
  // A moved block can't be inserted inside itself.
  if (cut && clipSheet === si) {
    const inside = rows ? at.row > sel.start.row && at.row <= sel.end.row : at.col > sel.start.col && at.col <= sel.end.col;
    if (inside) throw failed("The cut rows or columns can't be inserted inside themselves.");
  }
  const sheetRef = `/sh:${encodeURIComponent(ctx.doc.sheets[si].id)}`;
  // Where the copied block's top-left lands, relative to the (untrimmed) copied lines.
  let inserted, pasteAt;
  if (rows) {
    const h = height(sel);
    const start = at.row;
    await ctx.run('home.insertRows', {rows: `${start + 1}:${start + h}`, sheet: sheetRef});
    const dr = Math.max(0, range.start.row - sel.start.row);
    inserted = rowsRange(start, Math.min(start + h - 1, MAX_ROWS - 1));
    pasteAt = {row: start + dr, col: range.start.col};
  } else if (cols) {
    const w = width(sel);
    const start = at.col;
    const end = Math.min(start + w - 1, MAX_COLS - 1);
    await ctx.run('home.insertColumns', {cols: `${colToLetters(start)}:${colToLetters(end)}`, sheet: sheetRef});
    const dc = Math.max(0, range.start.col - sel.start.col);
    inserted = colsRange(start, end);
    pasteAt = {row: range.start.row, col: start + dc};
  } else {
    const end = offset(at, height(range) - 1, width(range) - 1);
    if (!end) throw failed("The copied cells don't fit on the sheet at this position.");
    const block = {start: at, end};
    await ctx.run('home.insertCells', {range: `${sheetRef}/${rangeA1(block)}`, shift});
    inserted = block;
    pasteAt = at;
  }
  // Inserting ended copy mode; bring the clipboard back for the paste. A cut reads the live
  // workbook, so it follows the source if the insert pushed it along.
  let data = clip;
  if (cut) {
    const pushed = clipSheet === si && (rows ? sel.start.row >= at.row : sel.start.col >= at.col);
    const [dr, dc] = rows ? [height(inserted), 0] : [0, width(inserted)];
    const mv = r => (pushed ? {start: {row: Math.min(r.start.row + dr, MAX_ROWS - 1), col: Math.min(r.start.col + dc, MAX_COLS - 1)},
      end: {row: Math.min(r.end.row + dr, MAX_ROWS - 1), col: Math.min(r.end.col + dc, MAX_COLS - 1)}} : r);
    data = {...clip, range: rangeA1(mv(range)), selected: rangeA1(mv(sel))};
    Object.defineProperty(data, 'source', {value: ctx.doc, enumerable: false});
  }
  ctx.setClipboard({...entry, data});
  const out = await ctx.run('edit.pasteSpecial', {what: 'all', at: `${sheetRef}/${a1(pasteAt.row, pasteAt.col)}`});
  let final = inserted;
  if (cut) {
    // The paste wrote into blocks it had read through the foundation's per-block entry cache;
    // fresh block objects keep the line delete below from reading stale entries
    // (design note U-grid-format--F-grid--block-entries-cache).
    freshBlocks(ctx);
    // Close the gap the moved lines left behind.
    const lines0 = parseRange(data.selected);
    const clipRef = `/sh:${encodeURIComponent(clip.sheetId)}`;
    let removed, beforeDest;
    if (rows) {
      await ctx.run('home.deleteRows', {rows: `${lines0.start.row + 1}:${lines0.end.row + 1}`, sheet: clipRef});
      removed = height(lines0);
      beforeDest = clipSheet === si && lines0.start.row < inserted.start.row;
    } else {
      await ctx.run('home.deleteColumns', {cols: `${colToLetters(lines0.start.col)}:${colToLetters(lines0.end.col)}`, sheet: clipRef});
      removed = width(lines0);
      beforeDest = clipSheet === si && lines0.start.col < inserted.start.col;
    }
    if (beforeDest) {
      const [dr, dc] = rows ? [-removed, 0] : [0, -removed];
      final = {start: {row: Math.max(0, inserted.start.row + dr), col: Math.max(0, inserted.start.col + dc)}, end: {row: Math.max(0, inserted.end.row + dr), col: Math.max(0, inserted.end.col + dc)}};
    }
  }
  setGridSelection(ctx, {sheet: si, active: {...final.start}, anchor: {...final.start}, ranges: [final]});
  // Like inserting cells, this ends copy mode (the copied block may have moved).
  ctx.setClipboard(null);
  return {sheet: si, inserted: rangeA1(final), pasted: out?.pasted ?? null};
}

const hasClipboard = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return gridClipEntry(ctx) ? {enabled: true} : {enabled: false, reason: 'the clipboard is empty'};
};

const LINES_ROWS = s.object({rows: ROWS, range: RANGE, sheet: SHEET, count: s.optional(s.integer({min: 1, max: MAX_ROWS}))});
const LINES_COLS = s.object({cols: COLS, range: RANGE, sheet: SHEET, count: s.optional(s.integer({min: 1, max: MAX_COLS}))});

export default defineCommands({
  family: 'sheet',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'home.insertRows', label: 'Insert Sheet Rows', shortcut: 'Ctrl+Shift+=', risk: 'edit',
      description: 'Insert whole rows above the selected rows (or `rows`, e.g. "3:5"); `count` inserts that many at the first.',
      params: LINES_ROWS, state: hasDoc, run: (ctx, p) => insertLines(ctx, p, 'rows')},
    {id: 'home.insertColumns', label: 'Insert Sheet Columns', risk: 'edit',
      description: 'Insert whole columns left of the selected columns (or `cols`, e.g. "B:C").',
      params: LINES_COLS, state: hasDoc, run: (ctx, p) => insertLines(ctx, p, 'cols')},
    {id: 'home.deleteRows', label: 'Delete Sheet Rows', shortcut: 'Mod+-', risk: 'edit',
      description: 'Delete the selected rows (every area of a multi-area selection, or `rows`, e.g. "3:3,7:8").',
      params: LINES_ROWS, state: hasDoc, run: (ctx, p) => deleteLines(ctx, p, 'rows')},
    {id: 'home.deleteColumns', label: 'Delete Sheet Columns', risk: 'edit',
      description: 'Delete the selected columns (every area, or `cols`, e.g. "A:A,C:C").',
      params: LINES_COLS, state: hasDoc, run: (ctx, p) => deleteLines(ctx, p, 'cols')},
    {id: 'sheet.moveColumns', label: 'Move Columns', risk: 'edit',
      description: 'Move whole columns (`cols`, default the selection) before the zero-based column `before`, without replacing the columns there.',
      params: s.object({cols: COLS, range: RANGE, sheet: SHEET, before: s.integer({min: 0, max: MAX_COLS})}), state: hasDoc, run: moveColumns},
    {id: 'home.insertCells', label: 'Insert Cells…', risk: 'edit', dialog: 'dialog.insertCells',
      description: 'Insert blank cells at a range (default: the selection), shifting the cells there right or down, or insert entire rows or columns.',
      params: s.object({range: RANGE, sheet: SHEET, shift: s.enum(['right', 'down', 'row', 'column', 'entireRow', 'entireColumn'])}), state: hasDoc, run: insertCells},
    {id: 'home.insertCopiedCells', label: 'Insert Copied Cells', risk: 'edit', dialog: 'dialog.insertPaste',
      description: 'Insert the copied cells at `at` (the active cell) and paste them there: whole copied rows or columns insert whole lines; other blocks shift the cells down (default) or right. A cut of whole rows or columns moves them (Insert Cut Cells).',
      params: s.object({at: s.optional(s.string({min: 1, max: 600})), sheet: SHEET, shift: s.optional(s.enum(['down', 'right', 'up', 'left']))}), state: hasClipboard, run: insertCopiedCells},
    {id: 'home.deleteCells', label: 'Delete Cells…', risk: 'edit', dialog: 'dialog.deleteCells',
      description: 'Delete the cells of a range (default: the selection), shifting the cells after them left or up, or delete entire rows or columns.',
      params: s.object({range: RANGE, sheet: SHEET, shift: s.enum(['left', 'up', 'row', 'column', 'entireRow', 'entireColumn'])}), state: hasDoc, run: deleteCells},
  ],
});

export {mapRangeThrough};
