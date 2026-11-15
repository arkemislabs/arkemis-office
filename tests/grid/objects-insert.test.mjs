// U:grid/insert (objects): Recommended PivotTables, PivotChart and the smooth and straight scatter variants.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/pivot/charts.rs (`suggestions`: the layouts that suit a source, up to five;
//    `recommended` with apply; `insert_pivot_chart`: the chart's series from the report, linked `Sheet!PivotTable`) and
//    pivot/charts.rs (`chart_series`, `rebind_charts`), crates/xlsx chart.rs (the chart's pivotSource). Excel: a PivotChart
//    follows its PivotTable as fields are added.
// 2. Ours runs the same commands through the translated pivot model; the chart is the ordinary chart object with a link.
// 3. These tests; the bridge E2E tests/e2e/grid/insert-objects.e2e.mjs drives the ribbon.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run} from './edit-helpers.mjs';
import {resolveChart} from '../../core/grid/lib/chart-resolve.mjs';
import {render} from '../../core/grid/lib/chart-render.mjs';
import {chartLink, parseChartLink, linksTo, chartSeries} from '../../core/grid/lib/pivot-chart.mjs';

const SALES = [
  ['Region', 'Product', 'Date', 'Units', 'Sales'],
  ['East', 'Apples', '1/15/2026', 10, 100], ['West', 'Apples', '2/10/2026', 5, 50], ['East', 'Pears', '3/3/2026', 8, 120],
  ['North', 'Pears', '4/20/2026', 2, 30], ['West', 'Plums', '5/5/2026', 7, 70], ['East', 'Plums', '6/30/2026', 4, 60],
  ['North', 'Apples', '7/4/2026', 9, 90], ['West', 'Pears', '8/8/2026', 3, 45], ['East', 'Apples', '9/9/2026', 6, 60],
];
async function sales() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: SALES});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}
const pivots = t => t.content.sheets.flatMap(sh => sh.pivots ?? []);
const charts = t => t.content.sheets.flatMap(sh => sh.charts ?? []);

test('insert.chart: scatter with lines and markers, straight or smoothed', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 'X'}, B1: {v: 'Y'}, A2: {v: 1}, B2: {v: 3}, A3: {v: 2}, B3: {v: 5}, A4: {v: 3}, B4: {v: 4}, A5: {v: 4}, B5: {v: 8}}}}]));
  await run(t, 'selection.set', {range: 'A1:B5'});
  const r = await run(t, 'insert.chart', {kind: 'scatterStraight'});
  const straight = charts(t).find(c => c.id === r.chart);
  assert.equal(straight.kind, 'scatterLines');
  assert.ok(straight.series.every(x => !x.smooth));
  const r2 = await run(t, 'insert.chart', {kind: 'scatterSmooth', at: 'H2'});
  const smooth = charts(t).find(c => c.id === r2.chart);
  assert.equal(smooth.kind, 'scatterLines');
  assert.ok(smooth.series.every(x => x.smooth === true));
  assert.equal(smooth.anchor.cell, 'H2');
  assert.equal(t.doc.selection.ranges[0].anchor, `/sh:s1/chart:${smooth.id}`, 'the new chart is selected');
  const prims = render(smooth, resolveChart(t.content, 0, smooth), 400, 250);
  assert.ok(prims.some(p => p.t === 'line'), 'the lines are drawn');
  await expectUndoRoundTrip(t, 'insert.chart', {kind: 'scatterSmooth'}, after => assert.equal(after.content.sheets[0].charts.length, 3));
});

test('insert.recommendedPivotTables lists the layouts that suit the data and creates the one picked', async () => {
  const t = await sales();
  const r = await run(t, 'insert.recommendedPivotTables', {});
  assert.equal(r.source, 'Sheet1!$A$1:$E$10');
  const titles = r.suggestions.map(x => x.title);
  assert.equal(titles[0], 'Sum of Units by Region');
  assert.ok(titles.includes('Sum of Units by Region and Product'));
  assert.ok(titles.includes('Sum of Units by Date (quarters)'), 'a date column suggests quarters');
  assert.ok(titles.includes('Sum of Units and Sales by Region'));
  assert.ok(titles.includes('Count of Region by Region'));
  assert.ok(r.suggestions.length <= 5);
  assert.deepEqual(r.suggestions[0], {index: 0, title: 'Sum of Units by Region', rows: ['Region'], columns: [], values: [{field: 'Units', func: 'sum'}]});
  assert.equal(pivots(t).length, 0, 'listing creates nothing');
  const made = await run(t, 'insert.recommendedPivotTables', {apply: 1});
  assert.equal(made.suggestion.title, 'Sum of Units by Region and Product');
  assert.equal(pivots(t).length, 1);
  assert.deepEqual(pivots(t)[0].rows.map(x => x.sourceCol), ['Region']);
  assert.deepEqual(pivots(t)[0].columns.map(x => x.sourceCol), ['Product']);
  await assert.rejects(() => run(t, 'insert.recommendedPivotTables', {source: 'Sheet1!A1:A10', apply: 3}), /no suggestion/);
});

