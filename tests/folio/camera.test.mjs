// Enhance camera image: core/folio/lib/camera.mjs (the warp and the clean-up) and core/folio/commands/camera.mjs (the tool).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/engine/src/camera.rs tests (a tilted quad comes out upright at the longer sides' size, the corner order does
//    not matter, transparency becomes white, bad corners and rasters are errors, far corners are capped), camera_clean.rs tests (a shadow and a
//    yellow cast become white paper and the text stays dark, a blue stamp stays blue, level 0 changes nothing and strength grows with the level,
//    specks go at high levels, the looks), geom perspective.rs tests (each corner maps onto its target; collinear points have no transform),
//    camera_ui.rs (the corners start 5 % in from the page's edges, are kept inside the page, the look and level set what the next enhance uses).
//    Acrobat's Enhance scanned file / camera image works the same way.
// 2. Ours does the same on the same numbers.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {homography, applyH, orderQuad, warp, applyLook, clean, insetCorners, MAX_PIXELS} from '../../core/folio/lib/camera.mjs';

after(() => releaseTextSources());

const raster = (w, h, f) => {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); out.set([r, g, b, 255], (y * w + x) * 4); }
  return out;
};
const close = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

test('a homography maps each corner onto its target, is the identity for a rectangle onto itself, and has none for collinear or non-finite points', () => {
  const from = [[12, 30], [410, 5], [430, 610], [-4, 590]], to = [[0, 0], [400, 0], [400, 600], [0, 600]];
  const h = homography(from, to);
  from.forEach((p, i) => assert.ok(close(applyH(h, p), to[i]), `${p} -> ${to[i]}`));
  const r = [[0, 0], [10, 0], [10, 20], [0, 20]];
  assert.ok(close(applyH(homography(r, r), [3, 7]), [3, 7]));
  assert.equal(homography([[0, 0], [1, 1], [2, 2], [3, 3]], to), null);
  assert.equal(homography([[0, 0], [0, 0], [0, 0], [0, 0]], to), null);
  assert.equal(homography([[NaN, 0], [1, 0], [1, 1], [0, 1]], to), null);
  const back = homography(to, from), p = [120, 210];
  assert.ok(close(applyH(back, applyH(homography(from, to), p)), p), 'the inverse takes points back');
});

test('orderQuad puts the corners top-left, top-right, bottom-right, bottom-left, whatever order they come in, and refuses a sliver', () => {
  const q = [[20, 30], [170, 10], [180, 150], [10, 160]];
  assert.deepEqual(orderQuad([q[2], q[0], q[3], q[1]]), q);
  assert.equal(orderQuad([[0, 0], [5, 5], [10, 10], [2, 2]]), null, 'in a line');
  assert.equal(orderQuad([[NaN, 0], [1, 0], [1, 1], [0, 1]]), null);
  assert.equal(orderQuad([[0, 0], [10, 0], [2, 2], [0, 10]]), null, 'not convex');
});

