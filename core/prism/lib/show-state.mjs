// Slide show navigation and clicks: click steps, slide order (hidden slides, custom shows, ranges),
// loop and automatic advance, what was played on each visited slide, and what a click does (a
// triggered animation, a link, the next step).
// Translated from deckcraft crates/anim/src/{show,interact}.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// The rules follow PowerPoint, as observed on its slide show:
// - the topmost visible shape under the pointer decides; a shape without an action on top of one
//   with an action blocks it (the click then counts as a click on the background);
// - a shape with a triggered animation plays the next step of it per click, and starts over once
//   all its steps have played; clicking it while a step plays completes the step at once;
// - a shape with a link and a triggered animation follows the link at once;
// - with "advance on click" off a click never leaves the slide, but it still plays animation steps;
// - a slide the show returns to (link or arrow keys) looks as it was left.
//
// Actions of `next`, `prev`, `goto`, `stepDone`, `follow` and `click` are `{kind, ...}`:
// none, playStep{step}, finishStep{step}, stepBack{step}, slide{index}, end, exit; a click also
// answers animated, open{url} and exit.

import {Timeline} from './anim-timeline.mjs';
import {safeUrl} from '../model/text.mjs';
import {ctxForSlide, xfrm as resolveXfrm} from '../model/resolve.mjs';
import {masterFor} from '../model/presentation.mjs';

export const SHOW_NONE = {kind: 'none'};
const act = (kind, extra) => ({kind, ...extra});

const settings = pres => pres.show ?? {};
const slides = pres => pres.slides ?? [];

/** Index of each slide by id (the first slide wins a duplicate id). */
function slideIndices(pres) {
  const m = new Map();
  slides(pres).forEach((s, i) => { if (!m.has(s.id)) m.set(s.id, i); });
  return m;
}

/** Slide indices the show visits in order: the custom show or range from Set Up Slide Show, minus hidden slides. */
export function showOrder(pres) {
  const n = slides(pres).length;
  const st = settings(pres);
  const cs = st.customShow ? (pres.customShows ?? []).find(c => c.name === st.customShow) : null;
  let base;
  if (cs) { const idx = slideIndices(pres); base = cs.slides.map(id => idx.get(id)).filter(v => v !== undefined); }
  else if (Array.isArray(st.range)) {
    const a = Math.max(Math.max(st.range[0], 1) - 1, 0), b = Math.min(st.range[1], n);
    base = []; for (let i = a; i < b; i++) base.push(i);
  } else base = Array.from({length: n}, (_, i) => i);
  return base.filter(i => slides(pres)[i] && !slides(pres)[i].hidden);
}

function customIndices(pres, name) {
  const cs = (pres.customShows ?? []).find(c => c.name === name);
  if (!cs) return null;
  const idx = slideIndices(pres);
  const order = cs.slides.map(id => idx.get(id)).filter(i => i !== undefined && slides(pres)[i] && !slides(pres)[i].hidden);
  return order.length ? order : null;
}
const looping = pres => !!settings(pres).loopUntilEsc || settings(pres).showType === 'kiosk';

/** The timeline of slide `i` of `pres`: colours and placeholder boxes resolve through the slide's own master and layout. */
export function timelineFor(pres, i) {
  const sl = slides(pres)[i];
  if (!sl) return new Timeline();
  const ctx = ctxForSlide(pres, sl);
  const size = pres.slideSize ?? {width: 960, height: 540};
  const flat = [];
  const walkAll = list => { for (const s of list ?? []) { flat.push(s); if (s.kind?.type === 'group') walkAll(s.kind.children); } };
  walkAll(sl.shapes);
  return Timeline.of(sl, size.width, size.height, ctx ? {
    scheme: ctx.scheme,
    xfrmOf: id => { const sh = flat.find(s => s.id === id); return sh ? resolveXfrm(ctx, sh) : null; },
  } : {});
}

/** Main steps of slide `i` (0 with Show without animation). */
export const stepsOf = (pres, i, tl = null) => (settings(pres).withoutAnimation ? 0 : (tl ?? timelineFor(pres, i)).steps());

export class ShowState {
  constructor() {
    this.slide = 0;
    this.step = 0;
    this.playing = false;
    this.ended = false;
    this.active = false;
    this.lastNow = null;
    /** Map slide index → {visited, step, triggers: [{shape, done, elapsed, stamps}], clock}. */
    this.runs = new Map();
    this.order = null;
    this.custom = null;
    this.zoom = null;
    this.tlCache = new Map();
  }

