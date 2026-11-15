// Trendlines: the least-squares fits behind chart trendlines and moving averages, the equation and R²
// labels, and the lines drawn over a plot.
// Translated from gridcraft crates/chart/src/trend.rs (`fit_trendline`, `TrendFit`, `moving_average`,
// `auto_name`, `num_text`) and crates/chart/src/render/trend.rs (`draw_trendlines`, `draw_trend_labels`,
// `supports_trendline`, forecast slots, `clip_unit`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// A stored trendline (chart series `trendlines[]`): {type: 'linear'|'exponential'|'logarithmic'|'power'|'polynomial'|
// 'movingAverage', order?: 2-6, period?: 2-255, name?, forward?, backward?, intercept?, displayEquation?, displayRSquared?,
// color?, width?, dash?: 'solid'|'dash'}. A resolved one (chart-resolve) is {spec, color}: the stored fields and a colour.
// Exponential, logarithmic and power trendlines are linear fits of transformed data (ln y against x, y against ln x,
// ln y against ln x); points where the transform is undefined are skipped and R² is for the transformed fit.

import {valueRange, decimate, MAX_LINE_PTS, MAX_CATS, LABEL_SIZE, TEXT} from './chart-render.mjs';

export const MAX_TRENDLINES = 16;
export const MAX_FORECAST = 100_000;
const TREND_STEPS = 200;
export const TREND_TYPES = Object.freeze(['linear', 'exponential', 'logarithmic', 'power', 'polynomial', 'movingAverage']);

/** A forecast distance as stored: finite, not negative, at most MAX_FORECAST. */
export const clampForecast = v => (Number.isFinite(v) && v > 0 ? Math.min(v, MAX_FORECAST) : 0);

/** Whether series drawn as `k` show trendlines (2-D unstacked column, bar, line, area, scatter and bubble). */
export const supportsTrendline = k => ['columnClustered', 'barClustered', 'line', 'lineMarkers', 'area', 'scatter', 'scatterLines', 'bubble'].includes(k);

const degree = t => (t.type === 'polynomial' ? Math.min(6, Math.max(2, t.order ?? 2)) : t.type === 'movingAverage' ? null : 1);
const logX = t => t.type === 'logarithmic' || t.type === 'power';
const logY = t => t.type === 'exponential' || t.type === 'power';

