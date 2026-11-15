// Calculated PivotTable fields: a formula over other fields (`=Sales*0.1`, `='Unit Price'*Units`,
// `=IF(Units>0,Sales/Units,0)`).
// Translated from gridcraft crates/engine/src/pivot_calc.rs (`compile`, `eval`, `CalcSet`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.
//
// As Microsoft documents for Excel, the formula operates on the *sums* of the fields it names for each report
// cell (items, subtotals and grand totals alike), not record by record: for `=Sales*1.2` a cell shows 1.2 x the sum
// of Sales of that cell's records. Fields are written bare (`Sales`) or in single quotes (`'Unit Price'`); cell
// references and defined names are not allowed. A calculated field may use other calculated fields; a cycle
// evaluates to #REF!. The report evaluates `LET(__pcf0, sum0, ..., formula)` with the formula's field names replaced
// by those placeholders.

import {parse, print, walk} from './formula.mjs';
import {ERR, CellError, GArray, numberToText} from './value.mjs';
import {engineFor} from '../model/calc.mjs';

export const MAX_FORMULA_LEN = 8192;
export const MAX_CALC_FIELDS = 256;
const MAX_DEPTH = 64;
const PREFIX = '__pcf';
const placeholder = i => `${PREFIX}${i}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isDigit = c => c >= '0' && c <= '9';
const isAlpha = c => c !== undefined && /[\p{L}_]/u.test(c);
const isAlnum = c => c !== undefined && /[\p{L}\p{N}_.]/u.test(c);

/** Parses a calculated-field formula. `field` maps a written name to the canonical name of a source or calculated field (or null). Throws Error(message). */
export function compile(formula, field) {
  let text = String(formula ?? '').trim();
  if (text.startsWith('=')) text = text.slice(1).trim();
  if (!text) throw new Error('The formula is empty.');
  if (text.length > MAX_FORMULA_LEN) throw new Error('The formula is too long.');
  const chars = [...text];
  const refs = [];
  const slot = name => {
    let i = refs.findIndex(r => same(r, name));
    if (i < 0) { refs.push(name); i = refs.length - 1; }
    return placeholder(i);
  };
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '"') {
      out += '"'; i++;
      for (;;) {
        if (i >= chars.length) throw new Error('The formula has an unterminated text value.');
        if (chars[i] === '"' && chars[i + 1] === '"') { out += '""'; i += 2; } else if (chars[i] === '"') { out += '"'; i++; break; } else { out += chars[i]; i++; }
      }
    } else if (c === "'") {
      let name = '';
      i++;
      for (;;) {
        if (i >= chars.length) throw new Error('The formula has an unterminated field name.');
        if (chars[i] === "'" && chars[i + 1] === "'") { name += "'"; i += 2; } else if (chars[i] === "'") { i++; break; } else { name += chars[i]; i++; }
      }
      const canon = field(name);
      if (canon === null || canon === undefined) throw new Error(`There's no field named '${name}'.`);
      out += slot(canon);
    } else if (isDigit(c) || (c === '.' && isDigit(chars[i + 1] ?? ''))) {
      while (i < chars.length && (isDigit(chars[i]) || chars[i] === '.')) out += chars[i++];
      if (chars[i] === 'e' || chars[i] === 'E') {
        const sign = chars[i + 1] === '+' || chars[i + 1] === '-' ? 1 : 0;
        if (isDigit(chars[i + 1 + sign] ?? '')) {
          for (let k = 0; k <= sign; k++) out += chars[i++];
          while (i < chars.length && isDigit(chars[i])) out += chars[i++];
        }
      }
    } else if (isAlpha(c)) {
      const start = i;
      while (i < chars.length && isAlnum(chars[i])) i++;
      const word = chars.slice(start, i).join('');
      let j = i;
      while (j < chars.length && /\s/.test(chars[j])) j++;
      const isCall = chars[j] === '(';
      const canon = isCall ? null : field(word);
      out += canon !== null && canon !== undefined ? slot(canon) : word;
    } else { out += c; i++; }
  }
  let body;
  try { body = parse(out); } catch { throw new Error('The formula contains an error.'); }
  let problem = null;
  walk(body, e => {
    if (problem) return;
    if (e.t === 'name') { if (!String(e.v).startsWith(PREFIX)) problem = `There's no field named '${e.v}'.`; }
    else if (e.t === 'ref' || e.t === 'struct') problem = "A calculated field can't refer to cells or tables; use field names.";
  });
  if (problem) throw new Error(problem);
  return {body, refs};
}

