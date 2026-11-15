// Chart layout: title, legend, axes and the column, bar, line, area, scatter and bubble kinds, drawn
// into drawing primitives (`Prim` objects) that the surface paints on a canvas and the tests read.
// Translated from gridcraft crates/chart/src/render.rs (`render`, `finalize`, `Ctx`), render/frame.rs
// (`frame`, `axis_titles`, `chart_title`), render/legend.rs, render/lines.rs and render/cartesian.rs
// (`cartesian`, `scatter`, `series_spans`, `axis_scales`, `column_slots`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Trendlines (render/trend.rs) are in chart-trend.mjs. No DOM, no Node built-ins.
//
// Prim: {t:'rect', x, y, w, h, fill, stroke:[rgba, width]|null, radius} | {t:'line', pts, color, width, dash} |
//   {t:'poly', pts, fill, stroke} | {t:'wedge', cx, cy, ro, ri, a0, a1, fill, stroke} |
//   {t:'circle', cx, cy, r, fill, stroke} | {t:'text', x, y, text, size, color, bold, align, valign, rotation}
// Colours are [r, g, b, a] (0-255). ChartData: {categories, categoryLevels, series, palette};
// series {name, values: (number|null)[], x, sizes, color, kind, secondary, smooth, trendlines, numberFormat}.

import {Fmt, Scale, clean, fixedScale, niceScale} from './chart-axis.mjs';
import {histogram, waterfall, funnel, pie, treemap, radar, boxWhisker, stock} from './chart-render-kinds.mjs';
import {pie3d, ofPie, pareto, sphereShade} from './chart-render-extra.mjs';
import {drawErrorBars, drawDataTable, drawLines, tableSize, takes} from './chart-elements.mjs';
import {supportsTrendline, autoName, maxForward, maxBackward, maxForwardSlots, drawTrendlines, drawTrendLabels, MAX_TRENDLINES} from './chart-trend.mjs';

export const TEXT = [0x59, 0x59, 0x59, 0xFF];
export const DARK_TEXT = [0x26, 0x26, 0x26, 0xFF];
export const GRID = [0xD9, 0xD9, 0xD9, 0xFF];
export const AXIS = [0xBF, 0xBF, 0xBF, 0xFF];
export const WHITE = [0xFF, 0xFF, 0xFF, 0xFF];
export const STOCK = [0x40, 0x40, 0x40, 0xFF];
export const UP = [0x3E, 0x9B, 0x5F, 0xFF];
export const DOWN = [0xD6, 0x4F, 0x45, 0xFF];

export const TITLE_SIZE = 14;
export const LABEL_SIZE = 9;
export const AXIS_TITLE_SIZE = 10;
export const MAX_CATS = 20_000;
export const MAX_LINE_PTS = 2000;
export const MAX_MARKERS = 5000;
export const MAX_LABELS = 200;
export const MAX_POINTS = 100_000;
export const MAX_SERIES = 255;
export const TAU = Math.PI * 2;

/** The kinds of a chart, as stored in `chart.kind`. */
export const CHART_KINDS = Object.freeze(['columnClustered', 'columnStacked', 'columnStacked100', 'barClustered', 'barStacked', 'barStacked100', 'line', 'lineMarkers', 'lineStacked',
  'pie', 'doughnut', 'area', 'areaStacked', 'areaStacked100', 'scatter', 'scatterLines', 'bubble', 'radar', 'histogram', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'stock', 'combo', 'pie3d', 'pieOfPie', 'barOfPie', 'pareto', 'bubble3d']);

/** Fixed-width approximation: 0.55 x size per character (bold 10% wider). */
export const approxMeasure = {textWidth: (text, size, bold) => [...String(text)].length * 0.55 * size * (bold ? 1.1 : 1)};

const fin = Number.isFinite;

export class Bx {
  constructor(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; }
  get right() { return this.x + this.w; }
  get bottom() { return this.y + this.h; }
  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  ok() { return fin(this.w) && fin(this.h) && this.w > 4 && this.h > 4; }
  with(patch) { return new Bx(patch.x ?? this.x, patch.y ?? this.y, patch.w ?? this.w, patch.h ?? this.h); }
}

export class Ctx {
  constructor(measure) { this.out = []; this.m = measure; }
  tw(s, size) { const w = this.m.textWidth(s, size, false); return fin(w) ? Math.max(0, w) : 0; }
  fit(s, size, maxw) {
    if (this.tw(s, size) <= maxw) return s;
    const chars = [...s];
    let n = Math.min(chars.length, 400);
    while (n > 0) {
      n -= 1;
      const t = chars.slice(0, n).join('') + '…';
      if (this.tw(t, size) <= maxw) return n === 0 ? '' : t;
    }
    return '';
  }
  text(x, y, s, size, color, [align, valign]) {
    if (!s) return;
    this.out.push({t: 'text', x, y, text: s, size, color, bold: false, align, valign, rotation: 0});
  }
  rect(x, y, w, h, fill, stroke = null) { this.out.push({t: 'rect', x, y, w, h, fill, stroke, radius: 0}); }
  line(pts, color, width) { if (pts.length >= 2) this.out.push({t: 'line', pts, color, width, dash: false}); }
  hline(x0, x1, y, color, width) { this.line([[x0, y], [x1, y]], color, width); }
  vline(x, y0, y1, color, width) { this.line([[x, y0], [x, y1]], color, width); }
}

const sanitizeVals = v => v.slice(0, MAX_POINTS).map(x => (x !== null && x !== undefined && fin(x) ? clean(x) : null));
function sanitize(d) {
  return {
    palette: d.palette.slice(0, MAX_POINTS),
    categories: d.categories.slice(0, MAX_POINTS),
    categoryLevels: (d.categoryLevels ?? []).slice(0, 3).map(l => l.slice(0, MAX_POINTS)),
    series: d.series.slice(0, MAX_SERIES).map(s => ({...s, values: sanitizeVals(s.values), x: s.x ? sanitizeVals(s.x) : null, sizes: s.sizes ? sanitizeVals(s.sizes) : null})),
  };
}

/** Lays out and draws a chart into a `w` x `h` box at the origin. Empty for a degenerate box. */
export function render(chart, data0, w, h, measure = approxMeasure) {
  if (!(fin(w) && fin(h)) || w < 1 || h < 1 || w > 1e7 || h > 1e7) return [];
  const data = sanitize(data0);
  const ctx = new Ctx(measure);
  // Format > chart area: its fill and line (Shape Styles, Shape Fill, Shape Outline on the Chart Area).
  const areaFill = hexRgba(chart.area?.fill, WHITE), areaLine = chart.area?.line === 'none' ? null : [hexRgba(chart.area?.line, GRID), Math.max(0.25, chart.area?.lineWidth ?? 1)];
  ctx.out.push({t: 'rect', x: 0, y: 0, w, h, fill: areaFill, stroke: areaLine, radius: 0});
  const pad = Math.min(10, Math.max(2, Math.min(w, h) * 0.04));
  let area = new Bx(pad, pad, w - 2 * pad, h - 2 * pad);
  const title = chartTitle(chart, data);
  if (title) {
    const size = Math.max(4, Math.min(TITLE_SIZE, h * 0.12));
    ctx.text(w / 2, area.y, ctx.fit(title, size, area.w), size, TEXT, ['center', 'top']);
    const used = size * 1.3 + 4;
    area = area.with({y: area.y + used, h: area.h - used});
  }
  const entries = legendEntries(chart, data);
  if (entries.length && area.ok()) area = drawLegend(ctx, entries, chart.legend ?? 'bottom', area);
  if (area.ok() && data.series.length) drawKind(ctx, chart, data, area);
  return textEffects(contrastText(finalize(ctx.out, w, h), areaFill), chart.textFx);
}

