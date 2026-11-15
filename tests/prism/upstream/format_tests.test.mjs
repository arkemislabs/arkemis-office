// Ported from deckcraft crates/engine/src/cmd/format.rs `mod tests`, crates/engine/src/cmd/ruler_tests.rs
// and the format tests of crates/engine/src/tests.rs (text_transform_sets_and_clears_a_warp,
// insert_shape_and_format, text_transparency_keeps_the_colour_and_sets_alpha,
// numbering_takes_color_and_size, format_language_marks_the_selected_text,
// language_all_marks_every_text_in_the_deck_with_nothing_selected, change_case_spans_formatting_runs)
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. Each test names its Rust original. deckcraft's
// `UiRequest::Dialog {id, params}` is our `{dialog, params}` result. Spell-check assertions of the
// language tests belong to U:prism/review and are left out.
//
// 1. What ArtCraft does: Home › Font / Paragraph commands format the edited text (a bare caret: its
//    word) or the selected shapes' text, each one undo step labelled with the command; the Font,
//    Paragraph, Tabs and Columns commands with no fields ask the UI to open their dialog with the
//    selection's values and edit nothing; bad fields are refused without editing. PowerPoint does
//    the same from its Font group, Paragraph group and dialogs.
// 2. Ours: the same commands on schema-2 decks through the kernel; the dialog request is a result.
// 3. Proved here; dialogs in tests/prism/format.test.mjs, ribbon flow in tests/e2e/prism/format-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createContent} from '../../../core/prism/schema.mjs';
import {findShape} from '../../../core/prism/model/presentation.mjs';
import {selectText, selectShapes} from '../../../core/prism/model/doc.mjs';
import {bodyText, posOf, offsetOf} from '../../../core/prism/model/text.mjs';

async function session() {
  const c = createContent('Format');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides.push({...structuredClone(c.slides[0]), id: 'b1', layout, shapes: []});
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:b1', focus: '/sl:b1'}], primary: 0}});
}
/** `shape()`: a blank slide with a rectangle "Hello" (shape.insert), selected. */
async function shapeSession(text = 'Hello', rect = [40, 40, 240, 80]) {
  const t = await session();
  const r = await t.exec('shape.insert', {preset: 'rect', rect, text});
  return {t, id: r.result.id};
}
const slideOf = t => t.content.slides.find(s => s.id === 'b1');
const sh = (t, id) => findShape(slideOf(t).shapes, id);
const firstRun = (t, id) => sh(t, id).text.paragraphs[0].runs[0].props ?? {};
const firstPara = (t, id) => sh(t, id).text.paragraphs[0].props ?? {};
const bodyProps = (t, id) => sh(t, id).text?.body ?? {};
const undos = t => t.doc.undo.size;
const lastLabel = t => t.doc.undo.labels()[0];
/** text.edit + text.select {anchor, caret} as positions. */
function selectIn(t, id, a, b) {
  const body = sh(t, id).text;
  t.session.setSelection(t.docId, selectText('b1', [id], offsetOf(body, a), offsetOf(body, b)));
}

test('format.rs font_dialog_applies_character_formatting_in_one_undo', async () => {
  const {t, id} = await shapeSession();
  const before = undos(t);
  await t.exec('format.fontDialog', {family: 'Liberation Serif', size: 28, bold: true, italic: false, underline: 'wavy', color: '#112233', strike: 'dbl',
    baseline: 'super', caps: 'small', spacing: 3});
  assert.equal(undos(t), before + 1);
  assert.equal(lastLabel(t), 'Font…');
  const r = firstRun(t, id);
  assert.equal(r.font, 'Liberation Serif');
  assert.equal(r.size, 28);
  assert.equal(r.bold, true);
  assert.equal(r.italic, false);
  assert.equal(r.underline, 'wavy');
  assert.equal(r.fill.kind, 'solid');
  assert.equal(r.fill.color.base.kind, 'rgb');
  assert.equal(r.strike, 'double');
  assert.equal(r.baseline, 0.3);
  assert.equal(r.caps, 'small');
  assert.equal(r.spacing, 3);
  await t.undo();
  const u = firstRun(t, id);
  assert.ok(u.font == null && u.size == null && u.bold == null && u.underline == null && u.fill == null && u.strike == null && u.caps == null);
});

