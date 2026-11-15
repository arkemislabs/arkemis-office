// The FORECAST.ETS family: additive-error, additive-trend, additive-seasonality (AAA) exponential
// smoothing over an evenly spaced timeline, and the Timeline type the Forecast Sheet continues a
// timeline with.
// Translated from gridcraft crates/functions/src/ets.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Model (Hyndman, Koehler, Ord & Snyder, "Forecasting with Exponential Smoothing: The State Space
// Approach", 2008, ETS(A,A,A), component form):
//
//   yhat_t = l_{t-1} + b_{t-1} + s_{t-m}        e_t = y_t - yhat_t
//   l_t = l_{t-1} + b_{t-1} + alpha*e_t
//   b_t = b_{t-1} + alpha*beta*e_t
//   s_t = s_{t-m} + gamma*e_t
//
// Initial states follow the book's heuristic (section 2.6.1): seasonal indices from a classical
// decomposition (centred moving average) of the first seasons, level and trend from a straight line
// fitted to the first ten seasonally adjusted values. alpha, beta and gamma (each in [0, 1]) minimise
// the sum of squared one-step errors: a coarse grid, then a Nelder-Mead simplex clamped to the box.
// Excel does not document its optimiser, so fitted parameters (and the last digits of forecasts on
// noisy data) can differ from Excel's; exact data (straight lines, exactly repeating seasons)
// forecast exactly either way.
//
// Seasonality detection: the autocorrelation of the linearly detrended series; the highest local
// peak above the 95% white-noise bound (2/sqrt(n)) at a lag of at most n/2 (and at most 8,760).
//
// Prediction intervals use the model's h-step forecast variance (the book's Table 6.1, class 1):
// sigma^2 * (1 + sum_{j=1}^{h-1} (alpha + alpha*beta*j + gamma*[j mod m = 0])^2), sigma^2 = SSE / n,
// with the normal quantile.

import {CellError, ERR} from '../../lib/value.mjs';
import {D1900, datetimeFromSerial, daysInMonthIn, serialFromYmd} from '../../lib/date.mjs';
import {f, register, numVal, num, has, arg, asArray} from './registry.mjs';
import {normInv} from './special.mjs';

/** Longest timeline (after completing missing points) the functions accept. */
export const MAX_POINTS = 200_000;
/** Longest seasonality Excel supports (hours in a year). */
export const MAX_SEASON = 8_760;
/** Share of the timeline's points that may be missing. */
const MAX_MISSING = 0.3;
/** Seasonally adjusted values the initial level and trend are fitted to. */
const INIT_POINTS = 10;
const NM_ITERATIONS = 400;
/** Rust f64::round: half away from zero. */
const roundAway = x => (x < 0 ? -Math.round(-x) : Math.round(x));

// ---------------------------------------------------------------------------------------------
// Options

/** Seasonality: `{kind: 'detect'}`, `{kind: 'none'}` or `{kind: 'fixed', m}`. */
const DETECT = Object.freeze({kind: 'detect'});
const NONE = Object.freeze({kind: 'none'});
const AGGREGATES = Object.freeze(['average', 'count', 'counta', 'max', 'median', 'min', 'sum']);
export const defaultOptions = () => ({seasonality: DETECT, interpolate: true, aggregate: 'average'});
/** The options a formula's arguments mean, from their numbers (seasonality 1 detect, 0 none, 2-8,760 a length; fill 1 interpolate, 0 zeros; aggregate null or 2-7). */
export function optionsFromNumbers(seasonality, fill, aggregate) {
  return {
    seasonality: seasonality === 0 ? NONE : seasonality >= 2 ? {kind: 'fixed', m: seasonality} : DETECT,
    interpolate: fill !== 0,
    aggregate: aggregate >= 2 && aggregate <= 7 ? AGGREGATES[aggregate - 1] : 'average',
  };
}
/** The season length these options give a series (detected, none or fixed). */
export const seasonLength = (opts, y) => (opts.seasonality.kind === 'detect' ? detectSeason(y) : opts.seasonality.kind === 'none' ? 0 : opts.seasonality.m);

function whole(a, i) {
  if (!has(a, i)) return null;
  const v = num(a, i);
  if (!Number.isFinite(v)) throw ERR.Num;
  return Math.trunc(v);
}

