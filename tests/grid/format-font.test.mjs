// U:grid/format on schema-1 workbooks (the legacy editor's cells, `sheets[i].cells[A1] = {value, bold?, ...}`):
// the format commands still style them through their inline props until Grid's gate migrates them.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: format.rs `toggle`/`underline`/`apply_style` read the active cell and style every
//    targeted cell; Excel's Bold/Italic/Underline/Strikethrough do the same.
// 2. Ours: the same toggles write the legacy props (bold, italic, underline, strike, fill, ...), so the
//    old editor shows them; schema-2 workbooks are covered by tests/grid/format.test.mjs.
// 3. This file (engine); the schema-2 flow has the bridge E2E tests/e2e/grid/format-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createFile, validateFile} from '../../core/model.mjs';

async function session(cells = {}) {
  const file = createFile('grid', 'Font test');
  file.id = 'doc1';
  const sh = file.content.sheets[0];
  sh.id = 's1';
  file.content.activeSheetId = 's1';
  sh.cells = cells;
  file.content.sheets.push({id: 's2', name: 'Data sheet', cells: {}, rows: 50, columns: 10});
  return createTestSession('grid', {file});
}
const cells = t => t.content.sheets[0].cells;

test('home.bold on a legacy range: undo round trip, canonical ranges, the file stays valid', async () => {
  const t = await session({A1: {value: 'Name'}, B1: {value: 'Total', italic: true}});
  const r = await expectUndoRoundTrip(t, 'home.bold', {range: '/sh:s1/A1:C1'}, after => {
    assert.equal(after.read('/sheets/0/cells/A1').bold, true);
    assert.deepEqual(after.read('/sheets/0/cells/C1'), {value: '', bold: true});
  });
  assert.deepEqual(r.result, {on: true, ranges: ['/sh:s1/A1:C1']});
  assert.deepEqual(cells(t).B1, {value: 'Total', italic: true, bold: true});
  validateFile(t.file);
});

test('toggling reads the active cell, and clearing removes cells that only held the style', async () => {
  const t = await session({A1: {value: 'x', bold: true}});
  await t.exec('home.bold', {range: 'A1:B2'});
  assert.deepEqual(cells(t), {A1: {value: 'x'}});
  await t.exec('home.bold', {range: 'A1:B2'});
  assert.equal(Object.keys(cells(t)).length, 4);
  await t.exec('home.bold', {range: 'A1:B2', on: false});
  assert.deepEqual(cells(t), {A1: {value: 'x'}});
});

test('the selection is the default target and the active cell drives the ribbon state', async () => {
  const t = await session({B2: {value: '7'}});
  assert.deepEqual(t.state('home.italic'), {enabled: true, checked: false});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/C3'}], primary: 0});
  await expectUndoRoundTrip(t, 'home.italic', {});
  assert.equal(cells(t).B2.italic, true);
  assert.equal(cells(t).C3.italic, true);
  assert.deepEqual(t.state('home.italic'), {enabled: true, checked: true});
});

test('home.underline: styles, toggling against the active style, none clears; fill and alignment map to legacy props', async () => {
  const t = await session({A1: {value: 'a'}});
  await expectUndoRoundTrip(t, 'home.underline', {range: 'A1', style: 'double'});
  assert.equal(cells(t).A1.underline, 'double');
  assert.deepEqual(t.state('home.underline', {}), {enabled: true, checked: true, value: 'double'});
  await t.exec('home.underline', {range: 'A1', style: 'double'});
  assert.equal(cells(t).A1.underline, undefined);
  await t.exec('home.fillColor', {range: 'A1', color: '#FFFF00'});
  await t.exec('home.alignCenter', {range: 'A1'});
  assert.deepEqual(cells(t).A1, {value: 'a', background: '#FFFF00', align: 'center'});
});
