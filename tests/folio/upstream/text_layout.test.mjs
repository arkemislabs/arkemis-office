// Ported from printcraft crates/render/src/text/tests.rs at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): the page-text layout and the
// PageText queries core/folio/model/text.mjs translates. Each test names the Rust test it ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {layout, PageText, foldCase} from '../../../core/folio/model/text.mjs';

const emBox = (text, x0, y0, x1, y1) => ({text, rect: [x0, y0, x1, y1], quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], direction: [1, 0]});
const g = (t, x0, y0, x1) => emBox(t, x0, y0, x1, y0 + 10);
function word(v, s, x, y, advance) { [...s].forEach((c, i) => { const x0 = x + i * advance; v.push(g(c, x0, y, x0 + 6)); }); }
const range = (a, b) => [a, b];

test('subscript_stays_in_its_word', () => {
  const glyphs = [emBox('C', 0, 92.5, 5, 100.6), emBox('O', 5, 92.5, 11, 100.6), emBox('2', 11, 97.9, 13.5, 102.6), emBox('-', 13.5, 92.5, 16, 100.6), emBox('E', 16, 92.5, 21, 100.6)];
  assert.equal(layout(glyphs).plainText(), 'CO2-E');
});

test('lines_words_and_search', () => {
  const v = [];
  [...'Hello'].forEach((c, i) => v.push(g(c, 10 + i * 6, 10, 16 + i * 6)));
  [...'world'].forEach((c, i) => v.push(g(c, 50 + i * 6, 10, 56 + i * 6)));
  [...'Next'].forEach((c, i) => v.push(g(c, 10 + i * 6, 30, 16 + i * 6)));
  const t = layout(v);
  assert.equal(t.plainText(), 'Hello world\nNext');
  assert.deepEqual(t.find('WORLD next'), [range(5, 14)]);
  assert.deepEqual(t.find('o'), [range(4, 5), range(6, 7)]);
  assert.equal(t.lineRects(3, 12).length, 2);
  assert.equal(t.nearest(52, 14), 5);
});

test('fake_bold_duplicates_are_removed', () => {
  const v = [];
  [...'Bold'].forEach((c, i) => { const x = 10 + i * 7; v.push(g(c, x, 10, x + 6)); v.push(g(c, x + 0.3, 10, x + 6.3)); });
  assert.equal(layout(v).plainText(), 'Bold');
  const w = [g('e', 10, 10, 16), g('́', 13, 10, 13), g('e', 10, 10, 16), g('́', 13, 10, 13)];
  assert.equal(layout(w).plainText(), 'é');
});

test('two_columns_read_left_then_right_even_if_drawn_interleaved', () => {
  const v = [];
  word(v, 'Left1', 10, 10, 6); word(v, 'Right1', 200, 10, 6); word(v, 'Left2', 10, 24, 6); word(v, 'Right2', 200, 24, 6);
  assert.equal(layout(v).plainText(), 'Left1\nLeft2\nRight1\nRight2');
});

test('rtl_runs_come_out_in_logical_order_and_cjk_has_no_spaces', () => {
  const v = []; word(v, 'םולש', 10, 10, 6);
  assert.equal(layout(v).plainText(), 'שלום');
  const w = []; word(w, '每个字', 10, 10, 9);
  assert.equal(layout(w).plainText(), '每个字');
});

test('word_gaps_follow_position_not_drawing_order', () => {
  const v = []; word(v, '19.4', 40, 10, 6); word(v, '20.0', 10, 10, 6);
  assert.equal(layout(v).plainText(), '20.0 19.4');
  const w = []; word(w, 'םלוע', 10, 10, 6); word(w, 'םולש', 40, 10, 6);
  assert.equal(layout(w).plainText(), 'שלום עולם');
});

test('rtl_line_with_number_and_punctuation_reads_in_logical_order', () => {
  const line = words => { const v = []; let x = 10; for (const w of words) { word(v, w, x, 10, 6); x += [...w].length * 6 + 6; } return layout(v).plainText(); };
  assert.equal(line(['םילקש', '120', 'ריחמ']), 'מחיר 120 שקלים');
  assert.equal(line(['םלוע', 'םולש']), 'שלום עולם');
  assert.equal(line(['Total', 'םולש', 'price']), 'Total שלום price');
});

test('words_and_lines_around_a_glyph', () => {
  const t = new PageText(['a', 'b', ' ', 'c', 'd', 'e', 'f', 'g'].map(s => ({text: s, rect: [0, 0, 0, 0], quad: [[0, 0], [0, 0], [0, 0], [0, 0]], direction: [1, 0]})),
    [0, 0, 0, 0, 0, 1, 1, 1], [false, false, false, false, false, false, true, false]);
  assert.deepEqual(t.wordAt(1), [0, 1]);
  assert.deepEqual(t.wordAt(3), [3, 4]);
  assert.deepEqual(t.wordAt(4), [3, 4]);
  assert.deepEqual(t.wordAt(5), [5, 5]);
  assert.deepEqual(t.wordAt(7), [6, 7]);
  assert.deepEqual(t.lineAt(2), [0, 4]);
  assert.deepEqual(t.lineAt(6), [5, 7]);
  assert.equal(t.wordAt(8), null);
  assert.equal(t.lineAt(8), null);
  assert.equal(new PageText().lineAt(0), null);
});

test('case_folding_keeps_one_character_per_character + turkish_dotted_and_dotless_i_match_in_any_case', () => {
  for (const s of ['İSTANBUL', 'ırmak', 'ΣΟΦΟΣ', 'Straße']) assert.equal([...foldCase(s)].length, [...s].length, s);
  assert.equal(foldCase('İSTANBUL'), 'istanbul');
  assert.equal(foldCase('IRMAK'), foldCase('ırmak'));
});

test('a_degenerate_or_nan_quad_holds_no_point (nearest falls back to the closest box)', () => {
  const t = new PageText([{text: 'x', rect: [0, 0, 10, 10], quad: [[NaN, 0], [10, 0], [10, 10], [0, 10]], direction: [1, 0]}], [0], [false]);
  assert.equal(t.nearest(5, 5), 0);
});
