// Ported from deckcraft crates/anim/src/tests.rs (`morph_pairs_by_name_text_and_geometry`,
// `morph_pairs_leaves_unrelated_text_boxes_alone`, `morph_crop_moves_the_image_linearly`,
// `morph_xfrm_interpolates`) and crates/ui-egui/src/panels/animtimeline.rs tests (`ruler_and_scale`,
// `drags_snap_and_clamp`, `label_text`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
//
// 1. ArtCraft: crates/anim/src/morph.rs (Morph's pairing, box and crop interpolation),
//    panels/animtimeline.rs (the Animation Pane's ruler and drag maths); PowerPoint: Morph's
//    matching (!!name, name, same text, same shape) and the Animation Pane's timeline bars.
// 2. Ours: core/prism/lib/morph.mjs and anim-pane.mjs, the same rules and numbers; Morph's plan
//    (which shapes move, which cross-fade) is covered by the last test.
// 3. These tests; the Animation Pane in the app: tests/e2e/prism/animations.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {morphPairs, morphXfrm, morphCrop, morphPlan} from '../../../core/prism/lib/morph.mjs';
import {rulerSeconds, pixelsPerSecond, draggedDelay, draggedDuration, barLabel, MAX_MS, MIN_DURATION_MS} from '../../../core/prism/lib/anim-pane.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const shape = (id, name, extra = {}) => ({id: String(id), name, xfrm: {x: 100, y: 100, w: 200, h: 100}, geom: {kind: 'preset', name: 'rect'}, kind: {type: 'shape'}, ...extra});
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('morph_pairs_by_name_text_and_geometry', () => {
  const a = {shapes: [shape(1, '!!Logo'), shape(2, 'Title 1'), shape(3, 'x'), shape(4, 'Rect A')]};
  const b = {shapes: [shape(14, 'Rect B'), shape(13, 'y'), shape(12, 'Title 1'), shape(11, '!!Logo')]};
  a.shapes[2].text = bodyFromText('Hello');
  b.shapes[1].text = bodyFromText('Hello');
  const p = morphPairs(a, b).map(x => x.join('>'));
  for (const w of ['1>11', '2>12', '3>13', '4>14']) assert.ok(p.includes(w), w);
  assert.equal(p.length, 4);
  assert.deepEqual(morphPairs({shapes: []}, b), []);
});

test('morph_pairs_leaves_unrelated_text_boxes_alone', () => {
  const tb = (id, name, x, text) => shape(id, name, {xfrm: {x, y: 100, w: 200, h: 100}, text: bodyFromText(text), textBox: true});
  const a = {shapes: [tb(1, 'TextBox 1', 0, 'Gone')]};
  const b = {shapes: [tb(2, 'TextBox 2', 400, 'New')]};
  assert.deepEqual(morphPairs(a, b), []);
  a.shapes.push(shape(3, 'Rect A'));
  b.shapes.push(shape(4, 'Rect B'));
  b.shapes[0].name = 'TextBox 1';
  assert.deepEqual(morphPairs(a, b), [['1', '2'], ['3', '4']]);
});

test('morph_crop_moves_the_image_linearly', () => {
  const bx = (x, w) => ({x, y: 0, w, h: 100});
  let c = morphCrop([0, 0, 0.5, 0], bx(0, 100), [0.5, 0, 0, 0], bx(0, 100), bx(0, 100), 0.5);
  assert.ok(c.every((v, i) => near(v, [0.25, 0, 0.25, 0][i])), String(c));
  c = morphCrop([0, 0, 0, 0], bx(0, 100), [0, 0, 0.5, 0], bx(0, 50), bx(0, 75), 0.5);
  assert.ok(c.every((v, i) => near(v, [0, 0, 0.25, 0][i])), String(c));
  c = morphCrop([0.5, 0, 0.5, 0], bx(0, 100), [0, 0, 0, 0], bx(0, 100), bx(0, 100), 0.5);
  assert.ok(c.every(Number.isFinite) && near(c[0], 0.25), String(c));
});

test('morph_xfrm_interpolates', () => {
  const a = {x: 0, y: 0, w: 100, h: 100, rot: 350}, b = {x: 100, y: 50, w: 200, h: 100, rot: 10};
  const m = morphXfrm(a, b, 0.5);
  assert.ok(near(m.x, 50) && near(m.w, 150));
  assert.ok(Math.abs(m.rot) < 1e-9 || near(m.rot, 360), String(m.rot));
  assert.deepEqual(morphXfrm(a, b, 1), b);
  assert.deepEqual(morphXfrm(a, b, NaN), a);
  assert.ok(Number.isFinite(morphXfrm({x: NaN, y: 0, w: 1, h: 1, rot: Infinity}, b, 0.3).rot));
});

test('morphPlan: a shape that only moved moves; changed content cross-fades on the moving box; unpaired shapes fade; entrance shapes stay out', () => {
  const a = {id: 'a', shapes: [shape(1, 'Card'), shape(2, 'Gone', {text: bodyFromText('gone')}), shape(3, 'Same', {text: bodyFromText('A')}), shape(4, 'Ent')]};
  const b = {id: 'b', shapes: [shape(11, 'Card', {xfrm: {x: 500, y: 100, w: 200, h: 100}}), shape(12, 'Same', {text: bodyFromText('B')}), shape(13, 'New', {text: bodyFromText('new')}), shape(14, 'Ent')]};
  const pres = {slides: [a, b], masters: [], slideSize: {width: 960, height: 540}};
  const plan = morphPlan(pres, a, b, 0.5, id => id === '14');
  assert.ok(near(plan.new.get('11').xfrm.x, 300) && plan.new.get('11').opacity === 1, 'identical content moves');
  assert.equal(plan.old.get('1').hide, true);
  assert.ok(near(plan.old.get('2').opacity, 0.5), 'an unpaired shape of the old slide fades out');
  assert.ok(near(plan.new.get('13').opacity, 0.5), 'an unpaired shape of the new slide fades in');
  assert.ok(near(plan.new.get('12').opacity, 0.5) && near(plan.old.get('3').opacity, 0.5), 'changed content cross-fades');
  assert.equal(plan.new.get('14').hide, true, 'a shape the build has not entered yet stays out');
  assert.equal(morphPlan(pres, a, b, 1).mix, 1);
});

test('ruler_and_scale', () => {
  assert.equal(rulerSeconds([]), 1);
  assert.equal(rulerSeconds([{start: 1.2, span: 2}]), 4);
  assert.equal(pixelsPerSecond(200, 4), 50);
  assert.equal(pixelsPerSecond(10_000, 1), 120);
  assert.equal(pixelsPerSecond(NaN, 0), 8);
});

test('drags_snap_and_clamp', () => {
  assert.equal(draggedDelay(0, 25, 50), 500);
  assert.equal(draggedDelay(500, -100, 50), 0);
  assert.equal(draggedDelay(0, 13, 50), 250);
  assert.equal(draggedDelay(0, Infinity, 50), 0);
  assert.equal(draggedDelay(MAX_MS, 1e9, 1), MAX_MS);
  assert.equal(draggedDuration(500, 50, 50, 1), 1500);
  assert.equal(draggedDuration(500, 50, 50, 2), 1000);
  assert.equal(draggedDuration(500, -1000, 50, 1), MIN_DURATION_MS);
  assert.equal(draggedDuration(500, 0, 0, NaN), 500);
});

test('label_text', () => {
  assert.equal(barLabel({start: 0.5, span: 2}), 'Start: 0.50s, End: 2.50s');
});
