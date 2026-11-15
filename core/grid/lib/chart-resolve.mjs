// Pulls chart data (names, categories, values, formats, colours) out of a workbook.
// Translated from gridcraft crates/chart/src/resolve.rs (`resolve`, `series_color`, `category_table`,
// `series_name`, `eval_list`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {parseRange, splitSheet, categoryLevels, width, height} from './addr.mjs';
import {GArray, CellError, toText} from './value.mjs';
import {engineFor} from '../model/calc.mjs';
import {displayAt} from '../model/index.mjs';
import {sheetIndex} from '../model/sheet.mjs';
import {styleAt} from '../model/workbook.mjs';
import {applyTint, resolveColor, DEFAULT_THEME} from '../model/style.mjs';
import {MAX_POINTS, MAX_SERIES} from './chart-render.mjs';
import {MAX_TRENDLINES, TREND_TYPES, clampForecast} from './chart-trend.mjs';
import {paletteColor, styleOf} from './chart-styles.mjs';

const CYCLE_TINTS = [0, 0.4, -0.25, 0.6, -0.5, 0.2];
export const PALETTE_CYCLE = 6 * CYCLE_TINTS.length;

const themeOf = content => content?.theme ?? DEFAULT_THEME;

/** Colour of the i-th series: theme accents 1-6, then tinted variations of them. */
export function seriesColor(theme, i) {
  const base = theme.colors?.[4 + (i % 6)] ?? 0x156082;
  const rgb = [(base >> 16) & 255, (base >> 8) & 255, base & 255];
  const [r, g, b] = applyTint(rgb, CYCLE_TINTS[Math.floor(i / 6) % CYCLE_TINTS.length] ?? 0);
  return [r, g, b, 0xFF];
}
export const defaultPalette = (theme, n) => Array.from({length: Math.min(n, 4096)}, (_, i) => seriesColor(theme, i));

/** Splits `Sheet!A1:B2` / `'My Sheet'!$A$1` / `A1:B2` into a sheet index and range. */
export function parseRef(content, si, formula) {
  const f = String(formula).trim().replace(/^=/, '').trim();
  const [name, addr] = splitSheet(f);
  const sheet = name === null ? si : sheetIndex(content, name);
  if (sheet < 0 || sheet === undefined || sheet === null) return null;
  const r = parseRange(addr.replace(/\$/g, ''));
  return r ? {sheet, range: r} : null;
}

/** The parts of a union reference `(Sheet1!$A$1:$A$3,Sheet1!$A$5)`, or null. */
function unionParts(f) {
  if (!(f.startsWith('(') && f.endsWith(')'))) return null;
  const inner = f.slice(1, -1);
  const parts = [];
  let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'") quoted = !quoted;
    else if (c === '(' && !quoted) depth += 1;
    else if (c === ')' && !quoted) depth -= 1;
    else if (c === ',' && !quoted && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    if (depth < 0) return null;
  }
  parts.push(inner.slice(start));
  return parts.length > 1 ? parts : null;
}

function evalList(content, engine, si, formula, depth = 0) {
  const f = String(formula ?? '').trim();
  if (!f) return [];
  const parts = depth < 4 ? unionParts(f) : null;
  if (parts) {
    const out = [];
    for (const p of parts) {
      if (out.length >= MAX_POINTS) break;
      out.push(...evalList(content, engine, si, p, depth + 1).slice(0, MAX_POINTS - out.length));
    }
    return out;
  }
  const v = engine.evaluate(si, {row: 0, col: 0}, f);
  return v instanceof GArray ? v.data.slice(0, MAX_POINTS) : [v];
}

const toNum = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nums = (content, engine, si, f) => evalList(content, engine, si, f).map(toNum);
const valueText = v => (v === null || v === undefined ? '' : v instanceof CellError ? v.text : toText(v));

/** Number format code of the first cell of a reference ("General" when not a reference). */
function refFormat(content, si, formula) {
  const r = parseRef(content, si, formula);
  if (!r) return 'General';
  const code = styleAt(content, content.sheets[r.sheet], r.range.start.row, r.range.start.col).numFmt;
  return typeof code === 'string' && code ? code : 'General';
}

