// core/folio/commands/comment.mjs: the Comments panel and every comment tool other than text
// markup and the pen (markup.mjs), threads, status, check marks, lock, properties, stamps,
// Flatten, Hide all, Summarize, Export and Import.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: a comment tool picked from a menu becomes the quick tool and the Comments panel
//    opens (printcraft crates/ui-egui/src/commands.rs:451); the gesture makes the comment
//    (tools/comments/input.rs, composer.rs: a note at the click with the composer's text, a text
//    box that fits its text or wraps to the dragged width, a callout from the point to the box,
//    shapes by paint.rs drawn_shape, Insert text snapped to the character, Replace text = a
//    StrikeOut /IT /StrikeOutTextEdit plus a grouped Caret holding the replacement); replies,
//    statuses and check marks are /IRT Text annotations (modify.rs); stamps carry their own
//    appearance; Flatten draws appearances into the page (edit/src/flatten.rs); Summarize writes a
//    "Summary of Comments on …" PDF (engine/src/comments.rs); Export/Import are XFDF
//    (crates/xfdf). Acrobat does each of these the same way (Comment tools, Comments list
//    filter/sort/reply/status/checkmark, Stamp palette, Flatten, Summarize, Export/Import data file).
// 2. Ours does the same, end to end: the commands write comment records, the folio writer saves
//    them as real annotation dictionaries with appearances; these tests save, reopen with pdf-lib
//    and check the dictionaries (and /FS embedded files, page content after Flatten).
// 3. Proved by the tests below, tests/folio/upstream/comment_*.test.mjs (ported upstream tests) and
//    tests/e2e/folio/comment-tools.e2e.mjs (the window, through the bridge).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFArray, PDFDict, PDFStream, decodePDFRawStream} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {readXfdf, commentSummary} from '../../core/folio/lib/comment-pdf.mjs';

after(() => releaseTextSources());

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const session = (fixture = 'textPages', o = {}) => createTestSession('folio', {fixture, ...o});
const last = (t, page = 0) => t.content.pages[page].annots.at(-1);

async function reopened(content) {
  const bytes = await writeFolioPdf(content);
  const doc = await PDFDocument.load(bytes);
  const list = page => {
    const arr = doc.getPage(page).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return arr ? arr.asArray().map(e => doc.context.lookup(e)) : [];
  };
  return {bytes, doc, list};
}
const nm = (d, k) => d.lookup(PDFName.of(k))?.decodeText?.();

test('picking a tool from a menu makes it the quick tool and opens the Comments panel (commands.rs:451)', async () => {
  const t = await session();
  const r = await t.exec('comment.square', {});
  assert.deepEqual(r.result, {tool: 'comment.square'});
  assert.equal(t.doc.view.tool, 'comment.square');
  assert.equal(t.doc.view.rightPanel, 'comments');
  assert.equal(t.state('comment.square').checked, true);
});

test('a sticky note is a Text annotation at the click with the composer text, a pop-up, and is undoable as "Add sticky note"', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'comment.note', {page: 'p1', at: [100, 100], text: 'Check this'}, after => {
    const rec = after.content.pages[0].annots.at(-1);
    assert.equal(rec.dict.Subtype, '/Text');
    assert.equal(rec.dict.Name, '/Comment');
    assert.equal(rec.dict.Contents.$t, 'Check this');
    assert.ok(rec.popup, 'notes get a pop-up');
  });
  assert.equal(r.undoLabel, 'Add sticky note');
  const {list} = await reopened(t.content);
  const note = list(0).find(d => nm(d, 'Subtype') === 'Text');
  assert.ok(note.lookup(PDFName.of('Popup'), PDFDict), 'the saved note points at its pop-up');
  assert.equal(note.lookup(PDFName.of('Contents')).decodeText(), 'Check this');
});

