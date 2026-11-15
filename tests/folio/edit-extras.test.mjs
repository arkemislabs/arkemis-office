// core/folio/lib/attachments.mjs, dialogs/link-properties.mjs and the edit.link, edit.links, edit.link_select, edit.link_change, edit.attach and edit.attachments
// commands: Add link and Attach file.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/organize attachments.rs and tests, crates/annot links.rs, ui-egui link_ui.rs): an attachment is a document-level file in
//    /Names /EmbeddedFiles under its file name (any folder part dropped, made unique with " (2)", " (3)"), with its size and type; a link is a Link annotation with
//    a /URI action, a rectangle of at least 2 points each way and its own border and highlight; the Link tool selects a link and Delete removes it; Link Properties
//    asks for the web address first. Acrobat's Attach a file and Link tool do the same.
// 2. Ours does the same on real files: attachments are read back from the saved bytes (also through a name tree with /Kids), links from the page records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content, editPdf} from '../../core/folio/fixtures.mjs';
import {listAttachments, addAttachment, attachmentKeys, mimeForName, fileName} from '../../core/folio/lib/attachments.mjs';
import linkDialog, {valuesToParams} from '../../core/folio/dialogs/link-properties.mjs';

const session = async (extra = {}) => createTestSession('folio', {content: {...(await migrateContent(await schema1Content(await editPdf(), 'x.pdf'))), ...extra}});
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const b64 = text => Buffer.from(text).toString('base64');
const source = async t => PDFDocument.load(Uint8Array.from(Buffer.from(t.content.sourceBase64, 'base64')));

test('a file is attached to the document under its name, with its size and type; a taken name gets " (2)"', async () => {
  const t = await session();
  assert.equal((await t.exec('edit.attach', {base64: b64('hello world'), name: 'C:\\Users\\me\\notes.txt', description: 'My notes'})).result.name, 'notes.txt');
  assert.equal((await t.exec('edit.attach', {base64: b64('again'), name: 'notes.txt'})).result.name, 'notes.txt (2)');
  await t.exec('edit.attach', {base64: b64('<a/>'), name: 'data.xml'});
  const list = (await t.exec('edit.attachments', {})).result.attachments;
  assert.deepEqual(list.map(a => a.name), ['data.xml', 'notes.txt', 'notes.txt (2)'], 'the name tree is sorted');
  const notes = list.find(a => a.name === 'notes.txt');
  assert.deepEqual([notes.size, notes.type, notes.description], [11, 'text/plain', 'My notes']);
  assert.equal(list.find(a => a.name === 'data.xml').type, 'application/xml');
  const reopened = await PDFDocument.load(await (await source(t)).save());
  assert.deepEqual(attachmentKeys(reopened), ['data.xml', 'notes.txt', 'notes.txt (2)']);
  await assert.rejects(() => t.exec('edit.attach', {base64: b64('x'), name: '   '}), /file name|name/i);
});

test('an attachment is added to a name tree that already has Kids, and the file name drops its folder', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const ctx = doc.context;
  const leaf = ctx.register(ctx.obj({Names: ['b.txt', ctx.register(ctx.obj({Type: 'Filespec', F: 'b.txt'}))]}));
  const root = ctx.obj({Kids: [leaf]});
  doc.catalog.set(PDFName.of('Names'), ctx.obj({EmbeddedFiles: root}));
  assert.deepEqual(attachmentKeys(doc), ['']);
  const key = addAttachment(doc, {name: '/tmp/a.png', bytes: Uint8Array.of(1, 2, 3), mime: mimeForName('a.png')});
  assert.equal(key, 'a.png');
  assert.equal(fileName('x/y\\z.pdf'), 'z.pdf');
  assert.equal(listAttachments(doc).find(a => a.name === 'a.png').type, 'image/png');
});

