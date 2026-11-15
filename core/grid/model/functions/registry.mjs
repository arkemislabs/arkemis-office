// The worksheet function library: specs, lookup, automatic array lifting and the shared argument
// helpers.
// Translated from gridcraft crates/functions/src/{lib.rs, lift.rs, util.rs} at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A spec is {name, minArgs, maxArgs, category, volatile, scalarArgs, valueArgs, signature,
// description, imp}. `imp(args, ctx)` receives evaluated arguments ({value, fromRef}) and returns a
// value; it may throw a CellError (gridcraft's `Err(CellError)`), which `finish` turns into the
// result. Category modules register through `register()`; the calc engine looks functions up with
// `lookup()` and invokes them with `call()`. No DOM, no Node built-ins.

import {CellError, ERR, GArray, num as numValue, scalar as scalarOf, toNumber, toText, toBool} from '../../lib/value.mjs';

export const VAR = Infinity;
export const MAX_CELLS = 10_000_000;
export const MAX_TEXT = 32_767;
/** Lifting masks: S = every argument is a scalar, A = none is. */
export const S = Object.freeze([true]);
export const A = Object.freeze([false]);

const specs = [];
const byName = new Map();

/** A value parameter mask table (lift.rs VALUE_ARGS). */
const VALUE_ARGS = [
  ['EOMONTH EDATE YEARFRAC WEEKNUM', [true]],
  ['WORKDAY NETWORKDAYS', [true, true, false]],
  ['WORKDAY.INTL NETWORKDAYS.INTL', [true, true, false, false]],
  ['ACCRINT ACCRINTM AMORDEGRC AMORLINC COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD CUMIPMT CUMPRINC DISC DOLLARDE DOLLARFR DURATION EFFECT INTRATE MDURATION NOMINAL ODDFPRICE ODDFYIELD ODDLPRICE ODDLYIELD PRICE PRICEDISC PRICEMAT RECEIVED TBILLEQ TBILLPRICE TBILLYIELD YIELD YIELDDISC YIELDMAT', [true]],
  ['FVSCHEDULE XNPV', [true, false]],
  ['XIRR', [false, false, true]],
  ['ISEVEN ISODD QUOTIENT MROUND FACTDOUBLE SQRTPI RANDBETWEEN', [true]],
  ['SERIESSUM', [true, true, true, false]],
  ['BIN2DEC BIN2HEX BIN2OCT DEC2BIN DEC2HEX DEC2OCT HEX2BIN HEX2DEC HEX2OCT OCT2BIN OCT2DEC OCT2HEX CONVERT DELTA GESTEP ERF ERF.PRECISE ERFC ERFC.PRECISE BESSELI BESSELJ BESSELK BESSELY COMPLEX IMABS IMAGINARY IMARGUMENT IMCONJUGATE IMCOS IMCOSH IMCOT IMCSC IMCSCH IMDIV IMEXP IMLN IMLOG10 IMLOG2 IMPOWER IMREAL IMSEC IMSECH IMSIN IMSINH IMSQRT IMSUB IMTAN', [true]],
];
function valueArgs(name) {
  for (const [names, mask] of VALUE_ARGS) if (names.split(' ').includes(name)) return mask;
  return [];
}

/** Builds a spec (gridcraft's `f!` macro). */
export function f(name, minArgs, maxArgs, category, scalarArgs, signature, description, imp, {volatile = false} = {}) {
  return {name, minArgs, maxArgs, category, volatile, scalarArgs, valueArgs: valueArgs(name), signature, description, imp};
}

/** Adds a category module's specs (the first registration of a name wins, as upstream). */
export function register(list) {
  for (const s of list) {
    if (byName.has(s.name)) continue;
    byName.set(s.name, s);
    specs.push(s);
  }
}

/** Looks a function up by name (case-insensitive; `_xlfn.`/`_xlws.` prefixes dropped; `_xludf.` never found). */
export function lookup(name) {
  let n = String(name).trim().toUpperCase();
  for (;;) {
    if (n.startsWith('_XLFN.')) n = n.slice(6);
    else if (n.startsWith('_XLWS.')) n = n.slice(6);
    else break;
  }
  return byName.get(n) ?? null;
}
/** Every registered function. */
export const all = () => specs;

