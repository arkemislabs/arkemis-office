// Regression (UI review round 3: "No more misspelt words" with "teh" still in the text): a fresh document with "teh" always reports it, whatever another
// document ignored. The dictionary rejects "teh"; Ignore All and Ignore Once belong to one document (session) and end with it; Add to Dictionary is the
// person's own and is the only thing that reaches every document.
import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from '../quill/format-fixture.mjs';
import {textSession, textSel} from '../slate/format-helpers.mjs';
import review from '../../core/prism/commands/review.mjs';
import panes from '../../core/prism/commands/panes.mjs';
import {withNew} from '../prism/upstream/text_deck.mjs';
import {shape, presetGeom} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {resetSpelling, spelling, watchSession, sessionKey} from '../../core/common/lib/spelling.mjs';

test.beforeEach(() => resetSpelling());

const tb = text => shape({id: '93', name: 'Text 93', textBox: true, xfrm: {x: 50, y: 100, w: 400, h: 60}, geom: presetGeom('rect'), text: bodyFromText(text)});

test('the dictionary does not accept teh, in any case or with an affix', async () => {
  const sp = spelling();
  await sp.prepare(['teh', 'Teh', "teh's", 'tehs', 'tehed']);
  for (const w of ['teh', 'Teh', "teh's", 'tehs', 'tehed']) assert.equal(sp.check(w), false, w);
});

test('Word: a fresh document with teh reports it after another document used Ignore All and Ignore Once', async () => {
  const a = await quill('teh and teh');
  a.sel(0, 1);
  await a.exec('review.ignoreOnce');
  await a.exec('review.ignoreAll', {word: 'teh'});
  assert.equal((await a.exec('review.issues')).result.length, 0, 'the first document ignores it');
  const b = await quill('A fresh teh here');
  assert.deepEqual((await b.exec('review.issues')).result.map(i => i.text), ['teh']);
  assert.equal((await b.exec('review.spelling')).result.text, 'teh');
});

test('OneNote: a fresh notebook with teh reports it after another notebook used Ignore All and Ignore Once', async () => {
  const a = await textSession(['teh and teh'], {selection: p => textSel(p, 'b1', 0)});
  const [first] = (await a.exec('review.spellingList')).result;
  await a.exec('review.ignoreOnce', {key: first.key});
  await a.exec('review.ignoreAll', {word: 'teh'});
  assert.equal((await a.exec('review.spellingList')).result.length, 0);
  const b = await textSession(['A fresh teh here'], {selection: p => textSel(p, 'b1', 0)});
  assert.deepEqual((await b.exec('review.spellingList')).result.map(i => i.word), ['teh']);
});

test('PowerPoint: a fresh deck with teh reports it after another deck used Ignore All and Ignore Once', async () => {
  const deck = text => withNew({extra: [review, panes], shapes: [tb(text)]});
  const a = await deck('teh and teh');
  const [first] = (await a.exec('review.spellingList')).result;
  await a.exec('review.ignoreOnce', {key: first.key});
  await a.exec('review.ignoreAll', {word: 'teh'});
  assert.equal((await a.exec('review.spellingList')).result.length, 0);
  const b = await deck('A fresh teh here');
  assert.deepEqual((await b.exec('review.spellingList')).result.map(i => i.word), ['teh']);
});

test('a document id that is opened again starts with empty Ignore lists (the kernel session says so); the same id in another session is another document', async () => {
  const sp = spelling();
  const listeners = new Set();
  const fake = {host: {}, subscribe: f => { listeners.add(f); return () => listeners.delete(f); }};
  const other = {};
  watchSession(fake);
  watchSession(fake);
  assert.equal(listeners.size, 1, 'watched once');
  const k1 = sessionKey(fake.host, 'doc-1'), k2 = sessionKey(fake.host, 'doc-2'), o1 = sessionKey(other, 'doc-1');
  assert.notEqual(k1, o1, 'the same id in another session is another document');
  assert.equal(k1, sessionKey(fake.host, 'doc-1'), 'stable');
  sp.ignoreAll(k1, 'teh');
  sp.ignoreOnce(k1, 'k');
  sp.ignoreAll(k2, 'teh');
  sp.ignoreAll(o1, 'teh');
  assert.equal(sp.hasIgnored(k1), true);
  for (const f of listeners) f({type: 'document.closed', doc: 'doc-1'});
  assert.equal(sp.hasIgnored(k1), false, 'closed: forgotten');
  assert.equal(sp.hasIgnored(k2), true, 'another document keeps its own');
  assert.equal(sp.hasIgnored(o1), true, 'and so does the same id in another session');
  for (const f of listeners) f({type: 'document.opened', doc: 'doc-2'});
  assert.equal(sp.hasIgnored(k2), false, 'opened again: starts empty');
  await sp.prepare(['teh']);
  assert.equal(sp.check('teh', k1), false);
});

test('Add to Dictionary is the one thing that reaches every document, and only when asked', async () => {
  const a = await quill('We say teh here');
  a.sel(0, 10);
  await a.exec('review.addToDictionary');
  assert.equal((await a.exec('review.issues')).result.length, 0);
  // A new window reads its own saved prefs: without the word there, it is reported again.
  resetSpelling();
  const b = await quill('We say teh here');
  assert.equal((await b.exec('review.issues')).result.length, 1);
});
