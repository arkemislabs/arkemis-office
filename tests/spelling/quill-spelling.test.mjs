// Spelling in Word (U:quill/spelling): review.spelling, issues, suggestions, Change, Change All, Ignore Once / All, Add to
// Dictionary, the squiggles in the page's display list, and the 300-page benchmark. The dictionary is the bundled en_US one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from '../quill/format-fixture.mjs';
import {para, lines, content, shaper, LayoutCache} from '../quill/layout-fixtures.test.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {layout, pageDisplay} from '../../core/quill/layout/index.mjs';
import {resetSpelling, spelling} from '../../core/common/lib/spelling.mjs';
import {paraIssues, prepare} from '../../core/quill/lib/review-spelling.mjs';

const TEXT = 'The team will recieve the report.\nA seperate line is fine.\nNothing wrong in this one.\nLast teh paragraph.';

test.beforeEach(() => resetSpelling());

test('review.spelling selects the next misspelt word after the caret, with suggestions and its sentence, and wraps', async () => {
  const q = await quill(TEXT);
  q.sel(0, 0);
  const a = (await q.exec('review.spelling')).result;
  assert.equal(a.text, 'recieve');
  assert.equal(a.kind, 'spelling');
  assert.equal(a.suggestions[0], 'receive');
  assert.equal(a.context.before.endsWith('will '), true);
  assert.equal(a.context.after.startsWith(' the report'), true);
  assert.deepEqual([a.start.off, a.end.off], [14, 21]);
  const sel = q.t.session.get(q.t.docId).selection;
  assert.ok(sel.ranges[0].anchor.includes('t:14') && sel.ranges[0].focus.includes('t:21'), JSON.stringify(sel));
  assert.equal((await q.exec('review.spelling')).result.text, 'seperate');
  assert.equal((await q.exec('review.spelling')).result.text, 'teh');
  assert.equal((await q.exec('review.spelling')).result.text, 'recieve', 'wraps to the start');
  assert.equal(q.t.session.get(q.t.docId).view.editorPane, true, 'opens the Editor pane');
});

test('review.issues lists every misspelt word; review.suggestions answers for the caret', async () => {
  const q = await quill(TEXT);
  const all = (await q.exec('review.issues')).result;
  assert.deepEqual(all.map(i => i.text), ['recieve', 'seperate', 'teh']);
  q.sel(1, 4);
  const one = (await q.exec('review.suggestions')).result;
  assert.equal(one.text, 'seperate');
  assert.ok(one.suggestions.includes('separate'));
  q.sel(2, 2);
  assert.equal((await q.exec('review.suggestions')).result, null);
});

test('menu state: Ignore All, Add to Dictionary and the suggestions show only on a misspelt word', async () => {
  const q = await quill(TEXT);
  await q.exec('review.issues'); // every word is looked up (the page does it for the words on screen)
  q.sel(2, 3);
  for (const id of ['review.ignoreAll', 'review.addToDictionary', 'review.applySuggestion']) assert.equal(q.state(id).hidden, true, `${id} is hidden off a misspelt word`);
  q.sel(0, 16);
  await q.exec('review.suggestions');
  assert.equal(q.state('review.ignoreAll').enabled, true);
  assert.equal(q.state('review.addToDictionary').enabled, true);
  const list = q.state('review.applySuggestion');
  assert.equal(list.enabled, true);
  assert.equal(list.value[0].value, 'receive');
});

test('review.applySuggestion types the suggestion over the word (one undo step)', async () => {
  const q = await quill(TEXT);
  q.sel(0, 16);
  await q.exec('review.applySuggestion', {text: 'receive'});
  assert.equal(q.para(0).text, 'The team will receive the report.');
  await q.t.exec('edit.undo');
  assert.equal(q.para(0).text, 'The team will recieve the report.');
});

