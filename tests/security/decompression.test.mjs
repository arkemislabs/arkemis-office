// Security audit H3: decompression bombs. Every reader caps what comes out of an inflate, whatever the
// file's headers declare.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import {ZipBudget, inflateCapped, verifyZipBytes, ZipLimitError} from '../../core/common/lib/zip-guard.mjs';
import {Package as DocxPackage} from '../../core/quill/formats/docx-read.mjs';
import {internals as pptx} from '../../core/prism/formats/pptx-read.mjs';
import {read as readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {decodePng} from '../../core/prism/lib/raster.mjs';
import {decodePngJs} from '../../core/quill/lib/picture-host.mjs';
import {PDFDocument} from 'pdf-lib';
import '../../core/common/lib/pdf-guard.mjs';

const MB = 1024 * 1024;
/** A zip whose one part inflates to `size` zero bytes but whose headers claim it is 100 bytes. */
async function bomb(name, size, {declared = 100, extra = []} = {}) {
  const z = new JSZip();
  z.file(name, Buffer.alloc(size), {compression: 'DEFLATE'});
  for (const [n, data] of extra) z.file(n, data);
  const bytes = await z.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 30 < bytes.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50 && new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + name.length)) === name) view.setUint32(i + 22, declared, true);
    if (sig === 0x02014b50 && new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + name.length)) === name) view.setUint32(i + 24, declared, true);
  }
  return bytes;
}

test('inflateCapped stops at the cap even when the header declares a tiny size', async () => {
  const zip = await JSZip.loadAsync(await bomb('big.bin', 16 * MB));
  const entry = zip.file('big.bin');
  assert.equal(entry._data.uncompressedSize, 100, 'the header lies');
  const t = Date.now();
  await assert.rejects(inflateCapped(entry, 1 * MB), ZipLimitError);
  assert.ok(Date.now() - t < 3000);
  const honest = await JSZip.loadAsync(await (async () => { const z = new JSZip(); z.file('a.bin', Buffer.alloc(3 * MB)); return z.generateAsync({type: 'uint8array', compression: 'DEFLATE'}); })());
  assert.equal((await inflateCapped(honest.file('a.bin'), 4 * MB)).length, 3 * MB);
});

test('a package total past the budget is refused although every part is under its cap', async () => {
  const z = new JSZip();
  for (let i = 0; i < 6; i++) z.file(`p${i}.bin`, Buffer.alloc(2 * MB), {compression: 'DEFLATE'});
  const packed = await z.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  const zip = await JSZip.loadAsync(packed);
  const budget = new ZipBudget({total: 8 * MB, part: 4 * MB});
  await assert.rejects(async () => { for (let i = 0; i < 6; i++) await budget.bytes(zip.file(`p${i}.bin`)); }, ZipLimitError);
  await assert.rejects(verifyZipBytes(JSZip, packed, {budget: new ZipBudget({total: 8 * MB})}), ZipLimitError);
});

test('docx, pptx, xlsx readers refuse a part that inflates past the cap', async () => {
  const docx = await bomb('word/document.xml', 12 * MB);
  await assert.rejects(DocxPackage.open(docx, {maxPart: 1 * MB, maxTotal: 4 * MB}), e => e.name === 'DocxError' && /size limit|declares/.test(e.message));
  const pptxBytes = await bomb('ppt/presentation.xml', 12 * MB);
  const p = await pptx.Package.open(pptxBytes, {maxPart: 1 * MB, maxTotal: 4 * MB, maxWork: 8 * MB});
  assert.equal(p.get('ppt/presentation.xml'), null, 'the bomb part is skipped, not inflated');
  const xlsx = await bomb('xl/workbook.xml', 66 * MB);
  await assert.rejects(readXlsx(xlsx), /too large to open/);
});

function png(width, height, color, idatPayload) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0); out.write(type, 4, 'latin1'); body.copy(out, 8); // CRC is not checked by the decoders
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = color;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idatPayload), chunk('IEND', Buffer.alloc(0))]));
}

test('PNG IDAT that inflates past width x height x channels is refused', async () => {
  const honest = png(8, 8, 6, zlib.deflateSync(Buffer.alloc(8 * (8 * 4 + 1), 7)));
  assert.equal((await decodePng(honest)).width, 8);
  assert.equal((await decodePngJs(honest)).width, 8);
  const bombed = png(8, 8, 6, zlib.deflateSync(Buffer.alloc(48 * MB)));
  assert.ok(bombed.length < 200_000);
  const t = Date.now();
  assert.equal(await decodePng(bombed), null);
  await assert.rejects(decodePngJs(bombed), e => e.message.includes('too large'));
  assert.ok(Date.now() - t < 3000);
});

const NL = String.fromCharCode(10);
function pdfWithObjStms(inflated, count) {
  const body = zlib.deflateSync(Buffer.alloc(inflated));
  const head = ['%PDF-1.5', '1 0 obj', '<</Type/Catalog/Pages 2 0 R>>', 'endobj', '2 0 obj', '<</Type/Pages/Kids[]/Count 0>>', 'endobj', ''].join(NL);
  const parts = [Buffer.from(head, 'latin1')];
  for (let i = 0; i < count; i++) {
    const open = [`${3 + i} 0 obj`, `<</Type/ObjStm/N 1/First 4/Length ${body.length}/Filter/FlateDecode>>`, 'stream', ''].join(NL);
    parts.push(Buffer.from(open, 'latin1'), body, Buffer.from(['', 'endstream', 'endobj', ''].join(NL), 'latin1'));
  }
  parts.push(Buffer.from(['trailer', `<</Root 1 0 R/Size ${3 + count}>>`, '%%EOF', ''].join(NL), 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

test('PDFDocument.load bounds object-stream inflation, in total and per stream, and refuses an oversized file', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const t = Date.now();
    // One bomb is cut off at the per-stream cap (pdf-lib skips what it cannot decode); it does not hang or fill memory.
    await PDFDocument.load(pdfWithObjStms(130 * MB, 1)).catch(() => {});
    // Several together pass the load's total: the load is refused.
    await assert.rejects(PDFDocument.load(pdfWithObjStms(130 * MB, 4)), /size limit/);
    assert.ok(Date.now() - t < 60_000);
  } finally { console.warn = warn; }
  await assert.rejects(PDFDocument.load(new Uint8Array(33 * MB)), /too large/);
  const ok = await PDFDocument.create(); ok.addPage();
  assert.equal((await PDFDocument.load(await ok.save())).getPageCount(), 1);
});
