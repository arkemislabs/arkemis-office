// U:prism/design: the Design tab commands (design.theme, browseTheme, themes, colors, variant,
// variants, fonts, effects, background, hideBackgroundGraphics, slideSize, ideas, applyIdea), the
// pane command (pane.toggle), the dialogs (Slide Size, Create New Theme Colors / Fonts, the scale
// prompt) and the .pptx round trip of themes and backgrounds.
//
// 1. ArtCraft: crates/engine/src/cmd/design/tests.rs (theme, colours, fonts, effects, backgrounds,
//    slide size), design/browse_theme_tests.rs (a deck's or template's master and layouts, a
//    .thmx's theme), cmd/ideas.rs tests (the ideas of a picture slide and a text slide).
//    PowerPoint: the Design tab and the Format Background pane.
// 2. Ours: core/prism/commands/design.mjs, lib/ideas.mjs, lib/pattern.mjs, dialogs/{slideSize,
//    themeColors,themeFonts,scaleContent}.mjs; the file is core/prism/formats/pptx-*.mjs.
// 3. These tests and tests/e2e/prism/design.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import design from '../../core/prism/commands/design.mjs';
import panes from '../../core/prism/commands/panes.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import slideSizeDialog from '../../core/prism/dialogs/slideSize.mjs';
import themeColorsDialog, {COLOR_FIELDS} from '../../core/prism/dialogs/themeColors.mjs';
import themeFontsDialog from '../../core/prism/dialogs/themeFonts.mjs';
import scaleDialog from '../../core/prism/dialogs/scaleContent.mjs';
import {withNew, textBox, rect, curSlide} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {builtinThemes, builtinColorSchemes, builtinFontSchemes, builtinFormatSchemes} from '../../core/prism/model/theme.mjs';
import {hex} from '../../core/prism/model/color.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {base64Encode} from '../../core/prism/lib/shape-common.mjs';
import {shape, presetGeom} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {colorScheme} from '../../core/prism/model/style.mjs';
import {TILES, GALLERY, tile, isFg, runs} from '../../core/prism/lib/pattern.mjs';
import {ideasFor, coverCrop} from '../../core/prism/lib/ideas.mjs';

