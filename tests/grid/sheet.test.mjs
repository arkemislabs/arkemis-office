// U:grid/sheet: undo round trips of every structure and sheet-tab command, view-only sheet switching,
// protection and limits, and the Insert / Delete / Insert Paste / Rename / Move or Copy / Unhide dialogs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/sheet.rs and cmd/sheet/tabs.rs; ui-egui dialogs.rs (Insert, Delete, Insert
//    Paste, Rename Sheet, Move or Copy, Unhide). Excel: Home › Cells › Insert / Delete / Format and
//    the sheet tab menu (Insert, Delete, Rename, Move or Copy, Tab Color, Hide, Unhide).
// 2. Ours: the same commands on schema-2 workbooks, each one undo step; switching sheets is a view
//    change that brings back the sheet's selection; the dialogs submit the same commands.
// 3. This file, tests/grid/upstream/sheet_tests.test.mjs, and tests/e2e/grid/format-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails, stored, v, selection} from './edit-helpers.mjs';
import insertCells from '../../core/grid/dialogs/insertCells.mjs';
import deleteCells from '../../core/grid/dialogs/deleteCells.mjs';
import insertPaste from '../../core/grid/dialogs/insertPaste.mjs';
import renameSheet from '../../core/grid/dialogs/renameSheet.mjs';
import moveSheet, {MOVE_TO_END} from '../../core/grid/dialogs/moveSheet.mjs';
import unhideSheet from '../../core/grid/dialogs/unhideSheet.mjs';
import {changeDialogValues} from '../../core/kernel/dialog.mjs';

const book = () => session(workbook([
  {id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}, A2: {v: 2}, A3: {v: 3}, B1: {f: 'SUM(A1:A3)'}}},
    notes: {A3: {text: 'note'}}, merges: ['C2:D3'], rows: {1: {size: 30}}},
  {id: 's2', name: 'Data', blocks: {0: {A1: {f: 'Sheet1!A3*2'}}}},
]));

const EDITS = [
  ['home.insertRows', {rows: '2:3'}, t => stored(t, 'B1').f === 'SUM(A1:A5)' && t.content.sheets[0].notes.A5 && t.content.sheets[0].merges[0] === 'C4:D5'],
  ['home.insertColumns', {cols: 'A:A'}, t => stored(t, 'C1').f === 'SUM(B1:B3)' && stored(t, 'A1', 1).f === 'Sheet1!B3*2'],
  ['home.deleteRows', {rows: '1:1'}, t => stored(t, 'B1') === null && v(t, 'A1') === 2],
  ['home.deleteColumns', {cols: 'A:A'}, t => stored(t, 'A1').f === 'SUM(#REF!)'],
  ['sheet.moveColumns', {cols: 'A:A', before: 3}, t => stored(t, 'A1').f === 'SUM(C1:C3)' && v(t, 'C1') === 1],
  ['home.insertCells', {range: 'A2', shift: 'down'}, t => stored(t, 'B1').f === 'SUM(A1:A4)' && v(t, 'A3') === 2],
  ['home.insertCells', {range: 'A1:A2', shift: 'right'}, t => v(t, 'B1') === 1 && v(t, 'B2') === 2 && v(t, 'A3') === 3 && stored(t, 'C1').f === 'SUM(A1:A3)'],
  ['home.deleteCells', {range: 'A1', shift: 'up'}, t => v(t, 'A1') === 2 && stored(t, 'B1').f === 'SUM(A1:A2)'],
  ['home.deleteCells', {range: 'A1:A3', shift: 'left'}, t => stored(t, 'A1').f === 'SUM(#REF!)' && stored(t, 'A1', 1).f === '#REF!*2'],
  ['home.insertCells', {range: 'A2', shift: 'row'}, t => v(t, 'A3') === 2],
  ['home.deleteCells', {range: 'A2', shift: 'column'}, t => stored(t, 'A1').f === 'SUM(#REF!)'],
  ['home.insertSheet', {}, t => t.content.sheets[1].name === 'Sheet2' && t.content.activeSheetId === t.content.sheets[1].id],
  ['home.insertSheet', {name: 'Budget', before: 0}, t => t.content.sheets[0].name === 'Budget'],
  ['home.deleteSheet', {sheet: 'Sheet1'}, t => t.content.sheets.length === 1 && stored(t, 'A1', 0).f === '#REF!*2'],
  ['sheet.rename', {sheet: 0, name: 'Totals'}, t => stored(t, 'A1', 1).f === 'Totals!A3*2'],
  ['sheet.move', {sheet: 0, to: 1}, t => t.content.sheets[1].name === 'Sheet1'],
  ['sheet.move', {sheet: 'Data', to: 0, copy: true}, t => t.content.sheets[0].name === 'Data (2)' && t.content.sheets.length === 3],
  ['sheet.tabColor', {sheet: 'Data', color: '#ff0000'}, t => t.content.sheets[1].tabColor === '#FF0000'],
  ['sheet.hide', {sheet: 'Data'}, t => t.content.sheets[1].hidden === 'hidden'],
];

for (const [id, params, check] of EDITS) {
  test(`${id} ${JSON.stringify(params)}: undo round trip`, async () => {
    const t = await book();
    await expectUndoRoundTrip(t, id, params, () => assert.ok(check(t), `${id} did what it should`));
  });
}

