// Excel criteria (COUNTIF, SUMIFS, DCOUNT…) and wildcard matching.
// Translated from gridcraft crates/functions/src/criteria.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CellError, ERR, GArray, compareNumbers, compareText, parseError} from '../../lib/value.mjs';
import {parseNumberText} from '../../lib/parse.mjs';

const MAX_CRITERION_UTF16_UNITS = 255;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function cmpOp(op, o) {
  switch (op) {
    case 'eq': return o === 0;
    case 'ne': return o !== 0;
    case 'lt': return o < 0;
    case 'le': return o <= 0;
    case 'gt': return o > 0;
    default: return o >= 0;
  }
}
function splitOp(t) {
  if (t.startsWith('>=')) return ['ge', t.slice(2)];
  if (t.startsWith('<=')) return ['le', t.slice(2)];
  if (t.startsWith('<>')) return ['ne', t.slice(2)];
  if (t.startsWith('=')) return ['eq', t.slice(1)];
  if (t.startsWith('>')) return ['gt', t.slice(1)];
  if (t.startsWith('<')) return ['lt', t.slice(1)];
  return ['eq', t];
}

/** A parsed criterion: {op, kind: 'number'|'bool'|'error'|'text'|'cut'|'blank', operand, bareEmpty}. */
export class Criterion {
  constructor(op, kind, operand, bareEmpty = false) { this.op = op; this.kind = kind; this.operand = operand; this.bareEmpty = bareEmpty; }

