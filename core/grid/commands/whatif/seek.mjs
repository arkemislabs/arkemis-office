// Data > Forecast > What-If Analysis > Goal Seek and Data Table.
// Translated from gridcraft crates/engine/src/cmd/whatif.rs (`Trial`, `seek`, `goal_seek`,
// `data_table`) and cmd/whatif/tests.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every what-if evaluation is a trial: the input cells are overwritten in a copy of the workbook
// and only their dependents are recalculated (lib/data-common.mjs `Trial`); the document changes only
// when a command writes its final answer, as one undo step. Goal Seek finds the input that makes a
// formula cell reach a value (secant search with bisection once the answer is bracketed; stops
// within Maximum Change or after Maximum Iterations from File > Options > Formulas). Data Table
// fills a block with the results of substituting row and column input values (a snapshot of
// values, not a live {=TABLE()}).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {rangeA1, contains, rangeOf} from '../../lib/addr.mjs';
import {parseNumberText} from '../../lib/parse.mjs';
import {CellError, toJSONValue} from '../../lib/value.mjs';
import {engineFor} from '../../model/calc.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {hasDoc, gridSel} from '../../lib/edit-targets.mjs';
import {Trial, parseRangeText, cellArg, valueOf, bad, failed, baseDoc} from '../../lib/data-common.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/whatif.rs', 'crates/engine/src/cmd/whatif/tests.rs']};
const MAX_TABLE_CELLS = 100_000;

/**
 * Finds x with |f(x)| <= tol: secant steps (growing steps while nothing is bracketed), switching to
 * secant-or-bisection inside a sign-change bracket. Returns the best point seen; `f` returns NaN where the model errors.
 */
export function seek(x0In, f, maxIterIn, tolIn) {
  const tol = Number.isFinite(tolIn) && tolIn > 0 ? tolIn : 0.001;
  const maxIter = Math.min(Math.max(Number.isFinite(maxIterIn) ? Math.trunc(maxIterIn) : 100, 1), 10_000);
  const x0 = Number.isFinite(x0In) ? x0In : 0;
  const f0 = f(x0);
  const best = {x: x0, fx: f0};
  const consider = (x, fx) => { if (Number.isFinite(fx) && (!Number.isFinite(best.fx) || Math.abs(fx) < Math.abs(best.fx))) { best.x = x; best.fx = fx; } };
  const done = it => ({x: best.x, fx: best.fx, iterations: it, converged: Number.isFinite(best.fx) && Math.abs(best.fx) <= tol});
  if (Number.isFinite(f0) && Math.abs(f0) <= tol) return done(0);
  const step0 = x0 === 0 ? 0.01 : Math.abs(x0) * 0.01;
  let xa = x0, fa = f0;
  let xb = x0 + step0, fb = f(xb);
  let it = 1;
  consider(xb, fb);
  let bracket = null;   // [lo, flo, hi, fhi] with a sign change
  let slow = 0;
  while (it < maxIter) {
    if (Number.isFinite(fb) && Math.abs(fb) <= tol) break;
    if (!bracket && Number.isFinite(fa) && Number.isFinite(fb) && (fa < 0) !== (fb < 0)) bracket = [xa, fa, xb, fb];
    const secant = Number.isFinite(fa) && Number.isFinite(fb) && fb !== fa ? xb - fb * (xb - xa) / (fb - fa) : NaN;
    let next;
    if (bracket) {
      const [lo, , hi] = bracket;
      const a = Math.min(lo, hi), b = Math.max(lo, hi);
      next = slow >= 2 || !(secant > a && secant < b) ? (lo + hi) / 2 : secant;
    } else {
      const span = Math.max(Math.abs(xb - xa), Number.MIN_VALUE);
      if (!Number.isFinite(fb)) next = (xa + xb) / 2;   // the model errors here: step back towards the last good point
      else if (!Number.isFinite(secant)) next = xb + 2 * (xb - xa);
      else if (Math.abs(secant - xb) > 100 * span + 1) next = xb + Math.sign(secant - xb) * (100 * span + 1);
      else next = secant;
    }
    if (!Number.isFinite(next)) break;
    const fnext = f(next);
    it++;
    consider(next, fnext);
    if (bracket) {
      const [lo, flo, hi, fhi] = bracket;
      const width = Math.abs(hi - lo);
      if (Number.isFinite(fnext)) bracket = (fnext < 0) === (flo < 0) ? [next, fnext, hi, fhi] : [lo, flo, next, fnext];
      else bracket = Math.abs(flo) < Math.abs(fhi) ? [lo, flo, next, fhi] : [next, flo, hi, fhi];
      const [l, , h] = bracket;
      const nw = Math.abs(h - l);
      slow = nw > width * 0.5 ? slow + 1 : 0;
      if (nw <= Number.EPSILON * (1 + Math.max(Math.abs(l), Math.abs(h)))) break;
    }
    xa = xb; fa = fb; xb = next; fb = fnext;
  }
  return done(it);
}

