// U:quill/review — the Review tab: Word Count, Thesaurus, Language; comments (new, reply, edit,
// delete, resolve, previous/next, Show Comments); Track Changes (For Everyone / Just Mine),
// Display for Review, Show Markup, Track Changes Options, the Reviewing Pane; Accept / Reject and
// Previous / Next Change; Compare / Combine; Restrict Editing; their dialogs; the drawing of
// tracked changes; .docx round trips; and the double page border's corners (Design › Page Borders).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/review.rs (specs), review/comments.rs (new_comment 6,
//    reply 51, edit_comment 92, comment_at_caret 120, delete_comment 186, comment_list 207,
//    nav_comment 245), review/changes.rs (resolve_runs 4, resolve_para 31, resolve_all 194,
//    resolve_sel 279, changes 330, deletion_balloons 455, nav_change 528, tracking_options 581),
//    review/proofing.rs (word_count 3, thesaurus 101), fmt_revisions.rs (record, resolve_*),
//    tools/compare.rs (compare 37, lcs_ops 194, word_diff 323), tools/actions.rs (language 7),
//    protect.rs (restrict 61, check_before 334, outside_unchanged 432), session/run.rs (the guard
//    and the formatting record around every command), layout display/lines.rs and display/page.rs
//    (revision colours, marks, change bars), the ribbon in ui-egui/src/ribbon/review.rs, the
//    dialogs in ui-egui dialogs_lists.rs:505 (Track Changes Options), dialogs_review.rs:202 (Compare)
//    and :560 (Restrict Editing), dispatch.rs:760 (Word Count), dialogs_layout/text.rs:329 (Language),
//    panes/comments.rs and canvas/balloons.rs. Word: typing with Track Changes on records an
//    insertion in the author's colour (underlined), deleting records a deletion (struck through),
//    Accept/Reject resolve the change at the caret or selection (Accept All makes everything plain),
//    Next/Previous Change select it; comments anchor to a range, survive edits, take replies and
//    resolve; Simple Markup shows the final text with a red bar, No Markup the final text, Original
//    the text before the changes; Word Count shows pages, words, characters with and without
//    spaces, paragraphs and lines; Compare marks the differences as tracked changes; Restrict
//    Editing refuses what the protection forbids.
// 2. Ours: the same engine (core/quill/lib/review-*.mjs, core/quill/hooks.mjs), each edit one undo
//    step; the page view draws the marks, bars, balloons and comment highlights from the same
//    layout; the .docx writer and reader keep w:ins, w:del, w:rPrChange and comments with replies
//    and their resolved state. Not here: Spelling & Grammar (upstream's proof crate, its
//    dictionaries and squiggles), Block Authors (no upstream engine), Compare's separate result
//    window and Original from another file.
// 3. Proof: this file, tests/quill/upstream/review_tests.test.mjs and tests/e2e/quill/review.e2e.mjs
//    (captures of the Review tab, tracked changes, a comment thread, All vs Simple Markup, Accept
//    All, Word Count and Compare).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {quill, blocks} from './format-fixture.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {layout, pageDisplay} from '../../core/quill/layout/index.mjs';
import {reviewLook, revisionColor, MOVE_COLOR} from '../../core/quill/layout/display.mjs';
import {reviewPresentation, markupOf, defaultMarkup, SIMPLE_BAR} from '../../core/quill/lib/review-markup.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {protectionHash, checkProtectionPassword, legacyKey, sha512} from '../../core/quill/lib/review-protect.mjs';
import wordCountDialog from '../../core/quill/dialogs/wordCount.mjs';
import trackDialog, {trackParams} from '../../core/quill/dialogs/trackChangesOptions.mjs';
import compareDialog, {compareParams} from '../../core/quill/dialogs/compare.mjs';
import languageDialog from '../../core/quill/dialogs/language.mjs';
import {pageBorderRules} from '../../core/quill/layout/page.mjs';