test('a clicked text box fits its text; a dragged one keeps its width and wraps (geometry.rs)', async () => {
  const t = await session();
  await t.exec('comment.freetext', {page: 'p1', at: [100, 100], text: 'Hi'});
  const small = last(t).dict.Rect;
  assert.ok(small[2] - small[0] < 60 && small[2] - small[0] >= 40, 'a short text gets the 40 pt minimum');
  assert.equal(small[0], 100);
  assert.equal(small[3], 792 - 100, 'hangs from the clicked top-left');
  await t.exec('comment.freetext', {page: 'p1', rect: [100, 200, 120, 30], text: 'word '.repeat(30)});
  const wide = last(t).dict.Rect;
  assert.equal(Math.round(wide[2] - wide[0]), 120, 'the dragged width stays');
  assert.ok(wide[3] - wide[1] > 30, 'the box grows down to fit the wrapped text');
  assert.match(last(t).dict.DA.$t, /\/Helv 12 Tf/);
  await assert.rejects(t.exec('comment.freetext', {page: 'p1', at: [10, 10], text: '  '}), /type the text/);
});

test('a callout points at `point` from a box at `at`, its knee halfway and level with the box (composer.rs)', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'comment.callout', {page: 'p1', point: [100, 300], at: [300, 200], text: 'Look'}, after => {
    const d = after.content.pages[0].annots.at(-1).dict;
    assert.equal(d.IT, '/FreeTextCallout');
    assert.equal(d.CL.length, 6);
    assert.deepEqual(d.CL.slice(0, 2), [100, 492], 'the leader starts at the point');
    assert.equal(d.LE, '/OpenArrow');
    assert.match(d.DA.$t, /\/Helv 10 Tf/);
  });
  await assert.rejects(t.exec('comment.callout', {page: 'p1', point: [100, 300], at: [102, 302], text: 'x'}), /drag farther/);
});

test('shapes: line, arrow, rectangle, oval, polygon, connected lines and cloud, each with its undo label', async () => {
  const t = await session();
  const cases = [
    ['comment.line', [[100, 100], [200, 150]], '/Line', 'Add line'],
    ['comment.arrow', [[100, 100], [200, 150]], '/Line', 'Add arrow'],
    ['comment.square', [[100, 100], [200, 150]], '/Square', 'Add rectangle'],
    ['comment.circle', [[100, 100], [200, 150]], '/Circle', 'Add oval'],
    ['comment.polygon', [[100, 100], [200, 100], [150, 180]], '/Polygon', 'Add polygon'],
    ['comment.polyline', [[100, 100], [200, 100], [150, 180]], '/PolyLine', 'Add connected lines'],
    ['comment.cloud', [[100, 100], [200, 100], [150, 180]], '/Polygon', 'Add cloud'],
  ];
  for (const [id, points, subtype, label] of cases) {
    const r = await expectUndoRoundTrip(t, id, {page: 'p1', points}, after => assert.equal(after.content.pages[0].annots.at(-1).dict.Subtype, subtype));
    assert.equal(r.undoLabel, label, id);
  }
  await t.exec('comment.arrow', {page: 'p1', points: [[100, 100], [200, 150]]});
  assert.deepEqual(last(t).dict.LE, ['/None', '/OpenArrow']);
  await t.exec('comment.cloud', {page: 'p1', points: [[100, 100], [200, 100], [150, 180]]});
  assert.equal(last(t).dict.IT, '/PolygonCloud');
  await assert.rejects(t.exec('comment.square', {page: 'p1', points: [[0, 0], [1, 1]]}), /too small/, 'paint.rs: slips are ignored');
  await assert.rejects(t.exec('comment.polygon', {page: 'p1', points: [[0, 0], [10, 10]]}), /at least 3/);
  const {list} = await reopened(t.content);
  for (const d of list(0)) assert.ok(d.lookup(PDFName.of('AP'), PDFDict), `${nm(d, 'Subtype')} is saved with an appearance`);
});

test('Insert text snaps the caret to the character edge on the baseline; away from text it stays at the click', async () => {
  const t = await session();
  // Line 1 baseline at y = 720 (view y = 72); its text starts at x = 72.
  await t.exec('comment.caret', {page: 'p1', at: [73, 66], text: 'new'});
  const snapped = last(t).dict;
  assert.equal(snapped.Subtype, '/Caret');
  assert.equal(snapped.Contents.$t, 'new');
  const tipX = (snapped.Rect[0] + snapped.Rect[2]) / 2;
  assert.ok(Math.abs(tipX - 72) < 0.6, `the tip is on the first character's left edge (${tipX})`);
  assert.ok(Math.abs(snapped.Rect[3] - 720) < 0.6, 'the tip is on the baseline');
  await t.exec('comment.caret', {page: 'p1', at: [400, 500], text: 'far'});
  const far = last(t).dict.Rect;
  assert.deepEqual([far[2] - far[0], far[3] - far[1]], [8, 8], 'CARET_SIZE away from text');
});

