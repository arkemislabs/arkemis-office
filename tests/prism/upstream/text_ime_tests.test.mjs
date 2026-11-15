// Ported from deckcraft crates/engine/src/cmd/text/ime.rs `mod ime_surrounding_tests`
// (`selected_text_survives_the_requested_characters_or_bytes_around_it`,
// `byte_counts_round_inward_to_whole_characters`, `surrounding_text_is_committed_logical_and_bounded`,
// `paragraph_marks_are_deletable_logical_text`, `soft_line_breaks_read_as_newlines`,
// `out_of_range_counts_clamp_instead_of_truncating`, `a_non_composing_ime_deletion_is_one_undo_step`)
// and crates/engine/src/tests.rs (`ime_composition_replaces_its_preedit_and_commits_as_one_undo_step`,
// `ime_cancel_restores_the_text_and_selection`, `ime_composition_is_kept_by_a_key_a_click_or_another_command`
// (the command part), `ime_composition_underlines_follow_the_text` (the ranges)) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. Positions are UTF-16 here where deckcraft counts
// characters: in "aé😀b" deckcraft's 3 (after the emoji) is 4.
//
// 1. ArtCraft: cmd/text/ime.rs (`compose`, `commit`, `ime_surrounding`) and caret.rs
//    (`delete_surrounding`); PowerPoint: typing Japanese, Korean or Chinese with an input method,
//    press-and-hold accents and dictation on the Mac.
// 2. Ours: the same commands and results; the pre-edit is view state the surface draws in place
//    (core/prism/lib/text-ime.mjs explains why), so "the preedit is shown in place" is checked on
//    `composedText`, and the composition is still one undo step when committed.
// 3. These tests + tests/prism/text.test.mjs + tests/e2e/prism/text-editing.e2e.mjs (commit over the bridge).
//    Not ported: the keys-layer parts (`Session::key`/`pointer` settling, `ime_on_a_selected_shape_replaces_its_text`:
//    the surface starts editing as it does for typing) and the underline geometry (the surface's layout).

import test from 'node:test';
import assert from 'node:assert/strict';
import {withNew, rect, textOf, textSel, curSlide} from './text_deck.mjs';
import {imeSurrounding, committedBody, composedText, IME_SURROUNDING_MAX_BYTES, countParam} from '../../../core/prism/lib/text-ime.mjs';
import {bodyText} from '../../../core/prism/model/text.mjs';

const titleId = t => curSlide(t).shapes[0].id;
const comp = t => t.doc.view?.composition ?? null;
const bodyOfShape = (t, id) => curSlide(t).shapes.find(s => s.id === String(id)).text;
/** What the person sees: the body with the pre-edit in place. */
const shown = (t, id) => (comp(t) ? bodyText(composedText(bodyOfShape(t, id), comp(t)).body) : textOf(t, id));
const undoDepth = t => t.doc.undo.size;

async function edit() {
  const t = await withNew({shapes: [rect('901', [10, 10, 240, 60], 'aé😀b')]});
  await t.exec('text.edit', {id: '901'});
  return t;
}
const select = (t, anchor, caret) => t.exec('text.select', {anchor: [0, anchor], caret: [0, caret]});
const del = (t, before, after, bytes) => t.exec('text.deleteSurrounding', {before, after, bytes});
function surrounding(t) {
  const s = textSel(t);
  const body = committedBody(bodyOfShape(t, s.shape), comp(t));
  const c = comp(t);
  return c ? imeSurrounding(body, c.from, c.from) : imeSurrounding(body, s.anchor, s.caret);
}

test('selected_text_survives_the_requested_characters_or_bytes_around_it', async () => {
  const t = await edit();
  await select(t, 4, 1); // reversed: caret before anchor, selecting é😀
  await del(t, 1, 1, false);
  assert.equal(textOf(t, '901'), 'é😀', 'a and b go; the selected run stays');
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 3], [0, 0]], 'both endpoints shift and stay reversed');
  await t.undo();
  assert.equal(textOf(t, '901'), 'aé😀b');
  await select(t, 1, 4);
  await del(t, 1, 1, true);
  assert.equal(textOf(t, '901'), 'é😀', 'byte counts around the selection delete a and b too');
  await t.undo();
  assert.equal(textOf(t, '901'), 'aé😀b');
});

test('byte_counts_round_inward_to_whole_characters', async () => {
  const t = await edit();
  await select(t, 2, 2); // after é: bytes 0..3
  await del(t, 1, 0, true);
  assert.equal(textOf(t, '901'), 'aé😀b', 'one byte inside é is not the whole scalar');
  await del(t, 2, 0, true);
  assert.equal(textOf(t, '901'), 'a😀b', 'two bytes reach é\'s start, so the whole é goes');
  await t.undo();
  assert.equal(textOf(t, '901'), 'aé😀b');
  await select(t, 2, 2);
  await del(t, 0, 1, true);
  assert.equal(textOf(t, '901'), 'aé😀b', 'one byte into the emoji is not the whole scalar');
  await del(t, 0, 4, true);
  assert.equal(textOf(t, '901'), 'aéb', 'four bytes contain the whole emoji');
});

