// Helpers for U:grid/edit tests: a schema-2 workbook session, cell values and shown text, styles.
// Not a test file (no .test suffix).

import {createTestSession} from '../../core/kernel/testing.mjs';
import {parseCell, parseRange} from '../../core/grid/lib/addr.mjs';
import {engineFor} from '../../core/grid/model/calc.mjs';
import {cellAt} from '../../core/grid/model/store.mjs';
import {styleAt} from '../../core/grid/model/workbook.mjs';
import {displayAt} from '../../core/grid/model/index.mjs';
import {CellError} from '../../core/grid/lib/value.mjs';

/** A blank workbook: Sheet1 (s1), or the sheets given ({id, name, blocks?, ...}). */
export function workbook(sheets = [{id: 's1', name: 'Sheet1'}], extra = {}) {
  const list = sheets.map(sh => ({blocks: {}, ...sh}));
  return {sheets: list, activeSheetId: list[0].id, styles: [{}], names: [], ...extra};
}

/** A test session over a workbook (gridcraft `Session::new` + `new_workbook`). */
export async function session(content = workbook(), opts = {}) {
  const t = await createTestSession('grid', {content, ...opts});
  return t;
}

const at = (ref) => {
  const m = /^(?:([^!]+)!)?(.+)$/.exec(ref);
  return {sheetName: m[1] ?? null, cell: parseCell(m[2])};
};
const sheetOf = (t, name) => (name ? t.content.sheets.findIndex(s => s.name === name) : t.content.sheets.findIndex(s => s.id === (t.content.activeSheetId)));

/** The value a cell shows (number, string, boolean, CellError or null); `Sheet2!B3` names another sheet. */
export function v(t, ref, si) {
  const {sheetName, cell} = at(ref);
  const s = si ?? (sheetName ? sheetOf(t, sheetName) : 0);
  return engineFor(t.content).sheetValue(s, cell.row, cell.col);
}
/** The text a cell shows (number format applied). */
export function text(t, ref, si = 0) {
  const {cell} = at(ref);
  return displayAt(t.content, si, cell.row, cell.col).text;
}
/** The stored cell ({v?, f?, s?, a?}) or null. */
export function stored(t, ref, si = 0) {
  const {cell} = at(ref);
  return cellAt(t.content.sheets[si], cell.row, cell.col);
}
/** The resolved style of a cell. */
export function style(t, ref, si = 0) {
  const {cell} = at(ref);
  return styleAt(t.content, t.content.sheets[si], cell.row, cell.col);
}
/** The error text of an error value, else null. */
export const errorOf = x => (x instanceof CellError ? x.text : null);

/** Runs a command, returns its result (throws its CommandError). */
export async function run(t, id, params = {}) {
  return (await t.exec(id, params)).result;
}
/** Runs a command that must fail; returns the error. */
export async function fails(t, id, params = {}) {
  try { await t.exec(id, params); } catch (e) { return e; }
  throw new Error(`${id} ${JSON.stringify(params)} should have failed`);
}

/** The current selection as A1 text (`A1:B2,D4`) and the active cell. */
export async function selection(t) {
  const {fromKernelSelection} = await import('../../core/grid/model/workbook.mjs');
  const {rangeA1, a1} = await import('../../core/grid/lib/addr.mjs');
  const sel = fromKernelSelection(t.content, t.doc.selection);
  return {a1: sel.ranges.map(rangeA1).join(','), sheet: sel.sheet, anchor: a1(sel.anchor.row, sel.anchor.col)};
}

export {parseRange};
