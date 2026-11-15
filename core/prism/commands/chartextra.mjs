// Chart Design › Add Chart Element, the elements the chart engine did not draw: Axes, Data Table, Error Bars, Lines, Trendline and
// Up/Down Bars; and Chart Format › Reset to Match Style. PowerPoint's behaviour, not checked against upstream (deckcraft has none of them).
//
// `chart.element` sets one element on the selected charts: `axes {h?, v?}` (the bottom and left axis), `dataTable` (the values under the
// chart), `errorBars` (none, standardError, percentage, standardDeviation), `lines` (none, drop, highLow), `trendline` (none, linear,
// exponential, linearForecast, movingAverage), `upDownBars`. They are kept in the chart's `elements` (core/prism/lib/chart-extra.mjs draws
// them; the chart part carries them in this app's own extension). Like every chart command it drops the chart's kept `raw` part.
// Refresh Data stays hidden: a chart keeps its data in its own worksheet, with no external file to read it from again.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, editShapes} from '../lib/shape-common.mjs';
import {selectedShapes} from '../lib/format-text.mjs';
import {isSchema2} from '../model/doc.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/model/src/chart.rs']};
const noChart = {enabled: false, reason: 'select a chart'};
const charts = ctx => (isSchema2(ctx.doc) ? selectedShapes(ctx).filter(sh => sh.kind?.type === 'chart') : []);
const onChart = ctx => (charts(ctx).length ? {enabled: true} : noChart);
const ERROR_BARS = ['none', 'standardError', 'percentage', 'standardDeviation'];
const LINES = ['none', 'drop', 'highLow'];
const TRENDS = {none: null, linear: {type: 'linear'}, exponential: {type: 'exponential'}, linearForecast: {type: 'linear', forward: 2}, movingAverage: {type: 'movingAverage', period: 2}};
const CARTESIAN = ['column', 'stackedColumn', 'percentColumn', 'line', 'stackedLine', 'lineMarkers', 'bar', 'stackedBar', 'percentBar', 'area', 'stackedArea', 'scatter', 'bubble', 'combo', 'stock'];
const LINE_TYPES = ['line', 'stackedLine', 'lineMarkers', 'combo'];

function element(ctx, p) {
  const C = 'chart.element';
  if (p.errorBars !== undefined && !ERROR_BARS.includes(p.errorBars)) throw bad(C, '`errorBars` is none, standardError, percentage or standardDeviation');
  if (p.lines !== undefined && !LINES.includes(p.lines)) throw bad(C, '`lines` is none, drop or highLow');
  if (p.trendline !== undefined && !Object.hasOwn(TRENDS, p.trendline)) throw bad(C, '`trendline` is none, linear, exponential, linearForecast or movingAverage');
  editShapes(ctx, p, C, sh => {
    if (sh.kind?.type !== 'chart') throw bad(C, 'not a chart');
    const c = {...sh.kind};
    const type = c.chartType;
    const el = {...(c.elements ?? {})};
    const axes = {...(p.axes && typeof p.axes === 'object' ? p.axes : {}), ...(typeof p.axesH === 'boolean' ? {h: p.axesH} : {}), ...(typeof p.axesV === 'boolean' ? {v: p.axesV} : {})};
    if (Object.keys(axes).length) {
      if (!CARTESIAN.includes(type)) throw bad(C, 'this chart has no axes');
      el.axes = {...(el.axes ?? {}), ...(typeof axes.h === 'boolean' ? {h: axes.h} : {}), ...(typeof axes.v === 'boolean' ? {v: axes.v} : {})};
      if (el.axes.h !== false && el.axes.v !== false) delete el.axes;
    }
    if (typeof p.dataTable === 'boolean') {
      if (!CARTESIAN.includes(type) || ['stock', 'bubble', 'scatter'].includes(type)) throw bad(C, 'this chart has no data table');
      if (p.dataTable) el.dataTable = true; else delete el.dataTable;
    }
    if (p.errorBars !== undefined) {
      if (!['column', 'line', 'lineMarkers', 'combo'].includes(type)) throw bad(C, 'error bars are drawn on column and line charts');
      if (p.errorBars === 'none') delete el.errorBars; else el.errorBars = p.errorBars;
    }
    if (p.lines !== undefined) {
      if (!LINE_TYPES.includes(type)) throw bad(C, 'lines are drawn on line charts');
      if (p.lines === 'none') delete el.lines; else el.lines = p.lines;
    }
    if (p.trendline !== undefined) {
      if (!['column', 'bar', 'line', 'lineMarkers', 'area', 'scatter', 'bubble'].includes(type)) throw bad(C, 'this chart cannot have a trendline');
      if (p.trendline === 'none') delete el.trendline; else el.trendline = {...TRENDS[p.trendline]};
    }
    if (typeof p.upDownBars === 'boolean') {
      if (!['line', 'lineMarkers', 'combo'].includes(type)) throw bad(C, 'up/down bars are drawn on line charts');
      if (p.upDownBars) el.upDownBars = true; else delete el.upDownBars;
    }
    if (Object.keys(el).length) c.elements = el; else delete c.elements;
    delete c.raw;
    sh.kind = c;
  });
  return {};
}

