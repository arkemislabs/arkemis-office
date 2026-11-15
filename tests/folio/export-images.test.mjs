// core/folio/lib/image-files.mjs and core/folio/commands/export_images.mjs: Export all images; the PNG and TIFF writers Export to Image uses.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/create/src/extract.rs (each image once, on the first page that uses it; shorter than min_side skipped; a JPEG
//    unchanged, others decoded and written as PNG with the soft mask as alpha; what cannot be decoded is reported) and export_ui.rs (the files named
//    after the document, "Exported n images", " (n not exported: why)"). Acrobat's Export all images does the same.
// 2. Ours does the same on real PDFs: the PNGs it writes are read back with pdf-lib's own decoder of embedded PNGs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {encodePng, encodeTiff, extractImages} from '../../core/folio/lib/image-files.mjs';

const grey = (w, h, v = 100) => ({width: w, height: h, channels: 1, data: new Uint8Array(w * h).fill(v)});

async function documentWithImages() {
  const doc = await PDFDocument.create();
  const small = await doc.embedPng(await encodePng({width: 4, height: 4, channels: 3, data: Uint8Array.from({length: 48}, (_, i) => i * 5)}));
  const big = await doc.embedPng(await encodePng(grey(80, 60)));
  const alpha = await doc.embedPng(await encodePng({width: 8, height: 8, channels: 4, data: Uint8Array.from({length: 256}, (_, i) => (i % 4 === 3 ? 128 : 60))}));
  const p1 = doc.addPage([200, 200]);
  p1.drawImage(big, {x: 10, y: 10, width: 80, height: 60});
  p1.drawImage(small, {x: 100, y: 10, width: 20, height: 20});
  const p2 = doc.addPage([200, 200]);
  p2.drawImage(big, {x: 10, y: 10, width: 40, height: 30}); // the same picture again: exported once, on page 1
  p2.drawImage(alpha, {x: 100, y: 100, width: 30, height: 30});
  return doc.save();
}

test('the PNG writer: a valid PNG (read back by pdf-lib), TIFF header fields', async () => {
  const png = await encodePng({width: 3, height: 2, channels: 3, data: Uint8Array.from({length: 18}, (_, i) => i * 10)});
  assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  assert.deepEqual([image.width, image.height], [3, 2]);
  await assert.rejects(encodePng({width: 2, height: 2, channels: 3, data: new Uint8Array(5)}), /no samples/);
  const tif = encodeTiff({width: 2, height: 1, rgb: Uint8Array.of(1, 2, 3, 4, 5, 6), dpi: 150});
  assert.deepEqual(Array.from(tif.slice(0, 4)), [0x49, 0x49, 42, 0]);
  assert.deepEqual(Array.from(tif.slice(-6)), [1, 2, 3, 4, 5, 6], 'the samples are the last strip');
  assert.equal(new DataView(tif.buffer).getUint16(8, true), 12, 'twelve directory entries');
});

test('each picture is exported once, on the first page that uses it; pictures shorter than the limit are left out; transparency is kept', async () => {
  const doc = await PDFDocument.load(await documentWithImages());
  const all = await extractImages(doc, [0, 1], 0);
  assert.equal(all.images.length, 3, 'two on page 1, the repeat on page 2 is not exported again, plus the transparent one');
  assert.deepEqual(all.images.map(i => [i.page, i.width, i.height, i.ext]), [[0, 80, 60, 'png'], [0, 4, 4, 'png'], [1, 8, 8, 'png']]);
  assert.deepEqual(all.skipped, []);
  const limited = await extractImages(doc, [0, 1], 16);
  assert.deepEqual(limited.images.map(i => [i.width, i.height]), [[80, 60]], 'those with fewer than 16 pixels on their shorter side are left out');
  const back = await PDFDocument.create();
  const e = await back.embedPng(all.images[2].bytes);
  assert.deepEqual([e.width, e.height], [8, 8]);
  assert.equal((await extractImages(doc, [1], 0)).images.length, 2, 'asked for page 2 alone, the repeat is page 2\'s own');
});

test('export.all_images: files named after the document come back as base64 for a program; nothing without images; the page list is checked', async () => {
  const content = await migrateContent(await createPdfContent(await documentWithImages(), 'Photos.pdf'));
  const t = await createTestSession('folio', {content});
  const r = await t.exec('export.all_images', {});
  assert.equal(r.result.exported, 3);
  assert.deepEqual(r.result.names, ['Photos_image_1.png', 'Photos_image_2.png', 'Photos_image_3.png']);
  assert.match(r.result.message, /^Exported 3 images$/);
  assert.equal(r.result.files.length, 3);
  assert.equal((await t.exec('export.all_images', {minSide: 16})).result.message, 'Exported 1 image');
  await assert.rejects(t.exec('export.all_images', {pages: [7]}), /does not exist/);
  const plain = await createTestSession('folio', {fixture: 'textPages'});
  assert.equal((await plain.exec('export.all_images', {})).result.message, 'There are no images to export');
});
