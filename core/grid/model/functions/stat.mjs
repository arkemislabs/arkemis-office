// Statistical functions: aggregates, order statistics, simple regression, the normal distribution,
// and the SUBTOTAL/AGGREGATE kernel.
// Translated from gridcraft crates/functions/src/stat.rs, stat/descriptive.rs and the normal-
// distribution and simple-regression parts of stat/distributions.rs and stat/regression.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not translated yet (not registered, so they are #NAME? and not offered by autocomplete): the
// t/F/chi-squared/beta/gamma/binomial/Poisson/Weibull/lognormal families, LINEST/LOGEST/TREND/GROWTH
// and the tests (T.TEST, Z.TEST, F.TEST, CHISQ.TEST).

import {CellError, ERR, GArray, toNumber, scalar as scalarOf} from '../../lib/value.mjs';
import {parseNumberText} from '../../lib/parse.mjs';
import {f, register, VAR, S, A, numVal, num, optNum, has, arg, numbers, numbersA, arrayNumbers, asArray, arrayVal, boolean, finish, ok} from './registry.mjs';
import {normCdf, normPdf, normInv, lnGamma} from './special.mjs';

const S_ARR_K = [false, true], S_RANK = [true, false, true], S_PRANK = [false, true, true], S_FORECAST = [true, false, false], S_PROB = [false, false, true, true];

export function mean(x) { if (!x.length) throw ERR.Div0; let s = 0; for (const v of x) s += v; return s / x.length; }
export function devsq(x) {
  if (!x.length) return 0;
  let s = 0; for (const v of x) s += v;
  const m = s / x.length;
  let d = 0; for (const v of x) d += (v - m) * (v - m);
  return d;
}
export function varS(x) { if (x.length < 2) throw ERR.Div0; return devsq(x) / (x.length - 1); }
export function varP(x) { if (!x.length) throw ERR.Div0; return devsq(x) / x.length; }
const sorted = v => Float64Array.from(v).sort();
export function median(v) {
  if (!v.length) throw ERR.Num;
  const s = sorted(v), n = s.length, hi = s[n >> 1];
  return n % 2 ? hi : (s[n / 2 - 1] + hi) / 2;
}
function modes(v) {
  const counts = new Map();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = 0; for (const c of counts.values()) best = Math.max(best, c);
  if (best < 2) return [];
  return [...counts].filter(([, c]) => c === best).map(([x]) => x);
}
const modeSngl = v => { const m = modes(v); if (!m.length) throw ERR.NA; return m[0]; };
function modeNumbers(args) {
  const out = [];
  for (const a of args) {
    const v = a.value;
    if (v instanceof GArray) { for (const x of v.data) { if (typeof x === 'number') out.push(x); else if (x instanceof CellError) throw x; } }
    else if (typeof v === 'number') out.push(v);
    else if (v instanceof CellError) throw v;
    else if (v === null || v === undefined) throw ERR.Value;
  }
  return out;
}
const productOf = v => (v.length ? v.reduce((p, x) => p * x, 1) : 0);
export function minOf(v) { if (!v.length) return 0; let m = Infinity; for (const x of v) if (x < m) m = x; return m; }
export function maxOf(v) { if (!v.length) return 0; let m = -Infinity; for (const x of v) if (x > m) m = x; return m; }
function kth(v, k0, largest) {
  const k = Math.ceil(k0);
  if (Number.isNaN(k) || k < 1 || k > v.length) throw ERR.Num;
  const s = sorted(v);
  return s[largest ? s.length - k : k - 1];
}
function interp(s, pos) {
  const i = Math.floor(pos), frac = pos - i;
  const lo = s[i];
  if (lo === undefined) throw ERR.Num;
  return i + 1 < s.length && frac > 0 ? lo + frac * (s[i + 1] - lo) : lo;
}
function percentileInc(v, k) { if (!v.length || !(k >= 0 && k <= 1)) throw ERR.Num; const s = sorted(v); return interp(s, k * (s.length - 1)); }
function percentileExc(v, k) {
  const n = v.length;
  if (!n || !(k > 0 && k < 1)) throw ERR.Num;
  const pos = k * (n + 1);
  if (pos < 1 || pos > n) throw ERR.Num;
  return interp(sorted(v), pos - 1);
}
function quartileInc(v, q0) { const q = Math.trunc(q0); if (!(q >= 0 && q <= 4)) throw ERR.Num; return percentileInc(v, q / 4); }
function quartileExc(v, q0) { const q = Math.trunc(q0); if (!(q >= 1 && q <= 3)) throw ERR.Num; return percentileExc(v, q / 4); }
const argNums = (a, i) => arrayNumbers(arg(a, i).value);
function pairs(x, y) {
  const xa = asArray(x), ya = asArray(y);
  if (xa.data.length !== ya.data.length) throw ERR.NA;
  const xs = [], ys = [];
  for (let i = 0; i < xa.data.length; i++) {
    const p = xa.data[i], q = ya.data[i];
    if (p instanceof CellError) throw p;
    if (q instanceof CellError) throw q;
    if (typeof p === 'number' && typeof q === 'number') { xs.push(p); ys.push(q); }
  }
  return [xs, ys];
}
const argPairs = (a, i, j) => pairs(arg(a, i).value, arg(a, j).value);
function moments(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return [sxy, sxx, syy, mx, my];
}
function correl(x, y) {
  if (x.length < 2) throw ERR.Div0;
  const [sxy, sxx, syy] = moments(x, y);
  if (sxx === 0 || syy === 0) throw ERR.Div0;
  return sxy / Math.sqrt(sxx * syy);
}
function slope(y, x) { const [sxy, sxx] = moments(x, y); if (sxx === 0) throw ERR.Div0; return sxy / sxx; }
function intercept(y, x) { const [sxy, sxx, , mx, my] = moments(x, y); if (sxx === 0) throw ERR.Div0; return my - (sxy / sxx) * mx; }
function truncDigits(r, sig) { const fct = 10 ** Math.trunc(sig); if (!Number.isFinite(fct)) return r; return Math.floor(r * fct + 1e-9) / fct; }
const colValue = v => arrayVal(v.length, 1, v.slice());

