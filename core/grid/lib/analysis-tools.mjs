// The Analysis ToolPak tools (Data > Analysis > Data Analysis): each computes a report, a Grid of values
// by (row, column) relative to its top-left corner, from input ranges.
// Translated from gridcraft crates/engine/src/cmd/analysis.rs (`descriptive`, `histogram`, `matrix`,
// `regression`, `moving_average`, `exponential_smoothing`, `forecast_grid`, `rank_percentile`, `t_test`,
// `f_test`, `anova_single`, the parameter readers and `TOOLS`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Layouts follow Microsoft's public description of the tools (row labels and section titles); exact
// spacing is the upstream reading of it. Distribution values (t, F) come from analysis-dist.mjs so the
// reports agree with the worksheet functions of the same names. The input is read through `env`:
// {content, sheet (the active sheet index), value(sheet, row, col)}. No DOM, no Node built-ins.

import {ERR, display} from './value.mjs';
import {bad, failed, parseRangeText} from './data-common.mjs';
import {mean, ss, varS, val, ratio, nOrDiv0, dist, sortAsc, median, mode, kurtosis, skewness, correlation, covarianceP, ols} from './analysis-stats.mjs';
import {tDist2T, tDistRT, tInv, tInv2T, fDist, fDistRT, fInv, fInvRT} from './analysis-dist.mjs';

export const CMD = 'data.analysisToolPak';
/** Most input cells a tool reads. */
export const MAX_INPUT_CELLS = 1_000_000;
/** Most cells a report may write. */
export const MAX_OUTPUT_CELLS = 4_000_000;
/** Most variables in a correlation or covariance matrix (work grows with its square). */
const MAX_MATRIX_VARS = 256;
/** Excel's limit on regression X columns. */
const MAX_REGRESSORS = 16;
/** Most histogram bins. */
const MAX_BINS = 100_000;

/** Part of the error a programmatic call gets when the output range already holds data; the dialog recognises it and asks before running again with `overwrite: true`. */
export const OVERWRITE_ERROR = 'already holds data';

/** [id, label] of every tool, in the order of Excel's Analysis Tools list. */
export const TOOLS = [
  ['anovaSingle', 'Anova: Single Factor'],
  ['correlation', 'Correlation'],
  ['covariance', 'Covariance'],
  ['descriptive', 'Descriptive Statistics'],
  ['exponentialSmoothing', 'Exponential Smoothing'],
  ['fTest', 'F-Test Two-Sample for Variances'],
  ['histogram', 'Histogram'],
  ['movingAverage', 'Moving Average'],
  ['rankPercentile', 'Rank and Percentile'],
  ['regression', 'Regression'],
  ['tTestPaired', 't-Test: Paired Two Sample for Means'],
  ['tTestEqual', 't-Test: Two-Sample Assuming Equal Variances'],
  ['tTestUnequal', 't-Test: Two-Sample Assuming Unequal Variances'],
];

// ---------------------------------------------------------------- parameters

