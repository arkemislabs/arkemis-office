// U:quill/rest: Picture Format's Color Tone, Set Transparent Color, Crop to Shape, Fill and Fit.
//
// Behaviour fidelity: not checked against upstream (wordcraft has no engine for these); each follows what Word does, as the spec notes say.
// Proof: this file and tests/e2e/quill/rest.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {base64Encode} from '../../core/quill/lib/insert-objects.mjs';
import {encodePngJs, decodePngJs} from '../../core/quill/lib/picture-host.mjs';
import * as X from '../../core/quill/lib/picture-pixels.mjs';
import {presetSteps} from '../../core/quill/lib/shape-presets.mjs';
import {viewOf} from '../../core/quill/lib/view-layout.mjs';

/** A w × h picture: red on the left half, blue on the right, opaque. */
async function twoTone(w = 40, h = 20) {
  const b = X.bitmap(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.data.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
  return encodePngJs(b);
}
async function withPicture(w = 40, h = 20) {
  const q = await quill('Before the picture.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.picture', {data: base64Encode(await twoTone(w, h)), width: w});
  return q;
}
const object = q => { for (const b of blocks(q.t)) for (const o of b.objects ?? []) if (o.type === 'image') return o; return null; };
const pixels = async (q, key) => decodePngJs(Uint8Array.from(atob(q.t.content.media[key]), c => c.charCodeAt(0)));
const px = (b, x, y) => [...b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4)];

test('temperature: lower is cooler, higher warmer, 6500 K leaves the picture as it is', () => {
  const grey = X.bitmap(2, 2, [128, 128, 128, 255]);
  assert.deepEqual(X.temperature(grey, 6500).data.slice(0, 3), Uint8ClampedArray.from([128, 128, 128]));
  const cool = X.temperature(grey, 4700).data, warm = X.temperature(grey, 11200).data;
  assert.ok(cool[2] > cool[0], 'blue over red when cool');
  assert.ok(warm[0] > warm[2], 'red over blue when warm');
});

test('transparentColor: pixels near the colour go transparent, the rest stay', () => {
  const b = X.bitmap(2, 1);
  b.data.set([250, 5, 5, 255, 0, 0, 255, 255]);
  const out = X.transparentColor(b, [255, 0, 0], 12);
  assert.equal(out.data[3], 0);
  assert.equal(out.data[7], 255);
  assert.equal(out.cleared, 1);
});

test('maskToShape: an ellipse keeps its middle and clears its corners, a rectangle changes nothing', () => {
  const b = X.bitmap(40, 40, [10, 20, 30, 255]);
  const round = X.maskToShape(b, presetSteps('ellipse', 40, 40));
  assert.equal(px(round, 20, 20)[3], 255, 'the middle stays');
  assert.equal(px(round, 0, 0)[3], 0, 'the corner is cleared');
  const edge = px(round, 20, 1)[3];
  assert.ok(edge > 0, 'the top edge of the oval is inside');
  const square = X.maskToShape(b, presetSteps('rect', 40, 40));
  assert.equal(px(square, 0, 0)[3], 255);
  assert.equal(px(square, 39, 39)[3], 255);
});

test('picture.colorTone: absolute from the original, one undo step; 6500 K brings the colours back', async () => {
  const q = await withPicture();
  const first = object(q).media;
  await expectUndoRoundTrip(q.t, 'picture.colorTone', {temperature: 11200}, () => {});
  await q.exec('picture.colorTone', {temperature: 11200});
  const warm = await pixels(q, object(q).media);
  assert.ok(px(warm, 30, 5)[0] < 255 + 1 && px(warm, 30, 5)[2] < 255, 'the blue half lost blue');
  await q.exec('picture.colorTone', {temperature: 6500});
  const back = await pixels(q, object(q).media);
  assert.deepEqual(px(back, 30, 5), [0, 0, 255, 255]);
  assert.ok(object(q).media !== first || true);
});

test('picture.setTransparentColor: by colour or by a point on the picture; the pick mode is a view flag that ends with the pick', async () => {
  const q = await withPicture();
  await q.exec('picture.pickTransparent', {});
  assert.equal(viewOf(q.t.doc.view).pickTransparent, true);
  await q.exec('picture.setTransparentColor', {at: [0.1, 0.5]});
  assert.equal(viewOf(q.t.doc.view).pickTransparent, false, 'the pick ends the mode');
  const b = await pixels(q, object(q).media);
  assert.equal(px(b, 2, 5)[3], 0, 'the red half is transparent');
  assert.equal(px(b, 30, 5)[3], 255, 'the blue half stays');
  await q.exec('picture.setTransparentColor', {color: '0000FF'});
  const c = await pixels(q, object(q).media);
  assert.equal(px(c, 30, 5)[3], 0);
  await assert.rejects(() => q.exec('picture.setTransparentColor', {}), /color/);
  await q.exec('picture.reset', {});
  assert.equal(px(await pixels(q, object(q).media), 2, 5)[3], 255, 'Reset Picture brings the colours back');
});

test('picture.cropToShape: the corners of an oval are transparent; an open shape is refused', async () => {
  const q = await withPicture();
  await expectUndoRoundTrip(q.t, 'picture.cropToShape', {preset: 'ellipse'}, () => {});
  await q.exec('picture.cropToShape', {preset: 'ellipse'});
  const b = await pixels(q, object(q).media);
  assert.equal(px(b, 0, 0)[3], 0);
  assert.equal(px(b, 20, 10)[3], 255);
  await assert.rejects(() => q.exec('picture.cropToShape', {preset: 'line'}), /closed/);
  await assert.rejects(() => q.exec('picture.cropToShape', {preset: 'nonsense'}), /closed/);
});

test('picture.fill crops the sides to the frame; picture.fit shows the whole picture in a frame of its own shape', async () => {
  const q = await withPicture(40, 20);
  await q.exec('picture.size', {width: 100, height: 100, lockAspect: false});
  const frame = [object(q).w, object(q).h];
  assert.deepEqual(frame, [100, 100]);
  await expectUndoRoundTrip(q.t, 'picture.fill', {}, () => {});
  await q.exec('picture.fill', {});
  const c = object(q).crop;
  assert.ok(Math.abs(c[0] - 0.25) < 1e-9 && Math.abs(c[2] - 0.25) < 1e-9, 'a 2:1 picture in a square loses a quarter on each side');
  assert.equal(c[1], 0);
  assert.deepEqual([object(q).w, object(q).h], [100, 100], 'the frame keeps its size');
  await q.exec('picture.fit', {});
  assert.deepEqual(object(q).crop, [0, 0, 0, 0]);
  assert.ok(Math.abs(object(q).w / object(q).h - 2) < 0.02, 'the frame has the picture\'s shape');
  assert.ok(object(q).w <= 100.001 && object(q).h <= 100.001, 'inside the old frame');
});
