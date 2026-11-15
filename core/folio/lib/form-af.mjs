// Acrobat form formatting, validation and calculation without a JavaScript engine: the Format,
// Validate and Calculate tabs of Field Properties.
//
// Real forms carry these as JavaScript calls to the AF functions of Acrobat's JavaScript API
// (AFNumber_Format, AFPercent_Format, AFDate_FormatEx, AFTime_Format, AFSpecial_Format,
// AFSpecial_KeystrokeEx, AFRange_Validate, AFSimple_Calculate and simplified field notation).
// Acrobat writes exactly these calls from its tabs; this module recognises them, runs them
// (format for display, keystroke check on commit, validation, calculation) and writes them back.
// Other scripts are kept untouched and reported as unsupported.
//
// Translated from printcraft crates/forms/src/af.rs, af/format.rs, af/calc.rs, af/script.rs at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// A Format is {kind: 'none'} | {kind: 'number', decimals, sep, neg, currency, prepend} |
// {kind: 'percent', decimals, sep} | {kind: 'date', fmt} | {kind: 'time', fmt} | {kind: 'special', n} |
// {kind: 'mask', mask}; a Validate {kind: 'none'} | {kind: 'range', min, max}; a Calculate
// {kind: 'none'} | {kind: 'simple', op, fields} | {kind: 'notation', expr}. No DOM, no Node built-ins.

export const NONE = Object.freeze({kind: 'none'});
export const DATE_PRESETS = Object.freeze(['m/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd', 'mmm-yy', 'mmmm-yy',
  'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM']);
export const TIME_PRESETS = Object.freeze(['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt']);
export const CALC_OPS = Object.freeze([['sum (+)', 'SUM'], ['product (x)', 'PRD'], ['average', 'AVG'], ['minimum', 'MIN'], ['maximum', 'MAX']]);
const OP_BY_CODE = Object.fromEntries(CALC_OPS.map(([label, code]) => [code, label]));
export const opLabel = code => OP_BY_CODE[code] ?? code;

// ── script arguments ────────────────────────────────────────────────────────────────────────

const MAX_NESTING = 64;

class Parser {
  constructor(s, i = 0) { this.s = s; this.i = i; this.depth = 0; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  string() {
    const q = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === '\\' && this.i < this.s.length) {
        const e = this.s[this.i++];
        switch (e) {
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case '0': out += '\0'; break;
          case 'x': { const h = this.s.slice(this.i, this.i + 2); if (!/^[0-9a-fA-F]{2}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); this.i += 2; break; }
          case 'u': { const h = this.s.slice(this.i, this.i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); this.i += 4; break; }
          default: out += e;
        }
      } else if (c === q) return out;
      else out += c;
    }
    return null;
  }
  arg() {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) return undefined;
    if (c === '"' || c === "'") { const s = this.string(); return s === null ? undefined : {t: 'str', v: s}; }
    if (c === '[') { this.i++; const l = this.nested(']'); return l ? {t: 'list', v: l} : undefined; }
    if (this.s.startsWith('new Array', this.i)) {
      this.i += 9; this.ws();
      if (this.s[this.i] !== '(') return undefined;
      this.i++;
      const l = this.nested(')');
      return l ? {t: 'list', v: l} : undefined;
    }
    if (this.s.startsWith('true', this.i)) { this.i += 4; return {t: 'bool', v: true}; }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return {t: 'bool', v: false}; }
    const start = this.i;
    while (this.i < this.s.length && /[0-9.\-+eE]/.test(this.s[this.i])) this.i++;
    const n = Number(this.s.slice(start, this.i));
    return this.i > start && Number.isFinite(n) ? {t: 'num', v: n} : undefined;
  }
  nested(close) {
    if (this.depth >= MAX_NESTING) return null;
    this.depth++;
    const out = this.list(close);
    this.depth--;
    return out;
  }
  list(close) {
    const out = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === close) { this.i++; return out; }
      const a = this.arg();
      if (a === undefined) return null;
      out.push(a);
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] === close) { this.i++; return out; }
      else return null;
    }
  }
}

const argNum = a => (!a ? undefined : a.t === 'num' ? a.v : a.t === 'bool' ? Number(a.v) : a.t === 'str' && Number.isFinite(Number(a.v.trim())) && a.v.trim() ? Number(a.v) : undefined);
export const argString = a => (!a ? undefined : a.t === 'str' ? a.v : a.t === 'num' ? String(a.v) : undefined);
const truthy = a => (a.t === 'bool' ? a.v : a.t === 'num' ? a.v !== 0 : a.t === 'str' ? a.v.length > 0 : a.v.length > 0);

/** The first call to `name(` in `js` and its arguments, or null. */
export function call(js, name) {
  const at = js.indexOf(`${name}(`);
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(js[at - 1])) return null;
  return new Parser(js, at + name.length + 1).list(')');
}

