// Ported from gridcraft crates/functions/src/engineering.rs `mod tests` at
// 146161b4b450a56e5e59a083ba0478582d1e602b (the Rust names are the test titles).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: engineering.rs and engineering/{complex,units,bessel}.rs; the expected values are
//    Excel's documented results (BIN2DEC(1111111111) = -1, CONVERT(68,"F","C") = 20, ...).
// 2. Ours: the same functions registered in the foundation's library (core/grid/lib/formulas-fn-engineering.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import '../../../core/grid/lib/formulas-functions.mjs';
import {lookup, call, val, ref} from '../../../core/grid/model/functions/registry.mjs';
import {GArray, ERR, CellError} from '../../../core/grid/lib/value.mjs';
import {parseComplex} from '../../../core/grid/lib/formulas-fn-engineering.mjs';

const ev = (name, args) => call(lookup(name), args, null);
const n = x => val(x), t = s => val(s);
const close = (v, want, tol = 1e-9) => assert.ok(typeof v === 'number' && Math.abs(v - want) <= tol * Math.max(1, Math.abs(want)), `${v} != ${want}`);
const isErr = (v, e) => assert.ok(v instanceof CellError && v.text === e.text, `${v} != ${e.text}`);
const isText = (v, s) => assert.equal(v, s);
const cx = (v, re, im) => {
  assert.equal(typeof v, 'string', String(v));
  const [z] = parseComplex(v);
  assert.ok(Math.abs(z.re - re) <= 1e-12 * Math.max(Math.abs(re), 1), `${v}: re ${z.re} vs ${re}`);
  assert.ok(Math.abs(z.im - im) <= 1e-12 * Math.max(Math.abs(im), 1), `${v}: im ${z.im} vs ${im}`);
};

test('base_conversions', () => {
  close(ev('BIN2DEC', [n(1100100)]), 100);
  close(ev('BIN2DEC', [n(1111111111)]), -1);
  isText(ev('BIN2HEX', [n(11111011), n(4)]), '00FB');
  isText(ev('BIN2HEX', [n(1110)]), 'E');
  isText(ev('BIN2HEX', [n(1111111111)]), 'FFFFFFFFFF');
  isText(ev('BIN2OCT', [n(1001), n(3)]), '011');
  isText(ev('BIN2OCT', [n(1111111111)]), '7777777777');
  isText(ev('DEC2BIN', [n(9), n(4)]), '1001');
  isText(ev('DEC2BIN', [n(-100)]), '1110011100');
  isErr(ev('DEC2BIN', [n(512)]), ERR.Num);
  isText(ev('DEC2HEX', [n(100), n(4)]), '0064');
  isText(ev('DEC2HEX', [n(-54)]), 'FFFFFFFFCA');
  isText(ev('DEC2HEX', [n(28)]), '1C');
  isErr(ev('DEC2HEX', [n(64), n(1)]), ERR.Num);
  isText(ev('DEC2OCT', [n(58), n(3)]), '072');
  isText(ev('DEC2OCT', [n(-100)]), '7777777634');
  isText(ev('HEX2BIN', [t('F'), n(8)]), '00001111');
  isText(ev('HEX2BIN', [t('B7')]), '10110111');
  isText(ev('HEX2BIN', [t('FFFFFFFE00')]), '1000000000');
  isErr(ev('HEX2BIN', [t('200')]), ERR.Num);
  close(ev('HEX2DEC', [t('A5')]), 165);
  close(ev('HEX2DEC', [t('FFFFFFFF5B')]), -165);
  close(ev('HEX2DEC', [t('3DA408B9')]), 1034160313);
  isText(ev('HEX2OCT', [t('F'), n(3)]), '017');
  isText(ev('HEX2OCT', [t('3B4E')]), '35516');
  isText(ev('HEX2OCT', [t('FFFFFFFF00')]), '7777777400');
  isText(ev('OCT2BIN', [n(3), n(3)]), '011');
  isText(ev('OCT2BIN', [n(7777777000)]), '1000000000');
  close(ev('OCT2DEC', [n(54)]), 44);
  close(ev('OCT2DEC', [n(7777777533)]), -165);
  isText(ev('OCT2HEX', [n(100), n(4)]), '0040');
  isText(ev('OCT2HEX', [n(7777777533)]), 'FFFFFFFF5B');
  isErr(ev('BIN2DEC', [n(102)]), ERR.Num);
  isErr(ev('HEX2DEC', [t('GG')]), ERR.Num);
  isErr(ev('BIN2DEC', [t('11111111111')]), ERR.Num);
  isErr(ev('DEC2BIN', [t('abc')]), ERR.Value);
  isText(ev('DEC2BIN', [n(9.7)]), '1001');
  close(ev('HEX2DEC', [t('ff')]), 255);
});

