// Ports of the upstream Rust tests for the Font, Paragraph and Enclose Characters dialogs:
// wordcraft crates/ui-egui/src/dialogs/tests.rs (paragraph_dialog_*, font_dialog_*) and
// crates/ui-egui/src/tests.rs (enclose_characters_button_opens_the_dialog) at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft: dialogs/font.rs `apply_font` and paragraph.rs `apply_paragraph` send only what the
//    person changed as one format.set / para.set (one undo step); blank (mixed) fields stay as each
//    run or paragraph has them; the Paragraph dialog shows alignment and indents as seen on the
//    page. Word's Font and Paragraph dialogs do the same.
// 2. Ours: core/quill/dialogs/{font,paragraph,enclose}.mjs read the selection the same way and
//    submit through the kernel's dialog path (submitDialog), the path the window and the bridge's
//    ui.dialog.submit use.
// 3. These tests (engine); tests/e2e/quill/format-home.e2e.mjs drives the dialogs in the window.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from '../format-fixture.mjs';
import {submitDialog} from '../../../core/kernel/dialog.mjs';
import font, {previewSize} from '../../../core/quill/dialogs/font.mjs';
import paragraph from '../../../core/quill/dialogs/paragraph.mjs';
import enclose from '../../../core/quill/dialogs/enclose.mjs';
import * as P from '../../../core/quill/model/para.mjs';

const open = (q, d) => d.init(q.t.session.readContext(q.t.docId));
const submit = (q, d, v) => (d.toCommand(v) ? submitDialog(q.t.session, q.t.docId, d, v) : null);
const charAt = (q, n, off) => P.propsAt(q.para(n), off);

/** Three paragraphs, the first centred, indented, 30 pt after, kept with the next, line spacing 6; all selected. */
async function mixedSelection() {
  const q = await quill('One\nTwo\nThree');
  q.sel(0, 0);
  await q.exec('para.set', {props: {align: 'center', indentLeft: 36, spaceAfter: 30, keepNext: true, lineSpacing: {rule: 'multiple', value: 6}}});
  q.sel([0, 0], [2, 5]);
  return q;
}

test('dialogs/tests.rs paragraph_dialog_leaves_what_the_selected_paragraphs_differ_in (#1346)', async () => {
  const q = await mixedSelection();
  const was = [0, 1, 2].map(i => structuredClone(q.props(i)));
  const v = open(q, paragraph);
  for (const f of ['alignment', 'keepNext', 'left', 'lineRule', 'after']) assert.equal(v[f], null, `${f} shows blank`);
  const version = q.t.session.get(q.t.docId).version;
  assert.equal(paragraph.toCommand(v), null, 'an unchanged OK runs nothing');
  assert.equal(q.t.session.get(q.t.docId).version, version, 'nor adds an undo step');
  await submit(q, paragraph, {...v, before: 6});
  assert.equal(q.t.session.get(q.t.docId).version, version + 1, 'one undo step');
  for (let i = 0; i < 3; i++) assert.deepEqual(q.props(i), {...was[i], spaceBefore: 6}, `paragraph ${i}`);
  await q.t.undo();
  assert.deepEqual([0, 1, 2].map(i => q.props(i)), was, 'undo takes all of it back');
});

test('dialogs/tests.rs paragraph_dialog_sets_a_mixed_check_box_for_all', async () => {
  const q = await mixedSelection();
  const v = open(q, paragraph);
  assert.equal(v.lineRule, null, 'line spacing 6 stays blank');
  assert.equal(v.keepNext, null, 'neither on nor off');
  assert.equal(v.keepLines, false, 'shared');
  await submit(q, paragraph, {...v, keepNext: true});
  assert.deepEqual([0, 1, 2].map(i => q.props(i).keepNext), [true, true, true]);
  assert.deepEqual([0, 1, 2].map(i => q.props(i).align), ['center', undefined, undefined], 'alignment untouched');
  assert.deepEqual([0, 1, 2].map(i => q.props(i).spaceAfter), [30, undefined, undefined], 'spacing untouched');
  assert.deepEqual(q.props(0).lineSpacing, {rule: 'multiple', value: 6}, 'line spacing untouched');
});

