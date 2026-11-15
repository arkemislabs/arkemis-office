// Number formats: Excel format codes (`#,##0.00;[Red](#,##0.00)`, dates, fractions, scientific…),
// the General display format and the TEXT() worksheet function. en-US only.
// Translated from gridcraft crates/numfmt/src/{lib.rs, parse.rs, render.rs, decimal.rs, builtin.rs}
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// formatValue(value, code|NumberFormat, dateSystem) → {text, color, fill, numeric}; `fill` is
// [char, index] (UTF-16 index into text) for a `*x` repeat. No DOM, no Node built-ins.

import {MONTHS, WEEKDAYS, datetimeFromSerial, maxSerial, D1900} from './date.mjs';
import {indexedColor} from './addr.mjs';
import {CellError, ERR, GArray} from './value.mjs';
import {parseNumberText} from './parse.mjs';

const GENERAL_WIDTH = 11;
const OVERFLOW = '########';
export const MAX_FORMAT_CODE_CHARS = 255;
const MAX_DECIMALS = 400;
const MAX_SECTIONS = 4;

// ---------------------------------------------------------------------------------------------
// Colours

const NAMED_COLORS = {black: [0, 0, 0], blue: [0, 0, 255], cyan: [0, 255, 255], green: [0, 255, 0], magenta: [255, 0, 255], red: [255, 0, 0], white: [255, 255, 255], yellow: [255, 255, 0]};
/** A format colour: {name} or {indexed}. rgb() gives [r, g, b] or null. */
export function formatColorRgb(c) {
  if (!c) return null;
  if (c.indexed !== undefined) return indexedColor(c.indexed);
  return NAMED_COLORS[c.name] ?? null;
}
function parseColor(lc) {
  if (NAMED_COLORS[lc]) return {name: lc};
  if (!lc.startsWith('color')) return null;
  const n = Number(lc.slice(5).trim());
  return Number.isInteger(n) && n >= 1 && n <= 56 ? {indexed: n} : null;
}

// ---------------------------------------------------------------------------------------------
// decimal.rs

