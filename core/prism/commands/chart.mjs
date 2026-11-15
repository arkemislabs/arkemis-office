// Charts: Insert > Chart, Chart Design (Change Chart Type, Edit Data, Switch Row/Column, Add Chart Element, Change Colors).
// Translated from deckcraft crates/engine/src/cmd/insert/chart.rs (`chart`, `chart_type_cmd`, `chart_data`, `chart_options`)
// at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The chart model, its drawing and its chart part are core/prism/lib/chart.mjs (on the spreadsheet's chart engine).
// Any command that changes a chart drops `raw`, the original chart part kept from a file, so the saved file carries the
// edited chart (deckcraft does the same). Not translated: the chart options the shared engine does not draw
// (`binCount`, `binSize`, `subtotals`, `quartiles`, `upDownBars`), noted in docs/spec/patches/prism/chart.json.
// Added beyond deckcraft: `chart.options` {showTitle, showXTitle, showYTitle, xTitle, yTitle} for Add Chart Element, and
// `chart.data` {table, switchRowColumn} for the Edit Data grid and Switch Row/Column (not checked against upstream).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {
  UPSTREAM_COMMIT, bad, hasSlide, rectParam, addShape, editShapes, colorValue,
} from '../lib/shape-common.mjs';
import {selectedShapes} from '../lib/format-text.mjs';
import {isSchema2} from '../model/doc.mjs';
import {sampleChart, retype, typeId, UNDRAWN, TYPE_IDS, fromTable, PALETTES, seriesColor, sheetOf, parseSheetRange, rangeText} from '../lib/chart.mjs';
import {QUICK_LAYOUTS, STYLES as GRID_STYLES} from '../../grid/lib/chart-styles.mjs';
import {resolveColor} from '../model/style.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/insert/chart.rs', 'crates/model/src/chart.rs']};

const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const rect = s.optional(s.array(s.number(), {min: 4, max: 4, description: '[x, y, w, h] pt'}));
const SERIES = s.optional(s.array(s.object({
  name: s.optional(s.string({max: 255})), values: s.optional(s.array(s.any(), {max: 20000})),
  xValues: s.optional(s.array(s.any(), {max: 20000})), sizes: s.optional(s.array(s.any(), {max: 20000})),
}), {max: 255}));
const MAX_SERIES = 255;

const noChart = {enabled: false, reason: 'select a chart'};
const charts = ctx => (isSchema2(ctx.doc) ? selectedShapes(ctx).filter(sh => sh.kind?.type === 'chart') : []);
const onChart = ctx => (charts(ctx).length ? {enabled: true} : noChart);

const text = v => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const cell = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const seriesOf = list => (list ?? []).slice(0, MAX_SERIES).map(x => {
  const o = {name: text(x?.name) || 'Series', values: (x?.values ?? []).map(cell)};
  if (Array.isArray(x?.xValues)) o.xValues = x.xValues.map(cell);
  if (Array.isArray(x?.sizes)) o.sizes = x.sizes.map(cell);
  return o;
});

function unsupported(cmd, name) {
  const k = String(name ?? '').toLowerCase().replace(/[-_ ]/g, '');
  return UNDRAWN[k] ? bad(cmd, `${UNDRAWN[k]} charts are not offered: the chart engine does not draw them`) : null;
}

function insertChart(ctx, p) {
  const err = unsupported('insert.chart', p.type);
  if (err) throw err;
  const c = sampleChart(typeId(p.type ?? 'column'));
  if (Array.isArray(p.categories)) c.categories = p.categories.map(text);
  if (Array.isArray(p.series)) c.series = seriesOf(p.series);
  if ('title' in p) c.title = typeof p.title === 'string' ? p.title : null;
  const size = ctx.doc.slideSize ?? {width: 960, height: 540};
  const r = rectParam(p, 'rect') ?? {x: size.width * 0.15, y: size.height * 0.15, w: size.width * 0.7, h: size.height * 0.7};
  const id = addShape(ctx, 'insert.chart', {xfrm: r, kind: c}, true);
  return {id};
}

function withCharts(ctx, p, cmd, f) {
  editShapes(ctx, p, cmd, sh => {
    if (sh.kind?.type !== 'chart') throw bad(cmd, 'not a chart');
    const c = {...sh.kind};
    f(c);
    delete c.raw;
    sh.kind = c;
  });
  return {};
}

function chartType(ctx, p) {
  const err = unsupported('chart.type', p.type);
  if (err) throw err;
  const id = typeId(p.type);
  return withCharts(ctx, p, 'chart.type', c => { Object.assign(c, retype(structuredClone(c), id)); });
}