/** A number parameter: a number, or text such as `95` or `95%`; null when absent or not finite. */
export function num(p, key) {
  const v = p[key];
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') { const t = v.trim().replace(/%$/, '').trim(); n = t === '' ? null : Number(t); }
  return n !== null && Number.isFinite(n) ? n : null;
}
export function flag(p, key) {
  const v = p[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  if (typeof v === 'number') return v !== 0;
  return false;
}
/** The first of `keys` that holds non-blank text. */
export function text(p, keys) {
  for (const k of keys) if (typeof p[k] === 'string' && p[k].trim()) return p[k].trim();
  return null;
}
const norm = s => String(s).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
/** A tool id from its id or its label (case and punctuation ignored). */
export function toolId(t) {
  const n = norm(t);
  return TOOLS.find(([id, label]) => norm(id) === n || norm(label) === n)?.[0] ?? null;
}
/** Confidence level as a percentage in (0, 100): `95`, `"95%"` or `0.95`. */
function confidence(p, key) {
  const raw = num(p, key);
  if (raw === null) return null;
  const c = raw > 0 && raw < 1 ? raw * 100 : raw;
  if (c > 0 && c < 100) return c;
  throw bad(CMD, 'the confidence level must be between 0 and 100');
}
function alphaOf(p) {
  const a = num(p, 'alpha');
  if (a === null) return 0.05;
  if (a > 0 && a < 1) return a;
  throw bad(CMD, 'alpha must be between 0 and 1');
}
const byRowsOf = p => typeof p.groupedBy === 'string' && p.groupedBy.toLowerCase().startsWith('row');

// ---------------------------------------------------------------- input

const nonNumeric = () => failed('Input range contains non-numeric data.');

/** The cells of a range parameter, after checking its size: {sheet, range}. */
function inputRange(env, p, keys) {
  const t = text(p, keys);
  if (t === null) throw bad(CMD, `missing \`${keys[0] ?? 'range'}\` (the input range)`);
  const r = parseRangeText(env.content, t, CMD, env.sheet);
  const cells = (r.range.end.row - r.range.start.row + 1) * (r.range.end.col - r.range.start.col + 1);
  if (cells > MAX_INPUT_CELLS) throw bad(CMD, `the input range is too large (${MAX_INPUT_CELLS} cells at most)`);
  return r;
}

/** Splits a range into variables (columns, or rows when `byRows`); with `labels` the first cell of each names it, else `fallback(i)` does. */
function variables(env, si, r, byRows, labels, fallback) {
  const w = r.end.col - r.start.col + 1, h = r.end.row - r.start.row + 1;
  const [outer, inner] = byRows ? [h, w] : [w, h];
  const out = [];
  for (let i = 0; i < outer; i++) {
    const cell = j => (byRows ? [r.start.row + i, r.start.col + j] : [r.start.row + j, r.start.col + i]);
    const vals = [];
    for (let j = 0; j < inner; j++) { const [row, col] = cell(j); vals.push(env.value(si, row, col)); }
    let name = fallback(i);
    if (labels && vals.length) {
      const t = display(vals.shift());
      if (t.trim()) name = t;
    }
    out.push({name, vals});
  }
  return out;
}

/** The numbers of a variable; blanks are skipped when `skipBlank`, anything else that is not a number is an error. */
function numbers(v, skipBlank) {
  const out = [];
  for (const x of v) {
    if (typeof x === 'number') out.push(x);
    else if ((x === null || x === undefined) && skipBlank) continue;
    else throw nonNumeric();
  }
  return out;
}

/** One variable from a single row or column (`range1`/`range2` of the two-sample tests). */
function single(env, p, key, fallback) {
  const {sheet, range: r} = inputRange(env, p, [key]);
  const w = r.end.col - r.start.col + 1, h = r.end.row - r.start.row + 1;
  if (w > 1 && h > 1) throw failed('Input range must be a single row or column.');
  const v = variables(env, sheet, r, w > 1, flag(p, 'labels'), () => fallback);
  if (!v.length) throw bad(CMD, 'empty input range');
  return v[v.length - 1];
}

// ---------------------------------------------------------------- report grid

/** A report: values by (row, col) relative to its top-left corner; `pct` lists the cells shown as percentages. */
export class Grid {
  constructor() { this.cells = new Map(); this.pct = []; }
  put(r, c, v) { if (v !== null && v !== undefined) this.cells.set(r * 65536 + c, v); }
  get(r, c) { return this.cells.get(r * 65536 + c); }
  txt(r, c, t) { this.put(r, c, String(t)); }
  num(r, c, x) { this.put(r, c, val(x)); }
  labels(r, c, items) { items.forEach((t, k) => { if (t) this.txt(r, c + k, t); }); }
  /** [rows, cols] spanned. */
  extent() {
    let rows = 0, cols = 0;
    for (const k of this.cells.keys()) { rows = Math.max(rows, Math.floor(k / 65536) + 1); cols = Math.max(cols, (k % 65536) + 1); }
    return [rows, cols];
  }
  /** [row, col, value] of every cell. */
  entries() { return [...this.cells].map(([k, v]) => [Math.floor(k / 65536), k % 65536, v]); }
}

// ---------------------------------------------------------------- tools

function descriptive(env, p) {
  const {sheet, range} = inputRange(env, p, ['range', 'input']);
  const vars = variables(env, sheet, range, byRowsOf(p), flag(p, 'labels'), i => `Column${i + 1}`);
  const summary = p.summary !== undefined ? flag(p, 'summary') : true;
  const conf = confidence(p, 'confidence');
  const kth = key => { const k = num(p, key); return k !== null && k >= 1 ? Math.trunc(k) : null; };
  const kl = kth('kthLargest'), ks = kth('kthSmallest');
  if (!summary && conf === null && kl === null && ks === null) throw bad(CMD, 'choose at least one of summary, confidence, kthLargest or kthSmallest');
  const g = new Grid();
  vars.forEach((v, i) => {
    const x = numbers(v.vals, true);
    const c = i * 2;
    g.txt(0, c, v.name);
    let row = 2;
    const line = (label, value) => { g.txt(row, c, label); g.put(row, c + 1, value); row++; };
    const n = x.length;
    const sorted = sortAsc(x);
    if (summary) {
      const sd = Math.sqrt(varS(x));
      line('Mean', nOrDiv0(mean(x)));
      line('Standard Error', n < 2 ? ERR.Div0 : nOrDiv0(sd / Math.sqrt(n)));
      line('Median', median(sorted));
      line('Mode', mode(x));
      line('Standard Deviation', nOrDiv0(sd));
      line('Sample Variance', nOrDiv0(varS(x)));
      line('Kurtosis', kurtosis(x));
      line('Skewness', skewness(x));
      const lo = sorted[0], hi = sorted[n - 1];
      line('Range', n ? val(hi - lo) : 0);
      line('Minimum', n ? val(lo) : 0);
      line('Maximum', n ? val(hi) : 0);
      line('Sum', val(x.reduce((a, b) => a + b, 0)));
      line('Count', val(n));
    }
    if (kl !== null) line(`Largest(${kl})`, kl <= n ? val(sorted[n - kl]) : ERR.Num);
    if (ks !== null) line(`Smallest(${ks})`, ks <= n ? val(sorted[ks - 1]) : ERR.Num);
    if (conf !== null) {
      const sd = Math.sqrt(varS(x));
      const value = n < 2 ? ERR.Div0 : nOrDiv0(tInv2T(1 - conf / 100, n - 1) * sd / Math.sqrt(n));
      line(`Confidence Level(${conf.toFixed(1)}%)`, value);
    }
  });
  return g;
}

function histogram(env, p) {
  const {sheet, range: r} = inputRange(env, p, ['range', 'input']);
  const labels = flag(p, 'labels');
  const read = (si, rg) => {
    const out = [];
    for (let row = rg.start.row; row <= rg.end.row; row++) for (let col = rg.start.col; col <= rg.end.col; col++) out.push(env.value(si, row, col));
    return out;
  };
  const cells = read(sheet, r);
  if (labels && cells.length) cells.shift();
  const data = numbers(cells, true);
  let bins;
  if (text(p, ['bins', 'binRange']) !== null) {
    const b = inputRange(env, p, ['bins', 'binRange']);
    const bc = read(b.sheet, b.range);
    if (labels && bc.length) bc.shift();
    bins = numbers(bc, true);
  } else {
    // Evenly spaced bins from the minimum to the maximum, sqrt(n) intervals.
    let lo = Infinity, hi = -Infinity;
    for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw failed('The input range holds no numbers.');
    const k = Math.min(Math.max(Math.floor(Math.sqrt(data.length)), 1), 1000);
    bins = hi === lo ? [lo] : Array.from({length: k + 1}, (_, i) => lo + (hi - lo) * i / k);
  }
  if (!bins.length) throw failed('The bin range holds no numbers.');
  if (bins.length > MAX_BINS) throw bad(CMD, `too many bins (${MAX_BINS} at most)`);
  bins.sort((a, b) => a - b);
  const freq = new Array(bins.length + 1).fill(0);
  for (const x of data) {
    // The first bin that is not below x (bins are sorted): how many bins lie below it.
    let lo = 0, hi = bins.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bins[mid] < x) lo = mid + 1; else hi = mid; }
    freq[lo]++;
  }
  const rows = [...bins.map(b => val(b)), 'More'].map((b, i) => [b, freq[i]]);
  const total = data.length;
  const cumulative = flag(p, 'cumulative');
  const g = new Grid();
  const write = (c0, list) => {
    g.labels(0, c0, ['Bin', 'Frequency']);
    if (cumulative) g.txt(0, c0 + 2, 'Cumulative %');
    let acc = 0;
    list.forEach(([b, f], i) => {
      const row = i + 1;
      g.put(row, c0, b);
      g.num(row, c0 + 1, f);
      if (cumulative) {
        acc += f;
        g.put(row, c0 + 2, ratio(acc, total));
        g.pct.push([row, c0 + 2]);
      }
    });
  };
  write(0, rows);
  if (flag(p, 'pareto')) write(cumulative ? 3 : 2, [...rows].sort((a, b) => b[1] - a[1]));
  return g;
}

