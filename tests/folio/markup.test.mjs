// core/folio/commands/markup.mjs: comment.highlight, comment.underline, comment.strikeout,
// comment.squiggly, comment.ink (pen and highlighter), annot.move, annot.resize, annot.reshape,
// annot.style, annot.set_contents, annot.delete, annot.list.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/commands.rs:452-470, tools/comments/input.rs:317,
//    canvas/selection.rs:57, crates/annot/src/create.rs add_annotation): picking a markup tool with
//    text selected marks it at once — one quad per selected line piece, a real Highlight/Underline/
//    StrikeOut/Squiggly annotation with QuadPoints, /C, /CA, an appearance (Highlight with Multiply),
//    listed in the comments list; colour and opacity change later (modify.rs set_style). Acrobat
//    does the same. The Draw tool makes Ink; Acrobat's highlighter pen is Ink drawn with Multiply at
//    a fixed nib.
// 2. Ours does the same end to end: these tests run the commands on real PDFs (built with pdf-lib),
//    write the file with the folio writer, reopen it with pdf-lib and pdf.js and check the
//    dictionaries; tests/e2e/folio/surface-markup.e2e.mjs drives the window over the bridge.
// 3. Tests: below, plus tests/folio/upstream/annots_create.test.mjs and text_layout.test.mjs.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, decodePDFRawStream} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content, base64} from '../../core/folio/fixtures.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';

after(() => releaseTextSources());

const session = (fixture = 'textPages') => createTestSession('folio', {fixture});
const select = (t, page, from, to) => t.session.setSelection(t.docId, {ranges: [{anchor: `/pg:${page}/chars:${from}`, focus: `/pg:${page}/chars:${to}`}]});
const records = (t, page = 0) => t.content.pages[page].annots;

async function reopened(content) {
  const bytes = await writeFolioPdf(content);
  const doc = await PDFDocument.load(bytes);
  const list = page => {
    const arr = doc.getPage(page).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return arr ? arr.asArray().map(e => doc.context.lookup(e)) : [];
  };
  return {bytes, doc, list};
}
const nameOf = (d, k) => d.lookup(PDFName.of(k))?.decodeText?.();
const numsOf = (d, k) => d.lookup(PDFName.of(k), PDFArray).asArray().map(x => x.asNumber());
const apOf = d => String.fromCharCode(...decodePDFRawStream(d.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))).decode());

test('Highlight text marks the selected text with one quad per line, undoably, as "Add highlight"', async () => {
  const t = await session();
  // Characters 30..90 run from "as a real annotation." on line 1 into line 2.
  select(t, 'p1', 30, 90);
  const r = await expectUndoRoundTrip(t, 'comment.highlight', {}, after => {
    const rec = after.content.pages[0].annots.at(-1);
    assert.equal(rec.dict.Subtype, '/Highlight');
    assert.equal(rec.dict.QuadPoints.length, 16, 'two lines → two quads');
  });
  assert.equal(r.undoLabel, 'Add highlight');
  const [q1, q2] = r.result.quads;
  // Each quad is top-left, top-right, bottom-left, bottom-right in user space and sits on its line.
  assert.ok(q1[1] > q2[1], 'the first quad is on the upper line');
  assert.equal(q1[1], q1[3]); assert.equal(q1[5], q1[7]); assert.ok(q1[1] > q1[5]);
  assert.equal(q2[0], 72, 'the second line starts at the left margin');
  assert.deepEqual(t.doc.selection, {ranges: [], primary: 0}, 'the selection is cleared (commands.rs:466)');
});

test('the selection follows the glyphs: highlighting one word gives a quad exactly over it', async () => {
  const t = await session();
  const text = await pageText(t.content, t.content.pages[0]);
  const plain = text.plainText();
  const from = plain.indexOf('quick'), to = from + 'quick'.length;
  const r = await t.exec('comment.highlight', {text: `/pg:p1/chars:${from}-${to}`});
  const [[x0, y0, x1, , , y1]] = r.result.quads;
  const g = text.glyphRange(from, to);
  const first = text.glyphs[g[0]], last = text.glyphs[g[1]];
  assert.ok(Math.abs(x0 - first.rect[0]) < 1e-6 && Math.abs(x1 - last.rect[2]) < 1e-6, 'left/right edges are the glyph edges');
  assert.ok(Math.abs((792 - y0) - first.rect[1]) < 1e-6 && Math.abs((792 - y1) - first.rect[3]) < 1e-6, 'top/bottom are the em box');
});

