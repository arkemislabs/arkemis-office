// Ported from deckcraft crates/anim/src/tests.rs (`show_skips_hidden_slides`, `show_loops`,
// `show_custom_show_and_range`, `playing_a_custom_show_stays_on_its_slides`,
// `show_steps_through_builds`, `show_back_leaves_a_slide_whose_first_step_is_automatic`,
// `show_auto_advance`, `show_empty_and_all_hidden`, `show_follows_links`) and
// crates/anim/src/tests_interact.rs (clicks, triggers, links) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
//
// 1. ArtCraft: crates/anim/src/{show,interact}.rs; PowerPoint: Slide Show navigation (hidden
//    slides, custom shows, builds, Back, Advance Slide After, hyperlinks and action buttons,
//    triggers).
// 2. Ours: core/prism/lib/show-state.mjs, the same state machine.
// 3. These tests; the show in the app: tests/e2e/prism/animations.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {ShowState, showOrder} from '../../../core/prism/lib/show-state.mjs';
import {defaultAnimation, defaultTransition} from '../../../core/prism/formats/pptx-read.mjs';
import {defaultShowSettings} from '../../../core/prism/model/presentation.mjs';

const pres = (n, extra = {}) => ({slides: Array.from({length: n}, (_, i) => ({id: String(1000 + i), shapes: [], animations: [], transition: null, hidden: false})),
  slideSize: {width: 960, height: 540}, show: defaultShowSettings(), customShows: [], ...extra});
const shape = (id, name = `S${id}`) => ({id: String(id), name, xfrm: {x: 100, y: 100, w: 200, h: 100}});
const anim = (sh, cls, effect, start, extra = {}) => ({...defaultAnimation(), shape: String(sh), class: cls, effect, start, durationMs: 1000, ...extra});
const sl = a => ({kind: 'slide', index: a});
const SLIDE = i => ({kind: 'slide', index: i});

test('show_skips_hidden_slides', () => {
  const p = pres(4);
  p.slides[1].hidden = true;
  const s = ShowState.begin(p);
  assert.equal(s.slide, 0);
  assert.deepEqual(s.next(p), SLIDE(2));
  assert.deepEqual(s.prev(p), SLIDE(0));
  assert.deepEqual(s.goto(p, 1), SLIDE(1), 'jumping to a hidden slide shows it');
  assert.deepEqual(s.next(p), SLIDE(2));
  assert.deepEqual(s.next(p), SLIDE(3));
  assert.deepEqual(s.next(p), {kind: 'end'});
  assert.deepEqual(s.next(p), {kind: 'exit'});
  assert.deepEqual(s.goto(p, 99), {kind: 'none'});
});

test('show_loops', () => {
  const p = pres(3);
  p.show.loopUntilEsc = true;
  const s = ShowState.begin(p);
  s.next(p); s.next(p);
  assert.deepEqual(s.next(p), SLIDE(0));
  assert.deepEqual(s.prev(p), SLIDE(2));
});

test('show_custom_show_and_range', () => {
  const p = pres(5);
  p.customShows = [{name: 'Short', slides: ['1003', '1001']}];
  p.show.customShow = 'Short';
  assert.deepEqual(showOrder(p), [3, 1]);
  const s = ShowState.begin(p);
  assert.equal(s.slide, 3);
  assert.deepEqual(s.next(p), SLIDE(1));
  p.show.customShow = null;
  p.show.range = [2, 4];
  assert.deepEqual(showOrder(p), [1, 2, 3]);
  p.show.range = [0, 99];
  assert.deepEqual(showOrder(p), [0, 1, 2, 3, 4]);
});

test('playing_a_custom_show_stays_on_its_slides', () => {
  const p = pres(5);
  p.customShows = [{name: 'Ends', slides: ['1000', '1004']}];
  let s = ShowState.playCustom(p, 'Ends');
  assert.equal(s.customName(), 'Ends');
  assert.equal(s.slide, 0);
  assert.equal(s.peekNext(p), 4);
  assert.deepEqual(s.next(p), SLIDE(4));
  assert.deepEqual(s.next(p), {kind: 'end'});
  assert.deepEqual(s.prev(p), SLIDE(4));
  assert.deepEqual(s.prev(p), SLIDE(0));
  assert.equal(ShowState.playCustom(p, 'Missing'), null);
  assert.equal(p.show.customShow, null, 'one-shot playback does not change Set Up');
  p.slides[4].hidden = true;
  const only = ShowState.playCustom(p, 'Ends');
  assert.equal(only.firstIndex(p), 0);
  assert.equal(only.lastIndex(p), 0);
  p.slides[4].hidden = false;
  s = ShowState.begin(p);
  assert.deepEqual(s.follow(p, {kind: 'customShow', name: 'Ends'}), {kind: 'show', action: SLIDE(0)});
  assert.equal(s.customName(), 'Ends');
  assert.deepEqual(s.next(p), SLIDE(4));
  assert.deepEqual(s.follow(p, {kind: 'customShow', name: 'Missing'}), {kind: 'none'});
  assert.equal(s.slide, 4, 'an unknown custom show leaves the current slide');
});