test('the Link tool is a toggle; a link is added at a page view rectangle with its address and look, listed, changed and deleted', async () => {
  const t = await session();
  assert.equal((await t.exec('edit.link', {})).result.tool, 'edit.add_link');
  assert.equal((await t.state('edit.link', {})).checked, true);
  assert.equal((await t.exec('edit.link', {})).result.tool, null);
  const r = (await t.exec('edit.link', {page: 1, rect: [100, 100, 220, 130], uri: 'https://example.com/a b', visible: true, color: [1, 0, 0], width: 2, line: 'dashed', highlight: 'Outline'})).result;
  assert.equal(r.uri, 'https://example.com/a b');
  const links = (await t.exec('edit.links', {page: 1})).result.links;
  assert.equal(links.length, 1);
  assert.equal(links[0].uri, 'https://example.com/a%20b', 'the address is written 7-bit');
  for (const [v, w] of links[0].rect.map((v, i) => [v, [100, 100, 220, 130][i]])) near(v, w);
  const record = t.content.pages[0].annots.find(a => a.id === r.id);
  assert.equal(record.dict.BS.W, 2);
  assert.equal(record.dict.H, '/P'.replace('/P', '/O'));
  await t.exec('edit.link_select', {page: 1, id: r.id});
  await t.exec('edit.link_change', {change: 'set', uri: 'https://example.org', rect: [100, 100, 260, 130], visible: false});
  const changed = (await t.exec('edit.links', {page: 1})).result.links[0];
  assert.equal(changed.uri, 'https://example.org');
  near(changed.rect[2], 260);
  await t.exec('edit.link_change', {change: 'delete'});
  assert.equal((await t.exec('edit.links', {page: 1})).result.links.length, 0);
  await assert.rejects(() => t.exec('edit.link_change', {page: 1, id: 'lnk-none', change: 'delete'}), /no longer on the page/);
});

test('links need an address and an area of at least 2 points, and a protected document refuses them', async () => {
  const t = await session();
  await assert.rejects(() => t.exec('edit.link', {page: 1, rect: [100, 100, 220, 130]}), /web address/);
  await assert.rejects(() => t.exec('edit.link', {page: 1, rect: [100, 100, 101, 130], uri: 'https://x.test'}), /too small/);
  assert.equal((await t.state('edit.link_change', {change: 'delete'})).enabled, false);
  const locked = await session({permissions: {modify: false}});
  await assert.rejects(() => locked.exec('edit.link', {page: 1, rect: [100, 100, 220, 130], uri: 'https://x.test'}), /security settings/);
  await assert.rejects(() => locked.exec('edit.attach', {base64: b64('x'), name: 'x.txt'}), /security settings/);
});

test('Link Properties asks for the address, and its values become the look of the link', () => {
  assert.deepEqual(linkDialog.validate({url: '  '}), [{field: 'url', message: 'Type the web address'}]);
  assert.deepEqual(linkDialog.validate({url: 'https://x.test'}), []);
  const v = {...linkDialog.init(), url: ' https://x.test ', visible: true, color: '#00FF00', width: 3, line: 'Underline', highlight: 'Inset', __page: 'p1', __rect: [1, 2, 30, 40]};
  assert.deepEqual(valuesToParams(v), {uri: 'https://x.test', visible: true, color: [0, 1, 0], width: 3, line: 'underline', highlight: 'Inset'});
  assert.deepEqual(linkDialog.toCommand(v).params.rect, [1, 2, 30, 40]);
  assert.equal(linkDialog.toCommand(v).command, 'edit.link');
});

test('without an address the window asks in Link Properties (an interactive call), and a cancelled dialog changes nothing', async () => {
  const t = await session();
  const asked = [];
  t.host.openDialog = async (id, init) => { asked.push([id, init]); return {...linkDialog.init(), url: 'https://from.dialog', ...init}; };
  const r = (await t.exec('edit.link', {page: 1, rect: [50, 50, 150, 80]}, {origin: 'ui'})).result;
  assert.equal(asked[0][0], 'dialog.link-properties');
  assert.equal(r.uri, 'https://from.dialog');
  t.host.openDialog = async () => null;
  const c = (await t.exec('edit.link', {page: 1, rect: [50, 90, 150, 120]}, {origin: 'ui'})).result;
  assert.equal(c.canceled, true);
  assert.equal((await t.exec('edit.links', {page: 1})).result.links.length, 1);
});
