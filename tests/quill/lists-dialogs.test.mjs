// The U:quill/lists dialogs: Define New Multilevel List, Define New Bullet, Define New Number
// Format, Set Numbering Value (core/quill/dialogs/{defineList,defineBullet,defineNumber,setNumberingValue}.mjs).
//
// Behaviour fidelity:
// 1. ArtCraft: dialogs_lists.rs ListForm::read (the caret's list or a new 1. a. i.), the level
//    fields (a new number style puts the level's number in the text, Include level number from
//    appends %k), LevelForm::params → one list.define; tools/specs.rs para.defineBullet,
//    para.defineNumber, para.setNumberingValue. Word: the same dialogs with a preview.
// 2. Ours edits the same per-level form and submits the same commands, one undo step each.
// 3. These tests; the Multilevel List gallery is driven in tests/e2e/quill/format-home.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {submitDialog, changeDialogValues} from '../../core/kernel/dialog.mjs';
import defineList, {sample, levelForm, levelParams} from '../../core/quill/dialogs/defineList.mjs';
import defineBullet from '../../core/quill/dialogs/defineBullet.mjs';
import defineNumber, {numberLabel} from '../../core/quill/dialogs/defineNumber.mjs';
import setNumberingValue from '../../core/quill/dialogs/setNumberingValue.mjs';

const open = (q, d) => d.init(q.t.session.readContext(q.t.docId));
const submit = (q, d, v) => submitDialog(q.t.session, q.t.docId, d, v);
const set = (d, v, field, value) => changeDialogValues(d, v, field, value);

test('dialogs_lists.rs ListForm: a new list is 1. a. i. and the preview numbers each level', async () => {
  const q = await quill('item');
  q.sel(0, 0);
  const v = open(q, defineList);
  assert.equal(v._levels.length, 9);
  assert.deepEqual([0, 1, 2].map(i => sample(v._levels, i)), ['1.', 'a.', 'i.']);
  assert.equal(v.text, '%1.');
  const p = defineList.preview(null, v);
  assert.equal(p.rows.length, 9);
  assert.equal(p.current, 0);
});

test('dialogs_lists.rs define_list: a level edited, legal numbering, include level, one list.define', async () => {
  const q = await quill('one\ntwo');
  q.sel([0, 0], [1, 3]);
  let v = open(q, defineList);
  v = set(defineList, v, 'level', 1);
  assert.equal(v.text, '%2.', 'level 2\'s fields');
  v = set(defineList, v, 'format', 'decimal');
  assert.equal(v.text, '%2.', 'a number style keeps a text that has a number');
  v = set(defineList, v, 'text', '');
  v = set(defineList, v, 'format', 'upperRoman');
  assert.equal(v.text, '%2.', 'a text without a number gets the level\'s number');
  v = set(defineList, v, 'text', '');
  v = set(defineList, v, 'includeLevel', 1);
  v = set(defineList, v, 'text', `${v.text}.%2`);
  assert.equal(v.text, '%1.%2');
  assert.equal(sample(v._levels, 1), '1.I');
  v = set(defineList, v, 'legal', true);
  assert.equal(sample(v._levels, 1), '1.I', 'legal numbering keeps this level\'s own style');
  v = set(defineList, v, 'level', 0);
  assert.equal(v.text, '%1.', 'level 1 again');
  v = set(defineList, v, 'format', 'bullet');
  assert.equal(v.text, '•', 'a bullet puts its character');
  v = set(defineList, v, 'level', 1);
  assert.equal(v.legal, true, 'level 2 kept its change');
  const version = q.t.session.get(q.t.docId).version;
  const r = await submit(q, defineList, v);
  assert.equal(q.t.session.get(q.t.docId).version, version + 1, 'one undo step');
  const num = r.result.num;
  assert.ok(num > 0);
  assert.equal(q.props(0).numbering.num, num, 'the selection is numbered with it');
  const got = (await q.exec('list.get', {num})).result;
  const lv = got.levels ?? got;
  assert.equal(lv[0].format, 'bullet');
  assert.equal(lv[1].format, 'upperRoman');
  assert.equal(lv[1].text, '%1.%2');
  assert.equal(lv[1].legal, true);
});

test('dialogs_lists.rs LevelForm read/params round trip (inches ↔ points, restart, tab stop)', () => {
  const json = {format: 'lowerLetter', text: '%2)', start: 3, restartAfter: 0, style: 'Heading2', align: 'right', alignedAt: 36, indentAt: 54,
    follow: 'tab', tabAt: 72, font: 'Georgia', bold: true, italic: false, legal: false};
  const f = levelForm(1, json);
  assert.deepEqual([f.alignedAt, f.indentAt, f.tabAt, f.tabOn, f.restart, f.linkStyle], [0.5, 0.75, 1, true, false, 'Heading2']);
  const back = levelParams(f, 1);
  assert.deepEqual({...back}, {...json});
  assert.equal(levelParams({...f, follow: 'space'}, 1).tabAt, null, 'no tab stop unless a tab follows');
});

test('Define New Bullet: the picked or typed character becomes a bulleted list', async () => {
  const q = await quill('first\nsecond');
  q.sel([0, 0], [1, 1]);
  let v = open(q, defineBullet);
  v = {...v, char: '★'};
  await submit(q, defineBullet, v);
  assert.ok(q.props(0).numbering?.num && q.props(1).numbering?.num);
  assert.deepEqual(q.labels(), ['★', '★']);
  assert.ok(defineBullet.validate({char: '•', custom: 'ab'}).length, 'one character');
  await q.t.undo();
  assert.ok(!q.props(0).numbering);
});

test('Define New Number Format: style, format text and start; the preview shows the labels', async () => {
  const q = await quill('a\nb');
  q.sel([0, 0], [1, 1]);
  let v = open(q, defineNumber);
  v = set(defineNumber, v, 'format', 'upperRoman');
  v = {...v, text: '(%1)', start: 4};
  assert.deepEqual(defineNumber.preview(null, v).labels, ['(IV)', '(V)', '(VI)']);
  assert.equal(numberLabel('lowerLetter', '%1.', 2), 'b.');
  await submit(q, defineNumber, v);
  assert.deepEqual(q.labels(), ['(IV)', '(V)']);
  assert.ok(defineNumber.validate({format: 'decimal', text: 'x', start: 1}).length, 'the format needs %1');
});

test('Set Numbering Value: a new list from the caret starting at the value', async () => {
  const q = await quill('a\nb\nc');
  q.sel([0, 0], [2, 1]);
  await q.exec('para.numbering');
  q.sel(1, 0);
  const v = open(q, setNumberingValue);
  assert.equal(v.value, 1);
  assert.deepEqual(setNumberingValue.preview(null, {...v, value: 7}).labels, ['7.']);
  await submit(q, setNumberingValue, {...v, value: 7});
  assert.deepEqual(q.labels(), ['1.', '7.', '8.']);
  await q.t.undo();
  assert.deepEqual(q.labels(), ['1.', '2.', '3.']);
});