test('Replace text strikes the text out and groups a caret with the replacement (modify.rs add_text_replacement)', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'comment.replace', {text: '/pg:p1/chars:0-7', replacement: 'Arkemis Office'}, after => {
    const [strike, caret] = after.content.pages[0].annots.slice(-2);
    assert.equal(strike.dict.Subtype, '/StrikeOut');
    assert.equal(strike.dict.IT, '/StrikeOutTextEdit');
    assert.equal(caret.dict.Subtype, '/Caret');
    assert.equal(caret.irt, strike.id);
    assert.equal(caret.dict.RT, '/Group');
    assert.equal(caret.dict.Subj.$t, 'Replace Text');
    assert.equal(caret.dict.Contents.$t, 'Arkemis Office');
  });
  assert.equal(r.undoLabel, 'Replace text');
  // Deleting the strikeout deletes its caret (one comment in the list).
  const strikeId = t.content.pages[0].annots.at(-2).id;
  await t.exec('annot.delete', {annotation: `/pg:p1/annot:${strikeId}`});
  assert.equal(t.content.pages[0].annots.length, 0);
});

test('Attach a file embeds it: /FS with /EF /F an EmbeddedFile stream with the bytes', async () => {
  const t = await session();
  const data = new TextEncoder().encode('hello attachment');
  await t.exec('comment.attach', {page: 'p1', at: [50, 50], base64: Buffer.from(data).toString('base64'), name: 'notes.txt'});
  assert.equal(last(t).dict.Subtype, '/FileAttachment');
  const {list, doc} = await reopened(t.content);
  const fa = list(0).find(d => nm(d, 'Subtype') === 'FileAttachment');
  const fs = fa.lookup(PDFName.of('FS'), PDFDict);
  assert.equal(fs.lookup(PDFName.of('UF')).decodeText(), 'notes.txt');
  const ef = fs.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFStream);
  assert.equal(new TextDecoder().decode(decodePDFRawStream(ef).decode()), 'hello attachment');
  assert.ok(doc, 'reopens');
});

test('the eraser rubs out the part of a drawing it passes over and splits the stroke (paint.rs erase)', async () => {
  const t = await session();
  await t.exec('comment.ink', {page: 'p1', strokes: [[[100, 100], [200, 100], [300, 100]]]});
  const r = await expectUndoRoundTrip(t, 'comment.eraser', {page: 'p1', path: [[200, 90], [200, 110]]}, after => {
    const ink = after.content.pages[0].annots.at(-1).dict.InkList;
    assert.equal(ink.length, 2, 'the stroke is split in two');
  });
  assert.equal(r.undoLabel, 'Erase');
  await t.exec('comment.eraser', {page: 'p1', path: [[100, 100], [300, 100]], width: 12});
  assert.equal(t.content.pages[0].annots.length, 0, 'a drawing with nothing left is deleted');
});

test('stamps: the palette, a standard stamp, a dynamic stamp with its By line, and a custom picture stamp', async () => {
  const t = await session();
  const pal = await t.exec('comment.stamp', {});
  assert.ok(pal.result.palette.dynamic.some(s => s.name === 'PCDynApproved'));
  assert.ok(pal.result.palette.standardBusiness.some(s => s.name === 'Approved'));
  assert.equal(t.doc.view.leftPanel, 'stamp');
  await expectUndoRoundTrip(t, 'comment.stamp', {page: 'p1', at: [300, 300], stamp: 'Approved'}, after => {
    const d = after.content.pages[0].annots.at(-1).dict;
    assert.equal(d.Subtype, '/Stamp');
    assert.equal(d.Name, '/Approved');
    assert.deepEqual([d.Rect[2] - d.Rect[0], d.Rect[3] - d.Rect[1]], [150, 40]);
  });
  const t2 = await session('textPages', {prefs: {identity: {name: 'Grace Hopper'}}});
  await t2.exec('comment.stamp', {page: 'p1', at: [300, 300], stamp: 'PCDynApproved'});
  assert.match(last(t2).dict.PCByLine.$t, /^By Grace Hopper at /);
  await t2.exec('comment.stamp', {page: 'p1', at: [100, 600], base64: PNG_1x1, name: 'Logo'});
  const pic = last(t2).dict;
  assert.ok(pic.PCPicture?.$ref, 'the picture is an object in the file');
  const {list} = await reopened(t2.content);
  const saved = list(0).filter(d => nm(d, 'Subtype') === 'Stamp');
  assert.equal(saved.length, 2);
  for (const d of saved) assert.ok(d.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream), 'stamps are saved with an appearance');
  const ap = saved.find(d => d.get(PDFName.of('PCPicture')));
  const xo = ap.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream).dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
  assert.ok(xo.lookup(PDFName.of('Pic'), PDFStream).dict.lookup(PDFName.of('Subtype')).decodeText() === 'Image', 'the appearance draws the embedded image');
});

