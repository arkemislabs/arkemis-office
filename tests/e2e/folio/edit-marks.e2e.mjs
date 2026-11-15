// An existing PDF on disk edited in the PDF window over the bridge, as a person would through the
// ribbon and the dialogs: Edit ▸ Header & Footer (the dialog filled and submitted), Watermark,
// Background, Bates numbering, Create links from URLs; Organize ▸ Rotate Pages (dialog), Insert pages
// from a file, Number pages; Export ▸ Text. Ctrl+S writes the same file; the file is reopened with
// pdf-lib and in the app and checked. Captures in artifacts/e2e/folio/edit-marks/.
//
// Behaviour fidelity: printcraft ui-egui commands.rs:477-545 / marks_ui.rs / dialogs.rs (Rotate
// Pages, Number pages) and Acrobat's Edit a PDF and Organize Pages tools; see
// tests/folio/edit-marks.test.mjs and tests/folio/page-organize.test.mjs for the engine side.
// No mouse, no keyboard, no screen capture: ui.activate / ui.dialog.* / ui.key / ui.capture only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {devRenderer, launchApp} from '../harness.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument, StandardFonts, PDFName, PDFArray, PDFRef, decodePDFRawStream, PDFRawStream} = require('pdf-lib');

async function report(file) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const p = pdf.addPage([612, 792]);
    p.drawText(`Quarterly report, page ${i}`, {x: 72, y: 700, size: 20, font});
    p.drawText('Figures at https://example.com/reports and more text on this page.', {x: 72, y: 660, size: 11, font});
  }
  await fs.writeFile(file, await pdf.save());
}
/** The decoded content streams of a saved page. */
function streams(doc, i) {
  const c = doc.getPage(i).node.get(PDFName.of('Contents'));
  const t = c instanceof PDFRef ? doc.context.lookup(c) : c;
  const list = t instanceof PDFArray ? t.asArray() : [c];
  return list.map(o => {
    const s = o instanceof PDFRef ? doc.context.lookup(o) : o;
    const bytes = s instanceof PDFRawStream && s.dict.get(PDFName.of('Filter')) ? decodePDFRawStream(s).decode() : s.getContents();
    return Buffer.from(bytes).toString('latin1');
  });
}

