// Ported from deckcraft crates/engine/src/cmd/find.rs `mod tests` and crates/engine/src/tests.rs
// `find_and_replace_across_shapes_and_notes` at f893f6af7d36a5409fd804e81a34fd895cfefedf.
//
// 1. ArtCraft: cmd/find.rs (`find`:184, `replace`:199: matches in slide text, table cells and notes,
//    never across a line break or into a field; Replace takes the first run's formatting);
//    PowerPoint: Home › Editing › Find / Replace (Match case, Find whole words only).
// 2. Ours: the same search and splice over the schema-2 bodies; offsets in UTF-16.
// 3. These tests + tests/prism/find.test.mjs (dialog model) + tests/e2e/prism/find-replace.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {matches, paraMatches, splice} from '../../../core/prism/commands/find.mjs';
import {paraText, bodyText} from '../../../core/prism/model/text.mjs';
import {withNew, rect} from './text_deck.mjs';

const opts = (t, c, w) => ({pat: [...t], case: c, whole: w});
const textRun = t => ({text: t});
const br = () => ({text: '', kind: {kind: 'break'}});

test('matching_honours_case_and_whole_words', () => {
  const t = [...'Cat cat category'];
  assert.equal(matches(opts('cat', false, false), t).length, 3);
  assert.equal(matches(opts('cat', true, false), t).length, 2);
  assert.deepEqual(matches(opts('cat', false, true), t), [[0, 3], [4, 7]]);
});

test('a_match_never_spans_a_line_break', () => {
  assert.deepEqual(paraMatches({runs: [textRun('a'), br(), textRun('b')]}, opts('ab', true, false)), []);
});

test('offsets_count_a_line_break_as_one_char', () => {
  assert.deepEqual(paraMatches({runs: [textRun('ab'), br(), textRun('cd')]}, opts('cd', true, false)), [[3, 5]]);
});

test('splice_after_a_line_break_keeps_the_break', () => {
  const p = splice({runs: [textRun('ab'), br(), textRun('cd')]}, 3, 5, 'X');
  assert.equal(paraText(p), 'ab\u000bX');
  assert.equal(p.runs[1].kind.kind, 'break');
});

test('splice_across_runs_keeps_the_first_runs_format', () => {
  const bold = {bold: true};
  const p = splice({runs: [{text: 'Hel', props: bold}, {text: 'lo world'}]}, 1, 5, 'ola');
  assert.equal(paraText(p), 'Hola world');
  assert.equal(p.runs[0].text, 'Hola');
  assert.deepEqual(p.runs[0].props, bold);
});

test('find_and_replace_across_shapes_and_notes', async () => {
  const t = await withNew({shapes: [rect('500', [100, 100, 200, 100], 'Old plan, old team\nboldly')]});
  await t.exec('slide.notes', {text: 'Discuss the old plan'});
  const q = {text: 'old'};
  const found = (await t.exec('text.find', q)).result;
  const n = found.length;
  assert.ok(n >= 3, JSON.stringify(found));
  const whole = (await t.exec('text.find', {text: 'old', wholeWords: true, matchCase: true})).result;
  assert.equal(whole.length, n - 2, 'Old and boldly are not whole lower-case matches');
  const first = found[0];
  assert.deepEqual([first.para, first.start], [0, 0]);
  await t.exec('text.replace', {text: 'old', with: 'New', at: first});
  assert.equal((await t.exec('text.find', q)).result.length, n - 1);
  const r = await t.exec('text.replace', {text: 'old', with: 'new', wholeWords: true});
  assert.equal(r.result.replaced, n - 2);
  const text = t.content.slides[0].shapes.filter(x => x.text).map(x => bodyText(x.text)).join('|');
  assert.ok(text.includes('New plan, new team\nboldly'), text);
  await assert.rejects(t.exec('text.replace', {text: 'zebra', with: 'x'}));
  await t.undo();
  assert.equal((await t.exec('text.find', q)).result.length, n - 1);
});
