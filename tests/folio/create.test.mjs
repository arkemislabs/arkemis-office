// Create a PDF: core/folio/lib/create.mjs and core/folio/commands/create.mjs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/create (blank: 3 to 14,400 points a side, up to 10,000 pages; image pages the size of the picture at its own
//    resolution, 72 dpi without one, or 72 dpi, or a custom dpi; text pages), create_ui.rs (an image or text file converts to a new PDF, a PDF is
//    not converted), create_multiple_ui.rs (several files joined in order with one bookmark each, a file that cannot be converted is left out and
//    named; separate PDFs: a PDF source is left out, names are plain). Acrobat's Create a PDF does the same.
// 2. Ours does the same on real bytes; the new document's pages are read back with pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import zlib from 'node:zlib';
import {REPLACEMENT_PNG, textPdf} from '../../core/folio/fixtures.mjs';
import {blankPdf, imagesPdf, textPdf as textPages, sourceKind, imageDpi, convertToPdf} from '../../core/folio/lib/create.mjs';
import {plainName} from '../../core/folio/lib/folder-out.mjs';

const tiny = () => Uint8Array.from(Buffer.from(REPLACEMENT_PNG, 'base64'));
/** A w x h grey PNG (a page needs at least 3 points a side, so the 1 pixel picture is too small to be one at 72 dpi). */
function png(w = 72, h = 36) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 128);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Uint8Array.from(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const open = () => createTestSession('folio', {fixture: 'textPages'});
const pages = async bytes => (await PDFDocument.load(bytes)).getPages().map(p => p.getSize());

test('a blank PDF is Letter by default; sizes and counts outside PDF\'s limits are refused', async () => {
  assert.deepEqual(await pages(await blankPdf()), [{width: 612, height: 792}]);
  assert.equal((await pages(await blankPdf(200, 300, 3))).length, 3);
  await assert.rejects(blankPdf(2, 300), /invalid page size/);
  await assert.rejects(blankPdf(200, 20000), /invalid page size/);
  await assert.rejects(blankPdf(200, 300, 0), /invalid page size/);
});

test('what Create takes is told by the bytes: a PDF, a JPEG, a PNG, text; the picture\'s resolution comes from its density', async () => {
  assert.equal(sourceKind('a.bin', await blankPdf()), 'pdf');
  assert.equal(sourceKind('a.png', png()), 'png');
  assert.equal(sourceKind('a.txt', new TextEncoder().encode('hello')), 'text');
  assert.equal(sourceKind('a.txt', Uint8Array.of(0, 1, 2)), null, 'binary data is not text');
  assert.equal(sourceKind('a.bmp', Uint8Array.of(66, 77, 1, 2)), null);
  const jfif = Uint8Array.of(0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0x01, 0x2C, 0x01, 0x2C, 0, 0, 0xFF, 0xD9);
  assert.equal(sourceKind('a.jpg', jfif), 'jpeg');
  assert.deepEqual(imageDpi('jpeg', jfif), [300, 300], 'JFIF density in dots per inch');
  const withPhys = Uint8Array.from([...tiny().slice(0, 33), 0, 0, 0, 9, 0x70, 0x48, 0x59, 0x73, 0, 0, 0x2E, 0x23, 0, 0, 0x2E, 0x23, 1, 0, 0, 0, 0, ...tiny().slice(33)]);
  const [dx] = imageDpi('png', withPhys);
  assert.ok(Math.abs(dx - 300) < 0.1, 'pHYs pixels per metre');
  assert.equal(imageDpi('png', tiny()), null);
});

test('image pages: the picture\'s own resolution (72 without one), 72 dpi, or a custom dpi; only JPEG and PNG', async () => {
  const one = await pages(await imagesPdf([{name: 'a.png', bytes: png()}]));
  assert.ok(Math.abs(one[0].width - 72) < 1e-6 && Math.abs(one[0].height - 36) < 1e-6, 'a 72 x 36 px picture at 72 dpi is 72 x 36 points');
  await assert.rejects(imagesPdf([{name: 't.png', bytes: tiny()}]), /outside PDF/);
  const custom = await pages(await imagesPdf([{name: 'a.png', bytes: png()}, {name: 'b.png', bytes: png()}], {mode: 'custom', dpi: 36}));
  assert.equal(custom.length, 2);
  assert.ok(Math.abs(custom[0].width - 144) < 1e-6, '72 px at 36 dpi is 144 points');
  await assert.rejects(imagesPdf([{name: 'a.png', bytes: png()}], {mode: 'custom', dpi: 0}), /resolution/);
  await assert.rejects(imagesPdf([]), /no images/);
  await assert.rejects(imagesPdf([{name: 'a.bmp', bytes: Uint8Array.of(66, 77, 0, 0)}]), /only JPEG and PNG/);
});

test('text pages wrap long lines and start a new page when one is full', async () => {
  const text = `${'word '.repeat(400)}\n` + 'line\n'.repeat(120);
  const sizes = await pages(await textPages(text));
  assert.ok(sizes.length >= 2, `${sizes.length} pages`);
  assert.deepEqual(sizes[0], {width: 612, height: 792});
  const c = await convertToPdf('notes.txt', new TextEncoder().encode('hello'));
  assert.equal(c.kind, 'text');
  assert.equal(await convertToPdf('x.bin', Uint8Array.of(0, 1, 2, 3)), null);
});

test('create.file, create.images, create.multiple: a new PDF comes back as bytes without a host; unreadable files are named', async () => {
  const t = await open();
  const r = await t.exec('create.file', {base64: b64(png()), name: 'scan.png'});
  assert.equal(r.result.kind, 'png');
  assert.equal(r.result.name, 'scan.pdf');
  assert.equal(r.result.created, false, 'no host: nothing is created, the bytes come back');
  assert.equal((await pages(Buffer.from(r.result.base64, 'base64'))).length, 1);
  await assert.rejects(t.exec('create.file', {base64: b64(Uint8Array.of(1, 2, 3, 4)), name: 'x.bin'}), /not a PDF/);
  const im = await t.exec('create.images', {files: [{base64: b64(png()), name: 'a.png'}, {base64: b64(png()), name: 'b.png'}], mode: 'custom', dpi: 72});
  assert.equal(im.result.pages, 2);
  const pdf = await textPdf({pages: 2});
  const multi = await t.exec('create.multiple', {files: [{base64: b64(pdf), name: 'two.pdf'}, {base64: b64(png()), name: 'pic.png'}, {base64: b64(Uint8Array.of(9, 9, 9)), name: 'junk.dat'}]});
  assert.equal(multi.result.pages, 3, 'two PDF pages and one picture');
  assert.deepEqual(multi.result.left, ['junk.dat']);
  const doc = await PDFDocument.load(Buffer.from(multi.result.base64, 'base64'));
  assert.ok(doc.catalog.get(PDFName.of('Outlines')), 'one bookmark per file');
  const blank = await t.exec('create.blank', {pages: 2});
  assert.equal(blank.result.pages, 2);
});

test('separate PDFs: a PDF source is left out, names are plain, nothing is written without a folder', async () => {
  const t = await open();
  const r = await t.exec('create.multiple_separate', {files: [{base64: b64(png()), name: '../..\evil:name?.png'}, {base64: b64(await blankPdf()), name: 'already.pdf'}, {base64: b64(new TextEncoder().encode('hi')), name: 'notes.txt'}]});
  assert.equal(r.result.created, 2);
  assert.deepEqual(r.result.left, ['already.pdf (already a PDF)']);
  for (const n of r.result.names) assert.ok(!/[\/:*?"<>|]/.test(n) && !n.startsWith('.'), n);
  assert.equal(plainName('..'), 'file');
  assert.equal(plainName(`a/b${String.fromCharCode(92)}c.pdf`), 'a_b_c.pdf');
  assert.equal(plainName('...hidden. '), 'hidden');
});
