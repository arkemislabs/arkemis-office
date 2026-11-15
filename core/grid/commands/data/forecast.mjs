// Data > Forecast > Forecast Sheet: a new sheet with the history, a FORECAST.ETS column, the
// FORECAST.ETS.CONFINT confidence bounds, optional FORECAST.ETS.STAT statistics and a chart.
// Translated from gridcraft crates/engine/src/cmd/forecast.rs (`forecast_sheet`, `source`, `options`,
// `steps_to`, `default_periods`, `max_periods`) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT,
// see assets/third-party-licenses/artcraft-reference.txt.
//
// Like Excel, the sheet holds a copy of the timeline and values (sorted by time) and live formulas
// over that copy, so the forecast follows edits to the copied history. With `forecastStart` the model
// is fit to the points before it and the forecast columns run over the actuals from there (hindcast).
// One difference from upstream, which Excel shares: a column chart draws the values and the forecast
// as columns and the confidence bounds as lines (a combo chart); upstream marks the bounds as lines
// on a column chart that draws every series as columns.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, colToLetters, quoteSheet, isSingle, rangeA1} from '../../lib/addr.mjs';
import {display, numberToText} from '../../lib/value.mjs';
import {parseInput} from '../../lib/parse.mjs';
import {engineFor} from '../../model/calc.mjs';
import {styleAt} from '../../model/workbook.mjs';
import {nextSheetName} from '../../model/sheet.mjs';
import {deriveStyle} from '../../model/style.mjs';
import {Timeline, series as etsSeries, fit as etsFit, horizon, optionsFromNumbers, seasonLength} from '../../model/functions/ets.mjs';
import {normInv} from '../../model/functions/special.mjs';
import {GArray} from '../../lib/value.mjs';
import {hasDoc, gridSel, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {bad, failed, baseDoc, valueOf, regionAround, parseRangeText, trimToUsed} from '../../lib/data-common.mjs';
import {nextObjectId} from '../../lib/objects.mjs';

const CMD = 'data.forecastSheet';
const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/forecast.rs']};
/** Most history rows a forecast sheet copies. */
export const MAX_HISTORY = 10_000;
/** Most forecast rows. */
export const MAX_PERIODS = 10_000;
/**
 * Most history rows x forecast rows. Every forecast row holds three ETS formulas that each refit the
 * model over the whole history, so this bounds a sheet's recalculation: 10,000 rows of history get 50
 * forecast rows, 50 rows of history the full 10,000.
 */
export const MAX_WORK = 500_000;
const BLOCK_ROWS = 256;

/** Most forecast rows for `history` rows of history. */
export function maxPeriods(history) {
  const h = Math.max(history, 1);
  return Math.min(MAX_PERIODS, Math.max(1, Math.floor(MAX_WORK / h)));
}
/** Forecast rows by default: a third of the history, within `maxPeriods`. */
export function defaultPeriods(history) {
  return Math.min(maxPeriods(history), Math.max(1, Math.ceil(history / 3)));
}

const RANGE = s.optional(s.string({min: 1, max: 4096}));
const TIME = s.optional(s.union([s.number(), s.string({max: 100})]));

/** The cells of a one-row or one-column range, at most `MAX_HISTORY + 1`: [{row, col}]. */
function lineCells(r) {
  const count = (r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1);
  if (count > MAX_HISTORY + 1) throw bad(CMD, `at most ${MAX_HISTORY} rows of history`);
  const out = [];
  if (r.start.col === r.end.col) for (let row = r.start.row; row <= r.end.row; row++) out.push({row, col: r.start.col});
  else if (r.start.row === r.end.row) for (let col = r.start.col; col <= r.end.col; col++) out.push({row: r.start.row, col});
  else throw bad(CMD, 'the timeline and the values are each one row or one column');
  return out;
}

/** (sheet, timeline cells, value cells) of the params, else of the selection or the block around it. */
export function sourceOf(ctx, content, p) {
  const text = k => (typeof p[k] === 'string' && p[k].trim() ? p[k].trim() : null);
  const active = gridSel(ctx).sheet;
  const [t, v] = [text('timeline'), text('values')];
  if (t && v) {
    const a = parseRangeText(content, t, CMD, active), b = parseRangeText(content, v, CMD, active);
    if (a.sheet !== b.sheet) throw bad(CMD, 'the timeline and the values must be on one sheet');
    return {si: a.sheet, tcells: lineCells(a.range), vcells: lineCells(b.range), trange: a.range, vrange: b.range};
  }
  if (t || v) throw bad(CMD, 'give both `timeline` and `values`, or neither');
  let si, r;
  const rangeText = text('range');
  if (rangeText) ({sheet: si, range: r} = parseRangeText(content, rangeText, CMD, active));
  else {
    const sel = gridSel(ctx);
    si = sel.sheet;
    const cur = sel.ranges[sel.ranges.length - 1];
    r = isSingle(cur) ? regionAround(content, si, sel.active) : trimToUsed(content, si, cur);
  }
  if (r.end.col - r.start.col + 1 < 2) throw failed('Select a timeline column and a values column for the forecast.');
  const col = c => ({start: {row: r.start.row, col: c}, end: {row: r.end.row, col: c}});
  const [tr, vr] = [col(r.start.col), col(r.start.col + 1)];
  return {si, tcells: lineCells(tr), vcells: lineCells(vr), trange: tr, vrange: vr};
}

/** A number parameter given as a number or as text (`95%`, ` 0.9 `); null when absent or blank. */
function number(p, key) {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const body = t.replace(/%$/, '').trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body)) throw bad(CMD, `\`${key}\` is not a number`);
    return Number(body);
  }
  throw bad(CMD, `\`${key}\` is not a number`);
}

