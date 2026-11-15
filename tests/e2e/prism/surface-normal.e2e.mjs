// Prism surface, Normal view (F:prism foundation; docs/architecture.md 16.3, 17.5).
//
// What deckcraft does: the canvas sends pointer gestures to Session::pointer (crates/engine/src/
// tools/pointer.rs), one undo step per gesture, labelled "Move", "Size", "Rotate", "Adjust Shape",
// "Duplicate"; the thumbnail pane lists every slide and follows the current one
// (crates/ui-egui/src/panels/thumbs.rs). PowerPoint behaves the same: drag moves with smart guides,
// handles resize, the round handle rotates, the yellow handle reshapes, Alt-drag (Ctrl-drag in
// PowerPoint) leaves a copy, a drag on empty slide selects by marquee.
// What this proves, end to end in the real app (new shell, test mode, no OS input): a schema-2
// deck opens in the surface; `surface.pointer` gestures from the bridge (the deckcraft control
// channel's `ui.pointer`) move, resize, rotate, adjust, duplicate and marquee-select, each one undo
// entry "Automation: <label>" read back through document.read and selection.get; ui.key Ctrl+Z (the
// KeyRouter) undoes; the window is captured after each step (artifacts/e2e/prism/surface-normal/).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {newSlide, layoutOfKind} from '../../../core/prism/model/defaults.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {boxHandles} from '../../../core/prism/lib/pointer.mjs';

function seed() {
  const file = createFile('prism', 'Surface deck', {schema: 2});
  file.id = 'prism-surface';
  const c = file.content;
  const s1 = c.slides[0];
  s1.shapes[0].text = bodyFromText('Quarterly review');
  s1.shapes[1].text = bodyFromText('Prism surface, Normal view');
  const fill = rgb => fillSolid(colorRgb({r: rgb[0], g: rgb[1], b: rgb[2], a: 255}));
  const made = newSlide(c, layoutOfKind(c, 'titleOnly') ?? c.slides[0].layout);
  const s2 = made.slide;
  c.nextId = made.nextId;
  s2.shapes[0].text = bodyFromText('Shapes');
  s2.shapes.push(shape({id: 'r1', name: 'Rectangle 1', xfrm: {x: 120, y: 200, w: 200, h: 120}, geom: presetGeom('rect'), fill: fill([68, 114, 196]),
    text: bodyFromText('Move me')}));
  s2.shapes.push(shape({id: 'r2', name: 'Rounded Rectangle 2', xfrm: {x: 520, y: 220, w: 220, h: 140}, geom: presetGeom('roundRect'), fill: fill([237, 125, 49])}));
  c.slides.push(s2);
  c.nextId = Math.max(c.nextId, 400);
  return {file, s1: s1.id, s2: s2.id};
}