/** `[seasonality]`: 1 (default) detects, 0 means none, 2-8,760 is the season length. */
export function seasonArg(a, i) {
  const v = whole(a, i);
  if (v === null || v === 1) return DETECT;
  if (v === 0) return NONE;
  if (v >= 2 && v <= MAX_SEASON) return {kind: 'fixed', m: v};
  throw ERR.Num;
}
/** `[data_completion]`: 1 (default) interpolates, 0 fills zeros. */
function completionArg(a, i) {
  const v = whole(a, i);
  if (v === null || v === 1) return true;
  if (v === 0) return false;
  throw ERR.Num;
}
/** `[aggregation]`: 0 or 1 AVERAGE (default), 2 COUNT, 3 COUNTA, 4 MAX, 5 MEDIAN, 6 MIN, 7 SUM. */
function aggregateArg(a, i) {
  const v = whole(a, i);
  if (v === null || v === 0 || v === 1) return 'average';
  if (v >= 2 && v <= 7) return AGGREGATES[v - 1];
  throw ERR.Num;
}

// ---------------------------------------------------------------------------------------------
// Timeline

/**
 * How timeline values map to point positions (0 = first point): `{linear: true, t0, step}` (a
 * constant numeric step) or `{linear: false, sys, month0, step, day}` (whole-day dates a constant
 * number of calendar months apart, all on the same day of the month (`day = d`) or all on the last
 * day of their month (`day = null`)).
 */
function axisPosition(axis, t) {
  if (axis.linear) return (t - axis.t0) / axis.step;
  const d = datetimeFromSerial(axis.sys, Math.floor(t));
  if (!d || d.day === 0) return null;
  const month = d.year * 12 + d.month - 1;
  const dim = daysInMonthIn(axis.sys, d.year, d.month);
  if (dim <= 0) return null;
  const anchor = axis.day === null ? dim : Math.min(axis.day, dim);
  const offset = (d.day - anchor + (t - Math.floor(t))) / dim;
  return ((month - axis.month0) + offset) / axis.step;
}

function gcd(a0, b0) {
  let a = a0, b = b0;
  while (b !== 0) { const r = a % b; a = b; b = r; }
  return Math.abs(a);
}

/** The axis of sorted, distinct time stamps: a constant step (missing points allowed) or, for dates, a constant number of calendar months. */
function detectAxis(times, sys) {
  if (times.length < 2) throw ERR.Num;
  const t0 = times[0];
  let step = Infinity;
  for (let i = 0; i + 1 < times.length; i++) step = Math.min(step, times[i + 1] - times[i]);
  if (Number.isFinite(step) && step > 0) {
    let even = true;
    for (let i = 0; i + 1 < times.length; i++) {
      const r = (times[i + 1] - times[i]) / step;
      if (Math.abs(r - roundAway(r)) > 1e-6) { even = false; break; }
    }
    if (even) return {linear: true, t0, step};
  }
  // Calendar months: whole days on one day of the month (or all month ends).
  const months = [];
  let sameDay = null, allSame = true, allEnd = true;
  for (const t of times) {
    if (t !== Math.trunc(t)) throw ERR.Num;
    const d = datetimeFromSerial(sys, t);
    if (!d || d.day === 0) throw ERR.Num;
    months.push(d.year * 12 + d.month - 1);
    if (sameDay === null) sameDay = d.day; else if (sameDay !== d.day) allSame = false;
    if (d.day !== daysInMonthIn(sys, d.year, d.month)) allEnd = false;
  }
  let day;
  if (allSame) day = sameDay; else if (allEnd) day = null; else throw ERR.Num;
  let g = 0;
  for (let i = 0; i + 1 < months.length; i++) {
    const d = months[i + 1] - months[i];
    if (d <= 0) throw ERR.Num;
    g = gcd(g, d);
  }
  const first = datetimeFromSerial(sys, Math.floor(t0));
  if (!first || first.day === 0) throw ERR.Num;
  if (g <= 0) throw ERR.Num;
  return {linear: false, sys, month0: first.year * 12 + first.month - 1, step: g, day};
}

