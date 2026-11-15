// U:prism/album: Insert > Photo Album (insert.photoAlbum, insert.photoAlbumEdit and their dialogs).
//
// 1. deckcraft: crates/engine/src/cmd/insert/album.rs and its tests. PowerPoint: Insert > Photo Album.
// 2. Ours: core/prism/commands/album.mjs, lib/album.mjs, lib/album-dialog.mjs, dialogs/photoAlbum(Edit).mjs.
// 3. These tests and tests/e2e/prism/album.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import album from '../../core/prism/commands/album.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import shape from '../../core/prism/commands/shape.mjs';
import design from '../../core/prism/commands/design.mjs';
import albumDialog from '../../core/prism/dialogs/photoAlbum.mjs';
import albumEditDialog from '../../core/prism/dialogs/photoAlbumEdit.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';
import {plan, place, fitIn, markOf, albumOf, fileStem} from '../../core/prism/lib/album.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';

/** A real PNG `w` x `h` pixels of one colour, as base64. */
function png(w, h, rgb = [200, 80, 40]) {
  const crcTable = n => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; };
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable((c ^ b) & 0xff) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const deck = async () => {
  const t = await withNew({extra: [album, insert, shape, design]});
  await t.exec('slide.go', {index: 0});
  return t;
};
const albumSlides = t => t.content.slides.filter(s => s.name === 'Photo Album');
const pics = sl => sl.shapes.filter(s => s.kind?.type === 'picture');
const boxes = sl => sl.shapes.filter(s => s.textBox);

test('the layout math: pictures batched per slide, text on its own slide, pictures fitted in their cells', () => {
  const items = [{kind: 'picture'}, {kind: 'picture'}, {kind: 'text', text: 'Summer'}, {kind: 'picture'}];
  assert.deepEqual(plan(items, 2).map(s => (s.text ?? s.pictures.length)), [2, 'Summer', 1]);
  assert.deepEqual(fitIn(200, 100, 400, 100), [200, 50]);
  assert.deepEqual(fitIn(200, 100, 100, 400), [25, 100]);
  const p = place(960, 540, {cols: 2, rows: 2, per: 4, title: true, fit: false}, Array(4).fill({pxW: 4, pxH: 3}), true);
  assert.equal(p.placed.length, 4);
  assert.deepEqual(p.title, [36, 8, 888, 32]);
  assert.ok(p.placed.every(c => c.caption && c.caption[1] >= c.pic[1] + c.pic[3]), 'a caption sits under its picture');
  assert.equal(fileStem('C:/photos/beach day.jpeg'), 'beach day');
});

test('insert.photoAlbum builds one slide per picture after the current slide, in one undo step', async () => {
  const t = await deck();
  const before = t.content.slides.length;
  await expectUndoRoundTrip(t, 'insert.photoAlbum', {pictures: [{name: 'a.png', data: png(40, 30)}, {name: 'b.png', data: png(30, 40)}], layout: '1', captions: true});
  const made = albumSlides(t);
  assert.equal(made.length, 2);
  assert.equal(t.content.slides.length, before + 2);
  assert.equal(t.content.slides.indexOf(made[0]), 1, 'after the current slide');
  const [first] = pics(made[0]);
  assert.ok(first.xfrm.w > 100 && first.xfrm.h > 100);
  assert.equal(bodyText(boxes(made[0])[0].text), 'a', 'the caption is the file name without its extension');
  assert.ok(markOf(made[0]) && markOf(made[0]).id === markOf(made[1]).id, 'both slides carry the same marker');
});

test('frames, black and white, rotation and corrections are applied to each picture', async () => {
  const t = await deck();
  await t.exec('insert.photoAlbum', {pictures: [{name: 'a.png', data: png(40, 30), rot: 90, brightness: 0.25, contrast: -0.5}], frame: 'simple', grayscale: true});
  const [p] = pics(albumSlides(t)[0]);
  assert.equal(p.line?.width, 6);
  assert.equal(p.kind.fill.adjust.grayscale, true);
  assert.equal(p.kind.fill.adjust.brightness, 0.25);
  assert.equal(p.xfrm.rot, 90);
});

test('four pictures to a slide with a title; text items take a slide of their own', async () => {
  const t = await deck();
  const data = png(40, 30);
  await t.exec('insert.photoAlbum', {pictures: [{name: 'one.png', data}, {name: 'two.png', data}, {text: 'Holidays'}, {name: 'three.png', data}], layout: '4title'});
  const made = albumSlides(t);
  assert.equal(made.length, 3);
  assert.equal(pics(made[0]).length, 2);
  assert.equal(bodyText(boxes(made[0]).at(-1).text), 'one', 'the title is the first picture\'s name');
  assert.equal(pics(made[1]).length, 0);
  assert.equal(bodyText(boxes(made[1])[0].text), 'Holidays');
});

