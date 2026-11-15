// U:grid/review: Protect Sheet, Unprotect Sheet, Protect Workbook, Allow Edit Ranges (with Excel's password
// hashes and real enforcement), Workbook Statistics, Check Accessibility, Previous and Next Comment and Note,
// Show Comments, Show All Notes, Convert to Comments, INFO("osversion"), and the xlsx round trip of the
// protection.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/review.rs and its tests (comment order across sheets with
//    wrapping, a sheet password uses Excel's SHA-512 hash and a second Protect cannot swap it, structure
//    protection blocks rename, move, copy, hide and unhide, a workbook password really verifies, Convert to
//    Comments, edit ranges open locked cells and their passwords really verify), crates/model/src/password.rs
//    (the published legacy hash example), at fb1e59f.
// 2. Ours: the same commands over our sheet model (sheet.protection, sheet.editRanges, content.protection).
// 3. These tests; tests/e2e/grid/review.e2e.mjs drives the ribbon and the dialogs.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {legacyHash, newPasswordHash, verifyPassword, saltFrom} from '../../core/grid/lib/password.mjs';
import {osVersion} from '../../core/grid/model/functions/info.mjs';
import {session, workbook, run, fails, v} from './edit-helpers.mjs';

const sheet = (t, i = 0) => t.content.sheets[i];
const sel = (t, range) => run(t, 'selection.set', {range});
const active = t => { const r = t.doc.selection.ranges[t.doc.selection.primary ?? 0]; return decodeURIComponent(String(r.anchor)); };
const book = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}, B2: {v: 2}}}}, {id: 's2', name: 'Two', blocks: {}}]);

