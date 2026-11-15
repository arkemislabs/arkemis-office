// U:grid/chart-design bridge E2E: the Chart Design and Format tabs of a selected chart from the ribbon (Add Chart Element,
// Quick Layout, Change Colors, Chart Styles, Switch Row/Column, Select Data, Change Chart Type, Move Chart, Format Pane,
// Shape Fill, Size) and the Format tab of a shape. Driven only through the bridge: no OS mouse or keyboard, no screen capture.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/contextual.rs (`chart_design`), panes.rs (`format_chart`),
//    dialogs/charts.rs, crates/engine/src/cmd/extra/chart.rs, at fb1e59f.
// 2. Ours runs the same commands from the ribbon controls and reads the chart back.
// 3. This flow; captures in artifacts/e2e/grid/chart-design/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid chart design and format tabs: layouts, colors, styles, data, type, location, format pane, shape fill', {timeout: 500_000}, async () => {
  const t = await startData('grid/chart-design', {tab: 'home'});
  const {app, doc, select, press, exec, settle, submit} = t;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const chart = async () => ((await t.read('/sh:s1', 'props'))?.charts ?? [])[0] ?? null;
  const readChart = async () => (await app.rpc('document.read', {doc, address: '/sh:s1', as: 'json'})).value;
  const openMenu = async (tab, id) => { await app.rpc('ui.tab', {doc, id: tab}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(350); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  const charts = async () => (await exec('object.list')).result.filter(o => o.kind === 'chart');
  try {
    await select('A1', 'D8');
    const made = (await exec('insert.chart', {type: 'column', range: 'A1:D8', at: 'F5', title: 'Sales'})).result;
    await settle(400);
    await app.rpc('ui.tab', {doc, id: 'chart-design'});
    await settle(300);
    let ui = await inspect();
    assert.equal(ui.tab, 'chart-design');
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['chartDesign.layouts.addElement', 'chartDesign.layouts.quickLayout', 'chartDesign.styles.changeColors', 'chartDesign.styles.gallery', 'chartDesign.data.switchRowColumn', 'chartDesign.data.selectData',
      'chartDesign.type.changeChartType', 'chartDesign.location.moveChart', 'chartDesign.format.formatPane', 'chartDesign.format.chartTitle', 'chartDesign.format.deleteChart']) assert.ok(ids.has(id), `${id} is on Chart Design`);
    await app.capture('01-chart-design-tab');

    // Add Chart Element.
    await openMenu('chart-design', 'chartDesign.layouts.addElement');
    await app.capture('02-add-chart-element');
    await closeMenu('chartDesign.layouts.addElement');
    await press('chartDesign.layouts.addElement.legend-top');
    await press('chartDesign.layouts.addElement.data-labels-show');
    await press('chartDesign.layouts.addElement.axis-titles');
    let c = await readChart();
    assert.ok(JSON.stringify(c).includes('"legend":"top"'), 'the legend goes to the top');
    await settle(400);
    await app.capture('03-legend-top-labels-axis-titles');

    // Quick Layout, Change Colors, Chart Styles: drawn galleries.
    await openMenu('chart-design', 'chartDesign.layouts.quickLayout');
    await app.capture('04-quick-layout-gallery');
    await closeMenu('chartDesign.layouts.quickLayout');
    await press('chartDesign.layouts.quickLayout', 5);
    await settle(300);
    await openMenu('chart-design', 'chartDesign.styles.changeColors');
    await app.capture('05-change-colors-gallery');
    await closeMenu('chartDesign.styles.changeColors');
    await press('chartDesign.styles.changeColors', 'accent2');
    await settle(400);
    await app.capture('06-colors-accent2');
    await openMenu('chart-design', 'chartDesign.styles.gallery');
    await app.capture('07-chart-styles-gallery');
    await closeMenu('chartDesign.styles.gallery');
    await press('chartDesign.styles.gallery', 4);
    await settle(400);
    await app.capture('08-style-4');

    // Switch Row/Column, Change Chart Type.
    await press('chartDesign.data.switchRowColumn');
    await settle(300);
    await app.capture('09-switched');
    await press('chartDesign.type.changeChartType.line');
    await settle(400);
    await app.capture('10-line');
    await press('chartDesign.type.changeChartType.clustered-column');

    // Select Data: the range, the labels, a series dropped.
    await press('chartDesign.data.selectData');
    const sd = await app.rpc('ui.dialog.get', {doc});
    assert.equal(sd.id, 'dialog.selectData');
    assert.ok(sd.values.range.includes('A1:D8'));
    await settle(300);
    await app.capture('11-select-data');
    await app.rpc('ui.dialog.set', {doc, values: {remove: '3'}});
    await submit();
    await settle(300);
    assert.ok(!JSON.stringify(await readChart()).includes('"values":"Sheet1!$D'), 'the third series is gone');

    // Move Chart to Sheet2.
    await press('chartDesign.location.moveChart');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.moveChart');
    await settle(300);
    await app.capture('12-move-chart');
    await app.rpc('ui.dialog.set', {doc, values: {toSheet: 'Sheet2', at: 'D4'}});
    await submit();
    await settle(300);
    // The chart stays selected on its new sheet, which comes into view (as Excel does); Sheet1 has no chart left.
    assert.equal(await chart(), null, 'the chart left Sheet1');
    assert.equal((await charts()).length, 1, 'the selected chart is on the sheet in view (Sheet2)');
    await exec('sheet.activate', {sheet: 'Sheet1'});

    // Format Pane and the Format tab.
    await exec('sheet.activate', {sheet: 'Sheet2'});
    const moved = (await charts())[0];
    await exec('object.select', {kind: 'chart', id: moved.id});
    await settle(300);
    await app.rpc('ui.tab', {doc, id: 'chart-design'});
    await press('chartDesign.format.formatPane');
    await settle(600);
    await app.capture('13-format-pane');
    await press('chartDesign.format.formatPane');
    await settle(300);
    await app.rpc('ui.tab', {doc, id: 'format'});
    await settle(300);
    await app.capture('14-chart-format-tab');
    const fids = new Set(((await inspect()).controls ?? []).map(x => x.id));
    for (const id of ['chartFormat.selection.formatSelection', 'chartFormat.shapeStyles.fill', 'chartFormat.size.height', 'chartFormat.size.width']) assert.ok(fids.has(id), `${id} is on the Format tab`);
    for (const id of ['chartFormat.shapeStyles.effects', 'chartFormat.shapeStyles.outline', 'chartFormat.wordArt.gallery', 'chartFormat.arrange.align', 'chartFormat.arrange.group']) assert.ok(fids.has(id), `${id} is on the Format tab`);
    assert.ok(!fids.has('chartFormat.arrange.rotate'), 'a chart cannot rotate');

    // A shape's Format tab: fill, outline, size.
    await exec('insert.shape', {kind: 'ellipse', at: 'B12', width: 120, height: 70});
    await settle(400);
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(300);
    await press('shapeFormat.styles.fill', '#E8774E');
    await press('shapeFormat.styles.outline', '#2E6FD8');
    await press('shapeFormat.size.width', 200);
    await settle(400);
    await app.capture('15-shape-format');
    const shape = (await exec('object.list')).result.find(o => o.kind === 'shape');
    assert.ok(shape, 'the shape is listed');
  } finally {
    await t.app.close();
  }
});
