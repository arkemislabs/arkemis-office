// Ports of the upstream Rust tests for character formatting (Home › Font):
// wordcraft crates/engine/src/cmd/format.rs `mod tests` and crates/engine/src/tests.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test it ports.
//
// Behaviour fidelity: (1) these are upstream's own assertions; (2) the setup that upstream does
// by typing (`text.insert`, `select.text`) builds the same paragraphs directly and selects by
// UTF-16 offsets (upstream: UTF-8 bytes), the assertions are unchanged; (3) passing here is the
// parity evidence for core/quill/commands/format.mjs. Parts that need the DOCX writer
// (border_toggles_and_saves' save, underline colour's round trip) are left to the docx unit.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from '../format-fixture.mjs';
import {convertCase} from '../../../core/quill/commands/format.mjs';
import * as P from '../../../core/quill/model/para.mjs';

const charProps = (q, n, off) => P.propsOfChar(q.para(n), off);

test('format.rs case_conversions', () => {
  assert.equal(convertCase('hello world. again', 'sentence', true), 'Hello world. Again');
  assert.equal(convertCase('hello WORLD', 'title', true), 'Hello World');
  assert.equal(convertCase('Hello', 'toggle', true), 'hELLO');
  assert.equal(convertCase('straße', 'upper', true), 'STRASSE');
  assert.equal(convertCase('hello world', 'title', false), 'Hello World');
  assert.equal(convertCase('ΣΟΦΟΣ ΟΔΟΣ', 'lower', true), 'σοφος οδος');
});

test('format.rs sentence_case_ignores_decimal_points (#3485)', () => {
  assert.equal(convertCase('one 3.14 apples and two 2.5 pears.', 'sentence', true), 'One 3.14 apples and two 2.5 pears.');
  assert.equal(convertCase('pi is 3.14. next sentence.', 'sentence', true), 'Pi is 3.14. Next sentence.');
});

test('tests.rs bold_toggles_selection_and_caret_word', async () => {
  const q = await quill('make this bold');
  q.sel(0, 5, 9);
  await q.exec('format.bold');
  assert.equal(charProps(q, 0, 5).bold, true);
  assert.equal(charProps(q, 0, 0).bold, undefined);
  await q.exec('format.bold');
  assert.equal(charProps(q, 0, 5).bold, false);
  // Caret inside a word formats the word.
  q.sel(0, 11);
  await q.exec('format.italic');
  assert.equal(charProps(q, 0, 10).italic, true);
  assert.equal(charProps(q, 0, 13).italic, true);
  assert.equal(charProps(q, 0, 9).italic, undefined);
});

test('tests.rs border_toggles_and_saves (without the DOCX save)', async () => {
  const q = await quill('make this boxed');
  const border = () => charProps(q, 0, 5).border;
  q.sel(0, 5, 9);
  await q.exec('format.border');
  assert.deepEqual(border(), {style: 'single', width: 0.5, color: null, space: 0});
  assert.equal(charProps(q, 0, 0).border, undefined);
  await q.exec('format.border');
  assert.equal(border(), undefined);
  await q.exec('format.border', {value: true});
  await q.exec('format.border', {value: true});
  assert.deepEqual(border(), {style: 'single', width: 0.5, color: null, space: 0});
  await q.exec('format.border', {value: false});
  assert.equal(border(), undefined);
});

test('tests.rs reset_shortcuts_remove_direct_formatting_but_keep_styles', async () => {
  const q = await quill('Hello world');
  q.sel(0, 11);
  await q.exec('para.heading1');
  await q.exec('para.indent');
  await q.exec('para.alignCenter');
  await q.exec('para.reset');
  assert.equal(q.props(0).style, 'Heading1', 'Ctrl+Q keeps the paragraph style');
  assert.deepEqual([q.props(0).indentLeft, q.props(0).align], [undefined, undefined], 'Ctrl+Q drops direct paragraph formatting');
  q.sel(0, 0, 11);
  await q.exec('format.bold');
  await q.exec('format.resetChar');
  assert.equal(charProps(q, 0, 1).bold, undefined, 'Ctrl+Space drops direct character formatting');
  assert.equal(q.props(0).style, 'Heading1', 'Ctrl+Space leaves the paragraph alone');
});