test('folio: edit an existing PDF (header & footer, watermark, background, links, organize), save, reopen', {timeout: 300_000}, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'arkemis-folio-edit-'));
  const source = path.join(folder, 'Report.pdf');
  await report(source);
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/edit-marks', renderer, args: [source]});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000});
    const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
    const settle = ms => new Promise(r => setTimeout(r, ms));

    // Edit ▸ Header & Footer: the split button's main part opens the dialog; fill it; OK.
    await app.rpc('ui.tab', {doc, id: 'edit'});
    await settle(2500);
    await app.capture('edit-tab', {doc});
    await assert.rejects(exec('edit.header_footer.update', {text: ['x', '', '', '', '', '']}), e => e.code === 'disabled' && /no header or footer to change/.test(e.message));
    await app.rpc('ui.activate', {doc, control: 'edit.add.header-and-footer'});
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.header-footer');
    assert.equal(dlg.values.size, 8);
    await app.rpc('ui.dialog.set', {doc, values: {'center-header-text': 'ACME Quarterly', 'right-footer-text': 'Page '}});
    await app.rpc('ui.dialog.set', {doc, values: {'page-format': 'Page 1 of n'}});
    await app.rpc('ui.dialog.set', {doc, field: 'insert-page', value: 1});
    assert.equal((await app.rpc('ui.dialog.get', {doc})).values['right-footer-text'], 'Page <<Page 1 of n>>');
    await app.capture('header-footer-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    let text = (await exec('export.text')).text;
    assert.match(text, /ACME Quarterly/);
    assert.match(text, /Page Page 2 of 2/);

    // Watermark through its dialog; Background and Bates numbering through the engine (bridge).
    await app.rpc('ui.activate', {doc, control: 'edit.add.watermark'});
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.watermark');
    await app.rpc('ui.dialog.set', {doc, values: {text: 'CONFIDENTIAL', opacity: 30, location: 'Appear behind page'}});
    await app.capture('watermark-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await exec('edit.background', {color: [1, 1, 0.85], subset: 'odd'});
    await exec('edit.bates', {prefix: 'ACME', start: 100, box: 3});
    const links = await exec('edit.links_from_urls');
    assert.equal(links.created, 2);
    text = (await exec('export.text')).text;
    assert.match(text, /CONFIDENTIAL/);
    assert.match(text, /ACME000101/);
    await settle(2000);
    await app.capture('marked-page', {doc});

    // Organize: Rotate Pages (dialog), insert a page from a file, Number pages (dialog).
    // All tools › Organize pages opens the page grid; its contextual tab shows while the grid is open.
    await app.rpc('ui.activate', {doc, control: 'alltools.organize.page-grid'});
    await app.until(async () => (await app.rpc('ui.inspect', {doc})).tabs?.some(t => (t.id ?? t) === 'organize-pages') || null, {timeout: 10_000});
    await app.rpc('ui.tab', {doc, id: 'organize-pages'});
    await app.capture('organize-grid', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.rotate-pages'});
    await app.rpc('ui.dialog.set', {doc, values: {direction: '180 degrees', pages: 'From', from: 2, to: 2}});
    await app.capture('rotate-pages-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const extra = await PDFDocument.create();
    extra.addPage([612, 792]).drawText('Appendix', {x: 72, y: 700, size: 24, font: await extra.embedFont(StandardFonts.Helvetica)});
    const inserted = await exec('page.insert', {base64: Buffer.from(await extra.save()).toString('base64'), name: 'Appendix.pdf', at: 2});
    assert.equal(inserted.inserted, 1);
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.number-pages'});
    await app.rpc('ui.dialog.set', {doc, values: {from: 3, to: 3, style: 'A, B, C', prefix: 'App-', start: 1}});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(2000);
    await app.capture('organize', {doc});

    // Ctrl+S writes the file in place; read it back.
    const stamp = (await fs.stat(source)).mtimeMs;
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(async () => (await fs.stat(source)).mtimeMs > stamp || null, {timeout: 30_000});
    const saved = await PDFDocument.load(await fs.readFile(source));
    assert.equal(saved.getPageCount(), 3);
    assert.equal(saved.getPage(1).getRotation().angle, 180);
    const s0 = streams(saved, 0).join('\n');
    assert.match(s0, /\/PCMark \/HeaderFooter/);
    assert.match(s0, /\(ACME Quarterly\) Tj/);
    assert.match(s0, /\/PCMark \/Watermark/);
    assert.match(s0, /\/PCMark \/Background/);
    const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'));
    assert.ok(annots && annots.size() >= 1, 'the link annotations are saved');
    assert.ok(saved.catalog.lookup(PDFName.of('PageLabels')), 'page labels are saved');

    // Reopen the saved file in the app: the marks are there to update and remove.
    await app.rpc('documents.close', {doc, save: false}).catch(() => null);
    const reopened = (await app.rpc('documents.open', {path: source, show: true})).doc;
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc: reopened}).catch(() => null); return ui?.doc?.id === reopened && ui.tabs?.length ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc: reopened, id: 'edit'});
    // The saved watermark is found again: Update replaces it, Remove takes it off every page.
    const upd = await app.rpc('engine.execute', {doc: reopened, command: 'edit.watermark.update', params: {text: 'DRAFT', opacity: 0.4}});
    assert.equal(upd.undoLabel, 'Automation: Update watermark');
    await settle(2000);
    await app.capture('reopened-updated', {doc: reopened});
    const r = await app.rpc('engine.execute', {doc: reopened, command: 'edit.watermark.remove', params: {}});
    // Update applied to every page (Acrobat's Page Range default, All pages), the inserted Appendix included.
    assert.equal(r.result.removed, 3);
    const t2 = (await app.rpc('engine.execute', {doc: reopened, command: 'export.text', params: {}})).result.text;
    assert.doesNotMatch(t2, /CONFIDENTIAL|DRAFT/);
    assert.match(t2, /Appendix/);
    await app.capture('reopened', {doc: reopened});
  } catch (e) {
    e.message += log();
    throw e;
  } finally {
    await app.close();
    await fs.rm(folder, {recursive: true, force: true});
  }
});
