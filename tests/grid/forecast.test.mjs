// Forecast Sheet (Data > Forecast): FORECAST.ETS, FORECAST.ETS.CONFINT, FORECAST.ETS.SEASONALITY,
// FORECAST.ETS.STAT and the command data.forecastSheet.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/functions/src/ets.rs `mod tests` (interpolation, the missing-point limit,
//    a straight line forecasts exactly, a seasonal series is detected and continued, the statistics are
//    consistent, monthly dates and duplicates, the documented errors, timelines continuing past their
//    last point) and crates/engine/src/cmd/forecast.rs `mod tests` (the sheet's table, formulas and chart,
//    the caps, parameters and errors, Forecast Start hindcasts, invalid starts).
// 2. Ours: core/grid/model/functions/ets.mjs and core/grid/commands/data/forecast.mjs.
// 3. These tests. The column chart is a combo chart (columns for the values and the forecast, lines for
//    the bounds), as Excel draws it; upstream marks the bounds as lines on a column chart.

import test from 'node:test';
import assert from 'node:assert/strict';
import '../../core/grid/model/functions/index.mjs';
import {lookup, call, val, ref} from '../../core/grid/model/functions/registry.mjs';
import {GArray, ERR, CellError} from '../../core/grid/lib/value.mjs';
import {serialFromYmd, daysInMonth, D1900} from '../../core/grid/lib/date.mjs';
import {Timeline, series, interpolate, defaultOptions} from '../../core/grid/model/functions/ets.mjs';
import {maxPeriods, defaultPeriods, MAX_HISTORY, MAX_PERIODS, MAX_WORK} from '../../core/grid/commands/data/forecast.mjs';
import {session, run, fails, v, text, stored} from './edit-helpers.mjs';

// ---------------------------------------------------------------------------------------------
// The functions

const col = xs => new GArray(xs.length, 1, xs);
const row = xs => new GArray(1, xs.length, xs);
const range = xs => ref(col(xs));
const n = x => val(x);
const ev = (name, args) => call(lookup(name), args, null);
const close = (got, want, tol = 1e-9) => assert.ok(typeof got === 'number' && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want)), `${got} != ${want}`);
const isErr = (got, e) => assert.ok(got instanceof CellError && got.text === e.text, `${String(got?.text ?? got)} != ${e.text}`);
const timeline = len => Array.from({length: len}, (_, i) => i + 1);
/** y = 3 + 2t plus a four-step season, over `len` points. */
const seasonal = len => { const pattern = [4, -2, 7, -9]; return timeline(len).map(t => 3 + 2 * t + pattern[(t - 1) % 4]); };

test('interpolation preserves gaps and endpoint values', () => {
  const cases = [
    [[null, 4, null, null, 13, -2, null, 8, null, null], [4, 4, 7, 10, 13, -2, 3, 8, 8, 8]],
    [[-7, null, 4], [-7, -1.5, 4]],
    [[3, -7, 2], [3, -7, 2]],
    [[null, null, null], [0, 0, 0]],
    [[6], [6]],
    [[], []],
  ];
  for (const [slots, want] of cases) assert.deepEqual(interpolate(slots), want, JSON.stringify(slots));
});

test('series completes a long gap at the missing point limit', () => {
  const len = 2000, gapStart = 700, gapEnd = 1300; // exactly 30% of the completed timeline
  const inGap = i => i >= gapStart && i < gapEnd;
  const times = [];
  for (let i = 0; i < len; i++) if (!inGap(i)) times.push(i + 1);
  const values = times.map(t => 3 * t + 2);
  const opts = defaultOptions();
  const want = Array.from({length: len}, (_, i) => 3 * i + 5);
  const done = series(col(values), col(times), opts, D1900);
  assert.deepEqual(done.y, want);
  assert.equal(done.step, 1);
  const zeros = series(col(values), col(times), {...opts, interpolate: false}, D1900);
  zeros.y.forEach((x, i) => assert.equal(x, inGap(i) ? 0 : want[i]));
  // Remove the first known point after the gap without changing either timeline endpoint.
  times.splice(gapStart, 1); values.splice(gapStart, 1);
  assert.throws(() => series(col(values), col(times), opts, D1900), e => e === ERR.Num);
});

