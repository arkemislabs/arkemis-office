// Math & trigonometry functions, plus the criteria aggregates (SUMIF(S), COUNTIF(S), AVERAGEIF(S),
// MAXIFS, MINIFS), Roman/base conversion and matrices.
// Translated from gridcraft crates/functions/src/math.rs, math/criteria.rs, math/roman_base.rs and
// math/matrix.rs at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {CellError, ERR, GArray} from '../../lib/value.mjs';
import {f, register, VAR, S, A, MAX_CELLS, numVal, num, optNum, has, text, numbers, asArray, arrayVal, checkSize, roundHalfAway, toSigDigits, arg} from './registry.mjs';
import {Criterion} from './criteria.mjs';
import {lnGamma} from './special.mjs';

const PI = Math.PI;
const alt = first => { const t = new Array(256).fill(false); for (let i = first; i < 256; i += 2) t[i] = true; return t; };
const COUNTIFS_SCAL = alt(1), SUMIFS_SCAL = alt(2);
const IF2 = [false, true, false];
const NUM_RANGE_REV = [false, true];

const TRIG_LIMIT = 134_217_728;
const unary = (a, fn) => numVal(fn(num(a, 0)));
const trigArg = x => { if (Math.abs(x) >= TRIG_LIMIT) throw ERR.Num; return x; };
const nonzero = x => { if (x === 0) throw ERR.Div0; return x; };
const clean = x => toSigDigits(x, 15);
const digitsArg = (a, i) => Math.max(-400, Math.min(400, Math.trunc(optNum(a, i, 0))));

function roundDir(x, digits, up) {
  if (x === 0 || !Number.isFinite(x)) return x;
  const ax = clean(Math.abs(x));
  let scaled, fct, neg;
  if (digits >= 0) { fct = 10 ** digits; scaled = ax * fct; neg = false; } else { fct = 10 ** -digits; scaled = ax / fct; neg = true; }
  if (!Number.isFinite(scaled) || scaled >= 1e17) return x;
  const s = clean(scaled);
  const r = up ? Math.ceil(s) : Math.floor(s);
  const out = !neg ? clean(r / fct) : r === 0 && !up ? 0 : r * fct;
  return x < 0 ? -out : out;
}

// Sums and products
const sum = a => numVal(numbers(a).reduce((s, x) => s + x, 0));
function percentof(a) {
  const part = numbers([arg(a, 0)]).reduce((s, x) => s + x, 0), all = numbers([arg(a, 1)]).reduce((s, x) => s + x, 0);
  if (all === 0) throw ERR.Div0;
  return numVal(part / all);
}
const sumsq = a => numVal(numbers(a).reduce((s, x) => s + x * x, 0));
function product(a) {
  const v = numbers(a);
  if (!v.length) return 0;
  return numVal(v.reduce((p, x) => p * x, 1));
}
function sumproduct(a) {
  const arrays = a.map(x => [asArray(x.value), !(x.value instanceof GArray)]);
  if (!arrays.length) throw ERR.Value;
  const {rows, cols} = arrays[0][0];
  if (arrays.some(([x]) => x.rows !== rows || x.cols !== cols)) throw ERR.Value;
  let total = 0;
  for (let i = 0; i < rows * cols; i++) {
    let p = 1;
    for (const [arr, isScalar] of arrays) {
      const v = arr.data[i];
      if (typeof v === 'number') p *= v;
      else if (v instanceof CellError) throw v;
      else if (typeof v === 'string' && isScalar) throw ERR.Value;
      else p = 0;
    }
    total += p;
  }
  return numVal(total);
}
function pairSum(a, fn) {
  const x = asArray(arg(a, 0).value), y = asArray(arg(a, 1).value);
  if (x.data.length !== y.data.length) throw ERR.NA;
  let total = 0, any = false;
  for (let i = 0; i < x.data.length; i++) {
    const u = x.data[i], v = y.data[i];
    if (u instanceof CellError) throw u;
    if (v instanceof CellError) throw v;
    if (typeof u === 'number' && typeof v === 'number') { total += fn(u, v); any = true; }
  }
  if (!any) throw ERR.Div0;
  return numVal(total);
}

