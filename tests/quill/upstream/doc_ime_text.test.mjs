// Ported from wordcraft crates/doc/src/ime_text.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c.
// Offsets are UTF-16 code units (upstream: UTF-8 bytes), so U+FFFC is one unit where upstream
// counts three, é is one unit and 👍 two; the 'units' delete counts stand for upstream's Bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {VisibleParagraph, imeSurrounding, imeDeleteSurrounding, MAX_IME_TEXT} from '../../../core/quill/model/ime-text.mjs';
import {Document, BODY} from '../../../core/quill/model/document.mjs';
import {createContent} from '../../../core/quill/model/content.mjs';
import {newParagraph, paragraphWithText, OBJ} from '../../../core/quill/model/para.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';

const pos = (b, off) => ({story: BODY, path: [b], off});
function paraWithRuns(parts) {
  const p = newParagraph();
  for (const [text, deleted] of parts) { p.text += text; p.runs.push(deleted ? {len: text.length, props: {del: 0}} : {len: text.length}); }
  return p;
}
const docOf = (...blocks) => new Document(createContent(blocks));
const eqPara = () => { const p = newParagraph(); p.text = `a${OBJ}b`; p.runs = [{len: 3}]; p.objects = [{type: 'equation', linear: 'x+y', display: false}]; return p; };

test('tracked_deletions_are_hidden_and_offsets_still_map', () => {
  const view = new VisibleParagraph(paraWithRuns([['ab', false], ['DEL', true], ['cd', false]]));
  assert.equal(view.visibleLen(), 4);
  assert.equal(view.visibleOffset(0), 0);
  assert.equal(view.visibleOffset(2), 2, 'the start of a deleted run is a visible caret position');
  assert.equal(view.visibleOffset(3), null, 'inside a tracked deletion');
  assert.equal(view.visibleOffset(5), 2);
  assert.equal(view.visibleOffset(7), 4);
  assert.equal(view.storedOffset(2), 5);
  assert.equal(view.storedOffset(4), 7);
  assert.equal(view.window(2, 2, 4000).text, 'abcd');
});

test('objects_contribute_their_plain_text_and_split_mapping_stops', () => {
  const view = new VisibleParagraph(eqPara());
  assert.equal(view.visibleLen(), 5);
  assert.equal(view.visibleOffset(1), 1);
  assert.equal(view.visibleOffset(2), 4);
  assert.equal(view.storedOffset(1), 1);
  assert.equal(view.storedOffset(4), 2);
  assert.equal(view.storedOffset(2), null, "inside the object's text");
});

test('an_empty_document_is_available_and_empty', () => {
  assert.deepEqual(new VisibleParagraph(newParagraph()).window(0, 0, MAX_IME_TEXT), {text: '', cursor: 0, anchor: 0});
  assert.equal(imeSurrounding(Document.create(), pos(0, 0), pos(0, 0)).text, '');
});

test('bounded_window_keeps_the_selection_and_rejects_too_wide_ones', () => {
  const view = new VisibleParagraph(paragraphWithText('a'.repeat(10_000)));
  const w = view.window(5000, 5000, MAX_IME_TEXT);
  assert.ok(w.text.length <= MAX_IME_TEXT);
  assert.equal(w.cursor, w.anchor);
  assert.ok(w.cursor <= w.text.length);
  assert.equal(view.window(0, 4001, MAX_IME_TEXT), null);
});

test('byte_deletion_rounds_inward_and_leaves_partial_scalars_whole (code units here)', () => {
  const d = Document.fromText('aé👍b');
  const caret = pos(0, 5);
  assert.deepEqual(imeDeleteSurrounding(d, caret, caret, 1, 0, 'units').before, [4, 5]);
  // Two units start inside the emoji's surrogate pair: it is left whole, only b goes.
  assert.deepEqual(imeDeleteSurrounding(d, caret, caret, 2, 0, 'units').before, [4, 5]);
  assert.deepEqual(imeDeleteSurrounding(d, caret, caret, 3, 0, 'units').before, [2, 5]);
  assert.equal(imeDeleteSurrounding(d, caret, caret, 0, 1, 'units'), null);
  assert.equal(imeDeleteSurrounding(d, caret, caret, 99, 0, 'units'), null);
});