export const isScalarArg = (spec, i) => (i < spec.scalarArgs.length ? spec.scalarArgs[i] : spec.scalarArgs.length ? spec.scalarArgs[spec.scalarArgs.length - 1] : false);
export const isValueArg = (spec, i) => (i < spec.valueArgs.length ? spec.valueArgs[i] : spec.valueArgs.length ? spec.valueArgs[spec.valueArgs.length - 1] : false);
export const accepts = (spec, n) => n >= spec.minArgs && n <= spec.maxArgs && n <= 255;

/** Calls a function with array lifting applied. Wrong arity gives #VALUE!. */
export function call(spec, args, ctx) {
  if (!accepts(spec, args.length)) return ERR.Value;
  return callLifted(spec, args, ctx);
}

function run(spec, args, ctx) {
  try { return finish(spec.imp(args, ctx)); } catch (e) {
    if (e instanceof CellError) return e;
    throw e;
  }
}

function callLifted(spec, args0, ctx) {
  let args = args0;
  if (spec.valueArgs.length) {
    const multi = (i, a) => a.fromRef && isValueArg(spec, i) && a.value instanceof GArray && a.value.data.length > 1;
    if (args.some((a, i) => multi(i, a))) args = args.map((a, i) => (multi(i, a) ? {value: ERR.Value, fromRef: false} : a));
  }
  let rows = 0, cols = 0, any = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (isScalarArg(spec, i) && v instanceof GArray) { any = true; rows = Math.max(rows, v.rows); cols = Math.max(cols, v.cols); }
  }
  if (!any) return run(spec, args, ctx);
  if (rows * cols > MAX_CELLS) return ERR.Num;
  const cell = args.map(a => ({...a}));
  const data = new Array(rows * cols);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let i = 0; i < args.length; i++) {
        const v = args[i].value;
        if (isScalarArg(spec, i) && v instanceof GArray) {
          const x = v.getBroadcast(r, c);
          cell[i].value = x instanceof GArray ? (x.data[0] ?? null) : x;
        }
      }
      const out = run(spec, cell, ctx);
      data[k++] = out instanceof GArray ? (out.data[0] ?? null) : out;
    }
  }
  if (rows === 1 && cols === 1) return data[0];
  return GArray.new(rows, cols, data) ?? ERR.Calc;
}

// ---------------------------------------------------------------------------------------------
// util.rs

/** Normalises a function's result: non-finite numbers are #NUM!, over-long text #VALUE!. */
export function finish(v) {
  if (typeof v === 'number') return numValue(v);
  if (typeof v === 'string' && v.length > MAX_TEXT && [...v].length > MAX_TEXT) return ERR.Value;
  return v === undefined ? null : v;
}

/** Throws a CellError (gridcraft `Err(e)?`). */
export const fail = e => { throw e; };
/** `x?` on a coercion result: throws a CellError, otherwise returns the value. */
export const ok = x => { if (x instanceof CellError) throw x; return x; };

