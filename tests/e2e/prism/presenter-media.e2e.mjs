// Prism: Presenter View beside a running Slide Show, and an audio clip played from the Playback tab.
//
// What deckcraft does: show/presenter.rs (the presenter window: current and next slide, notes, timer, count; its
// buttons drive the show) and media.rs (play, pause and seek are requests the UI host's player carries out).
// What this proves end to end: the presenter window opens (hidden in test mode), draws "Slide n of m" and the notes
// of the slide the show is at, follows Next, and closes with the show; an audio clip plays only when asked, reports
// its state, and pauses. Nothing on any screen is captured. Captures in artifacts/e2e/prism/presenter-media/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom, slide} from '../../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {base64Encode} from '../../../core/prism/lib/shape-common.mjs';

/** A one-second 440 Hz tone as a 16-bit mono WAV. */
function wav() {
  const rate = 8000, n = rate, data = new Uint8Array(n * 2), dv = new DataView(data.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 6000), true);
  const out = new Uint8Array(44 + data.length), h = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); h.setUint32(4, 36 + data.length, true); tag(8, 'WAVE'); tag(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); tag(36, 'data'); h.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

test('prism presenter view and audio playback', {timeout: 600_000}, async () => {
  const file = createFile('prism', 'Presenter and media deck', {schema: 2});
  file.id = 'prism-presenter-media';
  const c = file.content;
  const s1 = c.slides[0];
  s1.shapes = [shape({id: 'au', name: 'Audio 1', xfrm: {x: 100, y: 120, w: 48, h: 48}, kind: {type: 'media', media: 'wav1', video: false, poster: null, crop: [0, 0, 0, 0], trimStartMs: 0, trimEndMs: 0,
    fadeInMs: 0, fadeOutMs: 0, volume: 1, autoplay: false, loopPlay: false, rewind: false, playAcrossSlides: false, hideWhileNotPlaying: false, fullScreen: false, bookmarks: [], durationMs: 0, width: 0, height: 0}, geom: presetGeom('rect')})];
  s1.notes = bodyFromText('Welcome everyone. Start with the agenda.');
  c.slides.push(slide({id: 's2', layout: s1.layout, shapes: [], notes: bodyFromText('Second slide: the numbers.')}), slide({id: 's3', layout: s1.layout, shapes: [], notes: bodyFromText('Third slide: questions.')}));
  c.media = [{id: 'wav1', name: 'tone.wav', contentType: 'audio/wav', data: base64Encode(wav()), link: null}];
  c.nextId = Math.max(c.nextId, 400);
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/presenter-media', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const out = async (command, params = {}) => (await run(command, params)).result;
  const wait = (fn, what) => app.until(fn, {timeout: 60_000}).catch(e => { throw new Error(`${what}: ${e.message}${log()}`); });
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // The clip is drawn as a frame; nothing plays by itself.
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s1.id}/sp:au`, focus: `/sl:${s1.id}/sp:au`}]});
    await app.rpc('ui.tab', {doc, tab: 'playback'}).catch(() => {});
    await app.capture('1-audio-frame');
    assert.equal((await out('media.info')).status, undefined);

    // Play from the Playback tab: the player reports playing; pause stops it part way; it plays out and reports the end.
    await app.rpc('ui.activate', {doc, control: 'playback.preview.play'});
    await wait(async () => ((await out('media.info')).status?.playing ? true : null), 'the clip starts');
    await new Promise(r => setTimeout(r, 500));
    await app.rpc('ui.activate', {doc, control: 'playback.preview.play'});
    const paused = await wait(async () => { const st = (await out('media.info')).status; return st && !st.playing ? st : null; }, 'the clip pauses');
    assert.ok(paused.positionMs > 0, `paused at ${paused.positionMs} ms`);
    await run('media.stop');
    await wait(async () => { const st = (await out('media.info')).status; return st && !st.playing && st.positionMs === 0 ? true : null; }, 'the clip stops at its start');
    await run('media.play', {from: 600});
    await wait(async () => ((await out('media.info')).status?.playing ? true : null), 'the clip starts at 600 ms');
    await wait(async () => { const st = (await out('media.info')).status; return st && !st.playing ? true : null; }, 'the clip plays out');

    // Presenter View: on, then the show starts; the presenter window draws the first slide with its notes and count.
    await run('show.presenter', {on: true});
    await run('show.start', {});
    const first = await wait(async () => { const st = await out('show.status'); return st?.presenter?.open && st.presenter.slide === 0 ? st.presenter : null; }, 'the presenter window draws slide 1');
    assert.equal(first.count, 'Slide 1 of 3');
    assert.equal(first.notes, 'Welcome everyone. Start with the agenda.');
    assert.equal(first.next, 1);
    await app.capture('2-show-running');
    await run('show.next');
    const second = await wait(async () => { const st = await out('show.status'); return st?.presenter?.slide === 1 ? st.presenter : null; }, 'the presenter window follows to slide 2');
    assert.equal(second.count, 'Slide 2 of 3');
    assert.equal(second.notes, 'Second slide: the numbers.');
    assert.equal(second.next, 2);
    await run('show.last');
    await wait(async () => ((await out('show.status'))?.presenter?.count === 'Slide 3 of 3' ? true : null), 'the presenter window reaches the last slide');
    await run('show.end');
    await wait(async () => ((await out('show.status')) === null ? true : null), 'the show ends');
    assert.equal((await out('media.info')).status?.playing ?? false, false);
  } finally {
    await app.close();
  }
});
