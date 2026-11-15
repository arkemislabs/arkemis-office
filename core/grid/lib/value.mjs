// Cell values and Excel's coercion and comparison rules.
// Translated from gridcraft crates/core/src/value.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// JS representation of gridcraft `Value`:
//   Empty → null · Number → number · Text → string · Bool → boolean
//   Error → a CellError singleton (ERR.Div0 ...) · Array → GArray {rows, cols, data}
// In stored documents an error is `{e: '#N/A'}` (see toJSONValue / fromJSONValue).
// No DOM, no Node built-ins.

import {parseNumberTextIn} from './parse.mjs';

/** Excel's error values (gridcraft `CellError`). Compare by identity. */
export class CellError {
  constructor(text, code, name) { this.text = text; this.code = code; this.name = name; Object.freeze(this); }
  toString() { return this.text; }
  toJSON() { return {e: this.text}; }
}
export const ERR = Object.freeze({
  Null: new CellError('#NULL!', 1, 'Null'),
  Div0: new CellError('#DIV/0!', 2, 'Div0'),
  Value: new CellError('#VALUE!', 3, 'Value'),
  Ref: new CellError('#REF!', 4, 'Ref'),
  Name: new CellError('#NAME?', 5, 'Name'),
  Num: new CellError('#NUM!', 6, 'Num'),
  NA: new CellError('#N/A', 7, 'NA'),
  GettingData: new CellError('#GETTING_DATA', 8, 'GettingData'),
  Spill: new CellError('#SPILL!', 9, 'Spill'),
  Calc: new CellError('#CALC!', 14, 'Calc'),
  /** Circular reference that could not be resolved (Excel shows 0; gridcraft keeps it explicit). */
  Circ: new CellError('#CIRC!', 15, 'Circ'),
});
/** CellError::ALL (Circ is not a literal). */
export const ALL_ERRORS = Object.freeze([ERR.Null, ERR.Div0, ERR.Value, ERR.Ref, ERR.Name, ERR.Num, ERR.NA, ERR.GettingData, ERR.Spill, ERR.Calc]);
export function parseError(s) {
  const u = String(s).toUpperCase();
  for (const e of ALL_ERRORS) if (e.text === u) return e;
  return u === ERR.Circ.text ? ERR.Circ : null;
}
export const isError = v => v instanceof CellError;

/** A 2-D array of values, row-major, always at least 1×1 (gridcraft `Array`). */
export class GArray {
  constructor(rows, cols, data) { this.rows = rows; this.cols = cols; this.data = data; }
  static new(rows, cols, data) {
    if (rows === 0 || cols === 0 || rows * cols !== data.length) return null;
    return new GArray(rows, cols, data);
  }
  static filled(rows, cols, v) {
    const r = Math.max(rows, 1), c = Math.max(cols, 1);
    return new GArray(r, c, new Array(r * c).fill(v));
  }
  static scalar(v) { return new GArray(1, 1, [v]); }
  static column(v) { return v.length ? new GArray(v.length, 1, v) : GArray.scalar(ERR.Calc); }
  static row(v) { return v.length ? new GArray(1, v.length, v) : GArray.scalar(ERR.Calc); }
  get(r, c) { return r >= this.rows || c >= this.cols || r < 0 || c < 0 ? undefined : this.data[r * this.cols + c]; }
  /** Broadcasting read: a 1-row or 1-column array repeats along that axis; outside is #N/A. */
  getBroadcast(r, c) {
    const v = this.get(this.rows === 1 ? 0 : r, this.cols === 1 ? 0 : c);
    return v === undefined ? ERR.NA : v;
  }
  transpose() {
    const data = new Array(this.data.length);
    let k = 0;
    for (let c = 0; c < this.cols; c++) for (let r = 0; r < this.rows; r++) data[k++] = this.data[r * this.cols + c] ?? null;
    return new GArray(this.cols, this.rows, data);
  }
}
export const isArray = v => v instanceof GArray;

export const EMPTY = null;
export const isEmpty = v => v === null || v === undefined;
export const isNumber = v => typeof v === 'number';
export const isText = v => typeof v === 'string';
export const isBool = v => typeof v === 'boolean';

/** A number, or #NUM! when it is NaN or infinite (Excel never stores those); -0 becomes 0. */
export const num = v => (Number.isFinite(v) ? (v === 0 ? 0 : v) : ERR.Num);

/** Top-left element of an array, the value itself otherwise. */
export const scalar = v => (v instanceof GArray ? (v.data.length ? v.data[0] : null) : v);

/**
 * Coercion to a number as arithmetic does it: empty = 0, TRUE = 1, numeric text parses (dates,
 * times, percentages, currency), other text = #VALUE!. Returns a number or a CellError.
 */
export function toNumber(v, sys = 1900) {
  if (v === null || v === undefined) return 0;
  switch (typeof v) {
    case 'number': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': { const n = parseNumberTextIn(v, sys); return n === null ? ERR.Value : n; }
    default:
      if (v instanceof CellError) return v;
      if (v instanceof GArray) return v.data.length ? toNumber(v.data[0], sys) : 0;
      return ERR.Value;
  }
}

/** Coercion to text as `&` does it. Returns a string or a CellError. */
export function toText(v) {
  if (v === null || v === undefined) return '';
  switch (typeof v) {
    case 'number': return numberToText(v);
    case 'boolean': return v ? 'TRUE' : 'FALSE';
    case 'string': return v;
    default:
      if (v instanceof CellError) return v;
      if (v instanceof GArray) return v.data.length ? toText(v.data[0]) : '';
      return ERR.Value;
  }
}