// Rounding
const round = a => numVal(roundHalfAway(num(a, 0), digitsArg(a, 1)));
const roundup = a => numVal(roundDir(num(a, 0), digitsArg(a, 1), true));
const rounddown = a => numVal(roundDir(num(a, 0), digitsArg(a, 1), false));
function mround(a) {
  const x = num(a, 0), m = num(a, 1);
  if (m === 0 || x === 0) return 0;
  if ((x > 0) !== (m > 0)) throw ERR.Num;
  return numVal(clean(roundHalfAway(x / m, 0) * m));
}
function ceiling(a) {
  const x = num(a, 0), s = num(a, 1);
  if (x === 0 || s === 0) return 0;
  if (x > 0 && s < 0) throw ERR.Num;
  return numVal(clean(Math.ceil(clean(x / s)) * s));
}
function floor(a) {
  const x = num(a, 0), s = num(a, 1);
  if (s === 0) { if (x === 0) return 0; throw ERR.Div0; }
  if (x === 0) return 0;
  if (x > 0 && s < 0) throw ERR.Num;
  return numVal(clean(Math.floor(clean(x / s)) * s));
}
function ceilFloorMath(x, s0, up, away) {
  const s = Math.abs(s0);
  if (s === 0 || x === 0) return 0;
  const q = clean(x / s);
  const r = x >= 0 ? (up ? Math.ceil(q) : Math.floor(q)) : away ? Math.floor(q) : Math.ceil(q);
  return numVal(clean(r * s));
}
const sig1 = a => (has(a, 1) ? num(a, 1) : 1);
const ceilingMath = a => ceilFloorMath(num(a, 0), sig1(a), true, optNum(a, 2, 0) !== 0);
const floorMath = a => ceilFloorMath(num(a, 0), sig1(a), false, optNum(a, 2, 0) === 0);
const ceilingPrecise = a => ceilFloorMath(num(a, 0), sig1(a), true, false);
const floorPrecise = a => ceilFloorMath(num(a, 0), sig1(a), false, true);
function evenOdd(x, odd) {
  const sign = x < 0 ? -1 : 1;
  let v = Math.ceil(clean(Math.abs(x)));
  if (odd) { if (v % 2 === 0) v += 1; } else if (v % 2 !== 0) v += 1;
  return sign * v;
}

// Arithmetic
function modulo(x, d) {
  if (d === 0) throw ERR.Div0;
  let r = x % d;
  if (r !== 0 && (r < 0) !== (d < 0)) r += d;
  if (Math.abs(r) >= Math.abs(d)) return 0;
  return clean(r);
}
export function powerOf(x, y) {
  if (x === 0) {
    if (y === 0) throw ERR.Num;
    if (y < 0) throw ERR.Div0;
    return 0;
  }
  if (x < 0 && y % 1 !== 0) throw ERR.Num;
  const r = x ** y;
  if (!Number.isFinite(r)) throw ERR.Num;
  return r;
}
function log(a) {
  const x = num(a, 0), base = optNum(a, 1, 10);
  if (x <= 0 || base <= 0) throw ERR.Num;
  if (base === 1) throw ERR.Div0;
  return numVal(base === 10 ? Math.log10(x) : base === 2 ? Math.log2(x) : Math.log(x) / Math.log(base));
}
function randbetween(a, c) {
  const lo = Math.ceil(num(a, 0)), hi = Math.floor(num(a, 1));
  if (lo > hi) throw ERR.Num;
  const r = Math.max(0, Math.min(1, c.random()));
  return numVal(Math.min(lo + Math.floor(r * (hi - lo + 1)), hi));
}

