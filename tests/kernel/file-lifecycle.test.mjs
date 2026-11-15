// The document file lifecycle state machine (core/common/commands/file.mjs) over the in-memory file
// service (core/kernel/host.mjs createMemoryFiles): New -> untitled, Save -> Save As dialog the first
// time then the bound file, Save As (lossy formats with Office's warnings), Save a Copy, Close with
// unsaved changes, AutoSave, Open, Rename, Recent.
//
// 1. ArtCraft: wordcraft crates/engine/src/cmd/file.rs (file.save/saveAs/close/rename),
//    crates/ui-egui/src/app/files.rs (save before close, AutoSave blocks, autosave_tick) at aadb077;
//    Office: Word/Excel/PowerPoint save a new document through the system Save As dialog with the
//    native type first, later saves write that file, Save As binds to the new file (Excel warns
//    before CSV and binds to it), Save a Copy leaves the document on its file, closing a changed
//    document asks Save / Don't Save / Cancel, AutoSave needs a saved file in the native format.
// 2. Ours does the same: every case below asserts which dialog was asked (with which file types),
//    what was written where, and what the document is bound to afterwards.
// 3. This file (engine) and tests/bridge/file-lifecycle.test.mjs (real files through the format
//    worker) and tests/e2e/common/file-*.e2e.mjs (Electron, scripted system dialogs).

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectApprovalRequired} from '../../core/kernel/testing.mjs';
import {createTestHost, createMemoryFiles} from '../../core/kernel/host.mjs';
import fileFamily, {
  FILE_TYPES, saveFilters, openFilters, untitledName, canCreate, suggestedFileName, lossyPrompts, autosaveBlock,
  formatForPath, samePath, stemOf, saveChangesText, saveChangesModel, keepsEverything,
} from '../../core/common/commands/file.mjs';

async function setup(app, {script = [], disk = {}, binding = {}} = {}) {
  const files = createMemoryFiles({script, disk});
  const host = createTestHost({files});
  // Only the file family (and no app foundation): the lifecycle is app-independent.
  const t = await createTestSession(app, {host, modules: [fileFamily], sources: ['core/common/commands/file.mjs'], foundation: {}});
  const names = {quill: 'Document1', grid: 'Book1', prism: 'Presentation1', folio: 'Sample', slate: 'Note'};
  files.bind(t.docId, {kind: app, name: names[app], ...binding});
  return {t, files};
}
const edit = t => t.exec('file.properties', {subject: `edit ${Math.random()}`});

test('file types: native format first, Office names, every format the worker writes', () => {
  assert.deepEqual(saveFilters('quill').map(f => f.name), ['Word Document (*.docx)', 'PDF (*.pdf)', 'Web Page (*.htm;*.html)', 'Plain Text (*.txt)']);
  assert.deepEqual(saveFilters('grid').map(f => f.name), ['Excel Workbook (*.xlsx)', 'CSV (Comma delimited) (*.csv)', 'Web Page (*.htm;*.html)', 'PDF (*.pdf)']);
  // PowerPoint's PDF is written by file.exportPdf (the window draws the slides), not the format worker.
  assert.deepEqual(saveFilters('prism').map(f => f.name), ['PowerPoint Presentation (*.pptx)', 'PDF (*.pdf)']);
  assert.deepEqual(saveFilters('folio').map(f => f.name), ['Adobe PDF Files (*.pdf)']);
  // The current file's type comes first in Save As (Office keeps the type you have).
  assert.equal(saveFilters('grid', {first: 'csv'})[0].format, 'csv');
  assert.equal(openFilters('quill')[0].name, 'All Word Documents (*.docx)');
  assert.equal(openFilters('grid')[0].name, 'All Excel Files (*.xlsx)');
  assert.equal(openFilters('prism')[0].name, 'All PowerPoint Presentations (*.pptx)');
  assert.deepEqual(openFilters('folio').at(-1), {name: 'All Files (*.*)', extensions: ['*']});
  assert.equal(formatForPath('quill', 'C:\\a\\Report.DOCX'), 'docx');
  assert.equal(formatForPath('quill', 'C:\\a\\Report.htm'), 'html');
  assert.equal(formatForPath('grid', 'C:\\a\\Report.docx'), null);
  assert.ok(keepsEverything('grid', 'xlsx'));
  assert.ok(!keepsEverything('grid', 'csv'));
  assert.ok(samePath('C:\\Docs\\A.docx', 'c:/docs/a.docx'));
  assert.equal(stemOf('C:\\Docs\\Q3 report.v2.xlsx'), 'Q3 report.v2');
  for (const kind of Object.keys(FILE_TYPES)) assert.ok(FILE_TYPES[kind].save.length, kind);
});

