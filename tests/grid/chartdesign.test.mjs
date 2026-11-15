// U:grid/chart-design: Add Chart Element, Quick Layout, Change Colors, Chart Styles, Select Data, Move Chart, Format
// Selection, Shape Fill and Shape Outline, and the Size boxes of the Format tabs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/extra/chart.rs (`add_element`, `quick_layout`, `change_colors`,
//    `select_data`, `move_chart`, `format_series`) and extra/objects.rs (`shape_fill`, `shape_outline`) at fb1e59f:
//    the title, legend, data label, gridline and axis title elements, the six layouts, the palettes, a new data range
//    rebuilding the series, the last series staying, a chart moving to another sheet and cell.
// 2. Ours: the same commands over our chart model (core/grid/lib/chart-*.mjs); the sixteen styles are palettes with
//    their gridlines and labels, drawn in the gallery (gridcraft only stores the number).
// 3. These tests; tests/e2e/grid/chart-design.e2e.mjs drives the ribbon and takes the captures.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {resolveChart} from '../../core/grid/lib/chart-resolve.mjs';
import {STYLES, QUICK_LAYOUTS, paletteColor} from '../../core/grid/lib/chart-styles.mjs';

const blocks = {0: {A1: {v: 'Region'}, B1: {v: 'Qty'}, C1: {v: 'Amount'}, A2: {v: 'West'}, B2: {v: 5}, C2: {v: 120}, A3: {v: 'East'}, B3: {v: 9}, C3: {v: 340}, A4: {v: 'North'}, B4: {v: 12}, C4: {v: 480}}};
const data = () => workbook([{id: 's1', name: 'Sheet1', blocks}, {id: 's2', name: 'Two', blocks: {}}]);
const chartOf = (t, i = 0) => t.content.sheets[i].charts?.[0];
async function withChart() {
  const t = await session(data());
  await run(t, 'insert.chart', {type: 'column', range: 'A1:C4', title: 'Sales'});
  return t;
}

test('add chart element: title, legend position, data labels, gridlines, axis titles, smooth lines', async () => {
  const t = await withChart();
  await run(t, 'chart.addElement', {element: 'title', on: false});
  assert.equal(chartOf(t).title, '');
  await run(t, 'chart.addElement', {element: 'title'});
  assert.equal(chartOf(t).title, 'Chart Title', 'a hidden title comes back as Chart Title');
  await run(t, 'chart.set', {title: 'Sales'});
  await run(t, 'chart.addElement', {element: 'title', on: false});
  await run(t, 'chart.addElement', {element: 'title'});
  assert.equal(chartOf(t).title, 'Chart Title');
  for (const [position, want] of [['top', 'top'], ['left', 'left'], ['right', 'right'], [undefined, 'bottom']]) {
    await run(t, 'chart.addElement', {element: 'legend', ...(position ? {position} : {})});
    assert.equal(chartOf(t).legend, want);
  }
  await run(t, 'chart.addElement', {element: 'legend', on: false});
  assert.equal(chartOf(t).legend, 'none');
  await run(t, 'chart.addElement', {element: 'dataLabels'});
  assert.equal(chartOf(t).dataLabels, true);
  await run(t, 'chart.addElement', {element: 'gridlines', on: false});
  assert.equal(chartOf(t).gridlines, false);
  await run(t, 'chart.addElement', {element: 'axisTitles'});
  assert.deepEqual([chartOf(t).xTitle, chartOf(t).yTitle], ['Axis Title', 'Axis Title']);
  await run(t, 'chart.set', {xTitle: 'Region'});
  await run(t, 'chart.addElement', {element: 'axisTitles'});
  assert.equal(chartOf(t).xTitle, 'Region', 'an axis title that is there stays');
  await run(t, 'chart.addElement', {element: 'axisTitles', on: false});
  assert.deepEqual([chartOf(t).xTitle, chartOf(t).yTitle], [undefined, undefined]);
  await run(t, 'chart.addElement', {element: 'smooth'});
  assert.ok(chartOf(t).series.every(x => x.smooth === true));
  await fails(t, 'chart.addElement', {element: 'lines', type: 'highLow'});
  await expectUndoRoundTrip(t, 'chart.addElement', {element: 'dataLabels', on: false}, () => {});
});

test('quick layout 1 to 6 sets the legend, data labels, gridlines and axis titles together', async () => {
  const t = await withChart();
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await run(t, 'chart.quickLayout', {layout: n});
    const [legend, labels, grid, axes] = QUICK_LAYOUTS[n];
    const c = chartOf(t);
    assert.deepEqual([c.legend, c.dataLabels, c.gridlines, !!c.xTitle && !!c.yTitle], [legend, labels, grid, axes], `layout ${n}`);
  }
  await fails(t, 'chart.quickLayout', {layout: 7});
  const tiles = t.state('chart.quickLayout').value;
  assert.deepEqual(tiles.map(x => x.label), ['Layout 1', 'Layout 2', 'Layout 3', 'Layout 4', 'Layout 5', 'Layout 6']);
  assert.equal(tiles[0].art.kind, 'chart');
});