const as = (q, name) => { q.t.session.prefs = {...q.t.session.prefs, userName: name}; };
const at = (n, off) => ({block: n, off});
const runsOf = (q, n = 0) => P.runRanges(blocks(q.t)[n]).map(([a, b, c]) => [blocks(q.t)[n].text.slice(a, b), c]);
const visible = q => new Document(q.t.content).plainText('body').split(P.OBJ).join('');

async function tracked(text = 'Hello world', who = 'Ana') {
  const q = await quill(text);
  as(q, who);
  await q.exec('review.trackChanges', {value: true});
  return q;
}

// ---- Track Changes -----------------------------------------------------------------------------

test('review.trackChanges: For Everyone is the document setting (one undo step); Just Mine is the view and tracks only this person', async () => {
  const q = await quill('Hello');
  await expectUndoRoundTrip(q.t, 'review.trackChanges', {}, after => assert.equal(after.content.settings.trackChanges, true));
  assert.equal(q.state('review.trackChanges').checked, true);
  await q.exec('review.trackChanges', {value: false});
  assert.equal(q.state('review.trackChanges').checked, false);
  await q.exec('review.trackChanges', {scope: 'mine'});
  assert.equal(q.t.content.settings.trackChanges, false, 'not saved with the document');
  assert.equal(q.state('review.trackChanges', {scope: 'mine'}).checked, true);
  assert.equal(q.state('review.trackChanges', {scope: 'everyone'}).checked, false);
  assert.equal(q.state('review.trackChanges').checked, true);
  await q.exec('caret.docEnd');
  await q.exec('text.insert', {text: '!'});
  assert.ok(runsOf(q).some(([t, c]) => t === '!' && c.ins !== undefined), 'Just Mine records the insertion');
  await q.exec('review.trackChanges', {scope: 'everyone'});
  assert.deepEqual([q.t.content.settings.trackChanges, q.state('review.trackChanges', {scope: 'mine'}).checked], [true, false]);
  await q.exec('review.trackChanges', {});
  assert.equal(q.state('review.trackChanges').checked, false, 'the button turns tracking off');
});

test('typing and deleting while tracking record insertions and deletions by the author; Accept All makes them plain (one undo step)', async () => {
  const q = await tracked('Hello world\nSecond line');
  q.sel(0, 5);
  await q.exec('text.insert', {text: ' big'});
  q.sel(1, 0, 6);
  await q.exec('text.delete');
  const ins = runsOf(q).find(([t]) => t === ' big')[1].ins, del = runsOf(q, 1).find(([t]) => t === 'Second')[1].del;
  assert.deepEqual([q.t.content.revisions[ins].kind, q.t.content.revisions[ins].author], ['insert', 'Ana']);
  assert.deepEqual([q.t.content.revisions[del].kind, q.t.content.revisions[del].author], ['delete', 'Ana']);
  await expectUndoRoundTrip(q.t, 'review.acceptAll', {}, after => {
    assert.equal(new Document(after.content).plainText('body'), 'Hello big world\n line');
    assert.deepEqual(after.content.revisions, []);
  });
  await q.t.undo();
  await expectUndoRoundTrip(q.t, 'review.rejectAll', {}, after => assert.equal(new Document(after.content).plainText('body'), 'Hello world\nSecond line'));
});

test('review.accept / review.reject at the caret and over a selection; Next and Previous Change select the changes', async () => {
  const q = await tracked('one two three');
  await q.exec('caret.docStart');
  await q.exec('text.insert', {text: 'new '});
  await q.exec('select.range', {anchor: at(0, 8), focus: at(0, 12)});
  await q.exec('text.delete');
  await q.exec('caret.docStart');
  const next = await q.exec('review.nextChange');
  assert.match(next.result.anchor, /t:0$/);
  assert.match(next.result.focus, /t:4$/);
  const n2 = await q.exec('review.nextChange');
  assert.match(n2.result.anchor, /t:8$/);
  const p = await q.exec('review.previousChange');
  assert.match(p.result.focus, /t:4$/);
  q.sel(0, 1);
  await expectUndoRoundTrip(q.t, 'review.reject', {}, after => assert.equal(new Document(after.content).plainText('body'), 'one two three'));
  q.sel(0, 0, 13);
  await expectUndoRoundTrip(q.t, 'review.accept', {}, after => assert.equal(new Document(after.content).plainText('body'), 'one three', '"new " was rejected, "two " is accepted'));
  assert.equal(q.state('review.accept').enabled, true);
  const plain = await quill('nothing tracked');
  assert.equal(plain.state('review.acceptAll').enabled, false, 'Word greys Accept out without changes');
});

