// U:quill/design — the Design tab: themes, style sets, colours, fonts, paragraph spacing, effects,
// watermark, page colour, page borders, and the Printed Watermark and Borders and Shading dialogs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/design.rs (THEMES 11, set_fonts 98, set_accent 113,
//    theme 134, style_set 151, para_spacing 196, scale_font_sizes 215, watermark 252, page_borders 273),
//    tools/specs.rs:366 (design.effects), the ribbon in ui-egui/src/ribbon/design.rs, the dialogs in
//    ui-egui/src/dialogs/dispatch.rs:824 (watermark) and dialogs_para.rs:554 (Borders and Shading),
//    and the page drawing in crates/render/src/lib.rs draw_watermark. Word: a theme sets the fonts
//    and colours every style uses; a style set restyles the headings; Paragraph Spacing sets the
//    document default; Watermark draws diagonal or horizontal text behind every page; Page Color
//    paints the paper; Page Borders opens Borders and Shading on Page Border and draws the box.
// 2. Ours: the same edits of styles, settings and sections, one undo step each; the page view
//    paints the page colour and the watermark (src/apps/quill/surface/watermark.mjs) and lays out
//    page borders as rules. Set as Default stays hidden (no store of defaults for new documents).
// 3. Proof: this file, tests/quill/upstream/design_tests.test.mjs and
//    tests/e2e/quill/layout-design.e2e.mjs (captures of the watermark, page colour and border).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {submitDialog, openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {quill} from './format-fixture.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {THEMES} from '../../core/quill/commands/design.mjs';
import watermarkDialog from '../../core/quill/dialogs/watermark.mjs';
import linkDialog from '../../core/quill/dialogs/link.mjs';
import selectPlaceDialog from '../../core/quill/dialogs/selectPlace.mjs';
import * as P from '../../core/quill/model/para.mjs';
import bordersDialog, {readLines, sidesParam, applySetting, toggleSide} from '../../core/quill/dialogs/borders.mjs';

const styleOf = (c, id) => c.styles.styles.find(s => s.id === id);

test('design.theme: fonts, accent and theme colours; checked in the menu; one undo step', async () => {
  const q = await quill('Title\nBody');
  await expectUndoRoundTrip(q.t, 'design.theme', {name: 'Studio'}, after => {
    const c = after.content;
    assert.equal(c.settings.themeName, 'Studio');
    assert.deepEqual([c.settings.majorFont, c.settings.minorFont, c.styles.defaultChr.font], ['Georgia', 'Georgia', 'Georgia']);
    assert.deepEqual(styleOf(c, 'Heading1').chr.color, {Rgb: [0x8c, 0x2f, 0x39]});
    assert.equal(styleOf(c, 'Heading1').chr.font, 'Georgia');
    assert.deepEqual(c.settings.themeColors.slice(4, 10), THEMES[1][3].map(x => [...x]));
  });
  await q.exec('design.theme', {name: 'darkroom'});
  assert.equal(q.state('design.theme', {name: 'Darkroom'}).checked, true);
  assert.equal(styleOf(q.t.content, 'Title').chr.font, 'Futura', 'headings take the heading font');
  await assert.rejects(() => q.exec('design.theme', {name: 'Office'}), /unknown theme/);
  assert.deepEqual((await q.exec('design.themes')).result, THEMES.map(t => t[0]));
});

test('design.themeColors and design.themeFonts change only their part', async () => {
  const q = await quill('x');
  await expectUndoRoundTrip(q.t, 'design.themeColors', {name: 'Gallery'}, after => {
    assert.deepEqual(styleOf(after.content, 'Heading2').chr.color, {Rgb: [0x22, 0x22, 0x22]});
    assert.equal(after.content.settings.themeName, 'Craft', 'the theme name stays');
  });
  await q.exec('design.themeColors', {name: 'Gallery'});
  assert.equal(q.state('design.themeColors', {name: 'Gallery'}).checked, true);
  await expectUndoRoundTrip(q.t, 'design.themeFonts', {heading: 'Futura', body: 'Avenir Next'}, after => {
    assert.deepEqual([after.content.settings.majorFont, after.content.settings.minorFont], ['Futura', 'Avenir Next']);
    assert.equal(styleOf(after.content, 'Heading1').chr.font, 'Futura');
  });
  await q.exec('design.themeFonts', {heading: 'Georgia'});
  assert.equal(q.t.content.settings.minorFont, 'Georgia', 'body defaults to the heading font');
  assert.equal(q.state('design.themeFonts', {heading: 'Georgia', body: 'Georgia'}).checked, true);
});

