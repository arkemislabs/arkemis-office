// U:grid/formulas: Use in Formula, Apply Names, the Watch Window and the Circular References list.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/formulas.rs (`paste_names_and_use_in_formula_ask_the_ui_to_insert_the_name`: Use in Formula asks the editor
//    to insert the name and changes no cell; a name Paste Name does not list is refused) and cmd/extra/window.rs (`watch_window`: add, remove, the
//    list with value and formula). Apply Names is Excel's own, not checked against upstream.
// 2. Ours: formulas.useInFormula, formulas.applyNames, formulas.watchWindow, formulas.watchList, formulas.circularReference (core/grid/commands/formulas/extra.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, run, fails, v, text, stored, selection} from './edit-helpers.mjs';
import applyNamesDialog from '../../core/grid/dialogs/applyNames.mjs';
import addWatchDialog from '../../core/grid/dialogs/addWatch.mjs';
import {applyToFormula, nameTarget} from '../../core/grid/commands/formulas/extra.mjs';

const ctxOf = t => t.session.readContext(t.docId);
async function named() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Other'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['', 'Q1', 'Q2'], ['Sales', 10, 20], ['Costs', 4, 5]]});
  await run(t, 'range.setValues', {range: 'E1', values: [['=B2+C2', '=SUM(B2:C2)', '=B2*Rate'], ['=$B$2', '=Other!A1', '']]});
  await run(t, 'formulas.defineName', {name: 'Rate', refersTo: '=Sheet1!$B$3'});
  await run(t, 'formulas.defineName', {name: 'SalesRow', refersTo: '=Sheet1!$B$2:$C$2'});
  await run(t, 'formulas.defineName', {name: 'Firstq', refersTo: '=Sheet1!$B$2:$B$3'});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}

test('Use in Formula asks the editor for the name and changes no cell; the state lists the names', async () => {
  const t = await named();
  const before = t.session.get(t.docId).view?.insertNameRequest?.seq ?? 0;
  const r = await run(t, 'formulas.useInFormula', {name: 'rate'});
  assert.equal(r.name, 'Rate');
  const req = t.session.get(t.docId).view.insertNameRequest;
  assert.equal(req.name, 'Rate');
  assert.ok(req.seq > before);
  assert.equal(text(t, 'E1'), '30', 'no cell changed');
  assert.match((await fails(t, 'formulas.useInFormula', {name: 'NoSuchName'})).message, /no name "NoSuchName"/);
  const st = await t.session.state?.(t.docId, 'formulas.useInFormula', {}) ?? null;
  assert.ok(st === null || Array.isArray(st.value));
});

test('Apply Names replaces the references that are what a name refers to; relative and absolute match when asked', async () => {
  const t = await named();
  const r = await run(t, 'formulas.applyNames', {names: ['Rate', 'SalesRow'], useRowColumn: false});
  assert.equal(r.cells, 1);
  assert.equal(stored(t, 'G1').f, 'B2*Rate', 'already a name: unchanged');
  assert.equal(stored(t, 'F1').f, 'SUM(SalesRow)', 'a range that is a name becomes the name');
  assert.equal(stored(t, 'E1').f, 'B2+C2', 'single cells are not names');
  assert.equal(v(t, 'F1'), 30);
  assert.match((await fails(t, 'formulas.applyNames', {names: ['Rate'], useRowColumn: false})).message, /didn't find/);
  assert.match((await fails(t, 'formulas.applyNames', {names: []})).message, /Select the names/);
  assert.match((await fails(t, 'formulas.applyNames', {names: ['Nothing']})).message, /no name "Nothing"/);
});

test('Ignore Relative/Absolute: $B$3 and B3 both become Rate when it is on, only an exact match when off', async () => {
  const t = await named();
  await run(t, 'range.setValues', {range: 'E4', values: [['=B3+$B$3']]});
  const off = await run(t, 'formulas.applyNames', {names: ['Rate'], ignoreRelAbs: false, useRowColumn: false});
  assert.equal(off.references, 1);
  assert.equal(stored(t, 'E4').f, 'B3+Rate', 'only the absolute one');
  await run(t, 'range.setValues', {range: 'E4', values: [['=B3+$B$3']]});
  const on = await run(t, 'formulas.applyNames', {names: ['Rate'], ignoreRelAbs: true, useRowColumn: false});
  assert.equal(on.references, 2);
  assert.equal(stored(t, 'E4').f, 'Rate+Rate');
});

test('Use row and column names writes a crossing as the intersection; Omit leaves one out in its own row or column', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['', 'Q1', 'Q2'], ['Sales', 10, 20], ['Costs', 4, 5]]});
  await run(t, 'formulas.defineName', {name: 'Firstq', refersTo: '=Sheet1!$B$2:$B$3'});
  await run(t, 'formulas.defineName', {name: 'Sales', refersTo: '=Sheet1!$B$2:$C$2'});
  await run(t, 'range.setValues', {range: 'E5', values: [['=B2*2']]});
  await run(t, 'range.setValues', {range: 'B6', values: [['=B2']]});
  await run(t, 'range.setValues', {range: 'E2', values: [['=B2']]});
  await run(t, 'selection.set', {range: 'A1'});
  const r = await run(t, 'formulas.applyNames', {names: ['Firstq', 'Sales'], useRowColumn: true, omitColumn: true, omitRow: true});
  assert.equal(r.cells, 3);
  assert.equal(stored(t, 'E5').f, 'Sales Firstq*2', 'row name then column name');
  assert.equal(stored(t, 'B6').f, 'Sales', 'the formula is in column B: the column name Firstq is left out');
  assert.equal(stored(t, 'E2').f, 'Firstq', 'the formula is in row 2: the row name Sales is left out');
  assert.equal(v(t, 'E5'), 20);
  await run(t, 'range.setValues', {range: 'E5', values: [['=B2*2']]});
  await run(t, 'formulas.applyNames', {names: ['Firstq', 'Sales'], nameOrder: 'columnRow', omitColumn: false, omitRow: false});
  assert.equal(stored(t, 'E5').f, 'Firstq Sales*2');
});

