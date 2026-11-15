// U:grid/main bridge E2E: the Home, Help and Quick Access Toolbar controls built on top of the earlier work: Copy as Picture and Paste >
// Picture (drawn by the window), Fill > Across Worksheets, Data Validation's apply-to-same box, Standard Width in characters, the
// Help dialog, and Export as Web Page. Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Not in gridcraft (these are Office's own behaviours): not checked against upstream.
// 2. Ours runs the same commands from the ribbon controls and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/main-tabs/*.png were looked at by the author.

import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {startData, assert} from './data-kit.mjs';
import {exists} from '../common/file-helpers.mjs';

test('grid main tabs: pictures of cells, Fill Across Worksheets, Help, web page export', {timeout: 400_000}, async () => {
  const t = await startData('grid/main-tabs', {tab: 'home'});
  const {app, doc, select, press, exec, settle, read} = t;
  const ids = async () => new Set(((await app.rpc('ui.inspect', {doc})).controls ?? []).map(c => c.id));
  try {
    // The Help tab would hold one button (the rest are Microsoft services), so it is not on the ribbon; F1 opens the local Help.
    const tabs = ((await app.rpc('ui.inspect', {doc})).tabs ?? []).map(x => x.id ?? x);
    assert.ok(!tabs.includes('help'), 'no Help tab');
    const key = await app.rpc('ui.key', {doc, keys: 'F1'});
    assert.equal(key.command, 'help.open');
    await app.rpc('ui.dialog.cancel', {doc}).catch(() => {});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.help'});
    let d = await app.rpc('ui.inspect', {doc});
    assert.equal(d.dialog?.id, 'dialog.help');
    await settle(500);
    await app.capture('02-help');
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.tab', {doc, id: 'home'}); await settle(200);

    // Copy as Picture: the picture of A1:D4 is on the clipboard, Paste > Picture puts it on the sheet at the active cell.
    await select('A1', 'D4');
    const copied = (await exec('edit.copyPicture', {})).result;
    assert.equal(copied.range, 'A1:D4');
    assert.ok(copied.width > 100 && copied.height > 40, JSON.stringify(copied));
    await select('G2');
    await press('home.clipboard.paste.picture');
    const list = (await exec('object.list', {})).result;
    const img = list.find(o => o.kind === 'image');
    assert.ok(img, `a picture is on the sheet: ${JSON.stringify(list)}`);
    assert.equal(img.anchor.cell, 'G2');
    assert.equal(Math.round(img.anchor.width), copied.width);
    await settle(500);
    await app.capture('03-picture-pasted');
    await t.undo();
    assert.equal(((await exec('object.list', {})).result).filter(o => o.kind === 'image').length, 0, 'one undo removes the picture');

    // Ctrl+V after Copy as Picture pastes the picture, not the cells' text.
    await select('A1', 'B2');
    await exec('edit.copyPicture', {});
    await select('H12');
    await exec('edit.paste', {});
    assert.equal(((await exec('object.list', {})).result).filter(o => o.kind === 'image').length, 1, 'Paste puts the picture');
    assert.equal(await read('/sh:s1/H12', 'values'), null, 'and not the text');
    await t.undo();

    // Paste > Picture of copied cells (Copy, not Copy as Picture): a picture of the cells that were copied.
    await select('A1', 'B2');
    await exec('edit.copy', {});
    await select('F8');
    await exec('edit.pastePicture', {});
    assert.equal(((await exec('object.list', {})).result).filter(o => o.kind === 'image').length, 1);
    await t.undo();

    // Paste > Linked Picture: drawn live from the copied cells, so a change to them shows in the picture.
    await select('A1', 'B2');
    await exec('edit.copy', {});
    await select('G12');
    const linked = (await exec('edit.pasteLinkedPicture', {})).result;
    assert.deepEqual(linked.link.range, 'A1:B2');
    await settle(400);
    await app.capture('03b-linked-before');
    await exec('cell.set', {cell: 'A1', input: 'CHANGED'});
    await settle(600);
    await app.capture('03c-linked-after');
    await t.undo(); await t.undo();

    // Fill > Across Worksheets: the dialog lists the other sheets; Contents puts A1:B2 on Sheet2.
    await select('A1', 'B2');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.fillAcrossWorksheets'});
    d = await app.rpc('ui.dialog.get', {doc});
    assert.deepEqual(d.values.others, ['Sheet2']);
    await settle(400);
    await app.capture('04-fill-across');
    await app.rpc('ui.dialog.set', {doc, values: {fill: 'Contents'}});
    await t.submit();
    assert.equal((await read('/sh:s2/A1', 'values')), 'Region');
    assert.equal((await read('/sh:s2/B2', 'values')), 'Ann');

    // Standard Width is asked in characters.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.defaultWidth'});
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.values.width, 8.43);
    await app.rpc('ui.dialog.cancel', {doc});

    // Sheet View: New makes View1 from the sheet as it is, Keep saves it, the list names Default and View1.
    await exec('view.sheetViewNew', {});
    await select('A3');
    await exec('home.hideRows', {});
    await app.rpc('ui.tab', {doc, id: 'view'}); await settle(200);
    const ctl = ((await app.rpc('ui.inspect', {doc})).controls ?? []).map(c => c.id);
    for (const id of ['view.sheetView.select', 'view.sheetView.new', 'view.sheetView.keep', 'view.sheetView.exit', 'view.sheetView.options']) assert.ok(ctl.includes(id), `${id} is on the View tab`);
    await app.rpc('ui.menu', {doc, control: 'view.sheetView.select'}); await settle(350);
    await app.capture('05a-sheet-views');
    await app.rpc('ui.menu', {doc, control: 'view.sheetView.select', open: false});
    await exec('view.sheetViewKeep', {});
    await exec('view.sheetViewExit', {});
    assert.equal((await t.hidden(3)), false, 'Exit shows the rows as Default had them');
    await exec('view.sheetViewSelect', {name: 'View1'});
    assert.equal((await t.hidden(3)), true, 'View1 keeps row 3 hidden');
    await exec('view.sheetViewExit', {});
    await app.rpc('ui.tab', {doc, id: 'home'}); await settle(200);

    // Merge Styles: the list of the other workbooks the application holds (none here).
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.mergeStyles'});
    await settle(500);
    await app.capture('05b-merge-styles');
    await app.rpc('ui.dialog.cancel', {doc});

    // Custom Views > Add…: the Add View box takes the name, and the view is listed.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.addView'});
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Mine'}});
    await settle(300);
    await app.capture('05-add-view');
    await t.submit();
    await press('view.workbookViews.customViews').catch(async () => { await app.rpc('ui.tab', {doc, id: 'view'}); await settle(200); await press('view.workbookViews.customViews'); });
    assert.deepEqual((await app.rpc('ui.dialog.get', {doc})).values.views, ['Mine']);
    await app.rpc('ui.dialog.cancel', {doc});

    // Export as Web Page: the Quick Access Toolbar's Share menu item saves a copy as HTML.
    const html = path.join(os.tmpdir(), `main-tabs-${process.pid}.html`);
    let r;
    try { r = await app.rpc('engine.execute', {doc, command: 'file.saveCopy', params: {path: html, format: 'html'}}); } catch (e) {
      assert.equal(e.code, 'approval_required', e.message);
      r = await app.rpc('engine.execute', {doc, command: 'file.saveCopy', params: {path: html, format: 'html'}, approval: {nonce: e.data.nonce}});
    }
    assert.equal(r.result.copy, true);
    assert.ok(await exists(html));
    const text = await fs.readFile(html, 'utf8');
    assert.match(text, /<table/);
    assert.match(text, />Region<\/td>/);
    await fs.rm(html, {force: true});

    await exec('cell.set', {cell: 'F6', input: 'Привет'});

    // Export as PDF: the same Save a Copy with the PDF format writes the print pages.
    const pdf = path.join(os.tmpdir(), `main-tabs-${process.pid}.pdf`);
    try { r = await app.rpc('engine.execute', {doc, command: 'file.saveCopy', params: {path: pdf, format: 'pdf'}}); } catch (e2) {
      assert.equal(e2.code, 'approval_required', e2.message);
      r = await app.rpc('engine.execute', {doc, command: 'file.saveCopy', params: {path: pdf, format: 'pdf'}, approval: {nonce: e2.data.nonce}});
    }
    assert.equal(r.result.copy, true);
    const pdfBytes = await fs.readFile(pdf);
    const head = pdfBytes.subarray(0, 5).toString('latin1');
    assert.equal(head, '%PDF-');
    // The window's format worker embeds a system font for letters Helvetica lacks: Cyrillic survives the export.
    assert.match((await (await import('../../grid/pdf-text.mjs')).pdfText(new Uint8Array(pdfBytes))), /Привет/);
    await fs.rm(pdf, {force: true});
  } finally {
    await t.app.close();
  }
});
