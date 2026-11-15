// Table formulas (Table Layout › Data › Formula): `=SUM(ABOVE)`, cell references and ranges
// (`=SUM(B2:B4)`, `=A1*2`), arithmetic, comparisons and the functions Word offers in tables. A
// formula field is re-evaluated by Update Field (F9), so its result follows the cells it reads.
//
// Translated from wordcraft crates/engine/src/cmd/table_formula.rs (every function and the module
// tests, ported in tests/quill/upstream/table_formula_tests.test.mjs) and the `formula_instr` /
// `auto_formula_instr` part of crates/engine/src/cmd/table/convert.rs at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Cell references count rows from 1 at the top and columns from A at the left, by grid column.
// ABOVE, LEFT, RIGHT and BELOW sum the first run of numbers in that direction, as Word does: the
// cells next to the formula's cell are skipped while they hold no number (empty or text), then the
// numbers are summed up to the next cell that holds none. A function needs its arguments: `=SUM()`
// is a syntax error, as it is in Word. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MAX_COLS, MAX_ROWS, cellAtGrid, gridCol, tableCols} from '../model/table.mjs';
import {parseNumber as localeParse, formatNumber as localeFormat} from '../model/locale-number.mjs';
import * as P from '../model/para.mjs';
import {applyCaseSwitch, dollarText, fieldNumber, formatSwitch} from '../layout/fields.mjs';

/** The longest formula accepted, in bytes (UTF-8). */
export const MAX_FORMULA = 512;
const MAX_PICTURE = 64;
const MAX_DEPTH = 32;
/** The most cells one evaluation reads. */
export const MAX_CELL_VISITS = 100_000;

const syntax = msg => new CommandError('failed', `syntax error: ${msg}`);
const fail = msg => new CommandError('failed', msg);
const finite = x => { if (Number.isFinite(x)) return x; throw fail('the result is not a number'); };
const utf8Len = s => new TextEncoder().encode(s).length;

const cellTextOf = c => c.blocks.filter(b => b.kind === 'para').map(p => P.plainText(p)).join('\n');
const firstTextPara = c => c.blocks.find(b => b.kind === 'para' && P.plainText(b).trim() !== '') ?? null;

/** Evaluate `formula` (with or without its `=`) for the cell in row `r`, cell index `c`. */
export function evaluate(t, r, c, formula) { return evaluateWith(t, null, null, r, c, formula); }

/** evaluate with the document (cell languages via `paraLang(p)`) and the default language. */
export function evaluateWith(t, env, defaultLang, r, c, formula) {
  if (utf8Len(formula) > MAX_FORMULA) throw syntax(`the formula is longer than ${MAX_FORMULA} characters`);
  let body = formula.trim();
  if (body.startsWith('=')) body = body.slice(1);
  const parser = new Parser(tokenize(body));
  const expr = parser.compare();
  if (parser.pos !== parser.toks.length) throw syntax('unexpected text after the formula');
  const here = {t, env, defaultLang, r, c, g: gridCol(t, r, c), visits: 0};
  const v = evalExpr(expr, here);
  if (v.kind === 'num') return finite(v.x);
  throw syntax('a range or ABOVE/LEFT/RIGHT/BELOW needs a function, such as SUM');
}

/** The text a formula result shows: a whole number as is, otherwise two decimals (format_result). */
export const formatResult = v => localeFormat(v, null);

/** The text a formula field shows (evaluate_field). */
export function evaluateField(t, r, c, instr) { return evaluateFieldWith(t, null, null, r, c, instr); }