export function countImpl(args) {
  let c = 0;
  for (const a of args) {
    const v = a.value;
    if (v instanceof GArray) { for (const x of v.data) if (typeof x === 'number') c++; }
    else if (typeof v === 'number') c++;
    else if (a.fromRef) continue;
    else if (typeof v === 'boolean') c++;
    else if (typeof v === 'string' && parseNumberText(v) !== null) c++;
  }
  return c;
}
export function countaImpl(args) {
  let c = 0;
  for (const a of args) {
    const v = a.value;
    if (v instanceof GArray) { for (const x of v.data) if (x !== null && x !== undefined) c++; }
    else if ((v === null || v === undefined) && a.fromRef) continue;
    else c++;
  }
  return c;
}
function countblank(a) {
  const v = arg(a, 0).value;
  const blank = x => x === null || x === undefined || x === '';
  if (v instanceof GArray) { let c = 0; for (const x of v.data) if (blank(x)) c++; return c; }
  return blank(v) ? 1 : 0;
}
function rankImpl(a, avg) {
  const x = num(a, 0), v = argNums(a, 1), asc = optNum(a, 2, 0) !== 0;
  let eq = 0, before = 0;
  for (const y of v) { if (y === x) eq++; if (asc ? y < x : y > x) before++; }
  if (!eq) throw ERR.NA;
  const r = before + 1;
  return numVal(avg ? r + (eq - 1) / 2 : r);
}
function percentrankImpl(a, exc) {
  const s = sorted(argNums(a, 0)), x = num(a, 1), sig = Math.trunc(optNum(a, 2, 3));
  if (sig < 1 || !s.length) throw ERR.Num;
  if (x < s[0] || x > s[s.length - 1]) throw ERR.NA;
  const n = s.length;
  const rankOf = v => {
    let less = 0; for (const y of s) if (y < v) less++;
    return exc ? (less + 1) / (n + 1) : n <= 1 ? 1 : less / (n - 1);
  };
  let r;
  if (s.includes(x)) r = rankOf(x);
  else {
    let lo = -Infinity, hi = Infinity;
    for (const y of s) { if (y < x && y > lo) lo = y; if (y > x && y < hi) hi = y; }
    const rl = rankOf(lo), rh = rankOf(hi);
    r = rl + ((x - lo) / (hi - lo)) * (rh - rl);
  }
  return numVal(truncDigits(r, sig));
}
function trimmean(a) {
  const v = argNums(a, 0), p = num(a, 1);
  if (!(p >= 0 && p < 1) || !v.length) throw ERR.Num;
  const per = Math.floor((v.length * p) / 2);
  return numVal(mean(Array.from(sorted(v).slice(per, v.length - per))));
}
function kurt(v) {
  const n = v.length;
  if (n < 4) throw ERR.Div0;
  const m = mean(v), s = Math.sqrt(varS(v));
  if (s === 0) throw ERR.Div0;
  let sum4 = 0; for (const x of v) sum4 += ((x - m) / s) ** 4;
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum4 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}
function skew(v) {
  const n = v.length;
  if (n < 3) throw ERR.Div0;
  const m = mean(v), s = Math.sqrt(varS(v));
  if (s === 0) throw ERR.Div0;
  let sum3 = 0; for (const x of v) sum3 += ((x - m) / s) ** 3;
  return (n / ((n - 1) * (n - 2))) * sum3;
}
function skewP(v) {
  const m = mean(v), s = Math.sqrt(varP(v));
  if (s === 0) throw ERR.Div0;
  let t = 0; for (const x of v) t += ((x - m) / s) ** 3;
  return t / v.length;
}
function geomean(v) { if (!v.length || v.some(x => x <= 0)) throw ERR.Num; let t = 0; for (const x of v) t += Math.log(x); return Math.exp(t / v.length); }
function harmean(v) { if (!v.length || v.some(x => x <= 0)) throw ERR.Num; let t = 0; for (const x of v) t += 1 / x; return v.length / t; }
function avedev(v) { if (!v.length) throw ERR.Num; const m = mean(v); let t = 0; for (const x of v) t += Math.abs(x - m); return t / v.length; }
function frequency(a) {
  const data = argNums(a, 0), bins = argNums(a, 1);
  if (!bins.length) return colValue([data.length]);
  const order = bins.map((_, i) => i).sort((i, j) => bins[i] - bins[j]);
  const counts = new Array(bins.length + 1).fill(0);
  for (const x of data) {
    const hit = order.find(i => x <= bins[i]);
    counts[hit === undefined ? bins.length : hit]++;
  }
  return colValue(counts);
}
function prob(a) {
  const [xs, ps] = argPairs(a, 0, 1);
  const lo = num(a, 2), hi = has(a, 3) ? num(a, 3) : lo;
  if (ps.some(p => p <= 0 || p > 1)) throw ERR.Num;
  if (Math.abs(ps.reduce((s, p) => s + p, 0) - 1) > 1e-7) throw ERR.Num;
  let t = 0; xs.forEach((x, i) => { if (x >= lo && x <= hi) t += ps[i]; });
  return numVal(t);
}
function standardize(a) { const x = num(a, 0), m = num(a, 1), sd = num(a, 2); if (sd <= 0) throw ERR.Num; return numVal((x - m) / sd); }
function forecast(a) {
  const x = num(a, 0); const [ys, xs] = argPairs(a, 1, 2);
  if (!ys.length) throw ERR.Div0;
  return numVal(intercept(ys, xs) + slope(ys, xs) * x);
}
function steyx(a) {
  const [ys, xs] = argPairs(a, 0, 1);
  const n = ys.length;
  if (n < 3) throw ERR.Div0;
  const [sxy, sxx, syy] = moments(xs, ys);
  if (sxx === 0) throw ERR.Div0;
  return numVal(Math.sqrt(Math.max(0, (syy - (sxy * sxy) / sxx) / (n - 2))));
}
function covariance(a, sample) {
  const [xs, ys] = argPairs(a, 0, 1);
  const n = xs.length;
  if (!n || (sample && n < 2)) throw ERR.Div0;
  return numVal(moments(xs, ys)[0] / (sample ? n - 1 : n));
}
function normDist(a) {
  const x = num(a, 0), m = num(a, 1), sd = num(a, 2), cum = boolean(a, 3);
  if (sd <= 0) throw ERR.Num;
  const z = (x - m) / sd;
  return numVal(cum ? normCdf(z) : normPdf(z) / sd);
}
function normInvFn(a) {
  const p = num(a, 0), m = num(a, 1), sd = num(a, 2);
  if (!(p > 0 && p < 1) || sd <= 0) throw ERR.Num;
  return numVal(m + sd * normInv(p));
}
function normSDist(a) { const z = num(a, 0); const cum = a.length > 1 ? boolean(a, 1) : true; return numVal(cum ? normCdf(z) : normPdf(z)); }
function normSInv(a) { const p = num(a, 0); if (!(p > 0 && p < 1)) throw ERR.Num; return numVal(normInv(p)); }

