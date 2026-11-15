// Insert › Illustrations › Chart and the Chart Design tab: insert a chart, change its type, edit its data, add or remove its title,
// legend and data labels, and the Chart Layouts and Chart Styles galleries.
//
// Translated from wordcraft crates/engine/src/cmd/chart.rs (`insert.chart`, `chart.type`, `chart.editData`, `chart.title`,
// `chart.legend`, `chart.dataLabels`) at aadb077e072b7de05f724e359d8db82e151f125c, checked against wordcraft 0.13.1 (f2dfa0d); the model is
// core/quill/model/chart.mjs. What Word adds (U:quill/chart), reusing Grid's chart code instead of translating it again: the chart is
// drawn by Grid's chart renderer (core/quill/lib/chart-draw.mjs), the kinds, the six Quick Layouts, the sixteen Chart Styles and the
// Change Colors palettes are Grid's (core/grid/lib/chart-styles.mjs, gridcraft cmd/extra/chart.rs), the tiles are the TileArt chart art
// Grid's galleries use, and Edit Data works on the chart's embedded sheet (a table: the first row names the series, the first column
// the categories) that Word keeps in the chart part.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A chart is an inline \`graphic\` object whose \`graphic.chart\` is the model; a chart read from a file that has no model (made by
// another program) is kept as it is and the chart commands refuse it.
// Not here (hidden): Axes, Data Table, Error Bars, Lines, Trendline and Up/Down Bars (not drawn by the renderer), Select Data (the
// embedded sheet is edited in Edit Data), Refresh Data, Chart Title Centered Overlay, and the Size boxes (charts are resized on the page).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {selectedObjects} from '../context.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {sampleChart, sanitizedChart, chartTypeFromId, legendPosFromId, chartTable, chartFromTable, switchRowColumn, cleanChartText, WORD_TYPES, MAX_POINTS, MAX_SERIES, chartTypeLabel} from '../model/chart.mjs';
import {gridTheme, paletteColorN} from '../lib/chart-draw.mjs';
import {QUICK_LAYOUTS, PALETTES, STYLES, styleOf} from '../../grid/lib/chart-styles.mjs';
import {resolveColor, hex} from '../../grid/model/style.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/chart.rs']};

/** A new chart's size: 15 x 7.5 cm, points. */
export const DEFAULT_W = (15 / 2.54) * 72;
export const DEFAULT_H = (7.5 / 2.54) * 72;
const ELEMENTS = ['title', 'legend', 'dataLabels', 'gridlines', 'axisTitles'];

const bad = m => new CommandError('invalid_params', m);
const disabled = m => new CommandError('disabled', m);
const isChart = o => o?.type === 'graphic' && !!o.graphic?.chart;

/** The chart in the selection (or just before the caret): {pos, obj}, or null. */
export function pickChart(S) {
  const [a, b] = T.ordered(S.sel);
  if (a.story !== b.story) return null;
  return selectedObjects(S.d.content, a, b, 1, isChart)[0] ?? null;
}

export function chartState(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  try {
    const S = T.open(ctx);
    return pickChart(S) ? {enabled: true} : {enabled: false, reason: 'select a chart first'};
  } catch { return {enabled: false, reason: 'select a chart first'}; }
}

/** The theme the document's charts are drawn in. */
const themeOf = ctx => gridTheme(ctx.doc?.settings?.themeColors);

/** Change the selected chart's model with `f(spec, S)`, which edits the copy it is given (or returns a new one). */
export function edit(ctx, f) {
  const S = T.open(ctx);
  const hit = pickChart(S);
  if (!hit) throw disabled('select a chart first');
  const spec = structuredClone(hit.obj.graphic.chart);
  const next = sanitizedChart(f(spec, S) ?? spec);
  const para = S.d.paraMut(hit.pos.story, hit.pos.path);
  // An edit makes the chart ours: the chart part read from a file (graphic.raw) is no longer written back as it was.
  const {raw: _kept, ...graphic} = hit.obj.graphic;
  P.setObjectAt(para, hit.pos.off, {...hit.obj, graphic: {...graphic, chart: next}});
  return T.finish(S, {chart: next});
}

// ---- data from outside ------------------------------------------------------------------------------------

