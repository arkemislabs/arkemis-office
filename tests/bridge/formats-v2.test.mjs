// electron/formats-v2.cjs (the format worker's routing) and core/kernel/open-migrate.mjs (opening an
// older document in the new host).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
//  1. What does the original do? Word, Excel and PowerPoint open an older format by converting it in
//     memory and save in the format the person chose; Acrobat writes every comment into the PDF.
//  2. What does this test prove? Schema-2 documents are written by their app's format module, folio-
//     model PDFs by the folio writer with their comments as real annotations, schema-1 documents by
//     the old converters; a schema-2 document whose writer is not translated yet fails with a
//     message instead of writing something else; imports use an app's reader when it has one and
//     otherwise convert the old converter's result with the app's migrate.mjs; migrateOnOpen
//     converts a schema-1 file once and leaves schema 2 alone.
//  3. What is not covered here? The Electron worker thread itself and the system dialogs (the
//     file-lifecycle E2Es cover Save and Open through a window).

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PDFDocument, PDFName} from 'pdf-lib';
import {migrateOnOpen, needsMigration, isUpgrade} from '../../core/kernel/open-migrate.mjs';
import {apps} from '../../core/generated/apps.mjs';
import {createFile} from '../../core/model.mjs';
import {textPages} from '../../core/folio/fixtures.mjs';
import {createAnnotation} from '../../core/folio/model/annots.mjs';
import {defaultStyle} from '../../core/folio/model/types.mjs';

const require = createRequire(import.meta.url);
const {exportFile, importFile} = require('../../electron/formats-v2.cjs');

test('export: a schema-2 document goes through its app format module', async () => {
  const file = createFile('quill', 'Report', {schema: 2});
  const seen = [];
  const formats = async kind => ({docx: {write: {write: (f, opts) => { seen.push([kind, f.id, opts]); return new Uint8Array([1, 2, 3]); }}}});
  const bytes = await exportFile(file, 'docx', {formats});
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.deepEqual(seen, [['quill', file.id, {resolvedLinks: []}]]);
  // No writer for the extension: a clear failure, never a schema-1 converter fed schema-2 content.
  await assert.rejects(exportFile(file, 'rtf', {formats}), /Saving as RTF is not available for this document yet/);
});

test('export: a schema-1 document keeps the old converters', async () => {
  const file = createFile('quill', 'Old');
  const out = await exportFile(file, 'txt', {formats: async () => { throw new Error('must not be asked'); }});
  assert.equal(typeof out === 'string' || out instanceof Uint8Array || Buffer.isBuffer(out), true);
});

test('export: a folio-model PDF is written by the folio writer with its comments', async () => {
  const content = await textPages();
  assert.equal(content.folio, 2);
  const page = content.pages[0];
  const shape = {kind: 'TextBox', rect: [72, 600, 272, 640], fontSize: 12};
  const note = createAnnotation({shape, style: defaultStyle(shape), contents: 'Check this figure', author: 'Me'}, {id: 'n1'});
  page.annots = [...(page.annots ?? []), note];
  const file = {id: 'f1', schema: 1, kind: 'folio', title: 'Contract', content};
  const bytes = await exportFile(file, 'pdf', {formats: async () => ({})});
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), content.pages.length);
  const annots = pdf.getPage(0).node.Annots();
  assert.ok(annots && annots.size() >= 1, 'the comment is a real annotation');
  const texts = [];
  for (let i = 0; i < annots.size(); i++) {
    const a = pdf.context.lookup(annots.get(i));
    const c = a.get(PDFName.of('Contents'));
    if (c) texts.push(c.decodeText?.() ?? String(c));
  }
  assert.ok(texts.some(t => t.includes('Check this figure')), texts.join(' | '));
});

test('import: an app reader makes schema 2; without one the old converter result is migrated', async () => {
  const reader = {read: async (bytes, {title}) => ({...createFile('quill', title, {schema: 2}).content})};
  const viaReader = await importFile(Buffer.from('x'), 'docx', {title: 'Memo', kind: 'quill', newHost: true, formats: async k => (k === 'quill' ? {docx: {read: reader}} : {})});
  assert.equal(viaReader.schema, 2);
  assert.equal(viaReader.title, 'Memo');
  // .txt has no schema-2 reader: the schema-1 converter reads it and quill's migrate.mjs converts it.
  const viaMigrate = await importFile(Buffer.from('Hello there\nSecond line'), 'txt', {title: 'Notes', newHost: true, formats: async () => ({})});
  assert.equal(viaMigrate.kind, 'quill');
  assert.equal(viaMigrate.schema, 2);
  assert.match(JSON.stringify(viaMigrate.content), /Hello there/);
  // The legacy shell (no new host, app not ready) keeps schema 1.
  const legacy = await importFile(Buffer.from('Hello'), 'txt', {title: 'Old', newHost: false, formats: async () => ({}),
    apps: async () => ({quill: {...apps.quill, ready: false}})});
  assert.equal(legacy.schema, 1);
});

test('open-migrate: a schema-1 file is converted once; schema 2 and failures are left alone', async () => {
  const old = createFile('quill', 'Letter');
  assert.equal(needsMigration(apps.quill, old), true);
  const r = await migrateOnOpen(apps.quill, structuredClone(old));
  assert.equal(r.migrated, true);
  assert.equal(r.from, 1);
  assert.equal(r.file.schema, 2);
  assert.equal(r.file.id, old.id);
  assert.equal(isUpgrade(old, r.file), true);
  assert.equal(needsMigration(apps.quill, r.file), false);
  const again = await migrateOnOpen(apps.quill, r.file);
  assert.equal(again.migrated, false);
  assert.equal(again.file, r.file);
  // An app without migrate.mjs, or a migration that throws: the original comes back with the error.
  assert.equal(needsMigration({}, old), false);
  const broken = await migrateOnOpen({migrate: {migrateFile: () => { throw new Error('bad'); }}}, old);
  assert.deepEqual([broken.migrated, broken.error, broken.file], [false, 'bad', old]);
  // PDF: the content is upgraded in place (schema stays 1).
  assert.equal(isUpgrade({id: 'a', kind: 'folio', schema: 1, content: {}}, {id: 'a', kind: 'folio', schema: 1, content: {folio: 2}}), true);
  assert.equal(isUpgrade({id: 'a', kind: 'quill', schema: 2}, {id: 'a', kind: 'quill', schema: 2}), false);
});