test('design.styleSet, design.paragraphSpacing, design.scaleFontSizes, design.effects', async () => {
  const q = await quill('x');
  await expectUndoRoundTrip(q.t, 'design.styleSet', {name: 'centered'}, after => assert.equal(styleOf(after.content, 'Heading1').para.align, 'center'));
  await q.exec('design.styleSet', {name: 'lines'});
  assert.ok(styleOf(q.t.content, 'Heading1').para.borders.bottom, 'Lines: a rule under Heading 1');
  const gallery = q.state('design.styleSet').value;
  assert.deepEqual(gallery.map(x => x.value), ['default', 'basic', 'lines', 'shaded', 'casual', 'centered', 'minimalist', 'title']);
  await expectUndoRoundTrip(q.t, 'design.paragraphSpacing', {value: 'double'}, after => {
    const dp = after.content.styles.defaultPara;
    assert.deepEqual([dp.spaceBefore, dp.spaceAfter, dp.lineSpacing], [0, 8, {rule: 'multiple', value: 2}]);
  });
  await q.exec('design.paragraphSpacing', {value: 'compact'});
  assert.equal(q.state('design.paragraphSpacing', {value: 'compact'}).checked, true);
  await expectUndoRoundTrip(q.t, 'design.scaleFontSizes', {delta: 1}, () => {});
  await expectUndoRoundTrip(q.t, 'design.effects', {}, after => assert.equal(after.content.settings.themeName, 'Craft (Subtle)'));
});

test('design.watermark: presets, custom text, remove; drawn on every page; survives a DOCX round trip', async () => {
  const q = await quill(Array.from({length: 60}, (_, i) => `Paragraph ${i + 1} with some words.`).join('\n'));
  await expectUndoRoundTrip(q.t, 'design.watermark', {text: 'CONFIDENTIAL'}, after => {
    const wm = after.content.settings.watermark;
    assert.deepEqual([wm.text, wm.diagonal, wm.semitransparent], ['CONFIDENTIAL', true, true]);
  });
  await q.exec('design.watermark', {text: 'DRAFT'});
  assert.equal(q.state('design.watermark', {text: 'DRAFT'}).checked, true);
  await q.exec('design.watermark', {diagonal: false, color: 'FF0000'});
  assert.deepEqual([q.t.content.settings.watermark.text, q.t.content.settings.watermark.diagonal, q.t.content.settings.watermark.color], ['DRAFT', false, [255, 0, 0]]);
  assert.ok(layout(q.t.content, {view: 'print'}).pages.length >= 2, 'more than one page to draw it on');
  const back = await readDocx(await writeDocx(q.t.content));
  assert.equal(back.settings.watermark?.text, 'DRAFT', 'Word\'s watermark shape is written and read back');
  await q.exec('design.watermark', {remove: true});
  assert.equal(q.t.content.settings.watermark, null);
  assert.equal(q.state('design.watermark', {remove: true}).checked, true);
});

test('design.pageColor: a colour, or none; the state reports it', async () => {
  const q = await quill('x');
  await expectUndoRoundTrip(q.t, 'design.pageColor', {color: '#FFF2CC'}, after => assert.deepEqual(after.content.settings.pageColor, [0xff, 0xf2, 0xcc]));
  await q.exec('design.pageColor', {color: '#FFF2CC'});
  assert.equal(q.state('design.pageColor').value, '#FFF2CC');
  await q.exec('design.pageColor', {color: 'auto'});
  assert.equal(q.t.content.settings.pageColor, null, 'the palette\'s No Color');
  await q.exec('design.pageColor', {color: '#123456'});
  await q.exec('design.pageColor', {color: null});
  assert.equal(q.t.content.settings.pageColor, null);
});

test('design.pageBorders: a box laid out as four rules around each page; this section or the document', async () => {
  const q = await quill('alpha\nbeta');
  await expectUndoRoundTrip(q.t, 'design.pageBorders', {kind: 'box', width: 3, style: 'double', color: '2F5597'}, after => {
    const b = after.content.lastSection.pageBorders;
    assert.deepEqual([b.top.style, b.top.width, b.top.color, b.top.space], ['double', 3, [0x2f, 0x55, 0x97], 24]);
  });
  await q.exec('design.pageBorders', {kind: 'box'});
  const rules = layout(q.t.content, {view: 'print'}).pages[0].items.filter(i => i.kind === 'rule');
  assert.equal(rules.length, 4, 'top, bottom, left and right');
  q.sel(1, 0);
  await q.exec('layout.break', {kind: 'nextPage'});
  await q.exec('design.pageBorders', {kind: 'none'});
  const secs = q.doc().sections().map(([, x]) => !!x.pageBorders);
  assert.deepEqual(secs, [true, false], 'this section only');
  await q.exec('design.pageBorders', {kind: 'box', applyTo: 'document'});
  assert.deepEqual(q.doc().sections().map(([, x]) => !!x.pageBorders), [true, true]);
});

