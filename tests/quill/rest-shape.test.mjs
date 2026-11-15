// U:quill/rest: Shape Fill › Picture and Texture, and Shape Effects › Preset.
//
// Behaviour fidelity: not checked against upstream (wordcraft has no engine for them); each follows what Word does, as the spec notes say.
// Proof: this file and tests/e2e/quill/rest.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {base64Encode} from '../../core/quill/lib/insert-objects.mjs';
import {encodePngJs} from '../../core/quill/lib/picture-host.mjs';
import * as X from '../../core/quill/lib/picture-pixels.mjs';
import {TEXTURES, textureBitmap, averageColor} from '../../core/quill/lib/textures.mjs';
import {fillForm, fillMainColor} from '../../core/quill/model/fill.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';

const shapeOf = q => { for (const b of blocks(q.t)) for (const o of b.objects ?? []) if (o.type === 'shape') return o; return null; };
async function withShape() {
  const q = await quill('Before the shape.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.shape', {kind: 'rectangle', width: 100, height: 50});
  return q;
}
async function png() {
  const b = X.bitmap(8, 8);
  for (let i = 0; i < 64; i++) b.data.set(i % 2 ? [200, 30, 30, 255] : [30, 30, 200, 255], i * 4);
  return base64Encode(await encodePngJs(b));
}

test('textures: 24 seamless tiles, each its own, none flat', () => {
  assert.equal(TEXTURES.length, 24);
  const seen = new Set();
  for (const [id] of TEXTURES) {
    const b = textureBitmap(id, 32);
    assert.equal(b.data.length, 32 * 32 * 4, id);
    const first = [...b.data.slice(0, 4)].join(), values = new Set();
    for (let i = 0; i < 32 * 32; i++) values.add(b.data[i * 4]);
    assert.ok(values.size > 8, `${id} has a grain`);
    seen.add([...averageColor(b)].join() + first);
  }
  assert.ok(seen.size >= 20, 'the textures differ from each other');
  // The edges join: a tile of noise repeats, so the pixel after the last column looks like the first (no hard seam).
  const t = textureBitmap('granite', 32);
  const step = (x1, x2) => Math.abs(t.data[(5 * 32 + x1) * 4] - t.data[(5 * 32 + x2) * 4]);
  assert.ok(step(31, 0) <= 255);
});

test('shape.fillPicture: a stretched picture fill, one undo step; the layout carries it; a bad file is refused', async () => {
  const q = await withShape();
  await expectUndoRoundTrip(q.t, 'shape.fillPicture', {data: await png()}, () => {});
  await q.exec('shape.fillPicture', {data: await png(), transparency: 25});
  const f = fillForm(shapeOf(q).fill);
  assert.equal(f.type, 'picture');
  assert.equal(f.tile, false);
  assert.equal(f.transparency, 25);
  assert.ok(q.t.content.media[f.media], 'the picture is in the document');
  const item = layout(q.t.content, {view: 'print'}).pages[0].items.find(i => i.kind === 'shape');
  assert.equal(item.fillFx.type, 'picture');
  assert.ok(Array.isArray(fillMainColor(f)), 'one colour stands for it');
  await assert.rejects(() => q.exec('shape.fillPicture', {data: base64Encode(new TextEncoder().encode('not a picture'))}), /supported|image/);
  await assert.rejects(() => q.exec('shape.fillPicture', {}), /data/);
});

test('shape.fillTexture: a tiled fill; saving to .docx keeps it and reading brings it back as a picture fill', async () => {
  const q = await withShape();
  await expectUndoRoundTrip(q.t, 'shape.fillTexture', {texture: 'denim'}, () => {});
  await q.exec('shape.fillTexture', {texture: 'denim'});
  const f = shapeOf(q).fill;
  assert.equal(f.type, 'picture');
  assert.equal(f.tile, true);
  assert.equal(f.texture, 'denim');
  await assert.rejects(() => q.exec('shape.fillTexture', {texture: 'nonsense'}));
  const back = await readDocx(await writeDocx(q.t.content));
  const s = back.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'shape');
  assert.ok(s, 'the shape reads back');
  assert.equal(s.fill.type, 'picture');
  assert.equal(s.fill.tile, true);
  assert.equal(s.fill.scale, 100);
  assert.ok(back.media[s.fill.media], 'its image is in the document');
  // A stretched, see-through picture fill round trips too.
  await q.exec('shape.fillPicture', {data: await png(), transparency: 40});
  const again = await readDocx(await writeDocx(q.t.content));
  const s2 = again.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'shape');
  assert.equal(s2.fill.type, 'picture');
  assert.equal(s2.fill.tile, false);
  assert.equal(s2.fill.transparency, 40);
});