  /** Start at the first slide of the show order. */
  static begin(pres) {
    const first = showOrder(pres)[0];
    if (first === undefined) { const s = new ShowState(); s.ended = true; return s; }
    return ShowState.startAt(pres, first);
  }
  /** Start at slide `i` (hidden slides allowed: "from current slide"). */
  static startAt(pres, i) {
    const s = new ShowState();
    if (i < slides(pres).length) s.enter(pres, i); else s.ended = true;
    if (settings(pres).customShow) s.custom = settings(pres).customShow;
    return s;
  }
  /** Play custom show `name` from its first slide, without changing Set Up Slide Show; null when it is missing or has no visible slide. */
  static playCustom(pres, name) {
    const order = customIndices(pres, name);
    if (!order) return null;
    const s = ShowState.startAt(pres, order[0]);
    s.order = order;
    s.custom = name;
    return s;
  }

  customName() { return this.custom || null; }
  timeline(pres, i = this.slide) {
    const key = pres;
    let m = this.tlCache.get(key);
    if (!m) { this.tlCache.clear(); m = new Map(); this.tlCache.set(key, m); }
    if (!m.has(i)) m.set(i, timelineFor(pres, i));
    return m.get(i);
  }
  steps(pres, i = this.slide) { return stepsOf(pres, i, settings(pres).withoutAnimation ? null : this.timeline(pres, i)); }
  visit(pres) {
    if (this.order) return this.order.filter(i => slides(pres)[i] && !slides(pres)[i].hidden);
    return showOrder(pres);
  }
  peekNext(pres) { return this.nextIndex(pres); }
  firstIndex(pres) { return this.visit(pres)[0]; }
  lastIndex(pres) { const v = this.visit(pres); return v[v.length - 1]; }
  nextIndex(pres) {
    const order = this.visit(pres);
    const p = order.indexOf(this.slide);
    return p >= 0 ? order[p + 1] : order.find(i => i > this.slide);
  }
  prevIndex(pres) {
    const order = this.visit(pres);
    const p = order.indexOf(this.slide);
    if (p >= 0) return p > 0 ? order[p - 1] : undefined;
    return [...order].reverse().find(i => i < this.slide);
  }

  run(i) {
    let r = this.runs.get(i);
    if (!r) { r = {visited: false, step: 0, triggers: [], clock: 0}; this.runs.set(i, r); }
    return r;
  }
  /** Save what was played on the current slide before the show moves away from it. */
  leave(pres) {
    if (!this.active) return;
    const done = this.playing ? this.step + 1 : this.step;
    this.run(this.slide).step = Math.min(done, this.steps(pres, this.slide));
    this.playing = false;
  }
  /** Show slide `i`: as it was left when the show has been there before, otherwise from the start. */
  enter(pres, i) {
    this.leave(pres);
    this.active = true;
    this.slide = i;
    this.ended = false;
    this.lastNow = null;
    const steps = this.steps(pres, i);
    const run = this.run(i);
    if (run.visited) { this.step = Math.min(run.step, steps); this.playing = false; }
    else {
      run.visited = true;
      this.step = 0;
      this.playing = !settings(pres).withoutAnimation && this.timeline(pres, i).stepIsAuto(0);
    }
  }

  /** Click / → / Space: finish the playing step, else play the next step, else go to the next slide. */
  next(pres) {
    if (!slides(pres).length) { this.ended = true; return act('exit'); }
    if (this.ended) return act('exit');
    if (this.playing) return this.stepDone(pres);
    const steps = this.steps(pres, this.slide);
    if (this.step < steps) { this.playing = true; return act('playStep', {step: this.step}); }
    if (this.zoom && this.zoom[1] === this.slide && this.zoom[0] < slides(pres).length) {
      const back = this.zoom[0];
      this.zoom = null;
      this.enter(pres, back);
      this.step = this.steps(pres, back);
      this.playing = false;
      return act('slide', {index: back});
    }
    const n = this.nextIndex(pres);
    if (n !== undefined) { this.enter(pres, n); return act('slide', {index: n}); }
    if (looping(pres)) {
      const f = this.visit(pres)[0];
      if (f !== undefined) { this.enter(pres, f); return act('slide', {index: f}); }
      this.ended = true;
      return act('end');
    }
    this.ended = true;
    this.playing = false;
    return act('end');
  }
  /** The playing step reached its end (the UI's clock passed `stepDuration`). */
  stepDone(pres) {
    if (!this.playing) return SHOW_NONE;
    const n = this.step;
    this.playing = false;
    this.step = Math.min(this.step + 1, this.steps(pres, this.slide));
    return act('finishStep', {step: n});
  }
  /** ← / Backspace: undo the last step, else go to the previous slide fully built. An automatic first step is part of the slide appearing, so it is never undone. */
  prev(pres) {
    if (this.ended) {
      this.ended = false;
      if (this.slide >= slides(pres).length) return SHOW_NONE;
      this.step = this.steps(pres, this.slide);
      this.playing = false;
      return act('slide', {index: this.slide});
    }
    const undo = this.playing ? this.step : this.step > 0 ? this.step - 1 : null;
    const autoFirst = undo === 0 && !settings(pres).withoutAnimation && this.timeline(pres, this.slide).stepIsAuto(0);
    if (undo !== null && !autoFirst) { this.playing = false; this.step = undo; return act('stepBack', {step: undo}); }
    let target = this.prevIndex(pres);
    if (target === undefined && looping(pres)) { const l = this.visit(pres).at(-1); target = l !== this.slide ? l : undefined; }
    if (target === undefined) return SHOW_NONE;
    const seen = !!this.runs.get(target)?.visited;
    this.enter(pres, target);
    if (!seen) { this.step = this.steps(pres, target); this.playing = false; }
    return act('slide', {index: target});
  }
  /** Jump to slide `i` (number + Enter, See All Slides); hidden slides are shown when jumped to. */
  goto(pres, i) {
    if (!(i >= 0 && i < slides(pres).length)) return SHOW_NONE;
    this.zoom = null;
    this.enter(pres, i);
    return act('slide', {index: i});
  }

