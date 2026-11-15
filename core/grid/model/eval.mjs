// The formula evaluator: references, names, tables, LET/LAMBDA, dynamic arrays, the special forms
// (IF, CHOOSE, INDEX, OFFSET, INDIRECT, SUBTOTAL, TEXT...) and the operators.
// Translated from gridcraft crates/calc/src/eval.rs, eval/{array.rs, call.rs, lambda.rs,
// reference_fns.rs, special.rs, format.rs} and trimrange.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Expressions evaluate to an Ev: a value, a `Ref` (one or more areas, kept unresolved so ROW,
// OFFSET, INDEX and `:` work on references) or a `Lambda`. Cell reads go through the host (the
// recalculation pass, calc.mjs), which evaluates dirty precedents on demand. The native-stack
// budget of upstream is a depth budget here (JS has no stack-position probe).
// No DOM, no Node built-ins.

import {CellError, ERR, GArray, compare, toNumber, toText, toBool, num as numValue, scalar} from '../lib/value.mjs';
import {MAX_ROWS, MAX_COLS, colToLetters, unquoteSheet, range as mkRange, rangeOf, isSingle, height, width, union, intersection, contains, count as rangeCount, isFullRows, isFullCols, rangeA1} from '../lib/addr.mjs';
import {parse, parseName, refRange, sameName, shiftRelative, shiftRelativeWrapping, hasRelativeRefs, walk, FormulaError} from '../lib/formula.mjs';
import {textFunction} from '../lib/numfmt.mjs';
import {lookup, call as callFn, aggregateValues, aggregateValuesK} from './functions/index.mjs';

export const MAX_CELLS = 16_000_000;
const FULL_SIZE_CELLS = 16_384;
const FULL_SIZE_BOUNDED_CELLS = 1_048_576;
const MAX_DEPTH = 400;
const LAMBDA_FUEL = MAX_CELLS;
const MAX_LAMBDA_CALLS = 140;
/** Evaluation depth one formula (and those it computes on demand) may use: the JS stack budget. */
export const STACK_BUDGET = 1800;

/** A reference: one or more areas {sheet, range}. */
export class Ref { constructor(areas) { this.areas = areas; } }
export class Lambda { constructor(params, body, env) { this.params = params; this.body = body; this.env = env; } }
const isRef = e => e instanceof Ref;
const isLambda = e => e instanceof Lambda;

// ---------------------------------------------------------------------------------------------
// array.rs: operators and broadcasting

const broadcastDim = (a, b) => (a === 1 ? b : b === 1 ? a : Math.max(a, b));
export function zip2(a, b, fn) {
  if (a instanceof GArray && b instanceof GArray) {
    const rows = broadcastDim(a.rows, b.rows), cols = broadcastDim(a.cols, b.cols);
    if (rows * cols > MAX_CELLS) return ERR.Num;
    const data = new Array(rows * cols);
    let k = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[k++] = fn(a.getBroadcast(r, c), b.getBroadcast(r, c));
    return new GArray(rows, cols, data);
  }
  if (a instanceof GArray) return new GArray(a.rows, a.cols, a.data.map(v => fn(v, b)));
  if (b instanceof GArray) return new GArray(b.rows, b.cols, b.data.map(v => fn(a, v)));
  return fn(a, b);
}
function zip3(c, t, f, g) {
  const dims = v => (v instanceof GArray ? [v.rows, v.cols] : [1, 1]);
  const [tr, tc] = dims(t), [fr, fc] = dims(f);
  const rows = broadcastDim(broadcastDim(c.rows, tr), fr), cols = broadcastDim(broadcastDim(c.cols, tc), fc);
  if (rows * cols > MAX_CELLS) return ERR.Num;
  const get = (v, r, col) => (v instanceof GArray ? v.getBroadcast(r, col) : v);
  const data = [];
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) data.push(g(c.getBroadcast(r, col), get(t, r, col), get(f, r, col)));
  return new GArray(rows, cols, data);
}
const single = v => (v instanceof GArray ? (v.rows * v.cols > 1 ? undefined : (v.data[0] ?? null)) : v);
function mapUnary(v, fn, plus, sys) {
  if (v instanceof GArray) return new GArray(v.rows, v.cols, v.data.map(x => mapUnary(x, fn, plus, sys)));
  if (v instanceof CellError) return v;
  if (typeof v === 'string' && plus) return v;
  const n = toNumber(v, sys);
  return n instanceof CellError ? n : fn(n);
}
export function binaryValues(op, x, y, sys) { return zip2(x, y, (a, b) => binaryScalar(op, a, b, sys)); }
function binaryScalar(op, a, b, sys) {
  if (a instanceof CellError) return a;
  if (b instanceof CellError) return b;
  const nums = fn => { const x = toNumber(a, sys); if (x instanceof CellError) return x; const y = toNumber(b, sys); if (y instanceof CellError) return y; return fn(x, y); };
  switch (op) {
    case '+': return nums((x, y) => numValue(x + y));
    case '-': return nums((x, y) => numValue(x - y));
    case '*': return nums((x, y) => numValue(x * y));
    case '/': return nums((x, y) => (y === 0 ? ERR.Div0 : numValue(x / y)));
    case '^': return nums((x, y) => (x === 0 && y === 0 ? ERR.Num : x === 0 && y < 0 ? ERR.Div0 : numValue(x ** y)));
    case '&': {
      const x = toText(a); if (x instanceof CellError) return x;
      const y = toText(b); if (y instanceof CellError) return y;
      return x.length + y.length > 32767 * 4 ? ERR.Value : x + y;
    }
    case '=': return compare(a, b) === 0;
    case '<>': return compare(a, b) !== 0;
    case '<': return compare(a, b) < 0;
    case '>': return compare(a, b) > 0;
    case '<=': return compare(a, b) <= 0;
    case '>=': return compare(a, b) >= 0;
    default: return ERR.Value;
  }
}

// Aggregates that fold a reference without building an array (SUM, COUNT, AVERAGE).
const AGG = {SUM: 'sum', COUNT: 'count', AVERAGE: 'average'};

// ---------------------------------------------------------------------------------------------
// special.rs

export const SPECIAL_FUNCTIONS = Object.freeze(['IF', 'IFS', 'IFERROR', 'IFNA', 'CHOOSE', 'SWITCH', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'AREAS', 'ISREF',
  'ISFORMULA', 'FORMULATEXT', 'SHEET', 'SHEETS', 'OFFSET', 'INDIRECT', 'INDEX', 'CELL', 'TRIMRANGE', 'SUBTOTAL', 'AGGREGATE', 'TEXT', 'LET',
  'LAMBDA', 'ISOMITTED', 'MAP', 'REDUCE', 'SCAN', 'BYROW', 'BYCOL', 'MAKEARRAY']);