test('a tracked paragraph split and join: the inserted mark is rejected (the paragraphs join), a deleted mark accepted', async () => {
  const q = await tracked('Ab');
  q.sel(0, 1);
  await q.exec('text.newParagraph');
  assert.deepEqual(q.texts(), ['A', 'b']);
  assert.ok(blocks(q.t)[0].mark?.ins !== undefined, 'the new paragraph mark is an insertion');
  await q.exec('review.rejectAll');
  assert.deepEqual(q.texts(), ['Ab']);
  const r = await tracked('one\ntwo');
  r.sel([0, 3], [1, 0]);
  await r.exec('text.delete');
  assert.deepEqual(r.texts(), ['one', 'two'], 'the deleted mark stays until accepted');
  await r.exec('review.acceptAll');
  assert.deepEqual(r.texts(), ['onetwo']);
});

test('review.markup and review.showMarkup are view and preference changes, not undo steps; states check the menus', async () => {
  const q = await quill('x');
  for (const v of ['simple', 'all', 'noMarkup', 'original']) {
    await q.exec('review.markup', {value: v});
    assert.equal(q.state('review.markup', {value: v}).checked, true, v);
  }
  assert.equal(q.t.session.get(q.t.docId).undo.size, 0);
  await q.exec('review.markup', {});
  assert.equal(q.state('review.markup', {value: 'all'}).checked, true, 'without a value Original toggles back to All Markup');
  assert.equal(q.state('review.showMarkup', {toggle: 'comments'}).checked, true);
  await q.exec('review.showMarkup', {toggle: 'comments'});
  assert.equal(q.state('review.showMarkup', {toggle: 'comments'}).checked, false);
  assert.equal(markupOf(q.t.session.prefs).comments, false);
  await q.exec('review.showMarkup', {value: false});
  assert.equal(q.state('review.markup', {value: 'noMarkup'}).checked, true);
  await q.exec('review.trackingOptions', {balloons: 'revisions'});
  assert.equal(q.state('review.trackingOptions', {balloons: 'revisions'}).checked, true);
  await assert.rejects(() => q.t.bridge('review.markup', {value: 'sparkly'}), /value/);
});

test('review.trackingOptions: validated preference; colours byAuthor/auto; trackMoves is the document\'s', async () => {
  const q = await quill('x');
  const r = (await q.exec('review.trackingOptions', {insertMark: 'doubleUnderline', insertColor: 'ff0000', changedLines: 'right', changedLinesColor: 'auto'})).result;
  assert.deepEqual([r.insertMark, r.insertColor, r.changedLines, r.changedLinesColor], ['doubleUnderline', 'FF0000', 'right', 'auto']);
  await assert.rejects(() => q.exec('review.trackingOptions', {insertColor: 'red'}), /insertColor/);
  await assert.rejects(() => q.exec('review.trackingOptions', {deleteMark: 'glitter'}), /deleteMark/);
  assert.deepEqual(markupOf({}), defaultMarkup());
});

// ---- Comments ----------------------------------------------------------------------------------

