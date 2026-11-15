// Time-value-of-money and cash-flow functions: PMT, IPMT, PPMT, PV, FV, NPER, RATE, CUMIPMT,
// CUMPRINC, NPV, XNPV, IRR, XIRR, MIRR.
// Translated from gridcraft crates/functions/src/financial/tvm.rs and financial.rs (`type_arg`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Depreciation, securities, day-count and euro conversion functions are not translated yet.

import {CellError, ERR, toNumber} from '../../lib/value.mjs';
import {f, register, VAR, S, numVal, num, optNum, numbers, arrayNumbers, asArray, arg, ok} from './registry.mjs';

const typeArg = (a, i) => (optNum(a, i, 0) !== 0 ? 1 : 0);
function pmtCalc(rate, nper, pv, fv, typ) {
  if (rate === 0) return -(pv + fv) / nper;
  if (rate <= -1) return NaN;
  const l = nper * Math.log1p(rate), m = Math.expm1(l), k = 1 + rate * typ;
  if (m > 0) return -(pv * rate + (pv + fv) * (rate / m)) / k;
  if (m > -0.5) return -(rate * (pv + fv + pv * m)) / (k * m);
  return -(rate * (fv + pv * Math.exp(l))) / (k * m);
}
function fvCalc(rate, nper, pmt, pv, typ) {
  if (rate === 0) return -(pv + pmt * nper);
  const p = (1 + rate) ** nper;
  return -(pv * p + (pmt * (1 + rate * typ) * (p - 1)) / rate);
}
function pvCalc(rate, nper, pmt, fv, typ) {
  if (rate === 0) return -(fv + pmt * nper);
  const p = (1 + rate) ** nper;
  return -(fv + (pmt * (1 + rate * typ) * (p - 1)) / rate) / p;
}
function pmt(a) {
  const rate = num(a, 0), nper = num(a, 1), pv = num(a, 2), fv = optNum(a, 3, 0), typ = typeArg(a, 4);
  if (nper === 0) throw ERR.Num;
  return numVal(pmtCalc(rate, nper, pv, fv, typ));
}
function nper(a) {
  const rate = num(a, 0), p = num(a, 1), pv = num(a, 2), fv = optNum(a, 3, 0), typ = typeArg(a, 4);
  if (rate === 0) { if (p === 0) throw ERR.Num; return numVal(-(pv + fv) / p); }
  const numer = p * (1 + rate * typ) - fv * rate, denom = pv * rate + p * (1 + rate * typ);
  if (denom === 0) throw ERR.Num;
  const q = numer / denom;
  if (q <= 0 || rate <= -1) throw ERR.Num;
  return numVal(Math.log(q) / Math.log(1 + rate));
}
function ipmtCalc(rate, per, nper, pv, fv, typ) {
  const p = pmtCalc(rate, nper, pv, fv, typ);
  if (typ === 1 && per === 1) return 0;
  const i = fvCalc(rate, per - 1, p, pv, typ) * rate;
  return typ === 1 ? i / (1 + rate) : i;
}
function perArgs(a) {
  const rate = num(a, 0), per = num(a, 1), np = num(a, 2), pv = num(a, 3), fv = optNum(a, 4, 0), typ = typeArg(a, 5);
  if (per < 1 || per > np || np === 0) throw ERR.Num;
  return [rate, per, np, pv, fv, typ];
}
function cumulative(a, principal) {
  const rate = num(a, 0), np = num(a, 1), pv = num(a, 2), start = Math.trunc(num(a, 3)), end = Math.trunc(num(a, 4)), typ = num(a, 5);
  const npi = Math.trunc(np);
  if (rate <= 0 || npi <= 0 || pv <= 0 || start < 1 || end < start || end > npi || (typ !== 0 && typ !== 1)) throw ERR.Num;
  if (end - start > 1e7 || npi > 1e15) throw ERR.Num;
  const p = pmtCalc(rate, npi, pv, 0, typ);
  let sum = 0;
  for (let per = start; per <= end; per++) { const i = ipmtCalc(rate, per, npi, pv, 0, typ); sum += principal ? p - i : i; }
  return numVal(sum);
}
function newton(fn, guess) {
  let x = guess;
  for (let k = 0; k < 200; k++) {
    const y = fn(x);
    if (!Number.isFinite(y)) return null;
    const h = 1e-6 * Math.max(Math.abs(x), 1e-3);
    const d = (fn(x + h) - fn(x - h)) / (2 * h);
    if (d === 0 || !Number.isFinite(d)) return null;
    let nx = x - y / d;
    if (nx <= -1) { nx = (x - 1) / 2; if (nx <= -1) nx = -0.999999999; }
    if (Math.abs(nx - x) < 1e-12 * Math.max(Math.abs(nx), 1)) return nx;
    x = nx;
  }
  return null;
}
function solveRate(fn, guess) {
  const check = r => Number.isFinite(fn(r)) && Math.abs(fn(r)) < 1e-7 * (1 + Math.min(Math.abs(fn(guess)), 1e12));
  for (const g of [guess, 0.1, 0.01, 0.5, -0.5, 1, 0.001, 5, -0.9, 10]) {
    const r = newton(fn, g);
    if (r !== null && r > -1 && check(r)) return r;
  }
  const grid = [-0.999999, -0.99, -0.9, -0.5, -0.2, 0, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 100, 1000];
  for (let i = 0; i + 1 < grid.length; i++) {
    let lo = grid[i], hi = grid[i + 1];
    const flo = fn(lo), fhi = fn(hi);
    if (!(Number.isFinite(flo) && Number.isFinite(fhi)) || flo * fhi > 0) continue;
    const loNeg = flo < 0;
    for (let k = 0; k < 200; k++) { const mid = 0.5 * (lo + hi); if ((fn(mid) < 0) === loNeg) lo = mid; else hi = mid; }
    return 0.5 * (lo + hi);
  }
  throw ERR.Num;
}
function rate(a) {
  const np = num(a, 0), p = num(a, 1), pv = num(a, 2), fv = optNum(a, 3, 0), typ = typeArg(a, 4), guess = optNum(a, 5, 0.1);
  if (np <= 0) throw ERR.Num;
  return numVal(solveRate(r => (Math.abs(r) < 1e-12 ? pv + p * np + fv : pv * (1 + r) ** np + (p * (1 + r * typ) * ((1 + r) ** np - 1)) / r + fv), guess));
}
function npv(a) {
  const r = num(a, 0);
  if (r === -1) throw ERR.Div0;
  let sum = 0, d = 1;
  for (const v of numbers(a.slice(1))) { d *= 1 + r; sum += v / d; }
  return numVal(sum);
}
function datedFlows(values, dates) {
  const va = asArray(values), da = asArray(dates);
  if (va.data.length !== da.data.length) throw ERR.Num;
  const v = [], d = [];
  va.data.forEach((x, i) => {
    const y = da.data[i];
    if (typeof x === 'number') v.push(x); else if (x instanceof CellError) throw x; else throw ERR.Value;
    if (typeof y === 'number') d.push(Math.trunc(y));
    else if (y instanceof CellError) throw y;
    else if (typeof y === 'string') d.push(Math.trunc(ok(toNumber(y))));
    else throw ERR.Value;
  });
  if (!d.length) throw ERR.Num;
  if (d.some(x => x < d[0] || x < 0)) throw ERR.Num;
  return [v, d];
}
const xnpvCalc = (r, v, d) => v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0);
function irr(a) {
  const v = arrayNumbers(arg(a, 0).value), guess = optNum(a, 1, 0.1);
  if (!v.some(x => x > 0) || !v.some(x => x < 0)) throw ERR.Num;
  return numVal(solveRate(r => { let s = 0, d = 1; for (const x of v) { s += x / d; d *= 1 + r; } return s; }, guess));
}
function mirr(a) {
  const v = arrayNumbers(arg(a, 0).value), fr = num(a, 1), rr = num(a, 2), n = v.length;
  if (n < 2) throw ERR.Div0;
  let pos = 0, neg = 0;
  v.forEach((x, i) => { if (x > 0) pos += x / (1 + rr) ** i; else if (x < 0) neg += x / (1 + fr) ** i; });
  if (neg === 0) throw ERR.Div0;
  return numVal(((-pos * (1 + rr) ** (n - 1)) / neg) ** (1 / (n - 1)) - 1);
}