  /** Follow a clicked hyperlink or shape action; `lastViewed` is the slide shown before the current one. Answers {kind:'show', action}, {kind:'open', url}, {kind:'exit'} or none. */
  follow(pres, action, lastViewed = null) {
    let target;
    switch (action?.kind) {
      case 'url': return safeUrl(action.url) ? {kind: 'open', url: String(action.url).trim()} : SHOW_NONE;
      case 'endShow': return act('exit');
      case 'slide': target = slides(pres).findIndex(s => s.id === action.slide); if (target < 0) target = undefined; break;
      case 'nextSlide': target = this.nextIndex(pres); break;
      case 'previousSlide': target = this.prevIndex(pres); break;
      case 'firstSlide': target = this.visit(pres)[0]; break;
      case 'lastSlide': target = this.visit(pres).at(-1); break;
      case 'lastViewed': target = lastViewed ?? undefined; break;
      case 'customShow': {
        const order = customIndices(pres, action.name);
        if (!order) return SHOW_NONE;
        this.order = order;
        this.custom = action.name;
        return act('show', {action: this.goto(pres, order[0])});
      }
      default: return SHOW_NONE;
    }
    return target === undefined ? SHOW_NONE : act('show', {action: this.goto(pres, target)});
  }
  /** Follow a clicked link, honouring a zoom's Return to Zoom. */
  followLink(pres, link, lastViewed = null) {
    const from = this.slide;
    const jump = this.follow(pres, link.action, lastViewed);
    const until = link.zoomReturn != null ? slides(pres).findIndex(s => s.id === link.zoomReturn) : -1;
    if (until >= 0 && jump.kind === 'show' && jump.action.kind === 'slide') this.zoom = [from, until];
    return jump;
  }

  /** Seconds after which the current slide advances by itself (Advance Slide ▸ After), when the show uses timings. */
  advanceAfter(pres) {
    if (!settings(pres).useTimings || this.ended) return null;
    const ms = slides(pres)[this.slide]?.transition?.advanceAfterMs;
    return ms === null || ms === undefined ? null : ms / 1000;
  }
  /** Should the show advance now, `elapsed` seconds after the slide appeared? */
  autoAdvanceDue(pres, elapsed) {
    const after = this.advanceAfter(pres);
    return after !== null && !this.playing && Number.isFinite(elapsed) && elapsed >= after;
  }

  // ---- interact.rs --------------------------------------------------------------------------

  animated(pres) { return !settings(pres).withoutAnimation; }
  triggerLive(pres, tl, shape) { return this.animated(pres) && tl.triggerSteps(shape) > 0; }
  /** The playheads of the current slide's triggered sequences: [{trigger, step, t}]. */
  triggerPlays() { return (this.runs.get(this.slide)?.triggers ?? []).map(t => ({trigger: t.shape, step: t.done, t: t.elapsed ?? 0})); }
  /** When the steps of the current slide's triggered sequences were started: [{trigger, step, at}]. */
  triggerStamps() { return (this.runs.get(this.slide)?.triggers ?? []).flatMap(t => t.stamps.map((at, step) => ({trigger: t.shape, step, at}))); }
  triggerPlaying() { return !!this.runs.get(this.slide)?.triggers.some(t => t.elapsed !== null && t.elapsed !== undefined); }
  /** Animation state of `shape` on the current slide: main step `step` with `tMain` seconds played, plus the triggered sequences. */
  animState(tl, shape, tMain) { return tl.stateOrdered(shape, null, this.step, tMain, this.triggerPlays(), this.triggerStamps()); }