test('show_steps_through_builds', () => {
  const p = pres(2);
  p.slides[0].shapes = [shape(1, 'A')];
  p.slides[0].animations = [anim(1, 'entrance', 'fade', 'onClick')];
  const s = ShowState.begin(p);
  assert.ok(!s.playing);
  assert.deepEqual(s.next(p), {kind: 'playStep', step: 0});
  assert.ok(s.playing);
  assert.deepEqual(s.stepDone(p), {kind: 'finishStep', step: 0});
  assert.equal(s.step, 1);
  assert.deepEqual(s.prev(p), {kind: 'stepBack', step: 0});
  assert.deepEqual(s.next(p), {kind: 'playStep', step: 0});
  assert.deepEqual(s.next(p), {kind: 'finishStep', step: 0});
  assert.deepEqual(s.next(p), SLIDE(1));
  assert.deepEqual(s.prev(p), SLIDE(0), 'back to a fully built previous slide');
  assert.equal(s.step, 1);
});

test('show_back_leaves_a_slide_whose_first_step_is_automatic', () => {
  for (const start of ['withPrevious', 'afterPrevious']) {
    const p = pres(2);
    p.slides[1].shapes = [shape(1, 'A'), shape(2, 'B')];
    p.slides[1].animations = [anim(1, 'entrance', 'fade', start), anim(2, 'entrance', 'fade', 'onClick')];
    const s = ShowState.begin(p);
    assert.deepEqual(s.next(p), SLIDE(1));
    assert.ok(s.playing, start);
    assert.deepEqual(s.prev(p), SLIDE(0), start);
    assert.deepEqual(s.next(p), SLIDE(1));
    assert.deepEqual(s.next(p), {kind: 'playStep', step: 1});
    assert.deepEqual(s.stepDone(p), {kind: 'finishStep', step: 1});
    assert.deepEqual(s.prev(p), {kind: 'stepBack', step: 1}, start);
    assert.deepEqual(s.prev(p), SLIDE(0), start);
    assert.deepEqual([s.step, s.playing], [0, false]);
  }
});

test('show_auto_advance', () => {
  const p = pres(2);
  p.slides[0].transition = {...defaultTransition(), advanceAfterMs: 2000};
  const s = ShowState.begin(p);
  assert.equal(s.advanceAfter(p), 2);
  assert.ok(!s.autoAdvanceDue(p, 1));
  assert.ok(s.autoAdvanceDue(p, 2.5));
  assert.ok(!s.autoAdvanceDue(p, NaN));
  p.show.useTimings = false;
  assert.ok(!s.autoAdvanceDue(p, 5));
});

test('show_empty_and_all_hidden', () => {
  let p = pres(0);
  let s = ShowState.begin(p);
  assert.ok(s.ended);
  assert.deepEqual(s.next(p), {kind: 'exit'});
  s.prev(p);
  p = pres(2);
  for (const x of p.slides) x.hidden = true;
  s = ShowState.begin(p);
  assert.ok(s.ended);
  s.next(p); s.prev(p);
});

test('show_follows_links', () => {
  const p = pres(4);
  p.slides[3].hidden = true;
  const s = ShowState.begin(p);
  const J = i => ({kind: 'show', action: SLIDE(i)});
  assert.deepEqual(s.follow(p, {kind: 'slide', slide: '1002'}), J(2));
  assert.deepEqual(s.follow(p, {kind: 'previousSlide'}), J(1));
  assert.deepEqual(s.follow(p, {kind: 'nextSlide'}), J(2));
  assert.deepEqual(s.follow(p, {kind: 'lastSlide'}), J(2), 'last skips the hidden slide');
  assert.deepEqual(s.follow(p, {kind: 'slide', slide: '1003'}), J(3), 'a link to the hidden slide shows it');
  assert.deepEqual(s.follow(p, {kind: 'firstSlide'}), J(0));
  assert.deepEqual(s.follow(p, {kind: 'lastViewed'}, 3), J(3));
  assert.equal(s.slide, 3);
  assert.deepEqual(s.follow(p, {kind: 'url', url: 'https://example.org'}), {kind: 'open', url: 'https://example.org'});
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:', 'smb://host/share', 'C:\\Windows\\calc.exe', '../notes.txt', 'https:', '']) {
    assert.deepEqual(s.follow(p, {kind: 'url', url: bad}), {kind: 'none'}, `${bad} must not open`);
  }
  assert.deepEqual(s.follow(p, {kind: 'url', url: ' MAILTO:a@example.org'}), {kind: 'open', url: 'MAILTO:a@example.org'});
  assert.deepEqual(s.follow(p, {kind: 'endShow'}), {kind: 'exit'});
  assert.deepEqual(s.follow(p, {kind: 'slide', slide: '9'}), {kind: 'none'}, 'a link to a deleted slide does nothing');
  assert.deepEqual(s.follow(p, {kind: 'lastViewed'}), {kind: 'none'});
  assert.equal(s.slide, 3);
});