test('custom stamps are kept in the palette and can be deleted', async () => {
  const t = await session();
  const c = await t.exec('comment.stamp.custom.create', {base64: PNG_1x1, name: 'My seal', category: 'Company'});
  const pal = await t.exec('comment.stamp', {});
  assert.deepEqual(pal.result.palette.custom.map(x => x.name), ['My seal']);
  await t.exec('comment.stamp', {page: 'p1', at: [100, 100], custom: c.result.id});
  assert.equal(last(t).dict.Subtype, '/Stamp');
  await t.exec('comment.stamp.custom.delete', {custom: c.result.id});
  assert.deepEqual((await t.exec('comment.stamp', {})).result.palette.custom, []);
});

test('replies, status, check marks and lock (modify.rs) appear in the comment list threads', async () => {
  const t = await session('textPages', {prefs: {identity: {name: 'Ada'}}});
  await t.exec('comment.note', {page: 'p1', at: [100, 100], text: 'Parent'});
  const a = `/pg:p1/annot:${last(t).id}`;
  const r1 = await expectUndoRoundTrip(t, 'annot.reply', {annotation: a, text: 'A reply'}, after => {
    const rep = after.content.pages[0].annots.at(-1);
    assert.equal(rep.irt, after.content.pages[0].annots[0].id);
    assert.equal(rep.ap, 'empty');
  });
  assert.equal(r1.undoLabel, 'Reply');
  const r2 = await t.exec('annot.set_status', {annotation: a, status: 'Accepted'});
  assert.equal(r2.undoLabel, 'Set status Accepted');
  assert.equal(last(t).dict.Contents.$t, 'Accepted set by Ada');
  assert.equal(last(t).dict.StateModel.$t, 'Review');
  const r3 = await t.exec('annot.mark', {annotation: a});
  assert.equal(r3.undoLabel, 'Mark with checkmark');
  assert.equal(last(t).dict.F & 2, 2, 'the check-mark reply is hidden');
  const list = (await t.exec('comment.list', {open: true})).result;
  assert.equal(list.count, 1);
  assert.equal(list.replyCount, 1);
  const th = list.threads[0];
  assert.equal(th.status, 'Accepted');
  assert.equal(th.marked, true);
  assert.deepEqual(th.replies.map(x => x.contents), ['A reply']);
  assert.deepEqual(th.history.map(h => h.state), ['Accepted']);
  await t.exec('annot.mark', {annotation: a});
  assert.equal((await t.exec('comment.list', {})).result.threads[0]?.marked ?? false, false, 'the latest check mark wins');
  const r4 = await t.exec('annot.lock', {annotation: a, locked: true});
  assert.equal(r4.undoLabel, 'Lock comment');
  await assert.rejects(t.exec('annot.move', {annotation: a, dx: 5, dy: 5}), /locked/);
  // Saved: the reply's /IRT points at the parent, the status reply carries /State.
  const {list: saved} = await reopened(t.content);
  const parent = saved(0).find(d => nm(d, 'Contents') === 'Parent');
  const reply = saved(0).find(d => nm(d, 'Contents') === 'A reply');
  assert.ok(reply.get(PDFName.of('IRT')));
  assert.equal(reply.lookup(PDFName.of('IRT')), parent);
});

