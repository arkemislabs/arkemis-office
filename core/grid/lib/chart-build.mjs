// Building a chart from a block of cells: the type names the Insert tab gives, the series a block
// makes (first row and column as names and categories when they are text), the types that suit the
// data's shape, and the chart object an insert stores.
// Translated from gridcraft crates/engine/src/cmd/insert/chart.rs (`chart_kind`, `series_from_range`,
// `series_from_areas`, `scatter_x_from_first`, `recommend_charts`, `build_chart`, `series_block`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {a1, colToLetters, quoteSheet, width, height, rangeA1, count as rangeCount, parseRange, splitSheet, rangeOf} from './addr.mjs';
import {engineFor} from '../model/calc.mjs';
import {sheetIndex} from '../model/sheet.mjs';
import {usedBounds} from '../model/store.mjs';
import {valueOf, bad, regionAround} from './data-common.mjs';

/** Most cells a chart's source block may span (bounds the series it builds). */
const MAX_CELLS_PER_CHART = 1_000_000;

/** The stored chart kind for an Insert tab type and subtype (`column` + `stacked` is `columnStacked`). */
export function chartKind(t, sub) {
  switch (`${t}|${sub}`) {
    case 'column|stacked': return 'columnStacked';
    case 'column|stacked100': return 'columnStacked100';
    case 'bar|stacked': return 'barStacked';
    case 'bar|stacked100': return 'barStacked100';
    case 'line|markers': return 'lineMarkers';
    case 'line|stacked': return 'lineStacked';
    case 'area|stacked': return 'areaStacked';
    case 'area|stacked100': return 'areaStacked100';
    case 'scatter|lines': case 'scatter|smooth': case 'scatter|linesMarkers': return 'scatterLines';
    case 'pie|3d': return 'pie3d';
    case 'pie|ofPie': return 'pieOfPie';
    case 'pie|barOfPie': return 'barOfPie';
    case 'bubble|3d': return 'bubble3d';
    default:
  }
  switch (t) {
    case 'bar': return 'barClustered';
    case 'line': return 'line';
    case 'pie': return 'pie';
    case 'doughnut': return 'doughnut';
    case 'area': return 'area';
    case 'scatter': return 'scatter';
    case 'bubble': return 'bubble';
    case 'bubble3d': return 'bubble3d';
    case 'pie3d': return 'pie3d';
    case 'pieOfPie': return 'pieOfPie';
    case 'barOfPie': return 'barOfPie';
    case 'pareto': return 'pareto';
    case 'radar': return 'radar';
    case 'histogram': return 'histogram';
    case 'waterfall': return 'waterfall';
    case 'funnel': return 'funnel';
    case 'treemap': return 'treemap';
    case 'sunburst': return 'sunburst';
    case 'boxWhisker': return 'boxWhisker';
    case 'stock': return 'stock';
    case 'combo': return 'combo';
    default: return 'columnClustered';
  }
}

export const CHART_TYPES = Object.freeze(['column', 'bar', 'line', 'pie', 'doughnut', 'area', 'scatter', 'bubble', 'radar', 'combo', 'histogram', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'stock', 'pareto', 'auto']);

const absRange = (q, r) => `${q}!$${colToLetters(r.start.col)}$${r.start.row + 1}:$${colToLetters(r.end.col)}$${r.end.row + 1}`;
const abs1 = (q, row, col) => `${q}!$${colToLetters(col)}$${row + 1}`;