test('bits', () => {
  close(ev('BITAND', [n(1), n(5)]), 1);
  close(ev('BITAND', [n(13), n(25)]), 9);
  close(ev('BITOR', [n(23), n(10)]), 31);
  close(ev('BITXOR', [n(5), n(3)]), 6);
  close(ev('BITLSHIFT', [n(4), n(2)]), 16);
  close(ev('BITRSHIFT', [n(13), n(2)]), 3);
  close(ev('BITRSHIFT', [n(13), n(-2)]), 52);
  isErr(ev('BITAND', [n(-1), n(5)]), ERR.Num);
  isErr(ev('BITAND', [n(1.5), n(5)]), ERR.Num);
  isErr(ev('BITLSHIFT', [n(1), n(54)]), ERR.Num);
  isErr(ev('BITLSHIFT', [n(2 ** 47), n(1)]), ERR.Num);
});

test('convert_units', () => {
  close(ev('CONVERT', [n(1), t('lbm'), t('kg')]), 0.45359237);
  close(ev('CONVERT', [n(68), t('F'), t('C')]), 20);
  close(ev('CONVERT', [n(100), t('C'), t('F')]), 212);
  close(ev('CONVERT', [n(0), t('C'), t('K')]), 273.15);
  close(ev('CONVERT', [n(1), t('in'), t('cm')]), 2.54);
  close(ev('CONVERT', [n(1), t('mi'), t('km')]), 1.609344);
  close(ev('CONVERT', [n(1), t('gal'), t('l')]), 3.785411784);
  close(ev('CONVERT', [n(1), t('byte'), t('bit')]), 8);
  close(ev('CONVERT', [n(1), t('kibyte'), t('byte')]), 1024);
  close(ev('CONVERT', [n(100), t('km/h'), t('m/s')]), 100 / 3.6);
  close(ev('CONVERT', [n(1), t('m2'), t('ft2')]), 10.763910416709722);
  close(ev('CONVERT', [n(1), t('km2'), t('m2')]), 1e6);
  close(ev('CONVERT', [n(1), t('hr'), t('mn')]), 60);
  close(ev('CONVERT', [n(1), t('atm'), t('Pa')]), 101325);
  close(ev('CONVERT', [n(1), t('ha'), t('m^2')]), 10000);
  close(ev('CONVERT', [n(1), t('cal'), t('J')]), 4.1868);
  close(ev('CONVERT', [n(1), t('mm'), t('m')]), 0.001);
  close(ev('CONVERT', [n(6), t('ft'), t('yd')]), 2);
  close(ev('CONVERT', [n(1), t('cup'), t('tsp')]), 48);
  isErr(ev('CONVERT', [n(2.5), t('ft'), t('sec')]), ERR.NA);
  isErr(ev('CONVERT', [n(1), t('xyz'), t('m')]), ERR.NA);
  isErr(ev('CONVERT', [n(1), t('kft'), t('m')]), ERR.NA);
  isErr(ev('CONVERT', [n(1), t('LBM'), t('kg')]), ERR.NA);
});

