// Ported from wordcraft crates/engine/src/cmd/review/tests.rs, crates/engine/src/cmd/tools/tests.rs
// (compare) and crates/engine/src/cmd/protect/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): the Review tab's engine tests.
// Each test names the Rust test it ports. Upstream's `document.setText` is the fixture's text and
// `s.author = "Ana"` the person's user name (prefs.userName).

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from '../format-fixture.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import {deletionBalloons, DELETION_TEXT_CHARS} from '../../../core/quill/lib/review-changes.mjs';
import {commentRangeAtCaret, commentAtCaret} from '../../../core/quill/lib/review-comments.mjs';
import {lcsOps, collapseNoiseMatches, SAME, DEL, INS} from '../../../core/quill/lib/review-compare.mjs';
import {layout, pageDisplay} from '../../../core/quill/layout/index.mjs';
import {reviewLook} from '../../../core/quill/layout/display.mjs';
import {markupOf} from '../../../core/quill/lib/review-markup.mjs';
import {selectionPositions} from '../../../core/quill/address.mjs';

const OBJ = P.OBJ;
const as = (q, name) => { q.t.session.prefs = {...q.t.session.prefs, userName: name}; };
const at = (q, n, off) => ({block: n, off});
const range = (q, a, b) => q.exec('select.range', {anchor: a, focus: b});
const body0 = q => blocks(q.t)[0];
const spans = async q => (await q.exec('review.changes', {list: true})).result.map(c => [c.kind, Number(c.start.split('t:')[1]), Number(c.end.split('t:')[1])]);

/** "one two three" with "new " typed at the start, "two " deleted and " end" typed at the end (three_changes). */
async function threeChanges() {
  const q = await quill('one two three');
  as(q, 'Ana');
  await q.exec('review.trackChanges', {value: true});
  await q.exec('caret.docStart');
  await q.exec('text.insert', {text: 'new '});
  await range(q, at(q, 0, 8), at(q, 0, 12));
  await q.exec('text.delete');
  await q.exec('caret.docEnd');
  await q.exec('text.insert', {text: ' end'});
  return q;
}

/** The selection's offsets in paragraph 0 (selected). */
function selected(q) {
  const s = q.t.session.get(q.t.docId).selection.ranges[0];
  const off = a => Number(String(a).split('t:')[1]);
  return [Math.min(off(s.anchor), off(s.focus)), Math.max(off(s.anchor), off(s.focus))];
}

test('accept_and_reject_cover_a_change_split_by_a_comment', async () => {
  for (const accept of [true, false]) {
    const q = await quill('');
    as(q, 'Ana');
    await q.exec('review.trackChanges', {value: true});
    await q.exec('text.insert', {text: 'hello world'});
    await range(q, at(q, 0, 3), at(q, 0, 8));
    await q.exec('review.newComment', {text: 'note'});
    assert.ok(body0(q).runs.length > 3, 'the comment anchors split the insertion');
    await range(q, at(q, 0, 1), at(q, 0, 1));
    await q.exec(accept ? 'review.accept' : 'review.reject');
    const p = body0(q);
    assert.ok(P.runRanges(p).every(([, , c]) => c.ins === undefined), 'no tracked insertion is left');
    assert.equal(p.text.split(OBJ).join('').includes('hello'), accept, p.text);
  }
});

test('accept_and_reject_can_move_to_the_next_change', async () => {
  for (const [cmd, accept] of [['review.accept', true], ['review.reject', false]]) {
    let q = await threeChanges();
    const before = await spans(q);
    assert.deepEqual(before.map(c => c[0]), ['insert', 'delete', 'insert'], cmd);
    await q.exec('caret.docStart');
    await q.exec(cmd, {next: true});
    const after = await spans(q);
    assert.equal(after.length, 2, `${cmd}: the first insertion is resolved`);
    assert.equal(after[0][0], 'delete', cmd);
    assert.deepEqual(selected(q), [after[0][1], after[0][2]], `${cmd}: the deletion is selected next`);
    assert.equal(new Document(q.t.content).plainText('body').startsWith('new '), accept, cmd);
    // Without `next`, the caret stays at the resolved change.
    q = await threeChanges();
    await q.exec('caret.docStart');
    await q.exec(cmd);
    assert.deepEqual(selected(q), [0, 0], cmd);
  }
});