// Combinatorics
export function factOf(n0) {
  const n = Math.trunc(n0);
  if (n < 0 || n > 170) throw ERR.Num;
  let fct = 1;
  for (let i = 2; i <= n; i++) fct *= i;
  return fct;
}
function factdouble(a) {
  const n = Math.trunc(num(a, 0));
  if (n < -1 || n > 300) throw ERR.Num;
  let fct = 1;
  for (let i = n; i > 1; i -= 2) fct *= i;
  return numVal(fct);
}
export function combinOf(n0, k0) {
  const n = Math.trunc(n0); let k = Math.trunc(k0);
  if (n < 0 || k < 0 || k > n) throw ERR.Num;
  k = Math.min(k, n - k);
  if (k > 1e7) {
    const r = Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1));
    if (!Number.isFinite(r)) throw ERR.Num;
    return r;
  }
  let r = 1;
  for (let i = 1; i <= k; i++) { r = (r * (n - k + i)) / i; if (!Number.isFinite(r)) throw ERR.Num; }
  return r < 9e15 ? Math.round(r) : r;
}
function combina(a) {
  const n = Math.trunc(num(a, 0)), k = Math.trunc(num(a, 1));
  if (n < 0 || k < 0 || (n < k && n === 0 && k > 0)) throw ERR.Num;
  if (k === 0) return 1;
  return numVal(combinOf(n + k - 1, k));
}
function permut(a) {
  const n = Math.trunc(num(a, 0)), k = Math.trunc(num(a, 1));
  if (n < 0 || k < 0 || k > n) throw ERR.Num;
  let r = 1;
  for (let i = 0; i < k; i++) { r *= n - i; if (!Number.isFinite(r)) throw ERR.Num; }
  return numVal(r);
}
function permutationa(a) {
  const n = Math.trunc(num(a, 0)), k = Math.trunc(num(a, 1));
  if (n < 0 || k < 0) throw ERR.Num;
  return numVal(n ** k);
}
function integerArgs(a) {
  return numbers(a).map(x => { const t = Math.trunc(x); if (!(t >= 0 && t < 9.007_199_254_740_992e15)) throw ERR.Num; return t; });
}
const gcd2 = (x, y) => { let p = BigInt(x), q = BigInt(y); while (q !== 0n) { const t = p % q; p = q; q = t; } return Number(p); };
const gcd = a => numVal(integerArgs(a).reduce((acc, x) => gcd2(acc, x), 0));
function lcm(a) {
  let acc = 1;
  for (const x of integerArgs(a)) {
    if (x === 0) return 0;
    acc = (acc / gcd2(acc, x)) * x;
    if (acc >= 9.007_199_254_740_992e15) throw ERR.Num;
  }
  return numVal(acc);
}
function multinomial(a) {
  let total = 0, r = 1;
  for (const x of numbers(a)) {
    const k = Math.trunc(x);
    if (k < 0) throw ERR.Num;
    total += k;
    r *= combinOf(total, k);
    if (!Number.isFinite(r)) throw ERR.Num;
  }
  return numVal(r);
}
function atan2(a) {
  const x = num(a, 0), y = num(a, 1);
  if (x === 0 && y === 0) throw ERR.Div0;
  return numVal(Math.atan2(y, x));
}
function seriessum(a) {
  const x = num(a, 0), n = num(a, 1), m = num(a, 2);
  const coeffs = asArray(arg(a, 3).value);
  let total = 0;
  coeffs.data.forEach((c, i) => {
    if (c instanceof CellError) throw c;
    if (typeof c !== 'number') throw ERR.Value;
    total += c * powerOf(x, n + i * m);
  });
  return numVal(total);
}

// Roman numerals and bases (roman_base.rs)
const NUMERALS = [['I', 1], ['V', 5], ['X', 10], ['L', 50], ['C', 100], ['D', 500], ['M', 1000]];
function romanTokens(form) {
  const [pow10Max, fiveMax] = [[10, 0], [10, 20], [100, 20], [100, 200], [1000, 200]][form] ?? [10, 0];
  const toks = NUMERALS.map(([c, v]) => [c, v]);
  NUMERALS.forEach(([sc, sv], i) => {
    for (const [lc, lv] of NUMERALS.slice(i + 1)) {
      const ratio = Math.trunc(lv / sv);
      const pow10 = 'IXC'.includes(sc);
      const okk = ratio <= (pow10 ? pow10Max : fiveMax);
      const value = lv - sv;
      if (okk && !NUMERALS.some(([, v]) => v === value)) toks.push([sc + lc, value]);
    }
  });
  toks.sort((p, q) => q[1] - p[1] || p[0].length - q[0].length);
  return toks;
}
function roman(a) {
  const n = Math.trunc(num(a, 0));
  const fv = a[1]?.value;
  const form = a[1] === undefined ? 0 : fv === true ? 0 : fv === false ? 4 : Math.trunc(num(a, 1));
  if (!(n >= 0 && n <= 3999) || !(form >= 0 && form <= 4)) throw ERR.Value;
  const toks = romanTokens(form);
  let rem = n, out = '';
  while (rem > 0) {
    const t = toks.find(([, v]) => v <= rem);
    if (!t) break;
    out += t[0]; rem -= t[1];
  }
  return out;
}
function arabic(a) {
  const s = text(a, 0).trim();
  if ([...s].length > 255) throw ERR.Value;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const vals = [...body].map(ch => { const n = NUMERALS.find(([c]) => c === ch.toUpperCase()); if (!n) throw ERR.Value; return n[1]; });
  let total = 0;
  vals.forEach((v, i) => { total += i + 1 < vals.length && vals[i + 1] > v ? -v : v; });
  return numVal(neg ? -total : total);
}
function base(a) {
  const n = Math.trunc(num(a, 0)), radix = Math.trunc(num(a, 1)), minLen = Math.trunc(optNum(a, 2, 0));
  if (!(n >= 0 && n < 9.007_199_254_740_992e15) || !(radix >= 2 && radix <= 36) || !(minLen >= 0 && minLen <= 255)) throw ERR.Num;
  return BigInt(n).toString(radix).toUpperCase().padStart(minLen, '0');
}
function decimal(a) {
  const s = text(a, 0), radix = Math.trunc(num(a, 1));
  if (!(radix >= 2 && radix <= 36) || [...s].length > 255) throw ERR.Num;
  let total = 0;
  for (const ch of s.trim()) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d) || d >= radix || !/^[0-9a-z]$/i.test(ch)) throw ERR.Num;
    total = total * radix + d;
  }
  if (total >= 9.007_199_254_740_992e15) throw ERR.Num;
  return numVal(total);
}

