// Prism skeleton: a Move gesture (surface.pointer, deckcraft's Session::pointer) from the bridge on
// a schema-2 deck, read back, undone, then the same drag through ui.pointer (the surface's own
// pointer path); capture to artifacts/skeleton/prism.png.
//
// What deckcraft does: a press inside a shape and a drag moves it, one undo step "Move"
// (crates/engine/src/tools/pointer.rs). What PowerPoint does: the same. What this proves: the
// bridge's engine.execute and its ui.pointer route (RendererBridge -> SurfaceHandle.pointer) run
// the same gesture, and undo takes it back. (slide.new is written against schema 1 until the slide
// family moves: design note F-prism--slide--schema2.)
import test from 'node:test';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {runSkeleton} from '../skeleton.mjs';

test('prism skeleton: a Move gesture through the bridge and ui.pointer, with undo', {timeout: 200_000}, async () => {
  const seed = createFile('prism', 'Skeleton deck', {schema: 2});
  seed.id = 'prism-skeleton';
  const slide = seed.content.slides[0];
  slide.shapes.push(shape({id: 'r1', name: 'Rectangle 1', xfrm: {x: 120, y: 300, w: 200, h: 120}, geom: presetGeom('rect'),
    fill: fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255}))}));
  seed.content.nextId = Math.max(seed.content.nextId ?? 0, 400);
  const events = [{kind: 'down', x: 220, y: 360}, {kind: 'drag', x: 250, y: 380}, {kind: 'drag', x: 281, y: 397}, {kind: 'up', x: 281, y: 397}];
  await runSkeleton({
    app: 'prism', seed, tab: 'home',
    command: 'surface.pointer', params: {events, tol: 4}, undoLabel: 'Automation: Move',
    again: async ({app, doc}) => { await app.rpc('ui.pointer', {doc, events, tol: 4}); return 'ui.pointer drag r1 by (61, 37)'; },
    read: `/sl:${slide.id}/sp:r1`, as: 'json',
    applied: v => !!v?.xfrm && Math.abs(v.xfrm.x - 180) <= 6 && Math.abs(v.xfrm.y - 337) <= 6,
  });
});