test('comments: new on the word at the caret, reply, edit, resolve, delete — one undo step each; anchors survive edits', async () => {
  const q = await quill('one two three');
  q.sel(0, 5);
  let id;
  await expectUndoRoundTrip(q.t, 'review.newComment', {text: 'Why two?'}, after => {
    const ids = Object.keys(after.content.comments).map(Number);
    id = ids[0];
    const p = after.content.body.chunks[0][0];
    const objs = P.objectsWithOffsets(p).map(([off, o]) => [off, o.type]);
    assert.deepEqual(objs, [[4, 'commentStart'], [8, 'commentEnd']], 'the word at the caret, without its trailing space');
    assert.equal(after.content.parts[after.content.comments[id].part].kind, 'comment');
  });
  assert.equal(q.t.session.get(q.t.docId).view.commentsPane, true, 'New Comment shows the comments');
  await expectUndoRoundTrip(q.t, 'review.reply', {id, text: 'Because.'}, after => assert.equal(Object.values(after.content.comments).filter(c => c.parent === id).length, 1));
  await expectUndoRoundTrip(q.t, 'review.editComment', {id, text: 'Why\ntwo?'}, after => assert.equal(after.content.parts[after.content.comments[id].part].blocks.length, 2));
  await q.t.undo();
  await expectUndoRoundTrip(q.t, 'review.resolveComment', {id}, after => assert.equal(after.content.comments[id].resolved, true));
  // Typing before the comment moves its anchors with the text.
  await q.exec('caret.docStart');
  await q.exec('text.insert', {text: 'Zero '});
  const list = (await q.exec('review.comments')).result;
  assert.deepEqual(list.map(c => [c.id, c.parent, c.text]), [[id, null, 'Why two?'], [list[1].id, id, 'Because.']]);
  assert.match(list[0].anchor, /t:9$/, 'the anchor moved with the text');
  await expectUndoRoundTrip(q.t, 'review.deleteComment', {id}, after => assert.deepEqual(Object.keys(after.content.comments), [], 'the thread goes'));
  await q.t.undo();
  await q.t.bridge('review.deleteComment', {all: true});
  assert.deepEqual(q.t.content.comments, {});
  assert.equal(visible(q), 'Zero one two three');
  await assert.rejects(() => q.t.bridge('review.reply', {id: 99, text: 'x'}), /no such comment/);
  await assert.rejects(() => q.t.bridge('review.reply', {id: 1.5, text: 'x'}));
});

test('comments: Previous / Next go to the anchors in reading order (wrapping); Show Comments toggles the pane', async () => {
  const q = await quill('alpha beta gamma');
  q.sel(0, 0, 5); await q.exec('review.newComment', {text: 'a'});
  q.sel(0, 13, 18); await q.exec('review.newComment', {text: 'g'});
  q.sel(0, 9);
  let r = await q.exec('review.nextComment');
  assert.match(r.result.focus, /t:13$/);
  r = await q.exec('review.nextComment');
  assert.match(r.result.focus, /t:0$/, 'wraps to the first');
  r = await q.exec('review.previousComment');
  assert.match(r.result.focus, /t:13$/);
  assert.equal(q.state('review.nextComment').enabled, true);
  assert.equal((await quill('x')).state('review.nextComment').enabled, false);
  const before = !!q.t.session.get(q.t.docId).view.commentsPane;
  await q.exec('view.commentsPane');
  assert.equal(q.state('view.commentsPane').checked, !before);
});

// ---- Proofing and Language ---------------------------------------------------------------------

test('review.wordCount: pages, words, characters with and without spaces, paragraphs, lines; the selection when there is one', async () => {
  const q = await quill('Hello brave new world\nSecond paragraph here\n\nEnd.');
  const r = (await q.exec('review.wordCount')).result;
  assert.deepEqual({...r, lines: undefined}, {pages: 1, words: 8, characters: 41, charactersWithSpaces: 46, paragraphs: 3, lines: undefined, includeTextBoxes: false});
  assert.equal(r.lines, 4);
  q.sel(0, 6, 15);
  const s = (await q.exec('review.wordCount')).result;
  assert.deepEqual([s.words, s.characters, s.charactersWithSpaces, s.paragraphs], [2, 8, 9, 1]);
  await q.exec('review.wordCount', {includeTextBoxes: true});
  assert.equal(q.t.session.prefs.countNotes, true, 'remembered');
});

