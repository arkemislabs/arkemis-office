// Protect, end to end in the window (docs/behaviour-fidelity.md):
//   Protect using password opens as a dialog (Viewing or Editing, password twice with its strength,
//   Advanced Options), Apply protects the document (written by the next Save), Security properties shows
//   the method, Remove security takes it away; a password-protected PDF opens as a locked document that
//   asks for its password in our dialog, a wrong password stays in the dialog, the right one opens it.
//
// Behaviour fidelity:
// 1. printcraft: crates/ui-egui/src/dialogs/protect.rs (the dialog), commands.rs:197-219 (what each id does),
//    dialogs/prompts.rs:351 (the password prompt), crates/engine/src/protection.rs. Acrobat's Protect, Security
//    properties and Open with a password work the same way.
// 2. Here the window runs the new shell (devRenderer); commands run as engine.execute, the dialogs through
//    ui.dialog.*, the saved bytes are opened with pdf.js (another reader). No password is typed anywhere but the
//    dialog fields of the test window.
// 3. Evidence: artifacts/e2e/folio/protect/*.png (ui.capture -> capturePage). No OS input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {createPdfContent} from '../../../core/pdf-document.mjs';
import {writeFolioPdf} from '../../../core/folio/model/pdf-write.mjs';
import {migrateContent} from '../../../core/folio/migrate.mjs';
import * as P from '../../../core/folio/lib/protect.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

async function plainSeed() {
  const file = createFile('folio', 'Plain PDF');
  file.id = 'folio-plain';
  file.content = await schema1Content(await textPdf({pages: 2}), 'plain.pdf');
  return file;
}

/** A PDF that needs the password `pw1`, as File > Open leaves it: a locked, empty document. */
async function lockedSeed() {
  const doc = await (await import('pdf-lib')).PDFDocument.load(await textPdf({pages: 2}), {updateMetadata: false});
  const rec = await P.protect(await doc.save(), {openPassword: 'pw1', permissionsPassword: 'pw2', printing: 'None', changes: 'None'});
  const bytes = await P.saveEncrypted(doc, rec);
  const file = createFile('folio', 'Locked PDF');
  file.id = 'folio-locked';
  file.content = await migrateContent(await createPdfContent(bytes, 'locked.pdf'));
  assert.ok(file.content.locked);
  return file;
}

test('folio protect: the dialog, Security properties, Remove security, and a locked PDF that asks for its password', {timeout: 300_000}, async () => {
  const plain = await plainSeed();
  const locked = await lockedSeed();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/protect', files: [plain, locked], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = plain.id;
  const exec = async (command, params = {}, d = doc) => (await app.rpc('engine.execute', {doc: d, command, params})).result;
  const security = async d => (await app.rpc('document.read', {doc: d, address: '/security'}).catch(e => (/Nothing at/.test(e.message) ? {value: undefined} : Promise.reject(e)))).value;
  const dlg = id => app.rpc('ui.dialog.get', {doc, id});
  const set = (id, field, value, d = doc) => app.rpc('ui.dialog.set', {doc: d, id, field, value});
  const settle = ms => new Promise(r => setTimeout(r, ms));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const v = await exec('surface.view'); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'all-tools'});
    await app.capture('opened');

    // 1. Protect using password: Viewing, an open password, the strength shows, Apply.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.protect'});
    await settle(500);
    await set('dialog.protect', 'password', 'abc');
    await set('dialog.protect', 'confirm', 'abd');
    await settle(300);
    await app.capture('protect-mismatch');
    await assert.rejects(app.rpc('ui.dialog.submit', {doc, id: 'dialog.protect', button: 'protect'}), /match|password/i);
    await set('dialog.protect', 'password', 'Correct-Horse-9');
    await set('dialog.protect', 'confirm', 'Correct-Horse-9');
    await set('dialog.protect', 'advanced', true);
    await settle(400);
    await app.capture('protect-advanced');
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.protect', button: 'protect'});
    await assert.rejects(dlg('dialog.protect'), /not open/, 'Apply closes the dialog');
    const sec = await security(doc);
    assert.equal(sec.label, 'AES, 256-bit');
    assert.equal(sec.pending, true);
    assert.ok(!JSON.stringify(sec).includes('Correct-Horse-9'));
    const written = await app.rpc('document.read', {doc, address: '/sourceBase64'});
    assert.ok(written.value.length > 100, 'the working copy stays plain');

    // 2. Security properties.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.security-properties'});
    await settle(500);
    const props = await dlg('dialog.security-properties');
    assert.equal((props.values ?? props.dialog?.values).method, 'AES, 256-bit');
    await app.capture('security-properties');
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.security-properties'});

    // 3. Editing: the limits show; Remove security takes the protection back.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.protect'});
    await set('dialog.protect', 'for', 'Editing');
    await settle(400);
    await app.capture('protect-editing');
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.protect'});
    await exec('protect.remove');
    assert.equal(await security(doc), undefined);

    // 4. A locked PDF asks for its password; a wrong one stays; the right one opens it.
    const d2 = locked.id;
    await app.rpc('documents.open', {doc: d2, show: true});
    await app.until(async () => { try { const g = await app.rpc('ui.dialog.get', {doc: d2, id: 'prompt.password'}); return g ? g : null; } catch { return null; } }, {timeout: 30_000})
      .catch(e => { throw new Error(`the password prompt did not open: ${e.message}${log()}`); });
    await settle(600);
    await app.capture('password-prompt');
    await set('prompt.password', 'password', 'not it', d2);
    await assert.rejects(app.rpc('ui.dialog.submit', {doc: d2, id: 'prompt.password', button: 'open'}), /incorrect/i);
    await settle(400);
    await app.capture('password-wrong');
    await set('prompt.password', 'password', 'pw1', d2);
    await app.rpc('ui.dialog.submit', {doc: d2, id: 'prompt.password', button: 'open'});
    const pages = (await app.rpc('document.read', {doc: d2, address: '/pages'})).value;
    assert.equal(pages.length, 2, 'the right password opens the document');
    assert.equal((await security(d2)).owner, false);
    await app.until(async () => { const v = await exec('surface.view', {}, d2); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000});
    await settle(800);
    await app.capture('opened-after-password');
    // The restricted document refuses what its permissions refuse, and the permissions password lifts it.
    await assert.rejects(exec('page.delete', {pages: [1]}, d2), /permissions/);
    await exec('protect.unlock', {password: 'pw2'}, d2);
    assert.equal((await security(d2)).owner, true);
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
