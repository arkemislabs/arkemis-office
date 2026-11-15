// PDF (Acrobat): there is no blank PDF; a PDF is opened from disk (here: the path on the command
// line, as Explorer opens it), Ctrl+S writes it back in place without a dialog, Ctrl+Shift+S is Save
// As with "Adobe PDF Files (*.pdf)", and the document is then the new file. Ctrl+P shows File >
// Print; printing goes through the window's print job (test mode logs it instead of printing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {asked, binding, documentsFolder, edit, exists, run, script, start, windowOf} from './file-helpers.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument} = require('pdf-lib');

test('pdf: open from the command line, Save in place, Save As, Print', {timeout: 300_000}, async () => {
  const folder = await documentsFolder('pdf');
  const source = path.join(folder, 'Contract.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]); pdf.addPage([612, 792]);
  await fs.writeFile(source, await pdf.save());
  const app = await start('folio', 'file-pdf', {args: [source]});
  await run(async () => {
    await assert.rejects(app.rpc('documents.create', {}), e => e.code === 'disabled');
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await app.until(async () => (await app.rpc('ui.inspect', {doc}).catch(() => null))?.doc?.id === doc || null, {timeout: 45_000});
    assert.equal((await windowOf(app, doc)).title, 'Contract - PDF');

    // Ctrl+S: the PDF's own file, no dialog.
    await edit(app, doc);
    await script(app);
    const stamp = (await fs.stat(source)).mtimeMs;
    const key = await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    assert.equal(key.command, 'file.save');
    await app.until(async () => (await fs.stat(source)).mtimeMs > stamp || null, {timeout: 30_000});
    assert.deepEqual((await asked(app)).filter(a => a.type === 'save'), []);
    assert.equal((await PDFDocument.load(await fs.readFile(source))).getPageCount(), 2);

    // Ctrl+Shift+S: Save As, the PDF type, then the document is the new file.
    const other = path.join(folder, 'Contract final.pdf');
    await script(app, {type: 'save', path: other});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Shift+S'});
    await app.until(() => exists(other), {timeout: 30_000});
    const dialog = (await asked(app)).find(a => a.type === 'save');
    assert.equal(dialog.options.filters[0].name, 'Adobe PDF Files (*.pdf)');
    await app.until(async () => (await binding(app, doc))?.path === other || null);
    assert.equal((await windowOf(app, doc)).title, 'Contract final - PDF');
    const recent = (await app.rpc('documents.list', {})).recent.map(r => r.path);
    assert.deepEqual(recent.slice(0, 2), [other, source]);

    // Print (programmatic: settings and the person's approval).
    let printed;
    try { printed = await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 2, orientation: 'portrait'}}); } catch (e) {
      assert.equal(e.code, 'approval_required', e.message);
      printed = await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 2, orientation: 'portrait'}, approval: {nonce: e.data.nonce}});
    }
    assert.equal(printed.result.printed, true);
    const job = (await asked(app)).find(a => a.type === 'print');
    assert.equal(job.options.copies, 2);
    assert.equal(job.options.landscape, false);
    await app.capture('saved-as');
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