test('accept_and_move_to_next_off_a_change_selects_it_unresolved', async () => {
  const q = await threeChanges();
  await range(q, at(q, 0, 5), at(q, 0, 5));
  await q.exec('review.accept', {next: true});
  const after = await spans(q);
  assert.equal(after.length, 3, 'nothing is resolved');
  assert.deepEqual(selected(q), [after[1][1], after[1][2]], 'the deletion after the caret is selected');
});

test('accept_and_reject_all_can_stop_tracking', async () => {
  for (const cmd of ['review.acceptAll', 'review.rejectAll']) {
    let q = await threeChanges();
    await q.exec(cmd, {stopTracking: true});
    assert.deepEqual(await spans(q), [], cmd);
    assert.equal(q.t.content.settings.trackChanges, false, `${cmd}: Track Changes is off`);
    await q.t.undo();
    assert.equal(q.t.content.settings.trackChanges, true, `${cmd}: one undo step brings tracking and the changes back`);
    assert.equal((await spans(q)).length, 3, cmd);
    q = await threeChanges();
    await q.exec(cmd);
    assert.deepEqual(await spans(q), [], cmd);
    assert.equal(q.t.content.settings.trackChanges, true, `${cmd}: Track Changes stays on`);
  }
});

/** "plain words here" with "words" bold and 14 pt, and the paragraph centred, under Track Changes by Ana (formatted_while_tracking). */
async function formattedWhileTracking() {
  const q = await quill('plain words here');
  as(q, 'Ana');
  await range(q, at(q, 0, 12), at(q, 0, 16));
  await q.exec('format.italic');
  assert.ok(P.runRanges(body0(q)).every(([, , c]) => !c.fmtChange), 'untracked formatting is no revision');
  await q.exec('review.trackChanges', {value: true});
  await range(q, at(q, 0, 6), at(q, 0, 11));
  await q.exec('format.bold');
  await q.exec('format.size', {size: 14});
  await q.exec('para.alignCenter');
  return q;
}

test('formatting_is_tracked_while_tracking_changes', async () => {
  const q = await formattedWhileTracking();
  const p = body0(q);
  const ch = P.propsOfChar(p, 6).fmtChange;
  assert.ok(ch, 'a formatting change on "words"');
  assert.deepEqual([ch.old.bold, ch.old.size], [undefined, undefined], 'the formatting before the first change is kept');
  const rev = q.t.content.revisions[ch.rev];
  assert.deepEqual([rev.kind, rev.author], ['format', 'Ana']);
  assert.ok(!P.propsOfChar(p, 0).fmtChange && !P.propsOfChar(p, 13).fmtChange);
  assert.equal(p.props.fmtChange?.old?.align, undefined);
  assert.ok(p.props.fmtChange, 'the paragraph carries its change');
  const list = (await q.exec('review.changes', {list: true})).result.filter(c => c.kind === 'format').map(c => c.description);
  assert.equal(list.length, 2, JSON.stringify(list));
  assert.ok(list.some(x => /^Formatted: Align: center/.test(x)), JSON.stringify(list));
  assert.ok(list.some(x => /Bold/.test(x) && /Size: 14/.test(x)), JSON.stringify(list));
  // One changed line, one bar beside it.
  const lay = layout(q.t.content);
  const page = lay.pages[0];
  const d = pageDisplay(page, {review: reviewLook(q.t.content, {show: true, marks: markupOf({}), paraMark: (st, path) => {
    const x = new Document(q.t.content).para(st, path); return x ? {ins: false, del: false, fmt: !!x.mark?.fmtChange, props: !!x.props?.fmtChange} : null; }})});
  assert.equal(d.filter(x => x.bar).length, 1, 'one changed line, one bar');
});

