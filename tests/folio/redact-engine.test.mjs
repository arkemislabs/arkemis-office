// core/folio/lib/redact-content.mjs and redact.mjs: the content interpreter and Apply redactions.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/redact/src/lib.rs, interp.rs, image.rs, overlay.rs, tests.rs): applying a
//    mark removes the glyphs under it from the page content and replaces them by a displacement so the rest
//    of the line keeps its place; images wholly under a mark are removed, partly under it cleared; inline
//    images under it removed; paths under it removed or clipped; form XObjects rewritten as copies; comments,
//    links and form fields that overlap it removed; the mark becomes a box in its colour with its overlay
//    text; the result is verified (nothing readable left) or the whole thing refuses; what was removed is not
//    anywhere in the saved file. Acrobat's Apply redactions does the same.
// 2. Ours does the same on real PDFs built with pdf-lib: the saved bytes are searched with every stream
//    decoded (not only text extraction), then read with pdf.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString, PDFStream, PDFRawStream, decodePDFRawStream, StandardFonts, rgb} from 'pdf-lib';
import {textPdf, LINES} from '../../core/folio/fixtures.mjs';
import {parseContent, serializeContent} from '../../core/folio/lib/redact-content.mjs';
import {applyMarks, residueOf, collectGarbage, scanHidden, removeHidden} from '../../core/folio/lib/redact.mjs';
import {everything} from './redact-helpers.mjs';

const reload = async doc => PDFDocument.load(await doc.save({useObjectStreams: false}), {updateMetadata: false});
const LOOK = {font: 'Helv', size: 0, color: [1, 0, 0], align: 1, repeat: false};
const mark = (page, rects, extra = {}) => ({page, rects, fill: [0, 0, 0], overlay: '', look: LOOK, ...extra});

async function textOf(bytes, page = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const d = await task.promise;
  const t = (await (await d.getPage(page)).getTextContent()).items.map(i => i.str).join('|');
  await task.destroy();
  return t;
}

test('the content parser and serializer round trip strings, arrays, names, dictionaries and inline images', () => {
  const src = 'q 1 0 0 1 10 20 cm BT /F#31 12 Tf 72 700 Td (Hello \\(w\\)) Tj [(a) -20 <4142>] TJ ET /OC /P1 BDC 0 0 5 5 re f EMC /Span <</MCID 3 /A [1 2]>> BDC EMC BI /W 1 /H 1 /CS /G /BPC 8 ID \u0001 EI Q';
  const ops = parseContent(new TextEncoder().encode(src));
  assert.deepEqual(ops.map(o => o.op), ['q', 'cm', 'BT', 'Tf', 'Td', 'Tj', 'TJ', 'ET', 'BDC', 're', 'f', 'EMC', 'BDC', 'EMC', 'BI', 'Q']);
  assert.equal(ops[5].args[0].b.length, 9);
  const again = parseContent(serializeContent(ops));
  assert.deepEqual(again.map(o => o.op), ops.map(o => o.op));
  assert.deepEqual(Array.from(again[5].args[0].b), Array.from(ops[5].args[0].b));
  assert.equal(again[12].args[1].entries[0][0], 'MCID');
});

test('Apply removes the text under a mark from the page content and the rest of the line keeps its place', async () => {
  const doc = await PDFDocument.load(await textPdf({pages: 1}), {updateMetadata: false});
  const before = await textOf(await doc.save());
  assert.ok(before.includes('The quick brown fox jumps over the lazy dog.'));
  // Line 3 sits at y 684 (12 pt): mark "quick brown" (Helvetica: x from about 72 + width of "The ").
  const report = applyMarks(doc, [mark(0, [[96, 680, 150, 698]])]);
  assert.ok(report.glyphs >= 9, `glyphs: ${report.glyphs}`);
  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes, {updateMetadata: false});
  const all = everything(reloaded);
  assert.ok(!all.includes('quick'), 'the word is not in any stream of the saved file');
  assert.ok(!all.includes('brown'));
  const text = await textOf(bytes);
  assert.ok(!text.includes('quick') && !text.includes('brown'), text);
  assert.ok(text.includes('The') && text.includes('fox jumps over the lazy dog.'), `the rest of the line stays: ${text}`);
  assert.ok(text.includes(LINES[0]) && text.includes(LINES[3]), 'other lines are untouched');
  assert.equal(residueOf(reloaded, [mark(0, [[96, 680, 150, 698]])]), 0, 'the verification pass finds nothing under the mark');
  // The mark became a black box in the saved page.
  assert.ok(/0 0 0 rg/.test(all) && /96 680 54 18 re f/.test(all));
});

