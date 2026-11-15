// Charts WordCraft makes and edits (Insert › Chart): type, data (categories and series), title,
// legend and data labels. A graphic object with `graphic.chart` set keeps this model next to the
// items it is drawn with; the DOCX writer turns it into a chart part with the data cached in it.
// Translated from wordcraft crates/doc/src/chart.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// ChartSpec `{type, categories: string[], series: [{name, values: (number|null)[]}], title: string|null,
// legend: 'right'|'left'|'top'|'bottom'|null, dataLabels: boolean}`. Every value from outside
// goes through sanitizedChart().
//
// Word's additions (U:quill/chart): the kinds Grid draws too (WORD_TYPES, the subtypes of Insert Chart), the Chart Design
// settings the Grid chart model keeps (`style` 1 to 16, `gridlines`, `xTitle`, `yTitle`, a colour of each series), and the
// embedded data sheet as a table (chartTable / chartFromTable: the first row names the series, the first column the categories).
// No DOM, no Node built-ins.

export const MAX_SERIES = 255;
export const MAX_POINTS = 4000;
export const MAX_CELLS = 100_000;
export const MAX_TEXT = 255;

export const CHART_TYPES = Object.freeze(['column', 'columnStacked', 'bar', 'barStacked', 'line', 'area', 'pie', 'doughnut', 'scatter']);
/** The kinds Word adds, named as Grid's chart kinds are. */
export const EXTRA_TYPES = Object.freeze(['columnStacked100', 'barStacked100', 'lineMarkers', 'lineStacked', 'areaStacked', 'areaStacked100', 'scatterLines', 'radar', 'histogram',
  'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'stock', 'combo']);
export const WORD_TYPES = Object.freeze([...CHART_TYPES, ...EXTRA_TYPES]);
/** The kind Grid's chart renderer calls a type (column and bar are the clustered ones). */
export const gridKind = t => (t === 'column' ? 'columnClustered' : t === 'bar' ? 'barClustered' : t);
const LABELS = {column: 'Clustered Column', columnStacked: 'Stacked Column', bar: 'Clustered Bar', barStacked: 'Stacked Bar', line: 'Line',
  area: 'Area', pie: 'Pie', doughnut: 'Doughnut', scatter: 'Scatter', columnStacked100: '100% Stacked Column', barStacked100: '100% Stacked Bar', lineMarkers: 'Line with Markers',
  lineStacked: 'Stacked Line', areaStacked: 'Stacked Area', areaStacked100: '100% Stacked Area', scatterLines: 'Scatter with Straight Lines', radar: 'Radar', histogram: 'Histogram',
  waterfall: 'Waterfall', funnel: 'Funnel', treemap: 'Treemap', sunburst: 'Sunburst', boxWhisker: 'Box & Whisker', stock: 'Stock', combo: 'Combo'};
/** The type an id names (any ASCII case), or null. */
export const chartTypeFromId = id => WORD_TYPES.find(t => t.toLowerCase() === String(id ?? '').trim().toLowerCase()) ?? null;
export const chartTypeLabel = t => LABELS[t] ?? LABELS.column;
/** Pie and doughnut charts show one series, a slice per category. */
export const chartIsRound = t => t === 'pie' || t === 'doughnut';
/** The kinds whose data is one series (a share a category). */
const SINGLE = new Set(['pie', 'doughnut', 'histogram', 'waterfall', 'funnel', 'treemap', 'sunburst']);

export const LEGEND_POSITIONS = Object.freeze(['right', 'top', 'left', 'bottom']);
export const legendPosFromId = id => LEGEND_POSITIONS.find(p => p === String(id ?? '').trim().toLowerCase()) ?? null;

/** A new chart of `type` with WordCraft's sample data, legend at the bottom. */
export function sampleChart(type = 'column') {
  let categories, series;
  if (type === 'waterfall') { categories = ['Start', 'Sales', 'Costs', 'Tax', 'End']; series = [['Change', [50, 30, -20, -10, 50]]]; }
  else if (type === 'stock') { categories = ['Mon', 'Tue', 'Wed', 'Thu']; series = [['Open', [20, 22, 21, 24]], ['High', [24, 25, 26, 27]], ['Low', [18, 20, 19, 22]], ['Close', [22, 21, 25, 26]]]; }
  else if (SINGLE.has(type)) { categories = ['North', 'East', 'South', 'West']; series = [['Share', [38, 24, 21, 17]]]; }
  else if (type === 'scatter' || type === 'scatterLines') { categories = ['1', '2', '3', '4']; series = [['Series 1', [2.1, 3.4, 3.0, 4.6]], ['Series 2', [1.2, 1.9, 2.8, 3.1]]]; }
  else {
    categories = ['Q1', 'Q2', 'Q3', 'Q4'];
    series = [['Series 1', [3.2, 4.1, 3.6, 5.0]], ['Series 2', [2.0, 2.7, 3.9, 3.3]], ['Series 3', [1.5, 2.2, 2.4, 3.8]]];
  }
  return {type, categories, series: series.map(([name, values]) => ({name, values: [...values]})), title: null, legend: 'bottom', dataLabels: false};
}

const HEX = /^#?[0-9a-fA-F]{6}$/;
export const chartPoints = c => c.categories.length;

/**
 * The chart's embedded data sheet, as Word shows it in Edit Data: rows of cells, the first row naming the series ('' in the
 * corner), the first column the categories, then a column of values for each series.
 */
export function chartTable(c) {
  const head = ['', ...c.series.map(s => s.name)];
  return [head, ...c.categories.map((cat, i) => [cat, ...c.series.map(s => (s.values[i] ?? null))])];
}

/** The chart `c` with the data of a table (chartTable's shape; text that reads as a number is one; an empty cell is a gap). */
export function chartFromTable(c, rows) {
  const body = rows.slice(1);
  const width = Math.max(1, ...rows.map(r => r.length));
  const num = v => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const x = String(v ?? '').trim();
    return x !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
  };
  const keep = new Map((c.series ?? []).map(s => [s.name, s.color]));
  const series = [];
  for (let k = 1; k < width; k++) {
    const name = String(rows[0]?.[k] ?? '');
    series.push({name, values: body.map(r => num(r[k])), ...(keep.get(name) ? {color: keep.get(name)} : {})});
  }
  return sanitizedChart({...c, categories: body.map(r => String(r[0] ?? '')), series});
}

/** Switch Row/Column: the categories become the series and the series the categories. */
export function switchRowColumn(c) {
  const t = chartTable(c);
  const cols = Math.max(...t.map(r => r.length));
  const flipped = Array.from({length: cols}, (_, j) => t.map(r => r[j] ?? null));
  const next = chartFromTable(c, flipped);
  return {...next, series: next.series.map(s => { const {color: _c, ...rest} = s; return rest; })};
}

/** `s` as chart text: control characters as spaces, ends trimmed, at most MAX_TEXT characters. */
export function cleanChartText(s) {
  const t = [...String(s ?? '')].slice(0, MAX_TEXT * 4).map(c => (/\p{Cc}/u.test(c) ? ' ' : c)).join('');
  return [...t.trim()].slice(0, MAX_TEXT).join('').trimEnd();
}

/**
 * The chart made safe to store and draw: text cleaned, at most MAX_POINTS categories,
 * MAX_SERIES series and MAX_CELLS cells, non-finite values as gaps, every series as long as the
 * categories (categories padded with empty labels to the longest series). Returns a new object.
 */
export function sanitizedChart(c0) {
  const c = {type: chartTypeFromId(c0?.type) ?? 'column', categories: [...(c0?.categories ?? [])].map(String),
    series: (c0?.series ?? []).slice(0, MAX_SERIES).map(s => ({name: String(s?.name ?? ''), values: [...(s?.values ?? [])], ...(HEX.test(String(s?.color ?? '')) ? {color: String(s.color).startsWith('#') ? String(s.color).toUpperCase() : `#${String(s.color).toUpperCase()}`} : {})})),
    title: c0?.title ?? null, legend: c0?.legend === null || c0?.legend === undefined ? null : legendPosFromId(c0.legend), dataLabels: !!c0?.dataLabels};
  // Word's Chart Design settings, kept only when set.
  if (Number.isInteger(c0?.style) && c0.style >= 1 && c0.style <= 16) c.style = c0.style;
  if (c0?.gridlines === false) c.gridlines = false;
  for (const k of ['xTitle', 'yTitle']) { const v = cleanChartText(c0?.[k]); if (v) c[k] = v; }
  // Format Chart Area (Chart Format): the area's fill (a colour or 'none') and border ('none' or {color, width}), kept only when set.
  if (c0?.areaFill === 'none' || HEX.test(String(c0?.areaFill ?? ''))) c.areaFill = c0.areaFill === 'none' ? 'none' : `#${String(c0.areaFill).replace('#', '').toUpperCase()}`;
  if (c0?.areaLine === 'none') c.areaLine = 'none';
  else if (c0?.areaLine && HEX.test(String(c0.areaLine.color ?? ''))) c.areaLine = {color: `#${String(c0.areaLine.color).replace('#', '').toUpperCase()}`, width: Number.isFinite(c0.areaLine.width) ? Math.min(Math.max(c0.areaLine.width, 0), 72) : 0.75};
  const longest = c.series.reduce((m, s) => Math.max(m, s.values.length), 0);
  const n = Math.min(Math.max(c.categories.length, longest), MAX_POINTS);
  const keep = n > 0 ? Math.min(MAX_SERIES, Math.max(1, Math.floor(MAX_CELLS / n))) : MAX_SERIES;
  c.series = c.series.slice(0, keep);
  c.categories = c.categories.slice(0, n).map(cleanChartText);
  while (c.categories.length < n) c.categories.push('');
  for (const s of c.series) {
    s.name = cleanChartText(s.name);
    s.values = s.values.slice(0, n).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    while (s.values.length < n) s.values.push(null);
  }
  const title = c.title === null ? null : cleanChartText(c.title);
  c.title = title ? title : null;
  return c;
}