// Matrices (matrix.rs)
function matrix(v) {
  const arr = asArray(v);
  const out = arr.data.map(x => { if (typeof x === 'number') return x; if (x instanceof CellError) throw x; throw ERR.Value; });
  return [arr.rows, arr.cols, out];
}
const toValueArray = (rows, cols, data) => arrayVal(rows, cols, data.map(x => (Number.isFinite(x) ? x : ERR.Num)));
function mmult(a) {
  const [ar, ac, ad] = matrix(arg(a, 0).value), [br, bc, bd] = matrix(arg(a, 1).value);
  if (ac !== br) throw ERR.Value;
  if (ar * bc > MAX_CELLS || ar * bc * ac > 2_000_000_000) throw ERR.Num;
  const out = new Array(ar * bc).fill(0);
  for (let i = 0; i < ar; i++) for (let k = 0; k < ac; k++) {
    const x = ad[i * ac + k];
    if (x === 0) continue;
    for (let j = 0; j < bc; j++) out[i * bc + j] += x * bd[k * bc + j];
  }
  return toValueArray(ar, bc, out);
}
function square(a) {
  const [r, c, d] = matrix(arg(a, 0).value);
  if (r !== c) throw ERR.Value;
  if (r > 2000) throw ERR.Num;
  return [r, d];
}
function determinant(n, m) {
  let det = 1;
  for (let col = 0; col < n; col++) {
    let piv = col, best = 0;
    for (let row = col; row < n; row++) { const v = Math.abs(m[row * n + col]); if (v > best) { best = v; piv = row; } }
    if (best === 0) return 0;
    if (piv !== col) { for (let k = 0; k < n; k++) { const t = m[piv * n + k]; m[piv * n + k] = m[col * n + k]; m[col * n + k] = t; } det = -det; }
    const p = m[col * n + col];
    det *= p;
    for (let row = col + 1; row < n; row++) {
      const fct = m[row * n + col] / p;
      if (fct === 0) continue;
      for (let k = col; k < n; k++) m[row * n + k] -= fct * m[col * n + k];
    }
  }
  return det;
}
function mdeterm(a) {
  const [n, m] = square(a);
  const d = determinant(n, m);
  return numVal(Math.abs(d) > 1e-300 ? toSigDigits(d, 15) : d);
}
function minverse(a) {
  const [n, m] = square(a);
  const inv = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  const scale = Math.max(m.reduce((acc, x) => Math.max(acc, Math.abs(x)), 0), 1e-300);
  for (let col = 0; col < n; col++) {
    let piv = col, best = 0;
    for (let row = col; row < n; row++) { const v = Math.abs(m[row * n + col]); if (v > best) { best = v; piv = row; } }
    if (best <= scale * 1e-15) throw ERR.Num;
    if (piv !== col) for (let k = 0; k < n; k++) {
      [m[piv * n + k], m[col * n + k]] = [m[col * n + k], m[piv * n + k]];
      [inv[piv * n + k], inv[col * n + k]] = [inv[col * n + k], inv[piv * n + k]];
    }
    const p = m[col * n + col];
    for (let k = 0; k < n; k++) { m[col * n + k] /= p; inv[col * n + k] /= p; }
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const fct = m[row * n + col];
      if (fct === 0) continue;
      for (let k = 0; k < n; k++) { m[row * n + k] -= fct * m[col * n + k]; inv[row * n + k] -= fct * inv[col * n + k]; }
    }
  }
  const noise = 1e-15 / scale;
  return toValueArray(n, n, inv.map(x => (Math.abs(x) < noise ? 0 : x)));
}
function munit(a) {
  const n = Math.trunc(num(a, 0));
  const [r] = checkSize(n, n);
  const data = new Array(r * r).fill(0);
  for (let i = 0; i < r; i++) data[i * r + i] = 1;
  return arrayVal(r, r, data);
}

