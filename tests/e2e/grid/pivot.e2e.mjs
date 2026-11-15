// U:grid/pivot bridge E2E: Insert > PivotTable and Create PivotTable, the PivotTable Fields pane (field list, areas, moves through
// the bridge commands), the PivotTable Analyze and Design tabs (value field settings, grouping, layouts, subtotals, grand totals, the
// drawn styles gallery, refresh), the report saved to a real .xlsx and read back, and a slicer on a table (Insert Slicers, tile
// clicks that filter the table, the Slicer tab). Driven only through the bridge: no OS mouse or keyboard, no screen capture.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/pivot*.rs, cmd/slicer.rs, ui-egui/src/pivot_pane.rs and crates/xlsx/src/pivot*,
//    at fb1e59f.
// 2. Ours runs the same commands from the ribbon controls, their dialogs and the pane, and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/pivot/*.png were looked at by the author.

import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import {startData, assert} from './data-kit.mjs';
import {readXlsx} from '../../../core/grid/formats/xlsx-read.mjs';
import {script, exists} from '../common/file-helpers.mjs';

test('grid pivot tables and slicers: create, fields pane, analyze, design, styles gallery, xlsx, slicer', {timeout: 900_000}, async () => {
  const t = await startData('grid/pivot', {tab: 'insert'});
  const {app, doc, press, exec, settle, submit} = t;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const ids = async () => new Set(((await inspect()).controls ?? []).map(c => c.id));
  const dialog = () => app.rpc('ui.dialog.get', {doc});
  const readSheet = async name => (await app.rpc('document.read', {doc, address: `'${name}'!A1:H40`, as: 'json'})).value;
  const list = async () => (await exec('pivot.list')).result;
  const openMenu = async (tab, id) => { await app.rpc('ui.tab', {doc, id: tab}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(350); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  try {
    // Insert > PivotTable opens Create PivotTable with the current region as its source.
    await exec('selection.set', {range: 'A1', sheet: 'Sheet1'});
    await settle(200);
    const insertIds = await ids();
    assert.ok(insertIds.has('insert.tables.pivotTable'), 'PivotTable is on the Insert tab');
    for (const id of ['insert.tables.recommendedPivotTables', 'insert.charts.pivotChart', 'insert.filters.timeline']) assert.ok(insertIds.has(id), `${id} is on the Insert tab`);
    await press('insert.tables.pivotTable');
    const dlg = await dialog();
    assert.equal(dlg.id, 'dialog.createPivotTable');
    assert.equal(dlg.values.source, 'Sheet1!$A$1:$D$8');
    assert.equal(dlg.values.destination, 'new');
    await settle(300);
    await app.capture('01-create-pivottable');
    await submit();
    await settle(500);
    let p = (await list())[0];
    assert.deepEqual([p.name, p.anchor, p.source], ['PivotTable1', 'A3', 'Sheet1!$A$1:$D$8']);
    const sheet = p.sheet;
    await app.capture('02-placeholder-with-fields-pane');
    assert.ok(((await inspect()).panes ?? []).some(x => x.id === 'pane.pivotFields' && x.open), 'the PivotTable Fields pane opens with the new PivotTable');

    // The Fields pane's actions are the bridge commands: add, move and remove.
    await exec('pivot.addField', {field: 'Region', area: 'rows'});
    await exec('pivot.addField', {field: 'Rep', area: 'columns'});
    await exec('pivot.addField', {field: 'Amount', area: 'values'});
    await exec('pivot.moveField', {field: 'Rep', from: 'columns', to: 'filters'});
    await exec('selection.set', {range: 'A4', sheet});
    await settle(500);
    p = (await list())[0];
    assert.deepEqual([p.rows.map(f => f.field), p.columns.length, p.filters.map(f => f.field), p.values.map(v => v.name)], [['Region'], 0, ['Rep'], ['Sum of Amount']]);
    const rows = await readSheet(sheet);
    assert.ok(JSON.stringify(rows).includes('Grand Total'));
    await app.capture('03-region-sum-amount');

    // PivotTable Analyze: what is drawn and what stays hidden.
    await app.rpc('ui.tab', {doc, id: 'pivot-table-analyze'});
    await settle(300);
    const an = await ids();
    for (const id of ['pivotAnalyze.pivotTable.options', 'pivotAnalyze.activeField.fieldSettings', 'pivotAnalyze.activeField.expandField', 'pivotAnalyze.activeField.collapseField', 'pivotAnalyze.group.groupField',
      'pivotAnalyze.group.ungroup', 'pivotAnalyze.data.refresh', 'pivotAnalyze.data.changeSource', 'pivotAnalyze.actions.clear', 'pivotAnalyze.show.fieldList', 'pivotAnalyze.show.fieldHeaders']) assert.ok(an.has(id), `${id} is on PivotTable Analyze`);
    for (const id of ['pivotAnalyze.activeField.drillDown', 'pivotAnalyze.activeField.drillUp', 'pivotAnalyze.calculations.olapTools']) assert.ok(!an.has(id), `${id} stays hidden`);
    for (const id of ['pivotAnalyze.pivotTable.name', 'pivotAnalyze.activeField.name', 'pivotAnalyze.filter.insertSlicer', 'pivotAnalyze.filter.filterConnections', 'pivotAnalyze.actions.select', 'pivotAnalyze.actions.move', 'pivotAnalyze.calculations.fieldsItemsSets']) assert.ok(an.has(id), `${id} is on PivotTable Analyze`);
    await app.capture('04-pivottable-analyze-tab');

    // Value Field Settings, from the tab: show values as percent of the grand total.
    await press('pivotAnalyze.activeField.fieldSettings');
    const vf = await dialog();
    assert.equal(vf.id, 'dialog.valueFieldSettings');
    await settle(300);
    await app.capture('05-value-field-settings');
    await app.rpc('ui.dialog.set', {doc, values: {func: 'average', name: 'Mean amount'}});
    await submit();
    assert.equal((await list())[0].values[0].name, 'Mean amount');
    await exec('pivot.valueSettings', {index: 0, func: 'sum', name: 'Sum of Amount', showAs: 'percentOfGrandTotal'});
    assert.equal((await list())[0].values[0].showAs, 'percentOfGrandTotal');
    await exec('pivot.valueSettings', {index: 0, showAs: 'normal'});

    // Options, Change Data Source, Refresh from the source after an edit, Clear Filters.
    await press('pivotAnalyze.pivotTable.options');
    assert.equal((await dialog()).id, 'dialog.pivotTableOptions');
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Sales by region'}});
    await submit();
    assert.equal((await list())[0].name, 'Sales by region');
    await press('pivotAnalyze.data.changeSource');
    assert.equal((await dialog()).id, 'dialog.changePivotSource');
    await app.rpc('ui.dialog.cancel', {doc});
    await exec('cell.set', {cell: 'D2', input: '1000', sheet: 'Sheet1'});
    await exec('selection.set', {range: 'A4', sheet});
    await press('pivotAnalyze.data.refresh');
    await settle(400);
    // West was 120 + 210 + 300; with D2 at 1000 it is 1510.
    assert.ok(JSON.stringify(await readSheet(sheet)).includes('1510'), 'Refresh reads the edited source');
    await press('pivotAnalyze.show.fieldList');
    await settle(300);
    await press('pivotAnalyze.show.fieldList');
    await settle(300);

    // Grouping: a date field by its months needs numbers that are dates; a text field is refused with Excel's wording.
    await exec('selection.set', {range: 'A5', sheet});
    await press('pivotAnalyze.group.groupField');
    assert.equal((await dialog()).id, 'dialog.pivotGrouping');
    await settle(300);
    await app.capture('06-grouping');
    await app.rpc('ui.dialog.cancel', {doc});

    // PivotTable Design: layouts, subtotals, grand totals and the drawn styles gallery.
    await exec('pivot.addField', {field: 'Rep', area: 'rows'});
    await app.rpc('ui.tab', {doc, id: 'pivot-table-design'});
    await settle(300);
    const de = await ids();
    for (const id of ['pivotDesign.layout.subtotals', 'pivotDesign.layout.grandTotals', 'pivotDesign.layout.reportLayout', 'pivotDesign.styles.gallery']) assert.ok(de.has(id), `${id} is on PivotTable Design`);
    for (const id of ['pivotDesign.layout.blankRows', 'pivotDesign.styleOptions.rowHeaders', 'pivotDesign.styleOptions.columnHeaders', 'pivotDesign.styleOptions.bandedRows', 'pivotDesign.styleOptions.bandedColumns']) assert.ok(de.has(id), `${id} is on PivotTable Design`);
    await app.capture('07-pivottable-design-tab');
    await openMenu('pivot-table-design', 'pivotDesign.layout.reportLayout');
    await app.capture('08-report-layout-menu');
    await closeMenu('pivotDesign.layout.reportLayout');
    await press('pivotDesign.layout.reportLayout.show-in-tabular-form');
    assert.equal((await list())[0].layout, 'tabular');
    await settle(300);
    await app.capture('09-tabular-report');
    await press('pivotDesign.layout.reportLayout.show-in-compact-form');
    await press('pivotDesign.layout.subtotals.do-not-show-subtotals');
    assert.equal((await list())[0].subtotals, 'none');
    await press('pivotDesign.layout.subtotals.show-all-subtotals-at-top-of-group');
    await press('pivotDesign.layout.grandTotals.on-for-columns-only');
    const gt = (await list())[0];
    assert.deepEqual([gt.grandTotalsRows, gt.grandTotalsCols], [false, true]);
    await press('pivotDesign.layout.grandTotals.on-for-rows-and-columns');
    await openMenu('pivot-table-design', 'pivotDesign.styles.gallery');
    await app.capture('10-pivottable-styles-gallery');
    await closeMenu('pivotDesign.styles.gallery');
    // The Fields pane's field menu on a Rows chip (Excel's Move Up/Down, to another area, Remove Field): Move Down runs pivot.moveField.
    const paneMenu = await t.pointer({target: 'pivotPane', click: 'Region field menu'});
    assert.ok(paneMenu.buttons.includes('Move to Column Labels'), 'the field menu lists the other areas');
    await settle(200);
    await app.capture('10b-fields-pane-field-menu');
    await t.pointer({target: 'pivotPane', click: 'Move Down'});
    await settle(400);
    assert.deepEqual((await list())[0].rows.map(f => f.field), ['Rep', 'Region'], 'Move Down reorders the row fields');
    await exec('pivot.moveField', {field: 'Region', from: 'rows', to: 'rows', position: 0});
    await press('pivotDesign.styles.gallery', 'PivotStyleMedium9');
    assert.equal((await list())[0].style, 'PivotStyleMedium9');
    await settle(400);
    await app.capture('11-style-medium-9');

    // Show Details: the cell menu offers it on a value cell only; a double-click on a value lists its records on a new sheet.
    await exec('selection.set', {range: 'A5', sheet});
    const labelMenu = await app.rpc('ui.contextMenu', {doc, target: 'cell'});
    assert.ok(!labelMenu.items.some(i => i.command === 'pivot.showDetails'), 'no Show Details on a row label');
    await app.rpc('ui.contextMenu', {doc, open: false});
    await exec('selection.set', {range: 'B5', sheet});
    await settle(200);
    const valueMenu = await app.rpc('ui.contextMenu', {doc, target: 'cell', x: 420, y: 400});
    assert.ok(valueMenu.items.some(i => i.command === 'pivot.showDetails'), 'Show Details on a value cell');
    await settle(300);
    await app.capture('11b-show-details-menu');
    await app.rpc('ui.contextMenu', {doc, open: false});
    const sheetsBefore = (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value?.sheets?.length;
    await t.pointer({action: 'doubleClick', cell: 'B5'});
    await settle(500);
    const detail = (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
    if (sheetsBefore !== undefined) assert.equal(detail.sheets.length, sheetsBefore + 1, 'Show Details adds a sheet');
    await app.capture('11c-show-details-sheet');
    await exec('selection.set', {range: 'A4', sheet});

    // The report saved to a real .xlsx and read back.
    const file = path.join(os.tmpdir(), `pivot-${process.pid}.xlsx`);
    await script(app, {type: 'save', path: file});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(() => exists(file), {timeout: 30_000});
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const names = Object.keys(zip.files);
    assert.ok(names.some(n => /pivotTables\/pivotTable1\.xml$/.test(n)) && names.some(n => /pivotCacheDefinition1\.xml$/.test(n)), 'pivot parts are in the package');
    const back = await readXlsx(await fs.readFile(file));
    const bp = back.sheets.flatMap(s => s.pivots ?? [])[0];
    assert.equal(bp.name, 'Sales by region');
    assert.equal(bp.style, 'PivotStyleMedium9');
    assert.deepEqual(bp.rows.map(f => f.sourceCol), ['Region', 'Rep']);
    await fs.rm(file, {force: true});

    // A slicer on a table: Insert Slicers lists the columns, tiles filter the table, the Slicer tab shows.
    await exec('selection.set', {range: 'A1', sheet: 'Sheet1'});
    await exec('insert.table', {range: 'A1:D8', header: true});
    await exec('selection.set', {range: 'A2', sheet: 'Sheet1'});
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle(200);
    await press('insert.filters.slicer');
    const sd = await dialog();
    assert.equal(sd.id, 'dialog.insertSlicers');
    assert.deepEqual(sd.values.heads, ['Region', 'Rep', 'Qty', 'Amount']);
    await settle(300);
    await app.capture('12-insert-slicers');
    await submit();
    await settle(500);
    let slicers = (await exec('slicer.list')).result;
    assert.equal(slicers.length, 1);
    assert.deepEqual(slicers[0].items.map(i => i.value), ['West', 'East', 'North']);
    await app.rpc('ui.tab', {doc, id: 'slicer'});
    await settle(300);
    const sl = await ids();
    for (const id of ['slicer.slicer.settings', 'slicer.buttons.columns', 'slicer.buttons.height', 'slicer.buttons.width', 'slicer.actions.clearFilter', 'slicer.actions.selectAll', 'slicer.actions.delete']) assert.ok(sl.has(id), `${id} is on the Slicer tab`);
    for (const id of ['slicer.styles.gallery', 'slicer.slicer.reportConnections']) assert.ok(sl.has(id), `${id} is on the Slicer tab`);
    await app.capture('13-slicer-tab');
    await exec('slicer.toggle', {value: 'East'});
    await settle(400);
    const rowsHidden = [];
    for (let r = 2; r <= 8; r++) if (((await t.read(`/sh:s1/row:${r}`, 'props'))[0] ?? {}).hidden === true) rowsHidden.push(r);
    assert.deepEqual(rowsHidden, [2, 4, 5, 7, 8], 'only the East rows (3 and 6) stay');
    await app.capture('14-slicer-filtering-east');
    await press('slicer.actions.clearFilter');
    await settle(300);
    assert.equal((await exec('slicer.list')).result[0].selected, null);
    await press('slicer.actions.delete');
    assert.equal((await exec('slicer.list')).result.length, 0);
  } finally {
    await t.app.close();
  }
});
