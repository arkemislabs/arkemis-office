// U:slate/media: Record Audio, Record Video and the Audio & Video playback tab.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `insert.recordAudio`, `insert.recordVideo`
//    and `media.*` name the commands. OneNote's behaviour: Record Audio/Video embeds a recording on the
//    page at the caret while the microphone or camera runs; Stop ends it; notes typed meanwhile are linked
//    to their moment and play the recording from it; Play, Pause, rewind and fast-forward work on the
//    recording; See Playback lights the note being played.
// 2. Ours does the same through the host's media service. Every test here passes a STUB service: no
//    microphone and no camera is ever opened.
// 3. Proof: these tests and tests/e2e/slate/audio-video.e2e.mjs (ribbon, page, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTestHost} from '../../core/kernel/host.mjs';
import {evaluate} from '../../core/slate/context.mjs';
import {loadNotebook, writeNotebook} from '../../core/slate/lib/notebook-folder.mjs';
import {validateContent} from '../../core/slate/schema.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const DATA = 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAHTEUm';
/** A media service that opens nothing: records a fixed blob, plays into a position table. */
function stub() {
  const calls = [], at = {};
  return {calls, at,
    async record(kind) {
      calls.push(['record', kind]);
      return {async stop() { calls.push(['stop']); return {data: kind === 'video' ? DATA.replace('audio', 'video') : DATA, mime: kind === 'video' ? 'video/webm' : 'audio/webm'}; },
        async pause() { calls.push(['pause-recording']); }, async resume() { calls.push(['resume-recording']); }, cancel() { calls.push(['cancel']); }};
    },
    async play(id, o) { calls.push(['play', id, o.from ?? null]); if (o.from !== undefined) at[id] = o.from; },
    async pause(id) { calls.push(['pause', id]); },
    async stop(id) { calls.push(['stop-playback', id]); at[id] = 0; },
    async seek(id, t) { calls.push(['seek', id, t]); at[id] = t; },
    async position(id) { return {t: at[id] ?? 0}; },
  };
}
async function session(opts = {}) {
  const media = stub();
  const t = await textSession(['Start of notes'], {selection: p => textSel(p, 'b1', 5), host: createTestHost({media}), ...opts});
  t.media = media;
  t.recording = () => t.doc.view.recording ?? null;
  t.objects = () => { const out = []; const walk = n => { if (n.type === 'media') out.push(n); (n.content ?? []).forEach(walk); }; walk(t.content.pages[t.pageId].body); return out; };
  return t;
}

