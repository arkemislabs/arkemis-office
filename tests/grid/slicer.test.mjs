// U:grid/slicer: Insert Slicer, Table Design > Insert Slicer and the Slicer tab commands.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/slicer.rs at fb1e59f (a slicer over a table column, tiles from the distinct values,
//    a click shows one value and a second click on the sole shown value clears it, multi adds and removes, everything selected is no
//    filter, the filter is the sheet AutoFilter over the table, delete clears the filter it set).
// 2. Ours: the same commands over sheet.slicers[] and our AutoFilter model.
// 3. These tests; tests/e2e/grid/pivot.e2e.mjs draws the slicer and clicks its tiles.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, run, fails} from './edit-helpers.mjs';

async function book() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['Region', 'Sales'], ['East', 10], ['West', 20], ['East', 30], ['North', 40]]});
  await run(t, 'insert.table', {range: 'A1:B5', header: true});
  await run(t, 'selection.set', {range: 'A2'});
  return t;
}
const hidden = t => Object.keys(t.content.sheets[0].rows ?? {}).filter(r => t.content.sheets[0].rows[r].hidden).map(Number).sort((a, b) => a - b);
const items = async t => (await run(t, 'slicer.list', {}))[0].items;

test('insert slicer: tiles from the distinct values, no filter, placed beside the table', async () => {
  const t = await book();
  const r = await run(t, 'insert.slicer', {});
  const sl = t.content.sheets[0].slicers[0];
  assert.deepEqual([sl.id, sl.table, sl.column, sl.caption, sl.selected, sl.columns], [r.slicer, 'Table1', 'Region', 'Region', null, 1]);
  assert.equal(sl.anchor.cell, 'D1');
  assert.deepEqual((await items(t)).map(x => [x.value, x.on]), [['East', true], ['West', true], ['North', true]]);
  assert.deepEqual(hidden(t), []);
  await fails(t, 'insert.slicer', {table: 'Nope'});
  await fails(t, 'insert.slicer', {column: 'Nope'});
});

test('a click shows one value; clicking it again, or Select All, shows everything', async () => {
  const t = await book();
  await run(t, 'insert.slicer', {});
  await run(t, 'slicer.toggle', {value: 'East'});
  assert.deepEqual(t.content.sheets[0].slicers[0].selected, ['East']);
  assert.deepEqual(hidden(t), [2, 4], 'West and North rows are hidden');
  assert.deepEqual((await items(t)).map(x => x.on), [true, false, false]);
  await run(t, 'slicer.toggle', {value: 'east'});
  assert.equal(t.content.sheets[0].slicers[0].selected, null);
  assert.deepEqual(hidden(t), []);
  await run(t, 'slicer.toggle', {value: 'West'});
  await run(t, 'slicer.selectAll', {});
  assert.deepEqual(hidden(t), []);
  await fails(t, 'slicer.toggle', {value: 'South'});
});

test('multi adds and removes values; every value selected is the same as no filter', async () => {
  const t = await book();
  await run(t, 'insert.slicer', {});
  await run(t, 'slicer.toggle', {value: 'North', multi: true});
  assert.deepEqual(t.content.sheets[0].slicers[0].selected, ['East', 'West']);
  assert.deepEqual(hidden(t), [4]);
  await run(t, 'slicer.toggle', {value: 'North', multi: true});
  assert.equal(t.content.sheets[0].slicers[0].selected, null);
  assert.deepEqual(hidden(t), []);
});

test('delete clears the filter it set; the Slicer tab settings change caption, columns and size', async () => {
  const t = await book();
  const {slicer} = await run(t, 'insert.slicer', {column: 'Sales'});
  await run(t, 'slicer.toggle', {slicer, value: '10'});
  assert.deepEqual(hidden(t), [2, 3, 4]);
  await run(t, 'slicer.set', {slicer, caption: 'Amounts', columns: 2});
  await run(t, 'slicer.height', {height: 150});
  await run(t, 'slicer.width', {width: 90});
  const sl = t.content.sheets[0].slicers[0];
  assert.deepEqual([sl.caption, sl.columns, sl.anchor.height, sl.anchor.width], ['Amounts', 2, 200, 120]);
  assert.equal((await t.state('slicer.columns')).value, 2);
  await run(t, 'slicer.delete', {slicer});
  assert.equal(t.content.sheets[0].slicers, undefined);
  assert.deepEqual(hidden(t), []);
});

test('several columns at once make one slicer each, and a protected sheet refuses', async () => {
  const t = await book();
  const r = await run(t, 'insert.slicer', {column: ['Region', 'Sales']});
  assert.equal(r.slicers.length, 2);
  assert.notEqual(t.content.sheets[0].slicers[0].anchor.dx, t.content.sheets[0].slicers[1].anchor.dx);
  await run(t, 'review.protectSheet', {});
  await fails(t, 'insert.slicer', {column: 'Region'});
  await fails(t, 'slicer.toggle', {value: 'East'});
});

test('Table Design > Insert Slicer and Clear Filter: the same slicer, and Clear Filter shows every row again', async () => {
  const t = await book();
  const {slicer} = await run(t, 'table.insertSlicer', {table: 'Table1', column: 'Region'});
  assert.equal(t.content.sheets[0].slicers[0].column, 'Region');
  await run(t, 'slicer.toggle', {slicer, value: 'West'});
  assert.deepEqual(hidden(t), [1, 3, 4]);
  await run(t, 'slicer.clear', {slicer});
  assert.equal(t.content.sheets[0].slicers[0].selected, null);
  assert.deepEqual(hidden(t), []);
});

test('slicer.caption: the box of the Slicer tab shows the caption and sets it, one undo step', async () => {
  const t = await book();
  await run(t, 'insert.slicer', {});
  assert.equal((await t.state('slicer.caption')).value, 'Region');
  const {expectUndoRoundTrip} = await import('../../core/kernel/testing.mjs');
  await expectUndoRoundTrip(t, 'slicer.caption', {caption: 'Pick a region'}, () => {});
  assert.equal(t.content.sheets[0].slicers[0].caption, 'Pick a region');
  assert.equal((await t.state('slicer.caption')).value, 'Pick a region');
  await fails(t, 'slicer.caption', {caption: ''});
});
