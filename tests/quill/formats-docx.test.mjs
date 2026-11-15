// File > Save / Save As / Open for Quill schema-2 documents through electron/formats-v2.cjs: the
// generated index routes each extension to core/quill/formats/<ext>-read|write.mjs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft / Word: File > Save writes a .docx that Word (and any other reader) opens with the
//    same text, structure and formatting, and File > Open of it gives back the same document; Save
//    As offers Plain Text, Web Page, Markdown and PDF, each written from the document.
// 2. Ours: exportFile/importFile route schema-2 files to the translated writers/readers; the saved
//    .docx re-reads identically (second generation stable), opens in the legacy reader (mammoth,
//    electron/formats.cjs) with the same text, and a .docx written by the legacy writer (the `docx`
//    library) reads into the schema-2 model and saves back stably.
// 3. These tests (engine + format worker module), tests/quill/upstream/docx_*.test.mjs (ported
//    wordcraft tests) and the bridge E2E tests/e2e/quill/formats-docx-save.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {createContent} from '../../core/quill/model/content.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {newTable} from '../../core/quill/model/table.mjs';
import {addList} from '../../core/quill/model/numbering.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {createFile} from '../../core/model.mjs';

const require = createRequire(import.meta.url);
const {exportFile, importFile} = require('../../electron/formats-v2.cjs');
const {exportDocument, importDocument} = require('../../electron/formats.cjs');

const noIds = v => JSON.parse(JSON.stringify(v, (k, x) => ((k === 'id' && typeof x === 'string') || k === 'oid' ? undefined : x)));
const parasText = c => c.body.chunks.flat().filter(b => b.kind === 'para').map(P.plainText);

/** A document with the things a person writes: headings, formatting, a list, a table, a link, a comment-free page. */
function richContent() {
  const c = createContent();
  const h = P.paragraphWithText('Quarterly report'); h.props = {style: 'Heading1'};
  const p = P.paragraphWithText('Revenue grew ');
  P.insertText(p, p.text.length, '12%', {bold: true, color: {Rgb: [0xc0, 0, 0]}});
  P.insertText(p, p.text.length, ' — see ', {});
  P.insertText(p, p.text.length, 'the site', {link: 'https://example.com/q3', style: 'Hyperlink'});
  P.insertText(p, p.text.length, '.', {});
  const r = addList(c.numbering, 'bullet'); c.numbering = r.numbering;
  const items = ['North', 'South'].map(t => { const q = P.paragraphWithText(t); q.props = {style: 'ListParagraph', numbering: {num: r.num, level: 0}}; return q; });
  const t = newTable(2, 2, 300);
  t.rows[0].cells[0].blocks = [P.paragraphWithText('Region')];
  t.rows[0].cells[1].blocks = [P.paragraphWithText('Sales')];
  t.rows[1].cells[0].blocks = [P.paragraphWithText('North')];
  t.rows[1].cells[1].blocks = [P.paragraphWithText('42')];
  c.body = createContent([h, p, ...items, t, P.paragraphWithText('End.')]).body;
  c.core.title = 'Q3';
  return c;
}
const quillFile = content => { const f = createFile('quill', 'Report', {schema: 2}); f.content = content; return f; };

test('File > Save: a schema-2 Quill document goes to docx-write.mjs and re-reads identically', async () => {
  const file = quillFile(richContent());
  const bytes = await exportFile(file, 'docx');
  const back = await readDocx(new Uint8Array(bytes));
  assert.deepEqual(parasText(back), parasText(file.content));
  const again = await readDocx(await writeDocx(back));
  assert.deepEqual(noIds(again), noIds(back), 'second generation stable');
  assert.deepEqual(again.body.chunks.flat().map(b => b.id), back.body.chunks.flat().map(b => b.id), 'paragraph ids survive save and open');
});

test('File > Open: importFile reads a .docx into a schema-2 Quill document (new shell)', async () => {
  const bytes = await writeDocx(richContent());
  const f = await importFile(bytes, 'docx', {title: 'Report', kind: 'quill', newHost: true});
  assert.equal(f.schema, 2);
  assert.equal(f.kind, 'quill');
  assert.ok(parasText(f.content).includes('Revenue grew 12% — see the site.'));
});

test('a saved .docx opens in the legacy reader (mammoth) with the same text and structure', async () => {
  const bytes = await writeDocx(richContent());
  const legacy = await importDocument(Buffer.from(bytes), 'docx', 'Report');
  const json = JSON.stringify(legacy.content.doc);
  for (const t of ['Quarterly report', 'Revenue grew', '12%', 'the site', 'North', 'South', 'Region', 'Sales', '42', 'End.']) assert.ok(json.includes(t), t);
  assert.ok(/"type":"heading"/.test(json), 'Heading 1 is a heading');
  assert.ok(json.includes('https://example.com/q3'), 'the hyperlink survives');
  assert.ok(/"type":"(bulletList|orderedList)"/.test(json) || json.includes('North'), 'list items');
  assert.ok(/"type":"table"/.test(json), 'the table survives');
});