test('the comment list searches, filters by type/author/status/check mark and sorts by author (comments_panel.rs)', async () => {
  const t = await session('textPages', {prefs: {identity: {name: 'Zed'}}});
  await t.exec('comment.note', {page: 'p1', at: [100, 100], text: 'alpha'});
  await t.exec('comment.square', {page: 'p2', points: [[100, 100], [200, 200]]});
  t.session.updatePrefs?.({identity: {name: 'Amy'}});
  const all = (await t.exec('comment.list', {})).result;
  assert.equal(all.count, 2);
  assert.deepEqual(all.threads.map(x => x.heading), ['Page 1', 'Page 2']);
  assert.equal((await t.exec('comment.list', {search: 'ALPHA'})).result.threads.length, 1, 'search ignores case');
  assert.equal((await t.exec('comment.list', {filter: {types: ['Note']}})).result.threads[0].kind, 'Rectangle');
  assert.equal((await t.exec('comment.list', {filter: {statuses: ['None']}})).result.threads.length, 0);
  assert.equal((await t.exec('comment.list', {filter: {checks: ['Unchecked']}})).result.threads.length, 0);
  const byType = (await t.exec('comment.list', {sort: 'Type'})).result;
  assert.deepEqual(byType.threads.map(x => x.kind), ['Note', 'Rectangle']);
  assert.equal(t.doc.view.commentSort, 'Type');
});

test('Comment Properties changes look, endings, icon, author and lock in one step, and can become the tool default', async () => {
  const t = await session();
  await t.exec('comment.line', {page: 'p1', points: [[100, 100], [200, 100]]});
  const a = `/pg:p1/annot:${last(t).id}`;
  const r = await expectUndoRoundTrip(t, 'comment.properties', {annotation: a, color: '#0000FF', width: 4, end: 'ClosedArrow', author: 'Reviewer', subject: 'Path', makeDefault: true}, after => {
    const d = after.content.pages[0].annots.at(-1).dict;
    assert.deepEqual(d.C, [0, 0, 1]);
    assert.equal(d.BS.W, 4);
    assert.deepEqual(d.LE, ['/None', '/ClosedArrow']);
    assert.equal(d.T.$t, 'Reviewer');
    assert.equal(d.Subj.$t, 'Path');
  });
  assert.equal(r.undoLabel, 'Change comment properties');
  assert.deepEqual(t.session.prefs.commentStyles['comment.line'].color, [0, 0, 1]);
  await t.exec('comment.line', {page: 'p1', points: [[100, 300], [200, 300]]});
  assert.deepEqual(last(t).dict.C, [0, 0, 1], 'the next line takes the saved default');
  await t.exec('comment.note', {page: 'p1', at: [300, 300], text: 'n'});
  await t.exec('comment.properties', {annotation: `/pg:p1/annot:${last(t).id}`, icon: 'Help', locked: true});
  assert.equal(last(t).dict.Name, '/Help');
  assert.equal(last(t).dict.F & 128, 128);
});

test('Hide all comments is view state; the file is unchanged', async () => {
  const t = await session();
  const v = t.version;
  await t.exec('comment.hide_all', {});
  assert.equal(t.doc.view.commentsHidden, true);
  assert.equal(t.state('comment.hide_all').checked, true);
  await t.exec('comment.hide_all', {});
  assert.equal(t.doc.view.commentsHidden, false);
  assert.equal(t.version, v);
});

test('Flatten draws every comment into its page and removes the annotations (flatten.rs)', async () => {
  const t = await session();
  assert.equal(t.state('comment.flatten').enabled, false, 'Needs::HasComments');
  await t.exec('comment.square', {page: 'p1', points: [[100, 100], [200, 200]]});
  await t.exec('comment.note', {page: 'p1', at: [300, 100], text: 'x'});
  await t.exec('comment.square', {page: 'p2', points: [[100, 100], [200, 200]]});
  const r = await expectUndoRoundTrip(t, 'comment.flatten', {pages: [1]}, after => {
    assert.equal(after.content.pages[0].annots.length, 0);
    assert.equal(after.content.pages[1].annots.length, 1, 'other pages keep theirs');
  });
  assert.equal(r.undoLabel, 'Flatten comments');
  assert.equal(r.result.flattened, 2);
  const {doc} = await reopened(t.content);
  const page = doc.getPage(0);
  assert.equal(page.node.get(PDFName.of('Annots')), undefined);
  const xo = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  assert.ok(xo.get(PDFName.of('PCFl0')) && xo.get(PDFName.of('PCFl1')), 'the appearances are page XObjects now');
  const contents = page.node.lookup(PDFName.of('Contents'), PDFArray).asArray().map(r => doc.context.lookup(r));
  const tail = new TextDecoder().decode(decodePDFRawStream(contents.at(-1)).decode());
  assert.match(tail, /\/PCFl0 Do Q/);
});