test('review.thesaurus: synonyms of the word at the caret (upstream list) and the pane', async () => {
  const q = await quill('a good day');
  q.sel(0, 3);
  const r = (await q.exec('review.thesaurus')).result;
  assert.deepEqual(r, {word: 'good', synonyms: ['fine', 'excellent', 'decent', 'solid', 'worthy']});
  assert.equal(q.t.session.get(q.t.docId).view.thesaurusPane, true);
  assert.deepEqual((await q.exec('review.thesaurus', {word: 'Zebra'})).result.synonyms, []);
});

test('review.language: marks the selection (one undo step), Do Not Check toggles, default sets the document\'s', async () => {
  const q = await quill('Dzień dobry');
  q.sel(0, 0, 11);
  await expectUndoRoundTrip(q.t, 'review.language', {lang: 'pl_pl'}, after => assert.equal(P.propsOfChar(after.content.body.chunks[0][0], 2).lang, 'pl-PL'));
  await q.exec('review.language', {lang: 'pl-PL'});
  assert.equal(q.state('review.language', {lang: 'pl-PL'}).checked, true);
  await q.exec('review.language', {noProofToggle: true});
  assert.equal(P.propsOfChar(blocks(q.t)[0], 2).noProof, true);
  assert.equal(q.state('review.language', {noProofToggle: true}).checked, true);
  await q.exec('review.language', {lang: 'en-GB', default: true});
  assert.equal(q.t.content.styles.defaultChr.lang, 'en-GB');
  await assert.rejects(() => q.exec('review.language', {lang: 'not a tag'}), /language tag/);
});

// ---- Compare and Protect -----------------------------------------------------------------------

test('review.compare / review.combine: one undo step; from .docx bytes; labelled with the author', async () => {
  const q = await quill('The cat sat.');
  await expectUndoRoundTrip(q.t, 'review.compare', {text: 'The dog sat.', author: 'Reviewer'}, after => {
    const p = after.content.body.chunks[0][0];
    const kinds = P.runRanges(p).filter(([, , c]) => c.ins !== undefined || c.del !== undefined).map(([a, b, c]) => [p.text.slice(a, b), c.ins !== undefined ? 'ins' : 'del']);
    assert.deepEqual(kinds, [['cat ', 'del'], ['dog ', 'ins']]);
    assert.ok(after.content.revisions.every(r => r.author === 'Reviewer'));
  });
  const revised = await quill('The cat ran.');
  const bytes = await writeDocx(revised.t.content);
  const data = Buffer.from(bytes).toString('base64');
  const r = (await q.exec('review.combine', {data})).result;
  assert.equal(r.changes, 1);
  await q.exec('review.acceptAll');
  assert.equal(visible(q), 'The cat ran.');
  await assert.rejects(() => q.exec('review.compare', {}), /revised document/);
});

test('review.restrict: start and stop (one undo step each), exceptions, formatting limited to unlocked styles', async () => {
  const q = await quill('Title\nBody');
  await expectUndoRoundTrip(q.t, 'review.restrict', {mode: 'readOnly'}, after => assert.equal(after.content.settings.protection, 'readOnly'));
  await expectUndoRoundTrip(q.t, 'review.restrict', {stop: true}, after => assert.equal(after.content.settings.protection, null));
  await q.exec('review.restrict', {formatting: true, lockedStyles: ['Heading1']});
  assert.equal(q.t.content.settings.protectFormatting, true);
  assert.ok(q.t.content.styles.styles.find(s => s.id === 'Heading1').locked);
  await assert.rejects(() => q.exec('para.style', {style: 'Heading1'}), /locked/);
  await assert.rejects(() => q.exec('format.bold'), /formatting is limited/);
  await assert.rejects(() => q.exec('review.restrict', {lockedStyles: []}), /stop protection before changing the formatting/);
  const st = (await q.exec('review.restrict', {stop: true})).result;
  assert.deepEqual([st.protection, st.formatting, st.password], [null, false, false]);
  q.sel(1, 0, 4);
  const ex = (await q.exec('review.restrict', {exception: 'add'})).result;
  assert.equal(ex.exceptions, 1);
  await q.exec('review.restrict', {exception: 'removeAll'});
  assert.equal(new Document(q.t.content).permRanges().length, 0);
});

