// Evaluate Formula's stepping: the formula shown with the next part to evaluate underlined, each
// Evaluate replacing that part with its value, left to right and innermost first, as Excel's
// Evaluate Formula dialog does. Each part's value is what gridcraft's `evaluate_formula` computes
// for that sub-expression (crates/engine/src/cmd/formulas.rs:791, `evaluate_expr` per node) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:grid/formulas. No DOM, no Node built-ins.

import {parseName, print} from './formula.mjs';
import {CellError, GArray} from './value.mjs';
import {engineFor} from '../model/calc.mjs';
import {valueJson} from './formulas-names.mjs';

const MARK = '__ARKEMIS_EVAL_NEXT__';

/** A value as a formula literal (what Evaluate puts in place of a part). */
export function literal(v) {
  if (v instanceof CellError) return {t: 'err', v};
  if (v instanceof GArray) {
    const rows = [];
    for (let r = 0; r < v.rows; r++) { const row = []; for (let c = 0; c < v.cols; c++) row.push(literal(v.get(r, c) ?? 0)); rows.push(row); }
    return {t: 'array', rows};
  }
  if (typeof v === 'number') return {t: 'num', v};
  if (typeof v === 'boolean') return {t: 'bool', v};
  if (v === null || v === undefined) return {t: 'num', v: 0};
  return {t: 'str', v: String(v)};
}

/** A copy of `e` where `f(node)` (when it returns a node) replaces a node; identity of the rest kept by position. */
function rebuild(e, f) {
  const r = f(e);
  if (r) return r;
  switch (e.t) {
    case 'array': return {t: 'array', rows: e.rows.map(row => row.map(x => rebuild(x, f)))};
    case 'unary': return {...e, x: rebuild(e.x, f)};
    case 'paren': return {t: 'paren', x: rebuild(e.x, f)};
    case 'binary': return {t: 'binary', op: e.op, a: rebuild(e.a, f), b: rebuild(e.b, f)};
    case 'call': return {t: 'call', name: e.name, args: e.args.map(x => rebuild(x, f))};
    case 'invoke': return {t: 'invoke', callee: rebuild(e.callee, f), args: e.args.map(x => rebuild(x, f))};
    default: return e;
  }
}

const stepped = e => e.t === 'call' || e.t === 'ref' || e.t === 'name' || (e.t === 'binary' && e.op !== ':' && e.op !== ',' && e.op !== ' ');
/** The parts Evaluate steps through, children before their parent, left to right. */
function order(e, out = []) {
  switch (e.t) {
    case 'array': for (const row of e.rows) for (const x of row) order(x, out); break;
    case 'unary': case 'paren': order(e.x, out); break;
    case 'binary': if (e.op === ':' && e.a.t === 'ref' && e.b.t === 'ref') break; order(e.a, out); order(e.b, out); break;
    case 'call': for (const x of e.args) order(x, out); break;
    case 'invoke': order(e.callee, out); for (const x of e.args) order(x, out); break;
    default: break;
  }
  if (stepped(e) || (e.t === 'binary' && e.op === ':')) out.push(e);
  return out;
}
const cellText = e => print(e.t === 'binary' && e.op === ',' ? {t: 'paren', x: e} : e);

/**
 * The Evaluate Formula sequence of a formula (text without `=`) in a cell: frames
 * [{text, underline: [start, end] | null, value}] — frame k shows the formula after k Evaluate
 * presses with the part the next press evaluates underlined (`value` is what it becomes). The
 * last frame is the result, nothing underlined.
 */
export function evaluationFrames(content, si, at, text, limit = 200) {
  const expr = parseName(String(text).replace(/^=/, ''));
  const eng = engineFor(content);
  const parts = order(expr).slice(0, limit);
  const values = parts.map(p => eng.evaluate(si, at, cellText(p)));
  const done = new Set();
  const frames = [];
  const show = extra => rebuild(expr, n => (n === extra ? {t: 'name', v: MARK} : done.has(n) ? literal(values[parts.indexOf(n)]) : null));
  for (let k = 0; k < parts.length; k++) {
    const marked = `=${print(show(parts[k]))}`;
    const i = marked.indexOf(MARK);
    const partText = print(rebuild(parts[k], n => (n !== parts[k] && done.has(n) ? literal(values[parts.indexOf(n)]) : null)));
    const shown = i < 0 ? marked : marked.slice(0, i) + partText + marked.slice(i + MARK.length);
    frames.push({text: shown, underline: i < 0 ? null : [i, i + partText.length], value: valueJson(values[k])});
    done.add(parts[k]);
  }
  const result = eng.evaluate(si, at, cellText(expr));
  frames.push({text: `=${print(literal(result))}`, underline: null, value: valueJson(result)});
  return frames;
}
