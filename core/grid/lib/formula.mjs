// The Excel formula language: tokenizer, parser, syntax tree, printer (A1 and R1C1) and reference
// adjustment for copy/fill and structural edits.
// Translated from gridcraft crates/formula/src/{lib.rs, ast.rs, lexer.rs, parser.rs, printer.rs,
// adjust.rs} at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Differences that are representation only: token spans are UTF-16 offsets (the editor's units)
// instead of UTF-8 bytes; the tree is plain objects tagged with `t`. Input syntax is en-US (the
// Spanish entry table of crates/formula/src/input.rs is not part of Arkemis's interface).
//
// Expr nodes:
//   {t:'num', v} {t:'str', v} {t:'bool', v} {t:'err', v: CellError} {t:'array', rows: Expr[][]}
//   {t:'ref', sheet, kind}   sheet: {k:'cur'} | {k:'named', name} | {k:'span', a, b}
//                            kind:  {k:'cell', a} | {k:'range', a, b} | {k:'rows', r0, a0, r1, a1} | {k:'cols', c0, a0, c1, a1}
//                            anchor a/b: {row, col, rowAbs, colAbs}
//   {t:'name', v} {t:'struct', table, specifiers, colStart, colEnd}
//   {t:'unary', op: 'neg'|'plus'|'percent'|'at'|'spill'|'trim', mode?: 'leading'|'trailing'|'all', x}
//   {t:'binary', op: '+'|'-'|'*'|'/'|'^'|'&'|'='|'<>'|'<'|'>'|'<='|'>='|':'|','|' ', a, b}
//   {t:'call', name, args} {t:'invoke', callee, args} {t:'missing'} {t:'paren', x}
// No DOM, no Node built-ins.

import {ERR, ALL_ERRORS, numberToText} from './value.mjs';
import {MAX_ROWS, MAX_COLS, lettersToCol, parseA1Prefix, quoteSheet, sheetNeedsQuotes, colToLetters, rangeOf, rowsRange, colsRange, range as mkRange, containsRange} from './addr.mjs';

export {quoteSheet, sheetNeedsQuotes};

/** Longest formula accepted, in characters (Excel's limit). */
export const MAX_FORMULA_LEN = 8192;
const MAX_DEPTH = 256;

export class FormulaError extends Error {
  constructor(msg, pos) { super(msg); this.name = 'FormulaError'; this.pos = pos; }
}

// ---------------------------------------------------------------------------------------------
// lib.rs: LET/LAMBDA name comparison

/** Case-folded form of a name (ß → ss, ſ → s, ς → σ). */
export function foldName(s) {
  return s.toLowerCase().replace(/ß/g, 'ss').replace(/ſ/g, 's').replace(/ς/g, 'σ');
}
/** Whether two LET/LAMBDA names are the same (case-insensitive in any script). */
export function sameName(a, b) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(a) && /^[\x00-\x7f]*$/.test(b)) return a.length === b.length && a.toLowerCase() === b.toLowerCase();
  return a === b || foldName(a) === foldName(b);
}

// ---------------------------------------------------------------------------------------------
// ast.rs

export const BINOPS = Object.freeze({
  ':': 90, ' ': 85, ',': 80, '^': 50, '*': 40, '/': 40, '+': 30, '-': 30, '&': 20, '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10,
});
export const TRIM_SYMBOL = Object.freeze({leading: '.:', trailing: ':.', all: '.:.'});
export const TRIM_CODE = Object.freeze({leading: 1, trailing: 2, all: 3});

export const anchorCell = a => ({row: a.row, col: a.col});

/** The range a reference covers. */
export function refRange(r) {
  const k = r.kind;
  switch (k.k) {
    case 'cell': return rangeOf(k.a.row, k.a.col, k.a.row, k.a.col);
    case 'range': return mkRange(anchorCell(k.a), anchorCell(k.b));
    case 'rows': return rowsRange(Math.min(k.r0, k.r1), Math.max(k.r0, k.r1));
    default: return colsRange(Math.min(k.c0, k.c1), Math.max(k.c0, k.c1));
  }
}

/** Visits every node depth-first, parents before children, left to right. */
export function walk(e, f) {
  const pending = [e];
  while (pending.length) {
    const x = pending.pop();
    f(x);
    switch (x.t) {
      case 'array': for (let i = x.rows.length - 1; i >= 0; i--) for (let j = x.rows[i].length - 1; j >= 0; j--) pending.push(x.rows[i][j]); break;
      case 'unary': case 'paren': pending.push(x.x); break;
      case 'binary': pending.push(x.b, x.a); break;
      case 'call': for (let i = x.args.length - 1; i >= 0; i--) pending.push(x.args[i]); break;
      case 'invoke': for (let i = x.args.length - 1; i >= 0; i--) pending.push(x.args[i]); pending.push(x.callee); break;
      default: break;
    }
  }
}

/** Rewrites every node bottom-up, children left to right before their parent. */
export function mapExpr(e, f) {
  const spine = [];
  let node = e;
  while (node.t === 'binary') { spine.push(node); node = node.a; }
  let out;
  switch (node.t) {
    case 'array': out = {t: 'array', rows: node.rows.map(r => r.map(x => mapExpr(x, f)))}; break;
    case 'unary': out = {...node, x: mapExpr(node.x, f)}; break;
    case 'paren': out = {t: 'paren', x: mapExpr(node.x, f)}; break;
    case 'call': out = {t: 'call', name: node.name, args: node.args.map(x => mapExpr(x, f))}; break;
    case 'invoke': out = {t: 'invoke', callee: mapExpr(node.callee, f), args: node.args.map(x => mapExpr(x, f))}; break;
    default: out = node;
  }
  let acc = f(out);
  while (spine.length) {
    const b = spine.pop();
    const right = mapExpr(b.b, f);
    acc = f({t: 'binary', op: b.op, a: acc, b: right});
  }
  return acc;
}

/** All references in the formula. */
export function references(e) {
  const v = [];
  walk(e, x => { if (x.t === 'ref') v.push(x); });
  return v;
}
/** Function names used (upper-case). */
export function functions(e) {
  const v = [];
  walk(e, x => { if (x.t === 'call') v.push(x.name); });
  return v;
}