test('warp: a tilted quad comes out upright at its longer sides\' size; the corner order does not matter; transparency is white; bad input is an error', () => {
  const quad = [[20, 30], [170, 10], [180, 150], [10, 160]];
  const ordered = orderQuad(quad);
  const inside = (x, y) => ordered.every((a, i) => { const b = ordered[(i + 1) % 4]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0; });
  const src = raster(200, 180, (x, y) => (inside(x + 0.5, y + 0.5) ? [20, 20, 20] : [255, 255, 255]));
  const out = warp(src, 200, 180, quad);
  assert.deepEqual([out.width, out.height], [170, 140], 'the longer of each pair of opposite sides');
  for (const [x, y] of [[5, 5], [85, 70], [164, 134], [5, 134], [164, 5]]) assert.ok(out.rgb[(y * out.width + x) * 3] < 60, `(${x}, ${y})`);
  const gradient = raster(64, 48, (x, y) => [x * 4, y * 5, 128]);
  const q = [[4, 3], [60, 6], [58, 44], [2, 40]];
  const a = warp(gradient, 64, 48, q), b = warp(gradient, 64, 48, [q[2], q[0], q[3], q[1]]);
  assert.deepEqual(Array.from(a.rgb), Array.from(b.rgb));
  const px = (img, x, y) => img.rgb.slice((y * img.width + x) * 3, (y * img.width + x) * 3 + 3);
  assert.ok(px(a, a.width - 3, 10)[0] > px(a, 2, 10)[0] + 100, 'left to right the red grows');
  assert.ok(px(a, 10, a.height - 3)[1] > px(a, 10, 2)[1] + 100, 'top to bottom the green grows');
  const clear = warp(new Uint8Array(8 * 8 * 4), 8, 8, [[0, 0], [8, 0], [8, 8], [0, 8]]);
  assert.ok(clear.rgb.every(v => v === 255), 'transparency becomes white');
  const ten = raster(10, 10, () => [0, 0, 0]);
  assert.throws(() => warp(ten, 10, 10, [[0, 0], [5, 5], [10, 10], [2, 2]]), /convex|area|line/);
  assert.throws(() => warp(ten, 10, 10, [[NaN, 0], [1, 0], [1, 1], [0, 1]]), /corners/);
  assert.throws(() => warp(ten, 11, 10, [[0, 0], [10, 0], [10, 10], [0, 10]]), /picture/, 'the size does not match the buffer');
  assert.throws(() => warp(new Uint8Array(0), 0, 0, [[0, 0], [10, 0], [10, 10], [0, 10]]), /picture/);
  const far = warp(ten, 10, 10, [[-1e9, -1e9], [1e9, -1e9], [1e9, 1e9], [-1e9, 1e9]]);
  assert.ok(far.width * far.height <= MAX_PIXELS, 'a capped picture, not a huge allocation');
});

/** camera_clean.rs tests' photo: lines of text, a blue stamp, a few specks, under a light. */
function photo(w, h, light) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const text = Math.floor(y / 12) % 3 === 1 && x > w / 10 && x < 9 * w / 10 && Math.floor(x / 9) % 6 !== 0;
    const stamp = (x - Math.floor(3 * w / 4)) ** 2 + (y - Math.floor(3 * h / 4)) ** 2 < Math.floor(h / 12) ** 2;
    const speck = (x * 7919 + y * 104729) % 997 === 0;
    const ink = text || speck ? [0.12, 0.12, 0.12] : stamp ? [0.15, 0.25, 0.75] : [0.97, 0.97, 0.95];
    const l = light(x, y);
    for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = Math.min(255, Math.max(0, Math.round(ink[c] * l[c] * 255)));
  }
  return out;
}
const at = (img, w, x, y) => Array.from(img.slice((y * w + x) * 3, (y * w + x) * 3 + 3));

test('clean: a shadow and a yellow cast become white paper and the text stays dark; a blue stamp stays blue', () => {
  const [w, h] = [480, 640];
  const img = photo(w, h, (x, y) => { const f = 1 - 0.66 * ((x + y) / (w + h)); return [0.95 * f, 0.85 * f, 0.6 * f]; });
  const out = clean(img, w, h, 60);
  for (const [fx, fy] of [[0.05, 0.03], [0.5, 0.03], [0.95, 0.03], [0.05, 0.53], [0.5, 0.53], [0.97, 0.98], [0.03, 0.98]]) {
    const x = Math.min(Math.floor(fx * w), w - 1);
    const y0 = Math.floor(fy * h);
    const y = Math.min(y0 - (y0 % 36) + 4, h - 1);
    assert.ok(at(out, w, x, y).every(v => v >= 235), `paper at (${x}, ${y}): ${at(img, w, x, y)} -> ${at(out, w, x, y)}`);
  }
  for (const [x, y] of [[w / 2, 13], [w / 2, 3 * 12 + 13]]) if (Math.floor(x / 9) % 6 !== 0) assert.ok(at(out, w, Math.floor(x), y).every(v => v <= 90), `text at (${x}, ${y})`);
  const blue = clean(photo(w, h, () => [0.9, 0.85, 0.7]), w, h, 100);
  const [r, g, b] = at(blue, w, Math.floor(3 * w / 4), Math.floor(3 * h / 4) + 12);
  assert.ok(b - r > 60 && b - g > 40, `${[r, g, b]}`);
});

