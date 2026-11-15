// Engineering functions: base conversion (BIN2DEC … OCT2HEX), bit operations, CONVERT, DELTA,
// GESTEP, ERF/ERFC, complex numbers (COMPLEX, IM*) and Bessel functions.
// Translated from gridcraft crates/functions/src/engineering.rs, engineering/complex.rs,
// engineering/units.rs and engineering/bessel.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formulas (registered through
// the foundation's registry). No DOM, no Node built-ins.

import {CellError, ERR, GArray, numberToText, toText} from './value.mjs';
import {erf, erfc, lnGamma} from '../model/functions/special.mjs';
import {f, register, A, S, VAR, has, num, optNum, text, numVal, scalar, flatten} from '../model/functions/registry.mjs';

const PI = Math.PI;

// ---------------------------------------------------------------------------------------------
// Base conversion

/** engineering.rs `base_source`: numbers are written out as integers. */
function baseSource(a) {
  const v = a[0] ? scalar(a[0]) : null;
  if (v instanceof CellError) throw v;
  if (typeof v === 'boolean') throw ERR.Value;
  if (typeof v === 'number') { if (v < 0 || v !== Math.trunc(v)) throw ERR.Num; return numberToText(v); }
  if (v === null || v === undefined) return '';
  const t = toText(v);
  if (t instanceof CellError) throw t;
  return t.trim();
}
const BITS = {2: 10, 8: 30, 16: 40};
/** A 10-digit two's-complement number in `radix`. */
function parseBase(s, radix) {
  if (s.length > 10) throw ERR.Num;
  if (s === '') return 0;
  if (/^[+-]/.test(s)) throw ERR.Num;
  const digits = radix === 2 ? /^[01]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/;
  if (!digits.test(s)) throw ERR.Num;
  const v = parseInt(s, radix);
  const bits = BITS[radix];
  // A full 10-digit number with the top bit set is negative.
  return s.length === 10 && v >= 2 ** (bits - 1) ? v - 2 ** bits : v;
}
function formatBase(v, radix, places) {
  const bits = BITS[radix];
  const min = -(2 ** (bits - 1)), max = 2 ** (bits - 1) - 1;
  if (v < min || v > max) throw ERR.Num;
  if (v < 0) return (v + 2 ** bits).toString(radix).toUpperCase();
  const s = v.toString(radix).toUpperCase();
  if (places === null) return s;
  const p = Math.trunc(places);
  if (!(p >= 1 && p <= 10)) throw ERR.Num;
  if (s.length > p) throw ERR.Num;
  return '0'.repeat(p - s.length) + s;
}
const placesArg = a => (has(a, 1) ? num(a, 1) : null);
function convertBase(a, from, to) {
  const v = parseBase(baseSource(a), from);
  const places = placesArg(a);
  return to === 10 ? v : formatBase(v, to, places);
}
function decTo(a, to) {
  const v = a[0] ? scalar(a[0]) : null;
  if (typeof v === 'boolean') throw ERR.Value;
  const n = Math.trunc(num(a, 0));
  if (Math.abs(n) > 1e15) throw ERR.Num;
  return formatBase(n, to, placesArg(a));
}

// ---------------------------------------------------------------------------------------------
// Bits

const BIT_LIMIT = 2 ** 48;
function bitOperand(a, i) {
  const n = num(a, i);
  if (!(n >= 0 && n < BIT_LIMIT) || n !== Math.trunc(n)) throw ERR.Num;
  return BigInt(n);
}
const bigNum = b => Number(b);
function shift(a, left) {
  const n = bitOperand(a, 0);
  const s0 = Math.trunc(num(a, 1));
  if (Math.abs(s0) > 53) throw ERR.Num;
  const s = left ? s0 : -s0;
  if (s >= 0) {
    const r = n << BigInt(s);
    if (r >= BigInt(BIT_LIMIT)) throw ERR.Num;
    return bigNum(r);
  }
  return bigNum(n >> BigInt(-s));
}

// ---------------------------------------------------------------------------------------------
// complex.rs

