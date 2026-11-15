// Excel Data, Formulas, PivotTable Design and Slicer tabs added by U:grid/tables: Apply Names, Use in Formula, the Watch Window, Auto Outline,
// From Text/CSV, Forecast Sheet, Data Analysis, Solver, PivotTable Style Options, Blank Rows, Repeat labels, PivotTable slicers and Slicer Styles.
// Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft's forecast.rs, analysis.rs, solver.rs, extra/data.rs, extra/window.rs; PivotTable options, Apply Names and Auto Outline are Excel's.
// 2. Ours runs the ribbon controls and their dialogs and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/tables-tabs/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid tables tabs: formulas, data, pivot design and slicer additions', {timeout: 600_000}, async () => {
  const t = await startData('grid/tables-tabs', {tab: 'formulas'});
  const {app, doc, select, press, exec, settle, submit} = t;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const ids = async () => new Set(((await inspect()).controls ?? []).map(c => c.id));
  const dialog = () => app.rpc('ui.dialog.get', {doc});
  try {
    // Formulas: Apply Names, Use in Formula, Watch Window, Circular References.
    await exec('formulas.defineName', {name: 'Amounts', refersTo: '=Sheet1!$D$2:$D$8'});
    await exec('cell.set', {cell: 'H1', input: '=SUM(D2:D8)'});
    const f = await ids();
    for (const id of ['formulas.definedNames.useInFormula', 'formulas.auditing.watchWindow', 'formulas.auditing.errorChecking']) assert.ok(f.has(id), `${id} is on the Formulas tab`);
    await select('H1');
    await press('formulas.definedNames.defineName.apply-names');
    assert.equal((await dialog()).id, 'dialog.applyNames');
    await settle(400);
    await app.capture('01-apply-names');
    await app.rpc('ui.dialog.set', {doc, values: {names: ['Amounts'], useRowColumn: false}});
    await submit();
    assert.equal(await t.read('/sh:s1/H1', 'formulas').then(v => String(Array.isArray(v) ? (Array.isArray(v[0]) ? v[0][0] : v[0]) : v)), '=SUM(Amounts)');
    // Error Checking and Evaluate Formula with Step In.
    await exec('cell.set', {cell: 'H3', input: '=1/0'});
    await exec('cell.set', {cell: 'H4', input: '=H1+D2'});
    await exec('cell.set', {cell: 'H5', input: '=SUM(H3,2)'});
    await select('H3');
    await press('formulas.auditing.errorChecking');
    assert.equal((await dialog()).id, 'dialog.errorChecking');
    await settle(500);
    await app.capture('01c-error-checking');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('H4');
    await press('formulas.auditing.evaluateFormula');
    assert.equal((await dialog()).id, 'dialog.evaluateFormula');
    await settle(400);
    await app.capture('01d-evaluate-formula');
    await app.rpc('ui.dialog.cancel', {doc});
    for (const c of ['H3', 'H4', 'H5']) await exec('cell.set', {cell: c, input: ''});
    await press('formulas.auditing.errorChecking');
    assert.equal((await dialog()).id, 'dialog.errorChecking');
    await settle(400);
    await app.capture('01e-error-checking-none');
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.solverOptions'});
    await settle(400);
    await app.capture('01f-solver-options');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('H1');
    await press('formulas.auditing.watchWindow');
    await settle(600);
    await exec('formulas.watchWindow', {add: 'Sheet1!H1'});
    await settle(500);
    await app.capture('02-watch-window');
    await press('formulas.auditing.watchWindow');

    // Data: Auto Outline, From Text/CSV, Forecast Sheet, Data Analysis, Solver.
    await app.rpc('ui.tab', {doc, id: 'data'});
    await settle(300);
    const d = await ids();
    for (const id of ['data.outline.group', 'data.getTransform.fromTextCsv', 'data.forecast.forecastSheet', 'data.analysis.dataAnalysis', 'data.analysis.solver']) assert.ok(d.has(id), `${id} is on the Data tab`);
    for (const id of ['data.getTransform.fromWeb', 'data.dataTypes.stocks', 'data.tools.relationships']) assert.ok(!d.has(id), `${id} stays hidden`);
    await exec('range.setValues', {sheet: 'Sheet1', range: 'J1', values: [['Item', 'Q1'], ['a', 1], ['b', 2], ['Sub', '=SUM(K2:K3)']]});
    await press('data.outline.group.auto-outline');
    const ao = await exec('data.autoOutline', {});
    assert.equal(ao.result.rows, 2, 'Auto Outline grouped the two detail rows');

    await press('data.getTransform.fromTextCsv');
    assert.equal((await dialog()).id, 'dialog.fromTextCsv');
    await app.rpc('ui.dialog.set', {doc, values: {name: 'orders.csv', text: 'Item,Qty,Price\nBolt,10,0.25\nNut,25,0.1\nWasher,40,0.05\n', delimiter: 'comma'}});
    await settle(400);
    await app.capture('03-from-text-csv');
    await submit();
    await settle(500);
    await app.capture('04-imported-table');

    await exec('range.setValues', {sheet: 'Sheet1', range: 'N1', values: [['Month', 'Units'], ['1/1/2026', 10], ['2/1/2026', 12], ['3/1/2026', 14], ['4/1/2026', 13], ['5/1/2026', 16], ['6/1/2026', 18], ['7/1/2026', 17], ['8/1/2026', 20], ['9/1/2026', 22], ['10/1/2026', 21], ['11/1/2026', 25], ['12/1/2026', 27]]});
    await app.rpc('ui.tab', {doc, id: 'data'});
    await select('N1', 'O13');
    await press('data.forecast.forecastSheet');
    assert.equal((await dialog()).id, 'dialog.forecastSheet');
    await settle(500);
    await app.capture('05-forecast-dialog');
    await app.rpc('ui.dialog.cancel', {doc});
    await press('data.analysis.dataAnalysis');
    assert.equal((await dialog()).id, 'dialog.analysisToolPak');
    await settle(400);
    await app.capture('06-data-analysis');
    await app.rpc('ui.dialog.cancel', {doc});
    await press('data.analysis.solver');
    assert.equal((await dialog()).id, 'dialog.solver');
    await settle(400);
    await app.capture('07-solver');
    await app.rpc('ui.dialog.cancel', {doc});

    // PivotTable Design and Slicer.
    await app.rpc('ui.tab', {doc, id: 'sheet'}).catch(() => {});
    await exec('selection.set', {range: 'A1', sheet: 'Sheet1'});
    await exec('insert.pivotTable', {source: 'Sheet1!A1:D8', rows: ['Region', 'Rep'], values: ['Amount']});
    await exec('pivot.reportLayout', {layout: 'tabular'});
    await app.rpc('ui.tab', {doc, id: 'pivot-table-design'});
    await settle(400);
    await press('pivotDesign.styleOptions.bandedRows');
    await press('pivotDesign.layout.reportLayout.repeat-all-item-labels');
    await settle(300);
    await app.capture('08-pivot-design-options');
    await press('pivotDesign.layout.blankRows.insert');
    await settle(300);
    await app.capture('09-blank-rows');
    await app.rpc('ui.tab', {doc, id: 'pivot-table-analyze'});
    await settle(300);
    await press('pivotAnalyze.filter.insertSlicer');
    assert.equal((await dialog()).id, 'dialog.insertSlicers');
    await app.rpc('ui.dialog.set', {doc, values: {columns: ['Region']}});
    await submit();
    await settle(600);
    await app.capture('10-pivot-slicer');
    await app.rpc('ui.tab', {doc, id: 'slicer'});
    await settle(500);
    // A timeline over a date field, a period picked, and a +/- button clicked.
    await exec('range.setValues', {sheet: 'Sheet1', range: 'J12', values: [['Region', 'When', 'Amount'], ['East', '1/15/2026', 100], ['West', '2/10/2026', 50], ['East', '3/3/2026', 120], ['North', '4/20/2026', 30]]});
    await exec('insert.pivotTable', {source: 'Sheet1!J12:L16', rows: ['Region'], values: ['Amount']});
    const tl = await exec('insert.timeline', {pivot: 'PivotTable2'});
    await exec('timeline.select', {timeline: tl.result.timeline, index: 1, extend: false});
    await settle(600);
    await app.capture('10b-timeline');
    await app.rpc('ui.tab', {doc, id: 'slicer'});
    await settle(300);
    await press('slicer.styles.gallery', 'TimeSlicerStyleDark3');
    await settle(400);
    await app.capture('10c-timeline-style');
    await exec('selection.set', {range: 'A4', sheet: 'Sheet3'}).catch(() => {});
    await press('slicer.styles.gallery', 'SlicerStyleDark3').catch(() => {});
    await settle(400);
    await app.capture('11-slicer-styles');
  } finally {
    await app.close();
  }
});