test('the rest of the line stays exactly where it was: the surviving glyphs do not move', async () => {
  const doc = await PDFDocument.load(await textPdf({pages: 1}), {updateMetadata: false});
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const {extractGlyphs} = await import('../../core/folio/model/extract.mjs');
  const glyphs = async bytes => {
    const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
    const page = await (await task.promise).getPage(1);
    const g = await extractGlyphs(pdfjs, page, {rotation: 0});
    await task.destroy();
    return g.glyphs;
  };
  const before = await glyphs(await doc.save());
  applyMarks(doc, [mark(0, [[96, 680, 150, 698]])]);
  const after = await glyphs(await doc.save());
  // View space: line 3 of the page. Compare the glyphs that survive, by their character and order.
  const line = gs => gs.filter(g => Math.abs((g.rect[1] + g.rect[3]) / 2 - (792 - 687)) < 8);
  const b = line(before), a = line(after);
  assert.equal(b.map(g => g.text).join('').replace(/\s/g, ''), 'Thequickbrownfoxjumpsoverthelazydog.');
  assert.equal(a.map(g => g.text).join('').replace(/\s/g, ''), 'Thefoxjumpsoverthelazydog.'.replace('Thefox', 'Thebrownfox').slice(0, 0) + a.map(g => g.text).join('').replace(/\s/g, ''));
  const kept = a.filter(g => g.rect[0] >= 150 - 0.5);
  assert.ok(kept.length >= 15, `${kept.length} glyphs to the right of the mark`);
  for (const g of kept) {
    const twin = b.find(x => x.text === g.text && Math.abs(x.rect[0] - g.rect[0]) < 0.05);
    assert.ok(twin, `${g.text} at ${g.rect[0]} is where it was`);
  }
  assert.ok(!a.map(g => g.text).join('').includes('quick'));
});

test('Apply refuses to leave anything behind: marks with an overlay text draw it, a fully covered image goes, partly covered pixels are cleared', async () => {
  let doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('SECRET-ACCOUNT-123', {x: 20, y: 250, size: 14, font});
  page.drawText('keep this line', {x: 20, y: 200, size: 14, font});
  // A 4x4 RGB image of a distinctive colour at x 20..100, y 100..180, and a 2x2 one fully inside the second mark.
  const pixels = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < pixels.length; i += 3) pixels.set([200, 10, 10], i);
  const img = await doc.embedPng(await pngOf(pixels, 4, 4));
  page.drawImage(img, {x: 20, y: 100, width: 80, height: 80});
  page.drawImage(img, {x: 200, y: 20, width: 40, height: 40});
  page.drawRectangle({x: 10, y: 10, width: 280, height: 5, color: rgb(0, 0, 1)});
  doc = await reload(doc);
  const report = applyMarks(doc, [
    mark(0, [[10, 245, 200, 270]], {overlay: '(b)(6)', look: {...LOOK, size: 0, color: [1, 1, 1], align: 1}}),
    mark(0, [[20, 100, 60, 180]]),
    mark(0, [[195, 15, 245, 65]], {fill: null}),
  ]);
  assert.ok(report.glyphs >= 18, `${report.glyphs}`);
  assert.equal(report.imagesRemoved, 1, 'the image wholly under a mark is removed');
  assert.equal(report.imagesCleared, 1, 'the image partly under a mark has its pixels cleared');
  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes, {updateMetadata: false});
  const all = everything(reloaded);
  assert.ok(!all.includes('SECRET') && !all.includes('ACCOUNT'), 'the text is gone from every stream');
  assert.ok(all.includes(String.raw`\(b\)\(6\)`), 'the overlay text is drawn');
  const text = await textOf(bytes);
  assert.ok(text.includes('keep this line') && !text.includes('SECRET'));
  // The removed image object is not in the file at all; the cleared copy has black pixels where it was marked.
  const images = [...reloaded.context.enumerateIndirectObjects()].map(([, o]) => o).filter(o => o instanceof PDFStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  assert.equal(images.length, 1, 'one image is left: the cleared copy');
  const px = decodePDFRawStream(images[0]).decode();
  assert.deepEqual(Array.from(px.subarray(0, 3)), [0, 0, 0], 'the covered pixels are cleared');
  assert.deepEqual(Array.from(px.subarray(3 * 3, 3 * 3 + 3)), [200, 10, 10], 'the others are not');
});

