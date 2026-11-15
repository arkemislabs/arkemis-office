// Solver (Data > Analysis > Solver): the constants, the evaluator the solving methods call, and the
// split of the constraints into variable bounds and general rows.
// Translated from gridcraft crates/engine/src/cmd/solver.rs (constants) and
// crates/engine/src/cmd/solver/problem.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The workbook is the model: every evaluation sets the variable cells on a trial copy of the workbook
// (lib/data-common.mjs `Trial`) and recalculates their dependents, so any formula works. Work is
// bounded by an evaluation budget (no clock). A cell is {row, col}; a constraint row is
// {lhs: cell, sense: 'le'|'ge'|'eq', rhs: cell|null, rhsConst}. No DOM, no Node built-ins.

import {MAX_COLS} from './addr.mjs';
import {GArray} from './value.mjs';

/** Excel's limit on decision variables. */
export const MAX_VARS = 200;
/** Most scalar constraints (after expanding ranges). */
export const MAX_CONSTRAINTS = 1000;
export const DEFAULT_EVALS = 20_000;
export const MAX_EVALS = 200_000;
/** Most simplex pivots x tableau cells per solve. */
export const LP_WORK = 2_000_000_000;
export const MAX_NODES_LP = 10_000;
export const MAX_NODES_NLP = 200;
/** Evolutionary population sizes. */
export const MIN_POPULATION = 10;
export const MAX_POPULATION = 1000;
/** Constraint precision (Excel's default 0.000001). */
export const PRECISION = 1e-6;
export const EPS = 1e-9;

/** Rust `f64::round`: halves round away from zero (Math.round rounds them up). */
export const roundAway = v => (v < 0 ? -Math.round(-v) : Math.round(v));
export const cellKey = c => c.row * MAX_COLS + c.col;
export const sameCell = (a, b) => a.row === b.row && a.col === b.col;

/** The number the solvers see in a cell value: blank 0, TRUE 1, anything but a number NaN. */
export function asNum(v) {
  if (v instanceof GArray) v = v.data[0] ?? null;
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

/**
 * Evaluates the model at a point: the objective and `lhs - rhs` per row. `target` is set for the
 * Limits report, where the objective is that variable itself.
 */
export class Evaluator {
  constructor({trial, sheet, vars, objective, rows, budget}) {
    this.trial = trial; this.sheet = sheet; this.vars = vars; this.objective = objective; this.rows = rows;
    this.evals = 0; this.budget = budget; this.target = null;
  }
  exhausted() { return this.evals >= this.budget; }
  /** Evaluates the model at `x`; null once the budget is spent. Returns {f, g}. */
  evaluate(x) {
    if (this.exhausted()) return null;
    this.evals++;
    const sheet = this.sheet;
    const sets = this.vars.map((c, i) => ({sheet, row: c.row, col: c.col, value: x[i]}));
    const reads = [{sheet, row: this.objective.row, col: this.objective.col}];
    for (const r of this.rows) {
      reads.push({sheet, row: r.lhs.row, col: r.lhs.col});
      if (r.rhs) reads.push({sheet, row: r.rhs.row, col: r.rhs.col});
    }
    const vals = this.trial.run(sets, reads);
    let k = 0;
    let f = k < vals.length ? asNum(vals[k++]) : NaN;
    if (this.target !== null) f = x[this.target] ?? NaN;
    const g = [];
    for (const r of this.rows) {
      const l = k < vals.length ? asNum(vals[k++]) : NaN;
      const rv = r.rhs ? (k < vals.length ? asNum(vals[k++]) : NaN) : r.rhsConst;
      g.push(l - rv);
    }
    return {f, g};
  }
}

/** Splits the constraints into variable bounds and general rows: {lo, hi, integer, rows}. */
export function buildProblem(m) {
  const n = m.vars.length;
  const lo = new Array(n).fill(-Infinity), hi = new Array(n).fill(Infinity);
  const hasLower = new Array(n).fill(false), integer = new Array(n).fill(false);
  const rows = [];
  const index = new Map(m.vars.map((c, j) => [cellKey(c), j]));
  for (const c of m.cons) {
    c.lhs.forEach((cell, k) => {
      const j = index.get(cellKey(cell));
      if (c.rel === 'int' || c.rel === 'bin') {
        if (j !== undefined) {
          integer[j] = true;
          if (c.rel === 'bin') { lo[j] = Math.max(lo[j], 0); hi[j] = Math.min(hi[j], 1); hasLower[j] = true; }
        }
        return;
      }
      const sense = c.rel === 'le' ? 'le' : c.rel === 'ge' ? 'ge' : 'eq';
      let rhs = null, rhsConst = 0;
      if (c.rhs.kind === 'const') rhsConst = c.rhs.value;
      else if (c.rhs.kind === 'cells') rhs = c.rhs.cells[k] ?? c.rhs.cells[0] ?? null;
      if (j !== undefined && rhs === null) {
        // A constant bound on a variable cell is a box bound.
        if (sense !== 'ge') hi[j] = Math.min(hi[j], rhsConst);
        if (sense !== 'le') { lo[j] = Math.max(lo[j], rhsConst); hasLower[j] = true; }
      } else rows.push({lhs: cell, sense, rhs, rhsConst});
    });
  }
  if (m.nonNegative) for (let j = 0; j < n; j++) if (!hasLower[j]) lo[j] = Math.max(lo[j], 0);
  return {lo, hi, integer, rows};
}
