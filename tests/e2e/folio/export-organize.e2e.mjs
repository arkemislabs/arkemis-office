// Export to Word and HTML, and the Organize grid's toolbar, end to end in the window (docs/behaviour-fidelity.md):
//   Convert > Export to Microsoft Word / HTML web page (a real .docx package, an HTML file with the text as headings and paragraphs); the Organize grid's Larger pages, Smaller
//   pages and the percentage change the size of the pages, Move earlier and Move later move the selected page, Page properties sets
//   the tab order from its dialog.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/workflows/files.rs export_office_dialog, canvas/organize.rs organize_toolbar,
//    panels/organize_panel.rs page_props_body. Acrobat's Export a PDF, Organize Pages and Page Properties work the same way.
// 2. Here the window runs the new shell (devRenderer); the controls are activated through the bridge (ui.activate), the system dialogs are
//    answered by the test-mode script (electron/main.cjs), the written files are read back with JSZip and pdf-lib. No OS input.
// 3. Evidence: artifacts/e2e/folio/export-organize/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import JSZip from 'jszip';
import {textPdf} from '../../../core/folio/fixtures.mjs';
import {documentsFolder, run, show, start} from '../common/file-helpers.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument, PDFName} = require('pdf-lib');

test('folio export and organize: Word and HTML files from Convert, the grid toolbar, Page properties', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('folio-export');
  const source = path.join(folder, 'Quarterly.pdf');
  await fs.writeFile(source, await textPdf({pages: 3}));
  const app = await start('folio', 'folio-export-organize', {args: [source]});
  await run(async () => {
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await show(app, doc);
    const settle = ms => new Promise(r => setTimeout(r, ms));
    const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
    const read = async address => (await app.rpc('document.read', {doc, address})).value;
    const inspect = () => app.rpc('ui.inspect', {doc});
    const control = (ui, id) => { const found = []; const walk = n => { for (const k of n ?? []) { if (k.id === id) found.push(k); walk(k.items ?? k.controls); } }; walk(ui.controls); return found[0]; };
    await app.until(async () => (await exec('surface.view')).renders.count > 0 || null, {timeout: 60_000});

    // Convert > Export to Microsoft Word: a real Word package with the page's text. A control activated over the bridge is a program asking, so
    // the file comes back as base64 instead of through the Save dialog (which only a person's own click opens).
    await app.rpc('ui.tab', {doc, id: 'convert'});
    const word = (await app.rpc('ui.activate', {doc, control: 'convert.export.microsoft-word-docx'})).result;
    assert.equal(word.name, 'Quarterly.docx', 'the file is named after the document');
    assert.equal(word.pages, 3);
    const zip = await JSZip.loadAsync(Buffer.from(word.base64, 'base64'));
    assert.ok(zip.file('word/document.xml') && zip.file('word/styles.xml'), 'a Word package');
    const xml = await zip.file('word/document.xml').async('string');
    assert.match(xml, /The quick brown fox jumps over the lazy dog\./);
    assert.equal((xml.match(/<w:sectPr>/g) ?? []).length, 3, 'a section per page');
    await app.capture('01-after-word', {doc});

    // HTML web page.
    const web = (await app.rpc('ui.activate', {doc, control: 'convert.export.html-web-page'})).result;
    assert.equal(web.name, 'Quarterly.html');
    const html = Buffer.from(web.base64, 'base64').toString('utf8');
    assert.match(html, /<title>Quarterly<\/title>/);
    assert.match(html, /The quick brown fox jumps over the lazy dog\./);
    assert.equal(html.split('<hr>').length - 1, 2, 'a rule between pages');

    // The Organize grid: page size in the grid.
    await exec('page.organize', {});
    await app.until(async () => (await inspect()).tab === 'organize-pages' || null, {timeout: 20_000});
    await settle(1200);
    await app.capture('02-grid', {doc});
    await app.rpc('ui.activate', {doc, control: 'organize.grid.larger'});
    await settle(900);
    assert.equal((await exec('organize.zoom', {percent: 125})).zoom, 125);
    await app.rpc('ui.activate', {doc, control: 'organize.grid.larger'});
    await settle(900);
    await app.capture('03-grid-larger', {doc});
    await app.rpc('ui.activate', {doc, control: 'organize.grid.reset-size'});
    await app.rpc('ui.activate', {doc, control: 'organize.grid.smaller'});
    await settle(900);
    await app.capture('04-grid-smaller', {doc});
    await app.rpc('ui.activate', {doc, control: 'organize.grid.reset-size'});

    // Move later and Move earlier act on the selected page.
    const ids = (await read('/pages')).map(p => p.id);
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/pg:${ids[0]}`, focus: `/pg:${ids[0]}`}], primary: 0});
    await app.rpc('ui.activate', {doc, control: 'organize.grid.move-later'});
    await app.until(async () => (await read('/pages')).map(p => p.id)[1] === ids[0] || null, {timeout: 20_000});
    await settle(700);
    await app.capture('05-moved-later', {doc});
    await app.rpc('ui.activate', {doc, control: 'organize.grid.move-earlier'});
    await app.until(async () => (await read('/pages')).map(p => p.id)[0] === ids[0] || null, {timeout: 20_000});

    // Page properties: the tab order from the dialog.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.page-properties'});
    await settle(500);
    await app.capture('06-page-properties', {doc});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.page-properties', field: 'order', value: 'Use Row Order'});
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.page-properties', button: 'ok'});
    const orders = (await exec('page.properties', {})).orders;
    assert.deepEqual(orders, ['row'], 'the current page now has row order');
    await exec('page.organize', {open: false});
    await settle(500);
    const saved = await PDFDocument.load(Buffer.from(await read('/sourceBase64'), 'base64'));
    assert.equal(saved.getPage(0).node.lookup(PDFName.of('Tabs')).decodeText(), 'R');
    void control;
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