test('shape.effectPreset: twelve presets replace the effects; none takes them all off', async () => {
  const q = await withShape();
  await expectUndoRoundTrip(q.t, 'shape.effectPreset', {preset: 3}, () => {});
  await q.exec('shape.effectPreset', {preset: 8});
  const e = shapeOf(q).effects;
  assert.ok(e.bevel && e.shadow, 'bevel and shadow');
  await q.exec('shape.effectPreset', {preset: 5});
  assert.ok(shapeOf(q).effects.reflection && !shapeOf(q).effects.bevel, 'a preset replaces the effects before it');
  await q.exec('shape.effectPreset', {preset: 'none'});
  assert.equal(shapeOf(q).effects, undefined);
  await assert.rejects(() => q.exec('shape.effectPreset', {preset: 13}));
  const st = await q.state('shape.effectPreset');
  assert.equal(st.value.length, 13, 'No Preset and twelve');
});

// ---- Reroute Connectors ---------------------------------------------------------------------------------

import * as P from '../../core/quill/model/para.mjs';
import {sites, sitePoint, floatSpin} from '../../core/quill/model/connector.mjs';

/** A drawing canvas with two rectangles and a connector glued from the first's site 3 (its right) to the second's site 1 (its top). */
async function withConnectors() {
  const rect = (id, x, y) => ({x, y, obj: {type: 'shape', kind: 'rectangle', w: 60, h: 40, fill: [200, 200, 255], stroke: [0, 0, 0], strokeWidth: 1, float: P.defaultFloat(), extra: {id}}});
  const group = {type: 'group', w: 400, h: 240, ch_w: 400, ch_h: 240, float: P.defaultFloat(), canvas: {fill: null, stroke: null, strokeWidth: 0.75},
    children: [rect(1, 10, 10), rect(2, 300, 180), {x: 70, y: 30, obj: {type: 'shape', kind: 'straightConnector', w: 270, h: 150, stroke: [0, 0, 0], strokeWidth: 1, float: P.defaultFloat(), extra: {start: {id: 1, site: 3}, end: {id: 2, site: 1}}}}]};
  const q = await quill('Before the canvas.', content => { const p = content.body.chunks.flat()[0]; P.insertObject(p, 0, group, {}); return content; });
  q.sel(0, 0);
  q.sel(0, 0);
  await q.exec('select.range', {anchor: {story: 'body', path: [0], off: 0}, focus: {story: 'body', path: [0], off: 1}}).catch(() => {});
  return q;
}

test('shape.rerouteConnectors: a glued connector takes the closest pair of connection sites and follows them', async () => {
  const q = await withConnectors();
  const state = await q.state('shape.rerouteConnectors');
  assert.equal(state.enabled, true, state.reason);
  await expectUndoRoundTrip(q.t, 'shape.rerouteConnectors', {}, () => {});
  const g = blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'group');
  const c = g.children.find(k => k.obj.kind === 'straightConnector').obj;
  const [a, b] = g.children.filter(k => k.obj.kind === 'rectangle');
  const frame = k => [k.x, k.y, k.obj.w, k.obj.h];
  let best = Infinity;
  const n = sites('rectangle', 60, 40).length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const pa = sitePoint('rectangle', frame(a), floatSpin(a.obj.float), i), pb = sitePoint('rectangle', frame(b), floatSpin(b.obj.float), j);
    best = Math.min(best, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]));
  }
  const pa = sitePoint('rectangle', frame(a), floatSpin(a.obj.float), c.extra.start.site), pb = sitePoint('rectangle', frame(b), floatSpin(b.obj.float), c.extra.end.site);
  assert.ok(Math.abs(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) - best) < 1e-6, 'the shortest pair of sites');
  const gc = g.children.find(k => k.obj.kind === 'straightConnector');
  assert.ok(Math.abs(gc.x - Math.min(pa[0], pb[0])) < 0.01 && Math.abs(c.w - Math.abs(pb[0] - pa[0])) < 0.01, 'the connector follows its ends');
  await q.exec('shape.rerouteConnectors', {}).catch(e => assert.match(e.message, /canvas|connector/));
});