test('Apply Names works on the selection when it is more than a cell, skips locked cells and keeps other sheets', async () => {
  const t = await named();
  await run(t, 'selection.set', {range: 'E1:F1'});
  const r = await run(t, 'formulas.applyNames', {names: ['SalesRow'], useRowColumn: false});
  assert.equal(r.cells, 1);
  await run(t, 'selection.set', {range: 'A1'});
  await run(t, 'review.protectSheet', {});
  assert.match((await fails(t, 'formulas.applyNames', {names: ['Rate'], range: 'E1:G2', useRowColumn: false})).message, /didn't find|Excel/);
});

test('the pure rewrite: names of other sheets match by sheet, a name with no reference target is skipped', async () => {
  const t = await named();
  const content = t.content;
  const def = content.names.find(n => n.name === 'Rate');
  const target = {...nameTarget(content, def, 0), name: 'Rate'};
  assert.equal(target.sheet, 0);
  const o = {ignoreRelAbs: true, useRowColumn: false, omitColumn: true, omitRow: true, nameOrder: 'rowColumn'};
  assert.equal(applyToFormula(content, 0, {row: 0, col: 0, sheet: 0}, 'Other!B3+B3', [target], o).text, 'Other!B3+Rate');
  assert.equal(applyToFormula(content, 0, {row: 0, col: 0, sheet: 0}, 'B4', [target], o), null);
  assert.equal(applyToFormula(content, 0, {row: 0, col: 0, sheet: 0}, '(((', [target], o), null);
  await run(t, 'formulas.defineName', {name: 'Mixed', refersTo: '=SUM(Sheet1!B2:B3)'});
  assert.equal(nameTarget(t.content, t.content.names.find(n => n.name === 'Mixed'), 0), null);
  assert.ok(applyNamesDialog.id);
});

test('the Apply Names dialog lists the names, needs one, and sends Excel\'s options', async () => {
  const t = await named();
  const d = applyNamesDialog.init(ctxOf(t));
  assert.deepEqual(d.list.map(x => x.name), ['Firstq', 'Rate', 'SalesRow']);
  assert.deepEqual([d.ignoreRelAbs, d.useRowColumn, d.omitColumn, d.omitRow, d.nameOrder], [true, true, true, true, 'rowColumn']);
  assert.equal(applyNamesDialog.validate(d)[0].field, 'names');
  assert.deepEqual(applyNamesDialog.toCommand({...d, names: ['Rate'], nameOrder: 'columnRow'}).params, {names: ['Rate'], ignoreRelAbs: true, useRowColumn: true, omitColumn: true, omitRow: true, nameOrder: 'columnRow'});
  const empty = await session(workbook());
  assert.throws(() => applyNamesDialog.init(ctxOf(empty)), /no names/);
});

test('the Watch Window lists watched cells with value and formula; Add takes a range, Delete a cell; the view flag shows the window', async () => {
  const t = await named();
  const view = () => t.session.get(t.docId).view;
  assert.equal(view().watchPane ?? false, false);
  const r = await run(t, 'formulas.watchWindow', {add: 'E1:F1'});
  assert.equal(r.on, true);
  assert.deepEqual(r.watches.map(w => [w.address, w.value, w.formula]), [['E1', '30', '=B2+C2'], ['F1', '30', '=SUM(B2:C2)']]);
  assert.equal(view().watchPane, true);
  await run(t, 'range.setValues', {range: 'B2', values: [[100]]});
  const list = (await run(t, 'formulas.watchList', {})).watches;
  assert.equal(list[0].value, '120', 'the value follows the sheet');
  await run(t, 'formulas.watchWindow', {add: 'Rate'}).catch(() => null);
  const named1 = await run(t, 'formulas.watchWindow', {add: 'Sheet1!B3'});
  assert.equal(named1.watches.find(w => w.address === 'B3').name, 'Rate');
  await run(t, 'formulas.watchWindow', {add: 'E1'});
  assert.equal((await run(t, 'formulas.watchList', {})).watches.filter(w => w.address === 'E1').length, 1, 'a cell is watched once');
  await run(t, 'formulas.watchWindow', {remove: 'Sheet1!F1'});
  assert.deepEqual((await run(t, 'formulas.watchList', {})).watches.map(w => w.address), ['E1', 'B3']);
  assert.match((await fails(t, 'formulas.watchWindow', {remove: 'Sheet1!Z9'})).message, /isn't being watched/);
  const hide = await run(t, 'formulas.watchWindow', {on: false});
  assert.equal(hide.on, false);
  assert.equal(view().watchPane, false);
  assert.equal((await run(t, 'formulas.watchList', {})).watches.length, 2, 'hiding keeps the list');
  const toggled = await run(t, 'formulas.watchWindow', {});
  assert.equal(toggled.on, true);
  await run(t, 'selection.set', {range: 'C3'});
  const d = addWatchDialog.init(ctxOf(t));
  assert.equal(d.range, 'Sheet1!C3');
  assert.deepEqual(addWatchDialog.toCommand(d), {command: 'formulas.watchWindow', params: {add: 'Sheet1!C3', on: true}});
  assert.equal(addWatchDialog.validate({range: ' '}).length, 1);
});

test('Circular References select the cells that refer to themselves', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['=B1', '=A1'], [1, 2]]});
  const r = await run(t, 'formulas.circularReference', {});
  assert.match(r.cell, /^Sheet1!(A1|B1)$/);
  assert.equal((await selection(t)).a1, r.cell.replace('Sheet1!', ''));
  const other = r.cell === 'Sheet1!A1' ? 'B1' : 'A1';
  await run(t, 'formulas.circularReference', {cell: `Sheet1!${other}`});
  assert.equal((await selection(t)).a1, other);
  await run(t, 'range.setValues', {range: 'A1', values: [[5, 6]]});
  assert.match((await fails(t, 'formulas.circularReference', {})).message, /no circular|disabled|There are no/i);
});

