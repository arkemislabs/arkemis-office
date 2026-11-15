// Chart Design and Format tabs: Add Chart Element, Quick Layout, Change Colors, Chart Styles, Select Data, Move Chart,
// Format Selection (the Format Chart pane and a series colour), Shape Fill and Shape Outline.
//
// Translated from gridcraft crates/engine/src/cmd/extra/chart.rs (`add_element`, `quick_layout`, `change_colors`,
// `select_data`, `move_chart`, `format_series`) and cmd/extra/objects.rs (`shape_fill`, `shape_outline`) at fb1e59f.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What the chart model carries is what these set: title, legend, data labels, gridlines, axis titles, smooth lines,
// series colours, the source range, the category labels and the series' trendlines (chart-trend.mjs draws them). Axes,
// Data Table, Error Bars, Lines and Up/Down Bars are not in gridcraft's chart model, so those items stay hidden. Chart Styles draw sixteen palettes with their gridlines and labels (gridcraft stores the
// number only); Chart Styles, Quick Layout and Change Colors are drawn galleries.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2, cellParamOn} from '../lib/edit-targets.mjs';
import {bad, baseDoc} from '../lib/data-common.mjs';
import {a1, rangeA1, quoteSheet, colToLetters} from '../lib/addr.mjs';
import {seriesFromRange, scatterXFromFirst, clipToUsed} from '../lib/chart-build.mjs';
import {parseRef} from '../lib/chart-resolve.mjs';
import {findObject, selectedObject, objectSelection} from '../lib/objects.mjs';
import {QUICK_LAYOUTS, PALETTES, paletteColor, STYLES, styleOf} from '../lib/chart-styles.mjs';
import {findChart, guardObjects} from './insert/charts.mjs';
import {seriesPlotKind} from '../lib/chart-resolve.mjs';
import {supportsTrendline, clampForecast} from '../lib/chart-trend.mjs';
import {ERROR_TYPES, LINE_TYPES, takes} from '../lib/chart-elements.mjs';
import {elementOf} from './objfmt/shape.mjs';
import {DEFAULT_THEME, hex, resolveColor} from '../model/style.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/extra/chart.rs', 'crates/engine/src/cmd/extra/objects.rs', 'crates/engine/src/cmd/extra.rs', 'crates/ui-egui/src/ribbon/contextual.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const CHART = s.optional(s.integer({min: 0}));
const HEX = /^#?[0-9a-fA-F]{6}$/;

const hasChart = ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const picked = selectedObject(ctx.doc, ctx.selection);
  const sheet = ctx.doc.sheets[picked?.kind === 'chart' ? picked.si : gridSel(ctx).sheet];
  return (sheet.charts ?? []).length ? {enabled: true} : {enabled: false, reason: 'no chart on this sheet'};
};
const themeOf = ctx => ctx.doc?.theme ?? DEFAULT_THEME;

/** Rewrites the chart `p` names through `f(chart)` (returns the new chart). */
function withChart(ctx, p, f) {
  const hit = findChart(ctx, p);
  requireSchema2(ctx, hit.si);
  guardObjects(hit.sheet);
  const next = f({...hit.object, anchor: {...hit.object.anchor}}, hit);
  ctx.change.set(['sheets', hit.si, 'charts', hit.index], next);
  return {chart: hit.object.id};
}

// ---------------------------------------------------------------- Add Chart Element

const ELEMENTS = ['title', 'legend', 'dataLabels', 'gridlines', 'axisTitles', 'smooth', 'trendline', 'axes', 'dataTable', 'errorBars', 'lines', 'upDownBars'];
const TRENDLINES = ['linear', 'linearForecast', 'exponential', 'logarithmic', 'power', 'polynomial', 'movingAverage'];

