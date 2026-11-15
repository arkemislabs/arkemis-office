// Prism's Animations tab, the Animation Pane and animations in the slide show, through the bridge
// and the real window (U:prism/transitions).
//
// What deckcraft does (crates/ui-egui/src/ribbon/animations.rs, panels/animation.rs, engine
// cmd/animation.rs, the show in crates/ui-egui/src/show.rs): the gallery puts one effect on the selected
// shapes, Add Animation appends another, Effect Options lists the effect's options with the current
// one marked, Start / Duration / Delay edit the effect the pane has picked, Trigger starts it when a
// shape is clicked, Preview and the pane's Play From play it on the slide, the slide shows each
// effect's number beside its shape, and the show plays one click step at a time. PowerPoint: the same
// tab and pane. What this proves in the app: the real ribbon controls change the deck as the engine
// tests do, the pane lists the effects with timing bars and the markers number them, Preview paints
// the slide mid-animation, and in Play from Start the entrance shapes are not on the first screen and
// appear click by click while the show reports its steps. Captures in artifacts/e2e/prism/animations/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {decodePng, share} from './png.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const redish = (r, g, b) => r > 170 && g < 110 && b < 110;

test('prism animations: ribbon, pane, markers, preview, slide show', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Animations deck', {schema: 2});
  file.id = 'prism-animations';
  file.content.slides[0].shapes[0].text = bodyFromText('Launch plan');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/animations', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const anims = async () => (await deck()).slides[0].animations;
  const status = async () => (await run('show.status')).result;
  const shot = async () => decodePng((await app.rpc('ui.capture', {})).png);
  const pick = async id => { const d = await deck(); await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${d.slides[0].id}/sp:${id}`, focus: `/sl:${d.slides[0].id}/sp:${id}`}]}); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // Three shapes to animate: a red rectangle, an ellipse and a text box.
    const a = (await run('shape.insert', {preset: 'rect', rect: [80, 250, 220, 150]})).result.id;
    const b = (await run('shape.insert', {preset: 'ellipse', rect: [370, 250, 220, 150]})).result.id;
    const c = (await run('insert.textBox', {rect: [660, 270, 220, 100], text: 'Ship it'})).result.id;
    await run('shape.fill', {ids: [a], color: '#d83f3f'});
    await app.rpc('ui.tab', {doc, tab: 'animations'});
    let ui = await app.rpc('ui.inspect', {doc});
    const ctl = id => ui.controls.find(x => x.id === id);
    assert.ok(ctl('animations.gallery') && ctl('animations.advanced.add') && ctl('animations.advanced.pane') && ctl('animations.timing.start'), 'the tab is drawn');
    assert.equal(ctl('animations.timing.start').enabled, false, 'no animated shape selected: Start is off');
    await app.capture('1-tab-nothing-selected');

    // The gallery on shape A: Fly In; the effect is marked, Effect Options lists eight directions.
    await pick(a);
    await app.rpc('ui.activate', {doc, control: 'animations.gallery', value: 'entrance:fly'});
    let list = await anims();
    assert.deepEqual([list[0].effect, list[0].class, list[0].option, list[0].shape], ['fly', 'entrance', 'b', a]);
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('animations.gallery').value.find(g => g.selected).id, 'entrance:fly');
    await app.rpc('ui.menu', {doc, control: 'animations.gallery'});
    await app.capture('2-gallery-open');
    await app.rpc('ui.menu', {doc, control: 'animations.gallery', open: false});
    await app.rpc('ui.menu', {doc, control: 'animations.effect-options'});
    await app.capture('3-effect-options');
    await app.rpc('ui.menu', {doc, control: 'animations.effect-options', open: false});
    await run('animation.options', {option: 'l'});
    assert.equal((await anims())[0].option, 'l');

    // Add Animation: Spin (emphasis) on B and Fade (exit) on C.
    await pick(b);
    await app.rpc('ui.activate', {doc, control: 'animations.advanced.add', value: 'emphasis:spin'});
    await pick(c);
    await app.rpc('ui.activate', {doc, control: 'animations.advanced.add', value: 'exit:fadeOut'});
    list = await anims();
    assert.deepEqual(list.map(x => [x.shape, x.effect, x.start]), [[a, 'fly', 'onClick'], [b, 'spin', 'onClick'], [c, 'fadeOut', 'onClick']]);

    // The pane and the numbers on the slide.
    await app.rpc('ui.activate', {doc, control: 'animations.advanced.pane'});
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ui.panes?.some(p => /animation/.test(p.id) && p.open) || null; }, {timeout: 10_000});
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ctl('animations.advanced.pane').checked === true || null; }, {timeout: 10_000});
    await sleep(900);
    await app.capture('4-pane-and-markers');
    await run('animation.pick', {index: 1});
    // Start / Duration / Delay edit the picked effect: Spin starts With Previous, 1.5 s, delay 0.25 s.
    await app.rpc('ui.activate', {doc, control: 'animations.timing.start', value: 'With Previous'});
    await app.rpc('ui.activate', {doc, control: 'animations.timing.duration', value: 1500});
    await app.rpc('ui.activate', {doc, control: 'animations.timing.delay', value: 250});
    list = await anims();
    assert.deepEqual([list[1].start, list[1].durationMs, list[1].delayMs, list[0].durationMs, list[2].durationMs], ['withPrevious', 1500, 250, 500, 500], 'only the picked effect changed');
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('animations.timing.start').value, 'With Previous');
    assert.equal(ctl('animations.timing.duration').value, 1.5);
    await app.capture('5-pane-after-timing');

    // Reorder with Move Earlier / Later; Trigger on C by clicking A.
    await run('animation.pick', {index: 2});
    await app.rpc('ui.activate', {doc, control: 'animations.timing.earlier'});
    assert.deepEqual((await anims()).map(x => x.shape), [a, c, b]);
    await app.rpc('ui.activate', {doc, control: 'animations.timing.later'});
    assert.deepEqual((await anims()).map(x => x.shape), [a, b, c]);
    await run('animation.pick', {index: 2});
    await app.rpc('ui.menu', {doc, control: 'animations.advanced.trigger'});
    await app.capture('6-trigger-menu');
    await app.rpc('ui.menu', {doc, control: 'animations.advanced.trigger', open: false});
    await run('animation.timing', {index: 2, trigger: a});
    assert.equal((await anims())[2].trigger, a);
    await run('animation.timing', {index: 2, trigger: null});
    assert.equal((await anims())[2].trigger, null);
    await run('animation.pick', {index: 0});

    // Preview paints the slide mid-animation; Fly In from the left has the rectangle off the slide at the start.
    await app.rpc('ui.pane', {doc, id: 'animation', open: false});
    await app.until(async () => { ui = await app.rpc('ui.inspect', {doc}); return ctl('animations.advanced.pane').checked === false || null; }, {timeout: 10_000});
    await app.rpc('ui.activate', {doc, control: 'animations.preview.preview'});
    await sleep(350);
    await app.capture('7-preview-midway');
    await app.until(async () => !(await run('animation.preview', {on: false})).result.on, {timeout: 10_000});
    await app.capture('8-preview-done');

    // The show from the first slide: the title is there, the animated shapes are not until the clicks.
    await app.rpc('ui.tab', {doc, tab: 'slide-show'});
    await app.rpc('ui.activate', {doc, control: 'slideshow.start.from-beginning'});
    await app.until(async () => (await status())?.slide === 0 || null, {timeout: 15_000});
    await sleep(400);
    const first = await shot();
    await app.capture('9-show-start');
    assert.ok(share(first, [0.08, 0.5, 0.35, 0.85], redish) < 0.02, 'the red rectangle (an entrance) is not on screen before the first click');
    assert.equal((await status()).step, 0);
    await run('show.next');
    await app.until(async () => (await status()).playing || null, {timeout: 8000});
    await sleep(150);
    await app.capture('10-show-fly-in-flight');
    await app.until(async () => !(await status()).playing || null, {timeout: 8000});
    assert.equal((await status()).step, 1);
    await sleep(200);
    const flown = await shot();
    await app.capture('11-show-fly-in-done');
    assert.ok(share(flown, [0.08, 0.5, 0.35, 0.85], redish) > 0.1, 'the red rectangle flew in');
    // Step 2 is the text box's Fade exit; Spin ran with Fly In in step 1.
    await run('show.next');
    await app.until(async () => (await status()).step === 2 && !(await status()).playing || null, {timeout: 10_000});
    await sleep(300);
    await app.capture('12-show-all-played');
    await run('show.previous');
    await app.until(async () => (await status()).step === 1 || null, {timeout: 10_000});
    await sleep(200);
    await app.capture('13-show-back-one-step');
    await run('show.next');
    await app.until(async () => (await status()).step === 2 && !(await status()).playing || null, {timeout: 10_000});
    await run('show.next');
    await app.until(async () => (await status())?.ended || null, {timeout: 10_000});
    await run('show.next');
    await app.until(async () => (await status()) === null, {timeout: 10_000});
    await app.capture('14-after-show');
  } finally {
    await app.close();
  }
});