// SUBTOTAL / AGGREGATE support
export const aggregateValues = (fnNum, values) => wrap(() => aggregateImpl(fnNum, values, undefined));
export const aggregateValuesK = (fnNum, values, k) => wrap(() => aggregateImpl(fnNum, values, k));
function wrap(fn) { try { return finish(fn()); } catch (e) { if (e instanceof CellError) return e; throw e; } }
function aggregateImpl(fnNum, values, k0) {
  const code = fnNum >= 101 && fnNum <= 111 ? fnNum - 100 : fnNum;
  const xs = [];
  let nonempty = 0;
  const push = v => {
    if (typeof v === 'number') xs.push(v);
    else if (v instanceof CellError) throw v;
    if (v !== null && v !== undefined) nonempty++;
  };
  for (const v of values) { if (v instanceof GArray) v.data.forEach(push); else push(v); }
  let k = 0;
  if (code >= 14 && code <= 19) { if (k0 === undefined) throw ERR.Value; k = ok(toNumber(scalarOf(k0))); }
  switch (code) {
    case 1: return numVal(mean(xs));
    case 2: return xs.length;
    case 3: return nonempty;
    case 4: return numVal(maxOf(xs));
    case 5: return numVal(minOf(xs));
    case 6: return numVal(productOf(xs));
    case 7: return numVal(Math.sqrt(varS(xs)));
    case 8: return numVal(Math.sqrt(varP(xs)));
    case 9: return numVal(xs.reduce((s, x) => s + x, 0));
    case 10: return numVal(varS(xs));
    case 11: return numVal(varP(xs));
    case 12: return numVal(median(xs));
    case 13: return numVal(modeSngl(xs));
    case 14: return numVal(kth(xs, k, true));
    case 15: return numVal(kth(xs, k, false));
    case 16: return numVal(percentileInc(xs, k));
    case 17: return numVal(quartileInc(xs, k));
    case 18: return numVal(percentileExc(xs, k));
    case 19: return numVal(quartileExc(xs, k));
    default: throw ERR.Value;
  }
}