export function parseFormat(js) {
  const a = (args, i) => Math.min(255, Math.max(0, argNum(args[i]) ?? 0));
  let args;
  if ((args = call(js, 'AFNumber_Format'))) return {kind: 'number', decimals: a(args, 0), sep: a(args, 1), neg: a(args, 2), currency: argString(args[4]) ?? '', prepend: args[5] === undefined || truthy(args[5])};
  if ((args = call(js, 'AFPercent_Format'))) return {kind: 'percent', decimals: a(args, 0), sep: a(args, 1)};
  if ((args = call(js, 'AFDate_FormatEx'))) { const f = argString(args[0]); return f === undefined ? null : {kind: 'date', fmt: f}; }
  if ((args = call(js, 'AFDate_Format'))) { const f = DATE_PRESETS[a(args, 0)]; return f ? {kind: 'date', fmt: f} : null; }
  if ((args = call(js, 'AFTime_FormatEx'))) { const f = argString(args[0]); return f === undefined ? null : {kind: 'time', fmt: f}; }
  if ((args = call(js, 'AFTime_Format'))) { const f = TIME_PRESETS[a(args, 0)]; return f ? {kind: 'time', fmt: f} : null; }
  if ((args = call(js, 'AFSpecial_Format'))) return {kind: 'special', n: Math.min(a(args, 0), 3)};
  if ((args = call(js, 'AFSpecial_KeystrokeEx'))) { const m = argString(args[0]); return m === undefined ? null : {kind: 'mask', mask: m}; }
  return null;
}

export function parseValidate(js) {
  const args = call(js, 'AFRange_Validate');
  if (!args) return null;
  const flag = i => !!args[i] && truthy(args[i]);
  return {kind: 'range', min: flag(0) ? argNum(args[1]) ?? null : null, max: flag(2) ? argNum(args[3]) ?? null : null};
}

export function parseCalculate(js) {
  if (js.includes('BVCALC')) {
    const range = notationRange(js, jsTokens(js).comments);
    if (range) return {kind: 'notation', expr: notationText(js.slice(range[0], range[1]))};
  }
  const args = call(js, 'AFSimple_Calculate');
  if (!args) return null;
  const op = argString(args[0]);
  if (!OP_BY_CODE[op]) return null;
  const second = args[1];
  let fields;
  if (second?.t === 'list') fields = second.v.map(argString).filter(x => x !== undefined);
  else if (second?.t === 'str') fields = second.v.split(',').map(x => x.trim()).filter(Boolean);
  else return null;
  return {kind: 'simple', op, fields};
}

// ── writing scripts (what Acrobat's tabs generate) ──────────────────────────────────────────