test('refusals: no pictures, bad options, a file that is not a picture, too many items', async () => {
  const t = await deck();
  await assert.rejects(t.exec('insert.photoAlbum', {}), /pictures/);
  await assert.rejects(t.exec('insert.photoAlbum', {pictures: []}), /at least one/);
  await assert.rejects(t.exec('insert.photoAlbum', {pictures: [{name: 'a.png', data: png(4, 4)}], layout: '7'}), /unknown layout/);
  await assert.rejects(t.exec('insert.photoAlbum', {pictures: [{name: 'a.png', data: png(4, 4)}], frame: 'gold'}), /unknown frame/);
  await assert.rejects(t.exec('insert.photoAlbum', {pictures: [{name: 'a.png', data: png(4, 4), brightness: 3}]}), /between -1 and 1/);
  await assert.rejects(t.exec('insert.photoAlbum', {pictures: [{name: 'a.txt', data: Buffer.from('hello').toString('base64')}]}), /not a picture/);
  await assert.rejects(t.exec('insert.photoAlbum', {pictures: Array(49).fill({text: 'x'})}), /at most 48/);
  assert.equal(albumSlides(t).length, 0, 'a refused album changes nothing');
});

test('Edit Photo Album rebuilds the album where it was; it is disabled off an album', async () => {
  const t = await deck();
  await assert.rejects(t.exec('insert.photoAlbumEdit', {pictures: [{text: 'x'}]}), /not part of a photo album|select a slide/);
  const data = png(40, 30);
  await t.exec('insert.photoAlbum', {pictures: [{name: 'a.png', data}, {name: 'b.png', data}], layout: '1'});
  const at = t.content.slides.indexOf(albumSlides(t)[0]);
  await t.exec('slide.go', {index: at});
  const seed = albumEditDialog.init(t.session.readContext(t.docId));
  assert.equal(seed.items.length, 2);
  assert.equal(seed.layout, '1');
  assert.ok(seed.album);
  const cmd = albumEditDialog.toCommand({...seed, layout: '2', items: [...seed.items, {kind: 'text', text: 'The end'}]});
  assert.equal(cmd.command, 'insert.photoAlbumEdit');
  await expectUndoRoundTrip(t, cmd.command, cmd.params);
  const made = albumSlides(t);
  assert.equal(made.length, 2, 'two pictures on one slide, then the text slide');
  assert.equal(t.content.slides.indexOf(made[0]), at, 'rebuilt at the same place');
  assert.equal(pics(made[0]).length, 2);
  assert.equal(markOf(made[0]).layout, '2');
});

test('the album survives a .pptx save and reopen and is found again', async () => {
  const t = await deck();
  await t.exec('insert.photoAlbum', {pictures: [{name: 'a.png', data: png(40, 30)}, {text: 'Fin'}], layout: 'fit', captions: true, frame: 'rect'});
  const back = await importPptx(await exportPptx(t.content));
  const slides = back.slides.filter(s => s.name === 'Photo Album');
  assert.equal(slides.length, 2);
  const found = albumOf(back.slides, back.slides.indexOf(slides[0]));
  assert.equal(found.slides.length, 2);
  assert.equal(markOf(slides[0]).frame, 'rect');
  assert.equal(markOf(slides[0]).captions, true);
});

test('the dialogs: Add a picture and a text box, validation, and the submitted command', () => {
  const v = albumDialog.init({});
  assert.deepEqual([v.items.length, v.layout, v.frame], [0, '1', 'none']);
  assert.equal(albumDialog.validate(v).length, 1, 'an empty album is refused');
  const full = {...v, items: [{kind: 'picture', name: 'p.png', data: png(8, 8), rot: 0, brightness: 0.1, contrast: 0}, {kind: 'text', text: '  Hello '}], layout: '2title', captions: true};
  assert.equal(albumDialog.validate(full).length, 0);
  const cmd = albumDialog.toCommand(full);
  assert.equal(cmd.command, 'insert.photoAlbum');
  assert.deepEqual(cmd.params.pictures[1], {text: 'Hello'});
  assert.equal(cmd.params.layout, '2title');
  assert.equal(albumDialog.validate({...full, items: [{kind: 'text', text: ' '}]}).length, 1);
});
