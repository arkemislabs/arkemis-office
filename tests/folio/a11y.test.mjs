// The Accessibility Checker, report, alternate text, tag editing, Automatically tag PDF and Tag form fields (core/folio/lib/a11y.mjs).
// Translated from printcraft crates/a11y at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, PDFName, PDFString, rgb} from 'pdf-lib';
import * as A from '../../core/folio/lib/a11y.mjs';

const N = s => PDFName.of(s);
async function textDoc(pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([300, 300]);
    p.drawText(`Page ${i + 1} first paragraph`, {x: 20, y: 250, size: 12, font});
    p.drawText('Second paragraph', {x: 20, y: 200, size: 12, font});
  }
  return PDFDocument.load(await doc.save({useObjectStreams: false}));
}
const find = (report, id) => report.results.find(r => r.rule === id);

test('an untagged document fails Tagged PDF, Title, Language and Tagged content, and the manual rules stay manual', async () => {
  const doc = await textDoc();
  const report = A.check(doc);
  assert.equal(report.results.length, 32);
  assert.equal(find(report, 'tagged-pdf').status, 'failed');
  assert.equal(find(report, 'primary-language').status, 'failed');
  assert.equal(find(report, 'title').status, 'failed');
  assert.equal(find(report, 'tagged-content').status, 'failed');
  assert.equal(find(report, 'logical-reading-order').status, 'manual');
  assert.equal(find(report, 'color-contrast').status, 'skipped', 'colour contrast is off by default');
  assert.equal(find(report, 'image-only').status, 'passed');
  assert.equal(find(report, 'table-summary').status, 'passed', 'no tables, nothing to fail');
});

test('Automatically tag PDF tags each text object; the checker then finds the content tagged', async () => {
  const doc = await textDoc(2);
  const r = A.autotagText(doc);
  assert.deepEqual(r, {pages: 2, paragraphs: 4});
  const again = await PDFDocument.load(await doc.save({useObjectStreams: false}));
  const report = A.check(again);
  assert.equal(find(report, 'tagged-pdf').status, 'passed');
  assert.equal(find(report, 'tagged-content').status, 'passed');
  assert.equal(A.tags(again).filter(t => t.kind === 'P').length, 4);
  assert.throws(() => A.autotagText(again), /already has a structure tree/);
});

test('Automatically tag PDF refuses what it cannot tag and says why', async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([200, 200]);
  p.drawRectangle({x: 10, y: 10, width: 50, height: 50, color: rgb(1, 0, 0)});
  const loaded = await PDFDocument.load(await doc.save());
  assert.throws(() => A.autotagText(loaded), /page 1: unsupported or painted operator|no text objects/);
});

test('reading options set the language, the title and the title bar, and the fix for tab order marks pages with annotations', async () => {
  const doc = await textDoc();
  A.setReadingOptions(doc, {language: 'en-US', title: 'Annual report', displayTitle: true});
  const report = A.check(doc);
  assert.equal(find(report, 'primary-language').status, 'passed');
  assert.equal(find(report, 'title').status, 'passed');
  assert.throws(() => A.setReadingOptions(doc, {language: 'not a language'}), /language/);
});

async function structured() {
  const doc = await textDoc();
  const ctx = doc.context;
  const page = doc.getPage(0);
  const root = ctx.nextRef(), docEl = ctx.nextRef();
  const fig = ctx.register(ctx.obj({Type: 'StructElem', S: 'Figure', P: docEl, Pg: page.ref, K: 0}));
  const h1 = ctx.register(ctx.obj({Type: 'StructElem', S: 'H1', P: docEl, Pg: page.ref, K: 1}));
  const h3 = ctx.register(ctx.obj({Type: 'StructElem', S: 'H3', P: docEl, Pg: page.ref, K: 2}));
  const li = ctx.register(ctx.obj({Type: 'StructElem', S: 'LI', P: docEl, Pg: page.ref, K: 3}));
  const cell = (n, s = 'TD') => ctx.register(ctx.obj({Type: 'StructElem', S: s, Pg: page.ref, K: n}));
  const tr1 = ctx.register(ctx.obj({Type: 'StructElem', S: 'TR', K: [cell(4), cell(5)]}));
  const tr2 = ctx.register(ctx.obj({Type: 'StructElem', S: 'TR', K: [cell(6)]}));
  const table = ctx.register(ctx.obj({Type: 'StructElem', S: 'Table', P: docEl, K: [tr1, tr2]}));
  ctx.assign(docEl, ctx.obj({Type: 'StructElem', S: 'Document', P: root, K: [fig, h1, h3, li, table]}));
  ctx.assign(root, ctx.obj({Type: 'StructTreeRoot', K: docEl}));
  doc.catalog.set(N('StructTreeRoot'), root);
  return {doc, fig, table, h3};
}