export function jsStr(s) {
  let o = '"';
  for (const c of String(s)) {
    if (c === '"' || c === '\\') o += `\\${c}`;
    else if (c === '\n') o += '\\n';
    else if (c === '\r') o += '\\r';
    else if (c === '\t') o += '\\t';
    else if (c.codePointAt(0) >= 0x20 && c.codePointAt(0) < 0x7f) o += c;
    else for (let i = 0; i < c.length; i++) o += `\\u${c.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `${o}"`;
}

/** The (format, keystroke) scripts for a format, or null for none. */
export function formatJs(f) {
  switch (f?.kind) {
    case 'number': { const a = `${f.decimals}, ${f.sep}, ${f.neg}, 0, ${jsStr(f.currency)}, ${f.prepend}`; return [`AFNumber_Format(${a});`, `AFNumber_Keystroke(${a});`]; }
    case 'percent': return [`AFPercent_Format(${f.decimals}, ${f.sep});`, `AFPercent_Keystroke(${f.decimals}, ${f.sep});`];
    case 'date': return [`AFDate_FormatEx(${jsStr(f.fmt)});`, `AFDate_KeystrokeEx(${jsStr(f.fmt)});`];
    case 'time': return [`AFTime_FormatEx(${jsStr(f.fmt)});`, `AFTime_KeystrokeEx(${jsStr(f.fmt)});`];
    case 'special': return [`AFSpecial_Format(${f.n});`, `AFSpecial_Keystroke(${f.n});`];
    case 'mask': return ['', `AFSpecial_KeystrokeEx(${jsStr(f.mask)});`];
    default: return null;
  }
}

export function validateJs(v) {
  if (v?.kind !== 'range') return null;
  return `AFRange_Validate(${v.min !== null && v.min !== undefined}, ${v.min ?? 0}, ${v.max !== null && v.max !== undefined}, ${v.max ?? 0});`;
}

export function calculateJs(c) {
  if (c?.kind === 'simple') return `AFSimple_Calculate(${jsStr(c.op)}, new Array(${c.fields.map(jsStr).join(', ')}));`;
  // Acrobat's own translation follows the comment, so a viewer that runs the script instead of
  // reading the comment computes the same value.
  if (c?.kind === 'notation') return `/** BVCALC ${c.expr} EVCALC **/ event.value = ${notationJs(c.expr)};`;
  return null;
}

// ── running them ────────────────────────────────────────────────────────────────────────────

/** AFMakeNumber: a number from typed text (currency symbols, group separators, spaces, a trailing % ignored). */
export function makeNumber(s) {
  let t = String(s).trim().replace(/[\s$€£¥'%]/g, '');
  if (!t) return null;
  const neg = t.startsWith('(') && t.endsWith(')');
  t = t.replace(/^\(+/, '').replace(/\)+$/, '');
  const c = t.lastIndexOf(','), d = t.lastIndexOf('.');
  let norm;
  if (c >= 0 && d >= 0 && c > d) norm = t.replace(/\./g, '').replace(/,/g, '.');
  else if (c >= 0 && d < 0 && t.length - c - 1 !== 3) norm = t.replace(/,/g, '.');
  else norm = t.replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(norm)) return null;
  const v = Number(norm);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

/** A number as JavaScript prints it. */
export const jsNumber = v => String(v);

function group(int, sep) {
  let out = '';
  for (let i = 0; i < int.length; i++) { if (i > 0 && (int.length - i) % 3 === 0) out += sep; out += int[i]; }
  return out;
}

/** A number with `decimals` places in separator style `sep` (0 "1,234.56", 1 "1234.56", 2 "1.234,56", 3 "1234,56", 4 "1'234.56"). */
function numberText(v, decimals, sep) {
  const p = 10 ** decimals;
  const scaled = Math.abs(v) * p;
  const r = Number.isFinite(scaled) ? Math.round(scaled + 1e-9 * Math.sign(scaled)) / p : Math.abs(v);
  const s = r.toFixed(decimals);
  const [int, frac = ''] = s.split('.');
  const [g, dec] = {1: [null, '.'], 2: ['.', ','], 3: [null, ','], 4: ["'", '.']}[sep] ?? [',', '.'];
  let out = g ? group(int, g) : int;
  if (frac) out += dec + frac;
  return out;
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const daysIn = (y, m) => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
function weekday(y, m, d) {
  const T = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = y - (m < 3 ? 1 : 0);
  return ((((yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + (T[m - 1] ?? 0) + d) % 7) + 7) % 7);
}

/** The fields of a date format in order (year, month, day, hours, minutes, seconds, literal digits). */
function order(fmt) {
  const out = [];
  const cleaned = fmt.replace(/dddd/g, ' ').replace(/ddd/g, ' ');
  let prev = ' ';
  let run = null;
  const fixed = (k, n) => ((k === 'y' && (n === 2 || n === 4)) || ('mdHMs'.includes(k) && n === 2) ? n : 0);
  for (const c of cleaned) {
    const continues = run && run[0] === c;
    if (run && !continues) {
      const last = out[out.length - 1];
      if (last && last.kind !== '#') last.width = fixed(run[0] === 'h' ? 'H' : run[0], run[1]);
      run = null;
    }
    if (c >= '0' && c <= '9') {
      const last = out[out.length - 1];
      if (last && last.kind === '#' && /[0-9]/.test(prev)) last.literal = last.literal * 10 + Number(c);
      else out.push({kind: '#', literal: Number(c), width: 0, joined: false});
      prev = c;
      continue;
    }
    const k = {y: 'y', m: 'm', d: 'd', H: 'H', h: 'H', M: 'M', s: 's'}[c];
    if (!k) { prev = c; continue; }
    if (continues) run = [run[0], run[1] + 1];
    else {
      const adjacent = 'ymdHhMs'.includes(prev) && prev !== ' ';
      if (out[out.length - 1]?.kind !== k) {
        const last = out[out.length - 1];
        if (last && last.kind !== '#') last.joined = adjacent;
        out.push({kind: k, literal: 0, width: 0, joined: false});
      }
      run = [c, 1];
    }
    prev = c;
  }
  const last = out[out.length - 1];
  if (run && last && last.kind !== '#') last.width = fixed(run[0] === 'h' ? 'H' : run[0], run[1]);
  return out;
}

/** Parse typed text against a date/time format (any separators, month names, two-digit years); null when it is not a date. */
export function parseDate(text, fmt) {
  const t = String(text).trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const pm = lower.includes('pm') || /\d\s*p$/.test(lower);
  const am = lower.includes('am') || /\d\s*a$/.test(lower);
  const nums = [];
  let monthName = null;
  let cur = '';
  const flush = () => {
    if (!cur) return;
    if (/^[0-9]/.test(cur)) nums.push(cur);
    else if (cur.length >= 3) { const i = MONTHS.findIndex(m => m.toLowerCase().startsWith(cur.toLowerCase())); if (i >= 0) monthName = i + 1; }
    cur = '';
  };
  for (const c of t) {
    const alnum = /[\p{L}\p{N}]/u.test(c);
    const sameKind = cur === '' || /[0-9]/.test(cur[0]) === /[0-9]/.test(c);
    if (alnum && sameKind) cur += c;
    else { flush(); if (alnum) cur += c; }
  }
  flush();
  const dt = {y: 0, m: 1, d: 1, hh: 0, mm: 0, ss: 0};
  const parts = order(fmt);
  const takesNumber = p => 'ydHMs'.includes(p.kind) || (p.kind === 'm' && monthName === null);
  const isTime = p => 'HMs'.includes(p.kind);
  const wanted = [parts.filter(p => takesNumber(p) && !isTime(p)).length, parts.filter(isTime).length];
  let tail = false, haveY = false;
  const next = (part, need, nextWidth) => {
    const run = nums.shift();
    if (run === undefined) return null;
    const wasTail = tail;
    tail = false;
    const short = nums.length < Math.max(0, need - 1);
    let digits = run;
    const head = run.slice(0, part.width), rest = run.slice(part.width);
    if (part.joined && part.width > 0 && rest.length && (wasTail || (short && rest.length >= nextWidth))) { nums.unshift(rest); tail = true; digits = head; }
    else if (wasTail && part.width > 0 && run.length !== part.width) return null;
    const n = Number(digits);
    return Number.isSafeInteger(n) && digits.length <= 15 ? n : null;
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const kind = isTime(part) ? 1 : 0;
    const need = wanted[kind];
    const nextWidth = parts[i + 1]?.width ?? 0;
    if (takesNumber(part)) wanted[kind] = Math.max(0, wanted[kind] - 1);
    const take = () => next(part, need, nextWidth);
    if (part.kind === '#') { if (nums.length && Number(nums[0]) === part.literal) { nums.shift(); tail = false; } continue; }
    if (part.kind === 'm') { if (monthName !== null) dt.m = monthName; else { const v = take(); if (v === null) return null; dt.m = v; } }
    else if (part.kind === 'd') { const v = take(); if (v === null) return null; dt.d = v; }
    else if (part.kind === 'y') { const v = take(); if (v === null) return null; dt.y = v < 100 ? (v < 50 ? 2000 + v : 1900 + v) : v; haveY = true; }
    else if (part.kind === 'H') { if (nums.length) { const v = take(); if (v === null) return null; dt.hh = v; } }
    else if (part.kind === 'M') { if (nums.length) { const v = take(); if (v === null) return null; dt.mm = v; } }
    else if (part.kind === 's') { if (nums.length) { const v = take(); if (v === null) return null; dt.ss = v; } }
  }
  if (nums.length) return null;
  if (!haveY) dt.y = 2000;
  if (pm && dt.hh < 12) dt.hh += 12;
  if (am && dt.hh === 12) dt.hh = 0;
  if (/[ymd]/.test(fmt) && (dt.m < 1 || dt.m > 12 || dt.d === 0 || dt.d > daysIn(dt.y, dt.m))) return null;
  if (dt.hh > 23 || dt.mm > 59 || dt.ss > 59) return null;
  return dt;
}

/** Format a date/time with Acrobat's date format letters. */
export function formatDate(dt, fmt) {
  const chars = [...fmt];
  let out = '';
  for (let i = 0; i < chars.length;) {
    const c = chars[i];
    let n = 1;
    while (i + n < chars.length && chars[i + n] === c) n++;
    const h12 = dt.hh % 12 === 0 ? 12 : dt.hh % 12;
    const two = v => String(v).padStart(2, '0');
    if (c === 'y') out += n >= 4 ? String(dt.y).padStart(4, '0') : two(((dt.y % 100) + 100) % 100);
    else if (c === 'm') out += n >= 3 ? (MONTHS[dt.m - 1] ? (n >= 4 ? MONTHS[dt.m - 1] : MONTHS[dt.m - 1].slice(0, 3)) : String(dt.m)) : n === 2 ? two(dt.m) : String(dt.m);
    else if (c === 'd') out += n >= 3 ? (n >= 4 ? DAYS[weekday(dt.y, dt.m, dt.d)] : DAYS[weekday(dt.y, dt.m, dt.d)].slice(0, 3)) : n === 2 ? two(dt.d) : String(dt.d);
    else if (c === 'H') out += n === 2 ? two(dt.hh) : String(dt.hh);
    else if (c === 'h') out += n === 2 ? two(h12) : String(h12);
    else if (c === 'M') out += n === 2 ? two(dt.mm) : String(dt.mm);
    else if (c === 's') out += n === 2 ? two(dt.ss) : String(dt.ss);
    else if (c === 't') out += n === 2 ? (dt.hh < 12 ? 'am' : 'pm') : dt.hh < 12 ? 'a' : 'p';
    else out += c.repeat(n);
    i += n;
  }
  return out;
}

const SPECIAL_MASKS = ['99999', '99999-9999', '(999) 999-9999', '999-99-9999'];

function maskFits(mask, text) {
  const t = [...text], m = [...mask];
  return t.length === m.length && m.every((mc, i) => (mc === '9' ? /[0-9]/.test(t[i]) : mc === 'A' ? /\p{L}/u.test(t[i]) : mc === 'O' ? /[\p{L}\p{N}]/u.test(t[i]) : mc === 'X' ? true : mc === t[i]));
}

function applyMask(mask, text) {
  const src = [...text].filter(c => /[\p{L}\p{N}]/u.test(c));
  let at = 0, out = '';
  for (const mc of mask) {
    if ('9AOX'.includes(mc)) {
      const c = src[at++];
      if (c === undefined) return null;
      const ok = mc === '9' ? /[0-9]/.test(c) : mc === 'A' ? /\p{L}/u.test(c) : true;
      if (!ok) return null;
      out += c;
    } else out += mc;
  }
  return at === src.length ? out : null;
}

/** The text shown for a value (the Format event). */
export function formatValue(f, value) {
  if (!value) return '';
  switch (f?.kind) {
    case 'number': {
      const v = makeNumber(value);
      if (v === null) return value;
      let body = numberText(v, f.decimals, f.sep);
      if (f.currency) body = f.prepend ? `${f.currency}${body}` : `${body}${f.currency}`;
      if (v < 0) return f.neg === 2 || f.neg === 3 ? `(${body})` : `-${body}`;
      return body;
    }
    case 'percent': {
      const v = makeNumber(value);
      return v === null ? value : `${v < 0 ? '-' : ''}${numberText(v * 100, f.decimals, f.sep)}%`;
    }
    case 'date': case 'time': { const dt = parseDate(value, f.fmt); return dt ? formatDate(dt, f.fmt) : value; }
    case 'special': return applyMask(SPECIAL_MASKS[Math.min(f.n, 3)], value) ?? value;
    case 'mask': return applyMask(f.mask, value) ?? value;
    default: return value;
  }
}

/** The Keystroke event on commit: the value to store, or {error} with Acrobat's message. */
export function keystroke(f, field, value) {
  const bad = () => ({error: `The value entered does not match the format of the field [ ${field} ]`});
  const kind = f?.kind ?? 'none';
  if (kind !== 'none' && !String(value).trim()) return {value: ''};
  switch (kind) {
    case 'none': return {value};
    case 'number': case 'percent': { const v = makeNumber(value); return v === null ? bad() : {value: jsNumber(v)}; }
    case 'date': case 'time':
      return parseDate(value, f.fmt) ? {value: String(value).trim()} : {error: `Invalid date/time: please ensure that the date/time exists. Field [ ${field} ] should match format ${f.fmt}`};
    case 'special': { const m = SPECIAL_MASKS[Math.min(f.n, 3)]; const a = applyMask(m, value); return a && maskFits(m, a) ? {value: String(value).trim()} : bad(); }
    case 'mask': return applyMask(f.mask, value) !== null ? {value: String(value).trim()} : bad();
    default: return {value};
  }
}

/** The Validate event: null when fine, else Acrobat's message. */
export function validate(v, value) {
  if (v?.kind !== 'range') return null;
  if (!String(value).trim()) return null;
  const x = makeNumber(value);
  if (x === null) return null;
  const {min, max} = v;
  const hasMin = min !== null && min !== undefined, hasMax = max !== null && max !== undefined;
  if ((!hasMin || x >= min) && (!hasMax || x <= max)) return null;
  if (hasMin && hasMax) return `Invalid value: must be greater than or equal to ${min} and less than or equal to ${max}.`;
  if (hasMin) return `Invalid value: must be greater than or equal to ${min}.`;
  return `Invalid value: must be less than or equal to ${max}.`;
}

// ── JavaScript tokens (to find the field names a calculation reads) ─────────────────────────

const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield']);
const BEFORE_CONDITION = new Set(['if', 'while', 'for', 'with']);
const lineEnds = (s, j) => s[j] === '\n' || s[j] === '\r' || s[j] === ' ' || s[j] === ' ';

/** Tokens {from, to, kind: 'ident'|'str'|'punct'|'other', text?} and the comment ranges of a script. */
export function jsTokens(js) {
  const s = js;
  const out = [], comments = [];
  const word = j => j < s.length && /[A-Za-z0-9_$]|[^\x00-\x7f]/.test(s[j]) && !lineEnds(s, j);
  let i = 0, dividesUntil = 0, afterCondition = false;
  const conditions = [];
  const regexMayFollow = () => {
    const last = out[out.length - 1];
    if (!last) return true;
    if (last.kind === 'ident') return BEFORE_REGEX.has(s.slice(last.from, last.to));
    if (last.kind === 'punct' && last.text === ')') return afterCondition;
    if (last.kind === 'punct') return !(last.text === ']' || last.text === '}');
    return false;
  };
  const opensCondition = () => {
    const last = out[out.length - 1];
    if (!last || last.kind !== 'ident' || !BEFORE_CONDITION.has(s.slice(last.from, last.to))) return false;
    const before = out[out.length - 2];
    return !(before && before.kind === 'punct' && before.text === '.');
  };
  scan: while (i < s.length) {
    const c = s[i];
    const start = i;
    let token;
    if (/\s/.test(c) || lineEnds(s, i)) { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { let j = i + 2; while (j < s.length && !lineEnds(s, j)) j++; i = j; comments.push([start + 2, i]); continue; }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      if (e < 0) { comments.push([i + 2, s.length]); break scan; }
      comments.push([i + 2, e]); i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      const p = new Parser(s, i);
      const text = p.string();
      if (text === null) break scan;
      i = p.i;
      token = {kind: 'str', text};
    } else if (c === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) break scan;
        if (s[j] === '\\') j += 2; else if (s[j] === '`') break; else j++;
      }
      i = j + 1;
      token = {kind: 'other'};
    } else if (c === '/' && i >= dividesUntil && regexMayFollow()) {
      let j = i + 1, cls = false, end = null;
      for (;;) {
        if (j >= s.length || lineEnds(s, j)) break;
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '/' && !cls) { end = j; break; }
        if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false;
        j++;
      }
      if (end !== null) { i = end + 1; while (word(i)) i++; token = {kind: 'other'}; }
      else { dividesUntil = j; i++; token = {kind: 'punct', text: '/'}; }
    } else if (/[0-9]/.test(c)) {
      while (word(i) || s[i] === '.') i++;
      token = {kind: 'other'};
    } else if (word(i)) {
      while (word(i)) i++;
      token = {kind: 'ident'};
    } else { i++; token = {kind: 'punct', text: c}; }
    if (token.kind === 'punct' && token.text === '(') { conditions.push(opensCondition()); afterCondition = false; }
    else if (token.kind === 'punct' && token.text === ')') afterCondition = conditions.pop() ?? false;
    else afterCondition = false;
    out.push({from: start, to: i, ...token});
  }
  return {tokens: out, comments};
}

/** Where a Calculate script keeps its simplified field notation: between BVCALC and EVCALC in a comment. */
export function notationRange(js, comments) {
  for (const [a0, a1] of comments) {
    const text = js.slice(a0, a1);
    const a = text.indexOf('BVCALC');
    if (a < 0) continue;
    const start = a + 6;
    const b = text.indexOf('EVCALC', start);
    if (b < 0) continue;
    return [a0 + start, a0 + b];
  }
  return null;
}

/** Simplified field notation's tokens, each with its range in `src`. */
export function notationTokens(src) {
  const breaks = c => /\s/.test(c) || '+-*/()'.includes(c);
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const start = i;
    if (/\s/.test(c)) { i++; continue; }
    if (breaks(c)) { i++; out.push({from: start, to: i, kind: 'op', op: c}); continue; }
    if (/[0-9.]/.test(c)) { while (i < src.length && /[0-9.]/.test(src[i])) i++; out.push({from: start, to: i, kind: 'number'}); continue; }
    let name = '';
    while (i < src.length && !breaks(src[i])) {
      const n = src[i++];
      if (n === '\\' && i < src.length) name += src[i++]; else name += n;
    }
    out.push({from: start, to: i, kind: 'name', name});
  }
  return out;
}