test('untitled names follow Office per app; PDF and Slate make no blank files', () => {
  assert.equal(untitledName('quill', 1), 'Document1');
  assert.equal(untitledName('grid', 2), 'Book2');
  assert.equal(untitledName('prism', 3), 'Presentation3');
  assert.equal(untitledName('folio', 1), null);
  assert.ok(canCreate('quill') && canCreate('grid') && canCreate('prism'));
  assert.ok(!canCreate('folio') && !canCreate('slate'));
  assert.equal(suggestedFileName('quill', 'Document1', 'docx'), 'Document1.docx');
  assert.equal(suggestedFileName('quill', 'Notes', 'html'), 'Notes.html');
  assert.equal(suggestedFileName('grid', 'a:b?', 'csv'), 'a_b_.csv');
});

test('file.save on a new document opens the Save As dialog with the native type, then binds to the file', async () => {
  const {t, files} = await setup('quill', {script: [{path: 'C:\\Docs\\Report.docx', format: 'docx'}]});
  await edit(t);
  assert.equal(t.doc.dirty, true);
  const r = await t.exec('file.save');
  assert.deepEqual(r.result, {saved: true, path: 'C:\\Docs\\Report.docx', format: 'docx', bound: true, copy: false});
  assert.equal(files.asked.length, 1);
  assert.equal(files.asked[0].type, 'save');
  assert.equal(files.asked[0].format, 'docx');
  assert.equal(files.asked[0].name, 'Document1');
  assert.deepEqual(files.written.map(w => [w.path, w.format, w.bind]), [['C:\\Docs\\Report.docx', 'docx', true]]);
  assert.equal(t.doc.dirty, false, 'the document has every change in its file');
  const b = files.binding(t.docId);
  assert.equal(b.path, 'C:\\Docs\\Report.docx');
  assert.equal(b.name, 'Report');
  assert.deepEqual((await files.recent('quill')).map(x => x.path), ['C:\\Docs\\Report.docx']);

  // The next Save writes the same file without asking.
  await edit(t);
  await t.exec('file.save');
  assert.equal(files.asked.length, 1, 'no dialog the second time');
  assert.equal(files.written.at(-1).path, 'C:\\Docs\\Report.docx');
  assert.equal(t.doc.dirty, false);
});

test('Cancel in the Save As dialog writes nothing and keeps the changes', async () => {
  const {t, files} = await setup('grid', {script: [null]});
  await edit(t);
  const r = await t.exec('file.save');
  assert.deepEqual(r.result, {saved: false, canceled: true});
  assert.equal(files.written.length, 0);
  assert.equal(t.doc.dirty, true);
  assert.equal(files.binding(t.docId).path, null);
});