/** Variables of a range whose columns (rows) must all be numbers, for the matrix tools. */
function matrixVars(env, p) {
  const {sheet, range} = inputRange(env, p, ['range', 'input']);
  const vars = variables(env, sheet, range, byRowsOf(p), flag(p, 'labels'), i => `Column ${i + 1}`);
  if (vars.length > MAX_MATRIX_VARS) throw bad(CMD, `too many variables (${MAX_MATRIX_VARS} at most)`);
  return vars.map(v => [v.name, numbers(v.vals, false)]);
}
function matrix(env, p, f, diag) {
  const vars = matrixVars(env, p);
  const g = new Grid();
  vars.forEach(([name, x], i) => {
    const k = i + 1;
    g.txt(0, k, name);
    g.txt(k, 0, name);
    for (let j = 0; j <= i; j++) g.put(k, j + 1, i === j ? diag(x) : f(x, vars[j][1]));
  });
  return g;
}

// ---------------------------------------------------------------- regression

function regression(env, p) {
  const labels = flag(p, 'labels');
  const y0 = inputRange(env, p, ['inputY', 'y']);
  const x0 = inputRange(env, p, ['inputX', 'x']);
  const yr = y0.range, xr = x0.range;
  const yw = yr.end.col - yr.start.col + 1, yh = yr.end.row - yr.start.row + 1;
  const xw = xr.end.col - xr.start.col + 1, xh = xr.end.row - xr.start.row + 1;
  if (yw !== 1) throw failed('Input Y range must be a single column.');
  if (xh !== yh) throw failed('Input Y range and input X range must have the same number of rows.');
  if (xw > MAX_REGRESSORS) throw failed(`Input X range must have ${MAX_REGRESSORS} columns or fewer.`);
  const yv = variables(env, y0.sheet, yr, false, labels, () => 'Y');
  const xv = variables(env, x0.sheet, xr, false, labels, i => `X Variable ${i + 1}`);
  const yvar = yv[0];
  if (!yvar) throw bad(CMD, 'empty input Y range');
  const y = numbers(yvar.vals, false);
  const xs = xv.map(v => numbers(v.vals, false));
  const zero = flag(p, 'constantZero');
  const k = xs.length, n = y.length;
  const params = zero ? k : k + 1;
  if (n <= params) throw failed('Too few observations for this many X variables.');
  const fit = ols(y, xs, zero);
  if (!fit) throw failed("The X variables are collinear; the regression can't be computed.");
  const conf = confidence(p, 'confidence') ?? 95;
  const sst = fit.ssr + fit.sse;
  const r2 = sst > 0 ? fit.ssr / sst : NaN;
  const g = new Grid();
  g.txt(0, 0, 'SUMMARY OUTPUT');
  g.txt(2, 0, 'Regression Statistics');
  const stats = [
    ['Multiple R', nOrDiv0(Math.sqrt(r2))],
    ['R Square', nOrDiv0(r2)],
    ['Adjusted R Square', nOrDiv0(1 - (fit.sse / fit.dfe) / (sst / fit.dft))],
    ['Standard Error', nOrDiv0(Math.sqrt(fit.sse / fit.dfe))],
    ['Observations', val(n)],
  ];
  stats.forEach(([label, v], i) => { g.txt(3 + i, 0, label); g.put(3 + i, 1, v); });
  g.txt(9, 0, 'ANOVA');
  g.labels(10, 1, ['df', 'SS', 'MS', 'F', 'Significance F']);
  const msr = fit.ssr / fit.dfr, mse = fit.sse / fit.dfe;
  const f = msr / mse;
  g.txt(11, 0, 'Regression');
  g.num(11, 1, fit.dfr);
  g.num(11, 2, fit.ssr);
  g.num(11, 3, msr);
  g.put(11, 4, nOrDiv0(f));
  g.put(11, 5, Number.isFinite(f) ? dist(fDistRT(f, fit.dfr, fit.dfe)) : ERR.Div0);
  g.txt(12, 0, 'Residual');
  g.num(12, 1, fit.dfe);
  g.num(12, 2, fit.sse);
  g.num(12, 3, mse);
  g.txt(13, 0, 'Total');
  g.num(13, 1, fit.dft);
  g.num(13, 2, sst);
  g.labels(15, 1, ['Coefficients', 'Standard Error', 't Stat', 'P-value', 'Lower 95%', 'Upper 95%', `Lower ${conf.toFixed(1)}%`, `Upper ${conf.toFixed(1)}%`]);
  const t95 = tInv2T(0.05, fit.dfe);
  const tc = tInv2T(1 - conf / 100, fit.dfe);
  fit.coef.forEach((b, j) => {
    const se = fit.se[j];
    const row = 16 + j;
    g.txt(row, 0, j === 0 ? 'Intercept' : xv[j - 1]?.name ?? '');
    g.num(row, 1, b);
    if (j === 0 && zero) { for (let c = 2; c <= 8; c++) g.put(row, c, ERR.NA); return; }
    const t = b / se;
    g.put(row, 2, nOrDiv0(se));
    g.put(row, 3, nOrDiv0(t));
    g.put(row, 4, Number.isFinite(t) ? dist(tDist2T(Math.abs(t), fit.dfe)) : ERR.Div0);
    g.num(row, 5, b - t95 * se);
    g.num(row, 6, b + t95 * se);
    g.num(row, 7, b - tc * se);
    g.num(row, 8, b + tc * se);
  });
  let row = 16 + fit.coef.length + 3;
  const residuals = flag(p, 'residuals'), standardized = flag(p, 'standardizedResiduals');
  if (residuals || standardized) {
    g.txt(row, 0, 'RESIDUAL OUTPUT');
    const head = ['Observation', `Predicted ${yvar.name}`, 'Residuals'];
    if (standardized) head.push('Standard Residuals');
    g.labels(row + 2, 0, head);
    // Residuals scaled by their standard deviation (n - 1).
    const sd = Math.sqrt(fit.sse / (n - 1));
    y.forEach((yi, i) => {
      const r = row + 3 + i, pi = fit.predicted[i];
      g.num(r, 0, i + 1);
      g.num(r, 1, pi);
      g.num(r, 2, yi - pi);
      if (standardized) g.put(r, 3, ratio(yi - pi, sd));
    });
  }
  if (flag(p, 'normalProbability')) {
    const c = residuals || standardized ? (standardized ? 5 : 4) : 0;
    if (!(residuals || standardized)) row = 16 + fit.coef.length + 3;
    g.txt(row, c, 'PROBABILITY OUTPUT');
    g.labels(row + 2, c, ['Percentile', yvar.name]);
    sortAsc(y).forEach((v, i) => {
      g.num(row + 3 + i, c, 100 * (i + 0.5) / n);
      g.num(row + 3 + i, c + 1, v);
    });
  }
  return g;
}

