// U:prism/shape: every edit command of the family round-trips through undo/redo on a schema-2
// deck, runs over the bridge path, and keeps deckcraft's disabled reasons.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/shape.rs and shape/{appearance,size,
//    freeform,picture}.rs edit the targeted shapes (ids, else the selection) as one undo step each;
//    locked objects refuse geometry edits ("the object is locked"); nothing selected disables the
//    commands ("nothing selected"). PowerPoint's Shape Format and Picture Format do the same.
// 2. Ours: the same commands over the kernel change API (whole shapes written back), so undo
//    restores the exact document and selection.
// 3. Proved here; upstream tests in tests/prism/upstream/shape_tests.test.mjs; the ribbon path in
//    tests/e2e/prism/shape-format.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide, findShape} from '../../core/prism/model/presentation.mjs';
import {pictureFill} from '../../core/prism/lib/shape-common.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAJPwF+4uP4SAAAAAASUVORK5CYII=';

async function deck() {
  const c = createContent('Shape tests');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlide({id: 's1', layout})];
  c.media = [{id: 'm1', name: 'a.png', contentType: 'image/png', data: PNG, link: null}];
  const base = {name: '', geom: {kind: 'preset', name: 'rect'}, ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false,
    locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null};
  c.slides[0].shapes = [
    {...base, id: 'a', name: 'Rectangle 1', xfrm: {x: 100, y: 100, w: 200, h: 100}, kind: {type: 'shape'}},
    {...base, id: 'b', name: 'Oval 2', xfrm: {x: 400, y: 100, w: 100, h: 100}, kind: {type: 'shape'}, geom: {kind: 'preset', name: 'ellipse'}},
    {...base, id: 'p', name: 'Picture 3', xfrm: {x: 100, y: 300, w: 160, h: 80}, kind: {type: 'picture', fill: pictureFill('m1')}},
    {...base, id: 'v', name: 'Video 4', xfrm: {x: 500, y: 300, w: 160, h: 90}, kind: {type: 'media', media: 'm1', video: true, poster: null, crop: [0, 0, 0, 0],
      trimStartMs: 0, trimEndMs: 0, fadeInMs: 0, fadeOutMs: 0, volume: 1, autoplay: false, loopPlay: false, rewind: false, playAcrossSlides: false,
      hideWhileNotPlaying: false, fullScreen: false, bookmarks: [], durationMs: 0, width: 0, height: 0}},
  ];
  c.nextId = 300;
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:s1/sp:a', focus: '/sl:s1/sp:a'}], primary: 0}});
}
const sh = (r, id) => findShape(r.content.slides[0].shapes, id);
const sel = (t, ids) => t.session.setSelection(t.docId, {ranges: ids.map(i => ({anchor: `/sl:s1/sp:${i}`, focus: `/sl:s1/sp:${i}`})), primary: 0});

test('geometry commands round-trip: move, resize, setBounds, rotate, flip, adjust, change, smoothCorners', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'shape.move', {dx: 10, dy: -5}, r => assert.deepEqual([sh(r, 'a').xfrm.x, sh(r, 'a').xfrm.y], [110, 95]));
  await expectUndoRoundTrip(t, 'shape.move', {x: 0, y: 0, ids: ['b']}, r => assert.deepEqual([sh(r, 'b').xfrm.x, sh(r, 'b').xfrm.y], [0, 0]));
  await expectUndoRoundTrip(t, 'shape.resize', {w: 300, lockAspect: true}, r => assert.deepEqual([sh(r, 'a').xfrm.w, sh(r, 'a').xfrm.h], [300, 150]));
  await expectUndoRoundTrip(t, 'shape.setBounds', {x: 1, y: 2, w: 3, h: 4}, r => assert.deepEqual(sh(r, 'a').xfrm, {x: 1, y: 2, w: 3, h: 4}));
  await expectUndoRoundTrip(t, 'shape.rotate', {deg: 45}, r => assert.equal(sh(r, 'a').xfrm.rot, 45));
  await expectUndoRoundTrip(t, 'shape.flip', {axis: 'vertical'}, r => assert.equal(sh(r, 'a').xfrm.flipV, true));
  await expectUndoRoundTrip(t, 'shape.change', {preset: 'roundRect'}, r => assert.deepEqual(sh(r, 'a').geom, {kind: 'preset', name: 'roundRect'}));
  await expectUndoRoundTrip(t, 'shape.adjust', {index: 1, value: 5000, ids: ['a']}, r => assert.deepEqual(sh(r, 'a').geom.adj, [16667, 5000], 'missing values take the preset defaults'));
  await expectUndoRoundTrip(t, 'shape.smoothCorners', {smoothing: 60}, r => {
    const g = sh(r, 'a').geom;
    assert.equal(g.kind, 'custom');
    assert.equal(g.paths[0].w, 3, 'the squircle is drawn at the shape size');
  });
  await assert.rejects(t.exec('shape.change', {preset: 'nope'}), /unknown preset `nope`/);
  await assert.rejects(t.exec('shape.smoothCorners', {smoothing: 50, ids: ['b']}), /only rectangles/);
});

