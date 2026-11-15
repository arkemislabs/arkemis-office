// Security audit H1: a regex pattern in a cell formula must not be able to hang the thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import {session, run, v, errorOf} from '../grid/edit-helpers.mjs';

const BS = '\\';
const q = s => s.split('"').join('""');
async function calc(formula, cells = {}) {
  const t = await session();
  for (const [a, x] of Object.entries(cells)) await run(t, 'range.setValues', {range: a, values: [[x]]});
  await run(t, 'range.setValues', {range: 'Z99', values: [['=' + formula]]});
  const t0 = Date.now();
  const value = v(t, 'Z99');
  return {value: errorOf(value) ?? value, ms: Date.now() - t0};
}

test('catastrophic patterns are refused with #VALUE! instead of hanging', async () => {
  const s = 'a'.repeat(40) + 'b';
  for (const p of ['^(a+)+$', '^(a*)*$', '^(a|a)*$', '^(a|aa)+$', '^(a?)*$', '^(a{1,3})+$', '^((a+)b?)+$', '^(a|)*$', `^(${BS}w+${BS}s?)*$`]) {
    const {value, ms} = await calc(`REGEXTEST("${s}","${q(p)}")`);
    assert.equal(value, '#VALUE!', p);
    assert.ok(ms < 500, `${p} took ${ms} ms`);
  }
  assert.equal((await calc(`REGEXEXTRACT("${s}","(a+)+$")`)).value, '#VALUE!');
  assert.equal((await calc(`REGEXREPLACE("${s}","(a+)+$","x")`)).value, '#VALUE!');
});

test('polynomial and over-long inputs are refused', async () => {
  assert.equal((await calc('REGEXTEST(A1,"^.*a.*a.*a.*a.*b")', {A1: 'a'.repeat(5000)})).value, '#VALUE!');
  assert.equal((await calc('REGEXTEST(A1,"a")', {A1: 'x'.repeat(40_000)})).value, '#VALUE!');
  assert.equal((await calc(`REGEXTEST("abc","${'a'.repeat(1001)}")`)).value, '#VALUE!');
});

test('ordinary patterns still work', async () => {
  const d = BS + 'd', w = BS + 'w', dot = BS + '.';
  assert.equal((await calc('REGEXTEST("hello world","^h.*d$")')).value, true);
  assert.equal((await calc(`REGEXTEST("2024-05-06","^${d}{4}-${d}{2}-${d}{2}$")`)).value, true);
  assert.equal((await calc(`REGEXEXTRACT("order 1234 ok","${d}+")`)).value, '1234');
  assert.equal((await calc('REGEXTEST("abab","^(a|b)*$")')).value, true);
  assert.equal((await calc(`REGEXTEST("1.22.3.4","^(${d}+${dot}){3}${d}+$")`)).value, true);
  assert.equal((await calc('REGEXREPLACE("a-b-c","-","+")')).value, 'a+b+c');
  assert.equal((await calc(`REGEXTEST("x@y.com","^[${w}.]+@[${w}.]+${dot}${w}+$")`)).value, true);
  assert.equal((await calc('REGEXTEST("abc","(")')).value, '#VALUE!');
});
