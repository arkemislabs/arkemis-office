// U:prism/media: audio and video on the slide (deckcraft cmd/media.rs): play and pause are requests the
// surface's player carries out and reports back, Poster Frame keeps a picture, and fades follow the trim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {base64Encode} from '../../core/prism/lib/shape-common.mjs';
import {encodePng} from '../../core/prism/lib/raster.mjs';
import {fadedVolume} from '../../core/prism/lib/media-play.mjs';

const clip = (id, video, extra = {}) => ({id, name: id, xfrm: {x: 100, y: 100, w: 320, h: 180}, kind: {type: 'media', media: 'mv', video, poster: null, crop: [0, 0, 0, 0], trimStartMs: 0, trimEndMs: 0,
  fadeInMs: 0, fadeOutMs: 0, volume: 1, autoplay: false, loopPlay: false, rewind: false, playAcrossSlides: false, hideWhileNotPlaying: false, fullScreen: false, bookmarks: [], durationMs: 0,
  width: 0, height: 0}, geom: {kind: 'preset', name: 'rect'}, ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '',
  title: '', decorative: false, click: null, hover: null, ...extra});
async function session({shapes = [clip('v', true)], host} = {}) {
  const c = createContent('Media');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.media = [{id: 'mv', name: 'clip.mp4', contentType: 'video/mp4', data: base64Encode(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0])), link: null}];
  c.slides = [newSlide({id: 's1', layout, shapes})];
  return createTestSession('prism', {content: c, host, selection: {ranges: [{anchor: `/sl:s1/sp:${shapes[0].id}`, focus: `/sl:s1/sp:${shapes[0].id}`}], primary: 0}});
}
const view = t => t.session.get(t.docId).view ?? {};
const live = t => t.session.get(t.docId).file.content;

test('play, pause, toggle, stop and seek ask the player; nothing plays by itself', async () => {
  const t = await session();
  assert.equal(view(t).mediaRequest, undefined);
  await t.exec('media.play', {from: 1500});
  assert.deepEqual([view(t).mediaRequest.action, view(t).mediaRequest.id, view(t).mediaRequest.ms], ['play', 'v', 1500]);
  const n = view(t).mediaRequest.n;
  await t.exec('media.pause', {});
  assert.equal(view(t).mediaRequest.action, 'pause');
  assert.ok(view(t).mediaRequest.n > n);
  await t.exec('media.seek', {ms: 4000});
  assert.equal(view(t).mediaRequest.ms, 4000);
  await assert.rejects(t.exec('media.seek', {}), /ms/);
  await t.exec('media.stop', {});
  assert.equal(view(t).mediaRequest.action, 'stop');
});

test('media.toggle is checked while the player reports the clip playing; media.info returns the options and status', async () => {
  const t = await session({shapes: [clip('v', true, {})]});
  assert.equal(t.state('media.toggle', {}).checked, false);
  await t.exec('media.report', {id: 'v', playing: true, positionMs: 2300, durationMs: 9000});
  assert.equal(t.state('media.toggle', {}).checked, true);
  await t.exec('media.options', {volume: 0.5, trimStart: 1000, loop: true});
  const info = (await t.exec('media.info', {})).result;
  assert.deepEqual([info.id, info.video, info.durationMs, info.options.volume, info.options.trimStart, info.options.loop, info.status.positionMs], ['v', true, 9000, 0.5, 1000, true, 2300]);
  assert.equal(info.contentType, 'video/mp4');
});

test('a slide with two clips needs one chosen; a shape is not a clip', async () => {
  const two = await session({shapes: [clip('v', true), clip('w', false)]});
  await assert.rejects(two.exec('media.play', {id: 'nope'}), /not a media shape|no such/);
  await two.exec('media.play', {id: 'w'});
  assert.equal(two.session.get(two.docId).view.mediaRequest.id, 'w');
  const none = await session({shapes: [{...clip('x', true), kind: {type: 'shape'}}]});
  await assert.rejects(none.exec('media.play', {}), /no audio or video|select an audio/);
  assert.equal(none.state('media.toggle', {}).enabled, false);
});

test('Poster Frame keeps a PNG as the poster, from the player, a file or nothing; only videos have one', async () => {
  const png = await encodePng({width: 4, height: 3, data: new Uint8ClampedArray(48).fill(200)});
  const data = `data:image/png;base64,${base64Encode(png)}`;
  const t = await session({host: createTestHost({pickImage: async () => data})});
  await t.exec('media.posterFrame', {data});
  const poster = live(t).slides[0].shapes[0].kind.poster;
  assert.ok(poster);
  assert.equal(live(t).media.find(m => m.id === poster).contentType, 'image/png');
  await t.exec('media.posterFrame', {reset: true});
  assert.equal(live(t).slides[0].shapes[0].kind.poster, null);
  await t.exec('media.posterFrame', {pick: true}, {origin: 'ui'});
  assert.ok(live(t).slides[0].shapes[0].kind.poster);
  await t.exec('media.posterFrame', {reset: true});
  const r = (await t.exec('media.posterFrame', {}, {origin: 'ui'})).result;
  assert.equal(r.requested, true);
  assert.equal(view(t).mediaRequest.action, 'poster', 'Current Frame asks the player for its frame');
  await assert.rejects(t.exec('media.posterFrame', {}, {origin: 'bridge'}), /data/);
  const audio = await session({shapes: [clip('a', false)]});
  await assert.rejects(audio.exec('media.posterFrame', {data}), /only videos/);
});

test('fades follow the trimmed length: in over the start, out over the end, never above the volume', () => {
  assert.equal(fadedVolume(1, 0, 10_000, 2000, 2000), 0);
  assert.equal(fadedVolume(1, 1000, 10_000, 2000, 2000), 0.5);
  assert.equal(fadedVolume(1, 5000, 10_000, 2000, 2000), 1);
  assert.equal(fadedVolume(1, 9000, 10_000, 2000, 2000), 0.5);
  assert.equal(fadedVolume(0.6, 5000, 10_000, 2000, 2000), 0.6);
  assert.equal(fadedVolume(1, 100, 0, 0, 0), 1);
});