/** The options of the params: {seasonality (1 = auto), fill (1 interpolate, 0 zeros), aggregate (null or 2-7), confidence (null or 0..1), statistics, columnChart}. */
export function optionsOf(p) {
  const sv = p.seasonality;
  let seasonality;
  if (sv === undefined || sv === null || (typeof sv === 'string' && (!sv.trim() || sv.trim().toLowerCase() === 'auto'))) seasonality = 1;
  else {
    const n = number(p, 'seasonality');
    if (n === null || n !== Math.trunc(n) || n < 0 || n > 8760) throw bad(CMD, '`seasonality` is "auto", 0 (none) or a season length from 2 to 8,760');
    seasonality = n;
  }
  const str = k => (typeof p[k] === 'string' ? p[k].trim().toLowerCase() : null);
  let fill = 1;
  const fm = str('fillMissing');
  if (fm === null || fm === '' || fm === 'interpolate' || fm === 'interpolation') fill = 1;
  else if (fm === 'zeros' || fm === 'zero') fill = 0;
  else throw bad(CMD, `\`fillMissing\` is interpolate or zeros, not \`${fm}\``);
  const AGG = {'': null, average: null, count: 2, counta: 3, max: 4, median: 5, min: 6, sum: 7};
  const ag = str('aggregate');
  if (ag !== null && !(ag in AGG)) throw bad(CMD, `unknown \`aggregate\`: \`${ag}\``);
  const aggregate = ag === null ? null : AGG[ag];
  let confidence = null;
  if (p.confidenceInterval !== false) {
    let c = number(p, 'confidence') ?? 0.95;
    if (c >= 1) c /= 100;
    if (!(c > 0 && c < 1)) throw bad(CMD, '`confidence` is between 0 and 1 (or 0 and 100%)');
    confidence = c;
  }
  const ch = str('chart');
  if (ch !== null && ch !== '' && ch !== 'line' && ch !== 'column') throw bad(CMD, `\`chart\` is line or column, not \`${ch}\``);
  return {seasonality, fill, aggregate, confidence, statistics: p.statistics === true, columnChart: ch === 'column'};
}

/** A timeline value given as a number or as date text; null when absent or blank. */
function timeParam(p, key, sys) {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    const x = parseInput(v.trim(), sys).value;
    if (typeof x === 'number') return x;
    throw bad(CMD, `\`${key}\` is not a number or a date: \`${v}\``);
  }
  throw bad(CMD, `\`${key}\` is not a number or a date`);
}

/** Forecast rows needed to reach `end` (rounded up to whole steps). */
function stepsTo(timeline, end, cap) {
  const steps = timeline.stepsAfterLast(end);
  if (steps === null) throw bad(CMD, '`end` is not on the timeline');
  if (steps < 1e-9) throw failed('The forecast end must be after the last point of the timeline.');
  const k = Math.ceil(steps);
  if (k > cap) throw bad(CMD, `at most ${cap} forecast steps for this much history`);
  return k;
}