/** A field name as simplified field notation writes it. */
export function notationName(name) {
  let out = '';
  [...name].forEach((c, i) => {
    if (/\s/.test(c) || '+-*/()\\'.includes(c) || (i === 0 && /[0-9.]/.test(c))) out += '\\';
    out += c;
  });
  return out;
}

const splice = (src, edits) => {
  let out = '', done = 0;
  for (const [from, to, w] of edits) {
    if (from < done || from > to) continue;
    out += src.slice(done, from) + w;
    done = to;
  }
  return out + src.slice(done);
};

/** Notation as the JavaScript Acrobat writes after its BVCALC comment. */
export function notationJs(expr) {
  return splice(expr, notationTokens(expr).filter(t => t.kind === 'name').map(t => [t.from, t.to, `AFMakeNumber(this.getField(${jsStr(t.name)}).value)`]));
}

/** `src` from its first notation token to its last: the spaces around it left out, but not an escaped space that ends the last name (`Total\ `), as trim would. */
function notationText(src) {
  const t = notationTokens(src);
  return t.length ? src.slice(t[0].from, t.at(-1).to) : '';
}

/** Why notationStorable refuses a notation, in the words the Calculate tab and the tools say it (printcraft 8f16855 af/script.rs). */
export const NOTATION_NOT_STORABLE = "the notation can't be stored as written: it is empty, or holds EVCALC or */, or ends in a lone \\";