/** Position of a time stamp relative to the last point (0 = last point, 1 = next step). */
export function horizon(series, t) {
  const p = axisPosition(series.axis, t);
  if (p === null) throw ERR.Num;
  const h = p - (series.y.length - 1);
  if (!Number.isFinite(h) || h < -1e-9) throw ERR.Num;
  return Math.max(h, 0);
}

function aggregate(kind, xs) {
  const n = xs.length;
  if (kind === 'count' || kind === 'counta') return n;
  if (!n) return null;
  switch (kind) {
    case 'average': { let s = 0; for (const x of xs) s += x; return s / n; }
    case 'sum': { let s = 0; for (const x of xs) s += x; return s; }
    case 'max': return xs.reduce((a, b) => (b > a ? b : a));
    case 'min': return xs.reduce((a, b) => (b < a ? b : a));
    default: {
      xs.sort((a, b) => a - b);
      const k = Math.trunc(n / 2), hi = xs[k];
      return n % 2 === 1 ? hi : (xs[k - 1] + hi) / 2;
    }
  }
}

/** Builds the series: pairs values with time stamps, sorts, aggregates duplicates, checks the step and completes missing points. */
export function series(values, timeline, opts, sys) {
  const va = asArray(values), ta = asArray(timeline);
  if (va.data.length !== ta.data.length) throw ERR.NA;
  if (va.data.length > MAX_POINTS) throw ERR.Num;
  const points = [];
  for (let i = 0; i < ta.data.length; i++) {
    const t = ta.data[i] ?? null, v = va.data[i] ?? null;
    if (t instanceof CellError) throw t;
    if (v instanceof CellError) throw v;
    let value;
    if (typeof v === 'number') value = v;
    else if (v === null) value = null;
    else throw ERR.Value;
    let time;
    if (typeof t === 'number' && Number.isFinite(t)) time = t;
    else if (t === null && value === null) continue; // A blank row (no time stamp, no value) is ignored.
    else throw ERR.Value;
    points.push([time, value]);
  }
  points.sort((a, b) => a[0] - b[0]);
  const times = [];
  for (const p of points) if (!times.length || times[times.length - 1] !== p[0]) times.push(p[0]);
  if (times.length < 2) throw ERR.Num;
  const axis = detectAxis(times, sys);
  const first = times[0], last = times[times.length - 1];
  const lastPos = axisPosition(axis, last);
  if (lastPos === null) throw ERR.Num;
  const span = roundAway(lastPos);
  if (!(span >= 1 && span < MAX_POINTS)) throw ERR.Num;
  const len = span + 1;
  // Group the (sorted) points by position.
  const slots = new Array(len).fill(null);
  let group = [], groupAt = null;
  const flush = () => { if (groupAt !== null && groupAt < slots.length) slots[groupAt] = aggregate(opts.aggregate, group); group = []; };
  for (const [t, v] of points) {
    const pos = axisPosition(axis, t);
    if (pos === null) throw ERR.Num;
    const p = roundAway(pos);
    if (!(p >= 0 && p < len)) throw ERR.Num;
    if (groupAt !== p) { flush(); groupAt = p; }
    if (v !== null) group.push(v);
  }
  flush();
  let known = 0;
  for (const s of slots) if (s !== null) known++;
  if (known === 0 || (len - known) > MAX_MISSING * len) throw ERR.Num;
  const y = opts.interpolate ? interpolate(slots) : slots.map(s => s ?? 0);
  const step = axis.linear ? axis.step : (last - first) / span;
  return {y, axis, step};
}

/** Missing points become the straight line between their known neighbours (the nearest known value at either end). */
export function interpolate(slots) {
  const out = [];
  const nextKnown = from => { for (let j = from; j < slots.length; j++) if (slots[j] !== null) return j; return -1; };
  let next = nextKnown(0);
  let prev = -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s !== null) { out.push(s); prev = i; next = nextKnown(i + 1); continue; }
    if (prev >= 0 && next >= 0) out.push(slots[prev] + (slots[next] - slots[prev]) * (i - prev) / (next - prev));
    else if (prev >= 0) out.push(slots[prev]);
    else if (next >= 0) out.push(slots[next]);
    else out.push(0);
  }
  return out;
}

