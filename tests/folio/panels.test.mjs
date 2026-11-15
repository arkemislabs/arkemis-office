// core/folio/commands/panels.mjs and lib/pdf-info.mjs: the rail's Layers, Attachments and Tags panels.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) panels/right.rs (Layers: a row and an eye per layer, "This document has no layers"; Attachments: name, size, the page of a
//    comment's file, description, Save, delete only for the document's own attachments; Tags: the structure tree), engine/layers.rs
//    (set_default_layer_state: /BaseState /ON, /ON the visible, /OFF the hidden, the rest of the configuration kept). Acrobat's panels do the same.
// 2. Ours does the same on real PDFs written with pdf-lib and read back with pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {bytesOf} from '../../core/folio/lib/page-source.mjs';
import {readLayers, readAttachments, readTags} from '../../core/folio/lib/pdf-info.mjs';

const N = s => PDFName.of(s);

async function fixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const mk = name => ctx.register(ctx.obj({Type: 'OCG', Name: PDFString.of(name)}));
  const [a, b, c] = [mk('Background'), mk('Notes'), mk('Print only')];
  doc.catalog.set(N('OCProperties'), ctx.obj({OCGs: [a, b, c], D: {BaseState: 'ON', OFF: [c], Order: [a, b, c]}}));
  await doc.attach(new TextEncoder().encode('hello attachment'), 'readme.txt', {mimeType: 'text/plain', description: 'About this file'});
  const p = ctx.register(ctx.obj({Type: 'StructElem', S: 'P', Pg: page.ref, Alt: PDFString.of('A paragraph')}));
  const h = ctx.register(ctx.obj({Type: 'StructElem', S: 'H1', Pg: page.ref, K: [p]}));
  const root = ctx.register(ctx.obj({Type: 'StructTreeRoot', K: [h]}));
  doc.catalog.set(N('StructTreeRoot'), root);
  return migrateContent(await createPdfContent(await doc.save(), 'panels.pdf'));
}
const open = async () => createTestSession('folio', {content: await fixture()});

test('layers: the file\'s groups in its order with the initial visibility; a document without layers lists none', async () => {
  const t = await open();
  const {layers} = (await t.exec('layers.read', {})).result;
  assert.deepEqual(layers.map(l => [l.name, l.visible]), [['Background', true], ['Notes', true], ['Print only', false]]);
  const plain = await createTestSession('folio', {fixture: 'textPages'});
  assert.deepEqual((await plain.exec('layers.read', {})).result.layers, []);
  await assert.rejects(plain.exec('layers.set', {id: '1 0'}), /no layer/);
});

test('layers.set rewrites the default configuration (BaseState ON, ON, OFF), keeps /Order, and is one undo step', async () => {
  const t = await open();
  const {layers} = (await t.exec('layers.read', {})).result;
  const notes = layers.find(l => l.name === 'Notes');
  const r = await t.exec('layers.set', {id: notes.id});
  assert.deepEqual([r.result.name, r.result.visible], ['Notes', false], 'no `visible` toggles');
  const doc = await PDFDocument.load(bytesOf(t.content.sourceBase64));
  const d = doc.catalog.lookup(N('OCProperties'), (await import('pdf-lib')).PDFDict).lookup(N('D'), (await import('pdf-lib')).PDFDict);
  assert.equal(d.lookup(N('BaseState')).decodeText(), 'ON');
  assert.equal(d.lookup(N('OFF')).size(), 2, 'Notes and Print only are off');
  assert.equal(d.lookup(N('ON')).size(), 1);
  assert.ok(d.has(N('Order')), 'the rest of the configuration stays');
  assert.deepEqual(readLayers(doc).map(l => l.visible), [true, false, false]);
  await t.exec('layers.set', {id: notes.id, visible: true});
  assert.deepEqual(readLayers(await PDFDocument.load(bytesOf(t.content.sourceBase64))).map(l => l.visible), [true, true, false]);
  await t.exec('edit.undo', {});
  assert.deepEqual(readLayers(await PDFDocument.load(bytesOf(t.content.sourceBase64))).map(l => l.visible), [true, false, false], 'one step back');
  await assert.rejects(t.exec('layers.set', {id: '99999 0'}), /no layer/);
});

test('attachments: the document\'s files with size and description; save returns the bytes; delete removes it (document attachments only)', async () => {
  const t = await open();
  const {attachments} = (await t.exec('attachments.read', {})).result;
  assert.equal(attachments.length, 1);
  assert.deepEqual([attachments[0].name, attachments[0].description, attachments[0].source], ['readme.txt', 'About this file', {kind: 'document'}]);
  assert.equal(attachments[0].size, 16);
  const saved = await t.exec('attachments.save', {key: attachments[0].key});
  assert.equal(Buffer.from(saved.result.base64, 'base64').toString(), 'hello attachment');
  await assert.rejects(t.exec('attachments.save', {key: 'doc:nothing'}), /no attachment/);
  await assert.rejects(t.exec('attachments.delete', {key: 'annot:0:0'}), /only an attachment of the document/);
  await t.exec('attachments.delete', {key: attachments[0].key});
  assert.deepEqual(readAttachments(await PDFDocument.load(bytesOf(t.content.sourceBase64))), []);
  await t.exec('edit.undo', {});
  assert.equal(readAttachments(await PDFDocument.load(bytesOf(t.content.sourceBase64))).length, 1, 'undo brings it back');
});

test('tags: the structure tree by tag with title and page; an untagged document has none', async () => {
  const t = await open();
  const {tags} = (await t.exec('tags.read', {})).result;
  assert.equal(tags.length, 1);
  assert.deepEqual([tags[0].tag, tags[0].page, tags[0].children.length], ['H1', 0, 1]);
  assert.deepEqual([tags[0].children[0].tag, tags[0].children[0].title], ['P', 'A paragraph']);
  assert.deepEqual(readTags(await PDFDocument.load(await (await PDFDocument.create()).save())), []);
});

test('the rail toggles: one right panel at a time, a second click closes', async () => {
  const t = await open();
  await t.exec('layers.panel', {});
  assert.equal(t.doc.view.rightPanel, 'layers');
  assert.equal((await t.session.state(t.docId, 'layers.panel', {})).checked, true);
  await t.exec('attachments.panel', {});
  assert.equal(t.doc.view.rightPanel, 'attachments');
  await t.exec('a11y.tags', {});
  assert.equal(t.doc.view.rightPanel, 'tags');
  await t.exec('a11y.tags', {});
  assert.equal(t.doc.view.rightPanel, null);
  assert.equal(PDFString.of('x').decodeText(), 'x');
});