test('Underline, Strikethrough and Squiggly make their own annotation types with the upstream default colours', async () => {
  const t = await session();
  const want = {'comment.underline': ['/Underline', [0, 0.47, 0.84]], 'comment.strikeout': ['/StrikeOut', [0.89, 0.13, 0.13]], 'comment.squiggly': ['/Squiggly', [0.18, 0.62, 0.36]]};
  for (const [id, [subtype, color]] of Object.entries(want)) {
    select(t, 'p1', 0, 20);
    const r = await t.exec(id);
    const rec = records(t).find(x => x.id === r.result.id);
    assert.equal(rec.dict.Subtype, subtype);
    assert.deepEqual(rec.dict.C, color);
  }
});

test('with no text selected the command picks the tool (view state, no undo entry); state() shows it checked', async () => {
  const t = await session();
  const r = await t.exec('comment.highlight');
  assert.deepEqual(r.result, {tool: 'comment.highlight'});
  assert.equal(t.doc.undo.size, 0);
  assert.equal(t.state('comment.highlight').checked, true);
  assert.equal(t.state('comment.underline').checked, false);
  await t.exec('comment.ink', {highlighter: true});
  assert.equal(t.state('comment.ink', {highlighter: true}).checked, true);
  assert.equal(t.state('comment.ink').checked, false);
});

test('saved PDF: real Highlight/Underline/StrikeOut/Squiggly dictionaries with QuadPoints, colour, opacity and a Multiply appearance', async () => {
  const t = await session();
  select(t, 'p1', 30, 90);
  const h = await t.exec('comment.highlight', {color: '#FF8A00', opacity: 0.6});
  select(t, 'p2', 0, 10);
  await t.exec('comment.underline');
  select(t, 'p2', 60, 80);
  await t.exec('comment.strikeout');
  select(t, 'p2', 100, 120);
  await t.exec('comment.squiggly');
  const {list, bytes} = await reopened(t.content);
  const hl = list(0).find(d => nameOf(d, 'Subtype') === 'Highlight');
  assert.ok(hl, 'a Highlight annotation is in the file');
  assert.deepEqual(numsOf(hl, 'QuadPoints').map(v => Math.round(v * 100) / 100), h.result.quads.flat().map(v => Math.round(v * 100) / 100));
  assert.deepEqual(numsOf(hl, 'C').map(v => Math.round(v * 100) / 100), [1, 0.54, 0]);
  assert.equal(hl.lookup(PDFName.of('CA')).asNumber(), 0.6);
  assert.equal(nameOf(hl, 'NM') ?? hl.lookup(PDFName.of('NM')).decodeText(), h.result.id);
  const res = hl.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')).dict.lookup(PDFName.of('Resources'), PDFDict);
  assert.equal(res.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS0'), PDFDict).lookup(PDFName.of('BM')).decodeText(), 'Multiply');
  assert.match(apOf(hl), /\/GS0 gs\n1 0\.541 0 rg\n[\d. ]+ m [\d. ]+ l [\d. ]+ l [\d. ]+ l h f\n/);
  assert.deepEqual(list(1).map(d => nameOf(d, 'Subtype')), ['Underline', 'StrikeOut', 'Squiggly']);
  // An independent reader (pdf.js) sees the same comments.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: bytes, verbosity: 0});
  const doc = await task.promise;
  const a1 = await (await doc.getPage(1)).getAnnotations();
  const pjHl = a1.find(a => a.subtype === 'Highlight');
  assert.equal(pjHl.quadPoints.length, 16);
  assert.deepEqual(Array.from(pjHl.color), [255, 138, 0]);
  const a2 = await (await doc.getPage(2)).getAnnotations();
  assert.deepEqual(a2.map(a => a.subtype), ['Underline', 'StrikeOut', 'Squiggly']);
  await task.destroy();
});

test('reopening the saved file reads the same comments back (ids, quads, colour) and leaves them untouched on the next save', async () => {
  const t = await session();
  select(t, 'p1', 0, 25);
  const h = await t.exec('comment.highlight');
  const {bytes} = await reopened(t.content);
  const content = await migrateContent(await schema1Content(bytes));
  const back = content.pages[0].annots.find(r => r.id === h.result.id);
  assert.ok(back, 'the /NM id survives');
  assert.equal(back.ap, 'source');
  assert.deepEqual(back.dict.QuadPoints.map(v => Math.round(v * 1000)), records(t).at(-1).dict.QuadPoints.map(v => Math.round(v * 1000)));
  const again = await PDFDocument.load(await writeFolioPdf(content));
  const ref = again.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).get(0);
  assert.deepEqual([ref.objectNumber, ref.generationNumber], back.src, 'an unchanged comment is written back as the same object');
});