/** Structural equality of two trees. */
export function exprEquals(a, b) { return print(a) === print(b) && JSON.stringify(a, rep) === JSON.stringify(b, rep); }
const rep = (k, v) => (v && typeof v === 'object' && typeof v.code === 'number' && typeof v.text === 'string' ? v.text : v);

function clampAnchor(row, col) {
  return row >= 0 && row < MAX_ROWS && col >= 0 && col < MAX_COLS ? [row, col] : null;
}

// ---------------------------------------------------------------------------------------------
// lexer.rs

const WORD = /[\p{Alphabetic}\p{N}_.$\\?]/u;
const isWordChar = c => c !== undefined && WORD.test(c);
const isAsciiDigit = c => c !== undefined && c >= '0' && c <= '9';
const isAsciiAlpha = c => c !== undefined && /^[A-Za-z]$/.test(c);
const isAsciiAlnum = c => isAsciiDigit(c) || isAsciiAlpha(c);

/** A word that can end a range (`A1`, `$A$1`, `A`, `$A`, `1`, `$1`). */
function isRangeEnd(w) {
  const s = w.startsWith('$') ? w.slice(1) : w;
  let k = 0;
  while (k < s.length && isAsciiAlpha(s[k])) k++;
  const letters = s.slice(0, k), rest = s.slice(k);
  const digits = letters ? (rest.startsWith('$') ? rest.slice(1) : rest) : rest;
  return letters.length <= 3 && (digits === '' ? letters.length > 0 && rest === '' : /^[0-9]+$/.test(digits));
}
const startsRangeEnd = c => isAsciiAlnum(c) || c === '$';

/**
 * Tokenizes formula text (without the leading `=`). Tokens: {tok, v?, v2?, start, end} with
 * tok in num str bool err word sheet func struct op lparen rparen lbrace rbrace comma semicolon
 * colon trim space eof; spans are UTF-16 offsets.
 */
export function tokenize(src) {
  // Characters with their UTF-16 offsets (a surrogate pair is one character).
  const chars = [];
  for (let i = 0; i < src.length;) {
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    chars.push([i, ch]);
    i += ch.length;
  }
  const n = chars.length;
  const posOf = i => (i < n ? chars[i][0] : src.length);
  const ch = i => (i < n ? chars[i][1] : undefined);
  const out = [];
  const emit = (tok, start, endI, extra) => out.push({tok, start, end: posOf(endI), ...extra});
  const lexErr = (msg, pos) => new FormulaError(msg, pos);
  const text = (i, j) => { let s = ''; for (let k = i; k < j; k++) s += chars[k][1]; return s; };
  let i = 0, arrayDepth = 0;

  const quoted = (i0, start) => {
    const quote = ch(i0);
    let value = '', j = i0 + 1;
    for (;;) {
      const c = ch(j);
      if (c === undefined) throw lexErr(quote === '"' ? 'unterminated text' : 'unterminated sheet name', start);
      if (c === quote && ch(j + 1) === quote) { value += quote; j += 2; continue; }
      if (c === quote) { j++; break; }
      value += c; j++;
    }
    if (quote === '"') { emit('str', start, j, {v: value}); return j; }
    if (ch(j) !== '!') throw lexErr('expected ! after sheet name', posOf(j));
    const k = value.indexOf(':');
    if (k >= 0) emit('sheet', start, j + 1, {v: value.slice(0, k), v2: value.slice(k + 1)});
    else emit('sheet', start, j + 1, {v: value, v2: null});
    return j + 1;
  };
  const errorLiteral = (i0, start) => {
    const rest = src.slice(start);
    const e = ALL_ERRORS.find(x => rest.slice(0, x.text.length).toUpperCase() === x.text);
    if (!e) throw lexErr('unknown error literal', start);
    const end = i0 + [...e.text].length;
    emit('err', start, end, {v: e});
    return end;
  };
  const structured = (i0, start) => {
    let depth = 0, j = i0;
    for (;;) {
      const c = ch(j);
      if (c === undefined) throw lexErr('unbalanced [', start);
      if (c === "'") { j += 2; continue; }
      if (c === '[') { depth++; j++; continue; }
      if (c === ']') { depth--; j++; if (depth === 0) break; continue; }
      j++;
    }
    emit('struct', start, j, {v: src.slice(posOf(i0 + 1), posOf(Math.max(0, j - 1)))});
    return j;
  };
  const number = (i0, start) => {
    let j = i0;
    while (isAsciiDigit(ch(j))) j++;
    // A row range `1:3` (also `1.:3`, `1:.3`, `1:$3`).
    let k = j;
    if (ch(k) === '.' && ch(k + 1) === ':') k++;
    let isRow = false;
    if (ch(k) === ':') {
      k++;
      if (ch(k) === '.') k++;
      if (ch(k) === '$') k++;
      isRow = isAsciiDigit(ch(k));
    }
    if (isRow) { emit('word', start, j, {v: text(i0, j)}); return j; }
    if (ch(j) === '.') { j++; while (isAsciiDigit(ch(j))) j++; }
    if (ch(j) === 'e' || ch(j) === 'E') {
      let e = j + 1;
      if (ch(e) === '+' || ch(e) === '-') e++;
      if (isAsciiDigit(ch(e))) { while (isAsciiDigit(ch(e))) e++; j = e; }
    }
    const t = src.slice(start, posOf(j));
    const v = Number(t);
    if (Number.isNaN(v)) throw lexErr(`bad number \`${t}\``, start);
    if (!Number.isFinite(v)) throw lexErr(`number too large \`${t}\``, start);
    emit('num', start, j, {v});
    return j;
  };
  const wordEnd = from => {
    let j = from;
    while (isWordChar(ch(j)) && !(arrayDepth > 0 && ch(j) === ',')) j++;
    return j;
  };
  const sheetRangeEnd = (value, colon) => {
    const end = wordEnd(colon + 1);
    const last = out[out.length - 1];
    const repeatsSheet = isRangeEnd(value) && last && last.tok === 'sheet' && last.v2 === null && sameName(text(colon + 1, end), last.v);
    return end > colon + 1 && ch(end) === '!' && !repeatsSheet;
  };
  const word = (i0, start) => {
    const j = wordEnd(i0);
    const value = text(i0, j);
    if (ch(j) === '!') { emit('sheet', start, j + 1, {v: value, v2: null}); return j + 1; }
    if (ch(j) === ':' && sheetRangeEnd(value, j)) {
      const end = wordEnd(j + 1);
      emit('sheet', start, end + 1, {v: value, v2: text(j + 1, end)});
      return end + 1;
    }
    if (ch(j) === '(') { emit('func', start, j + 1, {v: value}); return j + 1; }
    if (/^true$/i.test(value) && ch(j) !== '[') { emit('bool', start, j, {v: true}); return j; }
    if (/^false$/i.test(value) && ch(j) !== '[') { emit('bool', start, j, {v: false}); return j; }
    if (value.length > 1 && value.endsWith('.') && ch(j) === ':' && isRangeEnd(value.slice(0, -1))) {
      emit('word', start, j - 1, {v: value.slice(0, -1)});
      return j - 1;
    }
    emit('word', start, j, {v: value});
    return j;
  };

  while (i < n) {
    const start = posOf(i);
    const c = ch(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i;
      while ([' ', '\t', '\n', '\r'].includes(ch(j))) j++;
      emit('space', start, j);
      i = j;
    } else if (c === '"' || c === "'") i = quoted(i, start);
    else if (c === '#') {
      const last = out[out.length - 1];
      if (last && last.end === start && last.tok === 'word') { emit('op', start, i + 1, {v: '#'}); i++; }
      else i = errorLiteral(i, start);
    } else if (c === '[') i = structured(i, start);
    else if (c === '.' && ch(i + 1) === ':') {
      if (ch(i + 2) === '.' && startsRangeEnd(ch(i + 3))) { emit('trim', start, i + 3, {v: 'all'}); i += 3; }
      else { emit('trim', start, i + 2, {v: 'leading'}); i += 2; }
    } else if (isAsciiDigit(c) || (c === '.' && isAsciiDigit(ch(i + 1)))) i = number(i, start);
    else if (c === '(') { emit('lparen', start, i + 1); i++; }
    else if (c === ')') { emit('rparen', start, i + 1); i++; }
    else if (c === '{') { arrayDepth++; emit('lbrace', start, i + 1); i++; }
    else if (c === '}') { arrayDepth = Math.max(0, arrayDepth - 1); emit('rbrace', start, i + 1); i++; }
    else if (c === ',') { emit('comma', start, i + 1); i++; }
    else if (c === ';') { emit('semicolon', start, i + 1); i++; }
    else if (c === ':') {
      if (ch(i + 1) === '.' && startsRangeEnd(ch(i + 2))) { emit('trim', start, i + 2, {v: 'trailing'}); i += 2; }
      else { emit('colon', start, i + 1); i++; }
    } else if ('+-*/^&%@='.includes(c)) { emit('op', start, i + 1, {v: c}); i++; }
    else if (c === '<' || c === '>') {
      const two = ch(i + 1);
      const [op, len] = c === '<' && two === '=' ? ['<=', 2] : c === '<' && two === '>' ? ['<>', 2] : c === '>' && two === '=' ? ['>=', 2] : [c, 1];
      emit('op', start, i + len, {v: op});
      i += len;
    } else if (isWordChar(c)) i = word(i, start);
    else throw lexErr(`unexpected character \`${c}\``, start);
  }
  out.push({tok: 'eof', start: src.length, end: src.length});
  return out;
}

