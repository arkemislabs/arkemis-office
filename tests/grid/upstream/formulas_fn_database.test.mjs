// Ported from gridcraft crates/functions/src/database.rs `mod tests` at
// 146161b4b450a56e5e59a083ba0478582d1e602b (the Rust names are the test titles), plus the functions
// evaluated in a sheet with a computed criterion.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: database.rs (criteria rows OR'ed, conditions AND'ed, plain text "begins with",
//    DGET's #VALUE!/#NUM!, a formula under an unknown label is a computed criterion). Excel gives
//    the same results (the DGet.xls expectations upstream quotes are Excel's).
// 2. Ours: the same functions registered in the foundation's library (core/grid/lib/formulas-fn-database.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import '../../../core/grid/lib/formulas-functions.mjs';
import {lookup, call, val, ref} from '../../../core/grid/model/functions/registry.mjs';
import {GArray, ERR, CellError} from '../../../core/grid/lib/value.mjs';
import {engineFor} from '../../../core/grid/model/calc.mjs';

const arr = rows => new GArray(rows.length, rows[0].length, rows.flat());
const ev = (name, args) => call(lookup(name), args, null);
const close = (v, want, tol = 1e-9) => assert.ok(typeof v === 'number' && Math.abs(v - want) <= tol * Math.max(1, Math.abs(want)), `${v} != ${want}`);
const isErr = (v, e) => assert.ok(v instanceof CellError && v.text === e.text, `${v} != ${e.text}`);
const t = s => val(s), n = x => val(x), empty = () => val(null);

const db = () => arr([
  ['Tree', 'Height', 'Age', 'Yield', 'Profit'],
  ['Apple', 18, 20, 14, 105],
  ['Pear', 12, 12, 10, 96],
  ['Cherry', 13, 14, 9, 105],
  ['Apple', 14, 15, 10, 75],
  ['Pear', 9, 8, 8, 76.8],
  ['Apple', 8, 9, 6, 45],
]);
const crit = () => arr([
  ['Tree', 'Height', 'Age', 'Yield', 'Profit', 'Height'],
  ['=Apple', '>10', null, null, null, '<16'],
  ['=Pear', null, null, null, null, null],
]);
const d = (f, field) => ev(f, [ref(db()), field, ref(crit())]);

test('orchard', () => {
  close(d('DCOUNT', t('Age')), 3);
  close(d('DCOUNTA', t('Profit')), 3);
  close(d('DMAX', t('Profit')), 96);
  close(d('DMIN', t('Profit')), 75);
  close(d('DSUM', t('Profit')), 247.8);
  close(d('DSUM', n(5)), 247.8);
  close(d('DPRODUCT', t('Yield')), 800);
  close(d('DAVERAGE', t('Yield')), 28 / 3);
  close(d('DSTDEV', t('Yield')), 1.154700538);
  close(d('DSTDEVP', t('Yield')), 0.942809042);
  close(d('DVAR', t('Yield')), 1.333333333);
  close(d('DVARP', t('Yield')), 0.888888889);
  close(d('DCOUNT', empty()), 3);
  isErr(d('DSUM', t('Nope')), ERR.Value);
  isErr(d('DSUM', n(9)), ERR.Value);
});

test('simple_criteria', () => {
  const c = cells => arr([['Tree', 'Height'], cells]);
  close(ev('DSUM', [ref(db()), t('Profit'), ref(c(['Apple', null]))]), 225);
  close(ev('DCOUNT', [ref(db()), t('Age'), ref(c(['P', null]))]), 2);
  close(ev('DCOUNT', [ref(db()), t('Age'), ref(c(['=P', null]))]), 0);
  close(ev('DSUM', [ref(db()), t('Yield'), ref(c([null, '>=13']))]), 33);
  close(ev('DSUM', [ref(db()), t('Yield'), ref(c([null, 18]))]), 14);
  close(ev('DSUM', [ref(db()), t('Yield'), ref(c([null, null]))]), 57);
  close(ev('DSUM', [ref(db()), t('Yield'), ref(c(['*e*', '<10']))]), 14);
  close(ev('DCOUNTA', [ref(db()), t('tree'), ref(arr([['Tree']]))]), 6);
  close(ev('DCOUNT', [ref(db()), t('Age'), ref(arr([['Color'], ['red']]))]), 0);
});

