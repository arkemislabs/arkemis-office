// Solver: runs the model's solving method for a goal within the variable bounds.
// Translated from gridcraft crates/engine/src/cmd/solver.rs (`Solve`, `Bounds`, `optimise`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A solve is {outcome, notLinear, evoEnd}. No DOM, no Node built-ins.

import {LP_WORK, MAX_NODES_LP, MAX_NODES_NLP} from './solver-problem.mjs';
import {INFEASIBLE, LIMIT, branchAndBound, linearize, solveLp} from './solver-lp.mjs';
import {nlp, project} from './solver-nlp.mjs';
import {evolutionary} from './solver-evo.mjs';

/** Runs the model's method for `goal` within `bounds` ({lo, hi, integer}) from `x0`; `gap` is the integer optimality gap (0..1). */
export function optimise(ev, m, goal, x0, bounds, gap) {
  const {lo, hi, integer} = bounds;
  const anyInt = integer.some(b => b);
  let notLinear = false, evoEnd = null, outcome;
  if (lo.some((l, i) => l > hi[i])) outcome = INFEASIBLE;
  else if (m.method === 'simplex') {
    const lin = linearize(ev, x0);
    if (lin.err === 'nonlinear' || lin.err === 'error') { notLinear = true; outcome = INFEASIBLE; }
    else if (lin.err) outcome = LIMIT;
    else {
      const {cf, fConst, rows: linRows} = lin;
      const rows = linRows.map((r, i) => [r.a.slice(), ev.rows[i].sense, -r.k]);
      let c;
      if (goal.kind === 'max') c = cf.map(v => -v);
      else if (goal.kind === 'min') c = cf.slice();
      else { rows.push([cf.slice(), 'eq', goal.value - fConst]); c = new Array(cf.length).fill(0); }
      const size = (rows.length + 2 * x0.length + 1) * (4 * x0.length + 2 * rows.length + 1);
      const work = {n: Math.max(LP_WORK, size)};
      const relax = (l, h) => solveLp(c, rows, l, h, work);
      outcome = anyInt ? branchAndBound(lo, hi, integer, MAX_NODES_LP, gap, relax).outcome : relax(lo, hi);
    }
  } else if (m.method === 'grg') {
    if (anyInt) {
      const relax = (l, h) => {
        const start = x0.slice();
        project(start, l, h);
        return nlp(ev, start, l, h, goal);
      };
      outcome = branchAndBound(lo, hi, integer, MAX_NODES_NLP, gap, relax).outcome;
    } else outcome = nlp(ev, x0, lo, hi, goal);
  } else {
    const r = evolutionary(ev, x0, lo, hi, integer, goal, m.evo);
    outcome = r.outcome; evoEnd = r.end;
  }
  return {outcome, notLinear, evoEnd};
}