  static parse(v) {
    if (typeof v === 'number') return new Criterion('eq', 'number', v);
    if (typeof v === 'boolean') return new Criterion('eq', 'bool', v);
    if (v instanceof CellError) return new Criterion('eq', 'error', v);
    if (v === null || v === undefined) return new Criterion('eq', 'number', 0);
    if (v instanceof GArray) return Criterion.parse(v.data[0] ?? null);
    return Criterion.parseText(v);
  }
  /** Throws #VALUE! for text over 255 UTF-16 units. */
  static parseArg(v) {
    if (v instanceof GArray) return Criterion.parseArg(v.data[0] ?? null);
    if (typeof v === 'string' && v.length > MAX_CRITERION_UTF16_UNITS) throw ERR.Value;
    return Criterion.parse(v);
  }
  /** Text over 255 UTF-16 units matches on its first 255 (several criteria pairs). */
  static parseArgTruncated(v) {
    if (v instanceof GArray) return Criterion.parseArgTruncated(v.data[0] ?? null);
    if (typeof v === 'string' && v.length > MAX_CRITERION_UTF16_UNITS) {
      const cut = v.slice(0, MAX_CRITERION_UTF16_UNITS);
      const last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        const [op, rest] = splitOp(cut.slice(0, -1));
        return new Criterion(op, 'cut', rest);
      }
      return Criterion.parseText(cut);
    }
    return Criterion.parse(v);
  }
  static parseText(t) {
    if (t === '') return new Criterion('eq', 'blank', null, true);
    const [op, rest] = splitOp(t);
    if (rest === '') return new Criterion(op, 'blank', null);
    const n = parseNumberText(rest);
    if (n !== null) return new Criterion(op, 'number', n);
    if (/^true$/i.test(rest)) return new Criterion(op, 'bool', true);
    if (/^false$/i.test(rest)) return new Criterion(op, 'bool', false);
    const e = parseError(rest);
    if (e) return new Criterion(op, 'error', e);
    return new Criterion(op, 'text', rest);
  }

  matches(v0) {
    const v = v0 instanceof GArray ? (v0.data[0] ?? null) : v0;
    if (this.bareEmpty) return v === null || v === undefined || v === '';
    switch (this.kind) {
      case 'blank': {
        const blank = v === null || v === undefined;
        if (this.op === 'eq') return blank;
        if (this.op === 'ne') return !blank;
        return typeof v === 'string' && v !== '' ? cmpOp(this.op, compareText(v, '')) : false;
      }
      case 'number': {
        let cell = null;
        if (typeof v === 'number') cell = v;
        else if (typeof v === 'string' && (this.op === 'eq' || this.op === 'ne')) cell = parseNumberText(v);
        return cell !== null ? cmpOp(this.op, compareNumbers(cell, this.operand)) : this.op === 'ne';
      }
      case 'bool': return typeof v === 'boolean' ? cmpOp(this.op, cmp(v, this.operand)) : this.op === 'ne';
      case 'error': return v instanceof CellError ? cmpOp(this.op, cmp(v.code, this.operand.code)) : this.op === 'ne';
      case 'text': {
        if (this.op === 'eq' || this.op === 'ne') {
          const m = typeof v === 'string' && wildcardMatch(this.operand, v);
          return this.op === 'eq' ? m : !m;
        }
        return typeof v === 'string' ? cmpOp(this.op, compareText(v, this.operand)) : false;
      }
      default: { // cut text
        if (this.op === 'eq') return false;
        if (this.op === 'ne') return true;
        if (this.op === 'lt' || this.op === 'le') return typeof v === 'string' && compareText(v, this.operand) <= 0;
        return typeof v === 'string' && compareText(v, this.operand) > 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Wildcards

const lowerChar = c => { const l = c.toLowerCase(); return [...l][0] ?? c; };
/** Tokens: a one-character string (literal), ANY (`?`) or STAR (`*`). */
const ANY = 1, STAR = 2;
function tokenize(pattern) {
  const out = [];
  const cs = [...pattern];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === '~') { if (i + 1 < cs.length) out.push(lowerChar(cs[++i])); else out.push('~'); }
    else if (c === '*') out.push(STAR);
    else if (c === '?') out.push(ANY);
    else out.push(lowerChar(c));
  }
  return out;
}
const lowerChars = s => [...s].map(lowerChar);

export const hasWildcards = pattern => tokenize(pattern).some(t => typeof t !== 'string') || pattern.includes('~');

const MAX_STEPS = 1 << 26;
function matchFrom(p, t, ti0, whole, budget) {
  let pi = 0, ti = ti0, star = null;
  for (;;) {
    if (--budget.n < 0) return null;
    if (pi === p.length && (!whole || ti === t.length)) return ti;
    const tk = p[pi];
    if (tk === STAR) { star = [pi, ti]; pi++; continue; }
    const step = pi < p.length && ti < t.length && (tk === ANY || tk === t[ti]);
    if (step) { pi++; ti++; continue; }
    if (star && star[1] < t.length) { star = [star[0], star[1] + 1]; pi = star[0] + 1; ti = star[1]; }
    else return null;
  }
}

/** Whether `text` matches the wildcard `pattern` (`*`, `?`, `~` escape), case-insensitively. */
export function wildcardMatch(pattern, text) {
  return matchFrom(tokenize(pattern), lowerChars(text), 0, true, {n: MAX_STEPS}) !== null;
}

/** First character index at or after `start` where the pattern matches a prefix; null if none. */
export function wildcardFind(pattern, text, start) {
  let p = tokenize(pattern);
  const t = lowerChars(text);
  let skip = 0;
  while (skip < p.length && p[skip] === STAR) skip++;
  p = p.slice(skip);
  if (!p.length) return start <= t.length ? start : null;
  let anys = 0;
  while (anys < p.length && p[anys] === ANY) anys++;
  const anchor = p[anys];
  const budget = {n: MAX_STEPS};
  for (let i = start; i < t.length; i++) {
    let hit;
    if (typeof anchor === 'string') {
      const rest = t[i + anys];
      if (rest === undefined) break;
      hit = rest === anchor && matchFrom(p, t, i, false, budget) !== null;
    } else hit = matchFrom(p, t, i, false, budget) !== null;
    if (hit) return i;
  }
  return null;
}

/** Equality as lookups use it (exact numbers; text case-insensitive or by wildcard). */
export function lookupEqual(needle, hay, wild) {
  if (typeof needle === 'string' && typeof hay === 'string') return wild ? wildcardMatch(needle, hay) : compareText(needle, hay) === 0;
  if (typeof needle === 'number' && typeof hay === 'number') return needle === hay;
  if (typeof needle === 'boolean' && typeof hay === 'boolean') return needle === hay;
  if (needle instanceof CellError && hay instanceof CellError) return needle === hay;
  return (needle === null || needle === undefined) && (hay === null || hay === undefined);
}
