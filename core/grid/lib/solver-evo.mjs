// Solver: Evolutionary. A genetic search for models that aren't smooth (IF, lookups, rounding), with
// tournament selection, blend crossover and Gaussian mutation inside the variable bounds,
// feasibility-first ranking and integer rounding, followed by a compass (pattern) search around the best
// member. It stops when the population has converged, when the best member stops improving, or at the
// evaluation budget.
// Translated from gridcraft crates/engine/src/cmd/solver/evolutionary.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The search keeps no clock, so the time without improvement is counted in generations. A small
// deterministic generator (SplitMix64) makes a seed reproduce a run on every platform. No DOM, no Node
// built-ins.

import {MAX_POPULATION, MIN_POPULATION, PRECISION, roundAway} from './solver-problem.mjs';
import {solved, INFEASIBLE, LIMIT} from './solver-lp.mjs';
import {shape, violation, project} from './solver-nlp.mjs';

const M64 = (1n << 64n) - 1n;
const u64 = v => BigInt.asUintN(64, v);

class Rng {
  constructor(seed) { this.s = u64(BigInt(seed) ^ 0x2545_F491_4F6C_DD1Dn); }
  next() {
    this.s = u64(this.s + 0x9E37_79B9_7F4A_7C15n);
    let z = this.s;
    z = u64((z ^ (z >> 30n)) * 0xBF58_476D_1CE4_E5B9n);
    z = u64((z ^ (z >> 27n)) * 0x94D0_49BB_1331_11EBn);
    return (z ^ (z >> 31n)) & M64;
  }
  /** Uniform in [0, 1). */
  uniform() { return Number(this.next() >> 11n) / 9007199254740992; }
  between(a, b) { return a + (b - a) * this.uniform(); }
  below(n) { return n === 0 ? 0 : Number(this.next() % BigInt(n)); }
  /** Standard normal (Box-Muller). */
  normal() {
    const u = Math.max(this.uniform(), Number.MIN_VALUE);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.uniform());
  }
}

/** Feasible beats infeasible; then the lower objective, or the smaller violation. */
function better(a, o, tol) {
  const fa = a.viol <= tol, fo = o.viol <= tol;
  if (fa && !fo) return true;
  if (!fa && fo) return false;
  return fa ? a.phi < o.phi : a.viol < o.viol;
}

/** The search box, integer flags and scoring shared by the genetic and pattern phases. */
class EvoSearch {
  constructor(ev, rows, senses, goal, lo, hi, integer, tol) {
    this.ev = ev; this.rows = rows; this.senses = senses; this.goal = goal; this.lo = lo; this.hi = hi; this.integer = integer; this.tol = tol;
  }
  /** Clamps into the box and rounds integer variables. */
  repair(x) {
    for (let j = 0; j < x.length; j++) {
      const l = this.lo[j] ?? 0, h = this.hi[j] ?? 0;
      x[j] = Number.isFinite(x[j]) ? Math.min(Math.max(x[j], l), h) : l;
      if (this.integer[j]) x[j] = Math.min(Math.max(roundAway(x[j]), Math.ceil(l)), Math.floor(h));
    }
  }
  /** Scores `x`; null once the budget is spent. */
  score(x) {
    const p = this.ev.evaluate(x);
    if (!p) return null;
    const [phi0, cons] = shape(p, this.rows, this.goal);
    let viol = violation(cons, this.senses);
    const phi = Number.isFinite(phi0) ? phi0 : Infinity;
    viol = Number.isFinite(viol) && cons.every(c => Number.isFinite(c)) ? viol : Infinity;
    return {x, phi, viol};
  }
}

