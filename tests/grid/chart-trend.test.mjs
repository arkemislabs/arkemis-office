// U:grid/data: chart trendlines: the fits, labels and drawing (ported from gridcraft crates/chart/src/tests.rs, the
// trendline tests) and Add Chart Element > Trendline.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/chart/src/trend.rs and render/trend.rs at 146161b4b450a56e5e59a083ba0478582d1e602b:
//    least squares through x, ln transforms for exponential, logarithmic and power, polynomials on centred x,
//    Set Intercept, moving averages, the equation and R² labels, forecasts adding category slots, clipping to the plot;
//    cmd/extra/chart.rs `add_element` trendline (eligible kinds, `series`, none removes).
// 2. Ours: the same maths and drawing in core/grid/lib/chart-trend.mjs over our chart renderer.
// 3. These tests; the Add Chart Element menu is driven in tests/e2e/grid/chart-design.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {fitTrendline, movingAverage, numText, autoName} from '../../core/grid/lib/chart-trend.mjs';
import {render, legendEntries} from '../../core/grid/lib/chart-render.mjs';
import {resolveChart} from '../../core/grid/lib/chart-resolve.mjs';

const close = (a, b) => Math.abs(a - b) <= 1e-9 * (1 + Math.abs(b));
const fit = (spec, pts) => fitTrendline({type: 'linear', ...spec}, pts);

test('linear trendline matches least squares, equation and R² text', () => {
  const f = fit({}, [[1, 2], [2, 4], [3, 5], [4, 4], [5, 5]]);
  assert.ok(close(f.coef[0], 2.2) && close(f.coef[1], 0.6), String(f.coef));
  assert.ok(close(f.r2, 0.6));
  assert.equal(f.equation(), 'y = 0.6x + 2.2');
  assert.equal(f.rSquared(), 'R² = 0.6');
  assert.ok(close(f.eval(10), 8.2));
  assert.equal(fit({}, [[0, 1], [1, -1], [2, -3]]).equation(), 'y = -2x + 1');
});

test('Set Intercept fits through it', () => {
  const pts = [[1, 2], [2, 5], [3, 6]];
  const f = fit({intercept: 0}, pts);
  assert.ok(close(f.coef[0], 0) && close(f.coef[1], 15 / 7), String(f.coef));
  const ssRes = pts.reduce((s, [x, y]) => s + (y - (15 / 7) * x) ** 2, 0);
  assert.ok(close(f.r2, 1 - ssRes / 65));
  const q = fit({type: 'polynomial', order: 2, intercept: 2}, [[1, 0], [2, 0], [3, 2], [4, 6]]);
  assert.ok(close(q.coef[0], 2) && close(q.coef[1], -3) && close(q.coef[2], 1), String(q.coef));
});

test('transformed trendlines recover their curves; points the transform cannot take are skipped', () => {
  const xs = [0.5, 1, 2, 3, 4.5, 6];
  const e = fit({type: 'exponential'}, xs.map(x => [x, 3 * Math.exp(0.5 * x)]));
  assert.ok(close(Math.exp(e.coef[0]), 3) && close(e.coef[1], 0.5));
  assert.equal(e.equation(), 'y = 3e^(0.5x)');
  const l = fit({type: 'logarithmic'}, xs.map(x => [x, 2 * Math.log(x) + 1]));
  assert.ok(close(l.coef[1], 2) && close(l.coef[0], 1));
  assert.equal(l.equation(), 'y = 2ln(x) + 1');
  const p = fit({type: 'power'}, xs.map(x => [x, 4 * x ** 1.5]));
  assert.ok(close(Math.exp(p.coef[0]), 4) && close(p.coef[1], 1.5));
  assert.equal(p.equation(), 'y = 4x^1.5');
  assert.ok(close(p.r2, 1));
  assert.equal(p.eval(-1), null, 'power is undefined left of zero');
  const skip = fit({type: 'exponential'}, [[1, Math.exp(2)], [2, 0], [3, -4], [4, Math.exp(8)]]);
  assert.ok(close(skip.coef[1], 2) && close(skip.coef[0], 0), String(skip.coef));
  assert.equal(fit({type: 'power'}, [[-1, 1], [0, 2], [3, 3]]), null);
});

