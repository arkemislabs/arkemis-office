// Grid's foundation API (ctx.model for every grid command; the surface reads through it too).
// Gathers the translated gridcraft model, calc, formula, functions and numfmt crates:
//   store.mjs (cells in 256-row blocks), sheet.mjs (geometry, merges, freeze, names), style.mjs,
//   workbook.mjs (records, selection), input.mjs (typing into cells), fill.mjs (AutoFill),
//   structure.mjs (insert/delete lines as one undoable op), calc.mjs (dependency graph and
//   recalculation), eval.mjs + functions/* (the evaluator and worksheet functions).
// Upstream: gridcraft crates/{core,model,calc,formula,functions,numfmt} at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values are never stored for formulas: `values(content)` is the calculation engine following the
// content lineage (engineFor), so reading a value after an edit recalculates only what changed.
// The older flat translations (core/formulas.mjs, core/formula-functions.mjs, core/gridcraft-*.mjs,
// core/grid-*.mjs) stay for the legacy editor; this model replaces them for schema 2.
// No DOM, no Node built-ins.

import {engineFor} from './calc.mjs';
import {formatValue} from '../lib/numfmt.mjs';
import {toJSONValue, display as displayRaw, GArray} from '../lib/value.mjs';
import {cellAt} from './store.mjs';
import {styleAt, fromKernelSelection, sheetView} from './workbook.mjs';
import {activeSheetIndex} from './sheet.mjs';

export * from './store.mjs';
export * from './sheet.mjs';
export * from './style.mjs';
export * from './workbook.mjs';
export * from './input.mjs';
export * from './fill.mjs';
export * from './structure.mjs';
export {engineFor, CalcEngine, WorkbookView, dropEngines} from './calc.mjs';
export {Evaluator, parseFormula, isKnownFunction} from './eval.mjs';
export {lookup as lookupFunction, all as allFunctions} from './functions/index.mjs';

/** The calculation engine for a workbook content (synced and recalculated). */
export const values = content => engineFor(content);

/** The value a cell shows (formula result, constant or spilled value). */
export function valueAt(content, si, row, col) {
  return engineFor(content).sheetValue(si, row, col);
}

/**
 * What a cell shows: {text, color, numeric, fill} with its number format applied (no width
 * narrowing: General fitting to the column happens in the surface, as cell_paint `display_text`).
 * `showFormulas` shows `=formula` text for formula cells; `showZeros:false` hides zeros.
 */
export function displayAt(content, si, row, col, value = valueAt(content, si, row, col)) {
  const sheet = content.sheets[si];
  const view = sheetView(sheet);
  if (view.showFormulas) {
    const c = cellAt(sheet, row, col);
    if (c?.f !== undefined) return {text: `=${c.f}`, color: null, numeric: false, fill: null};
  }
  const v = value instanceof GArray ? (value.data[0] ?? null) : value;
  if (v === null || v === undefined) return {text: '', color: null, numeric: false, fill: null};
  if (!view.showZeros && v === 0) return {text: '', color: null, numeric: true, fill: null};
  const st = styleAt(content, sheet, row, col);
  if (st.numFmt === 'checkbox' && (typeof v === 'boolean')) return {text: '', color: null, numeric: false, fill: null};
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  return formatValue(v, st.numFmt, sys);
}

/** The value as plain JSON for bridge reads ({e:'#DIV/0!'} for errors). */
export const jsonValueAt = (content, si, row, col) => toJSONValue(valueAt(content, si, row, col));
export {displayRaw};

/** The grid selection of a command context (kernel selection → {sheet, active, anchor, ranges}). */
export const selection = ctx => fromKernelSelection(ctx.doc, ctx.selection);
/** The active cell of a command context: {sheet, row, col}. */
export function activeCell(ctx) {
  const sel = selection(ctx);
  return {sheet: sel.sheet, row: sel.active.row, col: sel.active.col};
}
export {activeSheetIndex};
// The view a workbook is saved with and opened in (U:grid/view: the active sheet's zoomScale and view).
export {fileForSave, initialView} from '../lib/view-file.mjs';
