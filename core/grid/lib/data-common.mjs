// What every Data command shares: the range a command works on, the header guess, the value and
// text a cell shows, a "trial" workbook with some cells replaced (what-if analysis, validation of
// a value being entered) and hidden-row bookkeeping.
// Translated from gridcraft crates/engine/src/cmd/data.rs (`col_param`, `data_range`, `data_target`,
// `guess_header`) and crates/engine/src/cmd/whatif.rs (`Trial`, `parse_range`, `cell_arg`, `cell_list`)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The calculation engine follows a content lineage (model/calc.mjs `engineFor`): a trial content
// that shares every block it does not touch recalculates only the dependents of the replaced
// cells, and the document's own content syncs back the same way. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, a1, parseCell, parseRange, rangeOf, colToLetters, lettersToCol, intersection, isFullCols, isFullRows, contains, isSingle, rangeCell} from './addr.mjs';
import {GArray} from './value.mjs';
import {engineFor} from '../model/calc.mjs';
import {displayAt} from '../model/index.mjs';
import {cellAt, usedBounds, hasContent, blockOf} from '../model/store.mjs';
import {tableRanges, sheetIndex} from '../model/sheet.mjs';
import {currentRegion, styleAt} from '../model/workbook.mjs';
import {gridSel, targetSheet, targetRange, splitRef, bad, failed, baseDoc} from './edit-targets.mjs';

export {bad, failed, baseDoc};

/** The value a cell shows (spilled values included), unwrapped from arrays. */
export function valueOf(engine, si, row, col) {
  const v = engine.sheetValue(si, row, col);
  return v instanceof GArray ? (v.data[0] ?? null) : v;
}
/** The text a cell shows (number format applied). */
export const textOf = (content, si, row, col, v) => displayAt(content, si, row, col, v).text;
/** The text of a value for comparisons that ignore formatting. */
export const isBlankValue = v => v === null || v === undefined || v === '';

/** gridcraft `col_param`: a letter (`B`, `$B`) or a 0-based offset from `base`; null when neither. */
export function colParam(v, base) {
  if (typeof v === 'string') { const t = v.trim().replace(/^\$/, ''); return /^[A-Za-z]{1,3}$/.test(t) ? lettersToCol(t.toUpperCase()) : null; }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return base + v;
  return null;
}

/** The table holding a cell: {table, ranges} or null. */
export function tableAtCell(sheet, at) {
  for (const t of sheet?.tables ?? []) {
    let r;
    try { r = tableRanges(t); } catch { continue; }
    if (contains(r.range, at)) return {table: t, ...r};
  }
  return null;
}

const filledAt = (sheet, engine, si) => (row, col) => hasContent(cellAt(sheet, row, col)) || engine.spillAnchorOf(si, row, col) !== null;

/** The contiguous data region around a cell (selection.rs `current_region`). */
export function regionAround(content, si, at) {
  const engine = engineFor(content);
  return currentRegion(filledAt(content.sheets[si], engine, si), at);
}

/**
 * The range a data command works on: `range`, else the table holding the active cell (its header
 * and data rows), else the selection when it is a block (trimmed to the used range), else the
 * current region around the active cell.
 */
export function dataRange(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  if (typeof p.range === 'string' && p.range) return trimToUsed(content, targetRange(ctx, p).sheet, targetRange(ctx, p).range);
  const si = sel.sheet;
  const sheet = content.sheets[si];
  const tb = tableAtCell(sheet, sel.active);
  if (tb) return tb.data ? {start: {...tb.range.start}, end: {...tb.data.end}} : tb.range;
  const cur = sel.ranges[sel.ranges.length - 1];
  if (!isSingle(cur)) {
    const u = usedBounds(sheet);
    if (!u) return rangeCell(sel.active);
    return intersection(cur, rangeOf(u.r0, u.c0, u.r1, u.c1)) ?? cur;
  }
  return regionAround(content, si, sel.active);
}

/** Whole rows or columns are trimmed to the used range (whatif.rs `trim_to_used`). */
export function trimToUsed(content, si, r) {
  if (!(isFullCols(r) || isFullRows(r))) return r;
  const u = usedBounds(content.sheets[si]);
  if (!u) return rangeCell(r.start);
  return intersection(r, rangeOf(0, 0, u.r1, u.c1)) ?? rangeCell(r.start);
}

/** data_target: the sheet and range a data command works on. */
export function dataTarget(ctx, p, cmd) {
  const content = baseDoc(ctx);
  const sheet = targetSheet(ctx, p);
  if (typeof p.range === 'string' && p.range) {
    const split = splitRef(content, p.range);
    if (split.sheet !== null && split.sheet !== sheet) throw bad(cmd, `\`${p.range}\` names a sheet other than \`sheet\``);
  }
  const sel = gridSel(ctx);
  if (sheet !== sel.sheet && !p.range) throw bad(cmd, 'missing `range`: the selection is on the active sheet');
  const range = dataRange(ctx, p);
  return {sheet, range};
}

