// U:quill/insert: Insert › Icons: the library translated from wordcraft crates/render/src/icon_lib.rs, its search, its drawing into a PNG
// and the insert.icon command and picker dialog.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/render/src/icon_lib.rs (the library and its two tests: every icon is unique, parses, fits the grid,
//    has convex fills, draws something and is not clipped; search matches words in ids, names, keywords and categories) and
//    crates/engine/src/cmd/insert/objects.rs (insert.icon: a PNG picture \`size\` points square in \`color\`, listing without an id).
//    Word: Insert › Icons offers a searchable, categorised set of pictograms that go in as pictures the colour of your choice.
// 2. Ours: the same data and path language; a scanline filler in place of vello_cpu; the picture is a palette PNG whose alpha is the
//    coverage; the picker is core/quill/dialogs/icons.mjs over src/apps/quill/dialogs/icons.tsx.
// 3. Proof: this file and tests/e2e/quill/insert-leftovers.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {openDialogModel} from '../../core/kernel/dialog.mjs';
import {ICONS, CATEGORIES, GRID, STROKE, findIcon, searchIcons, parseCategory, flatten, piecesOf, renderIcon, iconPng} from '../../core/quill/lib/icon-lib.mjs';
import {probe} from '../../core/quill/lib/insert-objects.mjs';
import icons from '../../core/quill/dialogs/icons.mjs';