class Cx {
  constructor(re, im) { this.re = re; this.im = im; }
  add(o) { return new Cx(this.re + o.re, this.im + o.im); }
  sub(o) { return new Cx(this.re - o.re, this.im - o.im); }
  mul(o) { return new Cx(this.re * o.re - this.im * o.im, this.re * o.im + this.im * o.re); }
  div(o) {
    const d = o.re * o.re + o.im * o.im;
    if (d === 0) throw ERR.Num;
    return new Cx((this.re * o.re + this.im * o.im) / d, (this.im * o.re - this.re * o.im) / d);
  }
  abs() { return Math.hypot(this.re, this.im); }
  arg() { return Math.atan2(this.im, this.re); }
  exp() { const e = Math.exp(this.re); return new Cx(e * Math.cos(this.im), e * Math.sin(this.im)); }
  ln() { if (this.re === 0 && this.im === 0) throw ERR.Num; return new Cx(Math.log(this.abs()), this.arg()); }
  sin() { return new Cx(Math.sin(this.re) * Math.cosh(this.im), Math.cos(this.re) * Math.sinh(this.im)); }
  cos() { return new Cx(Math.cos(this.re) * Math.cosh(this.im), -Math.sin(this.re) * Math.sinh(this.im)); }
  sinh() { return new Cx(Math.sinh(this.re) * Math.cos(this.im), Math.cosh(this.re) * Math.sin(this.im)); }
  cosh() { return new Cx(Math.cosh(this.re) * Math.cos(this.im), Math.sinh(this.re) * Math.sin(this.im)); }
  powf(n) {
    if (this.re === 0 && this.im === 0) { if (n > 0) return new Cx(0, 0); throw ERR.Num; }
    const r = this.abs() ** n, t = this.arg() * n;
    return new Cx(r * Math.cos(t), r * Math.sin(t));
  }
}
const ONE = new Cx(1, 0);

