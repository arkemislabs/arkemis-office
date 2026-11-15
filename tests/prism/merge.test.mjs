// U:prism/merge: Shape Format › Merge Shapes (deckcraft cmd/merge.rs). The boolean areas of two squares,
// the fragments, and the command on real shapes (first shape's formatting, undo).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {mergeAreas, ringArea} from '../../core/prism/lib/polybool.mjs';

const square = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]];
/** Filled area of the results: rings counted by even-odd nesting (outer minus holes). */
const filled = areas => areas.reduce((n, a) => n + a.reduce((m, r) => m + Math.abs(ringArea(r)) * (a.length > 1 && r !== a.reduce((big, q) => (Math.abs(ringArea(q)) > Math.abs(ringArea(big)) ? q : big)) ? -1 : 1), 0), 0);

test('boolean ops have the expected areas (merge.rs boolean_ops_have_the_expected_areas)', () => {
  const areas = [square(0, 0, 10), square(5, 5, 10)];
  assert.ok(Math.abs(filled(mergeAreas('union', areas)) - 175) < 1e-6);
  assert.ok(Math.abs(filled(mergeAreas('intersect', areas)) - 25) < 1e-6);
  assert.ok(Math.abs(filled(mergeAreas('subtract', areas)) - 75) < 1e-6);
  assert.ok(Math.abs(filled(mergeAreas('combine', areas)) - 150) < 1e-6);
  const frags = mergeAreas('fragment', areas);
  assert.equal(frags.length, 3);
  assert.ok(Math.abs(filled(frags) - 175) < 1e-6);
  assert.deepEqual(mergeAreas('intersect', [square(0, 0, 1), square(5, 5, 1)]), []);
});

test('a square cut out of the middle of another leaves a hole', () => {
  const out = mergeAreas('subtract', [square(0, 0, 10), square(3, 3, 4)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 2, 'outer ring and hole');
  assert.ok(Math.abs(filled(out) - 84) < 1e-6);
});

const box = (id, name, x, y, w, h, preset, extra = {}) => ({id, name, xfrm: {x, y, w, h}, kind: {type: 'shape'}, geom: {kind: 'preset', name: preset}, ph: null, fill: null, line: null, effects: null,
  style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null, ...extra});
async function session() {
  const c = createContent('Merge');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const red = {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 255, g: 0, b: 0, a: 255}}, mods: []}};
  c.slides = [newSlide({id: 's1', layout, shapes: [box('a', 'Rect', 100, 100, 100, 100, 'rect', {fill: red}), box('b', 'Oval', 150, 100, 100, 100, 'ellipse'), box('c', 'Far', 400, 400, 50, 50, 'rect')]})];
  return createTestSession('prism', {content: c, selection: {ranges: ['a', 'b'].map(i => ({anchor: `/sl:s1/sp:${i}`, focus: `/sl:s1/sp:${i}`})), primary: 1}});
}
const live = t => t.session.get(t.docId).file.content.slides[0].shapes;

test("shape.merge unions two shapes into one freeform with the first shape's formatting, and undoes", async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'shape.merge', {op: 'union', ids: ['a', 'b']}, r => {
    const shapes = (r.content ?? r).slides[0].shapes;
    assert.equal(shapes.length, 2);
    const m = shapes[0];
    assert.equal(m.name, 'Freeform 1');
    assert.equal(m.geom.kind, 'custom');
    assert.equal(m.fill.color.base.rgb.r, 255);
    assert.deepEqual([m.xfrm.x, m.xfrm.y, m.xfrm.h], [100, 100, 100]);
    assert.ok(Math.abs(m.xfrm.w - 150) < 0.05, `${m.xfrm.w}`);
  });
});

test('shape.merge fragment makes three shapes and intersect one; unmergeable selections are refused', async () => {
  const t = await session();
  const r = (await t.exec('shape.merge', {op: 'fragment', ids: ['a', 'b']})).result;
  assert.equal(r.ids.length, 3);
  assert.equal(live(t).length, 4);
  const t2 = await session();
  assert.equal((await t2.exec('shape.merge', {op: 'intersect', ids: ['a', 'b']})).result.ids.length, 1);
  await assert.rejects((await session()).exec('shape.merge', {op: 'rotate', ids: ['a', 'c']}), /unknown op/);
  await assert.rejects((await session()).exec('shape.merge', {op: 'union', ids: ['c']}), /select two or more/);
});
