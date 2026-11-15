// U:prism/transitions: the Transitions tab commands (transition.set, options, timing, sound,
// applyAll, preview, list), the Slide Show commands (show.fromStart/fromCurrent/start/end, setup,
// customShow) and the .pptx round trip of transitions and animation timing.
//
// 1. ArtCraft: crates/engine/src/cmd/transition.rs (`set` takes the effect's first option and default
//    duration, `None` with nothing else set removes it, `timing` clamps at 59 s, `sound` embeds a WAV
//    once, `apply_all` copies the current transition), crates/engine/src/cmd/review.rs (`setup`,
//    `custom_show`, `start`), crates/pptx tests (transition XML). PowerPoint: Transitions tab, Slide
//    Show tab.
// 2. Ours: core/prism/commands/{transition,show}.mjs; the file is core/prism/formats/pptx-*.mjs.
// 3. These tests and tests/e2e/prism/transitions.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import animation from '../../core/prism/commands/animation.mjs';
import transition from '../../core/prism/commands/transition.mjs';
import show from '../../core/prism/commands/show.mjs';
import {withNew, curSlide, rect} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {transitionOptionLabel, builtinSound, BUILTIN_SOUNDS} from '../../core/prism/lib/anim-tables.mjs';
import {TRANSITIONS} from '../../core/prism/formats/pptx-read.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';

async function deck(n = 3) {
  const t = await withNew({extra: [animation, transition, show]});
  while (t.content.slides.length < n) await t.exec('slide.new', {});
  await t.exec('slide.go', {index: 0}).catch(() => {});
  return t;
}
const tr = (t, i = 0) => t.content.slides[i].transition;

test('transition.set: first option and default duration, explicit option and duration, None removes it; undo restores', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'transition.set', {kind: 'push'});
  assert.deepEqual([tr(t).kind, tr(t).option, tr(t).durationMs], ['push', 'u', 1000]);
  await t.exec('transition.set', {kind: 'wipe', option: 'ld', duration: 2500});
  assert.deepEqual([tr(t).kind, tr(t).option, tr(t).durationMs], ['wipe', 'ld', 2500]);
  await t.exec('transition.set', {kind: 'morph'});
  assert.deepEqual([tr(t).kind, tr(t).option, tr(t).durationMs], ['morph', 'objects', 2000]);
  await t.exec('transition.set', {kind: 'none'});
  assert.equal(tr(t), null, 'None with nothing else set removes the transition');
  await t.exec('transition.timing', {after: 3000});
  await t.exec('transition.set', {kind: 'none'});
  assert.equal(tr(t).advanceAfterMs, 3000, 'None keeps the advance timing');
  await assert.rejects(t.exec('transition.set', {kind: 'nope'}), e => e.code === 'invalid_params' && e.data.path === '/kind');
  await assert.rejects(t.exec('transition.set', {kind: 'fade', index: -1}), undefined);
  await assert.rejects(t.exec('transition.set', {kind: 'fade', index: 9}), /no slide 9/);
});