/** Text drawn in the default dark grey turns light on a dark chart area, as Excel keeps its text readable. */
function contrastText(prims, fill) {
  if (!fill || on(fill) !== WHITE) return prims;
  const light = [0xF2, 0xF2, 0xF2, 0xFF];
  return prims.map(p => (p.t === 'text' && (p.color.join() === TEXT.join() || p.color.join() === DARK_TEXT.join()) ? {...p, color: light} : p));
}

/** A chart colour "#RRGGBB" as [r, g, b, 255]; `none` is null (no fill), anything else `dflt`. */
function hexRgba(v, dflt) {
  if (v === 'none') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? ''));
  return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(255) : dflt;
}

/** WordArt on a chart's text (Chart Format > Text Fill, Text Outline, Text Effects): the fill colour, an outline, a shadow or glow on each text. */
function textEffects(prims, fx) {
  if (!fx) return prims;
  const fillOf = f => (f?.type === 'solid' ? [...f.color, 255] : f?.type === 'gradient' && f.stops?.length ? [...f.stops[Math.floor(f.stops.length / 2)].color, 255] : null);
  const fill = fx.fill?.type === 'none' ? null : fillOf(fx.fill);
  return prims.map(p => {
    if (p.t !== 'text') return p;
    const q = {...p};
    if (fx.fill?.type === 'none') q.hollow = true; else if (fill) q.color = fill;
    if (fx.outline?.color) q.outline = {color: [...fx.outline.color, 255], width: fx.outline.width ?? 0.75};
    if (fx.shadow) q.shadow = {color: [...(fx.shadow.color ?? [0, 0, 0]), Math.round(255 * (1 - (fx.shadow.transparency ?? 60) / 100))], blur: fx.shadow.blur ?? 3, dx: (fx.shadow.distance ?? 3) * Math.cos((fx.shadow.angle ?? 45) * Math.PI / 180), dy: (fx.shadow.distance ?? 3) * Math.sin((fx.shadow.angle ?? 45) * Math.PI / 180)};
    else if (fx.glow) q.shadow = {color: [...(fx.glow.color ?? [0x15, 0x60, 0x82]), Math.round(255 * (1 - (fx.glow.transparency ?? 60) / 100))], blur: fx.glow.size ?? 5, dx: 0, dy: 0};
    return q;
  });
}

function drawKind(ctx, chart, data, area) {
  switch (chart.kind) {
    case 'pie': return pie(ctx, chart, data, area, 0, false);
    case 'doughnut': return pie(ctx, chart, data, area, 0.5, false);
    case 'sunburst': return pie(ctx, chart, data, area, 0.2, true);
    case 'treemap': return treemap(ctx, chart, data, area);
    case 'funnel': return funnel(ctx, chart, data, area);
    case 'radar': return radar(ctx, chart, data, area);
    case 'pie3d': return pie3d(ctx, chart, data, area);
    case 'pieOfPie': return ofPie(ctx, chart, data, area, false);
    case 'barOfPie': return ofPie(ctx, chart, data, area, true);
    default: {
      const a = axisTitles(ctx, chart, area);
      if (!a.ok()) return undefined;
      switch (chart.kind) {
        case 'barClustered': case 'barStacked': case 'barStacked100': return cartesian(ctx, chart, data, a, true);
        case 'scatter': case 'scatterLines': case 'bubble': return scatter(ctx, chart, data, a);
        case 'bubble3d': { const from = ctx.out.length; scatter(ctx, {...chart, kind: 'bubble'}, data, a); return sphereShade(ctx, from); }
        case 'pareto': return pareto(ctx, chart, data, a);
        case 'histogram': return histogram(ctx, chart, data, a);
        case 'waterfall': return waterfall(ctx, chart, data, a);
        case 'boxWhisker': return boxWhisker(ctx, chart, data, a);
        case 'stock': return stock(ctx, chart, data, a);
        default: return cartesian(ctx, chart, data, a, false);
      }
    }
  }
}

const clampStroke = s => (s && fin(s[1]) && s[1] > 0 ? [s[0], Math.min(50, s[1])] : null);

