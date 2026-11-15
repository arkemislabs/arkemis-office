// Create Forecast Worksheet dialog model (submit: data.forecastSheet).
// Excel's Create Forecast Worksheet (line or column chart, Forecast End, and under Options: Forecast
// Start, Confidence Interval, Seasonality detected automatically or set manually, Include forecast
// statistics, Timeline Range, Values Range, Fill Missing Points Using, Aggregate Duplicates Using) on
// gridcraft's cmd/forecast.rs (`forecast_sheet`) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT,
// see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: chart (line|column), end (text; the proposed end is the timeline's next third), endShown and
// endValue (what was proposed, so an untouched end is sent as its number), forecastStart, confidenceInterval,
// confidence (percent, text), seasonalityMode (auto|manual), seasonality (the length when manual; 0 for none),
// statistics, timeline, values (ranges as `Sheet1!$A$1:$A$17`), fillMissing, aggregate.
// The preview is the chart the sheet gets, drawn from the numbers its formulas would give.

import {defineDialog} from '../../kernel/dialog.mjs';
import {quoteSheet, rangeA1} from '../lib/addr.mjs';
import {formatValue} from '../lib/numfmt.mjs';
import {DEFAULT_THEME} from '../model/style.mjs';
import {render} from '../lib/chart-render.mjs';
import {seriesColor, defaultPalette} from '../lib/chart-resolve.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {planForecast, previewPoints, sourceOf} from '../commands/data/forecast.mjs';

const CMD = 'data.forecastSheet';
const absRange = (content, si, cells) => {
  const [a, b] = [cells[0], cells[cells.length - 1]];
  return `${quoteSheet(content.sheets[si].name)}!${rangeA1({start: {row: a.row, col: a.col}, end: {row: b.row, col: b.col}}).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`;
};

/** The timeline's text for a serial in its number format (a date column shows dates). */
const shown = (x, fmt, sys) => { try { return formatValue(x, fmt, sys).text ?? String(x); } catch { return String(x); } };

const trim = v => String(v ?? '').trim();
const percent = v => { const t = trim(v).replace(/%$/, '').trim(); return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN; };

/** The command's params for the dialog's values (blank ranges leave the source to the selection). */
function paramsOf(v) {
  const p = {chart: v.chart === 'column' ? 'column' : 'line'};
  const end = trim(v.end);
  if (end) p.end = end === trim(v.endShown) && typeof v.endValue === 'number' ? v.endValue : end;
  if (trim(v.forecastStart)) p.forecastStart = trim(v.forecastStart);
  p.confidenceInterval = v.confidenceInterval !== false;
  if (p.confidenceInterval) p.confidence = trim(v.confidence) || '95';
  p.seasonality = v.seasonalityMode === 'manual' ? Number(trim(v.seasonality)) : 'auto';
  p.statistics = v.statistics === true;
  if (trim(v.timeline)) p.timeline = trim(v.timeline);
  if (trim(v.values)) p.values = trim(v.values);
  p.fillMissing = v.fillMissing === 'zeros' ? 'zeros' : 'interpolate';
  p.aggregate = trim(v.aggregate) || 'average';
  return p;
}

export default defineDialog({
  id: 'dialog.forecastSheet',
  title: 'Create Forecast Worksheet',
  command: CMD,
  init(ctx) {
    const out = {chart: 'line', end: '', endShown: '', endValue: null, forecastStart: '', confidenceInterval: true, confidence: '95',
      seasonalityMode: 'auto', seasonality: '', statistics: false, timeline: '', values: '', fillMissing: 'interpolate', aggregate: 'average'};
    try {
      const content = baseDoc(ctx);
      const src = sourceOf(ctx, content, {});
      out.timeline = absRange(content, src.si, src.tcells);
      out.values = absRange(content, src.si, src.vcells);
      const plan = planForecast(ctx, {});
      const last = plan.future[plan.future.length - 1];
      out.endValue = last;
      out.end = out.endShown = shown(last, plan.tfmt, plan.sys);
    } catch { /* the person fills the ranges in */ }
    return out;
  },
  validate(v) {
    const errors = [];
    const field = (f, message) => errors.push({field: f, message});
    const [t, x] = [trim(v.timeline), trim(v.values)];
    if (!t && x) field('timeline', 'Enter the timeline range.');
    if (t && !x) field('values', 'Enter the values range.');
    if (!trim(v.end)) field('end', 'Enter the date or number the forecast ends at.');
    if (v.confidenceInterval !== false) {
      const c = percent(v.confidence);
      if (!(c > 0 && c < 100)) field('confidence', 'The confidence interval is a percentage between 0 and 100.');
    }
    if (v.seasonalityMode === 'manual') {
      const n = Number(trim(v.seasonality));
      if (!trim(v.seasonality) || !Number.isInteger(n) || n === 1 || n < 0 || n > 8760) field('seasonality', 'Seasonality is 0 for none, or a number of points from 2 to 8,760.');
    }
    return errors;
  },
  toCommand: v => ({command: CMD, params: paramsOf(v)}),
  /** The chart the sheet gets: the actual values, the forecast and its bounds. */
  preview(ctx, v) {
    try {
      const plan = planForecast(ctx, paramsOf(v));
      const pts = previewPoints(plan);
      const theme = baseDoc(ctx).theme ?? DEFAULT_THEME;
      const w = 420, h = 230;
      const fmt = f => (plan[f] ?? 'General');
      const columns = v.chart === 'column';
      const mk = (name, values, i, kind) => ({name, values, x: null, sizes: null, color: seriesColor(theme, i), kind, secondary: false, smooth: false, trendlines: [], numberFormat: fmt('vfmt')});
      const kindOf = i => (columns ? (i < 2 ? 'columnClustered' : 'line') : 'line');
      const list = [[plan.vname, pts.actual], [`Forecast(${plan.vname})`, pts.forecast]];
      if (plan.opts.confidence !== null) list.push(['Lower Confidence Bound', pts.lower], ['Upper Confidence Bound', pts.upper]);
      const data = {
        categories: pts.times.map(t => shown(t, plan.tfmt, plan.sys)), categoryLevels: [],
        series: list.map(([name, values], i) => mk(name, values, i, kindOf(i))),
        palette: defaultPalette(theme, pts.times.length),
      };
      const chart = {kind: columns ? (list.length > 2 ? 'combo' : 'columnClustered') : 'line', series: list.map((_, i) => ({kind: kindOf(i)})), legend: 'bottom', gridlines: true, dataLabels: false, style: 1};
      return {w, h, prims: render(chart, data, w, h)};
    } catch (e) { return {w: 0, h: 0, prims: [], error: String(e?.message ?? 'No preview')}; }
  },
});