const jsonOf = v => (v === null || v === undefined ? null : v instanceof CellError ? v.text : v);

function goalSeek(ctx, p) {
  const content = baseDoc(ctx);
  const active = gridSel(ctx).sheet;
  const set = cellArg(content, p.set, 'set', 'data.goalSeek', active);
  const chg = cellArg(content, p.changing, 'changing', 'data.goalSeek', active);
  const target = typeof p.to === 'number' ? p.to : typeof p.to === 'string' ? parseNumberText(p.to) : null;
  if (target === null || !Number.isFinite(target)) throw bad('data.goalSeek', '`to` must be a number');
  const hasFormula = c => cellAt(content.sheets[c.sheet], c.cell.row, c.cell.col)?.f !== undefined;
  if (!hasFormula(set)) throw failed('Cell must contain a formula.');
  if (hasFormula(chg)) throw failed('Cell must contain a value.');
  const engine = engineFor(content);
  const x0 = typeof valueOf(engine, chg.sheet, chg.cell.row, chg.cell.col) === 'number' ? valueOf(engine, chg.sheet, chg.cell.row, chg.cell.col) : 0;
  const maxIter = content.calc?.maxIterations ?? 100, tol = content.calc?.maxChange ?? 0.001;
  const trial = new Trial(content);
  const read = [{sheet: set.sheet, row: set.cell.row, col: set.cell.col}];
  const run = x => trial.run([{sheet: chg.sheet, row: chg.cell.row, col: chg.cell.col, value: x}], read)[0];
  const r = seek(x0, x => { const v = run(x); return typeof v === 'number' ? v - target : NaN; }, maxIter, tol);
  const old = cellAt(content.sheets[chg.sheet], chg.cell.row, chg.cell.col);
  writeCell(ctx.change, ctx.doc, chg.sheet, chg.cell.row, chg.cell.col, {v: r.x, ...(old?.s ? {s: old.s} : {})});
  const result = jsonOf(run(r.x));
  // Excel's Goal Seek Status (a notice the worksheet shows when the dialog is open; Cancel there undoes the write).
  ctx.setView({dataNotice: {id: `gs${ctx.host?.uid?.() ?? Date.now()}`, kind: 'goalSeek', set: String(p.set).replace(/\$/g, '').toUpperCase(), to: target, result: typeof result === 'number' ? Math.round(result * 1e6) / 1e6 : String(result), converged: r.converged}});
  return {value: r.x, result, iterations: r.iterations, converged: r.converged};
}

