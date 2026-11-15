// The folio foundation (docs/architecture.md 14.5, 14.7, 16.4): schema 2, the schema-1 migration,
// the address resolver, contextual flags, the page view's geometry (core/folio/lib/pageview.mjs)
// and the appearance painter (core/folio/lib/content-paint.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft keeps every comment as an annotation dictionary read from the file (crates/annot
//    lookup.rs, info.rs), lays pages out continuously (crates/ui-egui/src/canvas.rs: PT, GAP, MARGIN,
//    SIDE), hit-tests comments topmost first, markup by its quads (tools/comments/state.rs), resizes
//    by eight handles (geometry.rs) and paints comments from their appearance streams. Acrobat
//    behaves the same.
// 2. Ours: these tests run the translated modules on real PDFs built with pdf-lib.
// 3. Tests below; the window flows are tests/e2e/folio/surface-*.e2e.mjs.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {textPdf, schema1Content, textPages} from '../../core/folio/fixtures.mjs';
import {migrateContent, needsMigration, overlayRecord} from '../../core/folio/migrate.mjs';
import {validateContent, createContent, applyLegacyCommand} from '../../core/folio/schema.mjs';
import * as address from '../../core/folio/address.mjs';
import {evaluate, flags} from '../../core/folio/context.mjs';
import {pageText, releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {layoutPages, visiblePages, currentPage, fitZoom, hitComment, resized, handlePos, HANDLES, runSelection, selectionRun, clickUnit, PT, GAP, MARGIN,
  isMarkup, movable, resizable, reshapable, viewRects, shownOnPage} from '../../core/folio/lib/pageview.mjs';
import {tokenize, paintForm, appearanceMatrix, decodeWinAnsi, recordAppearance, userToCanvas, cssFont} from '../../core/folio/lib/content-paint.mjs';
import {createAnnotation} from '../../core/folio/model/annots.mjs';
import {defaultStyle} from '../../core/folio/model/types.mjs';
import {userToView} from '../../core/folio/lib/geom.mjs';
import {createTestSession} from '../../core/kernel/testing.mjs';

after(() => releaseTextSources());

test('schema 2: an empty document, validation of comment records, duplicate ids refused', async () => {
  assert.deepEqual(createContent(), {sourceBase64: '', sourceName: '', pages: [], activePageId: '', folio: 2});
  const c = await textPages();
  assert.equal(c.folio, 2);
  assert.ok(validateContent(c));
  const bad = structuredClone(c);
  const r = createAnnotation({shape: {kind: 'Rectangle', rect: [10, 10, 50, 50]}, style: defaultStyle({kind: 'Rectangle'})}, {id: 'dup'});
  bad.pages[0].annots = [r, {...r}];
  assert.throws(() => validateContent(bad), /Duplicate comment id dup/);
  const orphan = structuredClone(c);
  orphan.pages[0].annots = [{...r, irt: 'nobody'}];
  assert.throws(() => validateContent(orphan), /replies to a comment that does not exist/);
});

test('migration: the file\'s comments are read, the old build\'s overlays become the comments they stood for, ids stay unique on duplicated pages', async () => {
  const bytes = await textPdf({pages: 2, foreignHighlight: true});
  const s1 = await schema1Content(bytes);
  s1.pages[0].overlays = [
    {id: 'o1', type: 'highlight', x: 72, y: 100, width: 120, height: 14, color: '#ffef00'},
    {id: 'o2', type: 'rectangle', x: 100, y: 300, width: 80, height: 40, color: '#e32222'},
    {id: 'o3', type: 'text', x: 100, y: 400, width: 200, height: 40, text: 'Note', fontSize: 12, color: '#000000'},
  ];
  s1.pages.push({...s1.pages[0], id: 'p3', overlays: []});   // a duplicate of page 1 (same source page)
  assert.equal(needsMigration(s1), true);
  const c = await migrateContent(s1);
  assert.equal(needsMigration(c), false);
  assert.equal(await migrateContent(c), c, 'idempotent');
  const subtypes = c.pages[0].annots.map(r => r.dict.Subtype);
  assert.deepEqual(subtypes, ['/Highlight', '/Highlight', '/Square', '/FreeText']);
  assert.ok(c.pages[0].annots[0].src, 'the file\'s highlight keeps its source object');
  assert.equal(c.pages[0].annots[0].ap, 'source');
  assert.deepEqual(c.pages[0].overlays, []);
  const ids = c.pages.flatMap(p => (p.annots ?? []).map(r => r.id));
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.equal(c.pages[2].annots.length, 1, 'the duplicate carries a copy of the file\'s comment');
  assert.notEqual(c.pages[2].annots[0].id, c.pages[0].annots[0].id);
  // The old highlight rectangle (top-left origin) becomes a highlight over the same area in user space.
  const o1 = overlayRecord(s1.pages[0].overlays[0], s1.pages[0], [0, 0, 612, 792]);
  assert.deepEqual(o1.dict.Rect.map(Math.round), [72, 678, 192, 692]);
  // /v1 page operations still run on schema-2 content and keep the comments.
  const dup = applyLegacyCommand(c, {type: 'pdf_operation', operation: {type: 'duplicate', pageId: 'p1'}});
  assert.equal(dup.pages.length, 4);
  validateContent(dup);
});

test('addresses: pages, comments, page text (chars, word), regions, friendly forms, mapping through deletes', async () => {
  const c = await textPages();
  const text = await pageText(c, c.pages[0]);
  const plain = text.plainText();
  const ast = address.parse('/pg:p1/chars:0-7');
  assert.equal(address.format(ast), '/pg:p1/chars:0-7');
  assert.deepEqual(address.read(c, ast, 'json').text, 'Arkemis');
  assert.equal(address.read(c, address.parse('/pg:p1'), 'text'), plain);
  const w = address.read(c, address.parse('/pg:p1/word:2'), 'json');
  assert.equal(w.text, 'keeps');
  assert.equal(address.read(c, address.parse(w.address), 'json').text, 'keeps');
  assert.deepEqual(address.read(c, address.parse('/pg:p1/rect:0,0,612,792'), 'json').user, [0, 0, 612, 792]);
  assert.equal(address.canonical(c, 'page 2'), '/pg:p2');
  assert.throws(() => address.parse('/pg:p1/nope:1'), e => e.code === 'invalid_address');
  assert.throws(() => address.resolve(c, address.parse('/pg:zz')), e => e.code === 'not_found');
  // A comment: canonical address, view rect, mapping when it is deleted.
  const t = await createTestSession('folio', {content: c});
  const r = await t.exec('comment.highlight', {text: '/pg:p1/chars:0-7'});
  const read = t.session.read(t.docId, r.result.annotation, 'json');
  assert.equal(read.subtype, 'Highlight');
  assert.equal(read.address, r.result.annotation);
  const anchor = t.session.anchor(t.docId, r.result.annotation);
  await t.exec('annot.delete', {annotation: r.result.annotation});
  assert.deepEqual(t.session.where(t.docId, anchor), {deleted: true, nearest: '/pg:p1'});
  // document.inspect lists pages and their comments with addresses.
  const nodes = address.enumerate(t.content, null, {depth: 2, limit: 100}).nodes;
  assert.deepEqual(nodes.filter(n => n.kind === 'page').map(n => n.address), ['/pg:p1', '/pg:p2']);
  // document.find over the page text.
  const found = address.find(c, {query: 'quad per line'});
  assert.equal(found.matches[0].text, 'quad per line');
});

test('contextual flags: annotation, text selection, page selection', () => {
  const c = {pages: [{id: 'p1'}]};
  assert.deepEqual(Object.keys(evaluate(c, null)), flags);
  assert.equal(evaluate(c, {ranges: [{anchor: '/pg:p1/annot:a', focus: '/pg:p1/annot:a'}]}).annotation, true);
  assert.equal(evaluate(c, {ranges: [{anchor: '/pg:p1/chars:0', focus: '/pg:p1/chars:5'}]})['text-selection'], true);
  assert.equal(evaluate(c, {ranges: [{anchor: '/pg:p1', focus: '/pg:p1'}]})['page-selection'], true);
});

test('page view layout (canvas.rs): pages stacked GAP apart between MARGINs at PT per point, virtualized, current page, fit', () => {
  const pages = Array.from({length: 5}, (_, i) => ({id: `p${i}`, width: 612, height: 792, sourceRotation: 0, rotation: i === 2 ? 90 : 0}));
  const l = layoutPages(pages, 100, 1200);
  assert.ok(Math.abs(l.scale - PT) < 1e-12);
  assert.equal(l.tops[0], MARGIN);
  assert.ok(Math.abs(l.tops[1] - (MARGIN + 792 * PT + GAP)) < 1e-9);
  assert.ok(Math.abs(l.widths[2] - 792 * PT) < 1e-9, 'a turned page is wider than tall');
  assert.equal(l.height, l.tops[4] + l.heights[4] + MARGIN);
  assert.ok(Math.abs(l.left(0) - (1200 - 612 * PT) / 2) < 1e-9);
  assert.deepEqual(visiblePages(l, 0, 800), [0, 0]);
  assert.deepEqual(visiblePages(l, l.tops[1] - 20, 400), [0, 1]);
  assert.deepEqual(visiblePages(l, l.tops[1] - 10, 400), [1, 1], "the gap between pages shows neither");
  assert.equal(currentPage(l, l.tops[3] - 100, 900), 3);
  const w = fitZoom('pageWidth', pages[0], 1000, 800);
  assert.ok(Math.abs(w - (1000 - 140) / (612 * PT) * 100) < 1e-9);
  assert.ok(fitZoom('page', pages[0], 1000, 800) < w);
});

test('comment hit tests and handles (state.rs hit, geometry.rs): topmost first, markup by its quads, eight handles, corner ratio', async () => {
  const c = await textPages();
  const page = c.pages[0];
  const t = await createTestSession('folio', {content: c});
  const h = await t.exec('comment.highlight', {text: '/pg:p1/chars:0-7'});
  const sq = await t.exec('comment.ink', {page: 'p1', strokes: [[[100, 300], [200, 340]]]});
  const p = t.content.pages[0];
  const hl = p.annots.find(r => r.id === h.result.id), ink = p.annots.find(r => r.id === sq.result.id);
  assert.equal(isMarkup('Highlight'), true);
  assert.equal(movable(hl), false, 'text markup stays with its text');
  assert.equal(movable(ink), true);
  assert.equal(resizable(ink), true);
  assert.equal(reshapable(ink), false);
  const [q] = viewRects(p, hl);
  assert.equal(hitComment(p, (q[0] + q[2]) / 2, (q[1] + q[3]) / 2)?.id, hl.id);
  assert.equal(hitComment(p, 150, 320)?.id, ink.id);
  assert.equal(hitComment(p, 500, 700), null);
  assert.equal(shownOnPage(hl), true);
  assert.equal(HANDLES.length, 8);
  assert.deepEqual(handlePos([0, 0, 10, 20], [1, 1]), [10, 20]);
  assert.deepEqual(resized([0, 0, 10, 20], [1, 0], 5, 99), [0, 0, 15, 20]);
  assert.deepEqual(resized([0, 0, 10, 20], [1, 1], 10, 0, 0.5), [0, 0, 20, 40], 'a corner keeps the ratio');
  assert.ok(page);
});

test('text selection ↔ session selection: a run as chars carets, read back to the same glyphs; click units', async () => {
  const c = await textPages();
  const text = await pageText(c, c.pages[0]);
  const sel = runSelection('p1', text, 40, 10);   // dragged backwards
  const back = selectionRun({ranges: [sel], primary: 0}, () => text);
  assert.deepEqual([back.first, back.last, back.anchorGlyph, back.headGlyph], [10, 40, 40, 10]);
  const word = clickUnit(text, 2, 3);
  assert.equal(text.textOf(word[0], word[1] + 1), 'Arkemis');
  const line = clickUnit(text, 3, 3);
  assert.equal(text.textOf(line[0], line[1] + 1), 'Arkemis PDF keeps every comment as a real annotation.');
  assert.deepEqual(clickUnit(text, 4, 3), [0, text.glyphs.length - 1]);
});

/** A Canvas 2D stand-in that records what is drawn. */
function recorder() {
  const calls = [];
  const ctx = {calls, lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', font: '', lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
    getTransform: () => ({a: 2, b: 0})};
  for (const m of ['save', 'restore', 'transform', 'translate', 'scale', 'beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'closePath', 'rect', 'clip', 'setLineDash', 'fillText', 'strokeText', 'setTransform']) {
    ctx[m] = (...a) => calls.push([m, ...a]);
  }
  ctx.fill = rule => calls.push(['fill', rule, ctx.fillStyle, ctx.globalAlpha, ctx.globalCompositeOperation]);
  ctx.stroke = () => calls.push(['stroke', ctx.strokeStyle, ctx.lineWidth, ctx.globalAlpha, ctx.globalCompositeOperation]);
  return ctx;
}

test('appearance painting: the stream the writer saves is painted, Highlight with Multiply at its opacity, text in WinAnsi', async () => {
  assert.deepEqual(tokenize('/GS0 gs 1 0.5 0 rg 10 20 m (a\\(b\\)) Tj [(x) -250 (y)] TJ <4142> Tj'),
    ['/GS0', {op: 'gs'}, 1, 0.5, 0, {op: 'rg'}, 10, 20, {op: 'm'}, {str: 'a(b)'}, {op: 'Tj'}, [{str: 'x'}, -250, {str: 'y'}], {op: 'TJ'}, {str: 'AB'}, {op: 'Tj'}]);
  assert.equal(decodeWinAnsi('caf\xe9 \x80'), 'café €');
  assert.equal(cssFont('/Helvetica-Bold', 12), 'bold 12px Helvetica, Arial, sans-serif');
  assert.deepEqual(appearanceMatrix([0, 0, 10, 10], null, [100, 200, 120, 220]), [2, 0, 0, 2, 100, 200]);
  const shape = {kind: 'TextMarkup', markup: 'Highlight', quads: [[72, 732, 120, 732, 72, 718, 120, 718]]};
  const r = createAnnotation({shape, style: {...defaultStyle(shape), opacity: 0.6}}, {id: 'h1'});
  const ap = recordAppearance(r);
  const ctx = recorder();
  paintForm(ctx, ap.form, ap.rect);
  const fill = ctx.calls.find(x => x[0] === 'fill');
  assert.deepEqual(fill.slice(2), ['rgb(255, 240, 0)', 0.6, 'multiply']);
  // A text box draws its text.
  const tb = createAnnotation({shape: {kind: 'TextBox', rect: [100, 100, 300, 140], fontSize: 12}, style: defaultStyle({kind: 'TextBox'}), contents: 'Hello'}, {id: 't1'});
  const ctx2 = recorder();
  paintForm(ctx2, recordAppearance(tb).form, recordAppearance(tb).rect);
  assert.ok(ctx2.calls.some(x => x[0] === 'fillText' && x[1] === 'Hello'));
  // user space → canvas for an unturned page at scale 2: y flips about the crop box top.
  const m = userToCanvas((x, y) => userToView({width: 612, height: 792, sourceRotation: 0, rotation: 0}, x, y), 2);
  assert.deepEqual(m, [2, 0, 0, -2, 0, 1584]);
});

test('PDF bytes: the content migrated from a file written by pdf-lib reopens', async () => {
  const c = await textPages();
  const doc = await PDFDocument.load(Uint8Array.from(atob(c.sourceBase64), ch => ch.charCodeAt(0)));
  assert.equal(doc.getPageCount(), 2);
});