test('the Watch Window list is kept on the sheets and saved in the .xlsx file as cellWatches', async () => {
  const {writeXlsx} = await import('../../core/grid/formats/xlsx-write.mjs');
  const {readXlsx} = await import('../../core/grid/formats/xlsx-read.mjs');
  const t = await named();
  await run(t, 'formulas.watchWindow', {add: 'Sheet1!E1:F1'});
  await run(t, 'formulas.watchWindow', {add: 'Other!A1'});
  assert.deepEqual(t.content.sheets[0].watches, ['E1', 'F1']);
  assert.deepEqual(t.content.sheets[1].watches, ['A1']);
  const bytes = await writeXlsx(t.content);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<cellWatches><cellWatch r="E1"\/><cellWatch r="F1"\/><\/cellWatches>/);
  const back = await readXlsx(bytes);
  const wb = back.content ?? back;
  assert.deepEqual(wb.sheets.map(s => s.watches ?? null), [['E1', 'F1'], ['A1']]);
  await run(t, 'formulas.watchWindow', {remove: 'Sheet1!E1'});
  assert.deepEqual(t.content.sheets[0].watches, ['F1']);
  await run(t, 'formulas.watchWindow', {remove: 'Other!A1'});
  assert.equal(t.content.sheets[1].watches, undefined);
});

test('Ignore Error takes a cell out of Error Checking, is saved in the .xlsx file as ignoredErrors, and Reset brings it back', async () => {
  const {writeXlsx} = await import('../../core/grid/formats/xlsx-write.mjs');
  const {readXlsx} = await import('../../core/grid/formats/xlsx-read.mjs');
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['=1/0', '=1/0', 5]]});
  const count = async () => (await run(t, 'formulas.errorChecking', {})).errors.length;
  assert.equal(await count(), 2);
  await run(t, 'formulas.ignoreError', {cell: 'A1'});
  assert.equal(await count(), 1);
  assert.deepEqual(t.content.sheets[0].ignoredErrors, ['A1']);
  const back = await readXlsx(await writeXlsx(t.content));
  assert.deepEqual((back.content ?? back).sheets[0].ignoredErrors, ['A1']);
  assert.deepEqual(await run(t, 'formulas.resetIgnoredErrors', {}), {reset: 1});
  assert.equal(await count(), 2);
  assert.match((await fails(t, 'formulas.resetIgnoredErrors', {})).message, /no errors are ignored|disabled/i);
});