// ---------------------------------------------------------------- smoothing

function series(env, p) {
  const {sheet, range: r} = inputRange(env, p, ['range', 'input']);
  const w = r.end.col - r.start.col + 1, h = r.end.row - r.start.row + 1;
  if (w > 1 && h > 1) throw failed('Input range must be a single row or column.');
  const v = variables(env, sheet, r, w > 1, flag(p, 'labels'), () => '');
  return numbers(v[0]?.vals ?? [], false);
}

/** Writes the forecasts (and with `standardErrors` the standard errors over `seWindow` points) down two columns. */
export function forecastGrid(x, f, seWindow, p) {
  const g = new Grid();
  f.forEach((fi, i) => g.put(i, 0, fi === null || fi === undefined ? ERR.NA : val(fi)));
  if (flag(p, 'standardErrors')) {
    // A running sum of squared residuals over the last `seWindow` points: O(n), not O(n * window). A point
    // without a forecast restarts it, so every window touching it is #N/A.
    const sq = j => (j >= 0 && j < x.length && f[j] !== null && f[j] !== undefined ? (x[j] - f[j]) ** 2 : null);
    let acc = 0, run = 0;
    for (let i = 0; i < f.length; i++) {
      const t = sq(i);
      if (t !== null) { acc += t; run++; } else { acc = 0; run = 0; }
      if (run > seWindow) { acc -= (i >= seWindow ? sq(i - seWindow) : null) ?? 0; run = seWindow; }
      // Rounding in the subtraction can leave a tiny negative sum.
      g.put(i, 1, run === seWindow ? val(Math.sqrt(Math.max(acc, 0) / seWindow)) : ERR.NA);
    }
  }
  return g;
}