test('format.rs font_dialog_changes_only_the_fields_it_is_given', async () => {
  const {t, id} = await shapeSession();
  await t.exec('format.bold', {on: true});
  await t.exec('format.fontDialog', {size: 22, color: {scheme: 'accent2', lumMod: 50000}});
  const r = firstRun(t, id);
  assert.equal(r.bold, true);
  assert.equal(r.size, 22);
  assert.ok(r.font == null && r.italic == null);
  assert.equal(r.fill.color.base.slot, 'accent2');
  assert.ok(r.fill.color.mods.some(m => m.op === 'lumMod'));
  await t.undo();
  const u = firstRun(t, id);
  assert.equal(u.bold, true);
  assert.ok(u.size == null && u.fill == null);
});

test('format.rs font_dialog_with_no_fields_asks_the_ui_to_open', async () => {
  const {t} = await shapeSession();
  await t.exec('format.italic', {on: true});
  const v = t.version, n = undos(t);
  const r = await t.exec('format.fontDialog', {});
  assert.equal(t.version, v);
  assert.equal(undos(t), n);
  assert.equal(r.result.dialog, 'dialog.font');
  assert.equal(r.result.params.italic, true);
  assert.equal(r.result.params.bold, false);
  assert.ok(r.result.params.family.length > 0);
  assert.ok(r.result.params.size > 0);
});

test('format.rs font_dialog_rejects_bad_fields_without_editing', async () => {
  const {t, id} = await shapeSession();
  const n = undos(t);
  await assert.rejects(t.exec('format.fontDialog', {underline: 'sparkle'}), /underline/);
  await assert.rejects(t.exec('format.fontDialog', {size: 'large'}));
  await assert.rejects(t.exec('format.fontDialog', {bold: 1}));
  await assert.rejects(t.exec('format.fontDialog', {family: '  '}));
  await assert.rejects(t.exec('format.fontDialog', {color: 'not-a-color'}));
  assert.equal(undos(t), n);
  assert.equal(firstRun(t, id).underline, undefined);
  await t.exec('edit.deselect', {});
  await t.exec('edit.deselect', {});
  await assert.rejects(t.exec('format.fontDialog', {bold: true}));
});

test('format.rs paragraph_dialog_applies_alignment_indent_and_spacing_in_one_undo', async () => {
  const {t, id} = await shapeSession();
  const before = undos(t);
  await t.exec('format.paragraphDialog', {align: 'justify', indentLeft: 36, indentRight: 18, special: 'hanging', specialBy: 18, spaceBefore: 6, spaceAfter: 8,
    lineSpacing: 1.5});
  assert.equal(undos(t), before + 1);
  assert.equal(lastLabel(t), 'Paragraph…');
  const p = firstPara(t, id);
  assert.equal(p.align, 'justify');
  assert.equal(p.marginLeft, 36);
  assert.equal(p.marginRight, 18);
  assert.equal(p.indent, -18);
  assert.deepEqual(p.spaceBefore, {kind: 'pts', v: 6});
  assert.deepEqual(p.spaceAfter, {kind: 'pts', v: 8});
  assert.deepEqual(p.lineSpacing, {kind: 'pct', v: 1.5});
  await t.undo();
  const u = firstPara(t, id);
  assert.equal(u.align, 'center', 'undo restores the alignment shape.insert wrote');
  assert.ok(u.marginLeft == null && u.indent == null && u.spaceBefore == null && u.lineSpacing == null);
});

test('format.rs paragraph_dialog_first_line_and_exact_spacing_replace_only_those_fields', async () => {
  const {t, id} = await shapeSession();
  await t.exec('format.paragraphDialog', {align: 'right'});
  await t.exec('format.paragraphDialog', {special: 'first', specialBy: 27, lineSpacingPt: 20});
  const p = firstPara(t, id);
  assert.equal(p.align, 'right');
  assert.equal(p.indent, 27);
  assert.deepEqual(p.lineSpacing, {kind: 'pts', v: 20});
  assert.equal(p.marginLeft, undefined);
  await t.undo();
  assert.equal(firstPara(t, id).align, 'right');
  assert.equal(firstPara(t, id).indent, undefined);
});

