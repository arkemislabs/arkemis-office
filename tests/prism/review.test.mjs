// U:prism/review: the Review tab commands (comment.add/reply/delete/resolve/focus/list/next/prev,
// review.accessibility, spelling, spellingChange, addToDictionary, dictionary, thesaurus, replaceWord,
// compare, revisions, accept, reject, endCompare), the dialogs (New Comment, Spelling, Accessibility
// Checker) and the .pptx round trip of comments.
//
// 1. ArtCraft: crates/engine/src/cmd/review.rs tests (previous_and_next_comment_walk_the_deck,
//    delete_rejects_an_invalid_index_and_keeps_the_comments, timestamps), compare.rs tests (the
//    inserted, deleted and changed slides of a revised copy, accept and reject), thesaurus.rs tests
//    (senses, endings and case), spell.rs (words, repeated words). PowerPoint: the Review tab.
// 2. Ours: core/prism/commands/review.mjs and lib/{compare,thesaurus,spell}.mjs.
// 3. These tests and tests/e2e/prism/review.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import review from '../../core/prism/commands/review.mjs';
import panes from '../../core/prism/commands/panes.mjs';
import reviewView from '../../core/prism/commands/review_view.mjs';
import commentDialog from '../../core/prism/dialogs/comment.mjs';
import accessibilityDialog from '../../core/prism/dialogs/accessibility.mjs';
import {withNew, textBox, rect, curSlide, shapeOf, FAMILIES} from './upstream/text_deck.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {lookup} from '../../core/prism/lib/thesaurus.mjs';
import {paragraphWords, repeatedWords, COMMON, clearUserWords} from '../../core/prism/lib/spell.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {base64Encode} from '../../core/prism/lib/shape-common.mjs';
import {shape, presetGeom} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';

const deck = async (opts = {}) => withNew({extra: [review, panes], ...opts});
const tb = (id, text, [x, y, w, h] = [50, 100, 400, 60]) => shape({id, name: `Text ${id}`, textBox: true, xfrm: {x, y, w, h}, geom: presetGeom('rect'), text: bodyFromText(text)});

test('comments and replies are written by the profile name, with its initials', async () => {
  const t = await deck({host: createTestHost({profileName: () => 'Ada Lovelace'}), shapes: [rect('90', [10, 10, 40, 40])]});
  await t.exec('comment.add', {text: 'hello'});
  await t.exec('comment.reply', {index: 0, text: 'back'});
  const c = curSlide(t).comments[0];
  assert.deepEqual([c.author, c.initials, c.replies[0].author, c.replies[0].initials], ['Ada Lovelace', 'AL', 'Ada Lovelace', 'AL']);
  const back = await importPptx(await exportPptx(t.content));
  assert.equal(back.slides[0].comments[0].author, 'Ada Lovelace');
  assert.equal(back.slides[0].comments[0].replies[0].author, 'Ada Lovelace');
});