test('prism surface: Normal view, pointer gestures from the bridge, undo, captures', {timeout: 240_000}, async () => {
  const {file, s1, s2} = seed();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/surface-normal', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    // Opening fits the slide to the window (deckcraft: zoom None = fit).
    await app.until(async () => (await app.rpc('ui.inspect', {doc})).zoom?.fit === 'fit' || (await app.rpc('ui.inspect', {doc})).view?.fit === 'fit' || null, {timeout: 10_000}).catch(() => {});
    await app.capture('1-title-slide');

    // The second slide becomes current (the thumbnail click's selection).
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s2}`, focus: `/sl:${s2}`}]});
    await new Promise(r => setTimeout(r, 300));
    await app.capture('2-shapes-slide');

    const xf = async id => (await app.rpc('document.read', {doc, address: `/sl:${s2}/sp:${id}`, as: 'json'})).value.xfrm;
    const gesture = (events, label) => app.rpc('engine.execute', {doc, command: 'surface.pointer', params: {events, tol: 4}}).then(r => {
      if (label) assert.equal(r.undoLabel, `Automation: ${label}`, `undo label of ${label}`);
      return r;
    });

    // Move: press inside r1, drag by (61, 37), release. Snapping to the 6 pt grid / smart guides applies.
    await gesture([{kind: 'down', x: 220, y: 260}, {kind: 'drag', x: 250, y: 280}, {kind: 'drag', x: 281, y: 297}, {kind: 'up', x: 281, y: 297}], 'Move');
    let x = await xf('r1');
    assert.ok(Math.abs(x.x - 180) <= 6 && Math.abs(x.y - 237) <= 6, `moved: ${JSON.stringify(x)}`);
    let sel = (await app.rpc('selection.get', {doc})).selection;
    assert.deepEqual(sel.ranges.map(r => r.anchor), [`/sl:${s2}/sp:r1`]);
    await app.capture('3-after-move');

    // Resize from the SE handle.
    const before = await xf('r1');
    const se = boxHandles(before).pts[4];
    await gesture([{kind: 'down', x: se.x, y: se.y}, {kind: 'drag', x: se.x + 40, y: se.y + 30}, {kind: 'up', x: se.x + 40, y: se.y + 30}], 'Size');
    x = await xf('r1');
    assert.ok(x.w > before.w + 30 && x.h > before.h + 20, `resized: ${JSON.stringify(x)}`);
    assert.equal(x.x, before.x);

    // Rotate with the rotate handle (Shift: 15° steps).
    const {rot} = boxHandles(x);
    const cx = x.x + x.w / 2, cy = x.y + x.h / 2;
    const r = Math.hypot(rot.x - cx, rot.y - cy);
    const to = {x: cx + r * Math.sin(Math.PI / 6), y: cy - r * Math.cos(Math.PI / 6)};
    await gesture([{kind: 'down', x: rot.x, y: rot.y}, {kind: 'drag', x: to.x, y: to.y, mods: {shift: true}}, {kind: 'up', x: to.x, y: to.y, mods: {shift: true}}], 'Rotate');
    x = await xf('r1');
    assert.equal(x.rot, 30, `rotated: ${JSON.stringify(x)}`);
    await app.capture('4-after-resize-rotate');

    // The rounded rectangle's yellow adjust handle.
    await gesture([{kind: 'down', x: 600, y: 300}, {kind: 'up', x: 600, y: 300}]);
    const rr = await xf('r2');
    const shapeR2 = (await app.rpc('document.read', {doc, address: `/sl:${s2}/sp:r2`, as: 'json'})).value;
    assert.equal(shapeR2.geom.adj, undefined);
    // roundRect's handle sits on the top edge at x = adj × min(w, h) (default 16 667).
    const hx = rr.x + (16667 / 100000) * Math.min(rr.w, rr.h), hy = rr.y;
    await gesture([{kind: 'down', x: hx, y: hy}, {kind: 'drag', x: hx + 30, y: hy}, {kind: 'up', x: hx + 30, y: hy}], 'Adjust Shape');
    const adj = (await app.rpc('document.read', {doc, address: `/sl:${s2}/sp:r2`, as: 'json'})).value.geom.adj;
    assert.ok(Array.isArray(adj) && adj[0] > 30000, `adjusted: ${JSON.stringify(adj)}`);

    // Alt-drag leaves a copy.
    const count = async () => (await app.rpc('document.read', {doc, address: `/sl:${s2}`, as: 'json'})).value.shapes.length;
    const n0 = await count();
    await gesture([{kind: 'down', x: 640, y: 320, mods: {alt: true}}, {kind: 'drag', x: 660, y: 400, mods: {alt: true}}, {kind: 'up', x: 660, y: 400, mods: {alt: true}}], 'Duplicate');
    assert.equal(await count(), n0 + 1);

    // Marquee over the whole slide selects every unlocked shape.
    await gesture([{kind: 'down', x: 5, y: 5}, {kind: 'drag', x: 955, y: 535}, {kind: 'up', x: 955, y: 535}]);
    sel = (await app.rpc('selection.get', {doc})).selection;
    assert.ok(sel.ranges.length >= 4, `marquee selected ${sel.ranges.length}`);
    await app.capture('5-marquee-selection');

    // Text being edited (the selection text.edit / text.select leave): dashed box, selected text, caret.
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s2}/sp:r1/t:0`, focus: `/sl:${s2}/sp:r1/t:4`}]});
    await new Promise(r2 => setTimeout(r2, 300));
    await app.capture('5b-text-selection');

    // Ctrl+Z through the KeyRouter undoes the duplicate; the bridge undoes the rest.
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal(k.handled, true);
    await app.until(async () => (await count()) === n0 || null, {timeout: 10_000});
    for (let i = 0; i < 4; i++) await app.rpc('engine.execute', {doc, command: 'edit.undo'});
    x = await xf('r1');
    assert.deepEqual({x: x.x, y: x.y, w: x.w, h: x.h, rot: x.rot ?? 0}, {x: 120, y: 200, w: 200, h: 120, rot: 0});
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s1}`, focus: `/sl:${s1}`}]});
    await new Promise(r2 => setTimeout(r2, 300));
    await app.capture('6-after-undo-title');
  } finally {
    await app.close();
  }
});