/** Series from a block: the first row / column name the series and label the categories when they are text. */
export function seriesFromRange(content, si, r, byRows, engine = engineFor(content)) {
  const q = quoteSheet(content.sheets[si].name);
  const val = (row, col) => valueOf(engine, si, row, col);
  const isText = (row, col) => { const v = val(row, col); return typeof v === 'string' || v === null || v === undefined; };
  const rowText = (row, col) => typeof val(row, col) === 'string';
  const w = width(r), h = height(r);
  const cols = Array.from({length: w}, (_, i) => r.start.col + i);
  const headerRow = h > 1 && cols.some(c => rowText(r.start.row, c)) && cols.filter(c => c !== r.start.col).every(c => isText(r.start.row, c));
  // A blank top-left cell above a header row marks the first column as the category labels even when it holds numbers (years, X values).
  const blankCorner = headerRow && (val(r.start.row, r.start.col) === null || val(r.start.row, r.start.col) === undefined);
  let labelCol = false;
  if (w > 1) {
    labelCol = blankCorner;
    if (!labelCol) {
      labelCol = true;
      for (let row = r.start.row + (headerRow ? 1 : 0); row <= r.end.row; row++) if (!isText(row, r.start.col)) { labelCol = false; break; }
    }
  }
  const data = rangeOf(r.start.row + (headerRow ? 1 : 0), r.start.col + (labelCol ? 1 : 0), r.end.row, r.end.col);
  const out = [];
  if (!byRows) {
    for (let c = data.start.col; c <= data.end.col; c++) {
      out.push({
        name: headerRow ? abs1(q, r.start.row, c) : undefined,
        categories: labelCol ? absRange(q, rangeOf(data.start.row, r.start.col, data.end.row, r.start.col)) : undefined,
        values: absRange(q, rangeOf(data.start.row, c, data.end.row, c)),
      });
    }
  } else {
    for (let row = data.start.row; row <= data.end.row; row++) {
      out.push({
        name: labelCol ? abs1(q, row, r.start.col) : undefined,
        categories: headerRow ? absRange(q, rangeOf(r.start.row, data.start.col, r.start.row, data.end.col)) : undefined,
        values: absRange(q, rangeOf(row, data.start.col, row, data.end.col)),
      });
    }
  }
  return out.map(se => Object.fromEntries(Object.entries(se).filter(([, v]) => v !== undefined)));
}

/** Series of the areas of a selection: one area makes its block's series; several make a text category column and equal-height series columns. */
export function seriesFromAreas(content, si, areas, engine = engineFor(content)) {
  const first = areas[0];
  if (!first) throw bad('insert.chart', 'Select data for the chart first.');
  const bounds = areas.slice(1).reduce((r, a) => rangeOf(Math.min(r.start.row, a.start.row), Math.min(r.start.col, a.start.col), Math.max(r.end.row, a.end.row), Math.max(r.end.col, a.end.col)), first);
  if (areas.length === 1) {
    const byRows = width(first) > height(first) + 1;
    return {bounds, byRows, series: seriesFromRange(content, si, first, byRows, engine)};
  }
  let valid = width(first) === 1 && height(first) > 1 && areas.slice(1).every(a => width(a) === 1 && height(a) === height(first));
  if (valid) for (let row = first.start.row; row <= first.end.row; row++) { const v = valueOf(engine, si, row, first.start.col); if (!(typeof v === 'string' || v === null || v === undefined)) valid = false; }
  if (!valid) throw bad('insert.chart', 'multi-area charts require a text category column followed by equal-height series columns');
  const category = seriesFromRange(content, si, first, false, engine)[0]?.values;
  const series = areas.slice(1).map(a => {
    const item = seriesFromRange(content, si, a, false, engine).pop();
    if (!item) throw bad('insert.chart', 'Select data for the chart first.');
    if (!item.name) throw bad('insert.chart', 'multi-area series columns require headers');
    return {...item, categories: category};
  });
  return {bounds, byRows: false, series};
}

/** A scatter plot of a block without category labels takes its first column (or row) as the X values of the others (#428). */
export function scatterXFromFirst(kind, series) {
  // Bubble: three columns are X, Y and the bubble size (Excel's own reading of a bubble selection).
  if ((kind === 'bubble' || kind === 'bubble3d') && series.length >= 3 && !series[0].categories && !series[0].bubbleSizes) {
    const x = series.shift().values;
    for (const se of series) se.categories = x;
    series[0].bubbleSizes = series[1].values;
    series.splice(1, 1);
    return;
  }
  if ((kind === 'scatter' || kind === 'scatterLines') && series.length > 1 && !series[0].categories) {
    const x = series.shift().values;
    for (const se of series) se.categories = x;
  }
}

const REC = {
  column: ['column', '', 'Clustered Column'], bar: ['bar', '', 'Clustered Bar'], line: ['line', '', 'Line'], lineMarkers: ['line', 'markers', 'Line with Markers'],
  pie: ['pie', '', 'Pie'], doughnut: ['doughnut', '', 'Doughnut'], area: ['area', '', 'Area'], scatter: ['scatter', '', 'Scatter'],
  stackedColumn: ['column', 'stacked', 'Stacked Column'], stackedBar: ['bar', 'stacked', 'Stacked Bar'],
};