/** Switch Row/Column: the series become the categories and the other way round. */
function transpose(c) {
  const rows = Math.max(c.categories.length, ...c.series.map(x => x.values.length), 0);
  const series = Array.from({length: rows}, (_, r) => ({name: c.categories[r] || `Series ${r + 1}`, values: c.series.map(x => x.values[r] ?? null)}));
  return {categories: c.series.map(x => x.name), categoryLevels: [], series};
}

function chartData(ctx, p) {
  const xy = ch => ch.chartType === 'scatter' || ch.chartType === 'bubble';
  return withCharts(ctx, p, 'chart.data', c => {
    if (p.switchRowColumn) {
      if (xy(c)) throw bad('chart.data', 'a scatter or bubble chart has no categories to switch');
      Object.assign(c, transpose(c));
      delete c.sheet; delete c.range;
      return;
    }
    if (Array.isArray(p.table)) {
      const t = fromTable(p.table, c.chartType);
      const old = c.series;
      delete c.sheet; delete c.range;
      c.categories = t.categories;
      c.series = t.series.map((n, i) => ({...(old[i] ?? {}), ...n}));
      return;
    }
    if (Array.isArray(p.categories)) c.categories = p.categories.map(text);
    if (Array.isArray(p.levels)) c.categoryLevels = p.levels.slice(0, 16).map(l => (Array.isArray(l) ? l.map(text) : []));
    if (Array.isArray(p.series)) {
      // Series formatting is kept by position.
      const old = c.series;
      c.series = seriesOf(p.series).map((n, i) => ({...(old[i] ?? {}), ...n}));
    }
  });
}

const LEGENDS = ['bottom', 'top', 'left', 'right'];

function chartOptions(ctx, p) {
  let textColor;
  if ('textColor' in p) {
    if (p.textColor === null) textColor = null;
    else {
      textColor = colorValue(p.textColor);
      if (!textColor) throw bad('chart.options', '`textColor` is a colour: #RRGGBB, accent1…accent6, tx1…, or null');
    }
  }
  if (typeof p.legend === 'string' && !['none', ...LEGENDS, 'b', 't', 'l', 'r'].includes(p.legend)) throw bad('chart.options', '`legend` is none, bottom, top, left or right');
  if (typeof p.palette === 'string' && !/^((colorful|monochrome)\d{0,2}|accent[1-6])$/.test(p.palette)) throw bad('chart.options', '`palette` is colorful1…, monochrome1… or accent1…accent6');
  return withCharts(ctx, p, 'chart.options', c => {
    if (textColor !== undefined) c.textColor = textColor;
    if ('title' in p) c.title = typeof p.title === 'string' ? p.title : null;
    if (typeof p.showTitle === 'boolean') c.title = p.showTitle ? (typeof c.title === 'string' && c.title ? c.title : 'Chart Title') : null;
    if ('legend' in p) {
      const l = p.legend;
      c.legend = l === null || l === 'none' ? null : ({b: 'bottom', t: 'top', l: 'left', r: 'right'})[l] ?? l;
    }
    if (typeof p.dataLabels === 'boolean') {
      c.dataLabels = p.dataLabels;
      // A series' own setting would otherwise keep overriding the chart-wide switch.
      for (const x of c.series) delete x.dataLabels;
    }
    if (typeof p.gridlines === 'boolean') c.gridlines = p.gridlines;
    if (typeof p.palette === 'string') c.palette = p.palette;
    for (const [key, show, def] of [['xTitle', 'showXTitle', 'Axis Title'], ['yTitle', 'showYTitle', 'Axis Title']]) {
      if (key in p) c[key] = typeof p[key] === 'string' ? p[key] : null;
      if (typeof p[show] === 'boolean') c[key] = p[show] ? (typeof c[key] === 'string' && c[key] ? c[key] : def) : null;
    }
  });
}

/** The checked state of an option command: every given option equals the first selected chart's. */
function optionState(ctx, p) {
  const st = onChart(ctx);
  if (!st.enabled) return st;
  const c = charts(ctx)[0].kind;
  const has = v => v !== undefined;
  // A toggle names the option it flips in `field` (its value is the placeholder the ribbon fills in).
  if (p?.field === 'showXTitle' || p?.field === 'showYTitle') return {enabled: true, checked: !!c[p.field === 'showXTitle' ? 'xTitle' : 'yTitle']};
  if (p?.field === 'gridlines') return {enabled: true, checked: c.gridlines !== false};
  const checks = [];
  if (has(p?.legend)) checks.push((p.legend === 'none' || p.legend === null ? null : p.legend) === c.legend);
  if (has(p?.dataLabels)) checks.push(!!p.dataLabels === !!c.dataLabels);
  if (has(p?.gridlines)) checks.push(!!p.gridlines === (c.gridlines !== false));
  if (has(p?.showTitle)) checks.push(!!p.showTitle === (typeof c.title === 'string' && c.title !== ''));
  if (has(p?.showXTitle)) checks.push(!!p.showXTitle === !!c.xTitle);
  if (has(p?.showYTitle)) checks.push(!!p.showYTitle === !!c.yTitle);
  if (has(p?.palette)) checks.push(String(p.palette).replace(/\d+$/, '') === String(c.palette ?? 'colorful1').replace(/\d+$/, ''));
  return {enabled: true, checked: checks.length ? checks.every(Boolean) : false};
}