export function evaluateFieldWith(t, env, defaultLang, r, c, instr) {
  const [formula, sw] = splitSwitch(instr);
  const value = evaluateWith(t, env, defaultLang, r, c, formula);
  let text;
  const picture = sw === null ? null : pictureOf(sw);
  if (picture !== null) text = formatPicture(value, picture);
  else {
    let outLang = null;
    if (env) {
      const own = t.rows[r]?.cells[c];
      const p = own ? firstTextPara(own) : null;
      outLang = p ? env.paraLang(p) : null;
      if (!outLang) {
        let n = 0;
        outer: for (const row of t.rows) for (const cl of row.cells) {
          if (n++ >= 100) break outer;
          const q = firstTextPara(cl);
          const l = q ? env.paraLang(q) : null;
          if (l) { outLang = l; break outer; }
        }
      }
    }
    outLang = outLang ?? defaultLang ?? null;
    text = localeFormat(value, outLang);
  }
  return sw === null ? text : formatSwitches(sw, value, text);
}

/** Whether the `\*` number format `fmt` writes `value` (number_format_covers). */
export function numberFormatCovers(fmt, value) {
  let lo = 0, hi = 4_294_967_295;
  if (fmt === 'cardinalText' || fmt === 'ordinalText') hi = 999_999;
  else if (fmt === 'lowerRoman' || fmt === 'upperRoman') { lo = 1; hi = 50_000; } else if (fmt === 'lowerLetter' || fmt === 'upperLetter') { lo = 1; hi = 780; }
  return Number.isInteger(value) && value >= lo && value <= hi;
}

function formatSwitches(switches, value, text) {
  const unquoted = switches.split('"').filter((_, i) => i % 2 === 0).join(' ');
  let fmt = formatSwitch(unquoted);
  if (fmt === 'decimal') fmt = null;
  if (fmt === 'dollarText') return applyCaseSwitch(switches, dollarText(value) ?? text);
  if (fmt && numberFormatCovers(fmt, value)) return fieldNumber(switches, fmt, value >>> 0);
  return applyCaseSwitch(switches, text);
}

/** Split a field's `\#` / `\*` switches off its formula: [formula, switches | null] (split_switch). */
export function splitSwitch(instr) {
  const at = [instr.indexOf('\\#'), instr.indexOf('\\*')].filter(i => i >= 0);
  if (!at.length) return [instr, null];
  const i = Math.min(...at);
  return [instr.slice(0, i).trimEnd(), instr.slice(i)];
}

function pictureOf(sw) {
  const i = sw.indexOf('\\#');
  if (i < 0) return null;
  const rest = sw.slice(i + 2).trimStart();
  let pic = rest.startsWith('"') ? rest.slice(1).split('"')[0] ?? '' : rest.split(/\s+/)[0] ?? '';
  pic = [...pic].slice(0, MAX_PICTURE).join('');
  return pic ? pic : null;
}

/** Round half away from zero to `n` decimals (Rust `f64::round` on the scaled value). */
const roundAway = x => (x < 0 ? -Math.round(-x) : Math.round(x)) + 0;
const roundHalfAway = x => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));

