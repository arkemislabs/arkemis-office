// Insert > Charts: Insert Chart (every type the Insert tab lists), Recommended Charts and the chart
// properties a chart's own tabs set.
// Translated from gridcraft crates/engine/src/cmd/insert/chart.rs (`insert_chart`, `chart_set`,
// `chart_switch`, `chart_delete`, `find_chart`) and cmd/insert.rs (specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A chart is a floating object on the sheet: {id, kind, anchor, title, series: [{name, categories,
// values, ...}], legend, dataLabels, gridlines, style, xTitle, yTitle, source, byRows}. It draws from
// the series formulas, so it follows its cells. Insert Chart with no `type` takes the first of the
// types that suit the data (`insert.chartRecommendations`, what the Recommended Charts dialog lists).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1} from '../../lib/addr.mjs';
import {engineFor} from '../../model/calc.mjs';
import {hasDoc, gridSel, targetRanges, targetSheet, cellParamOn, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {bad, baseDoc, valueOf, parseRangeText, failed} from '../../lib/data-common.mjs';
import {nextObjectId, findObject, anchorCell, objectSelection, selectedObject, topZ, ANCHOR_MODES} from '../../lib/objects.mjs';
import {setGridSelection, rangeSelection} from '../../lib/edit-targets.mjs';
import {rangeCell} from '../../lib/addr.mjs';
import {CHART_KINDS} from '../../lib/chart-render.mjs';
import {chartKind, CHART_TYPES, seriesFromAreas, scatterXFromFirst, recommendCharts, seriesFromRange, seriesBlock, chartAreasFor, clipToUsed} from '../../lib/chart-build.mjs';
import {parseRef} from '../../lib/chart-resolve.mjs';
import {rangeA1, quoteSheet} from '../../lib/addr.mjs';
import {display} from '../../lib/value.mjs';
import {styleOf} from '../../lib/chart-styles.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/insert.rs', 'crates/engine/src/cmd/insert/chart.rs']};
const RANGE = s.optional(s.string({min: 1, max: 4096}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const LEGENDS = ['none', 'bottom', 'top', 'left', 'right'];
const TYPE = s.optional(s.enum(CHART_TYPES));
// The tiles of the Scatter menu that are one stored kind drawn another way: Smooth (scatterLines with smoothed series) and Straight (scatterLines).
const INSERT_KINDS = Object.freeze([...CHART_KINDS, 'scatterSmooth', 'scatterStraight']);
const KIND = s.optional(s.enum(INSERT_KINDS));
const NO_GRID = Object.freeze(['pie', 'doughnut', 'treemap', 'sunburst', 'funnel', 'pie3d', 'pieOfPie', 'barOfPie']);
const MENUS = ['columnBar', 'lineArea', 'pieDoughnut', 'scatterBubble', 'statistic', 'hierarchy'];

/** The tiles of each Insert chart menu, grouped as Excel groups them: [group, kind, label, icon]. 3-D, Pie of Pie and the like are not drawn by gridcraft. */
const TILES = {
  columnBar: [['2-D Column', 'columnClustered', 'Clustered Column', 'column-clustered'], ['2-D Column', 'columnStacked', 'Stacked Column', 'column-stacked'], ['2-D Column', 'columnStacked100', '100% Stacked Column', 'column-100'],
    ['2-D Bar', 'barClustered', 'Clustered Bar', 'bar-clustered'], ['2-D Bar', 'barStacked', 'Stacked Bar', 'bar-stacked'], ['2-D Bar', 'barStacked100', '100% Stacked Bar', 'bar-100']],
  lineArea: [['2-D Line', 'line', 'Line', 'line'], ['2-D Line', 'lineStacked', 'Stacked Line', 'line-stacked'], ['2-D Line', 'lineMarkers', 'Line with Markers', 'line-markers'],
    ['2-D Area', 'area', 'Area', 'area'], ['2-D Area', 'areaStacked', 'Stacked Area', 'area-stacked'], ['2-D Area', 'areaStacked100', '100% Stacked Area', 'area-100']],
  pieDoughnut: [['2-D Pie', 'pie', 'Pie', 'pie'], ['2-D Pie', 'pieOfPie', 'Pie of Pie', 'pie-of-pie'], ['2-D Pie', 'barOfPie', 'Bar of Pie', 'bar-of-pie'], ['3-D Pie', 'pie3d', '3-D Pie', 'pie-3d'], ['Doughnut', 'doughnut', 'Doughnut', 'doughnut']],
  scatterBubble: [['Scatter', 'scatter', 'Scatter', 'scatter'], ['Scatter', 'scatterSmooth', 'Scatter with Smooth Lines and Markers', 'scatter-smooth-markers'], ['Scatter', 'scatterStraight', 'Scatter with Straight Lines and Markers', 'scatter-straight-markers'],
    ['Scatter', 'scatterLines', 'Scatter with Lines', 'scatter-lines'], ['Bubble', 'bubble', 'Bubble', 'bubble'], ['Bubble', 'bubble3d', '3-D Bubble', 'bubble-3d']],
  statistic: [['Histogram', 'histogram', 'Histogram', 'histogram'], ['Histogram', 'pareto', 'Pareto', 'pareto'], ['Box and Whisker', 'boxWhisker', 'Box and Whisker', 'box-whisker']],
  hierarchy: [['Hierarchy', 'treemap', 'Treemap', 'treemap'], ['Hierarchy', 'sunburst', 'Sunburst', 'sunburst'], ['Waterfall', 'waterfall', 'Waterfall', 'waterfall'], ['Funnel', 'funnel', 'Funnel', 'funnel'],
    ['Radar', 'radar', 'Radar', 'radar'], ['Stock', 'stock', 'Stock', 'stock'], ['Combo', 'combo', 'Combo', 'combo']],
};
const tilesFor = menu => (TILES[menu] ?? []).map(([group, kind, label, icon]) => ({id: kind, label, value: kind, icon: `insert-chart-${icon}`, group, iconOnly: true}));
const SUBTYPE = s.optional(s.string({max: 20}));

function areasOf(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  if (typeof p.range === 'string' && p.range) { const t = targetRanges(ctx, p); return {si: t.sheet, areas: t.areas, content, sel}; }
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : sel.sheet;
  return {si, areas: chartAreasFor(content, si, sel, null), content, sel};
}

/** The chart `insert.chart` stores for these params (also what the dialog previews). */
export function buildChart(ctx, p) {
  const {si, areas, content} = areasOf(ctx, p);
  const engine = engineFor(content);
  let type = p.type ?? 'column', sub = p.subtype ?? '';
  if (type === 'auto') { const first = recommendCharts(content, si, areas, engine)[0] ?? ['column', '', '']; type = first[0]; sub = first[1]; }
  const smooth = p.kind === 'scatterSmooth' || (type === 'scatter' && sub === 'smooth');
  const kind = CHART_KINDS.includes(p.kind) ? p.kind : p.kind === 'scatterSmooth' || p.kind === 'scatterStraight' ? 'scatterLines' : chartKind(type, sub);
  const {bounds, byRows, series} = seriesFromAreas(content, si, areas, engine);
  if (!series.length) throw bad('insert.chart', 'Select data for the chart first.');
  scatterXFromFirst(kind, series);
  if (smooth) series.forEach(x => { x.smooth = true; });
  const at = cellParamOn(ctx, p, 'at', si) ?? {row: bounds.start.row, col: bounds.end.col + 2};
  let title = typeof p.title === 'string' ? p.title : undefined;
  if (title === undefined) {
    if (series.length === 1) { if (series[0].name) { const v = engine.evaluate(si, at, series[0].name); title = display(v); } } else title = 'Chart Title';
  }
  const mode = ANCHOR_MODES.includes(p.mode) ? p.mode : 'moveAndSize';
  const sheet = content.sheets[si];
  const chart = {
    id: nextObjectId(content), kind,
    anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: p.width ?? 480, height: p.height ?? 288, mode},
    ...topZ(sheet), series, legend: ['pie', 'doughnut', 'pie3d', 'pieOfPie', 'barOfPie'].includes(kind) ? 'right' : 'bottom', dataLabels: false,
    gridlines: !NO_GRID.includes(kind), style: 1, byRows,
  };
  if (title !== undefined) chart.title = title;
  if (areas.length === 1) chart.source = `${quoteSheet(sheet.name)}!${rangeA1(bounds)}`;
  return {si, chart};
}

function insertChart(ctx, p) {
  const {si, chart} = buildChart(ctx, p);
  requireSchema2(ctx, si);
  const sheet = ctx.doc.sheets[si];
  setIn(ctx.change, ['sheets', si, 'charts'], [...(sheet.charts ?? []), chart]);
  ctx.setSelection(objectSelection(sheet, 'chart', chart.id));
  return {chart: chart.id};
}

function chartRecommendations(ctx, p) {
  const {si, areas, content} = areasOf(ctx, p);
  return recommendCharts(content, si, areas).map(([type, subtype, label]) => ({type, subtype, label}));
}

function findChart(ctx, p) {
  const content = baseDoc(ctx);
  const picked = selectedObject(content, ctx.selection);
  // A selected chart is on its own sheet, whichever sheet the grid selection falls back to.
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : picked?.kind === 'chart' ? picked.si : gridSel(ctx).sheet;
  const sheet = content.sheets[si];
  const list = sheet.charts ?? [];
  const id = Number.isInteger(p.chart) ? p.chart : (picked?.kind === 'chart' && picked.si === si ? picked.id : list[list.length - 1]?.id);
  const hit = findObject(sheet, 'chart', id);
  if (!hit) throw bad('chart', 'no such chart');
  return {si, sheet, ...hit};
}

/** Edit objects: a protected sheet refuses changes to its charts unless Protect Sheet allowed it. */
export function guardObjects(sheet) {
  const pr = sheet?.protection;
  if (pr && pr.enabled !== false && !pr.objects) throw failed('The cell or chart you are trying to change is on a protected sheet. To make a change, unprotect the sheet.');
}

function chartSet(ctx, p) {
  const {si, index, object: c0, sheet: sh0} = findChart(ctx, p);
  requireSchema2(ctx, si);
  guardObjects(sh0);
  const c = {...c0, anchor: {...c0.anchor}};
  if (typeof p.type === 'string') c.kind = chartKind(p.type, p.subtype ?? '');
  if (p.quartiles !== undefined) c.series = c.series.map(x => ({...x, quartiles: p.quartiles}));
  if (p.title !== undefined) { if (p.title === null) delete c.title; else c.title = String(p.title); }
  if (p.legend !== undefined) c.legend = p.legend;
  if (typeof p.dataLabels === 'boolean') c.dataLabels = p.dataLabels;
  if (typeof p.gridlines === 'boolean') c.gridlines = p.gridlines;
  if (Number.isInteger(p.style)) {
    // A style is a palette with gridlines and data labels (core/grid/lib/chart-styles.mjs); the palette goes to the series that have no colour of their own.
    c.style = Math.min(16, Math.max(1, p.style));
    const [, grid, labels] = styleOf(c.style);
    if (typeof p.gridlines !== 'boolean') c.gridlines = grid && !NO_GRID.includes(c.kind);
    if (typeof p.dataLabels !== 'boolean') c.dataLabels = labels;
  }
  if (p.xTitle !== undefined) { if (p.xTitle === null) delete c.xTitle; else c.xTitle = String(p.xTitle); }
  if (p.yTitle !== undefined) { if (p.yTitle === null) delete c.yTitle; else c.yTitle = String(p.yTitle); }
  const at = cellParamOn(ctx, p, 'at', si);
  if (at) c.anchor.cell = a1(at.row, at.col);
  if (typeof p.width === 'number') c.anchor.width = Math.min(10000, Math.max(20, p.width));
  if (typeof p.height === 'number') c.anchor.height = Math.min(10000, Math.max(20, p.height));
  if (typeof p.dx === 'number') c.anchor.dx = p.dx;
  if (typeof p.dy === 'number') c.anchor.dy = p.dy;
  ctx.change.set(['sheets', si, 'charts', index], c);
  return null;
}

function chartSwitch(ctx, p) {
  const {si, index, object: c, sheet: sh0} = findChart(ctx, p);
  requireSchema2(ctx, si);
  guardObjects(sh0);
  const content = baseDoc(ctx);
  // Charts read from a file have no source range: take the block their series span.
  const block = c.source ? {source: c.source, byRows: !!c.byRows} : seriesBlock(content, c.series);
  if (!block) return null;
  const [sheetName, body] = block.source.split(/!(?=[^!]*$)/);
  const ref = parseRef(content, si, `${sheetName}!${body}`);
  if (!ref) return null;
  let r = clipToUsed(content, ref.sheet, ref.range);
  if ((r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1) > 1_000_000) throw bad('chart.switchRowColumn', 'range too large for a chart');
  const byRows = !block.byRows;
  const series = seriesFromRange(content, ref.sheet, r, byRows);
  scatterXFromFirst(c.kind, series);
  ctx.change.set(['sheets', si, 'charts', index], {...c, source: c.source ?? block.source, byRows, series});
  return null;
}

function chartDelete(ctx, p) {
  const {si, index, object, sheet: sh0} = findChart(ctx, p);
  requireSchema2(ctx, si);
  guardObjects(sh0);
  const list = ctx.doc.sheets[si].charts;
  ctx.change.set(['sheets', si, 'charts'], list.filter((_, i) => i !== index));
  if (selectedObject(ctx.doc, ctx.selection)?.kind === 'chart') setGridSelection(ctx, rangeSelection(si, rangeCell(anchorCell(object.anchor))));
  return null;
}

export {findChart};

export default defineCommands({
  family: 'insert/charts',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'insert.chart', label: 'Insert Chart', risk: 'edit', dialog: 'dialog.recommendedCharts',
      description: 'Insert a chart of the selected data (or `range`) on the sheet: kind (an exact chart kind such as columnStacked, which the menu tiles send), or type column|bar|line|pie|doughnut|area|scatter|bubble|radar|combo|histogram|waterfall|funnel|treemap|sunburst|boxWhisker|stock|auto, subtype clustered|stacked|stacked100|markers|lines, title, at (top-left cell), width, height. → {chart: id}.',
      params: s.object({range: RANGE, sheet: SHEET, type: TYPE, subtype: SUBTYPE, kind: KIND, menu: s.optional(s.enum(MENUS)), title: s.optional(s.string({max: 255})), at: s.optional(s.string({max: 100})),
        width: s.optional(s.number({min: 20, max: 10000})), height: s.optional(s.number({min: 20, max: 10000})), mode: s.optional(s.enum(ANCHOR_MODES))}),
      state: (ctx, p) => ({...hasDoc(ctx), ...(p?.menu ? {value: tilesFor(p.menu)} : {})}),
      run: insertChart,
    },
    {
      id: 'insert.recommendedCharts', label: 'Recommended Charts', risk: 'edit', dialog: 'dialog.recommendedCharts',
      description: 'Insert the first recommended chart for the data (or the given `type`); the ribbon button opens the Insert Chart dialog instead.',
      params: s.object({range: RANGE, sheet: SHEET, type: TYPE, subtype: SUBTYPE}),
      state: hasDoc,
      run: (ctx, p) => insertChart(ctx, p.type === undefined ? {...p, type: 'auto'} : p),
    },
    {
      id: 'insert.chartRecommendations', label: 'Chart Recommendations', risk: 'read',
      description: 'The chart types that suit the shape of the data, best first: [{type, subtype, label}].',
      params: s.object({range: RANGE, sheet: SHEET}),
      state: hasDoc,
      run: chartRecommendations,
    },
    {
      id: 'chart.set', label: 'Chart Properties', risk: 'edit',
      description: 'Change a chart: type, subtype, title, legend none|bottom|top|left|right, dataLabels, gridlines, quartiles, style 1-16, xTitle, yTitle, at, width, height, dx, dy. `chart` is its id (default: the selected or last chart).',
      params: s.object({chart: s.optional(s.integer({min: 0})), sheet: SHEET, type: TYPE, subtype: SUBTYPE, title: s.optional(s.nullable(s.string({max: 255}))), legend: s.optional(s.enum(LEGENDS)),
        dataLabels: s.optional(s.boolean()), gridlines: s.optional(s.boolean()), quartiles: s.optional(s.enum(['exclusive', 'inclusive'])), style: s.optional(s.integer({min: 1, max: 16})),
        xTitle: s.optional(s.nullable(s.string({max: 255}))), yTitle: s.optional(s.nullable(s.string({max: 255}))), at: s.optional(s.string({max: 100})),
        width: s.optional(s.number({min: 20, max: 10000})), height: s.optional(s.number({min: 20, max: 10000})), dx: s.optional(s.number()), dy: s.optional(s.number())}),
      state: hasDoc,
      run: chartSet,
    },
    {
      id: 'chart.switchRowColumn', label: 'Switch Row/Column', risk: 'edit',
      description: 'Plot the rows as series instead of the columns (and back).',
      params: s.object({chart: s.optional(s.integer({min: 0})), sheet: SHEET}),
      state: hasDoc,
      run: chartSwitch,
    },
    {
      id: 'chart.delete', label: 'Delete Chart', risk: 'edit',
      description: 'Delete a chart (default: the selected or last chart).',
      params: s.object({chart: s.optional(s.integer({min: 0})), sheet: SHEET}),
      state: hasDoc,
      run: chartDelete,
    },
  ],
});