function dataTable(ctx, p) {
  const content = baseDoc(ctx);
  const active = gridSel(ctx).sheet;
  const {sheet: si, range: r} = parseRangeText(content, p.range, 'data.dataTable', active);
  const input = key => (typeof p[key] === 'string' && p[key].trim() ? cellArg(content, p[key], key, 'data.dataTable', active) : null);
  const rowIn = input('rowInput'), colIn = input('columnInput');
  if (!rowIn && !colIn) throw bad('data.dataTable', 'give `rowInput`, `columnInput` or both');
  if (r.end.row - r.start.row < 1 || r.end.col - r.start.col < 1) throw bad('data.dataTable', 'the table needs at least two rows and two columns');
  const r0 = r.start.row, c0 = r.start.col;
  const body = rangeOf(r0 + 1, c0 + 1, r.end.row, r.end.col);
  if ((body.end.row - body.start.row + 1) * (body.end.col - body.start.col + 1) > MAX_TABLE_CELLS) throw bad('data.dataTable', `the table body is too large (${MAX_TABLE_CELLS} cells max)`);
  for (const inp of [rowIn, colIn]) if (inp && inp.sheet === si && contains(r, inp.cell)) throw failed('Input cell reference is not valid.');
  const engine = engineFor(content);
  const trial = new Trial(content);
  const at = (row, col) => ({sheet: si, row, col});
  const out = [];
  let mode;
  if (!rowIn) {
    const reads = []; for (let c = c0 + 1; c <= r.end.col; c++) reads.push(at(r0, c));
    for (let row = r0 + 1; row <= r.end.row; row++) {
      const vals = trial.run([{sheet: colIn.sheet, row: colIn.cell.row, col: colIn.cell.col, value: valueOf(engine, si, row, c0)}], reads);
      vals.forEach((v, k) => out.push([row, c0 + 1 + k, v]));
    }
    mode = 'column';
  } else if (!colIn) {
    const reads = []; for (let row = r0 + 1; row <= r.end.row; row++) reads.push(at(row, c0));
    for (let col = c0 + 1; col <= r.end.col; col++) {
      const vals = trial.run([{sheet: rowIn.sheet, row: rowIn.cell.row, col: rowIn.cell.col, value: valueOf(engine, si, r0, col)}], reads);
      vals.forEach((v, k) => out.push([r0 + 1 + k, col, v]));
    }
    mode = 'row';
  } else {
    const reads = [at(r0, c0)];
    for (let row = r0 + 1; row <= r.end.row; row++) {
      const cv = valueOf(engine, si, row, c0);
      for (let col = c0 + 1; col <= r.end.col; col++) {
        const rv = valueOf(engine, si, r0, col);
        out.push([row, col, trial.run([{sheet: rowIn.sheet, row: rowIn.cell.row, col: rowIn.cell.col, value: rv}, {sheet: colIn.sheet, row: colIn.cell.row, col: colIn.cell.col, value: cv}], reads)[0]]);
      }
    }
    mode = 'twoVariable';
  }
  for (const [row, col, v] of out) {
    const old = cellAt(content.sheets[si], row, col);
    const cell = {};
    const j = v instanceof CellError ? toJSONValue(v) : v;
    if (j !== null && j !== undefined) cell.v = j;
    if (old?.s) cell.s = old.s;
    writeCell(ctx.change, ctx.doc, si, row, col, Object.keys(cell).length ? cell : null);
  }
  return {range: rangeA1(body), cells: out.length, mode, static: true};
}

export default defineCommands({
  family: 'whatif/seek',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.goalSeek', label: 'Goal Seek…', risk: 'edit', dialog: 'dialog.goalSeek',
      description: 'Find the value of the `changing` constant cell that makes the formula cell `set` equal `to`, and write it. → {value, result, iterations, converged}.',
      params: s.object({set: s.string({min: 1, max: 600}), to: s.union([s.number(), s.string({max: 64})]), changing: s.string({min: 1, max: 600})}),
      state: hasDoc,
      run: goalSeek,
    },
    {
      id: 'data.dataTable', label: 'Data Table…', risk: 'edit', dialog: 'dialog.dataTable',
      description: 'Fill a block with the results of substituting values: values down the first column with columnInput, or across the top row with rowInput (formulas on the other edge), or both with the formula in the corner; writes static values (at most 100,000 cells).',
      params: s.object({range: s.string({min: 1, max: 600}), rowInput: s.optional(s.string({max: 600})), columnInput: s.optional(s.string({max: 600}))}),
      state: hasDoc,
      run: dataTable,
    },
  ],
});