test('Restrict Editing passwords: SHA-512 spin hash as Word writes it; the legacy form is read', () => {
  const salt = new Uint8Array(16).fill(7);
  const h = protectionHash('secret', 50, salt);
  assert.deepEqual(h.map(([k]) => k), ['w:algorithmName', 'w:hashValue', 'w:saltValue', 'w:spinCount']);
  assert.equal(checkProtectionPassword(h, 'secret'), 'correct');
  assert.equal(checkProtectionPassword(h, 'Secret'), 'incorrect');
  assert.equal(checkProtectionPassword([], 'x'), 'none');
  assert.equal(checkProtectionPassword([['w:algorithmName', 'MD5'], ['w:hashValue', 'AAAA']], 'x'), 'unsupported');
  assert.equal(legacyKey('Example').toString(16), '64ceed7e', 'ECMA-376 Part 4 §14.8.1 example');
  assert.equal(Buffer.from(sha512(new TextEncoder().encode('abc'))).toString('hex').slice(0, 16), 'ddaf35a193617aba');
});

// ---- Dialogs -----------------------------------------------------------------------------------

test('dialog.wordCount: the counts, the check box switches them, Close', async () => {
  const q = await quill('one two\nthree');
  const v = openDialogModel(q.t.session, q.t.docId, wordCountDialog);
  assert.deepEqual([v.pages, v.words, v.characters, v.charactersWithSpaces, v.paragraphs, v.lines], ['1', '3', '11', '12', '2', '2']);
  const w = changeDialogValues(wordCountDialog, v, 'includeTextBoxes', true);
  assert.equal(w.words, '3');
  assert.deepEqual(wordCountDialog.toCommand(w), {command: 'review.wordCount', params: {includeTextBoxes: true}});
});

test('dialog.trackChangesOptions: the person\'s options in, review.trackingOptions out', async () => {
  const q = await quill('x');
  const v = openDialogModel(q.t.session, q.t.docId, trackDialog);
  assert.deepEqual([v.insertMark, v.balloons, v.insertColor, v.moveFromColor, v.trackMoves], ['underline', 'commentsAndFormatting', '', '#1A7F37', true]);
  const p = trackParams({...v, insertColor: '#00ff00', changedLines: 'left'});
  assert.deepEqual([p.insertColor, p.deleteColor, p.changedLinesColor, p.changedLines], ['00FF00', 'byAuthor', 'auto', 'left']);
  assert.deepEqual(trackDialog.validate({...v, deleteColor: 'nope'}), [{field: 'deleteColor', message: 'Choose a colour or Automatic.'}]);
  await q.exec(trackDialog.toCommand({...v, insertMark: 'bold'}).command, trackDialog.toCommand({...v, insertMark: 'bold'}).params);
  assert.equal(markupOf(q.t.session.prefs).insertMark, 'bold');
});

test('dialog.compare and dialog.language: values, validation, commands', async () => {
  const q = await quill('x');
  const v = openDialogModel(q.t.session, q.t.docId, compareDialog);
  assert.equal(v.label, 'Author');
  assert.deepEqual(compareDialog.validate(v), [{field: 'revised', message: 'Choose the revised document (Browse…).'}]);
  const p = compareParams({...v, revisedData: 'UEsD', revisedFormat: 'docx', level: 'character', settings: ['formatting', 'tables']});
  assert.deepEqual([p.data, p.format, p.level, p.formatting, p.caseChanges, p.showIn], ['UEsD', 'docx', 'character', true, false, 'original']);
  const l = openDialogModel(q.t.session, q.t.docId, languageDialog);
  assert.deepEqual([l.lang, l.noProof], ['en-US', false]);
  assert.deepEqual(languageDialog.buttons['set-as-default'](null, {...l, lang: 'fr-FR'}), {command: 'review.language', params: {lang: 'fr-FR', noProof: false, detect: true, default: true}});
});

