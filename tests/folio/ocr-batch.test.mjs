// core/folio/commands/ocr_batch.mjs: Recognize text in multiple files.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) workflows/ocr_ui.rs ocr_files: each file is recognized in turn with the dialog's settings and a searchable copy is
//    written under the same name into a chosen folder; engine/ocr.rs: pages that already have text are skipped unless forced. Acrobat's Recognize
//    Text in multiple files does the same.
// 2. Ours: a scripted recogniser stands in for the worker (as in tests/folio/ocr.test.mjs); the copies are read back and searched.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {textPdf} from '../../core/folio/fixtures.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';

after(() => releaseTextSources());
const b64 = bytes => Buffer.from(bytes).toString('base64');
async function scan(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawRectangle({x: 72, y: 600, width: 300, height: 60});
  return doc.save();
}
const words = [{text: 'Invoice', x: 72, y: 132, width: 120, height: 24}, {text: 'paid', x: 200, y: 132, width: 60, height: 24}];

test('each file is recognized with the settings given and comes back as a searchable copy under its own name; files that need nothing are named', async () => {
  const calls = [];
  const host = createTestHost({ocrWords: async (content, pageId, opts) => { calls.push([pageId, opts.dpi, opts.language]); return {words}; }});
  const t = await createTestSession('folio', {fixture: 'textPages', host});
  const r = await t.exec('ocr.recognize_batch', {dpi: 150, language: 'en', files: [{base64: b64(await scan(2)), name: 'scan one.pdf'}, {base64: b64(await textPdf({pages: 1})), name: 'has text.pdf'}, {base64: b64(Uint8Array.of(1, 2, 3)), name: 'junk.pdf'}]});
  assert.equal(r.result.recognized, 1);
  assert.equal(r.result.words, 4, 'two words on each of two pages');
  assert.deepEqual(r.result.names, ['scan one.pdf']);
  assert.equal(r.result.left.length, 2);
  assert.match(r.result.left[0], /has text\.pdf \(no page needed recognizing\)/);
  assert.match(r.result.left[1], /junk\.pdf/);
  assert.deepEqual(calls.map(c => c.slice(1)), [[150, 'en'], [150, 'en']]);
  assert.equal(r.result.message, 'Recognized 4 words in 1 file');
  const copy = await migrateContent(await createPdfContent(Buffer.from(r.result.files[0].base64, 'base64'), 'copy.pdf'));
  assert.match((await pageText(copy, copy.pages[1])).plain().text, /Invoice\s+paid/, 'every page of the copy is searchable');
  const forced = await t.exec('ocr.recognize_batch', {force: true, files: [{base64: b64(await textPdf({pages: 1})), name: 'has text.pdf'}]});
  assert.equal(forced.result.recognized, 1, 'forced, a page with text is recognized too (the words not already there are added)');
});

test('without the recognition engine the command is off; without files a program is refused', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  assert.equal((await t.session.state(t.docId, 'ocr.recognize_batch', {})).enabled, false);
  const host = createTestHost({ocrWords: async () => ({words: []})});
  const u = await createTestSession('folio', {fixture: 'textPages', host});
  await assert.rejects(u.exec('ocr.recognize_batch', {}), /files is required/);
  assert.equal((await u.exec('ocr.recognize_batch', {files: [{base64: b64(await scan(1)), name: 'blank.pdf'}]})).result.message, 'No text was recognized');
});