export function numVal(n) {
  if (!Number.isFinite(n)) throw ERR.Num;
  return n === 0 ? 0 : n;
}
export const scalar = a => scalarOf(a.value);
export function arg(args, i) { const a = args[i]; if (!a) throw ERR.Value; return a; }
/** An argument given (a blank reference counts, an omitted argument does not). */
export const has = (args, i) => !!args[i] && (args[i].value !== null || args[i].fromRef);
export const num = (args, i) => ok(toNumber(scalar(arg(args, i))));
export const optNum = (args, i, d) => (args[i] === undefined ? d : ok(toNumber(scalar(args[i]))));
export function toInt(n) {
  if (!Number.isFinite(n) || Math.abs(n) > 9.007_199_254_740_992e15) throw ERR.Num;
  return Math.trunc(n);
}
export const int = (args, i) => toInt(num(args, i));
export const optInt = (args, i, d) => (args[i] === undefined ? d : int(args, i));
export const text = (args, i) => ok(toText(scalar(arg(args, i))));
export const boolean = (args, i) => ok(toBool(scalar(arg(args, i))));
export const optBool = (args, i, d) => (args[i] === undefined ? d : ok(toBool(scalar(args[i]))));
export const asArray = v => (v instanceof GArray ? v : GArray.scalar(v));
export function arrayVal(rows, cols, data) {
  if (rows * cols > MAX_CELLS) throw ERR.Num;
  const a = GArray.new(rows, cols, data);
  if (!a) throw ERR.Calc;
  return a;
}
export function checkSize(rows, cols) {
  if (Number.isNaN(rows) || Number.isNaN(cols) || rows < 1 || cols < 1 || !Number.isFinite(rows) || !Number.isFinite(cols)) throw ERR.Value;
  const r = Math.trunc(rows), c = Math.trunc(cols);
  if (r > 1_048_576 || c > 16_384 || r * c > MAX_CELLS) throw ERR.Num;
  return [r, c];
}
export function flatten(args) {
  const out = [];
  for (const a of args) { if (a.value instanceof GArray) out.push(...a.value.data); else out.push(a.value); }
  return out;
}
/** Numbers of the arguments as SUM reads them (text and booleans in references are skipped). */
export function numbers(args) {
  const out = [];
  for (const a of args) {
    const v = a.value;
    if (v instanceof GArray) {
      for (const x of v.data) {
        if (typeof x === 'number') out.push(x);
        else if (x instanceof CellError) throw x;
      }
    } else if (v instanceof CellError) throw v;
    else if (typeof v === 'number') out.push(v);
    else if (a.fromRef || v === null || v === undefined) continue;
    else out.push(ok(toNumber(v)));
  }
  return out;
}
/** Numbers as the -A functions read them (text in references is 0, booleans count). */
export function numbersA(args) {
  const out = [];
  for (const a of args) {
    const v = a.value;
    if (v instanceof GArray) {
      for (const x of v.data) {
        if (typeof x === 'number') out.push(x);
        else if (typeof x === 'boolean') out.push(x ? 1 : 0);
        else if (typeof x === 'string') out.push(0);
        else if (x instanceof CellError) throw x;
      }
    } else if (v instanceof CellError) throw v;
    else if (v === null || v === undefined) continue;
    else if (typeof v === 'string' && a.fromRef) out.push(0);
    else out.push(ok(toNumber(v)));
  }
  return out;
}
export function arrayNumbers(v) {
  const out = [];
  if (v instanceof GArray) {
    for (const x of v.data) { if (typeof x === 'number') out.push(x); else if (x instanceof CellError) throw x; }
  } else if (typeof v === 'number') out.push(v);
  else if (v instanceof CellError) throw v;
  else if (v !== null && v !== undefined) out.push(ok(toNumber(v)));
  return out;
}

/** Round half away from zero at `digits` decimals, on the 15-significant-digit decimal form (util.rs). */
export function roundHalfAway(x, digits) {
  if (!Number.isFinite(x) || x === 0) return x;
  const dg = Math.max(-400, Math.min(400, Math.trunc(digits)));
  const s = Math.abs(x).toExponential(14);
  const [mant, exp] = s.split('e');
  const e = Number(exp);
  const d = mant.replace('.', '').split('').map(Number);
  const keep = e + 1 + dg;
  if (keep >= d.length) return toSigDigits(x, d.length);
  if (keep < 0) return 0;
  const roundUp = d[keep] >= 5;
  d.length = keep;
  let exp10 = e + 1;
  if (roundUp) {
    let i = keep;
    for (;;) {
      if (i === 0) { d.unshift(1); exp10++; break; }
      i--;
      if (d[i] === 9) d[i] = 0; else { d[i]++; break; }
    }
  }
  if (!d.length) return 0;
  const r = Number(`0.${d.join('')}e${exp10}`);
  return x < 0 ? -r : r;
}
export function toSigDigits(x, sig) {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toExponential(Math.min(30, Math.max(0, sig - 1))));
}

/** A literal argument / an argument read from a reference (tests and the evaluator). */
export const val = value => ({value, fromRef: false});
export const ref = value => ({value, fromRef: true});