const deck = async (opts = {}) => withNew({extra: [design, panes, insert], ...opts});
const theme = t => t.content.masters[0].theme;
const names = rows => rows.map(r => r.id);
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('design.theme gives the deck a built-in theme (master name too), undoes, and the state lists the gallery with the current one marked', async () => {
  const t = await deck();
  const st = await t.state('design.theme');
  assert.deepEqual(names(st.value), builtinThemes().map(x => x.name));
  assert.equal(st.value.find(x => x.selected).id, 'Arkemis');
  assert.ok(!JSON.stringify(st.value).includes('DeckCraft'), 'no upstream name in the gallery');
  assert.equal(st.value[1].art.kind, 'theme');
  assert.match(st.value[1].art.bg, /^#[0-9a-f]{6}$/);
  assert.equal(st.value[1].art.accents.length, 6);
  await expectUndoRoundTrip(t, 'design.theme', {name: 'harbor'});
  assert.equal(theme(t).name, 'Harbor');
  assert.equal(t.content.masters[0].name, 'Harbor');
  assert.deepEqual(t.content.masters[0].colorMap, []);
  assert.equal((await t.state('design.theme')).value.find(x => x.selected).id, 'Harbor');
  await assert.rejects(t.exec('design.theme', {name: 'Nope'}), e => e.code === 'invalid_params' && /no theme/.test(e.message));
});

test('design.themes lists the themes, colour schemes, font schemes and effect schemes', async () => {
  const t = await deck();
  const r = (await t.exec('design.themes', {})).result;
  assert.equal(r.themes.length, builtinThemes().length);
  assert.match(r.themes[0].colors[0], /^#[0-9A-F]{6}$/);
  assert.deepEqual(r.colorSchemes, builtinColorSchemes().map(c => c.name));
  assert.deepEqual(r.fontSchemes.map(f => f.name), builtinFontSchemes().map(f => f.name));
  assert.deepEqual(r.effectSchemes, builtinFormatSchemes().map(f => f.name));
});

test('design.variant applies one of the four colour variations; design.variants says which is applied', async () => {
  const t = await deck();
  const v = (await t.exec('design.variants', {})).result;
  assert.equal(v.variants.length, 4);
  assert.equal(v.current, 0);
  await expectUndoRoundTrip(t, 'design.variant', {index: 3});
  assert.equal((await t.exec('design.variants', {})).result.current, 3);
  assert.equal(hex(theme(t).colors.colors[0]), hex(builtinThemes()[0].colors.colors[1]), 'the dark variant swaps light and dark');
  const items = (await t.state('design.variant')).value;
  assert.deepEqual(items.map(i => i.selected === true), [false, false, false, true]);
  await assert.rejects(t.exec('design.variant', {index: 4}), /(?:index|variant)/);
});

test('design.colors: a built-in scheme, slots overlaid, Custom when only colours are given; refuses aliases and bad colours; no params is for the dialog', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'design.colors', {name: 'Ocean'});
  assert.equal(theme(t).colors.name, 'Ocean');
  assert.equal(hex(theme(t).colors.colors[4]), '006494');
  await t.exec('design.colors', {colors: {accent1: '#ff0000'}});
  assert.equal(theme(t).colors.name, 'Custom');
  assert.equal(hex(theme(t).colors.colors[4]), 'FF0000');
  assert.equal(hex(theme(t).colors.colors[5]), '247BA0', 'the other slots stay');
  await t.exec('design.colors', {name: 'Mine', colors: {dk1: '#101010', hlink: '#0000ee'}});
  assert.equal(theme(t).colors.name, 'Mine');
  assert.equal(hex(theme(t).colors.colors[10]), '0000EE');
  await assert.rejects(t.exec('design.colors', {colors: {bg1: '#ffffff'}}), /not a theme colour/);
  await assert.rejects(t.exec('design.colors', {colors: {nope: '#ffffff'}}), /unknown colour/);
  await assert.rejects(t.exec('design.colors', {colors: {accent2: 'red'}}), /#RRGGBB/);
  await assert.rejects(t.exec('design.colors', {name: 'No such scheme'}), /no colour scheme/);
  await assert.rejects(t.exec('design.colors', {name: ' '}), /name is empty/);
  await assert.rejects(t.exec('design.colors', {colors: {}}), /empty/);
  const rows = (await t.state('design.colors')).value;
  assert.deepEqual(names(rows), builtinColorSchemes().map(c => c.name));
  assert.equal(rows[0].art.colors.length, 8);
});

test('design.fonts: a built-in pair, faces laid over it, Custom for faces alone (an omitted body copies the heading)', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'design.fonts', {name: 'Classic'});
  assert.deepEqual([theme(t).fonts.name, theme(t).fonts.major.latin, theme(t).fonts.minor.latin], ['Classic', 'Merriweather', 'Open Sans']);
  await t.exec('design.fonts', {major: 'Georgia'});
  assert.deepEqual([theme(t).fonts.name, theme(t).fonts.major.latin, theme(t).fonts.minor.latin], ['Custom', 'Georgia', 'Georgia']);
  await t.exec('design.fonts', {major: 'Arial', minor: 'Verdana'});
  assert.deepEqual([theme(t).fonts.major.latin, theme(t).fonts.minor.latin], ['Arial', 'Verdana']);
  await t.exec('design.fonts', {name: 'Neutral', minor: 'Tahoma'});
  assert.deepEqual([theme(t).fonts.name, theme(t).fonts.major.latin, theme(t).fonts.minor.latin], ['Neutral', 'Roboto', 'Tahoma']);
  await assert.rejects(t.exec('design.fonts', {name: 'Nope'}), /no font scheme/);
  await assert.rejects(t.exec('design.fonts', {major: ' '}), /empty/);
  const rows = (await t.state('design.fonts')).value;
  assert.equal(rows.find(r => r.checked).id, 'Neutral');
  assert.equal(rows[0].art.kind, 'fonts');
});

test('design.effects replaces the format scheme and keeps colours and fonts; the state marks the current one', async () => {
  const t = await deck();
  const before = [JSON.stringify(theme(t).colors), JSON.stringify(theme(t).fonts)];
  await expectUndoRoundTrip(t, 'design.effects', {name: 'soft'});
  assert.equal(theme(t).format.name, 'Soft');
  assert.deepEqual([JSON.stringify(theme(t).colors), JSON.stringify(theme(t).fonts)], before);
  assert.equal((await t.state('design.effects')).value.find(r => r.checked).id, 'Soft');
  assert.equal((await t.state('design.effects')).value[1].art.kind, 'effect');
  await assert.rejects(t.exec('design.effects', {name: 'Nope'}), /no effect scheme/);
});