const sameX = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The Evolutionary method within `lo..hi` from `x0`: {outcome, end} with end 'converged' | 'stalled' | 'budget'. */
export function evolutionary(ev, x0, lo, hi, integer, goal, o) {
  const rows = ev.rows.slice();
  const senses = rows.map(r => r.sense);
  const scale = rows.reduce((m, r) => Math.max(m, Math.abs(r.rhsConst)), 1);
  const start = x0.slice();
  project(start, lo, hi);
  // Without a bound, search within 100 of the start.
  const blo = lo.map((l, i) => (Number.isFinite(l) ? l : start[i] - 100));
  const bhi = hi.map((h, i) => (Number.isFinite(h) ? h : start[i] + 100));
  const noInteger = blo.some((l, i) => integer[i] && Math.ceil(l) > Math.floor(bhi[i]));
  if (blo.some((l, i) => l > bhi[i]) || noInteger) return {outcome: INFEASIBLE, end: 'converged'};
  const span = blo.map((l, i) => Math.max(bhi[i] - l, 1e-9));
  const se = new EvoSearch(ev, rows, senses, goal, blo, bhi, integer, PRECISION * scale);
  const rng = new Rng(o.seed);
  const size = Math.min(Math.max(o.population, MIN_POPULATION), MAX_POPULATION);
  const tol = se.tol;
  let end = 'budget';
  // The first generation: the start and random points in the box.
  let pop = [];
  se.repair(start);
  let nextX = start;
  while (pop.length < size) {
    let x = nextX; nextX = null;
    if (!x) { x = se.lo.map((l, i) => rng.between(l, se.hi[i])); se.repair(x); }
    const m = se.score(x);
    if (!m) break;
    pop.push(m);
  }
  let best = null;
  for (const m of pop) if (!best || better(m, best, tol)) best = m;
  let lastImproved = 0, generation = 0;
  search: while (pop.length === size) {
    const b = best;
    if (!b) break;
    // Converged: 99% of the population is feasible and within Convergence of the best.
    const close = pop.filter(m => m.viol <= tol && Math.abs(m.phi - b.phi) <= o.convergence * Math.max(Math.abs(b.phi), 1)).length;
    if (b.viol <= tol && generation >= 5 && close * 100 >= size * 99) { end = 'converged'; break; }
    if (Math.max(generation - lastImproved, 0) >= o.stall) { end = 'stalled'; break; }
    // The next generation: the best survives, the rest are children of two tournaments.
    const next = [b];
    while (next.length < size) {
      const parent = () => {
        const i = rng.below(size), k = rng.below(size);
        const p = pop[i], q = pop[k];
        return p && q ? (better(q, p, tol) ? q.x : p.x) : null;
      };
      const pa = parent(), pb = parent();
      if (!pa || !pb) break search;
      const x = pa.map((a, i) => {
        const c = pb[i], w = span[i];
        let v = a + rng.between(-0.25, 1.25) * (c - a);
        if (rng.uniform() < o.mutation) v += 0.1 * w * rng.normal();
        return v;
      });
      se.repair(x);
      const m = se.score(x);
      if (!m) break search;
      next.push(m);
    }
    generation++;
    for (const m of next) {
      const cur = best;
      if (!cur) continue;
      if (better(m, cur, tol)) {
        const improved = cur.viol > tol || cur.phi - m.phi > 1e-9 * Math.max(Math.abs(cur.phi), 1);
        best = m;
        if (improved) lastImproved = generation;
      }
    }
    pop = next;
  }
  // Polish: a compass search on the continuous variables around the best member.
  if (best) {
    let b = best;
    const step = span.map(w => 0.01 * w);
    const n = b.x.length;
    polish: for (let it = 0; it < 10_000; it++) {
      if (step.every((s, i) => integer[i] || s <= 1e-9 * Math.max(span[i], 1))) break;
      let moved = false;
      for (let j = 0; j < n; j++) {
        if (integer[j]) continue;
        for (const dir of [1, -1]) {
          const x = b.x.slice();
          if (j < x.length && j < step.length) x[j] += dir * step[j];
          se.repair(x);
          if (sameX(x, b.x)) continue;
          const m = se.score(x);
          if (!m) break polish;
          if (better(m, b, tol)) { b = m; moved = true; break; }
        }
      }
      if (!moved) for (let i = 0; i < step.length; i++) step[i] *= 0.5;
    }
    best = b;
  }
  if (best && best.viol <= tol) return {outcome: solved(best.x, best.phi, end !== 'budget'), end};
  return {outcome: end === 'budget' ? LIMIT : INFEASIBLE, end};
}
