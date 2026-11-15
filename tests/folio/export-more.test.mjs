// Export a PDF > Spreadsheet (.xlsx), XML 1.0 and PostScript / EPS (core/folio/lib/export-more.mjs, commands/export_more.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): not checked against upstream (printcraft at 8f16855 has no engine for these). Acrobat's Export a PDF: a table the page lays out
// becomes a sheet (numbers as numbers, merged cells for spans), the document with no table is its text in one sheet; XML keeps the structure; PostScript is a Level 2 file.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import * as more from '../../core/folio/lib/export-more.mjs';

async function tablePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText('Quarterly results', {x: 50, y: 360, size: 20, font});
  const rows = [['Region', 'Units', 'Revenue'], ['North', '1,200', '34.5'], ['South', '980', '28.25'], ['West', '007', '12']];
  rows.forEach((r, i) => r.forEach((c, k) => page.drawText(c, {x: 50 + k * 110, y: 300 - i * 24, size: 11, font})));
  return doc.save();
}
const session = async bytes => createTestSession('folio', {content: await migrateContent(await createPdfContent(bytes, 'Results.pdf'))});

test('a table the page lays out becomes a sheet, numbers stay numbers and "007" stays text; the title above it spans the columns (merged)', async () => {
  const t = await session(await tablePdf());
  const r = (await t.exec('export.xlsx', {})).result;
  assert.equal(r.name, 'Results.xlsx');
  assert.deepEqual(r.sheets, ['Table 1']);
  const zip = await JSZip.loadAsync(Buffer.from(r.base64, 'base64'));
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<c r="A2"[^>]*t="inlineStr"><is><t[^>]*>Region<\/t>/);
  assert.match(sheet, /<c r="B3"><v>1200<\/v><\/c>/);
  assert.match(sheet, /<c r="C4"><v>28.25<\/v><\/c>/);
  assert.match(sheet, /<c r="B5"[^>]*t="inlineStr"><is><t[^>]*>007<\/t>/);
  const book = await zip.file('xl/workbook.xml').async('string');
  assert.match(book, /<sheet name="Table 1" sheetId="1"/);
  assert.ok(zip.file('xl/styles.xml') && zip.file('[Content_Types].xml'));
});

test('a document with no table puts its paragraphs in one sheet; numbers read plainly; sheet names are legal and unique', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Just a line of text', {x: 30, y: 250, size: 12, font});
  const t = await session(await doc.save());
  const r = (await t.exec('export.xlsx', {})).result;
  assert.deepEqual(r.sheets, ['Text']);
  assert.equal(more.numberOf('1,234.50'), 1234.5);
  assert.equal(more.numberOf('-12'), -12);
  assert.equal(more.numberOf('007'), null);
  assert.equal(more.numberOf('12%'), null);
  assert.equal(more.numberOf('$5'), null);
  assert.equal(more.numberOf('1,23'), null);
});

test('XML 1.0 keeps the page size, the heading, the paragraphs and the table cells, and escapes what must be', async () => {
  const t = await session(await tablePdf());
  const r = (await t.exec('export.xml', {})).result;
  assert.equal(r.name, 'Results.xml');
  const xml = Buffer.from(r.base64, 'base64').toString('utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<document title="Results" pages="1">/);
  assert.match(xml, /<page number="1" width="400" height="400">/);
  assert.match(xml, /<cell colspan="2">Quarterly results<\/cell>/);
  assert.match(xml, /<cell>North<\/cell><cell>1,200<\/cell>/);
  assert.equal(more.xml([{width: 10, height: 10, blocks: [], images: []}], 'a<b&"c'), '<?xml version="1.0" encoding="UTF-8"?>\n<document title="a&lt;b&amp;&quot;c" pages="1">\n <page number="1" width="10" height="10">\n </page>\n</document>\n');
});

test('ASCII85 matches the Adobe encoding and PostScript is a Level 2 file with a page each; EPS has one page and a bounding box', () => {
  assert.equal(more.ascii85(new TextEncoder().encode('Man ')), '9jqo^~>');
  assert.equal(more.ascii85(new Uint8Array([0, 0, 0, 0])), 'z~>');
  assert.equal(more.ascii85(new TextEncoder().encode('Ma')), '9jn~>');
  const page = (w, h) => ({width: w, height: h, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), pixelWidth: 4, pixelHeight: 2});
  const ps = new TextDecoder().decode(more.postscript([page(612, 792), page(300.5, 200)], {title: 'Résumé'}));
  assert.match(ps, /^%!PS-Adobe-3\.0\n/);
  assert.match(ps, /%%Pages: 2/);
  assert.match(ps, /%%BoundingBox: 0 0 612 792/);
  assert.match(ps, /%%Title: R\?sum\?/);
  assert.match(ps, /<< \/PageSize \[612 792\] >> setpagedevice/);
  assert.match(ps, /\/DCTDecode filter >> image/);
  assert.equal((ps.match(/showpage/g) ?? []).length, 2);
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(ps), 'seven-bit text');
  const eps = new TextDecoder().decode(more.postscript([page(612, 792), page(100, 100)], {eps: true}));
  assert.match(eps, /^%!PS-Adobe-3\.0 EPSF-3\.0\n/);
  assert.match(eps, /%%Pages: 1/);
  assert.equal(eps.includes('setpagedevice'), false);
  assert.throws(() => more.postscript([]), /no pages/);
});