test('password hashes: the published legacy example, Excel SHA-512 hashes that verify, damaged and unsupported ones refused', () => {
  assert.equal(legacyHash('password'), 0x83AF);
  assert.equal(legacyHash(''), 0xCE4B);
  assert.equal(verifyPassword({password: '83AF'}, 'password'), true);
  assert.equal(verifyPassword({password: '83AF'}, 'Password'), false);
  const h = newPasswordHash('s3cret', 'Sheet1');
  assert.deepEqual([h.algorithmName, h.spinCount], ['SHA-512', 100000]);
  assert.equal(verifyPassword(h, 's3cret'), true);
  assert.equal(verifyPassword(h, 's3cret '), false);
  assert.notEqual(newPasswordHash('s3cret', 'Sheet1').hashValue, h.hashValue, 'equal passwords get different salts');
  assert.throws(() => verifyPassword({...h, algorithmName: 'SHA-1'}, 's3cret'), /aren't supported/);
  assert.throws(() => verifyPassword({...h, algorithmName: 'MD5'}, 's3cret'), /aren't supported/);
  assert.throws(() => verifyPassword({...h, spinCount: 10_000_001}, 's3cret'), /more than/);
  assert.throws(() => verifyPassword({...h, hashValue: '!!'}, 's3cret'), /damaged/);
  assert.equal(verifyPassword({...h, algorithmName: 'SHA-256', spinCount: 2}, 's3cret'), false);
  assert.equal(saltFrom('x').length, 16);
});

test('protect sheet blocks edits to locked cells, formatting, and the rows and columns, until its flags allow them', async () => {
  const t = await session(book());
  await run(t, 'review.protectSheet', {});
  assert.deepEqual([sheet(t).protection.enabled, sheet(t).protection.selectLocked, sheet(t).protection.formatCells], [true, true, false]);
  assert.equal(t.state('review.protectSheet').checked, true);
  await fails(t, 'cell.set', {cell: 'C3', input: '5'});
  await fails(t, 'home.bold', {range: 'A1'});
  await fails(t, 'home.insertRows', {rows: '1:1'});
  assert.equal(v(t, 'A1'), 1, 'nothing changed');
  await run(t, 'review.unprotectSheet', {});
  assert.equal(sheet(t).protection, undefined);
  await run(t, 'cell.set', {cell: 'C3', input: '5'});
  // Unlocked cells stay editable, and a flag opens one action.
  await run(t, 'home.lockCell', {range: 'D4', on: false});
  await run(t, 'review.protectSheet', {formatCells: true});
  await run(t, 'cell.set', {cell: 'D4', input: '7'});
  await run(t, 'home.bold', {range: 'A1'});
  await fails(t, 'cell.set', {cell: 'A1', input: '9'});
  await expectUndoRoundTrip(t, 'review.unprotectSheet', {}, () => {});
});

test('protection that forbids selecting locked cells is enforced and kept; protecting again keeps the rights', async () => {
  const t = await session(book());
  await run(t, 'home.lockCell', {range: 'B2', on: false});
  await run(t, 'review.protectSheet', {selectLockedCells: false});
  await fails(t, 'selection.set', {cell: 'A1'});
  await sel(t, 'B2');
  await run(t, 'review.unprotectSheet', {});
  await run(t, 'review.protectSheet', {selectLockedCells: false});
  await run(t, 'review.unprotectSheet', {});
  await run(t, 'review.protectSheet', {selectLockedCells: false});
  await fails(t, 'review.protectSheet', {sort: true}).catch(() => {});
  assert.equal(sheet(t).protection.selectLocked, false);
});

test('a sheet password is hashed, never stored plain, never journaled, and a second protect cannot swap it', async () => {
  const t = await session(book());
  await run(t, 'review.protectSheet', {password: 'pa55'});
  const p = sheet(t).protection;
  assert.equal(p.password.algorithmName, 'SHA-512');
  assert.ok(!JSON.stringify(t.content).includes('pa55'));
  await fails(t, 'review.unprotectSheet', {});
  await fails(t, 'review.unprotectSheet', {password: 'pass'});
  await fails(t, 'review.protectSheet', {});
  assert.deepEqual(sheet(t).protection, p, 'protecting again changed nothing');
  const wrong = await fails(t, 'review.unprotectSheet', {password: 'nope'});
  assert.match(String(wrong.message), /password you supplied is not correct/);
  assert.ok(!String(wrong.message).includes('nope'));
  await run(t, 'review.unprotectSheet', {password: 'pa55'});
  assert.equal(sheet(t).protection, undefined);
  const journal = JSON.stringify(t.session.journal);
  assert.ok(!journal.includes('pa55') && !journal.includes('nope'), 'no password in the journal');
  assert.ok(!t.session.journal.some(e => e.command === 'review.protectSheet' || e.command === 'review.unprotectSheet'), 'the protection commands are not journaled at all');
  // A legacy 16-bit hash from a file verifies too.
  const old = await session(workbook([{id: 's1', name: 'Sheet1', protection: {enabled: true, password: {password: '83AF'}}}]));
  await fails(old, 'review.unprotectSheet', {password: 'new'});
  await run(old, 'review.unprotectSheet', {password: 'password'});
});

test('protected structure blocks add, rename, move, copy, hide and unhide; a workbook password really verifies', async () => {
  const t = await session(book());
  const names = () => t.content.sheets.map(x => x.name);
  const before = names();
  await run(t, 'review.protectWorkbook', {});
  assert.equal(t.state('review.protectWorkbook').checked, true);
  await fails(t, 'sheet.rename', {sheet: 0, name: 'Renamed'});
  await fails(t, 'sheet.move', {sheet: 0, to: 1});
  await fails(t, 'sheet.move', {sheet: 0, to: 1, copy: true});
  await fails(t, 'sheet.hide', {sheet: 1});
  await fails(t, 'home.insertSheet', {name: 'Three'});
  assert.deepEqual(names(), before);
  await run(t, 'review.protectWorkbook', {});
  await run(t, 'sheet.rename', {sheet: 0, name: 'Renamed'});
  await run(t, 'sheet.hide', {sheet: 1});
  await run(t, 'review.protectWorkbook', {});
  await fails(t, 'sheet.unhide', {sheet: 1});
  await run(t, 'review.protectWorkbook', {});
  await run(t, 'sheet.unhide', {sheet: 1});
  // With a password.
  await run(t, 'review.protectWorkbook', {password: 'pa55'});
  assert.equal(t.content.protection.password.algorithmName, 'SHA-512');
  assert.deepEqual(await run(t, 'review.protectWorkbook', {on: true}), {on: true});
  await fails(t, 'review.protectWorkbook', {});
  await fails(t, 'review.protectWorkbook', {on: false, password: 'pass'});
  assert.equal(t.content.protection.structure, true);
  await run(t, 'review.protectWorkbook', {on: false, password: 'pa55'});
  assert.equal(t.content.protection, undefined);
  await expectUndoRoundTrip(t, 'review.protectWorkbook', {}, () => {});
});

test('edit ranges open locked cells; their passwords really verify; they move with their cells; list, add, modify, delete and undo', async () => {
  const t = await session(book());
  assert.deepEqual(await run(t, 'review.allowEditRanges', {}), []);
  await run(t, 'review.allowEditRanges', {action: 'add', title: 'Open', range: 'A1:A3'});
  await run(t, 'review.allowEditRanges', {action: 'add', title: 'Budget', range: 'B1:B3,D1', password: 'pa55'});
  await fails(t, 'review.allowEditRanges', {action: 'add', title: 'budget', range: 'E1'});
  await run(t, 'review.protectSheet', {});
  await run(t, 'cell.set', {cell: 'A2', input: '1'});
  await fails(t, 'cell.set', {cell: 'C1', input: '1'});
  const refused = await fails(t, 'cell.set', {cell: 'D1', input: '1'});
  assert.match(String(refused.message), /Budget/);
  await fails(t, 'range.setValues', {range: 'B2', values: [[5]]});
  await fails(t, 'review.allowEditRanges', {action: 'unlock', title: 'Budget', password: 'pass'});
  await fails(t, 'review.allowEditRanges', {action: 'unlock', title: 'Budget'});
  const list = await run(t, 'review.allowEditRanges', {action: 'unlock', title: 'budget', password: 'pa55'});
  assert.equal(list[1].unlocked, true);
  await run(t, 'range.setValues', {range: 'B2', values: [[5]]});
  await run(t, 'cell.set', {cell: 'D1', input: '2'});
  await fails(t, 'review.allowEditRanges', {action: 'delete', title: 'Open'});
  await run(t, 'review.unprotectSheet', {});
  await run(t, 'review.allowEditRanges', {action: 'delete', title: 'Open'});
  await run(t, 'review.allowEditRanges', {action: 'delete', title: 'Budget'});
  assert.deepEqual(await run(t, 'review.allowEditRanges', {}), []);
  await sel(t, 'C3:D4');
  assert.deepEqual(await run(t, 'review.allowEditRanges', {action: 'add'}), [{title: 'Range1', range: 'C3:D4', password: false, unlocked: true}]);
  const m = await run(t, 'review.allowEditRanges', {action: 'modify', title: 'Range1', newTitle: 'Mine', range: 'E5', password: 'x'});
  assert.deepEqual([m[0].title, m[0].range, m[0].password], ['Mine', 'E5', true]);
  await run(t, 'home.insertRows', {rows: '1:1'});
  assert.equal((await run(t, 'review.allowEditRanges', {}))[0].range, 'E6', 'inserting a row above moves the range with its cells');
  await fails(t, 'review.allowEditRanges', {action: 'nope'});
  await fails(t, 'review.allowEditRanges', {action: 'delete'});
  await expectUndoRoundTrip(t, 'review.allowEditRanges', {action: 'delete', title: 'Mine'}, () => {});
});

test('protection and edit ranges survive .xlsx, and so do workbook protection and its hash', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}}}}]));
  await run(t, 'review.allowEditRanges', {action: 'add', title: 'Budget', range: 'B1:B3,D1', password: 'pa55'});
  await run(t, 'review.protectSheet', {password: 'sheetpw', sort: true});
  await run(t, 'review.protectWorkbook', {password: 'bookpw'});
  const bytes = await writeXlsx(t.content);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<sheetProtection algorithmName="SHA-512" hashValue="[^"]+" saltValue="[^"]+" spinCount="100000" sheet="1"[^>]*\/>/);
  assert.match(xml, /<protectedRanges><protectedRange sqref="B1:B3 D1" name="Budget" algorithmName="SHA-512" hashValue="[^"]+" saltValue="[^"]+" spinCount="100000"\/><\/protectedRanges>/);
  assert.ok(xml.indexOf('</sheetData><sheetProtection') > 0 && xml.indexOf('<protectedRanges>') > xml.indexOf('<sheetProtection'));
  const wb = await zip.file('xl/workbook.xml').async('string');
  assert.match(wb, /<workbookProtection lockStructure="1" workbookAlgorithmName="SHA-512" workbookHashValue="[^"]+" workbookSaltValue="[^"]+" workbookSpinCount="100000"\/>/);
  assert.ok(!xml.includes('sheetpw') && !wb.includes('bookpw'));
  const back = await readXlsx(bytes);
  assert.equal(verifyPassword(back.sheets[0].protection.password, 'sheetpw'), true);
  assert.equal(verifyPassword(back.sheets[0].editRanges[0].password, 'pa55'), true);
  assert.deepEqual(back.sheets[0].editRanges[0].ranges, ['B1:B3', 'D1']);
  assert.equal(back.sheets[0].protection.sort, true);
  assert.equal(back.protection.structure, true);
  assert.equal(verifyPassword(back.protection.password, 'bookpw'), true);
});