const SPECIAL_SET = new Set(SPECIAL_FUNCTIONS);
export const isSpecial = n => SPECIAL_SET.has(n);
export const isKnownFunction = n => isSpecial(String(n).toUpperCase()) || !!lookup(n);
const resizesSumRange = (name, n) => n === 3 && (name === 'SUMIF' || name === 'AVERAGEIF');
/** The range SUMIF/AVERAGEIF add up: the sum range's top-left, sized like the criteria range. */
export function resizedSumRange(sum, h, w) {
  return rangeOf(sum.start.row, sum.start.col, Math.min(sum.start.row + Math.max(h - 1, 0), MAX_ROWS - 1), Math.min(sum.start.col + Math.max(w - 1, 0), MAX_COLS - 1));
}
function evShape(ev) {
  if (isRef(ev)) return ev.areas.length === 1 ? [height(ev.areas[0].range), width(ev.areas[0].range)] : null;
  if (ev instanceof GArray) return [ev.rows, ev.cols];
  if (isLambda(ev)) return null;
  return [1, 1];
}

/**
 * The static precedents of a formula on sheet `si` with sheets resolved through `wb`, and whether
 * it reads references only known while evaluating (INDIRECT, OFFSET, names, tables...).
 */
export function precedents(wb, si, e) {
  const out = [];
  let dynamic = false;
  const push = (r, range) => {
    const s = r.sheet;
    if (s.k === 'cur') out.push({sheet: si, range});
    else if (s.k === 'named') { const i = wb.sheetIndex(s.name); if (i >= 0) out.push({sheet: i, range}); }
    else {
      const i = wb.sheetIndex(s.a), j = wb.sheetIndex(s.b);
      if (i >= 0 && j >= 0) for (let k = Math.min(i, j); k <= Math.max(i, j); k++) out.push({sheet: k, range});
    }
  };
  walk(e, x => {
    if (x.t === 'ref') push(x, refRange(x));
    else if (x.t === 'call' && resizesSumRange(x.name, x.args.length)) {
      const [c, , s] = x.args;
      if (c.t === 'ref' && s.t === 'ref') { const cr = refRange(c); push(s, resizedSumRange(refRange(s), height(cr), width(cr))); }
      else if (!['num', 'str', 'bool', 'err', 'array', 'missing'].includes(s.t)) dynamic = true;
    } else if (x.t === 'call' && ['INDIRECT', 'OFFSET', 'NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'RANDARRAY', 'CELL', 'INFO'].includes(x.name)) dynamic = true;
    else if (x.t === 'name' || x.t === 'struct') dynamic = true;
    else if (x.t === 'call' && !lookup(x.name) && !isSpecial(x.name)) dynamic = true;
    else if (x.t === 'binary' && x.op === ':' && !(x.a.t === 'ref' && x.b.t === 'ref')) {
      const inner = [...precedents(wb, si, x.a)[0], ...precedents(wb, si, x.b)[0]];
      const boxes = [];
      for (const a of inner) {
        const box = boxes.find(b => b.sheet === a.sheet);
        if (box) box.range = union(box.range, a.range); else boxes.push({...a});
      }
      out.push(...boxes);
    }
  });
  return [out, dynamic];
}

/** CELL("format") code for a number format. */
function cellFormatCode(code) {
  const c = code.toLowerCase();
  const decimals = () => { const i = c.indexOf('.'); if (i < 0) return 0; let n = 0; while (c[i + 1 + n] === '0') n++; return n; };
  if (c === 'general') return 'G';
  if (c.includes('%')) return `P${decimals()}`;
  if (c.includes('e') && c.includes('0')) return `S${decimals()}`;
  if (c.includes('$')) return `C${decimals()}`;
  if (c.includes('y') || c.includes('d')) return 'D1';
  if (c.includes('h')) return 'D9';
  if (c.includes(',')) return `,${decimals()}`;
  return `F${decimals()}`;
}
const sameKind = (a, b) => typeTag(a) === typeTag(b) || a === null || a === undefined || b === null || b === undefined;
const typeTag = v => (v === null || v === undefined ? 'e' : typeof v === 'object' ? (v instanceof CellError ? 'x' : 'a') : typeof v);

/** R1C1 reference text → A1 text (INDIRECT(…, FALSE)). null: not R1C1; throws #REF! past the sheet. */
export function r1c1ToA1(s, at) {
  const bang = s.lastIndexOf('!');
  const sheet = bang >= 0 ? s.slice(0, bang + 1) : '', body = bang >= 0 ? s.slice(bang + 1) : s;
  const conv = part => {
    const u = part.toUpperCase();
    if (!u.startsWith('R')) return null;
    const ci = u.indexOf('C', 1);
    if (ci < 0) return null;
    const rp = u.slice(1, ci), cp = u.slice(ci + 1);
    const numPart = (p, base, max) => {
      let v, absolute;
      if (p === '') { v = base; absolute = false; }
      else if (p.startsWith('[') && p.endsWith(']')) { const d = Number(p.slice(1, -1)); if (!/^[+-]?\d+$/.test(p.slice(1, -1))) return null; v = base + d; absolute = false; }
      else { if (!/^\d+$/.test(p)) return null; const n = Number(p); if (n < 1) return {past: true}; v = n - 1; absolute = true; }
      return v >= 0 && v < max ? {v, absolute} : {past: true};
    };
    const r = numPart(rp, at.row, MAX_ROWS), c = numPart(cp, at.col, MAX_COLS);
    if (!r || !c) return null;
    if (r.past || c.past) throw ERR.Ref;
    return `${c.absolute ? '$' : ''}${colToLetters(c.v)}${r.absolute ? '$' : ''}${r.v + 1}`;
  };
  const colon = body.indexOf(':');
  let out;
  if (colon >= 0) {
    const x = conv(body.slice(0, colon)), y = conv(body.slice(colon + 1));
    if (x === null || y === null) return null;
    out = `${x}:${y}`;
  } else { out = conv(body); if (out === null) return null; }
  return sheet + out;
}

// ---------------------------------------------------------------------------------------------
// The evaluator

/** Function context handed to the library (gridcraft `FnCtx`). */
class FnCtx {
  constructor(ev, criteria = null, lambda = null) { this.ev = ev; this.criteria = criteria; this.lambda = lambda; }
  dateSystem() { return this.ev.host.wb.dateSystem; }
  nowSerial() { return this.ev.host.nowSerial(); }
  random() { return this.ev.host.random(); }
  hasLambda() { return !!this.lambda; }
  callLambda(arg) {
    const l = this.lambda;
    if (!l) return undefined;
    if (l.params.length !== 1) return ERR.Value;
    const r = this.ev.derefEv(this.ev.callLambdaValues(l, [[l.params[0], arg]]));
    return r instanceof GArray && r.data.length !== 1 ? ERR.Calc : scalar(r);
  }
  computedCriterion(row, col, db, record) {
    const area = this.criteria;
    if (!area) return undefined;
    const at = {row: area.range.start.row + row, col: area.range.start.col + col};
    if (!contains(area.range, at)) return undefined;
    const text = this.ev.host.formulaText(area.sheet, at.row, at.col);
    if (text === null) return undefined;
    let expr;
    try { expr = parse(text); } catch { return undefined; }
    const shifted = shiftRelative(expr, record - 1, 0);
    const env = [];
    for (let c = 0; c < db.cols; c++) {
      const h = db.get(0, c);
      if (typeof h === 'string' && h.trim()) env.push([h.trim(), db.get(record, c) ?? null]);
    }
    const ev = new Evaluator(this.ev.host, area.sheet, at);
    ev.env = env; ev.depth = this.ev.depth; ev.calls = this.ev.calls; ev.fuel = this.ev.fuel;
    const v = toBool(scalar(ev.value(shifted)));
    this.ev.fuel = ev.fuel;
    return v === true;
  }
}

export class Evaluator {
  /** host: the recalculation pass (calc.mjs PassHost) or any object with the same reads. */
  constructor(host, sheet, at) {
    this.host = host; this.sheet = sheet; this.at = at;
    this.env = []; this.depth = 0; this.calls = 0; this.fuel = LAMBDA_FUEL;
  }

  /** Evaluates to a value (references dereferenced; multi-cell → array). */
  value(e) { return this.derefEv(this.eval(e)); }

  resolveSheet(s) {
    const wb = this.host.wb;
    if (s.k === 'cur') return [this.sheet];
    if (s.k === 'named') { const i = wb.sheetIndex(s.name); if (i < 0) throw ERR.Ref; return [i]; }
    const i = wb.sheetIndex(s.a), j = wb.sheetIndex(s.b);
    if (i < 0 || j < 0) throw ERR.Ref;
    const out = [];
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) out.push(k);
    return out;
  }
  referenceAreas(r) { const range = refRange(r); return this.resolveSheet(r.sheet).map(sheet => ({sheet, range})); }

  derefEv(ev) {
    if (isRef(ev)) return ev.areas.length === 1 ? this.areaValue(ev.areas[0]) : ERR.Value;
    if (isLambda(ev)) return ERR.Calc;
    return ev;
  }
  areaValue(a) {
    if (isSingle(a.range)) return this.host.cellValue(a.sheet, a.range.start.row, a.range.start.col);
    const cells = height(a.range) * width(a.range);
    const toEdge = a.range.end.row === MAX_ROWS - 1 || a.range.end.col === MAX_COLS - 1;
    const full = cells <= FULL_SIZE_CELLS || (!toEdge && cells <= FULL_SIZE_BOUNDED_CELLS);
    const range = full ? a.range : this.trim(a);
    const h = height(range), w = width(range);
    if (h * w > MAX_CELLS) return ERR.Num;
    return GArray.new(h, w, this.host.rangeValues(a.sheet, range)) ?? ERR.Value;
  }
  /** Trims the bottom/right of an area to the sheet's used range. */
  trim(a) {
    if (!this.host.wb.sheets[a.sheet]) return a.range;
    const used = this.host.usedRange(a.sheet);
    let r1 = a.range.end.row, c1 = a.range.end.col;
    if (used) { r1 = Math.min(r1, Math.max(used.end.row, a.range.start.row)); c1 = Math.min(c1, Math.max(used.end.col, a.range.start.col)); }
    else { r1 = a.range.start.row; c1 = a.range.start.col; }
    return mkRange(a.range.start, {row: r1, col: c1});
  }

  eval(e) {
    const host = this.host;
    host.evalDepth = (host.evalDepth ?? 0) + 1;
    try {
      if (host.evalDepth > STACK_BUDGET) { host.stackExhausted?.(); return ERR.Num; }
      if (++this.depth > MAX_DEPTH) return ERR.Num;
      try { return this.evalInner(e); } catch (x) { if (x instanceof CellError) return x; throw x; } finally { this.depth--; }
    } finally { host.evalDepth--; }
  }
  evalInner(e) {
    switch (e.t) {
      case 'num': return numValue(e.v);
      case 'str': return e.v;
      case 'bool': return e.v;
      case 'err': return e.v;
      case 'missing': return null;
      case 'paren': return this.eval(e.x);
      case 'array': {
        const h = e.rows.length, w = e.rows[0]?.length ?? 0, data = [];
        for (const row of e.rows) for (const el of row) data.push(this.value(el));
        return GArray.new(h, w, data) ?? ERR.Value;
      }
      case 'ref': return new Ref(this.referenceAreas(e));
      case 'name': return this.name(e.v);
      case 'struct': return this.structured(e);
      case 'unary': return this.unary(e);
      case 'binary': return this.binary(e.op, e.a, e.b);
      case 'call': return this.call(e.name, e.args);
      case 'invoke': {
        const fn = this.eval(e.callee);
        if (isLambda(fn)) return this.applyLambda(fn, e.args);
        if (fn instanceof CellError) return fn;
        return ERR.Value;
      }
      default: return ERR.Value;
    }
  }

  name(n) {
    for (let i = this.env.length - 1; i >= 0; i--) if (sameName(this.env[i][0], n)) return this.env[i][1];
    const wb = this.host.wb;
    let scopeSheet = this.sheet, bare = n;
    const bang = n.indexOf('!');
    if (bang >= 0) {
      const i = wb.sheetIndex(unquoteSheet(n.slice(0, bang)));
      if (i < 0) return ERR.Name;
      scopeSheet = i; bare = n.slice(bang + 1);
    }
    const def = wb.name(bare, scopeSheet);
    if (def) {
      const scope = def.scope ? wb.sheetIndex(def.scope) : this.sheet;
      let expr;
      try { expr = parseName(def.formula.replace(/^=/, '')); } catch { return ERR.Name; }
      if (hasRelativeRefs(expr)) expr = shiftRelativeWrapping(expr, this.at.row, this.at.col);
      const saved = this.sheet;
      this.sheet = scope >= 0 ? scope : this.sheet;
      try { return this.eval(expr); } finally { this.sheet = saved; }
    }
    const t = wb.table(bare);
    if (t && t.data) return new Ref([{sheet: t.sheet, range: t.data}]);
    return ERR.Name;
  }

  structured(s) {
    const wb = this.host.wb;
    const t = s.table ? wb.table(s.table) : wb.tableAt(this.sheet, this.at);
    if (!t) return ERR.Ref;
    let r0 = t.range.start.row, r1 = t.range.end.row;
    const items = s.specifiers;
    if (!items.length || (items.length === 1 && items[0] === 'data')) {
      if (!t.data) return ERR.Ref;
      r0 = t.data.start.row; r1 = t.data.end.row;
    } else if (items.includes('thisRow')) {
      if (this.at.row < t.range.start.row || this.at.row > t.range.end.row) return ERR.Value;
      r0 = r1 = this.at.row;
    } else if (!items.includes('all')) {
      let lo = Infinity, hi = -1;
      const add = (a, b) => { lo = Math.min(lo, a); hi = Math.max(hi, b); };
      if (items.includes('headers')) { if (!t.headerRow) return ERR.Ref; add(t.range.start.row, t.range.start.row); }
      if (items.includes('data') && t.data) add(t.data.start.row, t.data.end.row);
      if (items.includes('totals')) { if (!t.totalsRow) return ERR.Ref; add(t.range.end.row, t.range.end.row); }
      if (lo > hi) return ERR.Ref;
      r0 = lo; r1 = hi;
    }
    let c0 = t.range.start.col, c1 = t.range.end.col;
    if (s.colStart !== null) {
      const i = t.columnIndex(s.colStart);
      if (i < 0) return ERR.Ref;
      c0 = c1 = t.range.start.col + i;
      if (s.colEnd !== null) {
        const j = t.columnIndex(s.colEnd);
        if (j < 0) return ERR.Ref;
        const cj = t.range.start.col + j;
        c0 = Math.min(c0, cj); c1 = Math.max(c1, cj);
      }
    }
    return new Ref([{sheet: t.sheet, range: rangeOf(r0, c0, r1, c1)}]);
  }

  unary(e) {
    const {op, x} = e;
    if (op === 'trim') return this.trimRef(e.mode, x);
    if (op === 'spill') {
      const ev = this.eval(x);
      if (isRef(ev) && ev.areas.length === 1 && isSingle(ev.areas[0].range)) {
        const a = ev.areas[0];
        const r = this.host.spillRange(a.sheet, a.range.start.row, a.range.start.col);
        return r ? new Ref([{sheet: a.sheet, range: r}]) : ERR.Ref;
      }
      if (ev instanceof CellError) return ev;
      return ERR.Ref;
    }
    if (op === 'at') {
      const ev = this.eval(x);
      if (isRef(ev)) {
        if (ev.areas.length !== 1) return ERR.Value;
        const a = ev.areas[0], c = this.implicitIntersect(a);
        return c ? this.host.cellValue(a.sheet, c.row, c.col) : ERR.Value;
      }
      if (isLambda(ev)) return ev;
      return scalar(ev);
    }
    const v = this.value(x), sys = this.host.wb.dateSystem;
    return mapUnary(v, n => (op === 'neg' ? numValue(-n) : op === 'percent' ? numValue(n / 100) : numValue(n)), op === 'plus', sys);
  }
  implicitIntersect(a) {
    const r = a.range;
    if (isSingle(r)) return r.start;
    if (width(r) === 1 && r.start.row <= this.at.row && this.at.row <= r.end.row) return {row: this.at.row, col: r.start.col};
    if (height(r) === 1 && r.start.col <= this.at.col && this.at.col <= r.end.col) return {row: r.start.row, col: this.at.col};
    return null;
  }

  binary(op, a, b) {
    if (op === ':') {
      const x = this.eval(a), y = this.eval(b);
      if (!isRef(x) || !isRef(y)) {
        if (x instanceof CellError) return x;
        if (y instanceof CellError) return y;
        return ERR.Value;
      }
      const all = [...x.areas, ...y.areas];
      if (!all.length) return ERR.Ref;
      if (all.some(ar => ar.sheet !== all[0].sheet)) return ERR.Value;
      let r = all[0].range;
      for (const ar of all) r = union(r, ar.range);
      return new Ref([{sheet: all[0].sheet, range: r}]);
    }
    if (op === ',') {
      const x = this.eval(a), y = this.eval(b);
      if (isRef(x) && isRef(y)) return new Ref([...x.areas, ...y.areas]);
      if (x instanceof CellError) return x;
      if (y instanceof CellError) return y;
      return ERR.Value;
    }
    if (op === ' ') {
      const x = this.eval(a), y = this.eval(b);
      if (isRef(x) && isRef(y)) {
        const out = [];
        for (const p of x.areas) for (const q of y.areas) if (p.sheet === q.sheet) { const i = intersection(p.range, q.range); if (i) out.push({sheet: p.sheet, range: i}); }
        return out.length ? new Ref(out) : ERR.Null;
      }
      if (x instanceof CellError) return x;
      if (y instanceof CellError) return y;
      return ERR.Value;
    }
    // A long chain A1+A2+… folds in a loop.
    const rest = [[op, b]];
    let left = a;
    while (left.t === 'binary' && ![':', ',', ' '].includes(left.op)) { rest.push([left.op, left.b]); left = left.a; }
    let acc = this.value(left);
    const sys = this.host.wb.dateSystem;
    while (rest.length) { const [o, r] = rest.pop(); acc = binaryValues(o, acc, this.value(r), sys); }
    return acc;
  }

  argEv(args, i) { return i < args.length ? this.eval(args[i]) : undefined; }
  argVal(args, i) { return i < args.length ? this.value(args[i]) : undefined; }
  argNum(args, i, d) {
    const a = args[i];
    if (a === undefined || a.t === 'missing') return d;
    const n = toNumber(scalar(this.value(a)));
    if (n instanceof CellError) throw n;
    return n;
  }

  // call.rs ---------------------------------------------------------------------------------
  call(name, args) {
    switch (name) {
      case 'IF': return this.ifCall(args);
      case 'IFS': {
        if (args.length < 2 || args.length % 2) return ERR.Value;
        for (let i = 0; i < args.length; i += 2) {
          const c = toBool(scalar(this.value(args[i])));
          if (c instanceof CellError) return c;
          if (c) return this.eval(args[i + 1]);
        }
        return ERR.NA;
      }
      case 'IFERROR': case 'IFNA': return this.ifErrorCall(name, args);
      case 'CHOOSE': return this.chooseCall(args);
      case 'SWITCH': return this.switchCall(args);
      case 'ROW': case 'COLUMN': return this.rowColumnCall(name, args);
      case 'ROWS': case 'COLUMNS': {
        if (args.length !== 1) return ERR.Value;
        const rows = name === 'ROWS';
        const ev = this.eval(args[0]);
        if (isRef(ev)) return ev.areas.length === 1 ? (rows ? height(ev.areas[0].range) : width(ev.areas[0].range)) : ERR.Ref;
        if (ev instanceof GArray) return rows ? ev.rows : ev.cols;
        if (ev instanceof CellError) return ev;
        if (isLambda(ev)) return ERR.Value;
        return 1;
      }
      case 'AREAS': {
        const ev = args.length ? this.eval(args[0]) : undefined;
        if (isRef(ev)) return ev.areas.length;
        return ev instanceof CellError ? ev : ERR.Value;
      }
      case 'ISREF': return args.length ? isRef(this.eval(args[0])) : false;
      case 'ISFORMULA': case 'FORMULATEXT': {
        const ev = args.length ? this.eval(args[0]) : undefined;
        if (!isRef(ev) || !ev.areas.length) return ERR.NA;
        const a = ev.areas[0];
        const f = this.host.formulaText(a.sheet, a.range.start.row, a.range.start.col);
        if (name === 'ISFORMULA') return f !== null;
        return f !== null ? `=${f}` : ERR.NA;
      }
      case 'SHEET': case 'SHEETS': return this.sheetCall(name, args);
      case 'OFFSET': return this.offset(args);
      case 'INDIRECT': return this.indirect(args);
      case 'INDEX': return this.index(args);
      case 'XLOOKUP': return this.xlookup(args);
      case 'CELL': return this.cellInfo(args);
      case 'TRIMRANGE': return this.trimrange(args);
      case 'SUBTOTAL': case 'AGGREGATE': return this.subtotal(name, args);
      case 'TEXT': {
        if (args.length !== 2) return ERR.Value;
        const v = this.argVal(args, 0) ?? null, fm = this.argVal(args, 1) ?? null, sys = this.host.wb.dateSystem;
        return zip2(v, fm, (x, y) => {
          if (x instanceof CellError) return x;
          const code = toText(y);
          if (code instanceof CellError) return code;
          try { return textFunction(x, code, sys); } catch (e) { if (e instanceof CellError) return e; throw e; }
        });
      }
      case 'LET': return this.let_(args);
      case 'LAMBDA': {
        if (!args.length) return ERR.Value;
        const params = [];
        for (const p of args.slice(0, -1)) { if (p.t !== 'name') return ERR.Value; params.push(p.v.replace(/^\[+|\]+$/g, '')); }
        return new Lambda(params, args[args.length - 1], this.env.slice());
      }
      case 'ISOMITTED': {
        const a = args[0];
        if (!a || a.t !== 'name') return false;
        for (let i = this.env.length - 1; i >= 0; i--) if (sameName(this.env[i][0], a.v)) { const v = this.env[i][1]; return v === null || v === undefined; }
        return false;
      }
      case 'MAP': case 'REDUCE': case 'SCAN': case 'BYROW': case 'BYCOL': case 'MAKEARRAY': return this.higherOrder(name, args);
      case 'NOW': case 'TODAY': case 'RAND': case 'RANDBETWEEN': case 'RANDARRAY':
        this.host.noteVolatile?.();
        return this.builtin(name, args);
      default: return this.builtin(name, args);
    }
  }
  ifCall(args) {
    if (!args.length || args.length > 3) return ERR.Value;
    const cond = this.argVal(args, 0) ?? null;
    if (cond instanceof GArray) {
      const t = args.length > 1 ? this.argVal(args, 1) : true, fl = args.length > 2 ? this.argVal(args, 2) : false;
      return zip3(cond, t ?? null, fl ?? null, (c, x, y) => { const b = toBool(c); return b instanceof CellError ? b : b ? x : y; });
    }
    const b = toBool(cond);
    if (b instanceof CellError) return b;
    const i = b ? 1 : 2;
    if (i >= args.length) return b;
    return args[i].t === 'missing' ? 0 : this.eval(args[i]);
  }
  ifErrorCall(name, args) {
    if (args.length !== 2) return ERR.Value;
    const value = this.argEv(args, 0) ?? null;
    const catches = e => name !== 'IFNA' || e === ERR.NA;
    const fix = arr => { const alt = scalar(this.argVal(args, 1) ?? null); return GArray.new(arr.rows, arr.cols, arr.data.map(v => (v instanceof CellError && catches(v) ? alt : v))) ?? ERR.Value; };
    if (value instanceof CellError && catches(value)) return this.eval(args[1]);
    if (value instanceof GArray && value.data.some(v => v instanceof CellError && catches(v))) return fix(value);
    if (isRef(value)) {
      const d = this.derefEv(value);
      if (d instanceof CellError && catches(d)) return this.eval(args[1]);
      if (d instanceof GArray && d.data.some(v => v instanceof CellError && catches(v))) return fix(d);
    }
    return value;
  }
  chooseCall(args) {
    if (args.length < 2) return ERR.Value;
    const index = this.value(args[0]);
    if (index instanceof GArray) {
      const spec = lookup('CHOOSE');
      const evaluated = [{value: index, fromRef: false}, ...args.slice(1).map(a => ({value: this.value(a), fromRef: false}))];
      return callFn(spec, evaluated, new FnCtx(this));
    }
    const n = toNumber(index);
    if (n instanceof CellError) return n;
    const i = Math.trunc(n);
    if (i < 1 || i >= args.length) return ERR.Value;
    return this.eval(args[i]);
  }
  switchCall(args) {
    if (args.length < 3) return ERR.Value;
    const value = scalar(this.argVal(args, 0) ?? null);
    if (value instanceof CellError) return value;
    const choices = args.slice(1);
    for (let i = 0; i + 1 < choices.length; i += 2) {
      const cand = scalar(this.value(choices[i]));
      if (!(cand instanceof CellError) && compare(value, cand) === 0 && sameKind(value, cand)) return this.eval(choices[i + 1]);
    }
    return choices.length % 2 === 1 ? this.eval(choices[choices.length - 1]) : ERR.NA;
  }
  rowColumnCall(name, args) {
    const isRow = name === 'ROW';
    if (!args.length || args[0].t === 'missing') return isRow ? this.at.row + 1 : this.at.col + 1;
    const ev = this.eval(args[0]);
    if (ev instanceof CellError) return ev;
    if (!isRef(ev)) return ERR.Value;
    if (!ev.areas.length) return ERR.Ref;
    const r = this.trimLines(ev.areas[0]);
    if (isRow) {
      const vals = []; for (let x = r.start.row; x <= r.end.row; x++) vals.push(x + 1);
      return vals.length === 1 ? vals[0] : GArray.column(vals);
    }
    const vals = []; for (let x = r.start.col; x <= r.end.col; x++) vals.push(x + 1);
    return vals.length === 1 ? vals[0] : GArray.row(vals);
  }
  sheetCall(name, args) {
    const isSheet = name === 'SHEET';
    if (!args.length) return isSheet ? this.sheet + 1 : this.host.wb.sheets.length;
    const ev = this.eval(args[0]);
    if (isRef(ev)) {
      if (isSheet) return ev.areas.length ? ev.areas[0].sheet + 1 : ERR.Ref;
      const s = []; for (const a of ev.areas) if (s[s.length - 1] !== a.sheet) s.push(a.sheet);
      return s.length;
    }
    if (typeof ev === 'string' && isSheet) { const i = this.host.wb.sheetIndex(ev); return i < 0 ? ERR.NA : i + 1; }
    return ERR.NA;
  }
  builtin(name, args) {
    const spec = lookup(name);
    if (!spec) {
      const ev = this.name(name);
      if (isLambda(ev)) return this.applyLambda(ev, args);
      if (ev instanceof CellError) return ev;
      return ERR.Name;
    }
    if (args.length < spec.minArgs || args.length > spec.maxArgs) return ERR.Value;
    const agg = AGG[spec.name];
    if (agg) return this.aggregate(agg, args);
    const evaluated = [];
    let criteriaShape = null, criteria = null, lambda = null;
    const lambdaAt = name === 'GROUPBY' ? 2 : name === 'PIVOTBY' ? 3 : -1;
    for (let i = 0; i < args.length; i++) {
      let ev = this.eval(args[i]);
      if (i === lambdaAt && isLambda(ev)) { lambda = ev; ev = null; }
      if (spec.category === 'Database' && i === 2 && isRef(ev) && ev.areas.length === 1) criteria = ev.areas[0];
      if (resizesSumRange(name, args.length)) {
        if (i === 0) criteriaShape = evShape(ev);
        else if (i === 2 && criteriaShape && isRef(ev) && ev.areas.length === 1) {
          const a = ev.areas[0];
          ev = new Ref([{sheet: a.sheet, range: resizedSumRange(a.range, criteriaShape[0], criteriaShape[1])}]);
        }
      }
      const fromRef = isRef(ev);
      let value;
      if (fromRef && ev.areas.length > 1) {
        const vals = [];
        for (const ar of ev.areas) { const v = this.areaValue(ar); if (v instanceof GArray) vals.push(...v.data); else vals.push(v); }
        value = GArray.row(vals);
      } else value = this.derefEv(ev);
      evaluated.push({value, fromRef});
    }
    return callFn(spec, evaluated, new FnCtx(this, criteria, lambda));
  }
  aggregate(kind, args) {
    const acc = {sum: 0, count: 0};
    let firstError = null;
    for (const a of args) {
      const ev = this.eval(a);
      const steps = isRef(ev) ? ev.areas.map(ar => this.aggregateArea(kind, ar, acc)) : [this.aggregateValue(kind, this.derefEv(ev), false, acc)];
      if (firstError === null) firstError = steps.find(s => s !== null) ?? null;
    }
    if (firstError !== null) return firstError;
    if (kind === 'sum') return numValue(acc.sum);
    if (kind === 'count') return acc.count;
    return acc.count === 0 ? ERR.Div0 : numValue(acc.sum / acc.count);
  }
  aggregateArea(kind, a, acc) {
    if (!isSingle(a.range)) {
      let error = null;
      const walked = this.host.visitRange(a.sheet, a.range, v => {
        if (typeof v === 'number') { acc.sum += v; acc.count++; return true; }
        if (v instanceof CellError && kind !== 'count') { error = v; return false; }
        return true;
      });
      if (walked) return error;
    }
    return this.aggregateValue(kind, this.areaValue(a), true, acc);
  }
  aggregateValue(kind, value, fromRef, acc) {
    const args = [{value, fromRef}];
    if (kind !== 'count') {
      const r = callFn(lookup('SUM'), args, new FnCtx(this));
      if (typeof r === 'number') acc.sum += r; else return r;
    }
    if (kind !== 'sum') {
      const r = callFn(lookup('COUNT'), args, new FnCtx(this));
      if (typeof r === 'number') acc.count += r; else return r;
    }
    return null;
  }
  /** A worksheet function given by name where a function is expected (BYROW(A1:C3,SUM)). */
  functionByName(e) {
    if (!e || e.t !== 'name') return null;
    if (this.env.some(([k]) => sameName(k, e.v)) || this.host.wb.name(e.v, this.sheet)) return null;
    const u = e.v.toUpperCase();
    return lookup(u) ? u : null;
  }

  // lambda.rs ------------------------------------------------------------------------------
  applyLambda(l, args) {
    const ok = args.length === l.params.length || (args.length === 0 && l.params.length === 1);
    if (!ok) return ERR.Value;
    const bound = l.params.map((p, i) => [p, args[i] === undefined || args[i].t === 'missing' ? null : this.eval(args[i])]);
    return this.callLambdaValues(l, bound);
  }
  callLambdaValues(l, bound) {
    if (this.calls >= MAX_LAMBDA_CALLS) return ERR.Num;
    if (this.fuel <= 0) return ERR.Calc;
    this.fuel--;
    this.calls++;
    const saved = this.env;
    this.env = [...l.env, ...bound];
    try { return this.eval(l.body); } finally { this.env = saved; this.calls--; }
  }
  let_(args) {
    if (args.length < 3 || args.length % 2 === 0) return ERR.Value;
    const base = this.env.length;
    try {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (args[i].t !== 'name') return ERR.Value;
        const v = this.eval(args[i + 1]);
        this.env.push([args[i].v, v]);
      }
      return this.eval(args[args.length - 1]);
    } finally { this.env.length = base; }
  }
  lambdaArg(e, arity) {
    const fnName = this.functionByName(e);
    if (fnName) {
      const params = Array.from({length: arity}, (_, i) => `_xleta.${i}`);
      return new Lambda(params, {t: 'call', name: fnName, args: params.map(p => ({t: 'name', v: p}))}, []);
    }
    if (!e) return null;
    const ev = this.eval(e);
    return isLambda(ev) ? ev : null;
  }
  higherOrder(name, args) {
    const asArr = v => (v instanceof GArray ? v : GArray.scalar(v));
    if (name === 'MAP') {
      if (args.length < 2) return ERR.Value;
      const l = this.lambdaArg(args[args.length - 1], args.length - 1);
      if (!l) return ERR.Value;
      const arrays = args.slice(0, -1).map(a => asArr(this.value(a)));
      const rows = Math.max(1, ...arrays.map(a => a.rows)), cols = Math.max(1, ...arrays.map(a => a.cols));
      if (rows * cols > MAX_CELLS) return ERR.Num;
      if (l.params.length !== arrays.length) return ERR.Value;
      const out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const one = single(this.derefEv(this.callLambdaValues(l, l.params.map((p, i) => [p, arrays[i].getBroadcast(r, c)]))));
        if (one === undefined) return ERR.Calc;
        out.push(one);
      }
      return GArray.new(rows, cols, out) ?? ERR.Calc;
    }
    if (name === 'REDUCE' || name === 'SCAN') {
      if (args.length !== 3) return ERR.Value;
      let acc = this.value(args[0]);
      const arr = asArr(this.value(args[1]));
      const l = this.lambdaArg(args[2], 2);
      if (!l || l.params.length !== 2) return ERR.Value;
      const scan = [];
      for (const v of arr.data) {
        acc = this.derefEv(this.callLambdaValues(l, [[l.params[0], acc], [l.params[1], v]]));
        if (name === 'SCAN') { const one = single(acc); if (one === undefined) return ERR.Calc; scan.push(one); }
      }
      return name === 'SCAN' ? GArray.new(arr.rows, arr.cols, scan) ?? ERR.Calc : acc;
    }
    if (name === 'BYROW' || name === 'BYCOL') {
      if (args.length !== 2) return ERR.Value;
      const arr = asArr(this.value(args[0]));
      const l = this.lambdaArg(args[1], 1);
      if (!l || l.params.length !== 1) return ERR.Value;
      const byRow = name === 'BYROW', n = byRow ? arr.rows : arr.cols, out = [];
      for (let i = 0; i < n; i++) {
        const slice = byRow ? Array.from({length: arr.cols}, (_, c) => arr.get(i, c) ?? null) : Array.from({length: arr.rows}, (_, r) => arr.get(r, i) ?? null);
        const one = single(this.derefEv(this.callLambdaValues(l, [[l.params[0], byRow ? GArray.row(slice) : GArray.column(slice)]])));
        if (one === undefined) return ERR.Calc;
        out.push(one);
      }
      return byRow ? GArray.column(out) : GArray.row(out);
    }
    if (name === 'MAKEARRAY') {
      if (args.length !== 3) return ERR.Value;
      const rows = Math.trunc(this.argNum(args, 0, 0)), cols = Math.trunc(this.argNum(args, 1, 0));
      if (rows < 1 || cols < 1 || rows * cols > MAX_CELLS) return ERR.Value;
      const l = this.lambdaArg(args[2], 2);
      if (!l || l.params.length !== 2) return ERR.Value;
      const out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const one = single(this.derefEv(this.callLambdaValues(l, [[l.params[0], r + 1], [l.params[1], c + 1]])));
        if (one === undefined) return ERR.Calc;
        out.push(one);
      }
      return GArray.new(rows, cols, out) ?? ERR.Calc;
    }
    return ERR.Name;
  }

  // reference_fns.rs ------------------------------------------------------------------------
  trimLines(a) { return isFullCols(a.range) || isFullRows(a.range) ? this.trim(a) : a.range; }
  offset(args) {
    this.host.noteVolatile?.();
    if (args.length < 3 || args.length > 5) return ERR.Value;
    const b = this.eval(args[0]);
    if (b instanceof CellError) return b;
    if (!isRef(b) || b.areas.length !== 1) return ERR.Value;
    const base = b.areas[0];
    const rows = Math.trunc(this.argNum(args, 1, 0)), cols = Math.trunc(this.argNum(args, 2, 0));
    const h = Math.trunc(this.argNum(args, 3, height(base.range))), w = Math.trunc(this.argNum(args, 4, width(base.range)));
    if (h === 0 || w === 0) return ERR.Ref;
    const r0 = base.range.start.row + rows, c0 = base.range.start.col + cols;
    const [ra, rb] = h > 0 ? [r0, r0 + h - 1] : [r0 + h + 1, r0];
    const [ca, cb] = w > 0 ? [c0, c0 + w - 1] : [c0 + w + 1, c0];
    if (ra < 0 || ca < 0 || rb >= MAX_ROWS || cb >= MAX_COLS) return ERR.Ref;
    return new Ref([{sheet: base.sheet, range: rangeOf(ra, ca, rb, cb)}]);
  }
  indirect(args) {
    this.host.noteVolatile?.();
    if (!args.length || args.length > 2) return ERR.Value;
    const t = toText(scalar(this.value(args[0])));
    if (t instanceof CellError) return t;
    let a1 = true;
    if (args[1] && args[1].t !== 'missing') { const b = toBool(scalar(this.value(args[1]))); a1 = b instanceof CellError ? true : b; }
    let text = t, a1ok = true;
    if (!a1) {
      const conv = r1c1ToA1(t, this.at);
      if (conv !== null) text = conv; else a1ok = false;
    }
    let e;
    try { e = parse(text); } catch { return ERR.Ref; }
    if (e.t === 'ref' && !a1ok) return ERR.Ref;
    if (e.t === 'ref' || e.t === 'name' || e.t === 'struct') { const r = this.eval(e); return isRef(r) ? r : ERR.Ref; }
    return ERR.Ref;
  }
  index(args) {
    if (!args.length || args.length > 4) return ERR.Value;
    const src = this.eval(args[0]);
    const arg = i => (args[i] === undefined || args[i].t === 'missing' ? undefined : this.value(args[i]));
    const rows = arg(1), cols = arg(2);
    const areaN = Math.trunc(this.argNum(args, 3, 1));
    const two = args.length === 2;
    const num = v => { if (v === undefined) return 0; const n = toNumber(v); if (n instanceof CellError) throw n; return Math.trunc(n); };
    if (rows instanceof GArray || cols instanceof GArray) {
      const asA = v => (v instanceof GArray ? v : GArray.scalar(v === undefined ? 0 : v));
      const ra = asA(rows), ca = asA(cols);
      const h = Math.max(ra.rows, ca.rows), w = Math.max(ra.cols, ca.cols);
      if (h * w > MAX_CELLS) return ERR.Num;
      const out = [];
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        let v;
        try {
          const d = this.derefEv(this.indexOne(src, num(ra.getBroadcast(r, c)), num(ca.getBroadcast(r, c)), areaN, two));
          v = d instanceof GArray && d.rows * d.cols > 1 ? ERR.Calc : scalar(d);
        } catch (e) { if (e instanceof CellError) v = e; else throw e; }
        out.push(v);
      }
      return GArray.new(h, w, out) ?? ERR.Value;
    }
    return this.indexOne(src, num(rows), num(cols), areaN, two);
  }
  indexOne(src, row, col, areaN, two) {
    if (row < 0 || col < 0) return ERR.Value;
    if (isRef(src)) {
      const a = src.areas[areaN - 1];
      if (!a || areaN < 1) return ERR.Ref;
      const r = a.range;
      if (two && height(r) > 1 && width(r) > 1) return ERR.Ref;
      const [rr, cc] = two && height(r) === 1 ? [1, row] : [row, col];
      if (rr > height(r) || cc > width(r)) return ERR.Ref;
      const [r0, r1] = rr === 0 ? [r.start.row, r.end.row] : [r.start.row + rr - 1, r.start.row + rr - 1];
      const [c0, c1] = cc === 0 ? [r.start.col, r.end.col] : [r.start.col + cc - 1, r.start.col + cc - 1];
      return new Ref([{sheet: a.sheet, range: rangeOf(r0, c0, r1, c1)}]);
    }
    if (src instanceof GArray) {
      const [rr, cc] = two && src.rows === 1 ? [1, row] : [row, col];
      if (rr > src.rows || cc > src.cols) return ERR.Ref;
      if (rr === 0 && cc === 0) return src;
      if (rr === 0) return GArray.column(Array.from({length: src.rows}, (_, r) => src.get(r, cc - 1) ?? null));
      if (cc === 0) return GArray.row(Array.from({length: src.cols}, (_, c) => src.get(rr - 1, c) ?? null));
      return src.get(rr - 1, cc - 1) ?? ERR.Ref;
    }
    if (src instanceof CellError) return src;
    if (isLambda(src)) return ERR.Value;
    return row <= 1 && col <= 1 ? src : ERR.Ref;
  }
  xlookup(args) {
    if (args.length >= 3 && args.length <= 6) {
      const look = this.eval(args[1]), ret = this.eval(args[2]);
      const spec = lookup('XMATCH');
      if (isRef(look) && isRef(ret) && look.areas.length === 1 && ret.areas.length === 1 && spec) {
        const key = this.value(args[0]);
        const l = look.areas[0], r = ret.areas[0];
        const vertical = width(l.range) === 1 && height(l.range) > 1, horizontal = height(l.range) === 1 && width(l.range) > 1;
        const sameLen = vertical ? height(r.range) === height(l.range) : width(r.range) === width(l.range);
        if (!(key instanceof GArray) && (vertical || horizontal) && sameLen) {
          const xargs = [{value: key, fromRef: false}, {value: this.areaValue(l), fromRef: true}];
          const given = i => args[i] !== undefined && args[i].t !== 'missing';
          const last = given(5) ? 5 : given(4) ? 4 : 3;
          for (let i = 4; i <= last; i++) xargs.push({value: given(i) ? this.value(args[i]) : 0, fromRef: false});
          const p = callFn(spec, xargs, new FnCtx(this));
          if (typeof p === 'number' && p >= 1) {
            const k = p - 1;
            const range = vertical ? rangeOf(r.range.start.row + k, r.range.start.col, r.range.start.row + k, r.range.end.col)
              : rangeOf(r.range.start.row, r.range.start.col + k, r.range.end.row, r.range.start.col + k);
            return new Ref([{sheet: r.sheet, range}]);
          }
          if (p === ERR.NA && args[3] && args[3].t !== 'missing') return this.eval(args[3]);
          if (p instanceof CellError) return p;
          return ERR.Value;
        }
      }
    }
    return this.builtin('XLOOKUP', args);
  }
  cellInfo(args) {
    const k = args.length ? toText(scalar(this.value(args[0]))) : ERR.Value;
    if (k instanceof CellError) return k;
    const kind = k.toLowerCase();
    let a;
    if (args.length > 1) { const ev = this.eval(args[1]); if (!isRef(ev)) return ERR.Value; a = ev.areas[0]; }
    else a = {sheet: this.sheet, range: rangeOf(this.at.row, this.at.col, this.at.row, this.at.col)};
    if (!a) return ERR.Ref;
    const c = a.range.start, wb = this.host.wb;
    switch (kind) {
      case 'address': return `$${colToLetters(c.col)}$${c.row + 1}`;
      case 'row': return c.row + 1;
      case 'col': return c.col + 1;
      case 'contents': return this.host.cellValue(a.sheet, c.row, c.col);
      case 'type': { const v = this.host.cellValue(a.sheet, c.row, c.col); return v === null || v === undefined ? 'b' : typeof v === 'string' ? 'l' : 'v'; }
      case 'width': return Math.round(wb.colChars(a.sheet, c.col));
      case 'filename': return wb.fileName(a.sheet);
      case 'sheetname': return wb.sheets[a.sheet]?.name ?? '';
      case 'protect': return wb.cellStyle(a.sheet, c.row, c.col).protection.locked ? 1 : 0;
      case 'format': return cellFormatCode(wb.cellStyle(a.sheet, c.row, c.col).numFmt);
      case 'color': case 'parentheses': return 0;
      case 'prefix': return '';
      default: return ERR.Value;
    }
  }
  subtotal(name, args) {
    const minArgs = name === 'AGGREGATE' ? 3 : 2;
    if (args.length < minArgs) return ERR.Value;
    const code = Math.trunc(this.argNum(args, 0, 0));
    let func, options, rest;
    if (name === 'AGGREGATE') { options = Math.trunc(this.argNum(args, 1, 0)); func = code; rest = args.slice(2); }
    else { const hidden = code > 100; func = hidden ? code - 100 : code; options = hidden ? 5 : 0; rest = args.slice(1); }
    if (!(func >= 1 && func <= 19) || (name === 'SUBTOTAL' && func > 11)) return ERR.Value;
    const skipHidden = [1, 3, 5, 7].includes(options), skipFiltered = name === 'SUBTOTAL', skipErrors = [2, 3, 6, 7].includes(options);
    const skipNested = name === 'SUBTOTAL' || options <= 3;
    let k;
    const refs = name === 'AGGREGATE' && func >= 14 ? rest.slice(0, 1) : rest;
    if (name === 'AGGREGATE' && func >= 14) k = rest[1] ? this.value(rest[1]) : undefined;
    const inputs = [];
    let budget = MAX_CELLS;
    for (const e of refs) {
      const ev = this.eval(e);
      if (isRef(ev)) {
        for (const a of ev.areas) { const range = this.trim(a); budget -= rangeCount(range); if (budget < 0) return ERR.Num; inputs.push([a.sheet, range]); }
      } else if (isLambda(ev)) return ERR.Value;
      else { budget -= ev instanceof GArray ? ev.data.length : 1; if (budget < 0) return ERR.Num; inputs.push(ev); }
    }
    const values = [];
    const wb = this.host.wb;
    for (const input of inputs) {
      if (Array.isArray(input)) {
        const [sheet, range] = input;
        for (let r = range.start.row; r <= range.end.row; r++) {
          const hidden = skipHidden ? wb.isRowHidden(sheet, r) : skipFiltered && wb.isRowFiltered(sheet, r);
          if (hidden) continue;
          for (let c = range.start.col; c <= range.end.col; c++) {
            if (skipNested) { const f = this.host.formulaText(sheet, r, c); if (f !== null && /SUBTOTAL\(|AGGREGATE\(/i.test(f)) continue; }
            const v = this.host.cellValue(sheet, r, c);
            if (skipErrors && v instanceof CellError) continue;
            values.push(v);
          }
        }
      } else if (input instanceof GArray) values.push(...input.data.filter(v => !(skipErrors && v instanceof CellError)));
      else values.push(input);
    }
    return k !== undefined ? aggregateValuesK(func, values, k) : aggregateValues(func, values);
  }

  // trimrange.rs ----------------------------------------------------------------------------
  trimrange(args) {
    if (!args.length || args.length > 3) return ERR.Value;
    const mode = i => {
      if (args[i] === undefined || args[i].t === 'missing') return [true, true];
      const v = scalar(this.value(args[i]));
      if (v instanceof CellError) throw v;
      const n = toNumber(v);
      if (n instanceof CellError) throw n;
      const t = Math.trunc(n);
      if (t === 0) return [false, false];
      if (t === 1) return [true, false];
      if (t === 2) return [false, true];
      if (t === 3) return [true, true];
      throw ERR.Value;
    };
    const rows = mode(1), cols = mode(2);
    return this.trimEv(this.eval(args[0]), rows, cols);
  }
  trimRef(m, x) {
    const flags = m === 'leading' ? [true, false] : m === 'trailing' ? [false, true] : [true, true];
    return this.trimEv(this.eval(x), flags, flags);
  }
  trimEv(ev, rows, cols) {
    const none = !rows[0] && !rows[1] && !cols[0] && !cols[1];
    const bounds = (values, w) => {
      let b = null;
      values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        const r = Math.floor(i / Math.max(w, 1)), c = i % Math.max(w, 1);
        b = b ? [[Math.min(b[0][0], r), Math.max(b[0][1], r)], [Math.min(b[1][0], c), Math.max(b[1][1], c)]] : [[r, r], [c, c]];
      });
      return b;
    };
    const keep = (len, nb, [lead, trail]) => [lead ? nb[0] : 0, trail ? nb[1] : Math.max(len - 1, 0)];
    if (isRef(ev)) {
      if (ev.areas.length !== 1) return ERR.Value;
      const a = ev.areas[0];
      if (none) return ev;
      const part = this.trim(a);
      const h = height(part), w = width(part);
      if (h * w > MAX_CELLS) return ERR.Num;
      const b = bounds(this.host.rangeValues(a.sheet, part), w);
      if (!b) return ERR.Calc;
      const [kr0, kr1] = keep(height(a.range), b[0], rows), [kc0, kc1] = keep(width(a.range), b[1], cols);
      return new Ref([{sheet: a.sheet, range: rangeOf(a.range.start.row + kr0, a.range.start.col + kc0, a.range.start.row + kr1, a.range.start.col + kc1)}]);
    }
    if (ev instanceof GArray) {
      if (none) return ev;
      const b = bounds(ev.data, ev.cols);
      if (!b) return ERR.Calc;
      const [kr0, kr1] = keep(ev.rows, b[0], rows), [kc0, kc1] = keep(ev.cols, b[1], cols);
      const data = [];
      for (let r = kr0; r <= kr1; r++) for (let c = kc0; c <= kc1; c++) data.push(ev.get(r, c) ?? null);
      return GArray.new(kr1 + 1 - kr0, kc1 + 1 - kc0, data) ?? ERR.Value;
    }
    if (ev instanceof CellError) return ev;
    if ((ev === null || ev === undefined) && !none) return ERR.Calc;
    if (isLambda(ev)) return ERR.Value;
    return ev;
  }
}

/** Parse a formula's text (without '=') to its tree, or null when it doesn't parse (#NAME?). */
export function parseFormula(text) {
  try { return parse(text); } catch (e) { if (e instanceof FormulaError) return null; throw e; }
}
export {rangeA1};
