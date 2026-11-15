// Grid (Excel): a workbook is a real .xlsx file; Save As CSV warns as Excel does and the workbook
// is then that CSV; Save a Copy leaves it on its file; closing with changes and Don't Save keeps the
// file as it was.
//   Book1 -> Ctrl+S -> Save As with "Excel Workbook (*.xlsx)" first -> Book1.xlsx on disk ->
//   F12 (Save As) -> CSV chosen -> "... may contain features that are not compatible with CSV
//   (Comma delimited). Do you want to keep the workbook in this format?" -> Yes -> the CSV on disk,
//   the window titled after it -> Save a Copy (bridge, with path) -> the copy exists, binding
//   unchanged -> a change -> close -> Don't Save -> the file on disk is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {asked, binding, documentsFolder, edit, exists, fileOf, press, run, savePrompt, script, show, start, windowOf} from './file-helpers.mjs';

test('grid: Book1 to .xlsx, Save As CSV with Excel\'s warning, Save a Copy keeps the binding, Don\'t Save on close', {timeout: 300_000}, async () => {
  const folder = await documentsFolder('grid');
  const seed = fileOf('grid', 'Budget', {sheets: [{id: 's1', name: 'Sheet 1', rows: 200, columns: 26,
    cells: {A1: {value: 'Item'}, B1: {value: 'Cost'}, A2: {value: 'Paper'}, B2: {value: '12.5', valueType: 'number'}}}], activeSheetId: 's1'});
  const app = await start('grid', 'file-grid', {files: [seed]});
  await run(async () => {
    // A blank workbook is Book1 and saves as an Excel Workbook.
    const made = await app.rpc('documents.create', {});
    assert.equal(made.name, 'Book1');
    await show(app, made.doc);
    const book1 = path.join(folder, 'Book1.xlsx');
    await script(app, {type: 'save', path: book1});
    await app.rpc('ui.key', {doc: made.doc, keys: 'Ctrl+S'});
    await app.until(() => exists(book1), {timeout: 30_000});
    const first = (await asked(app)).find(a => a.type === 'save');
    assert.equal(first.options.filters[0].name, 'Excel Workbook (*.xlsx)');
    assert.deepEqual(first.options.filters.map(f => f.extensions[0]), ['xlsx', 'csv', 'htm', 'pdf']);
    assert.equal(path.basename(first.options.defaultPath), 'Book1.xlsx');
    assert.equal((await fs.readFile(book1)).subarray(0, 2).toString(), 'PK');

    // The seeded workbook: F12 -> CSV -> Excel's warning -> Yes.
    const doc = seed.id;
    await show(app, doc);
    const csv = path.join(folder, 'Budget.csv');
    await script(app, {type: 'save', path: csv}, {type: 'message', response: 0});
    const key = await app.rpc('ui.key', {doc, keys: 'F12'});
    assert.equal(key.command, 'file.saveAs');
    await app.until(() => exists(csv), {timeout: 30_000});
    const log = await asked(app);
    assert.deepEqual(log.map(a => a.type), ['save', 'message']);
    assert.match(log[1].options.message, /Budget\.csv may contain features that are not compatible with CSV \(Comma delimited\)\. Do you want to keep the workbook in this format\?/);
    assert.deepEqual(log[1].options.buttons, ['Yes', 'No']);
    assert.match(await fs.readFile(csv, 'utf8'), /^Item,Cost\r?\nPaper,12\.5/);
    await app.until(async () => (await binding(app, doc))?.path === csv || null);
    assert.equal((await binding(app, doc)).format, 'csv');
    assert.equal((await windowOf(app, doc)).title, 'Budget - Grid');

    // Save a Copy (programmatic: a path, and the person's approval for a new file).
    const copy = path.join(folder, 'Budget copy.xlsx');
    let r;
    try { r = await app.rpc('engine.execute', {doc, command: 'file.saveCopy', params: {path: copy}}); } catch (e) {
      assert.equal(e.code, 'approval_required', e.message);
      r = await app.rpc('engine.execute', {doc, command: 'file.saveCopy', params: {path: copy}, approval: {nonce: e.data.nonce}});
    }
    assert.equal(r.result.copy, true);
    assert.ok(await exists(copy));
    assert.equal((await binding(app, doc)).path, csv, 'Save a Copy leaves the workbook on its file');

    // A change, close, Don't Save: the CSV is left as it was.
    const before = await fs.readFile(csv, 'utf8');
    const stamp = (await fs.stat(csv)).mtimeMs;
    await edit(app, doc);
    await app.rpc('test.window.close', {doc});
    const prompt = await savePrompt(app, doc);
    assert.match(JSON.stringify(prompt.values ?? {}), /Do you want to save the changes you made to “Budget”\?/);
    await press(app, doc, 'dont-save');
    await app.until(async () => !(await windowOf(app, doc)) || null, {timeout: 20_000});
    assert.equal(await fs.readFile(csv, 'utf8'), before);
    assert.equal((await fs.stat(csv)).mtimeMs, stamp);
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