test('polynomial trendlines are stable, even for year-valued x', () => {
  const q = fit({type: 'polynomial', order: 2}, [0, 1, 2, 3, 4].map(x => [x, x * x - 3 * x + 2]));
  assert.ok(close(q.coef[0], 2) && close(q.coef[1], -3) && close(q.coef[2], 1), String(q.coef));
  assert.equal(q.equation(), 'y = x² - 3x + 2');
  const curve = x => { const t = x - 2000; return 0.001 * t ** 6 - 0.02 * t ** 5 + 0.1 * t ** 3 - t + 7; };
  const years = Array.from({length: 12}, (_, i) => [2001 + i, curve(2001 + i)]);
  const six = fit({type: 'polynomial', order: 6}, years);
  for (const x of [2001, 2006.5, 2012, 2014]) assert.ok(Math.abs(six.eval(x) - curve(x)) <= 1e-6 * (1 + Math.abs(curve(x))), String(x));
  assert.ok(six.r2 > 0.999999);
});

test('degenerate trendlines fit nothing', () => {
  assert.equal(fit({}, []), null);
  assert.equal(fit({}, [[1, 1]]), null);
  assert.equal(fit({}, [[2, 1], [2, 5], [2, 3]]), null, 'all x equal is singular');
  assert.equal(fit({}, [[NaN, 1], [1, Infinity], [2, 3]]), null);
  assert.equal(fit({type: 'polynomial', order: 3}, [[1, 1], [2, 4], [3, 9]]), null);
  assert.equal(fit({type: 'movingAverage', period: 2}, [[1, 1], [2, 2]]), null);
  const flat = fit({}, [[1, 4], [2, 4], [3, 4]]);
  assert.deepEqual([flat.equation(), flat.r2], ['y = 4', null]);
});

test('moving average and label text', () => {
  const pts = [[1, 1], [2, 2], [3, 6], [4, NaN], [5, 4]];
  assert.deepEqual(movingAverage(pts, 2), [[2, 1.5], [3, 4], [5, 5]]);
  assert.deepEqual(movingAverage(pts, 3), [[3, 3], [5, 4]]);
  assert.deepEqual(movingAverage(pts, 9), []);
  assert.equal(numText(0.000012345), '1.2345E-05');
  assert.equal(numText(-0.00001), '-1E-05');
  assert.equal(numText(1234.56789), '1234.5679');
  assert.equal(autoName({type: 'movingAverage', period: 3}, 'Sales'), '3 per. Mov. Avg. (Sales)');
  assert.equal(autoName({type: 'exponential'}, 'Sales'), 'Expon. (Sales)');
});

const series = (name, values, color, kind, extra = {}) => ({name, values, x: null, sizes: null, color, kind, secondary: false, smooth: false, trendlines: [], numberFormat: 'General', ...extra});
const linesOf = (prims, color) => prims.filter(p => p.t === 'line' && p.color.join() === color.join()).map(p => p.pts);
const textsOf = prims => prims.filter(p => p.t === 'text').map(p => p.text);

test('a line chart draws the trendline, its forecast slot and its labels; legend names it', () => {
  const tc = [1, 2, 3, 255], dc = [10, 20, 30, 255];
  const s = series('Sales', [9, 7, 5, 3], dc, 'line', {trendlines: [{spec: {type: 'linear', forward: 1, displayEquation: true, displayRSquared: true}, color: tc}]});
  const d = {categoryLevels: [], palette: [], categories: ['a', 'b', 'c', 'd'], series: [s]};
  const c = {kind: 'line', legend: 'none', gridlines: true};
  const prims = render(c, d, 600, 400);
  const data = linesOf(prims, dc), trend = linesOf(prims, tc);
  assert.deepEqual([data.length, trend.length], [1, 1]);
  const [d0, dn] = [data[0][0], data[0][3]];
  const [t0, tn] = [trend[0][0], trend[0].at(-1)];
  assert.ok(Math.abs(t0[0] - d0[0]) < 0.01 && Math.abs(t0[1] - d0[1]) < 0.01, 'starts on the first point');
  const step = (dn[0] - d0[0]) / 3;
  assert.ok(Math.abs(tn[0] - (dn[0] + step)) < 0.01, 'runs one category past the data');
  assert.ok(tn[1] > dn[1], 'keeps falling past the data');
  const t = textsOf(prims);
  assert.ok(t.includes('y = -2x + 11') && t.includes('R² = 1'), String(t));
  assert.ok(legendEntries({kind: 'line', legend: 'bottom'}, d).some(e => e[0] === 'Linear (Sales)' && e[1].join() === tc.join() && e[2] === 'line'));
  // Not on chart kinds Excel offers no trendlines on.
  assert.deepEqual(linesOf(render({kind: 'pie', legend: 'none'}, d, 600, 400), tc), []);
  // One point: nothing to fit.
  const one = {...d, categories: ['a'], series: [{...s, values: [9]}]};
  assert.deepEqual(linesOf(render(c, one, 600, 400), tc), []);
});