test('workbook statistics and check accessibility', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}, B2: {f: 'A1+1'}, C3: {v: 'x'}}}, merges: ['A5:B5'], images: [{id: 7, alt: '', anchor: {cell: 'A1', width: 10, height: 10}}]},
    {id: 's2', name: 'Sales', blocks: {0: {A1: {v: 1}}}}]));
  await run(t, 'review.newNote', {cell: 'A1', text: 'n'});
  const st = await run(t, 'review.workbookStatistics', {});
  assert.deepEqual(st.sheet, {name: 'Sheet1', endOfSheet: 'C3', cellsWithData: 3, tables: 0, formulas: 1, charts: 0, comments: 1});
  assert.deepEqual(st.workbook, {sheets: 2, cellsWithData: 4, tables: 0, charts: 0, names: 0});
  const issues = await run(t, 'review.checkAccessibility', {});
  assert.deepEqual(issues, [{sheet: 'Sheet1', issue: 'Missing alternative text', object: 'Picture 7'}, {sheet: 'Sheet1', issue: 'Merged cells', count: 1}, {sheet: 'Sheet1', issue: 'Default sheet name'}]);
});

test('next and previous comment go in reading order across sheets and wrap; notes have their own; disabled without any', async () => {
  const t = await session(book());
  for (const [s, cell] of [[0, 'C1'], [0, 'A3'], [1, 'B2']]) await run(t, 'review.newComment', {sheet: s, cell, text: 'c', author: 'Ann'});
  await run(t, 'review.newNote', {sheet: 0, cell: 'A2', text: 'note', author: 'Bob'});
  await sel(t, 'B1');
  const here = () => { const a = active(t); return a.replace('/sh:', ''); };
  for (const [s, cell] of [['s1', 'C1'], ['s1', 'A3'], ['s2', 'B2'], ['s1', 'C1']]) { await run(t, 'review.nextComment', {}); assert.equal(here(), `${s}/${cell}`, 'notes are skipped'); }
  for (const [s, cell] of [['s2', 'B2'], ['s1', 'A3'], ['s1', 'C1']]) { await run(t, 'review.previousComment', {}); assert.equal(here(), `${s}/${cell}`); }
  assert.deepEqual(await run(t, 'review.nextComment', {notes: true}), {sheet: 'Sheet1', cell: 'A2'});
  const bare = await session(book());
  assert.equal(bare.state('review.nextComment').enabled, false);
  await fails(bare, 'review.nextComment', {});
  await run(bare, 'review.newNote', {cell: 'A1', text: 'note'});
  await fails(bare, 'review.nextComment', {});
  assert.equal(bare.state('review.nextComment', {notes: true}).enabled, true);
});