function movingAverage(env, p) {
  const x = series(env, p);
  const interval = num(p, 'interval') ?? 3;
  if (interval < 1 || interval !== Math.trunc(interval) || interval > x.length) throw failed('The interval must be a whole number from 1 to the number of data points.');
  const k = interval;
  const f = [];
  let acc = 0;
  x.forEach((v, i) => {
    acc += v;
    if (i - k >= 0) acc -= x[i - k];
    f.push(i + 1 >= k ? acc / k : null);
  });
  return forecastGrid(x, f, k, p);
}

function exponentialSmoothing(env, p) {
  const x = series(env, p);
  const damp = num(p, 'damping') ?? 0.3;
  if (!(damp >= 0 && damp <= 1)) throw failed('The damping factor must be between 0 and 1.');
  // F(1) = A(0); F(t) = (1 - damping) * A(t-1) + damping * F(t-1).
  const f = [];
  for (let i = 0; i < x.length; i++) {
    if (i === 0) f.push(null);
    else if (i === 1) f.push(x[0]);
    else f.push(f[i - 1] === null ? null : (1 - damp) * x[i - 1] + damp * f[i - 1]);
  }
  return forecastGrid(x, f, 3, p);
}

// ---------------------------------------------------------------- rank and percentile

/** Number of values in the ascending list below (`strict`) or at most `x`. */
function countBelow(asc, x, orEqual) {
  let lo = 0, hi = asc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (orEqual ? asc[mid] <= x : asc[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function rankPercentile(env, p) {
  const {sheet, range} = inputRange(env, p, ['range', 'input']);
  const vars = variables(env, sheet, range, byRowsOf(p), flag(p, 'labels'), i => `Column${i + 1}`);
  const g = new Grid();
  vars.forEach((v, vi) => {
    const c = vi * 4;
    g.labels(0, c, ['Point', v.name, 'Rank', 'Percent']);
    const pts = [];
    v.vals.forEach((x, i) => {
      if (typeof x === 'number') pts.push([i + 1, x]);
      else if (x !== null && x !== undefined) throw nonNumeric();
    });
    const asc = sortAsc(pts.map(q => q[1]));
    const n = asc.length;
    pts.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    pts.forEach(([point, x], k) => {
      const row = k + 1;
      const below = countBelow(asc, x, false);
      const above = n - countBelow(asc, x, true);
      g.num(row, c, point);
      g.num(row, c + 1, x);
      g.num(row, c + 2, above + 1);
      // PERCENTRANK.INC: share of values below, truncated to three digits.
      const pr = n <= 1 ? 1 : Math.floor(below / (n - 1) * 1000 + 1e-9) / 1000;
      g.num(row, c + 3, pr);
      g.pct.push([row, c + 3]);
    });
  });
  return g;
}

// ---------------------------------------------------------------- tests of means and variances

function twoSamples(env, p, skipBlank) {
  const a = single(env, p, 'range1', 'Variable 1');
  const b = single(env, p, 'range2', 'Variable 2');
  const x = numbers(a.vals, skipBlank), y = numbers(b.vals, skipBlank);
  if (x.length < 2 || y.length < 2) throw failed('Each input range needs at least two numbers.');
  return {a, b, x, y};
}

/** Title, blank row and the "Variable 1 / Variable 2" header; returns the first data row. */
function testHead(g, title, a, b) {
  g.txt(0, 0, title);
  g.txt(2, 1, a);
  g.txt(2, 2, b);
  return 3;
}

/** The t statistic rows shared by the three t-tests. */
function tRows(g, row, t, df, alpha) {
  const ta = Math.abs(t);
  const lines = [
    ['t Stat', nOrDiv0(t)],
    ['P(T<=t) one-tail', Number.isFinite(t) ? dist(tDistRT(ta, df)) : ERR.Div0],
    ['t Critical one-tail', dist(tInv(1 - alpha, df))],
    ['P(T<=t) two-tail', Number.isFinite(t) ? dist(tDist2T(ta, df)) : ERR.Div0],
    ['t Critical two-tail', dist(tInv2T(alpha, df))],
  ];
  for (const [label, v] of lines) { g.txt(row, 0, label); g.put(row, 1, v); row++; }
}

function pairRow(g, row, label, a, b = null) {
  g.txt(row, 0, label);
  g.put(row, 1, a);
  g.put(row, 2, b);
}

function tTest(env, p, kind) {
  const alpha = alphaOf(p);
  const hmd = num(p, 'hypothesizedDifference') ?? num(p, 'difference') ?? 0;
  const paired = kind === 'tTestPaired';
  const {a, b, x, y} = twoSamples(env, p, !paired);
  const n1 = x.length, n2 = y.length;
  const m1 = mean(x), m2 = mean(y), v1 = varS(x), v2 = varS(y);
  const g = new Grid();
  const title = kind === 'tTestPaired' ? 't-Test: Paired Two Sample for Means' : kind === 'tTestEqual' ? 't-Test: Two-Sample Assuming Equal Variances' : 't-Test: Two-Sample Assuming Unequal Variances';
  let row = testHead(g, title, a.name, b.name);
  pairRow(g, row, 'Mean', val(m1), val(m2));
  pairRow(g, row + 1, 'Variance', val(v1), val(v2));
  pairRow(g, row + 2, 'Observations', val(n1), val(n2));
  row += 3;
  let t, df;
  if (kind === 'tTestPaired') {
    if (x.length !== y.length) throw failed('Input ranges must have the same number of values.');
    pairRow(g, row, 'Pearson Correlation', correlation(x, y));
    row++;
    const dif = x.map((v, i) => v - y[i]);
    const sd = Math.sqrt(varS(dif));
    t = (mean(dif) - hmd) / (sd / Math.sqrt(n1));
    df = n1 - 1;
  } else if (kind === 'tTestEqual') {
    const pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
    pairRow(g, row, 'Pooled Variance', val(pooled));
    row++;
    t = (m1 - m2 - hmd) / Math.sqrt(pooled * (1 / n1 + 1 / n2));
    df = n1 + n2 - 2;
  } else {
    const q1 = v1 / n1, q2 = v2 / n2;
    // Welch-Satterthwaite degrees of freedom, rounded to a whole number.
    df = Math.round((q1 + q2) ** 2 / (q1 * q1 / (n1 - 1) + q2 * q2 / (n2 - 1)));
    t = (m1 - m2 - hmd) / Math.sqrt(q1 + q2);
  }
  pairRow(g, row, 'Hypothesized Mean Difference', val(hmd));
  pairRow(g, row + 1, 'df', nOrDiv0(df));
  tRows(g, row + 2, t, df, alpha);
  return g;
}

function fTest(env, p) {
  const alpha = alphaOf(p);
  const {a, b, x, y} = twoSamples(env, p, true);
  const v1 = varS(x), v2 = varS(y);
  const d1 = x.length - 1, d2 = y.length - 1;
  const g = new Grid();
  const row = testHead(g, 'F-Test Two-Sample for Variances', a.name, b.name);
  pairRow(g, row, 'Mean', val(mean(x)), val(mean(y)));
  pairRow(g, row + 1, 'Variance', val(v1), val(v2));
  pairRow(g, row + 2, 'Observations', val(d1 + 1), val(d2 + 1));
  pairRow(g, row + 3, 'df', val(d1), val(d2));
  const f = v1 / v2;
  pairRow(g, row + 4, 'F', nOrDiv0(f));
  // The tail on the side of F: left when F < 1, right otherwise.
  let pv, crit;
  if (!Number.isFinite(f)) { pv = ERR.Div0; crit = ERR.Div0; }
  else if (f < 1) { pv = dist(fDist(f, d1, d2)); crit = dist(fInv(alpha, d1, d2)); }
  else { pv = dist(fDistRT(f, d1, d2)); crit = dist(fInvRT(alpha, d1, d2)); }
  pairRow(g, row + 5, 'P(F<=f) one-tail', pv);
  pairRow(g, row + 6, 'F Critical one-tail', crit);
  return g;
}

function anovaSingle(env, p) {
  const alpha = alphaOf(p);
  const {sheet, range} = inputRange(env, p, ['range', 'input']);
  const vars = variables(env, sheet, range, byRowsOf(p), flag(p, 'labels'), i => `Column ${i + 1}`);
  const groups = vars.map(v => [v.name, numbers(v.vals, true)]);
  if (groups.length < 2 || groups.some(([, x]) => !x.length)) throw failed('Anova needs at least two groups, each with at least one number.');
  const g = new Grid();
  g.txt(0, 0, 'Anova: Single Factor');
  g.txt(2, 0, 'SUMMARY');
  g.labels(3, 0, ['Groups', 'Count', 'Sum', 'Average', 'Variance']);
  const all = groups.flatMap(([, x]) => x);
  const grand = mean(all);
  let ssb = 0, ssw = 0;
  groups.forEach(([name, x], i) => {
    const row = 4 + i;
    const m = mean(x);
    g.txt(row, 0, name);
    g.num(row, 1, x.length);
    g.num(row, 2, x.reduce((a, b) => a + b, 0));
    g.num(row, 3, m);
    g.put(row, 4, nOrDiv0(varS(x)));
    ssb += x.length * (m - grand) * (m - grand);
    ssw += ss(x);
  });
  const k = groups.length, n = all.length;
  const dfb = k - 1, dfw = n - k;
  const row = 4 + groups.length + 2;
  g.txt(row, 0, 'ANOVA');
  g.labels(row + 1, 0, ['Source of Variation', 'SS', 'df', 'MS', 'F', 'P-value', 'F crit']);
  const msb = ssb / dfb, msw = ratio(ssw, dfw);
  const f = typeof msw === 'number' ? msb / msw : NaN;
  g.txt(row + 2, 0, 'Between Groups');
  g.num(row + 2, 1, ssb);
  g.num(row + 2, 2, dfb);
  g.num(row + 2, 3, msb);
  g.put(row + 2, 4, nOrDiv0(f));
  g.put(row + 2, 5, Number.isFinite(f) && dfw > 0 ? dist(fDistRT(f, dfb, dfw)) : ERR.Div0);
  g.put(row + 2, 6, dfw > 0 ? dist(fInvRT(alpha, dfb, dfw)) : ERR.Div0);
  g.txt(row + 3, 0, 'Within Groups');
  g.num(row + 3, 1, ssw);
  g.num(row + 3, 2, dfw);
  g.put(row + 3, 3, msw);
  g.txt(row + 5, 0, 'Total');
  g.num(row + 5, 1, ssb + ssw);
  g.num(row + 5, 2, n - 1);
  return g;
}

/** Runs one tool: its report Grid. `tool` is a tool id. */
export function runTool(env, p, tool) {
  switch (tool) {
    case 'descriptive': return descriptive(env, p);
    case 'histogram': return histogram(env, p);
    case 'correlation': return matrix(env, p, correlation, () => 1);
    case 'covariance': return matrix(env, p, covarianceP, x => covarianceP(x, x));
    case 'regression': return regression(env, p);
    case 'movingAverage': return movingAverage(env, p);
    case 'exponentialSmoothing': return exponentialSmoothing(env, p);
    case 'rankPercentile': return rankPercentile(env, p);
    case 'tTestPaired': case 'tTestEqual': case 'tTestUnequal': return tTest(env, p, tool);
    case 'fTest': return fTest(env, p);
    case 'anovaSingle': return anovaSingle(env, p);
    default: throw bad(CMD, `unknown tool \`${tool}\``);
  }
}