test('formatting_changes_are_accepted_and_rejected', async () => {
  const q = await formattedWhileTracking();
  await q.exec('review.rejectAll');
  let p = body0(q);
  const c = P.propsOfChar(p, 6);
  assert.deepEqual([c.bold, c.size, c.fmtChange], [undefined, undefined, undefined]);
  assert.deepEqual([p.props?.align, p.props?.fmtChange], [undefined, undefined]);
  assert.equal(P.propsOfChar(p, 13).italic, true, 'untracked formatting stays');
  await q.t.undo();
  await range(q, at(q, 0, 8), at(q, 0, 8));
  await q.exec('review.accept');
  p = body0(q);
  assert.deepEqual([P.propsOfChar(p, 6).bold, P.propsOfChar(p, 6).fmtChange], [true, undefined]);
  assert.ok(p.props.fmtChange, "the paragraph's change is still there");
  await q.exec('review.acceptAll');
  p = body0(q);
  assert.deepEqual([p.props.align, p.props.fmtChange], ['center', undefined]);
  assert.deepEqual((await q.exec('review.changes', {list: true})).result, []);
});

test('track_moves_is_a_document_setting_with_one_undo_step', async () => {
  const q = await quill('');
  assert.equal((await q.exec('review.trackingOptions', {})).result.trackMoves, true);
  const depth = () => q.t.session.get(q.t.docId).undo.size;
  assert.equal(depth(), 0);
  await q.exec('review.trackingOptions', {trackMoves: true});
  assert.equal(depth(), 0, 'no change, no undo step');
  assert.equal((await q.exec('review.trackingOptions', {trackMoves: false})).result.trackMoves, false);
  assert.equal(q.t.content.settings.trackMoves, false);
  await q.t.undo();
  assert.equal(q.t.content.settings.trackMoves, true);
  await assert.rejects(() => q.exec('review.trackingOptions', {trackMoves: false, moveToMark: 'sparkles'}), /moveToMark/);
  assert.equal(q.t.content.settings.trackMoves, true, 'a refused parameter changes nothing');
});

test('comment_display_defaults_to_margin_and_is_validated', async () => {
  const q = await quill('x');
  assert.equal((await q.exec('review.trackingOptions', {})).result.commentDisplay, 'margin');
  assert.equal((await q.exec('review.trackingOptions', {commentDisplay: 'selected'})).result.commentDisplay, 'selected');
  await assert.rejects(() => q.exec('review.trackingOptions', {commentDisplay: 'popup'}));
  assert.equal(markupOf(q.t.session.prefs).commentDisplay, 'selected');
});

test('comment_range_at_caret_needs_the_caret_inside_the_range', async () => {
  const q = await quill('one two three');
  await q.exec('select.text', {text: 'two'});
  const id = (await q.exec('review.newComment', {text: 'note'})).result.id;
  await q.exec('select.text', {text: 'two'});
  await q.exec('caret.left');
  const d = () => new Document(q.t.content);
  const focus = () => selectionPositions(q.t.content, q.t.session.get(q.t.docId).selection)[0].focus;
  assert.equal(commentRangeAtCaret(d(), focus()), id, 'inside the commented text');
  await q.exec('select.text', {text: 'three'});
  assert.equal(commentRangeAtCaret(d(), focus()), null, 'elsewhere in the paragraph');
  assert.equal(commentAtCaret(d(), focus()), id, "the older lookup still falls back to the paragraph's comment");
});

test('deletion_balloons_join_runs_and_paragraph_marks_and_stay_short', async () => {
  let q = await quill('one two\nthree four');
  as(q, 'Ana');
  await q.exec('review.trackChanges', {value: true});
  await range(q, at(q, 0, 4), at(q, 0, 7));
  await q.exec('text.delete');
  await range(q, at(q, 0, 7), at(q, 1, 5));
  await q.exec('text.delete');
  as(q, 'Bo');
  await range(q, at(q, 1, 5), at(q, 1, 10));
  await q.exec('text.delete');
  let b = deletionBalloons({d: new Document(q.t.content)});
  assert.deepEqual(b.map(x => [x.author, x.text]), [['Ana', 'two¶three'], ['Bo', ' four']]);
  assert.deepEqual([b[0].at.path, b[0].at.off], [[0], 4]);
  q = await quill('word '.repeat(400));
  await q.exec('review.trackChanges', {value: true});
  await q.exec('select.all');
  await q.exec('text.delete');
  b = deletionBalloons({d: new Document(q.t.content)});
  assert.equal(b.length, 1);
  assert.equal([...b[0].text].length, DELETION_TEXT_CHARS + 1);
  assert.ok(b[0].text.startsWith('word word') && b[0].text.endsWith('…'));
});