// ---- Drawing -----------------------------------------------------------------------------------

const draws = (q, view = {}, prefs = {}) => {
  const pres = reviewPresentation(view, prefs);
  const lay = layout(q.t.content, {view: 'print', ...pres.layout});
  const d = new Document(q.t.content);
  return {pres, items: pageDisplay(lay.pages[0], {review: reviewLook(q.t.content, {...pres.look, paraMark: (st, path) => {
    const p = d.para(st, path); return p ? {ins: p.mark?.ins !== undefined, del: p.mark?.del !== undefined, fmt: !!p.mark?.fmtChange, props: !!p.props?.fmtChange} : null; }})})};
};
const textOf = items => items.filter(i => i.type === 'text').map(i => i.text).join('');

test('drawing: insertions underlined and deletions struck through in the author\'s colour; per Display for Review', async () => {
  const q = await tracked('Hello world', 'Ana');
  q.sel(0, 5); await q.exec('text.insert', {text: ' big'});
  as(q, 'Bo');
  q.sel(0, 9, 15); await q.exec('text.delete');
  const ana = revisionColor(0), bo = revisionColor(1);
  let {items} = draws(q);
  const big = items.find(i => i.type === 'text' && i.text.includes('big'));
  assert.deepEqual(big.color, ana, 'insertion in the first author\'s colour');
  assert.ok(items.some(i => i.type === 'line' && !i.bar && i.color === ana && Math.abs(i.y0 - i.y1) < 0.01 && i.y0 > big.y), 'underlined');
  const gone = items.find(i => i.type === 'text' && i.text.includes('world'));
  assert.deepEqual(gone.color, bo);
  assert.ok(items.some(i => i.type === 'line' && !i.bar && i.color === bo && i.y0 < gone.y), 'struck through');
  assert.equal(items.filter(i => i.bar).length, 1, 'a change bar beside the line');
  // Simple Markup: the final text, plain, a red bar.
  ({items} = draws(q, {markup: 'simple'}));
  assert.equal(textOf(items).replace(/\s+/g, ' ').trim(), 'Hello big');
  assert.ok(!items.some(i => i.type === 'line' && !i.bar), 'no underline or strikethrough');
  assert.deepEqual(items.filter(i => i.bar).map(i => i.color), [[0xC0, 0, 0]]);
  assert.equal(SIMPLE_BAR, 'C00000');
  // No Markup: the final text, no bar. Original: the text before the changes.
  ({items} = draws(q, {markup: 'noMarkup'}));
  assert.deepEqual([textOf(items).replace(/\s+/g, ' ').trim(), items.filter(i => i.bar).length], ['Hello big', 0]);
  ({items} = draws(q, {markup: 'original'}));
  assert.equal(textOf(items).replace(/\s+/g, ' ').trim(), 'Hello world');
  // Track Changes Options: deletions hidden take no room; colour-only has no line; a fixed colour wins.
  ({items} = draws(q, {}, {markup: {deleteMark: 'hidden', insertMark: 'colorOnly', insertColor: '0000FF'}}));
  assert.ok(!textOf(items).includes('world'));
  assert.deepEqual(items.find(i => i.type === 'text' && i.text.includes('big')).color, [0, 0, 0xFF]);
  assert.ok(!items.some(i => i.type === 'line' && !i.bar && i.color?.[2] === 0xFF));
  // Revisions in balloons: the deletion leaves the body text.
  const b = draws(q, {}, {markup: {balloons: 'revisions'}});
  assert.ok(!textOf(b.items).includes('world'));
  assert.equal(b.pres.balloons.deletions, true);
  assert.deepEqual(MOVE_COLOR, [0x1a, 0x7f, 0x37]);
});