/** The checked state of an element item: every given option equals the first selected chart's. */
function elementState(ctx, p) {
  const st = onChart(ctx);
  if (!st.enabled) return st;
  const c = charts(ctx)[0].kind, el = c.elements ?? {};
  const type = c.chartType;
  const supported = {
    axes: CARTESIAN.includes(type), dataTable: CARTESIAN.includes(type) && !['stock', 'bubble', 'scatter'].includes(type),
    errorBars: ['column', 'line', 'lineMarkers', 'combo'].includes(type), lines: LINE_TYPES.includes(type),
    trendline: ['column', 'bar', 'line', 'lineMarkers', 'area', 'scatter', 'bubble'].includes(type), upDownBars: ['line', 'lineMarkers', 'combo'].includes(type),
  };
  for (const k of Object.keys(supported)) if (p?.[k] !== undefined && !supported[k]) return {enabled: false, reason: `a ${type} chart has no ${k === 'upDownBars' ? 'up/down bars' : k === 'dataTable' ? 'data table' : k === 'errorBars' ? 'error bars' : k}`};
  const checks = [];
  if (p?.field === 'axesH' || p?.field === 'axesV') return {enabled: supported.axes, checked: el.axes?.[p.field === 'axesH' ? 'h' : 'v'] !== false, ...(supported.axes ? {} : {reason: 'this chart has no axes'})};
  if (p?.axes) checks.push(Object.entries(p.axes).every(([k, v]) => (el.axes?.[k] !== false) === !!v));
  if (p?.dataTable !== undefined) checks.push(!!el.dataTable === !!p.dataTable);
  if (p?.errorBars !== undefined) checks.push((el.errorBars ?? 'none') === p.errorBars);
  if (p?.lines !== undefined) checks.push((el.lines ?? 'none') === p.lines);
  if (p?.trendline !== undefined) {
    const t = el.trendline, w = TRENDS[p.trendline];
    checks.push(!t ? !w : !!w && t.type === w.type && (t.forward ?? 0) === (w.forward ?? 0));
  }
  if (p?.upDownBars !== undefined) checks.push(!!el.upDownBars === !!p.upDownBars);
  return {enabled: true, checked: checks.length ? checks.every(Boolean) : false};
}

export default defineCommands({
  family: 'chartextra',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'chart.element', label: 'Chart Element', risk: 'edit', state: elementState,
      description: '{axes?: {h?: bool, v?: bool}, axesH?: bool, axesV?: bool, dataTable?: bool, errorBars?: none|standardError|percentage|standardDeviation, lines?: none|drop|highLow, trendline?: none|linear|exponential|linearForecast|movingAverage, upDownBars?: bool, id?}: Add Chart Element › Axes, Data Table, Error Bars, Lines, Trendline and Up/Down Bars of the selected chart(s). Not checked against upstream.',
      params: s.object({axes: s.optional(s.any()), axesH: s.optional(s.boolean()), axesV: s.optional(s.boolean()), field: s.optional(s.string({max: 12})), dataTable: s.optional(s.boolean()), errorBars: s.optional(s.string({max: 24})), lines: s.optional(s.string({max: 12})),
        trendline: s.optional(s.string({max: 24})), upDownBars: s.optional(s.boolean()), id: s.optional(s.any()), ids: s.optional(s.array(s.any(), {max: 5000}))}),
      run: element,
    },
    {
      id: 'chart.resetStyle', label: 'Reset to Match Style', risk: 'edit', state: onChart,
      description: '{id?}: Reset to Match Style (Chart Format › Current Selection): take the selected chart(s) back to the look of their chart style: the series\' own colours, the text colour and the chart elements go; the palette of the style stays. Not checked against upstream.',
      params: s.object({id: s.optional(s.any()), ids: s.optional(s.array(s.any(), {max: 5000}))}),
      run(ctx, p) {
        editShapes(ctx, p, 'chart.resetStyle', sh => {
          if (sh.kind?.type !== 'chart') throw bad('chart.resetStyle', 'not a chart');
          const c = {...sh.kind, series: sh.kind.series.map(x => { const o = {...x}; delete o.color; return o; }), textColor: null};
          delete c.elements;
          delete c.raw;
          sh.kind = c;
        });
        return {};
      },
    },
  ],
});
