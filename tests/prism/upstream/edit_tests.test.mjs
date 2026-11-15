// Ported from deckcraft crates/engine/src/tests.rs (`clipboard_copy_paste_shapes_and_slides`,
// `pasted_shapes_get_the_next_automatic_name`, `pasting_after_a_deleted_shape_does_not_repeat_a_name`,
// `pasting_on_another_slide_keeps_names_so_morph_still_pairs_them` (names part),
// `bold_copy_is_html_and_pages_html_pastes_bold`, `html_paste_with_a_source_newline_keeps_its_bold`,
// `paste_special_keeps_source_look_picture_or_text` (all but Picture), `select_all_slides_scope`,
// `select_all_slides_leaves_shape_select_all_alone`, `select_all_slides_bad_scope_is_an_error`,
// `duplicating_a_moved_copy_repeats_the_move` (without shape.move: the copy is moved in the content),
// `duplicated_and_pasted_slides_retarget_animations_and_triggers`,
// `invalid_ids_array_never_falls_back_to_the_selection`) and crates/engine/src/cmd/richclip.rs `mod tests`
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. Shapes come from the content, not shape.insert.
//
// 1. ArtCraft: cmd/edit.rs (copy_inner:78, paste:266, paste_special:398, duplicate:511, delete:558,
//    select_all:626, deselect:659, select:676) and cmd/richclip.rs; PowerPoint: Home › Clipboard,
//    Ctrl+D, Delete, Select All, Paste Special.
// 2. Ours: the same steps; the session clipboard holds deckcraft's Clipboard (text body, shapes with
//    media and source theme, or slides) and the system clipboard the plain text and HTML.
// 3. These tests + tests/prism/edit.test.mjs (undo round trips) + tests/e2e/prism/edit-clipboard.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {withNew, rect, textBox, shapeOf, selected, curSlide} from './text_deck.mjs';
import {bodyToHtml, htmlToBody, sameWords, decodeText, MAX_HTML} from '../../../core/prism/lib/edit-richclip.mjs';
import {bodyFromText, bodyText} from '../../../core/prism/model/text.mjs';
import {colorScheme, fillSolid} from '../../../core/prism/model/style.mjs';
import {schemeGet} from '../../../core/prism/model/color.mjs';
import {masterScheme} from '../../../core/prism/model/presentation.mjs';
import {selectedSlideIds, currentSlideIndex} from '../../../core/prism/model/doc.mjs';

const names = t => curSlide(t).shapes.map(x => x.name);

test('clipboard_copy_paste_shapes_and_slides', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 50, 50], undefined, 'Oval 3')]});
  await t.exec('edit.copy', {});
  await t.exec('edit.paste', {});
  await t.exec('edit.paste', {});
  assert.equal(curSlide(t).shapes.length, 2 + 3);
  await t.exec('edit.copy', {scope: 'slides'});
  await t.exec('edit.paste', {scope: 'slides'});
  assert.equal(t.content.slides.length, 2);
});

test('pasted_shapes_get_the_next_automatic_name; a chosen name stays', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 50, 50], undefined, 'Rectangle 3')]});
  const before = names(t).length - 1;
  await t.exec('edit.copy', {});
  await t.exec('edit.paste', {});
  await t.exec('edit.paste', {});
  const all = names(t);
  assert.equal(all[before + 1], `Rectangle ${before + 2}`);
  assert.equal(all[before + 2], `Rectangle ${before + 3}`);
  // A name the user chose is not an automatic one and stays on the copy.
  const t2 = await withNew({shapes: [rect('500', [10, 10, 50, 50], undefined, 'Hero')]});
  await t2.exec('edit.copy', {});
  await t2.exec('edit.paste', {});
  assert.equal(names(t2).at(-1), 'Hero');
});