// ---------------------------------------------------------------------------------------------
// Quick Layout, Chart Styles (the looks of core/grid/lib/chart-styles.mjs, which Excel's chart tabs share) and Select Data

const themeOf = ctx => ctx.doc?.masters?.[0]?.theme?.colors;
const hexOf = c => `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
/** The first `n` series colours of a palette in the deck's theme, as hex strings (the swatches of a tile). */
const swatches = (ctx, palette, n) => Array.from({length: n}, (_, i) => hexOf(seriesColor({palette}, i, ref => resolveColor(ref, themeOf(ctx)))));
const chartTile = (colors, {grid = true, labels = false, legend = 'bottom', axes = false} = {}) => ({kind: 'chart', colors, grid, labels, legend, axes});

function quickLayout(ctx, p) {
  const n = QUICK_LAYOUTS[p.layout] ? p.layout : 1;
  const [legend, labels, grid, axes] = QUICK_LAYOUTS[n];
  return withCharts(ctx, p, 'chart.quickLayout', c => {
    c.legend = legend === 'none' ? null : legend;
    c.dataLabels = labels;
    c.gridlines = grid;
    if (axes) { c.xTitle = c.xTitle || 'Axis Title'; c.yTitle = c.yTitle || 'Axis Title'; } else { c.xTitle = null; c.yTitle = null; }
    for (const x of c.series) delete x.dataLabels;
  });
}

function styleGallery(ctx, p) {
  const [palette, grid, labels] = GRID_STYLES[p.style - 1];
  return withCharts(ctx, p, 'chart.styleGallery', c => {
    c.palette = palette === 'colorful' ? 'colorful1' : palette === 'monochrome' ? 'monochrome1' : palette;
    c.gridlines = grid;
    c.dataLabels = labels;
    c.style = p.style;
    for (const x of c.series) { delete x.dataLabels; delete x.color; }
  });
}

/** Select Data: the range of the chart's worksheet (headers included) the series and categories are read from. */
function selectData(ctx, p) {
  return withCharts(ctx, p, 'chart.selectData', c => {
    const table = sheetOf(c);
    const width = Math.max(1, ...table.map(r => r.length));
    const range = typeof p.range === 'string' ? parseSheetRange(p.range) : null;
    if (typeof p.range === 'string' && !range) throw bad('chart.selectData', `not a range: \`${p.range}\``);
    if (range) {
      if (range.r2 >= table.length || range.c2 >= width) throw bad('chart.selectData', `the worksheet is ${rangeText({r1: 0, c1: 0, r2: table.length - 1, c2: width - 1})}: the range goes outside it`);
      if (range.r1 === range.r2 || range.c1 === range.c2) throw bad('chart.selectData', 'the range needs a header row and a first column besides the values');
      const sub = table.slice(range.r1, range.r2 + 1).map(row => Array.from({length: range.c2 - range.c1 + 1}, (_, k) => row[range.c1 + k] ?? ''));
      const t = fromTable(sub, c.chartType);
      const old = c.series;
      c.sheet = table;
      c.range = rangeText(range);
      c.categories = t.categories;
      c.categoryLevels = [];
      c.series = t.series.map((n, i) => ({...(old[i] ?? {}), ...n}));
    }
    const drop = [...new Set((p.removeSeries ?? []).filter(Number.isInteger))].sort((a, b) => b - a);
    for (const i of drop) if (i < c.series.length && c.series.length > 1) c.series.splice(i, 1);
  });
}