/**
 * Whether simplified field notation `expr` can be stored: the script keeps it in a comment, between BVCALC and EVCALC, and it has to read back
 * from there as the same names and operators. One holding EVCALC or a comment end ends early, one ending in a lone backslash escapes the space after it,
 * and an empty one would be stored as `event.value = ;`.
 */
export function notationStorable(expr) {
  const words = s => notationTokens(s).map(t => s.slice(t.from, t.to));
  const js = calculateJs({kind: 'notation', expr});
  const read = js ? parseCalculate(js) : null;
  const mine = words(expr);
  return mine.length > 0 && read?.kind === 'notation' && words(read.expr).length === mine.length && words(read.expr).every((w, i) => w === mine[i]);
}

/** Where a Calculate script names fields: [{from, to, type, ...}] in order. A name built at run time is a `built` site (printcraft 8f16855). */
function calculationSites(js) {
  const sites = [];
  const {tokens, comments} = jsTokens(js);
  const at = notationRange(js, comments);
  if (at) for (const t of notationTokens(js.slice(at[0], at[1]))) if (t.kind === 'name') sites.push({from: at[0] + t.from, to: at[0] + t.to, type: 'notation', name: t.name});
  const ident = (k, w) => tokens[k]?.kind === 'ident' && js.slice(tokens[k].from, tokens[k].to) === w;
  const punct = (k, c) => tokens[k]?.kind === 'punct' && tokens[k].text === c;
  const str = k => (tokens[k]?.kind === 'str' ? tokens[k] : null);
  const built = k => { if (tokens[k]) sites.push({from: tokens[k].from, to: tokens[k].to, type: 'built'}); };
  for (let k = 0; k < tokens.length; k++) {
    if (ident(k, 'getField') && punct(k + 1, '(')) {
      if (str(k + 2) && punct(k + 3, ')')) sites.push({from: tokens[k + 2].from, to: tokens[k + 2].to, type: 'literal', name: tokens[k + 2].text});
      else built(k);
    }
    if (!(ident(k, 'AFSimple_Calculate') && punct(k + 1, '('))) continue;
    if (!(str(k + 2) && punct(k + 3, ','))) { built(k); continue; }
    // One string of comma-separated names, when it is the whole list (not `"row" + suffix`). An argument after it leaves the list as written:
    // its names are read, and what follows is a name built at run time.
    if (str(k + 4)) {
      if (punct(k + 5, ')') || punct(k + 5, ',')) sites.push({from: tokens[k + 4].from, to: tokens[k + 4].to, type: 'commas', list: tokens[k + 4].text});
      if (!punct(k + 5, ')')) built(k);
      continue;
    }
    // `new Array("a", "b")` or `["a", "b"]`: each item that is one string, and the list has to end the call.
    let first, close;
    if (punct(k + 4, '[')) { first = k + 5; close = ']'; }
    else if (ident(k + 4, 'new') && ident(k + 5, 'Array') && punct(k + 6, '(')) { first = k + 7; close = ')'; }
    else { built(k); continue; }
    for (let j = first; ;) {
      const t = tokens[j];
      if (t?.kind === 'str' && (punct(j + 1, ',') || punct(j + 1, close) || tokens[j + 1] === undefined)) { sites.push({from: t.from, to: t.to, type: 'literal', name: t.text}); j++; }
      else if (t?.kind === 'punct' && t.text === ',') j++;
      else if (t?.kind === 'punct' && t.text === close) { if (!punct(j + 1, ')')) built(k); break; }
      else { built(k); break; }
    }
  }
  return sites.sort((a, b) => a.from - b.from);
}

