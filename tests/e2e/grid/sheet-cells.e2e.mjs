// U:grid/sheet bridge E2E: Home › Cells › Insert and Delete (rows, columns, the Insert and Delete
// dialogs), Insert Copied Cells, and the sheet commands of Cells › Format (Rename, Move or Copy,
// Tab Color, Hide, Unhide) plus Insert Sheet and switching sheets, each read back over the bridge.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/sheet.rs and cmd/sheet/tabs.rs, ui-egui dialogs.rs (Insert, Delete, Rename
//    Sheet, Move or Copy, Unhide); Excel's Home › Cells and the sheet tabs do the same.
// 2. Ours: the ribbon (ui.activate), KeyRouter (ui.key) and the dialogs (ui.dialog.*) run the same
//    commands; formulas follow the moved cells; the tabs show names, colours and hidden sheets.
// 3. This flow; captures in artifacts/e2e/grid/sheet-cells/*.png were looked at by the author.
//
// Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';

const NOW = '2026-10-30T09:00:00.000Z';

function seed() {
  const content = {
    sheets: [
      {id: 's1', name: 'Sheet1', blocks: {0: {
        A1: {v: 'Item'}, B1: {v: 'Qty'}, A2: {v: 'Apples'}, B2: {v: 3}, A3: {v: 'Pears'}, B3: {v: 5}, A4: {v: 'Plums'}, B4: {v: 7},
        A5: {v: 'Total'}, B5: {f: 'SUM(B2:B4)'},
      }}},
      {id: 's2', name: 'Summary', blocks: {0: {A1: {v: 'Total qty'}, B1: {f: 'Sheet1!B5'}}}},
    ],
    activeSheetId: 's1', styles: [{}], names: [],
  };
  return {id: 'grid-sheet', schema: 2, kind: 'grid', title: 'Sheet flow', revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [],
    content: validateContent(content)};
}

test('grid sheet: insert and delete lines and cells, Insert Copied Cells, and sheet tabs, with undo', {timeout: 300_000}, async () => {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'grid', flow: 'grid/sheet-cells', renderer, files: [seed()]});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = 'grid-sheet';
  const read = async (address, as = 'values') => (await app.rpc('document.read', {doc, address, as})).value;
  const content = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const settle = () => new Promise(r => setTimeout(r, 250));
  const select = async (anchor, focus = anchor, sheet = 's1') => {
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sh:${sheet}/${anchor}`, focus: `/sh:${sheet}/${focus}`}], primary: 0});
    await settle();
  };
  const press = async (control, value) => { await app.rpc('ui.activate', {doc, control, ...(value !== undefined ? {value} : {})}); await settle(); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await settle();
    await app.capture('01-opened');

    // Insert Sheet Rows above row 3 from the Insert menu: the total follows.
    await select('A3');
    await press('home.cells.insert.insert-sheet-rows');
    assert.equal(await read('/sh:s1/B6', 'formulas'), '=SUM(B2:B5)');
    await app.rpc('ui.type', {doc, text: 'Figs'});
    await app.rpc('ui.keys', {doc, key: 'Tab'});
    await app.rpc('ui.type', {doc, text: '4'});
    await app.rpc('ui.keys', {doc, key: 'Enter'});
    assert.equal(await read('/sh:s1/B6'), 19);
    await app.capture('02-row-inserted');

    // The Insert dialog (Insert Cells…): shift cells right at B2:B3.
    await select('B2', 'B3');
    await press('home.cells.insert');
    let d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.insertCells');
    assert.equal(d.values.shift, 'down');
    await app.rpc('ui.dialog.set', {doc, values: {shift: 'right'}});
    await settle();
    await app.capture('03-insert-dialog');
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal(await read('/sh:s1/C2'), 3);
    // The Delete dialog undoes it the Excel way: shift cells left.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.deleteCells'});
    await app.rpc('ui.dialog.set', {doc, values: {shift: 'left'}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal(await read('/sh:s1/B2'), 3);

    // Insert Copied Cells: copy row 2, insert it above row 5.
    await app.rpc('engine.execute', {doc, command: 'edit.copy', params: {range: '/sh:s1/rows:2-2'}});
    await select('A5');
    await app.rpc('engine.execute', {doc, command: 'home.insertCopiedCells', params: {}});
    await settle();
    assert.equal(await read('/sh:s1/A5'), 'Apples');
    assert.equal(await read('/sh:s1/B7', 'formulas'), '=SUM(B2:B6)');
    await app.capture('04-insert-copied-cells');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    await settle();
    assert.equal(await read('/sh:s1/A5'), 'Plums', 'one undo step');

    // Delete Sheet Columns from the Delete menu: the Summary formula follows to #REF!.
    await select('A1');
    await press('home.cells.delete.delete-sheet-columns');
    assert.equal(await read('/sh:s2/B1', 'formulas'), '=Sheet1!A6');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    await settle();

    // Sheet tabs: rename through the dialog, colour the tab, insert and move a sheet, hide and unhide.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.renameSheet'});
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Fruit'}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal(await read('/sh:s2/B1', 'formulas'), '=Fruit!B6');
    await app.rpc('engine.execute', {doc, command: 'sheet.tabColor', params: {color: '#C00000'}});
    await app.rpc('ui.key', {doc, keys: 'Shift+F11'});
    await settle();
    let c = await content();
    assert.deepEqual(c.sheets.map(x => x.name), ['Fruit', 'Sheet1', 'Summary']);
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.moveSheet'});
    await app.rpc('ui.dialog.set', {doc, values: {beforeSheet: '(move to end)', copy: false}});
    await settle();
    await app.capture('05-move-or-copy');
    await app.rpc('ui.dialog.submit', {doc});
    c = await content();
    assert.deepEqual(c.sheets.map(x => x.name), ['Fruit', 'Summary', 'Sheet1']);
    await app.rpc('engine.execute', {doc, command: 'sheet.hide', params: {sheet: 'Summary'}});
    await settle();
    await app.capture('06-tabs-renamed-coloured-hidden');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.unhideSheet'});
    d = await app.rpc('ui.dialog.get', {doc});
    assert.deepEqual(d.values.hiddenSheets, ['Summary']);
    await settle();
    await app.capture('07-unhide-dialog');
    await app.rpc('ui.dialog.submit', {doc});
    await settle();
    c = await content();
    assert.ok(!c.sheets[1].hidden, 'Summary is visible again');
    assert.equal((await app.rpc('selection.get', {doc})).selection.ranges[0].anchor.startsWith('/sh:s2/'), true, 'the unhidden sheet is shown');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+PageUp'});
    await settle();
    assert.equal((await app.rpc('selection.get', {doc})).selection.ranges[0].anchor.startsWith('/sh:s1/'), true, 'Ctrl+PageUp shows the previous sheet');
    await app.capture('08-final');
  } finally {
    await app.close();
  }
});