// ---------------------------------------------------------------------------------------------
// parser.rs

/** Parses formula text; a leading `=` is skipped. Throws FormulaError. */
export const parse = src => parseTop(src, false);
/** Parses a defined name's formula: a top-level comma is the union operator. */
export const parseName = src => parseTop(src, true);

const MAX_CLOSED_PARENS = 8;
/** Parses as typed into a cell, closing up to eight missing `)` at the end as Excel does. */
export function parseClosingParens(src, parser = parse) {
  let typed;
  try { return parser(src); } catch (e) { typed = e; }
  let text = src;
  for (let i = 0; i < MAX_CLOSED_PARENS; i++) {
    text += ')';
    try { return parser(text); } catch { /* keep closing */ }
  }
  throw typed;
}

function parseTop(src, allowUnion) {
  const body = src.startsWith('=') ? src.slice(1) : src;
  if (body.length > MAX_FORMULA_LEN && [...body].length > MAX_FORMULA_LEN) {
    throw new FormulaError(`formula is longer than ${MAX_FORMULA_LEN} characters`, 0);
  }
  const p = new Parser(significantSpaces(tokenize(body)));
  const e = p.expr(0, allowUnion);
  if (p.peek().tok !== 'eof') throw p.err(`unexpected ${describe(p.peek())}`);
  return e;
}

function describe(t) {
  switch (t.tok) {
    case 'rparen': return '`)`';
    case 'comma': return '`,`';
    case 'eof': return 'end of formula';
    case 'word': case 'func': return `\`${t.v}\``;
    case 'op': return `\`${t.v}\``;
    case 'num': return `\`${t.v}\``;
    default: return t.tok;
  }
}

/** Keeps a space token only where it is the intersection operator. */
function significantSpaces(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.tok === 'space') {
      const p = out[out.length - 1], nx = toks[i + 1];
      const prevEnd = p && ['word', 'rparen', 'struct', 'err'].includes(p.tok);
      const nextStart = nx && ['word', 'sheet', 'lparen', 'func', 'err'].includes(nx.tok);
      if (prevEnd && nextStart) out.push(t);
      continue;
    }
    out.push(t);
  }
  return out;
}

function wordIsCols(w) {
  const abs = w.startsWith('$');
  const c = lettersToCol(w.replace(/^\$+/, ''));
  return c === null ? null : [c, abs];
}
function wordIsRow(w) {
  const abs = w.startsWith('$');
  const s = w.replace(/^\$+/, '');
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return n === 0 || n > MAX_ROWS ? null : [n - 1, abs];
}
function wordIsCell(w) {
  const p = parseA1Prefix(w);
  if (!p || p[4] !== '') return null;
  return {row: p[1], col: p[0], rowAbs: p[3], colAbs: p[2]};
}