test('surrounding_text_is_committed_logical_and_bounded', async () => {
  const t = await edit();
  assert.deepEqual(surrounding(t), {text: 'aé😀b', cursor: 8, anchor: 8});
  await t.exec('text.select', {anchor: [0, 4], caret: [0, 1]});
  assert.deepEqual(surrounding(t), {text: 'aé😀b', cursor: 1, anchor: 7}, 'reversed selection keeps caret before anchor');
  await t.exec('text.set', {id: '901', text: 'ab'});
  await t.exec('text.move', {to: 'end'});
  await t.exec('text.compose', {text: '日本'});
  assert.deepEqual(surrounding(t), {text: 'ab', cursor: 2, anchor: 2}, 'pre-edit is not committed text');
  await t.exec('text.set', {id: '901', text: ''});
  assert.deepEqual(surrounding(t), {text: '', cursor: 0, anchor: 0}, 'empty body is available');
  await t.exec('text.set', {id: '901', text: 'a'.repeat(IME_SURROUNDING_MAX_BYTES + 1500)});
  await t.exec('text.move', {to: 'end'});
  const q = surrounding(t);
  assert.ok(q.text.length <= IME_SURROUNDING_MAX_BYTES, String(q.text.length));
  assert.equal(q.cursor, q.text.length, 'caret stays at the end of the bounded window');
});

test('paragraph_marks_are_deletable_logical_text', async () => {
  const t = await edit();
  await t.exec('text.set', {id: '901', text: 'ab\ncd'});
  await t.exec('text.select', {anchor: [1, 0], caret: [1, 0]});
  assert.deepEqual(surrounding(t), {text: 'ab\ncd', cursor: 3, anchor: 3});
  await del(t, 1, 0, true);
  assert.equal(textOf(t, '901'), 'abcd', 'the mark goes and the paragraphs merge');
  assert.deepEqual(textSel(t).caret, [0, 2], 'the caret stays where the merged text continues');
  await t.undo();
  assert.equal(textOf(t, '901'), 'ab\ncd');
  await t.exec('text.select', {anchor: [1, 0], caret: [1, 0]});
  await del(t, 1, 0, false);
  assert.equal(textOf(t, '901'), 'abcd');
  await t.undo();
  await t.exec('text.select', {anchor: [0, 2], caret: [0, 2]});
  await del(t, 0, 1, false);
  assert.equal(textOf(t, '901'), 'abcd');
});

test('soft_line_breaks_read_as_newlines', async () => {
  const t = await edit();
  await t.exec('text.autocorrect', {on: false});
  await t.exec('text.set', {id: '901', text: 'ab'});
  await t.exec('text.select', {anchor: [0, 1], caret: [0, 1]});
  await t.exec('text.insert', {text: '\u000b'});
  assert.equal(textOf(t, '901'), 'a\u000bb', 'a line break inside one paragraph');
  assert.deepEqual(surrounding(t), {text: 'a\nb', cursor: 2, anchor: 2});
  await del(t, 1, 0, true);
  assert.equal(textOf(t, '901'), 'ab');
  await t.undo();
  assert.equal(textOf(t, '901'), 'a\u000bb');
});

test('out_of_range_counts_clamp_instead_of_truncating', async () => {
  const t = await edit();
  await select(t, 1, 1);
  await del(t, Number.MAX_SAFE_INTEGER * 4, 0, false);
  assert.equal(textOf(t, '901'), 'é😀b', 'everything before the caret goes, no error');
  assert.equal(countParam({before: 4294967296}, 'before'), 4294967296, 'the count is kept, not wrapped');
  assert.equal(countParam({}, 'before'), 0);
});

test('a_non_composing_ime_deletion_is_one_undo_step', async () => {
  const t = await edit();
  const undo0 = undoDepth(t);
  await select(t, 4, 4);
  await del(t, 1, 0, false);
  assert.equal(textOf(t, '901'), 'aéb');
  assert.equal(undoDepth(t), undo0 + 1, 'one history entry, not two');
  await t.undo();
  assert.equal(textOf(t, '901'), 'aé😀b');
});

