// Prism's Design tab through the bridge and the real window (U:prism/design).
//
// What deckcraft does (crates/ui-egui/src/ribbon/design.rs, engine cmd/design.rs, panels/
// background.rs, panels/designer.rs): the Themes gallery draws each theme and applies it, Variants
// gives four colour variations, Colors / Fonts / Effects are menus of schemes (Customize opens a
// dialog), Background Styles are twelve tiles, Slide Size is Standard / Widescreen / Page Setup,
// Format Background and Design Ideas are side panes. PowerPoint: the same tab, and a Maximize /
// Ensure Fit prompt when the size changes.
// What this proves in the app: the real ribbon controls (ui.activate on the galleries and menu
// rows, ui.menu to open them) change the deck as the engine tests do, the gallery tiles are
// pictures (looked at in the captures), the dialogs open on the deck's values and submit, the
// Format Background and Design Ideas panes open and show the slide's background / the ideas.
// Captures in artifacts/e2e/prism/design/ (looked at, not only counted).

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A 96x64 PNG: a blue to green diagonal, so a background picture and its tiling show. */
function png() {
  const w = 96, h = 64, raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 30 + y; raw[o + 1] = 80 + x; raw[o + 2] = 200 - x; }
  }
  const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('prism design: themes, variants, colours, fonts, effects, background styles, slide size, panes', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Design deck', {schema: 2});
  file.id = 'prism-design';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/design', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = (control, value) => app.rpc('ui.activate', value === undefined ? {doc, control} : {doc, control, value});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await run('slide.new', {layout: 'titleAndContent'});
    await run('slide.new', {layout: 'titleOnly'});
    await run('slide.go', {index: 0});
    await run('insert.textBox', {rect: [120, 300, 400, 80], text: 'Revenue grew 40 percent'});
    await app.rpc('ui.tab', {doc, tab: 'design'});
    let ui = await app.rpc('ui.inspect', {doc});
    const ctl = id => ui.controls.find(c => c.id === id);
    for (const id of ['design.themes.gallery', 'design.themes.browse', 'design.variants.gallery', 'design.variants.colors', 'design.variants.fonts', 'design.variants.effects',
      'design.variants.background-styles', 'design.customize.slide-size', 'design.customize.format-background', 'design.designer.design-ideas']) assert.ok(ctl(id), `${id} is drawn`);
    assert.equal(ctl('design.themes.save'), undefined, 'Save Current Theme is hidden (nothing upstream)');
    assert.ok(ctl('design.themes.gallery').value.every(t => t.art?.kind === 'theme'), 'every theme tile is a drawn picture');
    await app.capture('1-design-tab');

    // Themes: the gallery opens as pictures; a tile applies the theme; the gallery marks it.
    await app.rpc('ui.menu', {doc, control: 'design.themes.gallery'});
    await app.capture('2-themes-gallery-open');
    await app.rpc('ui.menu', {doc, control: 'design.themes.gallery', open: false});
    await activate('design.themes.gallery', 'Harbor');
    let d = await deck();
    assert.equal(d.masters[0].theme.name, 'Harbor');
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('design.themes.gallery').value.find(t => t.selected).id, 'Harbor');
    assert.equal(ctl('design.variants.gallery').value.length, 4);
    await app.capture('3-harbor-applied');

    // Variants and the Colors / Fonts / Effects menus.
    await activate('design.variants.gallery', 3);
    d = await deck();
    assert.equal(d.masters[0].theme.colors.name, 'Harbor 4');
    await app.rpc('ui.menu', {doc, control: 'design.variants.colors'});
    await app.capture('4-colors-menu');
    await app.rpc('ui.menu', {doc, control: 'design.variants.colors', open: false});
    await activate('design.variants.colors.colour-schemes', 'Sunset');
    assert.equal((await deck()).masters[0].theme.colors.name, 'Sunset');
    await app.rpc('ui.menu', {doc, control: 'design.variants.fonts'});
    await app.capture('5-fonts-menu');
    await app.rpc('ui.menu', {doc, control: 'design.variants.fonts', open: false});
    await activate('design.variants.fonts.font-schemes', 'Editorial');
    assert.equal((await deck()).masters[0].theme.fonts.major.latin, 'Playfair Display');
    await app.rpc('ui.menu', {doc, control: 'design.variants.effects'});
    await app.capture('6-effects-menu');
    await app.rpc('ui.menu', {doc, control: 'design.variants.effects', open: false});
    await activate('design.variants.effects.effect-schemes', 'Lift');
    assert.equal((await deck()).masters[0].theme.format.name, 'Lift');
    await app.capture('7-variants-applied');

    // Background Styles: twelve drawn tiles; a tile sets every slide and the master.
    await app.rpc('ui.menu', {doc, control: 'design.variants.background-styles'});
    await app.capture('8-background-styles');
    await app.rpc('ui.menu', {doc, control: 'design.variants.background-styles', open: false});
    await activate('design.variants.background-styles', 6);
    d = await deck();
    assert.ok(d.slides.every(s => s.background?.kind === 'ref' && s.background.idx === 1002));
    assert.equal(d.masters[0].background.idx, 1002);
    await app.capture('9-background-style-6');

    // Customize Colors and Customize Fonts: the dialogs open on the theme and submit.
    await activate('design.variants.colors.customize-colors');
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.themeColors');
    await app.capture('10-theme-colors-dialog');
    await app.rpc('ui.dialog.set', {field: 'accent-1', value: '#c0392b'});
    await app.rpc('ui.dialog.set', {field: 'name', value: 'Brick'});
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.equal(d.masters[0].theme.colors.name, 'Brick');
    assert.equal(d.masters[0].theme.colors.colors[4].r, 0xc0);
    await activate('design.variants.fonts.customize-fonts');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.themeFonts');
    await app.capture('11-theme-fonts-dialog');
    await app.rpc('ui.dialog.set', {field: 'major', value: 'Georgia'});
    await app.rpc('ui.dialog.set', {field: 'minor', value: 'Verdana'});
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.deepEqual([d.masters[0].theme.fonts.major.latin, d.masters[0].theme.fonts.minor.latin], ['Georgia', 'Verdana']);

    // Slide Size: the menu, the Maximize / Ensure Fit prompt, the dialog.
    await app.rpc('ui.menu', {doc, control: 'design.customize.slide-size'});
    await app.capture('12-slide-size-menu');
    await app.rpc('ui.menu', {doc, control: 'design.customize.slide-size', open: false});
    await activate('design.customize.slide-size.standard-4-3');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.scaleContent');
    await app.capture('13-scale-prompt');
    await app.rpc('ui.dialog.set', {field: 'scale', value: 'ensureFit'});
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.deepEqual([d.slideSize.width, d.slideSize.height], [720, 540]);
    await app.capture('14-standard-size');
    await activate('design.customize.slide-size.custom-slide-size');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.slideSize');
    assert.equal(dlg.values.preset, 'Standard (4:3)');
    await app.rpc('ui.dialog.set', {field: 'preset', value: 'Widescreen (16:9)'});
    await app.rpc('ui.dialog.set', {field: 'max', value: true});
    await app.capture('15-slide-size-dialog');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.deepEqual([d.slideSize.width, d.slideSize.height], [960, 540]);
    await app.capture('16-widescreen-again');

    // Format Background pane: solid, gradient, pattern and picture fills; hide graphics.
    await run('design.background', {color: '#1f3a5f'});
    await activate('design.customize.format-background');
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ui.panes?.some(p => /background/.test(p.id) && p.open) || null; }, {timeout: 10_000});
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ctl('design.customize.format-background').checked === true || null; }, {timeout: 10_000});
    await sleep(700);
    await app.capture('17-format-background-solid');
    await run('design.background', {gradient: {stops: [[0, '#ff7a45'], [1, '#2b5fd9']], kind: 'linear', angle: 90}});
    await sleep(500);
    await app.capture('18-format-background-gradient');
    await run('design.background', {pattern: {preset: 'wdUpDiag', fg: '#2e6fd8', bg: '#e8eefc'}});
    await sleep(500);
    await app.capture('19-format-background-pattern');
    await run('design.background', {picture: png(), name: 'bg.png', pictureProps: {tile: true, scaleX: 1.5, scaleY: 1.5}});
    await sleep(600);
    await app.capture('20-format-background-picture-tiled');
    await run('design.hideBackgroundGraphics', {hide: true});
    assert.equal((await deck()).slides[0].showMasterShapes, false);
    await run('design.background', {reset: true});
    await app.rpc('ui.pane', {doc, id: 'background', open: false});
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ctl('design.customize.format-background').checked === false || null; }, {timeout: 10_000});

    // Design Ideas pane: layout ideas for the slide, every theme.
    await activate('design.designer.design-ideas');
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ui.panes?.some(p => /designer/.test(p.id) && p.open) || null; }, {timeout: 10_000});
    await sleep(900);
    await app.capture('21-design-ideas-pane');
    const ideas = (await run('design.ideas')).result;
    assert.ok(ideas.length >= 3, 'the title slide with text has layout ideas');
    await run('design.applyIdea', {id: ideas[0].id});
    await sleep(500);
    await app.capture('22-idea-applied');
  } finally {
    await app.close();
  }
});
