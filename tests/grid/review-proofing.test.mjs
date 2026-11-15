// U:grid/review: Spelling (check, Change, Change All, Ignore Once, Ignore All, Add to Dictionary), the Thesaurus, Check Performance with
// Clean Excess Cell Formatting, and Hide Ink.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/spelling.rs (`spelling` checks the text cells that hold no formula; `change` replaces one word of one cell
//    or, with `all`, every cell; `add_word`). The bundled en_US dictionary replaces its system word list. Ignore Once, Ignore All, the Thesaurus's
//    synonyms and Replace, Check Performance and Hide Ink are Excel's own: not checked against upstream.
// 2. Ours: review.spelling, review.spellingSuggest, review.changeSpelling, review.ignoreOnce, review.ignoreAll, review.addToDictionary, review.thesaurus
//    (core/grid/commands/review/proofing.mjs), review.checkPerformance, review.cleanExcessFormatting, review.hideInk (review/checks.mjs).
// 3. These tests; tests/e2e/grid/review.e2e.mjs drives the dialogs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, run, fails, v, text} from './edit-helpers.mjs';
import {resetSpelling} from '../../core/common/lib/spelling.mjs';
import {checkPerformance} from '../../core/grid/commands/review/checks.mjs';
import spellingDialog from '../../core/grid/dialogs/spelling.mjs';
import thesaurusDialog from '../../core/grid/dialogs/thesaurus.mjs';
import checkDialog from '../../core/grid/dialogs/checkPerformance.mjs';
import {swapWord} from '../../core/grid/commands/review/proofing.mjs';

async function sheet(rows = [
  ['We recieve the order', 12, 'okay text'],
  ['teh quick fox', '=A1&"x"', 'separate recieve'],
  ['Fine words only', 'ALLCAPSWRD', 'abc123 teh'],
]) {
  resetSpelling();
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: rows});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}
const issues = async (t, p = {}) => (await run(t, 'review.spelling', p)).issues;
const words = list => list.map(i => `${i.cell}:${i.word}`);

test('Spelling checks text cells only, in reading order, with suggestions', async () => {
  const t = await sheet();
  const r = await run(t, 'review.spelling', {});
  assert.deepEqual(words(r.issues), ['A1:recieve', 'A2:teh', 'C2:recieve', 'C3:teh']);
  assert.equal(r.complete, false);
  assert.equal(r.issues[0].start, 3);
  assert.equal(r.issues[0].end, 10);
  assert.equal(r.issues[0].text, 'We recieve the order');
  assert.ok(r.issues[0].suggestions.includes('receive'), 'the dictionary suggests receive');
  assert.ok(r.issues[1].suggestions.length >= 1);
  // The formula cell B2 (="..."x), the number, the ALL CAPS word and the word with digits are left alone.
  assert.ok(!words(r.issues).some(w => /^B\d|ALLCAPS|abc123/.test(w)));
  const s = await run(t, 'review.spellingSuggest', {word: 'Recieve'});
  assert.ok(s[0] === 'Receive' || s.includes('Receive'), 'capital in, capital out');
});

test('the check starts at the active cell and goes on from the top; a selection of several cells limits it', async () => {
  const t = await sheet();
  await run(t, 'selection.set', {range: 'B2'});
  const r = await run(t, 'review.spelling', {});
  assert.deepEqual(words(r.issues), ['C2:recieve', 'C3:teh', 'A1:recieve', 'A2:teh']);
  assert.deepEqual(r.issues.map(i => i.wrapped), [false, false, true, true]);
  await run(t, 'selection.set', {range: 'A2:A3'});
  assert.deepEqual(words(await issues(t)), ['A2:teh']);
  assert.deepEqual(words(await issues(t, {range: 'C1:C3'})), ['C2:recieve', 'C3:teh']);
  assert.deepEqual(words(await issues(t, {range: 'C1:C3', ignore: ['recieve']})), ['C3:teh']);
});

