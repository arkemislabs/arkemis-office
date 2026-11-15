// U:prism/points: Shape Format › Edit Points (deckcraft cmd/points.rs): a preset becomes a freeform, its
// vertices move, split and go, point and segment types change, outlines open and close, and the box
// is fitted around the outline again without moving the drawing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import * as pts from '../../core/prism/lib/points.mjs';

const box = (id, x, y, w, h, preset, extra = {}) => ({id, name: id, xfrm: {x, y, w, h}, kind: {type: 'shape'}, geom: {kind: 'preset', name: preset}, ph: null, fill: null, line: null, effects: null,
  style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null, ...extra});
async function session(shapes = [box('a', 100, 100, 200, 100, 'rect')]) {
  const c = createContent('Points');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlide({id: 's1', layout, shapes})];
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: `/sl:s1/sp:${shapes[0].id}`, focus: `/sl:s1/sp:${shapes[0].id}`}], primary: 0}});
}
const live = t => t.session.get(t.docId).file.content.slides[0].shapes;
const pointsOf = async t => (await t.exec('shape.points', {})).result;

test('path data parses, makes a closing edge explicit and writes back', () => {
  const segs = pts.parse('M 0 0 L 10 0 L 10 10 L 0 10 Z');
  assert.deepEqual(segs.map(s => s.t), ['M', 'L', 'L', 'L', 'L', 'Z']);
  assert.deepEqual(pts.vertices(segs), [0, 1, 2, 3]);
  assert.equal(pts.write(pts.parse('M 0 0 C 1 2 3 4 5 6 Q 1 1 2 2')), 'M 0 0 C 1 2 3 4 5 6 Q 1 1 2 2');
  assert.deepEqual(pts.parse('L 1 1 C 1 1'), [{t: 'M', pts: [{x: 1, y: 1}]}], 'a path starts with a move; malformed commands are skipped');
});

test('shape.editPoints turns a rectangle into a freeform with four points; leaving keeps it; undo takes it back', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'shape.editPoints', {on: true}, r => {
    const sh = (r.content ?? r).slides[0].shapes[0];
    assert.equal(sh.geom.kind, 'custom');
    assert.deepEqual([sh.geom.paths[0].w, sh.geom.paths[0].h], [200, 100]);
  });
  assert.equal(t.state('shape.editPoints', {}).checked, true);
  await t.session.undo(t.docId);
  assert.equal(t.state('shape.editPoints', {}).checked, false, 'undo took the freeform back, so Edit Points is over');
  await t.exec('shape.editPoints', {on: true});
  assert.equal(t.session.get(t.docId).view.editPoints.id, 'a');
  const r = await pointsOf(t);
  assert.deepEqual(r.paths[0].map(q => q.map(Math.round)), [[100, 100], [300, 100], [300, 200], [100, 200]]);
  await t.exec('shape.editPoints', {on: false});
  assert.equal(t.session.get(t.docId).view.editPoints, null);
});

test('shape.movePoint moves a vertex in slide points and refits the box; the others stay where they are', async () => {
  const t = await session();
  await t.exec('shape.editPoints', {on: true});
  await t.exec('shape.movePoint', {index: 2, x: 340, y: 240});
  const x = live(t)[0].xfrm;
  assert.deepEqual([x.x, x.y, x.w, x.h], [100, 100, 240, 140]);
  const r = await pointsOf(t);
  assert.deepEqual(r.paths[0].map(q => q.map(Math.round)), [[100, 100], [300, 100], [340, 240], [100, 200]]);
  await t.exec('shape.movePoint', {index: 0, x: 60, y: 80});
  assert.deepEqual((await pointsOf(t)).paths[0].map(q => q.map(Math.round)), [[60, 80], [300, 100], [340, 240], [100, 200]]);
  const closing = pts.parse(live(t)[0].geom.paths[0].d);
  assert.deepEqual([closing.at(-2).pts[0].x - closing[0].pts[0].x, closing.at(-2).pts[0].y - closing[0].pts[0].y], [0, 0], 'the closing edge follows the start');
});

test('a rotated shape keeps its drawing in place when a point moves', async () => {
  const t = await session([box('a', 100, 100, 200, 100, 'rect', {xfrm: {x: 100, y: 100, w: 200, h: 100, rot: 30}})]);
  await t.exec('shape.editPoints', {on: true});
  const before = (await pointsOf(t)).paths[0];
  await t.exec('shape.movePoint', {index: 1, x: before[1][0] + 30, y: before[1][1] - 10});
  const after = (await pointsOf(t)).paths[0];
  for (const i of [0, 2, 3]) assert.ok(Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1]) < 1e-3, `point ${i} stayed`);
  assert.ok(Math.abs(after[1][0] - before[1][0] - 30) < 1e-3);
});