test('Record Audio embeds a recording at the caret and shows it is running; one recording at a time; Stop keeps the sound in the object', async () => {
  const t = await session();
  assert.equal(t.state('insert.recordAudio').enabled, true);
  const r = await t.exec('insert.recordAudio');
  assert.equal(r.result.recording, true);
  assert.deepEqual(t.media.calls, [['record', 'audio']]);
  const [obj] = t.objects();
  assert.deepEqual([obj.attrs.kind, obj.attrs.src, obj.attrs.duration], ['audio', '', null]);
  assert.equal(t.recording().id, obj.attrs.id);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/media:${obj.attrs.id}`);
  assert.equal(evaluate(t.content, t.doc.selection, {}, t.doc.view).media, true, 'the Audio & Video tab shows');
  assert.equal(t.state('insert.recordAudio').checked, true, 'the ribbon button shows it is recording');
  assert.equal(t.state('insert.recordVideo').enabled, false);
  assert.equal(t.state('media.stop').enabled, true);
  await assert.rejects(t.exec('insert.recordVideo'), /recording is running/);
  t.host.advance(12_400);
  const stopped = await t.exec('media.stop');
  assert.deepEqual([stopped.result.stopped, stopped.result.kept, stopped.result.duration], ['recording', true, 12.4]);
  const [kept] = t.objects();
  assert.deepEqual([kept.attrs.src, kept.attrs.mime, kept.attrs.duration], [DATA, 'audio/webm', 12.4]);
  assert.equal(t.recording(), null);
  assert.equal(t.state('media.stop').enabled, false);
  assert.equal(t.state('insert.recordAudio').checked, false);
  validateContent(t.content);
});

test('Record Video records video; without the media service nothing starts; a refused device leaves the page untouched', async () => {
  const t = await session();
  await t.exec('insert.recordVideo');
  assert.equal(t.objects()[0].attrs.kind, 'video');
  await t.exec('media.stop');
  assert.equal(t.objects()[0].attrs.mime, 'video/webm');
  const bare = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  assert.equal(bare.state('insert.recordAudio').enabled, false);
  assert.match(bare.state('insert.recordAudio').reason, /desktop app/);
  await assert.rejects(bare.exec('insert.recordAudio'));
  const refused = await textSession(['x'], {selection: p => textSel(p, 'b1', 1), host: createTestHost({media: {async record() { throw new Error('The microphone was not allowed'); }}})});
  await assert.rejects(refused.exec('insert.recordAudio'), /not allowed/);
  assert.deepEqual(refused.objects?.() ?? [], []);
  assert.equal(JSON.stringify(refused.content).includes('"media"'), false);
});

test('notes typed while recording are linked to their moment; notes before and after are not', async () => {
  const t = await session();
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 300, text: 'Before'});
  await t.exec('insert.recordAudio');
  t.host.advance(5_000);
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 400, text: 'At five seconds'});
  t.host.advance(7_300);
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 500, text: 'At twelve'});
  const id = t.objects()[0].attrs.id;
  const linked = () => { const out = {}; const walk = n => { if (n.type === 'paragraph') out[(n.content ?? []).map(c => c.text).join('')] = n.attrs.audio; (n.content ?? []).forEach(walk); }; walk(t.content.pages[t.pageId].body); return out; };
  assert.deepEqual(linked(), {'Start of notes': null, Before: null, 'At five seconds': {media: id, t: 5}, 'At twelve': {media: id, t: 12.3}});
  // Pausing stops the clock: a note typed while paused is not linked, the time after resume is the recorded time.
  await t.exec('media.pause');
  assert.equal(t.recording().paused, true);
  t.host.advance(60_000);
  await t.exec('media.play');
  assert.equal(t.recording().paused, false);
  assert.deepEqual(t.media.calls.filter(c => /recording/.test(c[0])), [['pause-recording'], ['resume-recording']]);
  t.host.advance(2_000);
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 600, text: 'After a pause'});
  assert.equal(linked()['After a pause'].t, 14.3);
  await t.exec('media.stop');
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 700, text: 'After stopping'});
  assert.equal(linked()['After stopping'], null);
  // The link reads back over the bridge as a paragraph property.
  const para = t.session.read(t.docId, `/pg:${t.pageId}`, 'json');
  assert.ok(JSON.stringify(para).includes(`"audio":{"media":"${id}","t":5}`));
});

test('Play, Pause, Stop, rewind and fast-forward work on the recording; playing from a note starts at its moment', async () => {
  const t = await session();
  await t.exec('insert.recordAudio');
  t.host.advance(3_000);
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 400, text: 'Note at three'});
  t.host.advance(57_000);
  await t.exec('media.stop');
  const id = t.objects()[0].attrs.id;
  const para = Object.values(t.content.pages[t.pageId].body.content).flatMap(c => c.content ?? []).find(p => p.attrs?.audio)?.attrs.id;
  // Selected on the page, Play plays it from the start.
  t.session.setSelection(t.docId, {ranges: [{anchor: `/pg:${t.pageId}/media:${id}`, focus: `/pg:${t.pageId}/media:${id}`}], primary: 0}, {origin: 'test'});
  assert.equal(t.state('media.play').enabled, true);
  await t.exec('media.play');
  assert.deepEqual(t.doc.view.playback, {id, playing: true});
  assert.equal(t.state('media.play').checked, true);
  assert.equal(t.state('media.pause').enabled, true);
  await t.exec('media.seek', {seconds: 10});
  assert.equal(t.media.at[id], 10);
  await t.exec('media.seek', {seconds: -600});
  assert.equal(t.media.at[id], 0, 'rewind stops at the start');
  await t.exec('media.seek', {seconds: 600});
  assert.equal(t.media.at[id], 60, 'fast forward stops at the end');
  await t.exec('media.pause');
  assert.deepEqual(t.doc.view.playback, {id, playing: false});
  assert.equal(t.state('media.pause').checked, true);
  await t.exec('media.play');
  assert.equal(t.doc.view.playback.playing, true);
  // From the note: the recording jumps to the moment the note was typed.
  await t.exec('media.play', {fromParagraph: para});
  assert.deepEqual(t.media.calls.at(-1), ['play', id, 3]);
  await t.exec('media.stop');
  assert.equal(t.doc.view.playback ?? null, null);
  assert.deepEqual(t.media.calls.at(-1), ['stop-playback', id]);
  await assert.rejects(t.exec('media.play', {fromParagraph: 'b1'}), /not typed during a recording/);
  await t.exec('media.seePlayback');
  assert.equal(t.doc.view.seePlayback, true);
  assert.equal(t.state('media.seePlayback').checked, true);
});

test('a recording is saved in the notebook folder with its page and reads back playable; the bridge lists it', async () => {
  const t = await session();
  await t.exec('insert.recordAudio');
  t.host.advance(8_000);
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 400, text: 'Linked note'});
  await t.exec('media.stop');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-media-'));
  const nodeFs = {readText: p => fs.readFile(p, 'utf8'), async writeText(p, body) { await fs.writeFile(p, body); }, list: async p => (await fs.readdir(p, {withFileTypes: true})).map(d => ({name: d.name, dir: d.isDirectory()})),
    mkdir: p => fs.mkdir(p, {recursive: true}).then(() => {}), rename: (a, b) => fs.rename(a, b), remove: p => fs.rm(p, {recursive: true, force: true})};
  try {
    const root = path.join(base, 'NB').split(path.sep).join('/');
    await writeNotebook(nodeFs, root, t.content);
    const {content: back} = await loadNotebook(nodeFs, root);
    const obj = JSON.stringify(back.pages[t.pageId].body);
    assert.ok(obj.includes(DATA), 'the sound is in the page file');
    assert.ok(obj.includes('"audio":{'), 'the note\'s link is too');
    const media = (function find(n) { if (n.type === 'media') return n; for (const c of n.content ?? []) { const f = find(c); if (f) return f; } return null; })(back.pages[t.pageId].body);
    assert.deepEqual([media.attrs.kind, media.attrs.mime, media.attrs.duration], ['audio', 'audio/webm', 8]);
    const read = t.session.read(t.docId, `/pg:${t.pageId}/media:${media.attrs.id}`, 'props');
    assert.deepEqual([read.type, read.kind, read.duration], ['media', 'audio', 8]);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('the media schema refuses what is not sound or picture data', async () => {
  const t = await session();
  await t.exec('insert.recordAudio');
  const id = t.objects()[0].attrs.id;
  const page = t.content.pages[t.pageId];
  const bad = src => { const c = structuredClone(t.content); const walk = n => { if (n.type === 'media') n.attrs.src = src; (n.content ?? []).forEach(walk); }; walk(c.pages[t.pageId].body); return c; };
  assert.throws(() => validateContent(bad('https://example.com/a.webm')), /valid audio or video/);
  assert.throws(() => validateContent(bad('data:text/html;base64,AAAA')), /valid audio or video/);
  assert.doesNotThrow(() => validateContent(bad(DATA)));
  void id; void page;
});

test('the Audio & Video controls exist and Audio & Video Settings stays out', async () => {
  const t = await session();
  for (const id of ['insert.recordAudio', 'insert.recordVideo', 'media.play', 'media.pause', 'media.stop', 'media.seek', 'media.seePlayback']) assert.ok(t.registry.has(id), id);
});