/** The numbers every forecast sheet is built from (shared with the dialog's preview): reads the workbook, writes nothing. */
export function planForecast(ctx, p) {
  const opts = optionsOf(p);
  const content = baseDoc(ctx);
  const {si, tcells, vcells, trange, vrange} = sourceOf(ctx, content, p);
  if (tcells.length !== vcells.length) throw bad(CMD, 'the timeline and the values need the same number of cells');
  if (content.protection?.structure) throw failed('The workbook is protected and cannot be changed.');
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const sheet = content.sheets[si];
  requireSchema2(ctx, si);
  const engine = engineFor(content);
  const val = c => valueOf(engine, si, c.row, c.col);
  // A text first cell is the header.
  const header = typeof val(tcells[0]) === 'string' || typeof val(vcells[0]) === 'string';
  const nameOf = (c, fallback) => {
    const v = c ? val(c) : null;
    const t = header && v !== null && v !== undefined ? display(v) : '';
    return t || fallback;
  };
  const [tname, vname] = [nameOf(tcells[0], 'Timeline'), nameOf(vcells[0], 'Values')];
  const skip = header ? 1 : 0;
  const rows = [];
  for (let i = skip; i < tcells.length; i++) {
    const [tv, vv] = [val(tcells[i]), val(vcells[i])];
    if (typeof tv === 'number') rows.push([tv, typeof vv === 'number' ? vv : null]);
    else if ((tv === null || tv === undefined) && (vv === null || vv === undefined)) continue;
    else throw failed(`The timeline must hold numbers or dates (${a1(tcells[i].row, tcells[i].col)} isn't one).`);
  }
  rows.sort((x, y) => x[0] - y[0]);
  const times = rows.map(r => r[0]);
  const timeline = Timeline.detect(times, sys);
  if (!timeline) throw failed('The timeline needs at least two points a constant step apart.');
  if (!rows.some(r => r[1] !== null)) throw failed('There are no values to forecast.');
  const end = timeParam(p, 'end', sys);
  // Forecast Start: the index (into `rows`) of the first forecast point, or `rows.length` for the usual forecast after the history.
  let fit = rows.length;
  const start = timeParam(p, 'forecastStart', sys);
  if (start !== null) {
    const lastT = times[times.length - 1];
    const tol = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1);
    const next = timeline.afterLast(1);
    if (!(tol(start, lastT) || (next !== null && tol(start, next)))) {
      const i = times.findIndex(t => tol(t, start));
      if (i < 0) throw bad(CMD, '`forecastStart` is not on the timeline (it is a point of the history, before its last point)');
      if (rows.slice(0, i).filter(r => r[1] !== null).length < 2) throw failed('The forecast start needs at least two values before it to fit the forecast.');
      fit = i;
    }
  }
  const cap = maxPeriods(rows.length);
  let periods;
  if (end !== null) periods = stepsTo(timeline, end, cap);
  else {
    const n = number(p, 'periods');
    if (n === null) periods = defaultPeriods(rows.length);
    else if (n >= 1 && Math.ceil(n) <= cap) periods = Math.ceil(n);
    else throw bad(CMD, `\`periods\` is from 1 to ${cap} for ${rows.length} rows of history`);
  }
  const future = [];
  for (let k = 1; k <= periods; k++) {
    const t = timeline.afterLast(k);
    if (t === null) throw bad(CMD, 'the forecast runs past the last date');
    future.push(t);
  }
  const fmtOf = c => (c ? styleAt(content, sheet, c.row, c.col).numFmt : 'General');
  return {content, si, sys, opts, header, tname, vname, rows, times, timeline, fit, periods, future, tfmt: fmtOf(tcells[skip]), vfmt: fmtOf(vcells[skip]), trange, vrange};
}

/**
 * What the sheet's columns would hold, computed the way its formulas compute them (the dialog's
 * preview): {times, actual, forecast, lower, upper} per row of history and forecast; forecast, lower
 * and upper are null before the point the forecast starts at.
 */
export function previewPoints(plan) {
  const {rows, fit, future, opts, sys} = plan;
  const head = rows.slice(0, fit);
  const o = optionsFromNumbers(opts.seasonality, opts.fill, opts.aggregate);
  const sr = etsSeries(GArray.column(head.map(r => r[1])), GArray.column(head.map(r => r[0])), o, sys);
  const model = etsFit(sr.y, seasonLength(o, sr.y));
  const z = opts.confidence === null ? null : normInv((1 + opts.confidence) / 2);
  const times = [...rows.map(r => r[0]), ...future];
  const actual = [...rows.map(r => r[1]), ...future.map(() => null)];
  const forecast = [], lower = [], upper = [];
  times.forEach((t, i) => {
    if (i < fit - 1) { forecast.push(null); lower.push(null); upper.push(null); return; }
    if (i === fit - 1) { const y = rows[i][1]; forecast.push(y); lower.push(z === null ? null : y); upper.push(z === null ? null : y); return; }
    const h = horizon(sr, t);
    const f = model.forecast(h);
    forecast.push(f);
    if (z === null) { lower.push(null); upper.push(null); } else { const d = z * model.forecastSd(h); lower.push(f - d); upper.push(f + d); }
  });
  return {times, actual, forecast, lower, upper};
}