test('transition.set goes to the selected slides, else the current one, else `index`', async () => {
  const t = await deck();
  await t.exec('transition.set', {kind: 'fade', index: 2});
  assert.deepEqual(t.content.slides.map(s => s.transition?.kind ?? null), [null, null, 'fade']);
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${t.content.slides[0].id}`}, {anchor: `/sl:${t.content.slides[1].id}`}], primary: 0});
  await t.exec('transition.set', {kind: 'cover', option: 'ru'});
  assert.deepEqual(t.content.slides.map(s => s.transition?.kind ?? null), ['cover', 'cover', 'fade']);
});

test('transition.options changes slides that have a transition and leaves the others alone; state lists the labelled options', async () => {
  const t = await deck();
  assert.equal(t.state('transition.options', {}).enabled, false, 'no transition yet');
  await t.exec('transition.set', {kind: 'push'});
  const rows = t.state('transition.options', {}).value;
  assert.deepEqual(rows.map(r => r.label), ['From Bottom', 'From Top', 'From Right', 'From Left']);
  assert.deepEqual(rows.filter(r => r.checked).map(r => r.value), ['u']);
  await expectUndoRoundTrip(t, 'transition.options', {option: 'r'});
  assert.equal(tr(t).option, 'r');
  await t.exec('transition.options', {option: 'l', index: 1});
  assert.equal(tr(t, 1), null);
  await t.exec('transition.set', {kind: 'flash'});
  assert.equal(t.state('transition.options', {}).enabled, false, 'Flash has no options');
});

test('transition.timing: Duration (at most 59 s), On Mouse Click, After; the ribbon reads them back', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'transition.timing', {duration: 90_000, onClick: false, after: 4000});
  assert.deepEqual([tr(t).durationMs, tr(t).advanceOnClick, tr(t).advanceAfterMs, tr(t).kind], [59_000, false, 4000, 'none']);
  assert.equal(t.state('transition.timing', {field: 'duration'}).value, 59);
  assert.equal(t.state('transition.timing', {field: 'onClick'}).checked, false);
  assert.equal(t.state('transition.timing', {field: 'after'}).checked, true);
  assert.equal(t.state('transition.timing', {field: 'afterTime'}).value, 4);
  await t.exec('transition.timing', {after: null});
  assert.equal(tr(t).advanceAfterMs, null);
  await t.exec('transition.timing', {afterOn: true});
  assert.equal(tr(t).advanceAfterMs, 0, 'the After check box starts at 0 s');
  await t.exec('transition.timing', {afterOn: false});
  assert.equal(tr(t).advanceAfterMs, null);
  const fresh = await deck();
  assert.equal(fresh.state('transition.timing', {field: 'duration'}).value, 1, 'a slide with no transition shows 1 s');
  assert.equal(fresh.state('transition.timing', {field: 'onClick'}).checked, true);
});

test('transition.sound: built-in sounds are embedded once; None, Stop Previous, Loop Until Next Sound, a given file; state names the sound', async () => {
  const t = await deck();
  assert.equal(t.state('transition.sound', {}).value, 'No Sound');
  await expectUndoRoundTrip(t, 'transition.sound', {builtin: 'chime'});
  assert.equal(t.state('transition.sound', {}).value, 'Chime');
  const media = tr(t).sound;
  assert.ok(media);
  assert.equal(t.content.media.find(m => m.id === media).contentType, 'audio/wav');
  await t.exec('transition.sound', {builtin: 'chime', index: 1});
  assert.equal(t.content.media.length, 1, 'the same built-in sound is embedded once');
  assert.equal(tr(t, 1).sound, media);
  await t.exec('transition.sound', {field: 'loop'});
  assert.equal(tr(t).soundLoop, true, 'field alone toggles Loop Until Next Sound');
  assert.equal(t.state('transition.sound', {field: 'loop'}).checked, true);
  await t.exec('transition.sound', {builtin: 'click'});
  assert.equal(tr(t).soundLoop, true, 'a new sound keeps Loop Until Next Sound');
  await t.exec('transition.sound', {stopPrevious: true});
  assert.deepEqual([tr(t).sound, tr(t).stopSound, !!tr(t).soundLoop], [null, true, false]);
  assert.equal(t.state('transition.sound', {}).value, 'Stop Previous Sound');
  await t.exec('transition.sound', {none: true});
  assert.deepEqual([tr(t).sound, !!tr(t).stopSound], [null, false]);
  assert.equal(t.state('transition.sound', {field: 'loop'}).enabled, false, 'loop needs a sound');
  await assert.rejects(t.exec('transition.sound', {builtin: 'nope'}), e => e.data.path === '/builtin');
  await assert.rejects(t.exec('transition.sound', {}), /give/);
  await assert.rejects(t.exec('transition.sound', {data: 'aGVsbG8=', name: 'x.txt'}), /not a sound file/);
  const wav = Buffer.from(builtinSound('laser')).toString('base64');
  const r = await t.exec('transition.sound', {data: wav, name: 'mine.wav'});
  assert.equal(r.result.sound, 'mine.wav');
  assert.equal(t.state('transition.sound', {}).value, 'mine');
  await assert.rejects(t.exec('transition.sound', {pick: true}), /desktop app/, 'Other Sound… needs the host');
});

test('every built-in sound is a playable mono 16-bit WAV', () => {
  for (const [id] of BUILTIN_SOUNDS) {
    const b = builtinSound(id);
    const dv = new DataView(b.buffer);
    assert.equal(String.fromCharCode(...b.slice(0, 4)), 'RIFF', id);
    assert.equal(dv.getUint16(22, true), 1);
    assert.equal(dv.getUint16(34, true), 16);
    const seconds = (b.length - 44) / 2 / dv.getUint32(24, true);
    assert.ok(seconds > 0.01 && seconds < 2, `${id}: ${seconds}`);
    assert.ok(b.slice(44).some(x => x !== 0), `${id} is not silent`);
  }
  assert.equal(builtinSound('nope'), null);
});

test('transition.applyAll copies the current slide\'s transition to every slide, sound included', async () => {
  const t = await deck(4);
  await t.exec('transition.set', {kind: 'cube', option: 'u', duration: 1800});
  await t.exec('transition.sound', {builtin: 'whoosh'});
  await t.exec('transition.timing', {after: 2000, onClick: false});
  await expectUndoRoundTrip(t, 'transition.applyAll', {});
  for (const s of t.content.slides) assert.deepEqual([s.transition.kind, s.transition.option, s.transition.durationMs, s.transition.advanceAfterMs, !!s.transition.sound], ['cube', 'u', 1800, 2000, true]);
  assert.notEqual(tr(t, 1), tr(t, 0), 'each slide has its own copy');
  // From a slide with none, it clears them all.
  await t.exec('slide.go', {index: 3}).catch(() => {});
  await t.exec('transition.set', {kind: 'none', index: 3});
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${t.content.slides[3].id}`}], primary: 0});
  await t.exec('transition.timing', {after: null, onClick: true, index: 3});
  await t.exec('transition.set', {kind: 'none', index: 3});
  await t.exec('transition.applyAll', {});
  assert.ok(t.content.slides.every(s => s.transition === null || s.transition.kind === 'none'));
});