test('deleting_a_comment_deletes_replies_to_replies', async () => {
  const q = await quill('one two');
  await q.exec('select.text', {text: 'two'});
  const root = (await q.exec('review.newComment', {text: 'root'})).result.id;
  const r1 = (await q.exec('review.reply', {id: root, text: 'r1'})).result.id;
  const r2 = (await q.exec('review.reply', {id: r1, text: 'r2'})).result.id;
  const other = (await q.exec('review.newComment', {text: 'other'})).result.id;
  const parts = Object.keys(q.t.content.parts).length;
  const deleted = (await q.exec('review.deleteComment', {id: root})).result.deleted;
  assert.deepEqual(deleted.sort(), [root, r1, r2].sort());
  assert.deepEqual(Object.keys(q.t.content.comments).map(Number), [other]);
  assert.equal(Object.keys(q.t.content.parts).length, parts - 3, "the thread's parts go with it");
});

test('deleting_a_comment_in_a_parent_cycle_ends', async () => {
  const q = await quill('x', c => {
    c.parts = {1: {kind: 'comment', blocks: [P.paragraphWithText('a', {})]}, 2: {kind: 'comment', blocks: [P.paragraphWithText('b', {})]}};
    c.comments = {1: {author: 'A', initials: 'A', date: '', parent: 2, resolved: false, part: 1}, 2: {author: 'B', initials: 'B', date: '', parent: 1, resolved: false, part: 2}};
    return c;
  });
  const r = (await q.exec('review.deleteComment', {id: 1})).result.deleted;
  assert.deepEqual(r.sort(), [1, 2]);
});

test('compare_marks_changes (tools/tests.rs)', async () => {
  const q = await quill('The cat sat.\nKeep this.\nOld line.');
  const r = (await q.exec('review.compare', {text: 'The dog sat.\nKeep this.\nNew line here.'})).result;
  assert.ok(r.changes >= 2);
  await q.exec('review.acceptAll');
  assert.equal(new Document(q.t.content).plainText('body'), 'The dog sat.\nKeep this.\nNew line here.');
});

test('compare_options_ignore_case_and_white_space (tools/tests.rs)', async () => {
  const original = 'The Cat sat.\nTwo  spaces here.', revised = 'The cat sat.\nTwo spaces here.';
  let q = await quill(original);
  let r = (await q.exec('review.compare', {text: revised, author: 'Reviewer'})).result;
  assert.equal(r.changes, 2);
  assert.ok(q.t.content.revisions.some(x => x.author === 'Reviewer'));
  q = await quill(original);
  r = (await q.exec('review.compare', {text: revised, caseChanges: false, whiteSpace: false})).result;
  assert.equal(r.changes, 0);
  assert.equal(new Document(q.t.content).plainText('body'), revised);
  q = await quill('colour');
  await q.exec('review.compare', {text: 'color', level: 'character'});
  let p = body0(q);
  assert.equal(P.runRanges(p).filter(([, , c]) => c.del !== undefined).map(([a, b]) => p.text.slice(a, b)).join(''), 'u');
  q = await quill('zawarta w dniu 01.09.2026 pomiędzy:');
  await q.exec('review.compare', {text: 'zawarta w dniu 19.10.2026 pomiędzy:', level: 'character'});
  p = body0(q);
  const del = P.runRanges(p).filter(([, , c]) => c.del !== undefined), ins = P.runRanges(p).filter(([, , c]) => c.ins !== undefined);
  assert.equal(del.map(([a, b]) => p.text.slice(a, b)).join(''), '01.09');
  assert.equal(ins.map(([a, b]) => p.text.slice(a, b)).join(''), '19.10');
  assert.equal(del.length, 1, 'one clean deleted run, not several scattered ones');
  assert.equal(ins.length, 1, 'one clean inserted run, not several scattered ones');
  // Formatting differences become formatting changes.
  q = await quill('Same words.');
  const revisedContent = (await quill('Same words.', c => { const b = c.body.chunks[0][0]; b.runs = [{len: b.text.length, props: {bold: true}}]; return c; })).t.content;
  r = (await q.exec('review.compare', {content: revisedContent})).result;
  assert.equal(r.changes, 1);
  assert.ok(q.t.content.revisions.some(x => x.kind === 'format'));
});