test('Export writes XFDF Acrobat reads; Import brings the comments into another copy, replies linked by name', async () => {
  const t = await session('textPages', {prefs: {identity: {name: 'Ada'}}});
  await t.exec('comment.note', {page: 'p1', at: [100, 100], text: 'Exported & <kept>'});
  const parent = last(t);
  await t.exec('annot.reply', {annotation: `/pg:p1/annot:${parent.id}`, text: 'reply'});
  await t.exec('comment.ink', {page: 'p2', strokes: [[[10, 10], [50, 50], [90, 10]]]});
  const r = await t.exec('comment.export', {});
  const xml = r.result.xfdf;
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<xfdf xmlns="http:\/\/ns.adobe.com\/xfdf\/" xml:space="preserve">/);
  assert.match(xml, /<text page="0" rect="[^"]+" name="[^"]+" title="Ada"/);
  assert.match(xml, /<contents>Exported &amp; &lt;kept&gt;<\/contents>/);
  assert.match(xml, /inreplyto="/);
  assert.match(xml, /<ink page="1"[^>]*><inklist><gesture>/);
  const records = readXfdf(xml);
  assert.equal(records.length, 3);
  const fresh = await session();
  const imp = await expectUndoRoundTrip(fresh, 'comment.import', {base64: Buffer.from(xml).toString('base64'), name: 'c.xfdf'}, after => {
    const p1 = after.content.pages[0].annots;
    assert.equal(p1.length, 2);
    assert.equal(p1[1].irt, p1[0].id, 'the reply is linked to its parent by name');
    assert.equal(after.content.pages[1].annots[0].dict.Subtype, '/Ink');
  });
  assert.equal(imp.result.imported, 3);
  // Importing again replaces the same-name comments instead of doubling them.
  await fresh.exec('comment.import', {base64: Buffer.from(xml).toString('base64')});
  assert.equal(fresh.content.pages[0].annots.length, 2);
});

test('Summarize comments writes "Summary of Comments on …" as a PDF, sorted as asked (comments.rs comment_summary)', async () => {
  const t = await session('textPages', {prefs: {identity: {name: 'Ada'}}});
  await t.exec('comment.note', {page: 'p2', at: [100, 100], text: 'second page'});
  await t.exec('comment.square', {page: 'p1', points: [[100, 100], [200, 200]]});
  const text = commentSummary('fixture.pdf', t.content, 'Page');
  assert.match(text, /^Summary of Comments on fixture.pdf\n\nPage: 1\nNumber: 1  Author: Ada  Subject: Rectangle  Date: /);
  assert.match(text, /Page: 2\nNumber: 1  Author: Ada  Subject: Sticky Note  Date: .*\nsecond page/);
  const r = await t.exec('comment.summarize', {sort: 'Type'});
  assert.match(r.result.text, /Subject: Rectangle  Page: 1/);
  const pdf = await PDFDocument.load(Buffer.from(r.result.base64, 'base64'));
  assert.ok(pdf.getPageCount() >= 1);
  assert.match(pdf.getTitle(), /^Summary of Comments on /);
});

test('everything here runs over the bridge with params validation (origin bridge)', async () => {
  const t = await session();
  await t.bridge('comment.note', {page: 1, at: [10, 10], text: 'from the bridge'});
  assert.equal(last(t).dict.Contents.$t, 'from the bridge');
  await assert.rejects(t.bridge('comment.note', {page: 1, at: [10], text: 'x'}), e => e.code === 'invalid_params');
  await assert.rejects(t.bridge('comment.list', {sort: 'Colour'}), e => e.code === 'invalid_params');
});