test('scatter trendlines use the x values and stay in the plot', () => {
  const xs = [1, 2, 4, 8];
  const colors = [[1, 0, 0, 255], [2, 0, 0, 255], [3, 0, 0, 255]];
  const s = series('P', xs.map(x => 4 * x * x), [10, 20, 30, 255], 'scatter', {x: xs, trendlines: [
    {spec: {type: 'power', backward: 0.5, displayEquation: true}, color: colors[0]},
    {spec: {type: 'exponential', forward: 30}, color: colors[1]},
    {spec: {type: 'movingAverage', period: 2}, color: colors[2]},
  ]});
  const prims = render({kind: 'scatter', legend: 'none', gridlines: true}, {categoryLevels: [], palette: [], categories: [], series: [s]}, 600, 400);
  for (const c of colors) assert.ok(linesOf(prims, c).length, `${c} not drawn`);
  assert.equal(linesOf(prims, colors[2])[0].length, 3, 'moving average: one point per full window');
  assert.ok(textsOf(prims).includes('y = 4x^2'));
  for (const p of prims) if (p.t === 'line') for (const [x, y] of p.pts) assert.ok(x >= -0.01 && x <= 600.01 && y >= -0.01 && y <= 400.01);
});

test('a huge forecast does not collapse the columns', () => {
  const tc = [9, 9, 9, 255];
  const s = series('S', [1, 2, 3, 4], [10, 20, 30, 255], 'columnClustered', {trendlines: [{spec: {type: 'linear', forward: 1e6, backward: 1e6}, color: tc}]});
  const prims = render({kind: 'columnClustered', legend: 'none', gridlines: true}, {categoryLevels: [], palette: [], categories: ['a', 'b', 'c', 'd'], series: [s]}, 600, 400);
  const trend = linesOf(prims, tc);
  assert.equal(trend.length, 1);
  assert.ok(trend[0].length >= 20, 'sampled over the plot, not the forecast');
  const bars = prims.filter(p => p.t === 'rect' && p.fill?.join() === '10,20,30,255');
  assert.ok(bars.every(b => b.w > 1), 'columns keep their width');
});

// ---------------------------------------------------------------- the command

const blocks = {0: {A1: {v: 'Region'}, B1: {v: 'Qty'}, C1: {v: 'Amount'}, A2: {v: 'West'}, B2: {v: 5}, C2: {v: 120}, A3: {v: 'East'}, B3: {v: 9}, C3: {v: 340}, A4: {v: 'North'}, B4: {v: 12}, C4: {v: 480}}};
async function withChart(type = 'line') {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks}]));
  await run(t, 'insert.chart', {type, range: 'A1:C4', title: 'Sales'});
  return t;
}
const chartOf = t => t.content.sheets[0].charts[0];

