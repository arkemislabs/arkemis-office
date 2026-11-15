// The chart types and chart elements the shared chart engine (core/grid/lib/chart-render.mjs) does not draw, drawn here over its
// pieces: Filled Radar, Surface and Pareto charts, and the Add Chart Element items Data Table, Error Bars, Lines (drop lines and
// high-low lines) and Up/Down Bars. PowerPoint's behaviour, not checked against upstream (deckcraft lists the three types and
// draws none of them, and has none of the elements). Axes and Trendline are the engine's own (`chart.axes`, a series' `trendlines`).
// No DOM, no Node built-ins.
//
// A chart's elements are `chart.elements = {axes: {h, v}, dataTable, errorBars: 'standardError'|'percentage'|'standardDeviation',
// lines: 'drop'|'highLow', upDownBars, trendline: {type, forward?, period?}}`, all optional.

import {Ctx, Bx, finalize, WHITE, TEXT, GRID, AXIS, TITLE_SIZE, LABEL_SIZE, TAU, chartTitle, legendEntries, drawLegend, valueRange, catLabel, approxMeasure, render} from '../../grid/lib/chart-render.mjs';
import {Fmt, niceScale} from '../../grid/lib/chart-axis.mjs';

/** The chart types drawn here: [id, label, category]. They are not engine kinds: `chartKind` says which engine kind stands in for each in a saved chart part. */
export const EXTRA_TYPES = Object.freeze([['filledRadar', 'Filled Radar', 'Radar'], ['surface', 'Surface', 'Surface'], ['pareto', 'Pareto', 'Histogram']]);
export const isExtra = id => EXTRA_TYPES.some(t => t[0] === id);
/** The engine kind that stands in for an extra type in a chart part (Filled Radar is a radar chart with the filled style). */
export const standInKind = id => ({filledRadar: 'radar', surface: 'area', pareto: 'combo'})[id] ?? null;

const fin = Number.isFinite;

/** The frame every chart has: its box, title and legend; `draw(ctx, area)` draws the plot into what is left. */
function shell(chart, data, w, h, entries, draw, measure = approxMeasure) {
  if (!(fin(w) && fin(h)) || w < 1 || h < 1) return [];
  const ctx = new Ctx(measure);
  ctx.out.push({t: 'rect', x: 0, y: 0, w, h, fill: WHITE, stroke: [GRID, 1], radius: 0});
  const pad = Math.min(10, Math.max(2, Math.min(w, h) * 0.04));
  let area = new Bx(pad, pad, w - 2 * pad, h - 2 * pad);
  const title = chartTitle(chart, data);
  if (title) {
    const size = Math.max(4, Math.min(TITLE_SIZE, h * 0.12));
    ctx.text(w / 2, area.y, ctx.fit(title, size, area.w), size, TEXT, ['center', 'top']);
    const used = size * 1.3 + 4;
    area = area.with({y: area.y + used, h: area.h - used});
  }
  if (entries.length && area.ok() && (chart.legend ?? 'bottom') !== 'none') area = drawLegend(ctx, entries, chart.legend ?? 'bottom', area);
  if (area.ok()) draw(ctx, area);
  return finalize(ctx.out, w, h);
}

const mix = (c, k) => [Math.round(c[0] + (255 - c[0]) * k), Math.round(c[1] + (255 - c[1]) * k), Math.round(c[2] + (255 - c[2]) * k), 255];
const shade = (c, k) => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k), 255];

// ---------------------------------------------------------------------------------------------
// Filled Radar: the radar chart with every series' outline filled (the same web, axes and labels)