test('delta_gestep_erf', () => {
  close(ev('DELTA', [n(5), n(4)]), 0);
  close(ev('DELTA', [n(5), n(5)]), 1);
  close(ev('DELTA', [n(0.5)]), 0);
  close(ev('GESTEP', [n(5), n(4)]), 1);
  close(ev('GESTEP', [n(-4)]), 0);
  close(ev('ERF', [n(0.745)]), 0.707928920, 1e-9);
  close(ev('ERF', [n(1)]), 0.842700792949715, 1e-12);
  close(ev('ERF', [n(0), n(1.5)]), 0.966105146475311, 1e-12);
  close(ev('ERF.PRECISE', [n(1)]), 0.842700792949715, 1e-12);
  close(ev('ERFC', [n(1)]), 0.157299207050285, 1e-12);
  close(ev('ERFC.PRECISE', [n(-1)]), 1.842700792949715, 1e-12);
});

test('complex_numbers', () => {
  isText(ev('COMPLEX', [n(3), n(4)]), '3+4i');
  isText(ev('COMPLEX', [n(3), n(4), t('j')]), '3+4j');
  isText(ev('COMPLEX', [n(0), n(1)]), 'i');
  isText(ev('COMPLEX', [n(0), n(-1)]), '-i');
  isText(ev('COMPLEX', [n(1.5), n(-2)]), '1.5-2i');
  isText(ev('COMPLEX', [n(3), n(0)]), '3');
  isText(ev('COMPLEX', [n(0), n(0)]), '0');
  isErr(ev('COMPLEX', [n(1), n(1), t('k')]), ERR.Value);
  close(ev('IMABS', [t('5+12i')]), 13);
  close(ev('IMREAL', [t('6-9i')]), 6);
  close(ev('IMAGINARY', [t('3+4i')]), 4);
  close(ev('IMAGINARY', [t('-j')]), -1);
  close(ev('IMAGINARY', [t('4')]), 0);
  close(ev('IMREAL', [n(7)]), 7);
  close(ev('IMARGUMENT', [t('3+4i')]), 0.9272952180016122);
  isErr(ev('IMARGUMENT', [t('0')]), ERR.Div0);
  isText(ev('IMCONJUGATE', [t('3+4i')]), '3-4i');
  isText(ev('IMDIV', [t('-238+240i'), t('10+24i')]), '5+12i');
  isErr(ev('IMDIV', [t('1+i'), t('0')]), ERR.Num);
  isText(ev('IMPRODUCT', [t('3+4i'), t('5-3i')]), '27+11i');
  isText(ev('IMPRODUCT', [t('1+2i'), n(30)]), '30+60i');
  isText(ev('IMSUM', [t('3+4i'), t('5-3i')]), '8+i');
  isText(ev('IMSUM', [ref(new GArray(1, 3, ['1+i', null, '2']))]), '3+i');
  isText(ev('IMSUB', [t('13+4i'), t('5+3i')]), '8+i');
  isErr(ev('IMSUM', [t('1+i'), t('1+j')]), ERR.Value);
  isErr(ev('IMABS', [t('abc')]), ERR.Num);
  isErr(ev('IMABS', [val(true)]), ERR.Value);
  cx(ev('IMEXP', [t('1+i')]), 1.4686939399158852, 2.287355287178842);
  cx(ev('IMLN', [t('3+4i')]), 1.6094379124341003, 0.9272952180016122);
  cx(ev('IMLOG10', [t('3+4i')]), 0.6989700043360188, 0.4027191962733732);
  cx(ev('IMLOG2', [t('3+4i')]), 2.321928094887362, 1.3378042124509768);
  cx(ev('IMSQRT', [t('1+i')]), 1.0986841134678099, 0.4550898605622273);
  isText(ev('IMSQRT', [t('-4')]), '2i');
  isText(ev('IMSQRT', [t('-9')]), '3i');
  isText(ev('IMSQRT', [t('4')]), '2');
  isText(ev('IMSQRT', [t('-2i')]), '1-i');
  isText(ev('IMPOWER', [t('2+3i'), n(3)]), '-46+9i');
  cx(ev('IMPOWER', [t('2+3i'), n(0.5)]), 1.6741492280355402, 0.895977476129838);
  cx(ev('IMSIN', [t('3+4i')]), 3.853738037919377, -27.01681325800393);
  cx(ev('IMCOS', [t('1+i')]), 0.833730025131149, -0.988897705762865);
  cx(ev('IMSINH', [t('4+3i')]), -27.01681325800393, 3.853738037919377);
  cx(ev('IMCOSH', [t('4+3i')]), -27.034945603074224, 3.851153334811777);
  cx(ev('IMTAN', [t('4+3i')]), 0.00490825806749606, 1.000709536067233);
  cx(ev('IMCOT', [t('4+3i')]), 0.0049011823943044, -0.999266927805902);
  cx(ev('IMSEC', [t('4+3i')]), -0.0652940278579471, -0.0752249603027732);
  cx(ev('IMCSC', [t('4+3i')]), -0.0754898329158637, 0.0648774713706355);
  isText(ev('IMSECH', [t('0')]), '1');
  isErr(ev('IMCSCH', [t('0')]), ERR.Num);
  cx(ev('IMPRODUCT', [t(ev('IMCOSH', [t('4+3i')])), t(ev('IMSECH', [t('4+3i')]))]), 1, 0);
  cx(ev('IMPRODUCT', [t(ev('IMSINH', [t('4+3i')])), t(ev('IMCSCH', [t('4+3i')]))]), 1, 0);
  cx(ev('IMSUM', [t('1.5e1+2E-1j')]), 15, 0.2);
});

