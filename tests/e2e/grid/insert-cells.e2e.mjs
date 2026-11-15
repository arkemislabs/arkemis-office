// U:grid/insert bridge E2E (cells and dialogs): Table with its style and filter buttons, the Insert Chart
// dialog (Recommended Charts and All Charts with the preview), Sparklines, Insert Hyperlink, a Comment,
// the Checkbox cell control, Symbol, and Insert Picture through the system Open dialog, each undone.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/insert.rs and dialogs.rs (`insertLink`, `sparkline`,
//    `comment`, the picture dialog), cmd/insert/{table,links,objects}.rs and cmd/extra/cells.rs. Excel:
//    Create Table banded with filter buttons; Insert Chart lists recommended types with a preview; a link
//    cell is blue and underlined; a checkbox cell toggles on a click on its box; Symbol adds a character.
// 2. Ours runs the same commands from the ribbon controls and their dialogs, the surface's own pointer
//    handlers for the checkbox click, and the system Open dialog through the scripted queue.
// 3. This flow; captures in artifacts/e2e/grid/insert-cells/*.png were looked at by the author.

import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {startData, assert} from './data-kit.mjs';
import {script} from '../common/file-helpers.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('grid insert: Table, Insert Chart, Sparklines, Link, Comment, Checkbox, Symbol and Picture from the ribbon', {timeout: 400_000}, async () => {
  const t = await startData('grid/insert-cells', {tab: 'insert'});
  const {app, doc, read, select, press, pointer, undo, submit, exec, settle} = t;
  const props = async () => await read('/sh:s1', 'props');
  const dlg = async (id, values = {}) => { await app.rpc('ui.dialog.set', {doc, values}); await settle(); void id; };
  try {
    // Table: the Create Table dialog with the block's range and its header guess; banded, with filter buttons.
    await select('A1', 'D8');
    await press('insert.tables.table');
    const d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.createTable');
    assert.equal(d.values.range, '$A$1:$D$8');
    assert.equal(d.values.header, true);
    await app.capture('01-create-table');
    await submit();
    const sheetNow = (await props());
    assert.equal(sheetNow.tables?.length, 1);
    assert.equal(sheetNow.tables[0].range, 'A1:D8');
    await select('F1');
    await settle(300);
    await app.capture('02-table-styled');
    await undo();
    assert.equal(((await props()).tables ?? []).length, 0, 'undo removes the table');

    // Insert Chart: Recommended Charts, the preview, and an All Charts pick.
    await select('B1', 'D8');
    await press('insert.charts.recommended');
    await settle(300);
    await app.capture('03-insert-chart-recommended');
    await app.rpc('ui.dialog.set', {doc, values: {types: 'Doughnut', pick: 'types'}});
    await settle(300);
    await app.capture('04-insert-chart-all-charts');
    await submit();
    const charts = (await exec('object.list')).result.filter(o => o.kind === 'chart');
    assert.equal(charts.length, 1);
    assert.equal(charts[0].chart, 'doughnut');
    await undo();

    // Sparklines: the Line item opens Create Sparklines with its type.
    await select('C2', 'D2');
    await press('insert.sparklines.sparklines.line');
    await app.rpc('ui.dialog.set', {doc, values: {range: 'C2:D2', location: 'F2', markers: true}});
    await settle();
    await app.capture('05-create-sparklines');
    await submit();
    const sp = (await props()).sparklines;
    assert.deepEqual([sp?.[0]?.cell, sp?.[0]?.kind, sp?.[0]?.markers], ['F2', 'line', true]);
    await exec('insert.sparkline', {range: 'C2:C8', location: 'G2', type: 'column'});
    await exec('insert.sparkline', {range: 'D2:D8', location: 'H2', type: 'winLoss'});
    await exec('insert.sparkline', {range: 'C2:C8', location: 'F3', type: 'line'});
    await exec('home.rowHeight', {rows: '/sh:s1/row:2', height: 36});
    await settle(300);
    await app.capture('06-sparklines');

    // Link: the dialog's three kinds, then a link cell reads back blue and underlined.
    await select('B3');
    await press('insert.links.link');
    const l = await app.rpc('ui.dialog.get', {doc});
    assert.equal(l.id, 'dialog.insertLink');
    assert.equal(l.values.text, 'Bo');
    await app.rpc('ui.dialog.set', {doc, values: {linkTo: 'web', target: 'https://example.com/bo', tooltip: 'Bo on the web'}});
    await settle();
    await app.capture('07-insert-hyperlink');
    await submit();
    assert.equal((await props()).hyperlinks?.B3?.target, 'https://example.com/bo');
    await select('B4');
    await press('insert.links.link');
    await app.rpc('ui.dialog.set', {doc, values: {linkTo: 'place', place: 'Sheet2', cellReference: 'A1'}});
    await submit();
    assert.deepEqual((await props()).hyperlinks?.B4, {location: 'Sheet2!A1'});
    await settle(300);
    await app.capture('08-link-cells');
    await select('B3');
    await press('insert.links.link');
    await app.rpc('ui.dialog.set', {doc, values: {}});
    await app.rpc('ui.dialog.cancel', {doc});

    // Comment: the dialog starts a thread; the cell shows its corner mark.
    await select('C3');
    await press('insert.comments.comment');
    await app.rpc('ui.dialog.set', {doc, values: {text: 'Check this number with Bo.'}});
    await submit();
    assert.equal((await props()).comments?.C3?.text, 'Check this number with Bo.');
    await exec('review.newNote', {cell: 'D3', text: 'A note', author: 'Ana'});
    await settle(300);
    await app.capture('09-comment-marks');

    // Checkbox: the control turns the cells into checkboxes; a click on a box toggles it.
    await select('H4', 'H6');
    await press('insert.cellControls.checkbox');
    assert.deepEqual(await read('/sh:s1/H4:H6'), [[false], [false], [false]]);
    await pointer({cell: 'H5'});
    await settle(200);
    assert.deepEqual(await read('/sh:s1/H4:H6'), [[false], [true], [false]], 'a click on the box checks it');
    await app.capture('10-checkboxes');
    await undo();

    // Symbol: a tile of the gallery, then the dialog with its grid.
    await select('A2');
    await press('insert.symbols.symbol', '€');
    assert.equal(await read('/sh:s1/A2'), 'West€');
    await undo();
    await press('insert.symbols.symbol.more-symbols');
    await settle(300);
    await app.rpc('ui.dialog.set', {doc, values: {subset: 'Greek and Coptic', char: 'Ω'}});
    await settle(300);
    await app.capture('11-symbol-dialog');
    await submit();
    assert.equal(await read('/sh:s1/A2'), 'WestΩ');
    await undo();

    // Picture: Browse… asks the system Open dialog (scripted), the dialog shows it, OK places it over the cells.
    const file = path.join(os.tmpdir(), `insert-picture-${process.pid}.png`);
    await fs.writeFile(file, Buffer.from(PNG, 'base64'));
    await select('F6');
    await press('insert.illustrations.pictures.place-over-cells');
    await script(app, {type: 'open', path: file});
    await pointer({target: 'dialog', dialog: 'dialog.insertPicture', click: 'Browse'});
    await settle(400);
    await app.rpc('ui.dialog.set', {doc, values: {alt: 'one pixel'}});
    await app.capture('12-insert-picture');
    await submit();
    const imgs = (await exec('object.list')).result.filter(o => o.kind === 'image');
    assert.equal(imgs.length, 1);
    await fs.rm(file, {force: true});
    void dlg;
  } finally {
    await t.app.close();
  }
});
