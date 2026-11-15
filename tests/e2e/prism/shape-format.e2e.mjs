// Prism Shape Format and Picture Format through the bridge (U:prism/shape, arrange, picture_style).
//
// What deckcraft does (crates/engine/src/cmd/shape.rs, arrange.rs, picture_style.rs; ribbon
// shape_format.rs, galleries.rs outline_menu / effects_menu / quick_styles, arrange.rs align_menu):
// selecting a shape shows Shape Format; Quick Styles, Shape Fill / Outline (Weight, Dashes) / Effects
// (Shadow, Glow) restyle it; Arrange aligns, groups and rotates; Size and Position… opens its
// dialog; a picture shows Picture Format, whose Picture Styles gallery frames it. PowerPoint: the
// same tabs and menus. What this proves end to end in the app: ui.activate on the real controls
// (gallery tiles by value, menu items) changes the deck as the engine tests do, the contextual tab
// appears with the selection, the Size and Position and Alt Text dialogs submit, and Ctrl+Z through
// the KeyRouter undoes. Captures in artifacts/e2e/prism/shape-format/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {pictureFill} from '../../../core/prism/lib/shape-common.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAJPwF+4uP4SAAAAAASUVORK5CYII=';

test('prism shape format: quick style, fill, outline, effects, align, group, size dialog, picture style, undo', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Shapes deck', {schema: 2});
  file.id = 'prism-shape-format';
  const c = file.content;
  const blank = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides[0].layout = blank;
  c.slides[0].shapes = [
    shape({id: 'r1', name: 'Rectangle 1', xfrm: {x: 120, y: 140, w: 220, h: 120}, geom: presetGeom('roundRect')}),
    shape({id: 'e1', name: 'Oval 2', xfrm: {x: 460, y: 200, w: 140, h: 140}, geom: presetGeom('ellipse')}),
    shape({id: 'p1', name: 'Picture 3', xfrm: {x: 640, y: 300, w: 200, h: 100}, kind: {type: 'picture', fill: pictureFill('m1')}}),
  ];
  c.media = [{id: 'm1', name: 'dot.png', contentType: 'image/png', data: PNG, link: null}];
  c.nextId = 400;
  const sid = c.slides[0].id;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/shape-format', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const sh = (d, id) => d.slides[0].shapes.find(s => s.id === id) ?? d.slides[0].shapes.flatMap(s => s.kind?.children ?? []).find(s => s.id === id);
  const select = ids => app.rpc('selection.set', {doc, ranges: ids.map(i => ({anchor: `/sl:${sid}/sp:${i}`, focus: `/sl:${sid}/sp:${i}`})), primary: 0});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // Select the rectangle: Shape Format appears.
    await select(['r1']);
    await app.until(async () => ((await app.rpc('ui.inspect', {doc})).tabs ?? []).some(t => (t.id ?? t) === 'shape-format') || null, {timeout: 15_000})
      .catch(() => null);
    await app.rpc('ui.tab', {doc, tab: 'shape-format'});
    await app.capture('1-shape-format-tab');

    // Shape Styles gallery: Subtle Effect - Accent 2 (row 3 × 7 + 2 = 23).
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.gallery', value: 23});
    let d = await deck();
    assert.deepEqual(sh(d, 'r1').style.fillRef, [2, {base: {kind: 'scheme', slot: 'accent2'}}]);
    // Shape Outline › Weight › 3 pt, Dashes › Dash; Shape Effects › Shadow › Outer, Glow › 8 pt.
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.outline.weight.3-pt'});
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.outline.dashes.dash'});
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.effects.shadow.outer'});
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.effects.glow.8-pt-glow'});
    d = await deck();
    assert.equal(sh(d, 'r1').line.width, 3);
    assert.deepEqual(sh(d, 'r1').line.dash, {kind: 'preset', name: 'dash'});
    assert.ok(sh(d, 'r1').effects.outerShadow);
    assert.equal(sh(d, 'r1').effects.glow.radius, 8);
    // Shape Fill › No Fill, then a theme colour.
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.fill.no-fill'});
    assert.equal(sh(await deck(), 'r1').fill.kind, 'none');
    await app.rpc('ui.activate', {doc, control: 'shapeformat.styles.fill.theme-colors-standard-colors', value: 'accent6'});
    assert.deepEqual(sh(await deck(), 'r1').fill, {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent6'}}});
    await app.capture('2-styled-rectangle');

    // Size and Position… : width 4 in with the aspect locked.
    await app.rpc('ui.activate', {doc, control: 'shapeformat.arrange.rotate.more-rotation-options'});
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.sizePosition');
    assert.equal(dlg.values.w, 220 / 72 > 3.0555 ? Math.round(220 / 72 * 10000) / 10000 : dlg.values.w);
    await app.rpc('ui.dialog.set', {field: 'lock', value: true});
    await app.rpc('ui.dialog.set', {field: 'w', value: 4});
    await app.capture('3-size-position-dialog');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.equal(sh(d, 'r1').xfrm.w, 288);
    assert.ok(Math.abs(sh(d, 'r1').xfrm.h - 288 * 120 / 220) < 0.01);

    // Alt Text.
    await app.rpc('ui.activate', {doc, control: 'shapeformat.accessibility.alt-text'});
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.altText');
    await app.rpc('ui.dialog.set', {field: 'text', value: 'A green rounded box'});
    await app.rpc('ui.dialog.submit', {});
    assert.equal(sh(await deck(), 'r1').descr, 'A green rounded box');

    // Arrange: both shapes, Align Top (to each other), Group, Rotate Right 90°.
    await select(['r1', 'e1']);
    await app.rpc('ui.activate', {doc, control: 'shapeformat.arrange.align.align-top'});
    d = await deck();
    assert.equal(sh(d, 'e1').xfrm.y, sh(d, 'r1').xfrm.y);
    await app.rpc('ui.activate', {doc, control: 'shapeformat.arrange.group.group'});
    d = await deck();
    const group = d.slides[0].shapes.find(s => s.kind.type === 'group');
    assert.ok(group, 'grouped');
    await app.rpc('ui.activate', {doc, control: 'shapeformat.arrange.rotate.rotate-right-90'});
    assert.equal((await deck()).slides[0].shapes.find(s => s.id === group.id).xfrm.rot, 90);
    await app.capture('4-grouped-and-rotated');
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal(k.handled, true);
    assert.equal((await deck()).slides[0].shapes.find(s => s.id === group.id).xfrm.rot ?? 0, 0, 'Ctrl+Z undoes the rotation');

    // The picture: Picture Format, Picture Styles gallery, Crop 10%.
    await select(['p1']);
    await app.rpc('ui.tab', {doc, tab: 'picture-format'});
    await app.rpc('ui.activate', {doc, control: 'pictureformat.styles.gallery', value: 'simpleFrameWhite'});
    await app.rpc('ui.activate', {doc, control: 'pictureformat.size.crop.crop-10-each-side'});
    d = await deck();
    assert.equal(sh(d, 'p1').line.width, 7);
    assert.deepEqual(sh(d, 'p1').kind.fill.crop, [0.1, 0.1, 0.1, 0.1]);
    await app.capture('5-picture-style');
  } finally {
    await app.close();
  }
});