test('pasting_after_a_deleted_shape_does_not_repeat_a_name', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 50, 50], undefined, 'Rectangle 3'), rect('501', [10, 10, 50, 50], undefined, 'Rectangle 4'),
    rect('502', [10, 10, 50, 50], undefined, 'Rectangle 5')]});
  await t.exec('edit.delete', {ids: ['501']});
  await t.exec('edit.select', {ids: ['502']});
  await t.exec('edit.copy', {});
  await t.exec('edit.paste', {});
  const all = names(t);
  assert.equal(new Set(all).size, all.length, all.join());
});

test('pasting on another slide keeps names (Morph pairs them) and positions', async () => {
  const t = await withNew({blank: true, shapes: [rect('500', [10, 10, 50, 50], undefined, 'Rectangle 2'), rect('501', [200, 200, 80, 80], undefined, 'Rectangle 3')]});
  await t.exec('edit.selectAll', {});
  await t.exec('edit.copy', {});
  await t.exec('slide.new', {layout: 'blank'});
  await t.exec('edit.paste', {});
  const [a, b] = [t.content.slides[1], t.content.slides[2]];
  assert.deepEqual(a.shapes.map(x => x.name), b.shapes.map(x => x.name));
  assert.deepEqual(a.shapes.map(x => x.xfrm), b.shapes.map(x => x.xfrm));
});

test('bold_copy_is_html_and_pages_html_pastes_bold', async () => {
  const t = await withNew();
  const title = curSlide(t).shapes[0].id;
  await t.exec('text.edit', {id: title});
  await t.exec('text.insert', {text: 'Hello'});
  // format.bold is U:prism/format: the run is made bold in place here.
  await t.exec('text.selectAll', {});
  const sl = curSlide(t);
  const body = structuredClone(sl.shapes[0].text);
  body.paragraphs[0].runs[0].props = {...(body.paragraphs[0].runs[0].props ?? {}), bold: true};
  await t.exec('text.set', {id: title, text: 'Hello'});
  const p0 = t.content.slides[0].shapes[0].text.paragraphs[0];
  assert.equal(bodyText({paragraphs: [p0]}), 'Hello');
  const bold = await withNew({shapes: [{...textBox('500', [10, 10, 200, 40], 'Hello'), text: {body: {wrap: true, autofit: {kind: 'shape'}}, paragraphs: [{level: 0, runs: [{text: 'Hello', props: {bold: true}}]}]}}]});
  await bold.exec('text.edit', {id: '500'});
  await bold.exec('text.selectAll', {});
  const v = (await bold.exec('edit.copy', {})).result;
  assert.ok(v.html.includes('<b>'), v.html);
  assert.equal(v.text, 'Hello');
  // The same plain words are our own clipboard, so a plainer HTML fragment is not reparsed.
  await bold.exec('text.select', {anchor: [0, 5], caret: [0, 5]});
  await bold.exec('edit.paste', {text: 'Hello', html: '<p>Hello</p>'});
  const b2 = shapeOf(bold, '500').text;
  assert.equal(bodyText(b2), 'HelloHello');
  assert.ok(b2.paragraphs.flatMap(p => p.runs).every(r => r.props?.bold === true), JSON.stringify(b2));
  await bold.exec('text.select', {anchor: [0, 10], caret: [0, 10]});
  const caret = (await bold.exec('edit.copy', {})).result;
  assert.deepEqual(caret, {text: '', html: ''});

  const ext = await withNew();
  await ext.exec('edit.paste', {text: 'Hello', html: '<p style="font-weight: bold">Hello</p>'});
  const pasted = curSlide(ext).shapes.find(sh => sh.text && bodyText(sh.text) === 'Hello').text;
  assert.equal(pasted.paragraphs[0].runs[0].props.bold, true);

  const mismatched = await withNew();
  await mismatched.exec('edit.paste', {text: 'Hi', html: '<b>Nope</b>'});
  const plain = curSlide(mismatched).shapes.find(sh => sh.text && bodyText(sh.text) === 'Hi').text;
  assert.notEqual(plain.paragraphs[0].runs[0].props?.bold, true);
});