test('a straight line forecasts exactly', () => {
  const ys = timeline(20).map(t => 3 + 2 * t), ts = timeline(20);
  close(ev('FORECAST.ETS', [n(25), range(ys), range(ts)]), 53);
  close(ev('FORECAST.ETS', [n(20.5), range(ys), range(ts), n(0)]), 44);
  close(ev('FORECAST.ETS.SEASONALITY', [range(ys), range(ts)]), 0);
  close(ev('FORECAST.ETS.CONFINT', [n(25), range(ys), range(ts)]), 0);
  close(ev('FORECAST.ETS.STAT', [range(ys), range(ts), n(8)]), 1);
  close(ev('FORECAST.ETS.STAT', [range(ys), range(ts), n(6)]), 0);
  // Target dates are lifted over arrays.
  const lifted = ev('FORECAST.ETS', [val(row([21, 22])), range(ys), range(ts)]);
  assert.ok(lifted instanceof GArray);
  close(lifted.data[0], 45);
  close(lifted.data[1], 47);
});

test('a seasonal series is detected and continued, in any order', () => {
  const ys = seasonal(24), ts = timeline(24);
  close(ev('FORECAST.ETS.SEASONALITY', [range(ys), range(ts)]), 4);
  // t = 27 is the third position of the pattern: 3 + 54 + 7.
  close(ev('FORECAST.ETS', [n(27), range(ys), range(ts)]), 64, 1e-7);
  close(ev('FORECAST.ETS', [n(28), range(ys), range(ts), n(4)]), 50, 1e-7);
  close(ev('FORECAST.ETS', [n(27), range([...ys].reverse()), range([...ts].reverse())]), 64, 1e-7);
});

test('the statistics of a noisy series are consistent', () => {
  const ys = seasonal(48).map((x, i) => x + (((i * 37) % 11) - 5) * 0.4), ts = timeline(48);
  const stat = k => { const x = ev('FORECAST.ETS.STAT', [range(ys), range(ts), n(k)]); assert.equal(typeof x, 'number', `statistic ${k}: ${x?.text}`); return x; };
  for (const k of [1, 2, 3]) assert.ok(stat(k) >= 0 && stat(k) <= 1, `parameter ${k} out of range`);
  const [mase, smape, mae, rmse] = [stat(4), stat(5), stat(6), stat(7)];
  assert.ok(mae > 0 && rmse >= mae && mase > 0 && smape > 0 && smape < 2);
  const conf = (t, c) => { const x = ev('FORECAST.ETS.CONFINT', [n(t), range(ys), range(ts), n(c)]); assert.equal(typeof x, 'number'); return x; };
  assert.ok(conf(49, 0.95) > 0);
  assert.ok(conf(60, 0.95) > conf(49, 0.95), 'the interval widens with the horizon');
  assert.ok(conf(49, 0.99) > conf(49, 0.95));
  const f = ev('FORECAST.ETS', [n(51), range(ys), range(ts)]);
  assert.ok(Math.abs(f - (3 + 102 + 7)) < 3, `forecast ${f}`);
});

test('monthly dates, missing points and duplicate time stamps', () => {
  // First of each month, 2024-01 to 2025-12.
  const ts = [];
  for (let i = 0; i < 24; i++) ts.push(serialFromYmd(D1900, 2024 + Math.floor(i / 12), (i % 12) + 1, 1));
  assert.equal(ts[0], 45292);
  const ys = Array.from({length: 24}, (_, i) => 100 + 5 * i);
  // 2026-01-01 = 46023, 2026-03-01 = 46082.
  close(ev('FORECAST.ETS', [n(46023), range(ys), range(ts), n(0)]), 220);
  close(ev('FORECAST.ETS', [n(46082), range(ys), range(ts), n(0)]), 230);
  // Missing points are interpolated (or zero with data_completion 0).
  const gapsT = [1, 2, 4, 5, 6, 8, 9, 10], gapsY = gapsT.map(t => 10 * t);
  close(ev('FORECAST.ETS', [n(12), range(gapsY), range(gapsT), n(0)]), 120);
  assert.notEqual(ev('FORECAST.ETS', [n(12), range(gapsY), range(gapsT), n(0), n(0)]), 120);
  // Duplicate time stamps are averaged by default, summed with aggregation 7.
  const dupT = [1, 2, 2, 3, 4, 5], dupY = [2, 3, 5, 6, 8, 10];
  close(ev('FORECAST.ETS', [n(6), range(dupY), range(dupT), n(0)]), 12);
  close(ev('FORECAST.ETS.STAT', [range(dupY), range(dupT), n(8)]), 1, 1e-12);
  assert.notEqual(ev('FORECAST.ETS', [n(6), range(dupY), range(dupT), n(0), n(1), n(7)]), 12);
});

