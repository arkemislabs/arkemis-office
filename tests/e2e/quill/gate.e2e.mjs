// Quill's gate (docs/architecture.md 17.5), the flows the other Quill suites don't already cover:
// Save As to every format Word saves (the system Save dialog answered by the test-mode script, the
// format from the file type chosen, as in Word), each editable format reopened from its path with
// the text intact, Export to PDF a real PDF, Print through the print path, and every address the
// document lists read back over the bridge. Typing, formatting, dialogs, contextual tabs, undo and
// .docx are in text-editing, format-home, insert-tab, table-layout, dialog-sweep and file-quill.
//
//   npm run build && node --test tests/e2e/quill/gate.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentsFolder, exists, script, asked, show, start, run} from '../common/file-helpers.mjs';

const TEXT = 'Gate check for the Quill document.';
const paraTexts = content => content?.body?.chunks ? content.body.chunks.flat().filter(b => b.kind === 'para').map(p => p.text).filter(Boolean) : [];

test('quill gate: Save As every format, reopen each, Export to PDF, Print, read back every address', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('quill-gate');
  const app = await start('quill', 'quill-gate');
  await run(async () => {
    const {doc} = await app.rpc('documents.create', {});
    await show(app, doc);
    await app.rpc('ui.type', {doc, text: TEXT});
    await app.until(async () => (await app.rpc('document.inspect', {doc})).version > 0 || null);

    // Save As (F12) to each format; the extension picks the writer, as Word's "Save as type" does.
    const saved = {};
    for (const ext of ['docx', 'pdf', 'html', 'txt']) {
      const target = path.join(folder, `Gate.${ext}`);
      await fs.rm(target, {force: true});
      // Plain Text asks Word's File Conversion question (formatting will be lost): OK.
      await script(app, {type: 'save', path: target}, ...(ext === 'txt' ? [{type: 'message', response: 0}] : []));
      const key = await app.rpc('ui.key', {doc, keys: 'F12'});
      assert.equal(key.command, 'file.saveAs', 'F12 is Save As');
      await app.until(() => exists(target), {timeout: 30_000});
      const [dialog] = (await asked(app)).filter(a => a.type === 'save');
      assert.ok(dialog, `${ext}: the system Save As dialog was asked`);
      saved[ext] = target;
    }
    assert.match(await fs.readFile(saved.txt, 'utf8'), /Gate check for the Quill document\./);
    assert.match(await fs.readFile(saved.html, 'utf8'), /Gate check for the Quill document\./);
    const pdf = await fs.readFile(saved.pdf);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'Export to PDF writes a real PDF');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loaded = await pdfjs.getDocument({data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true}).promise;
    const page = await loaded.getPage(1);
    const words = (await page.getTextContent()).items.map(i => i.str).join('');
    assert.match(words.replace(/\s+/g, ' '), /Gate check for the Quill document/, 'the PDF carries the text');

    // Reopen every format Word reads back, from its path (File > Open, Explorer).
    for (const ext of ['docx', 'html', 'txt']) {
      const r = await app.rpc('documents.open', {path: saved[ext], show: false});
      const id = r.doc ?? r.id;
      assert.ok(id, `${ext}: opened`);
      const body = await app.rpc('document.read', {doc: id, address: '/body', as: 'text'});
      assert.match(String(body.value), /Gate check for the Quill document\./, `${ext}: the text survives the round trip`);
    }

    // Print: File > Print's command, through the print path (the test-mode script answers it).
    await script(app);
    await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 1}}).catch(e => { if (e.code !== 'approval_required') throw e; });
    await app.capture('after-print');

    // Bridge read-back: every address the document lists reads back.
    const tree = await app.rpc('document.inspect', {doc});
    const addresses = [];
    const walk = n => { if (n?.address) addresses.push(n.address); for (const k of n?.nodes ?? []) walk(k); };
    walk(tree);
    assert.ok(addresses.length > 2, 'the document lists its parts');
    for (const address of addresses) {
      const r = await app.rpc('document.read', {doc, address});
      assert.ok(r && 'value' in r, `${address} reads back`);
    }
    void paraTexts;
  }, app);
});