test('html_paste_with_a_source_newline_keeps_its_bold', async () => {
  const t = await withNew();
  await t.exec('edit.paste', {text: 'Hello world', html: '<p><b>Hello</b>\nworld</p>'});
  const body = curSlide(t).shapes.find(sh => sh.text && bodyText(sh.text) === 'Hello world').text;
  assert.equal(body.paragraphs[0].runs[0].props.bold, true);
});

test('paste_special_keeps_source_look or text (Picture needs the slide renderer: not offered)', async () => {
  const sh = rect('500', [100, 100, 200, 100], 'Q3 plan', 'Rectangle 3', {fill: fillSolid(colorScheme('accent1'))});
  const t = await withNew({shapes: [sh]});
  const oldAccent = schemeGet(masterScheme(t.content.masters[0]), 'accent1');
  await t.exec('edit.copy', {});
  // design.theme is U:prism/design: the theme's accent 1 changes in place here.
  const c = structuredClone(t.content);
  c.masters[0].theme.colors.colors[4] = {r: 1, g: 2, b: 3, a: 255};
  t.session.reload(t.docId, {...t.file, content: c});
  const dest = await t.exec('edit.pasteSpecial', {as: 'destinationTheme'});
  assert.equal(shapeOf(t, dest.result.ids[0]).fill.color.base.kind, 'scheme');
  const keep = await t.exec('edit.pasteSpecial', {as: 'keepSource'});
  assert.deepEqual(shapeOf(t, keep.result.ids[0]).fill.color.base, {kind: 'rgb', rgb: oldAccent});
  // The clipboard itself still holds the theme-following shape.
  assert.equal(t.session.clipboard.data.shapes[0].fill.color.base.kind, 'scheme');
  const n = curSlide(t).shapes.length;
  await t.exec('edit.pasteSpecial', {as: 'text'});
  assert.equal(curSlide(t).shapes.length, n + 1);
  assert.equal(bodyText(curSlide(t).shapes.at(-1).text), 'Q3 plan');
  await assert.rejects(t.exec('edit.pasteSpecial', {as: 'bogus'}));
});

test('select_all_slides_scope / leaves shape select all alone / bad scope', async () => {
  const t = await withNew();
  const r = await t.exec('edit.selectAll', {scope: 'slides'});
  assert.equal(r.result.selected.length, 1);
  for (let i = 0; i < 3; i++) await t.exec('slide.new', {});
  await t.exec('slide.hide', {index: 1});
  await t.exec('slide.go', {index: 1});
  const before = currentSlideIndex(t.content, t.doc.selection);
  await t.exec('edit.selectAll', {scope: 'slides'});
  assert.deepEqual(selectedSlideIds(t.content, t.doc.selection), t.content.slides.map(x => x.id));
  assert.equal(currentSlideIndex(t.content, t.doc.selection), before, 'the current slide must not jump');
  assert.equal(t.content.slides.length, 4);
  const u = await withNew({shapes: [rect('500', [10, 10, 50, 50])]});
  await u.exec('edit.deselect', {});
  await u.exec('edit.selectAll', {});
  assert.ok(selected(u).length > 0);
  await assert.rejects(u.exec('edit.selectAll', {scope: 'everything'}));
  await assert.rejects(u.exec('edit.selectAll', {scope: 3}));
});

