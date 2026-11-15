// Combine files, end to end in the window (docs/behaviour-fidelity.md):
//   Combine files opens its own workspace with the list of files, each with the pages to take; files are added,
//   a locked one is unlocked in our dialog (a wrong password stays in the dialog), rows are selected, moved and
//   removed, the list is undone, and Combine makes the document.
//
// Behaviour fidelity:
// 1. printcraft: crates/ui-egui/src/workflows/combine_ui/* (the list, the toolbar, Unlock, Combine),
//    crates/engine/src/session/files.rs (ranges, one bookmark per file). Acrobat's Combine Files works the same
//    way. Not checked against upstream: the grid view, sorting by column and Add open documents are not translated.
// 2. Here the window runs the new shell (devRenderer); commands run as engine.execute, the dialogs through
//    ui.dialog.*, the workspace's own buttons through ui.inspect-free clicks on the bridge's synthesized events is
//    not needed: the toolbar runs the same combine.* commands. The files come as bytes (the system Open dialog
//    is the person's, the host's pickOpen carries several paths: tests/folio/combine.test.mjs).
// 3. Evidence: artifacts/e2e/folio/combine/*.png (ui.capture -> capturePage). No OS input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {createContent} from '../../../core/folio/schema.mjs';
import {protect, saveEncrypted} from '../../../core/folio/lib/protect.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const b64 = bytes => Buffer.from(bytes).toString('base64');
async function numbered(label, pages, size = [300, 300]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage(size).drawText(`${label} page ${i}`, {x: 30, y: size[1] / 2, size: 22, font});
  return doc.save();
}

test('folio combine: the workspace, adding files, unlocking one, moving, removing, undo, and Combine', {timeout: 400_000}, async () => {
  const file = createFile('folio', 'Combined');
  file.id = 'folio-combine';
  file.content = createContent();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/combine', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const list = () => exec('combine.read');
  const settle = ms => new Promise(r => setTimeout(r, ms));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await settle(1500);

    // 1. Combine files opens its workspace.
    await exec('page.combine');
    await settle(700);
    await app.capture('empty-workspace');

    // 2. Files: three plain ones (one with a range) and a locked one.
    const pdfDoc = await PDFDocument.load(await numbered('Secret', 2), {updateMetadata: false});
    const rec = await protect(await pdfDoc.save(), {openPassword: 'pw1', permissionsPassword: 'pw2', printing: 'None', changes: 'None'});
    const locked = await saveEncrypted(pdfDoc, rec);
    await exec('combine.add', {files: [
      {base64: b64(await numbered('Alpha', 3)), name: 'alpha.pdf'},
      {base64: b64(await numbered('Beta', 2)), name: 'beta.pdf', range: '2'},
      {base64: b64(locked), name: 'secret.pdf'},
      {base64: b64(await numbered('Gamma', 4)), name: 'gamma.pdf', range: '4, 1-2'},
    ]});
    await settle(900);
    await app.capture('list-with-locked');
    let l = await list();
    assert.deepEqual(l.files.map(f => f.problem), [null, null, 'password', null]);

    // 3. Unlock in our dialog: a wrong password stays, the permissions password opens it for combining.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.combine-unlock'});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.combine-unlock', field: 'password', value: 'nope'});
    await assert.rejects(app.rpc('ui.dialog.submit', {doc, id: 'dialog.combine-unlock', button: 'unlock'}), /incorrect/i);
    await settle(500);
    await app.capture('unlock-wrong');
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.combine-unlock', field: 'password', value: 'pw2'});
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.combine-unlock', button: 'unlock'});
    l = await list();
    assert.equal(l.files[2].problem, null);

    // 4. Select, move and remove; undo.
    await exec('combine.select', {ids: [l.files[3].id]});
    await exec('combine.move', {by: -1});
    await exec('combine.move', {by: -1});
    await exec('combine.select', {ids: [l.files[1].id]});
    await exec('combine.remove');
    await settle(700);
    await app.capture('moved-and-removed');
    assert.deepEqual((await list()).files.map(f => f.name), ['alpha.pdf', 'gamma.pdf', 'secret.pdf']);
    await exec('combine.undo');
    assert.equal((await list()).files.length, 4);
    await exec('combine.redo');

    // 5. Combine: the document is the combined PDF.
    const r = await exec('combine.go');
    assert.equal(r.opened, true);
    assert.equal(r.pages, 3 + 3 + 2);
    await app.until(async () => { const v = await exec('surface.view'); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await settle(1200);
    await app.capture('combined');
    const pages = (await app.rpc('document.read', {doc, address: '/pages'})).value;
    assert.equal(pages.length, 8);
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