test('byte_deletion_excludes_a_reversed_selection', () => {
  const d = Document.fromText('abcd');
  const del = imeDeleteSurrounding(d, pos(0, 1), pos(0, 3), 1, 1, 'units');
  assert.deepEqual(del.before, [0, 1]);
  assert.deepEqual(del.after, [3, 4]);
  assert.deepEqual([del.anchor, del.focus], [3, 1]);
});

test('tracked_deletions_are_not_counted_for_deletion_or_query', () => {
  const d = docOf(paraWithRuns([['ab', false], ['DEL', true], ['cd', false]]));
  assert.equal(new VisibleParagraph(d.paraAt(pos(0, 0))).window(2, 2, 100).text, 'abcd');
  assert.deepEqual(imeDeleteSurrounding(d, pos(0, 7), pos(0, 7), 1, 0, 'units').before, [6, 7]);
});

test('cross_paragraph_selection_is_unavailable', () => {
  const d = Document.fromText('one\ntwo');
  assert.equal(imeSurrounding(d, pos(0, 1), pos(1, 1)), null);
  assert.equal(imeDeleteSurrounding(d, pos(0, 1), pos(1, 1), 1, 0, 'chars'), null);
});

test('object_expansion_is_never_partly_deleted', () => {
  const d = docOf(eqPara());
  const caret = pos(0, 3);
  const two = imeDeleteSurrounding(d, caret, caret, 2, 0, 'units');
  assert.deepEqual(two.before, [2, 3], 'stored offsets keep the object whole');
  assert.equal(imeDeleteSurrounding(d, caret, caret, 2, 0, 'chars'), null);
  assert.deepEqual(imeDeleteSurrounding(d, caret, caret, 5, 0, 'units').before, [0, 3]);
});

test('trailing_character_deletion_clamps_at_the_paragraph_end', () => {
  const d = Document.fromText('ab\ncd');
  assert.deepEqual(imeDeleteSurrounding(d, pos(0, 1), pos(0, 1), 0, 99, 'chars').after, [1, 2]);
  assert.equal(imeDeleteSurrounding(d, pos(0, 1), pos(0, 1), 0, 0, 'chars'), null, 'nothing to erase');
});

test('alternating_tracked_revisions_map_correctly', () => {
  const parts = Array.from({length: 2000}, (_, i) => [`${i % 2 === 0 ? 'v' : 'D'}${String(i).padStart(4, '0')};`, i % 2 === 1]);
  const p = paraWithRuns(parts);
  const view = new VisibleParagraph(p);
  assert.equal(view.visibleLen(), p.text.length - 6 * 1000);
  assert.equal(view.visibleOffset(p.text.length), view.visibleLen());
  const w = view.window(0, 0, 100);
  assert.ok(w.text.length <= 100);
  assert.ok(!w.text.includes('D'));
});

test('window_budget_is_capped', () => {
  const view = new VisibleParagraph(paragraphWithText('a'.repeat(10_000)));
  assert.equal(view.window(0, 0, Number.MAX_SAFE_INTEGER).text.length, MAX_IME_TEXT);
  assert.equal(imeSurrounding(Document.fromText('a'.repeat(10_000)), pos(0, 0), pos(0, 0), Number.MAX_SAFE_INTEGER).text.length, MAX_IME_TEXT);
});

test('table_cell_paragraph_maps_inside_its_cell', () => {
  const t = newTable(1, 1, 100);
  t.rows[0].cells[0].blocks = [paragraphWithText('cell')];
  const d = docOf(paragraphWithText('outside'), t, newParagraph());
  const w = imeSurrounding(d, {story: BODY, path: [1, 0, 0, 0], off: 4}, {story: BODY, path: [1, 0, 0, 0], off: 2});
  assert.deepEqual([w.text, w.cursor, w.anchor], ['cell', 4, 2]);
});

test('control_markers_are_not_included_in_delete_ranges', () => {
  const p = newParagraph();
  p.text = `pre${OBJ}Ada${OBJ}X`;
  p.runs = [{len: p.text.length}];
  p.objects = [{type: 'controlStart', control: {kind: {type: 'richText'}, placeholderText: 'Enter name'}}, {type: 'controlEnd'}];
  const d = docOf(p);
  const cursor = pos(0, 7);
  const del = imeDeleteSurrounding(d, cursor, cursor, 3, 1, 'units');
  assert.deepEqual(del.before, [4, 7], 'the control-start marker and pre stay outside');
  assert.deepEqual(del.after, [8, 9], 'the control-end marker stays outside; only X goes');
  assert.deepEqual([del.anchor, del.focus], [7, 7]);
});