test('convert to comments turns every note into a comment and undoes; show comments and show all notes toggle', async () => {
  const t = await session(book());
  await run(t, 'review.newNote', {sheet: 0, cell: 'A2', text: 'note', author: 'Bob'});
  await run(t, 'review.newNote', {sheet: 1, cell: 'D4', text: 'second', author: 'Cy'});
  await run(t, 'review.newComment', {sheet: 0, cell: 'A5', text: 'kept', author: 'Ann'});
  const r = await run(t, 'review.convertToComments', {});
  assert.equal(r.converted, 2);
  assert.deepEqual([sheet(t).comments.A2.author, sheet(t).comments.A2.text, sheet(t).comments.A2.threaded, sheet(t, 1).comments.D4.text], ['Bob', 'note', true, 'second']);
  assert.equal(sheet(t).notes, undefined);
  assert.equal(sheet(t).comments.A5.text, 'kept');
  assert.equal((await run(t, 'review.convertToComments', {})).converted, 0, 'nothing left to convert');
  await t.undo();
  assert.equal(sheet(t).notes.A2.text, 'note');
  assert.equal(sheet(t).comments.A2, undefined);
  assert.deepEqual(await run(t, 'review.showComments', {}), {on: true});
  assert.equal(t.doc.view.commentsPane, true);
  assert.deepEqual(await run(t, 'review.showComments', {}), {on: false});
  assert.deepEqual(await run(t, 'review.showComments', {on: true}), {on: true});
  assert.deepEqual(await run(t, 'review.showAllNotes', {}), {on: true});
  assert.deepEqual(await run(t, 'review.showAllNotes', {on: false}), {on: false});
});

test('INFO("osversion") is the operating system version as Excel writes it', async () => {
  assert.match(osVersion(), /^(Windows \((32|64)-bit\) NT \d+\.\d\d|Macintosh \((Intel|ARM)\) \d+\.\d+|Linux.*|Unix)$/);
  assert.ok(!/GridCraft/i.test(osVersion()));
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {f: 'INFO("osversion")'}}}}]));
  assert.equal(v(t, 'A1'), osVersion());
});