// ---- tests_interact.rs ---------------------------------------------------------------------

const exitOnClick = (trigger, target, ms) => anim(target, 'exit', ms === 0 ? 'disappear' : 'fadeOut', 'onClick', {durationMs: ms, trigger: String(trigger)});
const slide = (id, shapes, animations, advanceOnClick) => ({id: String(id), shapes, animations, hidden: false, transition: advanceOnClick ? null : {...defaultTransition(), advanceOnClick: false}});
const toSlide = n => ({kind: 'slide', slide: String(n)});
const hit = (id, link = null) => ({id: String(id), parent: null, isGroup: false, link, underPointer: true});

class Run {
  constructor(p, hits) { this.pres = p; this.show = ShowState.begin(p); this.hits = hits; this.now = 0; }
  tl() { return this.show.timeline(this.pres, this.show.slide); }
  visible(id) { const st = this.show.animState(this.tl(), String(id), 0); return st.visible && st.opacity > 0; }
  opacity(id) { return this.show.animState(this.tl(), String(id), 0).opacity; }
  click() {
    const hits = this.hits[this.show.slide];
    const vis = new Map(hits.map(h => [h.id, this.visible(h.id)]));
    return this.show.click(this.pres, this.tl(), hits, id => vis.get(id) ?? true, this.now, null);
  }
  target() { return this.show.target(this.pres, this.tl(), this.hits[this.show.slide], id => this.visible(id)); }
  wait(secs) {
    const end = this.now + secs;
    while (this.now < end - 1e-9) { this.now = Math.min(this.now + 0.05, end); this.show.tick(this.tl(), this.now); }
  }
}
const SHOW = i => ({kind: 'show', action: SLIDE(i)});

function twoSlides(advanceOnClick) {
  const s1 = slide(1000, [shape(3), shape(2), shape(4)], [exitOnClick(4, 4, 0), exitOnClick(2, 2, 0)], advanceOnClick);
  const s2 = slide(1001, [shape(1)], [], advanceOnClick);
  const p = pres(0, {slides: [s1, s2]});
  return new Run(p, [[hit(3), hit(2, toSlide(1001)), hit(4)], [hit(1, toSlide(1000))]]);
}

test('hidden_shapes_stay_hidden_when_the_show_comes_back', () => {
  const r = twoSlides(false);
  assert.equal(r.target()?.shape, '4', 'the picture is on top');
  assert.deepEqual(r.click(), {kind: 'animated'});
  assert.ok(!r.visible(4));
  assert.equal(r.target()?.shape, '2');
  assert.deepEqual(r.click(), SHOW(1), 'the button animates and its link is followed');
  assert.equal(r.show.slide, 1);
  assert.deepEqual(r.click(), SHOW(0));
  assert.ok(!r.visible(4) && !r.visible(2) && r.visible(3));
  assert.equal(r.target(), null);
  for (let i = 0; i < 3; i++) assert.deepEqual(r.click(), {kind: 'none'}, 'advance on click is off: a click anywhere does nothing');
  assert.equal(r.show.slide, 0);
});

test('background_click_advances_when_the_slide_allows_it', () => {
  const r = twoSlides(true);
  r.click(); r.click(); r.click();
  assert.equal(r.show.slide, 0);
  assert.equal(r.target(), null);
  assert.deepEqual(r.click(), SHOW(1));
});