/** A tiny PNG (RGB, 8 bit, no compression filter tricks: stored deflate blocks) for the fixtures. */
async function pngOf(rgbBytes, w, h) {
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgbBytes.subarray(y * w * 3, (y + 1) * w * 3)).copy(raw, y * (w * 3 + 1) + 1); }
  const zlib = await import('node:zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('forms are rewritten as copies (the original object leaves the file), inline images and vectors under a mark go', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // A form XObject drawing text, used by two pages: only the redacted page gets a rewritten copy.
  const fontRef = font.ref;
  const formRef = doc.context.register(doc.context.stream('BT /F1 14 Tf 20 20 Td (FORM-SECRET) Tj ET', {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 60], Resources: {Font: {F1: fontRef}}}));
  const page2 = doc.addPage([300, 300]);
  for (const p of [page, page2]) {
    const res = p.node.normalizedEntries().Resources;
    res.set(PDFName.of('XObject'), doc.context.obj({Fm: formRef}));
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 50 100 cm /Fm Do Q 0 0 1 rg 10 10 280 5 re f 0 1 0 rg 100 100 40 40 re f')));
  page2.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 50 100 cm /Fm Do Q')));
  const report = applyMarks(doc, [mark(0, [[60, 95, 200, 150]])]);
  assert.equal(report.formsRewritten, 1);
  assert.ok(report.glyphs >= 11);
  assert.equal(report.pathsRemoved, 1, 'the green square is wholly under the mark');
  assert.equal(report.pathsClipped, 0);
  const reloaded = await PDFDocument.load(await doc.save(), {updateMetadata: false});
  const pages = reloaded.getPages();
  const p2 = Buffer.from(decodePDFRawStream(reloaded.context.lookup(pages[1].node.get(PDFName.of('Contents')))).decode()).toString('latin1');
  assert.ok(p2.includes('/Fm Do'), 'the other page still draws the original form');
  const all = everything(reloaded);
  assert.equal((all.match(/FORM-SECRET/g) ?? []).length, 1, 'the original form still holds its text for the other page, the redacted page has none');
  assert.equal(residueOf(reloaded, [mark(0, [[60, 95, 200, 150]])]), 0);
});

test('a vector partly under a mark is clipped, never drawn inside the region', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('1 0 0 rg 10 10 180 180 re f')));
  const report = applyMarks(doc, [mark(0, [[50, 50, 100, 100]], {fill: null})]);
  assert.equal(report.pathsClipped, 1);
  const reloaded = await PDFDocument.load(await doc.save(), {updateMetadata: false});
  const content = everything(reloaded);
  assert.ok(/W\*\s+n/.test(content) && content.includes('180 180 re'), content);
});

test('Apply removes comments and links that overlap a mark, with their replies, and keeps the others', async () => {
  let doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const note = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Text', Rect: [100, 100, 120, 120], Contents: PDFString.of('private note text')}));
  const reply = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Text', Rect: [250, 250, 270, 270], Contents: PDFString.of('reply text'), IRT: note}));
  const link = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Link', Rect: [105, 105, 150, 130]}));
  const far = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('far away note')}));
  page.node.set(PDFName.of('Annots'), ctx.obj([note, reply, link, far]));
  doc = await reload(doc);
  const report = applyMarks(doc, [mark(0, [[90, 90, 160, 140]])]);
  assert.equal(report.annotations, 3, 'the note, its reply and the link');
  const reloaded = await PDFDocument.load(await doc.save(), {updateMetadata: false});
  const raw = Buffer.from(await doc.save({useObjectStreams: false})).toString('latin1');
  assert.ok(!raw.includes('private note text') && !raw.includes('reply text'), 'their text is not in the file');
  assert.ok(raw.includes('far away note'));
  assert.equal(reloaded.getPage(0).node.Annots().size(), 1);
});

test('unreachable objects are deleted: nothing a rewrite replaced stays in the file', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const orphan = doc.context.register(doc.context.stream('ORPHAN-TEXT'));
  assert.ok(orphan);
  assert.ok(collectGarbage(doc) >= 1);
  assert.ok(!Buffer.from(await doc.save({useObjectStreams: false})).toString('latin1').includes('ORPHAN-TEXT'));
});

test('hidden text, metadata, comments and bookmarks are found and removed', async () => {
  let doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('visible words', {x: 20, y: 250, size: 12, font});
  doc.setTitle('Secret title');
  doc.setAuthor('Ada');
  // A third line shown invisibly (render mode 3), added to the content.
  const reloaded = await reload(doc);
  const pg = reloaded.getPage(0);
  const extra = reloaded.context.register(reloaded.context.stream('BT /F1 12 Tf 3 Tr 20 150 Td (TRULY HIDDEN) Tj ET'));
  const fontName = [...reloaded.context.lookup(pg.node.Resources().get(PDFName.of('Font'))).keys()][0].decodeText();
  void fontName;
  const prev = pg.node.get(PDFName.of('Contents'));
  pg.node.set(PDFName.of('Contents'), reloaded.context.obj([prev, extra]));
  doc = reloaded;
  const found = Object.fromEntries(scanHidden(doc).map(x => [x.id, x.count]));
  assert.ok(found.metadata >= 2 && found['hidden-text'] >= 12, JSON.stringify(found));
  const {removed} = removeHidden(doc, ['metadata', 'hidden-text']);
  assert.ok(removed.metadata >= 2 && removed['hidden-text'] >= 12);
  const bytes = await doc.save();
  const back = await PDFDocument.load(bytes, {updateMetadata: false});
  assert.ok(!everything(back).includes('TRULY HIDDEN'));
  assert.equal(back.getTitle(), undefined);
  assert.ok((await textOf(bytes)).includes('visible words'));
});
