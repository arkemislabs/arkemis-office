// U:prism/selection: the Selection pane's commands on schema-2 slides, each edit's undo round trip.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/selection.rs (select:30 picks objects,
//    group members too, never mixing them with top-level ones, and shows a hidden object it picks;
//    show_all:89; hide_all:114). PowerPoint: Selection Pane click / Ctrl+click, Show All, Hide All.
// 2. Ours: the same, over the kernel selection; picking is a selection change (no undo step)
//    unless it reveals a hidden object (one step).
// 3. These tests + tests/prism/upstream/selection_tests.test.mjs + tests/e2e/prism/selection-pane.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {withNew, rect, shapeOf, selected} from './upstream/text_deck.mjs';

test('selection.select reveals a hidden object (undoable); showAll / hideAll round trips', async () => {
  const t = await withNew({blank: true, shapes: [rect('500', [0, 0, 10, 10], undefined, 'A', {hidden: true}), rect('501', [20, 0, 10, 10], undefined, 'B')]});
  await expectUndoRoundTrip(t, 'selection.select', {id: '500'}, after => assert.equal(after.content.slides[1].shapes[0].hidden, false));
  assert.deepEqual(selected(t), ['500']);
  await expectUndoRoundTrip(t, 'selection.hideAll', {}, after => assert.ok(after.content.slides[1].shapes.every(x => x.hidden)));
  await expectUndoRoundTrip(t, 'selection.showAll', {}, after => assert.ok(after.content.slides[1].shapes.every(x => !x.hidden)));
  assert.equal(shapeOf(t, '501').hidden, false);
  assert.deepEqual(t.state('selection.showAll'), {enabled: true});
});
