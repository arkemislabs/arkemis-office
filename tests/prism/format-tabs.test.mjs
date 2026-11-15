// U:prism/format-tabs: the Picture Format, Shape Format and Home pieces that were hidden until now.
//
// 1. What deckcraft does: cmd/recolor.rs, background.rs and artistic.rs (picture recolor, Remove Background,
//    Artistic Effects), cmd/three_d.rs and shape/appearance.rs (Bevel and 3-D as kept sp3d/scene3d XML),
//    app/commands.rs view.gridOptions, panels/selpane.rs (the Selection pane's rows and drop target) and
//    panels.rs (the Format Shape pane).
// 2. Ours: core/prism/lib/{raster,three-d}.mjs, commands/{picture_pixels,view_grid,panes}.mjs, panes/selection.tsx.
// 3. Proved here; the panes and the drawn effects in tests/e2e/prism/format-tabs.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {pictureFill, base64Encode} from '../../core/prism/lib/shape-common.mjs';
import {encodePng, decodePng, matte, applyEffect, EFFECTS} from '../../core/prism/lib/raster.mjs';
import {parse3d, to3dXml, apply3d, flat3d, BEVELS} from '../../core/prism/lib/three-d.mjs';

/** A red disc on a white-to-grey gradient (deckcraft background.rs `disc`). */
function disc(w = 80, h = 60) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - w / 2, dy = y - h / 2, i = (y * w + x) * 4;
    if (dx * dx + dy * dy < 15 * 15) data.set([220, 30, 30, 255], i);
    else { const g = 255 - Math.round((x / w) * 20); data.set([g, g, g, 255], i); }
  }
  return {width: w, height: h, data};
}
const shapeBox = (id, name, kind, x = 10) => ({id, name, xfrm: {x, y: 10, w: 200, h: 100}, kind, geom: {kind: 'preset', name: 'rect'}, ph: null, fill: null, line: null, effects: null,
  style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null});

async function session({host} = {}) {
  const c = createContent('Format tabs');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const png = await encodePng(disc());
  c.media = [{id: 'm1', name: 'disc.png', contentType: 'image/png', data: base64Encode(png), link: null}];
  c.slides = [newSlide({id: 's1', layout, shapes: [shapeBox('p', 'Picture 1', {type: 'picture', fill: pictureFill('m1')}), shapeBox('b', 'Box', {type: 'shape'}, 300)]})];
  return createTestSession('prism', {content: c, host, selection: {ranges: [{anchor: '/sl:s1/sp:p', focus: '/sl:s1/sp:p'}], primary: 0}});
}
const live = t => t.session.get(t.docId).file.content;
const pic = c => c.slides[0].shapes[0];
const box = c => c.slides[0].shapes[1];
const after = r => r.content ?? r;

test('raster: a PNG written by encodePng reads back pixel for pixel; junk is refused', async () => {
  const img = disc(33, 17);
  const back = await decodePng(await encodePng(img));
  assert.equal(back.width, 33);
  assert.deepEqual([...back.data], [...img.data]);
  assert.equal(await decodePng(new Uint8Array([1, 2, 3])), null);
});

test('raster: the matte clears the background the edges reach and leaves the subject (background.rs)', () => {
  const img = disc();
  const n = matte(img, 20);
  assert.ok(n > 80 * 60 - 15 * 15 * 4, `cleared ${n}`);
  assert.equal(img.data[3], 0, 'the corner is transparent');
  assert.equal(img.data[(30 * 80 + 40) * 4 + 3], 255, 'the subject stays opaque');
  // A picture with nothing but subject at its edges is left alone.
  const flat = {width: 10, height: 10, data: new Uint8ClampedArray(400)};
  for (let i = 0; i < 100; i++) flat.data.set([10, 200, 10, 255], i * 4);
  assert.equal(matte(flat, 20), 0);
  assert.ok(flat.data.every((v, i) => i % 4 !== 3 || v === 255));
});