test('transition.list and the gallery state: every effect, by category, with a drawn picture; Effect Options labels are upstream\'s', async () => {
  const t = await deck();
  const list = (await t.exec('transition.list', {})).result;
  assert.equal(list.length, TRANSITIONS.length);
  assert.equal(list.find(x => x.id === 'morph').durationMs, 2000);
  assert.deepEqual(list.find(x => x.id === 'push').options.map(o => o.label), ['From Bottom', 'From Top', 'From Right', 'From Left']);
  await t.exec('transition.set', {kind: 'cube'});
  const gal = t.state('transition.set', {}).value;
  assert.deepEqual([...new Set(gal.map(g => g.group))], ['Subtle', 'Exciting', 'Dynamic Content']);
  assert.equal(gal.filter(g => g.inline).length, 12);
  assert.deepEqual(gal.filter(g => g.selected).map(g => g.id), ['cube']);
  assert.ok(gal.every(g => g.icon === `transition-${g.id}`));
  for (const [id, , , , opts] of TRANSITIONS) for (const o of opts) assert.ok(transitionOptionLabel(id, o) !== '' || id === 'cut', `${id}/${o}`);
  assert.equal(transitionOptionLabel('push', 'l'), 'From Right');
  assert.equal(transitionOptionLabel('cover', 'ru'), 'From Bottom-Left');
  assert.equal(transitionOptionLabel('ripple', 'ru'), 'From Bottom-Left');
  assert.equal(transitionOptionLabel('glitter', 'hexU'), 'Hexagons From Top');
  assert.equal(transitionOptionLabel('glitter', 'l'), 'Diamonds From Left');
  assert.equal(transitionOptionLabel('wind', 'l'), 'Left');
  assert.equal(transitionOptionLabel('pageCurlDouble', 'singleR'), 'Single Right');
  assert.equal(transitionOptionLabel('shred', 'particlesOut'), 'Particles Out');
  assert.equal(transitionOptionLabel('zoom', 'rotate'), 'Zoom and Rotate');
  assert.equal(transitionOptionLabel('split', 'vertIn'), 'Vertical In');
  const r = await t.exec('transition.preview', {});
  assert.equal(r.result.on, true);
  assert.equal(t.doc.view.transitionPreview.on, true);
});