// Criteria aggregates (math/criteria.rs)
function criteriaMask(a, firstPair, rows, cols) {
  const rest = a.slice(firstPair);
  if (!rest.length || rest.length % 2) throw ERR.Value;
  const singlePair = rest.length === 2;
  const mask = new Array(rows * cols).fill(true);
  for (let p = 0; p < rest.length; p += 2) {
    const r = asArray(rest[p].value);
    if (r.rows !== rows || r.cols !== cols) throw ERR.Value;
    const sc = rest[p + 1].value instanceof GArray ? (rest[p + 1].value.data[0] ?? null) : rest[p + 1].value;
    const c = singlePair ? Criterion.parseArg(sc) : Criterion.parseArgTruncated(sc);
    for (let i = 0; i < mask.length; i++) if (mask[i] && !c.matches(r.data[i])) mask[i] = false;
  }
  return mask;
}
function maskedNumbers(target, mask) {
  const out = [];
  target.data.forEach((v, i) => {
    if (!mask[i]) return;
    if (typeof v === 'number') out.push(v);
    else if (v instanceof CellError) throw v;
  });
  return out;
}
function countifs(a) {
  const first = asArray(arg(a, 0).value);
  return numVal(criteriaMask(a, 0, first.rows, first.cols).filter(Boolean).length);
}
function ifsNumbers(a) {
  const target = asArray(arg(a, 0).value);
  return maskedNumbers(target, criteriaMask(a, 1, target.rows, target.cols));
}
const sumifs = a => numVal(ifsNumbers(a).reduce((s, x) => s + x, 0));
function averageifs(a) { const v = ifsNumbers(a); if (!v.length) throw ERR.Div0; return numVal(v.reduce((s, x) => s + x, 0) / v.length); }
const maxifs = a => { const v = ifsNumbers(a); let m = -Infinity; for (const x of v) if (x > m) m = x; return numVal(v.length ? m : 0); };
const minifs = a => { const v = ifsNumbers(a); let m = Infinity; for (const x of v) if (x < m) m = x; return numVal(v.length ? m : 0); };
const scalarOf = v => (v instanceof GArray ? (v.data[0] ?? null) : v);
function countif(a) {
  const range = asArray(arg(a, 0).value);
  const c = Criterion.parseArg(scalarOf(arg(a, 1).value));
  let n = 0;
  for (const v of range.data) if (c.matches(v)) n++;
  return n;
}
function ifNumbers(a) {
  const range = asArray(arg(a, 0).value);
  const c = Criterion.parseArg(scalarOf(arg(a, 1).value));
  const sumRange = has(a, 2) ? asArray(arg(a, 2).value) : null;
  const out = [];
  for (let r = 0; r < range.rows; r++) for (let col = 0; col < range.cols; col++) {
    const v = range.get(r, col);
    if (!c.matches(v)) continue;
    const t = sumRange ? sumRange.get(r, col) : v;
    if (typeof t === 'number') out.push(t);
    else if (t instanceof CellError) throw t;
  }
  return out;
}
const sumif = a => numVal(ifNumbers(a).reduce((s, x) => s + x, 0));
function averageif(a) { const v = ifNumbers(a); if (!v.length) throw ERR.Div0; return numVal(v.reduce((s, x) => s + x, 0) / v.length); }