const siteNames = s => (s.type === 'built' ? [] : s.type === 'commas' ? s.list.split(',').map(x => x.trim()).filter(Boolean) : [s.name]);

function renamedSite(s, oldName, newName) {
  if (s.type === 'built') return null;
  if (s.type === 'literal') return s.name === oldName ? jsStr(newName) : null;
  if (s.type === 'notation') return s.name === oldName ? notationName(newName) : null;
  const parts = s.list.split(',');
  if (!parts.some(p => p.trim() === oldName)) return null;
  return jsStr(parts.map(p => (p.trim() === oldName ? p.replace(oldName, newName) : p)).join(','));
}

/** A Calculate script with field `oldName` named `newName` everywhere it reads it; null when it doesn't read it. */
export function renameInCalculation(js, oldName, newName) {
  const sites = calculationSites(js);
  const edits = sites.map(s => { const w = renamedSite(s, oldName, newName); return w === null ? null : [s.from, s.to, w]; }).filter(Boolean);
  if (!edits.length) return null;
  const out = splice(js, edits);
  const expected = sites.flatMap(siteNames).map(n => (n === oldName ? newName : n));
  const got = calculationSites(out).flatMap(siteNames);
  return got.length === expected.length && got.every((n, i) => n === expected[i]) ? out : null;
}

