// Ported from deckcraft crates/anim/src/tests.rs (timeline, effects, easing, motion paths) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf: `on_click_starts_steps`, `with_previous_joins_step`,
// `after_previous_chains`, `delays_shift_start`, `auto_first_step`, `hidden_before_entrance`,
// `hidden_after_exit`, `entrance_then_exit`, `emphasis_returns_or_persists`, `color_emphasis_tints`,
// `every_animation_evaluates_finite`, `fly_starts_off_slide`, `wipe_clips`,
// `repeat_and_auto_reverse_extend_duration`, `rewind_reverts_entrance`, `after_hide_on_next_click`,
// `triggered_sequences`, `text_build_by_paragraph`, `by_paragraph_groups_sub_bullets_with_their_parent`,
// `hostile_times_and_durations`, `empty_slide`, `start_of_seeks_the_play_all_clock_to_an_effect`,
// `locate_play_all_clock`, `motion_path_parse_and_eval`, `malformed_paths_dont_panic`,
// `preset_paths_move`, `custom_path_offsets_in_points`, `easing_endpoints`.
//
// 1. ArtCraft: crates/anim/src/{timeline,effects,easing,path}.rs; PowerPoint: the Animation Pane's
//    click sequence (On Click, With Previous, After Previous), Entrance/Emphasis/Exit/Motion Paths.
// 2. Ours: core/prism/lib/anim-timeline.mjs is the same algorithm, the same numbers.
// 3. These tests; the show in the app is tests/e2e/prism/animations.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {Timeline, MotionPath, ease, isIdentity, compose, sanitized, identityState} from '../../../core/prism/lib/anim-timeline.mjs';
import {ANIMATIONS, defaultAnimation, paragraphBuildRoles} from '../../../core/prism/formats/pptx-read.mjs';
import {motionDefaultPath} from '../../../core/prism/lib/anim-tables.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {colorRgb} from '../../../core/prism/model/style.mjs';
import {rgb} from '../../../core/prism/model/color.mjs';

const W = 960, H = 540;
const shape = (id, name) => ({id: String(id), name, xfrm: {x: 100, y: 100, w: 200, h: 100}});
const anim = (sh, cls, effect, start) => ({...defaultAnimation(), shape: String(sh), class: cls, effect, start, durationMs: 1000});
const slideWith = anims => ({shapes: [1, 2, 3, 4].map(i => shape(i, `S${i}`)), animations: anims});
const finite = s => [s.opacity, s.offsetX, s.offsetY, s.scaleX, s.scaleY, s.rotate].every(Number.isFinite) && (!s.clip || s.clip.every(Number.isFinite));
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
const tlOf = (anims, w = W, h = H) => Timeline.of(slideWith(anims), w, h);

test('default_state_is_identity', () => {
  const s = identityState();
  assert.ok(s.visible && s.opacity === 1 && s.scaleX === 1 && s.scaleY === 1 && isIdentity(s));
});

test('on_click_starts_steps', () => {
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick'), anim(2, 'entrance', 'fade', 'onClick'), anim(3, 'entrance', 'fade', 'onClick')]);
  assert.equal(tl.steps(), 3);
  assert.ok(!tl.stepIsAuto(0));
  assert.ok(near(tl.stepDuration(1), 1));
});

test('with_previous_joins_step', () => {
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick'), anim(2, 'entrance', 'fade', 'withPrevious')]);
  assert.equal(tl.steps(), 1);
  const e = tl.timings();
  assert.equal(e[1].step, 0);
  assert.equal(e[1].start, 0);
  assert.ok(near(tl.stepDuration(0), 1));
});

test('after_previous_chains', () => {
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick'), anim(2, 'entrance', 'fade', 'afterPrevious'), anim(3, 'entrance', 'fade', 'afterPrevious')]);
  assert.equal(tl.steps(), 1);
  const e = tl.timings();
  assert.ok(near(e[1].start, 1));
  assert.ok(near(e[2].start, 2));
  assert.ok(near(tl.stepDuration(0), 3));
});