test('Change replaces one word of one cell; Change All every cell; both keep the other text', async () => {
  const t = await sheet();
  const first = (await issues(t))[0];
  await run(t, 'review.changeSpelling', {cell: first.cell, word: first.word, to: 'receive', start: first.start});
  assert.equal(text(t, 'A1'), 'We receive the order');
  assert.equal(text(t, 'C2'), 'separate recieve', 'one cell only');
  const done = await run(t, 'review.changeSpelling', {word: 'recieve', to: 'receive', all: true});
  assert.equal(done.changed, 1);
  assert.equal(text(t, 'C2'), 'separate receive');
  assert.match((await fails(t, 'review.changeSpelling', {cell: 'A1', word: 'recieve', to: 'x'})).message, /no longer in A1/);
  assert.match((await fails(t, 'review.changeSpelling', {cell: 'B1', word: 'recieve', to: 'x'})).message, /holds no text/);
  assert.equal(v(t, 'B1'), 12, 'a number stays');
  assert.deepEqual(words(await issues(t)), ['A2:teh', 'C3:teh']);
  await run(t, 'edit.undo', {});
  assert.deepEqual(words(await issues(t)), ['A2:teh', 'C2:recieve', 'C3:teh'], 'undo brings the Change All back');
});

test('swapWord replaces whole words only, keeps case of the rest, and changes every one with all', () => {
  assert.deepEqual(swapWord('teh tehran teh', 'teh', 'the', undefined, true), {text: 'the tehran the', changed: 2});
  assert.deepEqual(swapWord('teh tehran teh', 'teh', 'the', 11, false), {text: 'teh tehran the', changed: 1});
  assert.deepEqual(swapWord('a recieve, recieve.', 'recieve', 'receive', undefined, false), {text: 'a receive, recieve.', changed: 1});
  assert.equal(swapWord('nothing', 'teh', 'the', undefined, true), null);
});

test('Ignore Once hides one place, Ignore All a word everywhere, Add to Dictionary keeps it in the preferences', async () => {
  const t = await sheet();
  const [a1, a2] = await issues(t);
  await run(t, 'review.ignoreOnce', {key: a1.key});
  assert.deepEqual(words(await issues(t)), ['A2:teh', 'C2:recieve', 'C3:teh'], 'only that place');
  await run(t, 'review.ignoreAll', {word: 'RECIEVE'});
  assert.deepEqual(words(await issues(t)), ['A2:teh', 'C3:teh'], 'any case, everywhere');
  await run(t, 'review.addToDictionary', {word: 'teh'});
  assert.deepEqual(words(await issues(t)), []);
  assert.deepEqual(t.session.prefs?.userDictionary, ['teh']);
  assert.match((await fails(t, 'review.addToDictionary', {word: 'two words'})).message, /single word/);
  assert.ok(a2.suggestions.length >= 1);
});

test('a locked cell on a protected sheet refuses Change, and Change All leaves it alone', async () => {
  const t = await sheet();
  await run(t, 'review.protectSheet', {});
  const e = await fails(t, 'review.changeSpelling', {cell: 'A1', word: 'recieve', to: 'receive'});
  assert.match(e.message, /protected/);
  const all = await run(t, 'review.changeSpelling', {word: 'recieve', to: 'receive', all: true}).catch(x => x);
  assert.ok(all instanceof Error || all.changed === 0);
  assert.equal(text(t, 'A1'), 'We recieve the order');
});

test('the Spelling dialog starts empty (its body reads review.spelling) and submits nothing', async () => {
  const t = await sheet();
  assert.equal(spellingDialog.id, 'dialog.spelling');
  assert.deepEqual(spellingDialog.init(t.session.readContext(t.docId)), {});
  assert.deepEqual(spellingDialog.validate({}), []);
});

