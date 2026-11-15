// Ported from deckcraft crates/engine/src/cmd/selection_tests.rs (`deck`, `eye_show_all_and_hide_all`
// (Show All / Hide All part), `select_from_the_pane`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// The deck (A, B, C, then G = group [D, H = group [E, F]]) is built in the content; shape.visible,
// shape.rename and arrange.group are other families, so hidden flags are set in the content.
//
// 1. ArtCraft: cmd/selection.rs (select:30, show_all:89, hide_all:114); PowerPoint: Home › Editing ›
//    Select › Selection Pane (click, Ctrl+click, Show All, Hide All; picking a hidden object shows it).
// 2. Ours: the same rules over the schema-2 tree; picking is a selection change unless it reveals.
// 3. These tests + tests/prism/selection.test.mjs + tests/e2e/prism/selection-pane.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {withNew, rect, shapeOf, selected} from './text_deck.mjs';

function deck({hidden = []} = {}) {
  const mk = (id, n, x) => rect(id, [x, 50, 100, 80], undefined, n, {hidden: hidden.includes(n)});
  const [a, b, c, d, e, f] = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => mk(String(501 + i), n, 20 + 110 * i));
  const group = (id, name, children) => ({...rect(id, [0, 0, 700, 200], undefined, name, {hidden: hidden.includes(name)}),
    text: null, geom: null, fill: null, kind: {type: 'group', children, child: {x: 0, y: 0, w: 700, h: 200}}});
  const h = group('510', 'H', [e, f]);
  const g = group('511', 'G', [d, h]);
  return withNew({blank: true, shapes: [a, b, c, g]});
}
const ID = {A: '501', B: '502', C: '503', D: '504', E: '505', F: '506', H: '510', G: '511'};
const hiddenOf = (t, n) => !!shapeOf(t, ID[n]).hidden;
const depth = t => t.doc.undo.length ?? t.doc.undo.size ?? t.doc.undo.labels().length;

test('eye_show_all_and_hide_all: Hide All hides the top level only; Show All shows everything', async () => {
  const t = await deck({hidden: ['B', 'G', 'E']});
  await t.exec('selection.hideAll', {});
  assert.ok(hiddenOf(t, 'A') && hiddenOf(t, 'G') && !hiddenOf(t, 'D') && hiddenOf(t, 'E'));
  await t.exec('selection.showAll', {});
  for (const n of Object.keys(ID)) assert.ok(!hiddenOf(t, n), `${n} still hidden`);
  const n0 = depth(t);
  await t.exec('selection.showAll', {});
  assert.equal(depth(t), n0, 'nothing to show: no undo step');
  await t.undo();
  assert.ok(hiddenOf(t, 'A') && hiddenOf(t, 'E'));
  await t.undo();
  assert.ok(!hiddenOf(t, 'A') && hiddenOf(t, 'G') && hiddenOf(t, 'E'));
});

test('select_from_the_pane', async () => {
  const t = await deck({hidden: ['C']});
  const {A: a, B: b, C: c, D: d, E: e, G: g} = ID;
  await t.exec('selection.select', {id: b});
  assert.deepEqual(selected(t), [b]);
  await t.exec('selection.select', {id: c, toggle: true});
  assert.deepEqual(selected(t), [b, c]);
  assert.ok(!hiddenOf(t, 'C'), 'picking a hidden object shows it');
  await t.undo();
  assert.ok(hiddenOf(t, 'C'));
  await t.exec('selection.select', {id: b});
  await t.exec('selection.select', {id: c, toggle: true});
  await t.exec('selection.select', {id: b, toggle: true});
  assert.deepEqual(selected(t), [c]);
  await t.exec('selection.select', {ids: [a, b], add: true});
  assert.deepEqual(selected(t), [c, a, b]);
  // A child inside a group; children across nesting levels go together.
  await t.exec('selection.select', {id: d});
  assert.deepEqual(selected(t), [d]);
  await t.exec('selection.select', {id: e, toggle: true});
  assert.deepEqual(selected(t), [d, e]);
  // ...but not with top-level objects: Ctrl+click on one is ignored.
  await t.exec('selection.select', {id: g, toggle: true});
  assert.deepEqual(selected(t), [d, e]);
  await t.exec('selection.select', {id: a});
  await t.exec('selection.select', {id: d, toggle: true});
  assert.deepEqual(selected(t), [a]);
  // Picking makes no undo step.
  const n = depth(t);
  await t.exec('selection.select', {id: b});
  assert.equal(depth(t), n);
  await assert.rejects(t.exec('selection.select', {id: 4242}));
});