test('the documented errors', () => {
  const ys = seasonal(12), ts = timeline(12);
  const ets = args => ev('FORECAST.ETS', args);
  isErr(ets([n(5), range(ys), range(ts)]), ERR.Num); // target before the end of the timeline
  isErr(ets([n(13), range(ys), range(ts.slice(0, 11))]), ERR.NA); // sizes differ
  isErr(ets([n(5), range([1, 2, 3]), range([1, 2, 4.5])]), ERR.Num); // no constant step
  // Seasonality, completion and aggregation out of range.
  for (const [i, bad] of [[3, 8761], [3, -1], [4, 2], [5, 8]]) {
    const args = [n(13), range(ys), range(ts), n(1), n(1), n(0)];
    args[i] = n(bad);
    isErr(ets(args), ERR.Num);
  }
  isErr(ets([n(30), range([1, 2, 3]), range([1, 2, 20])]), ERR.Num); // more than 30% missing
  // Text time stamps; errors propagate.
  isErr(ets([n(13), range([1, 2]), range([1, 'x'])]), ERR.Value);
  isErr(ets([n(13), range([1, ERR.Div0]), range([1, 2])]), ERR.Div0);
  // Confidence level outside (0, 1); statistic type outside 1-8.
  isErr(ev('FORECAST.ETS.CONFINT', [n(13), range(ys), range(ts), n(1)]), ERR.Num);
  isErr(ev('FORECAST.ETS.CONFINT', [n(13), range(ys), range(ts), n(0)]), ERR.Num);
  isErr(ev('FORECAST.ETS.STAT', [range(ys), range(ts), n(9)]), ERR.Num);
  isErr(ev('FORECAST.ETS.STAT', [range(ys), range(ts), n(0)]), ERR.Num);
  // Hostile spans: a huge gap is rejected before anything is allocated.
  isErr(ets([n(1e15), range([1, 2, 3]), range([0, 1, 1e12])]), ERR.Num);
  isErr(ets([n(1e308), range(ys), range(ts)]), ERR.Num);
});

test('timelines continue past their last point', () => {
  let tl = Timeline.detect([3, 1, 2, 2, 5], D1900);
  assert.ok(tl, 'numeric step');
  assert.equal(tl.afterLast(1), 6);
  assert.equal(tl.stepsAfterLast(8.5), 3.5);
  // Month ends: 2024-01-31 (45322), 2024-02-29 (45351), 2024-03-31 (45382).
  tl = Timeline.detect([45322, 45351, 45382], D1900);
  assert.ok(tl, 'months');
  assert.equal(tl.afterLast(1), 45412); // 2024-04-30
  assert.equal(tl.stepsAfterLast(45412), 1);
  assert.equal(Timeline.detect([1, 2, 4.5], D1900), null);
  assert.equal(Timeline.detect([1, 2, 9], D1900), null, 'too many missing points');
  assert.equal(Timeline.detect([1], D1900), null);
  assert.equal(Timeline.detect([1, NaN], D1900), null);
  assert.equal(daysInMonth(2024, 2), 29);
});

test('the functions work in cells and registered names are found with the file prefix', async () => {
  assert.ok(lookup('_xlfn.FORECAST.ETS.CONFINT'));
  const t = await session();
  const rows = [['t', 'y']];
  for (let i = 1; i <= 12; i++) rows.push([i, 3 + 2 * i]);
  await run(t, 'range.setValues', {range: 'A1', values: rows});
  await run(t, 'range.setValues', {range: 'D1', values: [['=FORECAST.ETS(15,B2:B13,A2:A13)', '=FORECAST.ETS.SEASONALITY(B2:B13,A2:A13)', '=FORECAST.ETS.STAT(B2:B13,A2:A13,8)', '=_xlfn.FORECAST.ETS(14,B2:B13,A2:A13)']]});
  close(v(t, 'D1'), 33);
  assert.equal(v(t, 'E1'), 0);
  assert.equal(v(t, 'F1'), 1);
  close(v(t, 'G1'), 31);
});

// ---------------------------------------------------------------------------------------------
// The command

