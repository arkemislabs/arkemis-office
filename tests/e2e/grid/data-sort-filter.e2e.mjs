// U:grid/data bridge E2E (Sort and Filter): the Data tab's ribbon, Sort A to Z and the Sort dialog
// (levels), Filter with its drop-downs in the header cells (values, search, Number Filters and the
// Custom AutoFilter dialog), Clear, Reapply and Filter off, each undone.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/data.rs (controls and order), dialogs/data.rs (the
//    Sort dialog: levels with column, sort on, order), grid/menus.rs (the filter menu: sort, search,
//    Select All, the value check boxes), cmd/data/{sort,filter}.rs. Excel: Filter puts a drop-down in
//    each header cell, a filtered column shows a funnel and the row numbers turn blue, hidden rows
//    come back when the filter is cleared or turned off.
// 2. Ours runs the same commands from the ribbon, the drop-downs and the dialogs through the
//    surface's own handlers (ui.pointer targets filterButton and popup) and reads the document back.
// 3. This flow; captures in artifacts/e2e/grid/data-sort-filter/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid data: Sort and Filter from the ribbon, the dialogs and the header drop-downs', {timeout: 400_000}, async () => {
  const t = await startData('grid/data-sort-filter');
  const {app, doc, read, select, press, pointer, undo, submit, hiddenRows, settle} = t;
  try {
    await app.capture('01-data-tab');
    const ui = await app.rpc('ui.inspect', {doc});
    const shown = new Set(ui.controls.filter(c => !c.pending).map(c => c.id));
    for (const id of ['data.sortFilter.sortAscending', 'data.sortFilter.sortDescending', 'data.sortFilter.sort', 'data.sortFilter.filter', 'data.sortFilter.clear', 'data.sortFilter.reapply',
      'data.sortFilter.advanced', 'data.tools.textToColumns', 'data.tools.flashFill', 'data.tools.removeDuplicates', 'data.tools.dataValidation', 'data.tools.consolidate',
      'data.forecast.whatIf', 'data.outline.group', 'data.outline.ungroup', 'data.outline.subtotal', 'data.outline.showDetail', 'data.outline.hideDetail', 'data.outline.settings']) {
      assert.ok(shown.has(id), `${id} is on the Data tab`);
    }
    // Controls upstream does not implement are not shown.
    for (const id of ['data.dataTypes.stocks', 'data.tools.relationships', 'data.getTransform.fromWeb']) assert.ok(!shown.has(id), `${id} stays hidden`);

    // Sort A to Z from the ribbon: one column, the header stays put.
    await select('C3');
    await press('data.sortFilter.sortAscending');
    assert.deepEqual((await read('/sh:s1/C2:C8')).map(r => r[0]), [3, 4, 5, 7, 9, 9, 12]);
    assert.equal(await read('/sh:s1/A1'), 'Region');
    assert.equal(await read('/sh:s1/B2'), 'Eli', 'the whole row moved');
    await app.capture('02-sorted-qty');
    await undo();
    assert.equal(await read('/sh:s1/B2'), 'Ann');

    // The Sort dialog: two levels.
    await select('A2');
    await press('data.sortFilter.sort');
    await app.rpc('ui.dialog.set', {doc, values: {levels: [{column: 'A', by: 'values', order: 'asc'}, {column: 'C', by: 'values', order: 'desc'}]}});
    await settle();
    await app.capture('03-sort-dialog');
    await submit();
    assert.deepEqual((await read('/sh:s1/A2:C8')).map(r => `${r[0]}${r[2]}`), ['East9', 'East3', 'North12', 'North4', 'West9', 'West7', 'West5']);
    await undo();

    // Filter: buttons appear, a drop-down filters by values, the filtered column shows the funnel.
    await select('A1');
    await press('data.sortFilter.filter');
    assert.equal((await read('/sh:s1', 'props')).autofilter?.range, 'A1:D8');
    await settle();
    await app.capture('04-filter-buttons');
    const opened = await pointer({target: 'filterButton', cell: 'A1'});
    assert.equal(opened.filterMenu, true, 'the header button opens the drop-down');
    await settle();
    await app.capture('05-filter-menu');
    const menu = await pointer({target: 'popup', check: '(Select All)'});
    assert.ok(menu.values.every(v => !v.on), 'Select All off clears every box');
    await pointer({target: 'popup', check: 'West'});
    await pointer({target: 'popup', click: 'OK'});
    await settle();
    assert.deepEqual(await hiddenRows(2, 8), [3, 5, 6, 8], 'only the West rows stay');
    await app.capture('06-filtered-west');
    // The same menu: search narrows the list.
    await pointer({target: 'filterButton', cell: 'B1'});
    await pointer({target: 'popup', search: 'a'});
    await settle();
    await app.capture('07-filter-search');
    await pointer({target: 'popup', click: 'Cancel'});
    await press('data.sortFilter.clear');
    assert.deepEqual(await hiddenRows(2, 8), []);
    assert.ok((await read('/sh:s1', 'props')).autofilter, 'Clear keeps the drop-down buttons');

    // Number Filters: Greater Than... opens Custom AutoFilter.
    await pointer({target: 'filterButton', cell: 'C1'});
    await pointer({target: 'popup', click: 'Number Filters'});
    await settle();
    await app.capture('08-number-filters');
    await pointer({target: 'popup', click: 'Greater Than'});
    await settle();
    const cf = await app.rpc('ui.dialog.get', {doc});
    assert.equal(cf.id, 'dialog.customAutoFilter');
    assert.equal(cf.values.op1, '>');
    await app.rpc('ui.dialog.set', {doc, values: {val1: '8'}});
    await settle();
    await app.capture('09-custom-autofilter');
    await submit();
    assert.deepEqual(await hiddenRows(2, 8), [2, 4, 6, 8], 'only quantities over 8 stay (rows 3, 5, 7)');
    await app.capture('10-filtered-over-8');
    await undo();
    await press('data.sortFilter.reapply');
    await press('data.sortFilter.filter');
    assert.equal((await read('/sh:s1', 'props')).autofilter, undefined);
    assert.deepEqual(await hiddenRows(2, 8), []);
  } finally {
    await t.app.close();
  }
});
