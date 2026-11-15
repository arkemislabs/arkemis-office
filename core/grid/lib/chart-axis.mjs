// Chart value-axis scaling ("nice numbers") and label formatting.
// Translated from gridcraft crates/chart/src/axis.rs (`Scale`, `nice_scale`, `Fmt`, `general_text`,
// `format_number`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {formatValue, parseFormat} from './numfmt.mjs';
import {numberToText} from './value.mjs';

/** Largest magnitude we plot; bigger values are clamped so ranges stay finite. */
export const MAX_ABS = 1e300;

export const clean = v => (Number.isFinite(v) ? Math.min(MAX_ABS, Math.max(-MAX_ABS, v)) : 0);

/** A linear axis scale: `min..max` with gridlines every `step`. */
export class Scale {
  constructor(min, max, step) { this.min = min; this.max = max; this.step = step; }
  /** Tick values from `min` to `max` (at most 51). */
  ticks() {
    const span = this.max - this.min;
    if (!(Number.isFinite(span) && Number.isFinite(this.step) && this.step > 0 && span > 0)) return [this.min];
    const n = Math.min(50, Math.max(1, Math.round(span / this.step)));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const v = this.min + i * this.step;
      const snapped = Math.round(v / this.step) * this.step;
      out.push(Math.abs(snapped) < this.step * 1e-9 ? 0 : snapped);
    }
    return out;
  }
  /** Position of `v` along the axis, 0 at `min`, 1 at `max` (clamped to a sane band). */
  frac(v) {
    const span = this.max - this.min;
    if (!(Number.isFinite(span) && span > 0 && Number.isFinite(v))) return 0;
    return Math.min(1.5, Math.max(-0.5, (v - this.min) / span));
  }
}

/**
 * Picks a "nice" scale (steps of 1, 2 or 5 x 10^n, 4-9 gridlines) covering `lo..hi`. `forceZero`
 * always includes 0 (columns, bars, areas); otherwise 0 is included when the data sits close to it.
 */
export function niceScale(lo0, hi0, forceZero) {
  let lo = clean(lo0), hi = clean(hi0);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (forceZero || (lo > 0 && lo < hi * 5 / 6) || lo === hi) lo = Math.min(lo, 0);
  if (forceZero || (hi < 0 && hi > lo * 5 / 6) || lo === hi) hi = Math.max(hi, 0);
  if (lo === hi) return new Scale(0, 1, 0.2);
  const range0 = hi - lo;
  if (hi > 0) hi += range0 * 0.05;
  if (lo < 0) lo -= range0 * 0.05;
  const range = hi - lo;
  if (!Number.isFinite(range) || range <= 0) return new Scale(0, 1, 0.2);
  const e = Math.floor(Math.log10(range / 8));
  let chosen = null;
  outer: for (const k of [e - 1, e, e + 1, e + 2]) {
    const p = 10 ** k;
    for (const m of [1, 2, 5]) {
      const s = m * p;
      if (!(Number.isFinite(s) && s > 0)) continue;
      const intervals = Math.ceil(hi / s - 1e-9) - Math.floor(lo / s + 1e-9);
      if (intervals <= 8) { chosen = s; break outer; }
    }
  }
  const step = chosen ?? range;
  let min = Math.floor(lo / step + 1e-9) * step;
  let max = Math.ceil(hi / step - 1e-9) * step;
  if (Math.abs(min) < step * 1e-9) min = 0;
  if (Math.abs(max) < step * 1e-9) max = 0;
  if (!(Number.isFinite(min) && Number.isFinite(max)) || max <= min) return new Scale(lo, hi, range);
  return new Scale(min, max, step);
}

/** Exact fixed scale (100% stacked axes). */
export const fixedScale = (min, max, step) => new Scale(min, max, step);

function generalText(v, step) {
  if (v === 0) return '0';
  if (step !== undefined && step !== null && Number.isFinite(step) && step > 0 && Math.abs(v) < 1e11 && Math.abs(v) >= 1e-9) {
    const d = Math.min(10, Math.max(0, -Math.floor(Math.log10(step))));
    const t = v.toFixed(d);
    return /^-?[0.]*$/.test(t) ? '0' : t;
  }
  return numberToText(v);
}

/** A number format prepared once and reused for many labels. */
export class Fmt {
  constructor(code) {
    const t = String(code ?? '').trim();
    this.general = t === '' || t.toLowerCase() === 'general';
    this.fmt = parseFormat(this.general ? 'General' : t);
  }
  /** Formats `v`; `step` (axis labels) fixes the decimals for General. */
  format(v0, step) {
    let v = clean(v0);
    if (step !== undefined && step !== null && step > 0 && Math.abs(v / step) < 1e-9) v = 0;
    if (this.general) return generalText(v, step);
    let t = formatValue(v, this.fmt).text;
    if ([...t].length > 40) t = [...t].slice(0, 40).join('');
    return t;
  }
}

/** Formats a number with a format code (General shows up to the precision implied by `step`). */
export const formatNumber = (v, code, step) => new Fmt(code).format(v, step);
