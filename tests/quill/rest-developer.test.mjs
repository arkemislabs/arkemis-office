// U:quill/rest: Developer › Legacy Tools: the legacy form fields and Reset Form Fields.
//
// Behaviour fidelity: not checked against upstream (wordcraft only reads legacy form fields, crates/doc legacy_form.rs); the commands follow what
// Word does: Text Form Field, Check Box Form Field and Drop-Down Form Field are fields with their w:ffData; the page draws their state.
// Proof: this file and tests/e2e/quill/rest.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {pageDisplay} from '../../core/quill/layout/display.mjs';
import {parseLegacyForm} from '../../core/quill/model/legacy-form.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';

const fields = q => blocks(q.t).flatMap(b => (b.objects ?? []).filter(o => o.type === 'field' && /FORM/.test(o.instr)));

test('legacy fields: a text field, a check box and a drop-down at the caret, named as Word names them', async () => {
  const q = await quill('Name: \nAgreed: \nColour: ');
  const at = (n) => q.sel(n, q.para(n).text.length);
  at(0);
  await expectUndoRoundTrip(q.t, 'developer.legacyField', {kind: 'text', maxLength: 30}, () => {});
  at(1);
  await q.exec('developer.legacyField', {kind: 'checkBox'});
  at(2);
  await q.exec('developer.legacyField', {kind: 'dropDown', entries: ['Red', 'Green', 'Blue']});
  const [text, box, drop] = fields(q);
  assert.equal(text.instr.trim(), 'FORMTEXT');
  assert.deepEqual(parseLegacyForm(text.form), {type: 'text', name: 'Text1', maxLen: 30});
  assert.deepEqual(parseLegacyForm(box.form), {type: 'checkBox', name: 'Check1', checked: false, size: null});
  assert.deepEqual(parseLegacyForm(drop.form), {type: 'dropDown', name: 'Dropdown1', entries: ['Red', 'Green', 'Blue'], selected: 0});
  at(0);
  await q.exec('developer.legacyField', {kind: 'text'});
  assert.ok(fields(q).some(f => parseLegacyForm(f.form).name === 'Text2'), 'a second text field is Text2');
});

test('legacy fields: the page draws the box and the entry, the commands change them, Reset Form Fields takes them back, and a .docx keeps them', async () => {
  const q = await quill('Agreed: \nColour: ');
  q.sel(0, 8);
  await q.exec('developer.legacyField', {kind: 'checkBox'});
  q.sel(1, 8);
  await q.exec('developer.legacyField', {kind: 'dropDown', entries: ['Red', 'Green', 'Blue']});
  const page = () => pageDisplay(layout(q.t.content, {view: 'print'}).pages[0]).filter(d => d.type === 'text').map(d => d.text).join('|');
  assert.ok(page().includes('☐'), 'an empty box');
  q.sel(0, 9);
  await q.exec('developer.legacyCheck', {});
  assert.ok(page().includes('☒'), 'a checked box');
  q.sel(1, 9);
  await q.exec('developer.legacyChoose', {value: 'Blue'});
  assert.ok(page().includes('Blue'), 'the chosen entry');
  await assert.rejects(() => q.exec('developer.legacyChoose', {index: 9}), /entry/);
  const back = await readDocx(await writeDocx(q.t.content));
  const kept = back.body.chunks.flat().flatMap(b => (b.objects ?? []).filter(o => o.type === 'field' && /FORM/.test(o.instr)));
  assert.equal(kept.length, 2, 'both fields are fields again');
  assert.equal(parseLegacyForm(kept[0].form).checked, true);
  assert.equal(parseLegacyForm(kept[1].form).selected, 2);
  await expectUndoRoundTrip(q.t, 'developer.resetFormFields', {}, () => {});
  const [box, drop] = fields(q);
  assert.equal(parseLegacyForm(box.form).checked, false);
  assert.equal(parseLegacyForm(drop.form).selected, 0);
  q.sel(0, 0);
  await assert.rejects(() => q.exec('developer.legacyCheck', {}), /legacy form field/);
});