test('the structure rules: figures without alternate text, heading levels, lists, tables (headers, summary, regularity)', async () => {
  const {doc} = await structured();
  const report = A.check(doc, {rules: A.RULES.map(r => r.id)});
  assert.equal(find(report, 'figures-alt-text').status, 'failed');
  assert.match(find(report, 'figures-alt-text').findings[0].message, /Figure element on page 1: no alternate text/);
  assert.equal(find(report, 'heading-nesting').status, 'failed');
  assert.match(find(report, 'heading-nesting').findings[0].message, /H3 follows an H1/);
  assert.equal(find(report, 'list-items').status, 'failed');
  assert.equal(find(report, 'table-headers').status, 'failed');
  assert.equal(find(report, 'table-summary').status, 'failed');
  assert.equal(find(report, 'table-regularity').status, 'failed');
  assert.match(find(report, 'table-regularity').findings[0].message, /rows have between 1 and 2 columns/);
});

test('alternate text: set_alt clears the Figures rule, a blank text removes it, and the figure list says what each has', async () => {
  const {doc, fig} = await structured();
  const key = `${fig.objectNumber} ${fig.generationNumber}`;
  assert.deepEqual(A.figures(doc).map(f => [f.object, f.page, f.alt]), [[key, 0, null]]);
  A.setAlt(doc, key, 'A bar chart of sales');
  assert.equal(A.figures(doc)[0].alt, 'A bar chart of sales');
  assert.equal(find(A.check(doc), 'figures-alt-text').status, 'passed');
  A.setAlt(doc, key, '   ');
  assert.equal(A.figures(doc)[0].alt, null);
  assert.throws(() => A.setAlt(doc, '999 0', 'x'), /not a figure/);
});

test('tag editing: type, title, table summary and move; invalid values are refused', async () => {
  const {doc, table, h3} = await structured();
  const tk = `${table.objectNumber} ${table.generationNumber}`, hk = `${h3.objectNumber} ${h3.generationNumber}`;
  A.setTagProperty(doc, hk, 'type', 'H2');
  assert.equal(A.tags(doc).find(t => t.object === hk).kind, 'H2');
  assert.equal(find(A.check(doc), 'heading-nesting').status, 'passed');
  assert.throws(() => A.setTagProperty(doc, hk, 'type', 'bad name'), /nonempty PDF name/);
  A.setTagProperty(doc, tk, 'summary', 'Sales by region');
  assert.equal(A.tags(doc).find(t => t.object === tk).summary, 'Sales by region');
  assert.equal(find(A.check(doc), 'table-summary').status, 'passed');
  A.setTagProperty(doc, tk, 'summary', '');
  assert.equal(A.tags(doc).find(t => t.object === tk).summary, null);
  assert.throws(() => A.setTagProperty(doc, hk, 'summary', 'x'), /applies only to Table tags/);
  const kids = A.tags(doc).filter(t => t.depth === 1).map(t => t.object);
  A.moveTag(doc, kids[3], kids[0], 'before');
  assert.equal(A.tags(doc).filter(t => t.depth === 1)[0].object, kids[3]);
  assert.throws(() => A.moveTag(doc, kids[3], kids[3]), /distinct/);
});

test('Tag form fields makes a Form element for each untagged widget', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const form = doc.getForm();
  form.createTextField('a').addToPage(page, {x: 10, y: 100, width: 100, height: 20});
  form.createTextField('b').addToPage(page, {x: 10, y: 50, width: 100, height: 20});
  const loaded = await PDFDocument.load(await doc.save({useObjectStreams: false}));
  assert.equal(find(A.check(loaded), 'tagged-form-fields').status, 'failed');
  assert.equal(A.tagFormFields(loaded), 2);
  const again = await PDFDocument.load(await loaded.save({useObjectStreams: false}));
  assert.equal(find(A.check(again), 'tagged-form-fields').status, 'passed');
  assert.equal(A.tags(again).filter(t => t.kind === 'Form').length, 2);
  assert.throws(() => A.tagFormFields(again), /no untagged page widgets/);
});

test('the report names every rule, its status and its problems, and escapes the file name', async () => {
  const doc = await textDoc();
  const report = A.check(doc);
  const html = A.reportHtml(report, 'a<b>.pdf', '2026-11-01');
  assert.match(html, /<h1>Accessibility Report<\/h1>/);
  assert.match(html, /a&lt;b&gt;\.pdf/);
  for (const r of A.RULES) assert.ok(html.includes(r.name.replace(/&/g, '&amp;')), r.id);
  assert.match(html, /The checker found problems which may prevent/);
  const sum = A.summarize(report);
  assert.equal(sum.passed + sum.failed + sum.manual + sum.skipped, 32);
});