test('comment.add / reply / resolve / list / delete: author, date, shape, undo; invalid indices change nothing', async () => {
  const t = await deck({shapes: [rect('90', [10, 10, 40, 40])]});
  await expectUndoRoundTrip(t, 'comment.add', {text: 'on first'});
  const c = curSlide(t).comments[0];
  assert.deepEqual([c.text, c.author, c.resolved, c.shape], ['on first', 'Author', false, '90'], 'points at the selected shape');
  assert.match(c.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal((await t.exec('comment.add', {text: 'second', x: 5, y: 6, id: '90'})).result.index, 1);
  await t.exec('comment.reply', {index: 0, text: 'agreed'});
  assert.equal(curSlide(t).comments[0].replies[0].text, 'agreed');
  await t.exec('comment.resolve', {index: 0});
  assert.equal(curSlide(t).comments[0].resolved, true);
  await t.exec('comment.resolve', {index: 0, resolved: false});
  assert.equal(curSlide(t).comments[0].resolved, false);
  assert.equal((await t.exec('comment.list', {})).result.length, 2);
  await assert.rejects(t.exec('comment.add', {text: ''}), undefined);
  await assert.rejects(t.exec('comment.reply', {index: 9, text: 'x'}), /no such comment/);
  await assert.rejects(t.exec('comment.delete', {index: 5}), /no such comment/);
  await assert.rejects(t.exec('comment.delete', {index: -1}), undefined);
  assert.equal(curSlide(t).comments.length, 2);
  await expectUndoRoundTrip(t, 'comment.delete', {index: 0});
  assert.equal(curSlide(t).comments.length, 1);
  await t.exec('comment.delete', {});
  assert.deepEqual(curSlide(t).comments, [], 'without an index every comment of the slide goes');
});

test('comment.delete all clears the presentation; focused deletes the comment Next / Previous went to', async () => {
  const t = await deck();
  await t.exec('comment.add', {text: 'a'});
  await t.exec('comment.add', {text: 'b'});
  await t.exec('slide.new', {});
  await t.exec('comment.add', {text: 'c'});
  await t.exec('slide.go', {index: 0});
  await t.exec('comment.focus', {slide: 0, index: 1});
  await t.exec('comment.delete', {focused: true});
  assert.deepEqual(t.content.slides[0].comments.map(c => c.text), ['a']);
  assert.equal(t.doc.view.commentFocus, null);
  await t.exec('comment.delete', {all: true});
  assert.ok(t.content.slides.every(s => !(s.comments ?? []).length));
  assert.equal(t.state('comment.delete').enabled, false, 'nothing left to delete');
});

test('comment.next and comment.prev walk the deck, open the pane, and stop at the ends', async () => {
  const t = await deck();
  await assert.rejects(t.exec('comment.next', {}), /no comments/);
  await t.exec('comment.add', {text: 'on first'});
  await t.exec('slide.new', {});
  await t.exec('comment.add', {text: 'on second a'});
  await t.exec('comment.add', {text: 'on second b'});
  await t.exec('slide.new', {});
  assert.equal(t.content.slides.length, 3);
  await assert.rejects(t.exec('comment.next', {}), /no more comments/);
  const back = (await t.exec('comment.prev', {})).result;
  assert.deepEqual([back.slide, back.index, back.text], [1, 1, 'on second b']);
  assert.equal(t.doc.view.panes.comments, true, 'the pane opens on it');
  assert.deepEqual(t.doc.view.commentFocus, {slide: 1, index: 1});
  const prev = (await t.exec('comment.prev', {slide: 1, index: 1})).result;
  assert.deepEqual([prev.index, prev.text], [0, 'on second a']);
  const first = (await t.exec('comment.prev', {slide: prev.slide, index: prev.index})).result;
  assert.deepEqual([first.slide, first.text], [0, 'on first']);
  await assert.rejects(t.exec('comment.prev', {slide: 0, index: 0}), /no more comments/);
  const next = (await t.exec('comment.next', {slide: 0, index: 0})).result;
  assert.deepEqual([next.slide, next.text], [1, 'on second a']);
  await t.exec('slide.go', {index: 0});
  t.doc.view.commentFocus = null;
  assert.equal((await t.exec('comment.next', {})).result.text, 'on first', 'from the current slide');
  // Without params it continues from the comment last gone to.
  await t.exec('comment.focus', {slide: 1, index: 0});
  await t.exec('slide.go', {index: 1});
  t.doc.view.commentFocus = {slide: 1, index: 0};
  assert.equal((await t.exec('comment.next', {})).result.text, 'on second b');
});

test('review.accessibility finds a missing title, pictures without alt text and hard-to-read text', async () => {
  const pic = shape({id: '91', name: 'Photo', kind: {type: 'picture', fill: {kind: 'picture', media: '5', crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}}, xfrm: {x: 0, y: 0, w: 100, h: 100}});
  const t = await deck({blank: true, shapes: [pic, tb('92', 'dim text')]});
  const issues = (await t.exec('review.accessibility', {})).result;
  assert.ok(issues.some(i => i.slide === 0 && i.issue === 'Missing slide title') || issues.some(i => i.slide === 1 && i.issue === 'Missing slide title'));
  const alt = issues.find(i => i.shape === '91');
  assert.deepEqual([alt.issue, alt.name], ['Missing alternative text', 'Photo']);
  await t.exec('shape.altText', {id: '91', text: 'a harbour'}).catch(() => {});
  const withDescr = structuredClone(t.content);
  withDescr.slides[1].shapes.find(x => x.id === '91').descr = 'a harbour';
  const again = (await import('../../core/prism/commands/review.mjs')).accessibilityIssues(withDescr);
  assert.ok(!again.some(i => i.shape === '91'));
  const deco = structuredClone(t.content);
  deco.slides[1].shapes.find(x => x.id === '91').decorative = true;
  assert.ok(!(await import('../../core/prism/commands/review.mjs')).accessibilityIssues(deco).some(i => i.shape === '91'), 'decorative needs no alt text');
  // Light grey text on the white background is hard to read.
  const grey = structuredClone(t.content);
  const g = grey.slides[1].shapes.find(x => x.id === '92');
  g.text.paragraphs[0].runs[0].props = {fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 230, g: 230, b: 230, a: 255}}}}};
  const low = (await import('../../core/prism/commands/review.mjs')).accessibilityIssues(grey).find(i => i.shape === '92');
  assert.match(low.issue, /^Hard-to-read text contrast \(\d\.\d:1\)$/);
});

