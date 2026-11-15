// U:quill/shapes, Edit Points: Shape Format › Edit Shape › Edit Points on a Word shape (shape.editPoints and the point commands).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft has no Edit Points. The engine is deckcraft crates/engine/src/cmd/points.rs through core/prism/lib/points.mjs
//    (imported, not edited); Word's behaviour: Edit Points turns a shape into a freeform with vertices and handles, a vertex drags,
//    a point is added on a segment and deleted, point types are smooth, straight and corner, a path opens and closes.
//    Not checked against upstream for Word.
// 2. Ours: a freeform path keeps its curves as path data (`d`) next to the flattened points; the box is fitted round the outline
//    again and a floating shape stays where it was on the page; .docx saves the curves as a:cubicBezTo.
// 3. Proof: this file and tests/e2e/quill/shapes.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {quill, blocks} from './format-fixture.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {pageDisplay} from '../../core/quill/layout/display.mjs';
import {wrapAreas} from '../../core/quill/layout/floats.mjs';

async function floating(kind = 'triangle') {
  const q = await quill('Before the shape.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.shape', {kind, width: 100, height: 60});
  await q.exec('arrange.position', {preset: 'topLeft', x: 200, y: 150});
  return q;
}
const shape = q => blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'shape');
const points = async q => (await q.exec('shape.points', {})).result;

test('shape.editPoints turns a triangle into a freeform with three vertices, and toggles off', async () => {
  const q = await floating('triangle');
  assert.equal((await q.state('shape.editPoints', {})).checked, false);
  await q.exec('shape.editPoints', {});
  assert.equal(shape(q).kind, 'freeform');
  assert.ok(shape(q).freeform.paths.every(p => typeof p.d === 'string'));
  assert.equal((await q.state('shape.editPoints', {})).checked, true);
  const p = await points(q);
  assert.equal(p.paths[0].length, 3);
  // The vertices are on the page where the triangle was drawn (200 and 150 from the 72 pt margins): apex at the top middle of its 100 x 60 frame.
  assert.deepEqual(p.paths[0].map(v => v.map(Math.round)), [[272, 282], [322, 222], [372, 282]]);
  await q.exec('shape.editPoints', {on: false});
  assert.equal((await q.state('shape.editPoints', {})).checked, false);
});

test('shape.movePoint moves a vertex on the page; the rest of the outline stays where it was and the box refits', async () => {
  const q = await floating('triangle');
  await q.exec('shape.editPoints', {});
  await q.exec('shape.movePoint', {index: 1, x: 192, y: 172});
  const p = await points(q);
  assert.deepEqual(p.paths[0].map(v => v.map(Math.round)), [[272, 282], [192, 172], [372, 282]]);
  const o = shape(q);
  assert.equal(Math.round(o.w), 180);
  assert.equal(Math.round(o.h), 110);
  assert.equal(Math.round(o.float.x), 120, 'the floating shape moved by what its box did');
  assert.equal(Math.round(o.float.y), 100);
});

test('addPoint, pointType, moveHandle, deletePoint: a smooth point has curved segments with handles', async () => {
  const q = await floating('rectangle');
  await q.exec('shape.editPoints', {});
  assert.equal((await points(q)).paths[0].length, 4);
  await q.exec('shape.addPoint', {segment: 1, t: 0.5});
  assert.equal((await points(q)).paths[0].length, 5);
  const t0 = (await points(q)).types[0];
  await q.exec('shape.pointType', {index: 2, type: 'smooth'});
  assert.equal((await points(q)).types[0][2], 'smooth');
  assert.ok(t0.length === 5);
  await q.exec('shape.segmentType', {segment: 2, type: 'curved'});
  assert.equal((await points(q)).segments[0][2], 'curved');
  await q.exec('shape.moveHandle', {index: 2, side: 'out', x: 330, y: 260});
  assert.ok(shape(q).freeform.paths[0].d.includes('C'), 'a curve keeps its Bézier data');
  await q.exec('shape.deletePoint', {index: 2});
  assert.equal((await points(q)).paths[0].length, 4);
});

