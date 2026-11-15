// Ported from wordcraft crates/layout/src/kinsoku.rs (mod tests) and para.rs/bidi.rs helpers at
// aadb077e072b7de05f724e359d8db82e151f125c. `uax14` stands for the unicode-linebreak crate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyKinsoku, autoSpace, uax14} from '../../../core/quill/layout/para/linebreak.mjs';
import {bidiLevels, visualOrder} from '../../../core/quill/layout/para/bidi.mjs';

const cp = s => s.codePointAt(0);

test('auto_space_pairs', () => {
  assert.equal(autoSpace(cp('院'), cp('9'), true, true), 'left');
  assert.equal(autoSpace(cp('A'), cp('カ'), true, true), 'right');
  assert.equal(autoSpace(cp('院'), cp('9'), true, false), null);
  assert.equal(autoSpace(cp('A'), cp('字'), false, true), null);
  for (const [a, b] of [['5', '、'], ['、', '8'], ['漢', '%'], ['漢', '한'], ['한', 'A'], ['a', 'b'], ['漢', '字'], ['漢', '１']]) {
    assert.equal(autoSpace(cp(a), cp(b), true, true), null, a + b);
  }
});

function breaks(text, kinsoku, wordWrap) {
  const opps = applyKinsoku(text, uax14(text).filter(i => i < text.length), kinsoku, wordWrap);
  return opps.map(i => String.fromCodePoint(text.codePointAt(i)));
}

test('kinsoku_and_word_wrap_break_opportunities', () => {
  const ja = '日本語、「漢字」。テスト';
  const on = breaks(ja, true, true);
  for (const c of ['、', '」', '。', '漢']) assert.ok(!on.includes(c), `kinsoku: no line starts with ${c}: ${on}`);
  assert.ok(on.includes('「'), `a line may start at an opening bracket: ${on}`);
  assert.ok(on.includes('テ'), String(on));
  const off = breaks(ja, false, true);
  for (const c of ['、', '」', '。', '漢']) assert.ok(off.includes(c), `kinsoku off: a line may start with ${c}: ${off}`);
  const en = 'Hello wonderful (world), 50%.';
  assert.deepEqual(breaks(en, true, true), breaks(en, false, true));
  assert.deepEqual(breaks(en, true, true), ['w', '(', '5']);
  assert.deepEqual(breaks('Hello café', true, false), ['e', 'l', 'l', 'o', 'c', 'a', 'f', 'é']);
});

// para/bidi.rs: visual order (L2) and levels of mixed text.
test('visual_order_reverses_right_to_left_runs', () => {
  assert.deepEqual(visualOrder([0, 0, 1, 1, 1, 0]), [0, 1, 4, 3, 2, 5]);
  assert.deepEqual(visualOrder([1, 1, 2, 2, 1]), [4, 2, 3, 1, 0]);
  assert.deepEqual(visualOrder([0, 0]), [0, 1]);
});

test('bidi_levels_of_mixed_text', () => {
  assert.deepEqual(bidiLevels('abc', false), []);
  const lv = bidiLevels('ab שלום cd', false);
  assert.deepEqual(lv, [0, 0, 0, 1, 1, 1, 1, 0, 0, 0]);
  // Numbers in right-to-left text read left to right (level 2).
  assert.deepEqual(bidiLevels('שלום 12', true), [1, 1, 1, 1, 1, 2, 2]);
  // Arabic digits after Arabic letters are AN.
  assert.deepEqual(bidiLevels('سلام ١٢', false), [1, 1, 1, 1, 1, 2, 2]);
});
