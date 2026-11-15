// PDF's gate (docs/architecture.md 17.5), the flows the other PDF suites don't already cover: a PDF opened from a path as Explorer
// opens it, an edit made through the ribbon and undone and redone with the keyboard shortcuts (the UI edit and the bridge edit are
// one history), the contextual panels (Measure objects, Compare, Organize pages) appearing with their tool and disappearing with
// it, a measurement and a comparison that survive Save As and reopen as real annotations, Save As to a new path (the system Save
// dialog answered by the test-mode script), Export to text, Print through the print path, and every address the document lists
// read back over the bridge. Dialogs: tests/e2e/shell/dialog-sweep.e2e.mjs (SWEEP_APPS=folio); the tools, forms, security,
// redaction, combining, find, view and file lifecycle each have their own suite in this folder and tests/e2e/common/file-pdf.e2e.mjs.
//
// PDF has no formats to import or export besides PDF itself (the text export is its one conversion).
//
//   npm run build && node --test tests/e2e/folio/gate.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {asked, documentsFolder, exists, run, script, show, start} from '../common/file-helpers.mjs';
import {textPdf, LINES} from '../../../core/folio/fixtures.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument, StandardFonts} = require('pdf-lib');

test('folio gate: open from a path, ribbon edit with undo and redo shortcuts, contextual panels, measure and compare saved as annotations, Save As, Export text, Print, read back every address', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('folio-gate');
  const source = path.join(folder, 'Gate.pdf');
  await fs.writeFile(source, await textPdf({pages: 3}));
  const app = await start('folio', 'folio-gate', {args: [source]});
  await run(async () => {
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await show(app, doc);
    const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
    const read = async address => (await app.rpc('document.read', {doc, address})).value;
    const inspect = () => app.rpc('ui.inspect', {doc});
    const settle = ms => new Promise(r => setTimeout(r, ms));
    await app.until(async () => (await exec('surface.view')).renders.count > 0 || null, {timeout: 60_000});
    assert.equal((await read('/pages')).length, 3, 'the three pages of the file');
    await app.capture('01-opened', {doc});

    // An edit through the ribbon (Edit > Rotate pages), undone and redone with the shortcuts: UI edits and bridge edits are one history.
    await app.rpc('ui.tab', {doc, id: 'edit'});
    await app.rpc('ui.activate', {doc, control: 'edit.modify.page-rotate'});
    await app.until(async () => (await read('/pages/0/rotation')) === 90 || null, {timeout: 15_000});
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'})).command, 'edit.undo');
    await app.until(async () => (await read('/pages/0/rotation')) === 0 || null, {timeout: 15_000});
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+Y'})).command, 'edit.redo');
    await app.until(async () => (await read('/pages/0/rotation')) === 90 || null, {timeout: 15_000});
    await exec('page.rotate_ccw', {pages: [0]});
    assert.equal(await read('/pages/0/rotation'), 0, 'a bridge edit joins the history');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    await app.until(async () => (await read('/pages/0/rotation')) === 90 || null, {timeout: 15_000});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    await app.until(async () => (await read('/pages/0/rotation')) === 0 || null, {timeout: 15_000});

    // Contextual panels come with their tool and go with it.
    await exec('measure.distance');
    await app.until(async () => (await inspect()).tab === 'measure-objects' || null, {timeout: 15_000});
    await app.capture('02-measure-panel', {doc});
    await exec('tool.select');
    await app.until(async () => !(await inspect()).tabs.includes('measure-objects') || null, {timeout: 15_000});
    await exec('page.organize', {});
    await app.until(async () => (await inspect()).tab === 'organize-pages' || null, {timeout: 15_000});
    await exec('page.organize', {open: false});
    await app.until(async () => !(await inspect()).tabs.includes('organize-pages') || null, {timeout: 15_000});

    // A measurement at 1:50 and a comparison, both real annotations after Save As.
    await exec('measure.scale', {ratio: '1:50'});
    const m = await exec('measure.distance', {page: 1, points: [[72, 100], [144, 100]]});
    assert.equal(m.label, '1.27 m');
    const older = await PDFDocument.create();
    const font = await older.embedFont(StandardFonts.Helvetica);
    LINES.forEach((line, i) => older.addPage([612, 792]).drawText(i === 2 ? line.replace('quick', 'slow') : line, {x: 72, y: 720, size: 12, font}));
    const cmp = await exec('doc.compare', {base64: Buffer.from(await older.save()).toString('base64'), name: 'older.pdf'});
    assert.ok(cmp.changes > 0, 'the older version differs from this file');
    await app.until(async () => (await inspect()).tab === 'compare' || null, {timeout: 15_000});
    await app.capture('03-compare-panel', {doc});
    const marked = await exec('compare.mark', {});
    assert.ok(marked.added > 0);
    await exec('compare.clear');
    await app.until(async () => !(await inspect()).tabs.includes('compare') || null, {timeout: 15_000});

    // Save As (Ctrl+Shift+S): the system dialog is answered by the script; the file is the document now.
    const other = path.join(folder, 'Gate final.pdf');
    await script(app, {type: 'save', path: other});
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+Shift+S'})).command, 'file.save_as');
    await app.until(() => exists(other), {timeout: 30_000});
    assert.ok((await asked(app)).some(a => a.type === 'save'), 'the system Save As dialog was asked');
    const saved = await PDFDocument.load(await fs.readFile(other));
    assert.equal(saved.getPageCount(), 3);
    const {PDFName: Name, PDFArray: Arr} = require('pdf-lib');
    const annots = saved.getPage(0).node.lookup(Name.of('Annots'), Arr);
    const intents = annots.asArray().map(e => saved.context.lookup(e).lookup(Name.of('IT'))?.decodeText()).filter(Boolean);
    assert.ok(intents.includes('LineDimension'), `the measurement is a dimension annotation in the file: ${intents}`);

    // Reopen it from its path: the measurement reads back as a measurement.
    const again = await app.rpc('documents.open', {path: other, show: true});
    const again_id = again.doc ?? again.id;
    assert.ok(again_id);
    await show(app, again_id);
    const info = (await app.rpc('engine.execute', {doc: again_id, command: 'measure.info', params: {}})).result;
    assert.equal(info.measurements.length, 1);
    assert.equal(info.measurements[0].reading.label, '1.27 m');
    assert.equal(info.unsupported.length, 0);

    // Export to text: the one conversion PDF has.
    // A program asking for the export gets the text back (the bridge never writes a path the person did not pick in the Save dialog).
    const exported = await exec('export.text', {});
    assert.match(exported.text, /The quick brown fox jumps over the lazy dog\./);
    assert.equal(exported.pages, 3);

    // Print: the print path (the test-mode script answers it); printing asks the person's approval.
    await script(app);
    let printed;
    try { printed = await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 1}}); } catch (e) {
      assert.equal(e.code, 'approval_required', e.message);
      printed = await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 1}, approval: {nonce: e.data.nonce}});
    }
    assert.equal(printed.result.printed, true);
    assert.ok((await asked(app)).some(a => a.type === 'print'), 'the print job reached the print path');
    await app.capture('04-after-print', {doc});

    // Bridge read-back: every address the document lists reads back.
    for (const d of [doc, again_id]) {
      const tree = await app.rpc('document.inspect', {doc: d});
      const addresses = [];
      const walk = n => { if (n?.address) addresses.push(n.address); for (const k of n?.nodes ?? []) walk(k); };
      walk(tree);
      assert.ok(addresses.length > 3, `the document lists its parts: ${addresses.length}`);
      for (const address of addresses) {
        const r = await app.rpc('document.read', {doc: d, address});
        assert.ok(r && 'value' in r, `${address} reads back`);
      }
    }
    void settle;
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