test('raster: every artistic effect returns a picture of the same size and keeps the alpha', () => {
  const img = disc(40, 30);
  img.data[3] = 77;
  for (const [id] of EFFECTS) {
    const out = applyEffect(id, img);
    assert.equal(out.width, 40, id);
    if (id !== 'artisticBlur') assert.equal(out.data[3], 77, `${id} keeps alpha`); // deckcraft's blur softens the alpha with the colours
  }
  assert.equal(applyEffect('artisticNope', img), null);
  assert.notDeepEqual([...applyEffect('artisticCutout', img).data], [...img.data]);
});

test('picture.recolor sets grayscale, a duotone or black and white, one at a time, and a recolor after Washout clears it', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'picture.recolor', {preset: 'grayscale'}, r => assert.equal(pic(after(r)).kind.fill.adjust.grayscale, true));
  await t.exec('picture.recolor', {preset: 'sepia'});
  let a = pic(live(t)).kind.fill.adjust;
  assert.equal(a.grayscale, false);
  assert.equal(a.duotone.length, 2);
  await t.exec('picture.recolor', {preset: 'bw50'});
  a = pic(live(t)).kind.fill.adjust;
  assert.equal(a.bilevel, 0.5);
  assert.equal(a.duotone, null);
  await t.exec('picture.recolor', {preset: 'washout'});
  a = pic(live(t)).kind.fill.adjust;
  assert.deepEqual([a.brightness, a.contrast, a.bilevel], [0.7, -0.7, undefined]);
  await t.exec('picture.recolor', {preset: 'accent2Dark'});
  a = pic(live(t)).kind.fill.adjust;
  assert.deepEqual([a.brightness, a.contrast], [0, 0]);
  assert.equal(a.duotone[1].base.slot, 'accent2');
  await assert.rejects(t.exec('picture.recolor', {preset: 'plaid'}), /unknown preset `plaid`/);
  assert.equal((await t.exec('picture.recolors', {})).result.length, 7 + 14);
  const st = t.state('picture.recolor', {});
  assert.equal(st.value.length, 21);
  assert.equal(st.value[2].art.colors.length, 2);
});

test('picture.transparentColor sets and clears the colour made transparent', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'picture.transparentColor', {color: '#FF00FF'}, r => assert.deepEqual(pic(after(r)).kind.fill.adjust.clearColor, {r: 255, g: 0, b: 255, a: 255}));
  await t.exec('picture.transparentColor', {none: true});
  assert.equal(pic(live(t)).kind.fill.adjust.clearColor, null);
  await assert.rejects(t.exec('picture.transparentColor', {color: 'blue'}), /bad colour/);
});

test('picture.removeBackground replaces the picture with a matted PNG and undoes; a shape is refused', async () => {
  const t = await session();
  await t.exec('picture.removeBackground', {});
  const f = pic(live(t)).kind.fill;
  assert.notEqual(f.media, 'm1');
  const m = live(t).media.find(x => x.id === f.media);
  assert.equal(m.name, 'disc-no-background.png');
  const back = await decodePng(Uint8Array.from(Buffer.from(m.data, 'base64')));
  assert.equal(back.data[3], 0);
  await t.session.undo(t.docId);
  assert.equal(pic(live(t)).kind.fill.media, 'm1');
  await t.exec('selection.select', {id: 'b'});
  await assert.rejects(t.exec('picture.removeBackground', {}), /select a picture/);
});

test('picture.artisticEffect keeps the original, changes the effect from it and None restores it', async () => {
  const t = await session();
  const f = () => pic(live(t)).kind.fill;
  await t.exec('picture.artisticEffect', {effect: 'artisticCutout'});
  assert.deepEqual(f().artistic, {effect: 'artisticCutout', original: 'm1'});
  assert.notEqual(f().media, 'm1');
  await t.exec('picture.artisticEffect', {effect: 'artisticBlur'});
  assert.equal(f().artistic.original, 'm1', 'the original is kept across a change of effect');
  await t.exec('picture.artisticEffect', {effect: 'none'});
  assert.deepEqual([f().media, f().artistic], ['m1', undefined]);
  await assert.rejects(t.exec('picture.artisticEffect', {effect: 'sparkle'}), /`effect` is none or one of/);
  assert.equal(t.state('picture.artisticEffect', {}).value.length, 1 + EFFECTS.length);
});