test('Draw freehand: an Ink comment from view-space strokes; the highlighter pen is Ink with Multiply and a fixed 12 pt nib', async () => {
  const t = await session();
  const pen = await expectUndoRoundTrip(t, 'comment.ink', {page: 'p1', strokes: [[[100, 300], [150, 310], [200, 305]]]});
  assert.equal(pen.undoLabel, 'Add drawing');
  const hi = await t.exec('comment.ink', {page: 'p1', strokes: [[[100, 400], [140, 402], [180, 401], [260, 404]]], highlighter: true});
  const rec = records(t).find(r => r.id === hi.result.id);
  assert.equal(rec.dict.Subtype, '/Ink');
  assert.equal(rec.dict.AKHighlighter, true);
  assert.equal(rec.dict.BS.W, 12);
  assert.deepEqual(rec.dict.C, [1, 0.94, 0]);
  // View (100, 400) on an unturned Letter page is user (100, 392).
  assert.deepEqual(rec.dict.InkList[0].slice(0, 2), [100, 392]);
  const {list} = await reopened(t.content);
  const ink = list(0).filter(d => nameOf(d, 'Subtype') === 'Ink');
  assert.equal(ink.length, 2);
  const hd = ink.find(d => d.lookup(PDFName.of('AKHighlighter')));
  const inkList = hd.lookup(PDFName.of('InkList'), PDFArray).asArray()[0].asArray().map(x => x.asNumber());
  assert.deepEqual(inkList, [100, 392, 140, 390, 180, 391, 260, 388]);
  const res = hd.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')).dict.lookup(PDFName.of('Resources'), PDFDict);
  assert.equal(res.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS0'), PDFDict).lookup(PDFName.of('BM')).decodeText(), 'Multiply');
  assert.match(apOf(hd), /12 w 1 J 1 j/);
  // The plain pen does not multiply.
  const plain = ink.find(d => !d.lookup(PDFName.of('AKHighlighter')));
  assert.equal(plain.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')).dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('ExtGState')), undefined);
});

test('every comment can be moved, resized, restyled, edited and deleted — each one undo step with the upstream label', async () => {
  const t = await session();
  select(t, 'p1', 0, 25);
  const h = await t.exec('comment.highlight');
  const addr = h.result.annotation;
  const before = records(t).at(-1).dict.QuadPoints.slice();
  const m = await expectUndoRoundTrip(t, 'annot.move', {annotation: addr, dx: 10, dy: 20});
  assert.equal(m.undoLabel, 'Move comment');
  const moved = records(t).at(-1).dict.QuadPoints;
  assert.equal(moved[0], before[0] + 10);
  assert.equal(moved[1], before[1] - 20, 'view +y (down) is user −y');
  const s = await expectUndoRoundTrip(t, 'annot.style', {annotation: addr, color: '#00FF00', opacity: 0.4});
  assert.equal(s.undoLabel, 'Change comment properties');
  assert.deepEqual(records(t).at(-1).dict.C, [0, 1, 0]);
  assert.equal(records(t).at(-1).dict.CA, 0.4);
  const c = await expectUndoRoundTrip(t, 'annot.set_contents', {annotation: addr, text: 'Check this'});
  assert.equal(c.undoLabel, 'Edit comment');
  // A drawing resizes by scaling its strokes.
  const ink = await t.exec('comment.ink', {page: 'p1', strokes: [[[100, 300], [200, 350]]]});
  const r = await expectUndoRoundTrip(t, 'annot.resize', {annotation: ink.result.annotation, rect: [100, 300, 200, 100]});
  assert.equal(r.undoLabel, 'Resize comment');
  // A highlight can't be resized (upstream set_rect), only moved.
  await assert.rejects(t.exec('annot.resize', {annotation: addr, rect: [0, 0, 50, 50]}), e => e.code === 'invalid_params');
  const d = await expectUndoRoundTrip(t, 'annot.delete', {annotation: addr});
  assert.equal(d.undoLabel, 'Delete comment');
});

test('the selected comment is the default target; a locked comment refuses edits', async () => {
  const t = await session();
  select(t, 'p1', 0, 10);
  const h = await t.exec('comment.highlight');
  t.session.setSelection(t.docId, {ranges: [{anchor: h.result.annotation, focus: h.result.annotation}]});
  assert.equal(t.state('annot.delete').enabled, true);
  await t.exec('annot.move', {dx: 1, dy: 1});
  const page = t.content.pages[0];
  const i = page.annots.findIndex(r => r.id === h.result.id);
  await t.session.execute(t.docId, 'annot.style', {color: '#000000'}, {origin: 'test'});
  // Lock it (the Locked flag) through a raw content edit and try again.
  const locked = {...page.annots[i], dict: {...page.annots[i].dict, F: 4 | 128}};
  t.doc.file = {...t.file, content: {...t.content, pages: t.content.pages.map((p, k) => (k ? p : {...p, annots: p.annots.map((r, j) => (j === i ? locked : r))}))}};
  assert.deepEqual(t.state('annot.move'), {enabled: false, reason: 'the comment is locked'});
  await assert.rejects(t.exec('annot.move', {dx: 1, dy: 1}), e => e.code === 'disabled');
});

test('annot.list lists the comments as the comments pane shows them (page order, top edge first)', async () => {
  const t = await session('foreignHighlight');
  select(t, 'p1', 0, 10);
  await t.exec('comment.highlight', {contents: 'Mine'});
  const list = (await t.exec('annot.list')).result;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(x => x.subtype), ['Highlight', 'Highlight']);
  assert.ok(list[0].rect[1] <= list[1].rect[1], 'top edge first');
  assert.deepEqual(list.map(x => x.contents).sort(), ['Imported', 'Mine']);
  assert.equal(list.find(x => x.contents === 'Imported').author, 'Someone else');
});

test('a comment another program wrote is read in, can be moved and keeps its own appearance and unknown keys', async () => {
  const t = await session('foreignHighlight');
  const foreign = records(t)[0];
  assert.equal(foreign.ap, 'source');
  await t.exec('annot.move', {annotation: `/pg:p1/annot:${foreign.id}`, dx: 0, dy: -100});
  const {list, doc} = await reopened(t.content);
  const d = list(0)[0];
  assert.deepEqual(numsOf(d, 'Rect'), [72, 740, 172, 754]);
  assert.equal(nameOf(d, 'Custom'), 'KeepMe');
  const n = d.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'));
  assert.equal(n.objectNumber, foreign.dict.AP.N.$ref[0], 'the original appearance stream is kept (it maps onto the moved /Rect)');
  assert.ok(doc);
});

test('markup on a page turned 90 degrees: quads follow the turned text, in user space', async () => {
  const t = await session('rotatedPage');
  const text = await pageText(t.content, t.content.pages[0]);
  assert.equal(t.content.pages[0].sourceRotation, 90);
  assert.ok(text.plainText().startsWith('Arkemis PDF keeps'));
  const r = await t.exec('comment.highlight', {text: '/pg:p1/chars:0-7'});
  const [q] = r.result.quads;
  // inspect/model.rs view_rect_to_quad: the corners are the line rect's as read on screen (top-left,
  // top-right, bottom-left, bottom-right), mapped to user space. "Arkemis" runs along user +x from
  // 72 with its baseline at 720 (12 pt: descender 717.6, ascender 729.6).
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  assert.ok(Math.abs(Math.min(...xs) - 72) < 0.01 && Math.abs(Math.max(...xs) - text.glyphs[6].rect[3]) < 0.01, `covers "Arkemis" along x: ${q}`);
  assert.ok(Math.abs(Math.min(...ys) - 717.6) < 0.01 && Math.abs(Math.max(...ys) - 729.6) < 0.01, `spans descender to ascender: ${q}`);
  // On screen the page is turned a quarter clockwise: the screen's top-left corner is user (72, 717.6).
  assert.deepEqual([q[0], q[1]].map(v => Math.round(v * 100) / 100), [72, 717.6]);
});

test('over the bridge the edit is "Automation: Add highlight" and bad params are invalid_params', async () => {
  const t = await session();
  const r = await t.bridge('comment.highlight', {text: '/pg:p1/chars:0-7'});
  assert.equal(r.undoLabel, 'Automation: Add highlight');
  await assert.rejects(t.bridge('comment.highlight', {text: '/pg:p1/word:1'}), e => e.code === 'invalid_params');
  await assert.rejects(t.bridge('comment.highlight', {rects: [[0, 0, 10, 10]]}), e => e.code === 'invalid_params');
  await assert.rejects(t.bridge('comment.ink', {page: 'nope', strokes: [[[0, 0]]]}), e => e.code === 'not_found');
  await assert.rejects(t.bridge('annot.move', {dx: 1, dy: 1}), e => e.code === 'invalid_params' || e.code === 'disabled');
});

test('schema-1 content (comments not read yet) disables the comment commands with a reason', async () => {
  const bytes = Uint8Array.from(atob((await (await import('../../core/folio/fixtures.mjs')).textPages()).sourceBase64), c => c.charCodeAt(0));
  const t = await createTestSession('folio', {content: await schema1Content(bytes)});
  assert.deepEqual(t.state('comment.highlight'), {enabled: false, reason: 'the PDF is still opening', checked: false});
  assert.ok(base64);
});