test('advance_on_click_off_still_plays_animation_steps', () => {
  const main = anim(1, 'entrance', 'fade', 'onClick', {durationMs: 500});
  const p = pres(0, {slides: [slide(1000, [shape(1)], [main], false), slide(1001, [], [], false)]});
  const r = new Run(p, [[hit(1)], []]);
  assert.deepEqual(r.click(), {kind: 'show', action: {kind: 'playStep', step: 0}});
  assert.deepEqual(r.click(), {kind: 'show', action: {kind: 'finishStep', step: 0}});
  assert.deepEqual(r.click(), {kind: 'none'});
  assert.equal(r.show.slide, 0);
  assert.deepEqual(r.show.next(r.pres), SLIDE(1), 'the arrow keys still move on');
});

test('a_shape_without_an_action_blocks_the_one_beneath_it', () => {
  let p = pres(0, {slides: [slide(1000, [shape(1), shape(2)], [], true), slide(1001, [], [], true)]});
  let r = new Run(p, [[hit(1, toSlide(1001)), hit(2)], []]);
  assert.equal(r.target(), null, 'the plain shape on top blocks the button');
  assert.deepEqual(r.click(), SHOW(1), 'so the click is a background click');
  p = pres(0, {slides: [slide(1000, [shape(2), shape(1)], [], true), slide(1001, [], [], true)]});
  r = new Run(p, [[hit(2), hit(1, toSlide(1001))], []]);
  assert.equal(r.target()?.shape, '1');
});

test('groups_answer_for_their_children', () => {
  const p = pres(0, {slides: [slide(1000, [shape(1)], [], true), slide(1001, [], [], true)]});
  const group = link => ({id: '10', parent: null, isGroup: true, link, underPointer: true});
  const child = {id: '11', parent: 1, isGroup: false, link: null, underPointer: true};
  let r = new Run(p, [[hit(5), group(toSlide(1001)), child], []]);
  assert.equal(r.target()?.shape, '10', 'a child of a group with an action acts as the group');
  r = new Run(p, [[hit(5, toSlide(1001)), group(null)], []]);
  assert.equal(r.target()?.shape, '5', 'empty space inside the box of a group without an action blocks nothing');
});

test('pointer_outside_a_shape_is_not_on_it', () => {
  const p = pres(0, {slides: [slide(1000, [shape(1)], [], true)]});
  const h = {...hit(1, toSlide(1000)), underPointer: false};
  assert.equal(new Run(p, [[h]]).target(), null);
});

test('each_click_plays_one_step_of_a_trigger_and_a_click_completes_a_playing_step', () => {
  const p = pres(0, {slides: [slide(1000, [shape(1), shape(2), shape(3)], [exitOnClick(1, 2, 5000), exitOnClick(1, 3, 5000)], true)]});
  const r = new Run(p, [[hit(2), hit(3), hit(1)]]);
  assert.equal(r.target()?.shape, '1');
  assert.deepEqual(r.click(), {kind: 'animated'});
  r.wait(2);
  assert.ok(r.show.triggerPlaying());
  assert.ok(r.opacity(2) < 1 && r.opacity(2) > 0, 'part way through the fade');
  assert.ok(r.visible(3));
  assert.deepEqual(r.click(), {kind: 'animated'}, 'a click on the shape while its step plays completes the step at once');
  assert.ok(!r.visible(2) && !r.show.triggerPlaying());
  assert.deepEqual(r.click(), {kind: 'animated'}, 'the next click plays the next step');
  r.wait(5.2);
  assert.ok(!r.visible(3));
  assert.equal(r.target()?.shape, '1');
  assert.deepEqual(r.click(), {kind: 'animated'});
  assert.ok(r.visible(2) && r.visible(3), "the first lap's effects are undone");
  r.wait(5.2);
  assert.ok(!r.visible(2) && r.visible(3));
});

test('a_ring_of_triggers_goes_round_and_round', () => {
  const ring = 4;
  const anims = [];
  for (let k = 1; k <= ring; k++) {
    const next = (k % ring) + 1;
    anims.push(exitOnClick(k, k, 0), anim(next, 'entrance', 'appear', 'withPrevious', {durationMs: 0, trigger: String(k)}));
  }
  const p = pres(0, {slides: [slide(1000, Array.from({length: ring}, (_, i) => shape(i + 1)), anims, true)]});
  const r = new Run(p, [Array.from({length: ring}, (_, i) => hit(i + 1))]);
  const showing = () => Array.from({length: ring}, (_, i) => i + 1).filter(k => r.visible(k));
  assert.deepEqual(showing(), [1]);
  for (let lap = 0; lap < 3; lap++) {
    for (let k = 1; k <= ring; k++) {
      assert.deepEqual(showing(), [k], `lap ${lap}, before click ${k}`);
      assert.equal(r.target()?.shape, String(k));
      assert.deepEqual(r.click(), {kind: 'animated'});
    }
  }
  assert.deepEqual(showing(), [1]);
});