register([
  f('PMT', 3, 5, 'Financial', S, 'PMT(rate, nper, pv, [fv], [type])', 'Payment for a loan with constant payments and a constant interest rate.', pmt),
  f('IPMT', 4, 6, 'Financial', S, 'IPMT(rate, per, nper, pv, [fv], [type])', "Interest part of a given period's payment.", a => numVal(ipmtCalc(...perArgs(a)))),
  f('PPMT', 4, 6, 'Financial', S, 'PPMT(rate, per, nper, pv, [fv], [type])', "Principal part of a given period's payment.", a => { const [r, per, np, pv, fv, t] = perArgs(a); return numVal(pmtCalc(r, np, pv, fv, t) - ipmtCalc(r, per, np, pv, fv, t)); }),
  f('PV', 3, 5, 'Financial', S, 'PV(rate, nper, pmt, [fv], [type])', 'Present value of a series of equal future payments.', a => numVal(pvCalc(num(a, 0), num(a, 1), num(a, 2), optNum(a, 3, 0), typeArg(a, 4)))),
  f('FV', 3, 5, 'Financial', S, 'FV(rate, nper, pmt, [pv], [type])', 'Future value of an investment with constant payments and rate.', a => numVal(fvCalc(num(a, 0), num(a, 1), num(a, 2), optNum(a, 3, 0), typeArg(a, 4)))),
  f('NPER', 3, 5, 'Financial', S, 'NPER(rate, pmt, pv, [fv], [type])', 'Number of periods needed to pay off or accumulate an amount.', nper),
  f('RATE', 3, 6, 'Financial', S, 'RATE(nper, pmt, pv, [fv], [type], [guess])', 'Interest rate per period of an annuity.', rate),
  f('CUMIPMT', 6, 6, 'Financial', S, 'CUMIPMT(rate, nper, pv, start_period, end_period, type)', 'Cumulative interest paid between two periods.', a => cumulative(a, false)),
  f('CUMPRINC', 6, 6, 'Financial', S, 'CUMPRINC(rate, nper, pv, start_period, end_period, type)', 'Cumulative principal paid between two periods.', a => cumulative(a, true)),
  f('NPV', 2, VAR, 'Financial', [true, false], 'NPV(rate, value1, [value2], ...)', 'Net present value of periodic cash flows at a discount rate.', npv),
  f('XNPV', 3, 3, 'Financial', [true, false, false], 'XNPV(rate, values, dates)', 'Net present value of cash flows on specific dates.', a => { const r = num(a, 0); if (r <= -1) throw ERR.Num; const [v, d] = datedFlows(arg(a, 1).value, arg(a, 2).value); return numVal(xnpvCalc(r, v, d)); }),
  f('IRR', 1, 2, 'Financial', [false, true], 'IRR(values, [guess])', 'Internal rate of return of periodic cash flows.', irr),
  f('XIRR', 2, 3, 'Financial', [false, false, true], 'XIRR(values, dates, [guess])', 'Internal rate of return of cash flows on specific dates.', a => { const [v, d] = datedFlows(arg(a, 0).value, arg(a, 1).value); const g = optNum(a, 2, 0.1); if (!v.some(x => x > 0) || !v.some(x => x < 0)) throw ERR.Num; return numVal(solveRate(r => xnpvCalc(r, v, d), g)); }),
  f('MIRR', 3, 3, 'Financial', [false, true, true], 'MIRR(values, finance_rate, reinvest_rate)', 'Modified internal rate of return.', mirr),
]);