test('format.rs paragraph_dialog_with_no_fields_asks_the_ui_to_open', async () => {
  const {t} = await shapeSession();
  const v = t.version, n = undos(t);
  const r = await t.exec('format.paragraphDialog', {});
  assert.equal(t.version, v);
  assert.equal(undos(t), n);
  assert.equal(r.result.dialog, 'dialog.paragraph');
  assert.equal(r.result.params.align, 'center', 'a new shape\'s text is centred');
  assert.equal(r.result.params.special, 'none');
  assert.equal(r.result.params.lineKind, 'multiple');
  assert.ok(r.result.params.lineValue > 0);
});

test('format.rs paragraph_dialog_rejects_bad_fields_without_editing', async () => {
  const {t, id} = await shapeSession();
  const n = undos(t);
  await assert.rejects(t.exec('format.paragraphDialog', {align: 'sparkle'}), /align/);
  await assert.rejects(t.exec('format.paragraphDialog', {special: 'middle'}));
  await assert.rejects(t.exec('format.paragraphDialog', {indentLeft: 'wide'}));
  await assert.rejects(t.exec('format.paragraphDialog', {lineSpacing: 'double'}));
  await assert.rejects(t.exec('format.paragraphDialog', {spaceBeforeKind: 'lines', spaceBefore: 4}));
  assert.equal(undos(t), n);
  assert.equal(firstPara(t, id).align, 'center');
  assert.equal(firstPara(t, id).indent, undefined);
});

test('format.rs columns_set_the_number_and_spacing_and_a_left_out_key_keeps_its_value', async () => {
  const {t, id} = await shapeSession();
  const n = undos(t);
  await t.exec('format.columns', {count: 4, spacing: 36});
  assert.deepEqual([bodyProps(t, id).columns, bodyProps(t, id).colSpacing], [4, 36]);
  assert.equal(undos(t), n + 1, 'one undo step');
  await t.exec('format.columns', {count: 2});
  assert.deepEqual([bodyProps(t, id).columns, bodyProps(t, id).colSpacing], [2, 36], 'the spacing stays');
  await t.exec('format.columns', {spacing: 9});
  assert.deepEqual([bodyProps(t, id).columns, bodyProps(t, id).colSpacing], [2, 9], 'the number stays');
});

test('format.rs columns_with_no_fields_open_the_dialog_with_the_shapes_values', async () => {
  const {t} = await shapeSession();
  await t.exec('format.columns', {count: 3, spacing: 27});
  const v = t.version, n = undos(t);
  const r = await t.exec('format.columns', {});
  assert.equal(t.version, v);
  assert.equal(undos(t), n);
  assert.equal(r.result.dialog, 'dialog.columns');
  assert.deepEqual(r.result.params, {count: 3, spacing: 27});
});

test('format.rs columns_reject_a_bad_number_or_spacing_without_editing', async () => {
  const {t, id} = await shapeSession();
  const n = undos(t);
  for (const p of [{count: 0}, {count: 17}, {count: 2.5}, {count: 'two'}, {spacing: 'wide'}]) {
    await assert.rejects(t.exec('format.columns', p), /format\.columns/, JSON.stringify(p));
  }
  assert.equal(undos(t), n);
  assert.equal(bodyProps(t, id).columns, undefined);
});

