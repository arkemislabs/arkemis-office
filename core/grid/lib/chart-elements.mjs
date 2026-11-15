// Add Chart Element, the parts gridcraft's chart model has no engine for: Data Table, Error Bars, Lines (drop lines,
// high-low lines, series lines) and Up/Down Bars. The chart stores `dataTable` {keys}, `errorBars` {type, value,
// direction, cap}, `lines` ('drop' | 'highLow' | 'series') and `upDownBars` (true); `axes` {category, value} (false hides
// that axis's labels) is read by `frame` in chart-render.mjs.
// Not in gridcraft: built from what Excel draws (Chart Elements menu), not checked against upstream. U:grid/charts.
// Prim objects as in chart-render.mjs. No DOM, no Node built-ins.

export const ERROR_TYPES = Object.freeze(['fixed', 'percentage', 'standardDeviation', 'standardError']);
export const LINE_TYPES = Object.freeze(['drop', 'highLow', 'series']);
const BAR = [0x40, 0x40, 0x40, 0xFF];
const GRID = [0xD9, 0xD9, 0xD9, 0xFF];
const AXIS = [0xBF, 0xBF, 0xBF, 0xFF];
const TEXT = [0x59, 0x59, 0x59, 0xFF];
const WHITE = [0xFF, 0xFF, 0xFF, 0xFF];
const fin = Number.isFinite;

/** Which of the elements each kind of chart takes (Excel greys out the others). */
export const takes = {
  dataTable: kind => ['columnClustered', 'columnStacked', 'columnStacked100', 'line', 'lineMarkers', 'lineStacked', 'area', 'areaStacked', 'areaStacked100'].includes(kind),
  errorBars: kind => ['columnClustered', 'columnStacked', 'barClustered', 'barStacked', 'line', 'lineMarkers', 'lineStacked', 'area', 'areaStacked', 'scatter', 'scatterLines', 'bubble'].includes(kind),
  lines: (kind, type) => (type === 'drop' ? ['line', 'lineMarkers', 'lineStacked', 'area', 'areaStacked', 'areaStacked100'].includes(kind)
    : type === 'highLow' ? ['line', 'lineMarkers', 'lineStacked'].includes(kind)
      : ['columnStacked', 'columnStacked100', 'barStacked', 'barStacked100'].includes(kind)),
  upDownBars: kind => ['line', 'lineMarkers', 'lineStacked'].includes(kind),
};