test('.docx round trip keeps insertions, deletions, formatting changes and comments with replies and resolved state', async () => {
  const q = await tracked('Hello world', 'Ana');
  q.sel(0, 5); await q.exec('text.insert', {text: ' big'});
  q.sel(0, 9, 15); await q.exec('text.delete');
  q.sel(0, 0, 5); await q.exec('format.bold');
  const id = (await q.exec('review.newComment', {text: 'Greeting?'})).result.id;
  await q.exec('review.reply', {id, text: 'Yes.'});
  await q.exec('review.resolveComment', {id});
  const back = await readDocx(await writeDocx(q.t.content));
  const p = back.body.chunks[0][0];
  const rr = P.runRanges(p).map(([a, b, c]) => [p.text.slice(a, b), c.ins !== undefined ? back.revisions[c.ins].kind : c.del !== undefined ? back.revisions[c.del].kind : c.fmtChange ? 'format' : '']);
  assert.ok(rr.some(([t, k]) => t === ' big' && k === 'insert'), JSON.stringify(rr));
  assert.ok(rr.some(([t, k]) => t === ' world' && k === 'delete'), JSON.stringify(rr));
  assert.ok(rr.some(([t, k]) => t.includes('Hello') && k === 'format'), JSON.stringify(rr));
  assert.ok(back.revisions.every(r => r.author === 'Ana'));
  const cs = Object.values(back.comments);
  assert.equal(cs.length, 2);
  const root = cs.find(c => c.parent === null || c.parent === undefined), reply = cs.find(c => c.parent !== null && c.parent !== undefined);
  assert.equal(root.resolved, true);
  assert.equal(reply.author, 'Ana');
  assert.equal(back.settings.trackChanges, true);
});

test('Design › Page Borders: a double box meets in square corners (outer strokes run on, inner ones stop)', () => {
  const border = {style: 'double', width: 1, space: 24};
  const s = {pageW: 612, pageH: 792, pageBorders: {top: border, bottom: border, left: border, right: border}};
  const rules = pageBorderRules(s);
  assert.deepEqual(rules.map(r => [r.side, r.joins]), [['top', [true, true]], ['bottom', [true, true]], ['left', [true, true]], ['right', [true, true]]]);
  const page = {header: [], footer: [], items: rules, body: {x: 72, y: 72, w: 468, h: 648}, number: 1};
  const lines = pageDisplay(page, {}).filter(i => i.type === 'line');
  assert.equal(lines.length, 8, 'two strokes per side');
  const top = lines.filter(l => l.y0 === l.y1 && l.y0 < 30), left = lines.filter(l => l.x0 === l.x1 && l.x0 < 30);
  const [topOut, topIn] = top.sort((a, b) => a.y0 - b.y0), [leftOut, leftIn] = left.sort((a, b) => a.x0 - b.x0);
  // Outer strokes: both reach the outer corner and cover it (half a stroke past the other's centre line).
  assert.equal(topOut.x0, leftOut.x0 - 0.5);
  assert.equal(leftOut.y0, topOut.y0 - 0.5);
  // Inner strokes: they stop at the inner corner, covering it the same way, and never cross.
  assert.equal(topIn.x0, leftIn.x0 - 0.5);
  assert.equal(leftIn.y0, topIn.y0 - 0.5);
  assert.ok(topIn.x0 > topOut.x0 && leftIn.y0 > leftOut.y0);
  // A side with no neighbour ends where its line ends.
  const one = pageBorderRules({...s, pageBorders: {top: border}});
  const l1 = pageDisplay({...page, items: one}, {}).filter(i => i.type === 'line');
  assert.deepEqual(l1.map(l => [l.x0, l.x1]), [[24, 588], [24, 588]]);
});