/** The trendline Add Chart Element > Trendline describes (gridcraft trendline_param): Linear Forecast is a linear fit projected two periods ahead. */
function trendlineParam(p) {
  const type = p.type ?? 'linear';
  if (!TRENDLINES.includes(type)) throw bad('chart.addElement', 'unknown trendline type ' + type);
  const t = {type: type === 'linearForecast' ? 'linear' : type, forward: clampForecast(p.forward ?? 0), backward: clampForecast(p.backward ?? 0), displayEquation: p.displayEquation === true, displayRSquared: p.displayRSquared === true};
  if (type === 'linearForecast' && t.forward === 0) t.forward = 2;
  if (type === 'polynomial') t.order = Math.min(6, Math.max(2, Math.trunc(p.order ?? 2)));
  if (type === 'movingAverage') t.period = Math.min(255, Math.max(2, Math.trunc(p.period ?? 2)));
  return t;
}

function trendline(c, p, on) {
  const only = Number.isInteger(p.series) ? p.series : null;
  if (only !== null && only >= (c.series ?? []).length) throw bad('chart.addElement', 'no such series');
  const targets = (c.series ?? []).map((_, i) => i).filter(i => only === null || only === i);
  if (!on) { c.series = c.series.map((x, i) => (targets.includes(i) && x.trendlines ? (({trendlines, ...rest}) => rest)(x) : x)); return; }
  const t = trendlineParam(p);
  const eligible = targets.filter(i => supportsTrendline(seriesPlotKind(c, i)));
  if (!eligible.length) throw bad('chart.addElement', 'trendlines need a 2-D column, bar, line, area, scatter or bubble series');
  c.series = c.series.map((x, i) => (eligible.includes(i) ? {...x, trendlines: [...(x.trendlines ?? []), t]} : x));
}

function addElement(ctx, p) {
  const on = p.on !== false;
  return withChart(ctx, p, c => {
    switch (p.element ?? 'title') {
      case 'title': if (on) { const t = typeof c.title === 'string' && c.title ? c.title : 'Chart Title'; c.title = t; } else c.title = ''; break;
      case 'legend': c.legend = !on ? 'none' : ['top', 'left', 'right'].includes(p.position) ? p.position : 'bottom'; break;
      case 'dataLabels': c.dataLabels = on; break;
      case 'gridlines': c.gridlines = on; break;
      case 'axisTitles':
        if (on) { c.xTitle = c.xTitle || 'Axis Title'; c.yTitle = c.yTitle || 'Axis Title'; } else { delete c.xTitle; delete c.yTitle; }
        break;
      case 'smooth': c.series = (c.series ?? []).map(x => ({...x, smooth: on})); break;
      case 'trendline': trendline(c, p, on); break;
      // Axes: `axis` horizontal or vertical (for a bar chart the horizontal axis is the value axis); both when left out.
      case 'axes': {
        const horizontalBars = String(c.kind).startsWith('bar');
        const key = p.axis === undefined ? null : (p.axis === 'horizontal') === horizontalBars ? 'value' : 'category';
        const axes = {...(c.axes ?? {})};
        // A menu item without `on` toggles the axis.
        const show = typeof p.on === 'boolean' ? p.on : key ? axes[key] === false : true;
        for (const k of key ? [key] : ['category', 'value']) { if (show) delete axes[k]; else axes[k] = false; }
        if (Object.keys(axes).length) c.axes = axes; else delete c.axes;
        break;
      }
      case 'dataTable':
        if (on && !takes.dataTable(c.kind)) throw bad('chart.addElement', 'a data table needs a column, line or area chart');
        if (on) c.dataTable = {keys: p.keys !== false}; else delete c.dataTable;
        break;
      case 'errorBars':
        if (!on) { delete c.errorBars; break; }
        if (!takes.errorBars(c.kind)) throw bad('chart.addElement', 'error bars need a column, bar, line, area, scatter or bubble chart');
        {
          const type = ERROR_TYPES.includes(p.type) ? p.type : 'standardError';
          c.errorBars = {type, direction: ['both', 'plus', 'minus'].includes(p.direction) ? p.direction : 'both', cap: p.cap !== false};
          if (Number.isFinite(p.value)) c.errorBars.value = p.value; else if (type === 'percentage') c.errorBars.value = 5; else if (type === 'fixed') c.errorBars.value = 1; else if (type === 'standardDeviation') c.errorBars.value = 1;
        }
        break;
      case 'lines':
        if (!on) { delete c.lines; break; }
        if (!LINE_TYPES.includes(p.type) || !takes.lines(c.kind, p.type)) throw bad('chart.addElement', 'drop lines need a line or area chart, high-low lines a line chart, series lines a stacked column or bar chart');
        c.lines = p.type;
        break;
      case 'upDownBars':
        if (on && !takes.upDownBars(c.kind)) throw bad('chart.addElement', 'up/down bars need a line chart');
        if (on) c.upDownBars = true; else delete c.upDownBars;
        break;
      default: throw bad('chart.addElement', `unknown element \`${p.element}\``);
    }
    return c;
  });
}