test('a picture the app cannot decode is refused by Remove Background, and the host decodes other formats', async () => {
  const mk = () => {
    const c = createContent('Jpeg');
    const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
    c.media = [{id: 'j', name: 'photo.jpg', contentType: 'image/jpeg', data: base64Encode(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])), link: null}];
    c.slides = [newSlide({id: 's1', layout, shapes: [shapeBox('p', 'Picture 1', {type: 'picture', fill: pictureFill('j')})]})];
    return c;
  };
  const selection = {ranges: [{anchor: '/sl:s1/sp:p', focus: '/sl:s1/sp:p'}], primary: 0};
  const bare = await createTestSession('prism', {content: mk(), selection});
  await assert.rejects(bare.exec('picture.removeBackground', {}), /format can't be processed/);
  let called = 0;
  const host = createTestHost({decodeImage: async () => { called++; return disc(); }});
  const t = await createTestSession('prism', {content: mk(), host, selection});
  await t.exec('picture.removeBackground', {});
  assert.equal(called, 1);
});

test('three-d: bevels and 3-D settings are kept as XML and read back (three_d.rs)', () => {
  const s = flat3d();
  apply3d(s, {bevelTop: 'artDeco', bevelTopW: 10, bevelTopH: 3});
  const xml = to3dXml(s);
  assert.match(xml, /<a:bevelT w="127000" h="38100" prst="artDeco"\/>/);
  const back = parse3d(xml);
  assert.deepEqual(back.top, {preset: 'artDeco', w: 10, h: 3});
  assert.equal(to3dXml(flat3d()), null, 'a flat shape has no 3-D XML');
  // A preset camera sets its own angles; a value outside the format's lists is not written back.
  apply3d(back, {rotX: 10, rotY: 20});
  apply3d(back, {camera: 'isometricTopUp'});
  assert.equal(back.rot, null);
  const evil = parse3d('<a:scene3d><a:camera prst="x&quot;/&gt;&lt;a:evil/&gt;"/><a:lightRig rig="bad" dir="zz"/></a:scene3d><a:sp3d prstMaterial="nope"><a:bevelT w="25400" h="25400" prst="bad"/></a:sp3d>');
  assert.deepEqual([evil.camera, evil.light, evil.lightDir, evil.material, evil.top.preset], ['orthographicFront', 'threePt', 't', 'warmMatte', 'circle']);
  assert.ok(!to3dXml(evil).includes('evil'));
  assert.equal(BEVELS.length, 12);
});

test('shape.effects {bevel} and {threeD} write the kept XML and keep the bevel preset in step; Reset clears them', async () => {
  const t = await session();
  await t.exec('selection.select', {id: 'b'});
  await t.exec('shape.effects', {bevel: 'relaxedInset'});
  assert.equal(box(live(t)).effects.bevel, 'relaxedInset');
  assert.match(box(live(t)).effects.raw3d, /<a:bevelT w="76200" h="76200" prst="relaxedInset"\/>/);
  await t.exec('shape.effects', {threeD: {bevelTopW: 12}});
  assert.match(box(live(t)).effects.raw3d, /w="152400"/);
  await t.exec('shape.effects', {bevel: 'none'});
  assert.equal(box(live(t)).effects.raw3d, null);
  await t.exec('shape.effects', {bevel: 'circle', shadow: 'outer'});
  await t.exec('shape.effects', {threeD: {reset: true}});
  const e = box(live(t)).effects;
  assert.deepEqual([e.bevel, e.raw3d, !!e.outerShadow], [null, null, true]);
  await t.session.undo(t.docId);
  assert.equal(box(live(t)).effects.bevel, 'circle');
});

test('shape.fill {pick} asks the system Open dialog; Cancel changes nothing', async () => {
  const png = await encodePng(disc(4, 4));
  let ask = 0, answer = `data:image/png;base64,${base64Encode(png)}`;
  const host = createTestHost({pickImage: async () => { ask++; return answer; }});
  const t = await session({host});
  await t.exec('selection.select', {id: 'b'});
  await t.exec('shape.fill', {pick: true}, {origin: 'ui'});
  assert.equal(ask, 1);
  assert.equal(box(live(t)).fill.kind, 'picture');
  await t.exec('shape.fill', {reset: true});
  answer = '';
  await t.exec('shape.fill', {pick: true}, {origin: 'ui'});
  assert.equal(box(live(t)).fill, null);
  await assert.rejects(t.exec('shape.fill', {pick: true}, {origin: 'bridge'}), /give `picture`/);
});