test('ime_composition_replaces_its_preedit_and_commits_as_one_undo_step', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  await t.exec('text.insert', {text: 'A '});
  const undo0 = undoDepth(t);
  for (const pre of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
    await t.exec('text.compose', {text: pre});
    assert.equal(shown(t, title), `A ${pre}`, 'the preedit is shown in place');
    assert.deepEqual([comp(t).from, [...comp(t).text].length], [[0, 2], [...pre].length]);
    assert.deepEqual(composedText(bodyOfShape(t, title), comp(t)).caret, [0, 2 + pre.length], 'caret after the preedit');
    assert.equal(undoDepth(t), undo0, 'no undo step while composing');
  }
  await t.exec('text.commit', {text: '한글'});
  assert.equal(textOf(t, title), 'A 한글');
  assert.equal(comp(t), null);
  assert.equal(undoDepth(t), undo0 + 1, 'one undo step for the composition');
  assert.match(t.doc.undo.peek().label, /Type Text/);
  await t.undo();
  assert.equal(textOf(t, title), 'A ');
  await t.redo();
  assert.equal(textOf(t, title), 'A 한글');

  // Windows' Korean IME commits a syllable when the next begins: an empty preedit, the commit, then a new preedit.
  await t.exec('text.compose', {text: 'ㄴ'});
  await t.exec('text.compose', {text: ''});
  await t.exec('text.commit', {text: 'ㄴ'});
  await t.exec('text.compose', {text: 'ㅁ'});
  assert.equal(shown(t, title), 'A 한글ㄴㅁ');
  await t.exec('text.commit', {text: '마'});
  assert.equal(textOf(t, title), 'A 한글ㄴ마');
  await t.undo();
  assert.equal(textOf(t, title), 'A 한글ㄴ');
});

test('ime_cancel_restores_the_text_and_selection', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  await t.exec('text.insert', {text: 'Hello world'});
  await t.exec('text.select', {anchor: [0, 6], caret: [0, 11]});
  const undo0 = undoDepth(t);
  await t.exec('text.compose', {text: 'せかい', active: [0, 3]});
  assert.equal(shown(t, title), 'Hello せかい', 'the preedit replaces the selection');
  assert.deepEqual(comp(t).active, [0, 3]);
  await t.exec('text.compose', {text: '世界', active: [0, 9]});
  assert.deepEqual(comp(t).active, [0, 2], 'clamped to the preedit');
  await t.exec('text.compose', {text: ''});
  assert.equal(shown(t, title), 'Hello world');
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 6], [0, 11]], 'the selection is back');
  assert.equal(undoDepth(t), undo0);
  // A commit of nothing without a composition is nothing.
  await t.exec('text.commit', {text: ''});
  assert.equal(undoDepth(t), undo0);
  // A commit without a preedit (some input methods send only the result) is one step.
  await t.exec('text.commit', {text: '世界'});
  assert.equal(textOf(t, title), 'Hello 世界');
  assert.equal(undoDepth(t), undo0 + 1);
});

test('ime_composition_is_kept_by_another_command (text.insert, text.get; a changed text starts a new one)', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  await t.exec('text.compose', {text: '하'});
  await t.exec('text.get', {id: title});
  assert.ok(comp(t), 'a query doesn\'t settle it');
  const undo0 = undoDepth(t);
  await t.exec('text.insert', {text: '!'});
  assert.equal(textOf(t, title), '하!', 'the pre-edit stays as typed text, then the key types');
  assert.equal(comp(t), null);
  assert.equal(t.doc.view.compositionSettles, 1, 'the platform\'s composition must be interrupted');
  // One step here where deckcraft records two (the kernel records one entry per command).
  assert.equal(undoDepth(t), undo0 + 1);
  await t.undo();
  assert.equal(textOf(t, title), '');

  // Text changed under the composition: a new one starts, no error.
  await t.exec('text.compose', {text: 'ㄱ'});
  t.doc.view = {...t.doc.view, composition: {...t.doc.view.composition, to: [0, 99]}};
  await t.exec('text.compose', {text: '가'});
  assert.ok(shown(t, title).endsWith('가'));
  // Control characters (an Enter sent as text) never split the paragraph.
  await t.exec('text.commit', {text: '가\n\r\u000b'});
  assert.equal(bodyOfShape(t, title).paragraphs.length, 1);
  assert.equal(textOf(t, title), '가');
});

test('ime_composition_underlines_follow_the_text (ranges in the composed body)', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  assert.equal(comp(t), null);
  await t.exec('text.compose', {text: 'にほんご', active: [2, 4]});
  const {ranges} = composedText(bodyOfShape(t, title), comp(t));
  assert.deepEqual(ranges, [{para: 0, start: 0, end: 4, thick: false}, {para: 0, start: 2, end: 4, thick: true}], 'the converted part is the end');
  await t.exec('text.commit', {text: '日本語'});
  assert.equal(comp(t), null);
  assert.equal(textOf(t, title), '日本語');
});

test('deleting around a composition keeps it and moves it with the text', async () => {
  const t = await edit();
  await t.exec('text.select', {anchor: [0, 2], caret: [0, 2]});
  await t.exec('text.compose', {text: 'x'});
  await del(t, 1, 1, false);
  assert.equal(textOf(t, '901'), 'ab', 'é before and the emoji after the pre-edit go');
  assert.deepEqual([comp(t).from, comp(t).to], [[0, 1], [0, 1]]);
  assert.equal(shown(t, '901'), 'axb');
  await t.exec('text.commit', {text: 'y'});
  assert.equal(textOf(t, '901'), 'ayb');
});
