// U:prism/compress: Picture Format › Compress Pictures (deckcraft cmd/compress.rs): downsample to the
// shown size at 330/220/150/96 ppi, delete cropped areas, never grow a picture, drop the replaced media.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {pictureFill, base64Encode} from '../../core/prism/lib/shape-common.mjs';
import {encodePng, decodePng} from '../../core/prism/lib/raster.mjs';

/** A busy picture, so its PNG is big enough to shrink. */
const busy = (w, h) => { const data = new Uint8ClampedArray(w * h * 4); let x = 12345; for (let i = 0; i < w * h; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; const g = 128 + ((i % w) / w) * 60; data.set([(x & 255) * 0.3 + g * 0.7, ((x >> 8) & 255) * 0.3 + g * 0.7, ((x >> 16) & 255) * 0.3 + g * 0.7, 255], i * 4); } return {width: w, height: h, data}; };
const pic = (id, media, w, h, crop) => ({id, name: id, xfrm: {x: 0, y: 0, w, h}, kind: {type: 'picture', fill: {...pictureFill(media), ...(crop ? {crop} : {})}}, geom: {kind: 'preset', name: 'rect'}, ph: null,
  fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null});
async function session({host, extra = []} = {}) {
  const c = createContent('Compress');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const png = await encodePng(busy(600, 300));
  c.media = [{id: 'm1', name: 'big.png', contentType: 'image/png', data: base64Encode(png), link: null}];
  c.slides = [newSlide({id: 's1', layout, shapes: [pic('p', 'm1', 144, 72), ...extra]})];
  return createTestSession('prism', {content: c, host, selection: {ranges: [{anchor: '/sl:s1/sp:p', focus: '/sl:s1/sp:p'}], primary: 0}});
}
const live = t => t.session.get(t.docId).file.content;

test('picture.compress downsamples a picture to the size it is shown at, replaces and drops the original, and undoes', async () => {
  const t = await session();
  const r = (await t.exec('picture.compress', {ppi: 96})).result;
  assert.equal(r.pictures, 1);
  assert.ok(r.after < r.before, `${r.after} < ${r.before}`);
  const c = live(t), f = c.slides[0].shapes[0].kind.fill;
  assert.notEqual(f.media, 'm1');
  assert.deepEqual(c.media.map(m => m.id), [f.media], 'the replaced original is dropped');
  const img = await decodePng(Uint8Array.from(Buffer.from(c.media[0].data, 'base64')));
  assert.deepEqual([img.width, img.height], [192, 96], '2 in at 96 ppi');
  await t.session.undo(t.docId);
  assert.equal(live(t).slides[0].shapes[0].kind.fill.media, 'm1');
  assert.equal(live(t).media.length, 1);
});

test('picture.compress leaves a small picture alone, deletes cropped areas, and keeps media another picture still uses', async () => {
  const t = await session();
  assert.equal((await t.exec('picture.compress', {ppi: 330})).result.pictures, 0, '600 px shown at 2 in is below 330 ppi');
  const tc = await session();
  await tc.exec('picture.compress', {ppi: 1200, deleteCropped: true});
  assert.equal(live(tc).slides[0].shapes[0].kind.fill.media, 'm1', 'no crop and no downsample: nothing to do');
  const cropped = await session({extra: [pic('q', 'm1', 144, 72, [0.5, 0, 0, 0])]});
  await cropped.exec('selection.select', {id: 'q'});
  await cropped.exec('picture.compress', {ppi: 1200, deleteCropped: true});
  const c = live(cropped), q = c.slides[0].shapes[1].kind.fill;
  assert.deepEqual(q.crop, [0, 0, 0, 0]);
  assert.ok(c.media.some(m => m.id === 'm1'), 'picture p still uses the original');
  const img = await decodePng(Uint8Array.from(Buffer.from(c.media.find(m => m.id === q.media).data, 'base64')));
  assert.deepEqual([img.width, img.height], [300, 300], 'the visible right half');
  await assert.rejects(t.exec('picture.compress', {ppi: 5}), /`ppi` must be between 36 and 1200/);
});

test('picture.compress applies to every picture with all: true; a JPEG goes through the host', async () => {
  let encoded = 0;
  const host = createTestHost({
    decodeImage: async bytes => (bytes[0] === 0xff ? busy(600, 300) : null),
    encodeImage: async (img, type) => { encoded++; return type === 'image/jpeg' ? Uint8Array.from([0xff, 0xd8, 1, 2, 3]) : null; },
  });
  const t = await session({host});
  const c = live(t);
  c.media.push({id: 'j1', name: 'photo.jpg', contentType: 'image/jpeg', data: base64Encode(new Uint8Array(40_000).fill(0xff)), link: null});
  t.session.get(t.docId).file.content.slides[0].shapes.push(pic('j', 'j1', 144, 72));
  const r = (await t.exec('picture.compress', {ppi: 96, all: true})).result;
  assert.equal(r.pictures, 2);
  assert.equal(encoded, 1);
  const j = live(t).slides[0].shapes.find(x => x.id === 'j').kind.fill.media;
  assert.equal(live(t).media.find(m => m.id === j).contentType, 'image/jpeg');
});