/** A timeline's step, for continuing it past its last point (the Forecast Sheet's future rows). */
export class Timeline {
  constructor(axis, last) { this.axis = axis; this.last = last; }

  /**
   * The step of a set of time stamps (any order, duplicates allowed): a constant numeric step
   * (missing points allowed) or, for whole-day dates on one day of the month, calendar months. null
   * without at least two distinct, finite time stamps or without a constant step.
   */
  static detect(times, sys = D1900) {
    if (times.some(t => !Number.isFinite(t))) return null;
    const sorted = Float64Array.from(times).sort();
    const distinct = [];
    for (const t of sorted) if (!distinct.length || distinct[distinct.length - 1] !== t) distinct.push(t);
    let axis;
    try { axis = detectAxis(distinct, sys); } catch { return null; }
    const lastPos = axisPosition(axis, distinct[distinct.length - 1]);
    if (lastPos === null) return null;
    const last = roundAway(lastPos);
    // Like the functions, at most 30% of the points may be missing.
    if (!(last >= 0 && last < MAX_POINTS) || (last + 1 - distinct.length) > MAX_MISSING * (last + 1)) return null;
    return new Timeline(axis, last);
  }

  /** Steps from the last time stamp to `t` (fractional between steps, negative before it). */
  stepsAfterLast(t) {
    const p = axisPosition(this.axis, t);
    if (p === null) return null;
    const d = p - this.last;
    return Number.isFinite(d) ? d : null;
  }

  /** The time stamp `k` steps after the last one. */
  afterLast(k) {
    const pos = this.last + k;
    const a = this.axis;
    if (a.linear) {
      const t = a.t0 + pos * a.step;
      return Number.isFinite(t) ? t : null;
    }
    const month = a.month0 + pos * a.step;
    const y = Math.floor(month / 12), m = ((month % 12) + 12) % 12 + 1;
    if (!Number.isSafeInteger(y)) return null;
    const dim = daysInMonthIn(a.sys, y, m);
    const d = a.day === null ? dim : Math.min(a.day, dim);
    if (y < 1900) return null;
    return serialFromYmd(a.sys, y, m, d);
  }
}

// ---------------------------------------------------------------------------------------------
// Seasonality detection

/** (intercept, slope) of the least-squares line through the points (slope 0 for one point). */
function line(points) {
  let n = 0, sx = 0, sy = 0;
  for (const [x, y] of points) { n += 1; sx += x; sy += y; }
  if (n === 0) return [0, 0];
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of points) { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
  const b = sxx > 0 ? sxy / sxx : 0;
  return [my - b * mx, b];
}

/** Residuals of the least-squares line through `y` (x = 0, 1, 2...). */
function detrend(y) {
  const [a, b] = line(y.map((v, i) => [i, v]));
  return y.map((v, i) => v - (a + b * i));
}

