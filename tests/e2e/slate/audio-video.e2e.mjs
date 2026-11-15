// U:slate/media: Record Audio, Record Video and the Audio & Video playback tab on a real page, end to end
// through the bridge. In test mode the media service records from a SYNTHETIC stream (an oscillator and a
// canvas): the same MediaRecorder path runs and the recording is embedded, saved in the vault and read
// back, but no microphone and no camera is ever opened. Every step is checked in the document and captured.
//
// Behaviour fidelity: see tests/slate/media.test.mjs. Evidence: artifacts/e2e/slate/audio-video/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = new Date().toISOString();
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});

function seed() {
  let n = 0;
  const c = createContent('Lecture', {uid: () => `a${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['s1']; c.groups = {};
  c.sections = {s1: {id: 's1', name: 'Class', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'p1', level: 0}]}};
  c.pages = {p1: {...newPageRecord({id: 'p1', title: 'Recorded lecture', created: NOW}), body: {type: 'doc', content: [{type: 'container', attrs: {id: 'c1', x: 60, y: 130, width: 560}, content: [para('b1', 'Notes for the lecture: ')]}]}}};
  return validateContent(c);
}
const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate Audio & Video: record audio and video, notes linked to their moment, play, pause, seek, saved in the notebook', {timeout: 600_000}, async () => {
  const doc = 'slate-audio-video';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/audio-video', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const pick = id => app.rpc('ui.activate', {doc, control: id});
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls.find(c => c.id === id);
  const objects = async () => { const out = []; const walk = n => { if (n?.type === 'media') out.push(n.attrs); (n?.content ?? []).forEach(walk); }; walk((await read('/pg:p1')).body); return out; };
  const notes = async () => { const out = {}; const walk = n => { if (n?.type === 'paragraph') out[(n.content ?? []).map(c => c.text ?? '').join('')] = n.attrs.audio; (n?.content ?? []).forEach(walk); }; walk((await read('/pg:p1')).body); return out; };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });

    // ---- Record Audio from the Insert tab: an indicator on the page and in the ribbon ---------------------------------------
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/pg:p1/b:b1/t:23', focus: '/pg:p1/b:b1/t:23'}]});
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle(700);
    await app.capture('01-insert-tab', {doc});
    assert.equal((await control('insert.recording.record-audio')).enabled, true, 'Record Audio is on the Insert tab');
    assert.equal((await control('insert.recording.record-video')).enabled, true);
    await pick('insert.recording.record-audio');
    await app.until(async () => (await objects()).length === 1 || null, {timeout: 20_000}).catch(async e => { const why = await exec('insert.recordAudio').then(() => 'ran', x => x.message); throw new Error(`${e.message}: ${why} ${JSON.stringify(await read('/pg:p1')).slice(0, 900)}${log()}`); });
    const [live] = await objects();
    assert.deepEqual([live.kind, live.src], ['audio', ''], 'the recording object is on the page while it runs');
    assert.ok((await inspect()).contextualTabs.includes('audio-and-video'), 'the Audio & Video tab shows');
    await app.rpc('ui.tab', {doc, id: 'audio-and-video'});
    assert.equal((await control('media.recording.audio')).checked, true, 'the ribbon button shows it is recording');
    assert.equal((await control('media.recording.video')).enabled, false, 'one recording at a time');
    await settle(1400);
    await app.capture('02-recording-indicator', {doc});
    // A note typed now is linked to its moment.
    await exec('surface.newContainer', {page: 'p1', x: 60, y: 520, text: 'Key point about energy'});
    await settle(1300);
    await exec('surface.newContainer', {page: 'p1', x: 60, y: 600, text: 'Second key point'});
    await settle(500);
    await app.rpc('ui.tab', {doc, id: 'audio-and-video'});
    await settle(500);
    await app.capture('03-audio-video-tab-recording', {doc});
    assert.equal((await control('media.playback.stop')).enabled, true, 'Stop is one click');
    await pick('media.playback.stop');
    await app.until(async () => (await objects())[0]?.src ? true : null, {timeout: 20_000});
    const [kept] = await objects();
    assert.match(kept.src, /^data:audio\//);
    assert.ok(kept.duration >= 2 && kept.duration < 20, `the recording has its time (${kept.duration} s)`);
    const linked = await notes();
    assert.equal(linked['Notes for the lecture: '], null, 'a note from before the recording is not linked');
    const first = linked['Key point about energy'], second = linked['Second key point'];
    assert.equal(first.media, kept.id);
    assert.ok(first.t >= 1 && first.t < 6, `the first note is at ${first.t} s`);
    assert.ok(second.t > first.t, 'the second note is later');
    await settle(500);
    await app.capture('04-recording-kept', {doc});

    // ---- Playback: play, pause, seek, rewind, forward, from a note, See Playback ---------------------------------------------
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/pg:p1/media:${kept.id}`, focus: `/pg:p1/media:${kept.id}`}]});
    await settle(400);
    assert.equal((await control('media.playback.play')).enabled, true);
    await pick('media.playback.play');
    await app.until(async () => (await control('media.playback.play'))?.checked || null, {timeout: 10_000});
    assert.equal((await control('media.playback.pause')).enabled, true);
    await settle(600);
    await app.capture('05-playing', {doc});
    await pick('media.playback.pause');
    assert.equal((await control('media.playback.pause')).checked, true);
    const back = await exec('media.seek', {seconds: -10});
    assert.equal(back.at, 0, 'rewind stops at the start');
    const fwd = await exec('media.seek', {seconds: 10});
    assert.ok(fwd.at <= kept.duration + 0.5, 'fast forward stops at the end');
    await pick('media.playback.rewind-10-seconds');
    const noteId = async text => { let hit = null; const walk = n => { if (n?.type === 'paragraph' && (n.content ?? []).map(c => c.text ?? '').join('') === text) hit = n.attrs.id; (n?.content ?? []).forEach(walk); }; walk((await read('/pg:p1')).body); return hit; };
    const from = await exec('media.play', {fromParagraph: await noteId('Key point about energy')});
    assert.equal(from.from, first.t, 'playing from a note starts at the moment it was typed');
    await pick('media.options.see-playback');
    assert.equal((await control('media.options.see-playback')).checked, true);
    await settle(400);
    await app.capture('06-see-playback', {doc});
    await pick('media.playback.stop');
    await app.until(async () => !(await control('media.playback.stop'))?.enabled || null, {timeout: 10_000});

    // ---- Record Video: the camera's picture is the object --------------------------------------------------------------------
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/pg:p1/b:b1/t:23', focus: '/pg:p1/b:b1/t:23'}]});
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await pick('insert.recording.record-video');
    await app.until(async () => (await objects()).length === 2 || null, {timeout: 20_000});
    await settle(1500);
    await pick('media.playback.stop').catch(async () => { await exec('media.stop'); });
    await app.until(async () => (await objects()).every(o => o.src) || null, {timeout: 20_000});
    const all = await objects();
    const v = all.find(o => o.kind === 'video');
    assert.match(v.src, /^data:video\//);
    await settle(800);
    await app.capture('07-video-recording', {doc});

    // ---- Saved in the notebook and read back ---------------------------------------------------------------------------------
    const vault = path.join(app.data, 'documents', `${doc}.json`);
    await app.until(async () => { const t = await fs.readFile(vault, 'utf8'); return t.includes('data:video/') && t.includes('data:audio/') && t.includes('"audio":{') ? t : null; }, {timeout: 30_000});
    const props = await read(`/pg:p1/media:${kept.id}`, 'props');
    assert.deepEqual([props.type, props.kind], ['media', 'audio']);
    assert.ok(props.duration >= 2);
  } finally {
    await app.close();
  }
});