test('delays_shift_start', () => {
  const a = {...anim(2, 'entrance', 'fade', 'withPrevious'), delayMs: 250};
  const b = {...anim(3, 'entrance', 'fade', 'afterPrevious'), delayMs: 500};
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick'), a, b]);
  const e = tl.timings();
  assert.ok(near(e[1].start, 0.25));
  assert.ok(near(e[2].start, 1.75), 'after previous: after the latest end (1.25) plus its delay');
  assert.ok(near(tl.stepDuration(0), 2.75));
});

test('auto_first_step', () => {
  const tl = tlOf([anim(1, 'entrance', 'fade', 'afterPrevious'), anim(2, 'entrance', 'fade', 'onClick')]);
  assert.equal(tl.steps(), 2);
  assert.ok(tl.stepIsAuto(0));
  assert.ok(!tl.stepIsAuto(1));
});

test('hidden_before_entrance', () => {
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick')]);
  assert.ok(!tl.state('1', null, 0, 0).visible);
  const mid = tl.state('1', null, 0, 0.5);
  assert.ok(mid.visible && mid.opacity > 0 && mid.opacity < 1);
  const done = tl.state('1', null, 1, 0);
  assert.ok(done.visible && near(done.opacity, 1));
  assert.ok(isIdentity(tl.state('2', null, 0, 0)), 'unanimated shapes are untouched');
});

test('hidden_after_exit', () => {
  const tl = tlOf([anim(1, 'exit', 'fadeOut', 'onClick')]);
  assert.ok(tl.state('1', null, 0, 0).visible);
  const mid = tl.state('1', null, 0, 0.5);
  assert.ok(mid.visible && mid.opacity < 1);
  assert.ok(!tl.state('1', null, 1, 0).visible);
  assert.ok(!tl.state('1', null, 0, 5).visible);
});

test('entrance_then_exit', () => {
  const tl = tlOf([anim(1, 'entrance', 'appear', 'onClick'), anim(1, 'exit', 'disappear', 'onClick')]);
  assert.ok(!tl.state('1', null, 0, 0).visible);
  assert.ok(tl.state('1', null, 1, 0).visible);
  assert.ok(!tl.state('1', null, 2, 0).visible);
});

test('emphasis_returns_or_persists', () => {
  const spin = {...anim(1, 'emphasis', 'spin', 'onClick'), amount: 90};
  const tl = tlOf([anim(2, 'emphasis', 'pulse', 'onClick'), spin]);
  assert.ok(tl.state('2', null, 0, 0.5).scaleX > 1);
  assert.ok(isIdentity(tl.state('2', null, 1, 0)));
  assert.ok(near(tl.state('1', null, 2, 0).rotate, 90));
});

test('color_emphasis_tints', () => {
  const a = {...anim(1, 'emphasis', 'fillColor', 'onClick'), color: colorRgb(rgb(255, 0, 0))};
  const tl = tlOf([a]);
  assert.deepEqual(tl.state('1', null, 1, 0).tint, rgb(255, 0, 0));
});

test('every_animation_evaluates_finite', () => {
  for (const [id, , cls, , , opts] of ANIMATIONS) {
    for (const o of [...opts, '']) {
      const tl = tlOf([{...anim(1, cls, id, 'onClick'), option: o}]);
      for (const [step, t] of [[0, 0], [0, 0.001], [0, 0.25], [0, 0.5], [0, 0.999], [0, 1], [0, 2], [1, 0]]) {
        const s = tl.state('1', null, step, t);
        assert.ok(finite(s), `${id} ${o} ${step} ${t}: ${JSON.stringify(s)}`);
      }
      const end = tl.state('1', null, 1, 0);
      if (cls === 'entrance') assert.ok(end.visible && near(end.opacity, 1), id);
      if (cls === 'exit') assert.ok(!end.visible, id);
    }
  }
});

