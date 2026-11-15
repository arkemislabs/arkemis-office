// Solver: Simplex LP. The model is linearised from n + 1 evaluations and checked for linearity at one more
// point; a dense two-phase simplex (Dantzig's rule, Bland's rule when it stalls) solves it exactly, and
// integer or binary constraints use depth-first branch and bound.
// Translated from gridcraft crates/engine/src/cmd/solver/lp.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// An outcome is {kind: 'solved', x, obj, converged} | {kind: 'infeasible'} | {kind: 'unbounded'} | {kind: 'limit'}
// (`obj` is the objective to minimise). Budgets are {n} objects so one budget is shared by every node.
// No DOM, no Node built-ins.

import {EPS, roundAway} from './solver-problem.mjs';

export const solved = (x, obj, converged) => ({kind: 'solved', x, obj, converged});
export const INFEASIBLE = {kind: 'infeasible'};
export const UNBOUNDED = {kind: 'unbounded'};
export const LIMIT = {kind: 'limit'};

const flip = sense => (sense === 'le' ? 'ge' : sense === 'ge' ? 'le' : 'eq');

function mapVariables(n, lo, hi) {
  const columns = [], offset = new Array(n).fill(0), boundRows = [];
  for (let j = 0; j < n; j++) {
    const lower = lo[j] ?? -Infinity, upper = hi[j] ?? Infinity;
    if (Number.isFinite(lower)) {
      offset[j] = lower;
      columns.push({var: j, sign: 1});
      if (Number.isFinite(upper)) boundRows.push([[[columns.length - 1, 1]], 'le', upper - lower]);
    } else if (Number.isFinite(upper)) {
      offset[j] = upper;
      columns.push({var: j, sign: -1});
    } else {
      columns.push({var: j, sign: 1});
      columns.push({var: j, sign: -1});
    }
  }
  return {columns, offset, boundRows};
}

function normalizeRows(rows, boundRows, columns, offset) {
  const width = columns.length;
  const transformed = [];
  for (const [coefficients, sense, rhs] of rows) {
    const row = new Array(width).fill(0);
    columns.forEach((mp, i) => { row[i] = (coefficients[mp.var] ?? 0) * mp.sign; });
    let shift = 0;
    for (let i = 0; i < coefficients.length && i < offset.length; i++) shift += coefficients[i] * offset[i];
    transformed.push([row, sense, rhs - shift]);
  }
  for (const [entries, sense, rhs] of boundRows) {
    const row = new Array(width).fill(0);
    for (const [index, value] of entries) if (index < width) row[index] = value;
    transformed.push([row, sense, rhs]);
  }
  // Rows with a negative right side are negated so every right side is >= 0.
  return transformed.map(([row, sense, rhs]) => (rhs < 0 ? [row.map(v => -v), flip(sense), -rhs] : [row, sense, rhs]));
}

function buildTableau(normalized, decisionCols, slackCols, artificialCols) {
  const width = decisionCols + slackCols + artificialCols;
  const rows = [], basis = new Array(normalized.length).fill(0);
  let slack = decisionCols, artificial = decisionCols + slackCols;
  normalized.forEach(([coefficients, sense, rhs], i) => {
    const row = new Array(width + 1).fill(0);
    for (let k = 0; k < coefficients.length && k < row.length; k++) row[k] = coefficients[k];
    let basic;
    if (sense === 'le') { row[slack] = 1; basic = slack; slack++; }
    else if (sense === 'ge') { row[slack] = -1; slack++; row[artificial] = 1; basic = artificial; artificial++; }
    else { row[artificial] = 1; basic = artificial; artificial++; }
    row[width] = rhs;
    basis[i] = basic;
    rows.push(row);
  });
  return {rows, basis, width, decisionCols, slackCols, artificialCols};
}

/** Phase one: drives the artificial columns out; returns an outcome when the model is infeasible or the budget is spent. */
function phaseOne(t, normalized, budget) {
  if (t.artificialCols === 0) return null;
  const objective = new Array(t.width + 1).fill(0);
  for (let column = t.decisionCols + t.slackCols; column < t.width; column++) objective[column] = 1;
  t.rows.forEach((row, i) => {
    if (t.basis[i] >= t.decisionCols + t.slackCols) for (let k = 0; k < objective.length; k++) objective[k] -= row[k] ?? 0;
  });
  const all = new Array(t.width).fill(true);
  if (simplex(t.rows, t.basis, objective, all, budget) === 'limit') return LIMIT;
  const scale = normalized.reduce((m, row) => Math.max(m, Math.abs(row[2])), 1);
  if (-(objective[t.width] ?? 0) > 1e-7 * scale) return INFEASIBLE;
  for (let i = 0; i < t.rows.length; i++) {
    if (!(t.basis[i] >= t.decisionCols + t.slackCols)) continue;
    let pivotCol = -1;
    for (let column = 0; column < t.decisionCols + t.slackCols; column++) if (Math.abs(t.rows[i][column] ?? 0) > EPS) { pivotCol = column; break; }
    if (pivotCol >= 0) { pivot(t.rows, objective, i, pivotCol); t.basis[i] = pivotCol; }
  }
  return null;
}

