// Charts on a slide: the chart shape's model, the sample data a new chart starts with, and its drawing
// and chart part, on the spreadsheet's chart engine (core/grid) instead of a second one.
// Translated from deckcraft crates/model/src/chart.rs (`ChartType`, `Chart::sample`, `Chart::default`),
// crates/render/src/chart.rs (`series_color`) and crates/engine/src/cmd/insert/chart.rs (`chart_type`)
// at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A chart is `shape.kind = {type: 'chart', chartType, title, categories, categoryLevels, series[{name, values,
// xValues, sizes, color?, smooth?, kind?, secondaryAxis?}], legend, dataLabels, gridlines, xTitle, yTitle, style,
// palette, textColor, varyColors, raw?}`; `raw` is the opaque object (xml + kept parts) of a chart read from a file,
// written back untouched until a command edits the chart (deckcraft's `Chart.raw`).
//
// What the shared engine does not draw is not offered: Filled Radar, Surface, Pareto and Map (deckcraft has them;
// the engine has no drawing for them: core/prism/lib/chart-extra.mjs now draws Filled Radar, Surface and Pareto, and the
// Axes, Data Table, Error Bars, Lines, Trendline and Up/Down Bars elements; Map needs online map data and stays out),
// histogram bins, waterfall totals and the box-and-whisker quartile method. Text sizes are the engine's 9 pt labels and 14 pt title drawn at 4/3, i.e. PowerPoint's 12 pt and
// 18.6 pt. No DOM, no Node built-ins.

import {render, TEXT, GRID, AXIS, WHITE} from '../../grid/lib/chart-render.mjs';
import {chartXml} from '../../grid/lib/xlsx-drawing.mjs';
import {createContent} from '../../grid/schema.mjs';
import {apply} from '../model/color.mjs';
import {EXTRA_TYPES, isExtra, renderExtra, elementsOnPlot, dataTableHeight, drawDataTable} from './chart-extra.mjs';

/** Chart types: [id, label, engine kind, category]. The categories are Insert Chart's list, in its order. */
export const TYPES = Object.freeze([
  ['column', 'Clustered Column', 'columnClustered', 'Column'], ['stackedColumn', 'Stacked Column', 'columnStacked', 'Column'],
  ['percentColumn', '100% Stacked Column', 'columnStacked100', 'Column'],
  ['line', 'Line', 'line', 'Line'], ['stackedLine', 'Stacked Line', 'lineStacked', 'Line'], ['lineMarkers', 'Line with Markers', 'lineMarkers', 'Line'],
  ['pie', 'Pie', 'pie', 'Pie'], ['doughnut', 'Doughnut', 'doughnut', 'Pie'],
  ['bar', 'Clustered Bar', 'barClustered', 'Bar'], ['stackedBar', 'Stacked Bar', 'barStacked', 'Bar'], ['percentBar', '100% Stacked Bar', 'barStacked100', 'Bar'],
  ['area', 'Area', 'area', 'Area'], ['stackedArea', 'Stacked Area', 'areaStacked', 'Area'],
  ['scatter', 'Scatter', 'scatter', 'X Y (Scatter)'], ['bubble', 'Bubble', 'bubble', 'X Y (Scatter)'],
  ['stock', 'Stock', 'stock', 'Stock'], ['radar', 'Radar', 'radar', 'Radar'], ['filledRadar', 'Filled Radar', 'radar', 'Radar'], ['surface', 'Surface', 'area', 'Surface'],
  ['treemap', 'Treemap', 'treemap', 'Treemap'], ['sunburst', 'Sunburst', 'sunburst', 'Sunburst'],
  ['histogram', 'Histogram', 'histogram', 'Histogram'], ['pareto', 'Pareto', 'combo', 'Histogram'], ['boxWhisker', 'Box and Whisker', 'boxWhisker', 'Box & Whisker'],
  ['waterfall', 'Waterfall', 'waterfall', 'Waterfall'], ['funnel', 'Funnel', 'funnel', 'Funnel'], ['combo', 'Combo', 'combo', 'Combo'],
]);
export const TYPE_IDS = Object.freeze(TYPES.map(t => t[0]));
export const CATEGORIES = Object.freeze([...new Set(TYPES.map(t => t[3]))]);
const BY_ID = new Map(TYPES.map(t => [t[0], t]));
export const typeLabel = id => BY_ID.get(id)?.[1] ?? 'Chart';
export const typeCategory = id => BY_ID.get(id)?.[3] ?? 'Column';
export const gridKind = id => BY_ID.get(id)?.[2] ?? 'columnClustered';
export const typesIn = category => TYPES.filter(t => t[3] === category).map(t => t[0]);