/** A workbook with Month/Sales: y = 10 + 2t with a four-step season, t = 1..16 in A2:B17. */
async function withHistory() {
  const t = await session();
  const season = [3, -1, 4, -6];
  const rows = [['Month', 'Sales']];
  for (let i = 1; i <= 16; i++) rows.push([i, 10 + 2 * i + season[(i - 1) % 4]]);
  await run(t, 'range.setValues', {range: 'A1', values: rows});
  return t;
}
const sheetOf = (t, r) => t.content.sheets.findIndex(x => x.name === r.sheet);
const fOf = (t, a1, si = 0) => stored(t, a1, si)?.f;

test('Forecast Sheet builds the table, the formulas and the chart before the data sheet', async () => {
  const t = await withHistory();
  await run(t, 'selection.set', {range: 'A1:B17'});
  const r = await run(t, 'data.forecastSheet', {periods: 4, statistics: true});
  assert.equal(r.history, 16);
  assert.equal(r.periods, 4);
  assert.equal(sheetOf(t, r), 0, 'inserted before the data sheet');
  assert.equal(t.content.sheets[1].name, 'Sheet1');
  assert.equal(t.content.activeSheetId, t.content.sheets[0].id, 'and shown');
  assert.equal(v(t, 'C1', 0), 'Forecast(Sales)');
  assert.equal(v(t, 'D1', 0), 'Lower Confidence Bound(Sales)');
  assert.equal(v(t, 'E1', 0), 'Upper Confidence Bound(Sales)');
  assert.equal(fOf(t, 'C17'), 'B17');
  assert.equal(fOf(t, 'C18'), 'FORECAST.ETS(A18,$B$2:$B$17,$A$2:$A$17,1,1)');
  assert.equal(fOf(t, 'D18'), 'C18-FORECAST.ETS.CONFINT(A18,$B$2:$B$17,$A$2:$A$17,0.95,1,1)');
  assert.equal(fOf(t, 'E18'), 'C18+FORECAST.ETS.CONFINT(A18,$B$2:$B$17,$A$2:$A$17,0.95,1,1)');
  assert.equal(fOf(t, 'H2'), 'FORECAST.ETS.STAT($B$2:$B$17,$A$2:$A$17,1,1,1)');
  assert.equal(fOf(t, 'H8'), 'FORECAST.ETS.STAT($B$2:$B$17,$A$2:$A$17,7,1,1)');
  // The history is copied sorted by time, as values.
  assert.equal(v(t, 'A2', 0), 1);
  assert.equal(v(t, 'B17', 0), v(t, 'B17', 1));
  assert.equal(stored(t, 'B2', 0).f, undefined);
  // The future timeline and the exact continuation of the seasonal series (t = 17: 10 + 34 + 3).
  assert.equal(v(t, 'A18', 0), 17);
  assert.equal(v(t, 'A21', 0), 20);
  assert.ok(Math.abs(v(t, 'C18', 0) - 47) < 1e-6, String(v(t, 'C18', 0)));
  const [lo, hi] = [v(t, 'D19', 0), v(t, 'E19', 0)];
  assert.ok(lo <= hi);
  // The statistics table: labels and live values.
  assert.deepEqual(['Alpha', 'Beta', 'Gamma', 'MASE', 'SMAPE', 'MAE', 'RMSE'].map((_, i) => v(t, `G${i + 2}`, 0)), ['Alpha', 'Beta', 'Gamma', 'MASE', 'SMAPE', 'MAE', 'RMSE']);
  for (let i = 2; i <= 8; i++) assert.equal(typeof v(t, `H${i}`, 0), 'number');
  assert.equal(v(t, 'G1', 0), 'Statistic');
  assert.equal(v(t, 'H1', 0), 'Value');
  // The table and the chart.
  const sh = t.content.sheets[0];
  assert.equal(sh.tables.length, 1);
  assert.equal(sh.tables[0].name, r.table);
  assert.equal(sh.tables[0].range, 'A1:E21');
  assert.deepEqual(sh.tables[0].columns.map(c => c.name), ['Month', 'Sales', 'Forecast(Sales)', 'Lower Confidence Bound(Sales)', 'Upper Confidence Bound(Sales)']);
  const chart = sh.charts[0];
  assert.equal(chart.id, r.chart);
  assert.equal(chart.kind, 'line');
  assert.equal(chart.series.length, 4);
  assert.equal(chart.series[1].values, `${r.sheet}!$C$2:$C$21`);
  assert.equal(chart.series[0].categories, `${r.sheet}!$A$2:$A$21`);
  assert.equal(chart.series[0].name, `${r.sheet}!$B$1`);
  assert.equal(chart.anchor.cell, 'J2', 'the chart sits right of the statistics table');
  // One undo step removes the sheet again.
  await t.exec('edit.undo', {});
  assert.equal(t.content.sheets.length, 1);
});