test('Slide Show: Play from Start / Current Slide / Slide Show / End Show are view requests; setup and custom shows write the deck', async () => {
  const t = await deck(4);
  await t.exec('show.fromStart', {});
  assert.equal(t.doc.view.show.from, 0);
  const n = t.doc.view.show.n;
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${t.content.slides[2].id}`}], primary: 0});
  await t.exec('show.fromCurrent', {});
  assert.deepEqual([t.doc.view.show.from, t.doc.view.show.n > n], [2, true]);
  assert.equal(t.state('show.end').enabled, true);
  await t.exec('show.end', {});
  assert.equal(t.doc.view.show, null);
  assert.equal(t.state('show.end').enabled, false);
  // Set Up Slide Show.
  await expectUndoRoundTrip(t, 'show.setup', {type: 'kiosk', noAnimation: true, from: 2, to: 3});
  assert.deepEqual([t.content.show.showType, t.content.show.loopUntilEsc, t.content.show.withoutAnimation, t.content.show.range], ['kiosk', true, true, [2, 3]]);
  await t.exec('show.setup', {all: true, useTimings: false, playNarrations: false, showMediaControls: false});
  assert.deepEqual([t.content.show.range, t.content.show.useTimings, t.content.show.withoutNarration, t.content.show.showMediaControls], [null, false, true, false]);
  assert.equal(t.state('show.setup', {field: 'useTimings'}).checked, false);
  assert.equal(t.state('show.setup', {field: 'noNarration'}).checked, false);
  // Custom shows.
  await t.exec('show.customShow', {name: 'Short', slides: [3, 1, 9]});
  assert.deepEqual(t.content.customShows, [{name: 'Short', slides: [t.content.slides[3].id, t.content.slides[1].id]}]);
  await t.exec('show.setup', {custom: 'Short'});
  assert.equal(t.content.show.customShow, 'Short');
  await t.exec('show.start', {custom: 'Short'});
  assert.equal(t.doc.view.show.custom, 'Short');
  await assert.rejects(t.exec('show.start', {custom: 'Missing'}), e => e.data.path === '/custom');
  await t.exec('show.customShow', {name: 'Short', delete: true});
  assert.deepEqual(t.content.customShows, []);
});

test('transitions, sound and animation timing survive a .pptx round trip', async () => {
  const t = await withNew({extra: [animation, transition, show], shapes: [rect('11', [10, 10, 100, 100]), rect('12', [150, 10, 100, 100])]});
  await t.exec('slide.new', {});
  await t.exec('transition.set', {kind: 'cube', option: 'u', duration: 1800, index: 0});
  await t.exec('transition.set', {kind: 'fade', option: 'throughBlack', index: 1});
  await t.exec('transition.timing', {after: 2500, onClick: false, index: 1});
  await t.exec('transition.sound', {builtin: 'camera', index: 1});
  await t.exec('transition.sound', {field: 'loop', index: 1});
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${t.content.slides[0].id}/sp:11`}], primary: 0});
  await t.exec('animation.add', {effect: 'fly', class: 'entrance', option: 'fromTopLeft', duration: 750});
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${t.content.slides[0].id}/sp:12`}], primary: 0});
  await t.exec('animation.add', {effect: 'spin', class: 'emphasis', start: 'withPrevious', delay: 250});
  await t.exec('animation.add', {effect: 'lines', class: 'path', option: 'right'});
  await t.exec('animation.timing', {index: 2, trigger: '11'});
  const bytes = await exportPptx(t.content);
  const d = await importPptx(bytes);
  const s0 = d.slides[0], s1 = d.slides[1];
  assert.deepEqual([s0.transition.kind, s0.transition.option, s0.transition.durationMs], ['cube', 'u', 1800]);
  assert.deepEqual([s1.transition.kind, s1.transition.option, s1.transition.advanceOnClick, s1.transition.advanceAfterMs, !!s1.transition.soundLoop], ['fade', 'throughBlack', false, 2500, true]);
  assert.ok(s1.transition.sound, 'the sound is embedded and referenced again');
  assert.equal(d.media.find(m => m.id === s1.transition.sound).contentType, 'audio/wav');
  assert.deepEqual(s0.animations.map(a => [a.effect, a.class, a.start, a.durationMs, a.delayMs]), [['fly', 'entrance', 'onClick', 750, 0], ['spin', 'emphasis', 'withPrevious', 2000, 250], ['lines', 'path', 'onClick', 2000, 0]]);
  assert.equal(s0.animations[0].option, 'lt');
  assert.equal(s0.animations[2].option, 'right');
  assert.equal(s0.animations[2].trigger, '11', 'a triggered effect keeps its trigger shape');
});

test('Set Up Show dialog: starts from the deck\'s settings and submits show.setup', async () => {
  const {default: dlg} = await import('../../core/prism/dialogs/setupShow.mjs');
  const t = await deck(4);
  const v = dlg.init({doc: t.content});
  assert.deepEqual([v.type, v.loop, v.nn, v.na, v.ut, v.slides, v.from, v.to], ['speaker', false, false, false, true, 'all', 1, 4]);
  assert.deepEqual(dlg.toCommand(v), {command: 'show.setup', params: {type: 'speaker', loop: false, noNarration: false, noAnimation: false, useTimings: true, penColor: '#FF0000', laserColor: '#FF0000', all: true}});
  assert.deepEqual(dlg.validate({...v, slides: 'range', from: 3, to: 2}).map(p => p.field), ['to']);
  assert.deepEqual(dlg.validate({...v, slides: 'custom', custom: ' '}).map(p => p.field), ['custom']);
  const out = dlg.toCommand({...v, type: 'kiosk', na: true, ut: false, slides: 'range', from: 2, to: 3});
  await t.exec(out.command, out.params);
  assert.deepEqual([t.content.show.showType, t.content.show.loopUntilEsc, t.content.show.withoutAnimation, t.content.show.useTimings, t.content.show.range], ['kiosk', true, true, false, [2, 3]]);
  assert.deepEqual(dlg.init({doc: t.content}).slides, 'range');
});

test('the show\'s own commands (next, previous, first, last, goto, black and white screen, report, status) drive the running show; the Animation Pane toggles', async () => {
  const t = await deck(4);
  await assert.rejects(t.exec('show.next'), e => e.code === 'disabled' && /no slide show is running/.test(e.message));
  assert.equal(t.state('show.next').enabled, false);
  assert.equal((await t.exec('show.status')).result, null);
  await t.exec('show.fromStart');
  const cmd = () => t.doc.view.showCmd;
  const sent = async (id, params = {}) => { const before = cmd()?.n ?? 0; await t.exec(id, params); assert.equal(cmd().n, before + 1, `${id} posts one request`); return cmd(); };
  assert.equal((await sent('show.next')).kind, 'next');
  assert.equal((await sent('show.previous')).kind, 'previous');
  assert.equal((await sent('show.first')).kind, 'first');
  assert.equal((await sent('show.last')).kind, 'last');
  const g = await sent('show.goto', {index: 2});
  assert.deepEqual([g.kind, g.index], ['goto', 2]);
  assert.equal((await sent('show.blackScreen')).kind, 'blackScreen');
  assert.equal((await sent('show.whiteScreen')).kind, 'whiteScreen');
  // The show reports where it is; show.status reads it back, and ending the show clears it.
  await t.exec('show.report', {slide: 2, step: 1, playing: false, ended: false, transition: 'cube:on', blank: null});
  assert.deepEqual((await t.exec('show.status')).result, {slide: 2, step: 1, playing: false, ended: false, transition: 'cube:on', blank: null});
  await t.exec('show.end');
  assert.equal((await t.exec('show.status')).result, null);
  // The Animation Pane (Animations › Advanced Animation): a toggle the surface turns into the pane.
  assert.equal(t.state('animation.pane').checked, false);
  await t.exec('animation.pane');
  assert.deepEqual([t.doc.view.panes.animation, t.doc.view.paneRequest.on], [true, true]);
  assert.equal(t.state('animation.pane').checked, true);
  await t.exec('animation.pane', {on: false, mirror: true});
  assert.deepEqual([t.doc.view.panes.animation, t.doc.view.paneRequest.on], [false, true], 'a mirror report changes the state, not the request');
  await t.exec('animation.pane', {on: true});
  await t.exec('animation.pane');
  assert.equal(t.doc.view.panes.animation, false);
});
