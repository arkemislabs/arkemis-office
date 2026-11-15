// U:slate/format: Home › Basic Text character formatting on schema-2 notebooks.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `format.*` (sourceRef
//    core/slate-format.mjs) names the commands, and OneNote's Home › Basic Text is the behaviour:
//    Font / Font Size boxes (Calibri 11 by default), Grow / Shrink Font through Office's size list,
//    B / I / U / abc / x₂ / x² toggles (off only when all the selection has it; sub- and superscript
//    exclude each other), Text Highlight Color (yellow; No Color clears), Font Color (Automatic
//    clears), Clear All Formatting (marks off, paragraph back to Normal); a caret in a word formats
//    the word.
// 2. Ours does the same on the page body (ProseMirror marks), one undo entry each, with ribbon
//    state (checked, current font, size, colours) read from the selection.
// 3. Proof: these tests (engine, undo round trips, bridge origin) and
//    tests/e2e/slate/format-home.e2e.mjs (ribbon presses, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {growSize, shrinkSize} from '../../core/slate/commands/format.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const runs = t => t.blocks[0].content.map(r => [r.text, (r.marks ?? []).map(m => (m.attrs ? `${m.type}:${JSON.stringify(Object.fromEntries(Object.entries(m.attrs).filter(([, v]) => v !== null)))}` : m.type)).join(',')]);

test('format.bold / italic / underline / strikethrough toggle on a range: on when any of it lacks the mark, off when all has it', async () => {
  const t = await textSession([{text: 'Hello world', marks: [{type: 'bold', from: 0, to: 2}]}], {selection: p => textSel(p, 'b1', 0, 5)});
  assert.equal(t.state('format.bold').checked, 'mixed');
  await expectUndoRoundTrip(t, 'format.bold', {});
  assert.deepEqual(runs(t), [['Hello', 'bold'], [' world', '']]);
  assert.equal(t.state('format.bold').checked, true);
  await t.exec('format.bold');
  assert.deepEqual(runs(t), [['Hello world', '']]);
  for (const [id, mark] of [['format.italic', 'italic'], ['format.underline', 'underline'], ['format.strikethrough', 'strike']]) {
    await expectUndoRoundTrip(t, id, {});
    assert.deepEqual(runs(t)[0], ['Hello', mark], id);
    await t.exec(id, {value: false});
  }
});

test('a caret inside a word formats the word; a caret between words formats nothing', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 8)});
  const r = await t.exec('format.italic');
  assert.deepEqual(r.result, {changed: 5, value: true});
  assert.deepEqual(runs(t), [['Hello ', ''], ['world', 'italic']]);
  t.select(textSel(t.pageId, 'b1', 5));
  const none = await t.exec('format.bold');
  assert.equal(none.result.changed, 0);
  assert.equal(none.result.reason, 'The caret is not in a word');
});

test('format.subscript and format.superscript exclude each other', async () => {
  const t = await textSession(['H2O'], {selection: p => textSel(p, 'b1', 1, 2)});
  await expectUndoRoundTrip(t, 'format.subscript', {});
  assert.deepEqual(runs(t), [['H', ''], ['2', 'subscript'], ['O', '']]);
  await expectUndoRoundTrip(t, 'format.superscript', {});
  assert.deepEqual(runs(t), [['H', ''], ['2', 'superscript'], ['O', '']]);
  assert.equal(t.state('format.subscript').checked, false);
});

test('format.fontFamily and format.fontSize set the textStyle; the boxes read Calibri 11 by default and blank when mixed', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 0, 11)});
  assert.equal(t.state('format.fontFamily').value, 'Calibri');
  assert.equal(t.state('format.fontSize').value, 11);
  await expectUndoRoundTrip(t, 'format.fontFamily', {family: 'Georgia'});
  t.select(textSel(t.pageId, 'b1', 6, 11));
  await expectUndoRoundTrip(t, 'format.fontSize', {points: 20.3});
  assert.deepEqual(runs(t), [['Hello ', 'textStyle:{"fontFamily":"Georgia"}'], ['world', 'textStyle:{"fontFamily":"Georgia","fontSize":20.5}']]);
  t.select(textSel(t.pageId, 'b1', 0, 11));
  assert.equal(t.state('format.fontSize').value, null);
  assert.equal(t.state('format.fontFamily').value, 'Georgia');
  await assert.rejects(t.bridge('format.fontSize', {points: 2000}), e => e.code === 'invalid_params');
});