test('fly_starts_off_slide', () => {
  const tl = tlOf([{...anim(1, 'entrance', 'fly', 'onClick'), option: 'l'}]);
  const s = tl.state('1', null, 0, 1e-6);
  assert.ok(100 + s.offsetX + 200 <= 0.01, JSON.stringify(s));
  assert.ok(Math.abs(tl.state('1', null, 0, 0.999999).offsetX) < 1);
});

test('wipe_clips', () => {
  const tl = tlOf([{...anim(1, 'entrance', 'wipe', 'onClick'), option: 'l'}]);
  const c = tl.state('1', null, 0, 0.5).clip;
  assert.ok(c[0] === 0 && c[2] > 0 && c[2] < 1);
});

test('repeat_and_auto_reverse_extend_duration', () => {
  const a = {...anim(1, 'emphasis', 'pulse', 'onClick'), repeat: 3, autoReverse: true};
  assert.ok(near(tlOf([a]).stepDuration(0), 6));
  const b = {...anim(2, 'emphasis', 'spin', 'onClick'), repeat: 0xffffffff};
  const tl = tlOf([b]);
  assert.ok(near(tl.stepDuration(0), 1), 'until next click: one iteration counts, keeps playing within the step');
  const s = tl.state('2', null, 0, 10.5);
  assert.ok(s.rotate > 0 && s.rotate < 360);
});

test('rewind_reverts_entrance', () => {
  const tl = tlOf([{...anim(1, 'entrance', 'fade', 'onClick'), rewind: true}]);
  assert.ok(!tl.state('1', null, 1, 0).visible);
});

test('after_hide_on_next_click', () => {
  const tl = tlOf([{...anim(1, 'entrance', 'fade', 'onClick'), after: 'hideOnNextClick'}, anim(2, 'entrance', 'fade', 'onClick')]);
  assert.ok(tl.state('1', null, 0, 5).visible);
  assert.ok(!tl.state('1', null, 1, 0).visible);
});

test('triggered_sequences', () => {
  const a = {...anim(1, 'entrance', 'fade', 'onClick'), trigger: '3'};
  const tl = tlOf([anim(2, 'entrance', 'fade', 'onClick'), a]);
  assert.equal(tl.steps(), 1);
  assert.deepEqual(tl.triggerShapes(), ['3']);
  assert.equal(tl.triggerSteps('3'), 1);
  assert.ok(!tl.state('1', null, 1, 0).visible, 'not played: hidden even after the main sequence');
  assert.ok(tl.stateWith('1', null, 0, 0, [{trigger: '3', step: 1, t: 0}]).visible);
});

test('text_build_by_paragraph', () => {
  const s = slideWith([]);
  s.shapes[0].text = bodyFromText('one\ntwo\nthree');
  const a = {...anim(1, 'entrance', 'fade', 'onClick'), textBuild: 'byParagraph'};
  s.animations = [a];
  let tl = Timeline.of(s, W, H);
  const n = tl.paragraphTargets('1').length;
  assert.equal(n, 3);
  assert.equal(tl.steps(), n, 'on click: one click per paragraph');
  assert.ok(tl.state('1', 0, 1, 0).visible);
  assert.ok(!tl.state('1', 1, 1, 0).visible);
  s.animations = [{...a, start: 'withPrevious'}];
  tl = Timeline.of(s, W, H);
  assert.equal(tl.steps(), 1);
  const e = tl.timings();
  assert.ok(near(e[1].start - e[0].start, 0.5), 'with previous: staggered within one step');
  assert.ok(tl.state('1', null, 0, 0).visible, "the shape itself isn't hidden");
});