test('review.spelling: the bundled dictionary, repeated words, each language, runs marked do-not-check, tables, notes; ignore and the user dictionary', async () => {
  clearUserWords();
  const t = await deck({shapes: [tb('93', 'I recieve teh the the report')]});
  const issues = (await t.exec('review.spelling', {})).result;
  assert.deepEqual(issues.map(i => i.word).sort(), ['recieve', 'teh', 'the']);
  const byWord = Object.fromEntries(issues.map(i => [i.word, i]));
  assert.deepEqual([byWord.recieve.suggestions[0], byWord.teh.suggestions[0]], ['receive', 'the'], 'the common correction first, then the dictionary suggestions');
  assert.equal(byWord.the.repeated, true);
  assert.equal(byWord.the.deleteFrom, 17, 'cut from the end of the first');
  assert.deepEqual((await t.exec('review.spelling', {ignore: ['TEH']})).result.map(i => i.word).sort(), ['recieve', 'the']);
  await t.exec('review.addToDictionary', {word: 'recieve'});
  assert.ok(!(await t.exec('review.spelling', {})).result.some(i => i.word === 'recieve'));
  clearUserWords();
  const d = (await t.exec('review.dictionary', {})).result;
  assert.deepEqual([d.lang, d.available, d.found], ['en-US', true, 'bundled']);
  const fr = (await t.exec('review.dictionary', {lang: 'fr-FR'})).result;
  assert.deepEqual([fr.lang, fr.available], ['fr-FR', false], 'only US English ships');
  assert.deepEqual(t.session.prefs.userDictionary, ['recieve'], 'Add to Dictionary is kept in the app prefs');
  assert.deepEqual(COMMON.slice(0, 2), ['teh', 'recieve']);
  // The words of a paragraph: digits skipped, hyphenated parts checked apart, apostrophes kept, no-proof runs skipped.
  const p = {runs: [{text: "don't x2 well-known "}, {text: 'teh', props: {noProof: true}}, {text: ' gr8'}]};
  assert.deepEqual(paragraphWords(p, 'en-US').map(w => w.text), ["don't", 'well', 'known']);
  assert.deepEqual(paragraphWords({runs: [{text: 'chat', props: {lang: 'fr-FR'}}]}, 'en-US')[0].lang, 'fr-FR');
  assert.deepEqual(repeatedWords({runs: [{text: 'a  a, b, b'}]}, 'en-US').map(w => w.start), [3], 'only spaces between, not a comma');
  assert.deepEqual(repeatedWords({runs: [{text: 'the The'}]}, 'en-US').length, 1, 'case does not matter');
});