test('dialogs/tests.rs paragraph_dialog_sets_only_the_options_that_changed (#512)', async () => {
  const q = await quill('Hello');
  q.sel(0, 0);
  const v = open(q, paragraph);
  assert.equal(paragraph.toCommand(v), null);
  await submit(q, paragraph, {...v, mirrorIndents: true, contextualSpacing: true, suppressLineNumbers: true, suppressHyphens: true});
  const p = q.props(0);
  assert.deepEqual([p.mirrorIndents, p.contextualSpacing, p.suppressLineNumbers, p.suppressHyphens], [true, true, true, true]);
  const v2 = open(q, paragraph);
  assert.deepEqual([v2.mirrorIndents, v2.contextualSpacing, v2.suppressLineNumbers, v2.suppressHyphens], [true, true, true, true], 'the dialog shows what is set');
  await submit(q, paragraph, {...v2, suppressHyphens: false});
  assert.equal(q.props(0).suppressHyphens, false);
  assert.equal(q.props(0).mirrorIndents, true);
});

test('dialogs/tests.rs paragraph_dialog_shows_direction_and_visual_alignment', async () => {
  const q = await quill('سلام دنیا');
  q.sel(0, 0);
  await q.exec('para.rtl');
  await q.exec('para.set', {props: {indentLeft: 36}});
  const v = open(q, paragraph);
  assert.equal(v.direction, 'rtl');
  assert.equal(v.alignment, 'right', 'a start-aligned right-to-left paragraph shows as right aligned');
  assert.deepEqual([v.left, v.right], [0, 0.5], 'the start indent is the right one');
});

test('dialogs/tests.rs paragraph_dialog_ok_keeps_what_it_shows', async () => {
  for (const [rtl, align] of [[false, 'para.alignCenter'], [false, 'para.alignRight'], [true, 'para.alignLeft'], [true, 'para.alignRight']]) {
    const q = await quill('متن');
    q.sel(0, 0);
    await q.exec(rtl ? 'para.rtl' : 'para.ltr');
    await q.exec(align);
    await q.exec('para.set', {props: {indentLeft: 18, indentRight: 9}});
    const before = structuredClone(q.props(0));
    const v = open(q, paragraph);
    await submit(q, paragraph, v);
    const after = q.props(0);
    assert.deepEqual([after.bidi, after.align], [before.bidi, before.align], `${align} rtl=${rtl}`);
    assert.deepEqual([after.indentLeft, after.indentRight], [18, 9], `${align} rtl=${rtl}`);
  }
});

test('dialogs/tests.rs paragraph_dialog_keeps_fixed_line_spacing (#467)', async () => {
  for (const [cmd, rule] of [[{exactly: 24}, {rule: 'exactly', value: 24}], [{atLeast: 24}, {rule: 'atLeast', value: 24}]]) {
    const q = await quill('Example');
    q.sel(0, 0);
    await q.exec('para.lineSpacing', cmd);
    await submit(q, paragraph, open(q, paragraph));
    assert.deepEqual(q.props(0).lineSpacing, rule, `unchanged OK, ${JSON.stringify(cmd)}`);
    await submit(q, paragraph, {...open(q, paragraph), keepNext: true});
    assert.deepEqual([q.props(0).lineSpacing, q.props(0).keepNext], [rule, true]);
  }
  const q = await quill('Example');
  q.sel(0, 0);
  await q.exec('para.lineSpacing', {exactly: 24});
  const v = open(q, paragraph);
  const changed = {...v, lineRule: 'multiple', ...paragraph.derive({...v, lineRule: 'multiple'}, ['lineRule'])};
  await submit(q, paragraph, {...changed, lineAt: 1.5});
  assert.deepEqual(q.props(0).lineSpacing, {rule: 'multiple', value: 1.5}, 'a changed value still sets a multiple');
});

test('dialogs/tests.rs paragraph_dialog_changes_direction', async () => {
  const q = await quill('Hello');
  q.sel(0, 0);
  const v = open(q, paragraph);
  await submit(q, paragraph, {...v, direction: 'rtl', alignment: 'right', right: v.right + 1});
  let p = q.props(0);
  assert.equal(p.bidi, true);
  assert.equal(p.align, 'left', 'right on the page is the start edge');
  assert.equal(p.indentLeft, 72, 'the right indent is the start indent');
  await submit(q, paragraph, {...open(q, paragraph), direction: 'ltr'});
  p = q.props(0);
  assert.deepEqual([p.bidi, p.align, p.indentLeft ?? 0, p.indentRight], [false, 'right', 0, 72], 'a new direction alone keeps what the dialog shows');
});

