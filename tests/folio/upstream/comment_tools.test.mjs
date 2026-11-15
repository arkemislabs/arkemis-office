// Ported from printcraft crates/ui-egui/src/tools/comments/tests.rs (drawn_shapes_ignore_slips,
// text_boxes_fit_their_text, the_caret_snaps_to_the_nearer_edge_on_the_baseline,
// away_from_upright_horizontal_text_the_caret_stays_at_the_click), crates/fonts/src/script.rs
// (long_names_keep_every_glyph_with_bounded_outline_work), crates/engine/src/dates.rs and
// crates/engine/src/tests.rs (comment_summary_includes_replies_to_replies) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT).
//
// Behaviour fidelity: 1. ArtCraft ignores slips (a rectangle under 2 pt), fits a text box to its
// text up to 300 pt, snaps Insert text to the character edge and draws typed signatures from the
// script face; the summary indents replies to replies. Acrobat behaves alike. 2. Ours runs the same
// rules through the commands. 3. These tests.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {textBoxRect} from '../../../core/folio/lib/comment-geometry.mjs';
import {scriptOutline, MAX_SIGNATURE_CHARS} from '../../../core/folio/lib/sign-script.mjs';
import {formatDate} from '../../../core/folio/lib/sign-fill.mjs';
import {commentSummary} from '../../../core/folio/lib/comment-pdf.mjs';
import {releaseTextSources} from '../../../core/folio/model/page-text.mjs';

after(() => releaseTextSources());

test('drawn_shapes_ignore_slips', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await assert.rejects(t.exec('comment.square', {page: 'p1', points: [[0, 0], [1, 1]]}), /too small/);
  const r = await t.exec('comment.square', {page: 'p1', points: [[10, 0], [0, 10]]});
  assert.ok(r.result.id);
  await t.exec('comment.ink', {page: 'p1', strokes: [[[5, 5]]]});
  assert.equal(t.content.pages[0].annots.at(-1).dict.InkList[0].length, 2, 'a click is a one-point stroke');
  await t.exec('comment.arrow', {page: 'p1', points: [[0, 0], [5, 0]]});
  assert.deepEqual(t.content.pages[0].annots.at(-1).dict.LE, ['/None', '/OpenArrow']);
});

test('text_boxes_fit_their_text', () => {
  const r = textBoxRect([100, 500], 'Hi', 12, 0);
  assert.deepEqual([r[0], r[3]], [100, 500]);
  assert.ok(r[2] - r[0] < 60);
  const long = textBoxRect([0, 500], 'word '.repeat(80), 12, 0);
  assert.equal(long[2], 300);
  assert.ok(long[3] - long[1] > 50);
});

test('the_caret_snaps_to_the_nearer_edge_on_the_baseline / away_from_upright_horizontal_text_the_caret_stays_at_the_click', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await t.exec('comment.caret', {page: 'p1', at: [73, 66], text: 'a'});
  const d = t.content.pages[0].annots.at(-1).dict;
  assert.ok(Math.abs((d.Rect[0] + d.Rect[2]) / 2 - 72) < 0.6 && Math.abs(d.Rect[3] - 720) < 0.6);
  const r = await createTestSession('folio', {fixture: 'rotatedPage'});
  await r.exec('comment.caret', {page: 'p1', at: [100, 100], text: 'b'});
  const e = r.content.pages[0].annots.at(-1).dict.Rect;
  assert.deepEqual([e[2] - e[0], e[3] - e[1]], [8, 8], 'a turned page keeps the caret at the click');
});

test('long_names_keep_every_glyph_with_bounded_outline_work', () => {
  const text = 'Alexandria Catherine Elizabeth Montgomery-Wellington';
  const o = scriptOutline(text);
  const expected = Array.from(text).reduce((n, c) => n + scriptOutline(c).contours.length, 0);
  assert.equal(o.contours.length, expected, 'the entire name must be drawn');
  const maxX = Math.max(...o.contours.flat().map(p => p[0]));
  assert.ok(maxX > o.width - 0.5, 'ink reaches the last letter');
  assert.ok(scriptOutline('W'.repeat(MAX_SIGNATURE_CHARS)).contours.length > 0);
  assert.equal(scriptOutline('W'.repeat(MAX_SIGNATURE_CHARS + 1)).contours.length, 0);
});

test('dates.rs: the ready-made formats', () => {
  const at = new Date(2026, 9, 2, 12).getTime();
  assert.equal(formatDate(at), '10/2/2026');
  assert.equal(formatDate(at, 'mm/dd/yyyy'), '10/02/2026');
  assert.equal(formatDate(at, 'd mmm yyyy'), '2 Oct 2026');
  assert.equal(formatDate(at, 'mmmm d, yyyy'), 'October 2, 2026');
  assert.equal(formatDate(at, 'yyyy.mm.dd.'), '2026.10.02.');
});

test('comment_summary_includes_replies_to_replies', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages', prefs: {identity: {name: 'Ada'}}});
  await t.exec('comment.note', {page: 'p1', at: [100, 100], text: 'Top'});
  const top = t.content.pages[0].annots.at(-1).id;
  await t.exec('annot.reply', {annotation: `/pg:p1/annot:${top}`, text: 'First reply'});
  const r1 = t.content.pages[0].annots.at(-1).id;
  await t.exec('annot.reply', {annotation: `/pg:p1/annot:${r1}`, text: 'Reply to the reply'});
  const text = commentSummary('doc.pdf', t.content, 'Page');
  assert.ok(text.includes('\n    First reply\n'), text);
  assert.ok(text.includes('\n        Reply to the reply\n'), text);
  assert.ok(/\n {4}Author: Ada {2}Subject: Reply {2}Date: /.test(text) && /\n {8}Author: Ada {2}Subject: Reply {2}Date: /.test(text), text);
});