/**
 * Depth-first branch and bound over a relaxation solver; returns {outcome, nodes} with the best integer point.
 * `relax(lo, hi)` solves a relaxation.
 */
export function branchAndBound(lo, hi, integer, maxNodes, gap, relax) {
  const stack = [[lo.slice(), hi.slice()]];
  let best = null, nodes = 0, limited = false, root = true;
  while (stack.length) {
    const [l, h] = stack.pop();
    if (nodes >= maxNodes) { limited = true; break; }
    nodes++;
    const out = relax(l, h);
    const wasRoot = root;
    root = false;
    let x, obj, converged;
    if (out.kind === 'solved') ({x, obj, converged} = out);
    else if (out.kind === 'unbounded' && wasRoot) return {outcome: UNBOUNDED, nodes};
    else if (out.kind === 'limit') { limited = true; break; } else continue;
    if (!converged) limited = true;
    if (best && obj >= best.obj - gap * Math.max(Math.abs(best.obj), 1e-12) - 1e-9 * (1 + Math.abs(best.obj))) continue;
    // The most fractional integer variable (the last one among equals, as Rust's `max_by`).
    let frac = null;
    for (let j = 0; j < x.length; j++) {
      if (!integer[j]) continue;
      const f = Math.abs(x[j] - roundAway(x[j]));
      if (f > 1e-6 && (frac === null || f >= frac.f)) frac = {j, f};
    }
    if (frac === null) {
      best = {x: x.map((v, j) => (integer[j] ? roundAway(v) : v)), obj};
    } else {
      const j = frac.j, v = x[j];
      const downH = h.slice(), upL = l.slice();
      downH[j] = Math.min(downH[j], Math.floor(v));
      upL[j] = Math.max(upL[j], Math.ceil(v));
      // Explore the nearer side first (pushed last).
      if (v - Math.floor(v) < 0.5) { stack.push([upL, h]); stack.push([l, downH]); } else { stack.push([l, downH]); stack.push([upL, h]); }
    }
  }
  if (best) return {outcome: solved(best.x, best.obj, !limited), nodes};
  return {outcome: limited ? LIMIT : INFEASIBLE, nodes};
}

/** Pivots the tableau on (r, j), updating the objective row. */
function pivot(t, obj, r, j) {
  const prow = t[r];
  const pv = prow[j] ?? 0;
  if (pv === 0) return;
  for (let k = 0; k < prow.length; k++) prow[k] /= pv;
  for (let i = 0; i < t.length; i++) {
    if (i === r) continue;
    const row = t[i];
    const f = row[j] ?? 0;
    if (f !== 0) for (let k = 0; k < row.length; k++) row[k] -= f * prow[k];
  }
  const f = obj[j] ?? 0;
  if (f !== 0) for (let k = 0; k < obj.length; k++) obj[k] -= f * prow[k];
}

/** Minimises with the reduced costs in `obj` (last entry: -objective). Columns not `allowed` never enter. Returns 'optimal', 'unbounded' or 'limit'. */
function simplex(t, basis, obj, allowed, budget) {
  const n = Math.max(obj.length - 1, 0);
  const cost = Math.max((t.length + 1) * (n + 1), 1);
  let stalled = 0;
  for (;;) {
    if (budget.n < cost) return 'limit';
    budget.n -= cost;
    const bland = stalled > 50;
    let enter = -1, best = -EPS;
    for (let j = 0; j < n; j++) {
      const d = obj[j];
      if (!allowed[j] || d >= -EPS) continue;
      if (bland) { enter = j; break; }
      if (d < best) { best = d; enter = j; }
    }
    if (enter < 0) return 'optimal';
    const j = enter;
    let leave = null;
    for (let i = 0; i < t.length; i++) {
      const row = t[i];
      const a = row[j] ?? 0;
      if (a <= EPS) continue;
      const ratio = (row[n] ?? 0) / a;
      const better = leave === null || ratio < leave.ratio - 1e-12 || (ratio <= leave.ratio + 1e-12 && basis[i] < basis[leave.i]);
      if (better) leave = {i, ratio};
    }
    if (leave === null) return 'unbounded';
    stalled = leave.ratio <= EPS ? stalled + 1 : 0;
    pivot(t, obj, leave.i, j);
    basis[leave.i] = j;
  }
}