test('over the bridge: no dialogs; a new document needs a path; writing a file asks approval', async () => {
  const {t, files} = await setup('quill');
  await edit(t);
  await assert.rejects(t.bridge('file.save'), e => e.code === 'invalid_params' && /has not been saved yet/.test(e.message) && e.data.path === '/path');
  await assert.rejects(t.bridge('file.saveAs'), e => e.code === 'invalid_params' && /path is required/.test(e.message));
  assert.equal(files.asked.length, 0);
  const approval = await expectApprovalRequired(t, 'file.save', {path: 'C:\\Out\\Bridge.docx'});
  assert.equal(approval.risk, 'irreversible');
  assert.match(approval.summary, /Save "Document1" to C:\\Out\\Bridge\.docx/);
  const r = await t.bridge('file.save', {path: 'C:\\Out\\Bridge.docx'}, {approval: {nonce: approval.nonce}});
  assert.equal(r.result.path, 'C:\\Out\\Bridge.docx');
  assert.equal(files.binding(t.docId).path, 'C:\\Out\\Bridge.docx');
  // Saving to its own file again is an ordinary edit: no approval.
  await edit(t);
  const again = await t.bridge('file.save');
  assert.equal(again.result.path, 'C:\\Out\\Bridge.docx');
  // A format the app can't write, or an extension that disagrees with the format, is refused.
  // (A new file asks approval first; the approved call is then refused for its format.)
  const bad = await expectApprovalRequired(t, 'file.save', {path: 'C:\\Out\\x.xlsx'});
  await assert.rejects(t.bridge('file.save', {path: 'C:\\Out\\x.xlsx'}, {approval: {nonce: bad.nonce}}),
    e => e.code === 'invalid_params' && /can't save a .XLSX file/.test(e.message));
  await assert.rejects(t.bridge('file.saveAs', {path: 'C:\\Out\\x.txt', format: 'docx'}, {approval: {nonce: 'x'}}), e => ['invalid_params', 'approval_invalid'].includes(e.code));
});

test('Grid Save As CSV: Excel\'s two warnings, OK + Yes binds the workbook to the CSV; No goes back to Save As', async () => {
  const {t, files} = await setup('grid', {binding: {path: 'C:\\Docs\\Book1.xlsx', format: 'xlsx', name: 'Book1', savedHere: true}});
  await t.exec('file.properties', {title: 'two sheets'});
  // Pretend the workbook has two sheets (the warning depends on it).
  const sheets = t.file.content.sheets;
  if (sheets.length < 2) t.session.get(t.docId).file = {...t.file, content: {...t.file.content, sheets: [...sheets, {...sheets[0], id: 's2', name: 'Sheet2'}]}};
  files.script({path: 'C:\\Docs\\Book1.csv', format: 'csv'}, 0, 1, {path: 'C:\\Docs\\Book1 (2).csv', format: 'csv'}, 0, 0);
  const r = await t.exec('file.saveAs');
  const kinds = files.asked.map(a => a.type);
  assert.deepEqual(kinds, ['save', 'message', 'message', 'save', 'message', 'message']);
  assert.match(files.asked[1].message, /does not support workbooks that contain multiple sheets/);
  assert.deepEqual(files.asked[1].buttons, ['OK', 'Cancel']);
  assert.match(files.asked[2].message, /Book1\.csv may contain features that are not compatible with CSV \(Comma delimited\)\. Do you want to keep the workbook in this format\?/);
  assert.deepEqual(files.asked[2].buttons, ['Yes', 'No']);
  assert.equal(files.asked[0].format, 'xlsx', 'Save As starts on the workbook\'s own type');
  assert.equal(r.result.path, 'C:\\Docs\\Book1 (2).csv');
  assert.equal(r.result.bound, true);
  const b = files.binding(t.docId);
  assert.equal(b.format, 'csv');
  assert.equal(b.name, 'Book1 (2)');
  assert.ok(autosaveBlock('grid', b), 'AutoSave can\'t keep a CSV');
  // Saving the CSV again asks only "keep this format?" (no sheet warning).
  await edit(t);
  files.script(0);
  await t.exec('file.save');
  assert.match(files.asked.at(-1).message, /may contain features/);
  assert.equal(files.written.at(-1).path, 'C:\\Docs\\Book1 (2).csv');
});

test('Quill Save As Plain Text warns about formatting (File Conversion) and binds; Web Page is a copy', async () => {
  const {t, files} = await setup('quill', {binding: {path: 'C:\\Docs\\Memo.docx', format: 'docx', name: 'Memo', savedHere: true}});
  files.script({path: 'C:\\Docs\\Memo.txt', format: 'txt'}, 0);
  await t.exec('file.saveAs');
  assert.equal(files.asked[1].title, 'File Conversion - Memo.txt');
  assert.match(files.asked[1].message, /Saving as a text file will cause all formatting/);
  assert.equal(files.binding(t.docId).path, 'C:\\Docs\\Memo.txt');
  files.script({path: 'C:\\Docs\\Memo.html', format: 'html'});
  const r = await t.exec('file.saveAs');
  assert.equal(r.result.bound, false);
  assert.equal(r.result.copy, true);
  assert.equal(files.binding(t.docId).path, 'C:\\Docs\\Memo.txt', 'a format Quill can\'t read back is written as a copy');
  // Cancel in the warning cancels the save.
  files.script({path: 'C:\\Docs\\Other.txt', format: 'txt'}, 1);
  const c = await t.exec('file.saveAs');
  assert.deepEqual(c.result, {saved: false, canceled: true});
  assert.ok(!files.disk.has('C:\\Docs\\Other.txt'));
});

test('Save a Copy: the dialog every time, the document stays on its file with its changes', async () => {
  const {t, files} = await setup('prism', {binding: {path: 'C:\\Docs\\Deck.pptx', format: 'pptx', name: 'Deck', savedHere: true}});
  await edit(t);
  files.script({path: 'C:\\Backup\\Deck copy.pptx', format: 'pptx'});
  const r = await t.exec('file.saveCopy');
  assert.equal(r.result.copy, true);
  assert.equal(files.asked[0].mode, 'copy');
  assert.equal(files.written[0].bind, false);
  assert.equal(files.binding(t.docId).path, 'C:\\Docs\\Deck.pptx');
  assert.equal(t.doc.dirty, true, 'the document still has changes its own file lacks');
  assert.ok(!(await files.recent()).some(x => x.path.includes('Backup')), 'a copy is not the document: not in Recent');
});

test('file.close with unsaved changes: Save (Save As for a new document), Don\'t Save, Cancel', async () => {
  const {t, files} = await setup('quill');
  await edit(t);
  await assert.rejects(t.exec('file.close'), e => e.code === 'failed' && /unsaved changes/.test(e.message));
  // Save on a new document runs Save As; Cancel there cancels the close.
  files.script(null);
  const canceled = await t.exec('file.close', {save: true});
  assert.deepEqual(canceled.result, {closed: false, canceled: true});
  assert.ok(t.session.docs.has(t.docId));
  // Save -> Save As -> written, then closed.
  files.script({path: 'C:\\Docs\\Letter.docx', format: 'docx'});
  const closed = await t.exec('file.close', {save: true});
  assert.deepEqual(closed.result, {closed: true});
  assert.equal(files.written[0].path, 'C:\\Docs\\Letter.docx');
  assert.ok(!t.session.docs.has(t.docId));
  assert.deepEqual(files.closedDocs.map(c => c.discard), [false]);

  // Don't Save: discards (over the bridge that needs approval: destructive).
  const second = await setup('grid');
  await edit(second.t);
  const approval = await expectApprovalRequired(second.t, 'file.close', {force: true});
  assert.equal(approval.risk, 'destructive');
  assert.match(approval.summary, /discard its unsaved changes/);
  await second.t.bridge('file.close', {force: true}, {approval: {nonce: approval.nonce}});
  assert.deepEqual(second.files.closedDocs.map(c => c.discard), [true]);
  assert.equal(second.files.written.length, 0);
});

test('the Save Changes message box: Office wording per app; Save and Don\'t Save run file.close', () => {
  assert.equal(saveChangesText('quill', 'Document1').message, 'Do you want to save changes to “Document1”?');
  assert.equal(saveChangesText('grid', 'Book1').message, 'Do you want to save the changes you made to “Book1”?');
  assert.equal(saveChangesText('prism', 'Presentation1').detail, "Your changes will be lost if you don't save them.");
  assert.match(saveChangesText('folio', 'a').message, /before closing\?$/);
  const model = saveChangesModel('dialog.saveChanges', 'Save Changes?');
  assert.deepEqual(model.buttons.save(), {command: 'file.close', params: {save: true}});
  assert.deepEqual(model.buttons['dont-save'](), {command: 'file.close', params: {force: true}});
  assert.deepEqual(model.buttons.no(), {command: 'file.close', params: {force: true}});
});

test('AutoSave: a new document is saved first (Save As); then on; a CSV can\'t; the bridge gets the reason', async () => {
  const {t, files} = await setup('quill');
  assert.equal(t.state('file.autosave').checked, false);
  assert.match(t.state('file.autosave').reason, /Save the document to turn on AutoSave/);
  await assert.rejects(t.bridge('file.autosave', {value: true}), e => e.code === 'failed' && e.data.block === 'unsaved');
  files.script({path: 'C:\\Docs\\Auto.docx', format: 'docx'});
  const r = await t.exec('file.autosave', {value: true});
  assert.deepEqual(r.result, {value: true});
  assert.equal(files.asked[0].mode, 'saveAs');
  assert.equal(files.binding(t.docId).autosave, true);
  assert.equal(t.state('file.autosave').checked, true);
  await t.exec('file.autosave', {value: false});
  assert.equal(files.binding(t.docId).autosave, false);

  // An opened file that was not saved in this session: Save (no dialog) lifts the block.
  const opened = await setup('grid', {binding: {path: 'C:\\Docs\\Data.xlsx', format: 'xlsx', name: 'Data', savedHere: false}});
  assert.equal(autosaveBlock('grid', opened.files.binding(opened.t.docId)).block, 'notSavedHere');
  await opened.t.exec('file.autosave', {value: true});
  assert.equal(opened.files.asked.length, 0);
  assert.equal(opened.files.written[0].path, 'C:\\Docs\\Data.xlsx');
  assert.equal(opened.files.binding(opened.t.docId).autosave, true);
});

test('file.open: the Open dialog at the controls, a path over the bridge; an open file comes forward', async () => {
  const disk = {'C:\\Docs\\Plan.docx': {format: 'docx', file: {kind: 'quill'}}};
  const {t, files} = await setup('quill', {disk});
  await assert.rejects(t.bridge('file.open'), e => e.code === 'invalid_params' && e.data.path === '/path');
  files.script('C:\\Docs\\Plan.docx');
  const r = await t.exec('file.open');
  assert.equal(files.asked[0].type, 'open');
  assert.equal(r.result.opened, true);
  assert.equal(r.result.name, 'Plan');
  assert.equal(r.result.alreadyOpen, false);
  const again = await t.bridge('file.open', {path: 'c:/docs/plan.docx'});
  assert.equal(again.result.alreadyOpen, true);
  assert.equal(again.result.doc, r.result.doc);
  await assert.rejects(t.bridge('file.open', {path: 'C:\\Docs\\Missing.docx'}), e => e.code === 'not_found' && /couldn't find/.test(e.message));
  files.script(null);
  assert.deepEqual((await t.exec('file.open')).result, {opened: false, canceled: true});
});

test('file.new: Document1, Document2 ...; Acrobat has no blank PDF', async () => {
  const {t, files} = await setup('quill');
  const a = await t.exec('file.new');
  const b = await t.exec('file.new');
  assert.deepEqual([a.result.name, b.result.name], ['Document1', 'Document2']);
  assert.equal(files.binding(a.result.doc).path, null);
  const pdf = await setup('folio');
  assert.equal(pdf.t.state('file.new').enabled, false);
  assert.match(pdf.t.state('file.new').reason, /Create a PDF/);
});

test('file.rename: a saved document\'s file is renamed in its folder, keeping its extension', async () => {
  const disk = {'C:\\Docs\\Old.xlsx': {format: 'xlsx', file: {kind: 'grid'}}};
  const {t, files} = await setup('grid', {disk, binding: {path: 'C:\\Docs\\Old.xlsx', format: 'xlsx', name: 'Old', savedHere: true}});
  const approval = await expectApprovalRequired(t, 'file.rename', {name: 'New'});
  assert.match(approval.summary, /Rename the file Old\.xlsx to New/);
  const r = await t.exec('file.rename', {name: 'Budget'});
  assert.equal(r.result.path, 'C:\\Docs\\Budget.xlsx');
  assert.ok(files.disk.has('C:\\Docs\\Budget.xlsx') && !files.disk.has('C:\\Docs\\Old.xlsx'));
  await assert.rejects(t.exec('file.rename', {name: 'a/b'}), e => e.code === 'invalid_params');
});

test('Recent: pinned files stay, Clear Recent Files removes the others', async () => {
  const {t, files} = await setup('quill', {script: [{path: 'C:\\A\\One.docx', format: 'docx'}, {path: 'C:\\A\\Two.docx', format: 'docx'}]});
  await t.exec('file.save');
  await t.exec('file.saveAs');
  assert.deepEqual((await files.recent('quill')).map(r => r.name), ['Two', 'One']);
  files.recentList.find(r => r.name === 'One').pinned = true;
  const r = await t.exec('file.clear_recent');
  assert.deepEqual(r.result.recent.map(x => x.name), ['One']);
});

test('lossy prompts are Office\'s; native formats have none', () => {
  assert.deepEqual(lossyPrompts('quill', 'docx', {name: 'a'}), []);
  assert.deepEqual(lossyPrompts('grid', 'xlsx', {name: 'a'}), []);
  assert.equal(lossyPrompts('grid', 'csv', {name: 'a', sheets: 1}).length, 1);
  assert.equal(lossyPrompts('grid', 'csv', {name: 'a', sheets: 3}).length, 2);
  assert.equal(lossyPrompts('grid', 'csv', {name: 'a', sheets: 3, mode: 'save'}).length, 1);
  assert.equal(lossyPrompts('quill', 'txt', {name: 'a', mode: 'save'}).length, 0, 'Word warns on Save As, not on each Save');
});

test('file.print at the controls shows File > Print; with settings (or the bridge) it prints after approval', async () => {
  const {t, files} = await setup('quill');
  const shown = await t.exec('file.print');
  assert.deepEqual(shown.result, {shown: 'print'});
  assert.deepEqual(files.shown.at(-1).page, 'print');
  const approval = await expectApprovalRequired(t, 'file.print', {copies: 2});
  assert.match(approval.summary, /Print 2 copies of "Document1"/);
  await t.bridge('file.print', {copies: 2}, {approval: {nonce: approval.nonce}});
  assert.deepEqual(files.printed[0].opts, {copies: 2});
});

test('file.save_as (PDF id) is Save As; file.open_recent opens a recent path or shows File > Open', async () => {
  const disk = {'C:\\Docs\\Scan.pdf': {format: 'pdf', file: {kind: 'folio'}}};
  const {t, files} = await setup('folio', {disk, binding: {path: 'C:\\Docs\\Scan.pdf', format: 'pdf', name: 'Scan', savedHere: true}});
  files.script({path: 'C:\\Docs\\Scan signed.pdf', format: 'pdf'});
  const r = await t.exec('file.save_as');
  assert.equal(files.asked[0].mode, 'saveAs');
  assert.equal(files.asked[0].format, 'pdf');
  assert.equal(r.result.path, 'C:\\Docs\\Scan signed.pdf');
  assert.equal(files.binding(t.docId).path, 'C:\\Docs\\Scan signed.pdf');
  const shown = await t.exec('file.open_recent');
  assert.deepEqual(shown.result, {shown: 'open'});
  const listed = await t.bridge('file.open_recent');
  assert.deepEqual(listed.result.recent.map(x => x.path), ['C:\\Docs\\Scan signed.pdf']);
  const opened = await t.bridge('file.open_recent', {path: 'C:\\Docs\\Scan.pdf'});
  assert.equal(opened.result.name, 'Scan');
});

test('file.recover lists kept documents (or shows the page) and opens one; file.close_all is for the person only', async () => {
  const {t, files} = await setup('quill');
  files.unsaved = async () => [{doc: 'k1', kind: 'quill', name: 'Document3', path: null, updatedAt: '2026-10-29T12:00:00.000Z', reason: 'closed'}];
  assert.deepEqual((await t.exec('file.recover')).result, {shown: 'recover'});
  assert.deepEqual((await t.bridge('file.recover')).result.documents.map(d => d.name), ['Document3']);
  assert.deepEqual((await t.bridge('file.recover', {doc: 'k1'})).result, {doc: 'k1', recovered: true});
  assert.deepEqual((await t.exec('file.close_all')).result, {closing: true});
  const approval = await expectApprovalRequired(t, 'file.close_all');
  await assert.rejects(t.bridge('file.close_all', {}, {approval: {nonce: approval.nonce}}), e => e.code === 'unavailable' && /documents\.close/.test(e.message));
});