/** Drops non-finite primitives and clamps every coordinate into the `w` x `h` box. */
export function finalize(prims, w, h) {
  const cx = v => Math.min(w, Math.max(0, v));
  const cy = v => Math.min(h, Math.max(0, v));
  const ptsOk = pts => pts.every(p => fin(p[0]) && fin(p[1]));
  const out = [];
  for (const p of prims) {
    switch (p.t) {
      case 'rect': {
        if (!(fin(p.x) && fin(p.y) && fin(p.w) && fin(p.h))) break;
        const x0 = cx(Math.min(p.x, p.x + p.w)), x1 = cx(Math.max(p.x, p.x + p.w));
        const y0 = cy(Math.min(p.y, p.y + p.h)), y1 = cy(Math.max(p.y, p.y + p.h));
        if (x1 - x0 <= 0 || y1 - y0 <= 0) break;
        const radius = fin(p.radius) ? Math.min(Math.max(0, p.radius), Math.min(x1 - x0, y1 - y0) / 2) : 0;
        out.push({...p, x: x0, y: y0, w: x1 - x0, h: y1 - y0, stroke: clampStroke(p.stroke), radius});
        break;
      }
      case 'line':
        if (!ptsOk(p.pts) || p.pts.length < 2 || !fin(p.width)) break;
        out.push({...p, pts: p.pts.map(q => [cx(q[0]), cy(q[1])]), width: Math.min(50, Math.max(0.1, p.width))});
        break;
      case 'poly':
        if (!ptsOk(p.pts) || p.pts.length < 3) break;
        out.push({...p, pts: p.pts.map(q => [cx(q[0]), cy(q[1])]), stroke: clampStroke(p.stroke)});
        break;
      case 'wedge': {
        if (![p.cx, p.cy, p.ro, p.ri, p.a0, p.a1].every(fin)) break;
        const x = cx(p.cx), y = cy(p.cy);
        const maxr = Math.min(x, w - x, y, h - y);
        const ro = Math.min(p.ro, maxr);
        if (ro <= 0) break;
        out.push({...p, cx: x, cy: y, ro, ri: Math.min(ro, Math.max(0, p.ri)), stroke: clampStroke(p.stroke)});
        break;
      }
      case 'circle': {
        if (!(fin(p.cx) && fin(p.cy) && fin(p.r))) break;
        const x = cx(p.cx), y = cy(p.cy);
        const r = Math.min(p.r, x, w - x, y, h - y);
        if (r <= 0) break;
        out.push({...p, cx: x, cy: y, r, stroke: clampStroke(p.stroke)});
        break;
      }
      case 'text':
        if (!(fin(p.x) && fin(p.y) && fin(p.size) && fin(p.rotation)) || !p.text) break;
        out.push({...p, x: cx(p.x), y: cy(p.y), size: Math.min(200, Math.max(1, p.size))});
        break;
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- frame (render/frame.rs)

/** Text colour readable on `fill`. */
export function on(fill) {
  const l = 0.299 * fill[0] + 0.587 * fill[1] + 0.114 * fill[2];
  return l < 150 ? WHITE : DARK_TEXT;
}

export function chartTitle(chart, data) {
  if (typeof chart.title === 'string') { const t = chart.title.trim(); return t || null; }
  if (chart.title === undefined || chart.title === null) {
    if (data.series.length === 1) return data.series[0].name || null;
  }
  return null;
}

export function axisTitles(ctx, chart, area0) {
  let area = area0;
  const lh = AXIS_TITLE_SIZE * 1.4 + 2;
  const xt = typeof chart.xTitle === 'string' ? chart.xTitle.trim() : '';
  if (xt) {
    ctx.text(area.cx, area.bottom, ctx.fit(xt, AXIS_TITLE_SIZE, area.w), AXIS_TITLE_SIZE, TEXT, ['center', 'bottom']);
    area = area.with({h: area.h - lh});
  }
  const yt = typeof chart.yTitle === 'string' ? chart.yTitle.trim() : '';
  if (yt) {
    const t = ctx.fit(yt, AXIS_TITLE_SIZE, area.h);
    if (t) ctx.out.push({t: 'text', x: area.x, y: area.cy, text: t, size: AXIS_TITLE_SIZE, color: TEXT, bold: false, align: 'center', valign: 'top', rotation: -Math.PI / 2});
    area = area.with({x: area.x + lh, w: area.w - lh});
  }
  return area;
}

function levelGroups(level, n) {
  const starts = [];
  for (let j = 0; j < n; j++) if (j === 0 || (level[j] !== undefined && level[j] !== '')) starts.push(j);
  starts.push(n);
  const out = [];
  for (let i = 0; i + 1 < starts.length; i++) out.push([starts[i], starts[i + 1]]);
  return out;
}

const axisLabels = a => a.scale.ticks().map(v => [v, a.fmt.format(v, a.scale.step)]);
const maxw = (ctx, l, size) => l.reduce((m, [, t]) => Math.max(m, ctx.tw(t, size)), 0);

/** Draws gridlines, axis labels and the category axis line; returns the plot rectangle.
 *  cat: {labels, outer} (category labels) or {scale, fmt} (numeric); y, y2: {scale, fmt}. */
export function frame(ctx, area, cat, y, y2, horizontal, grid, show = null) {
  const ls = LABEL_SIZE, lh = ls * 1.4;
  // Add Chart Element > Axes: `show` {category, value} hides the labels of an axis (the axis line stays, as in Excel).
  const showCat = show?.category !== false, showVal = show?.value !== false;
  const ylabels = axisLabels(y);
  if (!horizontal) {
    const left = showVal ? Math.min(maxw(ctx, ylabels, ls) + 6, area.w * 0.4) : 4;
    const y2labels = y2 && showVal ? axisLabels(y2) : null;
    let right;
    if (y2labels) right = Math.min(maxw(ctx, y2labels, ls) + 6, area.w * 0.3);
    else if (cat.scale) right = Math.min(ctx.tw(cat.fmt.format(cat.scale.max, cat.scale.step), ls) / 2, area.w * 0.2);
    else right = 4;
    const levels = cat.outer && showCat ? cat.outer.length : 0;
    const plot = new Bx(area.x + left, area.y + lh * 0.5, area.w - left - right, area.h - (showCat ? lh * 1.5 + 4 : lh * 0.5 + 4) - lh * levels);
    if (!plot.ok()) return plot;
    for (const [v, t] of ylabels) {
      const yy = plot.bottom - y.scale.frac(v) * plot.h;
      if (grid) ctx.hline(plot.x, plot.right, yy, GRID, 0.75);
      if (showVal) ctx.text(plot.x - 4, yy, t, ls, TEXT, ['right', 'middle']);
    }
    if (y2 && y2labels && showVal) {
      for (const [v, t] of y2labels) ctx.text(plot.right + 4, plot.bottom - y2.scale.frac(v) * plot.h, t, ls, TEXT, ['left', 'middle']);
    }
    const zero = y.scale.min <= 0 && y.scale.max >= 0 ? 0 : y.scale.min;
    ctx.hline(plot.x, plot.right, plot.bottom - y.scale.frac(zero) * plot.h, AXIS, 0.75);
    if (!showCat) {
      // no category labels
    } else if (cat.labels) {
      const l = cat.labels, n = Math.max(1, l.length), cw = plot.w / n;
      const lw = l.slice(0, 2000).reduce((m, t) => Math.max(m, ctx.tw(t, ls)), 0);
      const k = Math.min(n, Math.max(1, Math.ceil((lw + 6) / Math.max(1e-3, cw))));
      for (let j = 0; j < l.length; j += k) {
        ctx.text(plot.x + (j + 0.5) * cw, plot.bottom + 3, ctx.fit(l[j], ls, cw * k - 2), ls, TEXT, ['center', 'top']);
      }
      (cat.outer ?? []).forEach((level, i) => {
        const top = plot.bottom + 3 + lh * (i + 1);
        for (const [first, end] of levelGroups(level, n)) {
          const x0 = plot.x + first * cw, x1 = plot.x + end * cw;
          if (level[first]) ctx.text((x0 + x1) / 2, top, ctx.fit(level[first], ls, x1 - x0 - 2), ls, TEXT, ['center', 'top']);
          if (first > 0) ctx.vline(x0, plot.bottom, top + lh - 2, AXIS, 0.75);
        }
        ctx.vline(plot.right, plot.bottom, top + lh - 2, AXIS, 0.75);
      });
    } else {
      const s = cat.scale, f = cat.fmt;
      const ticks = s.ticks();
      const labels = ticks.map(v => f.format(v, s.step));
      const lw = labels.reduce((m, t) => Math.max(m, ctx.tw(t, ls)), 0);
      const slot = plot.w / Math.max(1, ticks.length);
      const k = Math.max(1, Math.ceil((lw + 6) / Math.max(1e-3, slot)));
      if (showCat) for (let i = 0; i < ticks.length; i += k) ctx.text(plot.x + s.frac(ticks[i]) * plot.w, plot.bottom + 3, labels[i], ls, TEXT, ['center', 'top']);
      if (showVal && s.min <= 0 && s.max >= 0) { const xx = plot.x + s.frac(0) * plot.w; ctx.vline(xx, plot.y, plot.bottom, AXIS, 0.75); }
    }
    return plot;
  }
  const labels = cat.labels ?? [];
  const outer = cat.outer ?? [];
  const lw = showCat ? Math.min(labels.slice(0, 2000).reduce((m, t) => Math.max(m, ctx.tw(t, ls)), 0) + 6, area.w * 0.35) : 4;
  const levelW = (showCat ? outer : []).map(l => Math.min(l.slice(0, 2000).reduce((m, t) => Math.max(m, ctx.tw(t, ls)), 0) + 6, area.w * 0.15));
  const levelsW = levelW.reduce((a, b) => a + b, 0);
  const right = Math.min(ylabels.length ? ctx.tw(ylabels[ylabels.length - 1][1], ls) / 2 : 0, area.w * 0.2) + 2;
  const plot = new Bx(area.x + lw + levelsW, area.y + 2, area.w - lw - levelsW - right, area.h - (showVal ? lh + 6 : 6));
  if (!plot.ok()) return plot;
  const vw = maxw(ctx, ylabels, ls);
  const slot = plot.w / Math.max(1, ylabels.length);
  const k = Math.max(1, Math.ceil((vw + 6) / Math.max(1e-3, slot)));
  ylabels.forEach(([v, t], i) => {
    const xx = plot.x + y.scale.frac(v) * plot.w;
    if (grid) ctx.vline(xx, plot.y, plot.bottom, GRID, 0.75);
    if (showVal && i % k === 0) ctx.text(xx, plot.bottom + 3, t, ls, TEXT, ['center', 'top']);
  });
  const zero = y.scale.min <= 0 && y.scale.max >= 0 ? 0 : y.scale.min;
  if (showCat) ctx.vline(plot.x + y.scale.frac(zero) * plot.w, plot.y, plot.bottom, AXIS, 0.75);
  const n = Math.max(1, labels.length), ch = plot.h / n;
  const kk = Math.min(n, Math.max(1, Math.ceil(lh / Math.max(1e-3, ch))));
  for (let j = 0; showCat && j < labels.length; j += kk) ctx.text(plot.x - 4, plot.bottom - (j + 0.5) * ch, ctx.fit(labels[j], ls, lw - 6), ls, TEXT, ['right', 'middle']);
  let x1 = plot.x - lw;
  outer.forEach((level, i) => {
    const w = levelW[i], x0 = x1 - w;
    for (const [first, end] of levelGroups(level, n)) {
      const y0 = plot.bottom - end * ch, yb = plot.bottom - first * ch;
      if (level[first]) ctx.text((x0 + x1) / 2, (y0 + yb) / 2, ctx.fit(level[first], ls, w - 4), ls, TEXT, ['center', 'middle']);
      if (first > 0) ctx.hline(x0, plot.x, yb, AXIS, 0.75);
    }
    ctx.hline(x0, plot.x, plot.y, AXIS, 0.75);
    x1 = x0;
  });
  return plot;
}

/** The plot area's fill and line (Format > Plot Area), under the gridlines `frame` just drew. */
function plotArea(ctx, chart, plot, mark) {
  const p = chart.plot;
  if (!p || (p.fill === undefined && p.line === undefined)) return;
  const fill = hexRgba(p.fill, null), line = p.line === undefined || p.line === 'none' ? null : [hexRgba(p.line, GRID), Math.max(0.25, p.lineWidth ?? 1)];
  ctx.out.splice(mark, 0, {t: 'rect', x: plot.x, y: plot.y, w: plot.w, h: plot.h, fill, stroke: line, radius: 0});
}

export function valueRange(it) {
  let lo = null, hi = null;
  for (const v of it) { if (lo === null) { lo = hi = v; } else { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return lo === null ? null : [lo, hi];
}

// ---------------------------------------------------------------- legend (render/legend.rs)

/** The kind a series is drawn as (per-series kinds only apply to combo charts). */
export const plotKind = (chart, s) => (chart.kind === 'combo' ? (s.kind === 'combo' ? 'line' : s.kind) : chart.kind);

/** Colour of point `j` for charts that colour by point (pie, doughnut, treemap, sunburst). */
export function pointColor(data, j) {
  if (j === 0 && data.series[0]) return data.series[0].color;
  return data.palette.length ? data.palette[j % data.palette.length] : [0x15, 0x60, 0x82, 0xFF];
}
export const catLabel = (data, j) => data.categories[j] ?? String(j + 1);

/** Legend entries [text, colour, swatch] `render` draws for this chart; empty when hidden. */
export function legendEntries(chart, data) {
  if ((chart.legend ?? 'bottom') === 'none') return [];
  switch (chart.kind) {
    case 'pie': case 'doughnut': case 'treemap': case 'sunburst': case 'pie3d': case 'pieOfPie': case 'barOfPie': {
      const n = Math.min(data.series[0]?.values.length ?? 0, MAX_CATS);
      return Array.from({length: n}, (_, j) => [catLabel(data, j), pointColor(data, j), 'box']);
    }
    case 'histogram': case 'funnel': case 'stock': case 'pareto': return [];
    case 'waterfall':
      return data.series.length ? [['Increase', UP, 'box'], ['Decrease', DOWN, 'box'], ['Total', data.series[0].color, 'box']] : [];
    default: {
      const out = data.series.slice(0, MAX_SERIES).map(s => {
        const k = plotKind(chart, s);
        const sw = ['line', 'lineStacked', 'radar', 'scatterLines'].includes(k) ? 'line' : k === 'lineMarkers' ? 'lineMarker' : ['scatter', 'bubble'].includes(k) ? 'marker' : 'box';
        return [s.name, s.color, sw];
      });
      // Trendlines follow the series, named "Linear (Sales)" unless given a name.
      for (const s of data.series.slice(0, MAX_SERIES).filter(x => supportsTrendline(plotKind(chart, x)))) {
        for (const tl of (s.trendlines ?? []).slice(0, MAX_TRENDLINES)) out.push([tl.spec.name ?? autoName(tl.spec, s.name), tl.color, 'line']);
      }
      return out;
    }
  }
}

const swatchW = (sw, s) => (sw === 'box' ? s : s * 2);
function drawSwatch(ctx, sw, x, yc, s, color) {
  if (sw === 'box') ctx.rect(x, yc - s / 2, s, s, color);
  else if (sw === 'line') ctx.hline(x, x + 2 * s, yc, color, 2);
  else if (sw === 'lineMarker') { ctx.hline(x, x + 2 * s, yc, color, 2); ctx.out.push({t: 'circle', cx: x + s, cy: yc, r: s * 0.35, fill: color, stroke: null}); }
  else ctx.out.push({t: 'circle', cx: x + s, cy: yc, r: s * 0.4, fill: color, stroke: null});
}

export function drawLegend(ctx, entries, pos, area) {
  const size = LABEL_SIZE, rowH = size * 1.6, s = size * 0.8, gap = 4, spacing = size * 1.3;
  const itemW = e => swatchW(e[2], s) + gap + ctx.tw(e[0], size);
  if (pos === 'none') return area;
  if (pos === 'top' || pos === 'bottom') {
    const maxRows = Math.max(1, Math.floor(area.h * 0.3 / rowH));
    const rows = [[]];
    let cur = 0;
    for (let i = 0; i < entries.length; i++) {
      const iw = Math.min(itemW(entries[i]), area.w);
      const need = cur > 0 ? spacing + iw : iw;
      if (cur > 0 && cur + need > area.w) {
        if (rows.length >= maxRows) break;
        rows.push([]);
        cur = 0;
      }
      cur += cur > 0 ? spacing + iw : iw;
      rows[rows.length - 1].push([i, iw]);
    }
    const lh = rows.length * rowH;
    const y0 = pos === 'bottom' ? area.bottom - lh : area.y;
    rows.forEach((row, ri) => {
      const total = row.reduce((a, [, w]) => a + w, 0) + spacing * Math.max(0, row.length - 1);
      let x = area.x + Math.max(0, area.w - total) / 2;
      const yc = y0 + ri * rowH + rowH / 2;
      for (const [i, iw] of row) {
        const e = entries[i];
        drawSwatch(ctx, e[2], x, yc, s, e[1]);
        const sx = swatchW(e[2], s) + gap;
        ctx.text(x + sx, yc, ctx.fit(e[0], size, Math.max(0, iw - sx) + 0.5), size, TEXT, ['left', 'middle']);
        x += iw + spacing;
      }
    });
    const used = lh + 4;
    return pos === 'bottom' ? area.with({h: area.h - used}) : area.with({y: area.y + used, h: area.h - used});
  }
  const colw = Math.min(entries.reduce((m, e) => Math.max(m, itemW(e)), 0), area.w * 0.35);
  const maxRows = Math.max(1, Math.floor(area.h / rowH));
  const n = Math.min(entries.length, maxRows);
  const lh = n * rowH;
  const y0 = area.y + Math.max(0, area.h - lh) / 2;
  const x0 = pos === 'right' ? area.right - colw : area.x;
  entries.slice(0, n).forEach((e, i) => {
    const yc = y0 + i * rowH + rowH / 2;
    drawSwatch(ctx, e[2], x0, yc, s, e[1]);
    const sx = swatchW(e[2], s) + gap;
    ctx.text(x0 + sx, yc, ctx.fit(e[0], size, Math.max(0, colw - sx) + 0.5), size, TEXT, ['left', 'middle']);
  });
  const used = colw + 8;
  return pos === 'right' ? area.with({w: area.w - used}) : area.with({x: area.x + used, w: area.w - used});
}

// ---------------------------------------------------------------- lines (render/lines.rs)

/** Reduces a long polyline to first/min/max/last per pixel column. */
export function decimate(pts, max) {
  if (pts.length <= max) return pts;
  const out = [];
  let i = 0;
  while (i < pts.length) {
    const col = Math.floor(pts[i][0]);
    const start = i;
    let mn = i, mx = i, k = i + 1;
    while (k < pts.length && Math.floor(pts[k][0]) === col) {
      if (pts[k][1] < pts[mn][1]) mn = k;
      if (pts[k][1] > pts[mx][1]) mx = k;
      k += 1;
    }
    const idx = [start, mn, mx, k - 1].sort((a, b) => a - b);
    let last = -1;
    for (const ix of idx) if (ix !== last) { out.push(pts[ix]); last = ix; }
    i = k;
  }
  if (out.length > max * 4) {
    const step = Math.floor(out.length / (max * 2)) + 1;
    const last = out[out.length - 1];
    const s = out.filter((_, j) => j % step === 0);
    if (s[s.length - 1] !== last) s.push(last);
    return s;
  }
  return out;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map(k => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
}
function smoothRun(pts, plot) {
  const n = pts.length;
  if (n < 3) return pts;
  const cap = MAX_LINE_PTS * 2;
  const steps = Math.min(100, Math.max(1, Math.floor(cap / n)));
  const at = i => pts[Math.min(n - 1, Math.max(0, i))];
  const x0 = Math.min(plot.x, plot.right), x1 = Math.max(plot.x, plot.right), y0 = Math.min(plot.y, plot.bottom), y1 = Math.max(plot.y, plot.bottom);
  const clip = p => [Math.min(x1, Math.max(x0, p[0])), Math.min(y1, Math.max(y0, p[1]))];
  const out = [];
  for (let i = 0; i < n - 1; i++) for (let s = 0; s < steps; s++) out.push(clip(catmull(at(i - 1), at(i), at(i + 1), at(i + 2), s / steps)));
  out.push(clip(at(n - 1)));
  return out;
}

/** Draws a polyline split at gaps (null), decimated when long; `smooth` (the plot box) interpolates a spline. */
export function drawRuns(ctx, pts, color, width, smooth) {
  let run = [];
  for (const p of [...pts, null]) {
    if (p) { run.push(p); continue; }
    if (run.length >= 2) {
      let r = decimate(run, MAX_LINE_PTS);
      if (smooth) r = smoothRun(r, smooth);
      ctx.line(r, color, width);
    }
    run = [];
  }
}

export function drawMarkers(ctx, pts, r, color) {
  const seen = new Set();
  for (const p of pts) {
    if (seen.size >= MAX_MARKERS) break;
    const key = `${Math.trunc(p[0] * 0.5)},${Math.trunc(p[1] * 0.5)}`;
    if (!seen.has(key)) { seen.add(key); ctx.out.push({t: 'circle', cx: p[0], cy: p[1], r, fill: color, stroke: [WHITE, 0.75]}); }
  }
}

// ---------------------------------------------------------------- cartesian (render/cartesian.rs)

const famOf = k => {
  switch (k) {
    case 'columnStacked': case 'barStacked': return 'colStack';
    case 'columnStacked100': case 'barStacked100': return 'col100';
    case 'line': case 'lineMarkers': case 'scatter': case 'scatterLines': case 'radar': case 'stock': return 'line';
    case 'lineStacked': return 'lineStack';
    case 'area': return 'area';
    case 'areaStacked': return 'areaStack';
    case 'areaStacked100': return 'area100';
    default: return 'col';
  }
};
const is100 = f => f === 'col100' || f === 'area100';
const isCol = f => f === 'col' || f === 'colStack' || f === 'col100';
const isLine = f => f === 'line' || f === 'lineStack';

function seriesSpans(data, fams, sec, ncat) {
  const totals = new Map();
  data.series.forEach((s, i) => {
    const fam = fams[i] ?? 'col';
    if (!is100(fam)) return;
    const key = `${sec[i] ? 1 : 0}|${fam}`;
    if (!totals.has(key)) totals.set(key, new Array(ncat).fill(0));
    const t = totals.get(key);
    s.values.slice(0, ncat).forEach((v, j) => { if (v !== null) t[j] += Math.abs(v); });
  });
  const share = (key, j, v) => { const t = totals.get(key)?.[j] ?? 0; return t > 0 ? v / t : 0; };
  const stacks = new Map();
  return data.series.map((s, i) => {
    const fam = fams[i] ?? 'col';
    const a = !!sec[i];
    const stacked = ['colStack', 'col100', 'lineStack', 'areaStack', 'area100'].includes(fam);
    const key = `${a ? 1 : 0}|${fam}`;
    let st = null;
    if (stacked) { if (!stacks.has(key)) stacks.set(key, {pos: new Array(ncat).fill(0), neg: new Array(ncat).fill(0)}); st = stacks.get(key); }
    const row = [];
    for (let j = 0; j < ncat; j++) {
      const v = s.values[j] ?? null;
      let span;
      if (st && (fam === 'colStack' || fam === 'col100')) {
        if (v === null) span = null;
        else {
          const vv = fam === 'col100' ? share(key, j, v) : v;
          const acc = vv >= 0 ? st.pos : st.neg;
          const base = acc[j];
          acc[j] += vv;
          span = [base, acc[j]];
        }
      } else if (st) {
        let vv = v ?? 0;
        if (fam === 'area100') vv = share(key, j, vv);
        const base = st.pos[j];
        st.pos[j] = clean(st.pos[j] + vv);
        span = [base, st.pos[j]];
      } else span = v === null ? null : [0, v];
      row.push(span);
    }
    return row;
  });
}

function axisScales(data, fams, sec, spans) {
  const axes = [];
  for (const axis of [false, true]) {
    const members = data.series.map((_, i) => i).filter(i => !!sec[i] === axis);
    if (!members.length) continue;
    const forceZero = members.some(i => !isLine(fams[i]));
    const all100 = members.every(i => is100(fams[i]));
    const vals = [];
    for (const i of members) {
      const line = isLine(fams[i]);
      for (const sp of spans[i] ?? []) if (sp) { if (line) vals.push(sp[1]); else vals.push(sp[0], sp[1]); }
    }
    const [lo, hi] = valueRange(vals) ?? [0, 0];
    // A series may carry its own fixed axis `{min, max, step}` (Prism's Pareto chart: its cumulative share runs 0 to 100 %).
    const own = members.map(i => data.series[i].axis).find(a => a && fin(a.min) && fin(a.max) && a.max > a.min);
    if (own) axes.push([fixedScale(own.min, own.max, own.step > 0 ? own.step : (own.max - own.min) / 5), new Fmt(data.series[members[0]]?.numberFormat ?? 'General')]);
    else if (all100) axes.push([fixedScale(lo < -1e-9 ? -1 : 0, hi > 1e-9 || lo >= -1e-9 ? 1 : 0, 0.2), new Fmt('0%')]);
    else axes.push([niceScale(lo, hi, forceZero), new Fmt(data.series[members[0]]?.numberFormat ?? 'General')]);
    if (!axis && sec.every(x => !x)) break;
  }
  return axes;
}

function columnSlots(fams, sec) {
  const keys = [];
  const slotOf = new Array(fams.length).fill(0);
  fams.forEach((f, i) => {
    if (!isCol(f)) return;
    const a = !!sec[i];
    const key = f === 'col' ? `${a}|${f}|${i}` : `${a}|${f}|*`;
    let k = keys.indexOf(key);
    if (k < 0) { keys.push(key); k = keys.length - 1; }
    slotOf[i] = k;
  });
  return [slotOf, Math.max(1, keys.length)];
}

export function cartesian(ctx, chart, data, area, horizontal) {
  const ncat = Math.min(MAX_CATS, Math.max(data.categories.length, ...data.series.map(s => s.values.length), 0));
  if (ncat === 0) return;
  const kinds = data.series.map(s => (horizontal ? chart.kind : plotKind(chart, s)));
  const fams = kinds.map(famOf);
  const anyPrimary = data.series.some(s => !s.secondary);
  const sec = data.series.map(s => s.secondary && anyPrimary && !horizontal);
  const spans = seriesSpans(data, fams, sec, ncat);
  const axes = axisScales(data, fams, sec, spans);
  if (!axes.length) return;
  const [s1, f1] = axes[0];
  const y1 = {scale: s1, fmt: f1};
  const y2 = axes[1] ? {scale: axes[1][0], fmt: axes[1][1]} : null;
  // A forward forecast on a category axis adds empty category slots after the data.
  const fwd = data.series.reduce((m, s, i) => (supportsTrendline(kinds[i]) ? Math.max(m, maxForward(s)) : m), 0);
  const ncatSlots = Math.min(Math.max(MAX_CATS, ncat), ncat + Math.ceil(Math.min(fwd, maxForwardSlots(ncat))));
  const labels = Array.from({length: ncatSlots}, (_, j) => (j < ncat ? catLabel(data, j) : ''));
  const outer = (data.categoryLevels ?? []).map(l => Array.from({length: ncatSlots}, (_, j) => l[j] ?? ''));
  // Add Chart Element: Axes (labels hidden), Data Table (under the plot, in place of the category labels).
  const table = chart.dataTable && !horizontal && takes.dataTable(chart.kind) ? tableSize(ctx, data, LABEL_SIZE) : null;
  // PowerPoint gives the axes as {h, v} (the bottom and left axis); Excel as {category, value}. On a bar chart the category axis is the left one.
  const ax = chart.axes ?? null, hv = !!ax && ('h' in ax || 'v' in ax);
  const catOn = hv ? (horizontal ? ax.v : ax.h) : ax?.category, valOn = hv ? (horizontal ? ax.h : ax.v) : ax?.value;
  const show = {category: catOn !== false && !table, value: valOn !== false};
  let box = area;
  if (table) {
    box = area.with({h: area.h - table.h});
    const probe = new Ctx(ctx.m), p0 = frame(probe, box, {labels, outer}, y1, y2, false, false, show);
    const need = table.nameW + 8 - (p0.x - box.x);
    if (need > 0) box = box.with({x: box.x + need, w: box.w - need});
  }
  const mark = ctx.out.length;
  const plot = frame(ctx, box, {labels, outer}, y1, y2, horizontal, chart.gridlines !== false, show);
  if (!plot.ok()) return;
  plotArea(ctx, chart, plot, mark);
  if (table) drawDataTable(ctx, chart, data, plot, ncat, ncatSlots, s => new Fmt(s.numberFormat), LABEL_SIZE);
  const scaleOf = i => (sec[i] ? (y2 ? y2.scale : s1) : s1);
  const catLen = horizontal ? plot.h : plot.w;
  const cw = catLen / ncatSlots;
  const center = j => (horizontal ? plot.bottom - (j + 0.5) * cw : plot.x + (j + 0.5) * cw);
  const vpos = (v, sc) => (horizontal ? plot.x + sc.frac(v) * plot.w : plot.bottom - sc.frac(v) * plot.h);
  const [slotOf, nslots] = columnSlots(fams, sec);
  const bw = cw / (nslots + 1.5);
  const labelsOn = !!chart.dataLabels && ncat <= MAX_LABELS;
  const areaLabels = [];
  for (let pass = 0; pass < 3; pass++) {
    data.series.forEach((s, i) => {
      const fam = fams[i] ?? 'col';
      const want = pass === 0 ? (fam === 'area' || fam === 'areaStack' || fam === 'area100') : pass === 1 ? isCol(fam) : isLine(fam);
      if (!want) return;
      const sc = scaleOf(i), fmt = new Fmt(s.numberFormat);
      const row = spans[i];
      if (!row) return;
      if (pass === 0) {
        let top = [], base = [];
        row.forEach((sp, j) => {
          const [b, t] = sp ?? [0, 0];
          const c = center(j);
          top.push([c, vpos(t, sc)]);
          base.push([c, vpos(b, sc)]);
          if (labelsOn && sp && s.values[j] !== null && s.values[j] !== undefined) areaLabels.push([c, vpos(t, sc) - 5, fmt.format(s.values[j])]);
        });
        if (top.length === 1) {
          const t = top[0], b = base[0];
          top = [[t[0] - cw * 0.3, t[1]], [t[0] + cw * 0.3, t[1]]];
          base = [[b[0] - cw * 0.3, b[1]], [b[0] + cw * 0.3, b[1]]];
        }
        const poly = [...decimate(top, MAX_LINE_PTS * 2), ...decimate(base, MAX_LINE_PTS * 2).reverse()];
        if (poly.length >= 3) ctx.out.push({t: 'poly', pts: poly, fill: s.color, stroke: null});
      } else if (pass === 1) {
        const k = slotOf[i] ?? 0;
        row.forEach((sp, j) => {
          if (!sp) return;
          const [b, t] = sp;
          const pb = vpos(b, sc), pt = vpos(t, sc), c = center(j), lo = Math.min(pb, pt), len = Math.abs(pb - pt);
          if (horizontal) ctx.rect(lo, c + nslots * bw / 2 - (k + 1) * bw, len, bw, s.color);
          else ctx.rect(c - nslots * bw / 2 + k * bw, lo, bw, len, s.color);
          const v = s.values[j];
          if (labelsOn && v !== null && v !== undefined) {
            const txt = fmt.format(v), stacked = fam !== 'col', mid = (pb + pt) / 2;
            if (horizontal) {
              const y = c + nslots * bw / 2 - (k + 0.5) * bw;
              if (stacked) ctx.text(mid, y, txt, LABEL_SIZE, on(s.color), ['center', 'middle']);
              else if (v >= 0) ctx.text(Math.max(pb, pt) + 3, y, txt, LABEL_SIZE, TEXT, ['left', 'middle']);
              else ctx.text(lo - 3, y, txt, LABEL_SIZE, TEXT, ['right', 'middle']);
            } else {
              const x = c - nslots * bw / 2 + (k + 0.5) * bw;
              if (stacked) ctx.text(x, mid, txt, LABEL_SIZE, on(s.color), ['center', 'middle']);
              else if (v >= 0) ctx.text(x, lo - 2, txt, LABEL_SIZE, TEXT, ['center', 'bottom']);
              else ctx.text(x, lo + len + 2, txt, LABEL_SIZE, TEXT, ['center', 'top']);
            }
          }
        });
      } else {
        const pts = row.map((sp, j) => (sp ? [center(j), vpos(sp[1], sc)] : null));
        drawRuns(ctx, pts, s.color, 2.25, s.smooth ? plot : null);
        if (kinds[i] === 'lineMarkers' && cw >= 3) drawMarkers(ctx, pts.filter(Boolean), 3.5, s.color);
        if (labelsOn) pts.forEach((p, j) => { const v = s.values[j]; if (p && v !== null && v !== undefined) ctx.text(p[0], p[1] - 5, fmt.format(v), LABEL_SIZE, TEXT, ['center', 'bottom']); });
      }
    });
    for (const [x, y, t] of areaLabels.splice(0)) ctx.text(x, y, t, LABEL_SIZE, TEXT, ['center', 'bottom']);
  }
  // Error bars, lines and up/down bars (Add Chart Element) over the series.
  const topOf = (i, j) => { const sp = spans[i]?.[j]; return sp ? vpos(sp[1], scaleOf(i)) : null; };
  const slotAt = (i, j) => { const k = slotOf[i] ?? 0, c = center(j); return horizontal ? [c + nslots * bw / 2 - (k + 1) * bw, c + nslots * bw / 2 - k * bw] : [c - nslots * bw / 2 + k * bw, c - nslots * bw / 2 + (k + 1) * bw]; };
  if (chart.errorBars && takes.errorBars(chart.kind)) {
    drawErrorBars(ctx, chart.errorBars, data, ncat, (i, j) => {
      const sp = spans[i]?.[j];
      if (!sp) return null;
      const stacked = fams[i] !== 'col' && fams[i] !== 'line' && fams[i] !== 'area';
      const k = slotOf[i] ?? 0, c = isCol(fams[i]) ? (horizontal ? center(j) + nslots * bw / 2 - (k + 0.5) * bw : center(j) - nslots * bw / 2 + (k + 0.5) * bw) : center(j);
      return [c, stacked ? sp[1] : data.series[i].values[j], data.series[i].values[j]];
    }, (v, i) => vpos(v, scaleOf(i)), horizontal);
  }
  const lineKind = chart.lines && takes.lines(chart.kind, chart.lines) ? chart.lines : null, upDown = chart.upDownBars === true && takes.upDownBars(chart.kind);
  if (lineKind || upDown) {
    const zero = s1.min <= 0 && s1.max >= 0 ? 0 : s1.min;
    drawLines(ctx, {...chart, lines: lineKind, upDownBars: upDown}, data, ncat, {top: topOf, base: vpos(zero, s1), center, slot: slotAt, horizontal, famOf: i => fams[i], cw});
  }
  // Prism's chart elements (error bars, drop and high-low lines, up/down bars) draw over the plot: `chart.onPlot` gets where the plot is and how a value maps onto it.
  if (typeof chart.onPlot === 'function') chart.onPlot({ctx, plot, data, kinds, horizontal, ncat, ncatSlots, cw, center, vpos, scaleOf, sec});
  // Trendlines on top: x is the category number 1..n.
  const trendLabels = [];
  data.series.forEach((s, i) => {
    if (!s.trendlines?.length || !supportsTrendline(kinds[i])) return;
    const sc = scaleOf(i);
    const pts = s.values.slice(0, ncat).map((v, j) => (v === null || v === undefined ? null : [j + 1, v])).filter(Boolean);
    const frac = (x, y) => [(x - 0.5) / ncatSlots, (y - sc.min) / (sc.max - sc.min)];
    const px = ([fx, fy]) => (horizontal ? [plot.x + fy * plot.w, plot.bottom - fx * plot.h] : [plot.x + fx * plot.w, plot.bottom - fy * plot.h]);
    drawTrendlines(ctx, s, pts, frac, px, trendLabels, [0.5, ncatSlots + 0.5]);
  });
  drawTrendLabels(ctx, plot, trendLabels);
}

export function scatter(ctx, chart, data, area) {
  const all = data.series.map(s => s.values.map((v, j) => {
    const x = s.x ? (s.x[j] ?? null) : j + 1;
    return x !== null && v !== null && v !== undefined ? [x, v] : null;
  }));
  const flat = all.flat().filter(Boolean);
  const xr = valueRange(flat.map(p => p[0]));
  if (!xr) return;
  // Forecasts extend the x axis to the trendline's ends.
  data.series.forEach((s, i) => {
    const r = (s.trendlines ?? []).length ? valueRange(all[i].filter(Boolean).map(p => p[0])) : null;
    if (r) { xr[0] = Math.min(xr[0], r[0] - maxBackward(s)); xr[1] = Math.max(xr[1], r[1] + maxForward(s)); }
  });
  const yr = valueRange(flat.map(p => p[1]));
  if (!yr) return;
  const xs = niceScale(xr[0], xr[1], false), ys = niceScale(yr[0], yr[1], false);
  const fx = new Fmt('General'), fy = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const mark = ctx.out.length;
  const sax = chart.axes ?? null, showXY = sax && ('h' in sax || 'v' in sax) ? {category: sax.h, value: sax.v} : sax;
  const plot = frame(ctx, area, {scale: xs, fmt: fx}, {scale: ys, fmt: fy}, null, false, chart.gridlines !== false, showXY);
  if (!plot.ok()) return;
  plotArea(ctx, chart, plot, mark);
  const map = ([x, y]) => [plot.x + xs.frac(x) * plot.w, plot.bottom - ys.frac(y) * plot.h];
  const bubble = chart.kind === 'bubble';
  const rmax = Math.min(plot.w, plot.h) * 0.12;
  data.series.forEach((s, si) => {
    const pts = all[si];
    const px = pts.map(p => (p ? map(p) : null));
    if (bubble) {
      const sizes = s.sizes ?? [];
      const smax = sizes.reduce((a, b) => (b !== null && b > a ? b : a), 0);
      const bubbles = [];
      px.forEach((p, j) => {
        const sz = sizes.length ? sizes[j] ?? null : 1;
        if (p && sz !== null && sz > 0) bubbles.push([p, sz]);
      });
      bubbles.splice(MAX_MARKERS);
      bubbles.sort((a, b) => b[1] - a[1]);
      const smaxx = sizes.length ? smax : 1;
      const fill = [s.color[0], s.color[1], s.color[2], 0xC0];
      for (const [p, sz] of bubbles) ctx.out.push({t: 'circle', cx: p[0], cy: p[1], r: Math.max(1, Math.sqrt(sz / smaxx) * rmax), fill, stroke: [WHITE, 0.75]});
    } else {
      const lines = chart.kind === 'scatterLines' || s.kind === 'scatterLines';
      if (lines) drawRuns(ctx, px, s.color, 2, s.smooth ? plot : null);
      if (!lines || px.length <= 500) drawMarkers(ctx, px.filter(Boolean), 3.5, s.color);
    }
    if (chart.dataLabels && pts.length <= MAX_LABELS) px.forEach((p, j) => { if (p && pts[j]) ctx.text(p[0], p[1] - 6, fy.format(pts[j][1]), LABEL_SIZE, TEXT, ['center', 'bottom']); });
  });
  const trendLabels = [];
  data.series.forEach((s, si) => {
    if (!s.trendlines?.length) return;
    const frac = (x, y) => [(x - xs.min) / (xs.max - xs.min), (y - ys.min) / (ys.max - ys.min)];
    const px = ([fx, fy_]) => [plot.x + fx * plot.w, plot.bottom - fy_ * plot.h];
    drawTrendlines(ctx, s, all[si].filter(Boolean), frac, px, trendLabels, [xs.min, xs.max]);
  });
  drawTrendLabels(ctx, plot, trendLabels);
}

export {Scale};

// ---------------------------------------------------------------- sparklines (chart/src/sparkline.rs)

/**
 * Draws a sparkline into a `w` x `h` box at the origin. Gaps (null) break lines; negatives in column and win/loss draw in the "down" red.
 * `opts` (Sparkline tab): {flags: {high, low, negative, first, last}, colors: {negative, markers, high, low, first, last} (rgba),
 * axis: {min, max (numbers or null for each sparkline's own), show, rtl}}: the marked points get their colours, the axis fixes the
 * scale (same for all sparklines or a custom value), a horizontal axis line shows at zero and the data runs right to left.
 */
export function renderSparkline(kind, values, color, markers, w, h, opts = {}) {
  if (!(fin(w) && fin(h)) || w < 1 || h < 1 || w > 1e6 || h > 1e6) return [];
  let vals = values.slice(0, MAX_POINTS).map(v => (v !== null && v !== undefined && fin(v) ? Math.min(1e300, Math.max(-1e300, v)) : null));
  const n = vals.length;
  if (n === 0) return [];
  if (opts.axis?.rtl) vals = vals.slice().reverse();
  const flags = opts.flags ?? {}, cols = opts.colors ?? {};
  const pick = key => cols[key] ?? (key === 'markers' ? color : DOWN);
  const pad = Math.min(2, Math.max(0.5, h * 0.1));
  const x0 = pad, y0 = pad, iw = Math.max(0.5, w - 2 * pad), ih = Math.max(0.5, h - 2 * pad);
  const r0 = valueRange(vals.filter(v => v !== null));
  if (!r0) return [];
  let [lo, hi] = r0;
  const ax = opts.axis ?? {};
  const own = [lo, hi];
  if (fin(ax.min)) lo = ax.min;
  if (fin(ax.max)) hi = ax.max;
  if (hi < lo) [lo, hi] = [hi, lo];
  // The marked points: the first and last, the highest and lowest of the data (the first of equal ones), the negatives.
  const real = vals.map((v, j) => [v, j]).filter(([v]) => v !== null);
  const hiAt = real.length ? real.reduce((m, c) => (c[0] > m[0] ? c : m))[1] : -1, loAt = real.length ? real.reduce((m, c) => (c[0] < m[0] ? c : m))[1] : -1;
  const firstAt = real.length ? real[0][1] : -1, lastAt = real.length ? real[real.length - 1][1] : -1;
  const mark = (v, j) => {
    if (flags.high && j === hiAt) return 'high';
    if (flags.low && j === loAt) return 'low';
    if (flags.first && j === firstAt) return 'first';
    if (flags.last && j === lastAt) return 'last';
    if (flags.negative && v < 0) return 'negative';
    return null;
  };
  void own;
  const out = [];
  if (kind === 'line') {
    const span = hi - lo;
    const fy = v => y0 + ih - (span > 0 ? (v - lo) / span : 0.5) * ih;
    const fx = j => (n > 1 ? x0 + j / (n - 1) * iw : x0 + iw / 2);
    if (ax.show && lo <= 0 && hi >= 0 && span > 0) out.push({t: 'line', pts: [[x0, fy(0)], [x0 + iw, fy(0)]], color: [0x80, 0x80, 0x80, 0xFF], width: 0.75, dash: false});
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const step = Math.floor(run.length / 2000) + 1;
        out.push({t: 'line', pts: run.length > 4000 ? run.filter((_, i) => i % step === 0) : run, color, width: 1.25, dash: false});
      }
      run = [];
    };
    vals.forEach((v, j) => { if (v !== null) run.push([fx(j), fy(v)]); else flush(); });
    flush();
    const r = Math.min(3, Math.max(1, h * 0.08)), step = Math.max(1, Math.floor(n / 500));
    if (markers || n === 1) for (let j = 0; j < n; j += step) if (vals[j] !== null) out.push({t: 'circle', cx: fx(j), cy: fy(vals[j]), r, fill: pick('markers'), stroke: null});
    // The marked points sit over the markers, a little larger.
    vals.forEach((v, j) => { const m = v === null ? null : mark(v, j); if (m) out.push({t: 'circle', cx: fx(j), cy: fy(v), r: r * 1.25, fill: pick(m), stroke: null}); });
  } else {
    const slot = iw / n, bw = Math.max(0.25, slot * 0.8), win = kind === 'winLoss';
    const [l0, h0] = win ? [-1, 1] : fin(ax.min) || fin(ax.max) ? [Math.min(lo, 0), Math.max(hi, 0)] : [Math.min(lo, 0), Math.max(hi, 0)];
    const span = h0 - l0;
    const fy = v => (span > 0 ? y0 + ih - (Math.min(h0, Math.max(l0, v)) - l0) / span * ih : y0 + ih);
    const base = fy(0);
    if (ax.show && span > 0) out.push({t: 'line', pts: [[x0, base], [x0 + iw, base]], color: [0x80, 0x80, 0x80, 0xFF], width: 0.75, dash: false});
    vals.forEach((v0, j) => {
      if (v0 === null) return;
      const v = win ? Math.sign(v0) : v0;
      if (win && v === 0) return;
      const top = fy(v);
      const m = mark(v0, j);
      out.push({t: 'rect', x: x0 + j * slot + (slot - bw) / 2, y: Math.min(top, base), w: bw, h: Math.max(0.5, Math.abs(top - base)), fill: m ? pick(m) : v < 0 ? pick('negative') : color, stroke: null, radius: 0});
    });
  }
  return finalize(out, w, h);
}
