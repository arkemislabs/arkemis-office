// U:grid/data bridge E2E (Outline and What-If): Group with the outline bars, level buttons and the -
// button, Subtotal, Consolidate, the Scenario Manager, Goal Seek (with Excel's status), Data Table and
// Advanced Filter, each undone where it changes the sheet.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/outline.rs (the bands: a lane per level, brackets, - / +
//    buttons on the summary lines, level buttons), cmd/data/grouping.rs, cmd/whatif*.rs and
//    ribbon/data.rs. Excel: Group draws brackets with - / + buttons and level buttons 1, 2; Subtotal
//    inserts SUBTOTAL rows and a grand total; Goal Seek shows a status where Cancel keeps the sheet.
// 2. Ours runs the same commands from the ribbon, the outline buttons (ui.pointer target outline) and
//    the dialogs, and reads the document back.
// 3. This flow; captures in artifacts/e2e/grid/data-outline-whatif/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid data: Group, Subtotal, Consolidate and the What-If tools from the ribbon and the dialogs', {timeout: 400_000}, async () => {
  const t = await startData('grid/data-outline-whatif');
  const {app, doc, read, select, press, pointer, undo, submit, exec, box, hiddenRows, settle} = t;
  const rowInfo = async i => ((await read('/sh:s1', 'props')).rows ?? {})[i] ?? {};
  try {
    // Group: the outline bars with brackets, level buttons and the - / + button.
    await select('A3', 'A5');
    await press('data.outline.group');
    assert.equal((await rowInfo(2)).outline, 1, 'Group puts the rows one level deep');
    await settle();
    await app.capture('01-grouped');
    await pointer({target: 'outline', axis: 'rows', start: 3});
    await settle();
    assert.deepEqual(await hiddenRows(2, 8), [3, 4, 5], 'the - button hides the detail');
    await app.capture('02-collapsed');
    await pointer({target: 'outline', axis: 'rows', start: 3});
    assert.deepEqual(await hiddenRows(2, 8), []);
    await pointer({target: 'outline', axis: 'rows', level: 1});
    assert.deepEqual(await hiddenRows(2, 8), [3, 4, 5], 'level button 1 shows only the summaries');
    await pointer({target: 'outline', axis: 'rows', level: 2});
    await exec('data.ungroup', {rows: '3:5'});
    assert.equal((await rowInfo(2)).outline ?? 0, 0);
    assert.deepEqual(await hiddenRows(2, 8), []);

    // Subtotal: a total under each region, a grand total, grouped.
    await exec('data.sort', {range: 'A1:D8', header: true, keys: [{column: 'A'}]});
    await select('A2');
    await press('data.outline.subtotal');
    await app.rpc('ui.dialog.set', {doc, values: {groupBy: 'A', function: 'sum', columns: ['C', 'D']}});
    await settle();
    await app.capture('03-subtotal-dialog');
    await submit();
    assert.equal(await read('/sh:s1/A4'), 'East Total');
    assert.equal(await read('/sh:s1/D4'), 430);
    await settle();
    await app.capture('04-subtotal-outline');
    await pointer({target: 'outline', axis: 'rows', level: 1});
    await settle();
    await app.capture('05-subtotal-level-1');
    await undo();
    await undo();

    // Consolidate across sheets.
    await select('H1');
    await press('data.tools.consolidate');
    await app.rpc('ui.dialog.set', {doc, values: {function: 'sum', references: ['Sheet2!A1:B2'], leftColumn: true, destination: 'H1'}});
    await settle();
    await app.capture('06-consolidate');
    await submit();
    assert.deepEqual(await read('/sh:s1/H1:I2'), [['West', 10], ['East', 20]]);
    await undo();

    // What-If: Scenario Manager, Add Scenario, Goal Seek (with its status), Data Table, Advanced Filter.
    await exec('cell.set', {cell: '/sh:s1/E2', input: '=C2*D2'});
    await exec('data.scenarioAdd', {name: 'Base', changing: 'C2:D2'});
    await exec('data.scenarioAdd', {name: 'Big', changing: 'C2:D2', values: [50, 200], comment: 'a large order'});
    await select('E2');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.scenarioManager'});
    await settle();
    await app.capture('07-scenario-manager');
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.addScenario'});
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Third', changing: 'C2:D2'}});
    await settle();
    await app.capture('08-add-scenario');
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.goalSeek'});
    await app.rpc('ui.dialog.set', {doc, values: {set: 'E2', to: '1200', changing: 'C2'}});
    await settle();
    await app.capture('09-goal-seek');
    const seeking = submit();
    await settle(500);
    await app.capture('10-goal-seek-status');
    await box('OK');
    await seeking;
    assert.ok(Math.abs((await read('/sh:s1/E2')) - 1200) < 0.01, 'Goal Seek wrote the answer');
    await exec('edit.undo', {});
    await exec('range.setValues', {range: 'K2', values: [[1], [2], [3]]});
    await exec('cell.set', {cell: '/sh:s1/L1', input: '=C2*2'});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.dataTable'});
    await app.rpc('ui.dialog.set', {doc, values: {range: 'K1:L4', columnInput: 'C2'}});
    await settle();
    await app.capture('11-data-table');
    await submit();
    assert.deepEqual((await read('/sh:s1/L2:L4')).map(r => r[0]), [2, 4, 6], 'the table fills the results');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.advancedFilter'});
    await app.rpc('ui.dialog.set', {doc, values: {range: 'A1:D8', action: 'copy', copyTo: 'N1', unique: true}});
    await settle();
    await app.capture('12-advanced-filter');
    await submit();
    assert.equal(await read('/sh:s1/N1'), 'Region');
  } finally {
    await t.app.close();
  }
});
