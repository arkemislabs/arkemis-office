// The rail's Layers, Attachments and Tags panels, the Combine files grid, Export to image and Export all images, Create a PDF and the Keyboard
// shortcuts and Preferences dialogs, in the window, driven over the bridge.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855): panels/right.rs (the Layers, Attachments rows), tools/tags_ui.rs, combine_ui/view.rs and combine_grid.rs (cards, stacks,
//    expanded pages, the page size), export_ui.rs (one file per page, named after the document; all images), create_ui.rs (a new unsaved PDF in its own
//    window), dialogs.rs (Keyboard shortcuts, Preferences).
// 2. Ours: the window runs the new shell; commands run as engine.execute and ui.activate; what the panels and the grid draw is read from the captures.
//    Programs get exported files as base64; nothing is written to disk. No OS input.
// 3. Evidence: artifacts/e2e/folio/tools-more/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {schema1Content} from '../../../core/folio/fixtures.mjs';
import {textPdf} from '../../../core/folio/fixtures.mjs';
import {encodePng} from '../../../core/folio/lib/image-files.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const N = s => PDFName.of(s);
const b64 = bytes => Buffer.from(bytes).toString('base64');

async function seed() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const ctx = doc.context;
  const picture = await doc.embedPng(await encodePng({width: 120, height: 80, channels: 3, data: Uint8Array.from({length: 120 * 80 * 3}, (_, i) => (i * 7) % 256)}));
  page.drawImage(picture, {x: 20, y: 150, width: 120, height: 80});
  const mk = name => ctx.register(ctx.obj({Type: 'OCG', Name: PDFString.of(name)}));
  const [a, b] = [mk('Background'), mk('Notes')];
  doc.catalog.set(N('OCProperties'), ctx.obj({OCGs: [a, b], D: {BaseState: 'ON', Order: [a, b]}}));
  await doc.attach(new TextEncoder().encode('hello'), 'readme.txt', {mimeType: 'text/plain', description: 'About'});
  const p = ctx.register(ctx.obj({Type: 'StructElem', S: 'P', Pg: page.ref, Alt: PDFString.of('A paragraph')}));
  // A second branch makes the Tags panel's tree a tree: a Document with a heading and a paragraph inside it.
  const elem = (S, alt, K) => ctx.register(ctx.obj({Type: 'StructElem', S, Pg: page.ref, Alt: PDFString.of(alt), ...(K ? {K} : {})}));
  const branch = elem('Document', 'The report', [elem('H1', 'Quarterly report', null), elem('P', 'Revenue grew', null)]);
  doc.catalog.set(N('StructTreeRoot'), ctx.register(ctx.obj({Type: 'StructTreeRoot', K: [p, branch]})));
  const file = createFile('folio', 'Tools more PDF');
  file.id = 'folio-tools-more';
  file.content = await schema1Content(await doc.save(), 'more.pdf');
  return file;
}

test('folio: Layers, Attachments and Tags panels, the Combine grid, exports, Create, Shortcuts and Preferences', {timeout: 900_000}, async () => {
  const file = await seed();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/tools-more', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = (ui, id) => ui.controls.find(c => c.id === id);
  const settle = ms => new Promise(r => setTimeout(r, ms));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const v = await exec('surface.view'); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 90_000}).catch(e => { throw new Error(e.message + log()); });

    // 1. The panels: each rail toggle opens its pane, which lists what the file has.
    for (const [rail, pane, shot] of [['rail.panels.layers', 'layers', 'layers'], ['rail.panels.attachments', 'attachments', 'attachments'], ['rail.panels.tags', 'tags', 'tags']]) {
      await app.rpc('ui.activate', {doc, control: rail});
      await app.until(async () => (await inspect()).panes.some(p => p.id === pane && p.open) || null, {timeout: 30_000}).catch(e => { throw new Error(e.message + log()); });
      await settle(900);
      await app.capture(shot);
    }
    assert.deepEqual((await exec('layers.read')).layers.map(l => [l.name, l.visible]), [['Background', true], ['Notes', true]]);
    await exec('layers.set', {id: (await exec('layers.read')).layers[1].id, visible: false});
    assert.equal((await exec('layers.read')).layers[1].visible, false, 'the layer is hidden in the file');
    assert.equal((await exec('attachments.read')).attachments[0].name, 'readme.txt');
    assert.equal((await exec('tags.read')).tags[0].title, 'A paragraph');
    await app.rpc('ui.activate', {doc, control: 'rail.panels.tags'});

    // 2. The Combine files grid: the file as a card with its thumbnail; a toggle back to the list.
    await exec('page.combine', {});
    await exec('combine.add', {files: [{base64: b64(await textPdf({pages: 3})), name: 'three pages.pdf'}, {base64: b64(await textPdf({pages: 1})), name: 'one page.pdf'}]});
    await app.rpc('ui.activate', {doc, control: 'combine.view.grid-list'});
    await settle(2500);
    await app.capture('combine-grid');
    await app.rpc('ui.activate', {doc, control: 'combine.view.expand-all'});
    await settle(2500);
    await app.capture('combine-expanded');
    await app.rpc('ui.activate', {doc, control: 'combine.view.larger'});
    await settle(800);
    await exec('combine.close');

    // 3. Export all images and Export to image: files come back as base64 for a program.
    const all = await exec('export.all_images');
    assert.equal(all.exported, 1);
    assert.match(all.names[0], /_image_1\.png$/);
    const png = Buffer.from(all.files[0].base64, 'base64');
    assert.deepEqual(Array.from(png.subarray(0, 4)), [137, 80, 78, 71]);
    const img = await exec('export.image', {dpi: 72, format: 'png'});
    assert.equal(img.exported, 1);
    assert.match(img.names[0], /_page_1\.png$/);
    assert.deepEqual(Array.from(Buffer.from(img.files[0].base64, 'base64').subarray(0, 4)), [137, 80, 78, 71]);
    const tif = await exec('export.image', {dpi: 72, format: 'tiff'});
    assert.deepEqual(Array.from(Buffer.from(tif.files[0].base64, 'base64').subarray(0, 4)), [0x49, 0x49, 42, 0]);
    const jpg = await exec('export.image', {dpi: 72, format: 'jpeg', quality: 70});
    assert.deepEqual(Array.from(Buffer.from(jpg.files[0].base64, 'base64').subarray(0, 2)), [0xFF, 0xD8]);

    // 4. Create a PDF: a new document opens in its own window.
    const created = await exec('create.blank', {pages: 2});
    assert.equal(created.pages, 2);
    assert.ok(created.created === true ? created.doc : created.base64, 'a new document, or its bytes without a host');

    // 5. Keyboard shortcuts and Preferences open their dialogs.
    await app.rpc('ui.activate', {doc, control: 'chrome.tabs.shortcuts'});
    await app.until(async () => (await inspect()).dialog || null, {timeout: 20_000}).catch(e => { throw new Error(e.message + log()); });
    await settle(600);
    await app.capture('shortcuts');
    await app.rpc('ui.key', {doc, keys: 'Escape'});
    await app.until(async () => !(await inspect()).dialog || null, {timeout: 20_000});
    await app.rpc('ui.activate', {doc, control: 'chrome.tabs.preferences'});
    await app.until(async () => (await inspect()).dialog || null, {timeout: 20_000}).catch(e => { throw new Error(e.message + log()); });
    await settle(500);
    await app.capture('preferences');
    await app.rpc('ui.key', {doc, keys: 'Escape'});
    assert.ok(control(await inspect(), 'alltools.panel.expand'));
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