/** Gaussian elimination with partial pivoting; null when (nearly) singular. */
function solve(a, b) {
  const n = b.length;
  const big = a.flat().reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (!(Number.isFinite(big) && big > 0)) return null;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let i = col + 1; i < n; i++) if (Math.abs(a[i][col]) > Math.abs(a[piv][col])) piv = i;
    [a[col], a[piv]] = [a[piv], a[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const p = a[col][col];
    if (!Number.isFinite(p) || Math.abs(p) <= big * 1e-13) return null;
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / p;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = 0;
    for (let c = r + 1; c < n; c++) s += a[r][c] * x[c];
    x[r] = (b[r] - s) / a[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Coefficients in X of the sum of a[k] * ((X - c) / s)^k (binomial expansion). */
function expand(a, c, s) {
  const out = new Array(a.length).fill(0);
  a.forEach((ak, k) => {
    const lead = ak / s ** k;
    let binom = 1;
    for (let j = 0; j <= k; j++) {
      out[j] += lead * binom * (-c) ** (k - j);
      binom = (binom * (k - j)) / (j + 1);
    }
  });
  return out.every(Number.isFinite) ? out : null;
}

/** A fitted regression trendline: {coef, r2, eval(x), equation(), rSquared()}; null for moving averages and degenerate data. */
export function fitTrendline(t, pts) {
  const d = degree(t);
  if (d === null) return null;
  const data = pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!logX(t) || x > 0) && (!logY(t) || y > 0))
    .map(([x, y]) => [logX(t) ? Math.log(x) : x, logY(t) ? Math.log(y) : y]);
  if (data.length < 2 || data.length <= d) return null;
  // Set Intercept applies to linear, exponential and polynomial trendlines; it fixes Y at x = 0.
  let fixed = null;
  if (t.type === 'linear' || t.type === 'polynomial') fixed = t.intercept ?? null;
  else if (t.type === 'exponential') fixed = t.intercept > 0 ? Math.log(t.intercept) : null;
  if (fixed !== null && !Number.isFinite(fixed)) fixed = null;
  const n = data.length;
  const center = fixed !== null ? 0 : data.reduce((s, p) => s + p[0], 0) / n;
  const scale = data.reduce((m, p) => Math.max(m, Math.abs(p[0] - center)), 0);
  if (!(Number.isFinite(scale) && scale > 0)) return null;
  const first = fixed !== null ? 1 : 0;
  const b0 = fixed ?? 0;
  const m = d + 1 - first;
  const ata = Array.from({length: m}, () => new Array(m).fill(0));
  const aty = new Array(m).fill(0);
  for (const [x, y] of data) {
    const u = (x - center) / scale;
    const pows = Array.from({length: m}, (_, i) => u ** (first + i));
    pows.forEach((pi, i) => {
      aty[i] += pi * (y - b0);
      pows.forEach((pj, j) => { ata[i][j] += pi * pj; });
    });
  }
  const sol = solve(ata, aty);
  if (!sol) return null;
  const a = new Array(d + 1).fill(b0);
  sol.forEach((v, k) => { a[k + first] = v; });
  const coef = expand(a, center, scale);
  if (!coef) return null;
  const poly = x => { const u = (x - center) / scale; return a.reduceRight((acc, c) => acc * u + c, 0); };
  const mean = data.reduce((s, p) => s + p[1], 0) / n;
  let ssRes = 0, ssTot = 0;
  for (const [x, y] of data) { ssRes += (y - poly(x)) ** 2; ssTot += fixed !== null ? (y - b0) ** 2 : (y - mean) ** 2; }
  const r2 = ssTot > 0 && Number.isFinite(ssTot) && Number.isFinite(ssRes) ? 1 - ssRes / ssTot : null;
  return {
    coef, r2,
    /** The trendline's y at x; null outside its domain (x <= 0 for log and power) or when not finite. */
    eval(x) {
      let xx = x;
      if (logX(t)) { if (x > 0) xx = Math.log(x); else return null; }
      const p = poly(xx);
      const y = logY(t) ? Math.exp(p) : p;
      return Number.isFinite(y) ? y : null;
    },
    equation() {
      const c0 = coef[0] ?? 0, c1 = coef[1] ?? 0;
      if (t.type === 'exponential') return `y = ${numText(Math.exp(c0))}e^(${numText(c1)}x)`;
      if (t.type === 'power') return `y = ${numText(Math.exp(c0))}x^${numText(c1)}`;
      if (t.type === 'logarithmic') return terms([[c1, 'ln(x)'], [c0, '']]);
      return terms(coef.map((c, k) => [c, POWERS[k] ?? 'x']).reverse());
    },
    rSquared() { return r2 === null ? 'R² = #N/A' : `R² = ${numText(r2)}`; },
  };
}

const POWERS = ['', 'x', 'x²', 'x³', 'x⁴', 'x⁵', 'x⁶'];

/** `y = a*t1 ± b*t2 ...`, skipping terms whose coefficient shows as 0. */
function terms(parts) {
  let s = 'y = ';
  let first = true;
  for (const [c, t] of parts) {
    const txt = numText(Math.abs(c));
    if (txt === '0') continue;
    const neg = c < 0;
    if (first) { if (neg) s += '-'; } else s += neg ? ' - ' : ' + ';
    // A unit coefficient on a power of x is left out: `y = x² - x + 1`.
    if (txt !== '1' || t === '') s += txt;
    s += t;
    first = false;
  }
  return first ? s + '0' : s;
}

const trimZeros = s => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/** A coefficient as trendline labels show it: up to four decimals, scientific when tiny or huge. */
export function numText(v) {
  if (!Number.isFinite(v)) return '#NUM!';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (!(a >= 1e-4 && a < 1e11)) {
    const [mant, exp] = v.toExponential(4).toUpperCase().split('E');
    const e = Number(exp);
    return `${trimZeros(mant)}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  const s = trimZeros(v.toFixed(4));
  return s === '-0' ? '0' : s;
}

/** Moving average of `period` consecutive points in plotted order: point i (from period - 1) is (x_i, mean(y_{i-p+1}..y_i)). */
export function movingAverage(pts, period) {
  const p = Math.min(255, Math.max(2, Math.trunc(period) || 2));
  const ok = pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const out = [];
  for (let i = p - 1; i < ok.length; i++) {
    let sum = 0;
    for (let k = i - p + 1; k <= i; k++) sum += ok[k][1];
    out.push([ok[i][0], sum / p]);
  }
  return out;
}

/** Excel's automatic trendline name for the legend, e.g. `Linear (Sales)`. */
export function autoName(t, series) {
  const k = {linear: 'Linear', exponential: 'Expon.', logarithmic: 'Log.', polynomial: 'Poly.', power: 'Power'}[t.type]
    ?? `${Math.min(255, Math.max(2, t.period ?? 2))} per. Mov. Avg.`;
  return `${k} (${series})`;
}

// ---------------------------------------------------------------- drawing

const forecast = v => (Number.isFinite(v) && v > 0 ? Math.min(v, 1e9) : 0);
const regression = s => (s.trendlines ?? []).filter(t => t.spec.type !== 'movingAverage');

/** Most empty category slots a forward forecast may add after `ncat` categories (four times the data, at least 32, never past MAX_CATS in total). */
export const maxForwardSlots = ncat => Math.min(Math.max(ncat * 4, 32), Math.max(0, MAX_CATS - ncat));
export const maxForward = s => regression(s).reduce((m, t) => Math.max(m, forecast(t.spec.forward)), 0);
export const maxBackward = s => regression(s).reduce((m, t) => Math.max(m, forecast(t.spec.backward)), 0);

/** Liang-Barsky: the part of segment a-b inside the unit square, with whether the start and end were cut. */
function clipSegment(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0]], [dx, 1 - a[0]], [-dy, a[1]], [dy, 1 - a[1]]]) {
    if (p === 0) { if (q < 0) return null; } else {
      const r = q / p;
      if (p < 0) { if (r > t1) return null; t0 = Math.max(t0, r); } else { if (r < t0) return null; t1 = Math.min(t1, r); }
    }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy], t0 > 0, t1 < 1];
}

/** Clips a sampled polyline in plot fractions (null = gap) to the plot box, returning the visible runs. */
function clipUnit(pts) {
  const LIM = 1e9;
  const ok = p => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const cl = p => [Math.min(LIM, Math.max(-LIM, p[0])), Math.min(LIM, Math.max(-LIM, p[1]))];
  const runs = [];
  let run = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = a && b && ok(a) && ok(b) ? clipSegment(cl(a), cl(b)) : null;
    if (seg) {
      const [p, q, cutStart, cutEnd] = seg;
      if (cutStart || !run.length) {
        if (run.length >= 2) runs.push(run);
        run = [p];
      }
      run.push(q);
      if (cutEnd) { runs.push(run); run = []; }
    } else {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/**
 * Draws `s`'s trendlines fitted to its plotted points `pts` (data x, y). `frac` maps data to fractions of the plot box,
 * `px` fractions to pixels; equation and R² label lines are appended to `labels`. Degenerate fits draw nothing.
 */
export function drawTrendlines(ctx, s, pts, frac, px, labels, window) {
  const range = valueRange(pts.map(p => p[0]));
  if (!range) return;
  const [xlo, xhi] = range;
  for (const t of (s.trendlines ?? []).slice(0, MAX_TRENDLINES)) {
    const spec = t.spec;
    let samples;
    if (spec.type === 'movingAverage') samples = movingAverage(pts, spec.period ?? 2).map(([x, y]) => frac(x, y));
    else {
      const fit = fitTrendline(spec, pts);
      if (!fit) continue;
      // Sample only the part of the forecast that is on the plot.
      const lo = Math.max(xlo - forecast(spec.backward), window[0]), hi = Math.min(xhi + forecast(spec.forward), window[1]);
      if (spec.displayEquation) labels.push(fit.equation());
      if (spec.displayRSquared) labels.push(fit.rSquared());
      samples = Array.from({length: TREND_STEPS + 1}, (_, i) => {
        const x = lo + ((hi - lo) * i) / TREND_STEPS;
        const y = fit.eval(x);
        return y === null ? null : frac(x, y);
      });
    }
    const width = Math.min(12, Math.max(0.25, Number.isFinite(spec.width) ? spec.width : 1.5));
    const dash = spec.dash !== 'solid';
    for (const run of clipUnit(samples)) {
      const line = decimate(run.map(px), MAX_LINE_PTS);
      if (line.length >= 2) ctx.out.push({t: 'line', pts: line, color: t.color, width, dash});
    }
  }
}

/** Trendline equation and R² labels, stacked in the plot's top-right corner. */
export function drawTrendLabels(ctx, plot, labels) {
  const lh = LABEL_SIZE * 1.3;
  labels.forEach((text, i) => {
    const y = plot.y + 4 + i * lh;
    if (y + lh > plot.bottom) return;
    ctx.text(plot.right - 4, y, ctx.fit(text, LABEL_SIZE, plot.w - 8), LABEL_SIZE, TEXT, ['right', 'top']);
  });
}