/** `_xlfn.XLOOKUP` → `XLOOKUP`; `_xludf.` is kept. */
export function normalizeFunctionName(name) {
  const u = name.toUpperCase();
  for (const p of ['_XLFN._XLWS.', '_XLFN.', '_XLWS.']) if (u.startsWith(p)) return u.slice(p.length);
  return u.startsWith('_XLUDF.') ? `_xludf.${u.slice(7)}` : u;
}

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; this.depth = 0; }
  peek(k = 0) { return this.toks[this.i + k] ?? {tok: 'eof', start: 0, end: 0}; }
  pos() { return this.toks[this.i]?.start ?? 0; }
  next() { const t = this.peek(); if (this.i < this.toks.length) this.i++; return t; }
  err(msg) { return new FormulaError(msg, this.pos()); }
  expect(tok) {
    if (this.peek().tok === tok) { this.next(); return; }
    throw this.err(`expected ${describe({tok})}, found ${describe(this.peek())}`);
  }
  binop(allowUnion) {
    const t = this.peek();
    if (t.tok === 'op' && t.v in BINOPS && t.v !== '%' && t.v !== '@' && t.v !== '#') return t.v;
    if (t.tok === 'colon') return ':';
    if (t.tok === 'space') return ' ';
    if (t.tok === 'comma' && allowUnion) return ',';
    return null;
  }
  expr(minBp, allowUnion) {
    if (++this.depth > MAX_DEPTH) throw this.err('formula is nested too deeply');
    let lhs = this.prefix(allowUnion);
    let postfix = 0;
    for (;;) {
      const t = this.peek();
      if (t.tok === 'op' && t.v === '%') {
        if (70 < minBp) break;
        if (this.depth + ++postfix > MAX_DEPTH) throw this.err('formula is nested too deeply');
        this.next();
        lhs = {t: 'unary', op: 'percent', x: lhs};
        continue;
      }
      if (t.tok === 'lparen' && ['call', 'invoke', 'paren', 'name'].includes(lhs.t)) {
        if (this.depth + ++postfix > MAX_DEPTH) throw this.err('formula is nested too deeply');
        this.next();
        lhs = {t: 'invoke', callee: lhs, args: this.args()};
        continue;
      }
      if (t.tok === 'trim') {
        const bp = BINOPS[':'];
        if (bp < minBp) break;
        this.next();
        const rhs = this.expr(bp + 1, allowUnion);
        lhs = {t: 'unary', op: 'trim', mode: t.v, x: combine(':', lhs, rhs)};
        continue;
      }
      const op = this.binop(allowUnion);
      if (op === null) break;
      const bp = BINOPS[op];
      if (bp < minBp) break;
      this.next();
      const rhs = this.expr(bp + 1, allowUnion);
      lhs = combine(op, lhs, rhs);
    }
    this.depth--;
    return lhs;
  }
  args() {
    const args = [];
    if (this.peek().tok === 'rparen') { this.next(); return args; }
    for (;;) {
      const k = this.peek().tok;
      args.push(k === 'comma' || k === 'rparen' ? {t: 'missing'} : this.expr(0, false));
      const t = this.next();
      if (t.tok === 'comma') continue;
      if (t.tok === 'rparen') break;
      throw this.err(`expected \`,\` or \`)\`, found ${describe(t)}`);
    }
    if (args.length > 255) throw this.err('too many arguments');
    return args;
  }
  prefix(allowUnion) {
    const t = this.next();
    switch (t.tok) {
      case 'num': return {t: 'num', v: t.v};
      case 'str': return {t: 'str', v: t.v};
      case 'bool': return {t: 'bool', v: t.v};
      case 'err': return {t: 'err', v: t.v};
      case 'op':
        if (t.v === '-') return {t: 'unary', op: 'neg', x: this.expr(60, allowUnion)};
        if (t.v === '+') return {t: 'unary', op: 'plus', x: this.expr(60, allowUnion)};
        if (t.v === '@') return {t: 'unary', op: 'at', x: this.expr(95, allowUnion)};
        break;
      case 'lparen': {
        const e = this.expr(0, true);
        this.expect('rparen');
        return {t: 'paren', x: e};
      }
      case 'lbrace': return this.array();
      case 'func': {
        const name = normalizeFunctionName(t.v);
        const args = this.args();
        if (name === 'ANCHORARRAY' && args.length === 1 && args[0].t === 'ref' && args[0].kind.k === 'cell') return {t: 'unary', op: 'spill', x: args[0]};
        if (name === 'SINGLE' && args.length === 1) return {t: 'unary', op: 'at', x: args[0]};
        const trim = {_TRO_LEADING: 'leading', _TRO_TRAILING: 'trailing', _TRO_ALL: 'all'}[name];
        if (trim && args.length === 1) return {t: 'unary', op: 'trim', mode: trim, x: args[0]};
        return {t: 'call', name, args};
      }
      case 'sheet': {
        const sheet = t.v2 !== null && t.v2 !== undefined ? {k: 'span', a: t.v, b: t.v2} : {k: 'named', name: t.v};
        const w = this.next();
        if (w.tok === 'word') return this.referenceFromWord(sheet, w.v);
        if (w.tok === 'err' && w.v === ERR.Ref) return {t: 'err', v: ERR.Ref};
        throw this.err(`expected a reference after the sheet name, found ${describe(w)}`);
      }
      case 'word': {
        if (this.peek().tok === 'struct' && wordIsCell(t.v) === null) {
          const pos = this.pos();
          const body = this.next().v;
          try { return {t: 'struct', ...parseStruct(t.v, body)}; } catch (e) { throw new FormulaError(e.message, pos); }
        }
        return this.referenceFromWord({k: 'cur'}, t.v);
      }
      case 'struct':
        try { return {t: 'struct', ...parseStruct('', t.v)}; } catch (e) { throw this.err(e.message); }
      default: break;
    }
    throw this.err(`unexpected ${describe(t)}`);
  }
  referenceFromWord(sheet, w) {
    const nx = this.peek();
    const trim = nx.tok === 'colon' ? 'colon' : nx.tok === 'trim' ? nx.v : null;
    const wrap = kind => {
      const r = {t: 'ref', sheet, kind};
      return trim && trim !== 'colon' ? {t: 'unary', op: 'trim', mode: trim, x: r} : r;
    };
    const a = wordIsCell(w);
    if (a) {
      const w2 = this.peek(1);
      if (trim && w2.tok === 'word') {
        const b = wordIsCell(w2.v);
        if (b) { this.next(); this.next(); return wrap({k: 'range', a, b}); }
      }
      const cell = {t: 'ref', sheet, kind: {k: 'cell', a}};
      if (this.peek().tok === 'op' && this.peek().v === '#') { this.next(); return {t: 'unary', op: 'spill', x: cell}; }
      return cell;
    }
    const n2 = this.peek(1);
    const second = n2.tok === 'word' ? n2.v : n2.tok === 'num' && Number.isInteger(n2.v) && n2.v >= 1 ? String(n2.v) : null;
    if (trim && second !== null) {
      const c0 = wordIsCols(w), c1 = wordIsCols(second);
      if (c0 && c1) { this.next(); this.next(); return wrap({k: 'cols', c0: c0[0], a0: c0[1], c1: c1[0], a1: c1[1]}); }
      const r0 = wordIsRow(w), r1 = wordIsRow(second);
      if (r0 && r1) { this.next(); this.next(); return wrap({k: 'rows', r0: r0[0], a0: r0[1], r1: r1[0], a1: r1[1]}); }
    }
    if (sheet.k !== 'cur') {
      if (sheet.k === 'named') return {t: 'name', v: `${sheet.name}!${w}`};
      throw this.err('invalid 3-D reference');
    }
    if (isAsciiDigit(w[0])) throw this.err(`unexpected \`${w}\``);
    if (w.length > 7 && w.slice(0, 7).toLowerCase() === '_xleta.') return {t: 'name', v: w.slice(7).toUpperCase()};
    return {t: 'name', v: w};
  }
  array() {
    const rows = [[]];
    for (;;) {
      const t = this.next();
      let el;
      if (t.tok === 'num') el = {t: 'num', v: t.v};
      else if (t.tok === 'op' && (t.v === '-' || t.v === '+')) {
        const nx = this.next();
        if (nx.tok !== 'num') throw this.err(`expected a number in array, found ${describe(nx)}`);
        el = {t: 'num', v: t.v === '-' ? -nx.v : nx.v};
      } else if (t.tok === 'str') el = {t: 'str', v: t.v};
      else if (t.tok === 'bool') el = {t: 'bool', v: t.v};
      else if (t.tok === 'err') el = {t: 'err', v: t.v};
      else throw this.err(`array constants may only contain constants, found ${describe(t)}`);
      rows[rows.length - 1].push(el);
      const sep = this.next();
      if (sep.tok === 'comma') continue;
      if (sep.tok === 'semicolon') { rows.push([]); continue; }
      if (sep.tok === 'rbrace') break;
      throw this.err(`expected \`,\`, \`;\` or \`}\`, found ${describe(sep)}`);
    }
    const w = rows[0].length;
    if (rows.some(r => r.length !== w)) throw this.err('array rows must have the same length');
    return {t: 'array', rows};
  }
}