test('locked objects refuse geometry but take formatting; a group locks with its members', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'shape.lock', {}, r => assert.equal(sh(r, 'a').locked, true));
  await assert.rejects(t.exec('shape.move', {dx: 5}), /the object is locked/);
  await t.exec('shape.fill', {color: 'accent2'});
  assert.deepEqual(sh(t, 'a').fill, {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent2'}}});
  await t.exec('shape.lock', {locked: false});
  await t.exec('shape.move', {dx: 5});
  assert.equal(sh(t, 'a').xfrm.x, 105);
});

test('appearance commands round-trip: fill (colour, gradient, pattern, picture, transparency), line, effects, quick style', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'shape.fill', {color: {scheme: 'accent1', lumOff: 40000, lumMod: 60000}}, r => assert.deepEqual(sh(r, 'a').fill.color.mods,
    [{op: 'lumMod', val: 60000}, {op: 'lumOff', val: 40000}]));
  await expectUndoRoundTrip(t, 'shape.fill', {gradient: {stops: [[1, '#000000'], [0, '#ffffff']], angle: 450}}, r => {
    const f = sh(r, 'a').fill;
    assert.equal(f.kind, 'gradient');
    assert.deepEqual(f.stops.map(s => s.pos), [0, 1]);
    assert.deepEqual(f.shape, {kind: 'linear', angle: 90, scaled: false});
  });
  await assert.rejects(t.exec('shape.fill', {gradient: {stops: [[0, '#fff']]}}), /at least two `stops`/);
  await expectUndoRoundTrip(t, 'shape.fill', {pattern: {preset: 'ltDnDiag'}}, r => assert.equal(sh(r, 'a').fill.preset, 'ltDnDiag'));
  await expectUndoRoundTrip(t, 'shape.fill', {picture: PNG, name: 'b.png'}, r => {
    assert.equal(sh(r, 'a').fill.kind, 'picture');
    assert.equal(sh(r, 'a').fill.media, 'm1', 'the same bytes reuse their media item');
  });
  await t.exec('shape.fill', {color: '#336699'});
  await expectUndoRoundTrip(t, 'shape.fill', {transparency: 0.25}, r => assert.deepEqual(sh(r, 'a').fill.color.mods, [{op: 'alpha', val: 75000}]));
  await assert.rejects(t.exec('shape.fill', {}), /give `color`/);
  await expectUndoRoundTrip(t, 'shape.line', {width: 2, head: 'triangle', headSize: 'lg', compound: 'double', cap: 'round', join: 'miter'}, r => {
    const l = sh(r, 'a').line;
    assert.equal(l.width, 2);
    assert.deepEqual(l.fill, {kind: 'solid', color: {base: {kind: 'scheme', slot: 'tx1'}}}, 'a width alone gives the outline Text 1');
    assert.deepEqual(l.head, {kind: 'triangle', w: 'lg', len: 'lg'});
    assert.deepEqual([l.compound, l.cap, l.join], ['double', 'round', 'miter']);
  });
  await expectUndoRoundTrip(t, 'shape.effects', {shadow: 'perspective', glow: 11, softEdges: 5, reflection: 'half'}, r => {
    const e = sh(r, 'a').effects;
    assert.equal(e.outerShadow.align, 'bl');
    assert.equal(e.glow.radius, 11);
    assert.equal(e.softEdge, 5);
    assert.equal(e.reflection.endPos, 0.55);
  });
  await expectUndoRoundTrip(t, 'shape.effects', {shadowProps: {transparency: 0.5, blur: 10}}, r => {
    const e = sh(r, 'a').effects.outerShadow;
    assert.equal(e.blur, 10);
    assert.deepEqual(e.color.mods, [{op: 'alpha', val: 50000}]);
  });
  // Bevel and 3-D are kept as sp3d/scene3d XML (core/prism/lib/three-d.mjs; tests/prism/format-tabs.test.mjs).
  await expectUndoRoundTrip(t, 'shape.effects', {bevel: 'circle'}, r => assert.equal(sh(r, 'a').effects.bevel, 'circle'));
  await expectUndoRoundTrip(t, 'shape.quickStyle', {index: 16}, r => {
    const s = sh(r, 'a');
    assert.deepEqual(s.style.fillRef, [1, {base: {kind: 'scheme', slot: 'accent2'}, mods: [{op: 'lumMod', val: 20000}, {op: 'lumOff', val: 80000}]}]);
    assert.equal(s.line.fill.kind, 'none');
    assert.equal(s.effects, null);
  });
  const st = t.state('shape.quickStyle', {});
  assert.equal(st.value.length, 42);
});