test('a_link_is_followed_at_once_and_the_animation_goes_on_where_it_stopped', () => {
  const s1 = slide(1000, [shape(1), shape(2), shape(4)], [exitOnClick(1, 4, 5000)], false);
  const s2 = slide(1001, [shape(5)], [], false);
  const r = new Run(pres(0, {slides: [s1, s2]}), [[hit(4), hit(2, toSlide(1001)), hit(1)], [hit(5, toSlide(1000))]]);
  r.click();
  r.wait(2);
  assert.equal(Math.round(r.show.triggerPlays()[0].t), 2);
  assert.deepEqual(r.show.click(r.pres, r.tl(), [hit(2, toSlide(1001))], () => true, r.now, null), SHOW(1));
  r.wait(60);
  assert.deepEqual(r.click(), SHOW(0), 'however long the show stays away, the animation does not run');
  assert.ok(Math.abs(r.show.triggerPlays()[0].t - 2) < 0.1);
  assert.ok(r.show.triggerPlaying());
  r.wait(2.5);
  assert.ok(r.show.triggerPlaying() && r.opacity(4) > 0);
  r.wait(1);
  assert.ok(!r.show.triggerPlaying() && !r.visible(4));
});

test('a_shape_with_a_link_and_an_animation_follows_the_link_without_waiting', () => {
  const s1 = slide(1000, [shape(2)], [exitOnClick(2, 2, 5000)], false);
  const s2 = slide(1001, [shape(5)], [], false);
  const r = new Run(pres(0, {slides: [s1, s2]}), [[hit(2, toSlide(1001))], [hit(5, toSlide(1000))]]);
  assert.deepEqual(r.click(), SHOW(1));
  r.wait(30);
  assert.deepEqual(r.click(), SHOW(0));
  assert.ok(r.visible(2) && r.opacity(2) > 0.95, 'the whole animation is still ahead');
  assert.ok(r.show.triggerPlaying());
  r.wait(5.5);
  assert.ok(!r.visible(2));
});

test('a_slide_comes_back_the_way_it_was_left', () => {
  const steps = [1, 2, 3].map(i => anim(i, 'entrance', 'appear', 'onClick', {durationMs: 0}));
  const p = pres(0, {slides: [slide(1000, [shape(1), shape(2), shape(3)], steps, true), slide(1001, [], [], true), slide(1002, [], [], true)]});
  let s = ShowState.begin(p);
  s.next(p);
  s.stepDone(p);
  assert.equal(s.step, 1);
  assert.deepEqual(s.follow(p, {kind: 'slide', slide: '1002'}), SHOW(2));
  assert.deepEqual(s.follow(p, {kind: 'slide', slide: '1000'}), SHOW(0));
  assert.deepEqual([s.step, s.playing], [1, false]);
  s.goto(p, 1);
  assert.deepEqual(s.prev(p), SLIDE(0), 'so does the back arrow');
  assert.equal(s.step, 1);
  s = ShowState.begin(p);
  s.goto(p, 2);
  assert.deepEqual(s.prev(p), SLIDE(1), 'going back to a slide not visited shows it fully built');
  assert.equal(s.step, s.steps(p, 1));
});

test('a_playing_main_step_is_finished_when_the_show_leaves', () => {
  const a = anim(1, 'entrance', 'fade', 'onClick', {durationMs: 500});
  const p = pres(0, {slides: [slide(1000, [shape(1)], [a], true), slide(1001, [], [], true)]});
  const s = ShowState.begin(p);
  assert.deepEqual(s.next(p), {kind: 'playStep', step: 0});
  s.goto(p, 1);
  s.goto(p, 0);
  assert.deepEqual([s.step, s.playing], [1, false]);
});

test('show_without_animation_ignores_triggers', () => {
  const p = pres(0, {slides: [slide(1000, [shape(1), shape(2)], [exitOnClick(1, 2, 0)], true)]});
  p.show.withoutAnimation = true;
  assert.equal(new Run(p, [[hit(2), hit(1)]]).target(), null);
});

test('clocks_and_pointers_with_hostile_numbers_are_harmless', () => {
  const p = pres(0, {slides: [slide(1000, [shape(1), shape(2)], [exitOnClick(1, 2, 1000)], true)]});
  const r = new Run(p, [[hit(2), hit(1)]]);
  r.click();
  for (const now of [NaN, Infinity, -Infinity, -1e12, 1e300]) r.show.tick(r.tl(), now);
  assert.ok(Number.isFinite(r.opacity(2)));
});