test('dget_and_empty', () => {
  const c = tree => arr([['Tree'], [tree]]);
  close(ev('DGET', [ref(db()), t('Yield'), ref(c('=Cherry'))]), 9);
  isErr(ev('DGET', [ref(db()), t('Yield'), ref(c('=Apple'))]), ERR.Num);
  isErr(ev('DGET', [ref(db()), t('Yield'), ref(c('=Plum'))]), ERR.Value);
  isErr(ev('DAVERAGE', [ref(db()), t('Yield'), ref(c('=Plum'))]), ERR.Div0);
  close(ev('DMAX', [ref(db()), t('Yield'), ref(c('=Plum'))]), 0);
  close(ev('DPRODUCT', [ref(db()), t('Yield'), ref(c('=Plum'))]), 0);
  isErr(ev('DSTDEV', [ref(db()), t('Yield'), ref(c('=Cherry'))]), ERR.Div0);
  close(ev('DSTDEVP', [ref(db()), t('Yield'), ref(c('=Cherry'))]), 0);
  isErr(ev('DSUM', [val(ERR.Ref), t('Yield'), ref(c('=Cherry'))]), ERR.Ref);
  close(ev('DCOUNTA', [ref(db()), empty(), ref(c('=Pear'))]), 2);
});

test('empty_string_criterion', () => {
  const data = arr([['Index', 'Value'], ['a', '='], ['b', null], ['c', ''], ['d', ' '], ['f', ERR.Value], ['h', 'abc'], ['i', 0]]);
  const get = index => ev('DGET', [ref(data), t('Index'), ref(arr([['Index', 'Value'], [index, '']]))]);
  assert.equal(get('c'), 'c');
  assert.equal(get('h'), 'h');
  isErr(get('b'), ERR.Value);
  isErr(get('i'), ERR.Value);
  isErr(get('f'), ERR.Value);
  close(ev('DCOUNTA', [ref(data), t('Index'), ref(arr([['Value'], ['']]))]), 4);
  const db2 = arr([['One', 'Two', 'Three'], ['a', 'c', 'x'], ['b', 'd', 'y']]);
  const get2 = (label, value) => ev('DGET', [ref(db2), t('One'), ref(arr([['One', label, 'Three'], ['a', value, 'x']]))]);
  assert.equal(get2(null, null), 'a');
  assert.equal(get2('', null), 'a');
  isErr(get2(null, ''), ERR.Value);
  isErr(get2('', ''), ERR.Value);
});

test('dget_skips_empty_fields', () => {
  const data = arr([['One', 'Two'], ['a', null], ['b', ' '], ['c', ''], ['d', ERR.NA], ['j', null], ['j', 'Text'], ['j', null], ['k', null], ['k', '']]);
  const get = one => ev('DGET', [ref(data), t('Two'), ref(arr([['One'], [one]]))]);
  isErr(get('a'), ERR.Value);
  assert.equal(get('b'), ' ');
  isErr(get('c'), ERR.Value);
  isErr(get('d'), ERR.NA);
  assert.equal(get('j'), 'Text');
  isErr(get('k'), ERR.Value);
});

test('database functions in a sheet, with a computed criterion', () => {
  const rows = [['Tree', 'Yield'], ['Apple', 14], ['Pear', 10], ['Cherry', 9]];
  const block = {};
  rows.forEach((r, i) => r.forEach((v, j) => { block[`${'AB'[j]}${i + 1}`] = {v}; }));
  block.D1 = {v: 'Big'};
  block.D2 = {f: 'B2>9.5'};
  block.F1 = {f: 'DSUM(A1:B4,"Yield",D1:D2)'};
  block.F2 = {f: 'DCOUNT(A1:B4,2,A1:A1)'};
  const content = {sheets: [{id: 's', name: 'S', blocks: {0: block}}], activeSheetId: 's', styles: [{}], names: []};
  const e = engineFor(content);
  assert.equal(e.sheetValue(0, 0, 5), 24, 'Apple and Pear have a yield over 9.5');
  assert.equal(e.sheetValue(0, 1, 5), 3);
});
