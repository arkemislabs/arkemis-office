// U:grid/data: the Sparkline tab: Edit Data, Type, Markers, Sparkline Color and Clear on the sparkline of
// the active cell, each with its undo round trip, and the Edit Sparklines dialog model.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/insert/objects.rs (`insert_sparkline`: one sparkline per cell,
//    replaced by location; kind line|column|winLoss, markers, colour accent 1). Excel: the contextual tab
//    edits the sparkline under the cursor.
// 2. Ours changes those fields of the stored sparkline, one undo step each.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import editSparklines from '../../core/grid/dialogs/editSparklines.mjs';

const sheet = t => t.content.sheets[0];
const book = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {B2: {v: 1}, C2: {v: 4}, D2: {v: 2}, B3: {v: 5}, C3: {v: 3}, D3: {v: 9}}}}]);
const ctxOf = t => t.session.readContext(t.docId);
async function withSparkline() {
  const t = await session(book());
  await run(t, 'insert.sparkline', {range: 'B2:D2', location: 'E2'});
  await run(t, 'selection.set', {cell: 'E2'});
  return t;
}

test('sparkline.type changes the kind of the sparkline in the active cell, and only there', async () => {
  const t = await withSparkline();
  await run(t, 'insert.sparkline', {range: 'B3:D3', location: 'E3', type: 'column'});
  await run(t, 'selection.set', {cell: 'E2'});
  await expectUndoRoundTrip(t, 'sparkline.type', {type: 'winLoss'}, () => {});
  assert.deepEqual(sheet(t).sparklines.map(s => [s.cell, s.kind]), [['E2', 'winLoss'], ['E3', 'column']]);
  const st = await t.state('sparkline.type', {type: 'winLoss'});
  assert.equal(st.checked, true);
  assert.equal((await t.state('sparkline.type', {type: 'line'})).checked, false);
  assert.ok(await fails(t, 'sparkline.type', {type: 'pie'}));
  await run(t, 'selection.set', {cell: 'A1'});
  assert.equal((await t.state('sparkline.type', {type: 'line'})).enabled, false);
  assert.match((await fails(t, 'sparkline.type', {type: 'line'})).message, /sparkline/i);
  // A cell named by `location` works from anywhere.
  await run(t, 'sparkline.type', {type: 'line', location: 'E2'});
  assert.equal(sheet(t).sparklines.find(s => s.cell === 'E2').kind, 'line');
});

test('sparkline.markers and sparkline.color', async () => {
  const t = await withSparkline();
  await expectUndoRoundTrip(t, 'sparkline.markers', {}, () => {});
  assert.equal(sheet(t).sparklines[0].markers, true);
  assert.equal((await t.state('sparkline.markers')).checked, true);
  await run(t, 'sparkline.markers', {on: false});
  assert.equal(sheet(t).sparklines[0].markers, false);
  await expectUndoRoundTrip(t, 'sparkline.color', {color: '#C00000'}, () => {});
  assert.equal(sheet(t).sparklines[0].color, '#C00000');
  assert.equal((await t.state('sparkline.color')).value, '#C00000');
  await run(t, 'sparkline.color', {color: {theme: 6, tint: 0.4}});
  assert.deepEqual(sheet(t).sparklines[0].color, {theme: 6, tint: 0.4});
  await run(t, 'sparkline.color', {color: 'auto'});
  assert.deepEqual(sheet(t).sparklines[0].color, {theme: 4, tint: 0});
  assert.ok(await fails(t, 'sparkline.color', {color: 'not a colour'}));
});

test('sparkline.edit changes the data range and the cell; one sparkline per cell', async () => {
  const t = await withSparkline();
  await run(t, 'insert.sparkline', {range: 'B3:D3', location: 'F2'});
  await run(t, 'selection.set', {cell: 'E2'});
  await expectUndoRoundTrip(t, 'sparkline.edit', {range: 'B3:D3'}, () => {});
  assert.equal(sheet(t).sparklines.find(s => s.cell === 'E2').source, 'B3:D3');
  assert.ok(await fails(t, 'sparkline.edit', {range: 'nonsense'}));
  // Moved onto the cell of another sparkline: that one goes.
  await run(t, 'sparkline.edit', {range: 'B2:D2', newLocation: 'F2'});
  assert.deepEqual(sheet(t).sparklines.map(s => [s.cell, s.source]), [['F2', 'B2:D2']]);
});

test('sparkline.clear removes the sparkline of the active cell', async () => {
  const t = await withSparkline();
  await expectUndoRoundTrip(t, 'sparkline.clear', {}, () => {});
  assert.equal(sheet(t).sparklines, undefined);
  assert.ok(await fails(t, 'sparkline.clear', {}));
});

test('Edit Sparklines dialog: opens on the sparkline, validates, builds sparkline.edit', async () => {
  const t = await withSparkline();
  const v = editSparklines.init(ctxOf(t));
  assert.deepEqual([v.at, v.range, v.location], ['E2', 'B2:D2', 'E2']);
  assert.equal(editSparklines.validate({...v, range: ''}).length, 1);
  assert.equal(editSparklines.validate({...v, location: '??'}).length, 1);
  assert.deepEqual(editSparklines.toCommand({...v, range: '$B$3:$D$3'}), {command: 'sparkline.edit', params: {location: 'E2', range: 'B3:D3'}});
  assert.deepEqual(editSparklines.toCommand({...v, location: '$G$2'}).params, {location: 'E2', range: 'B2:D2', newLocation: 'G2'});
});