/** Types deckcraft has but this engine cannot draw (a named one is refused, not turned into a column chart). */
export const UNDRAWN = Object.freeze({regionmap: 'Map', map: 'Map'});

/** deckcraft `chart_type`: a type from its name (`bar`, `stacked-column`, `donut`, `xy`…); unknown names are a column chart. */
export function typeId(name) {
  const k = String(name ?? 'column').toLowerCase().replace(/[-_ ]/g, '');
  if (UNDRAWN[k]) return null;
  const alias = {clusteredbar: 'bar', linewithmarkers: 'lineMarkers', donut: 'doughnut', xy: 'scatter', box: 'boxWhisker', clusteredcolumn: 'column'};
  if (alias[k]) return alias[k];
  const hit = TYPE_IDS.find(id => id.toLowerCase() === k);
  return hit ?? 'column';
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const FLAT = new Set(['pie', 'doughnut', 'funnel', 'waterfall', 'treemap', 'sunburst']);

const series = (name, values, extra = {}) => ({name, values: values.map(v => (v === undefined ? null : v)), ...extra});

/** A chart with deckcraft's defaults (`Chart::default`). */
export function blankChart(chartType) {
  return {type: 'chart', chartType, title: 'Chart Title', categories: [], categoryLevels: [], series: [], legend: 'bottom', dataLabels: false,
    gridlines: true, xTitle: null, yTitle: null, style: 2, palette: 'colorful1', textColor: null, varyColors: false};
}

/** deckcraft `Chart::sample`: the data a new chart starts with. */
export function sampleChart(chartType) {
  const c = blankChart(chartType);
  if (chartType === 'treemap' || chartType === 'sunburst') {
    c.categories = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
    c.categoryLevels = [['Q1', 'Q1', 'Q1', 'Q2', 'Q2', 'Q2', 'Q3', 'Q3']];
    c.varyColors = true;
    c.series = [series('Series 1', [4.2, 2.8, 3.6, 4.7, 2.6, 4.1, 1.9, 3.0])];
    return c;
  }
  if (chartType === 'histogram' || chartType === 'boxWhisker') {
    const obs = [12, 15, 17, 18, 21, 22, 22, 24, 25, 27, 28, 31, 33, 36, 41, 48];
    const box = chartType === 'boxWhisker';
    c.categories = box ? obs.map((_, i) => (i % 2 === 0 ? 'Group A' : 'Group B')) : [];
    c.legend = box ? 'bottom' : null;
    c.series = Array.from({length: box ? 2 : 1}, (_, s) => series(`Series ${s + 1}`, obs.map(v => v + s * 6)));
    return c;
  }
  if (chartType === 'pareto') {
    c.categories = ['Late delivery', 'Damaged', 'Wrong item', 'No answer', 'Other'];
    c.series = [series('Complaints', [24, 41, 17, 9, 6])];
    return c;
  }
  if (chartType === 'stock') {
    c.categories = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    c.series = [series('High', [55, 57, 57, 58, 58]), series('Low', [11, 12, 13, 11, 25]), series('Close', [25, 38, 50, 35, 43])];
    return c;
  }
  const data = [[4.2, 2.6, 2.1], [2.8, 4.1, 2.4], [3.6, 1.9, 3.3], [4.7, 3.0, 5.1]];
  c.categories = ['Q1', 'Q2', 'Q3', 'Q4'];
  const n = FLAT.has(chartType) ? 1 : 3;
  for (let s = 0; s < n; s++) {
    const extra = chartType === 'scatter' || chartType === 'bubble' ? {xValues: [1, 2, 3, 4]} : {};
    if (chartType === 'bubble') extra.sizes = data.map(r => Math.round(r[s] * 30) / 10);
    c.series.push(series(`Series ${s + 1}`, data.map(r => r[s]), extra));
  }
  c.varyColors = n === 1;
  if (chartType === 'combo') c.series.forEach((s, i) => { s.kind = i + 1 === n ? 'line' : 'column'; });
  return c;
}

/** The chart-wide changes `chart.type` makes (deckcraft `chart_type_cmd`): vary colours for the one-slice types, gridlines for the statistical ones. */
export function retype(c, chartType) {
  c.chartType = chartType;
  c.varyColors = FLAT.has(chartType) || (c.series.length === 1 && c.varyColors);
  if (['waterfall', 'histogram', 'boxWhisker'].includes(chartType)) c.gridlines = true;
  if (chartType !== 'combo') for (const s of c.series) delete s.kind;
  else c.series.forEach((s, i) => { s.kind ??= i + 1 === c.series.length ? 'line' : 'column'; });
  delete c.raw;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Colours

const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
const scheme = slot => ({base: {kind: 'scheme', slot}, mods: []});

/** The one accent a monochrome (accent 1) or `accentN` palette steps through, else null (the accents in turn). */
export function fixedAccent(chart) {
  const p = String(chart.palette ?? '');
  if (p.startsWith('monochrome')) return 'accent1';
  const m = /^accent([1-6])$/.exec(p);
  return m ? `accent${m[1]}` : null;
}

/** deckcraft `series_color`: the accents in turn, then a shade, a tint and lumMod steps of them; monochrome palettes step accent 1. */
export function seriesColor(chart, i, resolve) {
  const fixed = fixedAccent(chart);
  const mono = !!fixed;
  const base = resolve(scheme(fixed ?? ACCENTS[i % 6]));
  const round = mono ? i : Math.floor(i / 6);
  if (round === 0) return base;
  if (round === 1) return apply(base, [{op: 'shade', val: 60000}]);
  if (round === 2) return apply(base, [{op: 'tint', val: 60000}]);
  return apply(base, [{op: 'lumMod', val: 100000 - (round % 5) * 12000}]);
}
const rgba = c => [c.r, c.g, c.b, 255];
const hex2 = c => `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

export const PALETTES = Object.freeze([['colorful1', 'Colorful'], ['monochrome1', 'Monochromatic']]);

// ---------------------------------------------------------------------------------------------
// Drawing

const SCALE = 4 / 3;

/** The trendline the Trendline element puts on series `i` (the engine's resolved form: the spec and a colour), none when the element is off. */
function trendOf(c, i, resolve) {
  const tl = c.elements?.trendline;
  if (!tl || !tl.type) return [];
  const col = c.series[i]?.color ? resolve(c.series[i].color) : seriesColor(c, i, resolve);
  return [{spec: {...tl}, color: [Math.round(col.r * 0.7), Math.round(col.g * 0.7), Math.round(col.b * 0.7), 255]}];
}

/** The engine's data for a chart: names, values and colours (the series' own, else the palette's). */
export function drawData(c, resolve) {
  const n = Math.max(0, ...c.series.map(s => s.values.length));
  const palette = Array.from({length: Math.min(Math.max(n, c.series.length), 48)}, (_, j) => rgba(seriesColor(c, j, resolve)));
  return {
    categories: c.categories.length ? c.categories : Array.from({length: n}, (_, i) => String(i + 1)),
    categoryLevels: c.categoryLevels ?? [],
    palette,
    series: c.series.map((s, i) => ({
      name: s.name || `Series${i + 1}`, values: s.values.map(num),
      x: s.xValues?.length ? s.xValues.map(num) : null, sizes: s.sizes?.length ? s.sizes.map(num) : null,
      color: s.color ? rgba(resolve(s.color)) : rgba(seriesColor(c, i, resolve)),
      kind: c.chartType === 'combo' ? gridKind(s.kind ?? (i + 1 === c.series.length ? 'line' : 'column')) : gridKind(c.chartType),
      secondary: !!s.secondaryAxis, smooth: !!s.smooth, trendlines: trendOf(c, i, resolve), numberFormat: 'General',
    })),
  };
}

/** The engine's `axes` {category, value} of the Axes element: the bottom axis is the value axis of a bar chart and the category axis of the others. */
export function axesOf(c) {
  const bar = ['bar', 'stackedBar', 'percentBar'].includes(c.chartType);
  const h = c.elements?.axes?.h !== false, v = c.elements?.axes?.v !== false;
  return bar ? {category: v, value: h} : {category: h, value: v};
}

/** The engine's chart object for drawing and for the chart part (series as literal lists). */
export function engineChart(c, resolve) {
  const lit = vs => `{${vs.map(v => (num(v) === null ? '' : num(v))).join(',')}}`;
  const text = vs => `{${vs.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')}}`;
  return {
    kind: gridKind(c.chartType), title: typeof c.title === 'string' ? c.title : '', legend: c.legend ?? 'none',
    dataLabels: !!c.dataLabels, gridlines: c.gridlines !== false, style: c.style ?? 2, byRows: false,
    xTitle: c.xTitle ?? undefined, yTitle: c.yTitle ?? undefined,
    ...(c.elements?.axes && (c.elements.axes.h === false || c.elements.axes.v === false) ? {axes: axesOf(c)} : {}),
    ...(elementsOnPlot(c.elements) ? {onPlot: elementsOnPlot(c.elements)} : {}),
    series: c.series.map((s, i) => {
      const scatter = c.chartType === 'scatter' || c.chartType === 'bubble';
      const o = {name: `"${String(s.name ?? '').replaceAll('"', '""')}"`, values: lit(s.values),
        categories: scatter && s.xValues?.length ? lit(s.xValues) : c.categories.length ? text(c.categories) : undefined};
      if (s.sizes?.length) o.bubbleSizes = lit(s.sizes);
      if (c.chartType === 'combo') o.kind = gridKind(s.kind ?? (i + 1 === c.series.length ? 'line' : 'column'));
      if (s.secondaryAxis) o.secondary = true;
      if (s.smooth) o.smooth = true;
      if (c.elements?.trendline?.type) o.trendlines = [{...c.elements.trendline}];
      if (s.color) o.color = hex2(resolve(s.color));
      else if (fixedAccent(c)) o.color = hex2(seriesColor(c, i, resolve));
      return o;
    }),
  };
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const toCss = c => [c.r, c.g, c.b, 255];

/**
 * The chart as drawing primitives in a `w` x `h` box (points): the engine's output at 3/4 size, scaled up by `scale` (4/3),
 * with no white backing (a chart on a slide is transparent) and its greys taken from the text colour.
 * `resolve` turns a colour reference into {r, g, b, a} in the slide's theme; `textColor` is the chart's own.
 */
export function chartPrims(c, w, h, resolve, scale = SCALE) {
  if (!(w >= 1 && h >= 1) || !c.series.length) return {scale, w: w / scale, h: h / scale, prims: []};
  const vw = w / scale, vh = h / scale;
  const ink = c.textColor ?? scheme('tx1');
  const text = toCss(apply(resolve(ink), c.textColor ? [] : [{op: 'lumMod', val: 65000}, {op: 'lumOff', val: 35000}]));
  const grid = toCss(apply(resolve(ink), [{op: 'lumMod', val: 15000}, {op: 'lumOff', val: 85000}]));
  const axis = toCss(apply(resolve(ink), [{op: 'lumMod', val: 25000}, {op: 'lumOff', val: 75000}]));
  const data = drawData(c, resolve);
  let prims;
  if (isExtra(c.chartType)) prims = renderExtra(c.chartType, engineChart(c, resolve), data, vw, vh);
  else if (c.elements?.dataTable && data.series.length) {
    // Data Table: the chart in the room above the table, the legend keys in the table, the category labels in its header.
    const th = dataTableHeight(data, vh);
    const eng = engineChart(c, resolve);
    eng.legend = 'none';
    eng.axes = {...(eng.axes ?? {}), category: false};
    const top = render(eng, data, vw, vh - th);
    prims = [...top, ...drawDataTable(data, vw, vh - th, th)];
  } else prims = render(engineChart(c, resolve), data, vw, vh);
  const out = [];
  prims.forEach((p, i) => {
    if (i === 0 && p.t === 'rect' && p.fill && same(p.fill, WHITE)) return;
    const q = {...p};
    if (q.color && same(q.color, TEXT)) q.color = text;
    if (q.color && same(q.color, GRID)) q.color = grid;
    if (q.color && same(q.color, AXIS)) q.color = axis;
    if (q.stroke && same(q.stroke[0], GRID)) q.stroke = [grid, q.stroke[1]];
    if (q.stroke && same(q.stroke[0], AXIS)) q.stroke = [axis, q.stroke[1]];
    if (q.fill && same(q.fill, GRID)) q.fill = grid;
    if (q.fill && same(q.fill, AXIS)) q.fill = axis;
    out.push(q);
  });
  return {scale, w: vw, h: vh, prims: out};
}

/** A type's thumbnail for the chooser dialogs: its sample chart in a small box, on plain black-on-white. */
export function typePrims(chartType, w, h, large = false) {
  const c = sampleChart(chartType);
  const black = {r: 0, g: 0, b: 0, a: 255};
  const resolve = ref => {
    const slot = ref?.base?.slot ?? 'accent1';
    const accents = {accent1: [68, 114, 196], accent2: [237, 125, 49], accent3: [165, 165, 165], accent4: [255, 192, 0], accent5: [91, 155, 213], accent6: [112, 173, 71]};
    const a = accents[slot];
    return a ? {r: a[0], g: a[1], b: a[2], a: 255} : black;
  };
  // A thumbnail is the chart drawn small with no title or legend; the large one keeps its legend.
  return chartPrims({...c, title: null, legend: large ? c.legend : null}, w, h, resolve, large ? SCALE : 0.5);
}

// ---------------------------------------------------------------------------------------------
// The chart part (ppt/charts/chartN.xml)

/** The worksheet behind the chart: the whole table Select Data kept, else the Edit Data table. */
export const sheetOf = c => (Array.isArray(c.sheet) && c.sheet.length ? c.sheet : dataTable(c));

const letters = n => { let s = ''; for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };
/** `B2:D5` (or `Sheet1!$B$2:$D$5`) as {r1, c1, r2, c2}, 0-based; null when it is not a range. */
export function parseSheetRange(text) {
  const m = /^(?:[^!]*!)?\$?([A-Za-z]{1,3})\$?(\d{1,6})(?::\$?([A-Za-z]{1,3})\$?(\d{1,6}))?$/.exec(String(text ?? '').trim().replace(/^=/, ''));
  if (!m) return null;
  const col = s => [...s.toUpperCase()].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const [c1, r1] = [col(m[1]), Number(m[2]) - 1];
  const [c2, r2] = m[3] ? [col(m[3]), Number(m[4]) - 1] : [c1, r1];
  return {r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2)};
}
export const rangeText = r => `${letters(r.c1)}${r.r1 + 1}:${letters(r.c2)}${r.r2 + 1}`;

/** The embedded workbook of a chart and the chart whose series point at its cells (the Select Data range, else all of the sheet). */
export function workbookChart(c, resolve) {
  const table = sheetOf(c);
  const width = Math.max(1, ...table.map(r => r.length));
  const range = (c.range && parseSheetRange(c.range)) || {r1: 0, c1: 0, r2: Math.max(0, table.length - 1), c2: width - 1};
  const content = createContent('chart');
  const blocks = {};
  table.forEach((row, r) => row.forEach((v, k) => {
    const text = String(v ?? '');
    if (text === '') return;
    const n = parseNum(text);
    (blocks[String(Math.floor(r / 256))] ??= {})[`${letters(k)}${r + 1}`] = {v: n !== null && /^[-+]?[\d.,eE+-]+$/.test(text.trim()) ? n : text};
  }));
  content.sheets[0].blocks = blocks;
  const chart = engineChart(c, resolve);
  const xy = c.chartType === 'scatter' || c.chartType === 'bubble';
  const step = c.chartType === 'bubble' ? 2 : 1;
  const [first, last] = [range.r1 + 2, range.r2 + 1];
  const col = k => `$${letters(k)}`;
  const cells = (k, a = first, b = last) => `Sheet1!${col(k)}$${a}:${col(k)}$${b}`;
  chart.series = chart.series.map((s, i) => {
    const k = range.c1 + 1 + i * step;
    const o = {...s, name: `Sheet1!${col(k)}$${range.r1 + 1}`, values: cells(k)};
    if (xy || c.categories.length) o.categories = cells(range.c1);
    if (c.chartType === 'bubble') o.bubbleSizes = cells(k + 1);
    return o;
  });
  return {content, chart};
}

/**
 * The chart part: the engine's chart XML, the chart's own text size and colour, and its palette. With `workbook` its series point at the
 * cells of an embedded workbook (`workbookChart`, written by the package under ppt/embeddings) and the part names it as its external data;
 * without, each series is a literal list.
 */
export function chartPartXml(c0, resolve, {workbook = false} = {}) {
  const c = c0.chartType === 'pareto' ? paretoModel(c0) : c0;
  let xml;
  if (workbook) {
    const {content, chart} = workbookChart(c, resolve);
    xml = chartXml(content, 0, chart);
  } else {
    xml = chartXml(createContent('chart'), 0, engineChart(c, resolve));
    xml = xml.replace(/<c:tx><c:strRef><c:f>[^<]*<\/c:f><c:strCache><c:ptCount val="1"\/><c:pt idx="0"><c:v>([\s\S]*?)<\/c:v><\/c:pt><\/c:strCache><\/c:strRef><\/c:tx>/g, '<c:tx><c:v>$1</c:v></c:tx>');
    xml = xml.replace(/<c:(str|num)Ref><c:f>[^<]*<\/c:f><c:(?:str|num)Cache>([\s\S]*?)<\/c:(?:str|num)Cache><\/c:\1Ref>/g, '<c:$1Lit>$2</c:$1Lit>');
  }
  const fill = c.textColor ? colorXml(c.textColor, resolve) : '';
  const sz = 1200;
  const external = workbook ? '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>' : '';
  xml = xml.replace('</c:chart>', `</c:chart><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}">${fill ? `<a:solidFill>${fill}</a:solidFill>` : ''}</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>${external}`);
  if (c.palette && c.palette !== 'colorful1' || c.varyColors || isExtra(c0.chartType) || c0.elements) xml = xml.replace('</c:chartSpace>', `${paletteExt(c, c0)}</c:chartSpace>`).replace('</c:extLst><c:extLst>', '');
  // A filled radar chart is a radar chart with the filled style.
  if (c0.chartType === 'filledRadar') xml = xml.replace('<c:radarStyle val="marker"/>', '<c:radarStyle val="filled"/>');
  return xml;
}

/** A colour reference as DrawingML colour XML (scheme colours keep their slot, others become RGB). */
function colorXml(ref, resolve) {
  const slot = ref?.base?.kind === 'scheme' ? ref.base.slot : null;
  if (slot) {
    const mods = (ref.mods ?? []).filter(m => ['lumMod', 'lumOff', 'tint', 'shade', 'alpha'].includes(m.op)).map(m => `<a:${m.op} val="${m.val}"/>`).join('');
    return `<a:schemeClr val="${slot}">${mods}</a:schemeClr>`;
  }
  const c = resolve(ref);
  return `<a:srgbClr val="${hex2(c).slice(1)}"/>`;
}

const PALETTE_URI = '{6A1F3C52-2D64-4C57-9C1E-0D2B6F6E3A11}';
/** The palette and vary-colours flag in the chart's extension list (the chart part has no place for either). */
function paletteExt(c, c0 = c) {
  const el = c0.elements ? ` elements="${encodeURIComponent(JSON.stringify(c0.elements)).replace(/"/g, '%22')}"` : '';
  const type = isExtra(c0.chartType) ? ` type="${c0.chartType}"` : '';
  return `<c:extLst><c:ext uri="${PALETTE_URI}" xmlns:ark="urn:arkemis"><ark:chart palette="${String(c.palette ?? 'colorful1').replace(/[^A-Za-z0-9]/g, '')}" varyColors="${c.varyColors ? 1 : 0}"${type}${el}/></c:ext></c:extLst>`;
}

/** A Pareto chart as the chart part keeps it: the columns largest first and the cumulative share as a line on its own axis. */
export function paretoModel(c) {
  const s = c.series[0];
  if (!s) return {...c, chartType: 'combo'};
  const n = Math.max(c.categories.length, s.values.length);
  const rows = Array.from({length: n}, (_, j) => ({cat: c.categories[j] ?? String(j + 1), v: num(s.values[j])})).filter(r => r.v !== null && r.v >= 0).sort((a, b) => b.v - a.v);
  const total = rows.reduce((a, r) => a + r.v, 0) || 1;
  let run = 0;
  return {...c, chartType: 'combo', categories: rows.map(r => r.cat), categoryLevels: [], elements: undefined,
    series: [{...s, values: rows.map(r => r.v), kind: 'column'}, {name: 'Cumulative %', values: rows.map(r => { run += r.v; return Math.min(1, run / total); }), kind: 'line', secondaryAxis: true}]};
}

// ---------------------------------------------------------------------------------------------
// The data grid of Edit Data

/** The table Edit Data shows: a header row of series names, then a row per category (scatter: X values first; bubble: X, Y, size per series). */
export function dataTable(c) {
  const n = Math.max(c.categories.length, ...c.series.map(s => s.values.length), 0);
  const cell = v => (v === null || v === undefined ? '' : String(v));
  const xy = c.chartType === 'scatter' || c.chartType === 'bubble';
  const head = [xy ? 'X' : ''];
  for (const s of c.series) { head.push(s.name ?? ''); if (c.chartType === 'bubble') head.push(`${s.name ?? ''} size`); }
  const rows = [head];
  for (let r = 0; r < n; r++) {
    const row = [xy ? cell(c.series[0]?.xValues?.[r]) : c.categories[r] ?? ''];
    for (const s of c.series) { row.push(cell(s.values[r])); if (c.chartType === 'bubble') row.push(cell(s.sizes?.[r])); }
    rows.push(row);
  }
  return rows;
}

const parseNum = t => {
  const v = String(t ?? '').trim().replace(/,/g, '');
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The inverse of `dataTable`: `{categories, series[{name, values, xValues?, sizes?}]}` from a table of text cells. */
export function fromTable(table, chartType) {
  const rows = (table ?? []).filter(r => Array.isArray(r));
  if (!rows.length) return {categories: [], series: []};
  const xy = chartType === 'scatter' || chartType === 'bubble';
  const step = chartType === 'bubble' ? 2 : 1;
  const width = Math.max(...rows.map(r => r.length));
  const body = rows.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== ''));
  const out = {categories: xy ? [] : body.map(r => String(r[0] ?? '')), series: []};
  const xs = xy ? body.map(r => parseNum(r[0])) : null;
  for (let col = 1; col < width; col += step) {
    const s = {name: String(rows[0][col] ?? '').trim() || `Series ${out.series.length + 1}`, values: body.map(r => parseNum(r[col]))};
    if (xy) s.xValues = xs.slice();
    if (chartType === 'bubble') s.sizes = body.map(r => parseNum(r[col + 1]));
    out.series.push(s);
  }
  if (xy) out.categories = xs.map((v, i) => (v === null ? String(i + 1) : String(v)));
  return out;
}
