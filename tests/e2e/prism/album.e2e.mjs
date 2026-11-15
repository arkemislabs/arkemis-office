// Prism's photo album through the bridge and the real window (U:prism/album).
//
// What deckcraft does (cmd/insert/album.rs, dialogs/photo_album.rs): Insert > Photo Album opens a dialog to collect pictures and
// text boxes, with a layout, a frame, captions and black and white; Create puts the album into the open presentation after the
// current slide; Edit Photo Album rebuilds it. PowerPoint: the same, in a new presentation.
// What this proves in the app: the real dialogs open from the ribbon menu, show the pictures as thumbnails, create the slides
// (looked at in the captures), and Edit Photo Album reopens on the album with its pictures. Captures in artifacts/e2e/prism/album/.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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


test('prism photo album: create from the dialog, then edit it', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Album deck', {schema: 2});
  file.id = 'prism-album';
  file.content.slides[0].shapes[0].text = bodyFromText('Holiday');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/album', files: [file], renderer});
  const doc = file.id;
  const log = () => `
--- app log ---
${app.log.join('').slice(-3000)}`;
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = control => app.rpc('ui.activate', {doc, control});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'insert'});
    await app.rpc('ui.menu', {doc, control: 'insert.images.photo-album'});
    await sleep(400);
    await app.capture('1-photo-album-menu');
    await activate('insert.images.photo-album.new-photo-album');
    await sleep(500);
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.photoAlbum');
    await app.capture('2-new-album-empty');
    const items = [
      {kind: 'picture', name: 'Beach.png', data: png(64, 48, [230, 150, 60]), rot: 0, brightness: 0, contrast: 0},
      {kind: 'picture', name: 'Forest.png', data: png(48, 64, [50, 140, 80]), rot: 90, brightness: 0.2, contrast: 0},
      {kind: 'picture', name: 'Lake.png', data: png(64, 40, [60, 110, 200]), rot: 0, brightness: 0, contrast: 0},
      {kind: 'text', text: 'The end'},
    ];
    await app.rpc('ui.dialog.set', {field: 'items', value: items});
    await app.rpc('ui.dialog.set', {field: 'layout', value: '2title'});
    await app.rpc('ui.dialog.set', {field: 'frame', value: 'simple'});
    await app.rpc('ui.dialog.set', {field: 'captions', value: true});
    await sleep(500);
    await app.capture('3-new-album-filled');
    await app.rpc('ui.dialog.submit', {});
    await sleep(1200);
    let d = await deck();
    const made = d.slides.filter(s => s.name === 'Photo Album');
    assert.equal(made.length, 3, 'two pictures, one picture and the text slide');
    await app.capture('4-album-first-slide');
    await app.rpc('engine.execute', {doc, command: 'slide.go', params: {index: d.slides.indexOf(made[1])}});
    await sleep(500);
    await app.capture('5-album-second-slide');

    // Edit Photo Album reopens on the album.
    await app.rpc('ui.menu', {doc, control: 'insert.images.photo-album'});
    await sleep(300);
    await activate('insert.images.photo-album.edit-photo-album');
    await sleep(600);
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.photoAlbumEdit');
    assert.equal(dlg.values.items.length, 4);
    assert.equal(dlg.values.layout, '2title');
    await app.capture('6-edit-album-dialog');
    await app.rpc('ui.dialog.set', {field: 'layout', value: '1'});
    await app.rpc('ui.dialog.set', {field: 'frame', value: 'none'});
    await app.rpc('ui.dialog.submit', {});
    await sleep(1200);
    d = await deck();
    assert.equal(d.slides.filter(s => s.name === 'Photo Album').length, 4, 'one picture to a slide, then the text slide');
    await app.capture('7-album-edited');
  } finally {
    await app.close();
  }
});