/** Excel's header guess: the first row is text over a column of numbers, or is bold. */
export function guessHeader(content, si, r, engine = engineFor(content)) {
  const sheet = content.sheets[si];
  const tb = tableAtCell(sheet, r.start);
  if (tb) return tb.headerRow;
  if (r.end.row - r.start.row + 1 < 2) return false;
  let votes = 0;
  for (let c = r.start.col; c <= r.end.col; c++) {
    const a = valueOf(engine, si, r.start.row, c), b = valueOf(engine, si, r.start.row + 1, c);
    if (typeof a === 'string' && a !== '' && typeof b !== 'string' && !isBlankValue(b)) votes++;
    if (styleAt(content, sheet, r.start.row, c).font.bold !== styleAt(content, sheet, r.start.row + 1, c).font.bold) votes++;
  }
  return votes > 0;
}

// ---------------------------------------------------------------------------------------------
// Ranges and cells named by text (whatif.rs)

/** A sheet-qualified range text (`A1:C9`, `Sheet2!A:C`) resolved against the workbook: {sheet, range}. Whole lines are trimmed to the used range. */
export function parseRangeText(content, text, cmd, activeSheet) {
  const t = String(text ?? '').trim();
  let split;
  try { split = splitRef(content, t); } catch (e) { throw bad(cmd, e.message); }
  const si = split.sheet ?? activeSheet;
  const r = parseRange(split.body.replace(/\$/g, '').trim());
  if (!r) throw bad(cmd, `not a range: \`${text}\``);
  return {sheet: si, range: trimToUsed(content, si, r)};
}
/** A single cell param (`B5`, `Sheet2!B5`): {sheet, cell}. */
export function cellArg(content, text, what, cmd, activeSheet) {
  if (typeof text !== 'string' || !text.trim()) throw bad(cmd, `missing \`${what}\``);
  let split;
  try { split = splitRef(content, text.trim()); } catch (e) { throw bad(cmd, e.message); }
  const c = parseCell(split.body.replace(/\$/g, '').trim());
  if (!c) throw bad(cmd, `\`${what}\` is not a cell: \`${text}\``);
  return {sheet: split.sheet ?? activeSheet, cell: c};
}
/** Cells of `B2:B4,D1` (row-major per area, duplicates removed), at most `cap`: {sheet, cells}. */
export function cellList(content, text, cmd, cap, activeSheet) {
  let sheet = null;
  const out = [];
  const seen = new Set();
  for (const part of String(text).split(',').map(x => x.trim()).filter(Boolean)) {
    const {sheet: si, range: r} = parseRangeText(content, part, cmd, activeSheet);
    if (sheet === null) sheet = si; else if (sheet !== si) throw bad(cmd, 'all cells must be on one sheet');
    if ((r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1) > cap) throw bad(cmd, `too many cells (at most ${cap})`);
    for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) {
      const k = row * MAX_COLS + col;
      if (!seen.has(k)) { seen.add(k); out.push({row, col}); }
      if (out.length > cap) throw bad(cmd, `too many cells (at most ${cap})`);
    }
  }
  return {sheet: sheet ?? activeSheet, cells: out};
}

// ---------------------------------------------------------------------------------------------
// Trials

/** A content with constants put in cells: sets = [{sheet, row, col, value}]; styles stay. Untouched blocks stay shared. */
export function withCells(content, sets) {
  const sheets = content.sheets.slice();
  const copies = new Map();
  for (const {sheet: si, row, col, value} of sets) {
    let sh = sheets[si];
    if (!copies.has(si)) { sh = {...sh, blocks: {...sh.blocks}}; sheets[si] = sh; copies.set(si, new Set()); }
    sh = sheets[si];
    const b = blockOf(row);
    const done = copies.get(si);
    if (!done.has(b)) { sh.blocks[b] = {...(sh.blocks[b] ?? {})}; done.add(b); }
    const key = colToLetters(col) + (row + 1);
    const old = sh.blocks[b][key];
    const cell = {};
    if (value !== null && value !== undefined) cell.v = value;
    if (old?.s) cell.s = old.s;
    if (Object.keys(cell).length) sh.blocks[b][key] = cell; else delete sh.blocks[b][key];
  }
  return {...content, sheets};
}

/** Evaluates a workbook with some input cells replaced, without touching the document (whatif.rs `Trial`). */
export class Trial {
  constructor(content) {
    // What-if analysis always recalculates, even in manual mode.
    this.base = content.calc && content.calc.mode && content.calc.mode !== 'auto' ? {...content, calc: {...content.calc, mode: 'auto'}} : content;
  }
  /** Sets `sets` to constants, recalculates their dependents and reads `reads` ([{sheet, row, col}]). */
  run(sets, reads) {
    const trial = withCells(this.base, sets);
    const engine = engineFor(trial);
    return reads.map(r => valueOf(engine, r.sheet, r.row, r.col));
  }
}

// ---------------------------------------------------------------------------------------------
// Hidden rows

/** Sets or clears `hidden` on rows (Map row -> boolean) through the change API. */
export function setRowsHidden(change, content, si, map) {
  const rows = {...(content.sheets[si].rows ?? {})};
  let changed = false;
  for (const [row, hide] of map) {
    const info = rows[row];
    if (hide) {
      if (!info?.hidden) { rows[row] = {...(info ?? {}), hidden: true}; changed = true; }
    } else if (info?.hidden) {
      const {hidden, ...rest} = info;
      if (Object.keys(rest).length) rows[row] = rest; else delete rows[row];
      changed = true;
    }
  }
  if (changed) change.set(['sheets', si, 'rows'], rows);
  return changed;
}

export const a1Of = (row, col) => a1(row, col);
export {sheetIndex, MAX_ROWS, MAX_COLS, CommandError};
