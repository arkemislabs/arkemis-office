// U:quill/format — list definitions: Define New Multilevel List, the Multilevel List library,
// Set Numbering Value, Define New Bullet and Define New Number Format.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/lists.rs (`define` 182, `get` 175, `preset` 274,
//    `preset_levels` 225) and cmd/tools/specs.rs (`para.setNumberingValue` 291,
//    `para.defineBullet` 316, `para.defineNumber` 320). Word: Define New Multilevel List sets nine
//    levels (format, %n text, start, restart, linked style, alignment, indents, follow, font) and
//    numbers the selection; the library's heading presets number Heading 1–9 through their styles.
// 2. Ours: core/quill/commands/lists.mjs over the schema-2 numbering; labels checked through the
//    translated layout (core/quill/layout).
// 3. Proof: this file, tests/quill/upstream/lists_*.test.mjs, tests/e2e/quill/format-home.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {quill} from './format-fixture.mjs';
import {getStyle} from '../../core/quill/model/styles.mjs';

test('list.define numbers the selection with custom levels; list.get reads them back as define takes them', async () => {
  const q = await quill('One\nTwo\nThree');
  q.sel([0, 0], [2, 5]);
  const levels = [
    {format: 'decimal', text: '%1.', start: 1, alignedAt: 0, indentAt: 18, follow: 'tab', tabAt: 24, font: 'Arial', bold: true},
    {format: 'decimal', text: '%1.%2.', alignedAt: 18, indentAt: 45, follow: 'space', restartAfter: 1},
    {format: 'lowerLetter', text: '%3)', start: 1, align: 'right', alignedAt: 54, indentAt: 72, follow: 'nothing', restartAfter: 0},
  ];
  const r = await q.exec('list.define', {levels, name: 'Spec'});
  const num = r.result.num;
  q.sel(1, 0);
  await q.exec('para.listLevel', {level: 1});
  q.sel(2, 0);
  await q.exec('para.listLevel', {level: 2});
  assert.deepEqual(q.labels(), ['1.', '1.1.', 'a)']);
  const got = (await q.exec('list.get', {num})).result;
  assert.equal(got.name, 'Spec');
  const l = got.levels;
  assert.deepEqual([l[0].tabAt, l[0].font, l[0].bold], [24, 'Arial', true]);
  assert.deepEqual([l[1].follow, l[1].alignedAt, l[1].indentAt], ['space', 18, 45]);
  assert.deepEqual([l[2].restartAfter, l[2].align, l[2].follow], [0, 'right', 'nothing']);
  await assert.rejects(q.t.bridge('list.define', {}), /levels/);
  // Changing a list in place: every paragraph of it follows.
  await q.exec('list.define', {num, levels: [{format: 'upperRoman', text: '%1.'}], apply: false});
  assert.equal(q.labels()[0], 'I.');
  q.sel(0, 0);
  assert.equal((await q.exec('list.get')).result.num, num, 'the caret\'s list');
});

test('a level linked to a style numbers every paragraph in that style', async () => {
  const q = await quill('Intro\nBody');
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Heading 1'});
  q.sel(1, 0);
  await q.exec('list.define', {levels: [{style: 'Heading1', text: '%1.'}], apply: false});
  assert.ok(getStyle(q.t.content.styles, 'Heading1').para.numbering);
  assert.deepEqual(q.labels(), ['1.', null]);
});

test('the Multilevel List library numbers headings through their styles, in one undo step', async () => {
  const q = await quill('One\nTwo\nBody');
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Heading 1'});
  q.sel(1, 0);
  await q.exec('para.style', {style: 'Heading 2'});
  q.sel([0, 0], [1, 3]);
  await expectUndoRoundTrip(q.t, 'list.multilevelPreset', {preset: 'headings'}, after => {
    assert.equal(getStyle(after.content.styles, 'Heading2').para.numbering.level, 1);
  });
  assert.deepEqual(q.labels(), ['1', '1.1', null]);
  await assert.rejects(q.t.bridge('list.multilevelPreset', {preset: 'nope'}), /must be one of/);
});

test('Set Numbering Value starts a new instance at the value; Restart at 1 is its sibling', async () => {
  const q = await quill('a\nb\nc');
  q.sel([0, 0], [2, 1]);
  await q.exec('para.numbering');
  q.sel(1, 0);
  await expectUndoRoundTrip(q.t, 'para.setNumberingValue', {value: 7}, () => {});
  assert.deepEqual(q.labels(), ['1.', '7.', '8.']);
  const r = await quill('plain');
  r.sel(0, 0);
  assert.deepEqual(r.state('para.setNumberingValue'), {enabled: false, reason: 'not in a numbered list'});
});

test('Define New Bullet and Define New Number Format make the list the dialogs describe', async () => {
  const q = await quill('a\nb');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.defineBullet', {char: '★'}, () => {});
  assert.equal(q.labels()[0], '★');
  await assert.rejects(q.t.bridge('para.defineBullet', {char: 'ab'}), /one character/);
  q.sel(1, 0);
  await q.exec('para.defineNumber', {format: 'upperRoman', text: '(%1)', start: 4});
  assert.equal(q.labels()[1], '(IV)');
  assert.equal(q.props(1).style, 'ListParagraph');
});
