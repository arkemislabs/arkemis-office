// U:quill/rest: the table pen modes (Draw Table, Eraser, Border Sampler) and the diagonal borders of Table Design.
//
// Behaviour fidelity: not checked against upstream for the modes, the sampler and the diagonals (wordcraft's table.draw and table.eraser, which the
// modes drive from the page view, are ported in tests/quill/upstream/table_draw_tests.test.mjs); they follow what Word does.
// Proof: this file and tests/e2e/quill/rest.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {tableSession, firstTable, lay, blocks, cellRect} from './table-helpers.mjs';
import {drawModeOf} from '../../core/quill/commands/table_rest.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';

const inCell = async (t, r = 0, c = 0) => {
  const tb = firstTable(t);
  const id = blocks(t).find(b => b.kind === 'table').id;
  t.session.setSelection(t.docId, {ranges: [{anchor: `/body/b:${id}/r:${r}/c:${c}/b:0/t:0`, focus: `/body/b:${id}/r:${r}/c:${c}/b:0/t:0`}], primary: 0});
  return tb;
};

test('table.drawMode: the mode is view state, choosing the one that is on turns it off', async () => {
  const t = await tableSession(2, 2);
  assert.equal(drawModeOf(t.doc.view), null);
  await t.exec('table.drawMode', {mode: 'draw'});
  assert.equal(drawModeOf(t.doc.view), 'draw');
  assert.equal((await t.state('table.drawMode', {mode: 'draw'})).checked, true);
  assert.equal((await t.state('table.drawMode', {mode: 'erase'})).checked, false);
  await t.exec('table.drawMode', {mode: 'erase'});
  assert.equal(drawModeOf(t.doc.view), 'erase');
  await t.exec('table.drawMode', {mode: 'erase'});
  assert.equal(drawModeOf(t.doc.view), null, 'the same mode again turns it off');
  await t.exec('table.drawMode', {mode: 'sample'});
  await t.exec('table.drawMode', {mode: 'off'});
  assert.equal(drawModeOf(t.doc.view), null);
  await assert.rejects(() => t.exec('table.drawMode', {mode: 'paint'}));
});

test('table.borderSample: the border under the point becomes the pen; a point away from any border is refused', async () => {
  const t = await tableSession(2, 2);
  await inCell(t);
  await t.exec('table.pen', {style: 'double', width: 3, color: '#C00000'});
  await t.exec('table.borders', {kind: 'all'});
  await t.exec('table.pen', {style: 'single', width: 0.5, color: null});
  const a = cellRect(t, 0, 0);
  await t.exec('table.drawMode', {mode: 'sample'});
  await t.exec('table.borderSample', {page: 0, x: a.x + a.w, y: a.y + a.h / 2});
  assert.equal(drawModeOf(t.doc.view), null, 'the sampler turns itself off after a pick');
  const pen = t.doc.view.tablePen;
  assert.deepEqual([pen.style, pen.width, pen.color], ['double', 3, '#C00000'], 'the pen the Borders menu drew with is back');
  await assert.rejects(() => t.exec('table.borderSample', {page: 0, x: a.x + a.w / 2, y: a.y + a.h / 2}), /border/);
});

test('table.diagonalBorder: a line corner to corner in each selected cell, toggled, saved as w:tl2br and w:tr2bl', async () => {
  const t = await tableSession(2, 2);
  await inCell(t);
  await t.exec('table.pen', {style: 'single', width: 1.5, color: '#336699'});
  await expectUndoRoundTrip(t, 'table.diagonalBorder', {direction: 'down'}, () => {});
  const diag = () => firstTable(t).rows[0].cells[0].props?.borders ?? {};
  await t.exec('table.diagonalBorder', {direction: 'down', value: true});
  assert.equal(diag().diagDown.width, 1.5);
  assert.deepEqual(diag().diagDown.color, [0x33, 0x66, 0x99]);
  assert.equal((await t.state('table.diagonalBorder', {direction: 'down'})).checked, true);
  assert.equal((await t.state('table.diagonalBorder', {direction: 'up'})).checked, false);
  await t.exec('table.diagonalBorder', {direction: 'up', value: true});
  const lines = lay(t).pages[0].items.filter(i => i.kind === 'rule' && i.x0 !== i.x1 && i.y0 !== i.y1);
  assert.equal(lines.length, 2, 'both diagonals are drawn by the page');
  assert.ok(lines.some(l => l.y1 > l.y0) && lines.some(l => l.y1 < l.y0), 'one down, one up');
  const back = await readDocx(await writeDocx(t.content));
  const cell = back.body.chunks.flat().find(b => b.kind === 'table').rows[0].cells[0];
  assert.equal(cell.props.borders.diagDown.width, 1.5);
  assert.equal(cell.props.borders.diagUp.width, 1.5);
  await t.exec('table.diagonalBorder', {direction: 'down'});
  assert.equal(diag().diagDown, undefined, 'a second use takes it off');
  await t.exec('table.diagonalBorder', {direction: 'up', value: false});
  assert.equal(diag().diagUp, undefined);
});