export default defineCommands({
  family: 'chart',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.chart', label: 'Chart…', risk: 'edit', state: hasSlide, dialog: 'dialog.insertChart',
      description: `{type?: ${TYPE_IDS.join('|')}, rect?: [x,y,w,h] pt, categories?: string[], series?: [{name, values, xValues?, sizes?}], title?: string|null} — a chart on the current slide with sample data`,
      params: s.object({type: s.optional(s.string({max: 64})), rect, categories: s.optional(s.array(s.any(), {max: 20000})), series: SERIES, title: s.optional(s.any())}),
      run: insertChart},
    {id: 'chart.type', label: 'Change Chart Type', risk: 'edit', state: ctx => { const st = onChart(ctx); return st.enabled ? {enabled: true, value: charts(ctx)[0].kind.chartType} : st; },
      dialog: 'dialog.changeChartType',
      description: `{type: ${TYPE_IDS.join('|')}, id?} — change the type of the selected chart(s), keeping the data`,
      params: s.object({type: s.string({max: 64}), id: s.optional(ID), ids: s.optional(s.array(ID))}), run: chartType},
    {id: 'chart.data', label: 'Edit Data', risk: 'edit', state: onChart, dialog: 'dialog.chartData',
      description: '{categories?: string[], levels?: string[][], series?: [{name, values, xValues?, sizes?}], table?: string[][] (first row series names, first column categories), switchRowColumn?: true, id?}',
      params: s.object({categories: s.optional(s.array(s.any(), {max: 20000})), levels: s.optional(s.array(s.any(), {max: 16})), series: SERIES,
        table: s.optional(s.array(s.array(s.any(), {max: 1000}), {max: 20000})), switchRowColumn: s.optional(s.boolean()), id: s.optional(ID), ids: s.optional(s.array(ID))}),
      run: chartData},
    {id: 'chart.quickLayout', label: 'Quick Layout', risk: 'edit', description: '{layout: 1..6, id?}: the legend, data labels, gridlines and axis titles of one of the six quick layouts',
      params: s.object({layout: s.integer({min: 1, max: 6}), id: s.optional(ID), ids: s.optional(s.array(ID))}),
      state: ctx => {
        const st = onChart(ctx);
        if (!st.enabled) return st;
        const c = charts(ctx)[0].kind;
        return {...st, value: Object.entries(QUICK_LAYOUTS).map(([n, [legend, labels, grid, axes]]) => ({id: n, label: `Layout ${n}`, value: Number(n),
          art: chartTile(swatches(ctx, c.palette, 3), {grid, labels, legend, axes})}))};
      }, run: quickLayout},
    {id: 'chart.styleGallery', label: 'Chart Styles', risk: 'edit', description: '{style: 1..16, id?}: a palette with its gridlines and data labels (the sixteen looks Excel Chart Styles share)',
      params: s.object({style: s.integer({min: 1, max: 16}), id: s.optional(ID), ids: s.optional(s.array(ID))}),
      state: ctx => {
        const st = onChart(ctx);
        if (!st.enabled) return st;
        const cur = charts(ctx)[0].kind.style;
        return {...st, value: GRID_STYLES.map(([palette, grid, labels], i) => ({id: String(i + 1), label: `Style ${i + 1}`, value: i + 1, selected: cur === i + 1,
          art: chartTile(swatches(ctx, palette === 'colorful' ? 'colorful1' : palette === 'monochrome' ? 'monochrome1' : palette, 3), {grid, labels})}))};
      }, run: styleGallery},
    {id: 'chart.selectData', label: 'Select Data', risk: 'edit', state: onChart, dialog: 'dialog.selectData',
      description: '{range?: "A1:D5" (the chart worksheet, headers included), removeSeries?: [index], id?}',
      params: s.object({range: s.optional(s.string({max: 100})), removeSeries: s.optional(s.array(s.integer({min: 0}), {max: 255})), id: s.optional(ID), ids: s.optional(s.array(ID))}),
      run: selectData},
    {id: 'chart.options', label: 'Chart Elements', risk: 'edit', state: optionState,
      description: `{title?: string|null, showTitle?: bool, legend?: none|bottom|top|left|right, dataLabels?: bool, gridlines?: bool, palette?: ${PALETTES.map(x => x[0]).join('|')}, xTitle?, yTitle?: string|null, showXTitle?, showYTitle?: bool, textColor?: colour|null, id?}`,
      params: s.object({title: s.optional(s.any()), showTitle: s.optional(s.boolean()), legend: s.optional(s.any()), dataLabels: s.optional(s.boolean()),
        gridlines: s.optional(s.boolean()), palette: s.optional(s.string({max: 24})), xTitle: s.optional(s.any()), yTitle: s.optional(s.any()),
        showXTitle: s.optional(s.boolean()), showYTitle: s.optional(s.boolean()), field: s.optional(s.string({max: 24})), textColor: s.optional(s.any()), id: s.optional(ID), ids: s.optional(s.array(s.any()))}),
      run: chartOptions},
  ],
});