/** Folds `A1:B2`-like range operations of two plain refs into a single reference. */
function combine(op, lhs, rhs) {
  if (op === ':' && lhs.t === 'ref' && rhs.t === 'ref' && rhs.sheet.k === 'cur' && lhs.kind.k === 'cell' && rhs.kind.k === 'cell') {
    return {t: 'ref', sheet: lhs.sheet, kind: {k: 'range', a: lhs.kind.a, b: rhs.kind.a}};
  }
  return {t: 'binary', op, a: lhs, b: rhs};
}

/** Parses the inside of `Table[...]` → {table, specifiers, colStart, colEnd}. Throws Error. */
export function parseStruct(table, rawBody) {
  const specifiers = [], cols = [];
  const body = rawBody.trim();
  const unescape = s => { let out = ''; for (let i = 0; i < s.length; i++) { if (s[i] === "'") { if (i + 1 < s.length) out += s[++i]; } else out += s[i]; } return out; };
  const item = s => ({'#all': 'all', '#data': 'data', '#headers': 'headers', '#totals': 'totals', '#this row': 'thisRow'})[s.trim().toLowerCase()] ?? null;
  const unexpected = gap => new Error(`unexpected \`${gap}\` in structured reference`);
  const column = s => {
    let esc = false;
    for (const c of s) {
      if (esc) { esc = false; continue; }
      if (c === "'") esc = true;
      else if (c === '[' || c === ']') throw unexpected(s);
    }
    return unescape(s);
  };
  if (!body.startsWith('[')) {
    if (body.startsWith('@')) {
      specifiers.push('thisRow');
      let rest = body.slice(1).trim();
      if (rest.startsWith('[') && rest.endsWith(']')) rest = rest.slice(1, -1);
      if (rest) cols.push(column(rest));
    } else if (item(body)) specifiers.push(item(body));
    else if (body) cols.push(column(rawBody));
  } else {
    const parts = [];
    let depth = 0, cur = '', gap = '', esc = false;
    for (const c of body) {
      if (esc) { cur += c; esc = false; continue; }
      if (c === "'" && depth > 0) { cur += c; esc = true; }
      else if (c === '[') {
        if (depth === 0) { if (!['', ',', ':'].includes(gap.trim())) throw unexpected(gap.trim()); gap = ''; }
        depth++;
        if (depth > 1) cur += c;
      } else if (c === ']') {
        if (depth === 0) throw unexpected(']');
        depth--;
        if (depth > 0) cur += c; else { parts.push(cur); cur = ''; }
      } else if (depth > 0) cur += c;
      else gap += c;
    }
    if (depth > 0) throw new Error('unclosed `[` in structured reference');
    for (const p of parts) { const it = item(p); if (it) specifiers.push(it); else cols.push(column(p)); }
    const tail = gap.trim();
    if (tail) {
      const bare = tail.startsWith(',') ? tail.slice(1).trim() : '';
      const simple = bare && !/[[\]#',:]/.test(bare);
      if (!(simple && specifiers.length === 1 && specifiers[0] === 'thisRow' && !cols.length)) throw unexpected(tail);
      cols.push(bare);
    }
  }
  if (cols.length > 2) throw new Error('a structured reference names at most two columns');
  return {table, specifiers, colStart: cols[0] ?? null, colEnd: cols[1] ?? null};
}

// ---------------------------------------------------------------------------------------------
// printer.rs

function sheetPrefix(s) {
  if (s.k === 'cur') return '';
  if (s.k === 'named') return `${quoteSheet(s.name)}!`;
  const joined = `${s.a}:${s.b}`;
  return sheetNeedsQuotes(s.a) || sheetNeedsQuotes(s.b) ? `'${joined.replace(/'/g, "''")}'!` : `${joined}!`;
}
const anchorA1 = a => `${a.colAbs ? '$' : ''}${colToLetters(a.col)}${a.rowAbs ? '$' : ''}${a.row + 1}`;
const dollar = abs => (abs ? '$' : '');

/** A1 text of a reference node with `sep` between the ends of a range. */
export function referenceA1(r, sep = ':') {
  const k = r.kind;
  let body;
  switch (k.k) {
    case 'cell': body = anchorA1(k.a); break;
    case 'range': body = anchorA1(k.a) + sep + anchorA1(k.b); break;
    case 'rows': body = `${dollar(k.a0)}${k.r0 + 1}${sep}${dollar(k.a1)}${k.r1 + 1}`; break;
    default: body = `${dollar(k.a0)}${colToLetters(k.c0)}${sep}${dollar(k.a1)}${colToLetters(k.c1)}`;
  }
  return sheetPrefix(r.sheet) + body;
}

const r1c1Part = (letter, v, abs, base) => (abs ? `${letter}${v + 1}` : v - base === 0 ? letter : `${letter}[${v - base}]`);
const anchorR1C1 = (a, at) => r1c1Part('R', a.row, a.rowAbs, at.row) + r1c1Part('C', a.col, a.colAbs, at.col);
/** R1C1 text of a reference relative to `at`. */
export function referenceR1C1(r, at, sep = ':') {
  const k = r.kind;
  let body;
  switch (k.k) {
    case 'cell': body = anchorR1C1(k.a, at); break;
    case 'range': body = anchorR1C1(k.a, at) + sep + anchorR1C1(k.b, at); break;
    case 'rows': { const x = r1c1Part('R', k.r0, k.a0, at.row), y = r1c1Part('R', k.r1, k.a1, at.row); body = x === y && sep === ':' ? x : x + sep + y; break; }
    default: { const x = r1c1Part('C', k.c0, k.a0, at.col), y = r1c1Part('C', k.c1, k.a1, at.col); body = x === y && sep === ':' ? x : x + sep + y; }
  }
  return sheetPrefix(r.sheet) + body;
}

/** Splits a sheet-qualified name at its last `!` outside brackets. */
function sheetSplit(n) {
  let depth = 0, escaped = false, at = -1;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    if (escaped) { escaped = false; continue; }
    if (c === "'" && depth > 0) escaped = true;
    else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '!' && depth === 0) at = i;
  }
  return at < 0 ? null : [n.slice(0, at), n.slice(at + 1)];
}