test('format.rs tabs_dialog_sets_stops_in_one_undo_and_opens_with_no_fields', async () => {
  const {t, id} = await shapeSession();
  const before = undos(t);
  await t.exec('format.tabs', {set: [{pos: 144, align: 'center'}, {pos: 72, align: 'dec'}, {pos: 72.02, align: 'right'}], defaultTab: 36});
  assert.equal(undos(t), before + 1);
  assert.equal(lastLabel(t), 'Tabs…');
  const p = firstPara(t, id);
  assert.equal(p.tabs.length, 2, 'stops within 0.05 pt collapse');
  assert.equal(p.tabs[0].pos, 72.02);
  assert.equal(p.tabs[0].align, 'r');
  assert.equal(p.tabs[1].align, 'ctr');
  assert.equal(p.defaultTab, 36);
  await t.undo();
  assert.ok(firstPara(t, id).tabs == null && firstPara(t, id).defaultTab == null);
  const n = undos(t);
  const r = await t.exec('format.tabs', {});
  assert.equal(undos(t), n);
  assert.equal(r.result.dialog, 'dialog.tabs');
  assert.deepEqual(r.result.params.tabs, []);
  await assert.rejects(t.exec('format.tabs', {set: [{pos: 10, align: 'sparkle'}]}));
  await assert.rejects(t.exec('format.tabs', {set: 'nope'}));
  assert.equal(undos(t), n);
});

/** ruler_tests.rs `editing()`: a text box at [100, 50, 400, 40] holding "a\tb", being edited. */
async function editing() {
  const t = await session();
  const id = (await t.exec('insert.textBox', {rect: [100, 50, 400, 40]})).result.id;
  await t.exec('text.insert', {text: 'a\tb'});
  return {t, id};
}

test('ruler_tests.rs ruler_reports_the_text_area_and_indents', async () => {
  const {t} = await editing();
  let r = (await t.exec('format.ruler', {})).result;
  assert.ok(Math.abs(r.x - 107.2) < 0.01, JSON.stringify(r));
  assert.equal(r.rotated, false);
  assert.equal(r.tabs.length, 0);
  await t.exec('format.paragraph', {indentLeft: 36, indentFirst: -18});
  r = (await t.exec('format.ruler', {})).result;
  assert.deepEqual([r.marginLeft, r.indent], [36, -18]);
  await t.exec('text.exit', {});
  await assert.rejects(t.exec('format.ruler', {}), 'only while editing text');
});

test('ruler_tests.rs tabs_add_move_remove_clear_and_undo', async () => {
  const {t} = await editing();
  const tabs = async () => (await t.exec('format.ruler', {})).result.tabs.map(x => [x.pos, x.align]);
  await t.exec('format.tabs', {add: {pos: 144, align: 'center'}});
  await t.exec('format.tabs', {add: {pos: 72}});
  assert.deepEqual(await tabs(), [[72, 'l'], [144, 'ctr']], 'sorted');
  await t.exec('format.tabs', {add: {pos: 72.2, align: 'r'}});
  assert.deepEqual(await tabs(), [[72.2, 'r'], [144, 'ctr']], 'a stop at the same place is replaced');
  await t.exec('format.tabs', {move: {from: 144, to: 200}});
  await t.exec('format.tabs', {remove: 72.2});
  assert.deepEqual(await tabs(), [[200, 'ctr']]);
  await t.undo();
  assert.equal((await tabs()).length, 2);
  await t.exec('format.tabs', {clear: true});
  assert.deepEqual(await tabs(), []);
  const r = await t.exec('format.tabs', {});
  assert.equal(r.result.dialog, 'dialog.tabs', 'no fields opens the Tabs dialog');
  await t.exec('format.tabs', {add: {pos: Number.MAX_VALUE}});
  for (let i = 0; i < 100; i++) await t.exec('format.tabs', {add: {pos: i * 3}});
  assert.ok((await tabs()).length <= 32);
  await t.exec('format.tabs', {set: [{pos: 90, align: 'dec'}, {pos: 30, align: 'right'}, {pos: 'x'}], defaultTab: 36});
  assert.deepEqual(await tabs(), [[30, 'r'], [90, 'dec']], 'set replaces all, sorted, bad entries dropped');
  assert.equal((await t.exec('format.ruler', {})).result.defaultTab, 36);
});

