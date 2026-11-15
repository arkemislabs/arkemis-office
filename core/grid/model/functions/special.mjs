// Numeric special functions: gamma, error function, incomplete gamma, the normal distribution.
// Translated from gridcraft crates/functions/src/special.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

const PI = Math.PI;
const LANCZOS_G = 7;
const LANCZOS = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];

/** ln |Γ(x)|; NaN at non-positive integers. */
export function lnGamma(x0) {
  let x = x0;
  if (!Number.isFinite(x)) return NaN;
  if (x <= 0 && x === Math.floor(x)) return NaN;
  if (x < 0.5) return Math.log(PI / Math.abs(Math.sin(PI * x))) - lnGamma(1 - x);
  if (x < 15 && x === Math.floor(x)) { let fct = 1; for (let i = 2; i < x; i++) fct *= i; return Math.log(fct); }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export function gamma(x) {
  if (!Number.isFinite(x) || (x <= 0 && x === Math.floor(x))) return NaN;
  if (x === Math.floor(x) && x <= 171) { let fct = 1; for (let i = 2; i < x; i++) fct *= i; return fct; }
  if (x < 0.5) return PI / (Math.sin(PI * x) * gamma(1 - x));
  if (x > 171.7) return Infinity;
  return Math.exp(lnGamma(x));
}

export const lnBeta = (a, b) => lnGamma(a) + lnGamma(b) - lnGamma(a + b);

function gammaSeries(a, x) {
  let ap = a, sum = 1 / a, del = sum;
  for (let i = 0; i < 10_000; i++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-17) break; }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}
function gammaCf(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-17) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}
export function regGammaP(a, x) {
  if (Number.isNaN(a) || a <= 0 || Number.isNaN(x) || x < 0 || !Number.isFinite(a)) return NaN;
  if (x === 0) return 0;
  if (!Number.isFinite(x)) return 1;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaCf(a, x);
}
export function regGammaQ(a, x) {
  if (Number.isNaN(a) || a <= 0 || Number.isNaN(x) || x < 0 || !Number.isFinite(a)) return NaN;
  if (x === 0) return 1;
  if (!Number.isFinite(x)) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaCf(a, x);
}
export function erf(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === 0) return 0;
  if (Math.abs(x) < 0.5) {
    let sum = x, term = x;
    const x2 = x * x;
    for (let n = 1; n < 60; n++) { term *= -x2 / n; const add = term / (2 * n + 1); sum += add; if (Math.abs(add) < 1e-18 * Math.abs(sum)) break; }
    return (sum * 2) / Math.sqrt(PI);
  }
  const p = regGammaP(0.5, x * x);
  return x < 0 ? -p : p;
}
export function erfc(x) {
  if (Number.isNaN(x)) return NaN;
  if (Math.abs(x) < 0.5) return 1 - erf(x);
  return x > 0 ? regGammaQ(0.5, x * x) : 1 + regGammaP(0.5, x * x);
}
export const normPdf = z => Math.exp(-0.5 * z * z) / Math.sqrt(2 * PI);
export const normCdf = z => 0.5 * erfc(-z / Math.SQRT2);
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
/** Inverse of the standard normal CDF (Acklam + two Halley steps); NaN outside (0, 1). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const plow = 0.02425;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - plow) {
    const q = p - 0.5, r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  for (let i = 0; i < 2; i++) {
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * PI) * Math.exp((x * x) / 2);
    const nx = x - u / (1 + (x * u) / 2);
    if (!Number.isFinite(nx)) break;
    x = nx;
  }
  return x;
}