// ---------------------------------------------------------------- Quick Layout, Change Colors, Chart Styles

function quickLayout(ctx, p) {
  const n = QUICK_LAYOUTS[p.layout] ? p.layout : 1;
  const [legend, labels, grid, axes] = QUICK_LAYOUTS[n];
  return withChart(ctx, p, c => {
    c.legend = legend; c.dataLabels = labels; c.gridlines = grid;
    if (axes) { c.xTitle = c.xTitle || 'Axis Title'; c.yTitle = c.yTitle || 'Axis Title'; } else { delete c.xTitle; delete c.yTitle; }
    return c;
  });
}

function changeColors(ctx, p) {
  const explicit = Array.isArray(p.colors) ? p.colors.filter(x => HEX.test(String(x))).map(x => `#${String(x).replace('#', '').toUpperCase()}`) : null;
  return withChart(ctx, p, c => {
    c.series = (c.series ?? []).map((x, i) => {
      const color = explicit?.length ? explicit[i % explicit.length] : paletteColor(p.palette ?? 'colorful', i);
      const {color: _old, ...rest} = x;
      return color ? {...rest, color} : rest;
    });
    // The palette also sets the style's look so the series without a colour of their own follow it.
    return c;
  });
}

const paletteArt = (name, theme, n = 6) => {
  const rgb = i => {
    const c = paletteColor(name, i);
    const v = c ? resolveColor(c, theme) : resolveColor({theme: 4 + (i % 6), tint: 0}, theme);
    return hex(v) ?? '#888888';
  };
  return Array.from({length: n}, (_, i) => rgb(i));
};

/** A drawn tile of a chart look: bars in the palette, with or without gridlines, data labels, a legend and axis titles. */
const chartArt = (colors, {grid = true, labels = false, legend = 'bottom', axes = false} = {}) => ({kind: 'chart', colors, grid, labels, legend, axes});

// ---------------------------------------------------------------- Select Data, Move Chart

const textRef = (content, si, text, cmd) => {
  const ref = parseRef(content, si, String(text).trim().replace(/^=/, ''));
  if (!ref) throw bad(cmd, `not a range: \`${text}\``);
  return ref;
};

