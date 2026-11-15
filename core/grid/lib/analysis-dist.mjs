// The distribution values the Analysis ToolPak reports need: Student's t and the F distribution
// (T.DIST.RT, T.DIST.2T, T.INV, T.INV.2T, F.DIST, F.DIST.RT, F.INV, F.INV.RT).
// Translated from gridcraft crates/engine/src/cmd/analysis.rs at 146161b4b450a56e5e59a083ba0478582d1e602b
// (which calls the worksheet functions of those names; the worksheet library here does not carry the
// probability distributions beyond the normal one yet, so the small numerical routines live here).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every function returns a number, NaN when Excel's function would be #NUM! (degrees of freedom below
// 1, a probability outside its range). Degrees of freedom are truncated to whole numbers as Excel does.
// No DOM, no Node built-ins.

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction of the incomplete beta function (modified Lentz). */
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 20000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b). */
export function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

const dof = d => Math.trunc(d);

/** P(|T| > t) for Student's t with df degrees of freedom (t >= 0). */
function tail2(t, df) { return betaInc(df / (df + t * t), df / 2, 0.5); }

/** T.DIST.2T(x, df): two-tailed probability; x must be >= 0. */
export function tDist2T(x, df) {
  df = dof(df);
  if (!Number.isFinite(x) || x < 0 || !(df >= 1)) return NaN;
  return tail2(x, df);
}
/** T.DIST.RT(x, df): right-tailed probability (x may be negative). */
export function tDistRT(x, df) {
  df = dof(df);
  if (!Number.isFinite(x) || !(df >= 1)) return NaN;
  const h = tail2(Math.abs(x), df) / 2;
  return x >= 0 ? h : 1 - h;
}

/** The t above which a two-tailed probability p remains. */
export function tInv2T(p, df) {
  df = dof(df);
  if (!(p > 0 && p <= 1) || !(df >= 1)) return NaN;
  if (p === 1) return 0;
  let hi = 1;
  while (tail2(hi, df) > p) { hi *= 2; if (hi > 1e300) return NaN; }
  let lo = 0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tail2(mid, df) > p) lo = mid; else hi = mid;
    if (hi - lo <= hi * 1e-16) break;
  }
  return (lo + hi) / 2;
}
/** T.INV(p, df): the left-tailed inverse. */
export function tInv(p, df) {
  if (!(p > 0 && p < 1)) return NaN;
  if (p === 0.5) return 0;
  return p < 0.5 ? -tInv2T(2 * p, df) : tInv2T(2 * (1 - p), df);
}

/** F.DIST(x, d1, d2, TRUE): the left-tailed cumulative probability. */
export function fDist(x, d1, d2) {
  d1 = dof(d1); d2 = dof(d2);
  if (!Number.isFinite(x) || x < 0 || !(d1 >= 1) || !(d2 >= 1)) return NaN;
  return betaInc((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2);
}
/** F.DIST.RT(x, d1, d2): the right-tailed probability. */
export function fDistRT(x, d1, d2) {
  d1 = dof(d1); d2 = dof(d2);
  if (!Number.isFinite(x) || x < 0 || !(d1 >= 1) || !(d2 >= 1)) return NaN;
  return betaInc(d2 / (d2 + d1 * x), d2 / 2, d1 / 2);
}

/** Finds x >= 0 where the monotone `f` crosses `target`; `rising` is whether `f` grows with x. */
function solve(f, target, rising) {
  let hi = 1;
  const past = v => (rising ? v >= target : v <= target);
  while (!past(f(hi))) { hi *= 2; if (hi > 1e300) return NaN; }
  let lo = 0;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (past(f(mid))) hi = mid; else lo = mid;
    if (hi - lo <= hi * 1e-16) break;
  }
  return (lo + hi) / 2;
}
/** F.INV(p, d1, d2): the left-tailed inverse. */
export function fInv(p, d1, d2) {
  d1 = dof(d1); d2 = dof(d2);
  if (!(p > 0 && p < 1) || !(d1 >= 1) || !(d2 >= 1)) return NaN;
  return solve(x => fDist(x, d1, d2), p, true);
}
/** F.INV.RT(p, d1, d2): the right-tailed inverse. */
export function fInvRT(p, d1, d2) {
  d1 = dof(d1); d2 = dof(d2);
  if (!(p > 0 && p < 1) || !(d1 >= 1) || !(d2 >= 1)) return NaN;
  return solve(x => fDistRT(x, d1, d2), p, false);
}