register([
  f('AVERAGE', 1, VAR, 'Statistical', A, 'AVERAGE(number1, [number2], ...)', 'Arithmetic mean of the numbers.', a => numVal(mean(numbers(a)))),
  f('AVERAGEA', 1, VAR, 'Statistical', A, 'AVERAGEA(value1, [value2], ...)', 'Mean counting text as 0 and logical values as 1 or 0.', a => numVal(mean(numbersA(a)))),
  f('MEDIAN', 1, VAR, 'Statistical', A, 'MEDIAN(number1, [number2], ...)', 'Middle value of the numbers.', a => numVal(median(numbers(a)))),
  f('MODE', 1, VAR, 'Compatibility', A, 'MODE(number1, [number2], ...)', 'Most frequently occurring number.', a => numVal(modeSngl(modeNumbers(a)))),
  f('MODE.SNGL', 1, VAR, 'Statistical', A, 'MODE.SNGL(number1, [number2], ...)', 'Most frequently occurring number.', a => numVal(modeSngl(modeNumbers(a)))),
  f('MODE.MULT', 1, VAR, 'Statistical', A, 'MODE.MULT(number1, [number2], ...)', 'Vertical array of all the most frequent numbers.', a => { const m = modes(modeNumbers(a)); if (!m.length) throw ERR.NA; return colValue(m); }),
  f('STDEV', 1, VAR, 'Compatibility', A, 'STDEV(number1, [number2], ...)', 'Sample standard deviation.', a => numVal(Math.sqrt(varS(numbers(a))))),
  f('STDEV.S', 1, VAR, 'Statistical', A, 'STDEV.S(number1, [number2], ...)', 'Sample standard deviation.', a => numVal(Math.sqrt(varS(numbers(a))))),
  f('STDEV.P', 1, VAR, 'Statistical', A, 'STDEV.P(number1, [number2], ...)', 'Population standard deviation.', a => numVal(Math.sqrt(varP(numbers(a))))),
  f('STDEVP', 1, VAR, 'Compatibility', A, 'STDEVP(number1, [number2], ...)', 'Population standard deviation.', a => numVal(Math.sqrt(varP(numbers(a))))),
  f('STDEVA', 1, VAR, 'Statistical', A, 'STDEVA(value1, [value2], ...)', 'Sample standard deviation counting text as 0 and logicals as 1/0.', a => numVal(Math.sqrt(varS(numbersA(a))))),
  f('STDEVPA', 1, VAR, 'Statistical', A, 'STDEVPA(value1, [value2], ...)', 'Population standard deviation counting text as 0 and logicals as 1/0.', a => numVal(Math.sqrt(varP(numbersA(a))))),
  f('VAR', 1, VAR, 'Compatibility', A, 'VAR(number1, [number2], ...)', 'Sample variance.', a => numVal(varS(numbers(a)))),
  f('VAR.S', 1, VAR, 'Statistical', A, 'VAR.S(number1, [number2], ...)', 'Sample variance.', a => numVal(varS(numbers(a)))),
  f('VAR.P', 1, VAR, 'Statistical', A, 'VAR.P(number1, [number2], ...)', 'Population variance.', a => numVal(varP(numbers(a)))),
  f('VARP', 1, VAR, 'Compatibility', A, 'VARP(number1, [number2], ...)', 'Population variance.', a => numVal(varP(numbers(a)))),
  f('VARA', 1, VAR, 'Statistical', A, 'VARA(value1, [value2], ...)', 'Sample variance counting text as 0 and logicals as 1/0.', a => numVal(varS(numbersA(a)))),
  f('VARPA', 1, VAR, 'Statistical', A, 'VARPA(value1, [value2], ...)', 'Population variance counting text as 0 and logicals as 1/0.', a => numVal(varP(numbersA(a)))),
  f('MIN', 0, VAR, 'Statistical', A, 'MIN(number1, [number2], ...)', 'Smallest number (0 when there are none).', a => numVal(minOf(numbers(a)))),
  f('MINA', 1, VAR, 'Statistical', A, 'MINA(value1, [value2], ...)', 'Smallest value counting text as 0 and logicals as 1/0.', a => numVal(minOf(numbersA(a)))),
  f('MAX', 1, VAR, 'Statistical', A, 'MAX(number1, [number2], ...)', 'Largest number (0 when there are none).', a => numVal(maxOf(numbers(a)))),
  f('MAXA', 1, VAR, 'Statistical', A, 'MAXA(value1, [value2], ...)', 'Largest value counting text as 0 and logicals as 1/0.', a => numVal(maxOf(numbersA(a)))),
  f('LARGE', 2, 2, 'Statistical', S_ARR_K, 'LARGE(array, k)', 'The k-th largest number in a data set.', a => numVal(kth(argNums(a, 0), num(a, 1), true))),
  f('SMALL', 2, 2, 'Statistical', S_ARR_K, 'SMALL(array, k)', 'The k-th smallest number in a data set.', a => numVal(kth(argNums(a, 0), num(a, 1), false))),
  f('RANK', 2, 3, 'Compatibility', S_RANK, 'RANK(number, ref, [order])', 'Rank of a number within a list.', a => rankImpl(a, false)),
  f('RANK.EQ', 2, 3, 'Statistical', S_RANK, 'RANK.EQ(number, ref, [order])', 'Rank of a number within a list; ties share the top rank.', a => rankImpl(a, false)),
  f('RANK.AVG', 2, 3, 'Statistical', S_RANK, 'RANK.AVG(number, ref, [order])', 'Rank of a number within a list; ties get the average rank.', a => rankImpl(a, true)),
  f('PERCENTILE', 2, 2, 'Compatibility', S_ARR_K, 'PERCENTILE(array, k)', 'k-th percentile, k from 0 to 1 inclusive.', a => numVal(percentileInc(argNums(a, 0), num(a, 1)))),
  f('PERCENTILE.INC', 2, 2, 'Statistical', S_ARR_K, 'PERCENTILE.INC(array, k)', 'k-th percentile, k from 0 to 1 inclusive.', a => numVal(percentileInc(argNums(a, 0), num(a, 1)))),
  f('PERCENTILE.EXC', 2, 2, 'Statistical', S_ARR_K, 'PERCENTILE.EXC(array, k)', 'k-th percentile, k strictly between 0 and 1.', a => numVal(percentileExc(argNums(a, 0), num(a, 1)))),
  f('QUARTILE', 2, 2, 'Compatibility', S_ARR_K, 'QUARTILE(array, quart)', 'Quartile (0–4) of a data set.', a => numVal(quartileInc(argNums(a, 0), num(a, 1)))),
  f('QUARTILE.INC', 2, 2, 'Statistical', S_ARR_K, 'QUARTILE.INC(array, quart)', 'Quartile (0–4) of a data set, inclusive method.', a => numVal(quartileInc(argNums(a, 0), num(a, 1)))),
  f('QUARTILE.EXC', 2, 2, 'Statistical', S_ARR_K, 'QUARTILE.EXC(array, quart)', 'Quartile (1–3) of a data set, exclusive method.', a => numVal(quartileExc(argNums(a, 0), num(a, 1)))),
  f('PERCENTRANK', 2, 3, 'Compatibility', S_PRANK, 'PERCENTRANK(array, x, [significance])', 'Relative standing of a value as a fraction of the data set.', a => percentrankImpl(a, false)),
  f('PERCENTRANK.INC', 2, 3, 'Statistical', S_PRANK, 'PERCENTRANK.INC(array, x, [significance])', 'Relative standing of a value from 0 to 1 inclusive.', a => percentrankImpl(a, false)),
  f('PERCENTRANK.EXC', 2, 3, 'Statistical', S_PRANK, 'PERCENTRANK.EXC(array, x, [significance])', 'Relative standing of a value strictly between 0 and 1.', a => percentrankImpl(a, true)),
  f('COUNT', 1, VAR, 'Statistical', A, 'COUNT(value1, [value2], ...)', 'Counts the numbers.', a => countImpl(a)),
  f('COUNTA', 1, VAR, 'Statistical', A, 'COUNTA(value1, [value2], ...)', 'Counts the non-empty values.', a => countaImpl(a)),
  f('COUNTBLANK', 1, 1, 'Statistical', A, 'COUNTBLANK(range)', 'Counts empty cells and empty text in a range.', countblank),
  f('CORREL', 2, 2, 'Statistical', A, 'CORREL(array1, array2)', 'Correlation coefficient of two data sets.', a => { const [x, y] = argPairs(a, 0, 1); return numVal(correl(x, y)); }),
  f('PEARSON', 2, 2, 'Statistical', A, 'PEARSON(array1, array2)', 'Pearson product-moment correlation coefficient.', a => { const [x, y] = argPairs(a, 0, 1); return numVal(correl(x, y)); }),
  f('RSQ', 2, 2, 'Statistical', A, 'RSQ(known_ys, known_xs)', 'Square of the correlation coefficient.', a => { const [y, x] = argPairs(a, 0, 1); return numVal(correl(x, y) ** 2); }),
  f('SLOPE', 2, 2, 'Statistical', A, 'SLOPE(known_ys, known_xs)', 'Slope of the least-squares regression line.', a => { const [y, x] = argPairs(a, 0, 1); if (!y.length) throw ERR.Div0; return numVal(slope(y, x)); }),
  f('INTERCEPT', 2, 2, 'Statistical', A, 'INTERCEPT(known_ys, known_xs)', 'Y-intercept of the least-squares regression line.', a => { const [y, x] = argPairs(a, 0, 1); if (!y.length) throw ERR.Div0; return numVal(intercept(y, x)); }),
  f('STEYX', 2, 2, 'Statistical', A, 'STEYX(known_ys, known_xs)', 'Standard error of predicted y values in a regression.', steyx),
  f('FORECAST', 3, 3, 'Compatibility', S_FORECAST, 'FORECAST(x, known_ys, known_xs)', 'Predicts a value along a linear trend.', forecast),
  f('FORECAST.LINEAR', 3, 3, 'Statistical', S_FORECAST, 'FORECAST.LINEAR(x, known_ys, known_xs)', 'Predicts a value along a linear trend.', forecast),
  f('COVARIANCE.P', 2, 2, 'Statistical', A, 'COVARIANCE.P(array1, array2)', 'Population covariance of paired values.', a => covariance(a, false)),
  f('COVARIANCE.S', 2, 2, 'Statistical', A, 'COVARIANCE.S(array1, array2)', 'Sample covariance of paired values.', a => covariance(a, true)),
  f('COVAR', 2, 2, 'Compatibility', A, 'COVAR(array1, array2)', 'Population covariance of paired values.', a => covariance(a, false)),
  f('DEVSQ', 1, VAR, 'Statistical', A, 'DEVSQ(number1, [number2], ...)', 'Sum of squared deviations from the mean.', a => { const v = numbers(a); if (!v.length) throw ERR.Num; return numVal(devsq(v)); }),
  f('AVEDEV', 1, VAR, 'Statistical', A, 'AVEDEV(number1, [number2], ...)', 'Average absolute deviation from the mean.', a => numVal(avedev(numbers(a)))),
  f('GEOMEAN', 1, VAR, 'Statistical', A, 'GEOMEAN(number1, [number2], ...)', 'Geometric mean of positive numbers.', a => numVal(geomean(numbers(a)))),
  f('HARMEAN', 1, VAR, 'Statistical', A, 'HARMEAN(number1, [number2], ...)', 'Harmonic mean of positive numbers.', a => numVal(harmean(numbers(a)))),
  f('TRIMMEAN', 2, 2, 'Statistical', S_ARR_K, 'TRIMMEAN(array, percent)', 'Mean after trimming a fraction of points from both ends.', trimmean),
  f('KURT', 1, VAR, 'Statistical', A, 'KURT(number1, [number2], ...)', 'Excess kurtosis of a sample.', a => numVal(kurt(numbers(a)))),
  f('SKEW', 1, VAR, 'Statistical', A, 'SKEW(number1, [number2], ...)', 'Sample skewness.', a => numVal(skew(numbers(a)))),
  f('SKEW.P', 1, VAR, 'Statistical', A, 'SKEW.P(number1, [number2], ...)', 'Population skewness.', a => numVal(skewP(numbers(a)))),
  f('STANDARDIZE', 3, 3, 'Statistical', S, 'STANDARDIZE(x, mean, standard_dev)', 'Z-score of a value.', standardize),
  f('FREQUENCY', 2, 2, 'Statistical', A, 'FREQUENCY(data_array, bins_array)', 'Counts how many values fall into each bin, as a vertical array.', frequency),
  f('PROB', 3, 4, 'Statistical', S_PROB, 'PROB(x_range, prob_range, lower_limit, [upper_limit])', 'Probability that values fall between two limits.', prob),
  f('NORM.DIST', 4, 4, 'Statistical', S, 'NORM.DIST(x, mean, standard_dev, cumulative)', 'Normal distribution density or cumulative probability.', normDist),
  f('NORMDIST', 4, 4, 'Compatibility', S, 'NORMDIST(x, mean, standard_dev, cumulative)', 'Normal distribution density or cumulative probability.', normDist),
  f('NORM.INV', 3, 3, 'Statistical', S, 'NORM.INV(probability, mean, standard_dev)', 'Inverse of the normal cumulative distribution.', normInvFn),
  f('NORMINV', 3, 3, 'Compatibility', S, 'NORMINV(probability, mean, standard_dev)', 'Inverse of the normal cumulative distribution.', normInvFn),
  f('NORM.S.DIST', 2, 2, 'Statistical', S, 'NORM.S.DIST(z, cumulative)', 'Standard normal density or cumulative probability.', normSDist),
  f('NORMSDIST', 1, 1, 'Compatibility', S, 'NORMSDIST(z)', 'Standard normal cumulative probability.', normSDist),
  f('NORM.S.INV', 1, 1, 'Statistical', S, 'NORM.S.INV(probability)', 'Inverse of the standard normal cumulative distribution.', normSInv),
  f('NORMSINV', 1, 1, 'Compatibility', S, 'NORMSINV(probability)', 'Inverse of the standard normal cumulative distribution.', normSInv),
  f('GAMMALN', 1, 1, 'Statistical', S, 'GAMMALN(x)', 'Natural log of the gamma function.', a => { const x = num(a, 0); if (x <= 0) throw ERR.Num; return numVal(lnGamma(x)); }),
  f('GAMMALN.PRECISE', 1, 1, 'Statistical', S, 'GAMMALN.PRECISE(x)', 'Natural log of the gamma function.', a => { const x = num(a, 0); if (x <= 0) throw ERR.Num; return numVal(lnGamma(x)); }),
  f('FISHER', 1, 1, 'Statistical', S, 'FISHER(x)', 'Fisher transformation.', a => { const x = num(a, 0); if (x <= -1 || x >= 1) throw ERR.Num; return numVal(0.5 * Math.log((1 + x) / (1 - x))); }),
  f('FISHERINV', 1, 1, 'Statistical', S, 'FISHERINV(y)', 'Inverse of the Fisher transformation.', a => numVal(Math.tanh(num(a, 0)))),
  f('PHI', 1, 1, 'Statistical', S, 'PHI(x)', 'Standard normal density.', a => numVal(normPdf(num(a, 0)))),
  f('GAUSS', 1, 1, 'Statistical', S, 'GAUSS(z)', 'Probability that a standard normal value falls between the mean and z.', a => numVal(normCdf(num(a, 0)) - 0.5)),
]);