test('change colors: palettes recolour the series, colorful hands them back to the theme, a list of colours cycles', async () => {
  const t = await withChart();
  const colors = () => resolveChart(t.content, 0, chartOf(t)).series.map(x => x.color.slice(0, 3).join(','));
  const auto = colors();
  await run(t, 'chart.changeColors', {palette: 'monochrome'});
  assert.deepEqual(chartOf(t).series.map(x => x.color), [paletteColor('monochrome', 0), paletteColor('monochrome', 1)]);
  assert.notDeepEqual(colors(), auto);
  await run(t, 'chart.changeColors', {palette: 'accent3'});
  assert.equal(chartOf(t).series[0].color.theme, 6);
  await run(t, 'chart.changeColors', {colors: ['#FF0000', '00ff00']});
  assert.deepEqual(chartOf(t).series.map(x => x.color), ['#FF0000', '#00FF00']);
  await run(t, 'chart.changeColors', {palette: 'colorful'});
  assert.ok(chartOf(t).series.every(x => x.color === undefined));
  assert.deepEqual(colors(), auto, 'colorful is the theme\'s own cycle');
  const tiles = t.state('chart.changeColors').value;
  assert.deepEqual(tiles.map(x => x.id), ['colorful', 'monochrome', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']);
  assert.equal(tiles[1].art.colors.length, 8);
});

test('chart styles: sixteen palettes with their gridlines and data labels, drawn as tiles', async () => {
  const t = await withChart();
  assert.equal(STYLES.length, 16);
  const before = resolveChart(t.content, 0, chartOf(t)).series[0].color.join(',');
  await run(t, 'chart.styleGallery', {style: 4});
  const c = chartOf(t);
  assert.equal(c.style, 4);
  assert.deepEqual([c.gridlines, c.dataLabels], [STYLES[3][1], STYLES[3][2]]);
  assert.notEqual(resolveChart(t.content, 0, c).series[0].color.join(','), before, 'style 4 draws in another palette');
  await run(t, 'chart.styleGallery', {style: 2});
  assert.deepEqual([chartOf(t).gridlines, chartOf(t).dataLabels], [false, true]);
  await run(t, 'chart.styleGallery', {style: 1});
  assert.equal(resolveChart(t.content, 0, chartOf(t)).series[0].color.join(','), before, 'style 1 is the theme\'s own colours');
  await fails(t, 'chart.styleGallery', {style: 17});
  const tiles = t.state('chart.styleGallery').value;
  assert.equal(tiles.length, 16);
  assert.equal(tiles.filter(x => x.selected).length, 1);
  assert.ok(tiles.every(x => x.art.kind === 'chart'));
});

test('select data: a new range rebuilds the series, labels range, remove series (the last stays), switch row and column', async () => {
  const t = await withChart();
  assert.equal(chartOf(t).series.length, 2);
  await run(t, 'chart.selectData', {range: 'Sheet1!A1:B4'});
  assert.equal(chartOf(t).series.length, 1);
  assert.equal(chartOf(t).source, 'Sheet1!A1:B4');
  await run(t, 'chart.selectData', {range: 'A1:C4'});
  assert.equal(chartOf(t).series.length, 2);
  await run(t, 'chart.selectData', {categories: 'Sheet1!A2:A4'});
  assert.ok(chartOf(t).series.every(x => x.categories === 'Sheet1!$A$2:$A$4'));
  await run(t, 'chart.selectData', {categories: ''});
  assert.ok(chartOf(t).series.every(x => x.categories === undefined));
  await run(t, 'chart.selectData', {removeSeries: [0]});
  assert.equal(chartOf(t).series.length, 1);
  await run(t, 'chart.selectData', {removeSeries: [0]});
  assert.equal(chartOf(t).series.length, 1, 'the last series stays');
  await fails(t, 'chart.selectData', {});
  await fails(t, 'chart.selectData', {range: 'zzz'});
  await run(t, 'chart.selectData', {range: 'A1:C4', byRows: true});
  assert.equal(chartOf(t).byRows, true);
  await run(t, 'chart.switchRowColumn', {});
  assert.equal(chartOf(t).byRows, false);
  await expectUndoRoundTrip(t, 'chart.selectData', {range: 'A1:B4'}, () => {});
});

test('move chart goes to another sheet and a top-left cell; change type is chart.set; the dialogs hold the chart', async () => {
  const t = await withChart();
  const id = chartOf(t).id;
  await run(t, 'chart.move', {at: 'H10'});
  assert.equal(chartOf(t).anchor.cell, 'H10');
  const r = await run(t, 'chart.move', {toSheet: 'Two', at: 'B2'});
  assert.deepEqual(r, {chart: id, sheet: 'Two'});
  assert.equal(t.content.sheets[0].charts.length, 0);
  assert.equal(chartOf(t, 1).anchor.cell, 'B2');
  assert.ok(decodeURIComponent(t.doc.selection.ranges[0].anchor).startsWith('/sh:s2/chart:'), 'the chart stays selected on its new sheet');
  await run(t, 'sheet.activate', {sheet: 'Two'});
  await fails(t, 'chart.move', {toSheet: 'Nowhere'});
  await run(t, 'chart.changeType', {type: 'line', subtype: 'markers'});
  assert.equal(chartOf(t, 1).kind, 'lineMarkers');
  const {default: moveDialog} = await import('../../core/grid/dialogs/moveChart.mjs');
  const {default: typeDialog} = await import('../../core/grid/dialogs/changeChartType.mjs');
  assert.equal(typeDialog.validate({choice: 'nonsense|x'}).length, 1);
  assert.deepEqual(typeDialog.toCommand({chart: 3, choice: 'bar|stacked'}), {command: 'chart.changeType', params: {chart: 3, type: 'bar', subtype: 'stacked'}});
  assert.deepEqual(moveDialog.toCommand({chart: 3, toSheet: 'Two', at: 'C3'}), {command: 'chart.move', params: {chart: 3, toSheet: 'Two', at: 'C3'}});
});

test('select data dialog: range, labels and the series to drop become one command', async () => {
  const t = await withChart();
  const {default: dialog} = await import('../../core/grid/dialogs/selectData.mjs');
  const ctx = t.session.readContext(t.docId);
  const values = dialog.init(ctx);
  assert.equal(values.range, 'Sheet1!A1:C4');
  assert.deepEqual(values.series, ['Qty', 'Amount']);
  assert.equal(dialog.validate({...values, remove: '3'}).length, 1, 'there is no series 3');
  assert.deepEqual(dialog.toCommand({...values, remove: '2'}).params.removeSeries, [1]);
  assert.equal(dialog.validate({...values, remove: '1, 2'}).length, 0);
});

test('format selection: a series colour, the pane flag; shape fill and outline; the size boxes act on the selected object', async () => {
  const t = await withChart();
  await run(t, 'chart.formatSelection', {series: 1, color: '#336699'});
  assert.equal(chartOf(t).series[1].color, '#336699');
  await run(t, 'chart.formatSelection', {series: 1, color: null});
  assert.equal(chartOf(t).series[1].color, undefined);
  assert.deepEqual(await run(t, 'chart.formatSelection', {}), {on: true});
  assert.equal(t.doc.view.formatChartPane, true);
  assert.equal(t.state('chart.formatSelection').checked, true);
  assert.deepEqual(await run(t, 'chart.formatSelection', {on: false}), {on: false});
  await run(t, 'chart.shapeFill', {kind: 'chart', series: 0, color: '#112233'});
  assert.equal(chartOf(t).series[0].color, '#112233', 'on a chart Shape Fill with a series colours that series, as gridcraft does');
  await run(t, 'chart.shapeFill', {kind: 'chart', color: '#EEEEEE'});
  assert.equal(chartOf(t).area.fill, '#EEEEEE', 'with no series picked it fills the chart area, as Excel does');
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'F2', width: 100, height: 50});
  const sh = () => t.content.sheets[0].shapes[0];
  await run(t, 'chart.shapeFill', {color: '#FF8800'});
  await run(t, 'chart.shapeOutline', {color: '#0000FF'});
  assert.deepEqual([sh().fill, sh().line], ['#FF8800', '#0000FF']);
  await run(t, 'chart.shapeFill', {color: null});
  assert.equal(sh().fill, 'auto');
  await run(t, 'object.select', {kind: 'shape', id: sh().id});
  await run(t, 'object.move', {width: 160, height: 90});
  assert.deepEqual([sh().anchor.width, sh().anchor.height], [160, 90], 'the Size boxes size the selected shape');
  await run(t, 'object.select', {kind: 'chart', id: chartOf(t).id});
  await run(t, 'object.move', {width: 300});
  assert.equal(chartOf(t).anchor.width, 300);
  await run(t, 'object.select', {});
  await fails(t, 'object.move', {width: 10});
  await expectUndoRoundTrip(t, 'chart.shapeOutline', {id: sh().id, color: '#00FF00'}, () => {});
});