function parseReal(s) {
  if (!s || /\s/.test(s) || !/^[0-9.eE+-]+$/.test(s)) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
/** complex.rs `parse_complex`: "3+4i", "-j", "1.5e1+2E-1j", "4" → [Cx, suffix|null]. */
export function parseComplex(s) {
  if (s === '') return [new Cx(0, 0), null];
  const last = s[s.length - 1];
  if (last !== 'i' && last !== 'j') {
    const r = parseReal(s);
    if (r === null) throw ERR.Num;
    return [new Cx(r, 0), null];
  }
  const body = s.slice(0, -1);
  let split = -1;
  for (let i = body.length - 1; i >= 1; i--) {
    const c = body[i], prev = body[i - 1];
    if ((c === '+' || c === '-') && prev !== 'e' && prev !== 'E') { split = i; break; }
  }
  const reS = split >= 0 ? body.slice(0, split) : '', imS = split >= 0 ? body.slice(split) : body;
  let re = 0;
  if (reS !== '') { const r = parseReal(reS); if (r === null) throw ERR.Num; re = r; }
  let im;
  if (imS === '' || imS === '+') im = 1;
  else if (imS === '-') im = -1;
  else { const r = parseReal(imS); if (r === null) throw ERR.Num; im = r; }
  return [new Cx(re, im), last];
}
function cxOf(v) {
  if (typeof v === 'number') return [new Cx(v, 0), null];
  if (v === null || v === undefined) return [new Cx(0, 0), null];
  if (typeof v === 'boolean') throw ERR.Value;
  if (v instanceof CellError) throw v;
  if (v instanceof GArray) return cxOf(v.data[0] ?? null);
  return parseComplex(String(v));
}
const cxArg = (a, i) => cxOf(a[i] ? scalar(a[i]) : null);
function mergeSuffix(acc, s) {
  if (acc && s && acc !== s) throw ERR.Value;
  return acc ?? s;
}
const clean = x => Number(x.toExponential(14));
/** complex.rs `fmt_complex`. */
function fmtComplex(z, suffix) {
  if (!Number.isFinite(z.re) || !Number.isFinite(z.im)) throw ERR.Num;
  const re = clean(z.re), im = clean(z.im);
  if (im === 0) return numberToText(re);
  let s = '';
  if (re !== 0) { s += numberToText(re); if (im > 0) s += '+'; }
  if (im === -1) s += '-';
  else if (im !== 1) s += numberToText(im);
  return s + suffix;
}
function complexFn(a) {
  const re = num(a, 0), im = num(a, 1);
  const sfx = has(a, 2) ? text(a, 2) : 'i';
  if (sfx !== 'i' && sfx !== '' && sfx !== 'j') throw ERR.Value;
  return fmtComplex(new Cx(re, im), sfx === 'j' ? 'j' : 'i');
}
const imUnary = fn => a => { const [z, s] = cxArg(a, 0); return fmtComplex(fn(z), s ?? 'i'); };
const imReal = fn => a => numVal(fn(cxArg(a, 0)[0]));
const imBinary = fn => a => {
  const [x, s1] = cxArg(a, 0), [y, s2] = cxArg(a, 1);
  return fmtComplex(fn(x, y), mergeSuffix(s1, s2) ?? 'i');
};
function impower(a) {
  const [z, s] = cxArg(a, 0);
  const n = num(a, 1);
  let r;
  if (n === Math.trunc(n) && Math.abs(n) <= 64 && !(z.re === 0 && z.im === 0)) {
    let acc = ONE;
    for (let i = 0; i < Math.abs(n); i++) acc = acc.mul(z);
    r = n < 0 ? ONE.div(acc) : acc;
  } else r = z.powf(n);
  return fmtComplex(r, s ?? 'i');
}
function imFold(a, init, fn) {
  let acc = init, sfx = null;
  for (const arg of a) {
    const direct = !(arg.value instanceof GArray);
    for (const v of flatten([arg])) {
      if ((v === null || v === undefined) && !direct) continue;
      const [z, s] = cxOf(v);
      sfx = mergeSuffix(sfx, s);
      acc = fn(acc, z);
    }
  }
  return fmtComplex(acc, sfx ?? 'i');
}
function imsqrt(z) {
  const m = z.abs();
  const re = Math.sqrt((m + z.re) / 2), im = Math.sqrt((m - z.re) / 2);
  return new Cx(re, z.im < 0 ? -im : im);
}

// ---------------------------------------------------------------------------------------------
// units.rs

const IN = 0.0254, FT = 0.3048, YD = 0.9144, MI = 1609.344, NMI = 1852, LY = 9_460_730_472_580_800, PICA_PT = 0.0254 / 72, PICA = 0.0254 / 6, GAL = 0.003_785_411_784;
const SI = p => ({si: p});
const NO = {}, BIN = {bin: true};
const UNITS = [
  [['g'], 'Mass', 1, SI(1)], [['sg'], 'Mass', 14_593.902_937_206_4, NO], [['lbm'], 'Mass', 453.592_37, NO], [['u'], 'Mass', 1.660_539_066_6e-24, SI(1)],
  [['ozm'], 'Mass', 28.349_523_125, NO], [['grain'], 'Mass', 0.064_798_91, NO], [['cwt', 'shweight'], 'Mass', 45_359.237, NO],
  [['uk_cwt', 'lcwt', 'hweight'], 'Mass', 50_802.345_44, NO], [['stone'], 'Mass', 6_350.293_18, NO], [['ton'], 'Mass', 907_184.74, NO],
  [['uk_ton', 'LTON', 'brton'], 'Mass', 1_016_046.908_8, NO],
  [['m'], 'Length', 1, SI(1)], [['mi'], 'Length', MI, NO], [['Nmi'], 'Length', NMI, NO], [['in'], 'Length', IN, NO], [['ft'], 'Length', FT, NO],
  [['yd'], 'Length', YD, NO], [['ang'], 'Length', 1e-10, SI(1)], [['ell'], 'Length', 1.143, NO], [['ly'], 'Length', LY, SI(1)],
  [['parsec', 'pc'], 'Length', 30_856_775_814_913_673, SI(1)], [['Picapt', 'Pica'], 'Length', PICA_PT, NO], [['pica'], 'Length', PICA, NO],
  [['survey_mi'], 'Length', 1_609.347_218_694_437, NO],
  [['yr'], 'Time', 31_557_600, NO], [['day', 'd'], 'Time', 86_400, NO], [['hr'], 'Time', 3_600, NO], [['mn', 'min'], 'Time', 60, NO], [['sec', 's'], 'Time', 1, SI(1)],
  [['Pa', 'p'], 'Pressure', 1, SI(1)], [['atm', 'at'], 'Pressure', 101_325, SI(1)], [['mmHg'], 'Pressure', 133.322_387_415, SI(1)],
  [['psi'], 'Pressure', 6_894.757_293_168_36, NO], [['Torr'], 'Pressure', 101_325 / 760, NO],
  [['N'], 'Force', 1, SI(1)], [['dyn', 'dy'], 'Force', 1e-5, SI(1)], [['lbf'], 'Force', 4.448_221_615_260_5, NO], [['pond'], 'Force', 0.009_806_65, SI(1)],
  [['J'], 'Energy', 1, SI(1)], [['e'], 'Energy', 1e-7, SI(1)], [['c'], 'Energy', 4.184, SI(1)], [['cal'], 'Energy', 4.1868, SI(1)],
  [['eV', 'ev'], 'Energy', 1.602_176_634e-19, SI(1)], [['HPh', 'hh'], 'Energy', 2_684_519.537_696_17, NO], [['Wh', 'wh'], 'Energy', 3_600, SI(1)],
  [['flb'], 'Energy', 1.355_817_948_331_4, NO], [['BTU', 'btu'], 'Energy', 1_055.055_852_62, NO],
  [['W', 'w'], 'Power', 1, SI(1)], [['HP', 'h'], 'Power', 745.699_871_582_270_2, NO], [['PS'], 'Power', 735.498_75, NO],
  [['T'], 'Magnetism', 1, SI(1)], [['ga'], 'Magnetism', 1e-4, SI(1)],
  [['C', 'cel'], 'Temperature', 1, NO], [['F', 'fah'], 'Temperature', 1, NO], [['K', 'kel'], 'Temperature', 1, SI(1)], [['Rank'], 'Temperature', 1, NO],
  [['Reau'], 'Temperature', 1, NO],
  [['l', 'L', 'lt'], 'Volume', 0.001, SI(1)], [['tsp'], 'Volume', GAL / 768, NO], [['tspm'], 'Volume', 5e-6, NO], [['tbs'], 'Volume', GAL / 256, NO],
  [['oz'], 'Volume', GAL / 128, NO], [['cup'], 'Volume', GAL / 16, NO], [['pt', 'us_pt'], 'Volume', GAL / 8, NO], [['uk_pt'], 'Volume', 0.000_568_261_25, NO],
  [['qt'], 'Volume', GAL / 4, NO], [['uk_qt'], 'Volume', 0.001_136_522_5, NO], [['gal'], 'Volume', GAL, NO], [['uk_gal'], 'Volume', 0.004_546_09, NO],
  [['m3'], 'Volume', 1, SI(3)], [['mi3'], 'Volume', MI * MI * MI, NO], [['Nmi3'], 'Volume', NMI * NMI * NMI, NO], [['yd3'], 'Volume', YD * YD * YD, NO],
  [['ft3'], 'Volume', FT * FT * FT, NO], [['in3'], 'Volume', IN * IN * IN, NO], [['ang3'], 'Volume', 1e-30, SI(3)], [['ly3'], 'Volume', LY * LY * LY, NO],
  [['Picapt3', 'Pica3'], 'Volume', PICA_PT * PICA_PT * PICA_PT, NO], [['barrel'], 'Volume', 0.158_987_294_928, NO], [['bushel'], 'Volume', 0.035_239_070_166_88, NO],
  [['MTON'], 'Volume', 1.132_673_863_68, NO], [['GRT', 'regton'], 'Volume', 2.831_684_659_2, NO],
  [['m2'], 'Area', 1, SI(2)], [['ha'], 'Area', 10_000, NO], [['ar'], 'Area', 100, SI(1)], [['ft2'], 'Area', FT * FT, NO], [['in2'], 'Area', IN * IN, NO],
  [['yd2'], 'Area', YD * YD, NO], [['mi2'], 'Area', MI * MI, NO], [['Nmi2'], 'Area', NMI * NMI, NO], [['ang2'], 'Area', 1e-20, SI(2)], [['ly2'], 'Area', LY * LY, NO],
  [['Picapt2', 'Pica2'], 'Area', PICA_PT * PICA_PT, NO], [['uk_acre'], 'Area', 4_046.856_422_4, NO], [['us_acre'], 'Area', 4_046.872_609_874_252, NO],
  [['Morgen'], 'Area', 2_500, NO],
  [['bit'], 'Information', 1, BIN], [['byte'], 'Information', 8, BIN],
  [['m/s', 'm/sec'], 'Speed', 1, SI(1)], [['m/h', 'm/hr'], 'Speed', 1 / 3600, SI(1)], [['mph'], 'Speed', MI / 3600, NO], [['kn'], 'Speed', NMI / 3600, NO],
  [['admkn'], 'Speed', 6080 * FT / 3600, NO],
].map(([names, dim, factor, pre]) => ({names, dim, factor, pre}));
const SI_PREFIXES = [['da', 1e1], ['Y', 1e24], ['Z', 1e21], ['E', 1e18], ['P', 1e15], ['T', 1e12], ['G', 1e9], ['M', 1e6], ['k', 1e3], ['h', 1e2], ['e', 1e1],
  ['d', 1e-1], ['c', 1e-2], ['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12], ['f', 1e-15], ['a', 1e-18], ['z', 1e-21], ['y', 1e-24]];
const BIN_PREFIXES = [['ki', 1024], ['Mi', 1_048_576], ['Gi', 1_073_741_824], ['Ti', 1_099_511_627_776], ['Pi', 1_125_899_906_842_624], ['Ei', 1_152_921_504_606_846_976],
  ['Zi', 1_180_591_620_717_411_303_424], ['Yi', 1_208_925_819_614_629_174_706_176]];
const findUnit = name => UNITS.find(u => u.names.includes(name)) ?? null;
function resolveUnit(name0) {
  const name = name0.replaceAll('^2', '2').replaceAll('^3', '3');
  const u = findUnit(name);
  if (u) return [u, 1];
  for (const [p, fct] of BIN_PREFIXES) if (name.startsWith(p)) { const r = findUnit(name.slice(p.length)); if (r?.pre.bin) return [r, fct]; }
  for (const [p, fct] of SI_PREFIXES) {
    if (!name.startsWith(p)) continue;
    const r = findUnit(name.slice(p.length));
    if (!r) continue;
    if (r.pre.si) return [r, fct ** r.pre.si];
    if (r.pre.bin) return [r, fct];
  }
  return null;
}
const toKelvin = (n, x) => (n === 'C' || n === 'cel' ? x + 273.15 : n === 'F' || n === 'fah' ? (x - 32) * 5 / 9 + 273.15 : n === 'Rank' ? x * 5 / 9 : n === 'Reau' ? x * 1.25 + 273.15 : x);
const fromKelvin = (n, k) => (n === 'C' || n === 'cel' ? k - 273.15 : n === 'F' || n === 'fah' ? (k - 273.15) * 9 / 5 + 32 : n === 'Rank' ? k * 9 / 5 : n === 'Reau' ? (k - 273.15) / 1.25 : k);
function convert(a) {
  const x = num(a, 0), from = text(a, 1), to = text(a, 2);
  const fu = resolveUnit(from), tu = resolveUnit(to);
  if (!fu || !tu || fu[0].dim !== tu[0].dim) throw ERR.NA;
  if (fu[0].dim === 'Temperature') {
    const fname = fu[0].names[0], tname = tu[0].names[0];
    if (fname === tname && fu[1] === tu[1]) return numVal(x);
    return numVal(fromKelvin(tname, toKelvin(fname, x * fu[1])) / tu[1]);
  }
  return numVal((x * fu[0].factor * fu[1]) / (tu[0].factor * tu[1]));
}

// ---------------------------------------------------------------------------------------------
// bessel.rs

const MAX_BESSEL_POINTS = 4_000_000;
const EULER = 0.5772156649015329;
function hankel(n, x) {
  const mu = 4 * n * n;
  let p = 0, q = 0, term = 1, last = Infinity;
  for (let k = 0; k < 200; k++) {
    if (Math.abs(term) > last) break;
    const t = k % 4 < 2 ? term : -term;
    if (k % 2 === 0) p += t; else q += t;
    last = Math.abs(term);
    if (last < 1e-17) break;
    const kk = k + 1, odd = 2 * kk - 1;
    term *= (mu - odd * odd) / (kk * 8 * x);
  }
  const chi = x - (n / 2 + 0.25) * PI;
  const fct = Math.sqrt(2 / (PI * x));
  const j = fct * (p * Math.cos(chi) - q * Math.sin(chi)), y = fct * (p * Math.sin(chi) + q * Math.cos(chi));
  return Number.isFinite(j) && Number.isFinite(y) ? [j, y] : null;
}
function besselJ(n, x) {
  const pts = Math.ceil(2 * (Math.abs(x) + n) + 64);
  if (pts > MAX_BESSEL_POINTS) {
    if (Math.abs(x) <= 1e6) return null;
    const h = hankel(n, Math.abs(x));
    return h ? (x < 0 && n % 2 === 1 ? -h[0] : h[0]) : null;
  }
  const h = 2 * PI / pts;
  let sum = 0;
  for (let k = 0; k < pts; k++) { const t = k * h; sum += Math.cos(n * t - x * Math.sin(t)); }
  return sum / pts;
}
function besselJAll(x) {
  const top = Math.ceil(x) + 30 + Math.trunc(Math.sqrt(40 * Math.max(x, 1)));
  const m = top + (top % 2);
  const j = new Array(m + 2).fill(0);
  j[m] = 1e-30;
  for (let k = m; k >= 1; k--) {
    let prev = 2 * k / x * j[k] - j[k + 1];
    if (Math.abs(prev) > 1e250) { for (let i = 0; i < j.length; i++) j[i] *= 1e-250; prev *= 1e-250; }
    j[k - 1] = prev;
  }
  let norm = j[0];
  for (let i = 2; i < j.length; i += 2) norm += 2 * j[i];
  if (norm !== 0) for (let i = 0; i < j.length; i++) j[i] /= norm;
  return j;
}
function besselY01(x) {
  if (x > 25) { const a = hankel(0, x), b = hankel(1, x); return a && b ? [a[1], b[1]] : null; }
  const j = besselJAll(x);
  const jj = k => j[k] ?? 0;
  const l = Math.log(x / 2) + EULER;
  let s0 = 0, s1 = 0;
  for (let k = 1; 2 * k + 1 < j.length; k++) {
    const sign = k % 2 === 0 ? 1 : -1;
    s0 += sign * jj(2 * k) / k;
    s1 += sign * (jj(2 * k - 1) - jj(2 * k + 1)) / k;
  }
  const y0 = (2 / PI) * l * jj(0) - (4 / PI) * s0;
  const y1 = -(2 / PI) * (jj(0) / x - l * jj(1)) + (2 / PI) * s1;
  return Number.isFinite(y0) && Number.isFinite(y1) ? [y0, y1] : null;
}
function besselY(n, x) {
  const r = besselY01(x);
  if (!r) return null;
  if (n === 0) return r[0];
  let [a, b] = r;
  for (let k = 1; k < n; k++) { const c = 2 * k / x * b - a; a = b; b = c; if (!Number.isFinite(b)) return null; }
  return b;
}
function besselI(n, x) {
  if (x === 0) return n === 0 ? 1 : 0;
  const ax = Math.abs(x);
  const lnT0 = n * Math.log(ax / 2) - lnGamma(n + 1);
  const q = ax * ax / 4;
  let term = 1, sum = 1;
  for (let k = 1; k < 1e6; k++) {
    term *= q / (k * (k + n));
    sum += term;
    if (term < 1e-17 * sum) break;
    if (!Number.isFinite(sum)) return null;
  }
  let r = Math.exp(lnT0 + Math.log(sum));
  if (x < 0 && n % 2 === 1) r = -r;
  return Number.isFinite(r) ? r : null;
}
const lnCoshSafe = v => { const a = Math.abs(v); return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2; };
function besselK(n, x) {
  const kInt = nu => {
    const h = 0.02;
    let sum = 0.5 * Math.exp(-x);
    for (let t = h; t < 800; t += h) {
      const v = Math.exp(-x * Math.cosh(t) + lnCoshSafe(nu * t));
      sum += v;
      if (v < 1e-18 * sum && x * Math.cosh(t) > 50) break;
    }
    return sum * h;
  };
  const k0 = kInt(0);
  if (n === 0) return k0;
  let a = k0, b = kInt(1);
  for (let k = 1; k < n; k++) { const c = a + 2 * k / x * b; a = b; b = c; if (!Number.isFinite(b)) return null; }
  return Number.isFinite(b) ? b : null;
}
function besselArgs(a) {
  const x = num(a, 0);
  const n = Math.trunc(num(a, 1));
  if (n < 0 || n > 100_000) throw ERR.Num;
  return [x, n];
}
const orNum = v => { if (v === null) throw ERR.Num; return numVal(v); };

// ---------------------------------------------------------------------------------------------

const E = 'Engineering';
export const specs = [
  f('BIN2DEC', 1, 1, E, S, 'BIN2DEC(number)', 'Converts a binary number to decimal.', a => convertBase(a, 2, 10)),
  f('BIN2HEX', 1, 2, E, S, 'BIN2HEX(number, [places])', 'Converts a binary number to hexadecimal.', a => convertBase(a, 2, 16)),
  f('BIN2OCT', 1, 2, E, S, 'BIN2OCT(number, [places])', 'Converts a binary number to octal.', a => convertBase(a, 2, 8)),
  f('DEC2BIN', 1, 2, E, S, 'DEC2BIN(number, [places])', 'Converts a decimal number to binary.', a => decTo(a, 2)),
  f('DEC2HEX', 1, 2, E, S, 'DEC2HEX(number, [places])', 'Converts a decimal number to hexadecimal.', a => decTo(a, 16)),
  f('DEC2OCT', 1, 2, E, S, 'DEC2OCT(number, [places])', 'Converts a decimal number to octal.', a => decTo(a, 8)),
  f('HEX2BIN', 1, 2, E, S, 'HEX2BIN(number, [places])', 'Converts a hexadecimal number to binary.', a => convertBase(a, 16, 2)),
  f('HEX2DEC', 1, 1, E, S, 'HEX2DEC(number)', 'Converts a hexadecimal number to decimal.', a => convertBase(a, 16, 10)),
  f('HEX2OCT', 1, 2, E, S, 'HEX2OCT(number, [places])', 'Converts a hexadecimal number to octal.', a => convertBase(a, 16, 8)),
  f('OCT2BIN', 1, 2, E, S, 'OCT2BIN(number, [places])', 'Converts an octal number to binary.', a => convertBase(a, 8, 2)),
  f('OCT2DEC', 1, 1, E, S, 'OCT2DEC(number)', 'Converts an octal number to decimal.', a => convertBase(a, 8, 10)),
  f('OCT2HEX', 1, 2, E, S, 'OCT2HEX(number, [places])', 'Converts an octal number to hexadecimal.', a => convertBase(a, 8, 16)),
  f('BITAND', 2, 2, E, S, 'BITAND(number1, number2)', 'Bitwise AND of two non-negative integers.', a => bigNum(bitOperand(a, 0) & bitOperand(a, 1))),
  f('BITOR', 2, 2, E, S, 'BITOR(number1, number2)', 'Bitwise OR of two non-negative integers.', a => bigNum(bitOperand(a, 0) | bitOperand(a, 1))),
  f('BITXOR', 2, 2, E, S, 'BITXOR(number1, number2)', 'Bitwise exclusive OR of two non-negative integers.', a => bigNum(bitOperand(a, 0) ^ bitOperand(a, 1))),
  f('BITLSHIFT', 2, 2, E, S, 'BITLSHIFT(number, shift_amount)', 'Shifts the bits of a number left (right for negative shifts).', a => shift(a, true)),
  f('BITRSHIFT', 2, 2, E, S, 'BITRSHIFT(number, shift_amount)', 'Shifts the bits of a number right (left for negative shifts).', a => shift(a, false)),
  f('CONVERT', 3, 3, E, S, 'CONVERT(number, from_unit, to_unit)', 'Converts a measurement from one unit to another.', convert),
  f('DELTA', 1, 2, E, S, 'DELTA(number1, [number2])', 'Returns 1 when two numbers are equal, otherwise 0.', a => (num(a, 0) === optNum(a, 1, 0) ? 1 : 0)),
  f('GESTEP', 1, 2, E, S, 'GESTEP(number, [step])', 'Returns 1 when a number is at least the step, otherwise 0.', a => (num(a, 0) >= optNum(a, 1, 0) ? 1 : 0)),
  f('ERF', 1, 2, E, S, 'ERF(lower_limit, [upper_limit])', 'Error function integrated from 0 to a limit, or between two limits.',
    a => { const lo = num(a, 0); return has(a, 1) ? numVal(erf(num(a, 1)) - erf(lo)) : numVal(erf(lo)); }),
  f('ERF.PRECISE', 1, 1, E, S, 'ERF.PRECISE(x)', 'Error function integrated from 0 to x.', a => numVal(erf(num(a, 0)))),
  f('ERFC', 1, 1, E, S, 'ERFC(x)', 'Complementary error function, 1 - ERF(x).', a => numVal(erfc(num(a, 0)))),
  f('ERFC.PRECISE', 1, 1, E, S, 'ERFC.PRECISE(x)', 'Complementary error function, 1 - ERF(x).', a => numVal(erfc(num(a, 0)))),
  f('COMPLEX', 2, 3, E, S, 'COMPLEX(real_num, i_num, [suffix])', 'Builds a complex number as text from real and imaginary parts.', complexFn),
  f('IMABS', 1, 1, E, S, 'IMABS(inumber)', 'Absolute value (modulus) of a complex number.', imReal(z => z.abs())),
  f('IMAGINARY', 1, 1, E, S, 'IMAGINARY(inumber)', 'Imaginary coefficient of a complex number.', imReal(z => z.im)),
  f('IMREAL', 1, 1, E, S, 'IMREAL(inumber)', 'Real coefficient of a complex number.', imReal(z => z.re)),
  f('IMARGUMENT', 1, 1, E, S, 'IMARGUMENT(inumber)', 'Angle of a complex number in radians.', imReal(z => { if (z.re === 0 && z.im === 0) throw ERR.Div0; return z.arg(); })),
  f('IMCONJUGATE', 1, 1, E, S, 'IMCONJUGATE(inumber)', 'Complex conjugate of a complex number.', imUnary(z => new Cx(z.re, -z.im))),
  f('IMCOS', 1, 1, E, S, 'IMCOS(inumber)', 'Cosine of a complex number.', imUnary(z => z.cos())),
  f('IMCOSH', 1, 1, E, S, 'IMCOSH(inumber)', 'Hyperbolic cosine of a complex number.', imUnary(z => z.cosh())),
  f('IMCOT', 1, 1, E, S, 'IMCOT(inumber)', 'Cotangent of a complex number.', imUnary(z => z.cos().div(z.sin()))),
  f('IMCSC', 1, 1, E, S, 'IMCSC(inumber)', 'Cosecant of a complex number.', imUnary(z => ONE.div(z.sin()))),
  f('IMCSCH', 1, 1, E, S, 'IMCSCH(inumber)', 'Hyperbolic cosecant of a complex number.', imUnary(z => ONE.div(z.sinh()))),
  f('IMDIV', 2, 2, E, S, 'IMDIV(inumber1, inumber2)', 'Quotient of two complex numbers.', imBinary((x, y) => x.div(y))),
  f('IMEXP', 1, 1, E, S, 'IMEXP(inumber)', 'Exponential of a complex number.', imUnary(z => z.exp())),
  f('IMLN', 1, 1, E, S, 'IMLN(inumber)', 'Natural logarithm of a complex number.', imUnary(z => z.ln())),
  f('IMLOG10', 1, 1, E, S, 'IMLOG10(inumber)', 'Base-10 logarithm of a complex number.', imUnary(z => { const l = z.ln(); return new Cx(l.re / Math.LN10, l.im / Math.LN10); })),
  f('IMLOG2', 1, 1, E, S, 'IMLOG2(inumber)', 'Base-2 logarithm of a complex number.', imUnary(z => { const l = z.ln(); return new Cx(l.re / Math.LN2, l.im / Math.LN2); })),
  f('IMPOWER', 2, 2, E, S, 'IMPOWER(inumber, number)', 'Raises a complex number to a power.', impower),
  f('IMPRODUCT', 1, VAR, E, A, 'IMPRODUCT(inumber1, [inumber2], ...)', 'Product of complex numbers.', a => imFold(a, ONE, (x, y) => x.mul(y))),
  f('IMSEC', 1, 1, E, S, 'IMSEC(inumber)', 'Secant of a complex number.', imUnary(z => ONE.div(z.cos()))),
  f('IMSECH', 1, 1, E, S, 'IMSECH(inumber)', 'Hyperbolic secant of a complex number.', imUnary(z => ONE.div(z.cosh()))),
  f('IMSIN', 1, 1, E, S, 'IMSIN(inumber)', 'Sine of a complex number.', imUnary(z => z.sin())),
  f('IMSINH', 1, 1, E, S, 'IMSINH(inumber)', 'Hyperbolic sine of a complex number.', imUnary(z => z.sinh())),
  f('IMSQRT', 1, 1, E, S, 'IMSQRT(inumber)', 'Square root of a complex number.', imUnary(imsqrt)),
  f('IMSUB', 2, 2, E, S, 'IMSUB(inumber1, inumber2)', 'Difference of two complex numbers.', imBinary((x, y) => x.sub(y))),
  f('IMSUM', 1, VAR, E, A, 'IMSUM(inumber1, [inumber2], ...)', 'Sum of complex numbers.', a => imFold(a, new Cx(0, 0), (x, y) => x.add(y))),
  f('IMTAN', 1, 1, E, S, 'IMTAN(inumber)', 'Tangent of a complex number.', imUnary(z => z.sin().div(z.cos()))),
  f('BESSELJ', 2, 2, E, S, 'BESSELJ(x, n)', 'Bessel function of the first kind, J_n(x).', a => { const [x, n] = besselArgs(a); return orNum(besselJ(n, x)); }),
  f('BESSELY', 2, 2, E, S, 'BESSELY(x, n)', 'Bessel function of the second kind, Y_n(x).', a => { const [x, n] = besselArgs(a); if (x <= 0) throw ERR.Num; return orNum(besselY(n, x)); }),
  f('BESSELI', 2, 2, E, S, 'BESSELI(x, n)', 'Modified Bessel function of the first kind, I_n(x).', a => { const [x, n] = besselArgs(a); return orNum(besselI(n, x)); }),
  f('BESSELK', 2, 2, E, S, 'BESSELK(x, n)', 'Modified Bessel function of the second kind, K_n(x).', a => { const [x, n] = besselArgs(a); if (x <= 0) throw ERR.Num; return orNum(besselK(n, x)); }),
];
register(specs);