  /** Advance the clock of the playing triggered animations to `now` (seconds) and complete the steps that reached their end. Answers 'animated' when the picture changed. */
  tick(tl, now) {
    let dt = 0;
    if (this.lastNow !== null && Number.isFinite(now)) dt = Math.min(Math.max(now - this.lastNow, 0), 3600);
    if (Number.isFinite(now)) this.lastNow = now;
    const run = this.runs.get(this.slide);
    if (!run) return SHOW_NONE;
    let changed = false;
    for (const t of run.triggers) {
      if (t.elapsed === null || t.elapsed === undefined) continue;
      const e = (Number.isFinite(t.elapsed) ? t.elapsed : 0) + dt;
      if (e >= tl.triggerStepDuration(t.shape, t.done)) { t.done += 1; t.elapsed = null; changed = true; }
      else t.elapsed = e;
    }
    return changed ? act('animated') : SHOW_NONE;
  }

  /**
   * Index of the topmost shape a click lands on: the front-most one under the pointer that is
   * shown. A group without an action does not count. `shapes`: [{id, parent, isGroup, link,
   * underPointer}] in drawing order (a group before its children).
   */
  top(pres, tl, shapes, visible) {
    const shown = start => {
      let i = start;
      for (let k = 0; k <= shapes.length; k++) {
        const h = shapes[i];
        if (!h || !visible(h.id)) return false;
        if (h.parent === null || h.parent === undefined) return true;
        i = h.parent;
      }
      return false;
    };
    for (let i = shapes.length - 1; i >= 0; i--) {
      const h = shapes[i];
      if (h.underPointer && !(h.isGroup && !this.interactive(pres, tl, h)) && shown(i)) return i;
    }
    return null;
  }
  interactive(pres, tl, h) { return !!h.link || this.triggerLive(pres, tl, h.id); }
  /** The shape under the pointer a click would act on ({shape, link}), null when a click would be on the background. */
  target(pres, tl, shapes, visible) {
    let at = this.top(pres, tl, shapes, visible);
    for (let k = 0; k <= shapes.length; k++) {
      if (at === null || at === undefined) return null;
      const h = shapes[at];
      if (!h) return null;
      if (this.interactive(pres, tl, h)) return {shape: h.id, link: h.link ?? null};
      at = h.parent;
    }
    return null;
  }

  /** A mouse click: answers {kind: 'none'|'animated'|'show'|'open'|'exit', ...}. */
  click(pres, tl, shapes, visible, now, lastViewed = null) {
    this.tick(tl, now);
    if (this.ended) return SHOW_NONE;
    const t = this.target(pres, tl, shapes, visible);
    if (!t) return this.backgroundClick(pres);
    let animated = false;
    if (this.triggerLive(pres, tl, t.shape)) {
      const run = this.run(this.slide);
      let at = run.triggers.findIndex(r => r.shape === t.shape);
      if (at < 0) { run.triggers.push({shape: t.shape, done: 0, elapsed: null, stamps: []}); at = run.triggers.length - 1; }
      const stamp = run.clock + 1;
      const r = run.triggers[at];
      if (r.elapsed !== null && r.elapsed !== undefined) { r.done += 1; r.elapsed = null; }
      else {
        if (r.done >= tl.triggerSteps(t.shape)) { r.done = 0; r.stamps = []; }
        r.stamps.push(stamp);
        run.clock = stamp;
        if (tl.triggerStepDuration(t.shape, r.done) > 0) r.elapsed = 0; else r.done += 1;
      }
      animated = true;
    }
    if (t.link) {
      const j = this.follow(pres, t.link.action ?? t.link, lastViewed);
      return j.kind === 'show' ? j : j;
    }
    return animated ? act('animated') : SHOW_NONE;
  }
  /** A click that is on no shape with an action: next animation step, then next slide, unless the slide has "advance on click" off. */
  backgroundClick(pres) {
    const t = slides(pres)[this.slide]?.transition;
    const advance = !t || t.advanceOnClick !== false;
    const stepsLeft = this.playing || this.step < this.steps(pres, this.slide);
    return advance || stepsLeft ? act('show', {action: this.next(pres)}) : SHOW_NONE;
  }
}
