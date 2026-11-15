// Accessibility in the window, end to end (docs/behaviour-fidelity.md): the options dialog, the Accessibility Checker panel, Automatically tag PDF, the Tags panel
// editing, Set Alternate Text, Reading Options, the report.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/workflows/a11y_ui.rs (the dialog, the panel, the report file), tools/tags_ui.rs (the Tags panel), crates/a11y (the rules).
//    Acrobat's Accessibility tool and Check for Accessibility work the same way.
// 2. The window runs the new shell (devRenderer); controls are activated through the bridge (ui.activate), no OS input, captures through capturePage.
// 3. Evidence: artifacts/e2e/folio/rest-a11y/*.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {textPdf} from '../../../core/folio/fixtures.mjs';
import {documentsFolder, run, show, start} from '../common/file-helpers.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument, PDFName} = require('pdf-lib');

async function figurePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const root = ctx.nextRef(), docEl = ctx.nextRef();
  const fig = ctx.register(ctx.obj({Type: 'StructElem', S: 'Figure', P: docEl, Pg: page.ref, K: 0}));
  const h = ctx.register(ctx.obj({Type: 'StructElem', S: 'H3', P: docEl, Pg: page.ref, K: 1}));
  ctx.assign(docEl, ctx.obj({Type: 'StructElem', S: 'Document', P: root, K: [fig, h]}));
  ctx.assign(root, ctx.obj({Type: 'StructTreeRoot', K: docEl}));
  doc.catalog.set(PDFName.of('StructTreeRoot'), root);
  return doc.save({useObjectStreams: false});
}

test('folio accessibility: options dialog, checker panel, tagging, tags editing, alternate text, reading options, report', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('folio-a11y');
  const source = path.join(folder, 'Annual report.pdf');
  const figures = path.join(folder, 'Figures.pdf');
  await fs.writeFile(source, await textPdf({pages: 3}));
  await fs.writeFile(figures, await figurePdf());
  const app = await start('folio', 'folio-rest-a11y', {args: [source, figures]});
  await run(async () => {
    const find = async p => (await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === p) || null, {timeout: 30_000})).id;
    const doc = await find(source);
    await show(app, doc);
    const settle = ms => new Promise(r => setTimeout(r, ms));
    const exec = async (command, params = {}, d = doc) => (await app.rpc('engine.execute', {doc: d, command, params})).result;
    const dialog = (id, d = doc) => app.rpc('ui.dialog.get', {doc: d, id});
    await app.until(async () => (await exec('surface.view')).renders.count > 0 || null, {timeout: 60_000});

    // Check for accessibility: the options dialog first (31 of 32 rules on), a page range, then the panel.
    await app.rpc('ui.tab', {doc, id: 'all-tools'});
    await app.rpc('ui.activate', {doc, control: 'alltools.accessibility.check-for-accessibility'});
    await settle(600);
    const opts = await dialog('dialog.accessibility-options');
    assert.match(String(opts.values.checking), /31 of 32/);
    await app.capture('01-options', {doc});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.accessibility-options', field: 'pages', value: 'Range'});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.accessibility-options', field: 'to', value: 2});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.accessibility-options', field: 'category', value: 'headings'});
    await settle(300);
    await app.capture('02-options-headings', {doc});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.accessibility-options', field: 'category', value: 'document'});
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.accessibility-options', button: 'start-checking'});
    const first = await app.until(async () => { const r = await exec('a11y.read'); return r.checked ? r : null; }, {timeout: 30_000});
    assert.equal(first.rules.find(r => r.rule === 'tagged-pdf').status, 'failed');
    assert.equal(first.rules.find(r => r.rule === 'logical-reading-order').status, 'manual');
    await settle(900);
    await app.capture('03-panel', {doc});

    // Automatically tag PDF: three pages, twelve paragraphs; checking again compares with the last check.
    await app.rpc('ui.activate', {doc, control: 'alltools.accessibility.automatically-tag-pdf'});
    const tagged = await app.until(async () => { const t = (await exec('tags.list')).tags; return t.length ? t : null; }, {timeout: 30_000});
    assert.equal(tagged.filter(t => t.kind === 'P').length, 12, 'four lines of text on each of three pages');
    await settle(900);
    await app.capture('04-tags-panel', {doc});
    await exec('a11y.check', {rules: first.rules.filter(r => r.status !== 'skipped').map(r => r.rule), pages: [0, 1]});
    await exec('a11y.panel', {open: true});
    await settle(900);
    await app.capture('05-panel-compare', {doc});

    // The Tags panel: edit a title, move a tag.
    const p = tagged.filter(t => t.kind === 'P');
    await exec('tags.set', {object: p[0].object, property: 'title', value: 'First line'});
    await exec('tags.move', {object: p[1].object, anchor: p[0].object, placement: 'before'});
    await exec('a11y.tags', {open: true});
    await settle(900);
    await app.rpc('ui.activate', {doc, control: 'rail.panels.tags'}).catch(() => {});
    await app.capture('06-tags-edited', {doc});

    // Reading options through the dialog; the report.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.reading-options'});
    await settle(400);
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.reading-options', field: 'language', value: 'en-US'});
    await app.capture('07-reading-options', {doc});
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.reading-options', button: 'ok'});
    await settle(500);
    const saved = await PDFDocument.load(Buffer.from((await app.rpc('document.read', {doc, address: '/sourceBase64'})).value, 'base64'));
    assert.equal(saved.catalog.lookup(PDFName.of('Lang')).decodeText(), 'en-US');
    const report = await app.rpc('ui.activate', {doc, control: 'alltools.accessibility.open-accessibility-report'});
    assert.match(Buffer.from(report.result.base64, 'base64').toString('utf8'), /Accessibility Report/);

    // Set Alternate Text on a document with a figure: the dialog, then the Figures rule passes.
    const fdoc = await find(figures);
    await show(app, fdoc);
    await app.until(async () => (await exec('surface.view', {}, fdoc)).renders.count > 0 || null, {timeout: 60_000});
    const list = (await exec('a11y.alt_text', {}, fdoc)).figures;
    assert.equal(list.length, 1);
    await app.rpc('ui.dialog.open', {doc: fdoc, id: 'dialog.alt-text', args: {figures: list}});
    await settle(500);
    await app.capture('08-alt-text-empty', {doc: fdoc});
    await app.rpc('ui.dialog.cancel', {doc: fdoc, id: 'dialog.alt-text'});
    const done = await exec('a11y.alt_text', {items: [{object: list[0].object, alt: 'A bar chart of sales by quarter'}]}, fdoc);
    assert.equal(done.alts, 1);
    const checked = await exec('a11y.check', {}, fdoc);
    assert.equal(checked.rules.find(r => r.rule === 'figures-alt-text').status, 'passed');
    assert.equal(checked.rules.find(r => r.rule === 'heading-nesting').status, 'failed', 'the lone H3 skips H1 and H2');
    await settle(900);
    await app.capture('09-figures-panel', {doc: fdoc});
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