/** Coercion to a boolean as IF does it. Returns a boolean or a CellError. */
export function toBool(v) {
  if (v === null || v === undefined) return false;
  switch (typeof v) {
    case 'number': return v !== 0;
    case 'boolean': return v;
    case 'string': {
      if (/^true$/i.test(v)) return true;
      if (/^false$/i.test(v)) return false;
      return ERR.Value;
    }
    default:
      if (v instanceof CellError) return v;
      if (v instanceof GArray) return v.data.length ? toBool(v.data[0]) : false;
      return ERR.Value;
  }
}

/** Display text with General formatting (logs, CSV, tests). */
export function display(v) {
  if (v instanceof CellError) return v.text;
  const t = toText(v);
  return typeof t === 'string' ? t : '';
}

/** Type rank for comparison and sorting: numbers < text < booleans < errors; empty sorts last. */
function rank(v) {
  if (v === null || v === undefined) return 4;
  switch (typeof v) {
    case 'number': return 0;
    case 'string': return 1;
    case 'boolean': return 2;
    default: return v instanceof CellError ? 3 : 5;
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Excel's comparison for `=`, `<`… Text compares case-insensitively; empty acts as 0, "" or FALSE
 * depending on the other side. Returns -1, 0 or 1. Errors are handled by the caller.
 */
export function compare(a, b) {
  const ea = a === null || a === undefined, eb = b === null || b === undefined;
  if (ea && eb) return 0;
  if (ea) {
    if (typeof b === 'number') return compareNumbers(0, b);
    if (typeof b === 'string') return compareText('', b);
    if (typeof b === 'boolean') return cmp(false, b);
  }
  if (eb) {
    if (typeof a === 'number') return compareNumbers(a, 0);
    if (typeof a === 'string') return compareText(a, '');
    if (typeof a === 'boolean') return cmp(a, false);
  }
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return compareNumbers(a, b);
  if (ta === 'string' && tb === 'string') return compareText(a, b);
  if (ta === 'boolean' && tb === 'boolean') return cmp(a, b);
  if (a instanceof CellError && b instanceof CellError) return cmp(a.code, b.code);
  return cmp(rank(a), rank(b));
}

const round15 = x => (!Number.isFinite(x) || x === 0 ? x : Number(x.toExponential(14)));
/** Numbers compare at 15 significant digits, so 0.1+0.2 equals 0.3. */
export function compareNumbers(a, b) {
  if (a === b) return 0;
  if (Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 1e-13) return cmp(a, b);
  return cmp(round15(a), round15(b));
}

/** Case-insensitive text order (Unicode lowercase, compared by code point). */
export function compareText(a, b) {
  if (a === b) return 0;
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x === y) return 0;
  // Compare by code point (Rust char order), not UTF-16 unit.
  const ix = x[Symbol.iterator](), iy = y[Symbol.iterator]();
  for (;;) {
    const p = ix.next(), q = iy.next();
    if (p.done && q.done) return 0;
    if (p.done) return -1;
    if (q.done) return 1;
    if (p.value !== q.value) return cmp(p.value.codePointAt(0), q.value.codePointAt(0));
  }
}

/** Sort order (ascending): numbers, text, booleans, errors, then blanks last. */
export function sortCompare(a, b) {
  const ea = a === null || a === undefined, eb = b === null || b === undefined;
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  if (a instanceof CellError && b instanceof CellError) return 0;
  return compare(a, b);
}

/** Removes trailing zeros (and a trailing point) from a decimal string. */
export function trimDecimal(s) {
  if (!s.includes('.')) return s;
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
}

/** Scientific text like `1.23456789012346E+15` with up to `sig` significant digits. */
export function sciText(n, sig) {
  const s = n.toExponential(Math.max(0, sig - 1));
  const i = s.indexOf('e');
  if (i < 0) return s;
  const mant = trimDecimal(s.slice(0, i));
  const e = Number(s.slice(i + 1));
  return `${mant}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

/**
 * Number → text as `&` converts it: up to 15 significant digits, scientific for very large or
 * very small magnitudes.
 */
export function numberToText(n) {
  if (n === 0 || !Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if ((!(a >= 1e-9 && a < 1e15) && Math.round(a) !== a) || a >= 1e15) return sciText(n, 15);
  if (Number(a.toExponential(14)) >= 1e15) return sciText(n, 15);
  const mag = Math.floor(Math.log10(a));
  const decimals = Math.min(30, Math.max(0, 14 - mag));
  return trimDecimal(toFixedExact(n, decimals));
}

/** `n.toFixed(d)` that also works past 1e21 and for d up to 100. */
export function toFixedExact(n, d) {
  if (Math.abs(n) < 1e21) return n.toFixed(Math.min(100, d));
  return BigInt(Math.round(n)).toString() + (d > 0 ? '.' + '0'.repeat(d) : '');
}

// ---------------------------------------------------------------------------------------------
// Stored form (document JSON)

/** Value → JSON for the document: errors become {e}. Arrays are never stored in a cell. */
export function toJSONValue(v) {
  if (v instanceof CellError) return {e: v.text};
  if (v instanceof GArray) return toJSONValue(scalar(v));
  return v === undefined ? null : v;
}
/** JSON from the document → Value. */
export function fromJSONValue(j) {
  if (j === null || j === undefined) return null;
  if (typeof j === 'object') return typeof j.e === 'string' ? (parseError(j.e) ?? ERR.Value) : null;
  return j;
}

/** Structural equality of two values (arrays by content). */
export function sameValue(a, b) {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a instanceof GArray && b instanceof GArray) {
    if (a.rows !== b.rows || a.cols !== b.cols) return false;
    for (let i = 0; i < a.data.length; i++) if (!sameValue(a.data[i], b.data[i])) return false;
    return true;
  }
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}