test('chart.addElement trendline: every series or one, linear forecast, polynomial, moving average, None removes', async () => {
  const t = await withChart();
  await expectUndoRoundTrip(t, 'chart.addElement', {element: 'trendline', type: 'linear'}, () => {});
  assert.deepEqual(chartOf(t).series.map(s => s.trendlines?.length), [1, 1]);
  assert.equal(chartOf(t).series[0].trendlines[0].type, 'linear');
  await run(t, 'chart.addElement', {element: 'trendline', type: 'linearForecast', series: 1});
  assert.deepEqual(chartOf(t).series.map(s => s.trendlines?.length), [1, 2]);
  assert.deepEqual([chartOf(t).series[1].trendlines[1].type, chartOf(t).series[1].trendlines[1].forward], ['linear', 2]);
  await run(t, 'chart.addElement', {element: 'trendline', type: 'polynomial', order: 9, displayEquation: true, displayRSquared: true, series: 0});
  assert.deepEqual(chartOf(t).series[0].trendlines[1], {type: 'polynomial', forward: 0, backward: 0, displayEquation: true, displayRSquared: true, order: 6});
  await run(t, 'chart.addElement', {element: 'trendline', type: 'movingAverage', period: 2, series: 0});
  assert.equal(chartOf(t).series[0].trendlines[2].period, 2);
  assert.ok(await fails(t, 'chart.addElement', {element: 'trendline', series: 5}));
  assert.ok(await fails(t, 'chart.addElement', {element: 'trendline', type: 'zigzag'}));
  // The chart resolves them with a colour; the series colour is the default.
  const r = resolveChart(t.content, 0, chartOf(t));
  assert.equal(r.series[0].trendlines.length, 3);
  assert.deepEqual(r.series[0].trendlines[0].color, r.series[0].color);
  await run(t, 'chart.addElement', {element: 'trendline', on: false, series: 0});
  assert.equal(chartOf(t).series[0].trendlines, undefined);
  assert.equal(chartOf(t).series[1].trendlines.length, 2);
  await run(t, 'chart.addElement', {element: 'trendline', on: false});
  assert.equal(chartOf(t).series[1].trendlines, undefined);
});

test('trendlines need a kind Excel offers them on', async () => {
  const t = await withChart('pie');
  assert.match((await fails(t, 'chart.addElement', {element: 'trendline'})).message, /2-D column, bar, line, area, scatter or bubble/);
  const u = await withChart('column');
  await run(u, 'chart.addElement', {element: 'trendline', type: 'exponential'});
  assert.equal(chartOf(u).series[0].trendlines[0].type, 'exponential');
});

// ---------------------------------------------------------------- .xlsx

test('trendlines are written to the chart part in schema order and read back', async () => {
  const {default: JSZip} = await import('jszip');
  const {writeXlsx} = await import('../../core/grid/formats/xlsx-write.mjs');
  const {readXlsx} = await import('../../core/grid/formats/xlsx-read.mjs');
  const trendlines = [
    {type: 'polynomial', order: 3, name: 'Fit', forward: 2, backward: 1, intercept: 4, displayEquation: true, displayRSquared: false, color: '#C00000', width: 2.5, dash: 'solid'},
    {type: 'movingAverage', period: 4, forward: 0, backward: 0, displayEquation: false, displayRSquared: false},
  ];
  const chart = {id: 1, kind: 'line', anchor: {cell: 'E2', dx: 0, dy: 0, width: 400, height: 250, mode: 'moveAndSize'}, legend: 'bottom', dataLabels: false, gridlines: true, style: 2, byRows: false,
    series: [{name: 'Sheet1!$B$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$B$2:$B$4', trendlines}, {name: 'Sheet1!$C$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$C$2:$C$4'}]};
  const wb = workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 'Q'}, B1: {v: 'S'}, C1: {v: 'C'}, A2: {v: 'a'}, B2: {v: 1}, C2: {v: 2}, A3: {v: 'b'}, B3: {v: 3}, C3: {v: 4}, A4: {v: 'c'}, B4: {v: 5}, C4: {v: 6}}}, charts: [chart]}]);
  const bytes = await writeXlsx(wb);
  const xml = await (await JSZip.loadAsync(bytes)).file('xl/charts/chart1.xml').async('string');
  assert.match(xml, /<c:trendline><c:name>Fit<\/c:name><c:spPr><a:ln w="31750" cap="rnd"><a:solidFill>.*<\/a:solidFill><a:prstDash val="solid"\/><\/a:ln><\/c:spPr><c:trendlineType val="poly"\/><c:order val="3"\/><c:forward val="2"\/><c:backward val="1"\/><c:intercept val="4"\/><c:dispRSqr val="0"\/><c:dispEq val="1"\/>/);
  assert.match(xml, /<c:trendlineType val="movingAvg"\/><c:period val="4"\/>/);
  const read = await readXlsx(bytes);
  const back = (read.content ?? read).sheets[0].charts[0];
  assert.deepEqual(back.series[0].trendlines[0], {...trendlines[0], color: back.series[0].trendlines[0].color});
  assert.equal(back.series[0].trendlines[1].period, 4);
  assert.equal(back.series[1].trendlines, undefined);
});