test('collapse_noise_matches_merges_short_interior_runs_but_keeps_prefix_suffix (tools/tests.rs)', () => {
  const ops = lcsOps([...'01.09'], [...'19.10'], {left: Infinity});
  assert.ok(ops.includes(SAME), 'the raw LCS does find spurious matches here, or this test proves nothing');
  assert.deepEqual(collapseNoiseMatches(ops), [DEL, DEL, DEL, DEL, DEL, INS, INS, INS, INS, INS]);
  const ops2 = lcsOps([...'abcxdef'], [...'abcydef'], {left: Infinity});
  assert.deepEqual(collapseNoiseMatches(ops2), ops2);
});

test('compare_at_word_level_still_matches_a_whole_unchanged_word (tools/tests.rs)', async () => {
  const q = await quill('the cat sat');
  await q.exec('review.compare', {text: 'a cat ran'});
  const p = body0(q);
  assert.ok(P.runRanges(p).some(([a, b, c]) => c.del === undefined && c.ins === undefined && p.text.slice(a, b).trim() === 'cat'), 'the unchanged word must survive as plain text');
});

test('compare_bounds_total_diff_work (tools/tests.rs)', async () => {
  const words = 3000, paras = 12;
  const doc = rev => Array.from({length: paras}, (_, p) => Array.from({length: words}, (_, w) => (w % 10 === 0 && rev ? `x${p}w${w}` : `p${p}w${w}`)).join(' ')).join('\n');
  const q = await quill(doc(false));
  const r = (await q.exec('review.compare', {text: doc(true)})).result;
  assert.equal(r.changes, paras);
  const wordDiffed = b => { const same = P.runRanges(b).filter(([, , c]) => c.ins === undefined && c.del === undefined).reduce((n, [a, z]) => n + z - a, 0); return same * 2 > b.text.length; };
  const bl = blocks(q.t);
  assert.ok(wordDiffed(bl[0]));
  const diffed = bl.filter(wordDiffed).length;
  const cells = words * words;
  assert.ok(diffed * cells <= 50_000_000 + cells, `${diffed} pairs diffed word by word`);
});

test('restrict editing: read only refuses edits; exceptions stay editable; stop needs the password (protect/tests.rs)', async () => {
  const q = await quill('locked text\nfree text');
  await range(q, at(q, 1, 0), at(q, 1, 9));
  await q.exec('review.restrict', {exception: 'add'});
  await q.exec('review.restrict', {mode: 'readOnly', password: 'pw', spinCount: 10});
  assert.equal(q.t.content.settings.protection, 'readOnly');
  await range(q, at(q, 0, 0), at(q, 0, 6));
  await assert.rejects(() => q.exec('text.insert', {text: 'X'}), /editable regions/);
  assert.equal(body0(q).text, 'locked text', 'outside the exception nothing changes');
  await q.exec('caret.set', {pos: {block: 1, off: 3}});
  await q.exec('text.insert', {text: 'Y'});
  assert.ok(blocks(q.t)[1].text.includes('Y'), 'inside the exception typing works');
  await assert.rejects(() => q.exec('review.restrict', {stop: true}), /password/);
  await assert.rejects(() => q.exec('review.restrict', {stop: true, password: 'nope'}), /incorrect/);
  await q.exec('review.restrict', {stop: true, password: 'pw'});
  assert.equal(q.t.content.settings.protection, null);
});

test('restrict editing: comments only allows comments; tracked changes forces tracking (protect/tests.rs)', async () => {
  let q = await quill('alpha beta');
  await q.exec('review.restrict', {mode: 'comments'});
  await q.exec('select.text', {text: 'beta'});
  await assert.rejects(() => q.exec('text.insert', {text: 'X'}), /only comments/);
  await q.exec('review.newComment', {text: 'ok'});
  assert.equal(Object.keys(q.t.content.comments).length, 1);
  q = await quill('alpha beta');
  await q.exec('review.restrict', {mode: 'trackedChanges'});
  assert.equal(q.t.content.settings.trackChanges, true);
  await assert.rejects(() => q.exec('review.trackChanges', {value: false}), /tracked/);
  await assert.rejects(() => q.exec('review.acceptAll'), /tracked|disabled|no tracked/i);
  await q.exec('caret.docEnd');
  await q.exec('text.insert', {text: '!'});
  assert.ok(P.runRanges(body0(q)).some(([, , c]) => c.ins !== undefined), 'the typing is tracked');
});