/** Category labels formatted with each source cell's number format, and the outer levels of a multi-level axis. */
function categoryTable(content, engine, si, formula, values) {
  const vals = evalList(content, engine, si, formula);
  const src = parseRef(content, si, formula);
  const texts = vals.map((v, i) => {
    if (src && typeof v === 'number') {
      const w = Math.max(1, width(src.range));
      const row = src.range.start.row + Math.floor(i / w), col = src.range.start.col + (i % w);
      return displayAt(content, src.sheet, row, col, v).text;
    }
    return valueText(v);
  });
  if (!src) return [texts, []];
  const vr = parseRef(content, si, values)?.range ?? null;
  const levels = categoryLevels(src.range, vr);
  if (!levels) return [texts, []];
  const w = Math.max(1, width(src.range)), h = Math.max(1, height(src.range));
  if (texts.length !== w * h) return [texts, []];
  const at = (row, col) => texts[row * w + col] ?? '';
  const column = c => Array.from({length: h}, (_, row) => at(row, c));
  const row = rr => Array.from({length: w}, (_, c) => at(rr, c));
  const outer = levels.outer;
  if (levels.byColumns) return [column(w - 1), Array.from({length: outer}, (_, k) => w - 1 - (k + 1)).filter(c => c >= 0).map(column)];
  return [row(h - 1), Array.from({length: outer}, (_, k) => h - 1 - (k + 1)).filter(r => r >= 0).map(row)];
}

function isDefinedName(content, si, t) {
  const bare = t.includes('!') ? t.split('!').pop() : t;
  return (content.names ?? []).some(n => n.name.toLowerCase() === bare.toLowerCase());
}

function seriesName(content, engine, si, name) {
  const t = String(name).trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/""/g, '"');
  if (t.startsWith('=') || (parseRef(content, si, t) && t.includes('!')) || isDefinedName(content, si, t)) {
    return evalList(content, engine, si, t).map(valueText).filter(s => s !== '').slice(0, 8).join(' ');
  }
  return t;
}

const effectiveKind = (chartKind, seriesKind, i) => {
  if (chartKind === 'combo') return seriesKind && seriesKind !== 'combo' ? seriesKind : i === 0 ? 'columnClustered' : 'line';
  return seriesKind && seriesKind !== 'combo' ? seriesKind : chartKind;
};

/** The kind series `i` of `chart` is drawn as: its own kind in a combo chart, else the chart's. */
export const seriesPlotKind = (chart, i) => (chart.kind === 'combo' ? effectiveKind(chart.kind, chart.series?.[i]?.kind, i) : chart.kind);

/** Evaluates a chart's series formulas: names, values, categories (default 1, 2, ...), X values, sizes, formats, colours. */
export function resolveChart(content, si, chart, engine = engineFor(content)) {
  const theme = themeOf(content);
  const numericX = ['scatter', 'scatterLines', 'bubble', 'bubble3d'].includes(chart.kind);
  const series = [];
  let categories = null, levels = [];
  (chart.series ?? []).slice(0, MAX_SERIES).forEach((s, i) => {
    const values = nums(content, engine, si, s.values);
    const nm = s.name ? seriesName(content, engine, si, s.name) : '';
    const name = nm || `Series${i + 1}`;
    const rgb = s.color ? resolveColor(s.color, theme) : null;
    const styled = !rgb ? resolveColor(paletteColor(styleOf(chart.style)[0], i), theme) : null;
    const color = rgb ? [...rgb, 0xFF] : styled ? [...styled, 0xFF] : seriesColor(theme, i);
    const kind = effectiveKind(chart.kind, s.kind, i);
    let x = null;
    if (s.categories && (numericX || ['scatter', 'scatterLines', 'bubble'].includes(kind))) {
      const xs = evalList(content, engine, si, s.categories);
      if (!xs.some(v => typeof v === 'string')) x = xs.map(toNum);
    }
    if (categories === null && s.categories) {
      const [c, outer] = categoryTable(content, engine, si, s.categories, s.values);
      if (c.length) { categories = c; levels = outer; }
    }
    const sizes = s.bubbleSizes ? nums(content, engine, si, s.bubbleSizes) : null;
    const trendlines = (Array.isArray(s.trendlines) ? s.trendlines : []).filter(tl => TREND_TYPES.includes(tl?.type)).slice(0, MAX_TRENDLINES).map(tl => {
      const c = tl.color ? resolveColor(tl.color, theme) : null;
      return {spec: {...tl, forward: clampForecast(tl.forward), backward: clampForecast(tl.backward)}, color: c ? [...c, 0xFF] : color};
    });
    series.push({name, values, x, sizes, color, kind, secondary: !!s.secondary, smooth: !!s.smooth, trendlines, numberFormat: refFormat(content, si, s.values)});
  });
  const n = Math.max(0, ...series.map(s => s.values.length));
  return {categories: categories ?? Array.from({length: n}, (_, i) => String(i + 1)), categoryLevels: levels, series, palette: defaultPalette(theme, Math.min(n, PALETTE_CYCLE))};
}