const cell = v => (typeof v === 'string' ? cleanChartText(v) : v === null || v === undefined ? '' : cleanChartText(String(v)));
const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
function categoriesOf(v) {
  if (!Array.isArray(v)) throw bad('`categories`: an array of strings');
  return v.slice(0, MAX_POINTS).map(cell);
}
function seriesOf(v) {
  if (!Array.isArray(v)) throw bad('`series`: [{"name": string, "values": [number|null]}]');
  return v.slice(0, MAX_SERIES).map(x => {
    const values = x?.values;
    if (values !== undefined && values !== null && !Array.isArray(values)) throw bad('`values`: an array of numbers (null for none)');
    return {name: cell(x?.name), values: (values ?? []).slice(0, MAX_POINTS).map(num)};
  });
}

// ---- insert ----------------------------------------------------------------------------------------------

function insertChart(ctx, p) {
  const type = p.type === undefined || p.type === null ? null : chartTypeFromId(p.type);
  if (p.type !== undefined && p.type !== null && !type) throw bad(`unknown chart type \`${p.type}\`: ${WORD_TYPES.join('|')}`);
  // No type and no data: Insert › Chart's picker, as the ribbon button does.
  if (!type && p.data === undefined) return {...T.selResult(T.open(ctx)), ui: {open: 'insertChart'}};
  const spec = sampleChart(type ?? 'column');
  if (p.data !== undefined) {
    spec.categories = p.data.categories === undefined ? [] : categoriesOf(p.data.categories);
    spec.series = p.data.series === undefined ? [] : seriesOf(p.data.series);
    if (!spec.series.length) throw bad('`data.series` needs at least one series');
  }
  spec.title = typeof p.title === 'string' ? p.title : null;
  if (p.legend !== undefined) {
    if (String(p.legend).toLowerCase() === 'none') spec.legend = null;
    else { spec.legend = legendPosFromId(p.legend); if (!spec.legend) throw bad('`legend`: right|left|top|bottom|none'); }
  }
  spec.dataLabels = p.dataLabels === true;
  const S = T.open(ctx);
  // Fitted to the text width, as Word sizes a new chart.
  const maxW = Math.max(T.firstTextWidth(S), 36);
  const w = Math.min(Math.max(36, Math.min(2000, p.width ?? DEFAULT_W)), maxW);
  const h = Math.max(36, Math.min(2000, p.height ?? DEFAULT_H));
  const chart = sanitizedChart(spec);
  const obj = {type: 'graphic', w, h, alt: '', float: P.defaultFloat(), graphic: {kind: 'chart', chart}};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, obj, props);
  S.sel = {anchor: T.clonePos(at), focus: end};
  S.cells = null;
  return T.finish(S, {chart, width: w, height: h});
}

// ---- Chart Design ----------------------------------------------------------------------------------------

/** Add Chart Element: a title, legend, data labels, gridlines or axis titles on or off. */
function addElement(spec, p) {
  const on = p.on !== false;
  switch (p.element ?? 'title') {
    case 'title': spec.title = on ? (spec.title || 'Chart Title') : null; break;
    case 'legend': spec.legend = on ? (legendPosFromId(p.position) ?? spec.legend ?? 'bottom') : null; break;
    case 'dataLabels': spec.dataLabels = on; break;
    case 'gridlines': if (on) delete spec.gridlines; else spec.gridlines = false; break;
    case 'axisTitles':
      if (on) { spec.xTitle = spec.xTitle || 'Axis Title'; spec.yTitle = spec.yTitle || 'Axis Title'; } else { delete spec.xTitle; delete spec.yTitle; }
      break;
    default: throw bad(`unknown element \`${p.element}\`: ${ELEMENTS.join(', ')}`);
  }
  return spec;
}

/** Quick Layout 1 to 6: the legend, data labels, gridlines and axis titles together (gridcraft quick_layout). */
function quickLayout(spec, n) {
  const [legend, labels, grid, axes] = QUICK_LAYOUTS[n] ?? QUICK_LAYOUTS[1];
  spec.legend = legend === 'none' ? null : legend;
  spec.dataLabels = labels;
  if (grid) delete spec.gridlines; else spec.gridlines = false;
  if (axes) { spec.xTitle = spec.xTitle || 'Axis Title'; spec.yTitle = spec.yTitle || 'Axis Title'; } else { delete spec.xTitle; delete spec.yTitle; }
  return spec;
}