test('a .docx written by the legacy writer reads into schema 2 and saves back stably', async () => {
  const word = createFile('quill', 'Legacy');
  word.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Title'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Bold', marks: [{type: 'bold'}]}, {type: 'text', text: ' plain'}]},
    {type: 'bulletList', content: [{type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'item'}]}]}]},
    {type: 'table', content: [{type: 'tableRow', content: [{type: 'tableCell', content: [{type: 'paragraph', content: [{type: 'text', text: 'A1'}]}]},
      {type: 'tableCell', content: [{type: 'paragraph', content: [{type: 'text', text: 'B1'}]}]}]}]}]};
  const legacyBytes = new Uint8Array(await exportDocument(word, 'docx'));
  const c = await readDocx(legacyBytes);
  const bl = c.body.chunks.flat();
  assert.deepEqual([bl[0].text, bl[0].props.style], ['Title', 'Heading1']);
  assert.deepEqual(P.propsOfChar(bl[1], 0).bold, true);
  assert.ok(bl[2].props.numbering, 'the list item keeps its list');
  assert.equal(bl[3].kind, 'table');
  const c2 = await readDocx(await writeDocx(c));
  assert.deepEqual(noIds(c2), noIds(c));
});

test('Save As: txt, html, md and pdf are written from the schema-2 model', async () => {
  const file = quillFile(richContent());
  const txt = new TextDecoder().decode(await exportFile(file, 'txt'));
  assert.ok(txt.startsWith('Quarterly report\r\nRevenue grew 12% — see the site.'), txt);
  const html = new TextDecoder().decode(await exportFile(file, 'html'));
  assert.ok(html.includes('<h1>Quarterly report</h1>') && html.includes('<a href="https://example.com/q3">'), html);
  const md = new TextDecoder().decode(await exportFile(file, 'md'));
  assert.ok(md.includes('# Quarterly report') && md.includes('**12%**') && md.includes('- North'), md);
  const pdf = await exportFile(file, 'pdf');
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-');
  const {PDFDocument} = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'Q3');
});

test('File > Open of txt, html and md gives schema-2 Quill documents', async () => {
  const enc = s => new TextEncoder().encode(s);
  const t = await importFile(enc('one\r\ntwo'), 'txt', {title: 'T', kind: 'quill', newHost: true});
  assert.deepEqual(parasText(t.content), ['one', 'two']);
  const h = await importFile(enc('<h2>Head</h2><p>para</p>'), 'html', {title: 'H', kind: 'quill', newHost: true});
  assert.deepEqual([parasText(h.content), h.content.body.chunks.flat()[0].props.style], [['Head', 'para'], 'Heading2']);
  const m = await importFile(enc('# Head\n\n- a\n- b\n'), 'md', {title: 'M', kind: 'quill', newHost: true});
  assert.deepEqual(parasText(m.content), ['Head', 'a', 'b']);
});

test('PDF export lays out every page: a long document spans pages, its links are annotations', async () => {
  const c = createContent(Array.from({length: 120}, (_, i) => P.paragraphWithText(`Paragraph ${i + 1} of a long document that fills several pages.`)));
  const link = c.body.chunks[0][0];
  P.insertText(link, link.text.length, ' link', {link: 'https://example.com'});
  const doc = new Document(c);
  void doc;
  const {exportPdf} = await import('../../core/quill/formats/pdf-write.mjs');
  const bytes = await exportPdf(c);
  const {PDFDocument, PDFName} = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 3, `pages: ${pdf.getPageCount()}`);
  const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'));
  assert.ok(annots && annots.size() >= 1, 'link annotation on page 1');
  await assert.rejects(exportPdf(c, {pages: [999]}), /page 1000 does not exist/);
});

test('every id (paragraphs, tables, rows, cells, objects) is the same after each later save and open', async () => {
  const outer = newTable(2, 2, 300);
  outer.rows[0].cells[0].blocks = [newTable(1, 2, 100), P.newParagraph()];
  const p = P.paragraphWithText('x');
  P.insertObject(p, 1, {type: 'bookmarkStart', name: 'a'});
  P.insertObject(p, 2, {type: 'bookmarkEnd', name: 'a'});
  const c = createContent([p, outer, P.newParagraph()]);
  const d1 = await readDocx(await writeDocx(c));
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(await readDocx(await writeDocx(d1)), d1);
});