test('Change All replaces every occurrence, keeping a capital at the start', async () => {
  const q = await quill('Teh cat and teh dog.\nSee teh end, not tehx.');
  q.sel(0, 1);
  const r = (await q.exec('review.changeAll', {text: 'the'})).result;
  assert.equal(r.changed, 3);
  assert.deepEqual(q.texts(), ['The cat and the dog.', 'See the end, not tehx.']);
});

test('Ignore Once skips one place; Ignore All every case in the document; Recheck brings them back', async () => {
  const q = await quill('teh and teh again');
  assert.deepEqual((await q.exec('review.issues')).result.map(i => i.text), ['teh', 'teh']);
  q.sel(0, 1);
  await q.exec('review.ignoreOnce');
  assert.equal((await q.exec('review.issues')).result.length, 1, 'only the second one is left');
  await q.exec('review.ignoreAll', {word: 'TEH'});
  assert.equal((await q.exec('review.issues')).result.length, 0);
  await q.exec('review.recheck');
  assert.equal((await q.exec('review.issues')).result.length, 2);
  assert.equal((await q.exec('review.spelling')).result.text, 'teh');
});

test('Add to Dictionary keeps the word in the prefs, never again reported, and survives a new session', async () => {
  const q = await quill('We use Arkemis daily and teh app.');
  q.sel(0, 10);
  assert.equal((await q.exec('review.addToDictionary')).result.added, 'Arkemis');
  assert.deepEqual(q.t.session.prefs.userDictionary, ['Arkemis']);
  assert.deepEqual((await q.exec('review.issues')).result.map(i => i.text), ['teh']);
  // A new window: the service starts empty and learns the words from the prefs it is given.
  resetSpelling();
  const q2 = await quill('We use Arkemis daily and teh app.', undefined, {prefs: {userDictionary: ['Arkemis']}});
  assert.deepEqual((await q2.exec('review.issues')).result.map(i => i.text), ['teh']);
  await assert.rejects(q.exec('review.addToDictionary', {word: 'two words'}), /single word/);
});

test('words are skipped in ALL CAPS, with numbers, in addresses, in hyperlinks and in runs marked do not check', async () => {
  const q = await quill('NASA teh2 http://example.com/teh teh\nsecond teh here');
  q.sel(1, 8);
  await q.exec('review.language', {noProof: true});
  assert.deepEqual((await q.exec('review.issues')).result.map(i => i.text), ['teh'], 'only the plain word of paragraph 0');
  q.sel(1, 8);
  await q.exec('review.language', {noProof: false});
  q.sel(1, 8);
  await q.exec('review.language', {lang: 'de-DE'});
  assert.equal((await q.exec('review.issues')).result.length, 1, 'German text is not checked with the English dictionary');
});

test('Check Spelling as You Type is a preference', async () => {
  const q = await quill('teh');
  assert.equal(q.state('review.proofing').checked, true);
  await q.exec('review.proofing', {value: false});
  assert.equal(q.t.session.prefs.checkSpelling, false);
  assert.equal(q.state('review.proofing').checked, false);
});

test('the page display draws a red wavy underline under each misspelt word, only when asked for', async () => {
  const q = await quill('The team will recieve the report.');
  const sp = spelling();
  await sp.prepare(['recieve', 'team', 'report']);
  const lay = layout(q.t.content, {view: 'print'});
  const page = lay.pages[0];
  assert.equal(pageDisplay(page).filter(d => d.proof).length, 0, 'print and export draw none');
  const memo = new Map();
  const proof = (story, path) => paraIssues(q.doc().para(story, path), sp, {});
  const marks = pageDisplay(page, {proof}).filter(d => d.proof);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].stroke, 'wave');
  const word = pageDisplay(page).filter(d => d.type === 'text')[0];
  assert.ok(marks[0].x0 > word.x && marks[0].x1 > marks[0].x0, 'under the word, to its right of the line start');
  assert.ok(marks[0].x1 - marks[0].x0 > 20 && marks[0].x1 - marks[0].x0 < 60);
  void memo;
});

