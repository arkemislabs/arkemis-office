// What people type into a cell (and numeric text in formulas).
// Translated from gridcraft crates/core/src/parse.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Recognises numbers with thousands separators, percentages, currency, scientific notation,
// fractions (`1 1/2`), dates (`3/4/2026`, `2026-03-04`, `4-Mar-2026`, `Mar 4, 2026`), times
// (`10:30`, `10:30:15 PM`) and date-times. Locale: en-US. No DOM, no Node built-ins.

import {D1900, MONTHS, serialFromYmd, timeFraction, daysInMonthIn, unixNowMs, civilFromDays} from './date.mjs';
import {parseError} from './value.mjs';

/** Rust `str::parse::<f64>` over the characters parse_plain allows. */
function rustF64(s) {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * Interprets typed cell input (not formulas): {value, format}. Text that isn't a number, date,
 * boolean or error stays text. A leading apostrophe forces text. `errorOf` maps error literals.
 */
export function parseInput(s, sys = D1900, errorOf = null) {
  if (s === '') return {value: null, format: null};
  if (s.startsWith("'")) return {value: s.slice(1), format: null};
  const t = s.trim();
  if (/^true$/i.test(t)) return {value: true, format: null};
  if (/^false$/i.test(t)) return {value: false, format: null};
  const err = (errorOf ?? parseError)(t);
  if (err) return {value: err, format: null};
  const r = parseNumeric(t, sys);
  if (r) return {value: r[0] === 0 ? 0 : r[0], format: r[1]};
  return {value: s, format: null};
}

/** Numeric text as arithmetic coerces it ("1,000", "50%", "$3", "1/2/2020", "10:00"); null otherwise. */
export const parseNumberText = s => parseNumberTextIn(s, D1900);
export function parseNumberTextIn(s, sys = D1900) {
  const r = parseNumeric(String(s).trim(), sys);
  return r ? r[0] : null;
}

/** Text Excel's "Number Stored as Text" check flags; the number or null. */
export function numberStoredAsText(s) {
  const t = String(s).trim();
  const inner = parenthesized(t);
  if (inner !== null) {
    const body = inner.startsWith('$') ? inner.slice(1).trimStart() : inner;
    if (/^[-+(]/.test(body)) return null;
    const r = parsePlain(inner);
    return r ? -r[0] : null;
  }
  const r = parsePlain(t);
  return r ? r[0] : null;
}

function parseNumeric(t, sys) {
  const inner = parenthesized(t);
  if (inner !== null) {
    const body = inner.startsWith('$') ? inner.slice(1).trimStart() : inner;
    if (/^[-+(]/.test(body)) return null;
    let r = parsePlain(inner);
    if (!r) { const f = parseFraction(inner); r = f === null ? null : [f, '# ?/?']; }
    return r ? [-r[0], r[1]] : null;
  }
  return parseUnparenthesised(t, sys);
}

function parseUnparenthesised(t, sys) {
  if (!t) return null;
  const plain = parsePlain(t);
  if (plain) return plain;
  const f = parseFraction(t);
  if (f !== null) return [f, '# ?/?'];
  return parseDatetime(t, sys);
}

/** The number inside accounting parentheses as plain text (`(5)` → `5`, `$(5)` → `$5`, `(5)%` → `5%`). */
function parenthesized(t) {
  let currency = '', rest = t;
  if (rest.startsWith('$')) { currency = '$'; rest = rest.slice(1).trimStart(); }
  if (!rest.startsWith('(')) return null;
  rest = rest.slice(1);
  let body, percent = '';
  if (rest.endsWith(')')) body = rest.slice(0, -1);
  else {
    if (!rest.endsWith('%')) return null;
    const r = rest.slice(0, -1).trimEnd();
    if (!r.endsWith(')')) return null;
    body = r.slice(0, -1);
    percent = '%';
  }
  return `${currency}${body.trim()}${percent}`;
}

/** Signs, currency, thousands separators, percent, exponent: [number, format|null] or null. */
function parsePlain(t) {
  let s = t, neg = false, currency = false, percent = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trimStart(); }
  else if (s.startsWith('+')) s = s.slice(1).trimStart();
  if (s.startsWith('$')) {
    currency = true;
    s = s.slice(1).trimStart();
    if (!neg && s.startsWith('-')) { neg = true; s = s.slice(1); }
  }
  if (s.endsWith('%')) { percent = true; s = s.slice(0, -1).trimEnd(); }
  if (!s || (currency && percent)) return null;
  const hasSep = s.includes(',');
  let digits;
  if (hasSep) {
    const dot = s.indexOf('.');
    const int = dot < 0 ? s : s.slice(0, dot), frac = dot < 0 ? null : s.slice(dot + 1);
    const groups = int.split(',');
    if (!groups[0] || groups[0].length > 3 || groups.slice(1).some(g => g.length !== 3)) return null;
    digits = groups.join('') + (frac !== null ? '.' + frac : '');
  } else digits = s;
  if (!/^[0-9.eE+-]*$/.test(digits)) return null;
  if (!/^[0-9.]/.test(digits)) return null;
  let n = rustF64(digits);
  if (n === null || !Number.isFinite(n)) return null;
  const sci = /[eE]/.test(digits);
  if (percent) n /= 100;
  if (neg) n = -n;
  const fmt = currency ? (digits.includes('.') ? '"$"#,##0.00' : '"$"#,##0')
    : percent ? (digits.includes('.') ? '0.00%' : '0%')
      : sci ? '0.00E+00'
        : hasSep ? (digits.includes('.') ? '#,##0.00' : '#,##0') : null;
  return [n, fmt];
}

/** A plain ASCII number: digits, optionally `.digits` when `frac`. */
function plainNumber(s, frac) {
  let int = s, dec = null;
  const i = s.indexOf('.');
  if (frac && i >= 0) { int = s.slice(0, i); dec = s.slice(i + 1); }
  const digits = x => x.length > 0 && /^[0-9]+$/.test(x);
  if (!digits(int) || (dec !== null && !digits(dec))) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `1 1/2`, `0 3/4` (a whole part is required, else it's a date). */
function parseFraction(t) {
  const sp = t.indexOf(' ');
  if (sp < 0) return null;
  const whole = t.slice(0, sp), frac = t.slice(sp + 1);
  const neg = whole.startsWith('-');
  const w = plainNumber(whole.replace(/^-+/, ''), false);
  if (w === null) return null;
  const f = frac.trim(), slash = f.indexOf('/');
  if (slash < 0) return null;
  const a = plainNumber(f.slice(0, slash), false), b = plainNumber(f.slice(slash + 1), false);
  if (a === null || b === null || b === 0 || !Number.isFinite(w)) return null;
  const v = w + a / b;
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

function monthFromName(s) {
  const l = s.toLowerCase();
  if (l.length < 3) return null;
  const i = MONTHS.findIndex(m => m.toLowerCase().startsWith(l));
  return i < 0 ? null : i + 1;
}

/** Time part: [fraction, hasSeconds, hasAmPm] or null. */
function parseTime(t0) {
  const t = t0.trim();
  const lower = t.toLowerCase();
  let body, ampm = null;
  if (lower.endsWith('am')) { body = lower.slice(0, -2).trim(); ampm = false; }
  else if (lower.endsWith('a')) { body = lower.slice(0, -1).trim(); ampm = false; }
  else if (lower.endsWith('pm')) { body = lower.slice(0, -2).trim(); ampm = true; }
  else if (lower.endsWith('p')) { body = lower.slice(0, -1).trim(); ampm = true; }
  else body = lower;
  const parts = body.split(':');
  if (parts.length === 1 && ampm === null) return null;
  if (parts.length > 3 || parts.some(p => !p || p.startsWith('+'))) return null;
  let h = plainNumber(parts[0], false);
  if (h === null) return null;
  const m = parts.length > 1 ? plainNumber(parts[1], false) : 0;
  if (m === null) return null;
  const s = parts.length > 2 ? plainNumber(parts[2], true) : 0;
  if (s === null) return null;
  if (m >= 60 || s >= 60 || h < 0 || m < 0 || s < 0) return null;
  if (ampm !== null) {
    if (!(h >= 0 && h <= 12)) return null;
    if (h === 12) h = 0;
    if (ampm) h += 12;
  } else if (h >= 10000) return null;
  return [timeFraction(h, m, s), parts.length === 3, ampm !== null];
}

const expandYear = (text, y) => (text.length <= 2 ? (y < 30 ? 2000 + y : 1900 + y) : y);

function parseDate(t0, sys) {
  const t = t0.trim().replace(/,+$/, '');
  const num = s => {
    const x = s.trim();
    if (!x || !/^[0-9]+$/.test(x)) return null;
    const n = Number(x);
    return Number.isSafeInteger(n) ? n : null;
  };
  const parts = t.split(/[/.-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map(p => p.trim());
    if (a.length === 4) {
      const y = num(a), m = num(b), d = num(c);
      if (y !== null && m !== null && d !== null) return valid(sys, y, m, d, 'yyyy-mm-dd');
    }
    { const m = num(a), d = num(b), y = num(c);
      if (m !== null && d !== null && y !== null) return valid(sys, expandYear(c, y), m, d, 'm/d/yyyy'); }
    { const d = num(a), m = monthFromName(b), y = num(c);
      if (d !== null && m !== null && y !== null) return valid(sys, expandYear(c, y), m, d, 'd-mmm-yy'); }
  }
  if (parts.length === 2) {
    const [a, b] = parts.map(p => p.trim());
    const m = num(a), d = num(b);
    if (m !== null && d !== null) {
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return valid(sys, currentYear(), m, d, 'd-mmm');
      if (m >= 1 && m <= 12 && b.length === 4) return valid(sys, d, m, 1, 'mmm-yy');
    }
    { const d2 = num(a), m2 = monthFromName(b);
      if (d2 !== null && m2 !== null) return valid(sys, currentYear(), m2, d2, 'd-mmm'); }
    { const m3 = monthFromName(a), y = num(b);
      if (m3 !== null && y !== null) return valid(sys, expandYear(b, y), m3, 1, 'mmm-yy'); }
  }
  const words = t.split(/[ ,]/).filter(Boolean);
  if (words.length === 3) {
    { const m = monthFromName(words[0]), d = num(words[1]), y = num(words[2]);
      if (m !== null && d !== null && y !== null) return valid(sys, expandYear(words[2], y), m, d, 'd-mmm-yy'); }
    { const d = num(words[0]), m = monthFromName(words[1]), y = num(words[2]);
      if (d !== null && m !== null && y !== null) return valid(sys, expandYear(words[2], y), m, d, 'd-mmm-yy'); }
  }
  return null;
}

function valid(sys, y, m, d, fmt) {
  if (!(m >= 1 && m <= 12) || d < 1 || y < 1900) return null;
  if (d > daysInMonthIn(sys, y, m)) return null;
  const s = serialFromYmd(sys, y, m, d);
  return s === null ? null : [s, fmt];
}

/** The year used for dates typed without one, from the clock. */
export function currentYear() {
  const ms = unixNowMs();
  return Number.isFinite(ms) ? civilFromDays(Math.floor(ms / 86_400_000))[0] : 2026;
}

function parseDatetime(t, sys) {
  const tm = parseTime(t);
  if (tm) {
    const [tf, secs, ampm] = tm;
    const f = tf >= 1 ? '[h]:mm:ss' : !secs && !ampm ? 'h:mm' : secs && !ampm ? 'h:mm:ss' : !secs && ampm ? 'h:mm AM/PM' : 'h:mm:ss AM/PM';
    return [tf, f];
  }
  const d = parseDate(t, sys);
  if (d) return d;
  for (let i = t.indexOf(' '); i >= 0; i = t.indexOf(' ', i + 1)) {
    const b = t.slice(i + 1);
    if (b.length > 36 || !/^[0-9]/.test(b) || !b.includes(':')) continue;
    const dd = parseDate(t.slice(0, i), sys), tt = parseTime(b);
    if (dd && tt) return [dd[0] + tt[0], 'm/d/yyyy h:mm'];
  }
  return null;
}