test('tests.rs text_transform_sets_and_clears_a_warp', async () => {
  const {t, id} = await shapeSession('ARCH', [80, 80, 420, 160]);
  await assert.rejects(t.exec('format.textWarp', {}));
  await assert.rejects(t.exec('format.textWarp', {preset: 'notAWarp'}));
  await assert.rejects(t.exec('format.textWarp', {preset: 'textArchUp', adj: 'wide'}));
  await assert.rejects(t.exec('format.textWarp', {preset: 'textArchUp', adj: [1, 2, 3, 4, 5, 6, 7, 8, 9]}));
  await assert.rejects(t.exec('format.textWarp', {preset: 'textArchUp', adj: [null]}));
  assert.equal(bodyProps(t, id).warp, undefined);
  await t.exec('format.textWarp', {preset: 'textArchUp'});
  assert.equal(bodyProps(t, id).warp, 'textArchUp');
  assert.equal(bodyProps(t, id).warpAdj, undefined);
  await t.exec('format.textWarp', {preset: 'textInflate', adj: [20000]});
  assert.equal(bodyProps(t, id).warp, 'textInflate');
  assert.deepEqual(bodyProps(t, id).warpAdj, [20000]);
  await t.exec('format.textWarp', {preset: 'none'});
  assert.equal(bodyProps(t, id).warp, undefined);
  await t.undo();
  assert.equal(bodyProps(t, id).warp, 'textInflate');
  t.session.setSelection(t.docId, selectText('b1', [id], 0, 0));
  await t.exec('format.textWarp', {preset: 'textCircle'});
  assert.equal(bodyProps(t, id).warp, 'textCircle');
});

test('tests.rs insert_shape_and_format', async () => {
  const t = await session();
  const id = (await t.exec('shape.insert', {preset: 'roundRect', rect: [100, 100, 200, 100], text: 'Hi'})).result.id;
  await t.exec('shape.fill', {color: '#ff0000'});
  await t.exec('shape.line', {width: 3, color: 'accent2', dash: 'dash'});
  await t.exec('shape.rotate', {deg: 30});
  await t.exec('shape.move', {dx: 10, dy: -5});
  await t.exec('format.bold', {});
  assert.equal(sh(t, id).xfrm.x, 110);
  assert.equal(sh(t, id).xfrm.rot, 30);
  assert.equal(firstRun(t, id).bold, true);
  await t.undo(5);
  assert.equal(sh(t, id).fill, null);
});

test('tests.rs text_transparency_keeps_the_colour_and_sets_alpha', async () => {
  const {t, id} = await shapeSession('Hi', [100, 100, 200, 100]);
  const alpha = c => (c.mods ?? []).reduce((a, m) => (m.op === 'alpha' ? m.val / 100000 : a), 1);
  await t.exec('format.textTransparency', {value: 0.25});
  let f = firstRun(t, id).fill;
  assert.equal(f.kind, 'solid');
  assert.ok(Math.abs(alpha(f.color) - 0.75) < 1e-9);
  await t.exec('format.color', {color: '#C00000'});
  await t.exec('format.textTransparency', {value: 0.6});
  await t.exec('format.textTransparency', {value: 0.5});
  f = firstRun(t, id).fill;
  assert.deepEqual(f.color.base, {kind: 'rgb', rgb: {r: 0xc0, g: 0, b: 0, a: 255}});
  assert.equal(f.color.mods.filter(m => m.op === 'alpha').length, 1);
  assert.ok(Math.abs(alpha(f.color) - 0.5) < 1e-9);
  await t.exec('format.textTransparency', {value: 0});
  assert.ok(!(firstRun(t, id).fill.color.mods ?? []).length, 'opaque drops the alpha');
  await t.undo();
  assert.ok(Math.abs(alpha(firstRun(t, id).fill.color) - 0.5) < 1e-9);
  await assert.rejects(t.exec('format.textTransparency', {}));
});

test('tests.rs numbering_takes_color_and_size', async () => {
  const t = await session();
  const id = (await t.exec('insert.textBox', {rect: [10, 10, 300, 100], text: 'One\nTwo'})).result.id;
  await t.exec('format.numbering', {on: true, scheme: 'romanUcPeriod', start: 3, color: 'accent2', size: 150});
  const pp = firstPara(t, id);
  assert.deepEqual(pp.bullet, {kind: 'autoNum', scheme: 'romanUcPeriod', startAt: 3});
  assert.equal(pp.bulletSize, 1.5);
  assert.deepEqual(pp.bulletColor, {base: {kind: 'scheme', slot: 'accent2'}});
  await t.exec('format.bullets', {on: true, char: '★', size: 9000});
  assert.equal(firstPara(t, id).bulletSize, 4);
});

