// U:quill/rest: Design › Page Color › Fill Effects (gradient, texture, pattern, picture page backgrounds) and Picture….
//
// Behaviour fidelity: not checked against upstream (wordcraft only keeps a page picture read from a file); follows what Word does: the background is
// the page's picture, stretched (gradient, picture) or tiled (texture, pattern), saved as w:background with v:fill.
// Proof: this file and tests/e2e/quill/rest.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, submitDialog} from '../../core/kernel/dialog.mjs';
import {base64Encode} from '../../core/quill/lib/insert-objects.mjs';
import {encodePngJs, decodePngJs} from '../../core/quill/lib/picture-host.mjs';
import * as X from '../../core/quill/lib/picture-pixels.mjs';
import {gradientBitmap, patternBitmap, PATTERNS} from '../../core/quill/lib/page-fill.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';

const dialogs = (await import('../../core/generated/quill.dialogs.mjs')).dialogs;
const px = (b, x, y) => [...b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 3)];

test('gradients: each style runs from colour 1 to colour 2, the variants turn it round and back', () => {
  const [r, b] = [[255, 0, 0], [0, 0, 255]];
  const h = gradientBitmap(r, b, 'horizontal', 1, 10, 10);
  assert.ok(px(h, 5, 0)[0] > px(h, 5, 9)[0], 'red at the top, blue at the bottom');
  assert.ok(px(gradientBitmap(r, b, 'vertical', 1, 10, 10), 0, 5)[0] > px(gradientBitmap(r, b, 'vertical', 1, 10, 10), 9, 5)[0], 'vertical runs across');
  assert.ok(px(gradientBitmap(r, b, 'horizontal', 2, 10, 10), 5, 0)[2] > px(gradientBitmap(r, b, 'horizontal', 2, 10, 10), 5, 9)[2], 'variant 2 runs the other way');
  const mirrored = gradientBitmap(r, b, 'horizontal', 3, 10, 10);
  assert.ok(px(mirrored, 5, 0).every((v, i) => Math.abs(v - px(mirrored, 5, 9)[i]) <= 2), 'variant 3 returns to colour 1');
  const centre = gradientBitmap(r, b, 'fromCenter', 1, 11, 11);
  assert.ok(px(centre, 5, 5)[0] > px(centre, 0, 0)[0], 'from the centre colour 1 is in the middle');
});

test('patterns: an 8 by 8 tile of the foreground over the background', () => {
  assert.ok(PATTERNS.length >= 12);
  const t = patternBitmap('percent50', [0, 0, 0], [255, 255, 255]);
  assert.equal(t.width, 8);
  assert.deepEqual(px(t, 0, 0), [0, 0, 0]);
  assert.deepEqual(px(t, 1, 0), [255, 255, 255]);
  assert.equal(patternBitmap('nope', [0, 0, 0], [0, 0, 0]), null);
});

test('design.pageFill: gradient, texture, pattern and picture become the page picture; Page Color takes it off; a .docx keeps it', async () => {
  const q = await quill('Text');
  await expectUndoRoundTrip(q.t, 'design.pageFill', {kind: 'gradient', color1: 'FFFFFF', color2: 'C00000', style: 'diagonalDown'}, () => {});
  const pic = () => q.t.content.settings.pagePicture;
  assert.equal(pic().fillType, 'frame');
  assert.ok(q.t.content.media[pic().media], 'the bitmap is in the document');
  const b = await decodePngJs(Uint8Array.from(atob(q.t.content.media[pic().media]), c => c.charCodeAt(0)));
  assert.ok(px(b, 0, 0)[1] > px(b, b.width - 1, b.height - 1)[1], 'white at the top left, red at the bottom right');
  await q.exec('design.pageFill', {kind: 'texture', texture: 'denim'});
  assert.equal(pic().fillType, 'tile');
  assert.equal(pic().title, 'Denim');
  await q.exec('design.pageFill', {kind: 'pattern', pattern: 'smallGrid', fg: '808080', bg: 'FFFFFF'});
  assert.equal(pic().fillType, 'tile');
  const t = X.bitmap(4, 4, [10, 200, 10, 255]);
  await q.exec('design.pageFill', {kind: 'picture', data: base64Encode(await encodePngJs(t))});
  assert.equal(pic().fillType, 'frame');
  const back = await readDocx(await writeDocx(q.t.content));
  assert.ok(back.settings.pagePicture?.media, 'the page picture reads back');
  assert.equal(back.settings.pagePicture.fillType, 'frame');
  await q.exec('design.pageColor', {color: 'FFF2CC'});
  assert.equal(q.t.content.settings.pagePicture, null, 'a plain colour takes the picture away');
  await q.exec('design.pageFill', {kind: 'texture', texture: 'oak'});
  await q.exec('design.pageFill', {kind: 'none'});
  assert.equal(q.t.content.settings.pagePicture, null);
  await assert.rejects(() => q.exec('design.pageFill', {kind: 'texture', texture: 'nope'}), /texture/);
  await assert.rejects(() => q.exec('design.pageFill', {kind: 'gradient', style: 'zigzag'}), /style/);
  await assert.rejects(() => q.exec('design.pageFill', {kind: 'picture'}), /data/);
});

test('dialog.fillEffects: a gradient, texture or pattern by its radio, one undo step', async () => {
  const q = await quill('Text');
  const m = openDialogModel(q.t.session, q.t.docId, dialogs['dialog.fillEffects']);
  assert.equal(m.kind, 'gradient');
  await submitDialog(q.t.session, q.t.docId, dialogs['dialog.fillEffects'], {...m, kind: 'pattern', pattern: 'trellis', fg: '336699', bg: 'FFFFFF'});
  assert.equal(q.t.content.settings.pagePicture.title, 'Trellis');
  await submitDialog(q.t.session, q.t.docId, dialogs['dialog.fillEffects'], {...m, kind: 'gradient', color1: 'FFFFFF', color2: '000000', style: 'fromCenter', variant: '3'});
  assert.equal(q.t.content.settings.pagePicture.fillType, 'frame');
  await assert.rejects(() => submitDialog(q.t.session, q.t.docId, dialogs['dialog.fillEffects'], {...m, kind: 'gradient', color1: 'nope'}));
});