/** Exact decimal digits of a positive finite double: [digit string without leading zeros, exponent of the first digit]. */
function exactDigits(a) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, a);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2;
  if (expBits === 0) e2 = -1074; else { mant |= 1n << 52n; e2 = expBits - 1075; }
  let digits, exp10;
  if (e2 >= 0) { digits = (mant << BigInt(e2)).toString(); exp10 = digits.length - 1; }
  else {
    const s = (mant * 5n ** BigInt(-e2)).toString();
    exp10 = s.length - 1 + e2;
    digits = s;
  }
  return [digits.replace(/0+$/, '') || '0', exp10];
}
function significantDigits(a, n) {
  if (n <= 101) {
    const s = a.toExponential(n - 1);
    const i = s.indexOf('e');
    return [s.slice(0, i).replace('.', '').split('').map(Number), Number(s.slice(i + 1))];
  }
  const [d, e] = exactDigits(a);
  return [d.padEnd(n, '0').slice(0, n).split('').map(Number), e];
}
function isExactTie(a) {
  const [d] = exactDigits(a);
  return d[15] === '5' && /^0*$/.test(d.slice(16));
}
/** 15 significant digits of a > 0, rounded half away from zero on the decimal value: [digits[15], exponent]. */
export function decimalDigits(a) {
  const digits = new Array(15).fill(0);
  if (!Number.isFinite(a) || a <= 0) return [digits, 0];
  const [d16, exp] = significantDigits(a, 16);
  for (let i = 0; i < 15; i++) digits[i] = d16[i];
  const d = d16[15] ?? 0;
  if (d <= 4) return [digits, exp];
  if (d === 5 && isExactTie(a)) return [digits, exp];
  if (d === 5) { const [d15, e15] = significantDigits(a, 15); return [d15.slice(0, 15), e15]; }
  let e = exp, carry = true;
  for (let i = 14; i >= 0; i--) { if (digits[i] === 9) digits[i] = 0; else { digits[i]++; carry = false; break; } }
  if (carry) { digits.fill(0); digits[0] = 1; e++; }
  return [digits, e];
}
/** Integer and fraction digit strings of digits×10^exp at `decimals` decimals (half away from zero). */
export function fixedFromDigits(digits, exp, decimals) {
  const dc = Math.min(decimals, MAX_DECIMALS);
  const keep = exp + dc + 1;
  let m;
  if (keep <= 0) m = keep === 0 && (digits[0] ?? 0) >= 5 ? [1] : [];
  else if (keep >= digits.length) { m = digits.slice(); while (m.length < keep) m.push(0); }
  else {
    m = digits.slice(0, keep);
    if ((digits[keep] ?? 0) >= 5) {
      let carry = true;
      for (let i = m.length - 1; i >= 0; i--) { if (m[i] === 9) m[i] = 0; else { m[i]++; carry = false; break; } }
      if (carry) m.unshift(1);
    }
  }
  let lead = 0;
  while (lead < m.length && m[lead] === 0) lead++;
  m = m.slice(lead);
  const toS = ds => ds.join('');
  let int, frac;
  if (m.length <= dc) { int = ''; frac = '0'.repeat(dc - m.length) + toS(m); }
  else { const split = m.length - dc; int = toS(m.slice(0, split)); frac = toS(m.slice(split)); }
  if (decimals > dc) frac += '0'.repeat(decimals - dc);
  return [int, frac];
}
export function fixed(a, decimals) {
  if (!Number.isFinite(a) || a <= 0) return ['', '0'.repeat(Math.min(decimals, MAX_DECIMALS * 4))];
  const [d, e] = decimalDigits(a);
  return fixedFromDigits(d, e, decimals);
}
/** The General format in at most `maxChars` characters, or null when it can't fit. */
export function formatGeneralFit(n, maxChars) {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return maxChars >= 1 ? '0' : null;
  const sign = n < 0 ? '-' : '';
  const [digits, x] = decimalDigits(Math.abs(n));
  const intLen = sign.length + Math.max(x, 0) + 1;
  if (x >= -4 && intLen <= maxChars) {
    const avail = maxChars - intLen;
    let decimals = avail >= 2 ? avail - 1 : 0;
    for (;;) {
      const [i, f0] = fixedFromDigits(digits, x, decimals);
      const f = f0.replace(/0+$/, '');
      if (!i && !f) break;
      const s = sign + (i || '0') + (f ? '.' + f : '');
      if ([...s].length <= maxChars) return s;
      if (decimals === 0) break;
      decimals--;
    }
  }
  for (let md = Math.min(maxChars, 14); md >= 0; md--) {
    let e = x;
    let [mi, mf] = fixedFromDigits(digits, 0, md);
    if (mi.length > 1) { e++; [mi, mf] = fixedFromDigits(digits, -1, md); }
    mf = mf.replace(/0+$/, '');
    const s = `${sign}${mi || '0'}${mf ? '.' + mf : ''}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
    if ([...s].length <= maxChars) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// builtin.rs

const BUILTINS = [
  [0, 'General'], [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'], [5, '"$"#,##0_);\\("$"#,##0\\)'], [6, '"$"#,##0_);[Red]\\("$"#,##0\\)'],
  [7, '"$"#,##0.00_);\\("$"#,##0.00\\)'], [8, '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)'], [9, '0%'], [10, '0.00%'], [11, '0.00E+00'], [12, '# ?/?'],
  [13, '# ??/??'], [14, 'm/d/yyyy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'],
  [21, 'h:mm:ss'], [22, 'm/d/yyyy h:mm'], [37, '#,##0 ;(#,##0)'], [38, '#,##0 ;[Red](#,##0)'], [39, '#,##0.00;(#,##0.00)'], [40, '#,##0.00;[Red](#,##0.00)'],
  [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'], [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'], [44, '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'],
  [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'], [48, '##0.0E+0'], [49, '@'],
];
export const builtinFormat = id => BUILTINS.find(([i]) => i === id)?.[1] ?? null;
export function builtinId(code) {
  const hit = BUILTINS.find(([, c]) => c === code);
  if (hit) return hit[0];
  const norm = s => s.replace(/\\/g, '').toLowerCase();
  return BUILTINS.find(([, c]) => norm(c) === norm(code))?.[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// parse.rs — tokens: {t:'lit', s} {t:'digit', c} {t:'point'} {t:'comma'} {t:'percent'}
// {t:'exp', upper, plus} {t:'slash'} {t:'denom', s} {t:'fill', c} {t:'at'} {t:'general'}
// {t:'date', p: 'year'|'month'|'minute'|'day'|'hour'|'second'|'subsec'|'eh'|'em'|'es'|'ampm'|'ap', n, a?, b?}

const isCalendar = d => d.p === 'year' || d.p === 'month' || d.p === 'day';
function literalText(t) {
  switch (t.t) {
    case 'lit': case 'denom': return t.s;
    case 'digit': return t.c;
    case 'point': return '.';
    case 'comma': return ',';
    case 'percent': return '%';
    case 'exp': return (t.upper ? 'E' : 'e') + (t.plus ? '+' : '-');
    case 'slash': return '/';
    default: return '';
  }
}
function pushLit(toks, s) {
  if (!s) return;
  const last = toks[toks.length - 1];
  if (last && last.t === 'lit') last.s += s; else toks.push({t: 'lit', s});
}
const isCurrencyChar = c => '$€£¥₹₩₽¢₪₫฿'.includes(c);

function splitSections(code) {
  const cs = [...code];
  let lastClose = -1;
  for (let k = cs.length - 1; k >= 0; k--) if (cs[k] === ']') { lastClose = k; break; }
  const out = [''];
  let quoted = false, escape = false, i = 0;
  while (i < cs.length) {
    const c = cs[i++];
    if (escape) { out[out.length - 1] += c; escape = false; continue; }
    if (c === '"') { quoted = !quoted; out[out.length - 1] += c; }
    else if ((c === '\\' || c === '_' || c === '*') && !quoted) { escape = true; out[out.length - 1] += c; }
    else if (c === '[' && !quoted && lastClose >= i) {
      out[out.length - 1] += c;
      while (i < cs.length) { const d = cs[i++]; out[out.length - 1] += d; if (d === ']') break; }
    } else if (c === ';' && !quoted) { if (out.length >= MAX_SECTIONS) break; out.push(''); }
    else out[out.length - 1] += c;
  }
  return out;
}
const startsWithCi = (cs, i, pat) => [...pat].every((p, k) => cs[i + k] !== undefined && cs[i + k].toLowerCase() === p.toLowerCase());
function parseCond(s0) {
  const s = s0.trim();
  let op, rest;
  if (s.startsWith('<=')) [op, rest] = ['le', s.slice(2)];
  else if (s.startsWith('>=')) [op, rest] = ['ge', s.slice(2)];
  else if (s.startsWith('<>')) [op, rest] = ['ne', s.slice(2)];
  else if (s.startsWith('<')) [op, rest] = ['lt', s.slice(1)];
  else if (s.startsWith('>')) [op, rest] = ['gt', s.slice(1)];
  else if (s.startsWith('=')) [op, rest] = ['eq', s.slice(1)];
  else return null;
  const r = rest.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(r)) return null;
  const value = Number(r);
  return Number.isFinite(value) ? {op, value} : null;
}
function condTest(c, v) {
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'ne': return v !== c.value;
    case 'lt': return v < c.value;
    case 'le': return v <= c.value;
    case 'gt': return v > c.value;
    default: return v >= c.value;
  }
}
function tokenize(src) {
  const cs = [...src];
  const raw = {toks: [], color: null, cond: null, currency: false};
  const toks = raw.toks;
  let lastClose = -1;
  for (let k = cs.length - 1; k >= 0; k--) if (cs[k] === ']') { lastClose = k; break; }
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (c === '"') {
      let s = '';
      i++;
      while (i < cs.length) { const d = cs[i++]; if (d === '"') break; s += d; }
      if ([...s].some(isCurrencyChar)) raw.currency = true;
      pushLit(toks, s);
      continue;
    }
    if (c === '\\') { const d = cs[i + 1]; if (d !== undefined) { if (isCurrencyChar(d)) raw.currency = true; pushLit(toks, d); } i += 2; continue; }
    if (c === '_') { if (cs[i + 1] !== undefined) pushLit(toks, ' '); i += 2; continue; }
    if (c === '*') { if (cs[i + 1] !== undefined) toks.push({t: 'fill', c: cs[i + 1]}); i += 2; continue; }
    if (c === '[') {
      let p = -1;
      if (lastClose > i) for (let k = i + 1; k < cs.length; k++) if (cs[k] === ']') { p = k - (i + 1); break; }
      if (p >= 0) { bracket(raw, cs.slice(i + 1, i + 1 + p).join('')); i += p + 2; }
      else { pushLit(toks, '['); i++; }
      continue;
    }
    if (c === '0' || c === '#' || c === '?') toks.push({t: 'digit', c});
    else if (c === '.') toks.push({t: 'point'});
    else if (c === ',') toks.push({t: 'comma'});
    else if (c === '%') toks.push({t: 'percent'});
    else if (c === '@') toks.push({t: 'at'});
    else if (c === '/') {
      toks.push({t: 'slash'});
      i++;
      if (cs[i] >= '1' && cs[i] <= '9') {
        let s = '';
        while (i < cs.length && cs[i] >= '0' && cs[i] <= '9') s += cs[i++];
        toks.push({t: 'denom', s});
      }
      continue;
    } else if ((c === 'e' || c === 'E') && (cs[i + 1] === '+' || cs[i + 1] === '-')) {
      toks.push({t: 'exp', upper: c === 'E', plus: cs[i + 1] === '+'});
      i += 2;
      continue;
    } else if ((c === 'G' || c === 'g') && startsWithCi(cs, i, 'general')) { toks.push({t: 'general'}); i += 7; continue; }
    else if ((c === 'A' || c === 'a') && startsWithCi(cs, i, 'am/pm')) { toks.push({t: 'date', p: 'ampm'}); i += 5; continue; }
    else if ((c === 'A' || c === 'a') && startsWithCi(cs, i, 'a/p')) { toks.push({t: 'date', p: 'ap', a: c, b: cs[i + 2] ?? 'P'}); i += 3; continue; }
    else if ('yYmMdDhHsSeE'.includes(c)) {
      const lc = c.toLowerCase();
      let n = 0;
      while (cs[i + n] !== undefined && cs[i + n].toLowerCase() === lc) n++;
      const n8 = Math.min(n, 255);
      const p = lc === 'y' ? 'year' : lc === 'e' ? 'year' : lc === 'm' ? 'month' : lc === 'd' ? 'day' : lc === 'h' ? 'hour' : 'second';
      toks.push({t: 'date', p, n: lc === 'e' ? 4 : n8});
      i += Math.max(n, 1);
      continue;
    } else {
      if (isCurrencyChar(c)) raw.currency = true;
      pushLit(toks, c);
    }
    i++;
  }
  return raw;
}
function bracket(raw, content) {
  const lc = content.trim().toLowerCase();
  const color = parseColor(lc);
  if (color) { raw.color = color; return; }
  if (/^[<>=]/.test(lc)) { const c = parseCond(lc); if (c) raw.cond = c; return; }
  if (content.startsWith('$')) {
    const sym = content.slice(1).split('-')[0];
    if (sym) { raw.currency = true; pushLit(raw.toks, sym); }
    return;
  }
  const first = lc[0];
  if ((first === 'h' || first === 'm' || first === 's') && [...lc].every(ch => ch === first)) {
    raw.toks.push({t: 'date', p: first === 'h' ? 'eh' : first === 'm' ? 'em' : 'es', n: Math.min([...lc].length, 255)});
  }
}
function analyze(raw) {
  const {toks} = raw;
  const sec = {toks: [], color: raw.color, cond: raw.cond, kind: 'number', thousands: false, scale: 0, percent: 0,
    hasAt: toks.some(t => t.t === 'at'), hasDigits: false, exp: false, fraction: false, currency: raw.currency, fill: toks.some(t => t.t === 'fill')};
  if (toks.some(t => t.t === 'date')) { sec.kind = 'date'; return analyzeDate(toks, sec); }
  if (toks.some(t => t.t === 'general')) { sec.kind = 'general'; return analyzeKeep(toks, sec, ['general', 'fill']); }
  sec.hasDigits = toks.some(t => t.t === 'digit');
  if (sec.hasAt && !sec.hasDigits) { sec.kind = 'text'; return analyzeKeep(toks, sec, ['at', 'fill']); }
  return analyzeNumber(toks, sec);
}
function analyzeDate(toks, sec) {
  const datePart = t => (t.t === 'date' ? t : null);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!(t.t === 'date' && t.p === 'month' && t.n <= 2)) continue;
    let prev = null; for (let k = i - 1; k >= 0; k--) { prev = datePart(toks[k]); if (prev) break; }
    let next = null; for (let k = i + 1; k < toks.length; k++) { next = datePart(toks[k]); if (next) break; }
    const afterH = prev && (prev.p === 'hour' || prev.p === 'eh');
    const beforeS = next && (next.p === 'second' || next.p === 'es');
    if (afterH || beforeS) toks[i] = {t: 'date', p: 'minute', n: t.n};
  }
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.t === 'point' && toks[i + 1]?.t === 'digit' && toks[i + 1].c === '0') {
      let n = 0;
      while (toks[i + 1 + n]?.t === 'digit' && toks[i + 1 + n].c === '0') n++;
      out.push({t: 'date', p: 'subsec', n: Math.min(n, 255)});
      i += 1 + n;
      continue;
    }
    if (t.t === 'date' || t.t === 'fill') out.push(t); else pushLit(out, literalText(t));
    i++;
  }
  sec.toks = out;
  return sec;
}
function analyzeKeep(toks, sec, keep) {
  const out = [];
  for (const t of toks) { if (keep.includes(t.t)) out.push(t); else pushLit(out, literalText(t)); }
  sec.toks = out;
  return sec;
}
function analyzeNumber(toks0, sec) {
  const toks = toks0.map(t => ({...t}));
  let seenPoint = false, seenExp = false, seenDigit = false, fractionSlash = false;
  const digitAfterCommas = new Array(toks.length).fill(false);
  let after = false;
  for (let j = toks.length - 1; j >= 0; j--) { digitAfterCommas[j] = after; if (toks[j].t !== 'comma') after = toks[j].t === 'digit'; }
  let lastExp = -1;
  for (let k = toks.length - 1; k >= 0; k--) if (toks[k].t === 'exp') { lastExp = k; break; }
  const firstDigit = toks.findIndex(t => t.t === 'digit');
  const scientific = firstDigit >= 0 && toks.slice(firstDigit).some(t => t.t === 'exp');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let replace = null;
    switch (t.t) {
      case 'digit': seenDigit = true; break;
      case 'point': if (seenPoint || seenExp) replace = {t: 'lit', s: '.'}; else seenPoint = true; break;
      case 'percent': sec.percent++; break;
      case 'exp': if (seenExp || !seenDigit) replace = {t: 'lit', s: literalText(t)}; else { seenExp = true; sec.exp = true; } break;
      case 'comma': {
        const nextDigit = digitAfterCommas[i];
        if (seenDigit && nextDigit && !seenPoint && !seenExp) { sec.thousands = true; replace = {t: 'lit', s: ''}; }
        else if (seenDigit && scientific) replace = {t: 'lit', s: ''};
        else if (seenDigit && !nextDigit) { sec.scale++; replace = {t: 'lit', s: ''}; }
        else replace = {t: 'lit', s: ','};
        break;
      }
      case 'slash': {
        const nx = toks.slice(i + 1).find(x => x.t !== 'lit');
        const nextOk = toks[i + 1]?.t === 'denom' || nx?.t === 'digit';
        const hasExp = seenExp || lastExp > i;
        if (!fractionSlash && seenDigit && nextOk && !seenPoint && !hasExp) { fractionSlash = true; sec.fraction = true; }
        else replace = {t: 'lit', s: '/'};
        break;
      }
      case 'denom': if (!(toks[i - 1]?.t === 'slash' && sec.fraction)) replace = {t: 'lit', s: t.s}; break;
      default: break;
    }
    if (replace) toks[i] = replace;
  }
  if (sec.fraction) for (let i = 0; i < toks.length; i++) if (toks[i].t === 'point') toks[i] = {t: 'lit', s: '.'};
  const out = [];
  for (const t of toks) { if (t.t === 'lit') pushLit(out, t.s); else out.push(t); }
  sec.toks = out;
  return sec;
}
const parseSections = code => splitSections(code).map(s => analyze(tokenize(s)));

// ---------------------------------------------------------------------------------------------
// render.rs

class Out {
  constructor() { this.text = ''; this.fill = null; this.zero = false; }
  push(s) { this.text += s; }
  setFill(c) { if (!this.fill) this.fill = [c, this.text.length]; }
  prepend(s) { this.text = s + this.text; if (this.fill) this.fill = [this.fill[0], this.fill[1] + s.length]; }
}
function renderText(sec, text) {
  const out = new Out();
  for (const t of sec.toks) { if (t.t === 'at') out.push(text); else if (t.t === 'fill') out.setFill(t.c); else out.push(literalText(t)); }
  return out;
}
function renderGeneral(sec, v, width) {
  const out = new Out();
  for (const t of sec.toks) {
    if (t.t === 'general') out.push(formatGeneralFit(v, width) ?? '#'.repeat(Math.min(11, Math.max(1, width))));
    else if (t.t === 'fill') out.setFill(t.c);
    else out.push(literalText(t));
  }
  return out;
}
function renderDate(sec, v, sys) {
  if (!Number.isFinite(v) || !(v >= 0 && v < maxSerial(sys) + 1)) return null;
  let sub = 0;
  for (const t of sec.toks) if (t.t === 'date' && t.p === 'subsec') sub = Math.max(sub, t.n);
  sub = Math.min(sub, 3);
  const unit = 10 ** (3 - sub);
  let day = Math.floor(v);
  let ms = Math.round(((v - Math.floor(v)) * 86_400_000) / unit) * unit;
  if (ms >= 86_400_000) { ms -= 86_400_000; day++; }
  const totalMs = day * 86_400_000 + ms;
  const needsDate = sec.toks.some(t => t.t === 'date' && isCalendar(t));
  let dt;
  if (needsDate) { dt = datetimeFromSerial(sys, day); if (!dt) return null; }
  else dt = datetimeFromSerial(sys, 0) ?? {year: 1900, month: 1, day: 0, weekday: 0};
  const ampm = sec.toks.some(t => t.t === 'date' && (t.p === 'ampm' || t.p === 'ap'));
  const hour = Math.floor(ms / 3_600_000), minute = Math.floor(ms / 60_000) % 60, second = Math.floor(ms / 1000) % 60, milli = ms % 1000;
  const pad = (n, w) => (w >= 2 ? String(n).padStart(Math.min(w, 20), '0') : String(n));
  const monthName = MONTHS[dt.month - 1] ?? '', dayName = WEEKDAYS[dt.weekday] ?? '';
  const out = new Out();
  for (const t of sec.toks) {
    if (t.t === 'date') {
      let s;
      switch (t.p) {
        case 'year': s = t.n <= 2 ? String(((dt.year % 100) + 100) % 100).padStart(2, '0') : String(dt.year).padStart(4, '0'); break;
        case 'month': s = t.n === 1 || t.n === 2 ? pad(dt.month, t.n) : t.n === 3 ? monthName.slice(0, 3) : t.n === 5 ? monthName.slice(0, 1) : monthName; break;
        case 'day': s = t.n === 1 || t.n === 2 ? pad(dt.day, t.n) : t.n === 3 ? dayName.slice(0, 3) : dayName; break;
        case 'hour': s = pad(ampm ? (hour % 12 || 12) : hour, t.n); break;
        case 'minute': s = pad(minute, t.n); break;
        case 'second': s = pad(second, t.n); break;
        case 'subsec': s = ('.' + String(milli).padStart(3, '0')).slice(0, 1 + Math.min(t.n, 3)) + (t.n > 3 ? '0'.repeat(t.n - 3) : ''); break;
        case 'eh': s = pad(Math.floor(totalMs / 3_600_000), t.n); break;
        case 'em': s = pad(Math.floor(totalMs / 60_000), t.n); break;
        case 'es': s = pad(Math.floor(totalMs / 1000), t.n); break;
        case 'ampm': s = hour >= 12 ? 'PM' : 'AM'; break;
        default: s = hour >= 12 ? t.b : t.a;
      }
      out.push(s);
    } else if (t.t === 'fill') out.setFill(t.c);
    else out.push(literalText(t));
  }
  return out;
}
function fillInt(toks, idxs, digits, thousands, forceZero, pieces) {
  const ds = [...digits];
  let rem = ds.length, pos = 0;
  const count = idxs.length;
  for (let k = 0; k < count; k++) {
    const ti = idxs[count - 1 - k];
    const leftmost = k + 1 === count;
    const ph = toks[ti]?.t === 'digit' ? toks[ti].c : '0';
    let rev = '';
    const pushDigit = c => { if (thousands && pos > 0 && pos % 3 === 0) rev += ','; rev += c; pos++; };
    const take = leftmost ? rem : Math.min(rem, 1);
    if (take === 0) {
      if (ph === '0') pushDigit('0');
      else if (forceZero && k === 0) pushDigit('0');
      else if (ph === '?') { if (thousands && pos > 0 && pos % 3 === 0) rev += ' '; rev += ' '; pos++; }
    } else for (let n = 0; n < take; n++) { rem--; pushDigit(ds[rem] ?? '0'); }
    pieces[ti] = [...rev].reverse().join('');
  }
}
function withCommas(digits, thousands) {
  if (!thousands) return digits;
  const cs = [...digits], n = cs.length;
  return cs.map((c, i) => (i > 0 && (n - i) % 3 === 0 ? ',' : '') + c).join('');
}
function fillFrac(toks, idxs, frac, pieces) {
  const fd = [...frac];
  let lastSig = -1;
  for (let k = fd.length - 1; k >= 0; k--) if (fd[k] !== '0') { lastSig = k; break; }
  idxs.forEach((ti, i) => {
    const ph = toks[ti]?.t === 'digit' ? toks[ti].c : '0';
    pieces[ti] = lastSig >= 0 && i <= lastSig ? fd[i] ?? '0' : ph === '0' ? '0' : ph === '?' ? ' ' : '';
  });
}
const digitIndices = (toks, from, to) => { const r = []; for (let i = from; i < to; i++) if (toks[i]?.t === 'digit') r.push(i); return r; };
function renderNumber(sec, v) {
  let x = Math.abs(v);
  if (sec.percent > 0 && !sec.exp) x *= 100 ** Math.min(sec.percent, 20);
  if (sec.scale > 0) x /= 1000 ** Math.min(sec.scale, 110);
  if (!Number.isFinite(x)) x = Number.MAX_VALUE;
  const toks = sec.toks, n = toks.length;
  const pieces = new Array(n).fill(''), before = new Array(n + 1).fill('');
  let lits = [], zero = false;
  if (sec.fraction) { lits = new Array(n).fill(null); renderFraction(sec, x, pieces, lits); }
  else {
    const point = toks.findIndex(t => t.t === 'point'), exp = toks.findIndex(t => t.t === 'exp');
    const intEnd = point >= 0 ? point : exp >= 0 ? exp : n, fracEnd = exp >= 0 ? exp : n;
    const intIdx = digitIndices(toks, 0, intEnd), fracIdx = point >= 0 ? digitIndices(toks, point + 1, fracEnd) : [];
    let intS, fracS;
    if (exp >= 0) {
      const expIdx = digitIndices(toks, exp + 1, n);
      const step = Math.max(intIdx.length, 1);
      let e;
      if (x === 0) { e = 0; intS = '0'.repeat(intIdx.length); fracS = '0'.repeat(fracIdx.length); }
      else {
        const [digits, xe] = decimalDigits(x);
        e = xe - (((xe % step) + step) % step);
        [intS, fracS] = fixedFromDigits(digits, xe - e, fracIdx.length);
        if (intS.length > step) { e += step; [intS, fracS] = fixedFromDigits(digits, xe - e, fracIdx.length); }
      }
      const {upper = true, plus = true} = toks[exp];
      if (!intS && /^0*$/.test(fracS)) e = 0;
      const head = upper ? 'E' : 'e', sign = e < 0 ? '-' : plus ? '+' : '', digitsS = String(Math.abs(e));
      if (expIdx.length) { pieces[exp] = head; before[expIdx[0]] = sign; fillInt(toks, expIdx, digitsS, false, false, pieces); }
      else pieces[exp] = head + sign + digitsS;
    } else [intS, fracS] = fixed(x, fracIdx.length);
    zero = /^0*$/.test(intS + fracS);
    fillInt(toks, intIdx, intS, sec.thousands, false, pieces);
    if (!intIdx.length && intS) { const p = point >= 0 ? point : exp; if (p >= 0) before[p] = withCommas(intS, sec.thousands); }
    fillFrac(toks, fracIdx, fracS, pieces);
    if (point >= 0) pieces[point] = '.';
  }
  const out = new Out();
  toks.forEach((t, i) => {
    out.push(before[i]);
    if (t.t === 'lit') out.push(lits[i] ?? t.s);
    else if (t.t === 'percent') out.push('%');
    else if (t.t === 'fill') out.setFill(t.c);
    else if (!['at', 'general', 'date', 'comma'].includes(t.t)) out.push(pieces[i] ?? '');
  });
  out.zero = zero;
  return out;
}
function approximate(x, maxDen) {
  if (Number.isNaN(x) || x <= 0 || !Number.isFinite(x)) return [0, 1];
  if (x >= 1e15) return [Math.round(x), 1];
  let p0 = 0, q0 = 1, p1 = 1, q1 = 0, r = x;
  for (let k = 0; k < 64; k++) {
    const aF = Math.floor(r);
    if (aF > 1e15) break;
    const q2 = aF * q1 + q0;
    if (q2 > maxDen) break;
    const p2 = aF * p1 + p0;
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    const frac = r - aF;
    if (frac < 1e-12) break;
    r = 1 / frac;
  }
  if (q1 === 0) return [Math.round(x), 1];
  const k = Math.floor((maxDen - q0) / q1);
  const pb = p0 + k * p1, qb = q0 + k * q1;
  const errA = Math.abs(p1 / q1 - x), errB = qb > 0 ? Math.abs(pb / qb - x) : Infinity;
  return errB < errA ? [pb, qb] : [p1, q1];
}
const shownWidth = t => (t.t === 'lit' || t.t === 'denom' ? [...t.s].length : t.t === 'digit' || t.t === 'slash' ? 1 : 0);
function blankRange(toks, from, to, spaces, pieces, lits) {
  for (let i = from; i < to && i < toks.length; i++) {
    const t = toks[i], s = spaces ? ' '.repeat(shownWidth(t)) : '';
    if (t.t === 'lit') lits[i] = s;
    else if (t.t === 'digit' || t.t === 'slash' || t.t === 'denom') pieces[i] = s;
  }
}
function renderFraction(sec, x, pieces, lits) {
  const toks = sec.toks;
  const isDigit = i => toks[i]?.t === 'digit';
  const slash = toks.findIndex(t => t.t === 'slash');
  if (slash < 0) return;
  let numLast = -1;
  for (let i = slash - 1; i >= 0; i--) if (isDigit(i)) { numLast = i; break; }
  if (numLast < 0) return;
  let numStart = numLast;
  while (numStart > 0 && isDigit(numStart - 1)) numStart--;
  const wholeIdx = digitIndices(toks, 0, numStart), numIdx = digitIndices(toks, numStart, numLast + 1);
  const sepStart = wholeIdx.length ? wholeIdx[wholeIdx.length - 1] + 1 : numStart;
  let fixedDen = null, denStart;
  if (toks[slash + 1]?.t === 'denom') { const d = Number(toks[slash + 1].s); fixedDen = Math.min(1_000_000_000, Math.max(1, Number.isFinite(d) ? d : 1_000_000_000)); denStart = slash + 1; }
  else { let i = slash + 1; while (toks[i]?.t === 'lit') i++; denStart = i; }
  let denEnd = denStart;
  if (fixedDen !== null) denEnd++; else while (isDigit(denEnd)) denEnd++;
  const denIdx = digitIndices(toks, denStart, denEnd);
  const hasQ = idx => idx.some(i => toks[i]?.t === 'digit' && toks[i].c === '?');
  const hasWhole = wholeIdx.length > 0;
  let whole = hasWhole ? Math.floor(x) : 0;
  const fr = hasWhole ? x - Math.floor(x) : x;
  let num, den;
  if (fixedDen !== null) { num = Math.round(fr * fixedDen); den = fixedDen; }
  else if (fr >= 1e15) { num = Math.round(fr); den = 1; }
  else { const digits = Math.min(7, Math.max(1, denIdx.length)); [num, den] = approximate(fr, 10 ** digits - 1); }
  if (hasWhole && num >= den && den > 0) { whole += Math.floor(num / den); num %= den; }
  const wholeS = whole >= 1 ? fixed(whole, 0)[0] : '';
  const numZeroPh = numIdx.some(i => toks[i]?.c === '0');
  if (hasWhole && num === 0 && !numZeroPh) {
    fillInt(toks, wholeIdx, wholeS, sec.thousands, true, pieces);
    blankRange(toks, sepStart, denEnd, hasQ(wholeIdx) || hasQ(numIdx) || hasQ(denIdx), pieces, lits);
    return;
  }
  if (hasWhole) {
    const unitsHash = toks[wholeIdx[wholeIdx.length - 1]]?.c === '#';
    fillInt(toks, wholeIdx, wholeS, sec.thousands, !wholeS && num === 0 && !unitsHash, pieces);
    const wholeShown = wholeIdx.some(i => /[0-9]/.test(pieces[i] ?? ''));
    if (!wholeShown) blankRange(toks, sepStart, numStart, hasQ(wholeIdx) || hasQ(numIdx), pieces, lits);
  }
  fillInt(toks, numIdx, num < 1e15 ? String(Math.trunc(num)) : fixed(num, 0)[0], false, true, pieces);
  pieces[slash] = '/';
  const denS = String(den);
  if (fixedDen !== null) pieces[denStart] = denS;
  else {
    const zeros = denIdx.filter(i => toks[i]?.c === '0').length;
    const dc = [...('0'.repeat(Math.max(0, zeros - denS.length)) + denS)];
    denIdx.forEach((ti, k) => {
      let s = k + 1 === denIdx.length ? dc.slice(k).join('') : dc[k] ?? '';
      if (!s) s = toks[ti]?.c === '?' ? ' ' : toks[ti]?.c === '0' ? '0' : '';
      pieces[ti] = s;
    });
  }
}

// ---------------------------------------------------------------------------------------------
// lib.rs

const tooLong = code => code.length > MAX_FORMAT_CODE_CHARS && [...code].length > MAX_FORMAT_CODE_CHARS;

export class NumberFormat {
  constructor(code, general, sections, numSections, textSection) {
    this.code = code; this.general = general; this.sections = sections; this.numSections = numSections; this.textSection = textSection;
  }
  static parse(code) {
    const trimmed = String(code).trim();
    if (!trimmed || /^general$/i.test(trimmed) || trimmed === 'checkbox' || tooLong(code)) return new NumberFormat(code, true, [], 0, null);
    const sections = parseSections(code);
    const len = sections.length, lastIsText = len > 0 && sections[len - 1].kind === 'text';
    const textSection = len >= 4 ? 3 : lastIsText ? len - 1 : null;
    const numSections = len >= 4 ? 3 : lastIsText ? len - 1 : len;
    return new NumberFormat(code, false, sections, numSections, textSection);
  }
  get num() { return this.sections.slice(0, this.numSections); }
  isGeneral() { return this.general; }
  isDate() { return this.num.some(s => s.kind === 'date'); }
  isPercent() { return this.num.some(s => s.kind === 'number' && s.percent > 0); }
  isText() { return this.numSections === 0 && this.textSection !== null; }
  /** General | Number | Currency | Accounting | Date | Time | Percentage | Fraction | Scientific | Text | Special | Custom */
  kind() {
    if (this.general) return 'General';
    if (this.isText()) return 'Text';
    if (['00000', '00000-0000', '[<=9999999]###-####;(###) ###-####', '000-00-0000'].includes(this.code)) return 'Special';
    const s = this.sections[0];
    if (!s) return 'Custom';
    if (s.kind === 'general') return 'General';
    if (s.kind === 'text') return 'Text';
    if (s.kind === 'date') return s.toks.some(t => t.t === 'date' && isCalendar(t)) ? 'Date' : 'Time';
    if (s.fraction) return 'Fraction';
    if (s.exp) return 'Scientific';
    if (s.percent > 0) return 'Percentage';
    if (s.fill && s.hasDigits) return 'Accounting';
    if (s.currency && s.hasDigits) return 'Currency';
    if (s.hasDigits) return 'Number';
    return 'Custom';
  }
  select(v) {
    const secs = this.num, k = secs.length;
    const s0 = secs[0];
    if (!s0) return null;
    const c0 = s0.cond, c1 = secs[1]?.cond ?? null;
    if (c0 || c1) {
      const idx = c0 && condTest(c0, v) ? 0 : c1 && condTest(c1, v) ? 1 : c0 && c1 ? 2 : !c0 ? 0 : 1;
      return secs[idx] ? [secs[idx], k >= 2] : null;
    }
    if (v < 0 && k >= 2) return [secs[1], true];
    if (v === 0 && k >= 3) return [secs[2], false];
    return [s0, false];
  }
  formatNumber(n, sys) {
    const general = x => ({text: formatGeneralFit(x, GENERAL_WIDTH) ?? OVERFLOW, color: null, fill: null, numeric: true});
    if (this.general) return [general(n), false];
    const sel = this.select(n);
    if (!sel) return [general(n), false];
    const [sec, dropSign] = sel;
    const minus = n < 0 && !dropSign;
    let out;
    switch (sec.kind) {
      case 'text': out = renderText(sec, formatGeneralFit(n, GENERAL_WIDTH) ?? ''); break;
      case 'general': out = renderGeneral(sec, Math.abs(n), minus ? GENERAL_WIDTH - 1 : GENERAL_WIDTH); break;
      case 'date': out = minus ? null : renderDate(sec, Math.abs(n), sys); break;
      default: out = renderNumber(sec, Math.abs(n));
    }
    if (!out) return [{text: OVERFLOW, color: sec.color, fill: null, numeric: true}, true];
    if (minus && sec.kind !== 'text' && !out.zero) out.prepend('-');
    return [{text: out.text, color: sec.color, fill: out.fill, numeric: true}, false];
  }
  formatText(t) {
    const sec = this.textSection !== null ? this.sections[this.textSection] : null;
    if (!sec) return {text: t, color: null, fill: null, numeric: false};
    const out = renderText(sec, t);
    return {text: out.text, color: sec.color, fill: out.fill, numeric: false};
  }
}

const cache = new Map();
/** Parsed format for a code, cached (gridcraft `parse_cached`, 64 entries in a thread-local there). */
export function parseFormat(code) {
  const c = code ?? 'General';
  let f = cache.get(c);
  if (!f) {
    f = NumberFormat.parse(c);
    if (c.length <= 256) { if (cache.size >= 512) cache.clear(); cache.set(c, f); }
  }
  return f;
}

const EMPTY = Object.freeze({text: '', color: null, fill: null, numeric: false});
/** Display text of a value under a format (gridcraft `format_value`). */
export function formatValue(v, fmt, sys = D1900) {
  const f = fmt instanceof NumberFormat ? fmt : parseFormat(fmt);
  if (v === null || v === undefined) return EMPTY;
  if (typeof v === 'number') return Number.isFinite(v) ? f.formatNumber(v, sys)[0] : {...EMPTY, text: ERR.Num.text};
  if (typeof v === 'string') return f.formatText(v);
  if (typeof v === 'boolean') return {...EMPTY, text: v ? 'TRUE' : 'FALSE'};
  if (v instanceof CellError) return {...EMPTY, text: v.text};
  if (v instanceof GArray) { const first = v.data[0]; return first === undefined || first instanceof GArray ? EMPTY : formatValue(first, f, sys); }
  return EMPTY;
}

/** TEXT(value, format_text): a string, or throws a CellError. */
export function textFunction(v0, code, sys = D1900) {
  if (code === '') return '';
  if (tooLong(code)) throw ERR.Value;
  const f = parseFormat(code);
  const v = v0 instanceof GArray ? (v0.data[0] ?? null) : v0;
  let n;
  if (v instanceof CellError) throw v;
  if (v === null || v === undefined) n = 0;
  else if (typeof v === 'number') n = v;
  else if (typeof v === 'boolean') return f.formatText(v ? 'TRUE' : 'FALSE').text;
  else if (typeof v === 'string') { const p = parseNumberText(v); if (p === null) return f.formatText(v).text; n = p; }
  else throw ERR.Value;
  if (!Number.isFinite(n)) throw ERR.Num;
  const [out, overflow] = f.formatNumber(n, sys);
  if (overflow) throw ERR.Value;
  return out.text;
}