test('duplicating_a_moved_copy_repeats_the_move', async () => {
  const t = await withNew({shapes: [rect('500', [100, 100, 50, 50])]});
  const box = id => shapeOf(t, id).xfrm;
  const b = (await t.exec('edit.duplicate', {})).result.ids[0];
  assert.deepEqual([box(b).x, box(b).y], [112, 112]);
  // shape.move is U:prism/shape: the copy is moved through the content change API instead.
  const c0 = structuredClone(t.content);
  const sh = c0.slides[0].shapes.find(x => x.id === b);
  sh.xfrm = {...sh.xfrm, x: 180, y: 100};
  await t.batch([]).catch(() => {});
  t.doc.dirty = false;
  t.session.reload(t.docId, {...t.file, content: c0});
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${c0.slides[0].id}/sp:${b}`, focus: `/sl:${c0.slides[0].id}/sp:${b}`}], primary: 0});
  // The reload ends the session's memory of the last Duplicate only when the copy is gone; the view keeps it.
  const c = (await t.exec('edit.duplicate', {})).result.ids[0];
  assert.deepEqual([box(c).x, box(c).y], [260, 100]);
  const d = (await t.exec('edit.duplicate', {})).result.ids[0];
  assert.deepEqual([box(d).x, box(d).y], [340, 100]);
  // Duplicating something else goes back to the usual offset.
  await t.exec('edit.select', {ids: ['500']});
  const e = (await t.exec('edit.duplicate', {})).result.ids[0];
  assert.deepEqual([box(e).x, box(e).y], [112, 112]);
});

test('duplicated_and_pasted_slides_retarget_animations_and_triggers', async () => {
  const a = rect('500', [10, 10, 50, 50]), b = rect('501', [100, 10, 50, 50]);
  const t = await withNew({shapes: [a, b]});
  const c = structuredClone(t.content);
  c.slides[0].animations = [{shape: '500', class: 'entrance', effect: 'fade', option: '', trigger: '501'}, {shape: '501', class: 'entrance', effect: 'fly', option: '', trigger: null}];
  t.session.reload(t.docId, {...t.file, content: c});
  await t.exec('slide.duplicate', {index: 0});
  const copy = t.content.slides[1];
  const [na, nb] = copy.shapes.slice(-2).map(x => x.id);
  assert.notEqual(na, '500');
  assert.deepEqual(copy.animations.map(x => [x.shape, x.trigger]), [[na, nb], [nb, null]]);
  await t.exec('edit.copy', {scope: 'slides'});
  await t.exec('edit.paste', {});
  const pasted = t.content.slides[2];
  const [pa, pb] = pasted.shapes.slice(-2).map(x => x.id);
  assert.deepEqual(pasted.animations.map(x => [x.shape, x.trigger]), [[pa, pb], [pb, null]]);
});

test('invalid_ids_array_never_falls_back_to_the_selection', async () => {
  const t = await withNew({shapes: [rect('500', [100, 100, 100, 100])]});
  for (const ids of [[-1], [1.5], [4294967296], [-1, '500']]) {
    await assert.rejects(t.exec('edit.delete', {ids}), e => e.code === 'invalid_params', JSON.stringify(ids));
    assert.ok(shapeOf(t, '500'), `shape deleted for ${JSON.stringify(ids)}`);
  }
});

// ---- richclip.rs `mod tests` ----------------------------------------------------------------

test('richclip: multibyte_after_ampersand_is_kept', () => {
  const e = 'é'.repeat(20), cjk = '漢'.repeat(20);
  assert.equal(decodeText(`R&D ${e}`), `R&D ${e}`);
  assert.equal(decodeText(`&${cjk}`), `&${cjk}`);
});
test('richclip: signed_numeric_entities_are_kept_as_typed', () => {
  assert.equal(decodeText('a&#+65;b'), 'a&#+65;b');
  assert.equal(decodeText('a&#x+41;b'), 'a&#x+41;b');
  assert.equal(decodeText('a&#65;b&#x41;'), 'aAbA');
});
test('richclip: numeric_tab_entity_decodes_to_tab', () => {
  assert.equal(decodeText('a&#9;b'), 'a\tb');
  assert.equal(decodeText('a&#x9;b'), 'a\tb');
});
test('richclip: google_docs_normal_weight_wrapper_is_not_bold', () => {
  const body = htmlToBody('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><span style="font-weight:400">plain words</span></b>');
  assert.equal(bodyText(body), 'plain words');
  assert.equal(body.paragraphs[0].runs[0].props?.bold, undefined);
  assert.equal(htmlToBody('<b style="font-weight:300">thin</b>').paragraphs[0].runs[0].props?.bold, undefined);
  assert.equal(htmlToBody('<b>strong</b>').paragraphs[0].runs[0].props.bold, true);
  assert.equal(htmlToBody('<span style="font-weight:700">heavy</span>').paragraphs[0].runs[0].props.bold, true);
});
test('richclip: style_attribute_is_found_after_attributes_containing_style', () => {
  for (const tag of ['<span class="style1" style="font-weight:bold">x</span>', '<span data-style="x" style="font-weight:bold">x</span>',
    '<span class="mystyle" style="font-weight:bold">x</span>']) {
    assert.equal(htmlToBody(tag).paragraphs[0].runs[0].props.bold, true, tag);
  }
  assert.equal(htmlToBody('<span class="style">x</span>').paragraphs[0].runs[0].props?.bold, undefined);
});
test('richclip: bold_italic_and_underline_round_trip', () => {
  const body = {body: {}, paragraphs: [{level: 0, runs: [{text: 'Hi', props: {bold: true}}, {text: ' '}, {text: 'there', props: {italic: true, underline: 'sng'}}]}]};
  const html = bodyToHtml(body);
  assert.ok(html.includes('<b>Hi</b>'), html);
  assert.ok(html.includes('<i><u>there</u></i>') || html.includes('<u><i>there</i></u>'), html);
  const back = htmlToBody(html);
  assert.equal(bodyText(back), 'Hi there');
  assert.equal(back.paragraphs[0].runs[0].props.bold, true);
  const last = back.paragraphs[0].runs.at(-1);
  assert.equal(last.props.italic, true);
  assert.ok(last.props.underline);
});
test('richclip: bare_ampersand_keeps_text_up_to_next_semicolon', () => {
  const text = h => bodyText(htmlToBody(h));
  assert.equal(text('<p>R&D costs; up</p>'), 'R&D costs; up');
  assert.equal(text('<p>AT&T; Q&A</p>'), 'AT&T; Q&A');
  assert.equal(text('<p>A &amp; B &#38; C &#x26; D</p>'), 'A & B & C & D');
  assert.equal(text(`<p>${'&'.repeat(2000)}</p>`), '&'.repeat(2000));
});
test('richclip: pages_style_and_escapes', () => {
  const body = htmlToBody('<html><head><style>p{}</style></head><body><p><span style="font-weight: bold">A &amp; B</span></p><p><span style="font-style: italic">C</span></p></body></html>');
  assert.equal(bodyText(body), 'A & B\nC');
  assert.equal(body.paragraphs[0].runs[0].props.bold, true);
  assert.equal(body.paragraphs[1].runs[0].props.italic, true);
  assert.ok(sameWords(bodyText(body), 'A & B\nC'));
  assert.ok(!sameWords(bodyText(body), 'other'));
});
test('richclip: a_newline_in_html_text_is_a_space', () => {
  assert.equal(decodeText('Hello\nworld'), 'Hello world');
  assert.equal(bodyText(htmlToBody('<p>Hello\r\n  world</p>')), 'Hello world');
  const body = htmlToBody('<p>\n<b>Hello</b>\n<i>world</i>\n</p>\n<p>next</p>');
  assert.equal(bodyText(body), 'Hello world\nnext');
  assert.equal(body.paragraphs[0].runs[0].props.bold, true);
  assert.equal(body.paragraphs[0].runs.at(-1).props.italic, true);
});
test('richclip: a_huge_fragment_is_refused', () => {
  assert.equal(htmlToBody('x'.repeat(MAX_HTML + 1)), null);
  void bodyFromText;
});
