// The statistics behind the Analysis ToolPak reports: mean, sums of squares, variance, median, mode,
// kurtosis, skewness, correlation and covariance, and ordinary least squares with its standard errors.
// Translated from gridcraft crates/engine/src/cmd/analysis.rs (`mean`, `ss`, `var_s`, `median`, `mode`,
// `kurtosis`, `skewness`, `sxy`, `correlation`, `covariance_p`, `invert`, `ols`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Functions on plain number arrays; results that Excel shows as an error are CellError values
// (#DIV/0!, #N/A, #NUM!), numbers that cannot be computed are NaN. No DOM, no Node built-ins.

import {ERR, num as numValue} from './value.mjs';

export const mean = x => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
/** Sum of squared deviations from the mean. */
export function ss(x) { const m = mean(x); let s = 0; for (const v of x) s += (v - m) * (v - m); return s; }
/** Sample variance (n - 1). */
export const varS = x => (x.length < 2 ? NaN : ss(x) / (x.length - 1));

/** A number as a value: #NUM! when it is not finite. */
export const val = x => numValue(x);
/** `a / b`, #DIV/0! when `b` is zero or the inputs are not finite. */
export const ratio = (a, b) => (b === 0 || !Number.isFinite(a) || !Number.isFinite(b) ? ERR.Div0 : numValue(a / b));
/** The number, #DIV/0! when it is not finite. */
export const nOrDiv0 = x => (Number.isFinite(x) ? numValue(x) : ERR.Div0);
/** A distribution result: #NUM! when it is NaN. */
export const dist = x => (Number.isFinite(x) ? numValue(x) : ERR.Num);

export const sortAsc = x => [...x].sort((a, b) => a - b);

export function median(sorted) {
  const n = sorted.length;
  if (!n) return ERR.Num;
  return numValue(n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2);
}

/** The most frequent value (the first one to reach the top count), #N/A when no value repeats. */
export function mode(x) {
  const counts = new Map();
  for (const v of x) counts.set(v, (counts.get(v) ?? 0) + 1);
  let top = 0;
  for (const c of counts.values()) if (c > top) top = c;
  if (top < 2) return ERR.NA;
  for (const v of x) if (counts.get(v) === top) return numValue(v);
  return ERR.NA;
}

/** Sample excess kurtosis (Excel's KURT). */
export function kurtosis(x) {
  const n = x.length, sd = Math.sqrt(varS(x));
  if (n < 4 || Number.isNaN(sd) || sd <= 0) return ERR.Div0;
  const m = mean(x);
  let s4 = 0;
  for (const v of x) s4 += ((v - m) / sd) ** 4;
  return numValue((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * s4 - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3)));
}
/** Sample skewness (Excel's SKEW). */
export function skewness(x) {
  const n = x.length, sd = Math.sqrt(varS(x));
  if (n < 3 || Number.isNaN(sd) || sd <= 0) return ERR.Div0;
  const m = mean(x);
  let s3 = 0;
  for (const v of x) s3 += ((v - m) / sd) ** 3;
  return numValue((n / ((n - 1) * (n - 2))) * s3);
}

/** Sum of cross products of deviations. */
export function sxy(x, y) {
  const mx = mean(x), my = mean(y);
  let s = 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s;
}
export function correlation(x, y) {
  const d = Math.sqrt(ss(x) * ss(y));
  return !x.length || Number.isNaN(d) || d <= 0 ? ERR.Div0 : numValue(sxy(x, y) / d);
}
export const covarianceP = (x, y) => (!x.length ? ERR.Div0 : numValue(sxy(x, y) / x.length));

/** Inverts a small symmetric matrix by Gauss-Jordan elimination with partial pivoting; null when it is singular (collinear inputs). */
export function invert(m) {
  const n = m.length;
  const a = m.map(r => [...r]);
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(a[i][i]));
  const inv = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => (i === j ? 1 : 0)));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    const pv = a[piv][col];
    if (Number.isNaN(pv) || Math.abs(pv) <= 1e-12 * Math.max(scale, Number.MIN_VALUE)) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    [inv[col], inv[piv]] = [inv[piv], inv[col]];
    for (let j = 0; j < n; j++) { a[col][j] /= pv; inv[col][j] /= pv; }
    const prow = [...a[col]], pinv = [...inv[col]];
    for (let i = 0; i < n; i++) {
      if (i === col) continue;
      const f = a[i][col];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) { a[i][j] -= f * prow[j]; inv[i][j] -= f * pinv[j]; }
    }
  }
  return inv;
}

/**
 * Ordinary least squares of `y` on the columns `xs`, with an intercept unless `zero`. Returns
 * {coef (intercept first), se (same order; NaN for a forced-zero intercept), predicted, sse, ssr, dfr, dfe, dft} or null.
 */
export function ols(y, xs, zero) {
  const n = y.length, k = xs.length, nf = n;
  const ym = zero ? 0 : mean(y);
  const xm = zero ? xs.map(() => 0) : xs.map(mean);
  const dev = (j, i) => (xs[j][i] ?? 0) - xm[j];
  const sxx = Array.from({length: k}, () => new Array(k).fill(0));
  const sxyv = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const yi = (y[i] ?? 0) - ym;
    for (let a = 0; a < k; a++) {
      const da = dev(a, i);
      sxyv[a] += da * yi;
      for (let b = 0; b < k; b++) sxx[a][b] += da * dev(b, i);
    }
  }
  const inv = invert(sxx);
  if (!inv) return null;
  const b = Array.from({length: k}, (_, a) => { let s = 0; for (let c = 0; c < k; c++) s += inv[a][c] * sxyv[c]; return s; });
  let dot = 0;
  for (let j = 0; j < k; j++) dot += b[j] * xm[j];
  const b0 = zero ? 0 : ym - dot;
  const predicted = Array.from({length: n}, (_, i) => { let s = b0; for (let j = 0; j < k; j++) s += b[j] * (xs[j][i] ?? 0); return s; });
  let sse = 0, ssr = 0;
  for (let i = 0; i < n; i++) { sse += (y[i] - predicted[i]) ** 2; ssr += (predicted[i] - ym) ** 2; }
  const dfr = k;
  const dfe = zero ? nf - dfr : nf - dfr - 1;
  const dft = zero ? nf : nf - 1;
  const s2 = sse / dfe;
  const se = [];
  if (zero) se.push(NaN);
  else {
    let q = 0;
    for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) q += xm[a] * inv[a][c] * xm[c];
    se.push(Math.sqrt(s2 * (1 / nf + q)));
  }
  for (let a = 0; a < k; a++) se.push(Math.sqrt(s2 * inv[a][a]));
  return {coef: [b0, ...b], se, predicted, sse, ssr, dfr, dfe, dft};
}
