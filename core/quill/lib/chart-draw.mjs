// Drawing a Word chart: the chart model (core/quill/model/chart.mjs) is turned into the chart Grid draws, and Grid's chart
// renderer (core/grid/lib/chart-render.mjs, translated from gridcraft crates/chart) lays it out into drawing primitives that the page
// view paints (src/apps/quill/surface/paint.mjs) and the tests read. Word has no renderer of its own here: the same code draws a
// chart in Grid, Word and the Insert Chart preview.
//
// Where Word differs from Grid: the data is the chart's own embedded sheet (a table: chartTable), not a range of a workbook; the
// series colours come from the document's theme (settings.themeColors); a chart with no title shows none (Grid shows the name of a
// one-series chart); the legend is off when the model has none.
//
// Prim: {t:'rect'|'line'|'poly'|'wedge'|'circle'|'text', ...} in points from the chart's top left; colours [r, g, b, a] 0 to 255 (see
// chart-render.mjs). No DOM, no Node built-ins.

import {render, approxMeasure} from '../../grid/lib/chart-render.mjs';
import {applyTint, resolveColor, DEFAULT_THEME} from '../../grid/model/style.mjs';
import {paletteColor, styleOf} from '../../grid/lib/chart-styles.mjs';
import {gridKind} from '../model/chart.mjs';

/** Grid's tints of the theme accents past the sixth series (chart-resolve.mjs CYCLE_TINTS). */
const CYCLE_TINTS = [0, 0.4, -0.25, 0.6, -0.5, 0.2];

/** Grid's theme ({colors: ints}) from a Quill document's theme colours ([r, g, b] each). */
export function gridTheme(themeColors) {
  if (!Array.isArray(themeColors) || themeColors.length < 10) return DEFAULT_THEME;
  return {...DEFAULT_THEME, colors: themeColors.map(([r, g, b]) => ((r << 16) | (g << 8) | b))};
}

/** Colour of the i-th series: the theme's accents 1 to 6, then tinted variations of them. */
export function seriesColor(theme, i) {
  const base = theme.colors?.[4 + (i % 6)] ?? 0x156082;
  const rgb = [(base >> 16) & 255, (base >> 8) & 255, base & 255];
  const [r, g, b] = applyTint(rgb, CYCLE_TINTS[Math.floor(i / 6) % CYCLE_TINTS.length] ?? 0);
  return [r, g, b, 0xFF];
}

/**
 * A series colour of a one-hue palette (monochrome, accent 1 to 6) spread from dark to light over the `n` series, so two series of one
 * hue are told apart (Word's monochrome palettes do the same; Grid's fixed step makes two series near-identical). `colorful` is null.
 */
export function paletteColorN(palette, i, n) {
  const base = paletteColor(palette, 0);
  if (!base) return null;
  const tint = n > 1 ? -0.5 + (0.95 * Math.min(i, n - 1)) / (n - 1) : 0;
  return {...base, tint: Math.max(-0.8, Math.min(0.8, tint))};
}

/** The colour of series `i` of the chart: its own, else its style's palette, else the theme's cycle. */
export function colorOfSeries(spec, theme, i) {
  const own = spec.series[i]?.color ? resolveColor(spec.series[i].color, theme) : null;
  if (own) return [...own, 0xFF];
  const styled = resolveColor(paletteColorN(styleOf(spec.style)[0], i, spec.series.length), theme);
  return styled ? [...styled, 0xFF] : seriesColor(theme, i);
}

/** The chart as Grid's renderer takes it (kind, title, legend, gridlines, data labels, axis titles, a kind for each series). */
export function gridChart(spec) {
  return {
    kind: gridKind(spec.type), title: spec.title ?? '', legend: spec.legend ?? 'none', dataLabels: !!spec.dataLabels, gridlines: spec.gridlines !== false,
    ...(spec.xTitle ? {xTitle: spec.xTitle} : {}), ...(spec.yTitle ? {yTitle: spec.yTitle} : {}), ...(spec.style ? {style: spec.style} : {}),
    series: spec.series.map(() => ({})),
  };
}

const numeric = list => list.length > 0 && list.every(c => String(c).trim() !== '' && Number.isFinite(Number(c)));

/** The chart's data as Grid's renderer reads it: categories, the series with their colours, and the palette of a pie's points. */
export function gridData(spec, theme) {
  const n = spec.categories.length;
  const xs = (spec.type === 'scatter' || spec.type === 'scatterLines') && numeric(spec.categories) ? spec.categories.map(Number) : null;
  return {
    categories: spec.categories.length ? [...spec.categories] : Array.from({length: n}, (_, i) => String(i + 1)), categoryLevels: [],
    series: spec.series.map((s, i) => ({name: s.name || `Series${i + 1}`, values: [...s.values], x: xs, sizes: null, color: colorOfSeries(spec, theme, i), kind: gridKind(spec.type),
      secondary: false, smooth: false, trendlines: [], numberFormat: 'General'})),
    palette: Array.from({length: Math.min(n, 36)}, (_, i) => seriesColor(theme, i)),
  };
}

const cache = new WeakMap();
/**
 * The drawing primitives of a chart `w` x `h` points, measuring text with `measure` ({textWidth(text, size, bold)}; default a fixed
 * advance). Kept for a chart object until its size, theme or measure changes.
 */
export function chartPrims(spec, w, h, theme = DEFAULT_THEME, measure = approxMeasure) {
  const hit = cache.get(spec);
  if (hit && hit.w === w && hit.h === h && hit.theme === theme && hit.measure === measure) return hit.prims;
  let prims = [];
  try { prims = render(gridChart(spec), gridData(spec, theme), w, h, measure); } catch { prims = []; }
  if ((spec.areaFill || spec.areaLine) && prims[0]?.t === 'rect') {
    const rgba = hex => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255]; };
    const back = {...prims[0]};
    if (spec.areaFill) back.fill = spec.areaFill === 'none' ? null : rgba(spec.areaFill);
    if (spec.areaLine) back.stroke = spec.areaLine === 'none' || !(spec.areaLine.width > 0) ? null : [rgba(spec.areaLine.color), spec.areaLine.width];
    prims = [back, ...prims.slice(1)];
  }
  cache.set(spec, {w, h, theme, measure, prims});
  return prims;
}