const colRef = c => colToLetters(c);
/** A number as formula text (never exponent notation). */
const numText = x => (/e/i.test(String(x)) ? numberToText(x) : String(x));
const keyOf = (row, col) => colToLetters(col) + (row + 1);

function forecastSheet(ctx, p) {
  const plan = planForecast(ctx, p);
  const {content, si, opts, rows, fit, periods, future, tname, vname} = plan;
  const n = rows.length;
  const last = n + 1; // 1-based row of the last history point
  const fitLast = fit + 1; // 1-based row of the last point the model is fit to
  const endRow = last + periods; // 1-based row of the last forecast
  const sheetName = nextSheetName(content);
  const taken = new Set(content.sheets.flatMap(sh => (sh.tables ?? []).map(t => t.name.toLowerCase())));
  const names = new Set((content.names ?? []).map(x => String(x.name).toLowerCase()));
  let tableName = 'Table';
  for (let k = 1; ; k++) if (!taken.has(`table${k}`) && !names.has(`table${k}`)) { tableName = `Table${k}`; break; }
  const chartId = nextObjectId(content);

  const hist = c => `$${colRef(c)}$2:$${colRef(c)}$${fitLast}`;
  let tail = `${opts.seasonality},${opts.fill}`;
  if (opts.aggregate !== null) tail += `,${opts.aggregate}`;
  const headers = [tname, vname, `Forecast(${vname})`];
  if (opts.confidence !== null) { headers.push(`Lower Confidence Bound(${vname})`); headers.push(`Upper Confidence Bound(${vname})`); }
  // Table column names are unique.
  for (let i = 1; i < headers.length; i++) {
    const base = headers[i];
    let name = base, k = 2;
    while (headers.slice(0, i).some(h => h.toLowerCase() === name.toLowerCase())) name = `${base}${k++}`;
    headers[i] = name;
  }
  const width = headers.length;
  const statsCol = width + 1;
  const chartCol = opts.statistics ? statsCol + 3 : width + 1;

  const at = gridSel(ctx).sheet;
  // The new sheet goes before the active one, which Insert Sheet makes the active sheet (its A1 selected).
  const inserted = ctx.run('home.insertSheet', {name: sheetName, before: at});
  const ni = inserted?.index ?? at;
  requireSchema2(ctx, ni);
  const bold = deriveStyle(ctx.change, content, 0, {font: {bold: true}});
  const tstyle = deriveStyle(ctx.change, content, 0, {numFmt: plan.tfmt});
  const vstyle = deriveStyle(ctx.change, content, 0, {numFmt: plan.vfmt});

  const blocks = {};
  const put = (row, col, cell) => {
    const b = Math.floor(row / BLOCK_ROWS);
    (blocks[b] ??= {})[keyOf(row, col)] = cell;
  };
  const value = (row, col, v, style) => put(row, col, style ? {v, s: style} : {v});
  const formula = (row, col, f, style) => put(row, col, style ? {f, s: style} : {f});
  headers.forEach((h, c) => value(0, c, h, 0));
  rows.forEach(([t, v], i) => {
    const r = i + 1;
    value(r, 0, t, tstyle);
    if (v !== null) value(r, 1, v, vstyle);
  });
  // The last point the model is fit to starts the forecast lines, so they join the values.
  const join = fitLast - 1; // 0-based row
  formula(join, 2, `B${fitLast}`, vstyle);
  if (opts.confidence !== null) {
    formula(join, 3, `C${fitLast}`, vstyle);
    formula(join, 4, `C${fitLast}`, vstyle);
  }
  const [tl, vl] = [hist(0), hist(1)];
  const forecastRow = r => {
    formula(r - 1, 2, `FORECAST.ETS(A${r},${vl},${tl},${tail})`, vstyle);
    if (opts.confidence !== null) {
      const ci = `FORECAST.ETS.CONFINT(A${r},${vl},${tl},${numText(opts.confidence)},${tail})`;
      formula(r - 1, 3, `C${r}-${ci}`, vstyle);
      formula(r - 1, 4, `C${r}+${ci}`, vstyle);
    }
  };
  // Hindcast: forecasts over the actuals from the fit point to the last history point.
  for (let r = fitLast + 1; r <= last; r++) forecastRow(r);
  future.forEach((t, k) => {
    const r = last + k + 1; // 1-based
    value(r - 1, 0, t, tstyle);
    forecastRow(r);
  });
  if (opts.statistics) {
    value(0, statsCol, 'Statistic', bold);
    value(0, statsCol + 1, 'Value', bold);
    ['Alpha', 'Beta', 'Gamma', 'MASE', 'SMAPE', 'MAE', 'RMSE'].forEach((label, k) => {
      value(k + 1, statsCol, label, 0);
      formula(k + 1, statsCol + 1, `FORECAST.ETS.STAT(${vl},${tl},${k + 1},${tail})`, 0);
    });
  }
  const sheet = ctx.doc.sheets[ni];
  ctx.change.set(['sheets', ni, 'blocks'], blocks);
  const cols = {};
  for (let c = 0; c < width; c++) cols[c] = {size: c < 2 ? 90 : c === 2 ? 130 : 230};
  ctx.change.set(['sheets', ni, 'cols'], cols);
  const range = {start: {row: 0, col: 0}, end: {row: endRow - 1, col: width - 1}};
  const table = {
    name: tableName, range: rangeA1(range), headerRow: true, totalsRow: false, columns: headers.map(h => ({name: h})),
    style: {name: 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false, showFirstColumn: false, showLastColumn: false}, autoFilter: true,
  };
  setIn(ctx.change, ['sheets', ni, 'tables'], [...(sheet.tables ?? []), table]);
  const q = quoteSheet(sheetName);
  const colRange = c => `${q}!$${colRef(c)}$2:$${colRef(c)}$${endRow}`;
  const series = [];
  // A column chart draws the values and the forecast as columns and the bounds as lines (a combo chart); without bounds it is plain columns.
  const combo = opts.columnChart && width > 3;
  for (let c = 1; c < width; c++) {
    const se = {name: `${q}!$${colRef(c)}$1`, categories: colRange(0), values: colRange(c)};
    if (combo) se.kind = c >= 3 ? 'line' : 'columnClustered';
    series.push(se);
  }
  const chart = {
    id: chartId, kind: opts.columnChart ? (combo ? 'combo' : 'columnClustered') : 'line',
    anchor: {cell: a1(1, chartCol), dx: 0, dy: 0, width: 480, height: 288, mode: 'moveAndSize'},
    series, legend: 'bottom', dataLabels: false, gridlines: true, style: 1, byRows: false,
  };
  setIn(ctx.change, ['sheets', ni, 'charts'], [...(sheet.charts ?? []), chart]);
  return {sheet: sheetName, table: tableName, chart: chartId, history: n, periods, fitted: fit};
}

