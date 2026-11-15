// Ported from wordcraft crates/doc/src/legacy_form.rs and crates/doc/src/eq.rs (mod tests) at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLegacyForm, legacyFormShownText} from '../../../core/quill/model/legacy-form.mjs';
import * as E from '../../../core/quill/model/eq.mjs';

test('legacy_form: check_boxes_text_fields_and_drop_downs', () => {
  const cb = inner => `<w:ffData><w:name w:val="Box1"/><w:enabled/><w:checkBox>${inner}</w:checkBox></w:ffData>`;
  assert.deepEqual(parseLegacyForm(cb('<w:sizeAuto/><w:default w:val="0"/>')), {type: 'checkBox', name: 'Box1', checked: false, size: null});
  assert.equal(parseLegacyForm(cb('<w:sizeAuto/><w:default w:val="1"/>')).checked, true);
  assert.equal(parseLegacyForm(cb('<w:default w:val="1"/><w:checked w:val="0"/>')).checked, false);
  assert.equal(parseLegacyForm(cb('<w:default w:val="0"/><w:checked/>')).checked, true);
  assert.equal(parseLegacyForm(cb('<w:size w:val="30"/><w:default w:val="0"/>')).size, 15);
  const dd = '<w:ffData><w:name w:val="List1"/><w:ddList><w:result w:val="1"/><w:listEntry w:val="Alpha"/><w:listEntry w:val="B &amp; C"/></w:ddList></w:ffData>';
  const f = parseLegacyForm(dd);
  assert.equal(legacyFormShownText(f), 'B & C');
  assert.equal(f.name, 'List1');
  assert.equal(legacyFormShownText(parseLegacyForm('<w:ffData><w:ddList><w:listEntry w:val="Only"/></w:ddList></w:ffData>')), 'Only');
  const tx = '<w:ffData><w:name w:val="Name1"/><w:textInput><w:maxLength w:val="40"/></w:textInput></w:ffData>';
  assert.deepEqual(parseLegacyForm(tx), {type: 'text', name: 'Name1', maxLen: 40});
  assert.equal(parseLegacyForm(''), null);
  assert.equal(parseLegacyForm('<w:ffData><w:name w:val="x"/></w:ffData>'), null);
});

test('eq: parses_word_enclosures_and_general_overstrike', () => {
  let e = E.parseEnclosure(' eq \\o\\ac(○,字)');
  assert.deepEqual([e.shape, e.style, e.text], ['circle', 'shrink', '字']);
  e = E.parseEnclosure('EQ \\o\\ac(□;\\s\\up 1(12))');
  assert.deepEqual([e.shape, e.text], ['square', '12']);
  e = {shape: 'diamond', style: 'enlarge', text: 'a,'};
  assert.deepEqual(E.parseEnclosure(E.enclosureInstr(e)), e);
  assert.equal(E.enclosureWordInstr(e), 'eq \\o\\ac(◇,a\\,)');
  const o = E.parseOverstrike('eq \\o \\al(=,/)');
  assert.deepEqual([o.align, o.args], ['left', ['=', '/']]);
  assert.equal(E.parseOverstrike('eq \\f(1,2)'), null);
  assert.equal(E.parseOverstrike('PAGE'), null);
  assert.equal(E.parseOverstrike('eq \\o(unclosed'), null);
  assert.equal(E.parseEnclosure('eq \\o(a,b)'), null);
  assert.ok(E.fitsEnclosure('字') && E.fitsEnclosure('12') && !E.fitsEnclosure('字字') && !E.fitsEnclosure('123') && !E.fitsEnclosure(''));
});