test('live formulas: editing the copied history moves the forecast', async () => {
  const t = await withHistory();
  const r = await run(t, 'data.forecastSheet', {range: 'A1:B17', periods: 2, seasonality: 0, confidenceInterval: false});
  const before = v(t, 'C18', 0);
  await run(t, 'cell.set', {cell: `${r.sheet}!B17`, input: '500'});
  assert.notEqual(v(t, 'C18', 0), before);
  assert.equal(v(t, 'D1', 0), null, 'no bounds without the confidence interval');
});

test('the history and the periods are capped', async () => {
  assert.equal(defaultPeriods(16), 6);
  assert.equal(defaultPeriods(1_200), 400);
  assert.equal(defaultPeriods(3_000), 166);
  assert.equal(defaultPeriods(100_000), 5);
  assert.equal(maxPeriods(10), MAX_PERIODS);
  assert.equal(maxPeriods(0), MAX_PERIODS);
  for (const h of [1, 2, 3, 50, 51, 1_000, 1_300, 3_000, 10_000, 100_000, 2 ** 40]) {
    const [d, m] = [defaultPeriods(h), maxPeriods(h)];
    assert.ok(d >= 1 && d <= m && m <= MAX_PERIODS, `${h}: ${d} ${m}`);
    assert.ok(h * m <= Math.max(MAX_WORK, h), String(h));
  }
  const t = await session();
  const rows = [['t', 'y']];
  for (let i = 1; i <= 1_300; i++) rows.push([i, (i % 7) + i * 0.5]);
  await run(t, 'range.setValues', {range: 'A1', values: rows});
  const sheets = t.content.sheets.length;
  const cap = maxPeriods(1_300); // 384
  assert.match((await fails(t, 'data.forecastSheet', {range: 'A1:B1301', periods: cap + 1})).message, /from 1 to 384/);
  assert.match((await fails(t, 'data.forecastSheet', {range: 'A1:B1301', end: 1_300 + cap + 1})).message, /at most 384/);
  await fails(t, 'data.forecastSheet', {range: 'A1:B1301', periods: 10_000});
  assert.equal(t.content.sheets.length, sheets);
  // More history rows than MAX_HISTORY are refused.
  const big = MAX_HISTORY + 2;
  await fails(t, 'data.forecastSheet', {timeline: `A1:A${big}`, values: `B1:B${big}`});
  assert.equal(t.content.sheets.length, sheets);
});

