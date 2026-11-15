import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, format, isAnchor, parseTextRange, assertCodeUnitBoundary, createAddressing, genericResolver} from '../../core/kernel/address.mjs';
import {CommandError, ERROR_CODES, HTTP_STATUS, toCommandError} from '../../core/kernel/errors.mjs';

test('the address grammar round-trips', () => {
  for (const a of ['/body/b:7hq2c0xa/t:4-9', '/sh:k3f/B7', '/sl:s1/sp:e9/t:0-5', '/pg:p3/annot:a7', '/hdr:s1.default', '/']) {
    assert.equal(format(parse(a)), a);
  }
  assert.deepEqual(parse('/sh:k3f/A1:C9').segments, [{kind: 'sh', key: 'k3f'}, {kind: 'A1', key: 'C9'}]);
  assert.deepEqual(parse('@a12'), {anchor: '@a12'});
  assert.equal(isAnchor('@a12'), true);
  assert.equal(isAnchor('@b12'), false);
  assert.equal(format({segments: [{kind: 'field', key: 'a/b'}]}), '/field:a%2Fb');
  assert.deepEqual(parse('/field:a%2Fb').segments[0], {kind: 'field', key: 'a/b'});
});

test('malformed addresses are invalid_address', () => {
  for (const bad of ['', 'body', '//x', '/a//b', 7, 'x'.repeat(5000)]) {
    assert.throws(() => parse(bad), e => e instanceof CommandError && e.code === 'invalid_address', String(bad).slice(0, 20));
  }
});

test('text ranges and UTF-16 boundaries', () => {
  assert.deepEqual(parseTextRange('4-9'), {from: 4, to: 9});
  assert.deepEqual(parseTextRange('5'), {from: 5, to: 5});
  assert.throws(() => parseTextRange('9-4'), e => e.code === 'invalid_address');
  const text = 'a😀b';
  assertCodeUnitBoundary(text, 1);
  assertCodeUnitBoundary(text, 3);
  assert.throws(() => assertCodeUnitBoundary(text, 2), /splits a Unicode character/);
  assert.throws(() => assertCodeUnitBoundary(text, 9), /outside the text/);
});

test('apps without a resolver fall back to the generic JSON resolver', () => {
  const a = createAddressing();
  assert.equal(a.generic, true);
  const content = {sheets: [{name: 'S1'}]};
  assert.equal(a.read(content, a.parse('/sheets/0/name')), 'S1');
  assert.throws(() => a.resolve(content, a.parse('/sheets/4')), e => e.code === 'not_found');
  assert.deepEqual(genericResolver.enumerate(content, parse('/'), {depth: 2, limit: 10}).nodes.map(n => n.address), ['/', '/sheets', '/sheets/0']);
  const custom = createAddressing({parse: () => ({segments: [{kind: 'x'}]}), changed: () => ['/x']});
  assert.equal(custom.generic, false);
  assert.deepEqual(custom.parse('/anything'), {segments: [{kind: 'x'}]});
  assert.deepEqual(custom.parse('@a3'), {anchor: '@a3'}, 'anchors are parsed by the kernel');
  assert.equal(custom.format({segments: [{kind: 'y'}]}), '/y', 'missing functions fall back');
});

test('error codes map to HTTP statuses and wrap foreign errors', () => {
  assert.equal(ERROR_CODES.length, 11);
  assert.equal(HTTP_STATUS.conflict, 409);
  assert.equal(HTTP_STATUS.approval_required, 428);
  assert.equal(HTTP_STATUS.too_large, 413);
  assert.deepEqual(toCommandError(new Error('x')).toJSON(), {code: 'failed', message: 'x'});
  assert.equal(toCommandError({code: 'conflict', message: 'm', data: 1}).code, 'conflict');
  assert.throws(() => new CommandError('nope', 'x'), TypeError);
});
