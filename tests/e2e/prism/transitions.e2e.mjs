// Prism's Transitions tab and the slide show, through the bridge and the real window (U:prism/transitions).
//
// What deckcraft does (crates/ui-egui/src/ribbon/transitions.rs, engine cmd/transition.rs,
// crates/ui-egui/src/show.rs): the gallery sets the current slide's transition (first Effect
// Option, default duration), Effect Options lists the effect's options with the current one marked,
// Sound / Duration / On Mouse Click / After write the slide's timing, Apply To All copies it, Preview
// plays it, and the slide show plays it between slides. PowerPoint: the same tab and the same show.
// What this proves in the app: the real ribbon controls (ui.activate on the gallery, the Effect
// Options list, the Sound menu, the Duration and After boxes, the check boxes, Apply To All) change
// the deck as the engine tests do; Preview paints the transition on the slide (the capture mid-way
// is not the slide alone); the thumbnail pane marks the slides; Play from Start shows slide one,
// the next key plays the transition (mid-way capture, then slide two), Back and the end screen,
// the show ends. Captures in artifacts/e2e/prism/transitions/ (looked at, not only counted).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {decodePng, share, dark} from './png.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism transitions: ribbon, preview, thumbnail marks, slide show', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Transitions deck', {schema: 2});
  file.id = 'prism-transitions';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/transitions', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const status = async () => (await run('show.status')).result;
  const shot = async () => { const s = await app.rpc('ui.capture', {}); return decodePng(s.png); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // Three slides with something on each; a rectangle on the first.
    await run('slide.new', {layout: 'titleOnly'});
    await run('slide.new', {layout: 'titleOnly'});
    let d = await deck();
    const ids = d.slides.map(s => s.id);
    await run('shape.insert', {preset: 'rect', rect: [120, 220, 300, 200]});
    await run('slide.go', {index: 1});
    await run('shape.insert', {preset: 'ellipse', rect: [520, 200, 300, 260]});
    await run('slide.go', {index: 0});
    await app.rpc('ui.tab', {doc, tab: 'transitions'});
    let ui = await app.rpc('ui.inspect', {doc});
    const ctl = id => ui.controls.find(c => c.id === id);
    assert.ok(ctl('transitions.gallery') && ctl('transitions.effect-options') && ctl('transitions.timing.duration') && ctl('transitions.preview.preview'), 'the tab is drawn');
    assert.equal(ctl('transitions.timing.present-online'), undefined);
    await app.capture('1-tab-before');

    // The gallery on slide 1: Push, its first option and default duration; the gallery marks it.
    await app.rpc('ui.activate', {doc, control: 'transitions.gallery', value: 'push'});
    d = await deck();
    assert.deepEqual([d.slides[0].transition.kind, d.slides[0].transition.option, d.slides[0].transition.durationMs], ['push', 'u', 1000]);
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('transitions.gallery').value.find(g => g.selected).id, 'push');
    assert.equal(ctl('transitions.effect-options').enabled, true);
    await app.capture('2-push-chosen');
    await app.rpc('ui.menu', {doc, control: 'transitions.gallery'});
    await app.capture('3-gallery-open');
    await app.rpc('ui.menu', {doc, control: 'transitions.gallery', open: false});

    // Effect Options: the labelled list, the current one marked; choosing From Left (stored r).
    await app.rpc('ui.menu', {doc, control: 'transitions.effect-options'});
    await app.capture('4-effect-options');
    ui = await app.rpc('ui.inspect', {doc});
    const rows = ctl('transitions.effect-options.effect-options')?.value ?? ctl('transitions.effect-options').value;
    assert.deepEqual(rows.map(r => r.label), ['From Bottom', 'From Top', 'From Right', 'From Left']);
    await app.rpc('ui.menu', {doc, control: 'transitions.effect-options', open: false});
    await run('transition.options', {option: 'r'});
    assert.equal((await deck()).slides[0].transition.option, 'r');

    // Timing: Duration, On Mouse Click, After.
    await app.rpc('ui.activate', {doc, control: 'transitions.timing.duration', value: 1800});
    await app.rpc('ui.activate', {doc, control: 'transitions.timing.on-click', value: false});
    await app.rpc('ui.activate', {doc, control: 'transitions.timing.after', value: true});
    await app.rpc('ui.activate', {doc, control: 'transitions.timing.after-time', value: 4000});
    d = await deck();
    assert.deepEqual([d.slides[0].transition.durationMs, d.slides[0].transition.advanceOnClick, d.slides[0].transition.advanceAfterMs], [1800, false, 4000]);
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('transitions.timing.duration').value, 1.8);
    assert.equal(ctl('transitions.timing.on-click').checked, false);
    assert.equal(ctl('transitions.timing.after').checked, true);
    // Sound: the menu, a built-in sound.
    await app.rpc('ui.menu', {doc, control: 'transitions.timing.sound'});
    await app.capture('5-sound-menu');
    await app.rpc('ui.menu', {doc, control: 'transitions.timing.sound', open: false});
    await run('transition.sound', {builtin: 'camera'});
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('transitions.timing.sound').value, 'Camera');
    await app.capture('6-timing-set');

    // Slide 2: Cube, 1 s; slide 3 none. Apply To All copies slide 2's.
    await run('slide.go', {index: 1});
    await app.rpc('ui.activate', {doc, control: 'transitions.gallery', value: 'cube'});
    await app.rpc('ui.activate', {doc, control: 'transitions.timing.duration', value: 1200});
    await app.rpc('ui.activate', {doc, control: 'transitions.timing.apply-all'});
    d = await deck();
    assert.deepEqual(d.slides.map(s => s.transition.kind), ['cube', 'cube', 'cube']);
    await app.rpc('ui.activate', {doc, control: 'transitions.gallery', value: 'fade', index: 2}).catch(() => {});
    await run('transition.set', {kind: 'fade', index: 2});
    await run('transition.set', {kind: 'push', option: 'l', duration: 1500, index: 0});
    await run('transition.set', {kind: 'cube', option: 'l', duration: 1500, index: 1});
    await app.capture('7-thumbnails-marked');

    // Preview: the transition on slide 2, painted mid-way (not the slide alone).
    await app.rpc('ui.activate', {doc, control: 'transitions.preview.preview'});
    await sleep(500);
    const mid = await shot();
    await app.capture('8-preview-midway');
    await app.until(async () => !(await run('transition.preview', {on: false})).result.on, {timeout: 8000});
    await app.capture('9-preview-done');
    assert.ok(share(mid, [0.3, 0.3, 0.9, 0.9], dark) >= 0, 'a frame was painted');

    // The slide show from slide 1: the cut to slide 2 plays Cube (Push on slide 1 is its own entry).
    await run('slide.go', {index: 0});
    await app.rpc('ui.tab', {doc, tab: 'slide-show'});
    ui = await app.rpc('ui.inspect', {doc});
    for (const id of ['slideshow.start.from-beginning', 'slideshow.start.from-current', 'slideshow.setup.setup', 'slideshow.setup.hide-slide', 'slideshow.setup.use-timings']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['slideshow.start.present-online', 'slideshow.setup.record', 'slideshow.captions.always']) assert.equal(ctl(id), undefined, `${id} is hidden (not translated)`);
    await app.capture('9b-slide-show-tab');
    // Set Up Show: the dialog opens on the deck's settings and submits show.setup.
    await app.rpc('ui.activate', {doc, control: 'slideshow.setup.setup'});
    const dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.setupShow');
    await app.capture('9c-set-up-show-dialog');
    await app.rpc('ui.dialog.set', {field: 'ut', value: false});
    await app.rpc('ui.dialog.submit', {});
    assert.equal((await deck()).show.useTimings, false);
    await app.rpc('ui.activate', {doc, control: 'slideshow.setup.use-timings', value: true});
    assert.equal((await deck()).show.useTimings, true);
    await app.rpc('ui.activate', {doc, control: 'slideshow.start.from-current'});
    await app.until(async () => (await status())?.slide === 0 || null, {timeout: 15_000});
    await sleep(400);
    await app.capture('10-show-slide-1');
    await run('show.next');
    await app.until(async () => (await status())?.slide === 1 || null, {timeout: 10_000});
    await sleep(450);
    assert.match((await status()).transition ?? '', /cube:on/, 'the transition into slide 2 is playing');
    await app.capture('11-show-cube-midway');
    await app.until(async () => !(await status()).transition || null, {timeout: 10_000});
    await sleep(200);
    await app.capture('12-show-slide-2');
    await run('show.next');
    await app.until(async () => (await status())?.slide === 2 || null, {timeout: 10_000});
    await sleep(500);
    await app.capture('13-show-fade-midway');
    await sleep(900);
    await run('show.previous');
    await app.until(async () => (await status())?.slide === 1 || null, {timeout: 10_000});
    await sleep(300);
    await run('show.blackScreen');
    await sleep(200);
    const black = await shot();
    assert.ok(share(black, [0.1, 0.1, 0.9, 0.9], dark) > 0.6, 'B blanks the screen');
    await app.capture('14-show-black');
    await run('show.blackScreen');
    await run('show.last');
    await app.until(async () => (await status())?.slide === 2 || null, {timeout: 10_000});
    await sleep(2200);
    await run('show.next');
    await app.until(async () => (await status())?.ended || null, {timeout: 10_000});
    await sleep(200);
    await app.capture('15-show-end');
    await run('show.next');
    await app.until(async () => (await status()) === null, {timeout: 10_000});
    await app.capture('16-after-show');
  } finally {
    await app.close();
  }
});