export default defineCommands({
  family: 'data/forecast',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: CMD, label: 'Forecast Sheet', risk: 'edit', dialog: 'dialog.forecastSheet',
      description: 'Forecast Sheet (Data > Forecast). timeline? "A2:A25" and values? "B2:B25" (default: the first two columns of `range`, the selection or the current region; a text first cell is the header), end? (a timeline value or date text) or periods? (default: a third of the history, at least 1; at most 10,000, and history x periods at most 500,000; history at most 10,000 rows), forecastStart? (a timeline value or date text on the history, before its last point: the model is fit to the points before it and the forecast columns start there and run over the actuals; the default and the last point forecast after the history), confidenceInterval? (default true), confidence? (0.95 or 95), seasonality? ("auto", 0 for none, 2 to 8,760), fillMissing? interpolate|zeros, aggregate? average|count|counta|max|median|min|sum, statistics? (default false), chart? line|column. Inserts a sheet before the active one: timeline, values, Forecast (FORECAST.ETS), Lower and Upper Confidence Bound (FORECAST.ETS.CONFINT), optional FORECAST.ETS.STAT table, and a chart. Returns {sheet, table, chart, history, periods, fitted}.',
      params: s.object({
        timeline: RANGE, values: RANGE, range: RANGE, end: TIME, periods: s.optional(s.union([s.number(), s.string({max: 20})])), forecastStart: TIME,
        confidenceInterval: s.optional(s.boolean()), confidence: s.optional(s.union([s.number(), s.string({max: 20})])),
        seasonality: s.optional(s.union([s.number(), s.string({max: 20})])), fillMissing: s.optional(s.string({max: 20})), aggregate: s.optional(s.string({max: 20})),
        statistics: s.optional(s.boolean()), chart: s.optional(s.string({max: 20})),
      }),
      state: hasDoc,
      run: forecastSheet,
    },
  ],
});