test('names, alt text, visibility and Set as Default Shape', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'shape.rename', {name: 'Logo'}, r => assert.equal(sh(r, 'a').name, 'Logo'));
  await expectUndoRoundTrip(t, 'shape.altText', {text: 'A red box', decorative: true}, r => assert.deepEqual([sh(r, 'a').descr, sh(r, 'a').decorative], ['A red box', true]));
  await expectUndoRoundTrip(t, 'shape.visible', {visible: false}, r => assert.equal(sh(r, 'a').hidden, true));
  await t.exec('shape.fill', {color: '#00aa00'});
  const v = t.version;
  await t.exec('shape.setDefault', {});
  assert.equal(t.version, v, 'Set as Default Shape changes no document');
  const id = (await t.exec('shape.insert', {preset: 'ellipse', rect: [10, 10, 50, 50]})).result.id;
  assert.deepEqual(sh(t, id).fill, {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 0, g: 170, b: 0, a: 255}}}}, 'new shapes take the default look');
});

test('pictures: crop, corrections, reset, change; media playback options', async () => {
  const t = await deck();
  sel(t, ['p']);
  await expectUndoRoundTrip(t, 'picture.crop', {left: 0.1, right: 2}, r => assert.deepEqual(sh(r, 'p').kind.fill.crop, [0.1, 0, 0.95, 0]));
  await expectUndoRoundTrip(t, 'picture.adjust', {brightness: 0.4, contrast: -2, saturation: 0, grayscale: true, transparency: 0.3}, r => {
    const f = sh(r, 'p').kind.fill;
    assert.deepEqual([f.adjust.brightness, f.adjust.contrast, f.adjust.saturation, f.adjust.grayscale, f.alpha], [0.4, -1, 0, true, 0.7]);
  });
  await t.exec('picture.crop', {top: 0.2});
  await t.exec('shape.line', {width: 4});
  await expectUndoRoundTrip(t, 'picture.reset', {}, r => {
    const s = sh(r, 'p');
    assert.deepEqual(s.kind.fill.crop, [0, 0, 0, 0]);
    assert.equal(s.line, null);
  });
  const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  await expectUndoRoundTrip(t, 'picture.change', {data: GIF, name: 'dot.gif'}, r => {
    const m = r.content.media.find(x => x.id === sh(r, 'p').kind.fill.media);
    assert.equal(m.contentType, 'image/gif');
  });
  sel(t, ['v']);
  await expectUndoRoundTrip(t, 'media.options', {autoplay: true, loop: true, volume: 2, trimStart: 1000, fadeOut: 500}, r => {
    const m = sh(r, 'v').kind;
    assert.deepEqual([m.autoplay, m.loopPlay, m.volume, m.trimStartMs, m.fadeOutMs], [true, true, 1, 1000, 500]);
  });
});