test('parameters: end, no bounds, seasonality, fill, aggregate and the column chart', async () => {
  const t = await withHistory();
  const r = await run(t, 'data.forecastSheet', {timeline: 'A2:A17', values: 'B2:B17', end: '22', confidenceInterval: false, seasonality: 4, fillMissing: 'zeros', aggregate: 'sum', chart: 'column'});
  assert.equal(r.periods, 6);
  assert.equal(v(t, 'B1', 0), 'Values', 'no header: the names are Timeline and Values');
  assert.equal(v(t, 'A1', 0), 'Timeline');
  assert.equal(fOf(t, 'C18'), 'FORECAST.ETS(A18,$B$2:$B$17,$A$2:$A$17,4,0,7)');
  assert.equal(v(t, 'D1', 0), null);
  const chart = t.content.sheets[0].charts[0];
  assert.equal(chart.kind, 'columnClustered', 'no bounds: plain columns');
  assert.equal(chart.series.length, 2);
  // With bounds the column chart is a combo: columns and lines.
  const r2 = await run(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', periods: 2, chart: 'column'});
  const combo = t.content.sheets[sheetOf(t, r2)].charts[0];
  assert.equal(combo.kind, 'combo');
  assert.deepEqual(combo.series.map(x => x.kind), ['columnClustered', 'columnClustered', 'line', 'line']);
  // Percent text, whole percents and a typed date end.
  await run(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', periods: 1, confidence: '90%'});
  assert.equal(fOf(t, 'D18'), 'C18-FORECAST.ETS.CONFINT(A18,$B$2:$B$17,$A$2:$A$17,0.9,1,1)');
  await run(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', periods: 1, confidence: 99});
  assert.match(fOf(t, 'D18'), /,0\.99,1,1\)$/);
});

test('errors: end before the data, bad seasonality, one column, an uneven timeline, bad parameters', async () => {
  const t = await withHistory();
  const sheets = t.content.sheets.length;
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', end: 3});
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', seasonality: 9000});
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', seasonality: 1.5});
  assert.match((await fails(t, 'data.forecastSheet', {range: 'Sheet1!B1:B17'})).message, /Select a timeline column/);
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', fillMissing: 'nonsense'});
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', aggregate: 'nonsense'});
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', chart: 'pie'});
  await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', confidence: 0});
  await fails(t, 'data.forecastSheet', {timeline: 'A2:A17'});
  await fails(t, 'data.forecastSheet', {timeline: 'A2:B17', values: 'B2:B17'});
  assert.equal(t.content.sheets.length, sheets, 'nothing was built');
  await run(t, 'cell.set', {cell: 'A5', input: '4.5'});
  assert.match((await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17'})).message, /constant step/);
  await run(t, 'cell.set', {cell: 'A5', input: 'abc'});
  assert.match((await fails(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17'})).message, /A5 isn't one/);
  assert.equal(t.content.sheets.length, sheets);
});

test('Forecast Start hindcasts over the actuals', async () => {
  const t = await withHistory(); // t = 1..16 in A2:A17
  const r = await run(t, 'data.forecastSheet', {range: 'A1:B17', forecastStart: 13, periods: 2, confidenceInterval: false});
  assert.equal(r.fitted, 12);
  // Fit to t = 1..12 (rows 2..13); the line joins at row 13 and forecasts rows 14..19.
  assert.equal(fOf(t, 'C13'), 'B13');
  assert.equal(v(t, 'C13', 0), v(t, 'B13', 0));
  assert.equal(fOf(t, 'C14'), 'FORECAST.ETS(A14,$B$2:$B$13,$A$2:$A$13,1,1)');
  assert.equal(fOf(t, 'C19'), 'FORECAST.ETS(A19,$B$2:$B$13,$A$2:$A$13,1,1)');
  // The exact seasonal series is recovered, and the actual is still shown next to it.
  assert.ok(Math.abs(v(t, 'C14', 0) - 39) < 1e-6, String(v(t, 'C14', 0))); // t = 13: 10 + 26 + 3
  assert.equal(typeof v(t, 'B14', 0), 'number');
  // Start at the last point or one step later: as without forecastStart.
  for (const start of [16, 17, '16']) {
    const r2 = await run(t, 'data.forecastSheet', {range: 'Sheet1!A1:B17', forecastStart: start, periods: 2});
    assert.equal(r2.fitted, 16);
  }
  assert.equal(fOf(t, 'C18'), 'FORECAST.ETS(A18,$B$2:$B$17,$A$2:$A$17,1,1)');
});

test('an invalid Forecast Start is an error and builds nothing', async () => {
  const t = await withHistory();
  const sheets = t.content.sheets.length;
  for (const bad of [0, 2, 3.5, 18, 1000, 'abc', [1], 1e308]) await fails(t, 'data.forecastSheet', {range: 'A1:B17', forecastStart: bad});
  assert.equal(t.content.sheets.length, sheets);
  // Blank or null behaves like no start.
  const r = await run(t, 'data.forecastSheet', {range: 'A1:B17', forecastStart: ''});
  assert.equal(r.fitted, 16);
});

test('monthly dates: the forecast rows continue the calendar and the timeline keeps its format', async () => {
  const t = await session();
  const rows = [['Month', 'Units']];
  for (let i = 0; i < 12; i++) rows.push([serialFromYmd(D1900, 2024, i + 1, 1), 100 + 5 * i]);
  await run(t, 'range.setValues', {range: 'A1', values: rows});
  await run(t, 'format.numberFormat', {range: 'A2:A13', format: 'yyyy-mm-dd'}).catch(() => {});
  const r = await run(t, 'data.forecastSheet', {range: 'A1:B13', end: '2025-03-01', seasonality: 0, confidenceInterval: false});
  assert.equal(r.periods, 3);
  assert.equal(v(t, 'A14', 0), serialFromYmd(D1900, 2025, 1, 1));
  assert.equal(v(t, 'A16', 0), serialFromYmd(D1900, 2025, 3, 1));
  close(v(t, 'C14', 0), 160, 1e-8);
  close(v(t, 'C16', 0), 170, 1e-8);
});

test('a protected workbook structure refuses; the selection supplies the source', async () => {
  const t = await withHistory();
  await run(t, 'selection.set', {range: 'A1'});
  const r = await run(t, 'data.forecastSheet', {periods: 1});
  assert.equal(r.history, 16, 'the block around the active cell');
  const t2 = await withHistory();
  await run(t2, 'selection.set', {range: 'A1:B9'});
  const r2 = await run(t2, 'data.forecastSheet', {periods: 1});
  assert.equal(r2.history, 8, 'the selected block (its header row included)');
  const t3 = await withHistory();
  await run(t3, 'review.protectWorkbook', {structure: true}).catch(() => {});
  if (t3.content.protection?.structure) assert.match((await fails(t3, 'data.forecastSheet', {range: 'A1:B17'})).message, /protected/);
});

test('the dialog model starts from the selection and submits the command', async () => {
  const {default: dialog} = await import('../../core/grid/dialogs/forecastSheet.mjs');
  const t = await withHistory();
  await run(t, 'selection.set', {range: 'A1'});
  const ctx = t.session.readContext(t.docId);
  const init = dialog.init(ctx);
  assert.equal(init.chart, 'line');
  assert.equal(init.timeline, 'Sheet1!$A$1:$A$17');
  assert.equal(init.values, 'Sheet1!$B$1:$B$17');
  assert.equal(init.confidenceInterval, true);
  assert.equal(init.seasonality, '');
  assert.equal(init.seasonalityMode, 'auto');
  assert.equal(init.statistics, false);
  assert.ok(init.end, 'a proposed forecast end');
  assert.deepEqual(dialog.validate(init), []);
  const cmd = dialog.toCommand({...init, end: '24', confidence: '90', seasonalityMode: 'manual', seasonality: '4', statistics: true, chart: 'column'});
  assert.equal(cmd.command, 'data.forecastSheet');
  assert.equal(cmd.params.end, '24');
  assert.equal(cmd.params.confidence, '90');
  assert.equal(cmd.params.seasonality, 4);
  assert.equal(cmd.params.chart, 'column');
  assert.equal(cmd.params.statistics, true);
  assert.equal(cmd.params.timeline, 'Sheet1!$A$1:$A$17');
  const r = await run(t, cmd.command, dialog.toCommand(init).params);
  assert.equal(r.history, 16);
  const bad = dialog.validate({...init, end: ''});
  assert.ok(bad.some(e => e.field === 'end'));
  assert.ok(dialog.validate({...init, seasonalityMode: 'manual', seasonality: '1'}).some(e => e.field === 'seasonality'));
  assert.ok(dialog.validate({...init, confidence: '120'}).some(e => e.field === 'confidence'));
  const preview = dialog.preview(t.session.readContext(t.docId), init);
  assert.ok(preview && preview.prims.length > 5, 'a drawn preview of the forecast chart');
});

test('a forecast sheet round trips through .xlsx: the functions keep their _xlfn prefix, the table and the combo chart stay', async () => {
  const {default: JSZip} = await import('jszip');
  const {writeXlsx} = await import('../../core/grid/formats/xlsx-write.mjs');
  const {readXlsx} = await import('../../core/grid/formats/xlsx-read.mjs');
  const t = await withHistory();
  const r = await run(t, 'data.forecastSheet', {range: 'A1:B17', periods: 3, statistics: true, chart: 'column'});
  const bytes = await writeXlsx(t.content);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<f>_xlfn\.FORECAST\.ETS\(A18,\$B\$2:\$B\$17,\$A\$2:\$A\$17,1,1\)<\/f>/);
  assert.match(xml, /_xlfn\.FORECAST\.ETS\.CONFINT\(/);
  assert.match(xml, /_xlfn\.FORECAST\.ETS\.STAT\(/);
  const back = await readXlsx(bytes);
  const sheet = back.sheets.find(x => x.name === r.sheet);
  assert.equal(sheet.tables.length, 1);
  assert.equal(sheet.charts.length, 1);
  assert.equal(sheet.charts[0].kind, 'combo');
  assert.deepEqual(sheet.charts[0].series.map(x => x.kind), ['columnClustered', 'columnClustered', 'line', 'line']);
  const s2 = await session(back);
  assert.ok(Math.abs(v(s2, 'C18', 0) - 47) < 1e-6);
  assert.match(stored(s2, 'C18', 0).f, /^FORECAST\.ETS\(/);
});