const literal = v => {
  const x = v instanceof GArray ? (v.data[0] ?? null) : v;
  if (typeof x === 'number') return numberToText(x);
  if (x instanceof CellError) return x.text;
  if (typeof x === 'string') return `"${x.replace(/"/g, '""')}"`;
  if (typeof x === 'boolean') return x ? 'TRUE' : 'FALSE';
  return '0';
};

/** Evaluates a compiled formula with the given field values (in `refs` order). */
export function evaluate(content, c, args) {
  const bodyText = print(c.body);
  const text = c.refs.length ? `LET(${c.refs.map((_, i) => `${placeholder(i)},${literal(args[i] ?? null)}`).join(',')},${bodyText})` : bodyText;
  let v = engineFor(content).evaluate(0, {row: 0, col: 0}, text);
  if (v instanceof GArray) v = v.data[0] ?? null;
  return v === null || v === undefined || v === '' ? 0 : v;
}

/** A PivotTable's calculated fields, compiled against its source headers. */
export class CalcSet {
  constructor(pt, headers, content = null) {
    this.content = content;
    const list = (pt.calculatedFields ?? []).slice(0, MAX_CALC_FIELDS);
    this.names = list.map(c => c.name);
    const lookup = n => [...headers, ...this.names].find(h => same(String(h).trim(), String(n).trim())) ?? null;
    this.compiled = list.map(c => { try { return {ok: compile(c.formula, lookup)}; } catch (e) { return {error: e.message}; } });
  }
  index(name) { return this.names.findIndex(n => same(n, String(name).trim())); }
  error(i) { return this.compiled[i]?.error ?? null; }
  /** Source fields a calculated field needs, directly or through other calculated fields. */
  sourceRefs(i) {
    const out = [], seen = new Array(this.names.length).fill(false), stack = [i];
    while (stack.length) {
      const j = stack.pop();
      if (seen[j] ?? true) continue;
      seen[j] = true;
      for (const r of this.compiled[j]?.ok?.refs ?? []) {
        const k = this.index(r);
        if (k >= 0) stack.push(k); else if (!out.some(o => same(o, r))) out.push(r);
      }
    }
    return out;
  }
  /** Whether a calculated field reaches itself through the fields it uses. */
  isCyclic(i) {
    const seen = new Array(this.names.length).fill(false);
    const stack = (this.compiled[i]?.ok?.refs ?? []).map(r => this.index(r)).filter(k => k >= 0);
    while (stack.length) {
      const j = stack.pop();
      if (j === i) return true;
      if (seen[j] ?? true) continue;
      seen[j] = true;
      stack.push(...(this.compiled[j]?.ok?.refs ?? []).map(r => this.index(r)).filter(k => k >= 0));
    }
    return false;
  }
  /** The value of calculated field `i` for one report cell; `sum(name)` gives a source field's sum over that cell's records. */
  value(i, sum) {
    const memo = new Array(this.names.length).fill(undefined);
    const active = new Array(this.names.length).fill(false);
    const go = (k, depth) => {
      if (memo[k] !== undefined) return memo[k];
      if (depth > MAX_DEPTH || (active[k] ?? true)) return ERR.Ref;
      const c = this.compiled[k]?.ok;
      if (!c) return ERR.Name;
      active[k] = true;
      const args = c.refs.map(r => { const j = this.index(r); return j >= 0 ? go(j, depth + 1) : sum(r); });
      const v = evaluate(this.content, c, args);
      active[k] = false;
      memo[k] = v;
      return v;
    };
    return go(i, 0);
  }
}