test('bessel', () => {
  close(ev('BESSELJ', [n(1.9), n(2)]), 0.329925829, 1e-6);
  close(ev('BESSELY', [n(2.5), n(1)]), 0.145918138, 1e-6);
  close(ev('BESSELI', [n(1.5), n(1)]), 0.981666428, 1e-6);
  close(ev('BESSELK', [n(1.5), n(1)]), 0.277387804, 1e-6);
  close(ev('BESSELJ', [n(1), n(0)]), 0.7651976865579666, 1e-12);
  close(ev('BESSELJ', [n(1), n(1)]), 0.4400505857449335, 1e-12);
  close(ev('BESSELJ', [n(-1), n(1)]), -0.4400505857449335, 1e-12);
  close(ev('BESSELY', [n(1), n(0)]), 0.08825696421567696, 1e-11);
  close(ev('BESSELY', [n(1), n(1)]), -0.7812128213002887, 1e-11);
  close(ev('BESSELI', [n(1), n(0)]), 1.2660658777520084, 1e-12);
  close(ev('BESSELI', [n(1), n(1)]), 0.5651591039924851, 1e-12);
  close(ev('BESSELK', [n(1), n(0)]), 0.4210244382407083, 1e-11);
  close(ev('BESSELK', [n(1), n(1)]), 0.6019072301972346, 1e-11);
  isErr(ev('BESSELJ', [n(1), n(-1)]), ERR.Num);
  isErr(ev('BESSELY', [n(0), n(1)]), ERR.Num);
  isErr(ev('BESSELK', [n(-1), n(1)]), ERR.Num);
  isErr(ev('BESSELJ', [t('x'), n(1)]), ERR.Value);
  for (const x of [0.5, 7, 15, 24, 30, 80]) {
    const j0 = ev('BESSELJ', [n(x), n(0)]), j1 = ev('BESSELJ', [n(x), n(1)]), y0 = ev('BESSELY', [n(x), n(0)]), y1 = ev('BESSELY', [n(x), n(1)]);
    const w = j1 * y0 - j0 * y1, expect = 2 / (Math.PI * x);
    assert.ok(Math.abs(w - expect) < 1e-9 * Math.max(expect, 1), `x=${x}: ${w} vs ${expect}`);
  }
  assert.equal(typeof ev('BESSELJ', [n(50), n(3)]), 'number');
  assert.equal(typeof ev('BESSELK', [n(30), n(5)]), 'number');
});