test('dialogs/tests.rs font_dialog_sets_the_asian_and_latin_fonts_separately (#505)', async () => {
  const q = await quill('Hello 你好');
  q.sel(0, 0, 8);
  const fonts = () => [charAt(q, 0, 0).font, charAt(q, 0, 0).fontEa];
  const latin = fonts()[0];
  let v = open(q, font);
  assert.equal(v.asian, true, 'Chinese text in the selection shows the Asian text font box');
  await submit(q, font, {...v, fontEastAsia: 'SimSun'});
  assert.deepEqual(fonts(), [latin, 'SimSun']);
  v = open(q, font);
  assert.equal(v.fontEastAsia, 'SimSun');
  await submit(q, font, {...v, font: 'Georgia'});
  assert.deepEqual(fonts(), ['Georgia', 'SimSun']);
  await q.t.undo();
  assert.equal(fonts()[1], 'SimSun');
  assert.notEqual(fonts()[0], 'Georgia', 'one undo step each');
});

test('dialogs/tests.rs font_dialog_preview_ignores_a_size_that_is_not_a_number (#3663)', () => {
  for (const [typed, pt] of [['NaN', 12], ['nan', 12], ['inf', 12], ['-infinity', 12], ['10.5', 10.5], ['200', 72], ['', 12]]) assert.equal(previewSize(typed), pt, typed);
  const errors = font.validate({size: 'NaN'});
  assert.ok(errors.some(e => e.field === 'size'), 'OK refuses it with a message instead of closing');
});

test('dialogs/tests.rs font_dialog_ok_keeps_what_the_user_left_alone (#466)', async () => {
  const q = await quill('Example');
  q.sel(0, 0, 7);
  await q.exec('format.set', {props: {smallCaps: true, caps: true, hidden: true, spacing: 2, underline: 'double'}});
  let v = open(q, font);
  assert.equal(v.smallCaps, true, 'the dialog shows small caps');
  assert.deepEqual([v.spacingType, v.spacingBy], ['expanded', 2]);
  await submit(q, font, {...v, size: '14'});
  let c = charAt(q, 0, 0);
  assert.equal(c.size, 14);
  assert.deepEqual([c.smallCaps, c.caps, c.hidden, c.spacing, c.underline], [true, true, true, 2, 'double']);
  v = open(q, font);
  await submit(q, font, {...v, smallCaps: false});
  c = charAt(q, 0, 0);
  assert.deepEqual([c.smallCaps, c.caps, c.size], [false, true, 14]);
});

test('dialogs/tests.rs font_dialog_sets_kerning_for_fonts', async () => {
  const q = await quill('Kerned plain');
  q.sel(0, 0, 12);
  await q.exec('format.set', {props: {kern: 0}});
  const kern = off => charAt(q, 0, off).kern;
  let v = open(q, font);
  assert.deepEqual([v.kerning, v.kerningAt], [false, 12], 'off, offering 12 pt');
  await submit(q, font, {...v, kerning: true, kerningAt: 16});
  assert.deepEqual([kern(0), kern(7)], [16, 16]);
  await q.t.undo();
  assert.equal(kern(0), 0, 'one undo step');
  await q.t.redo();
  v = open(q, font);
  assert.deepEqual([v.kerning, v.kerningAt], [true, 16]);
  await submit(q, font, {...v, kerning: false});
  assert.deepEqual([kern(0), kern(7)], [0, 0]);
  q.sel(0, 0, 6);
  await q.exec('format.set', {props: {kern: 14}});
  q.sel(0, 0, 12);
  v = open(q, font);
  assert.equal(v.kerning, null, 'mixed kerning shows neither on nor off');
  await submit(q, font, {...v, size: '13'});
  assert.deepEqual([kern(0), kern(7)], [14, 0], 'each run keeps its kerning');
});

test('tests.rs enclose_characters_button_opens_the_dialog (#297)', async () => {
  const q = await quill('a 字 b');
  q.sel(0, 2, 3);
  let v = open(q, enclose);
  assert.deepEqual([v.style, v.text, v.enclosure], ['shrink', '字', 'circle']);
  await submit(q, enclose, {...v, enclosure: 'square', style: 'enlarge'});
  // The enclosed character is now one field object; select it and reopen.
  q.sel(0, 2, 3);
  v = open(q, enclose);
  assert.deepEqual([v.style, v.enclosure, v.text], ['enlarge', 'square', '字'], 'it reopens showing the enclosure');
  await submit(q, enclose, {...v, style: 'none'});
  assert.equal(q.texts()[0], 'a 字 b', 'None takes the enclosure off');
});

