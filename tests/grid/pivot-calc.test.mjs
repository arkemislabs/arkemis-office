// U:grid/pivot: PivotTable Analyze > Calculated Field, Move PivotTable and Select, and the dialogs behind them.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/pivot/tests.rs at 146161b4 (`calculated_field_on_sums`, `calculated_field_errors`). Move PivotTable and
//    Select are not in gridcraft: Excel's behaviour, not checked against upstream.
// 2. Ours: pivot.calculatedField, pivot.move, pivot.select (core/grid/commands/pivot/calc.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {CellError} from '../../core/grid/lib/value.mjs';
import {session, workbook, run, fails, v, text, selection} from './edit-helpers.mjs';
import movePivotTable from '../../core/grid/dialogs/movePivotTable.mjs';
import calcDialog, {fieldText, formulaProblem} from '../../core/grid/dialogs/pivotCalculatedField.mjs';

const SALES = [
  ['Region', 'Product', 'Date', 'Units', 'Sales'],
  ['East', 'Apples', '1/15/2026', 10, 100], ['West', 'Apples', '2/10/2026', 5, 50], ['East', 'Pears', '3/3/2026', 8, 120],
  ['North', 'Pears', '4/20/2026', 2, 30], ['West', 'Plums', '5/5/2026', 7, 70], ['East', 'Plums', '6/30/2026', 4, 60],
  ['North', 'Apples', '7/4/2026', 9, 90], ['West', 'Pears', '8/8/2026', 3, 45], ['East', 'Apples', '9/9/2026', 6, 60],
  ['North', 'Plums', '10/10/2026', 1, 15], ['West', 'Apples', '11/11/2026', 12, 120], ['East', 'Pears', '12/12/2026', 5, 75],
];
const TOTAL = 835;

async function sales() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: SALES});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}
const report = t => t.content.sheets.findIndex(s => (s.pivots ?? []).length);
const pt = t => { const sh = t.content.sheets[report(t)]; return sh.pivots[sh.pivots.length - 1]; };
const V = (t, ref) => v(t, ref, report(t));
const T = (t, ref) => text(t, ref, report(t));
const ctxOf = t => t.session.readContext(t.docId);

test('calculated fields work on the sums of each report cell; change, delete, the field list', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const r = await run(t, 'pivot.calculatedField', {name: 'Price', formula: 'Sales / Units'});
  assert.equal(r.formula, '=Sales / Units');
  assert.equal(T(t, 'C3'), 'Sum of Price');
  assert.equal(T(t, 'A4'), 'East');
  assert.ok(Math.abs(V(t, 'C4') - 415 / 33) < 1e-12);
  assert.equal(T(t, 'A7'), 'Grand Total');
  assert.ok(Math.abs(V(t, 'C7') - TOTAL / 72) < 1e-12, 'the grand total applies the formula to the totals');
  await run(t, 'pivot.calculatedField', {name: 'Rounded', formula: "=ROUND('Price'*2,1)"});
  assert.equal(V(t, 'D4'), 25.2);
  await run(t, 'pivot.calculatedField', {name: 'Zero', formula: '=Sales/(Units-Units)'});
  assert.ok(V(t, 'E4') instanceof CellError && V(t, 'E4').text === '#DIV/0!');
  await run(t, 'pivot.calculatedField', {name: 'zero', formula: '=Units*2'});
  assert.equal(V(t, 'E4'), 66);
  await run(t, 'pivot.calculatedField', {name: 'Zero', delete: true});
  assert.equal(pt(t).values.length, 3);
  assert.equal(pt(t).calculatedFields.length, 2);
  const f = await run(t, 'pivot.fields', {});
  assert.ok(f.fields.some(x => x.name === 'Price' && x.calculated === true));
  // Calculated fields go to the cache and come back from an .xlsx file.
  const back = await readXlsx(await writeXlsx(t.content));
  const wb = back.content ?? back;
  const p2 = wb.sheets.flatMap(s => s.pivots ?? [])[0];
  assert.deepEqual(p2.calculatedFields.map(c => [c.name, c.formula]), [['Price', '=Sales / Units'], ['Rounded', "=ROUND('Price'*2,1)"]]);
  assert.ok(p2.values.some(x => x.sourceCol === 'Price'));
});