const unique = list => [...new Set(list)];
/** The fields a Calculate script reads by name, each once, in order. */
export const calculationReads = js => unique(calculationSites(js).flatMap(siteNames));
/** Whether a Calculate script also reads fields by names it builds at run time (`getField("row" + i)`), which calculationReads can't list. */
export const readsBuiltNames = js => calculationSites(js).some(s => s.type === 'built');

/** The fields a Calculate tab's setting reads. */
export function calculateReads(c) {
  if (c?.kind === 'simple') return unique(c.fields);
  if (c?.kind === 'notation') return unique(notationTokens(c.expr).filter(t => t.kind === 'name').map(t => t.name));
  return [];
}

/** Evaluate simplified field notation: + - * / and parentheses over numbers and field names; null when it is not valid. */
export function evalNotation(src, valueOf) {
  const toks = [];
  for (const t of notationTokens(src)) {
    if (t.kind === 'number') { const n = Number(src.slice(t.from, t.to)); if (!Number.isFinite(n)) return null; toks.push({n}); }
    else if (t.kind === 'op') toks.push({op: t.op});
    else toks.push({n: valueOf(t.name)});
  }
  let i = 0;
  const factor = d => {
    if (d > MAX_NESTING) return null;
    const t = toks[i];
    if (!t) return null;
    if (t.n !== undefined) { i++; return t.n; }
    if (t.op === '-') { i++; const v = factor(d + 1); return v === null ? null : -v; }
    if (t.op === '(') { i++; const v = expr(d + 1); if (v === null || toks[i]?.op !== ')') return null; i++; return v; }
    return null;
  };
  const term = d => {
    let v = factor(d);
    if (v === null) return null;
    while (toks[i] && (toks[i].op === '*' || toks[i].op === '/')) { const o = toks[i++].op; const r = factor(d); if (r === null) return null; v = o === '*' ? v * r : v / r; }
    return v;
  };
  const expr = d => {
    let v = term(d);
    if (v === null) return null;
    while (toks[i] && (toks[i].op === '+' || toks[i].op === '-')) { const o = toks[i++].op; const r = term(d); if (r === null) return null; v = o === '+' ? v + r : v - r; }
    return v;
  };
  const v = expr(0);
  return v !== null && i === toks.length && Number.isFinite(v) ? v : null;
}

