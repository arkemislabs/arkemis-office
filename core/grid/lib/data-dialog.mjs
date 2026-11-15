// What the Data tab's dialogs read from the workbook when they open: the data range around the
// selection with its column headings, the active cell, the lists a sort can follow.
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`sort`: the columns of the region
// "B: Header", `remove_duplicates_range`, `validation_defaults`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {a1, colToLetters, rangeA1} from './addr.mjs';
import {engineFor} from '../model/calc.mjs';
import {WEEKDAYS, MONTHS} from './date.mjs';
import {gridSel} from './edit-targets.mjs';
import {dataRange, guessHeader, valueOf, textOf, baseDoc} from './data-common.mjs';

/** The data range around the selection with its headings: {sheet, range, a1, header, heads (per column), rowHeads (per row), startCol, startRow}. */
export function regionInfo(ctx, maxCols = 256, maxRows = 256) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const range = dataRange(ctx, {});
  const engine = engineFor(content);
  const heads = [];
  for (let c = range.start.col; c <= Math.min(range.end.col, range.start.col + maxCols - 1); c++) heads.push(textOf(content, sel.sheet, range.start.row, c, valueOf(engine, sel.sheet, range.start.row, c)).slice(0, 24));
  const rowHeads = [];
  for (let r = range.start.row; r <= Math.min(range.end.row, range.start.row + maxRows - 1); r++) rowHeads.push(textOf(content, sel.sheet, r, range.start.col, valueOf(engine, sel.sheet, r, range.start.col)).slice(0, 24));
  return {sheet: sel.sheet, range, a1: rangeA1(range), header: guessHeader(content, sel.sheet, range, engine), heads, rowHeads,
    startCol: range.start.col, startRow: range.start.row, active: sel.active, activeA1: a1(sel.active.row, sel.active.col), activeCol: colToLetters(sel.active.col)};
}

/** The lists a sort level can follow: the built-in weekdays, months and quarters, then the workbook's own. */
export function sortLists(content) {
  const builtin = [WEEKDAYS.map(d => d.slice(0, 3)), [...WEEKDAYS], MONTHS.map(m => m.slice(0, 3)), [...MONTHS], ['Q1', 'Q2', 'Q3', 'Q4']];
  const custom = Array.isArray(content?.customLists) ? content.customLists : [];
  return [...builtin, ...custom].filter(l => Array.isArray(l) && l.length).map(list => ({label: `${list.slice(0, 4).join(', ')}${list.length > 4 ? '…' : ''}`, list}));
}

/** The A1 text of a selection's areas (`A1:B2,D4`) as a dialog proposes it. */
export function selectionText(ctx) {
  const sel = gridSel(ctx);
  return sel.ranges.map(rangeA1).join(',');
}