test('insert.pivotChart plots the report: series from the item columns, linked, rebuilt as fields are added', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: [{field: 'Units', func: 'sum'}]});
  const r = await run(t, 'insert.pivotChart', {});
  assert.equal(r.series, 1);
  const chart = charts(t).find(c => c.id === r.chart);
  assert.equal(chart.pivot, `Sheet2!PivotTable1`);
  assert.equal(chart.kind, 'columnClustered');
  assert.equal(chart.title, 'Total');
  assert.equal(chart.series[0].name, '"Sum of Units"');
  assert.match(chart.series[0].values, /^Sheet2!\$B\$\d+:\$B\$\d+$/);
  assert.match(chart.series[0].categories, /^Sheet2!\$A\$\d+:\$A\$\d+$/);
  const plotted = resolveChart(t.content, t.content.sheets.findIndex(s => s.name === 'Sheet2'), chart);
  assert.equal(plotted.series[0].values.length, 3, 'one point for each region (the grand total is left out)');
  assert.equal(plotted.series[0].values.reduce((a, b) => a + b, 0), 54);
  // a second value field makes a second series, with no command of the chart's own
  await run(t, 'pivot.addField', {field: 'Sales', area: 'values'});
  const after = charts(t).find(c => c.id === r.chart);
  assert.equal(after.series.length, 2);
  assert.equal(after.series[1].name, '"Sum of Sales"');
  assert.ok(render(after, resolveChart(t.content, 0, after), 400, 250).some(p => p.t === 'rect'));
  assert.ok(linksTo(after.pivot, 'Sheet2', 'PivotTable1') && !linksTo(after.pivot, 'Sheet1', 'PivotTable1'));
  assert.deepEqual(parseChartLink("'My Sheet'!PivotTable2"), ['My Sheet', 'PivotTable2']);
  assert.deepEqual(parseChartLink('[Book.xlsx]Sheet2!PivotTable1'), ['Sheet2', 'PivotTable1']);
  assert.equal(chartLink('My Sheet', 'PivotTable2'), "'My Sheet'!PivotTable2");
  assert.equal(parseChartLink('nonsense'), null);
  await run(t, 'pivot.addField', {field: 'Product', area: 'columns'});
  assert.ok(charts(t).find(c => c.id === r.chart).series.length >= 6, 'a column field makes a series for each item and value');
  await expectUndoRoundTrip(t, 'pivot.removeField', {field: 'Product'}, after2 => assert.ok(after2.content.sheets[0].charts[0].series.length < 6));
});

test('insert.pivotChart with no PivotTable: the dialog asks, then a blank PivotTable and an empty chart are made', async () => {
  const t = await sales();
  assert.equal(await run(t, 'insert.pivotChart', {}), null);
  assert.equal(t.doc.view.dialogRequest.id, 'dialog.createPivotChart');
  const r = await run(t, 'insert.pivotChart', {source: 'Sheet1!$A$1:$E$10', destination: 'new', withTable: true});
  assert.equal(pivots(t).length, 1);
  assert.equal(r.series, 0, 'the chart is empty until fields are added');
  const chart = charts(t)[0];
  assert.equal(chart.pivot, 'Sheet2!PivotTable1');
  await run(t, 'pivot.addField', {field: 'Region', area: 'rows'});
  await run(t, 'pivot.addField', {field: 'Units', area: 'values'});
  assert.equal(charts(t)[0].series.length, 1, 'adding fields fills the chart');
  assert.deepEqual(chartSeries('S', {row: 0, col: 0}, {chartRows: [2, 3, 5], chartCols: [[1, 'A "x"']], labelCol: 0}), [{name: '"A ""x"""', values: '(S!$B$3:$B$4,S!$B$6)', categories: '(S!$A$3:$A$4,S!$A$6)'}]);
});

test('a PivotChart saves with its pivotSource and reads back linked', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: [{field: 'Units', func: 'sum'}]});
  await run(t, 'insert.pivotChart', {type: 'pie'});
  const bytes = await writeXlsx(t.content);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const chartXml = await zip.file('xl/charts/chart1.xml').async('string');
  assert.match(chartXml, /<c:pivotSource><c:name>\[Book1\]Sheet2!PivotTable1<\/c:name>/);
  const read = await readXlsx(bytes);
  const back = (read.content ?? read).sheets.flatMap(sh => sh.charts ?? [])[0];
  assert.equal(back.pivot, 'Sheet2!PivotTable1');
  assert.equal(back.kind, 'pie');
});