test('format.growFont / format.shrinkFont step each run through Office\'s size list', async () => {
  assert.deepEqual([11, 12, 28, 72, 75, 1630, 1638].map(growSize), [12, 14, 36, 80, 80, 1638, 1638]);
  assert.deepEqual([12, 11, 8, 7, 1, 80, 75].map(shrinkSize), [11, 10, 7, 6, 1, 72, 72]);
  const t = await textSession([{text: 'ab', marks: [{type: 'textStyle', attrs: {color: null, fontFamily: null, fontSize: 14}, from: 1, to: 2}]}], {selection: p => textSel(p, 'b1', 0, 2)});
  const r = await expectUndoRoundTrip(t, 'format.growFont', {});
  assert.deepEqual(r.result.sizes, [12, 16]);
  await expectUndoRoundTrip(t, 'format.shrinkFont', {});
  assert.deepEqual(runs(t).map(x => x[1]), ['textStyle:{"fontSize":11}', 'textStyle:{"fontSize":14}']);
});

test('format.highlight (yellow by default, null clears) and format.fontColor ("auto" clears) keep other text styles', async () => {
  const t = await textSession(['Note'], {selection: p => textSel(p, 'b1', 0, 4)});
  await expectUndoRoundTrip(t, 'format.highlight', {});
  assert.equal(t.state('format.highlight').value, '#ffff00');
  await t.exec('format.highlight', {color: '#00FF00'});
  assert.equal(t.state('format.highlight').value, '#00ff00');
  await t.exec('format.highlight', {color: null});
  assert.equal(t.state('format.highlight').value, null);
  await t.exec('format.fontSize', {points: 16});
  await expectUndoRoundTrip(t, 'format.fontColor', {color: '#FF0000'});
  assert.deepEqual(runs(t), [['Note', 'textStyle:{"color":"#ff0000","fontSize":16}']]);
  assert.equal(t.state('format.fontColor').value, '#ff0000');
  await t.exec('format.fontColor', {color: 'auto'});
  assert.deepEqual(runs(t), [['Note', 'textStyle:{"fontSize":16}']]);
});

test('format.clear removes character formatting (links stay) and returns the paragraph to Normal', async () => {
  const t = await textSession([{text: 'Big title', style: 'h1', marks: [{type: 'bold'}, {type: 'link', attrs: {href: 'https://a.example', title: null}, from: 0, to: 3}]}], {selection: p => textSel(p, 'b1', 2)});
  await expectUndoRoundTrip(t, 'format.clear', {});
  assert.equal(t.blocks[0].attrs.style, 'normal');
  assert.deepEqual(runs(t), [['Big', 'link:{"href":"https://a.example"}'], [' title', '']]);
});

test('formatting needs note text: a page tab selection disables it with OneNote\'s reason; over the bridge Bold is "Automation: Bold"', async () => {
  const t = await textSession(['Hello'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  assert.deepEqual(t.state('format.bold'), {enabled: false, reason: 'Click in a note to format text'});
  await assert.rejects(t.exec('format.bold'), e => e.code === 'disabled');
  t.select(textSel(t.pageId, 'b1', 0, 5));
  const r = await t.bridge('format.bold', {});
  assert.equal(r.undoLabel, 'Automation: Bold');
});

test('a selected note container formats everything in it', async () => {
  const t = await textSession(['One', 'Two'], {selection: p => ({ranges: [{anchor: `/pg:${p}/c:c1`, focus: `/pg:${p}/c:c1`}], primary: 0})});
  await t.exec('format.underline');
  assert.deepEqual(t.blocks.map(b => b.content[0].marks?.[0]?.type), ['underline', 'underline']);
});

test('More Colors (dialog.colors): RGB, HSL and Hex stay in step; OK sets the font colour; the honeycomb has 127 colours and 15 greys', async () => {
  const {default: colors, honeycomb, rgbToHsl, hslToRgb} = await import('../../core/slate/dialogs/colors.mjs');
  const t = await textSession(['Note'], {selection: p => textSel(p, 'b1', 0, 4)});
  await t.exec('format.fontColor', {color: '#0070c0'});
  const v = colors.init(t.session.readContext(t.docId));
  assert.deepEqual([v.red, v.green, v.blue, v.hex, v.current], [0, 112, 192, '#0070c0', '#0070c0']);
  assert.deepEqual(colors.derive({...v, hex: '#ff8000'}, ['hex']).red, 255);
  const hsl = colors.derive({...v, red: 255, green: 0, blue: 0}, ['red']);
  assert.deepEqual([hsl.hue, hsl.saturation, hsl.luminance], [0, 255, 128]);
  hslToRgb(...rgbToHsl(18, 200, 77)).forEach((c, i) => assert.ok(Math.abs(c - [18, 200, 77][i]) <= 1));
  assert.equal(colors.validate({...v, red: 300})[0].field, 'red');
  assert.deepEqual(colors.toCommand({...v, hex: '#00B050'}), {command: 'format.fontColor', params: {color: '#00b050'}});
  const comb = honeycomb();
  assert.equal(comb.rows.flat().length, 127);
  assert.deepEqual([comb.greys.length, comb.greys[0], comb.greys[14]], [15, '#ffffff', '#000000']);
});
