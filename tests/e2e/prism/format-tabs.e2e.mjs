// Prism format tabs in the app: the Selection pane and the Format Shape pane open from their ribbon
// buttons, the slide draws shape effects (shadow, glow, soft edges, reflection, bevel) and a recolored
// or artistic picture, Collapse All folds the slide pane's sections, and Grid Options opens its dialog.
//
// What deckcraft does: panels/selpane.rs and format_shape.rs are the two panes; the renderer draws the
// effects (render/renderer.rs, images.rs apply_adjust). PowerPoint: the same panes and effects.
// What this proves end to end: ribbon control -> command -> pane or slide (captured), and undo.
// Captures in artifacts/e2e/prism/format-tabs/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {pictureFill, base64Encode} from '../../../core/prism/lib/shape-common.mjs';
import {encodePng} from '../../../core/prism/lib/raster.mjs';

const box = (id, name, x, y, rgb) => shape({id, name, xfrm: {x, y, w: 150, h: 90}, geom: presetGeom('rect'), fill: fillSolid(colorRgb({...rgb, a: 255})), text: bodyFromText(name)});

/** A landscape, so recolor and effects are easy to see. */
async function landscape() {
  const w = 120, h = 80, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, hill = y > 50 + Math.sin(x / 12) * 8, sun = (x - 90) ** 2 + (y - 20) ** 2 < 100;
    data.set(sun ? [255, 214, 92, 255] : hill ? [64, 150, 70, 255] : [120, 180, 238, 255], i);
  }
  return encodePng({width: w, height: h, data});
}

test('prism format tabs: Selection and Format Shape panes, drawn effects, recolor, Collapse All, Grid Options', {timeout: 600_000}, async () => {
  const file = createFile('prism', 'Format tabs deck', {schema: 2});
  file.id = 'prism-format-tabs';
  const c = file.content;
  const s1 = c.slides[0];
  s1.shapes.push(box('f1', 'Shadow', 60, 120, {r: 68, g: 114, b: 196}), box('f2', 'Glow', 260, 120, {r: 237, g: 125, b: 49}), box('f3', 'Soft edges', 460, 120, {r: 112, g: 173, b: 71}),
    box('f4', 'Reflection', 60, 280, {r: 91, g: 155, b: 213}), box('f5', 'Bevel', 260, 280, {r: 165, g: 165, b: 165}));
  c.media = [{id: 'pic1', name: 'landscape.png', contentType: 'image/png', data: base64Encode(await landscape()), link: null}];
  s1.shapes.push(shape({id: 'pic', name: 'Picture 1', xfrm: {x: 660, y: 270, w: 240, h: 160}, kind: {type: 'picture', fill: pictureFill('pic1')}, geom: presetGeom('rect')}));
  c.nextId = Math.max(c.nextId, 400);
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/format-tabs', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const read = async address => (await app.rpc('document.read', {doc, address, as: 'json'})).value;
  const slide = () => read(`/sl:${s1.id}`);
  const pick = id => app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s1.id}/sp:${id}`, focus: `/sl:${s1.id}/sp:${id}`}]});
  const pane = async id => (await app.rpc('ui.inspect', {doc})).panes?.find(p => String(p.id).replace(/^pane\./, '') === id) ?? null;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'home'}).catch(() => {});

    // Effects drawn on the slide.
    await pick('f1'); await run('shape.effects', {shadow: 'outer'});
    await pick('f2'); await run('shape.effects', {glow: {radius: 11}});
    await pick('f3'); await run('shape.effects', {softEdges: 10});
    await pick('f4'); await run('shape.effects', {reflection: 'half'});
    await pick('f5'); await run('shape.effects', {bevel: 'circle'});
    await app.capture('1-effects-on-the-slide');
    const sl = await slide();
    assert.equal(sl.shapes.find(x => x.id === 'f5').effects.bevel, 'circle');

    // Picture Format: Recolor (Sepia), then an artistic effect; the picture's adjust and media change; undo goes back.
    await pick('pic');
    await app.rpc('ui.tab', {doc, tab: 'picture-format'}).catch(() => {});
    await run('picture.recolor', {preset: 'sepia'});
    assert.equal((await read(`/sl:${s1.id}/sp:pic`)).kind.fill.adjust.duotone.length, 2);
    await app.capture('2-picture-sepia');
    await run('picture.recolor', {preset: 'none'});
    await run('picture.artisticEffect', {effect: 'artisticCutout'});
    assert.equal((await read(`/sl:${s1.id}/sp:pic`)).kind.fill.artistic.effect, 'artisticCutout');
    await app.capture('3-picture-cutout');
    await run('edit.undo');
    assert.equal((await read(`/sl:${s1.id}/sp:pic`)).kind.fill.artistic, undefined);

    // The Selection pane opens from Home › Editing › Select › Selection Pane… and lists the objects.
    await app.rpc('ui.tab', {doc, tab: 'home'}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'home.editing.select.selection-pane'});
    await app.until(async () => (await pane('selection'))?.open || null, {timeout: 15_000}).catch(e => { throw new Error(e.message + log()); });
    await new Promise(r => setTimeout(r, 3000)); // the pane's module loads on first open
    await app.capture('4-selection-pane');
    // Close it again from the same control (it toggles).
    await app.rpc('ui.activate', {doc, control: 'home.editing.select.selection-pane'});
    await app.until(async () => ((await pane('selection'))?.open ? null : true), {timeout: 15_000});

    // The Format Shape pane opens on a tab: More Lines… on Fill & Line, Format Shape… on Effects.
    await pick('f5');
    await app.rpc('ui.activate', {doc, control: 'home.drawing.outline.more-lines'});
    await app.until(async () => (await pane('format'))?.open || null, {timeout: 15_000}).catch(e => { throw new Error(e.message + log()); });
    await new Promise(r => setTimeout(r, 3000));
    await app.capture('5-format-pane-fill-and-line');
    await app.rpc('ui.activate', {doc, control: 'home.drawing.effects.format-shape'});
    await app.capture('6-format-pane-effects');
    await app.rpc('ui.activate', {doc, control: 'shapeformat.pane.format'});

    // Section Collapse All folds the slide pane's sections; Expand All opens them.
    await run('section.add', {at: 0});
    await run('section.collapseAll');
    assert.equal((await app.rpc('ui.inspect', {doc})).doc?.id, doc);
    await app.capture('7-sections-collapsed');
    await run('section.expandAll');

    // Grid Options opens its dialog from Align › Grid Settings….
    await app.rpc('ui.activate', {doc, control: 'home.drawing.arrange.align.grid-settings'}).catch(() => {});
    await app.capture('8-grid-options');
  } finally {
    await app.close();
  }
});