test('shape.addPoint splits a segment and shape.deletePoint removes a vertex, keeping at least two', async () => {
  const t = await session();
  await t.exec('shape.editPoints', {on: true});
  await t.exec('shape.addPoint', {segment: 1, t: 0.5});
  const r = await pointsOf(t);
  assert.equal(r.paths[0].length, 5);
  assert.deepEqual(r.paths[0][1].map(Math.round), [200, 100]);
  await t.exec('shape.deletePoint', {index: 1});
  assert.equal((await pointsOf(t)).paths[0].length, 4);
  await t.exec('shape.deletePoint', {index: 3});
  await assert.rejects(async () => { await t.exec('shape.deletePoint', {index: 0}); await t.exec('shape.deletePoint', {index: 0}); }, /at least two points/);
});

test('point types: smooth puts the handles in line and equal; a handle drag keeps the type', async () => {
  const t = await session();
  await t.exec('shape.editPoints', {on: true});
  await t.exec('shape.pointType', {index: 1, type: 'smooth'});
  assert.equal((await pointsOf(t)).types[0][1], 'smooth');
  await t.exec('shape.moveHandle', {index: 1, side: 'out', x: 330, y: 160});
  const segs = pts.parse(live(t)[0].geom.paths[0].d);
  assert.equal(pts.pointKind(segs, pts.vertices(segs)[1]), 'smooth');
  await t.exec('shape.pointType', {index: 1, type: 'corner'});
  await t.exec('shape.moveHandle', {index: 1, side: 'in', x: 250, y: 60, type: 'corner'});
  assert.equal(pts.pointKind(pts.parse(live(t)[0].geom.paths[0].d), 1), 'corner');
  await assert.rejects(t.exec('shape.moveHandle', {index: 3, side: 'out', x: 0, y: 0}), /has no handle|no such point/);
});

test('segment types, open and close', async () => {
  const t = await session();
  await t.exec('shape.editPoints', {on: true});
  assert.deepEqual((await pointsOf(t)).segments[0], ['straight', 'straight', 'straight', 'straight']);
  await t.exec('shape.segmentType', {segment: 2, type: 'curved'});
  assert.equal((await pointsOf(t)).segments[0][2], 'curved');
  await t.exec('shape.segmentType', {segment: 2, type: 'straight'});
  assert.equal((await pointsOf(t)).segments[0][2], 'straight');
  await t.exec('shape.openPath', {index: 1});
  const open = pts.parse(live(t)[0].geom.paths[0].d);
  assert.equal(open.at(-1).t, 'L');
  assert.equal(open[0].t, 'M');
  await assert.rejects(t.exec('shape.openPath', {index: 1}), /open already/);
  await t.exec('shape.closePath', {index: 1});
  assert.equal(pts.parse(live(t)[0].geom.paths[0].d).at(-1).t, 'Z');
  await t.exec('shape.deleteSegment', {segment: 2});
  assert.notEqual(pts.parse(live(t)[0].geom.paths[0].d).at(-1).t, 'Z');
});

test('a shape that is a line, locked or in a group has no points to edit', async () => {
  const t = await session([box('a', 100, 100, 200, 100, 'rect', {locked: true})]);
  await assert.rejects(t.exec('shape.editPoints', {on: true}), /locked/);
  const l = await session([box('a', 100, 100, 200, 100, 'line')]);
  await assert.rejects(l.exec('shape.editPoints', {on: true}), /outline/);
});

test('segmentAt finds the outline near a point and vertexAt a vertex', async () => {
  const t = await session();
  await t.exec('shape.editPoints', {on: true});
  const sh = live(t)[0], x = sh.xfrm;
  assert.deepEqual(pts.vertexAt(sh, x, {x: 301, y: 99}, 4), [0, 1]);
  const s = pts.segmentAt(sh, x, {x: 200, y: 101}, 4);
  assert.deepEqual([s.path, s.index], [0, 1]);
  assert.ok(Math.abs(s.t - 0.5) < 0.02);
  assert.equal(pts.segmentAt(sh, x, {x: 200, y: 150}, 4), null);
});