test('by_paragraph_groups_sub_bullets_with_their_parent', () => {
  const s = slideWith([]);
  const body = bodyFromText('one\nsub a\nsub b\ntwo');
  body.paragraphs[1].level = 1;
  body.paragraphs[2].level = 1;
  s.shapes[0].text = body;
  s.animations = [{...anim(1, 'entrance', 'fade', 'onClick'), textBuild: 'byParagraph'}];
  const tl = Timeline.of(s, W, H);
  assert.equal(tl.steps(), 2);
  assert.deepEqual(tl.paragraphTargets('1'), [0, 1, 2, 3]);
  assert.ok(tl.state('1', 2, 1, 0).visible);
  assert.ok(!tl.state('1', 3, 1, 0).visible);
  assert.ok(!tl.state('1', 1, 0, 0).visible);
  assert.deepEqual(paragraphBuildRoles(body).map(r => (r.top ? 'top' : r.member !== undefined ? `m${r.member}` : 'u')), ['top', 'm0', 'm0', 'top']);
});

test('hostile_times_and_durations', () => {
  const a = {...anim(1, 'entrance', 'fly', 'onClick'), durationMs: 0xffffffff, delayMs: 0xffffffff, repeat: 0xfffffffe, smoothStart: NaN, smoothEnd: -5, bounceEnd: Infinity, amount: NaN};
  const b = {...anim(2, 'emphasis', 'growShrink', 'afterPrevious'), amount: 1e300, durationMs: 0};
  const tl = Timeline.of(slideWith([a, b, anim(99, 'path', 'customPath', 'onClick')]), NaN, -1);
  for (const t of [NaN, Infinity, -Infinity, -1, 0, 1e12, 1e300]) {
    for (const step of [0, 1, 2, 3, Number.MAX_SAFE_INTEGER]) {
      for (const id of ['1', '2', '99']) {
        assert.ok(finite(tl.state(id, null, step, t)));
        assert.ok(finite(tl.state(id, Number.MAX_SAFE_INTEGER, step, t)));
      }
    }
    tl.locate(t);
    tl.stateAt('1', null, t);
  }
  assert.equal(tl.stepDuration(Number.MAX_SAFE_INTEGER), 0);
});

test('empty_slide', () => {
  const tl = Timeline.of({shapes: [], animations: []}, W, H);
  assert.equal(tl.steps(), 0);
  assert.ok(tl.isEmpty());
  assert.ok(isIdentity(tl.state('1', null, 0, 1)));
  assert.deepEqual(tl.locate(5), [0, 0]);
});

test('start_of_seeks_the_play_all_clock_to_an_effect', () => {
  const late = {...anim(4, 'entrance', 'fade', 'withPrevious'), delayMs: 250};
  const triggered = {...anim(4, 'emphasis', 'pulse', 'onClick'), trigger: '1'};
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick'), anim(2, 'exit', 'fadeOut', 'onClick'), anim(3, 'entrance', 'fade', 'onClick'), late, triggered]);
  assert.equal(tl.startOf(0), 0);
  assert.equal(tl.startOf(2), 2);
  assert.equal(tl.startOf(3), 2.25);
  assert.equal(tl.startOf(4), null, 'a triggered effect is not on the play-all clock');
  assert.equal(tl.startOf(9), null);
  const at = tl.startOf(2);
  assert.ok(tl.stateAt('1', null, at).visible, 'entered before');
  assert.ok(!tl.stateAt('2', null, at).visible, 'exited before');
  assert.ok(!tl.stateAt('3', null, at).visible, 'not entered yet');
  assert.ok(!tl.stateAt('4', null, at).visible, 'not entered yet');
});

test('locate_play_all_clock', () => {
  const tl = tlOf([anim(1, 'entrance', 'fade', 'onClick'), anim(2, 'entrance', 'fade', 'onClick')]);
  assert.deepEqual(tl.locate(0.5), [0, 0.5]);
  assert.deepEqual(tl.locate(1.5), [1, 0.5]);
  assert.deepEqual(tl.locate(9), [2, 0]);
  assert.ok(near(tl.totalDuration(), 2));
});