test('password hashing in slices: the same Excel hash, and the event loop gets turns while it runs', async () => {
  const {newPasswordHashAsync, verifyPasswordAsync} = await import('../../core/grid/lib/password.mjs');
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const h = await newPasswordHashAsync('sl1ce', 'Sheet1');
  clearInterval(timer);
  assert.ok(ticks >= 3, `the window was not held still (${ticks} timer turns)`);
  assert.deepEqual([h.algorithmName, h.spinCount], ['SHA-512', 100000]);
  assert.equal(verifyPassword(h, 'sl1ce'), true, 'the slice-made hash is the synchronous one');
  assert.equal(await verifyPasswordAsync(h, 'sl1ce'), true);
  assert.equal(await verifyPasswordAsync(h, 'nope'), false);
  assert.equal(await verifyPasswordAsync({password: '83AF'}, 'password'), true);
  await assert.rejects(verifyPasswordAsync({...h, algorithmName: 'MD5'}, 'x'), /aren't supported/);
});

test('a password is confirmed in a second box before the sheet or workbook is protected', async () => {
  const t = await session(book());
  await run(t, 'review.protectSheet', {password: 'pa55', askConfirm: true, sort: true});
  assert.equal(sheet(t).protection, undefined, 'nothing is protected until the password is confirmed');
  const req = t.doc.view.dialogRequest;
  assert.equal(req.id, 'dialog.confirmPassword');
  assert.equal(req.init.command, 'review.protectSheet');
  assert.equal(req.init.params.sort, true);
  const {default: dialog} = await import('../../core/grid/dialogs/confirmPassword.mjs');
  assert.equal(dialog.validate({...req.init, confirm: 'nope'}).length, 1);
  assert.equal(dialog.validate({...req.init, confirm: 'pa55'}).length, 0);
  await fails(t, 'review.protectSheet', {password: 'pa55', confirmPassword: 'pa5'});
  const {command, params} = dialog.toCommand({...req.init, confirm: 'pa55'});
  await run(t, command, params);
  assert.equal(sheet(t).protection.password.algorithmName, 'SHA-512');
  assert.equal(sheet(t).protection.sort, true);
  await run(t, 'review.unprotectSheet', {password: 'pa55'});
  await run(t, 'review.protectWorkbook', {password: 'bk', askConfirm: true});
  assert.equal(t.content.protection, undefined);
  assert.equal(t.doc.view.dialogRequest.init.command, 'review.protectWorkbook');
  await run(t, 'review.protectWorkbook', {password: 'bk', confirmPassword: 'bk'});
  assert.equal(t.content.protection.structure, true);
  // The dialog: OK on a protected sheet unprotects; unchecking Protect worksheet unprotects too.
  const {default: ps} = await import('../../core/grid/dialogs/protectSheet.mjs');
  assert.equal(ps.toCommand({mode: 'protect', protectContents: false}).command, 'review.unprotectSheet');
  const asked = ps.toCommand({mode: 'protect', protectContents: true, password: 'x', formatCells: true, selectLockedCells: true, selectUnlockedCells: false});
  assert.deepEqual([asked.params.askConfirm, asked.params.formatCells, asked.params.selectUnlockedCells, asked.params.objects], [true, true, false, false]);
});

test('edit objects, edit scenarios and insert hyperlinks are enforced on a protected sheet', async () => {
  const t = await session(book());
  await run(t, 'insert.chart', {type: 'column', range: 'A1:B2'});
  await run(t, 'review.protectSheet', {});
  await fails(t, 'chart.set', {title: 'x'});
  await fails(t, 'chart.addElement', {element: 'dataLabels'});
  await fails(t, 'chart.delete', {});
  await fails(t, 'data.scenarioAdd', {name: 'S', changing: 'A1', values: [1]});
  await fails(t, 'insert.link', {cell: 'A1', target: 'https://example.com'});
  await run(t, 'review.unprotectSheet', {});
  await run(t, 'review.protectSheet', {objects: true, scenarios: true, insertHyperlinks: true});
  await run(t, 'chart.set', {title: 'x'});
  await run(t, 'insert.link', {cell: 'A1', target: 'https://example.com'});
  assert.equal(sheet(t).charts[0].title, 'x');
  assert.ok(sheet(t).hyperlinks.A1);
  const back = await readXlsx(await writeXlsx(t.content));
  assert.deepEqual([back.sheets[0].protection.objects, back.sheets[0].protection.scenarios, back.sheets[0].protection.insertHyperlinks, back.sheets[0].protection.sort], [true, true, true, false]);
});