test('tests.rs format_language_marks_the_selected_text', async () => {
  const {t, id} = await shapeSession('Hola mundo');
  selectIn(t, id, [0, 10], [0, 5]);
  await t.exec('format.language', {lang: 'es-ES'});
  assert.equal((await t.exec('format.state', {})).result.lang, 'es-ES');
  const runs = sh(t, id).text.paragraphs[0].runs.map(r => [r.text, r.props?.lang]);
  assert.deepEqual(runs, [['Hola ', undefined], ['mundo', 'es-ES']]);
  await assert.rejects(t.exec('format.language', {lang: 'en US!'}));
});

test('tests.rs language_all_marks_every_text_in_the_deck_with_nothing_selected', async () => {
  const {t, id} = await shapeSession('hello wurld', [100, 100, 300, 100]);
  await t.exec('format.language', {lang: 'de-DE'});
  await t.exec('insert.table', {rows: 1, cols: 1});
  t.session.setSelection(t.docId, selectShapes('b1', []));
  await t.exec('format.languageAll', {lang: 'xx-AL'});
  const langs = [];
  const walk = list => { for (const s of list) {
    for (const p of s.text?.paragraphs ?? []) for (const r of p.runs) langs.push(r.props?.lang);
    if (s.kind?.type === 'table') for (const row of s.kind.rows) for (const c of row.cells) for (const p of c.text.paragraphs) langs.push(p.endProps?.lang);
  } };
  for (const sl of t.content.slides) walk(sl.shapes);
  assert.ok(langs.length && langs.every(l => l === 'xx-AL'), JSON.stringify(langs));
  assert.equal(t.content.defaultTextStyle.levels[0].run.lang, 'xx-AL');
  assert.ok(t.content.masters.every(m => m.bodyStyle.levels[0].run.lang === 'xx-AL'));
  assert.ok(!sh(t, id).text.listStyle?.levels?.some(Boolean), 'a body without a list style does not get one');
  await t.undo();
  assert.equal(firstRun(t, id).lang, 'de-DE');
  await assert.rejects(t.exec('format.languageAll', {}));
  await assert.rejects(t.exec('format.languageAll', {lang: 'en US!'}));
});

test('tests.rs change_case_spans_formatting_runs', async () => {
  const setup = async (text, boldTo) => {
    const {t, id} = await shapeSession(text, [80, 80, 420, 160]);
    selectIn(t, id, [0, 0], [0, boldTo]);
    await t.exec('format.bold', {on: true});
    return {t, id};
  };
  for (const [mode, input, want] of [['title', 'hello world', 'Hello World'], ['sentence', 'hello world. bye', 'Hello world. Bye']]) {
    let {t, id} = await setup(input, 3);
    selectIn(t, id, [0, 0], [0, input.length]);
    await t.exec('format.case', {mode});
    assert.equal(bodyText(sh(t, id).text), want, `${mode} range`);
    ({t, id} = await setup(input, 3));
    await t.exec('text.exit', {});
    await t.exec('format.case', {mode});
    assert.equal(bodyText(sh(t, id).text), want, `${mode} shape`);
    assert.equal(firstRun(t, id).bold, true);
  }
  const {t, id} = await setup('straße', 4);
  selectIn(t, id, [0, 0], [0, 6]);
  await t.exec('format.case', {mode: 'upper'});
  const body = sh(t, id).text;
  assert.equal(bodyText(body), 'STRASSE');
  assert.equal(body.paragraphs[0].runs[0].text, 'STRA');
  assert.equal(body.paragraphs[0].runs[0].props.bold, true);
});

test('posOf/offsetOf helpers agree (test scaffolding)', () => {
  const b = {paragraphs: [{runs: [{text: 'ab'}]}, {runs: [{text: 'c'}]}]};
  assert.deepEqual(posOf(b, offsetOf(b, [1, 1])), [1, 1]);
});