/** A convex outline never changes turning sign. */
function convex(points) {
  let sign = 0;
  const n = points.length;
  for (let k = 0; k < n; k++) {
    const [a, b, c] = [points[k], points[(k + 1) % n], points[(k + 2) % n]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-4) continue;
    if (sign === 0) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

test('every icon is unique, parses, fits the grid, has convex fills, draws something and is not clipped', () => {
  assert.ok(ICONS.length >= 40 && ICONS.length <= 80, `${ICONS.length} icons`);
  const ids = new Set();
  for (const icon of ICONS) {
    assert.ok(!ids.has(icon.id), `duplicate id ${icon.id}`);
    ids.add(icon.id);
    assert.ok(icon.name && icon.keywords.length, icon.id);
    const pieces = piecesOf(icon);
    assert.ok(pieces.length, `${icon.id} draws nothing`);
    for (const p of pieces) {
      assert.ok(p.points.length >= 2, `${icon.id}: degenerate subpath`);
      const m = p.fill ? 0 : STROKE / 2 - 0.01;
      for (const [x, y] of p.points) assert.ok(x >= m && x <= GRID - m && y >= m && y <= GRID - m, `${icon.id}: (${x}, ${y}) leaves the grid`);
      if (p.fill) assert.ok(convex(p.points), `${icon.id}: filled outlines must be convex`);
    }
    const {width, alpha} = renderIcon(icon, 48);
    assert.equal(width, 48);
    assert.ok(alpha.filter(a => a > 0).length > 48, `${icon.id} renders blank`);
    const edge = (x, y) => alpha[y * 48 + x];
    for (let k = 0; k < 48; k++) assert.ok(edge(k, 0) === 0 && edge(k, 47) === 0 && edge(0, k) === 0 && edge(47, k) === 0, `${icon.id} is clipped`);
  }
  for (const c of CATEGORIES) assert.ok(ICONS.some(i => i.category === c), `${c} has icons`);
});

test('search matches words, names, keywords and categories; the path language rejects bad data', () => {
  const ids = (q, c = null) => searchIcons(q, c).map(i => i.id);
  assert.equal(searchIcons('').length, ICONS.length);
  assert.deepEqual(ids('Envelope'), ['mail']);
  assert.ok(ids('weather').includes('rain'));
  assert.deepEqual(ids('arrow up'), ['arrow-up']);
  assert.ok(ids('help', 'Symbols').includes('question'));
  assert.deepEqual(ids('help', 'Arrows'), []);
  assert.deepEqual(ids('zzz-nothing'), []);
  assert.equal(parseCategory(' weather '), 'Weather');
  assert.equal(parseCategory('nothing'), null);
  assert.ok(findIcon('heart') && !findIcon('nope'));
  for (const bad of ['M1 1 L', 'X 1', 'L 2 2', '5']) assert.throws(() => flatten(bad), bad);
  // An arc starts a subpath; a circle and a rounded rectangle are their own closed ones; Z closes.
  assert.deepEqual(flatten('M0 0 L1 1 L2 0 Z').map(s => [s.points.length, s.closed]), [[3, true]]);
  assert.deepEqual(flatten('O5 5 3 R1 1 4 4 1').map(s => s.closed), [true, true]);
  assert.equal(flatten('A12 12 7.5 -45 225').length, 1);
});

test('the PNG is a picture of the icon: its size, the ink and the coverage', () => {
  const heart = findIcon('heart');
  const png = iconPng(heart, 96, [200, 30, 60]);
  const pr = probe(png);
  assert.deepEqual([pr.width, pr.height, pr.notPicture ?? false], [96, 96, false]);
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(Buffer.from(png).includes(Buffer.from([200, 30, 60, 200, 30, 60])), true, 'the palette is the ink');
  // A thin stroke has soft edges: some pixels are partly covered.
  const {alpha} = renderIcon(findIcon('arrow-right'), 96);
  assert.ok(alpha.some(a => a > 0 && a < 255), 'anti-aliased');
  assert.ok(alpha.some(a => a === 255), 'solid where the pen is');
  // The pen is 2 grid units wide: the arrow shaft (y = 12) is about 8 pixels thick at 96 px.
  const col = x => { let n = 0; for (let y = 0; y < 96; y++) n += alpha[y * 96 + x] / 255; return n; };
  assert.ok(Math.abs(col(40) - 8) < 0.6, `shaft ${col(40)}`);
});

test('Insert Icons: places a picture of the icon, one undo step; without an id it lists the library', async () => {
  const q = await quill('The quick brown fox.\nSecond paragraph.');
  q.sel(0, 3);
  const listed = (await q.exec('insert.icon', {query: 'envelope'})).result.icons;
  assert.deepEqual(listed.map(i => [i.id, i.name, i.category]), [['mail', 'Mail', 'Communication']]);
  assert.equal((await q.exec('insert.icon', {category: 'weather'})).result.icons.every(i => i.category === 'Weather'), true);
  const r = (await q.exec('insert.icon', {id: 'heart', color: '#C81E3C', size: 36})).result;
  assert.equal(r.icon, 'heart');
  assert.equal(r.width, 36);
  const image = q.para(0).objects.find(o => o.type === 'image');
  assert.ok(image, 'a picture at the caret');
  assert.deepEqual([image.w, image.h, image.alt], [36, 36, 'Heart']);
  assert.ok(q.t.content.media[image.media], 'its bytes are kept');
  await q.t.exec('edit.undo', {});
  assert.ok(!q.para(0).objects?.some(o => o.type === 'image'), 'one undo takes it away');
  assert.equal((await q.exec('insert.icon', {id: ' mail '})).result.icon, 'mail', 'the id is trimmed');
  await assert.rejects(() => q.exec('insert.icon', {id: 'nope'}), /no icon/);
  await assert.rejects(() => q.exec('insert.icon', {id: 'heart', color: 'red'}), /bad color/);
  const big = (await q.exec('insert.icon', {id: 'star'})).result;
  assert.equal(big.width, 72, 'one inch by default');
});

test('the Icons picker: Insert needs a chosen icon and runs insert.icon with its id', async () => {
  const q = await quill('Text');
  const v = openDialogModel(q.t.session, q.t.docId, icons);
  assert.deepEqual([v.query, v.category, v.selected], ['', '', '']);
  assert.deepEqual(icons.validate(v).map(e => e.field), ['selected']);
  assert.deepEqual(icons.validate({...v, selected: 'mail'}), []);
  assert.deepEqual(icons.toCommand({...v, selected: 'mail'}), {command: 'insert.icon', params: {id: 'mail'}});
});