/** The Calculate event: the new value as text, or null. `values(name)` returns every field named `name` or below it. */
export function calculate(c, values) {
  const num = s => makeNumber(s) ?? 0;
  if (c?.kind === 'simple') {
    const xs = c.fields.flatMap(f => values(f)).map(num);
    let v;
    switch (c.op) {
      case 'SUM': v = xs.reduce((a, b) => a + b, 0); break;
      case 'PRD': v = xs.reduce((a, b) => a * b, 1); break;
      case 'AVG': v = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; break;
      case 'MIN': v = xs.length ? Math.min(...xs) : Infinity; break;
      default: v = xs.length ? Math.max(...xs) : -Infinity;
    }
    return Number.isFinite(v) ? jsNumber(v) : '0';
  }
  if (c?.kind === 'notation') {
    const v = evalNotation(c.expr, name => { const l = values(name); return l.length ? num(l[0]) : 0; });
    return v === null ? null : jsNumber(v);
  }
  return null;
}

// ── push buttons ────────────────────────────────────────────────────────────────────────────

/** Recognise the common one-line button scripts (af.rs `button_script`). */
export function buttonScript(js) {
  const t = String(js).trim();
  if (t.startsWith('this.print(') || t.startsWith('print(') || t.includes(';this.print(') || t.includes('; this.print(')) return {kind: 'named', name: 'Print'};
  const reset = call(t, 'this.resetForm') ?? call(t, 'resetForm');
  if (reset) {
    const first = reset[0];
    return {kind: 'reset', fields: first?.t === 'list' ? first.v.map(argString).filter(x => x !== undefined) : first?.t === 'str' ? [first.v] : [], exclude: false};
  }
  const alert = call(t, 'app.alert');
  if (alert && argString(alert[0]) !== undefined) return {kind: 'alert', message: argString(alert[0])};
  const url = call(t, 'app.launchURL');
  if (url && argString(url[0]) !== undefined) return {kind: 'uri', uri: argString(url[0])};
  const compact = t.replace(/\s/g, '').replace(/;+$/, '');
  if (compact === 'event.target.buttonImportIcon()') return {kind: 'importIcon'};
  if (compact === 'this.pageNum++' || compact === 'pageNum++') return {kind: 'named', name: 'NextPage'};
  if (compact === 'this.pageNum--' || compact === 'pageNum--') return {kind: 'named', name: 'PrevPage'};
  if (compact === 'this.pageNum=0') return {kind: 'named', name: 'FirstPage'};
  return {kind: 'script', script: t};
}