test('openPath and closePath, deleteSegment', async () => {
  const q = await floating('rectangle');
  await q.exec('shape.editPoints', {});
  await q.exec('shape.openPath', {index: 0});
  assert.equal(shape(q).freeform.paths[0].closed, false);
  await q.exec('shape.closePath', {index: 0});
  assert.equal(shape(q).freeform.paths[0].closed, true);
  await q.exec('shape.deleteSegment', {segment: 2});
  assert.equal(shape(q).freeform.paths[0].closed, false);
  await assert.rejects(() => q.exec('shape.openPath', {index: 0}), /already/);
});

test('the freeform draws its curves, and Undo takes Edit Points back to the preset shape', async () => {
  const q = await floating('ellipse');
  await q.exec('shape.editPoints', {});
  const p = shape(q).freeform.paths;
  assert.ok(p[0].d.includes('C') || p[0].d.includes('Q'), 'an oval is Bézier curves');
  assert.ok(p[0].pts.length > 8, 'flattened points stay for hit tests');
  const it = pageDisplay(layout(q.t.content, {view: 'print'}).pages[0], {}).find(i => i.freeform);
  assert.ok(it?.freeform.paths[0].d, 'the draw item carries the path data to the painter');
  await q.exec('edit.undo', {});
  assert.equal(shape(q).kind, 'ellipse');
  assert.equal((await q.state('shape.editPoints', {})).checked, false);
});

test('docx: a freeform with curves saves a:cubicBezTo and reads back with its path data', async () => {
  const q = await floating('ellipse');
  await q.exec('shape.editPoints', {});
  await q.exec('shape.movePoint', {index: 0, x: 330, y: 160});
  const bytes = await writeDocx(q.t.content);
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
  assert.match(xml, /<a:cubicBezTo>/);
  const back = await readDocx(bytes);
  const o = back.body.chunks.flat().flatMap(b => b.objects ?? []).find(x => x?.type === 'shape');
  assert.equal(o.kind, 'freeform');
  assert.ok(o.freeform.paths.some(p => /C/.test(p.d ?? '')), 'curves come back as path data');
  assert.ok(o.freeform.paths.every(p => p.pts.length > 2));
});

test('Edit Points leaves text boxes and pictures alone', async () => {
  const q = await quill('A paragraph.');
  q.sel(0, 0);
  await q.exec('insert.textBox', {});
  const st = await q.state('shape.editPoints', {});
  assert.equal(st.enabled, false);
});

test('Tight wrapping follows the outline of an edited freeform', async () => {
  const q = await floating('rectangle');
  await q.exec('shape.editPoints', {});
  // Pull the top right corner in so the outline is a trapezoid, then wrap text tight round it.
  const before = (await points(q)).paths[0];
  const top = before.reduce((a, v, i) => (v[1] < before[a][1] || (v[1] === before[a][1] && v[0] > before[a][0]) ? i : a), 0);
  await q.exec('shape.movePoint', {index: top, x: before[top][0] - 70, y: before[top][1]});
  await q.exec('arrange.wrap', {wrap: 'tight'});
  const o = shape(q);
  const rect = {x: 272, y: 222, w: o.w, h: o.h};
  const areas = wrapAreas(rect, {...o.float, wrap: 'tight'}, o);
  assert.ok(areas.length > 3, 'the exclusion is a stack of bands, not one rectangle');
  const widths = areas.map(a => a.rect.w);
  assert.ok(Math.max(...widths) - Math.min(...widths) > 20, 'the bands are as wide as the outline is at each height');
});

test('view.editPointsPick names the point or segment the point menus act on, only while Edit Points is on', async () => {
  const q = await floating('triangle');
  await assert.rejects(q.exec('view.editPointsPick', {vertex: [0, 1]}), /Edit Points/);
  await q.exec('shape.editPoints', {});
  await q.exec('view.editPointsPick', {vertex: [0, 1]});
  assert.deepEqual(q.t.doc.view.editPoints.vertex, [0, 1]);
  assert.equal(q.t.doc.view.editPoints.segment, null);
  await q.exec('view.editPointsPick', {segment: [0, 2, 0.5]});
  assert.equal(q.t.doc.view.editPoints.vertex, null);
  assert.deepEqual(q.t.doc.view.editPoints.segment, [0, 2, 0.5]);
});