test('tests.rs change_case_keeps_the_selection_when_lengths_change (#420)', async () => {
  const q = await quill('aİxZ');
  q.sel(0, 1, 3);
  await q.exec('format.changeCase', {mode: 'lower'});
  assert.equal(q.texts()[0], 'ai̇xZ');
  const [a, f] = [q.t.doc.selection.ranges[0].anchor, q.t.doc.selection.ranges[0].focus];
  assert.match(a, /t:1$/);
  assert.match(f, /t:4$/, 'the selection still covers i̇x');
  const r = await quill('ıxZ');
  r.sel(0, 0, 2);
  await r.exec('format.changeCase', {mode: 'upper'});
  assert.equal(r.texts()[0], 'IXZ');
  assert.match(r.t.doc.selection.ranges[0].focus, /t:2$/, 'the trailing Z stays out of the selection');
});

test('tests.rs change_case_keeps_each_runs_formatting_when_lengths_change (#421)', async () => {
  const q = await quill('İx');
  q.sel(0, 1, 2);
  await q.exec('format.bold', {value: true});
  q.sel(0, 0, 2);
  await q.exec('format.changeCase', {mode: 'lower'});
  assert.equal(q.texts()[0], 'i̇x');
  assert.notEqual(charProps(q, 0, 0).bold, true);
  assert.notEqual(charProps(q, 0, 1).bold, true);
  assert.equal(charProps(q, 0, 2).bold, true);
});

test('tests.rs change_case_sentence_ignores_decimal_points (#3485)', async () => {
  const q = await quill('one 3.14 apples and two 2.5 pears.');
  q.sel(0, 0, 34);
  await q.exec('format.changeCase', {mode: 'sentence'});
  assert.equal(q.texts()[0], 'One 3.14 apples and two 2.5 pears.');
});

test('tests.rs format_state_reports_kerning_for_fonts', async () => {
  const q = await quill('Kerned plain');
  q.sel(0, 0, 12);
  await q.exec('format.set', {props: {kern: 14}});
  assert.equal((await q.exec('format.state')).result.kern, 14);
  await q.exec('format.set', {props: {kern: 0}});
  assert.equal((await q.exec('format.state')).result.kern, 0);
  q.sel(0, 0, 6);
  await q.exec('format.set', {props: {kern: 12}});
  q.sel(0, 0, 12);
  assert.equal((await q.exec('format.state')).result.kern, null);
});

test('tests.rs colour_commands_take_any_custom_hex (#606)', async () => {
  const q = await quill('Custom');
  q.sel(0, 0, 6);
  for (const [given, want] of [['7A3EC8', '7A3EC8'], ['#0b5d1e', '0B5D1E'], ['  ff8800 ', 'FF8800']]) {
    await q.exec('format.color', {color: given});
    assert.equal((await q.exec('format.state')).result.color, want);
  }
  const doc = structuredClone(q.t.content);
  for (const junk of ['#12', 'purple', 'GG0000', 12, null, 'ééé']) {
    await assert.rejects(q.t.bridge('format.color', {color: junk}), undefined, String(junk));
  }
  assert.deepEqual(q.t.content, doc);
  await q.exec('format.color', {color: 'auto'});
  assert.equal((await q.exec('format.state')).result.color, 'auto');
  await q.exec('para.shading', {color: '#C0FFEE'});
  assert.deepEqual(q.props(0).shading, [0xc0, 0xff, 0xee]);
});

test('tests.rs underline_color_sets_and_clears_the_underlines_own_colour (#2738, without the DOCX round trip)', async () => {
  const q = await quill('Lanterns');
  q.sel(0, 0, 8);
  await q.exec('format.underline', {style: 'wave'});
  const state = async () => (await q.exec('format.state')).result.underlineColor;
  assert.equal(await state(), 'auto');
  const style = () => q.para(0).runs[0].props.underline;
  for (const [given, want] of [['C00000', 'C00000'], ['#1b5e20', '1B5E20']]) {
    await q.exec('format.underlineColor', {color: given});
    assert.equal(await state(), want);
    assert.equal(style(), 'wave', 'the style is kept');
  }
  await q.t.undo();
  assert.equal(await state(), 'C00000');
  await q.exec('format.underlineColor', {color: 'auto'});
  assert.equal(await state(), 'auto');
  assert.equal(style(), 'wave');
  const doc = structuredClone(q.t.content);
  for (const junk of [{}, {color: 'purple'}, {color: 12}, {color: null}, {color: '#12'}]) {
    await assert.rejects(q.t.bridge('format.underlineColor', junk), undefined, JSON.stringify(junk));
  }
  assert.deepEqual(q.t.content, doc);
});