test('design.background: solid, transparency, gradient, pattern, style, reset; the slide alone changes; undo restores', async () => {
  const t = await deck();
  t.content.slides.length < 2 && await t.exec('slide.new', {});
  await t.exec('slide.go', {index: 0});
  await expectUndoRoundTrip(t, 'design.background', {color: '#336699'});
  const bg0 = () => t.content.slides[0].background;
  assert.equal(bg0().kind, 'fill');
  assert.equal(hex(bg0().fill.color.base.rgb), '336699');
  assert.equal(t.content.slides[1].background ?? null, null, 'the other slides keep theirs');
  await t.exec('design.background', {transparency: 0.25});
  assert.deepEqual(bg0().fill.color.mods, [{op: 'alpha', val: 75000}]);
  await t.exec('design.background', {color: '#336699', transparency: 0});
  assert.equal(bg0().fill.color.mods?.length ?? 0, 0);
  await t.exec('design.background', {gradient: {stops: [[0, '#ff0000'], [1, '#0000ff']], kind: 'linear', angle: 45}});
  assert.equal(bg0().fill.kind, 'gradient');
  assert.equal(bg0().fill.rotateWithShape, false);
  assert.equal(bg0().fill.shape.angle, 45);
  await assert.rejects(t.exec('design.background', {gradient: {stops: [[0, '#ff0000']]}}), /two or more/);
  await t.exec('design.background', {pattern: {preset: 'dkDnDiag', fg: 'accent2', bg: '#ffffff'}});
  assert.equal(bg0().fill.kind, 'pattern');
  assert.equal(bg0().fill.preset, 'dkDnDiag');
  await t.exec('design.background', {style: 6});
  assert.deepEqual([bg0().kind, bg0().idx, bg0().color.base.slot], ['ref', 1002, 'bg2']);
  await t.exec('design.background', {style: 12});
  assert.deepEqual([bg0().idx, bg0().color.base.slot], [1003, 'tx1']);
  await t.exec('design.background', {reset: true});
  assert.equal(bg0(), null);
  await assert.rejects(t.exec('design.background', {}), /give `color`/);
  await assert.rejects(t.exec('design.background', {pictureProps: {tile: true}}), /need a picture/);
  await assert.rejects(t.exec('design.background', {color: 'nope'}), /invalid `color`/);
  const styles = (await t.state('design.background', {field: 'styles'})).value;
  assert.equal(styles.length, 12);
  assert.ok(styles.every(s => s.art.kind === 'bgstyle'));
  assert.ok(styles[8].art.stops && styles[0].art.color, 'the third group is a gradient, the first solid');
});

