// core/folio/commands/find.mjs: the find bar and Advanced search.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/ui-egui/src/canvas/find.rs, panels/search_ui.rs, commands.rs edit.find /
//    edit.advanced_search): a search lists every match on every page in document order; the current one is the first at or
//    after the page shown, and wraps round to the first when none follows; next and previous wrap round; Whole words only
//    and Case-sensitive search again; the Search panel lists each match with 36 glyphs of context on each side, by page,
//    and shares the bar's search; closing the panel moves the search back to the bar. Acrobat's Find does the same.
// 2. Ours does the same on a real PDF. Printcraft searches page text only: bookmarks, comments and Replace are not offered.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {firstAtOrAfter} from '../../core/folio/commands/find.mjs';

after(() => releaseTextSources());
const open = () => createTestSession('folio', {fixture: 'textPages'});
const find = t => t.doc.view.find;

test('first at or after: the search wraps round the document', () => {
  const m = [[1, 0, 3], [1, 8, 11], [3, 2, 5]];
  assert.equal(firstAtOrAfter(m, 0), 0);
  assert.equal(firstAtOrAfter(m, 2), 2);
  assert.equal(firstAtOrAfter(m, 4), 0, 'nothing follows: the first match');
  assert.equal(firstAtOrAfter([], 0), null);
});

test('Find opens the bar; a query lists every match in document order with its context; the first one at or after the page shown is current', async () => {
  const t = await open();
  const r = await t.exec('edit.find', {});
  assert.equal(r.result.open, true);
  assert.equal(find(t).open, true);
  const found = await t.exec('edit.find', {query: 'quick brown'});
  assert.equal(found.result.matches, 2, 'one on each page');
  assert.deepEqual(find(t).matches.map(m => m[0]), [0, 1]);
  assert.equal(find(t).current, 0);
  assert.equal(find(t).matches[0][4], 'quick brown');
  assert.match(find(t).matches[0][3], /es they mark, one quad per line\. The$/, 'the context before it, as one line of words');
  assert.match(find(t).matches[0][5], /^fox jumps over the lazy dog\./);
  assert.equal((await t.session.state(t.docId, 'edit.find', {})).value, 'quick brown', 'the combo shows the query');
  const nothing = await t.exec('edit.find', {query: 'zebra'});
  assert.equal(nothing.result.matches, 0);
  assert.equal(find(t).current, null);
});

test('Next and Previous step through the matches and wrap round; they are off without matches', async () => {
  const t = await open();
  assert.equal((await t.session.state(t.docId, 'find.step', {forward: true})).enabled, false);
  await t.exec('edit.find', {query: 'the'});
  const n = find(t).matches.length;
  assert.ok(n >= 4);
  const rev0 = find(t).rev;
  await t.exec('find.step', {forward: true});
  assert.equal(find(t).current, 1);
  assert.ok(find(t).rev > rev0, 'each move is a revision the page view follows');
  await t.exec('find.step', {forward: false});
  await t.exec('find.step', {forward: false});
  assert.equal(find(t).current, n - 1, 'previous from the first wraps to the last');
  await t.exec('find.step', {forward: true});
  assert.equal(find(t).current, 0, 'next from the last wraps to the first');
  await t.exec('find.goto', {match: 3});
  assert.equal(find(t).current, 2);
});

test('Whole words only and Case-sensitive search again', async () => {
  const t = await open();
  await t.exec('edit.find', {query: 'qui'});
  assert.ok(find(t).matches.length >= 2, 'a part of a word');
  await t.exec('find.option', {option: 'Whole words only'});
  assert.equal(find(t).wholeWords, true);
  assert.equal(find(t).matches.length, 0);
  assert.equal((await t.session.state(t.docId, 'find.option', {option: 'Whole words only'})).checked, true);
  await t.exec('find.option', {option: 'Whole words only'});
  await t.exec('edit.find', {query: 'QUICK'});
  assert.equal(find(t).matches.length, 2, 'case does not matter by default');
  await t.exec('find.option', {option: 'Case-sensitive'});
  assert.equal(find(t).matches.length, 0);
  await t.exec('edit.find', {query: 'Quick', caseSensitive: false});
  assert.equal(find(t).caseSensitive, false);
  assert.equal(find(t).matches.length, 2);
});

test('Advanced search shows the search in the Search panel; closing it moves the search back to the bar; Close ends the search', async () => {
  const t = await open();
  await t.exec('edit.find', {query: 'lazy'});
  await t.exec('edit.advanced_search', {});
  assert.deepEqual([t.doc.view.rightPanel, find(t).inPanel, find(t).query], ['search', true, 'lazy']);
  assert.equal((await t.session.state(t.docId, 'edit.advanced_search', {})).enabled, true);
  await t.exec('edit.advanced_search', {open: false});
  assert.deepEqual([t.doc.view.rightPanel, find(t).inPanel], [null, false]);
  await t.exec('find.close', {});
  assert.equal(find(t), null);
  assert.equal((await t.session.state(t.docId, 'find.close', {})).enabled, false);
});