test('motion_path_parse_and_eval', () => {
  const p = MotionPath.parse('M 0 0 L 0.25 0 L 0.25 0.25 E');
  assert.ok(near(p.length(), 0.5));
  let [x, y] = p.at(0.5);
  assert.ok(near(x, 0.25) && near(y, 0));
  [x, y] = p.at(1);
  assert.ok(near(x, 0.25) && near(y, 0.25));
  assert.ok(MotionPath.parse('m 0 0 l 0.1 0 c 0 0.1 0 0.1 0 0.2 z').length() > 0);
  assert.ok(MotionPath.parse('M0,0C0.1,0,0.2,0.1,0.2,0.2E').points.length > 2);
  [x, y] = MotionPath.parse('M 0 0 L 1e-1 -2.5E-1 E').at(1);
  assert.ok(near(x, 0.1) && near(y, -0.25));
});

test('malformed_paths_dont_panic', () => {
  for (const s of ['', 'E', 'M', 'M 0', 'L 1 1', 'C 1 2 3', 'M 0 0 L x y', 'M NaN 1 L inf 2', 'M 1e400 0 L 0 0', 'Z Z Z', 'M 0 0 Q', '--..ee', 'M 0 0 H 1 V 1 h -1 v -1', '😀 M 1 1', 'M 0 0 L 0.5 0.5 X 9 9']) {
    const p = MotionPath.parse(s);
    for (const t of [NaN, -1, 0, 0.5, 1, 2]) { const [x, y] = p.at(t); assert.ok(Number.isFinite(x) && Number.isFinite(y), s); }
  }
  assert.ok(MotionPath.parse('L 1 1 '.repeat(50_000)).points.length <= 20_000);
});

test('preset_paths_move', () => {
  for (const [id, , cls, , , opts] of ANIMATIONS.filter(a => a[2] === 'path' && a[0] !== 'customPath')) {
    for (const o of [...opts, '']) assert.ok(MotionPath.parse(motionDefaultPath(id, o)).length() > 0, `${id} ${o}`);
  }
  const tl = tlOf([{...anim(1, 'path', 'lines', 'onClick'), option: 'right'}]);
  const s = tl.state('1', null, 1, 0);
  assert.ok(Math.abs(s.offsetX - 0.25 * W) < 1e-6 && Math.abs(s.offsetY) < 1e-6);
});

test('custom_path_offsets_in_points', () => {
  const tl = tlOf([{...anim(1, 'path', 'customPath', 'onClick'), path: 'M 0 0 L 0.5 0.5 E'}]);
  const s = tl.state('1', null, 1, 0);
  assert.ok(Math.abs(s.offsetX - 480) < 1e-6 && Math.abs(s.offsetY - 270) < 1e-6);
});

test('easing_endpoints', () => {
  for (const [a, d, b] of [[0, 0, 0], [0.5, 0.5, 0], [0.3, 0, 0], [0, 0.7, 0], [0.9, 0.9, 0], [0, 0, 0.3]]) {
    assert.ok(Math.abs(ease(0, a, d, b)) < 1e-9, `${a} ${d} ${b}`);
    assert.ok(Math.abs(ease(1, a, d, b) - 1) < 1e-9, `${a} ${d} ${b}`);
  }
  assert.ok(ease(0.5, 0.5, 0.5, 0) > 0.49 && ease(0.5, 0.5, 0.5, 0) < 0.51);
});

test('compose_and_sanitize', () => {
  const a = {...identityState(), opacity: 0.5, offsetX: 10, scaleX: 2, rotate: 10, clip: [0, 0, 1, 1]};
  const b = {...identityState(), opacity: 0.5, offsetX: 5, scaleX: 3, rotate: 5, clip: [0.25, 0, 0.75, 1]};
  const c = compose(a, b);
  assert.ok(near(c.opacity, 0.25) && c.offsetX === 15 && c.scaleX === 6 && c.rotate === 15);
  assert.deepEqual(c.clip, [0.25, 0, 0.75, 1]);
  const bad = sanitized({...identityState(), opacity: NaN, offsetX: Infinity, clip: [NaN, 2, -1, 0.5]});
  assert.ok(finite(bad) && bad.clip.every(v => v >= 0 && v <= 1));
});