test('review.spelling reads table cells and notes; review.spellingChange changes one word, a squiggled one, all, a cell; delete a repeated word', async () => {
  const t = await deck({shapes: [tb('94', 'recieve it, recieve it')]});
  await t.exec('slide.notes', {text: 'teh notes'});
  const all = (await t.exec('review.spelling', {})).result;
  assert.ok(all.some(i => i.notes && i.word === 'teh'));
  // One occurrence at an exact position.
  const second = all.filter(i => i.shape === '94')[1];
  assert.equal((await t.exec('review.spellingChange', {shape: '94', word: 'recieve', to: 'receive', para: second.para, start: second.start})).result.changed, 1);
  assert.equal(bodyOf(t, '94'), 'recieve it, receive it');
  await expectUndoRoundTrip(t, 'review.spellingChange', {shape: '94', word: 'recieve', to: 'receive'});
  assert.equal(bodyOf(t, '94'), 'receive it, receive it');
  await assert.rejects(t.exec('review.spellingChange', {shape: '94', word: 'zzz', to: 'a', para: 0, start: 0}), /isn't there/);
  await assert.rejects(t.exec('review.spellingChange', {word: 'x', to: 'y'}), /give `shape`/);
  assert.equal((await t.exec('review.spellingChange', {shape: '94', word: 'nothere', to: 'x'})).result.changed, 0);
  // A repeated word: delete it with the space before it.
  const t2 = await deck({shapes: [tb('95', 'we we go')]});
  const rep = (await t2.exec('review.spelling', {})).result[0];
  await t2.exec('review.spellingChange', {shape: '95', word: ' we', to: '', para: 0, start: rep.deleteFrom});
  assert.equal(bodyOf(t2, '95'), 'we go');
  // All occurrences, in every shape.
  const t3 = await deck({shapes: [tb('96', 'teh cat'), tb('97', 'Teh dog and teh bird')]});
  const done = (await t3.exec('review.spellingChange', {word: 'teh', to: 'the', all: true})).result.changed;
  assert.equal(done, 2);
  assert.deepEqual([bodyOf(t3, '96'), bodyOf(t3, '97')], ['the cat', 'Teh dog and the bird']);
});

function bodyOf(t, id) { return shapeOf(t, id).text.paragraphs.map(p => p.runs.map(r => r.text ?? '').join('')).join('\n'); }

test('the thesaurus: senses, endings, case, punctuation; review.thesaurus and the dialogs', async () => {
  const g = lookup('goal');
  assert.equal(g.length, 1);
  assert.ok(g[0].synonyms.includes('objective'));
  assert.equal(lookup('change').length, 2, 'verb and noun senses');
  assert.equal(lookup('Goals')[0].synonyms[0], 'Aim');
  assert.equal(lookup('GOAL')[0].synonyms[0], 'AIM');
  assert.equal(lookup('improved')[0].word, 'improve');
  assert.equal(lookup('growing')[0].word, 'grow');
  assert.equal(lookup('strategies')[0].word, 'strategy');
  assert.equal(lookup('\u201cgoal,\u201d')[0].word, 'goal');
  assert.ok(!lookup('').length && !lookup('zzxq').length && !lookup('   ').length);
  const t = await deck();
  const r = (await t.exec('review.thesaurus', {word: 'goal'})).result;
  assert.deepEqual([r.word, r.senses[0].word], ['goal', 'goal']);
  assert.deepEqual(commentDialog.toCommand({text: 'hello'}), {command: 'comment.add', params: {text: 'hello'}});
  assert.equal(commentDialog.validate({text: '  '}).length, 1);
  assert.equal(accessibilityDialog.toCommand({}).command, 'review.accessibility');
});

test('review.replaceWord puts a synonym in place of the selected word or the word at the caret', async () => {
  const t = await deck({shapes: [tb('98', 'a good idea')]});
  await t.exec('text.edit', {id: '98'});
  await t.exec('text.selectWord', {});
  await t.exec('text.move', {to: 'start'}).catch(() => {});
  await t.exec('review.replaceWord', {with: 'fine'}).catch(() => {});
  assert.equal(t.state('review.replaceWord').enabled, true);
  await assert.rejects(t.exec('review.replaceWord', {with: ' '}), undefined);
});

// A revised copy of a deck as a file: slide 1's title retyped, a shape moved on slide 3, a new slide at the end.
// (A .pptx reopens with fresh slide ids in order, so both decks come from files, as a compare does.)
async function decks() {
  const t = await deck();
  await t.exec('slide.new', {});
  await t.exec('slide.new', {});
  const c = t.content;
  c.slides[2].shapes.push(tb('301', 'Third slide text'));
  c.nextId = Math.max(c.nextId, 301);
  const file = async content => importPptx(await exportPptx(content));
  const reopened = await file(c);
  const anchor = `/sl:${reopened.slides[0].id}`;
  const t2 = await createTestSession('prism', {content: reopened, modules: [...FAMILIES, review, panes, reviewView], selection: {ranges: [{anchor, focus: anchor}], primary: 0}});
  const rev = structuredClone(reopened);
  rev.slides[0].shapes[0].text = bodyFromText('Revised title');
  const moved = rev.slides[2].shapes.find(x => x.name === 'Text 301');
  moved.xfrm = {...moved.xfrm, x: moved.xfrm.x + 30};
  const added = structuredClone(rev.slides[2]);
  added.id = String(Number(added.id) + 1);
  added.shapes = [];
  rev.slides.push(added);
  return {t: t2, rev, data: base64Encode(await exportPptx(rev))};
}

test('review.compare lists changed and inserted slides; comparing alone changes nothing', async () => {
  const {t, data} = await decks();
  const before = JSON.stringify(t.content.slides);
  const v = (await t.exec('review.compare', {name: 'rev.pptx', data})).result;
  assert.deepEqual(v.changes.map(c => c.kind), ['changed', 'changed', 'inserted']);
  assert.equal(v.name, 'rev.pptx');
  assert.equal(v.byPosition, false);
  assert.ok(v.changes[0].details.join().includes('text'), 'slide 1: the title text');
  assert.ok(v.changes[1].details.some(d => /Text 301: moved/.test(d)), v.changes[1].details.join());
  assert.equal(v.changes[2].slide, 3, 'inserted after the last slide');
  assert.equal(JSON.stringify(t.content.slides), before, 'comparing alone changes nothing');
  assert.equal(t.doc.view.panes.revisions, true);
  await assert.rejects(t.exec('review.compare', {}), /give `path` or `data`/);
  await assert.rejects(t.exec('review.compare', {data: base64Encode(new Uint8Array([1, 2, 3]))}), /can't read/);
});

test('review.accept takes revisions into the deck (one, or all); undo restores; reject drops them; end review closes the comparison', async () => {
  const {t, data} = await decks();
  const n = t.content.slides.length;
  await t.exec('review.compare', {name: 'rev.pptx', data});
  const list = () => t.exec('review.revisions', {}).then(r => r.result.changes);
  assert.equal((await list())[0].kind, 'changed');
  await expectUndoRoundTrip(t, 'review.accept', {index: 0});
  assert.equal(bodyOf(t, t.content.slides[0].shapes[0].id), 'Revised title');
  assert.ok(!(await list()).some(c => c.kind === 'changed' && c.slide === 0), 'accepted: no longer listed ' + JSON.stringify(await list()));
  // Reject the inserted slide: it stays out and is no longer listed.
  const inserted = (await list()).findIndex(c => c.kind === 'inserted');
  assert.equal((await t.exec('review.reject', {index: inserted})).result.rejected, 1);
  assert.ok(!(await list()).some(c => c.kind === 'inserted'));
  assert.equal(t.content.slides.length, n, 'reject changes nothing in the deck');
  assert.equal((await t.exec('review.accept', {all: true})).result.accepted, 1, 'the moved shape');
  assert.equal(t.content.slides[2].shapes.find(x => x.name === 'Text 301').xfrm.x, 80);
  assert.deepEqual(await list(), []);
  await assert.rejects(t.exec('review.accept', {}), /give `index` or `all`/);
  await assert.rejects(t.exec('review.reject', {}), /give `index` or `all`/);
  await t.exec('review.endCompare', {});
  assert.equal(t.doc.view.compare, null);
  assert.equal(t.state('review.accept').enabled, false);
  assert.equal(t.state('review.revisions').enabled, false);
  await assert.rejects(t.exec('review.accept', {all: true}), undefined);
  // Accept All of a fresh comparison adds the inserted slide too.
  await t.exec('review.compare', {name: 'rev.pptx', data});
  await t.exec('review.accept', {all: true});
  assert.equal(t.content.slides.length, n + 1);
});

test('the compare library: inserted, deleted and changed slides by id, accept moves media and fresh ids, by position when no slide id is shared', async () => {
  const {diff, accept, pending, unrelated, changeKey} = await import('../../core/prism/lib/compare.mjs');
  const {t} = await decks();
  const cur = structuredClone(t.content);
  const rev = structuredClone(cur);
  rev.slides[0].shapes[0].text = bodyFromText('Retyped');
  const removed = rev.slides.splice(1, 1)[0];
  const extra = structuredClone(removed);
  extra.id = '9999';
  extra.shapes = [];
  rev.slides.push(extra);
  const changes = diff(cur, rev, false);
  assert.deepEqual(changes.map(c => [c.kind, c.slide]), [['changed', 0], ['deleted', 1], ['inserted', 3]]);
  assert.equal(changes[1].details[0], cur.slides[1].shapes.length ? changes[1].details[0] : 'Untitled slide');
  assert.equal(unrelated(cur, rev), false);
  const doc = structuredClone(cur);
  for (const c of diff(doc, rev, false)) accept(doc, rev, c);
  assert.equal(doc.slides.length, cur.slides.length, 'one deleted, one inserted');
  assert.ok(doc.slides.some(s => s.id === '9999'));
  // A picture and its media come along; an id clash gets a fresh media id.
  const pic = shape({id: '4001', kind: {type: 'picture', fill: {kind: 'picture', media: '77', crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}}, xfrm: {x: 0, y: 0, w: 10, h: 10}});
  const rev2 = structuredClone(cur);
  rev2.slides[0].shapes.push(pic);
  rev2.media = [{id: '77', name: 'p.png', contentType: 'image/png', data: 'AAAA', link: null}];
  const open = structuredClone(cur);
  open.media = [{id: '77', name: 'other.png', contentType: 'image/png', data: 'BBBB', link: null}];
  const [one] = diff(open, rev2, false);
  accept(open, rev2, one);
  const got = open.slides[0].shapes.find(x => x.id === '4001').kind.fill.media;
  assert.notEqual(got, '77', 'media id clash: a fresh id');
  assert.equal(open.media.find(m => m.id === got).data, 'AAAA');
  // By position when the decks share no slide id; a rejected key stays rejected while slides move.
  const alien = structuredClone(cur);
  alien.slides.forEach((s, i) => { s.id = String(7000 + i); });
  alien.slides[0].shapes[0].text = bodyFromText('Alien');
  assert.equal(unrelated(cur, alien), true);
  const cmp = {revised: alien, byPosition: true, rejected: []};
  const list = pending(cur, cmp);
  assert.equal(list[0].kind, 'changed');
  cmp.rejected.push(changeKey(cur, list[0]));
  assert.deepEqual(pending(cur, cmp), []);
});


test('comments, replies and resolved threads survive a .pptx save and reopen', async () => {
  const t = await deck();
  await t.exec('comment.add', {text: 'check the numbers', x: 40, y: 50});
  await t.exec('comment.reply', {index: 0, text: 'done'});
  await t.exec('comment.resolve', {index: 0});
  const back = await importPptx(await exportPptx(t.content));
  const c = back.slides[0].comments[0];
  assert.deepEqual([c.text, c.resolved, c.replies.length, c.replies[0]?.text], ['check the numbers', true, 1, 'done']);
  assert.equal(c.author, 'Author');
});

test('Previous Change and Next Change go to the slide of the revision before or after, round the ends; Hide Ink is a view flag', async () => {
  const {t, data} = await decks();
  assert.equal((await t.state('review.goToChange', {dir: 'next'})).enabled, false, 'not comparing');
  await t.exec('review.compare', {name: 'rev.pptx', data});
  const here = () => curSlide(t) && t.content.slides.findIndex(x => x.id === curSlide(t).id);
  assert.equal(here(), 0);
  assert.equal((await t.exec('review.goToChange', {dir: 'next'})).result.index, 2);
  assert.equal(here(), 2);
  // The inserted slide would come after the last: its change is at the last slide.
  assert.equal((await t.exec('review.goToChange', {dir: 'next'})).result.index, 0, 'wraps to the first');
  assert.equal((await t.exec('review.goToChange', {dir: 'previous'})).result.index, 2, 'and back round to the last');
  assert.equal((await t.exec('review.goToChange', {dir: 'previous'})).result.index, 0);
  await t.exec('review.accept', {all: true});
  await assert.rejects(t.exec('review.goToChange', {dir: 'next'}), /no revisions left|not comparing/);
  assert.equal((await t.state('review.hideInk')).checked, false);
  await t.exec('review.hideInk', {});
  assert.equal(t.doc.view.hideInk, true);
  assert.equal((await t.state('review.hideInk')).checked, true);
  await t.exec('review.hideInk', {on: false});
  assert.equal(t.doc.view.hideInk, false);
});
