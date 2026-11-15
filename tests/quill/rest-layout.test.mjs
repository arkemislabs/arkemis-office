// U:quill/rest: Edit Wrap Points, Set as Default Layout and Grid Settings.
//
// Behaviour fidelity: not checked against upstream (wordcraft keeps and reads a wrap polygon and the drawing grid, crates/doc wrap.rs, but has no way to
// edit either); these follow what Word does, as the spec notes say.
// Proof: this file and tests/e2e/quill/rest.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {viewOf} from '../../core/quill/lib/view-layout.mjs';
import {openDialogModel, submitDialog} from '../../core/kernel/dialog.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';

const dialogs = (await import('../../core/generated/quill.dialogs.mjs')).dialogs;
const objectOf = (q, type) => { for (const b of blocks(q.t)) for (const o of b.objects ?? []) if (o.type === type) return o; return null; };
async function withShape(kind = 'ellipse') {
  const q = await quill('Before the shape.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.shape', {kind, width: 100, height: 50});
  return q;
}

test('Edit Wrap Points: the first use makes the wrapping Tight with a polygon of the outline; points move, are added and deleted', async () => {
  const q = await withShape('ellipse');
  assert.equal((objectOf(q, 'shape').float.wrap ?? 'inline'), 'inline');
  await expectUndoRoundTrip(q.t, 'arrange.editWrapPoints', {}, () => {});
  const o = objectOf(q, 'shape');
  assert.equal(o.float.wrap, 'tight');
  assert.ok(o.float.wrapPolygon.edited && o.float.wrapPolygon.points.length >= 8, 'an oval has many points');
  assert.equal(viewOf(q.t.doc.view).wrapPoints, true);
  const n = o.float.wrapPolygon.points.length;
  await q.exec('wrap.movePoint', {index: 0, x: 0.5, y: -0.25});
  assert.deepEqual(objectOf(q, 'shape').float.wrapPolygon.points[0], [10800, -5400]);
  await q.exec('wrap.addPoint', {index: 0});
  assert.equal(objectOf(q, 'shape').float.wrapPolygon.points.length, n + 1);
  await q.exec('wrap.deletePoint', {index: 1});
  assert.equal(objectOf(q, 'shape').float.wrapPolygon.points.length, n);
  await assert.rejects(() => q.exec('wrap.movePoint', {index: 999, x: 0, y: 0}), /point/);
  await q.exec('wrap.reset', {});
  assert.equal(objectOf(q, 'shape').float.wrapPolygon, undefined);
  await q.exec('arrange.editWrapPoints', {value: false});
  assert.equal(viewOf(q.t.doc.view).wrapPoints, false);
});

test('Edit Wrap Points: a polygon keeps at least three points and the edited polygon is saved in the .docx', async () => {
  const q = await withShape('triangle');
  await q.exec('arrange.editWrapPoints', {value: true});
  const count = () => objectOf(q, 'shape').float.wrapPolygon.points.length;
  while (count() > 3) await q.exec('wrap.deletePoint', {index: 0});
  await assert.rejects(() => q.exec('wrap.deletePoint', {index: 0}), /three/);
  await q.exec('wrap.movePoint', {index: 1, x: 0.9, y: 0.1});
  const back = await readDocx(await writeDocx(q.t.content));
  const s = back.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'shape');
  assert.equal(s.float.wrap, 'tight');
  assert.equal(s.float.wrapPolygon.edited, true);
  assert.equal(s.float.wrapPolygon.points.length, 3);
  assert.deepEqual(s.float.wrapPolygon.points[1], [19440, 2160]);
});

test('Set as Default Layout: later pictures, shapes, text boxes and canvases start with the wrapping', async () => {
  const q = await withShape('rectangle');
  await q.exec('arrange.wrap', {wrap: 'square'});
  await q.exec('arrange.wrapText', {side: 'left'});
  const saved = (await q.exec('arrange.setDefaultLayout', {})).result.layout;
  assert.equal(saved.wrap, 'square');
  assert.equal(saved.wrapText, 'left');
  q.sel(1, 0);
  await q.exec('insert.textBox', {});
  const box = blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'shape' && o.kind === 'textBox');
  assert.equal(box.float.wrap, 'square');
  assert.equal(box.float.wrapText, 'left');
  q.sel(1, 0);
  await q.exec('insert.shape', {kind: 'diamond', width: 40, height: 40});
  const diamond = blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'shape' && o.kind === 'diamond');
  assert.equal(diamond.float.wrap, 'square', 'a shape too');
});

test('Grid Settings: spacing is saved with the document, gridlines are view state, the dialog reads and writes both', async () => {
  const q = await quill('Text');
  await expectUndoRoundTrip(q.t, 'layout.gridSettings', {gridH: 12, gridV: 18}, () => {});
  assert.equal(q.t.content.settings.gridH, 12);
  assert.equal(q.t.content.settings.gridV, 18);
  await q.exec('layout.gridSettings', {gridlines: true});
  assert.equal(viewOf(q.t.doc.view).gridlines, true);
  const m = openDialogModel(q.t.session, q.t.docId, dialogs['dialog.gridSettings']);
  assert.deepEqual([m.gridH, m.gridV, m.gridlines], [12, 18, true]);
  await submitDialog(q.t.session, q.t.docId, dialogs['dialog.gridSettings'], {gridH: 6, gridV: 6, gridlines: false});
  assert.equal(q.t.content.settings.gridH, 6);
  assert.equal(viewOf(q.t.doc.view).gridlines, false);
  await assert.rejects(() => q.exec('layout.gridSettings', {gridH: 0}), /points/);
});

test('Chart Format: Select Data, Align to Page and More Layout Options work on a chart like the other objects', async () => {
  const q = await quill('Before the chart.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.chart', {type: 'column'});
  const chart = () => blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'graphic');
  assert.ok(chart(), 'a chart');
  q.sel(0, 6, 7);
  assert.equal((await q.state('chart.editData')).enabled, true, 'Select Data runs the chart data grid');
  await q.exec('arrange.alignTo', {to: 'page'});
  await q.exec('arrange.align', {value: 'right'});
  assert.equal(chart().float.hRel, 'page');
  const m = openDialogModel(q.t.session, q.t.docId, dialogs['dialog.pictureSize']);
  assert.ok(m.width > 0, 'the Layout box reads the chart');
});