test('Printed Watermark dialog: text, font, colour, layout; No watermark removes it', async () => {
  const q = await quill('x');
  let v = openDialogModel(q.t.session, q.t.docId, watermarkDialog);
  assert.deepEqual([v.kind, v.text, v.layout, v.semitransparent], ['none', 'DRAFT', 'diagonal', true]);
  v = changeDialogValues(watermarkDialog, v, 'text', 'TOP SECRET');
  assert.equal(v.kind, 'text', 'typing a text picks Text watermark');
  v = {...v, layout: 'horizontal', color: '#C00000', semitransparent: false, font: 'Georgia'};
  await submitDialog(q.t.session, q.t.docId, watermarkDialog, v);
  const wm = q.t.content.settings.watermark;
  assert.deepEqual([wm.text, wm.diagonal, wm.color, wm.semitransparent, wm.font], ['TOP SECRET', false, [0xc0, 0, 0], false, 'Georgia']);
  await submitDialog(q.t.session, q.t.docId, watermarkDialog, {...v, kind: 'none'});
  assert.equal(q.t.content.settings.watermark, null);
  await assert.rejects(() => submitDialog(q.t.session, q.t.docId, watermarkDialog, {...v, text: '  '}), /watermark text/);
});

test('Borders and Shading dialog: Page Border box with a style, colour and width; only the changed page runs', async () => {
  const q = await quill('alpha');
  let v = openDialogModel(q.t.session, q.t.docId, bordersDialog);
  assert.deepEqual([v.pageSetting, v.paraSetting, v.pageApplyTo, v.fill], ['none', 'none', 'document', 'auto']);
  v = changeDialogValues(bordersDialog, v, 'pageSetting', 'shadow');
  assert.deepEqual(v.pageSides, {top: true, bottom: true, left: true, right: true, between: false});
  v = {...v, pageStyle: 'dashed', pageColor: '#2F5597', pageWidth: 1.5};
  assert.deepEqual(bordersDialog.toCommand(v).batch.map(c => c.command), ['design.pageBorders'], 'only the Page Border page changed');
  await submitDialog(q.t.session, q.t.docId, bordersDialog, v);
  const b = q.t.content.lastSection.pageBorders;
  assert.deepEqual([b.top.style, b.top.width, b.bottom.width, b.right.width, b.top.color], ['dashed', 1.5, 3, 3, [0x2f, 0x55, 0x97]], 'Shadow doubles bottom and right');
  // Reading it back gives the same setting.
  const again = openDialogModel(q.t.session, q.t.docId, bordersDialog);
  assert.deepEqual([again.pageSetting, again.pageStyle, again.pageWidth, again.pageColor], ['shadow', 'dashed', 1.5, '#2F5597']);
  // A side switched off makes it Custom; paragraph borders and shading go to their commands.
  let w = changeDialogValues(bordersDialog, again, 'pageSides', {...again.pageSides, left: false});
  assert.equal(w.pageSetting, 'custom');
  w = changeDialogValues(bordersDialog, w, 'paraSetting', 'box');
  w = {...w, fill: '#FFF2CC'};
  assert.deepEqual(bordersDialog.toCommand(w).batch.map(c => c.command), ['para.borders', 'design.pageBorders', 'para.shading']);
  const before = q.t.version;
  await submitDialog(q.t.session, q.t.docId, bordersDialog, w);
  assert.equal(q.t.version, before + 1, 'one undo step');
  assert.ok(q.para(0).props.borders.top && q.para(0).props.shading);
  assert.equal(q.t.content.lastSection.pageBorders.left, undefined);
});

test('LineForm helpers: read, settings, toggles, sides', () => {
  const box = {top: {style: 'single', width: 1, color: null, space: 24}, bottom: {style: 'single', width: 1, color: null, space: 24},
    left: {style: 'single', width: 1, color: null, space: 24}, right: {style: 'single', width: 1, color: null, space: 24}};
  assert.equal(readLines(box).setting, 'box');
  assert.equal(readLines({...box, bottom: {...box.bottom, width: 2}, right: {...box.right, width: 2}}).setting, 'shadow');
  assert.equal(readLines(null).setting, 'none');
  const f = applySetting({setting: 'none', style: 'single', color: 'auto', width: 1, sides: {top: false, bottom: false, left: false, right: false, between: false}}, 'threeD');
  assert.deepEqual(sidesParam(f, false).top, {style: 'single', width: 2});
  assert.equal(toggleSide(toggleSide(toggleSide(toggleSide(f, 'top'), 'bottom'), 'left'), 'right').setting, 'none');
});