test('calculated field errors: unknown names, cells, syntax, taken names, cycles, only in Values', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const e = async p => (await fails(t, 'pivot.calculatedField', p)).message;
  assert.match(await e({name: 'Bad', formula: '=Sales*Bogus'}), /Bogus/);
  assert.match(await e({name: 'Bad', formula: '=A1*2'}), /cells/);
  assert.match(await e({name: 'Bad', formula: '=Sales*('}), /error/);
  assert.match(await e({name: 'Sales', formula: '=1'}), /already exists/);
  assert.match(await e({name: 'Bad'}), /formula/);
  assert.match(await e({name: 'Gone', delete: true}), /Gone/);
  await run(t, 'pivot.calculatedField', {name: 'X', formula: '=Sales'});
  await run(t, 'pivot.calculatedField', {name: 'Y', formula: '=X*2'});
  assert.match(await e({name: 'X', formula: '=Y'}), /itself/);
  await fails(t, 'pivot.addField', {field: 'Y', area: 'rows'});
  assert.equal(pt(t).calculatedFields.length, 2);
});

test('Move PivotTable to another cell or sheet; Select the whole report, its labels or its values', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const d = movePivotTable.init(ctxOf(t));
  assert.deepEqual([d.pivot, d.destination, d.location], ['PivotTable1', 'existing', "'Sheet2'!$A$3"]);
  assert.equal(movePivotTable.validate({...d, location: 'nowhere'}).length, 1);
  assert.deepEqual(movePivotTable.toCommand({...d, location: 'Sheet2!$D$10'}), {command: 'pivot.move', params: {pivot: 'PivotTable1', to: 'Sheet2!$D$10'}});
  await run(t, 'pivot.move', {to: 'D10'});
  assert.equal(pt(t).anchor, 'D10');
  assert.equal(T(t, 'D11'), 'East');
  assert.equal(V(t, 'A4'), null, 'the old report is cleared');
  await run(t, 'pivot.move', {to: 'Sheet1!H3'});
  assert.equal(t.content.sheets[report(t)].name, 'Sheet1');
  assert.equal(text(t, 'H4', report(t)), 'East');
  await run(t, 'pivot.select', {part: 'entire'});
  assert.equal((await selection(t)).a1, 'H3:I7');
  await run(t, 'pivot.select', {part: 'values'});
  assert.equal((await selection(t)).a1, 'I4:I7');
  await run(t, 'pivot.select', {part: 'labels'});
  assert.equal((await selection(t)).a1, 'H3:I7');
});

test('Insert Calculated Field dialog: a free FieldN name, field text, problems, the command', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const d = calcDialog.init(ctxOf(t));
  assert.deepEqual([d.pivot, d.name, d.formula], ['PivotTable1', 'Field1', '= 0']);
  assert.deepEqual(d.fields, ['Region', 'Product', 'Date', 'Units', 'Sales']);
  assert.equal(fieldText('Sales'), 'Sales');
  assert.equal(fieldText('Unit Price'), "'Unit Price'");
  assert.equal(formulaProblem('=Sales*2', d.fields, [], 'X'), null);
  assert.match(formulaProblem('=Bogus', d.fields, [], 'X'), /Bogus/);
  assert.equal(calcDialog.validate({...d, name: 'Sales'})[0].field, 'name');
  assert.deepEqual(calcDialog.toCommand({...d, name: ' Tax ', formula: '=Sales*0.1'}), {command: 'pivot.calculatedField', params: {pivot: 'PivotTable1', name: 'Tax', formula: '=Sales*0.1'}});
  await run(t, 'pivot.calculatedField', {name: 'Tax', formula: '=Sales*0.1'});
  const again = calcDialog.init(ctxOf(t));
  assert.deepEqual(again.calculated, [{name: 'Tax', formula: '=Sales*0.1'}]);
  assert.deepEqual(calcDialog.derive({...again, name: 'tax'}, ['name']), {formula: '=Sales*0.1'});
});
