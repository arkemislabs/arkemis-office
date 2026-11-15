// U:prism/points, the pointer part (deckcraft tools/pointer.rs: the Edit Points branch of down, Drag::Vertex,
// Drag::Handle, Ctrl-click delete and add, a click elsewhere leaving, right-click picking a vertex or segment).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {shape, presetGeom, slide as newSlideObj} from '../../core/prism/model/presentation.mjs';
import * as pts from '../../core/prism/lib/points.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';
import points from '../../core/prism/commands/points.mjs';

async function session() {
  const c = createContent('Points pointer');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlideObj({id: 'sb', layout, shapes: [shape({id: 'a', name: 'Rectangle A', xfrm: {x: 100, y: 100, w: 200, h: 100}, geom: presetGeom('rect')})]})];
  const t = await createTestSession('prism', {content: c, modules: [surface, points], prefs: {prism: {snapToGrid: false, smartGuides: false}},
    selection: {ranges: [{anchor: '/sl:sb/sp:a', focus: '/sl:sb/sp:a'}], primary: 0}});
  await t.exec('shape.editPoints', {on: true});
  return t;
}
const ev = (kind, x, y, mods) => ({kind, x, y, ...(mods ? {mods} : {})});
const sh = t => t.content.slides[0].shapes[0];
const verts = t => pts.slideVertices(sh(t), sh(t).xfrm)[0].map(q => [Math.round(q.x), Math.round(q.y)]);
const edit = t => t.doc.view.editPoints;

test('dragging a vertex moves it as one undo step labelled Edit Points, and picks it for its handles', async () => {
  const t = await session();
  const r = await t.exec('surface.pointer', {events: [ev('down', 300, 100), ev('drag', 320, 90), ev('drag', 340, 80), ev('up', 340, 80)], tol: 3});
  assert.equal(r.undoLabel, 'Edit Points');
  assert.deepEqual(verts(t), [[100, 100], [340, 80], [300, 200], [100, 200]]);
  assert.deepEqual(edit(t).vertex, [0, 1]);
  await t.undo();
  assert.deepEqual(verts(t), [[100, 100], [300, 100], [300, 200], [100, 200]]);
});

test('a handle of the chosen point drags and keeps the point smooth', async () => {
  const t = await session();
  await t.exec('shape.pointType', {index: 1, type: 'smooth'});
  const h = pts.slideHandles(sh(t), sh(t).xfrm, 0, 1);
  await t.exec('surface.pointer', {events: [ev('down', h.hout.x, h.hout.y), ev('drag', h.hout.x + 10, h.hout.y + 25), ev('up', h.hout.x + 10, h.hout.y + 25)], tol: 3});
  const segs = pts.parse(sh(t).geom.paths[0].d);
  assert.equal(pts.pointKind(segs, pts.vertices(segs)[1]), 'smooth');
  assert.ok(Math.abs(pts.slideHandles(sh(t), sh(t).xfrm, 0, 1).hout.y - (h.hout.y + 25)) < 1e-6);
});

test('Ctrl-click deletes a vertex or adds one on the outline; a click elsewhere leaves Edit Points', async () => {
  const t = await session();
  await t.exec('surface.pointer', {events: [ev('down', 200, 100, {cmd: true}), ev('up', 200, 100, {cmd: true})], tol: 3});
  assert.equal(verts(t).length, 5);
  await t.exec('surface.pointer', {events: [ev('down', 200, 100, {cmd: true}), ev('up', 200, 100, {cmd: true})], tol: 3});
  assert.equal(verts(t).length, 4);
  await t.exec('surface.pointer', {events: [ev('down', 500, 400), ev('up', 500, 400)], tol: 3});
  assert.equal(edit(t), null);
});

test('right-clicking a vertex or a segment picks it for the menu commands', async () => {
  const t = await session();
  await t.exec('surface.pointer', {events: [ev('contextClick', 300, 200)], tol: 3});
  assert.deepEqual(edit(t).vertex, [0, 2]);
  await t.exec('shape.pointType', {type: 'corner'});
  await t.exec('surface.pointer', {events: [ev('contextClick', 200, 200)], tol: 3});
  assert.equal(edit(t).vertex, null);
  assert.deepEqual(edit(t).segment.slice(0, 2), [0, 3]);
  await t.exec('shape.segmentType', {type: 'curved'});
  assert.equal((await t.exec('shape.points', {})).result.segments[0][3], 'curved');
  await t.exec('shape.addPoint', {});
  assert.equal(verts(t).length, 5);
});