test('design.setDefault reports as upstream does (the ribbon button stays hidden: no store of defaults yet)', async () => {
  const q = await quill('x');
  const before = q.t.version;
  const r = (await q.exec('design.setDefault')).result;
  assert.equal(r.status, 'These settings will be used for new documents.');
  assert.equal(q.t.version, before, 'nothing in the document changes');
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('Picture watermark: Select Picture, Scale and Washout; drawn from its frame; written as a VML picture in the header and read back', async () => {
  const q = await quill('alpha\nbeta');
  await q.exec('design.watermark', {image: PNG, scale: 200, washout: true});
  let wm = q.t.content.settings.watermark;
  assert.ok(wm.picture?.media && q.t.content.media[wm.picture.media], 'the picture is kept as media');
  assert.deepEqual([wm.scale, wm.washout, wm.text], [200, true, '']);
  const {watermarkFrame} = await import('../../core/quill/model/content.mjs');
  assert.deepEqual(watermarkFrame({picture: {media: 'x', w: 100, h: 50}, scale: 200}, 612, 792), [200, 100], 'Scale 200% doubles the picture size');
  assert.deepEqual(watermarkFrame({picture: {media: 'x', w: 2000, h: 1000}, scale: 0}, 612, 792), [489.6, 244.8], 'Auto fits the page');
  await q.exec('design.watermark', {scale: 0, washout: false});
  wm = q.t.content.settings.watermark;
  assert.deepEqual([wm.scale, wm.washout, !!wm.picture], [0, false, true], 'Scale and Washout alone change the picture there');
  await q.exec('design.watermark', {scale: 100, washout: true});
  const bytes = await writeDocx(q.t.content);
  const back = await readDocx(bytes);
  assert.ok(back.settings.watermark?.picture?.media && back.media[back.settings.watermark.picture.media], 'the picture comes back');
  assert.equal(back.settings.watermark.washout, true);
  await q.exec('design.watermark', {text: 'DRAFT'});
  assert.equal(q.t.content.settings.watermark.picture, undefined, 'a text watermark replaces the picture');
  await assert.rejects(() => q.exec('design.watermark', {image: 'data:image/png;base64,AAAA'}), /image|picture/i);
});

test('Printed Watermark dialog: Picture watermark needs a picture; choosing one picks the kind', async () => {
  const q = await quill('x');
  let v = openDialogModel(q.t.session, q.t.docId, watermarkDialog);
  v = changeDialogValues(watermarkDialog, v, 'image', PNG);
  assert.equal(v.kind, 'picture');
  v = {...v, scale: '150', washout: false};
  await submitDialog(q.t.session, q.t.docId, watermarkDialog, v);
  const wm = q.t.content.settings.watermark;
  assert.deepEqual([wm.scale, wm.washout, !!wm.picture], [150, false, true]);
  const again = openDialogModel(q.t.session, q.t.docId, watermarkDialog);
  assert.deepEqual([again.kind, again.scale, again.washout], ['picture', '150', false]);
  await assert.rejects(() => submitDialog(q.t.session, q.t.docId, watermarkDialog, {...again, kind: 'picture', image: '', hasPicture: false}), /Select a picture/);
});

test('Insert Hyperlink: ScreenTip is kept on the link and written as w:tooltip; Bookmark… lists the places', async () => {
  const q = await quill('Visit the site now');
  q.sel(0, 6, 14);
  await q.exec('insert.link', {url: 'https://example.com/', tooltip: 'Our home page'});
  const p = q.para(0);
  assert.equal(P.propsAt(p, 8).linkTip, 'Our home page');
  const back = await readDocx(await writeDocx(q.t.content));
  const run = P.propsAt(back.body.chunks.flat().find(b => b.kind === 'para'), 8);
  assert.deepEqual([run.link, run.linkTip], ['https://example.com/', 'Our home page']);
  q.sel(0, 6, 14);
  const v = openDialogModel(q.t.session, q.t.docId, linkDialog);
  assert.equal(v.tip, 'Our home page', JSON.stringify({text: v.text, address: v.address, tip: v.tip}));
  const places = openDialogModel(q.t.session, q.t.docId, selectPlaceDialog);
  assert.equal(places.places[0].label, 'Top of the Document');
  const picked = changeDialogValues(linkDialog, v, 'place', places.places[0].value);
  assert.equal(picked.linkTo, 'place', 'choosing a place makes it a link to this document');
  await q.exec('insert.removeLink');
  assert.equal(P.propsAt(q.para(0), 8).linkTip, undefined, 'removing the link drops its ScreenTip');
});