/** Minimises `c.x` subject to `rows` ([coefficients, sense, rhs]) and `lo <= x <= hi`. */
export function solveLp(c, rows, lo, hi, budget) {
  for (let j = 0; j < Math.min(lo.length, hi.length); j++) if (lo[j] > hi[j]) return INFEASIBLE;
  // x_j = offset + sum sign * y_k with y >= 0.
  const {columns: cols, offset, boundRows: extra} = mapVariables(c.length, lo, hi);
  const ny = cols.length;
  const normalized = normalizeRows(rows, extra, cols, offset);
  const nSlack = normalized.filter(r => r[1] !== 'eq').length;
  const nArt = normalized.filter(r => r[1] !== 'le').length;
  const tableau = buildTableau(normalized, ny, nSlack, nArt);
  const failed = phaseOne(tableau, normalized, budget);
  if (failed) return failed;
  const {rows: t, basis, width} = tableau;
  const isArt = column => column >= ny + nSlack && column < width;
  // Phase 2: the real costs; artificials may not re-enter.
  const cost = new Array(width + 1).fill(0);
  cols.forEach((mp, k) => { cost[k] = (c[mp.var] ?? 0) * mp.sign; });
  const obj = cost.slice();
  t.forEach((row, i) => {
    const cb = cost[basis[i]] ?? 0;
    if (cb !== 0) for (let k = 0; k < obj.length; k++) obj[k] -= cb * (row[k] ?? 0);
  });
  const allowed = Array.from({length: width}, (_, j) => !isArt(j));
  const step = simplex(t, basis, obj, allowed, budget);
  if (step === 'limit') return LIMIT;
  if (step === 'unbounded') return UNBOUNDED;
  const y = new Array(width).fill(0);
  t.forEach((row, i) => { if (basis[i] !== undefined && row[width] !== undefined) y[basis[i]] = row[width]; });
  const x = offset.slice();
  cols.forEach((mp, k) => { x[mp.var] += mp.sign * (y[k] ?? 0); });
  let val = 0;
  for (let j = 0; j < Math.min(c.length, x.length); j++) val += c[j] * x[j];
  return solved(x, val, true);
}

/**
 * Linearises the model at `x0` (n + 1 evaluations) and checks it at one more point. Returns {cf, fConst, rows} (the objective
 * gradient and constant, and per row the gradient and constant of `lhs - rhs`), or {err: 'budget'|'error'|'nonlinear'}.
 */
export function linearize(ev, x0) {
  const n = x0.length;
  const p0 = ev.evaluate(x0);
  if (!p0) return {err: 'budget'};
  if (!Number.isFinite(p0.f) || p0.g.some(v => !Number.isFinite(v))) return {err: 'error'};
  const cf = new Array(n).fill(0);
  const ga = p0.g.map(() => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const x = x0.slice();
    x[j] += 1;
    const p = ev.evaluate(x);
    if (!p) return {err: 'budget'};
    cf[j] = p.f - p0.f;
    ga.forEach((row, i) => { row[j] = p.g[i] - p0.g[i]; });
  }
  const dot = (a, x) => { let s = 0; for (let i = 0; i < Math.min(a.length, x.length); i++) s += a[i] * x[i]; return s; };
  const fConst = p0.f - dot(cf, x0);
  const rows = ga.map((a, i) => ({a, k: p0.g[i] - dot(a, x0)}));
  // Linearity check at a spread-out point.
  const xt = x0.map((v, j) => v + (j % 2 === 0 ? 1.7 + 0.3 * (j % 5) : -0.6 - 0.2 * (j % 3)));
  const pt = ev.evaluate(xt);
  if (!pt) return {err: 'budget'};
  const close = (actual, pred, terms) => Number.isFinite(actual) && Math.abs(actual - pred) <= 1e-6 * (1 + Math.abs(actual) + terms);
  const terms = a => { let s = 0; for (let i = 0; i < Math.min(a.length, xt.length); i++) s += Math.abs(a[i] * xt[i]); return s; };
  if (!close(pt.f, fConst + dot(cf, xt), terms(cf))) return {err: 'nonlinear'};
  for (let i = 0; i < rows.length; i++) {
    if (!close(pt.g[i], rows[i].k + dot(rows[i].a, xt), terms(rows[i].a))) return {err: 'nonlinear'};
  }
  return {cf, fConst, rows};
}
