// Security audit L4: the journal redacts what a schema marks secret, whatever the field is called or typed,
// not just keys that happen to be named password or token.
import test from 'node:test';
import assert from 'node:assert/strict';
import {s, redact, hasSecrets} from '../../core/kernel/schema.mjs';

const MASK = '••••';

test('schema-marked secrets are redacted under any name, in arrays, objects and unions', () => {
  const schema = s.object({
    recoveryPhrase: s.secret(),
    note: s.string(),
    codes: s.array(s.secret()),
    inner: s.object({blob: s.secret(), shown: s.string()}),
    either: s.union([s.string(), s.object({whisper: s.secret()})]),
    byName: s.record(s.secret()),
  });
  const out = redact(schema, {
    recoveryPhrase: 'correct horse', note: 'hello', codes: ['a', 'b'], inner: {blob: 'xyz', shown: 'ok'},
    either: {whisper: 'psst'}, byName: {anything: 'v'},
  });
  assert.deepEqual(out, {recoveryPhrase: MASK, note: 'hello', codes: [MASK, MASK], inner: {blob: MASK, shown: 'ok'}, either: {whisper: MASK}, byName: {anything: MASK}});
});

test('a non-string value under a secret field is redacted too', () => {
  assert.deepEqual(redact(s.object({pin: s.secret(), token: s.string(), password: s.string()}), {pin: 1234, token: {a: 'b'}, password: ['x']}),
    {pin: MASK, token: MASK, password: MASK});
  assert.deepEqual(redact(null, {passphrase: 'p', apiKey: 'k', userPin: '1', PIN: '2'}), {passphrase: MASK, apiKey: MASK, userPin: MASK, PIN: MASK});
});

test('empty secrets stay empty (nothing to hide) and ordinary fields are untouched', () => {
  assert.deepEqual(redact(s.object({a: s.secret(), b: s.string()}), {a: '', b: 'pin'}), {a: '', b: 'pin'});
  assert.equal(hasSecrets(s.object({x: s.secret()})), true);
});