/** The cells of a series' value reference, as {sheet, range}. */
function valueRef(content, si, formula) {
  const [name, addr] = splitSheet(String(formula).trim().replace(/^=/, ''));
  const sheet = name === null ? si : sheetIndex(content, name);
  const range = parseRange(addr.replace(/\$/g, ''));
  return sheet >= 0 && range ? {sheet, range} : null;
}

/** Chart types that suit the shape of the data, best first, as [type, subtype, label]. */
export function recommendCharts(content, si, areas, engine = engineFor(content)) {
  if (areas.reduce((n, a) => n + rangeCount(a), 0) > MAX_CELLS_PER_CHART) throw bad('insert.chart', 'range too large for a chart');
  const {byRows, series} = seriesFromAreas(content, si, areas, engine);
  const refs = series.map(x => valueRef(content, si, x.values)).filter(Boolean);
  const points = refs[0] ? rangeCount(refs[0].range) : 0;
  let anyNumber = false, nonNegative = true;
  for (const r of refs) {
    for (let row = r.range.start.row; row <= r.range.end.row; row++) for (let col = r.range.start.col; col <= r.range.end.col; col++) {
      const v = valueOf(engine, r.sheet, row, col);
      if (typeof v === 'number') { anyNumber = true; nonNegative &&= v >= 0; }
    }
  }
  if (!series.length || !anyNumber) throw bad('insert.chart', 'Select data for the chart first.');
  const labelled = !!series[0].categories;
  const out = [];
  if (series.length === 2 && !labelled && !byRows) out.push(REC.scatter, REC.lineMarkers, REC.column);
  else if (series.length === 1) {
    if (points > 12) out.push(REC.line, REC.column, REC.area);
    else {
      out.push(REC.column, REC.bar);
      if (nonNegative && points >= 2) out.push(REC.pie, REC.doughnut);
      out.push(REC.lineMarkers);
    }
  } else if (points > 12) out.push(REC.line, REC.column, REC.area, REC.stackedColumn);
  else out.push(REC.column, REC.bar, REC.stackedColumn, REC.lineMarkers, REC.stackedBar);
  return out;
}

/** The block a chart's series come from, and whether each series is a row of it. */
export function seriesBlock(content, series) {
  let sheet = null, bounds = null, rows = 0;
  for (const s of series) {
    const parts = [s.values, s.categories, s.name];
    for (let i = 0; i < parts.length; i++) {
      const f = parts[i];
      if (f === undefined || f === null) continue;
      const [name, addr] = splitSheet(String(f).trim().replace(/^=/, ''));
      const r = name === null ? null : parseRange(addr.replace(/\$/g, ''));
      if (!r) return null;
      if (sheet === null) sheet = name; else if (sheet.toLowerCase() !== name.toLowerCase()) return null;
      if (i === 0 && height(r) === 1 && width(r) > 1) rows += 1;
      bounds = bounds ? rangeOf(Math.min(bounds.start.row, r.start.row), Math.min(bounds.start.col, r.start.col), Math.max(bounds.end.row, r.end.row), Math.max(bounds.end.col, r.end.col)) : r;
    }
  }
  if (!bounds) return null;
  return {source: `${quoteSheet(sheet)}!${rangeA1(bounds)}`, byRows: rows > 0 && rows === series.length};
}

/** The areas a chart insert works on: `range`, the selection's areas, else the block around the active cell. */
export function chartAreasFor(content, si, sel, areasParam) {
  if (areasParam?.length) return areasParam;
  if (sel.ranges.length > 1) return sel.ranges;
  const cur = sel.ranges[0];
  if (cur && (cur.start.row !== cur.end.row || cur.start.col !== cur.end.col)) return [cur];
  return [regionAround(content, si, sel.active)];
}

/** Clips a whole-column or whole-row block to the cells in use (files carry such references). */
export function clipToUsed(content, si, r) {
  const u = usedBounds(content.sheets[si]);
  if (!u) return r;
  return rangeOf(r.start.row, r.start.col, Math.max(r.start.row, Math.min(r.end.row, u.r1)), Math.max(r.start.col, Math.min(r.end.col, u.c1)));
}

export {a1};