const STRUCT_ITEM = {all: '#All', data: '#Data', headers: '#Headers', totals: '#Totals', thisRow: '#This Row'};
/** Structured reference text (`Table1[@Col]` shorthand when `atShorthand`). */
export function structRefText(s, atShorthand = true) {
  const esc = c => c.replace(/'/g, "''").replace(/\[/g, "'[").replace(/]/g, "']").replace(/#/g, "'#");
  const thisRow = atShorthand && s.specifiers.length === 1 && s.specifiers[0] === 'thisRow';
  const simpleCol = c => !/[ [\]#',:]/.test(c);
  let out = s.table;
  const a = s.colStart, b = s.colEnd;
  if (a === null && b === null && !s.specifiers.length) out += '[]';
  else if (a === null && b === null && thisRow) out += '[@]';
  else if (a === null && b === null && s.specifiers.length === 1) out += `[${STRUCT_ITEM[s.specifiers[0]]}]`;
  else if (a !== null && b === null && !s.specifiers.length) out += a.trim() === a ? `[${esc(a)}]` : `[[${esc(a)}]]`;
  else if (a !== null && b === null && thisRow) out += simpleCol(a) ? `[@${esc(a)}]` : `[@[${esc(a)}]]`;
  else {
    const parts = s.specifiers.map(i => `[${STRUCT_ITEM[i]}]`);
    if (a !== null && b !== null) parts.push(`[${esc(a)}]:[${esc(b)}]`);
    else if (a !== null) parts.push(`[${esc(a)}]`);
    out += `[${parts.join(',')}]`;
  }
  return out;
}

function numberText(n) {
  const text = numberToText(n);
  if (Number.isFinite(Number(text))) return text;
  const exact = n.toExponential().toUpperCase();
  const [m, e] = exact.split('E');
  return e.startsWith('-') ? exact : `${m}E+${e.replace(/^\+/, '')}`;
}

/** Prints an expression in A1 notation (without `=`). */
export const print = e => writeExpr(e, null);
/** Prints an expression in R1C1 notation relative to `at` ({row, col}). */
export const printR1C1 = (e, at) => writeExpr(e, at);

function writeExpr(e, at) {
  switch (e.t) {
    case 'num': return numberText(e.v);
    case 'str': return `"${e.v.replace(/"/g, '""')}"`;
    case 'bool': return e.v ? 'TRUE' : 'FALSE';
    case 'err': return e.v.text;
    case 'array': return `{${e.rows.map(r => r.map(x => writeExpr(x, at)).join(',')).join(';')}}`;
    case 'ref': return at ? referenceR1C1(e, at) : referenceA1(e);
    case 'name': { const sp = sheetSplit(e.v); return sp ? `${quoteSheet(sp[0])}!${sp[1]}` : e.v; }
    case 'struct': return structRefText(e);
    case 'unary':
      switch (e.op) {
        case 'neg': return '-' + writeExpr(e.x, at);
        case 'plus': return '+' + writeExpr(e.x, at);
        case 'at': return '@' + writeExpr(e.x, at);
        case 'percent': return writeExpr(e.x, at) + '%';
        case 'spill': return writeExpr(e.x, at) + (e.x.t === 'err' ? '' : '#');
        default: {
          const x = e.x, sym = TRIM_SYMBOL[e.mode];
          if (x.t === 'ref' && x.kind.k !== 'cell') return at ? referenceR1C1(x, at, sym) : referenceA1(x, sym);
          if (x.t === 'binary' && x.op === ':') return writeExpr(x.a, at) + sym + writeExpr(x.b, at);
          if (x.t === 'err') return writeExpr(x, at);
          return `TRIMRANGE(${writeExpr(x, at)},${TRIM_CODE[e.mode]},${TRIM_CODE[e.mode]})`;
        }
      }
    case 'binary': {
      const rest = [];
      let first = e;
      while (first.t === 'binary') { rest.push(first); first = first.a; }
      let s = writeExpr(first, at);
      for (let i = rest.length - 1; i >= 0; i--) s += rest[i].op + writeExpr(rest[i].b, at);
      return s;
    }
    case 'call': return `${e.name}(${e.args.map(a => writeExpr(a, at)).join(',')})`;
    case 'invoke': return `${writeExpr(e.callee, at)}(${e.args.map(a => writeExpr(a, at)).join(',')})`;
    case 'missing': return '';
    case 'paren': return `(${writeExpr(e.x, at)})`;
    default: return '';
  }
}

// ---------------------------------------------------------------------------------------------
// adjust.rs

const refErr = () => ({t: 'err', v: ERR.Ref});

/** Copy/fill: relative parts move by (dr, dc); references pushed off the sheet become #REF!. */
export function shiftRelative(e, dr, dc) {
  return mapExpr(e, x => {
    if (x.t !== 'ref') return x;
    const r = shiftRef(x, dr, dc);
    return r ?? refErr();
  });
}

/** Defined names: relative parts move by (dr, dc), wrapping around the sheet's edges. */
export function shiftRelativeWrapping(e, dr, dc) {
  const wrap = (v, abs, d, max) => (abs ? v : (((v + d) % max) + max) % max);
  const anchor = a => ({...a, row: wrap(a.row, a.rowAbs, dr, MAX_ROWS), col: wrap(a.col, a.colAbs, dc, MAX_COLS)});
  return mapExpr(e, x => {
    if (x.t !== 'ref') return x;
    const k = x.kind;
    let kind;
    switch (k.k) {
      case 'cell': kind = {k: 'cell', a: anchor(k.a)}; break;
      case 'range': kind = {k: 'range', a: anchor(k.a), b: anchor(k.b)}; break;
      case 'rows': kind = {...k, r0: wrap(k.r0, k.a0, dr, MAX_ROWS), r1: wrap(k.r1, k.a1, dr, MAX_ROWS)}; break;
      default: kind = {...k, c0: wrap(k.c0, k.a0, dc, MAX_COLS), c1: wrap(k.c1, k.a1, dc, MAX_COLS)};
    }
    return {t: 'ref', sheet: x.sheet, kind};
  });
}

/** Whether the formula has a relative (no `$`) row or column anywhere. */
export function hasRelativeRefs(e) {
  return references(e).some(r => {
    const k = r.kind;
    switch (k.k) {
      case 'cell': return !k.a.rowAbs || !k.a.colAbs;
      case 'range': return !k.a.rowAbs || !k.a.colAbs || !k.b.rowAbs || !k.b.colAbs;
      default: return !k.a0 || !k.a1;
    }
  });
}

function shiftAnchor(a, dr, dc) {
  const row = a.rowAbs ? a.row : a.row + dr, col = a.colAbs ? a.col : a.col + dc;
  const c = clampAnchor(row, col);
  return c ? {...a, row: c[0], col: c[1]} : null;
}
function shiftLine(v, abs, d, max) {
  if (abs) return v;
  const n = v + d;
  return n >= 0 && n < max ? n : null;
}
function shiftRef(r, dr, dc) {
  const k = r.kind;
  let kind;
  switch (k.k) {
    case 'cell': { const a = shiftAnchor(k.a, dr, dc); if (!a) return null; kind = {k: 'cell', a}; break; }
    case 'range': { const a = shiftAnchor(k.a, dr, dc), b = shiftAnchor(k.b, dr, dc); if (!a || !b) return null; kind = {k: 'range', a, b}; break; }
    case 'rows': { const r0 = shiftLine(k.r0, k.a0, dr, MAX_ROWS), r1 = shiftLine(k.r1, k.a1, dr, MAX_ROWS); if (r0 === null || r1 === null) return null; kind = {...k, r0, r1}; break; }
    default: { const c0 = shiftLine(k.c0, k.a0, dc, MAX_COLS), c1 = shiftLine(k.c1, k.a1, dc, MAX_COLS); if (c0 === null || c1 === null) return null; kind = {...k, c0, c1}; }
  }
  return {t: 'ref', sheet: r.sheet, kind};
}

/**
 * A structural edit on one sheet:
 *   {type:'insert'|'delete', axis:'rows'|'cols', at, count}
 *   {type:'move', from: range, toRow, toCol}
 *   {type:'insertCells'|'deleteCells', axis, range}
 *   {type:'moveToSheet', from, toSheet, toRow, toCol}
 */
export function adjust(e, host, target, edit) {
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  return mapExpr(e, x => {
    if (x.t !== 'ref') return x;
    const onTarget = x.sheet.k === 'cur' ? eq(host, target) : x.sheet.k === 'named' ? eq(x.sheet.name, target) : false;
    if (!onTarget) return x;
    return adjustRef(x, edit) ?? refErr();
  });
}

function mapIndex(v, at, cnt, insert, max) {
  if (insert) { if (v >= at) { const n = v + cnt; return n >= max ? null : n; } return v; }
  if (v < at) return v;
  if (v >= at + cnt) return v - cnt;
  return null;
}
function mapSpan(lo, hi, at, cnt, insert, max) {
  if (insert) {
    const lo2 = lo >= at ? lo + cnt : lo;
    const hi2 = Math.min(hi >= at ? hi + cnt : hi, max - 1);
    return lo2 > hi2 ? null : [lo2, hi2];
  }
  const end = at + cnt;
  if (lo >= at && hi < end) return null;
  const lo2 = lo < at ? lo : lo >= end ? lo - cnt : at;
  const hi2 = hi < at ? hi : hi >= end ? hi - cnt : Math.max(0, at - 1);
  return [lo2, Math.max(hi2, lo2)];
}

function adjustRef(r, edit) {
  const k = r.kind;
  if (edit.type === 'insert' || edit.type === 'delete') {
    const insert = edit.type === 'insert', {axis, at, count: cnt} = edit;
    let kind = k;
    if (k.k === 'cell' && axis === 'rows') { const v = mapIndex(k.a.row, at, cnt, insert, MAX_ROWS); if (v === null) return null; kind = {k: 'cell', a: {...k.a, row: v}}; }
    else if (k.k === 'cell' && axis === 'cols') { const v = mapIndex(k.a.col, at, cnt, insert, MAX_COLS); if (v === null) return null; kind = {k: 'cell', a: {...k.a, col: v}}; }
    else if (k.k === 'range' && axis === 'rows') {
      const s = mapSpan(Math.min(k.a.row, k.b.row), Math.max(k.a.row, k.b.row), at, cnt, insert, MAX_ROWS); if (!s) return null;
      kind = {k: 'range', a: {...k.a, row: s[0]}, b: {...k.b, row: s[1]}};
    } else if (k.k === 'range' && axis === 'cols') {
      const s = mapSpan(Math.min(k.a.col, k.b.col), Math.max(k.a.col, k.b.col), at, cnt, insert, MAX_COLS); if (!s) return null;
      kind = {k: 'range', a: {...k.a, col: s[0]}, b: {...k.b, col: s[1]}};
    } else if (k.k === 'rows' && axis === 'rows') {
      const s = mapSpan(Math.min(k.r0, k.r1), Math.max(k.r0, k.r1), at, cnt, insert, MAX_ROWS); if (!s) return null;
      kind = {...k, r0: s[0], r1: s[1]};
    } else if (k.k === 'cols' && axis === 'cols') {
      const s = mapSpan(Math.min(k.c0, k.c1), Math.max(k.c0, k.c1), at, cnt, insert, MAX_COLS); if (!s) return null;
      kind = {...k, c0: s[0], c1: s[1]};
    }
    return {t: 'ref', sheet: r.sheet, kind};
  }
  if (edit.type === 'insertCells' || edit.type === 'deleteCells') {
    const span = refRange(r), rg = edit.range;
    const inside = edit.axis === 'rows' ? rg.start.col <= span.start.col && span.end.col <= rg.end.col : rg.start.row <= span.start.row && span.end.row <= rg.end.row;
    if (!inside) return r;
    const at = edit.axis === 'rows' ? rg.start.row : rg.start.col;
    const cnt = edit.axis === 'rows' ? rg.end.row - rg.start.row + 1 : rg.end.col - rg.start.col + 1;
    return adjustRef(r, {type: edit.type === 'insertCells' ? 'insert' : 'delete', axis: edit.axis, at, count: cnt});
  }
  if (edit.type === 'move') {
    const {from, toRow, toCol} = edit;
    const dr = toRow - from.start.row, dc = toCol - from.start.col;
    if (!containsRange(from, refRange(r))) return r;
    const mv = a => { const c = clampAnchor(a.row + dr, a.col + dc); return c ? {...a, row: c[0], col: c[1]} : null; };
    let kind;
    switch (k.k) {
      case 'cell': { const a = mv(k.a); if (!a) return null; kind = {k: 'cell', a}; break; }
      case 'range': { const a = mv(k.a), b = mv(k.b); if (!a || !b) return null; kind = {k: 'range', a, b}; break; }
      case 'rows': { const r0 = shiftLine(k.r0, false, dr, MAX_ROWS), r1 = shiftLine(k.r1, false, dr, MAX_ROWS); if (r0 === null || r1 === null) return null; kind = {...k, r0, r1}; break; }
      default: { const c0 = shiftLine(k.c0, false, dc, MAX_COLS), c1 = shiftLine(k.c1, false, dc, MAX_COLS); if (c0 === null || c1 === null) return null; kind = {...k, c0, c1}; }
    }
    return {t: 'ref', sheet: r.sheet, kind};
  }
  if (edit.type === 'moveToSheet') {
    if (!containsRange(edit.from, refRange(r))) return r;
    const moved = adjustRef(r, {type: 'move', from: edit.from, toRow: edit.toRow, toCol: edit.toCol});
    return moved ? {...moved, sheet: {k: 'named', name: edit.toSheet}} : null;
  }
  return r;
}

/** Renames sheet references old → new. */
export function renameSheet(e, oldName, newName) {
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  return mapExpr(e, x => {
    if (x.t === 'ref') {
      const s = x.sheet;
      if (s.k === 'named' && eq(s.name, oldName)) return {...x, sheet: {k: 'named', name: newName}};
      if (s.k === 'span') return {...x, sheet: {k: 'span', a: eq(s.a, oldName) ? newName : s.a, b: eq(s.b, oldName) ? newName : s.b}};
      return x;
    }
    if (x.t === 'name' && x.v.length > oldName.length && eq(x.v.slice(0, oldName.length), oldName) && x.v[oldName.length] === '!') {
      return {t: 'name', v: newName + x.v.slice(oldName.length)};
    }
    return x;
  });
}

/** References to a deleted sheet become #REF!; a 3-D span losing an end shrinks inward. */
export function deleteSheet(e, name, order) {
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const pos = n => order.findIndex(o => eq(o, n));
  return mapExpr(e, x => {
    if (x.t !== 'ref') return x;
    if (x.sheet.k === 'named' && eq(x.sheet.name, name)) return refErr();
    if (x.sheet.k === 'span' && (eq(x.sheet.a, name) || eq(x.sheet.b, name))) {
      const {a, b} = x.sheet, ia = pos(a), ib = pos(b);
      if (ia < 0 || ib < 0) return x;
      if (ia === ib) return refErr();
      const inward = (from, to) => order[from < to ? from + 1 : Math.max(0, from - 1)];
      const [na, nb] = eq(a, name) ? [inward(ia, ib), order[ib]] : [order[ia], inward(ib, ia)];
      if (na === undefined || nb === undefined) return refErr();
      return {...x, sheet: eq(na, nb) ? {k: 'named', name: na} : {k: 'span', a: na, b: nb}};
    }
    return x;
  });
}
