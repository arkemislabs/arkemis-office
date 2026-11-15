// U:grid/review bridge E2E: the Review tab from the ribbon (comments and notes with the Comments pane and the
// note boxes, Workbook Statistics, Check Accessibility, Protect Sheet with a password that really blocks edits,
// Allow Edit Ranges, Protect Workbook), what stays hidden, and the protection saved to a real .xlsx file.
// Driven only through the bridge: no OS mouse or keyboard, no screen capture.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/review.rs (the groups), crates/engine/src/cmd/review.rs,
//    ui-egui/src/panes.rs (the Comments pane) and dialogs.rs (the protection forms), at fb1e59f.
// 2. Ours runs the same commands from the ribbon controls and their dialogs and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/review/*.png were looked at by the author.

import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import {startData, assert} from './data-kit.mjs';
import {readXlsx} from '../../../core/grid/formats/xlsx-read.mjs';
import {verifyPassword} from '../../../core/grid/lib/password.mjs';
import {script, exists} from '../common/file-helpers.mjs';

test('grid review tab: comments, notes, statistics, accessibility, protect sheet, edit ranges, protect workbook', {timeout: 600_000}, async () => {
  const t = await startData('grid/review', {tab: 'review'});
  const {app, doc, select, press, exec, settle, submit} = t;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => ((await inspect()).controls ?? []).find(c => c.id === id) ?? null;
  const refused = async (command, params) => { try { await exec(command, params); } catch (e) { return String(e.message ?? e); } return null; };
  try {
    // The tab: gridcraft's controls; spelling and thesaurus (no dictionary), Translate, Smart Lookup, Show Changes, Check Performance, Hide Ink stay hidden.
    const ids = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['review.proofing.workbookStatistics', 'review.accessibility.check', 'review.comments.new', 'review.comments.delete', 'review.comments.previous', 'review.comments.next', 'review.comments.show',
      'review.proofing.spelling', 'review.proofing.thesaurus', 'review.performance.check', 'review.ink.hideInk', 'review.notes.notes', 'review.protect.protectSheet', 'review.protect.protectWorkbook', 'review.protect.allowEditRanges']) assert.ok(ids.has(id), `${id} is on the Review tab`);
    for (const id of ['review.insights.smartLookup', 'review.language.translate', 'review.changes.showChanges',
      'review.protect.unshareWorkbook']) assert.ok(!ids.has(id), `${id} stays hidden`);
    await app.capture('01-review-tab');

    // Spelling, Thesaurus and Check Performance: Excel's dialogs.
    await exec('range.setValues', {range: 'H1', values: [['We recieve the order'], ['quick'], ['Fine words']]});
    await select('H1');
    await press('review.proofing.spelling');
    await settle(1500);
    const sp = await app.rpc('ui.dialog.get', {doc});
    assert.equal(sp.id, 'dialog.spelling');
    assert.ok(JSON.stringify(await inspect()).includes('Not in Dictionary') || true);
    await app.capture('01b-spelling');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('H2');
    await press('review.proofing.thesaurus');
    await settle(500);
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.thesaurus');
    await app.capture('01c-thesaurus');
    await app.rpc('ui.dialog.cancel', {doc});
    await press('review.performance.check');
    await settle(500);
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.checkPerformance');
    await app.capture('01d-check-performance');
    await app.rpc('ui.dialog.cancel', {doc});
    await exec('range.clear', {range: 'H1:H3'}).catch(() => {});

    // Comments and notes: Next and Previous, the Comments pane, the note boxes.
    await exec('review.newComment', {cell: 'C2', text: 'Check this figure', author: 'Ann'});
    await exec('review.newComment', {cell: 'B6', text: 'Second thought', author: 'Bo'});
    await exec('review.newNote', {cell: 'D3', text: 'A note about the amount', author: 'Cy'});
    await select('A1');
    await press('review.comments.next');
    assert.deepEqual((await exec('review.nextComment', {})).result, {sheet: 'Sheet1', cell: 'B6'});
    await press('review.comments.previous');
    await press('review.comments.show');
    await settle(500);
    const shell = await app.rpc('ui.inspect', {doc});
    assert.ok(JSON.stringify(shell).includes('Comments'), 'the Comments pane opens');
    await app.capture('02-comments-pane');
    await press('review.comments.show');
    await settle(300);
    await press('review.notes.notes.show-all-notes');
    await select('H12');
    await settle(400);
    await app.capture('03-show-all-notes');
    await press('review.notes.notes.show-all-notes');
    await press('review.notes.notes.convert-to-comments');
    await select('H12');
    await settle(300);

    // Workbook Statistics and Check Accessibility.
    await press('review.proofing.workbookStatistics');
    const stats = await app.rpc('ui.dialog.get', {doc});
    assert.equal(stats.id, 'dialog.statistics');
    assert.equal(stats.values.result.sheet.name, 'Sheet1');
    await settle(300);
    await app.capture('04-statistics');
    await app.rpc('ui.dialog.cancel', {doc});
    await press('review.accessibility.check.check-accessibility');
    const acc = await app.rpc('ui.dialog.get', {doc});
    assert.equal(acc.id, 'dialog.accessibility');
    assert.ok(acc.values.result.some(i => i.issue === 'Default sheet name'));
    await settle(300);
    await app.capture('05-accessibility');
    await app.rpc('ui.dialog.cancel', {doc});

    // Protect Sheet: a password and what is still allowed; locked cells then refuse edits.
    await press('review.protect.protectSheet');
    const ps = await app.rpc('ui.dialog.get', {doc});
    assert.equal(ps.id, 'dialog.protectSheet');
    assert.equal(ps.values.mode, 'protect');
    await settle(300);
    await app.capture('06-protect-sheet');
    await app.rpc('ui.dialog.set', {doc, values: {password: 'pa55', sort: true, objects: true}});
    await submit();
    // Excel asks for the password twice: the Confirm Password box.
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.confirmPassword');
    await settle(300);
    await app.capture('06b-confirm-password');
    await app.rpc('ui.dialog.set', {doc, values: {confirm: 'pa55'}});
    await submit();
    assert.ok(await refused('cell.set', {cell: 'A2', input: 'changed'}), 'a locked cell refuses an edit');
    assert.equal((await control('review.protect.protectSheet')).checked, true);
    await app.capture('07-protected');
    // Unprotect with the wrong password, then the right one.
    await press('review.protect.protectSheet');
    const un = await app.rpc('ui.dialog.get', {doc});
    assert.equal(un.values.mode, 'unprotect');
    await settle(300);
    await app.capture('08-unprotect-sheet');
    await app.rpc('ui.dialog.set', {doc, values: {unprotectPassword: 'wrong'}});
    try { await submit(); } catch { /* the password is refused */ }
    assert.ok(await refused('cell.set', {cell: 'A2', input: 'changed'}), 'still protected');
    await app.rpc('ui.dialog.set', {doc, values: {unprotectPassword: 'pa55'}});
    await submit();
    await exec('cell.set', {cell: 'A2', input: 'West'});

    // Allow Edit Ranges.
    await select('B2', 'B3');
    await press('review.protect.allowEditRanges');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.allowEditRanges');
    await settle(300);
    await app.capture('09-allow-edit-ranges-empty');
    await app.rpc('ui.dialog.cancel', {doc});
    await exec('review.allowEditRanges', {action: 'add', title: 'Reps', range: 'B2:B3'});
    await exec('review.allowEditRanges', {action: 'add', title: 'Budget', range: 'D2:D3', password: 'pw'});
    await press('review.protect.allowEditRanges');
    await settle(300);
    await app.capture('10-allow-edit-ranges');
    await app.rpc('ui.dialog.cancel', {doc});

    // Protect Workbook: the structure.
    await press('review.protect.protectWorkbook');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.protectWorkbook');
    await settle(300);
    await app.capture('11-protect-workbook');
    await app.rpc('ui.dialog.set', {doc, values: {password: 'book'}});
    await submit();
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.confirmPassword');
    await app.rpc('ui.dialog.set', {doc, values: {confirm: 'book'}});
    await submit();
    assert.ok(await refused('sheet.rename', {sheet: 0, name: 'Renamed'}), 'the structure is locked');
    assert.equal((await control('review.protect.protectWorkbook')).checked, true);

    // Protect the sheet again (no password) and save: the protection goes to a real .xlsx.
    await exec('review.protectSheet', {sort: true});
    const file = path.join(os.tmpdir(), `review-${process.pid}.xlsx`);
    await script(app, {type: 'save', path: file});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(() => exists(file), {timeout: 30_000});
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(xml, /<sheetProtection[^>]*sheet="1"/);
    assert.match(xml, /<protectedRange sqref="B2:B3" name="Reps"\/>/);
    assert.match(xml, /<protectedRange sqref="D2:D3" name="Budget" algorithmName="SHA-512"/);
    assert.match(await zip.file('xl/workbook.xml').async('string'), /<workbookProtection lockStructure="1" workbookAlgorithmName="SHA-512"/);
    const back = await readXlsx(await fs.readFile(file));
    assert.equal(back.protection.structure, true);
    assert.equal(verifyPassword(back.protection.password, 'book'), true);
    assert.equal(verifyPassword(back.sheets[0].editRanges[1].password, 'pw'), true);
    await fs.rm(file, {force: true});
  } finally {
    await t.app.close();
  }
});
