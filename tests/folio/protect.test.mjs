// core/folio/commands/protect.mjs: Protect using password, Restrict editing, Remove security, Enter
// permissions password, Security properties, and opening a password-protected PDF.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/commands.rs:197-219, dialogs/protect.rs, crates/engine/src/protection.rs,
//    document.rs allows_security_change / can_unlock / security_summary): protection is pending and written by the next
//    save; the session that protects owns the file; a document opened with the open password only is restricted
//    and Remove security or Protect first asks for the permissions password, which alone lifts the limits; the open
//    password and the permissions password must differ. Acrobat's Protect, Restrict editing and Remove security do the same.
// 2. Ours does the same: these tests run the commands, save with the folio writer and open the bytes with pdf.js, a reader
//    that is not ours, with the passwords; no password appears in the document.
// 3. Tests below, tests/folio/protect-engine.test.mjs (ciphers and the file round trip), tests/e2e/folio/protect.e2e.mjs.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {bytesOf} from '../../core/folio/lib/page-source.mjs';
import * as P from '../../core/folio/lib/protect.mjs';

after(() => releaseTextSources());
const open = () => createTestSession('folio', {fixture: 'textPages'});
const viewerOf = async (bytes, password) => (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({data: new Uint8Array(bytes), password, verbosity: 0}).promise;
const reopen = async bytes => migrateContent(await createPdfContent(bytes, 'file.pdf'));

test('Protect using password is pending until Save: the session owns the file, the bytes Save writes need the password, and undo takes it back', async () => {
  const t = await open();
  const r = await t.exec('protect.password', {openPassword: 'open sesame', compatibility: 'Acrobat 7.0 and later (128-bit AES)'});
  assert.deepEqual([r.result.protected, r.result.method, r.result.pending], [true, 'AES, 128-bit', true]);
  assert.equal(t.content.security.pending, true);
  assert.equal(t.content.security.owner, true);
  assert.ok(!JSON.stringify(t.content).includes('open sesame'), 'the password is not in the document');
  assert.equal((await t.exec('protect.properties', {})).result.pending, true);
  // Save writes it; the plain working copy stays what the model edits.
  const bytes = await writeFolioPdf(t.content, {encrypt: true});
  await assert.rejects(viewerOf(bytes), e => e.name === 'PasswordException');
  const viewer = await viewerOf(bytes, 'open sesame');
  assert.equal(viewer.numPages, 2);
  await viewer.loadingTask.destroy();
  assert.equal((await PDFDocument.load(await writeFolioPdf(t.content))).getPageCount(), 2, 'without encrypt the bytes are plain (internal rewrites)');
  const u = await expectUndoRoundTrip(t, 'protect.remove', {}, after => assert.equal(after.content.security, undefined));
  assert.equal(u.undoLabel, 'Remove security');
  const plain = await writeFolioPdf(t.content, {encrypt: true});
  const v2 = await viewerOf(plain);
  assert.equal(v2.numPages, 2, 'removed security: the file opens without a password');
  await v2.loadingTask.destroy();
});

test('Protect refuses what printcraft refuses and never keeps a password', async () => {
  const t = await open();
  await assert.rejects(t.exec('protect.password', {}), /Enter a password/);
  await assert.rejects(t.exec('protect.password', {openPassword: 'same', permissionsPassword: 'same'}), /must be different/);
  await assert.rejects(t.exec('protect.password', {openPassword: ''}), /empty/);
  await assert.rejects(t.exec('protect.password', {openPassword: 'é', compatibility: 'Acrobat 5.0 and later (128-bit RC4)'}), /plain ASCII/);
  assert.equal(t.content.security, undefined);
  await assert.rejects(t.exec('protect.remove', {}), /password-protected|not available|disabled/i);
});

test('Editing password only: a reader opening the saved file is restricted; the permissions password lifts it for the session', async () => {
  const t = await open();
  const r = await t.exec('protect.restrict_editing', {permissionsPassword: 'boss', printing: 'Low Resolution (150 dpi)',
    changes: 'Commenting, filling in form fields, and signing existing signature fields', copy: false, screenReader: true});
  assert.equal(r.result.restricted, true);
  assert.equal(r.result.viewing, false);
  const bytes = await writeFolioPdf(t.content, {encrypt: true});
  const viewer = await viewerOf(bytes);
  const flags = await viewer.getPermissions();
  const {PermissionFlag: F} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  assert.ok(flags.has(F.PRINT) && flags.has(F.MODIFY_ANNOTATIONS) && flags.has(F.FILL_INTERACTIVE_FORMS) && flags.has(F.COPY_FOR_ACCESSIBILITY));
  assert.ok(!flags.has(F.COPY) && !flags.has(F.MODIFY_CONTENTS) && !flags.has(F.PRINT_HIGH_QUALITY) && !flags.has(F.ASSEMBLE));
  await viewer.loadingTask.destroy();
  // Opened the way File > Open does: it opens (no open password), restricted, with the limits in the model.
  const reopened = await reopen(bytes);
  assert.equal(reopened.security.owner, false);
  assert.equal(reopened.permissions.modify, false);
  assert.equal(reopened.permissions.annotate, true);
  assert.equal(reopened.permissions.copy, false);
  const s2 = await createTestSession('folio', {content: reopened});
  assert.equal((await s2.session.state(s2.docId, 'protect.unlock', {})).enabled, true, 'a restricted document can enter the permissions password');
  await assert.rejects(s2.exec('protect.unlock', {password: 'wrong'}), /incorrect/);
  await assert.rejects(s2.exec('protect.remove', {}), /permissions password/, 'removing security asks for the permissions password first');
  await s2.exec('protect.unlock', {password: 'boss'});
  assert.equal(s2.content.security.owner, true);
  assert.equal(s2.content.permissions, undefined, 'the limits are lifted for this session');
  await s2.exec('protect.remove', {});
  assert.equal(s2.content.security, undefined);
});

test('a PDF that needs a password opens as a locked document; protect.open asks for it and decrypts it; a wrong password changes nothing', async () => {
  const src = await open();
  await src.exec('protect.password', {openPassword: 'pw1', permissionsPassword: 'pw2', printing: 'None', changes: 'None'});
  const bytes = await writeFolioPdf(src.content, {encrypt: true});
  const locked = await reopen(bytes);
  assert.equal(locked.pages.length, 0);
  assert.ok(locked.locked.sourceBase64.length > 100);
  assert.equal(locked.sourceBase64, '');
  const t = await createTestSession('folio', {content: locked});
  assert.equal((await t.session.state(t.docId, 'protect.open', {})).enabled, true);
  await assert.rejects(t.exec('protect.open', {password: 'nope'}), /incorrect/);
  assert.ok(t.content.locked, 'a wrong password changes nothing');
  await t.exec('protect.open', {password: 'pw1'});
  assert.equal(t.content.locked, undefined);
  assert.equal(t.content.pages.length, 2);
  assert.equal(t.content.security.owner, false, 'the open password is a user');
  assert.equal(t.content.permissions.print, false);
  assert.equal(t.content.permissions.modify, false);
  assert.equal(t.content.folio, 2);
  assert.equal((await PDFDocument.load(bytesOf(t.content.sourceBase64))).getPageCount(), 2, 'the working copy is plain');
  // Save writes the same security back: the same passwords open the saved file.
  const saved = await writeFolioPdf(t.content, {encrypt: true});
  assert.equal((await P.openPdf(saved, 'pw1')).security.owner, false);
  assert.equal((await P.openPdf(saved, 'pw2')).security.owner, true);
});

test('the permissions of a restricted PDF switch commands off with the reason printcraft gives', async () => {
  const src = await open();
  await src.exec('protect.password', {permissionsPassword: 'owner', changes: 'None', printing: 'High Resolution', copy: true});
  const t = await createTestSession('folio', {content: await reopen(await writeFolioPdf(src.content, {encrypt: true}))});
  const del = await t.session.state(t.docId, 'page.delete', {});
  assert.equal(del.enabled, false);
  assert.match(del.reason, /permissions/);
  await t.exec('protect.unlock', {password: 'owner'});
  assert.notEqual((await t.session.state(t.docId, 'page.delete', {})).enabled, false);
});
