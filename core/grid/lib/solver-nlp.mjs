// Solver: GRG Nonlinear (the name Excel's dialog uses). The method is an augmented-Lagrangian method
// (Powell-Hestenes-Rockafellar) whose inner problems are solved by projected gradient descent with
// Barzilai-Borwein steps and an Armijo line search, on central-difference gradients; variable bounds are
// kept by projection. It finds a local optimum of a smooth model.
// Translated from gridcraft crates/engine/src/cmd/solver/nlp.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A goal is {kind: 'max'} | {kind: 'min'} | {kind: 'value', value}. No DOM, no Node built-ins.

import {PRECISION} from './solver-problem.mjs';
import {solved, INFEASIBLE, UNBOUNDED, LIMIT} from './solver-lp.mjs';

/** Augmented-Lagrangian value of a point: objective `phi` plus the constraint terms. */
function aug(phi, cons, senses, lam, mu) {
  let v = phi;
  for (let i = 0; i < Math.min(cons.length, senses.length, lam.length); i++) {
    const c = cons[i], l = lam[i];
    if (senses[i] === 'eq') v += l * c + 0.5 * mu * c * c;
    else { const t = Math.max(l + mu * c, 0); v += (t * t - l * l) / (2 * mu); }
  }
  return v;
}

/** Constraint values in the `<= 0` / `= 0` form, and the objective to minimise: [phi, cons]. */
export function shape(p, rows, goal) {
  const phi = goal.kind === 'max' ? -p.f : goal.kind === 'min' ? p.f : (p.f - goal.value) * (p.f - goal.value);
  const cons = [];
  for (let i = 0; i < Math.min(p.g.length, rows.length); i++) cons.push(rows[i].sense === 'ge' ? -p.g[i] : p.g[i]);
  return [phi, cons];
}

export function violation(cons, senses) {
  let m = 0;
  for (let i = 0; i < Math.min(cons.length, senses.length); i++) {
    const v = senses[i] === 'eq' ? Math.abs(cons[i]) : Math.max(cons[i], 0);
    m = fmax(m, v);
  }
  return m;
}
/** Rust `f64::max`: a NaN loses against a number. */
const fmax = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));

export function project(x, lo, hi) {
  for (let i = 0; i < Math.min(x.length, lo.length, hi.length); i++) {
    if (x[i] < lo[i]) x[i] = lo[i];
    if (x[i] > hi[i]) x[i] = hi[i];
  }
}

const maxAbs = (v, init = 0) => v.reduce((m, e) => fmax(m, Math.abs(e)), init);

