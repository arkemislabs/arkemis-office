// Ported from deckcraft crates/engine/src/cmd/guides_tests.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf (`add_move_delete_and_undo`). The pointer part of
// `drag_a_guide_drop_it_off_the_slide_and_snap_shapes_to_it` is the foundation's
// (tests/prism/foundation-pointer.test.mjs); `guides_round_trip_through_pptx` belongs to the
// pptx format unit.
//
// 1. What ArtCraft does: guide.add with `defaults` adds the two centre guides only when there are
//    none; a guide is kept on the slide; bad indices and missing positions are refused; undo
//    brings a deleted guide back.
// 2. Ours: the same commands on a schema-2 deck (`content.guides`).
// 3. Proved here.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createContent} from '../../../core/prism/schema.mjs';

test('guides_tests.rs add_move_delete_and_undo', async () => {
  const c = createContent('Guides');
  const t = await createTestSession('prism', {content: c, selection: {ranges: [{anchor: `/sl:${c.slides[0].id}`, focus: `/sl:${c.slides[0].id}`}], primary: 0}});
  assert.equal((await t.exec('guide.add', {defaults: true})).result.added, 2);
  assert.equal((await t.exec('guide.add', {defaults: true})).result.added, 0, 'only when there are none');
  const i = (await t.exec('guide.add', {vertical: false, pos: 100})).result.index;
  assert.equal(i, 2);
  await t.exec('guide.move', {index: 2, pos: 5000});
  assert.equal(t.content.guides[2].pos, 540, 'kept on the slide');
  await assert.rejects(t.exec('guide.move', {index: 9, pos: 1}));
  await assert.rejects(t.exec('guide.move', {index: 0, pos: null}));
  await t.exec('guide.delete', {index: 0});
  assert.equal((await t.exec('guide.list', {})).result.length, 2);
  await t.undo();
  assert.equal(t.content.guides.length, 3);
});