/** The detected season length, 0 when the series shows none. */
export function detectSeason(y) {
  const n = y.length;
  if (n < 4) return 0;
  const r = detrend(y);
  let variance = 0; for (const v of r) variance += v * v;
  let scale = 0; for (const v of y) scale += v * v;
  if (!(Number.isFinite(variance) && variance > 1e-20 * Math.max(scale, Number.MIN_VALUE))) return 0;
  const maxLag = Math.min(Math.floor(n / 2), MAX_SEASON);
  const acf = [];
  const top = Math.min(maxLag + 1, n - 1);
  for (let k = 0; k <= top; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += r[i + k] * r[i];
    acf.push(s / variance);
  }
  const bound = 2 / Math.sqrt(n);
  let best = 0, bestR = bound;
  for (let k = 2; k <= maxLag; k++) {
    const prev = acf[k - 1], here = acf[k];
    if (prev === undefined || here === undefined) break;
    const next = acf[k + 1] ?? -Infinity;
    if (here > prev && here >= next && here > bestR) { best = k; bestR = here; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Model

/** Initial states (Hyndman et al. 2008, section 2.6.1): {level, trend, season}. */
function initialStates(y, m) {
  const n = y.length;
  const season = new Array(m).fill(0);
  if (m >= 2) {
    if (n >= 2 * m) {
      // Classical decomposition of the first seasons: centred moving average as the trend.
      const len = Math.max(Math.min(n, 4 * m), 2 * m);
      const w = y.slice(0, len);
      const prefix = [0];
      let acc = 0;
      for (const v of w) { acc += v; prefix.push(acc); }
      const sum = (a, b) => (prefix[b] ?? 0) - (prefix[a] ?? 0);
      const h = Math.floor(m / 2);
      const totals = new Array(m).fill(0), counts = new Array(m).fill(0);
      for (let t = h; t < Math.max(w.length - h, 0); t++) {
        let ma;
        if (m % 2 === 1) ma = sum(t - h, t + h + 1) / m;
        else {
          const ends = (w[t - h] ?? 0) + (w[t + h] ?? 0);
          ma = (sum(t - h + 1, t + h) + ends / 2) / m;
        }
        totals[t % m] += w[t] - ma;
        counts[t % m] += 1;
      }
      for (let i = 0; i < m; i++) season[i] = counts[i] > 0 ? totals[i] / counts[i] : 0;
    } else {
      // Under two seasons: deviations from a straight line through the data.
      const r = detrend(y);
      const counts = new Array(m).fill(0);
      r.forEach((v, t) => { season[t % m] += v; counts[t % m] += 1; });
      for (let i = 0; i < m; i++) if (counts[i] > 0) season[i] /= counts[i];
    }
    let mean = 0; for (const s of season) mean += s;
    mean /= m;
    for (let i = 0; i < m; i++) season[i] -= mean;
  }
  const k = Math.min(n, INIT_POINTS);
  const adjusted = [];
  for (let t = 0; t < k; t++) adjusted.push([t + 1, y[t] - (m >= 2 ? (season[t % m] ?? 0) : 0)]);
  const [level, trend] = line(adjusted);
  return {level, trend, season};
}

/** Runs the filter over the data; `errors` collects the one-step errors when given. */
function filter(y, init, p, errors) {
  const [alpha, beta, gamma] = p;
  const m = init.season.length;
  let l = init.level, b = init.trend;
  const season = init.season.slice();
  let sse = 0;
  for (let t = 0; t < y.length; t++) {
    const idx = m > 0 ? t % m : -1;
    const s = idx >= 0 ? season[idx] : 0;
    const e = y[t] - (l + b + s);
    if (idx >= 0) season[idx] = s + gamma * e;
    l = l + b + alpha * e;
    b += alpha * beta * e;
    sse += e * e;
    if (errors) errors.push(e);
  }
  return {level: l, trend: b, season, sse};
}

function objective(y, init, p) {
  const sse = filter(y, init, p, null).sse;
  return Number.isFinite(sse) ? sse : Infinity;
}

const clamp01 = x => Math.min(1, Math.max(0, x));
const clampParams = (p, active) => [0, 1, 2].map(i => (i < active ? clamp01(p[i]) : 0));
const byValue = (a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

/** Minimises the SSE over the active parameters (alpha, beta and, with seasonality, gamma) in [0, 1]. */
function optimise(y, init) {
  const active = init.season.length === 0 ? 2 : 3;
  const fn = p => objective(y, init, clampParams(p, active));
  // Coarse grid.
  const GRID = [0.05, 0.25, 0.5, 0.75, 0.95];
  let best = [[0.5, 0.1, 0.1], Infinity];
  for (const a of GRID) for (const b of GRID) for (const g of (active === 3 ? GRID : GRID.slice(0, 1))) {
    const p = clampParams([a, b, g], active);
    const v = fn(p);
    if (v < best[1]) best = [p, v];
  }
  // Nelder-Mead from the best grid point, clamped to the box.
  let simplex = [best];
  for (let i = 0; i < active; i++) {
    const p = best[0].slice();
    p[i] = p[i] > 0.5 ? p[i] - 0.1 : p[i] + 0.1;
    const q = clampParams(p, active);
    simplex.push([q, fn(q)]);
  }
  const lerp = (a, b, t) => clampParams(a.map((x, i) => x + t * (b[i] - x)), active);
  for (let iter = 0; iter < NM_ITERATIONS; iter++) {
    simplex.sort(byValue);
    const lo = simplex[0], hi = simplex[simplex.length - 1];
    const second = simplex.length >= 2 ? simplex[simplex.length - 2][1] : hi[1];
    let size = 0;
    for (const s of simplex) { let d = 0; for (let i = 0; i < 3; i++) d = Math.max(d, Math.abs(s[0][i] - lo[0][i])); size = Math.max(size, d); }
    if (Math.abs(hi[1] - lo[1]) <= 1e-12 * Math.abs(lo[1]) + 1e-300 || size < 1e-7) break;
    const k = Math.max(simplex.length - 1, 1);
    const c = [0, 0, 0];
    for (let j = 0; j < simplex.length - 1; j++) for (let i = 0; i < 3; i++) c[i] += simplex[j][0][i] / k;
    const reflected = lerp(c, hi[0], -1);
    const fr = fn(reflected);
    let replace = null;
    if (fr < lo[1]) {
      const expanded = lerp(c, hi[0], -2);
      const fe = fn(expanded);
      replace = fe < fr ? [expanded, fe] : [reflected, fr];
    } else if (fr < second) replace = [reflected, fr];
    else {
      const contracted = lerp(c, hi[0], 0.5);
      const fc = fn(contracted);
      if (fc < hi[1]) replace = [contracted, fc];
    }
    if (replace) simplex[simplex.length - 1] = replace;
    else {
      for (let j = 1; j < simplex.length; j++) {
        const p = lerp(lo[0], simplex[j][0], 0.5);
        simplex[j] = [p, fn(p)];
      }
    }
  }
  simplex.sort(byValue);
  return clampParams(simplex.length ? simplex[0][0] : best[0], active);
}

/** A fitted model. */
export class Fit {
  constructor(alpha, beta, gamma, m, n, state, errors) {
    this.alpha = alpha; this.beta = beta; this.gamma = gamma; this.m = m; this.n = n; this.state = state; this.errors = errors;
  }

  at(k) {
    let s = 0;
    if (this.m > 0) {
      const x = (this.n - 1) + k;
      let r = x % this.m;
      if (r < 0) r += this.m;
      s = this.state.season[Math.trunc(r)] ?? 0;
    }
    return this.state.level + k * this.state.trend + s;
  }

  /** Point forecast `h` steps after the last point (fractional steps interpolate). */
  forecast(h) {
    const lo = Math.floor(h);
    const a = this.at(lo);
    return h === lo ? a : a + (h - lo) * (this.at(lo + 1) - a);
  }

  /** Standard deviation of the forecast error `h` steps ahead. */
  forecastSd(h) {
    const sigma2 = this.state.sse / Math.max(this.n, 1);
    const k = Math.max(Math.ceil(h), 1) - 1;
    const a = this.alpha, b = this.alpha * this.beta, g = this.gamma;
    // Sum_{j=1}^{k} (a + b*j)^2 + seasonal terms, in closed form.
    let sum = k * a * a + a * b * k * (k + 1) + b * b * k * (k + 1) * (2 * k + 1) / 6;
    if (this.m > 0) {
      const m = this.m;
      const q = Math.floor(k / m);
      sum += 2 * g * (q * a + b * m * q * (q + 1) / 2) + g * g * q;
    }
    return Math.sqrt(Math.max(sigma2 * (1 + sum), 0));
  }
}

export function fit(y, m0) {
  const m = m0 >= 2 ? m0 : 0;
  const init = initialStates(y, m);
  const p = optimise(y, init);
  const errors = [];
  const state = filter(y, init, p, errors);
  return new Fit(p[0], p[1], p[2], m, y.length, state, errors);
}

// ---------------------------------------------------------------------------------------------
// Worksheet functions

function prepare(a, ctx, values, timeline, opts) {
  const s = series(arg(a, values).value, arg(a, timeline).value, opts, ctx?.dateSystem?.() ?? D1900);
  let m;
  if (opts.seasonality.kind === 'detect') m = detectSeason(s.y);
  else if (opts.seasonality.kind === 'none') m = 0;
  else m = opts.seasonality.m;
  return {series: s, m};
}

function options(a, season, completion, aggregation) {
  return {
    seasonality: season === null ? DETECT : seasonArg(a, season),
    interpolate: completionArg(a, completion),
    aggregate: aggregateArg(a, aggregation),
  };
}

function forecastEts(a, c) {
  const target = num(a, 0);
  const opts = options(a, 3, 4, 5);
  const p = prepare(a, c, 1, 2, opts);
  const h = horizon(p.series, target);
  return numVal(fit(p.series.y, p.m).forecast(h));
}

function forecastEtsConfint(a, c) {
  const target = num(a, 0);
  const level = has(a, 3) ? num(a, 3) : 0.95;
  if (!(level > 0 && level < 1)) throw ERR.Num;
  const opts = options(a, 4, 5, 6);
  const p = prepare(a, c, 1, 2, opts);
  const h = horizon(p.series, target);
  const z = normInv((1 + level) / 2);
  return numVal(z * fit(p.series.y, p.m).forecastSd(h));
}

function forecastEtsSeasonality(a, c) {
  const opts = options(a, null, 2, 3);
  const p = prepare(a, c, 0, 1, opts);
  return numVal(p.m);
}

function forecastEtsStat(a, c) {
  const kind0 = num(a, 2);
  if (!Number.isFinite(kind0) || !(Math.trunc(kind0) >= 1 && Math.trunc(kind0) < 9)) throw ERR.Num;
  const kind = Math.trunc(kind0);
  const opts = options(a, 3, 4, 5);
  const p = prepare(a, c, 0, 1, opts);
  if (kind === 8) return numVal(p.series.step);
  const y = p.series.y;
  const ft = fit(y, p.m);
  const n = Math.max(ft.errors.length, 1);
  let mae = 0; for (const e of ft.errors) mae += Math.abs(e);
  mae /= n;
  switch (kind) {
    case 1: return numVal(ft.alpha);
    case 2: return numVal(ft.beta);
    case 3: return numVal(ft.gamma);
    case 4: {
      let d = 0, cnt = 0;
      for (let i = 0; i + 1 < y.length; i++) { d += Math.abs(y[i + 1] - y[i]); cnt++; }
      d /= Math.max(cnt, 1);
      if (d === 0) throw ERR.Div0;
      return numVal(mae / d);
    }
    case 5: {
      let sum = 0, cnt = 0;
      for (let i = 0; i < y.length && i < ft.errors.length; i++) {
        const v = y[i], e = ft.errors[i];
        const denom = (Math.abs(v) + Math.abs(v - e)) / 2;
        if (denom > 0) { sum += Math.abs(e) / denom; cnt++; }
      }
      return numVal(sum / Math.max(cnt, 1));
    }
    case 6: return numVal(mae);
    case 7: { let s = 0; for (const e of ft.errors) s += e * e; return numVal(Math.sqrt(s / n)); }
    default: throw ERR.Num;
  }
}

const S_ETS = [true, false, false, true, true, true, true];
const S_ETS_SEASON = [false, false, true, true];
const S_ETS_STAT = [false, false, true, true, true, true];

register([
  f('FORECAST.ETS', 3, 6, 'Statistical', S_ETS, 'FORECAST.ETS(target_date, values, timeline, [seasonality], [data_completion], [aggregation])', 'Forecasts a value by additive (AAA) exponential smoothing.', forecastEts),
  f('FORECAST.ETS.CONFINT', 3, 7, 'Statistical', S_ETS, 'FORECAST.ETS.CONFINT(target_date, values, timeline, [confidence_level], [seasonality], [data_completion], [aggregation])', 'Half-width of the confidence interval around a FORECAST.ETS value.', forecastEtsConfint),
  f('FORECAST.ETS.SEASONALITY', 2, 4, 'Statistical', S_ETS_SEASON, 'FORECAST.ETS.SEASONALITY(values, timeline, [data_completion], [aggregation])', 'Length of the repeating pattern detected in a time series.', forecastEtsSeasonality),
  f('FORECAST.ETS.STAT', 3, 6, 'Statistical', S_ETS_STAT, 'FORECAST.ETS.STAT(values, timeline, statistic_type, [seasonality], [data_completion], [aggregation])', 'A statistic of the FORECAST.ETS model: 1 alpha, 2 beta, 3 gamma, 4 MASE, 5 SMAPE, 6 MAE, 7 RMSE, 8 step size.', forecastEtsStat),
]);
