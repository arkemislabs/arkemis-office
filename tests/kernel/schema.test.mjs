import test from 'node:test';
import assert from 'node:assert/strict';
import {s, validate, parse, toJSONSchema, requiredKeys, redact, hasSecrets, isSchema} from '../../core/kernel/schema.mjs';

const params = s.object({
  range: s.optional(s.address('range')),
  value: s.optional(s.boolean()),
  size: s.number({min: 1, max: 1638}),
  mode: s.optional(s.enum(['default', 'keep-source']), 'default'),
  color: s.optional(s.color()),
  tags: s.optional(s.array(s.string({min: 1}), {max: 3})),
  password: s.optional(s.secret()),
});

test('valid params pass and defaults are filled in', () => {
  const r = validate(params, {size: 12});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {size: 12, mode: 'default'});
});

test('errors carry JSON-pointer paths', () => {
  const r = validate(params, {size: 0, value: 'yes', tags: ['a', ''], extra: 1});
  assert.equal(r.ok, false);
  const paths = r.errors.map(e => e.path).sort();
  assert.deepEqual(paths, ['/extra', '/size', '/tags/1', '/value']);
  assert.throws(() => parse(params, {}), e => e.code === 'invalid_params' && e.data.path === '/size');
});

test('partial validation accepts spec control args that omit required params', () => {
  assert.equal(validate(params, {mode: 'keep-source'}, {partial: true}).ok, true);
  assert.equal(validate(params, {mode: 'merge'}, {partial: true}).ok, false);
  assert.equal(validate(params, {bogus: 1}, {partial: true}).ok, false);
});

test('addresses, colors, unions, records and nullables', () => {
  assert.equal(validate(s.address(), '/sh:k3f/B7').ok, true);
  assert.equal(validate(s.address(), '@a12').ok, true);
  assert.equal(validate(s.address(), '@b12').ok, false);
  assert.equal(validate(s.color(), '#1F6FEB').ok, true);
  assert.equal(validate(s.color(), 'auto').ok, true);
  assert.equal(validate(s.color(), 'blue').ok, false);
  const u = s.union([s.number({min: 10, max: 500}), s.enum(['pageWidth'])]);
  assert.equal(validate(u, 'pageWidth').ok, true);
  assert.equal(validate(u, 100).ok, true);
  assert.equal(validate(u, 5).ok, false);
  assert.equal(validate(s.record(s.nullable(s.string())), {a: null, b: 'x'}).ok, true);
  assert.equal(validate(s.integer(), 1.5).ok, false);
  assert.equal(validate(s.string({trim: true, min: 1}), '  ').ok, false);
});

test('schemas compile to JSON Schema', () => {
  const j = toJSONSchema(params);
  assert.equal(j.type, 'object');
  assert.equal(j.additionalProperties, false);
  assert.deepEqual(j.required, ['size']);
  assert.equal(j.properties.size.minimum, 1);
  assert.equal(j.properties.mode.default, 'default');
  assert.deepEqual(j.properties.mode.enum, ['default', 'keep-source']);
  assert.equal(j.properties.range['x-address'], 'range');
  assert.equal(j.properties.password.writeOnly, true);
  assert.deepEqual(toJSONSchema(s.nullable(s.string())).type, ['string', 'null']);
  assert.ok(JSON.stringify(j));
});

test('required keys, secrets and redaction', () => {
  assert.deepEqual(requiredKeys(params), ['size']);
  assert.equal(hasSecrets(params), true);
  assert.equal(hasSecrets(s.object({size: s.number()})), false);
  assert.deepEqual(redact(params, {size: 3, password: 'hunter2'}), {size: 3, password: '••••'});
  assert.deepEqual(redact(s.object({openPassword: s.string()}), {openPassword: 'x'}), {openPassword: '••••'});
  assert.equal(isSchema(params), true);
  assert.throws(() => s.object({a: 1}), /schema/);
});