/** The text of `value` under a numeric picture, as Word's `\#` pictures read (format_picture). */
export function formatPicture(value, picture) {
  const sections = picture.split(';');
  let section, x, minus;
  if (value < 0 && sections.length >= 2) { section = sections[1]; x = -value; minus = false; } else if (value === 0 && sections.length >= 3) { section = sections[2]; x = 0; minus = false; } else { section = sections[0]; x = Math.abs(value); minus = value < 0; }
  const start = section.search(/[#0]/);
  if (start < 0) return section;
  const rest = section.slice(start);
  let len = rest.search(/[^#0,.]/);
  if (len < 0) len = rest.length;
  const core = rest.slice(0, len), suffix = rest.slice(len);
  const prefix = section.slice(0, start);
  if (prefix.includes('%') || suffix.includes('%')) x *= 100;
  const dot = core.indexOf('.');
  const intPic = dot < 0 ? core : core.slice(0, dot);
  const fracPic = dot < 0 ? null : core.slice(dot + 1);
  const minInt = Math.min((intPic.match(/0/g) ?? []).length, MAX_PICTURE);
  const maxFrac = Math.min(fracPic === null ? 0 : (fracPic.match(/[0#]/g) ?? []).length, 15);
  const minFrac = Math.min(fracPic === null ? 0 : (fracPic.match(/0/g) ?? []).length, maxFrac);
  const scale = 10 ** maxFrac;
  const rounded = roundHalfAway(x * scale) / scale;
  if (!Number.isFinite(rounded)) return formatResult(value);
  const digits = rounded.toFixed(maxFrac);
  const [w0, dec0 = ''] = digits.split('.');
  let whole = w0 === '0' && minInt === 0 ? '' : w0.padStart(minInt, '0');
  if (intPic.includes(',')) whole = groupThousands(whole);
  let decimals = dec0;
  while (decimals.length > minFrac && decimals.endsWith('0')) decimals = decimals.slice(0, -1);
  let out = whole;
  if (decimals) out += `.${decimals}`;
  const sign = minus && rounded !== 0 ? '-' : '';
  return `${sign}${prefix}${out}${suffix}`;
}

function groupThousands(digits) {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/** A cell's number as a formula or a sort key reads it (parse_number). */
export function parseNumber(text, lang = null) {
  let t = String(text).trim();
  let negative = false;
  if (t.startsWith('(') && t.endsWith(')') && t.length >= 2) { t = t.slice(1, -1).trim(); negative = true; }
  const loc = localeParse(t, lang);
  if (loc !== null && loc !== undefined && !Number.isNaN(loc)) {
    const x = negative ? -Math.abs(loc) : loc;
    return Number.isFinite(x) ? x : null;
  }
  const cleaned = [...t].filter(c => !',$€£¥৳%'.includes(c) && !/\s/u.test(c)).join('');
  if (!cleaned || ![...cleaned].every(c => /[0-9.+\-eE]/.test(c))) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  let x = Number(cleaned);
  if (negative) x = -x;
  return Number.isFinite(x) ? x : null;
}

/** The number in a cell, if its text is one (cell_number_in). */
export const cellNumberIn = (c, lang) => parseNumber(cellTextOf(c), lang);

// ---- tokens and parser ------------------------------------------------------------------------

function tokenize(s) {
  const out = [];
  const ch = [...s];
  let i = 0;
  while (i < ch.length) {
    const c = ch[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let lit = '';
      while (i < ch.length && /[0-9.]/.test(ch[i])) lit += ch[i++];
      if (!/^(\d+\.?\d*|\.\d+)$/.test(lit)) throw syntax(`\`${lit}\` isn't a number`);
      out.push({k: 'num', x: Number(lit)});
    } else if (/[A-Za-z]/.test(c)) {
      let name = '';
      while (i < ch.length && /[A-Za-z0-9]/.test(ch[i])) name += ch[i++].toUpperCase();
      out.push({k: 'name', s: name});
    } else if ('+-*/^(),:'.includes(c)) { out.push({k: 'op', c}); i++; } else if ('<=>'.includes(c)) {
      i++;
      const n = ch[i];
      let op;
      if (c === '<' && n === '=') { op = '<='; i++; } else if (c === '<' && n === '>') { op = '<>'; i++; } else if (c === '>' && n === '=') { op = '>='; i++; } else op = c === '=' ? '=' : c;
      out.push({k: 'cmp', op});
    } else throw syntax(`\`${c}\` isn't part of a formula`);
  }
  return out;
}

class Parser {
  constructor(toks) { this.toks = toks; this.pos = 0; this.depth = 0; }
  peekOp(c) { const t = this.toks[this.pos]; return t?.k === 'op' && t.c === c; }
  eatOp(c) { const hit = this.peekOp(c); if (hit) this.pos++; return hit; }
  enter() { this.depth++; if (this.depth > MAX_DEPTH) throw syntax('the formula is nested too deeply'); }
  leave() { this.depth = Math.max(0, this.depth - 1); }
  compare() {
    const lhs = this.expr();
    const t = this.toks[this.pos];
    if (t?.k !== 'cmp') return lhs;
    this.pos++;
    const rhs = this.expr();
    return {k: 'cmp', op: t.op, a: lhs, b: rhs};
  }
  expr() {
    let lhs = this.term();
    for (;;) {
      const op = this.eatOp('+') ? '+' : this.eatOp('-') ? '-' : null;
      if (!op) return lhs;
      lhs = {k: 'bin', op, a: lhs, b: this.term()};
    }
  }
  term() {
    let lhs = this.power();
    for (;;) {
      const op = this.eatOp('*') ? '*' : this.eatOp('/') ? '/' : null;
      if (!op) return lhs;
      lhs = {k: 'bin', op, a: lhs, b: this.power()};
    }
  }
  power() {
    const base = this.unary();
    if (this.eatOp('^')) { this.enter(); const exp = this.power(); this.leave(); return {k: 'bin', op: '^', a: base, b: exp}; }
    return base;
  }
  unary() {
    if (this.eatOp('-')) { this.enter(); const inner = this.unary(); this.leave(); return {k: 'neg', a: inner}; }
    if (this.eatOp('+')) { this.enter(); const inner = this.unary(); this.leave(); return inner; }
    return this.primary();
  }
  primary() {
    const tok = this.toks[this.pos];
    if (!tok) throw syntax('the formula ends too soon');
    this.pos++;
    if (tok.k === 'num') return {k: 'num', x: tok.x};
    if (tok.k === 'op' && tok.c === '(') {
      this.enter();
      const inner = this.compare();
      if (!this.eatOp(')')) throw syntax('a `(` is missing its `)`');
      this.leave();
      return inner;
    }
    if (tok.k === 'name') {
      const name = tok.s;
      if (this.eatOp('(')) {
        this.enter();
        const args = [];
        if (!this.eatOp(')')) {
          for (;;) {
            args.push(this.compare());
            if (this.eatOp(')')) break;
            if (!this.eatOp(',')) throw syntax(`\`${name}\` needs \`,\` or \`)\` between its arguments`);
          }
        }
        this.leave();
        return {k: 'call', name, args};
      }
      const side = {ABOVE: 'above', LEFT: 'left', RIGHT: 'right', BELOW: 'below'}[name];
      if (side) return {k: 'side', side};
      if (name === 'TRUE' || name === 'FALSE') return {k: 'call', name, args: []};
      const ref = cellRef(name);
      if (!ref) throw syntax(`\`${name}\` isn't a cell reference or a function`);
      if (this.eatOp(':')) {
        const other = this.toks[this.pos];
        if (other?.k !== 'name') throw syntax('a range ends with a cell reference, such as B4');
        this.pos++;
        const ref2 = cellRef(other.s);
        if (!ref2) throw syntax(`\`${other.s}\` isn't a cell reference`);
        return {k: 'range', r0: Math.min(ref[0], ref2[0]), g0: Math.min(ref[1], ref2[1]), r1: Math.max(ref[0], ref2[0]), g1: Math.max(ref[1], ref2[1])};
      }
      return {k: 'cell', r: ref[0], g: ref[1], name};
    }
    if (tok.k === 'op') throw syntax(`\`${tok.c}\` is in the wrong place`);
    throw syntax(`\`${tok.op}\` is in the wrong place`);
  }
}

/** `B4` → [row 3, column 1] (cell_ref). */
export function cellRef(name) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(name);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) { col = col * 26 + (ch.charCodeAt(0) - 65 + 1); if (col > 1e9) return null; }
  col -= 1;
  const row = Number(m[2]) - 1;
  if (!Number.isSafeInteger(row) || row < 0) return null;
  return col < MAX_COLS && row < MAX_ROWS ? [row, col] : null;
}

// ---- evaluation --------------------------------------------------------------------------------

function visit(here, n) {
  here.visits += n;
  if (here.visits > MAX_CELL_VISITS) throw fail('Formula too complex');
}
function cellLang(here, c) {
  const p = here.env ? firstTextPara(c) : null;
  return (p ? here.env.paraLang(p) : null) ?? here.defaultLang ?? null;
}
const cellNumber = (here, c) => parseNumber(cellTextOf(c), cellLang(here, c));
function numberAt(here, r, g) {
  visit(here, 1);
  const ci = cellAtGrid(here.t, r, g);
  if (ci === null) return null;
  const c = here.t.rows[r]?.cells[ci];
  return c ? cellNumber(here, c) : null;
}

const num = x => ({kind: 'num', x});
const truth = b => (b ? 1 : 0);
function scalar(v) {
  if (v.kind === 'num') return finite(v.x);
  throw syntax('a range can only be used inside a function');
}

function evalExpr(e, here) {
  switch (e.k) {
    case 'num': return num(e.x);
    case 'cell': {
      const x = numberAt(here, e.r, e.g);
      if (x === null) throw fail(`${e.name} doesn't hold a number`);
      return num(x);
    }
    case 'range': {
      const v = [];
      const rEnd = Math.min(here.t.rows.length, e.r1 + 1), gEnd = Math.min(tableCols(here.t), e.g1 + 1);
      for (let row = e.r0; row < rEnd; row++) {
        let last = undefined;
        for (let g = e.g0; g < gEnd; g++) {
          const ci = cellAtGrid(here.t, row, g);
          if (ci !== null && ci === last) continue;
          last = ci;
          const x = numberAt(here, row, g);
          if (x !== null) v.push(x);
        }
      }
      return {kind: 'list', v};
    }
    case 'side': return {kind: 'list', v: sideNumbers(here, e.side)};
    case 'neg': return num(-scalar(evalExpr(e.a, here)));
    case 'bin': {
      const x = scalar(evalExpr(e.a, here)), y = scalar(evalExpr(e.b, here));
      if (e.op === '+') return num(x + y);
      if (e.op === '-') return num(x - y);
      if (e.op === '*') return num(x * y);
      if (e.op === '/') { if (y === 0) throw fail('division by zero'); return num(x / y); }
      return num(finite(x ** y));
    }
    case 'cmp': {
      const x = scalar(evalExpr(e.a, here)), y = scalar(evalExpr(e.b, here));
      const holds = {'=': x === y, '<>': x !== y, '<': x < y, '<=': x <= y, '>': x > y}[e.op] ?? x >= y;
      return num(truth(holds));
    }
    case 'call': return num(call(e.name, e.args, here));
    default: throw syntax('bad formula');
  }
}

function sideNumbers(here, side) {
  const out = [];
  let started = false;
  const take = v => { if (v !== null) { out.push(v); started = true; return true; } return !started; };
  if (side === 'above') {
    for (let row = here.r - 1; row >= 0; row--) if (!take(numberAt(here, row, here.g))) break;
  } else if (side === 'below') {
    for (let row = here.r + 1; row < here.t.rows.length; row++) if (!take(numberAt(here, row, here.g))) break;
  } else {
    const row = here.t.rows[here.r];
    if (!row) return out;
    visit(here, row.cells.length);
    const cells = row.cells.map(c => cellNumber(here, c));
    const order = [];
    if (side === 'left') for (let ci = here.c - 1; ci >= 0; ci--) order.push(ci);
    else for (let ci = here.c + 1; ci < cells.length; ci++) order.push(ci);
    for (const ci of order) if (!take(cells[ci] ?? null)) break;
  }
  return out;
}

function gather(args, here) {
  const all = [];
  for (const a of args) {
    const v = evalExpr(a, here);
    if (v.kind === 'num') all.push(finite(v.x)); else all.push(...v.v);
  }
  return all;
}
function one(name, args, here) {
  if (args.length !== 1) throw fail(`${name} takes one argument`);
  return scalar(evalExpr(args[0], here));
}

const NEEDS_ONE = new Set(['SUM', 'COUNT', 'AVERAGE', 'MAX', 'MIN', 'PRODUCT', 'ABS', 'INT', 'SIGN', 'ROUND', 'MOD', 'AND', 'OR', 'NOT', 'IF', 'DEFINED']);

function call(name, args, here) {
  if (!args.length && NEEDS_ONE.has(name)) throw syntax(`${name}() needs an argument`);
  switch (name) {
    case 'TRUE': case 'FALSE':
      if (args.length) throw fail(`${name} takes no arguments`);
      return truth(name === 'TRUE');
    case 'NOT': return truth(one(name, args, here) === 0);
    case 'AND': case 'OR': {
      const v = gather(args, here);
      if (!v.length) throw fail(`${name} has no numbers to test`);
      return truth(name === 'AND' ? v.every(x => x !== 0) : v.some(x => x !== 0));
    }
    case 'IF':
      if (args.length !== 3) throw fail('IF takes three arguments: a condition, the value when it is true, and the value when it is false');
      return scalar(evalExpr(args[0], here)) !== 0 ? scalar(evalExpr(args[1], here)) : scalar(evalExpr(args[2], here));
    case 'DEFINED':
      if (args.length !== 1) throw fail('DEFINED takes one argument');
      try { evalExpr(args[0], here); return 1; } catch { return 0; }
    case 'SUM': return gather(args, here).reduce((s, x) => s + x, 0);
    case 'COUNT': return gather(args, here).length;
    case 'AVERAGE': { const v = gather(args, here); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
    case 'MAX': { const v = gather(args, here); return v.length ? Math.max(...v) : 0; }
    case 'MIN': { const v = gather(args, here); return v.length ? Math.min(...v) : 0; }
    case 'PRODUCT': { const v = gather(args, here); return v.length ? v.reduce((s, x) => s * x, 1) : 1; }
    case 'ABS': return Math.abs(one(name, args, here));
    case 'INT': return Math.floor(one(name, args, here));
    case 'SIGN': { const x = one(name, args, here); return x === 0 ? 0 : Math.sign(x); }
    case 'ROUND': {
      if (args.length !== 2) throw fail('ROUND takes two arguments');
      const x = scalar(evalExpr(args[0], here));
      const digits = Math.trunc(Math.max(-15, Math.min(15, scalar(evalExpr(args[1], here)))));
      const scale = 10 ** digits;
      const scaled = x * scale;
      if (!Number.isFinite(scaled)) return finite(x);
      return finite(roundAway(scaled) / scale);
    }
    case 'MOD': {
      if (args.length !== 2) throw fail('MOD takes two arguments');
      const x = scalar(evalExpr(args[0], here)), y = scalar(evalExpr(args[1], here));
      if (y === 0) throw fail('division by zero');
      return x - y * Math.floor(x / y);
    }
    default: throw fail(`unknown formula function \`${name}\``);
  }
}

// ---- the formula a field stores (table/convert.rs) -----------------------------------------------

/** A formula as a field stores it: upper case, one leading `=`; switches kept as typed (formula_instr). */
export function formulaInstr(raw) {
  let body = raw.trim();
  if (body.startsWith('=')) body = body.slice(1);
  const [formula, sw] = splitSwitch(body);
  return sw !== null ? `=${formula.trim().toUpperCase()} ${sw}` : `=${formula.trim().toUpperCase()}`;
}

/** A bare function name takes its direction from the cell: ABOVE when a cell above holds a number, else LEFT. */
export function autoFormulaInstr(t, r, c, raw, lang) {
  const instr = formulaInstr(raw);
  const body = instr.startsWith('=') ? instr.slice(1) : instr;
  if (!body.includes('(') && ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'PRODUCT'].includes(body)) {
    const g = gridCol(t, r, c);
    let hasAbove = false;
    for (let row = r - 1; row >= 0 && !hasAbove; row--) {
      const ci = cellAtGrid(t, row, g);
      const cl = ci === null ? null : t.rows[row]?.cells[ci];
      if (cl && cellNumberIn(cl, lang) !== null) hasAbove = true;
    }
    return `=${body}(${hasAbove ? 'ABOVE' : 'LEFT'})`;
  }
  return instr;
}
