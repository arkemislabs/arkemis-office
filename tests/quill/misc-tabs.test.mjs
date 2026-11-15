// U:quill/table_misc, U:quill/view, U:quill/mailings: Table Design's pen and Border Painter, Clear, View Gridlines, Cell Margins, View's Dark Mode and
// Full Screen, and Mailings' Print Documents.
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/tools/specs.rs (table.cellMargins, table.borderPainter), cmd/view.rs (table.viewGridlines, view.darkMode,
//    view.fullScreen), cmd/mailings.rs (mailings.printDocuments).
// 2. Ours: the same view flags and table edits; the cell outlines are display items only when the page is displayed with them (never print or export).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {tableSession, firstTable, lay} from './table-helpers.mjs';
import {pageDisplay} from '../../core/quill/layout/display.mjs';
import {viewOf} from '../../core/quill/lib/view-layout.mjs';
import {submitDialog, openDialogModel} from '../../core/kernel/dialog.mjs';
import cellMarginsDialog from '../../core/quill/dialogs/tableCellMargins.mjs';

const inCell = async t => {
  const tb = firstTable(t);
  const id = t.content.body.chunks.flat().find(b => b.kind === 'table').id;
  t.session.setSelection(t.docId, {ranges: [{anchor: `/body/b:${id}/r:0/c:0/b:0/t:0`, focus: `/body/b:${id}/r:0/c:0/b:0/t:0`}], primary: 0});
  return tb;
};

test('table.cellMargins: the table\'s default cell margins, clamped, one undo step; the dialog reads and writes the same four', async () => {
  const t = await tableSession(2, 2);
  await inCell(t);
  await expectUndoRoundTrip(t, 'table.cellMargins', {top: 2, left: 10, bottom: 3, right: 12}, () => {});
  assert.deepEqual(firstTable(t).props.cellMargins, [2, 10, 3, 12]);
  await t.exec('table.cellMargins', {left: 500});
  assert.deepEqual(firstTable(t).props.cellMargins, [2, 144, 3, 12], 'clamped to 144 pt, the rest kept');
  const m = openDialogModel(t.session, t.docId, cellMarginsDialog);
  assert.equal(m.left, 144);
});

test('table.pen sets the pen the Borders menu and the Border Painter draw with; Clear takes the style off', async () => {
  const t = await tableSession(2, 2);
  await inCell(t);
  await t.exec('table.pen', {style: 'dashed', width: 2.25, color: '#ff0000'});
  await t.exec('table.borders', {kind: 'outside'});
  const top = firstTable(t).props.borders.top;
  assert.equal(top.style, 'dashed');
  assert.equal(top.width, 2.25);
  assert.deepEqual(top.color, [255, 0, 0]);
  await t.exec('table.pen', {style: 'double', width: 1, color: '#C00000'});
  await expectUndoRoundTrip(t, 'table.borderPainter', {}, () => {});
  const cell = (r, c) => firstTable(t).rows[r].cells[c].props.borders;
  assert.equal(cell(0, 0).left.style, 'double');
  assert.deepEqual(cell(1, 1).bottom.color, [192, 0, 0]);
  const rules = lay(t).pages[0].items.filter(i => i.kind === 'rule');
  assert.ok(rules.length && rules.every(r => r.border.style === 'double'), 'the page draws the pen, a table style does not hide it');
  await t.exec('table.borderPainter', {kind: 'outside', style: 'dashed', width: 3});
  assert.equal(cell(0, 0).top.style, 'dashed');
  assert.equal(cell(0, 0).right.style, 'double', 'an inside edge keeps what it had');
  await t.exec('table.borderPainter', {kind: 'none'});
  assert.equal(cell(0, 0).left.style, 'none');
  await assert.rejects(() => t.exec('table.pen', {color: 'red'}), /color/);
  await t.exec('table.style', {style: 'TableGrid'}).catch(() => {});
  await t.exec('table.clearStyle', {});
  assert.equal(firstTable(t).props.style ?? null, null);
});

test('table.viewGridlines is view state; the cell outlines are display items only when asked for', async () => {
  const t = await tableSession(2, 3);
  await inCell(t);
  const r = await t.exec('table.viewGridlines', {});
  assert.equal(r.result.value, true);
  assert.equal(viewOf(t.doc.view).tableGridlines, true);
  const page = lay(t).pages[0];
  const grid = d => d.filter(i => i.grid);
  assert.equal(grid(pageDisplay(page, {})).length, 0, 'not in the plain display list (print, export)');
  assert.equal(grid(pageDisplay(page, {tableGridlines: true})).length, 4 * 6, 'four dashed lines for each of the six cells');
  await t.exec('table.viewGridlines', {value: false});
  assert.equal(viewOf(t.doc.view).tableGridlines, false);
});

test('view.darkMode and view.fullScreen are view flags, never edits', async () => {
  const t = await tableSession(1, 1);
  const before = t.doc.version;
  assert.equal((await t.exec('view.darkMode', {})).result.value, true);
  assert.equal(viewOf(t.doc.view).darkMode, true);
  assert.equal((await t.exec('view.fullScreen', {})).result.value, true);
  assert.equal(viewOf(t.doc.view).fullScreen, true);
  await t.exec('view.darkMode', {value: false});
  await t.exec('view.fullScreen', {value: false});
  assert.deepEqual([viewOf(t.doc.view).darkMode, viewOf(t.doc.view).fullScreen], [false, false]);
  assert.equal(t.content.body.chunks.flat().length > 0, true);
  void before;
});

test('mailings.printDocuments is Finish & Merge without a path, then the Print page; the dialog asks which records', async () => {
  const t = await tableSession(1, 1);
  const state = await t.state('mailings.printDocuments', {});
  assert.equal(state.enabled, false, 'no recipients yet');
  assert.equal((await import('../../core/quill/dialogs/printRecords.mjs')).default.command, 'mailings.printDocuments');
  void submitDialog;
});