function filledRadar(ctx, chart, data, area) {
  const ncat = Math.min(1000, Math.max(data.categories.length, ...data.series.map(s => s.values.length), 0));
  if (ncat === 0) return;
  const labels = Array.from({length: ncat}, (_, j) => catLabel(data, j));
  const lw = Math.min(labels.reduce((m, t) => Math.max(m, ctx.tw(t, LABEL_SIZE)), 0), area.w * 0.2);
  const r = Math.max(0, Math.min(area.w - 2 * (lw + 8), area.h - 2 * (LABEL_SIZE * 1.4 + 6)) / 2);
  if (r < 5) return;
  const cx = area.cx, cy = area.cy;
  const [lo, hi] = valueRange(data.series.flatMap(s => s.values.filter(v => v !== null))) ?? [0, 0];
  const sc = niceScale(lo, hi, true);
  const f = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const ang = j => (j / ncat) * TAU;
  const pt = (a, rr) => [cx + rr * Math.sin(a), cy - rr * Math.cos(a)];
  const ticks = sc.ticks();
  const spacing = r / Math.max(1, ticks.length - 1);
  const every = Math.max(1, Math.ceil((LABEL_SIZE * 1.3) / Math.max(1e-3, spacing)));
  // Series are drawn largest-first so a smaller one stays visible in front of a bigger one.
  const order = data.series.map((s, i) => [i, s.values.reduce((a, v) => a + (v ?? 0), 0)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  for (const i of order) {
    const s = data.series[i];
    const pts = Array.from({length: ncat}, (_, j) => pt(ang(j), sc.frac(s.values[j] ?? sc.min) * r));
    if (pts.length >= 3) ctx.out.push({t: 'poly', pts, fill: [s.color[0], s.color[1], s.color[2], 0x99], stroke: [s.color, 1.5]});
  }
  ticks.forEach((t, ti) => {
    const rr = sc.frac(t) * r;
    if (rr > 0.5 && chart.gridlines !== false) {
      let ring = Array.from({length: ncat}, (_, j) => pt(ang(j), rr));
      if (ncat < 3) ring = Array.from({length: 49}, (_, k) => pt((k / 48) * TAU, rr));
      else ring.push(ring[0]);
      ctx.line(ring, GRID, 0.75);
    }
    if (ti % every === 0) ctx.text(cx - 3, cy - rr, f.format(t, sc.step), LABEL_SIZE * 0.9, TEXT, ['right', 'middle']);
  });
  const step = Math.max(1, Math.ceil(ncat / 72));
  for (let j = 0; j < ncat; j += step) {
    const a = ang(j);
    ctx.line([[cx, cy], pt(a, r)], GRID, 0.75);
    const p = pt(a, r + 6);
    const sa = Math.sin(a), ca = Math.cos(a);
    ctx.text(p[0], p[1], ctx.fit(labels[j] ?? '', LABEL_SIZE, Math.max(lw, 20)), LABEL_SIZE, TEXT, [sa > 0.1 ? 'left' : sa < -0.1 ? 'right' : 'center', ca > 0.1 ? 'bottom' : ca < -0.1 ? 'top' : 'middle']);
  }
}

// ---------------------------------------------------------------------------------------------
// Surface: the values as a landscape (rows are series, columns are categories), drawn as coloured bands of value over an oblique mesh

function surfaceBands(data) {
  const vals = data.series.flatMap(s => s.values.filter(v => v !== null));
  const [lo, hi] = valueRange(vals) ?? [0, 0];
  const sc = niceScale(lo, hi, false);
  const edges = sc.ticks();
  return {sc, edges: edges.length >= 2 ? edges : [sc.min, sc.max]};
}
const bandColor = (data, i) => data.palette[i % Math.max(1, data.palette.length)] ?? [68, 114, 196, 255];

function surface(ctx, chart, data, area) {
  const nr = Math.min(data.series.length, 64), nc = Math.min(Math.max(data.categories.length, ...data.series.map(s => s.values.length), 0), 200);
  if (nr < 2 || nc < 2) return;
  const {sc, edges} = surfaceBands(data);
  const f = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const fmtLabel = e => f.format(e, sc.step);
  const z = (i, j) => sc.frac(data.series[i].values[j] ?? sc.min);
  // Oblique projection: columns run right, rows run back and up; height rises.
  const depth = 0.38, rise = 0.5;
  const spanX = 1 + depth, spanY = rise + depth;
  const k = Math.min(area.w * 0.9 / spanX, area.h * 0.84 / spanY);
  const ox = area.cx - (k * spanX) / 2, oy = area.cy + (k * spanY) / 2 - 0.0;
  const P = (i, j, v) => [ox + k * (j / (nc - 1) + (i / (nr - 1)) * depth), oy - k * (v * rise + (i / (nr - 1)) * depth)];
  // Floor grid.
  for (let i = 0; i < nr; i++) ctx.line([P(i, 0, 0), P(i, nc - 1, 0)], GRID, 0.75);
  for (let j = 0; j < nc; j++) ctx.line([P(0, j, 0), P(nr - 1, j, 0)], GRID, 0.75);
  // Back-to-front quads, each in the colour of the band its mean value falls in.
  const bandOf = v => { let b = 0; for (let e = 1; e < edges.length - 1; e++) if (v >= sc.min + (edges[e] - sc.min)) b = e; return Math.min(b, edges.length - 2); };
  for (let i = nr - 2; i >= 0; i--) {
    for (let j = 0; j < nc - 1; j++) {
      const v = [z(i, j), z(i, j + 1), z(i + 1, j + 1), z(i + 1, j)];
      const mean = (v[0] + v[1] + v[2] + v[3]) / 4;
      const value = sc.min + mean * (sc.max - sc.min);
      const color = bandColor(data, bandOf(value));
      const tilt = 0.85 + 0.15 * Math.sin((j + i) * 0.9);
      ctx.out.push({t: 'poly', pts: [P(i, j, v[0]), P(i, j + 1, v[1]), P(i + 1, j + 1, v[2]), P(i + 1, j, v[3])], fill: shade(color, tilt), stroke: [shade(color, 0.55), 0.6]});
    }
  }
  // Axis labels: categories along the front, series names down the right, values up the left.
  const every = Math.max(1, Math.ceil((LABEL_SIZE * 3) / Math.max(1, (k / (nc - 1)))));
  for (let j = 0; j < nc; j += every) { const p = P(0, j, 0); ctx.text(p[0], p[1] + 3, ctx.fit(catLabel(data, j), LABEL_SIZE, k / Math.max(1, nc / every)), LABEL_SIZE, TEXT, ['center', 'top']); }
  for (let i = 0; i < nr; i++) { const p = P(i, nc - 1, 0); ctx.text(p[0] + 4, p[1], ctx.fit(data.series[i].name, LABEL_SIZE, 60), LABEL_SIZE, TEXT, ['left', 'middle']); }
  for (const t of sc.ticks()) { const p = P(0, 0, sc.frac(t)); ctx.text(p[0] - 4, p[1], fmtLabel(t), LABEL_SIZE, TEXT, ['right', 'middle']); }
}

/** A surface chart's legend: the value bands, each a swatch and the range it covers. */
function surfaceEntries(chart, data) {
  if ((chart.legend ?? 'bottom') === 'none' || data.series.length < 2) return [];
  const {sc, edges} = surfaceBands(data);
  const f = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const out = [];
  for (let e = 0; e < edges.length - 1; e++) out.push([`${f.format(edges[e], sc.step)}-${f.format(edges[e + 1], sc.step)}`, bandColor(data, e), 'box']);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pareto: the first series sorted largest first as columns, with the running share of the total as a line on its own 0-100 % axis

/** The data a Pareto chart draws: categories and values largest first, then a "Cumulative %" line series (secondary axis). */
export function paretoData(data) {
  const s = data.series[0];
  if (!s) return data;
  const n = Math.max(data.categories.length, s.values.length);
  const rows = Array.from({length: n}, (_, j) => ({cat: catLabel(data, j), v: s.values[j] ?? null})).filter(r => r.v !== null && r.v >= 0);
  rows.sort((a, b) => b.v - a.v);
  const total = rows.reduce((a, r) => a + r.v, 0) || 1;
  let run = 0;
  const cum = rows.map(r => { run += r.v; return Math.min(1, run / total); });
  return {
    ...data,
    categories: rows.map(r => r.cat), categoryLevels: [],
    series: [
      {...s, values: rows.map(r => r.v), kind: 'columnClustered', secondary: false, trendlines: []},
      {name: 'Cumulative %', values: cum, x: null, sizes: null, color: data.palette[1] ?? [237, 125, 49, 255], kind: 'lineMarkers', secondary: true, smooth: false, trendlines: [], numberFormat: '0%', axis: {min: 0, max: 1, step: 0.2}},
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The entry point

/**
 * The primitives of an extra type: `chart` is the engine chart (`kind` stands in for the type), `data` the engine data, `type` the extra
 * type id. Pareto goes through the engine's own combo chart on its derived data.
 */
export function renderExtra(type, chart, data, w, h, measure = approxMeasure) {
  if (type === 'pareto') {
    const d = paretoData(data);
    return render({...chart, kind: 'combo', legend: chart.legend ?? 'bottom'}, d, w, h, measure);
  }
  if (type === 'filledRadar') return shell(chart, data, w, h, legendEntries({...chart, kind: 'radar'}, data), (ctx, area) => filledRadar(ctx, chart, data, area), measure);
  if (type === 'surface') return shell(chart, data, w, h, surfaceEntries(chart, data), (ctx, area) => surface(ctx, chart, data, area), measure);
  return [];
}

// ---------------------------------------------------------------------------------------------
// Chart elements drawn over a cartesian plot (the engine calls `chart.onPlot` once the plot is laid out)

const stats = values => {
  const v = values.filter(x => x !== null && x !== undefined && fin(x));
  const n = v.length;
  if (n < 2) return {n, sd: 0, se: 0};
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return {n, sd, se: sd / Math.sqrt(n)};
};

/** How far an error bar reaches above and below a value: Standard Error and Standard Deviation are one amount for the series, Percentage is 5 % of the value. */
export function errorAmount(kind, values, v) {
  if (kind === 'percentage') return Math.abs(v) * 0.05;
  const st = stats(values);
  return kind === 'standardDeviation' ? st.sd : st.se;
}

/** The function the engine calls with the plot: draws error bars, drop or high-low lines and up/down bars. */
export function elementsOnPlot(elements) {
  const e = elements ?? {};
  if (!e.errorBars && !e.lines && !e.upDownBars) return null;
  return ({ctx, data, kinds, horizontal, ncat, cw, center, vpos, scaleOf}) => {
    if (horizontal) return;
    const isLine = i => ['line', 'lineMarkers', 'lineStacked'].includes(kinds[i]);
    const dark = [0x40, 0x40, 0x40, 0xFF];
    // Up/down bars: between the first and the last line series at each category (Line charts with two or more series).
    const lines = data.series.map((_, i) => i).filter(isLine);
    if (e.upDownBars && lines.length >= 2) {
      const first = data.series[lines[0]], last = data.series[lines[lines.length - 1]];
      const w = Math.min(cw * 0.3, 22);
      for (let j = 0; j < ncat; j++) {
        const a = first.values[j], b = last.values[j];
        if (a === null || a === undefined || b === null || b === undefined) continue;
        const ya = vpos(a, scaleOf(lines[0])), yb = vpos(b, scaleOf(lines[lines.length - 1]));
        ctx.rect(center(j) - w / 2, Math.min(ya, yb), w, Math.max(Math.abs(ya - yb), 0.75), b >= a ? [198, 224, 180, 255] : [244, 177, 131, 255], [dark, 0.75]);
      }
    }
    // Lines: drop lines run from each point down to the axis; high-low lines join the highest and lowest point of each category.
    if (e.lines === 'drop') {
      for (const i of lines) {
        const s = data.series[i];
        for (let j = 0; j < ncat; j++) {
          const v = s.values[j];
          if (v === null || v === undefined) continue;
          const sc = scaleOf(i);
          ctx.vline(center(j), vpos(v, sc), vpos(Math.max(0, sc.min), sc), AXIS, 0.75);
        }
      }
    } else if (e.lines === 'highLow' && lines.length >= 2) {
      for (let j = 0; j < ncat; j++) {
        const vals = lines.map(i => data.series[i].values[j]).filter(v => v !== null && v !== undefined);
        if (vals.length < 2) continue;
        const sc = scaleOf(lines[0]);
        ctx.vline(center(j), vpos(Math.max(...vals), sc), vpos(Math.min(...vals), sc), dark, 1);
      }
    }
    // Error bars: a bar with caps above and below each point of each column and line series.
    if (e.errorBars) {
      data.series.forEach((s, i) => {
        if (!isLine(i) && kinds[i] !== 'columnClustered') return;
        const sc = scaleOf(i);
        const cap = Math.min(cw * 0.12, 5);
        for (let j = 0; j < ncat; j++) {
          const v = s.values[j];
          if (v === null || v === undefined) continue;
          const d = errorAmount(e.errorBars, s.values, v);
          if (!(d > 0)) continue;
          // A clustered column sits left or right of the slot's centre: the bar is drawn over its own column.
          const clustered = kinds[i] === 'columnClustered';
          const cols = data.series.filter((_, k) => kinds[k] === 'columnClustered').length;
          const k = data.series.slice(0, i).filter((_, q) => kinds[q] === 'columnClustered').length;
          const bw = cw / (cols + 1.5);
          const x = clustered ? center(j) - (cols * bw) / 2 + (k + 0.5) * bw : center(j);
          const yTop = vpos(v + d, sc), yBot = vpos(v - d, sc);
          ctx.vline(x, yTop, yBot, dark, 1);
          ctx.hline(x - cap, x + cap, yTop, dark, 1);
          ctx.hline(x - cap, x + cap, yBot, dark, 1);
        }
      });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Data Table: the values under the chart, one row a series with its legend key, one column a category

/**
 * The prims of a data table in a `w` x `rowsH` strip and the height it needs for `data`. Drawn by the caller below a chart that has
 * the room taken out (and no legend: the keys are in the table).
 */
export function dataTableHeight(data, h) {
  const rows = data.series.length + 1;
  return Math.min(rows * (LABEL_SIZE * 1.7), h * 0.4);
}

export function drawDataTable(data, w, top, height, measure = approxMeasure) {
  const ctx = new Ctx(measure);
  const rows = data.series.length + 1;
  const rowH = height / rows;
  const ncat = Math.max(data.categories.length, ...data.series.map(s => s.values.length), 0);
  if (!ncat || rowH < LABEL_SIZE) return [];
  const nameW = Math.min(Math.max(...data.series.map(s => ctx.tw(s.name, LABEL_SIZE)), 10) + LABEL_SIZE * 2.2, w * 0.3);
  const x0 = 4;
  const colW = (w - nameW - 8) / ncat;
  const fmt = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const left = x0 + nameW;
  // Grid.
  for (let r = 0; r <= rows; r++) ctx.hline(x0, w - 4, top + r * rowH, AXIS, 0.75);
  for (let c = 0; c <= ncat; c++) ctx.vline(left + c * colW, top, top + height, AXIS, 0.75);
  ctx.vline(x0, top, top + height, AXIS, 0.75);
  for (let c = 0; c < ncat; c++) ctx.text(left + (c + 0.5) * colW, top + rowH / 2, ctx.fit(catLabel(data, c), LABEL_SIZE, colW - 4), LABEL_SIZE, TEXT, ['center', 'middle']);
  data.series.forEach((s, r) => {
    const y = top + (r + 1.5) * rowH;
    ctx.rect(x0 + 4, y - LABEL_SIZE * 0.35, LABEL_SIZE * 0.7, LABEL_SIZE * 0.7, s.color);
    ctx.text(x0 + 4 + LABEL_SIZE, y, ctx.fit(s.name, LABEL_SIZE, nameW - LABEL_SIZE * 1.5), LABEL_SIZE, TEXT, ['left', 'middle']);
    for (let c = 0; c < ncat; c++) {
      const v = s.values[c];
      if (v !== null && v !== undefined) ctx.text(left + (c + 0.5) * colW, y, fmt.format(v, 0), LABEL_SIZE, TEXT, ['center', 'middle']);
    }
  });
  return ctx.out;
}