test('the Thesaurus lists meanings of the active cell word and Replace puts a synonym in the cell', async () => {
  const t = await sheet([['quick', 12], ['two words', '']]);
  const r = await run(t, 'review.thesaurus', {});
  assert.equal(r.word, 'quick');
  assert.ok(r.senses.length >= 1 && r.senses[0].synonyms.length >= 1);
  const syn = r.senses[0].synonyms[0];
  const d = thesaurusDialog.init(t.session.readContext(t.docId));
  assert.equal(d.word, 'quick');
  assert.equal(thesaurusDialog.validate({...d, picked: ''}).length, 1);
  assert.deepEqual(thesaurusDialog.toCommand({...d, picked: syn}), {command: 'review.thesaurus', params: {to: syn}});
  await run(t, 'review.thesaurus', {to: syn});
  assert.equal(text(t, 'A1'), syn);
  assert.deepEqual((await run(t, 'review.thesaurus', {word: 'zzzzqq'})).senses, []);
  await run(t, 'selection.set', {range: 'B1'});
  assert.match((await fails(t, 'review.thesaurus', {to: 'x'})).message, /text cell/);
});

test('Check Performance lists excess formatting, volatile functions and whole column references; Clean Excess Cell Formatting fixes the first', async () => {
  resetSpelling();
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [[1, 2], [3, '=SUM(A:A)'], ['=NOW()', '=OFFSET(A1,1,0)']]});
  await run(t, 'home.bold', {range: 'F10:G12'});
  const r = await run(t, 'review.checkPerformance', {});
  const kinds = r.findings.map(f => f.kind).sort();
  assert.deepEqual(kinds, ['excess', 'volatile', 'whole']);
  const excess = r.findings.find(f => f.kind === 'excess');
  assert.equal(excess.count, 6);
  assert.match(excess.detail, /F10/);
  assert.equal(r.findings.find(f => f.kind === 'volatile').count, 2);
  assert.equal(r.findings.find(f => f.kind === 'whole').count, 1);
  assert.deepEqual(checkDialog.init(t.session.readContext(t.docId)).findings.map(f => f.kind).sort(), kinds);
  const done = await run(t, 'review.cleanExcessFormatting', {sheet: 'Sheet1'});
  assert.equal(done.cleaned, 6);
  assert.ok(!(await run(t, 'review.checkPerformance', {})).findings.some(f => f.kind === 'excess'));
  assert.equal(checkPerformance(t.session.readContext(t.docId)).findings.length, 2);
  assert.match((await fails(t, 'review.cleanExcessFormatting', {sheet: 'Sheet1'})).message, /no unused formatting/);
});

test('Hide Ink toggles a view flag that the sheet reads', async () => {
  resetSpelling();
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  assert.deepEqual(await run(t, 'review.hideInk', {}), {on: true});
  assert.equal(t.session.get(t.docId).view.hideInk, true);
  assert.deepEqual(await run(t, 'review.hideInk', {on: false}), {on: false});
  assert.equal(t.session.get(t.docId).view.hideInk, false);
});

test('Undo Last takes back Ignore Once, Ignore All and Add to Dictionary', async () => {
  const t = await sheet();
  const [a1] = await issues(t);
  await run(t, 'review.ignoreOnce', {key: a1.key});
  assert.ok(!words(await issues(t)).includes('A1:recieve'));
  await run(t, 'review.undoSpelling', {action: 'ignoreOnce', key: a1.key});
  assert.ok(words(await issues(t)).includes('A1:recieve'));
  await run(t, 'review.ignoreAll', {word: 'recieve'});
  assert.ok(!words(await issues(t)).some(w => /recieve/.test(w)));
  await run(t, 'review.undoSpelling', {action: 'ignoreAll', word: 'recieve'});
  assert.ok(words(await issues(t)).includes('C2:recieve'));
  await run(t, 'review.addToDictionary', {word: 'teh'});
  assert.deepEqual(t.session.prefs?.userDictionary, ['teh']);
  assert.ok(!words(await issues(t)).includes('A2:teh'));
  await run(t, 'review.undoSpelling', {action: 'add', word: 'teh'});
  assert.deepEqual(t.session.prefs?.userDictionary, []);
  assert.ok(words(await issues(t)).includes('A2:teh'));
  assert.match((await fails(t, 'review.undoSpelling', {action: 'ignoreOnce'})).message, /key/);
});