test('tests.rs enclose_characters_make_an_eq_field_and_come_back_out (without the DOCX round trip)', async () => {
  const q = await quill('No 12 and 字 here');
  const fields = () => P.objectsOf(q.para(0)).filter(o => o.type === 'field').map(o => [o.instr, o.result]);
  q.sel(0, 0, 5);
  await assert.rejects(q.t.bridge('format.enclose', {shape: 'circle'}), /full-width/, 'five characters don\'t fit');
  q.sel(0, 10, 11);
  await assert.rejects(q.t.bridge('format.enclose', {}), /shape/, 'a script must say which shape');
  await q.exec('format.enclose', {shape: 'circle'});
  assert.deepEqual(fields(), [['eq \\o\\ac(○,字)', '字']]);
  assert.equal(P.plainText(q.para(0)), 'No 12 and 字 here', 'the field\'s text reads as the character');
  q.sel(0, 3, 5);
  await q.exec('format.enclose', {shape: 'diamond', style: 'enlarge'});
  assert.deepEqual(fields().map(f => f[0]), ['eq \\o\\ac(◇,12) \\* enlarge', 'eq \\o\\ac(○,字)']);
  // Change the shape of the enclosed characters at the caret, then remove it.
  const e = q.para(0).text.indexOf('￼');
  q.sel(0, e + 1);
  await q.exec('format.enclose', {shape: 'square'});
  assert.ok(fields()[0][0].startsWith('eq \\o\\ac(□,12) \\* enlarge'), 'the style stays');
  await q.exec('format.enclose', {shape: null});
  assert.equal(P.plainText(q.para(0)), 'No 12 and 字 here');
  await q.t.undo();
  await q.t.undo();
  assert.ok(fields()[0][0].startsWith('eq \\o\\ac(◇,12)'));
  await q.t.undo();
  await q.t.undo();
  assert.deepEqual(fields(), [], 'back to plain text');
  await assert.rejects(q.t.bridge('format.enclose', {shape: null}), /no enclosed characters|select/);
  // Text given (the dialog's Text box) goes in at a caret.
  q.sel(0, q.para(0).text.length);
  await assert.rejects(q.t.bridge('format.enclose', {shape: 'triangle', text: 'ABC'}), /half-width/);
  await q.exec('format.enclose', {shape: 'triangle', text: 'A'});
  assert.equal(P.plainText(q.para(0)), 'No 12 and 字 hereA');
  assert.deepEqual(fields().at(-1), ['eq \\o\\ac(△,A)', 'A']);
});

test('tests.rs format_font_sets_the_asian_and_latin_fonts_separately (#505)', async () => {
  const q = await quill('Hello 你好');
  q.sel(0, 0, 8);
  const fonts = () => { const c = charProps(q, 0, 0); return [c.font, c.fontEa]; };
  const before = fonts();
  await q.exec('format.font', {name: 'Georgia', eastAsia: 'SimSun'});
  assert.deepEqual(fonts(), ['Georgia', 'SimSun']);
  assert.equal((await q.exec('format.state')).result.fontEastAsia, 'SimSun');
  // The Asian font alone leaves the Latin font as it is.
  await q.exec('format.font', {eastAsia: 'Noto Sans CJK SC'});
  assert.deepEqual(fonts(), ['Georgia', 'Noto Sans CJK SC']);
  // Each change is one undo step.
  await q.t.undo();
  assert.deepEqual(fonts(), ['Georgia', 'SimSun']);
  await q.t.undo();
  assert.deepEqual(fonts(), before);
  await assert.rejects(q.t.bridge('format.font', {}));
  await assert.rejects(q.t.bridge('format.font', {eastAsia: ' '}));
});
