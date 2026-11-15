// Data validation: the items of a list rule, and checking a value against the rule of a cell.
// Translated from gridcraft crates/engine/src/cmd/data/validation.rs (`list_items`,
// `check_validation`, `formula_at`, `compare_op`, `is_literal_list`, `list_source`, `op_param`)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored rule (xlsx's names, as the reader keeps them): {id, ranges: ['A1:B9'], type: any|whole|decimal|list|date|time|textLength|custom,
//   operator?: between|notBetween|equal|notEqual|greaterThan|lessThan|greaterThanOrEqual|lessThanOrEqual, formula1?, formula2?
//   (text without '='; a literal list is a quoted string), allowBlank?, inCellDropdown? (false hides the arrow), showInputMessage?,
//   promptTitle?, prompt?, showErrorMessage?, errorStyle?: stop|warning|information, errorTitle?, error?}.
// No DOM, no Node built-ins.

import {parse, print, shiftRelative} from './formula.mjs';
import {parseInput} from './parse.mjs';
import {display, toNumber, toBool, GArray, CellError} from './value.mjs';
import {engineFor} from '../model/calc.mjs';
import {ruleAt, ruleRanges} from './edit-parts.mjs';
import {withCells} from './data-common.mjs';
import {usedBounds} from '../model/store.mjs';
import {toJSONValue} from './value.mjs';

export const DEFAULT_ERROR = "This value doesn't match the data validation restrictions defined for this cell.";

const OPS = {between: 'between', notBetween: 'notBetween', equal: 'equal', notEqual: 'notEqual', greater: 'greaterThan', greaterThan: 'greaterThan',
  less: 'lessThan', lessThan: 'lessThan', greaterOrEqual: 'greaterThanOrEqual', greaterThanOrEqual: 'greaterThanOrEqual',
  lessOrEqual: 'lessThanOrEqual', lessThanOrEqual: 'lessThanOrEqual'};
/** Canonical (xlsx) operator name of a command or file operator; between when absent or unknown. */
export const normalizeOp = op => OPS[op ?? 'between'] ?? 'between';
export const OPERATOR_NAMES = Object.freeze(Object.keys(OPS));

/** Whether a list rule's source is a literal list rather than a reference or a name to evaluate. */
export function isLiteralList(f) {
  if (f.startsWith('"')) return true;
  if (f.includes('!')) return false;
  try { const e = parse(f); return e.t !== 'ref' && e.t !== 'name'; } catch { return true; }
}

/** A list rule's source as a file stores it: a literal list typed without quotes becomes the quoted string Excel saves. */
export function listSource(f) {
  const t = f.trim();
  if (!t || t.startsWith('=') || t.startsWith('"') || !isLiteralList(t)) return f.trim().replace(/^=/, '');
  return `"${t.replaceAll('"', '""')}"`;
}

/** The rule covering a cell, or null. */
export const validationAt = (sheet, at) => ruleAt(sheet?.validations, at);

/** List entries of a list rule (literal or from a range). */
export function listItems(content, si, rule) {
  const f = String(rule.formula1 ?? '').trim();
  if (isLiteralList(f)) {
    const body = f.startsWith('"') && f.endsWith('"') && f.length >= 2 ? f.slice(1, -1).replaceAll('""', '"') : f.replace(/^"+|"+$/g, '');
    return body.split(',').map(x => x.trim()).filter(Boolean);
  }
  const at = ruleRanges(rule)[0]?.start ?? {row: 0, col: 0};
  const v = engineFor(content).evaluate(si, at, f);
  if (v instanceof GArray) return v.data.filter(x => x !== null && x !== undefined && x !== '').map(x => (x instanceof CellError ? x.text : display(x)));
  if (v !== null && v !== undefined && v !== '' && !(v instanceof CellError)) return [display(v)];
  return [];
}

/** A formula written for `first`, as seen from `at` (relative references shifted). */
export function formulaAt(f, first, at) {
  if (first.row === at.row && first.col === at.col) return f;
  try { return print(shiftRelative(parse(String(f).replace(/^=/, '')), at.row - first.row, at.col - first.col)); } catch { return f; }
}

function compareOp(op, n, a, b) {
  if (a === null) return false;
  switch (op) {
    case 'between': return b !== null && n >= Math.min(a, b) && n <= Math.max(a, b);
    case 'notBetween': return b !== null && (n < Math.min(a, b) || n > Math.max(a, b));
    case 'equal': return n === a;
    case 'notEqual': return n !== a;
    case 'greaterThan': return n > a;
    case 'lessThan': return n < a;
    case 'greaterThanOrEqual': return n >= a;
    case 'lessThanOrEqual': return n <= a;
    default: return false;
  }
}

/**
 * Checks typed input against the validation of a cell. null = valid; else {rule, message, title, style}.
 * The formulas are written for the first cell of the rule's range and see the value being entered.
 */
export function checkValidation(content, si, at, input) {
  const sheet = content.sheets[si];
  const rule = validationAt(sheet, at);
  if (!rule || rule.type === 'any' || rule.type === undefined || rule.showErrorMessage === false) return null;
  const text = String(input ?? '');
  if (text === '' && rule.allowBlank) return null;
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const v = parseInput(text, sys).value;
  const first = ruleRanges(rule)[0]?.start ?? at;
  // A trial workbook with the value in the cell, so a formula that reads the cell sees what is being entered.
  const trial = withCells(content, [{sheet: si, row: at.row, col: at.col, value: v instanceof CellError ? toJSONValue(v) : v}]);
  const engine = engineFor(trial);
  const ev = f => engine.evaluate(si, at, formulaAt(f, first, at));
  const num = f => { if (f === undefined || f === null || f === '') return null; const x = toNumber(ev(f), sys); return typeof x === 'number' ? x : null; };
  const op = normalizeOp(rule.operator);
  let ok;
  switch (rule.type) {
    case 'list': ok = listItems(trial, si, rule).some(x => x.toLowerCase() === text.toLowerCase()); break;
    case 'custom': { const b = toBool(ev(rule.formula1 ?? '')); ok = b === true; break; }
    case 'textLength': ok = compareOp(op, [...text].length, num(rule.formula1), num(rule.formula2)); break;
    default:
      if (typeof v === 'number') ok = rule.type === 'whole' && !Number.isInteger(v) ? false : compareOp(op, v, num(rule.formula1), num(rule.formula2));
      else ok = false;
  }
  if (ok) return null;
  return {rule, message: rule.error ? rule.error : DEFAULT_ERROR, title: rule.errorTitle ?? '', style: rule.errorStyle ?? 'stop'};
}

/** Cells of a sheet whose current value fails their rule (Circle Invalid Data), as {row, col}. */
export function invalidCells(content, si, textAt, cap = 100_000) {
  const sheet = content.sheets[si];
  const out = [];
  const u = usedBounds(sheet);
  if (!u) return out;
  for (const rule of sheet.validations ?? []) {
    if (rule.type === 'any' || rule.type === undefined) continue;
    for (const r of ruleRanges(rule)) {
      for (let row = r.start.row; row <= Math.min(r.end.row, u.r1) && out.length < cap; row++) {
        for (let col = r.start.col; col <= Math.min(r.end.col, u.c1); col++) {
          const t = textAt(row, col);
          if (t === null || t === '') continue;
          if (checkValidation(content, si, {row, col}, t)) out.push({row, col});
        }
      }
    }
  }
  return out;
}