test('design.background all: every slide and the master they use, layout backgrounds dropped; copy puts this slide\'s on all', async () => {
  const t = await deck();
  await t.exec('slide.new', {});
  const lay = t.content.masters[0].layouts[0];
  t.content.masters[0].layouts[0].background = {kind: 'fill', fill: {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent3'}}}};
  void lay;
  await t.exec('slide.go', {index: 0});
  await t.exec('design.background', {color: '#202020', all: true});
  assert.ok(t.content.slides.every(s => hex(s.background.fill.color.base.rgb) === '202020'));
  assert.equal(hex(t.content.masters[0].background.fill.color.base.rgb), '202020');
  assert.ok(t.content.masters[0].layouts.every(l => !l.background), 'layouts follow the master again');
  await t.exec('slide.go', {index: 1});
  await t.exec('design.background', {color: '#ffcc00'});
  await t.exec('design.background', {copy: true});
  assert.ok(t.content.slides.every(s => hex(s.background.fill.color.base.rgb) === 'FFCC00'));
  assert.equal(hex(t.content.masters[0].background.fill.color.base.rgb), 'FFCC00');
});

test('design.background picture: a stretched picture, tile options, transparency; a non-picture is refused', async () => {
  const t = await deck();
  await t.exec('design.background', {picture: PNG, name: 'bg.png'});
  const f = () => t.content.slides[0].background.fill;
  assert.equal(f().kind, 'picture');
  assert.deepEqual(f().mode, {kind: 'stretch', fillRect: [0, 0, 0, 0]});
  assert.equal(t.content.media.length, 1);
  await t.exec('design.background', {pictureProps: {tile: true, offsetX: 10, scaleX: 2, mirror: 'xy', align: 'ctr'}});
  assert.deepEqual(f().mode, {kind: 'tile', tx: 10, ty: 0, sx: 2, sy: 1, flip: 'xy', align: 'ctr'});
  await t.exec('design.background', {pictureProps: {scaleY: 99, offsetY: -9999}});
  assert.deepEqual([f().mode.sy, f().mode.ty], [10, -4000], 'clamped');
  await t.exec('design.background', {transparency: 0.4});
  assert.ok(Math.abs(f().alpha - 0.6) < 1e-9);
  await t.exec('design.background', {pictureProps: {tile: false, stretch: [0.1, 0, 0, 0.2]}});
  assert.deepEqual(f().mode, {kind: 'stretch', fillRect: [0.1, 0, 0, 0.2]});
  await t.exec('design.background', {picture: PNG, name: 'again.png'});
  assert.equal(t.content.media.length, 1, 'the same bytes are shared');
  await assert.rejects(t.exec('design.background', {picture: base64Encode(new TextEncoder().encode('not a picture')), name: 'x.txt'}), /not a picture/);
});

test('design.hideBackgroundGraphics hides the layout and master graphics of the slide; the state is checked while hidden', async () => {
  const t = await deck();
  assert.equal((await t.state('design.hideBackgroundGraphics')).checked, false);
  await expectUndoRoundTrip(t, 'design.hideBackgroundGraphics', {hide: true});
  assert.equal(curSlide(t).showMasterShapes, false);
  assert.equal((await t.state('design.hideBackgroundGraphics')).checked, true);
  await t.exec('design.hideBackgroundGraphics', {});
  assert.equal(curSlide(t).showMasterShapes, true, 'without `hide` it toggles');
});

test('design.slideSize: ensure fit, maximize and none; masters stretch; text scales; portrait; clamps; presets by name', async () => {
  const t = await deck({shapes: [rect('50', [100, 100, 200, 100], 'Hello'), textBox('51', [10, 10, 100, 30], 'x')]});
  const sh = () => curSlide(t).shapes.find(s => s.id === '50');
  const size = () => [t.content.slideSize.width, t.content.slideSize.height];
  assert.deepEqual(size(), [960, 540]);
  const masterTitle = () => t.content.masters[0].shapes.find(s => s.xfrm);
  const mw = masterTitle().xfrm.w;
  await expectUndoRoundTrip(t, 'design.slideSize', {preset: 'standard'});
  assert.deepEqual(size(), [720, 540]);
  // Ensure fit: scale min(0.75, 1) = 0.75, centred vertically.
  assert.deepEqual([sh().xfrm.x, sh().xfrm.w, sh().xfrm.h], [75, 150, 75]);
  assert.ok(Math.abs(sh().xfrm.y - (100 * 0.75 + (540 - 540 * 0.75) / 2)) < 1e-9);
  assert.ok(Math.abs(masterTitle().xfrm.w - mw * 0.75) < 1e-9, 'masters stretch to the new size');
  await t.exec('design.slideSize', {preset: 'widescreen', scale: 'none'});
  assert.deepEqual(size(), [960, 540]);
  assert.deepEqual([sh().xfrm.x, sh().xfrm.w], [75, 150], 'none leaves the slides\' content');
  await t.exec('design.slideSize', {w: 1920, h: 1080, scale: 'maximize'});
  assert.deepEqual(size(), [1920, 1080]);
  assert.deepEqual([sh().xfrm.w, sh().xfrm.h], [300, 150]);
  await t.exec('design.slideSize', {w: 300, h: 200, orientation: 'portrait'});
  assert.deepEqual(size(), [200, 300]);
  await t.exec('design.slideSize', {w: 1, h: 99999});
  assert.deepEqual(size(), [72, 4032]);
  await assert.rejects(t.exec('design.slideSize', {preset: 'zzz'}), /unknown preset/);
  await assert.rejects(t.exec('design.slideSize', {w: 100}), /missing `h`/);
  await t.exec('design.slideSize', {preset: 'a4'});
  assert.deepEqual(size(), [780, 540]);
});

test('design.slideSize scales the font sizes of shapes by the same factor', async () => {
  const body = bodyFromText('big');
  body.paragraphs[0].runs[0].props = {size: 40};
  const t = await deck({shapes: [shape({id: '60', xfrm: {x: 0, y: 0, w: 100, h: 50}, textBox: true, geom: presetGeom('rect'), text: body})]});
  await t.exec('design.slideSize', {preset: 'standard'});
  const s = curSlide(t).shapes.find(x => x.id === '60');
  assert.equal(s.text.paragraphs[0].runs[0].props.size, 30);
});

test('design ideas: a title with text gets the text ideas, a picture gets the picture ideas; applying one moves the slide\'s shapes and changes only that slide', async () => {
  const title = shape({id: '70', name: 'Title', ph: {kind: 'title', idx: 0, vertical: false, size: null, hasCustomPrompt: false}, xfrm: {x: 50, y: 30, w: 860, h: 90}, text: bodyFromText('Harbour at dawn')});
  const body = shape({id: '71', name: 'Body', textBox: true, xfrm: {x: 50, y: 140, w: 860, h: 350}, geom: presetGeom('rect'), text: bodyFromText('one\ntwo')});
  const t = await deck({blank: true, shapes: [title, body]});
  const ideas = (await t.exec('design.ideas', {})).result;
  assert.deepEqual(ideas.map(i => i.id), ['titleColumn', 'centred', 'titleBottom']);
  await expectUndoRoundTrip(t, 'design.applyIdea', {id: 'titleColumn'});
  const s = curSlide(t);
  const tt = s.shapes.find(x => x.id === '70');
  assert.ok(tt.xfrm.w < 400 && tt.xfrm.h > 400, 'the title is a column');
  const first = t.content.slides[0].shapes.map(x => x.xfrm?.x);
  assert.ok(first.length >= 1);
  await assert.rejects(t.exec('design.applyIdea', {id: 'fullBleed'}), /no idea/);
  // A picture: the picture ideas; full bleed crops to cover and puts a band behind the title.
  const pic = shape({id: '72', name: 'Picture', kind: {type: 'picture', fill: {media: '5', crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}}, xfrm: {x: 100, y: 150, w: 400, h: 300}});
  const t2 = await deck({blank: true, shapes: [title, pic]});
  assert.deepEqual((await t2.exec('design.ideas', {})).result.map(i => i.id), ['fullBleed', 'pictureLeft', 'pictureRight', 'framed']);
  await t2.exec('design.applyIdea', {id: 'fullBleed'});
  const s2 = curSlide(t2);
  assert.equal(s2.shapes[0].id, '72', 'the picture goes to the back');
  assert.deepEqual([s2.shapes[0].xfrm.w, s2.shapes[0].xfrm.h], [960, 540]);
  assert.ok(s2.shapes[0].kind.fill.crop.some(v => v > 0), 'cropped to cover the slide');
  assert.equal(s2.shapes.find(x => x.id === '70').fill.kind, 'solid', 'a band behind the title');
  await t2.exec('design.applyIdea', {id: 'pictureLeft'});
  assert.equal(curSlide(t2).shapes.find(x => x.id === '70').fill, null, 'another idea takes the band away');
  assert.deepEqual(coverCrop(2, 1), [0.25, 0, 0.25, 0]);
  assert.deepEqual(coverCrop(NaN, 1), [0, 0, 0, 0]);
});

test('no ideas for a slide with other content in the way or two pictures', async () => {
  const pic = id => shape({id, kind: {type: 'picture', fill: {media: '5', crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}}, xfrm: {x: 0, y: 0, w: 100, h: 100}});
  const t = await deck({blank: true, shapes: [pic('80'), pic('81')]});
  assert.deepEqual((await t.exec('design.ideas', {})).result, []);
  const t2 = await deck({blank: true, shapes: [rect('82', [0, 0, 100, 100], '')]});
  assert.deepEqual(ideasFor(t2.content, 1), [], 'a filled shape would stay where it is');
});

test('design.browseTheme: a deck brings its master, layouts and theme (slides follow); a .thmx brings the theme only', async () => {
  const src = await deck();
  await src.exec('design.theme', {name: 'Ember'});
  await src.exec('design.slideSize', {preset: 'standard'});
  const bytes = await exportPptx(src.content);
  const t = await deck();
  await t.exec('slide.new', {});
  const layouts = t.content.slides.map(s => s.layout);
  await expectUndoRoundTrip(t, 'design.browseTheme', {data: base64Encode(bytes)});
  assert.equal(theme(t).name, 'Ember');
  assert.equal(t.content.masters.length, 1);
  assert.ok(t.content.masters[0].layouts.length >= 9);
  assert.deepEqual(t.content.slides.map(s => s.layout !== undefined), [true, true]);
  assert.ok(t.content.slides.every((s, i) => s.layout !== layouts[i]), 'the slides moved to the new master\'s layouts');
  assert.ok(t.content.slides.every(s => t.content.masters[0].layouts.some(l => l.id === s.layout)));
  assert.deepEqual([t.content.slideSize.width, t.content.slideSize.height], [960, 540], 'the deck keeps its own size');
  await assert.rejects(t.exec('design.browseTheme', {}), /give `path` or `data`/);
  await assert.rejects(t.exec('design.browseTheme', {data: base64Encode(new Uint8Array([1, 2, 3, 4]))}), /theme or PowerPoint/);
});

test('pane.toggle asks the surface to show or hide a pane and mirrors whether it is open', async () => {
  const t = await deck();
  assert.equal((await t.state('pane.toggle', {pane: 'background'})).checked, false);
  await t.exec('pane.toggle', {pane: 'background'});
  assert.equal(t.doc.view.panes.background, true);
  assert.deepEqual([t.doc.view.paneRequest.pane, t.doc.view.paneRequest.on], ['background', true]);
  assert.equal((await t.state('pane.toggle', {pane: 'background'})).checked, true);
  const n = t.doc.view.paneRequest.n;
  await t.exec('pane.toggle', {pane: 'background', on: false, mirror: true});
  assert.equal(t.doc.view.panes.background, false);
  assert.equal(t.doc.view.paneRequest.n, n, 'a mirror report asks for nothing');
  await t.exec('pane.toggle', {pane: 'designer', on: true});
  assert.equal(t.doc.view.panes.designer, true);
});

test('dialogs: Slide Size follows presets, dimensions and orientation; Theme Colors and Fonts submit their command; the scale prompt', async () => {
  const t = await deck();
  const ctx = () => t.session.readContext(t.docId);
  const v0 = slideSizeDialog.init(ctx());
  assert.deepEqual([v0.preset, v0.w, v0.h, v0.orientation, v0.max], ['Widescreen (16:9)', 13.33, 7.5, 'landscape', false]);
  const std = {...v0, preset: 'Standard (4:3)'};
  Object.assign(std, slideSizeDialog.derive(std, ['preset']));
  assert.deepEqual([std.w, std.h], [10, 7.5]);
  const custom = {...std, w: 11};
  Object.assign(custom, slideSizeDialog.derive(custom, ['w']));
  assert.equal(custom.preset, 'Custom');
  const port = {...custom, orientation: 'portrait'};
  Object.assign(port, slideSizeDialog.derive(port, ['orientation']));
  assert.deepEqual([port.w, port.h], [7.5, 11]);
  assert.deepEqual(slideSizeDialog.toCommand({...port, max: true}), {command: 'design.slideSize', params: {w: 540, h: 792, scale: 'maximize'}});
  const wide = {...v0, preset: 'Widescreen (13.333x7.5 in)'};
  Object.assign(wide, slideSizeDialog.derive(wide, ['preset']));
  assert.deepEqual(slideSizeDialog.toCommand(wide).params, {w: 960, h: 540, scale: 'ensureFit'}, 'a preset is exact, not 13.33 in');
  assert.equal(slideSizeDialog.validate({w: 0, h: 5}).length, 1);
  assert.equal(slideSizeDialog.validate({w: 10, h: 5}).length, 0);

  const cv = themeColorsDialog.init(ctx());
  assert.equal(cv.name, 'Custom');
  assert.match(cv[COLOR_FIELDS.accent1], /^#[0-9a-f]{6}$/);
  const call = themeColorsDialog.toCommand({...cv, [COLOR_FIELDS.accent1]: '#AA0000', name: 'Mine'});
  assert.equal(call.command, 'design.colors');
  assert.equal(call.params.colors.accent1, '#aa0000');
  assert.equal(Object.keys(call.params.colors).length, 12);
  await t.exec(call.command, call.params);
  assert.equal(theme(t).colors.name, 'Mine');
  assert.equal(themeColorsDialog.validate({...cv, [COLOR_FIELDS.dk1]: 'red'}).length, 1);
  assert.equal(themeColorsDialog.preview(null, cv).accents.length, 6);

  const fv = themeFontsDialog.init(ctx());
  assert.deepEqual([fv.major, fv.minor, fv.name], ['Inter', 'Inter', 'Custom']);
  const fcall = themeFontsDialog.toCommand({major: ' Georgia', minor: 'Arial ', name: 'Mine'});
  assert.deepEqual(fcall, {command: 'design.fonts', params: {name: 'Mine', major: 'Georgia', minor: 'Arial'}});
  assert.equal(themeFontsDialog.validate({major: '', minor: 'x', name: 'y'}).length, 1);

  assert.deepEqual(scaleDialog.toCommand({scale: 'maximize'}), {command: 'design.slideSize', params: {scale: 'maximize'}});
  assert.equal(scaleDialog.validate({scale: 'nope'}).length, 1);
  assert.equal(scaleDialog.init(ctx()).scale, 'ensureFit');
});

test('pattern tiles: every preset has a tile, the gallery is drawable, runs cover the set cells', () => {
  assert.equal(TILES.length, 54);
  for (const name of GALLERY) assert.ok(TILES.some(([n]) => n === name), name);
  assert.deepEqual(tile('nope'), tile('pct50'));
  const t = tile('horz');
  assert.ok([...Array(8).keys()].every(x => isFg(t, x, 0)) && !isFg(t, 0, 1));
  assert.deepEqual(runs('horz'), [[0, 0, 8]]);
  assert.equal(runs('pct50').length, 32);
});

test('themes, backgrounds and the layout\'s hidden graphics survive a .pptx save and reopen', async () => {
  const t = await deck();
  await t.exec('slide.new', {});
  await t.exec('design.theme', {name: 'Harbor'});
  await t.exec('design.colors', {name: 'Mine', colors: {accent1: '#aa0000'}});
  await t.exec('design.fonts', {major: 'Georgia', minor: 'Verdana'});
  await t.exec('design.effects', {name: 'Glow'});
  await t.exec('slide.go', {index: 0});
  await t.exec('design.background', {gradient: {stops: [[0, '#ff0000'], [0.5, '#00ff00'], [1, '#0000ff']], kind: 'radial'}});
  await t.exec('design.hideBackgroundGraphics', {hide: true});
  await t.exec('slide.go', {index: 1});
  await t.exec('design.background', {pattern: {preset: 'wdUpDiag', fg: '#112233', bg: '#ffeedd'}});
  await t.exec('design.background', {style: 7, all: false, index: 1});
  const back = await importPptx(await exportPptx(t.content));
  const th = back.masters[0].theme;
  assert.equal(th.colors.name, 'Mine');
  assert.equal(hex(th.colors.colors[4]), 'AA0000');
  assert.deepEqual([th.fonts.major.latin, th.fonts.minor.latin], ['Georgia', 'Verdana']);
  assert.equal(th.format.name, 'Glow');
  assert.equal(back.slides[0].background.fill.kind, 'gradient');
  assert.equal(back.slides[0].background.fill.stops.length, 3);
  assert.equal(back.slides[0].showMasterShapes, false);
  assert.deepEqual([back.slides[1].background.kind, back.slides[1].background.idx], ['ref', 1002]);
  const p = await importPptx(await exportPptx({...t.content, slides: t.content.slides.map((s, i) => (i === 1 ? {...s, background: {kind: 'fill', fill: {kind: 'pattern', preset: 'wdUpDiag', fg: {base: {kind: 'rgb', rgb: {r: 17, g: 34, b: 51, a: 255}}}, bg: colorScheme('bg1')}}} : s))}));
  assert.equal(p.slides[1].background.fill.preset, 'wdUpDiag');
});
