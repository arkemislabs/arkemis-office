// U:grid/data bridge E2E (Data Tools): Remove Duplicates (the column list and Excel's message), the Text
// to Columns wizard, and Data Validation (the dialog, the input message, the in-cell list, the Stop
// alert and Circle Invalid Data), each undone.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/dialogs.rs (Remove Duplicates, Text to Columns),
//    dialogs/data.rs (Data Validation), grid/editor.rs (`validation_arrow`, `list_picker`),
//    app/editing.rs (a Stop validation refuses the entry and keeps the editor), cmd/data/{tools,
//    validation}.rs. Excel: Remove Duplicates reports how many it removed, the wizard has three
//    steps, a list validation shows an arrow beside the active cell and its input message.
// 2. Ours runs the same commands from the ribbon and the dialogs, and the surface's own handlers
//    for the list arrow, the popup and the alert (ui.pointer targets validationArrow, popup,
//    messageBox), and reads the document back.
// 3. This flow; captures in artifacts/e2e/grid/data-tools/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid data: Remove Duplicates, Text to Columns and Data Validation from the ribbon and the worksheet', {timeout: 400_000}, async () => {
  const t = await startData('grid/data-tools');
  const {app, doc, read, select, press, pointer, undo, submit, exec, box, settle} = t;
  try {
    // Remove Duplicates: a column list, and the message Excel shows about what it did.
    await select('A1', 'D8');
    await press('data.tools.removeDuplicates');
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.removeDuplicates');
    assert.deepEqual(dlg.values.columns, ['A', 'B', 'C', 'D']);
    await app.rpc('ui.dialog.set', {doc, values: {columns: ['A']}});
    await settle();
    await app.capture('01-remove-duplicates');
    const pending = submit();
    await settle(400);
    await app.capture('02-duplicates-message');
    await box('OK');
    await pending;
    assert.deepEqual((await read('/sh:s1/A2:A8')).map(r => r[0]), ['West', 'East', 'North', null, null, null, null], 'the first of each region stays, the rows move up');
    await undo();
    assert.equal(await read('/sh:s1/A8'), 'North');

    // Text to Columns: the wizard's three steps.
    await select('F1', 'F3');
    await press('data.tools.textToColumns');
    await app.capture('03-wizard-step1');
    await app.rpc('ui.dialog.set', {doc, values: {step: 2, tab: false, comma: true}});
    await settle();
    await app.capture('04-wizard-step2');
    await app.rpc('ui.dialog.set', {doc, values: {step: 3, formats: ['general', 'text'], column: 1}});
    await settle();
    await app.capture('05-wizard-step3');
    await submit();
    assert.deepEqual(await read('/sh:s1/F1:G3'), [['Name', ' Role'], ['Ada', ' Engineer'], ['Alan', ' Mathematician']]);
    await undo();
    assert.equal(await read('/sh:s1/F1'), 'Name, Role');

    // Data Validation: a list with an input message and a Stop alert; the in-cell list; Circle Invalid Data.
    await select('B2', 'B8');
    await press('data.tools.dataValidation');
    await app.rpc('ui.dialog.set', {doc, values: {type: 'list', formula1: 'Ann,Bo,Cy,Di,Eli,Fay,Gus', inputTitle: 'Rep', inputMessage: 'Pick a rep from the list.', errorTitle: 'Not a rep', errorMessage: 'Choose a rep from the list.'}});
    await settle();
    await app.capture('06-validation-settings');
    await submit();
    assert.equal((await read('/sh:s1', 'props')).validations?.length, 1);
    await select('B3');
    await settle();
    await app.capture('07-validation-input-message');
    const arrow = await pointer({target: 'validationArrow'});
    assert.equal(arrow.listPicker, true, 'the arrow opens the list');
    await settle();
    await app.capture('08-validation-list');
    await pointer({target: 'popup', click: 'Di'});
    await settle();
    assert.equal(await read('/sh:s1/B3'), 'Di', 'picking an item types it');
    await app.rpc('ui.type', {doc, text: 'Zed'});
    await app.rpc('ui.keys', {doc, key: 'Enter'});
    await settle(500);
    await app.capture('09-validation-stop-alert');
    await box('Retry');
    await app.rpc('ui.keys', {doc, key: 'Escape'});
    await settle();
    assert.equal(await read('/sh:s1/B3'), 'Di', 'Stop refuses the entry');
    await exec('cell.set', {cell: '/sh:s1/B5', input: 'Nobody'});
    await select('B2');
    await press('data.tools.dataValidation.circle-invalid-data');
    await settle();
    await app.capture('10-circle-invalid');
    await press('data.tools.dataValidation.clear-validation-circles');
    await exec('data.validation', {range: 'B2:B8', clear: true});
    assert.equal((await read('/sh:s1', 'props')).validations?.length ?? 0, 0);
  } finally {
    await t.app.close();
  }
});