test('sheet.unhide, tab colour none, and the last visible sheet', async () => {
  const t = await book();
  await run(t, 'sheet.tabColor', {sheet: 0, color: {theme: 4}});
  assert.match(t.content.sheets[0].tabColor, /^#[0-9A-F]{6}$/);
  await run(t, 'sheet.tabColor', {sheet: 0, color: 'none'});
  assert.equal(t.content.sheets[0].tabColor, undefined);
  assert.equal(t.state('sheet.unhide').enabled, false);
  assert.equal(t.state('sheet.unhide').reason, 'No sheets are hidden.');
  await run(t, 'sheet.hide', {sheet: 'Data'});
  assert.match((await fails(t, 'sheet.hide', {sheet: 'Sheet1'})).message, /at least one visible worksheet/);
  assert.match((await fails(t, 'home.deleteSheet', {sheet: 'Sheet1'})).message, /at least one visible worksheet/);
  await expectUndoRoundTrip(t, 'sheet.unhide', {sheet: 'Data'}, () => assert.equal(t.content.sheets[1].hidden, undefined));
});

test('switching sheets is a view change that brings back each sheet\'s selection', async () => {
  const t = await book();
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/C4'}], primary: 0});
  const depth = t.doc.undo.size;
  await run(t, 'sheet.next', {});
  assert.deepEqual(await selection(t), {a1: 'A1', sheet: 1, anchor: 'A1'});
  await run(t, 'sheet.next', {});
  assert.equal((await selection(t)).sheet, 1, 'no visible sheet further on: stays');
  await run(t, 'sheet.previous', {});
  assert.deepEqual(await selection(t), {a1: 'B2:C4', sheet: 0, anchor: 'B2'});
  await run(t, 'sheet.activate', {sheet: 'Data'});
  assert.equal((await selection(t)).sheet, 1);
  await run(t, 'sheet.activate', {sheet: 's1'});
  assert.equal((await selection(t)).sheet, 0);
  assert.equal(t.doc.undo.size, depth, 'no undo steps');
});

test('names, protection and limits', async () => {
  const t = await book();
  assert.equal((await fails(t, 'home.insertSheet', {name: 'data'})).message, 'That name is already taken. Try a different one.');
  assert.match((await fails(t, 'sheet.rename', {name: 'a/b'})).message, /can't contain/);
  assert.match((await fails(t, 'home.insertRows', {rows: '1048576:1048576', count: 2})).message, /past the end of the worksheet/);
  const p = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}}}, protection: {enabled: true, insertRows: true}}]));
  await run(p, 'home.insertRows', {rows: '1:1'});
  assert.match((await fails(p, 'home.deleteRows', {rows: '2:2'})).message, /protected sheet/);
  assert.match((await fails(p, 'home.insertColumns', {cols: 'A:A'})).message, /protected sheet/);
  const w = await session(workbook([{id: 's1', name: 'Sheet1'}], {protection: {structure: true}}));
  assert.deepEqual(w.state('home.insertSheet'), {enabled: false, reason: 'The workbook is protected and cannot be changed.'});
});

test('Insert / Delete / Insert Paste dialogs', async () => {
  const t = await book();
  const ctx = () => t.session.readContext(t.docId);
  assert.deepEqual(insertCells.init(ctx()), {shift: 'down'});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/row:2', focus: '/sh:s1/row:2'}], primary: 0});
  assert.deepEqual(insertCells.init(ctx()), {shift: 'row'});
  assert.deepEqual(deleteCells.init(ctx()), {shift: 'row'});
  assert.deepEqual(insertCells.toCommand({shift: 'right'}), {command: 'home.insertCells', params: {shift: 'right'}});
  assert.deepEqual(deleteCells.toCommand({shift: 'left'}), {command: 'home.deleteCells', params: {shift: 'left'}});
  assert.deepEqual(insertPaste.toCommand({shift: 'right'}), {command: 'home.insertCopiedCells', params: {shift: 'right'}});
  assert.equal(insertCells.validate({shift: 'up'}).length, 1);
});

test('Rename / Move or Copy / Unhide dialogs', async () => {
  const t = await book();
  const ctx = () => t.session.readContext(t.docId);
  const r = renameSheet.init(ctx());
  assert.equal(r.name, 'Sheet1');
  assert.equal(renameSheet.validate({...r, name: 'data'})[0].message, 'That name is already taken. Try a different one.');
  const rc = renameSheet.toCommand({...r, name: ' Totals '});
  await t.exec(rc.command, rc.params);
  assert.equal(t.content.sheets[0].name, 'Totals');
  let m = moveSheet.init(ctx());
  assert.equal(m.beforeSheet, 'Data');
  m = changeDialogValues(moveSheet, m, 'beforeSheet', MOVE_TO_END);
  const mc = moveSheet.toCommand(m);
  assert.deepEqual(mc.params.to, 1);
  await t.exec(mc.command, mc.params);
  assert.deepEqual(t.content.sheets.map(x => x.name), ['Data', 'Totals']);
  const copy = moveSheet.toCommand({...moveSheet.init(ctx()), beforeSheet: 'Data', copy: true});
  await t.exec(copy.command, copy.params);
  assert.equal(t.content.sheets[0].name, 'Totals (2)');
  await run(t, 'sheet.hide', {sheet: 'Data'});
  const u = unhideSheet.init(ctx());
  assert.deepEqual(u, {hiddenSheets: ['Data'], sheet: 'Data'});
  const uc = unhideSheet.toCommand(u);
  await t.exec(uc.command, uc.params);
  assert.equal(t.content.sheets[1].hidden, undefined);
});
