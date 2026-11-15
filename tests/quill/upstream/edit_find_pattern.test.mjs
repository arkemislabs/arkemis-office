// Ports of the #[test]s in wordcraft crates/engine/src/cmd/find_pattern.rs (ArtCraft
// aadb077e072b7de05f724e359d8db82e151f125c): Find and Replace's ^ codes and wildcards.
//
// 1. What ArtCraft does: find_pattern.rs compiles Word's Find what (^p ^t ^# ^$ ^0nnn …, wildcards
//    < > [ ] { } @ * ?) into a regular expression and expands Replace with (^& ^c \1 ^0nnn); Word
//    reads ^0128–^0159 as Windows-1252 characters.
// 2. Ours: core/quill/lib/edit-find-pattern.mjs, the same compile / parse_replace / expand, producing a
//    JavaScript RegExp (Unicode sets as upstream's regex crate has them).
// 3. These tests and tests/quill/edit.test.mjs (edit.replaceAll through the kernel).

import test from 'node:test';
import assert from 'node:assert/strict';
import {compile, toRegExp, parseReplace, expand, defaultOpts} from '../../../core/quill/lib/edit-find-pattern.mjs';

const finds = (query, hay, o = defaultOpts()) => { const re = toRegExp(compile(query, o)); re.lastIndex = 0; return re.test(hay); };
const replaced = w => expand(parseReplace(w, defaultOpts()), '', () => null, '');
const ch = n => String.fromCharCode(n);

test('ansi_codes_128_to_159_are_windows_1252', () => {
  for (const [code, c] of [['^0151', ch(0x2014)], ['^0150', ch(0x2013)], ['^0128', ch(0x20AC)], ['^0145', ch(0x2018)]]) {
    const hay = `a${c}b`;
    assert.ok(finds(code, hay), `${code} should find ${c}`);
    assert.ok(!finds(code, code), `${code} should not match its literal text`);
    assert.ok(finds(code, hay, {...defaultOpts(), wildcards: true}), `wildcard ${code} should find ${c}`);
  }
  assert.equal(replaced('x^0151y'), `x${ch(0x2014)}y`);
  assert.equal(replaced('^0128'), ch(0x20AC));
  assert.ok(finds('^13', 'a\rb'));
  assert.ok(finds('^0065', 'A'));
  for (const undefinedSlot of ['^0129', '^0141', '^0143', '^0144', '^0157']) assert.equal(replaced(undefinedSlot), undefinedSlot);
  assert.ok(!finds('^151', ch(0x2014)));
  assert.ok(!finds('^150', ch(0x2013)));
});
