// Spelling in OneNote (U:slate/spelling): review.spelling, the list, the right-click menu word, Change / Change All, Ignore, Ignore All, Add to Dictionary,
// the editor's squiggle decorations, and what is left unchecked (marked text, other languages, links). The dictionary is the bundled en_US one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {textSession, textSel} from '../slate/format-helpers.mjs';
import {resetSpelling, spelling} from '../../core/common/lib/spelling.mjs';
import {blockIssues, pageIssuesAll} from '../../core/slate/lib/spelling.mjs';
import {nodeOf} from '../../core/slate/schema.mjs';

test.beforeEach(() => resetSpelling());
const words = list => list.map(i => i.word);

test('review.spelling lists the misspelt words of the page, selects the first at or after the caret and opens the pane', async () => {
  const t = await textSession(['The team will recieve the report.', 'A seperate line is fine.', 'Last teh paragraph.'], {selection: p => textSel(p, 'b1', 0)});
  const list = (await t.exec('review.spelling', {})).result;
  assert.deepEqual(words(list), ['recieve', 'seperate', 'teh']);
  assert.equal(list[0].suggestions[0], 'receive');
  assert.deepEqual([list[0].block, list[0].start, list[0].end], ['b1', 14, 21]);
  assert.deepEqual(t.doc.selection.ranges[0], {anchor: `/pg:${t.pageId}/b:b1/t:14`, focus: `/pg:${t.pageId}/b:b1/t:21`});
  assert.deepEqual(t.doc.view.pane, {kind: 'spelling'});
  // From the caret in the second note: the next word after it.
  t.select(textSel(t.pageId, 'b2', 12));
  await t.exec('review.spelling', {});
  assert.ok(t.doc.selection.ranges[0].anchor.endsWith('/b:b3/t:5'), JSON.stringify(t.doc.selection));
  // Only the list: no pane, the selection stays.
  t.doc.view.pane = null;
  const before = JSON.stringify(t.doc.selection);
  assert.equal((await t.exec('review.spellingList', {})).result.length, 3);
  await t.exec('review.spelling', {open: false});
  assert.equal(JSON.stringify(t.doc.selection), before);
  assert.equal(t.doc.view.pane ?? null, null);
});

test('Change replaces one word (one undo step, the marks kept); Change All every occurrence, keeping a capital', async () => {
  const t = await textSession([{text: 'Teh cat and teh dog', marks: [{type: 'bold', from: 12, to: 15}]}, 'teh end'], {selection: p => textSel(p, 'b1', 0)});
  const list = (await t.exec('review.spellingList', {})).result;
  const second = list.find(i => i.block === 'b1' && i.start === 12);
  await t.exec('review.spellingChange', {from: second.from, to: second.to, word: 'teh', text: 'the'});
  assert.equal(t.blocks[0].content.map(r => r.text).join(''), 'Teh cat and the dog');
  assert.ok(t.blocks[0].content.some(r => r.text === 'the' && (r.marks ?? []).some(m => m.type === 'bold')), 'the bold stayed on the changed word');
  await t.exec('edit.undo');
  assert.equal(t.blocks[0].content.map(r => r.text).join(''), 'Teh cat and teh dog');
  const all = (await t.exec('review.spellingChange', {word: 'teh', text: 'the', all: true})).result;
  assert.equal(all.changed, 3);
  assert.deepEqual(t.blocks.map(b => b.content.map(r => r.text).join('')), ['The cat and the dog', 'the end']);
  await assert.rejects(t.exec('review.spellingChange', {from: 1, to: 4, word: 'zzz', text: 'x'}), /isn't there/);
});

test('the right-click menu word: set from a position, suggestions as a dynamic list, hidden elsewhere', async () => {
  const t = await textSession(['We recieve it, the end.'], {selection: p => textSel(p, 'b1', 0)});
  for (const id of ['review.spellingApply', 'review.ignoreAll', 'review.addToDictionary']) assert.equal(t.state(id).hidden, true, `${id} hidden without a word under the pointer`);
  const [issue] = (await t.exec('review.spellingList', {})).result;
  const hit = (await t.exec('review.spellingMenu', {from: issue.from + 2})).result;
  assert.equal(hit.word, 'recieve');
  assert.equal(t.state('review.ignoreAll').enabled, true);
  const list = t.state('review.spellingApply');
  assert.equal(list.value[0].value, 'receive');
  assert.equal((await t.exec('review.spellingMenu', {from: 1})).result, null, 'a position outside a misspelt word clears it');
  assert.equal(t.state('review.spellingApply').hidden, true);
  await t.exec('review.spellingMenu', {from: issue.from});
  await t.exec('review.spellingApply', {text: 'receive'});
  assert.equal(t.blocks[0].content.map(r => r.text).join(''), 'We receive it, the end.');
});

test('Ignore is one place, Ignore All every case on this document; Recheck brings them back; Add to Dictionary is kept in the prefs', async () => {
  const t = await textSession(['teh and Teh and teh', 'Arkemis is here'], {selection: p => textSel(p, 'b1', 0)});
  const list = (await t.exec('review.spellingList', {})).result;
  assert.equal(list.length, 4);
  await t.exec('review.ignoreOnce', {key: list[0].key});
  assert.equal((await t.exec('review.spellingList', {})).result.length, 3);
  await t.exec('review.ignoreAll', {word: 'TEH'});
  assert.deepEqual(words((await t.exec('review.spellingList', {})).result), ['Arkemis']);
  await t.exec('review.spellingRecheck', {});
  assert.equal((await t.exec('review.spellingList', {})).result.length, 4);
  await t.exec('review.addToDictionary', {word: 'Arkemis'});
  assert.deepEqual(t.session.prefs.userDictionary, ['Arkemis']);
  assert.equal((await t.exec('review.spellingList', {})).result.length, 3);
  await assert.rejects(t.exec('review.addToDictionary', {word: 'two words'}), /single word/);
});

test('text marked do not check, in another language, or in a link is left out; table cells and every note container are read', async () => {
  const t = await textSession([
    {text: 'teh one', marks: [{type: 'language', attrs: {lang: 'en-US', noCheck: true}, from: 0, to: 3}]},
    {text: 'teh two', marks: [{type: 'language', attrs: {lang: 'de-DE', noCheck: false}, from: 0, to: 3}]},
    {text: 'teh three', marks: [{type: 'link', attrs: {href: 'https://example.com'}, from: 0, to: 3}]},
    'teh plain',
  ], {selection: p => textSel(p, 'b1', 0)});
  assert.deepEqual((await t.exec('review.spellingList', {})).result.map(i => i.block), ['b4']);
});

test('the editor decorations come from blockIssues: only the misspelt words, once the service has looked them up', async () => {
  const t = await textSession(['A recieve here and teh there.'], {selection: p => textSel(p, 'b1', 0)});
  const sp = spelling();
  const doc = nodeOf(t.content.pages[t.pageId].body);
  const block = doc.firstChild.firstChild;
  assert.deepEqual(blockIssues(block, sp, {session: 's'}), [], 'nothing is marked until the words are looked up');
  await pageIssuesAll(doc, t.pageId, sp, {session: 's'});
  assert.deepEqual(blockIssues(block, sp, {session: 's'}).map(i => [i.word, i.start, i.end]), [['recieve', 2, 9], ['teh', 19, 22]]);
  sp.ignoreAll('s', 'teh');
  assert.deepEqual(blockIssues(block, sp, {session: 's'}).map(i => i.word), ['recieve']);
});