test('picture.change asks the system Open dialog from the ribbon and refuses what is not a picture', async () => {
  const png = await encodePng(disc(4, 4));
  const host = createTestHost({pickImage: async () => `data:image/png;base64,${base64Encode(png)}`});
  const t = await session({host});
  await t.exec('picture.change', {}, {origin: 'ui'});
  assert.notEqual(pic(live(t)).kind.fill.media, 'm1');
  await assert.rejects(t.exec('picture.change', {data: base64Encode(Uint8Array.from([1, 2, 3, 4])), name: 'x.bin'}), /is not a picture/);
});

test('view.gridOptions sets the spacing, snapping and what is drawn, or reports them (grid_options.rs)', async () => {
  const t = await session();
  const r = (await t.exec('view.gridOptions', {spacing: 72, snap: false, smartGuides: false, gridlines: true, guides: true})).result;
  assert.deepEqual(r, {spacing: 72, snap: false, smartGuides: false, gridlines: true, guides: true});
  assert.equal(t.session.prefs.prism.gridSpacing, 72);
  assert.deepEqual((await t.exec('view.gridOptions', {snap: true})).result, {spacing: 72, snap: true, smartGuides: false, gridlines: true, guides: true});
  for (const bad of [{spacing: 0}, {spacing: 289}, {spacing: '72'}, {spacing: null}, {snap: 1}]) await assert.rejects(t.exec('view.gridOptions', bad), /spacing|snap/);
  assert.equal(t.session.prefs.prism.gridSpacing, 72);
  assert.equal(live(t).guides.length, 2, 'Display drawing guides adds the two centre guides');
  assert.equal((await t.exec('view.gridOptions', {})).result.spacing, 72);
});

test('pane.toggle opens the Selection pane and the Format Shape pane on a tab, and a tab on an open pane keeps it open', async () => {
  const t = await session();
  const view = () => t.session.get(t.docId).view ?? {};
  await t.exec('pane.toggle', {pane: 'selection'});
  assert.equal(view().panes.selection, true);
  await t.exec('pane.toggle', {pane: 'format', tab: 'effects'});
  assert.deepEqual([view().panes.format, view().formatTab], [true, 'effects']);
  await t.exec('pane.toggle', {pane: 'format', tab: 'size'});
  assert.deepEqual([view().panes.format, view().formatTab], [true, 'size'], 'More Options… on an open pane shows the tab and does not close it');
  await t.exec('pane.toggle', {pane: 'format'});
  assert.equal(view().panes.format, false);
  await assert.rejects(t.exec('pane.toggle', {pane: 'format', tab: 'nope'}), /tab/);
});

test('section.collapseAll and expandAll fold every section of the slide pane; a header folds its own (view state, not undoable)', async () => {
  const t = await session();
  const view = () => t.session.get(t.docId).view ?? {};
  assert.equal(t.state('section.collapseAll', {}).enabled, false, 'no sections yet');
  await assert.rejects(t.exec('section.collapseAll', {}), /no sections/);
  await t.exec('section.add', {at: 0});
  assert.equal(t.state('section.collapseAll', {}).enabled, true);
  const key = String(live(t).sections[0].slides[0]);
  await t.exec('section.collapseAll', {});
  assert.deepEqual(view().foldedSections, [key]);
  await t.exec('section.toggleFold', {index: 0});
  assert.deepEqual(view().foldedSections, []);
  await t.exec('section.toggleFold', {index: 0, on: true});
  assert.deepEqual(view().foldedSections, [key]);
  await t.exec('section.expandAll', {});
  assert.deepEqual(view().foldedSections, []);
  await assert.rejects(t.exec('section.toggleFold', {index: 5}), /no such section/);
  const before = JSON.stringify(live(t));
  await t.exec('section.collapseAll', {});
  assert.equal(JSON.stringify(live(t)), before, 'folding changes nothing in the presentation');
});
