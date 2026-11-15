// Spelling in PowerPoint (U:prism/spelling): review.spelling (the pane), the list, the right-click menu word and its commands, Ignore / Ignore All /
// Add, the slide issues the squiggles draw (the word the caret is in left alone), and what is left unchecked. The dictionary is the bundled en_US one.
import test from 'node:test';
import assert from 'node:assert/strict';
import review from '../../core/prism/commands/review.mjs';
import panes from '../../core/prism/commands/panes.mjs';
import {withNew, curSlide, shapeOf} from '../prism/upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {shape, presetGeom} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {resetSpelling, spelling} from '../../core/common/lib/spelling.mjs';
import {spellingIssues, spellingIssuesAll} from '../../core/prism/lib/spelling-issues.mjs';

const deck = async (opts = {}) => withNew({extra: [review, panes], ...opts});
const tb = (id, text, [x, y, w, h] = [50, 100, 400, 60]) => shape({id, name: `Text ${id}`, textBox: true, xfrm: {x, y, w, h}, geom: presetGeom('rect'), text: bodyFromText(text)});
const bodyOf = (t, id) => shapeOf(t, id).text.paragraphs.map(p => p.runs.map(r => r.text ?? '').join('')).join('\n');

test.beforeEach(() => resetSpelling());

test('review.spelling opens the Spelling pane on the first misspelt word, selects its shape and returns the list', async () => {
  const t = await deck({shapes: [tb('93', 'The team will recieve it. A seperate plan.'), tb('94', 'All good here')]});
  const list = (await t.exec('review.spelling', {})).result;
  assert.deepEqual(list.map(i => i.word), ['recieve', 'seperate']);
  assert.equal(list[0].suggestions[0], 'receive');
  assert.deepEqual([list[0].slide, list[0].shape, list[0].start], [0, '93', 14]);
  assert.equal(t.doc.view.panes.spelling, true, 'the pane is open');
  assert.equal(t.doc.view.paneRequest.pane, 'spelling');
  assert.ok(String(t.doc.selection.ranges[0].anchor).includes('93'), JSON.stringify(t.doc.selection));
  const quiet = (await t.exec('review.spelling', {open: false})).result;
  assert.equal(quiet.length, 2);
  assert.equal(t.doc.view.panes.spelling, true);
});

test('words in other languages, with numbers, in capitals and in addresses are left out; repeated words are found', async () => {
  const t = await deck({shapes: [tb('93', 'NASA teh2 x7 see http://example.com/teh and the the end, plus recieve')]});
  const list = (await t.exec('review.spellingList', {})).result;
  assert.deepEqual(list.map(i => [i.word, !!i.repeated]).sort(), [['recieve', false], ['the', true]]);
  const fr = await deck({shapes: [tb('95', 'bonjour recieve')]});
  const sh = shapeOf(fr, '95');
  sh.text.paragraphs[0].runs.forEach(r => { r.props = {...(r.props ?? {}), lang: 'fr-FR'}; });
  assert.equal((await fr.exec('review.spellingList', {})).result.length, 0, 'French text is not checked with the English dictionary');
});

test('the right-click menu word: set from an issue, suggestions as a dynamic list, Change as one undo step, hidden when there is none', async () => {
  const t = await deck({shapes: [tb('93', 'We recieve it, we the the end.')]});
  for (const id of ['review.spellingApply', 'review.spellingDeleteRepeat']) assert.equal(t.state(id).hidden, true, `${id} hidden without a word`);
  const hit = (await t.exec('review.spellingMenu', {start: 3})).result;
  assert.equal(hit.word, 'recieve');
  const list = t.state('review.spellingApply');
  assert.equal(list.value[0].value, 'receive');
  assert.equal(t.state('review.spellingDeleteRepeat').hidden, true, 'not a repeated word');
  await expectUndoRoundTrip(t, 'review.spellingApply', {text: 'receive'});
  assert.equal(bodyOf(t, '93'), 'We receive it, we the the end.');
  assert.equal(t.doc.view.spellMenu ?? null, null, 'Change clears the menu word');
  // A repeated word: Delete Repeated Word.
  const rep = (await t.exec('review.spellingMenu', {start: 22})).result;
  assert.equal(rep.repeated, true);
  assert.equal(t.state('review.spellingApply').hidden, true, 'no suggestions for a repeated word');
  await t.exec('review.spellingDeleteRepeat', {});
  assert.equal(bodyOf(t, '93'), 'We receive it, we the end.');
});

test('Ignore is one place, Ignore All every case, Recheck brings them back, Add to Dictionary is kept in the prefs', async () => {
  const t = await deck({shapes: [tb('93', 'teh cat and Teh dog and teh end')]});
  let list = (await t.exec('review.spellingList', {})).result;
  assert.equal(list.length, 3);
  await t.exec('review.ignoreOnce', {key: list[0].key});
  assert.equal((await t.exec('review.spellingList', {})).result.length, 2);
  await t.exec('review.ignoreAll', {word: 'TEH'});
  assert.equal((await t.exec('review.spellingList', {})).result.length, 0);
  await t.exec('review.spellingRecheck', {});
  assert.equal((await t.exec('review.spellingList', {})).result.length, 3);
  const u = await deck({shapes: [tb('93', 'We use Arkemis daily')]});
  assert.equal((await u.exec('review.spellingList', {})).result.length, 1);
  await u.exec('review.addToDictionary', {word: 'Arkemis'});
  assert.deepEqual(u.session.prefs.userDictionary, ['Arkemis']);
  assert.equal((await u.exec('review.spellingList', {})).result.length, 0);
  await assert.rejects(u.exec('review.addToDictionary', {word: 'two words'}), /single word/);
  list = [];
  void list;
});

test('the slide issues the squiggles draw: this slide only, the word the caret is in left alone, Ignore All hides a word', async () => {
  const t = await deck({shapes: [tb('93', 'one recieve and a seperate word')]});
  const sp = spelling();
  const doc = t.content;
  await spellingIssuesAll(doc, undefined, [], {sp, session: 's', slide: 0});
  const all = spellingIssues(doc, undefined, [], {sp, session: 's', slide: 0});
  assert.deepEqual(all.map(i => i.word), ['recieve', 'seperate']);
  const typing = spellingIssues(doc, undefined, [], {sp, session: 's', slide: 0, caret: {shape: '93', cell: null, para: 0, off: 11}});
  assert.deepEqual(typing.map(i => i.word), ['seperate'], 'the caret is at the end of recieve');
  assert.deepEqual(spellingIssues(doc, undefined, ['seperate'], {sp, session: 's', slide: 0}).map(i => i.word), ['recieve']);
  sp.ignoreAll('s', 'recieve');
  assert.deepEqual(spellingIssues(doc, undefined, [], {sp, session: 's', slide: 0}).map(i => i.word), ['seperate']);
  assert.equal(spellingIssues(doc, undefined, [], {sp, session: 's', slide: 5}).length, 0, 'no such slide');
});

test('review.dictionary says US English ships, others are not checked; the notes are read too', async () => {
  const t = await deck({shapes: [tb('93', 'fine')]});
  await t.exec('slide.notes', {text: 'teh notes'});
  const d = (await t.exec('review.dictionary', {})).result;
  assert.deepEqual([d.lang, d.available, d.found], ['en-US', true, 'bundled']);
  assert.equal((await t.exec('review.dictionary', {lang: 'de-DE'})).result.available, false);
  const list = (await t.exec('review.spellingList', {})).result;
  assert.ok(list.some(i => i.notes && i.word === 'teh'));
  void curSlide;
});