const HEXRE = /^#?[0-9a-fA-F]{6}$/;
/** Change Colors: every series takes the palette's colour (the theme's own cycle for \`colorful\`) or one of your own. */
function changeColors(spec, theme, p) {
  const explicit = Array.isArray(p.colors) ? p.colors.filter(x => HEXRE.test(String(x))).map(x => `#${String(x).replace('#', '').toUpperCase()}`) : null;
  spec.series = spec.series.map((x, i) => {
    const {color: _old, ...rest} = x;
    const own = explicit?.length ? explicit[i % explicit.length] : hex(resolveColor(paletteColorN(p.palette ?? 'colorful', i, spec.series.length), theme));
    return own ? {...rest, color: own} : rest;
  });
  return spec;
}

/** Chart Styles 1 to 16: a palette with its gridlines and data labels (Grid's STYLES). */
function applyStyle(spec, n) {
  const [, grid, labels] = styleOf(n);
  spec.style = n;
  spec.series = spec.series.map(({color: _c, ...rest}) => rest);
  spec.dataLabels = labels;
  if (grid) delete spec.gridlines; else spec.gridlines = false;
  return spec;
}

// ---- galleries drawn as tiles ------------------------------------------------------------------------------

const paletteArt = (name, theme, n = 6) => Array.from({length: n}, (_, i) => hex(resolveColor(paletteColorN(name, i, n) ?? {theme: 4 + (i % 6), tint: 0}, theme)) ?? '#888888');
const chartArt = (colors, {grid = true, labels = false, legend = 'bottom', axes = false, type = 'column'} = {}) => ({kind: 'chart', colors, grid, labels, legend, axes, type});
/** The selected chart's type, so the style and layout tiles are drawn as that kind of chart (Word redraws the gallery for the chart type). */
const typeOf = ctx => { try { return pickChart(T.open(ctx)).obj.graphic.chart.type ?? 'column'; } catch { return 'column'; } };