test('connectors, connection sites and freeforms', async () => {
  const t = await deck();
  const sites = (await t.exec('shape.sites', {id: 'a'})).result;
  assert.deepEqual(sites[0], [200, 100], 'the top middle of the rectangle');
  const r = await expectUndoRoundTrip(t, 'shape.connect', {from: 'a', to: 'b'}, rd => {
    const c = rd.content.slides[0].shapes.at(-1);
    assert.equal(c.kind.type, 'connector');
    assert.deepEqual([c.kind.start[0], c.kind.end[0]], ['a', 'b']);
  });
  assert.equal(r.result.fromSite, 3, 'right side of a');
  const bSites = (await t.exec('shape.sites', {id: 'b'})).result;
  const c = t.content.slides[0].shapes.at(-1);
  assert.deepEqual([c.xfrm.x + c.xfrm.w, c.xfrm.y + c.xfrm.h], bSites[r.result.toSite], 'the connector ends on the chosen site of b');
  await assert.rejects(t.exec('shape.connect', {from: 'a', to: 'zz'}), /connection sites/);
  const f = await expectUndoRoundTrip(t, 'shape.freeform', {points: [[10, 10], [60, 10], [35, 50]], closed: true, smooth: true}, rd => {
    const s = rd.content.slides[0].shapes.at(-1);
    assert.equal(s.geom.kind, 'custom');
    assert.match(s.geom.paths[0].d, /^M 0 0 C .* Z$/);
    assert.equal(s.geom.paths[0].fill, 'norm');
    assert.deepEqual(s.xfrm, {x: 10, y: 10, w: 50, h: 40});
  });
  assert.ok(f.result.id);
  await assert.rejects(t.exec('shape.freeform', {points: [[1, 1]]}), /at least two points/);
});

test('bridge path validates params and the selection gate gives deckcraft reasons', async () => {
  const t = await deck();
  await assert.rejects(t.bridge('shape.move', {dx: 'far'}), e => e.code === 'invalid_params');
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0});
  for (const id of ['shape.move', 'shape.fill', 'shape.line', 'shape.effects', 'shape.rotate', 'picture.crop']) {
    assert.deepEqual(t.state(id, {}), {enabled: false, reason: 'nothing selected'}, id);
  }
  await assert.rejects(t.bridge('shape.fill', {color: 'red'}), e => e.code === 'disabled' && /nothing selected/.test(e.message));
});

test('Trim Media dialog (body.rs dlg_trim, trim.rs): seeded in seconds from the clip, OK writes milliseconds', async () => {
  const dialog = (await import('../../core/prism/dialogs/trim.mjs')).default;
  const {secondsToMs} = await import('../../core/prism/dialogs/trim.mjs');
  const {submitDialog, openDialogModel} = await import('../../core/kernel/dialog.mjs');
  assert.deepEqual([secondsToMs('1.5'), secondsToMs(-2), secondsToMs('x'), secondsToMs(1e12)], [1500, 0, 0, 4294967295]);
  const t = await deck();
  sel(t, ['v']);
  await t.exec('media.options', {trimStart: 2000, fadeOut: 500});
  const v = openDialogModel(t.session, t.docId, dialog);
  assert.deepEqual(v, {start: 2, end: 0, fin: 0, fout: 0.5});
  await submitDialog(t.session, t.docId, dialog, {...v, end: 3.25, fin: 1});
  const m = findShape(t.content.slides[0].shapes, 'v').kind;
  assert.deepEqual([m.trimStartMs, m.trimEndMs, m.fadeInMs, m.fadeOutMs], [2000, 3250, 1000, 500]);
  sel(t, ['a']);
  assert.deepEqual(openDialogModel(t.session, t.docId, dialog), {start: 0, end: 0, fin: 0, fout: 0}, 'no clip selected: zeros');
});