test('the 300-page benchmark document: squiggles for the visible pages cost milliseconds and the layout is untouched', async () => {
  // The layout benchmark's document (tests/quill/layout.test.mjs): 2400 paragraphs of 4 lines, 300 pages; every word is misspelt ("abcdefg").
  const blocksList = [];
  for (let i = 0; i < 2400; i++) blocksList.push(lines(4));
  const c = content(blocksList);
  const cache = new LayoutCache();
  let t0 = performance.now();
  const first = layout(c, {shaper, cache});
  const cold = performance.now() - t0;
  assert.equal(first.pages.length, 300);
  const chunk = c.body.chunks.flat();
  chunk[1200] = para(chunk[1200].text.replace('abcdefg', 'abcdefgh'));
  const c2 = {...c, body: {chunks: [chunk]}};
  t0 = performance.now();
  const second = layout(c2, {shaper, cache});
  const warm = performance.now() - t0;
  assert.equal(second.pages.length, 300);
  assert.ok(warm < 400, `relayout took ${warm} ms`);
  const sp = spelling();
  const d = new Document(c2);
  // Three pages on screen: their words are looked up in one batch, then drawn.
  const visible = second.pages.slice(150, 153);
  const paras = [];
  for (const pg of visible) for (const it of pg.items) if (it.kind === 'lines') paras.push(it.path);
  t0 = performance.now();
  await prepare(d, 'body', paras, sp, {});
  const lookupMs = performance.now() - t0;
  const proof = (story, path) => paraIssues(d.para(story, path), sp, {});
  t0 = performance.now();
  let marks = 0;
  for (const pg of visible) marks += pageDisplay(pg, {proof}).filter(x => x.proof).length;
  const drawMs = performance.now() - t0;
  t0 = performance.now();
  for (const pg of visible) pageDisplay(pg, {});
  const plainMs = performance.now() - t0;
  // The layout benchmark again after the squiggles were drawn: unchanged (squiggles are display-only).
  t0 = performance.now();
  layout({...c2, body: {chunks: [chunk.map((b, i) => (i === 1201 ? para(b.text.replace('abcdefg', 'abcdefgh')) : b))]}}, {shaper, cache});
  const warm2 = performance.now() - t0;
  console.log(`# 300 pages: cold ${cold.toFixed(0)} ms, edit ${warm.toFixed(0)} ms (limit 400), edit again ${warm2.toFixed(0)} ms; 3 visible pages: words looked up in ${lookupMs.toFixed(1)} ms (one batch), ` +
    `display ${drawMs.toFixed(1)} ms with ${marks} squiggles vs ${plainMs.toFixed(1)} ms without`);
  assert.ok(marks > 500, `${marks} squiggles`);
  assert.ok(warm2 < 400);
  assert.ok(drawMs - plainMs < 100, 'the squiggles of three visible pages cost a few milliseconds');
});

test('Synonyms: the right-click menu lists the thesaurus words of the word at the caret; picking one replaces it in its case (one undo step)', async () => {
  const q = await quill('Big idea and a Big plan.');
  q.sel(0, 1);
  const list = q.state('review.applySynonym');
  assert.equal(list.enabled, true);
  assert.ok(Array.isArray(list.value), 'a list of synonyms (empty when the thesaurus has none)');
  q.sel(0, 6); // "idea"
  const ideas = q.state('review.applySynonym').value.map(v => v.value);
  assert.ok(ideas.includes('concept'), JSON.stringify(ideas));
  await q.exec('review.applySynonym', {text: 'concept'});
  assert.equal(q.para(0).text, 'Big concept and a Big plan.');
  await q.t.exec('edit.undo');
  assert.equal(q.para(0).text, 'Big idea and a Big plan.');
  q.sel(0, 10); // "and"
  assert.deepEqual(q.state('review.applySynonym').value.map(v => v.value), [], 'no synonyms for a word the thesaurus lacks');
});