export default defineCommands({
  family: 'chart',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.chart', label: 'Chart', risk: 'edit', state: T.ready, dialog: 'dialog.chartType',
      description: `Chart (Insert › Illustrations): a chart at the caret (\`type\` ${WORD_TYPES.join('|')}; \`data\` {categories, series: [{name, values}]}; \`title\`; \`legend\` right|left|top|bottom|none; \`dataLabels\`; \`width\`, \`height\` in points); with no type and no data, asks for the chart type picker.`,
      params: s.object({type: s.optional(s.string({max: 32})), data: s.optional(s.object({categories: s.optional(s.array(s.any())), series: s.optional(s.array(s.any()))})), title: s.optional(s.string({max: 255})),
        legend: s.optional(s.string({max: 16})), dataLabels: s.optional(s.boolean()), width: s.optional(s.number()), height: s.optional(s.number())}),
      run: insertChart},
    {id: 'chart.size', label: 'Chart Size', risk: 'edit',
      state: (ctx, p) => {
        const st = chartState(ctx);
        if (!st.enabled) return st;
        try { const o = pickChart(T.open(ctx)).obj; return {...st, value: Math.round((p?.width !== undefined ? o.w : o.h) * 100) / 100}; } catch { return st; }
      },
      description: "Size (Chart Design, Format): the selected chart's `width` and `height` in points (36 to 2000).",
      params: s.object({width: s.optional(s.number({min: 36, max: 2000})), height: s.optional(s.number({min: 36, max: 2000}))}),
      run: (ctx, p) => {
        if (p.width === undefined && p.height === undefined) throw bad('`width` or `height` is required');
        const S = T.open(ctx);
        const hit = pickChart(S);
        if (!hit) throw disabled('select a chart first');
        const para = S.d.paraMut(hit.pos.story, hit.pos.path);
        const w = p.width ?? hit.obj.w, h = p.height ?? hit.obj.h;
        P.setObjectAt(para, hit.pos.off, {...hit.obj, w, h});
        return T.finish(S, {width: w, height: h});
      }},
    {id: 'chart.altText', label: 'Alt Text', risk: 'edit',
      state: ctx => {
        const st = chartState(ctx);
        if (!st.enabled) return st;
        try { return {...st, value: pickChart(T.open(ctx)).obj.alt ?? ''}; } catch { return st; }
      },
      description: "Alt Text (Format › Accessibility): the selected chart's alternative `text`.",
      params: s.object({text: s.string({max: 1000})}),
      run: (ctx, p) => {
        const S = T.open(ctx);
        const hit = pickChart(S);
        if (!hit) throw disabled('select a chart first');
        const para = S.d.paraMut(hit.pos.story, hit.pos.path);
        P.setObjectAt(para, hit.pos.off, {...hit.obj, alt: P.capAlt ? P.capAlt(p.text) : p.text});
        return T.finish(S, {alt: p.text});
      }},
    {id: 'chart.type', label: 'Change Chart Type', risk: 'edit', state: chartState, dialog: 'dialog.chartType',
      description: `Change Chart Type (Chart Design › Type): the selected chart becomes another \`type\` (${WORD_TYPES.join('|')}).`,
      params: s.object({type: s.string({max: 32})}),
      run: (ctx, p) => { const type = chartTypeFromId(p.type); if (!type) throw bad(`unknown chart type \`${p.type}\`: ${WORD_TYPES.join('|')}`); return edit(ctx, c => { c.type = type; }); }},
    {id: 'chart.editData', label: 'Edit Data', risk: 'edit', state: chartState, dialog: 'dialog.chartData',
      description: 'Edit Data (Chart Design › Data): the data of the selected chart, as `data` {categories, series: [{name, values}]} or as the embedded sheet\'s `rows` (the first row names the series, the first column the categories).',
      params: s.object({data: s.optional(s.object({categories: s.optional(s.array(s.any())), series: s.optional(s.array(s.any()))})), rows: s.optional(s.array(s.array(s.any()), {max: MAX_POINTS + 1}))}),
      run: (ctx, p) => {
        if (p.rows === undefined && (!p.data || (p.data.categories === undefined && p.data.series === undefined))) throw bad('`data` or `rows` is required');
        return edit(ctx, c => {
          if (p.rows !== undefined) return chartFromTable(c, p.rows);
          if (p.data.categories !== undefined) c.categories = categoriesOf(p.data.categories);
          if (p.data.series !== undefined) c.series = seriesOf(p.data.series);
          return c;
        });
      }},
    {id: 'chart.table', label: 'Chart Data', risk: 'read', state: chartState,
      description: 'The embedded data sheet of the selected chart: {rows} (the first row names the series, the first column the categories).',
      params: s.object({}),
      run: ctx => { const S = T.open(ctx); const hit = pickChart(S); if (!hit) throw disabled('select a chart first'); return {rows: chartTable(hit.obj.graphic.chart), type: hit.obj.graphic.chart.type, label: chartTypeLabel(hit.obj.graphic.chart.type)}; }},
    {id: 'chart.switchRowColumn', label: 'Switch Row/Column', risk: 'edit', state: chartState,
      description: 'Switch Row/Column (Chart Design › Data): the series become the categories and the categories the series.',
      params: s.object({}), run: ctx => edit(ctx, c => switchRowColumn(c))},
    {id: 'chart.title', label: 'Chart Title', risk: 'edit', state: chartState,
      description: 'Chart Title (Chart Design › Chart Layouts): `text` is the title (null for none); with no text, the title is switched on (a placeholder) or off.',
      params: s.object({text: s.optional(s.nullable(s.string({max: 255})))}),
      run: (ctx, p) => edit(ctx, c => { c.title = p.text !== undefined ? p.text : c.title ? null : 'Chart Title'; })},
    {id: 'chart.legend', label: 'Legend', risk: 'edit', state: chartState,
      description: 'Legend (Chart Design › Chart Layouts): `pos` right|left|top|bottom|none; with no pos, the legend is switched on (at the bottom) or off.',
      params: s.object({pos: s.optional(s.string({max: 16})), position: s.optional(s.string({max: 16}))}),
      run: (ctx, p) => edit(ctx, c => {
        const id = p.pos ?? p.position;
        if (id === undefined) { c.legend = c.legend ? null : 'bottom'; return; }
        if (String(id).toLowerCase() === 'none') { c.legend = null; return; }
        c.legend = legendPosFromId(id);
        if (!c.legend) throw bad('`pos`: right|left|top|bottom|none');
      })},
    {id: 'chart.dataLabels', label: 'Data Labels', risk: 'edit', state: chartState,
      description: 'Data Labels (Chart Design › Chart Layouts): `on` shows or hides them; with no value, they switch.',
      params: s.object({on: s.optional(s.boolean()), value: s.optional(s.boolean())}),
      run: (ctx, p) => edit(ctx, c => { c.dataLabels = p.on ?? p.value ?? !c.dataLabels; })},
    {id: 'chart.addElement', label: 'Add Chart Element', risk: 'edit', state: chartState,
      description: `Add Chart Element (Chart Design › Chart Layouts): show or hide a chart element (${ELEMENTS.join(', ')}; \`on\`, default true; the legend takes \`position\`).`,
      params: s.object({element: s.optional(s.enum(ELEMENTS)), on: s.optional(s.boolean()), position: s.optional(s.enum(['top', 'bottom', 'left', 'right']))}),
      run: (ctx, p) => edit(ctx, c => addElement(c, p))},
    {id: 'chart.quickLayout', label: 'Quick Layout', risk: 'edit',
      description: 'Quick Layout (Chart Design › Chart Layouts): one of the six layouts (`layout`): legend, data labels, gridlines and axis titles together.',
      params: s.object({layout: s.integer({min: 1, max: 6})}),
      state: ctx => {
        const st = chartState(ctx);
        if (!st.enabled) return st;
        const theme = themeOf(ctx), type = typeOf(ctx);
        return {...st, value: Object.entries(QUICK_LAYOUTS).map(([n, [legend, labels, grid, axes]]) => ({id: n, label: `Layout ${n}`, value: Number(n), art: chartArt(paletteArt('colorful', theme, 3), {grid, labels, legend, axes, type}), iconOnly: false}))};
      },
      run: (ctx, p) => edit(ctx, c => quickLayout(c, p.layout))},
    {id: 'chart.changeColors', label: 'Change Colors', risk: 'edit',
      description: 'Change Colors (Chart Design › Chart Styles): colour the series from a palette (colorful, monochrome, accent1 to accent6) or a list of hex `colors`.',
      params: s.object({palette: s.optional(s.enum(PALETTES.map(x => x[0]))), colors: s.optional(s.array(s.string({max: 9}), {max: 64}))}),
      state: ctx => {
        const st = chartState(ctx);
        if (!st.enabled) return st;
        const theme = themeOf(ctx);
        return {...st, value: PALETTES.map(([id, label]) => ({id, label, value: id, group: id === 'colorful' ? 'Colorful' : 'Monochromatic', art: {kind: 'colors', colors: paletteArt(id, theme, 8)}}))};
      },
      run: (ctx, p) => { const theme = themeOf(ctx); return edit(ctx, c => changeColors(c, theme, p)); }},
    {id: 'chart.styleGallery', label: 'Chart Styles', risk: 'edit',
      description: 'Chart Styles (Chart Design › Chart Styles): one of the sixteen styles (`style`): a palette with its gridlines and data labels.',
      params: s.object({style: s.integer({min: 1, max: 16})}),
      state: ctx => {
        const st = chartState(ctx);
        if (!st.enabled) return st;
        const theme = themeOf(ctx), type = typeOf(ctx);
        let current = 1;
        try { current = pickChart(T.open(ctx)).obj.graphic.chart.style ?? 1; } catch { /* none */ }
        return {...st, value: STYLES.map(([palette, grid, labels], i) => ({id: String(i + 1), label: `Style ${i + 1}`, value: i + 1, selected: current === i + 1, art: chartArt(paletteArt(palette, theme, 3), {grid, labels, legend: 'none', type}), iconOnly: false}))};
      },
      run: (ctx, p) => edit(ctx, c => applyStyle(c, p.style))},
  ],
});