/** Local minimisation of the model within bounds `lo..hi` from `x0`. */
export function nlp(ev, x0, lo, hi, goal) {
  const n = x0.length;
  const rows = ev.rows.slice();
  const senses = rows.map(r => r.sense);
  let x = x0.slice();
  project(x, lo, hi);
  let lam = new Array(rows.length).fill(0);
  let mu = 10;
  const p = ev.evaluate(x);
  if (!p) return LIMIT;
  let [phi, cons] = shape(p, rows, goal);
  if (!Number.isFinite(phi)) return INFEASIBLE;
  const phi0 = phi;
  let prevViol = violation(cons, senses);
  let converged = false, outOfBudget = false, carried = null;
  const lval = (ph, cs, la, m) => aug(ph, cs, senses, la, m);
  const grad = (xs, la, m) => {
    const gr = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      const xj = xs[j] ?? 0;
      const h = 1e-6 * Math.max(Math.abs(xj), 1);
      const l = lo[j] ?? -Infinity, u = hi[j] ?? Infinity;
      const a = xj - h >= l ? xj - h : xj, b = xj + h <= u ? xj + h : xj;
      if (b <= a) continue;
      const xa = xs.slice(), xb = xs.slice();
      xa[j] = a; xb[j] = b;
      const pa = ev.evaluate(xa);
      if (!pa) return null;
      const [pha, ca] = shape(pa, rows, goal);
      const pb = ev.evaluate(xb);
      if (!pb) return null;
      const [phb, cb] = shape(pb, rows, goal);
      const d = (lval(phb, cb, la, m) - lval(pha, ca, la, m)) / (b - a);
      gr[j] = Number.isFinite(d) ? d : 0;
    }
    return gr;
  };
  for (let outer = 0; outer < 40; outer++) {
    // Inner: projected gradient on the augmented Lagrangian.
    let lCur = lval(phi, cons, lam, mu);
    let g = grad(x, lam, mu);
    if (!g) { outOfBudget = true; break; }
    // The step length carries over between outer iterations once known.
    const gnorm = maxAbs(g);
    let alpha = carried ?? (gnorm > 0 ? 1 / gnorm : 1);
    let innerDone = false, quiet = 0;
    for (let inner = 0; inner < 500; inner++) {
      let accepted = null;
      let a = alpha;
      for (let ls = 0; ls < 40; ls++) {
        const xn = x.map((v, i) => v - a * g[i]);
        project(xn, lo, hi);
        const pn = ev.evaluate(xn);
        if (!pn) break;
        const [phn, cn] = shape(pn, rows, goal);
        const ln = lval(phn, cn, lam, mu);
        let decrease = 0;
        for (let i = 0; i < n; i++) decrease += g[i] * (x[i] - xn[i]);
        if (Number.isFinite(ln) && ln <= lCur - 1e-4 * decrease) { accepted = {xn, phn, cn, ln}; break; }
        a *= 0.25;
      }
      if (ev.exhausted()) outOfBudget = true;
      if (!accepted) { innerDone = true; break; }
      const {xn, phn, cn, ln} = accepted;
      // Variables or objective running off towards infinity: unbounded.
      if (Math.abs(phn) > 1e15 * (1 + Math.abs(phi0)) || xn.some((v, i) => Math.abs(v) > 1e15 * (1 + Math.abs(x0[i])))) return UNBOUNDED;
      const s = xn.map((v, i) => v - x[i]);
      const step = maxAbs(s);
      const xmax = maxAbs(xn, 1);
      const small = step <= 1e-10 * xmax || Math.abs(lCur - ln) <= 1e-13 * (1 + Math.abs(lCur));
      quiet = small ? quiet + 1 : 0;
      x = xn; phi = phn; cons = cn; lCur = ln;
      if (quiet >= 3) { innerDone = true; break; }
      const gn = grad(x, lam, mu);
      if (!gn) { outOfBudget = true; break; }
      // Barzilai-Borwein step.
      let sy = 0, ss = 0;
      for (let i = 0; i < n; i++) { sy += s[i] * (gn[i] - g[i]); ss += s[i] * s[i]; }
      alpha = sy > 0 ? Math.min(Math.max(ss / sy, 1e-12), 1e12) : Math.min(a * 4, 1e12);
      g = gn;
      if (g.every(v => v === 0)) { innerDone = true; break; }
    }
    carried = alpha;
    if (outOfBudget) break;
    const viol = violation(cons, senses);
    const scale = rows.reduce((m, r) => fmax(m, Math.abs(r.rhsConst)), 1);
    if (viol <= PRECISION * scale && innerDone) {
      converged = true;
      if (rows.length === 0) break;
    }
    // Multiplier and penalty updates.
    lam = lam.map((l, i) => (senses[i] === 'eq' ? l + mu * cons[i] : Math.max(l + mu * cons[i], 0)));
    if (viol > 0.25 * prevViol) mu = Math.min(mu * 10, 1e10);
    if (converged && viol <= PRECISION * scale * 1e-2) break;
    prevViol = viol;
    converged = false;
  }
  const viol = violation(cons, senses);
  const scale = rows.reduce((m, r) => fmax(m, Math.abs(r.rhsConst)), 1);
  if (viol > PRECISION * scale * 10) return outOfBudget ? LIMIT : INFEASIBLE;
  return solved(x, phi, (converged || viol <= PRECISION * scale) && !outOfBudget);
}