/** Select Data: a new data range rebuilds the series, a labels range sets every series' category labels, `removeSeries` drops series (the last one stays). */
function selectData(ctx, p) {
  const content = baseDoc(ctx);
  const hit = findChart(ctx, p);
  const si = hit.si;
  if (typeof p.range !== 'string' && typeof p.categories !== 'string' && !(Array.isArray(p.removeSeries) && p.removeSeries.length)) throw bad('chart.selectData', 'missing `range`, `categories` or `removeSeries`');
  let rebuilt = null;
  if (typeof p.range === 'string' && p.range.trim()) {
    const ref = textRef(content, si, p.range, 'chart.selectData');
    const r = clipToUsed(content, ref.sheet, ref.range);
    if ((r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1) > 1_000_000) throw bad('chart.selectData', 'range too large for a chart');
    const byRows = typeof p.byRows === 'boolean' ? p.byRows : (r.end.col - r.start.col + 1) > (r.end.row - r.start.row + 1) + 1;
    rebuilt = {series: seriesFromRange(content, ref.sheet, r, byRows), source: `${quoteSheet(content.sheets[ref.sheet].name)}!${rangeA1(r)}`, byRows};
  }
  let categories;
  if (typeof p.categories === 'string') {
    const t = p.categories.trim().replace(/^=/, '');
    if (!t) categories = null;
    else {
      const ref = textRef(content, si, t, 'chart.selectData');
      const abs = c => `$${colToLetters(c.col)}$${c.row + 1}`;
      categories = `${quoteSheet(content.sheets[ref.sheet].name)}!${abs(ref.range.start)}:${abs(ref.range.end)}`;
    }
  }
  const remove = [...new Set((p.removeSeries ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
  return withChart(ctx, p, c => {
    if (rebuilt) {
      c.series = rebuilt.series; scatterXFromFirst(c.kind, c.series); c.source = rebuilt.source; c.byRows = rebuilt.byRows;
    }
    for (const i of [...remove].reverse()) if (i < c.series.length && c.series.length > 1) c.series = c.series.filter((_, j) => j !== i);
    if (categories !== undefined) c.series = c.series.map(x => { const {categories: _c, ...rest} = x; return categories === null ? rest : {...rest, categories}; });
    return c;
  });
}

/** Move Chart: to another sheet and/or a top-left cell (`chart.move`). */
function moveChart(ctx, p) {
  const content = baseDoc(ctx);
  const hit = findChart(ctx, p);
  const toName = typeof p.toSheet === 'string' && p.toSheet ? p.toSheet : null;
  const dest = toName ? content.sheets.findIndex(x => x.name.toLowerCase() === toName.toLowerCase()) : hit.si;
  if (dest < 0) throw bad('chart.move', 'no such sheet');
  requireSchema2(ctx, hit.si); requireSchema2(ctx, dest);
  const at = cellParamOn(ctx, {...p, sheet: dest}, 'at', dest);
  guardObjects(hit.sheet);
  const chart = {...hit.object, anchor: {...hit.object.anchor}};
  if (at) { chart.anchor.cell = a1(at.row, at.col); chart.anchor.dx = 0; chart.anchor.dy = 0; }
  const from = (content.sheets[hit.si].charts ?? []).filter((_, i) => i !== hit.index);
  if (dest === hit.si) {
    ctx.change.set(['sheets', hit.si, 'charts'], [...from, chart]);
  } else {
    ctx.change.set(['sheets', hit.si, 'charts'], from);
    ctx.change.set(['sheets', dest, 'charts'], [...(content.sheets[dest].charts ?? []), chart]);
    // The chart stays selected, on its new sheet.
    ctx.setSelection(objectSelection(content.sheets[dest], 'chart', chart.id));
  }
  return {chart: chart.id, sheet: content.sheets[dest].name};
}

// ---------------------------------------------------------------- Format Selection, Shape Fill, Shape Outline

/** Format Selection: with a series and a colour, fills that series (`format_series`); else shows or hides the Format Chart pane. */
function formatSelection(ctx, p) {
  if (p.series === undefined && p.color === undefined) {
    const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.formatChartPane;
    ctx.setView({formatChartPane: on});
    return {on};
  }
  const idx = Number.isInteger(p.series) ? p.series : 0;
  const color = typeof p.color === 'string' && HEX.test(p.color.trim()) ? `#${p.color.trim().replace('#', '').toUpperCase()}` : null;
  return withChart(ctx, p, c => {
    c.series = (c.series ?? []).map((x, i) => {
      if (i !== idx) return x;
      const {color: _old, ...rest} = x;
      return color ? {...rest, color} : rest;
    });
    return c;
  });
}

const selectedShape = (ctx, p) => {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  const picked = selectedObject(content, ctx.selection);
  const id = Number.isInteger(p.id) ? p.id : picked?.kind === 'shape' && picked.si === si ? picked.id : (content.sheets[si].shapes ?? []).slice(-1)[0]?.id;
  const hit = findObject(content.sheets[si], 'shape', id);
  if (!hit) throw bad('shape', 'no such shape');
  return {si, ...hit};
};
const colorOf = c => (typeof c === 'string' && HEX.test(c.trim()) ? `#${c.trim().replace('#', '').toUpperCase()}` : null);

/** Shape Fill: a shape's fill (`color`; none clears to automatic), else a chart series' colour, as gridcraft's `shape_fill` does. */
function shapeFill(ctx, p) {
  if (p.kind !== 'chart' && !(p.kind === undefined && selectedObject(baseDoc(ctx), ctx.selection)?.kind === 'chart')) {
    const {si, index} = selectedShape(ctx, p);
    requireSchema2(ctx, si);
    const color = colorOf(p.color);
    const shape = ctx.doc.sheets[si].shapes[index];
    ctx.change.set(['sheets', si, 'shapes', index], {...shape, fill: color ?? 'auto'});
    return {fill: color ?? 'auto'};
  }
  // Format > Shape Fill on a chart colours the part Chart Elements picked: the chart area, the plot area or a series.
  const chosen = p.series !== undefined ? `series${p.series}` : null;
  return withChart(ctx, {chart: p.chart}, c => {
    const el = chosen ?? elementOf(ctx, c);
    const none = p.color === null || p.color === 'none';
    const color = typeof p.color === 'string' && HEX.test(p.color.trim()) ? `#${p.color.trim().replace('#', '').toUpperCase()}` : null;
    if (el.startsWith('series')) {
      const idx = Number(el.slice(6));
      c.series = (c.series ?? []).map((x, i) => { if (i !== idx) return x; const {color: _old, ...rest} = x; return color ? {...rest, color} : rest; });
      return c;
    }
    const key = el === 'plotArea' ? 'plot' : 'area';
    const next = {...(c[key] ?? {})};
    if (none) next.fill = 'none'; else if (color) next.fill = color; else delete next.fill;
    if (Object.keys(next).length) c[key] = next; else delete c[key];
    if (key === 'area') delete c.areaStyle;
    return c;
  });
}

/** Shape Outline: a shape's line colour (`color`; none clears to automatic). */
function shapeOutline(ctx, p) {
  // On a chart: the line round the chart area or the plot area (a weight alone keeps the colour).
  if (p.kind === 'chart' || (p.kind === undefined && selectedObject(baseDoc(ctx), ctx.selection)?.kind === 'chart')) {
    return withChart(ctx, {chart: p.chart}, c => {
      const el = elementOf(ctx, c);
      if (el.startsWith('series')) throw bad('chart.shapeOutline', 'the outline of a series is not drawn; pick the chart area or the plot area in Chart Elements');
      const key = el === 'plotArea' ? 'plot' : 'area';
      const next = {...(c[key] ?? {})};
      const color = typeof p.color === 'string' && HEX.test(p.color.trim()) ? `#${p.color.trim().replace('#', '').toUpperCase()}` : null;
      if (p.color === null || p.color === 'none') next.line = 'none'; else if (color) next.line = color; else if (p.color === 'auto') delete next.line;
      if (Number.isFinite(p.width)) next.lineWidth = p.width;
      if (Object.keys(next).length) c[key] = next; else delete c[key];
      if (key === 'area') delete c.areaStyle;
      return c;
    });
  }
  const {si, index} = selectedShape(ctx, p);
  requireSchema2(ctx, si);
  const color = colorOf(p.color);
  const shape = ctx.doc.sheets[si].shapes[index];
  ctx.change.set(['sheets', si, 'shapes', index], {...shape, line: color ?? 'auto'});
  return {line: color ?? 'auto'};
}

export default defineCommands({
  family: 'chartdesign',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'chart.addElement', label: 'Add Chart Element', risk: 'edit',
      description: `Show or hide a chart element: ${ELEMENTS.join(', ')} (\`on\`, default true; legend takes \`position\` top, bottom, left or right; trendline takes \`series\`, \`type\` (${TRENDLINES.join(', ')}), order, period, forward, backward, displayEquation, displayRSquared).`,
      params: s.object({chart: CHART, sheet: SHEET, element: s.optional(s.enum(ELEMENTS)), on: s.optional(s.boolean()), position: s.optional(s.enum(['top', 'bottom', 'left', 'right'])),
        series: s.optional(s.integer({min: 0})), type: s.optional(s.enum([...TRENDLINES, ...ERROR_TYPES, ...LINE_TYPES])),
        axis: s.optional(s.enum(['horizontal', 'vertical'])), keys: s.optional(s.boolean()), direction: s.optional(s.enum(['both', 'plus', 'minus'])), cap: s.optional(s.boolean()), value: s.optional(s.number()), order: s.optional(s.integer({min: 1, max: 255})), period: s.optional(s.integer({min: 2, max: 255})),
        forward: s.optional(s.number({min: 0})), backward: s.optional(s.number({min: 0})), displayEquation: s.optional(s.boolean()), displayRSquared: s.optional(s.boolean())}),
      state: (ctx, p) => {
        const st = hasChart(ctx);
        if (!st.enabled || !p?.element) return st;
        const picked = selectedObject(ctx.doc, ctx.selection);
        const sheet = ctx.doc.sheets[picked?.kind === 'chart' ? picked.si : gridSel(ctx).sheet];
        const c = picked?.kind === 'chart' ? (sheet.charts ?? []).find(x => x.id === picked.id) : (sheet.charts ?? []).slice(-1)[0];
        if (!c) return st;
        const horizontalBars = String(c.kind).startsWith('bar');
        const gate = (ok, reason) => (p.on === false || ok ? {} : {enabled: false, reason});
        switch (p.element) {
          case 'axes': { const key = p.axis === undefined ? null : (p.axis === 'horizontal') === horizontalBars ? 'value' : 'category'; return {...st, checked: key ? c.axes?.[key] !== false : true}; }
          case 'dataTable': return {...st, checked: p.on === false ? !c.dataTable : !!c.dataTable && (c.dataTable.keys !== false) === (p.keys !== false), ...gate(takes.dataTable(c.kind), 'a data table needs a column, line or area chart')};
          case 'errorBars': return {...st, checked: p.on === false ? !c.errorBars : c.errorBars?.type === p.type, ...gate(takes.errorBars(c.kind), 'error bars need a column, bar, line, area, scatter or bubble chart')};
          case 'lines': return {...st, checked: p.on === false ? !c.lines : c.lines === p.type, ...gate(takes.lines(c.kind, p.type), 'not for this kind of chart')};
          case 'upDownBars': return {...st, checked: p.on === false ? !c.upDownBars : !!c.upDownBars, ...gate(takes.upDownBars(c.kind), 'up/down bars need a line chart')};
          default: return st;
        }
      }, run: addElement},
    {id: 'chart.quickLayout', label: 'Quick Layout', risk: 'edit',
      description: 'Apply one of the six quick layouts: legend, data labels, gridlines and axis titles together.',
      params: s.object({chart: CHART, sheet: SHEET, layout: s.integer({min: 1, max: 6})}),
      state: (ctx, p) => {
        const st = hasChart(ctx);
        if (!st.enabled) return st;
        return {...st, value: Object.entries(QUICK_LAYOUTS).map(([n, [legend, labels, grid, axes]]) => ({id: n, label: `Layout ${n}`, value: Number(n), art: chartArt(paletteArt('colorful', themeOf(ctx), 3), {grid, labels, legend, axes}), iconOnly: false}))};
      }, run: quickLayout},
    {id: 'chart.changeColors', label: 'Change Colors', risk: 'edit',
      description: 'Colour the series from a palette: colorful, monochrome or accent1 to accent6 (`palette`), or with your own list of hex `colors`.',
      params: s.object({chart: CHART, sheet: SHEET, palette: s.optional(s.enum(PALETTES.map(x => x[0]))), colors: s.optional(s.array(s.string({max: 9}), {max: 64}))}),
      state: ctx => {
        const st = hasChart(ctx);
        if (!st.enabled) return st;
        return {...st, value: PALETTES.map(([id, label]) => ({id, label, value: id, art: {kind: 'colors', colors: paletteArt(id, themeOf(ctx), 8)}}))};
      }, run: changeColors},
    {id: 'chart.styleGallery', label: 'Chart Styles', risk: 'edit',
      description: 'Apply one of the sixteen chart styles: a palette with its gridlines and data labels.',
      params: s.object({chart: CHART, sheet: SHEET, style: s.integer({min: 1, max: 16})}),
      state: ctx => {
        const st = hasChart(ctx);
        if (!st.enabled) return st;
        let current = 1;
        try { current = findChart(ctx, {}).object.style ?? 1; } catch { /* none */ }
        return {...st, value: STYLES.map(([palette, grid, labels], i) => ({id: String(i + 1), label: `Style ${i + 1}`, value: i + 1, selected: current === i + 1, art: chartArt(paletteArt(palette, themeOf(ctx), 3), {grid, labels, legend: 'none'}), iconOnly: false}))};
      }, run: (ctx, p) => ctx.run('chart.set', {chart: p.chart, sheet: p.sheet, style: p.style})},
    {id: 'chart.selectData', label: 'Select Data', risk: 'edit', dialog: 'dialog.selectData',
      description: 'The data of a chart: `range` rebuilds the series (`byRows` plots the rows as series), `categories` is the labels range for every series (empty clears it), `removeSeries` lists series numbers to drop (the last one stays).',
      params: s.object({chart: CHART, sheet: SHEET, range: s.optional(s.string({max: 4096})), byRows: s.optional(s.boolean()), categories: s.optional(s.string({max: 4096})), removeSeries: s.optional(s.array(s.integer({min: 0}), {max: 255}))}),
      state: hasChart, run: selectData},
    {id: 'chart.changeType', label: 'Change Chart Type', risk: 'edit',
      description: 'Change the chart type: type column|bar|line|pie|doughnut|area|scatter|radar|waterfall|funnel|treemap and subtype (as chart.set).',
      params: s.object({chart: CHART, sheet: SHEET, type: s.string({min: 1, max: 20}), subtype: s.optional(s.string({max: 20}))}),
      state: hasChart, run: (ctx, p) => ctx.run('chart.set', p)},
    {id: 'chart.move', label: 'Move Chart', risk: 'edit', dialog: 'dialog.moveChart',
      description: 'Move a chart to another sheet (`toSheet`) and/or to a top-left cell (`at`).',
      params: s.object({chart: CHART, sheet: SHEET, toSheet: s.optional(s.string({max: 300})), at: s.optional(s.string({max: 100}))}),
      state: hasChart, run: moveChart},
    {id: 'chart.formatSelection', label: 'Format Selection', risk: 'edit',
      description: 'Show or hide the Format Chart pane (`on`); with `series` and `color` fill that series (a hex colour; none clears it).',
      params: s.object({chart: CHART, sheet: SHEET, on: s.optional(s.boolean()), series: s.optional(s.integer({min: 0})), color: s.optional(s.nullable(s.string({max: 20})))}),
      state: ctx => { const st = hasChart(ctx); return st.enabled ? {...st, checked: !!ctx.view?.formatChartPane} : st; }, run: formatSelection},
    {id: 'chart.shapeFill', label: 'Shape Fill', risk: 'edit',
      description: 'Fill the selected shape with `color` (a hex colour; none clears it); on a chart, fill `series` (default the first).',
      params: s.object({kind: s.optional(s.enum(['shape', 'chart'])), id: s.optional(s.integer({min: 0})), chart: CHART, series: s.optional(s.integer({min: 0})), color: s.optional(s.nullable(s.string({max: 20})))}),
      state: hasDoc, run: shapeFill},
    {id: 'chart.shapeOutline', label: 'Shape Outline', risk: 'edit',
      description: 'Colour the outline of the selected shape with `color` (a hex colour; none clears it).',
      params: s.object({kind: s.optional(s.enum(['shape', 'chart'])), id: s.optional(s.integer({min: 0})), chart: CHART, width: s.optional(s.number({min: 0, max: 20})), color: s.optional(s.nullable(s.string({max: 20})))}),
      state: hasDoc, run: shapeOutline},
  ],
});

