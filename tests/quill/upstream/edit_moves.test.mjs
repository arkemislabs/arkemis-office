// Ports of the #[test]s in wordcraft crates/engine/src/cmd/moves.rs (ArtCraft
// aadb077e072b7de05f724e359d8db82e151f125c): tracked moves.
//
// 1. What ArtCraft does: with Track Changes on, a paragraph or sentence cut and pasted right after is
//    a move (moveFrom / moveTo linked by a move name, the paragraph mark moved too); a word is a
//    deletion and an insertion; with Track moves off (w:doNotTrackMoves) it is never a move. Word
//    shows the same in the Reviewing pane (Moved / Moved from).
// 2. Ours: core/quill/lib/edit-moves.mjs (cut_tracked, take_paste) behind edit.cut / edit.paste.
//    Upstream reads the result through review.changes and resolves it with review.accept/reject
//    (U:quill/review, not registered yet): here the revisions are read from the model directly; the
//    accept/reject parts of the upstream tests run once Review lands (names_in / resolve are
//    exported for it).
// 3. These tests and tests/quill/edit.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFromText} from '../../../core/quill/model/content.mjs';
import {s, run, setSel, pos, bodyParas} from '../text-fixture.mjs';

const texts = t => bodyParas(t).map(p => p.text);
const moveName = (t, rid) => (rid === undefined || rid === null ? null : t.content.revisions?.[rid]?.moveName ?? null);

async function tracked(text, settings = {}) {
  const c = contentFromText(text);
  c.settings = {...(c.settings ?? {}), trackChanges: true, ...settings};
  return s(c, {prefs: {userName: 'Ana'}});
}

/** Three paragraphs; with Track Changes on, the second (with its mark) cut and pasted before the first. */
async function moved(settings) {
  const t = await tracked('First one.\nSecond one.\nThird one.', settings);
  await setSel(t, pos(1, 0), pos(2, 0));
  await run(t, 'edit.cut');
  await setSel(t, pos(0, 0));
  await run(t, 'edit.paste');
  return t;
}

test('a_tracked_cut_and_paste_of_a_paragraph_is_a_move', async () => {
  let t = await moved();
  assert.deepEqual(texts(t), ['Second one.', 'First one.', 'Second one.', 'Third one.']);
  const [to, , from] = bodyParas(t);
  assert.equal(moveName(t, to.runs[0].props?.ins), 'move1');
  assert.equal(moveName(t, to.mark?.ins), 'move1', 'the pasted paragraph mark is moved too');
  assert.equal(moveName(t, from.runs[0].props?.del), 'move1');
  assert.equal(moveName(t, from.mark?.del), 'move1');
  assert.equal(bodyParas(t)[1].runs[0].props?.ins, undefined);
  // A word is no move: a deletion and an insertion.
  t = await tracked('one two');
  await setSel(t, pos(0, 0), pos(0, 4));
  await run(t, 'edit.cut');
  await run(t, 'caret.docEnd');
  await run(t, 'edit.paste');
  assert.deepEqual(t.content.revisions.map(r => [r.kind, r.moveName ?? null]), [['delete', null], ['insert', null]]);
});

test('with_track_moves_off_a_cut_and_paste_is_a_deletion_and_an_insertion', async () => {
  const t = await moved({trackMoves: false});
  assert.deepEqual(texts(t), ['Second one.', 'First one.', 'Second one.', 'Third one.']);
  assert.ok(t.content.revisions.every(r => !r.moveName), JSON.stringify(t.content.revisions));
  const kinds = new Set(t.content.revisions.map(r => r.kind));
  assert.ok(kinds.has('insert') && kinds.has('delete'));
});