register([
  f('SUM', 1, VAR, 'MathTrig', A, 'SUM(number1, [number2], ...)', 'Adds all the numbers in the arguments.', sum),
  f('PERCENTOF', 2, 2, 'MathTrig', A, 'PERCENTOF(data_subset, data_all)', 'The sum of a subset as a fraction of the sum of all the values.', percentof),
  f('SUMSQ', 1, VAR, 'MathTrig', A, 'SUMSQ(number1, [number2], ...)', 'Adds the squares of the numbers.', sumsq),
  f('SUMPRODUCT', 1, VAR, 'MathTrig', A, 'SUMPRODUCT(array1, [array2], ...)', 'Multiplies matching elements of equally sized arrays and adds the products.', sumproduct),
  f('SUMX2MY2', 2, 2, 'MathTrig', A, 'SUMX2MY2(array_x, array_y)', 'Sums the differences of squares of matching elements.', a => pairSum(a, (x, y) => x * x - y * y)),
  f('SUMX2PY2', 2, 2, 'MathTrig', A, 'SUMX2PY2(array_x, array_y)', 'Sums the sums of squares of matching elements.', a => pairSum(a, (x, y) => x * x + y * y)),
  f('SUMXMY2', 2, 2, 'MathTrig', A, 'SUMXMY2(array_x, array_y)', 'Sums the squared differences of matching elements.', a => pairSum(a, (x, y) => (x - y) * (x - y))),
  f('PRODUCT', 1, VAR, 'MathTrig', A, 'PRODUCT(number1, [number2], ...)', 'Multiplies all the numbers in the arguments.', product),
  f('ROUND', 2, 2, 'MathTrig', S, 'ROUND(number, num_digits)', 'Rounds a number to a given number of digits, halves away from zero.', round),
  f('ROUNDUP', 2, 2, 'MathTrig', S, 'ROUNDUP(number, num_digits)', 'Rounds a number away from zero to a given number of digits.', roundup),
  f('ROUNDDOWN', 2, 2, 'MathTrig', S, 'ROUNDDOWN(number, num_digits)', 'Rounds a number toward zero to a given number of digits.', rounddown),
  f('MROUND', 2, 2, 'MathTrig', S, 'MROUND(number, multiple)', 'Rounds a number to the nearest multiple.', mround),
  f('CEILING', 2, 2, 'Compatibility', S, 'CEILING(number, significance)', 'Rounds a number up to a multiple of significance.', ceiling),
  f('CEILING.MATH', 1, 3, 'MathTrig', S, 'CEILING.MATH(number, [significance], [mode])', 'Rounds a number up to the nearest integer or multiple.', ceilingMath),
  f('CEILING.PRECISE', 1, 2, 'MathTrig', S, 'CEILING.PRECISE(number, [significance])', 'Rounds a number toward positive infinity to a multiple.', ceilingPrecise),
  f('ISO.CEILING', 1, 2, 'MathTrig', S, 'ISO.CEILING(number, [significance])', 'Rounds a number toward positive infinity to a multiple.', ceilingPrecise),
  f('FLOOR', 2, 2, 'Compatibility', S, 'FLOOR(number, significance)', 'Rounds a number down to a multiple of significance.', floor),
  f('FLOOR.MATH', 1, 3, 'MathTrig', S, 'FLOOR.MATH(number, [significance], [mode])', 'Rounds a number down to the nearest integer or multiple.', floorMath),
  f('FLOOR.PRECISE', 1, 2, 'MathTrig', S, 'FLOOR.PRECISE(number, [significance])', 'Rounds a number toward negative infinity to a multiple.', floorPrecise),
  f('INT', 1, 1, 'MathTrig', S, 'INT(number)', 'Rounds a number down to the nearest integer.', a => unary(a, Math.floor)),
  f('TRUNC', 1, 2, 'MathTrig', S, 'TRUNC(number, [num_digits])', 'Cuts off the fractional part of a number at the given digits.', rounddown),
  f('MOD', 2, 2, 'MathTrig', S, 'MOD(number, divisor)', 'Remainder of a division, with the sign of the divisor.', a => numVal(modulo(num(a, 0), num(a, 1)))),
  f('QUOTIENT', 2, 2, 'MathTrig', S, 'QUOTIENT(numerator, denominator)', 'Integer part of a division.', a => numVal(Math.trunc(clean(num(a, 0) / nonzero(num(a, 1)))))),
  f('ABS', 1, 1, 'MathTrig', S, 'ABS(number)', 'Absolute value of a number.', a => unary(a, Math.abs)),
  f('SIGN', 1, 1, 'MathTrig', S, 'SIGN(number)', '1 for positive, -1 for negative and 0 for zero.', a => unary(a, x => (x > 0 ? 1 : x < 0 ? -1 : 0))),
  f('SQRT', 1, 1, 'MathTrig', S, 'SQRT(number)', 'Positive square root.', a => unary(a, x => { if (x < 0) throw ERR.Num; return Math.sqrt(x); })),
  f('SQRTPI', 1, 1, 'MathTrig', S, 'SQRTPI(number)', 'Square root of the number times pi.', a => unary(a, x => { if (x < 0) throw ERR.Num; return Math.sqrt(x * PI); })),
  f('POWER', 2, 2, 'MathTrig', S, 'POWER(number, power)', 'Raises a number to a power.', a => numVal(powerOf(num(a, 0), num(a, 1)))),
  f('EXP', 1, 1, 'MathTrig', S, 'EXP(number)', 'e raised to the given power.', a => unary(a, Math.exp)),
  f('LN', 1, 1, 'MathTrig', S, 'LN(number)', 'Natural logarithm.', a => unary(a, x => { if (x <= 0) throw ERR.Num; return Math.log(x); })),
  f('LOG', 1, 2, 'MathTrig', S, 'LOG(number, [base])', 'Logarithm to the given base (10 by default).', log),
  f('LOG10', 1, 1, 'MathTrig', S, 'LOG10(number)', 'Base-10 logarithm.', a => unary(a, x => { if (x <= 0) throw ERR.Num; return Math.log10(x); })),
  f('PI', 0, 0, 'MathTrig', S, 'PI()', 'The constant pi to 15 digits.', () => PI),
  f('RAND', 0, 0, 'MathTrig', S, 'RAND()', 'A random number between 0 and 1, recalculated every time.', (a, c) => numVal(c.random()), {volatile: true}),
  f('RANDBETWEEN', 2, 2, 'MathTrig', S, 'RANDBETWEEN(bottom, top)', 'A random integer between two bounds, inclusive.', randbetween, {volatile: true}),
  f('FACT', 1, 1, 'MathTrig', S, 'FACT(number)', 'Factorial of a number.', a => numVal(factOf(num(a, 0)))),
  f('FACTDOUBLE', 1, 1, 'MathTrig', S, 'FACTDOUBLE(number)', 'Double factorial of a number.', factdouble),
  f('COMBIN', 2, 2, 'MathTrig', S, 'COMBIN(number, number_chosen)', 'Number of combinations without repetition.', a => numVal(combinOf(num(a, 0), num(a, 1)))),
  f('COMBINA', 2, 2, 'MathTrig', S, 'COMBINA(number, number_chosen)', 'Number of combinations with repetition.', combina),
  f('PERMUT', 2, 2, 'Statistical', S, 'PERMUT(number, number_chosen)', 'Number of ordered selections without repetition.', permut),
  f('PERMUTATIONA', 2, 2, 'Statistical', S, 'PERMUTATIONA(number, number_chosen)', 'Number of ordered selections with repetition.', permutationa),
  f('GCD', 1, VAR, 'MathTrig', A, 'GCD(number1, [number2], ...)', 'Greatest common divisor of integers.', gcd),
  f('LCM', 1, VAR, 'MathTrig', A, 'LCM(number1, [number2], ...)', 'Least common multiple of integers.', lcm),
  f('EVEN', 1, 1, 'MathTrig', S, 'EVEN(number)', 'Rounds away from zero to the nearest even integer.', a => unary(a, x => evenOdd(x, false))),
  f('ODD', 1, 1, 'MathTrig', S, 'ODD(number)', 'Rounds away from zero to the nearest odd integer.', a => unary(a, x => evenOdd(x, true))),
  f('SIN', 1, 1, 'MathTrig', S, 'SIN(number)', 'Sine of an angle in radians.', a => unary(a, x => Math.sin(trigArg(x)))),
  f('COS', 1, 1, 'MathTrig', S, 'COS(number)', 'Cosine of an angle in radians.', a => unary(a, x => Math.cos(trigArg(x)))),
  f('TAN', 1, 1, 'MathTrig', S, 'TAN(number)', 'Tangent of an angle in radians.', a => unary(a, x => Math.tan(trigArg(x)))),
  f('ASIN', 1, 1, 'MathTrig', S, 'ASIN(number)', 'Arcsine in radians.', a => unary(a, x => { if (Math.abs(x) > 1) throw ERR.Num; return Math.asin(x); })),
  f('ACOS', 1, 1, 'MathTrig', S, 'ACOS(number)', 'Arccosine in radians.', a => unary(a, x => { if (Math.abs(x) > 1) throw ERR.Num; return Math.acos(x); })),
  f('ATAN', 1, 1, 'MathTrig', S, 'ATAN(number)', 'Arctangent in radians.', a => unary(a, Math.atan)),
  f('ATAN2', 2, 2, 'MathTrig', S, 'ATAN2(x_num, y_num)', 'Angle of the point (x, y) from the x-axis in radians.', atan2),
  f('SINH', 1, 1, 'MathTrig', S, 'SINH(number)', 'Hyperbolic sine.', a => unary(a, Math.sinh)),
  f('COSH', 1, 1, 'MathTrig', S, 'COSH(number)', 'Hyperbolic cosine.', a => unary(a, Math.cosh)),
  f('TANH', 1, 1, 'MathTrig', S, 'TANH(number)', 'Hyperbolic tangent.', a => unary(a, Math.tanh)),
  f('ASINH', 1, 1, 'MathTrig', S, 'ASINH(number)', 'Inverse hyperbolic sine.', a => unary(a, Math.asinh)),
  f('ACOSH', 1, 1, 'MathTrig', S, 'ACOSH(number)', 'Inverse hyperbolic cosine.', a => unary(a, x => { if (x < 1) throw ERR.Num; return Math.acosh(x); })),
  f('ATANH', 1, 1, 'MathTrig', S, 'ATANH(number)', 'Inverse hyperbolic tangent.', a => unary(a, x => { if (Math.abs(x) >= 1) throw ERR.Num; return Math.atanh(x); })),
  f('COT', 1, 1, 'MathTrig', S, 'COT(number)', 'Cotangent of an angle in radians.', a => unary(a, x => 1 / Math.tan(nonzero(trigArg(x))))),
  f('COTH', 1, 1, 'MathTrig', S, 'COTH(number)', 'Hyperbolic cotangent.', a => unary(a, x => 1 / Math.tanh(nonzero(trigArg(x))))),
  f('CSC', 1, 1, 'MathTrig', S, 'CSC(number)', 'Cosecant of an angle in radians.', a => unary(a, x => 1 / Math.sin(nonzero(trigArg(x))))),
  f('CSCH', 1, 1, 'MathTrig', S, 'CSCH(number)', 'Hyperbolic cosecant.', a => unary(a, x => 1 / Math.sinh(nonzero(trigArg(x))))),
  f('SEC', 1, 1, 'MathTrig', S, 'SEC(number)', 'Secant of an angle in radians.', a => unary(a, x => 1 / Math.cos(trigArg(x)))),
  f('SECH', 1, 1, 'MathTrig', S, 'SECH(number)', 'Hyperbolic secant.', a => unary(a, x => 1 / Math.cosh(trigArg(x)))),
  f('ACOT', 1, 1, 'MathTrig', S, 'ACOT(number)', 'Arccotangent in radians (0 to pi).', a => unary(a, x => PI / 2 - Math.atan(x))),
  f('ACOTH', 1, 1, 'MathTrig', S, 'ACOTH(number)', 'Inverse hyperbolic cotangent.', a => unary(a, x => { if (Math.abs(x) <= 1) throw ERR.Num; return 0.5 * Math.log((x + 1) / (x - 1)); })),
  f('DEGREES', 1, 1, 'MathTrig', S, 'DEGREES(angle)', 'Converts radians to degrees.', a => unary(a, x => (x * 180) / PI)),
  f('RADIANS', 1, 1, 'MathTrig', S, 'RADIANS(angle)', 'Converts degrees to radians.', a => unary(a, x => (x * PI) / 180)),
  f('ROMAN', 1, 2, 'MathTrig', S, 'ROMAN(number, [form])', 'Converts a number to Roman numerals in one of five styles.', roman),
  f('ARABIC', 1, 1, 'MathTrig', S, 'ARABIC(text)', 'Converts Roman numerals to a number.', arabic),
  f('BASE', 2, 3, 'MathTrig', S, 'BASE(number, radix, [min_length])', 'Writes a number in another base, padded with zeros.', base),
  f('DECIMAL', 2, 2, 'MathTrig', S, 'DECIMAL(text, radix)', 'Reads text in a given base as a number.', decimal),
  f('MMULT', 2, 2, 'MathTrig', A, 'MMULT(array1, array2)', 'Matrix product of two arrays.', mmult),
  f('MDETERM', 1, 1, 'MathTrig', A, 'MDETERM(array)', 'Determinant of a square matrix.', mdeterm),
  f('MINVERSE', 1, 1, 'MathTrig', A, 'MINVERSE(array)', 'Inverse of a square matrix.', minverse),
  f('MUNIT', 1, 1, 'MathTrig', S, 'MUNIT(dimension)', 'Identity matrix of the given size.', munit),
  f('SERIESSUM', 4, 4, 'MathTrig', [true, true, true, false], 'SERIESSUM(x, n, m, coefficients)', 'Sum of a power series.', seriessum),
  f('MULTINOMIAL', 1, VAR, 'MathTrig', A, 'MULTINOMIAL(number1, [number2], ...)', 'Ratio of the factorial of a sum to the product of factorials.', multinomial),
  f('SUMIF', 2, 3, 'MathTrig', IF2, 'SUMIF(range, criteria, [sum_range])', 'Adds the cells that meet a condition.', sumif),
  f('SUMIFS', 3, VAR, 'MathTrig', SUMIFS_SCAL, 'SUMIFS(sum_range, criteria_range1, criteria1, ...)', 'Adds the cells that meet every condition.', sumifs),
  f('COUNTIF', 2, 2, 'Statistical', NUM_RANGE_REV, 'COUNTIF(range, criteria)', 'Counts the cells that meet a condition.', countif),
  f('COUNTIFS', 2, VAR, 'Statistical', COUNTIFS_SCAL, 'COUNTIFS(criteria_range1, criteria1, ...)', 'Counts the cells that meet every condition.', countifs),
  f('AVERAGEIF', 2, 3, 'Statistical', IF2, 'AVERAGEIF(range, criteria, [average_range])', 'Average of the cells that meet a condition.', averageif),
  f('AVERAGEIFS', 3, VAR, 'Statistical', SUMIFS_SCAL, 'AVERAGEIFS(average_range, criteria_range1, criteria1, ...)', 'Average of the cells that meet every condition.', averageifs),
  f('MAXIFS', 3, VAR, 'Statistical', SUMIFS_SCAL, 'MAXIFS(max_range, criteria_range1, criteria1, ...)', 'Largest value among cells that meet every condition.', maxifs),
  f('MINIFS', 3, VAR, 'Statistical', SUMIFS_SCAL, 'MINIFS(min_range, criteria_range1, criteria1, ...)', 'Smallest value among cells that meet every condition.', minifs),
]);