test('clean: level 0 changes nothing, strength grows with the level, specks go at high levels but text stays', () => {
  const [w, h] = [240, 320];
  const img2 = photo(w, h, x => { const l = 0.6 + 0.3 * x / w; return [l, l, l]; });
  assert.deepEqual(Array.from(clean(img2, w, h, 0)), Array.from(img2));
  const mean = v => v.reduce((a, c) => a + c, 0) / v.length;
  const [a, b, c] = [mean(img2), mean(clean(img2, w, h, 30)), mean(clean(img2, w, h, 100))];
  assert.ok(a < b && b < c, `${a} ${b} ${c}`);
  const white = clean(photo(w, h, () => [1, 1, 1]), w, h, 100);
  let specks = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x * 7919 + y * 104729) % 997 === 0 && Math.floor(y / 12) % 3 === 0 && y % 12 >= 2 && y % 12 < 10) { specks++; assert.ok(at(white, w, x, y).every(v => v > 200), `speck at (${x}, ${y})`); }
  assert.ok(specks > 0);
  assert.ok(at(white, w, Math.floor(w / 2) + 1, 13).every(v => v < 60), 'text');
});

test('the looks: original is as photographed, colour is the clean-up, greyscale has one channel, black and white only black and white', () => {
  const [w, h] = [240, 320];
  const flat = photo(w, h, x => [0.95 - 0.4 * x / w, 0.85 - 0.4 * x / w, 0.65]);
  assert.deepEqual(Array.from(applyLook(flat, w, h, 'original', 80).data), Array.from(flat));
  assert.deepEqual(Array.from(applyLook(flat, w, h, 'colour', 80).data), Array.from(clean(flat, w, h, 80)));
  const grey = applyLook(flat, w, h, 'greyscale', 80);
  assert.deepEqual([grey.kind, grey.data.length], ['grey', w * h]);
  const bw = applyLook(flat, w, h, 'bw', 50);
  assert.ok(Array.from(bw.data).every(v => v === 0 || v === 255), 'only black and white');
  assert.equal(applyLook(flat, w + 1, h, 'colour', 50), null);
  assert.equal(applyLook(flat, w, h, 'sepia', 50), null);
});

test('the tool: the corners start 5 % in from the page\'s edges; they are kept inside the page; the look and level are kept for the next enhance', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const st = await t.session.state(t.docId, 'camera.enhance');
  assert.equal(st.enabled, false, 'the tool is not picked');
  assert.equal((await t.session.state(t.docId, 'camera.mode')).enabled, false);
  const r = await t.exec('ocr.enhance_camera', {});
  const page = t.content.pages[0];
  const w = page.width, h = page.height;
  assert.deepEqual(r.result.corners, insetCorners(w, h));
  assert.deepEqual(r.result.corners[0].map(v => Math.round(v * 1000)), [Math.round(w * 50), Math.round(h * 50)]);
  assert.equal(t.doc.view.tool, 'ocr.enhance_camera');
  assert.equal((await t.session.state(t.docId, 'ocr.enhance_camera')).checked, true);
  await t.exec('camera.corners', {corners: [[-50, -20], [w + 99, 10], [w, h + 5], [0, h]]});
  assert.deepEqual(t.doc.view.camera.corners, [[0, 0], [w, 10], [w, h], [0, h]], 'kept inside the page');
  await t.exec('camera.mode', {look: 'bw'});
  await t.exec('camera.cleanup', {level: 70});
  assert.deepEqual([t.doc.view.camera.look, t.doc.view.camera.level], ['bw', 70]);
  assert.equal((await t.session.state(t.docId, 'camera.mode')).value, 'Black and white');
  await t.exec('camera.mode', {look: 'original'});
  assert.equal((await t.session.state(t.docId, 'camera.cleanup')).enabled, false, 'the original look is not cleaned up');
  await assert.rejects(t.exec('camera.cleanup', {level: 101}), /level/);
  await assert.rejects(t.exec('camera.rotate_cw', {}), /enhance the page first|not available|disabled/i);
  await assert.rejects(t.exec('camera.rotate_ccw', {}), /enhance the page first|not available|disabled/i);
  await t.exec('camera.cancel', {});
  assert.equal(t.doc.view.tool, null);
  assert.equal(t.doc.view.camera, null);
  // Picking it again puts it away.
  await t.exec('ocr.enhance_camera', {});
  await t.exec('ocr.enhance_camera', {});
  assert.equal(t.doc.view.tool, null);
});