/** The sample standard deviation of a series' values (0 for fewer than two). */
export function stdev(values) {
  const v = values.filter(x => x !== null && x !== undefined && fin(x));
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** The amount error bars add and take off a series' point of value `v` (Error Bars: Fixed value, Percentage, Standard Deviation, Standard Error). */
export function errorAmount(eb, values, v) {
  const k = fin(eb?.value) ? eb.value : eb?.type === 'percentage' ? 5 : 1;
  switch (eb?.type) {
    case 'fixed': return Math.abs(k);
    case 'percentage': return Math.abs(v) * Math.abs(k) / 100;
    case 'standardDeviation': return Math.abs(k) * stdev(values);
    case 'standardError': { const n = values.filter(x => x !== null && x !== undefined && fin(x)).length; return n > 0 ? stdev(values) / Math.sqrt(n) : 0; }
    default: return 0;
  }
}

/**
 * Error bars on each series' points. `at(i, j)` is [position along the category axis, the value the bar hangs from, the
 * value] or null; `vpos(value, i)` the position on the value axis; `horizontal` for bars.
 */
export function drawErrorBars(ctx, eb, data, ncat, at, vpos, horizontal) {
  if (!eb || !ERROR_TYPES.includes(eb.type)) return;
  const dir = eb.direction ?? 'both', cap = eb.cap !== false ? 3 : 0;
  data.series.forEach((s, i) => {
    for (let j = 0; j < Math.min(ncat, s.values.length); j++) {
      const v = s.values[j], p = at(i, j);
      if (v === null || v === undefined || !p) continue;
      const err = errorAmount(eb, s.values, v);
      if (!(err > 0)) continue;
      const hi = dir === 'minus' ? p[1] : p[1] + err, lo = dir === 'plus' ? p[1] : p[1] - err;
      const a = vpos(hi, i), b = vpos(lo, i), c = p[0];
      if (horizontal) {
        ctx.hline(Math.min(a, b), Math.max(a, b), c, BAR, 1);
        if (cap) { if (dir !== 'minus') ctx.vline(a, c - cap, c + cap, BAR, 1); if (dir !== 'plus') ctx.vline(b, c - cap, c + cap, BAR, 1); }
      } else {
        ctx.vline(c, Math.min(a, b), Math.max(a, b), BAR, 1);
        if (cap) { if (dir !== 'minus') ctx.hline(c - cap, c + cap, a, BAR, 1); if (dir !== 'plus') ctx.hline(c - cap, c + cap, b, BAR, 1); }
      }
    }
  });
}

/** Rows and size of the data table (a header row of categories, then a row for each series). */
export function tableSize(ctx, data, size) {
  const rowH = size * 1.5;
  const keys = size * 0.8 + 4;
  const nameW = data.series.reduce((m, s) => Math.max(m, ctx.tw(s.name ?? '', size)), 0);
  return {rowH, h: rowH * (data.series.length + 1), nameW: nameW + keys, keys};
}

/** Draws the table under the plot: categories across the top, a row of values per series, legend keys in the first column. */
export function drawDataTable(ctx, chart, data, plot, ncat, nslots, fmtOf, size) {
  const t = tableSize(ctx, data, size);
  const left = plot.x - t.nameW - 4, cw = plot.w / Math.max(1, nslots), top = plot.bottom;
  const rows = data.series.length + 1;
  for (let r = 0; r <= rows; r++) ctx.hline(left, plot.right, top + r * t.rowH, AXIS, 0.75);
  ctx.vline(left, top, top + rows * t.rowH, AXIS, 0.75);
  for (let j = 0; j <= nslots; j++) ctx.vline(plot.x + j * cw, top, top + rows * t.rowH, AXIS, 0.75);
  for (let j = 0; j < Math.min(ncat, nslots); j++) {
    const label = data.categories[j] ?? String(j + 1);
    ctx.text(plot.x + (j + 0.5) * cw, top + t.rowH / 2, ctx.fit(String(label), size, cw - 2), size, TEXT, ['center', 'middle']);
  }
  data.series.forEach((s, i) => {
    const y = top + (i + 1.5) * t.rowH;
    if (chart.dataTable?.keys !== false) ctx.rect(left + 3, y - size * 0.4, size * 0.8, size * 0.8, s.color);
    ctx.text(plot.x - 4, y, ctx.fit(s.name ?? '', size, t.nameW - t.keys), size, TEXT, ['right', 'middle']);
    const fmt = fmtOf(s);
    for (let j = 0; j < Math.min(ncat, nslots); j++) {
      const v = s.values[j];
      if (v !== null && v !== undefined) ctx.text(plot.x + (j + 0.5) * cw, y, ctx.fit(fmt.format(v), size, cw - 2), size, TEXT, ['center', 'middle']);
    }
  });
  ctx.rect(left, top, 0, 0, WHITE);
}

/**
 * Drop lines, high-low lines, series lines and up/down bars. `top(i, j)` is the position of series i's point (its top for
 * stacked ones) on the value axis or null, `base` the axis line, `center(j)` the category position, `slot(i, j)` a column's
 * [start, end] across the category axis (stacked columns).
 */
export function drawLines(ctx, chart, data, ncat, g) {
  const {top, base, center, slot, horizontal, famOf, cw} = g;
  const draw = (c, a, b, color = GRID, w = 1) => (horizontal ? ctx.hline(Math.min(a, b), Math.max(a, b), c, color, w) : ctx.vline(c, Math.min(a, b), Math.max(a, b), color, w));
  const lineSeries = data.series.map((_, i) => i).filter(i => ['line', 'lineStack', 'area', 'areaStack', 'area100'].includes(famOf(i)));
  if (chart.lines === 'drop') {
    for (const i of lineSeries) for (let j = 0; j < ncat; j++) { const t = top(i, j); if (t !== null) draw(center(j), t, base, AXIS, 0.75); }
  } else if (chart.lines === 'highLow' && lineSeries.length >= 2) {
    for (let j = 0; j < ncat; j++) {
      const ts = lineSeries.map(i => top(i, j)).filter(t => t !== null);
      if (ts.length >= 2) draw(center(j), Math.min(...ts), Math.max(...ts), BAR, 1);
    }
  } else if (chart.lines === 'series') {
    data.series.forEach((_, i) => {
      for (let j = 0; j + 1 < ncat; j++) {
        const t0 = top(i, j), t1 = top(i, j + 1), s0 = slot(i, j), s1 = slot(i, j + 1);
        if (t0 === null || t1 === null || !s0 || !s1) continue;
        ctx.line(horizontal ? [[t0, s0[0]], [t1, s1[1]]] : [[s0[1], t0], [s1[0], t1]], AXIS, 0.75);
      }
    });
  }
  if (chart.upDownBars === true && lineSeries.length >= 2) {
    const first = lineSeries[0], last = lineSeries[lineSeries.length - 1], w = Math.max(2, cw * 0.4);
    for (let j = 0; j < ncat; j++) {
      const a = top(first, j), b = top(last, j);
      if (a === null || b === null) continue;
      const up = (data.series[last].values[j] ?? 0) >= (data.series[first].values[j] ?? 0);
      const lo = Math.min(a, b), len = Math.max(1, Math.abs(a - b)), c = center(j);
      const fill = up ? WHITE : BAR;
      if (horizontal) ctx.rect(lo, c - w / 2, len, w, fill, [BAR, 0.75]); else ctx.rect(c - w / 2, lo, w, len, fill, [BAR, 0.75]);
    }
  }
}
