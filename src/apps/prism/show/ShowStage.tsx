// The slide show engine and its picture: the slide drawn in its animation state each frame, the
// transitions between slides, clicks, keys, automatic advance, the end screen; and the two previews
// (Transitions › Preview, Animations › Preview / the Animation Pane's Play From).
// Follows deckcraft crates/ui-egui/src/show.rs, show/keys.rs, show/ui.rs (the clocks `step_start`,
// `slide_start`, `step_end`, the actions `PlayStep` / `FinishStep` / `StepBack` / `Slide` / `End`,
// the keys, the end screen, the toolbar) at f893f6af7d36a5409fd804e81a34fd895cfefedf; the logic is
// core/prism/lib/show-state.mjs, show-hit.mjs and transition-fx.mjs.
//
// The slide is the same SlideView the editor draws (SVG, one unit a point), given an AnimFrame
// per frame; a transition draws the old and new slides as bitmaps (raster.ts) through the layers
// of transition-fx.mjs (layers.ts). The pen, highlighter, eraser and laser pointer (Ctrl+P, Ctrl+L, Ctrl+A, E, the
// toolbar's pen menu and a right click) follow deckcraft's pen and laser (show/ui.rs draw_pen_and_hints); keeping the
// ink at the end is PowerPoint's. Not translated: zoom, See All Slides.

import {MediaLayer} from '../surface/MediaLayer';
import {useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState} from 'react';
import {ShowState, timelineFor} from '../../../../core/prism/lib/show-state.mjs';
import {animFrame} from '../../../../core/prism/lib/anim-frame.mjs';
import {hitShapes} from '../../../../core/prism/lib/show-hit.mjs';
import {transitionFrame, usesSlideParts, wholeSource} from '../../../../core/prism/lib/transition-fx.mjs';
import {morphPlan, morphPairs} from '../../../../core/prism/lib/morph.mjs';
import {SlideView, type AnimFrame} from '../surface/SlideView';
import {rasterize} from './raster';
import {LayerRenderer, type Textures} from './layers';
import './show.css';

type Any = any;
export type StageMode = 'show' | 'transition' | 'animation';

export interface ShowStageProps {
  content: Any;
  mode: StageMode;
  /** The slide the show starts at (an index); a preview's slide. */
  from: number;
  /** A custom show to play. */
  custom?: string | null;
  /** Animation preview: the effect to play from (Animation Pane ▸ Play From). */
  playFrom?: number | null;
  /** The show has ended, or the preview finished, or Esc. */
  onExit: (timings?: [number, number][]) => void;
  /** Rehearse Timings: time each slide and hand the times (slide index, milliseconds) to onExit. */
  rehearse?: boolean;
  /** Draw inside the parent (a preview over the slide) instead of covering the window. */
  embedded?: boolean;
  /** The latest show.next / previous / first / last / goto / blackScreen / whiteScreen request (the bridge's keys). */
  command?: {kind: string; index?: number; n: number} | null;
  /** Where the show is, reported when it changes (show.report). */
  onStatus?: (s: {slide: number; step: number; playing: boolean; ended: boolean; transition: string | null; blank: string | null; pointer?: string; ink?: number; keepAsk?: boolean}) => void;
  /** The ink drawn in the show, when the person keeps it at the end (show.addInk). */
  onKeepInk?: (ink: {slide: number; strokes: Stroke[]}[]) => void;
}

/** One stroke of the pen or highlighter, in slide points. */
export interface Stroke { points: [number, number, number][]; color: {r: number; g: number; b: number; a: number}; width: number; highlighter: boolean }
type Pointer = 'arrow' | 'laser' | 'pen' | 'highlighter' | 'eraser';
const HIGHLIGHT = {r: 255, g: 255, b: 0, a: 255};
const POINTER_ITEMS: [Pointer, string][] = [['arrow', 'Arrow'], ['laser', 'Laser Pointer'], ['pen', 'Pen'], ['highlighter', 'Highlighter'], ['eraser', 'Eraser']];
const cssRgb = (c: {r: number; g: number; b: number}) => `rgb(${c.r},${c.g},${c.b})`;

interface Trans { oldSlide: number | null; oldFrame: AnimFrame | null; kind: string; option: string; dur: number; ready: boolean; start: number; tex: Textures | null; morph: boolean; newSlide: number }

const END_TEXT = 'End of slide show, click to exit.';
const TOOLBAR_MS = 2.5;

/** The animation state of a slide at one moment, as the renderer takes it. */
function frameAt(pres: Any, state: Any, tl: Any, tMain: number): AnimFrame | null {
  if (!tl || tl.isEmpty()) return null;
  const sh = pres.show ?? {};
  const done = sh.withoutAnimation;
  const step = done ? Math.max(tl.steps(), 1) : state.step;
  const t = done ? 0 : tMain;
  return animFrame(tl, (id: string, p: number | null) => (p === null
    ? (done ? tl.state(id, null, step, t) : state.animState(tl, id, t))
    : tl.state(id, p, step, t)));
}

export default function ShowStage({content: pres, mode, from, custom = null, playFrom = null, onExit, rehearse = false, embedded = false, command = null, onStatus, onKeepInk}: ShowStageProps) {
  const root = useRef<HTMLDivElement>(null);
  const glass = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<LayerRenderer | null>(null);
  const [box, setBox] = useState({w: 960, h: 540});
  const [, force] = useReducer((n: number) => n + 1, 0);
  const size = pres.slideSize ?? {width: 960, height: 540};
  const scale = Math.max(Math.min(box.w / size.width, box.h / size.height), 0.01);
  const pw = size.width * scale, ph = size.height * scale;
  const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);
  const px = {w: Math.max(Math.round(pw * dpr), 2), h: Math.max(Math.round(ph * dpr), 2)};

  // All of the show's mutable state: it changes at most once a frame and the picture follows.
  const R = useRef<Any>(null);
  if (R.current === null) {
    const state = mode === 'show' ? (custom ? ShowState.playCustom(pres, custom) ?? ShowState.startAt(pres, from) : ShowState.startAt(pres, from)) : null;
    R.current = {state, now: 0, t0: typeof performance === 'undefined' ? 0 : performance.now() / 1000, stepStart: 0, slideStart: 0, stepEnd: 0, trans: null as Trans | null,
      blank: null as null | 'black' | 'white', goto: '', gotoAt: 0,
      pointer: 'arrow' as Pointer, ink: new Map<number, Stroke[]>(), drawing: null as Stroke | null, drawingSlide: 0, laserAt: null as null | {x: number; y: number}, menu: null as null | {x: number; y: number}, keepAsk: false, keepAsked: false, last: null as number | null, ended: !!state?.ended, pointerAt: embedded ? -99 : 0, done: false, preview: null as Any};
    // Slide 0 of a show with an automatic first step starts it at once.
    if (state?.playing) R.current.stepStart = 0;
  }
  const pxRef = useRef(px); pxRef.current = px;
  const presRef = useRef(pres); presRef.current = pres;

  // Rehearse Timings (deckcraft show.rs: a (slide, seconds) pair pushed when the slide changes and when the show ends).
  const rehearsal = useRef<{showStart: number; slideStart: number; slide: number | null; timings: [number, number][]; pausedAt: number | null} | null>(null);
  if (rehearse && rehearsal.current === null) { const t0 = performance.now(); rehearsal.current = {showStart: t0, slideStart: t0, slide: null, timings: [], pausedAt: null}; }
  const shownSlide: number | null = mode === 'show' ? R.current.state?.slide ?? null : null;
  if (rehearsal.current && shownSlide !== null && rehearsal.current.slide !== shownSlide) {
    const rh = rehearsal.current, t = performance.now();
    if (rh.slide !== null) rh.timings.push([rh.slide, Math.round(t - rh.slideStart)]);
    rh.slide = shownSlide;
    rh.slideStart = t;
  }
  const finish = useCallback(() => {
    if (R.current.done) return;
    // A show with ink asks first: "Do you want to keep your ink annotations?"
    if (mode === 'show' && !embedded && !R.current.keepAsked && [...R.current.ink.values()].some((l: Stroke[]) => l.length)) { R.current.keepAsked = true; R.current.keepAsk = true; R.current.menu = null; force(); return; }
    R.current.done = true;
    const rh = rehearsal.current;
    if (rh && rh.slide !== null) { rh.timings.push([rh.slide, Math.round(performance.now() - rh.slideStart)]); onExit(rh.timings); } else onExit();
  }, [onExit, mode, embedded]);
  /** The answer to the keep-ink question: Keep hands the strokes over, Discard drops them; either way the show ends. */
  const answerInk = useCallback((keep: boolean) => {
    const r = R.current;
    if (!r.keepAsk) return;
    r.keepAsk = false;
    if (keep && onKeepInk) onKeepInk([...r.ink.entries()].filter(([, l]: [number, Stroke[]]) => l.length).map(([slide, strokes]: [number, Stroke[]]) => ({slide, strokes})));
    r.ink.clear();
    finish();
  }, [finish, onKeepInk]);
  /** The pointer in use: a second ask for the same one puts the arrow back (Ctrl+P twice). */
  const togglePointer = useCallback((p: Pointer) => { const r = R.current; r.pointer = r.pointer === p && p !== 'arrow' ? 'arrow' : p; r.drawing = null; r.menu = null; r.laserAt = p === 'laser' ? r.laserAt : null; force(); }, []);
  const choosePointer = useCallback((p: Pointer) => { const r = R.current; r.pointer = p; r.drawing = null; r.menu = null; force(); }, []);
  const eraseInk = useCallback(() => { const r = R.current; r.ink.delete(r.state?.slide ?? 0); r.drawing = null; r.menu = null; force(); }, []);
  const [, tickRehearsal] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { if (!rehearse) return undefined; const id = window.setInterval(tickRehearsal, 100); return () => window.clearInterval(id); }, [rehearse]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => setBox({w: el.clientWidth, h: el.clientHeight});
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- the transition's textures and the previews' set-up ------------------------------------

  const startTransition = useCallback(async (oldSlide: number | null, oldFrame: AnimFrame | null, newSlide: number, now: number, previewFrame: AnimFrame | null = null) => {
    const p = presRef.current;
    const t = p.slides[newSlide]?.transition;
    if (!t || t.kind === 'none' || !(t.durationMs > 0) || p.show?.withoutAnimation) return false;
    const info: Trans = {oldSlide, oldFrame, kind: t.kind, option: t.option ?? '', dur: t.durationMs / 1000, ready: false, start: 0, tex: null, morph: t.kind === 'morph' && oldSlide !== null,
      newSlide};
    R.current.trans = info;
    const {w, h} = pxRef.current;
    const parts = usesSlideParts(t.kind, t.option ?? '');
    const state: Any = R.current.state;
    const newTl = state ? state.timeline(p, newSlide) : timelineFor(p, newSlide);
    const newFrame = previewFrame ?? frameAt(p, state ?? new ShowState(), newTl, 0);
    try {
      const jobs: Promise<[string, HTMLCanvasElement]>[] = [];
      const add = (k: string, slide: Any, parts_: 'all' | 'back' | 'content', fr: AnimFrame | null) => jobs.push(rasterize(p, slide, parts_, w, h, fr).then(c => [k, c] as [string, HTMLCanvasElement]));
      const oldS = oldSlide === null ? null : p.slides[oldSlide];
      const newS = p.slides[newSlide];
      if (!info.morph) {
        if (oldS) add('old', oldS, 'all', oldFrame);
        add('new', newS, 'all', newFrame);
        if (parts) {
          if (oldS) { add('oldBack', oldS, 'back', null); add('oldContent', oldS, 'content', oldFrame); }
          add('newBack', newS, 'back', null); add('newContent', newS, 'content', newFrame);
        }
      }
      info.tex = Object.fromEntries(await Promise.all(jobs)) as Textures;
    } catch { info.tex = null; }
    if (R.current.trans !== info) return true;
    info.ready = true;
    info.start = performance.now() / 1000 - R.current.t0;
    if (R.current.state) { R.current.stepStart = info.start + info.dur; }
    force();
    return true;
  }, []);

  // ---- applying what the state machine says --------------------------------------------------

  const apply = useCallback((a: Any, now: number, before: {slide: number; frame: AnimFrame | null} | null) => {
    const r = R.current;
    const s: ShowState = r.state;
    switch (a?.kind) {
      case 'show': apply(a.action, now, before); return;
      case 'playStep': r.stepStart = now; return;
      case 'finishStep': case 'stepBack': r.stepEnd = now; return;
      case 'slide': {
        r.ended = false;
        const from_ = before?.slide ?? null;
        if (from_ !== a.index) r.last = from_;
        r.slideStart = now; r.stepStart = now; r.stepEnd = now;
        r.trans = null;
        if (before && before.slide !== a.index) void startTransition(from_, before.frame, a.index, now);
        return;
      }
      case 'animated': return;
      case 'end': r.ended = true; return;
      case 'open': { try { (window as Any).studio?.openExternal?.(a.url); } catch { /* no external opener */ } return; }
      case 'exit': finish(); return;
      default: void s;
    }
  }, [finish, startTransition]);

  /** Run a navigation call on the state, with what the screen showed just before kept for a transition. */
  const navigate = useCallback((f: (s: ShowState) => Any) => {
    const r = R.current;
    const s: ShowState = r.state;
    if (!s) return;
    const now = performance.now() / 1000 - r.t0;
    // A transition under way is cut short by the next move.
    if (r.trans) { r.trans = null; if (s.playing) r.stepStart = now; }
    const tl = s.timeline(presRef.current, s.slide);
    const tMain = s.playing ? now - r.stepStart : 0;
    const before = {slide: s.slide, frame: frameAt(presRef.current, s, tl, tMain)};
    const a = f(s);
    apply(a, now, before);
    force();
  }, [apply]);

  // ---- the clock -----------------------------------------------------------------------------

  useEffect(() => {
    const r = R.current;
    const p0 = presRef.current;
    // Previews: the transition into slide `from` from the one before it; the animations of `from` on the play-everything clock.
    if (mode === 'transition') {
      const prev = from > 0 ? from - 1 : null;
      const tl = timelineFor(p0, from);
      const st = new ShowState();
      const frame = frameAt(p0, st, tl, 0);
      void startTransition(prev, null, from, 0, frame).then(ok => { if (!ok) finish(); });
    }
    if (mode === 'animation') {
      const tl = timelineFor(p0, from);
      const at = playFrom !== null && playFrom !== undefined ? tl.startOf(playFrom) : 0;
      r.preview = {tl, from: at ?? 0, total: tl.totalDuration(), start: 0};
      r.preview.start = performance.now() / 1000 - r.t0;
      if (tl.isEmpty()) finish();
    }
    let id = 0;
    const loop = () => {
      const now = performance.now() / 1000 - r.t0;
      r.now = now;
      let animating = false;
      const s: ShowState | null = r.state;
      const t: Trans | null = r.trans;
      if (r.done) return;
      if (t) {
        animating = true;
        if (t.ready && now - t.start >= t.dur) {
          r.trans = null;
          if (mode === 'transition') { finish(); return; }
          if (s?.playing) r.stepStart = now;
        }
      } else if (mode === 'animation' && r.preview) {
        animating = true;
        if (now - r.preview.start + r.preview.from > r.preview.total + 0.8) { finish(); return; }
      } else if (s && !r.ended) {
        const tl = s.timeline(presRef.current, s.slide);
        if (s.playing) {
          animating = true;
          if (now - r.stepStart >= tl.stepDuration(s.step)) { const a = s.stepDone(presRef.current); apply(a, now, null); }
        } else {
          if (s.tick(tl, now).kind === 'animated') animating = true;
          if (s.triggerPlaying()) animating = true;
          const idle = now - Math.max(r.stepEnd, r.slideStart);
          if (s.autoAdvanceDue(presRef.current, idle)) { const before = {slide: s.slide, frame: frameAt(presRef.current, s, tl, 0)}; apply(s.next(presRef.current), now, before); animating = true; }
        }
      }
      if (r.goto && now - r.gotoAt > 1.5) { r.goto = ''; animating = true; }
      if (embedded === false && now - r.pointerAt < TOOLBAR_MS + 0.1) animating = true;
      if (animating) force();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- keys and the pointer ------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = R.current;
      if (r.done) return;
      const k = e.key;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (mode !== 'show') { if (k === 'Escape') { stop(); finish(); } return; }
      // "Do you want to keep your ink annotations?": Enter keeps, Esc discards.
      if (r.keepAsk) { stop(); if (k === 'Enter') answerInk(true); else if (k === 'Escape') answerInk(false); return; }
      // Ctrl+P pen, Ctrl+L laser pointer, Ctrl+A arrow, Ctrl+E eraser.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const p = ({p: 'pen', l: 'laser', a: 'arrow', e: 'eraser'} as Record<string, Pointer>)[k.toLowerCase()];
        if (p) { stop(); togglePointer(p); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s: ShowState = r.state;
      const p = presRef.current;
      if (k === 'Escape' || k === '-') {
        stop();
        if (k === 'Escape' && r.goto) { r.goto = ''; force(); return; }
        if (k === 'Escape' && r.menu) { r.menu = null; force(); return; }
        if (k === 'Escape' && r.pointer !== 'arrow') { r.pointer = 'arrow'; r.drawing = null; r.laserAt = null; force(); return; }
        if (r.blank) { r.blank = null; force(); return; }
        finish();
        return;
      }
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'n', 'N', 'Enter'].includes(k)) {
        stop();
        if (k === 'Enter' && r.goto) { const i = Number(r.goto) - 1; r.goto = ''; if (Number.isFinite(i)) navigate(x => x.goto(p, i)); return; }
        if (r.ended) { finish(); return; }
        r.blank = null;
        navigate(x => x.next(p));
        return;
      }
      if (k === 'Backspace' && r.goto) { stop(); r.goto = r.goto.slice(0, -1); force(); return; }
      if (['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp', 'p', 'P'].includes(k)) { stop(); r.ended = false; r.blank = null; navigate(x => x.prev(p)); return; }
      if (k === 'Home') { stop(); const i = s.firstIndex(p); if (i !== undefined) navigate(x => x.goto(p, i)); return; }
      if (k === 'End') { stop(); const i = s.lastIndex(p); if (i !== undefined) navigate(x => x.goto(p, i)); return; }
      if (k === 'e' || k === 'E') { stop(); eraseInk(); return; }
      if (k === 'b' || k === 'B' || k === '.') { stop(); r.blank = r.blank === 'black' ? null : 'black'; force(); return; }
      if (k === 'w' || k === 'W' || k === ',') { stop(); r.blank = r.blank === 'white' ? null : 'white'; force(); return; }
      if (/^[0-9]$/.test(k)) { stop(); r.goto = (r.goto + k).slice(0, 4); r.gotoAt = performance.now() / 1000 - r.t0; force(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, navigate, finish, answerInk, togglePointer, eraseInk]);

  // The bridge's keys: the same moves the keyboard makes.
  const lastCommand = useRef(command?.n ?? 0);
  useEffect(() => {
    if (!command || command.n === lastCommand.current || mode !== 'show') return;
    lastCommand.current = command.n;
    const rr = R.current, p = presRef.current, st: ShowState = rr.state;
    switch (command.kind) {
      case 'next': if (rr.ended) finish(); else { rr.blank = null; navigate(x => x.next(p)); } break;
      case 'previous': rr.ended = false; rr.blank = null; navigate(x => x.prev(p)); break;
      case 'first': { const i = st.firstIndex(p); if (i !== undefined) navigate(x => x.goto(p, i)); break; }
      case 'last': { const i = st.lastIndex(p); if (i !== undefined) navigate(x => x.goto(p, i)); break; }
      case 'goto': navigate(x => x.goto(p, command.index ?? 0)); break;
      case 'blackScreen': rr.blank = rr.blank === 'black' ? null : 'black'; force(); break;
      case 'whiteScreen': rr.blank = rr.blank === 'white' ? null : 'white'; force(); break;
      case 'arrow': case 'laser': case 'pen': case 'highlighter': case 'eraser': {
        togglePointer(command.kind as Pointer);
        const at = (command as Any).at as number[] | undefined;
        if (command.kind === 'laser' && at) rr.laserAt = {x: (box.w - pw) / 2 + at[0] * scale, y: (box.h - ph) / 2 + at[1] * scale};
        break;
      }
      case 'stroke': {
        const c = command as Any;
        const hl = !!c.highlighter;
        const k: Stroke = {points: (c.points as number[][]).map(q => [q[0], q[1], q[2] ?? 1] as [number, number, number]), color: hl ? HIGHLIGHT : p.show?.penColor ?? {r: 255, g: 0, b: 0, a: 255}, width: hl ? 18 : 2.25, highlighter: hl};
        rr.ink.set(st.slide, [...(rr.ink.get(st.slide) ?? []), k]);
        force();
        break;
      }
      case 'menu': rr.menu = rr.menu ? null : {x: 14, y: -1}; force(); break;
      case 'eraseInk': eraseInk(); break;
      case 'askInk': finish(); break;
      case 'keepInk': if (!rr.keepAsk) finish(); answerInk(true); break;
      case 'discardInk': if (!rr.keepAsk) finish(); answerInk(false); break;
      default: break;
    }
  }, [command, mode, navigate, finish, togglePointer, eraseInk, answerInk]);

  /** The pointer's position in slide points, null when the slide is not on screen. */
  const slidePoint = (e: {clientX: number; clientY: number}) => {
    const rect = root.current?.querySelector('.show-slide')?.getBoundingClientRect();
    return rect ? {x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale} : null;
  };
  /** The eraser: every stroke of this slide with a point under it goes. */
  const eraseAt = (at: {x: number; y: number}) => {
    const r = R.current;
    const list: Stroke[] | undefined = r.ink.get(r.drawingSlide);
    if (!list) return;
    const keep = list.filter(k => !k.points.some(([x, y]) => Math.hypot(x - at.x, y - at.y) <= 6 + k.width / 2));
    if (keep.length !== list.length) r.ink.set(r.drawingSlide, keep);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const r = R.current;
    if (mode !== 'show') { e.stopPropagation(); finish(); return; }
    if (e.button !== 0 || r.done) return;
    if ((e.target as Element).closest?.('.show-toolbar, .show-rehearse, .show-pmenu, .show-keep')) return;
    if (r.menu) { r.menu = null; force(); return; }
    if (r.keepAsk) return;
    // The pen, highlighter and eraser draw instead of turning the page.
    if (r.pointer === 'pen' || r.pointer === 'highlighter' || r.pointer === 'eraser') {
      const at0 = slidePoint(e);
      if (!at0) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const slideNow = (r.state as ShowState).slide;
      if (r.pointer === 'eraser') { r.drawing = {points: [], color: HIGHLIGHT, width: 0, highlighter: false}; r.drawingSlide = slideNow; eraseAt(at0); }
      else {
        const hl = r.pointer === 'highlighter';
        r.drawing = {points: [[at0.x, at0.y, 1]], color: hl ? HIGHLIGHT : presRef.current.show?.penColor ?? {r: 255, g: 0, b: 0, a: 255}, width: hl ? 18 : 2.25, highlighter: hl};
        r.drawingSlide = slideNow;
      }
      force();
      return;
    }
    const s: ShowState = r.state;
    const p = presRef.current;
    if (r.ended) { finish(); return; }
    r.blank = null;
    const rect = (e.currentTarget as HTMLElement).querySelector('.show-slide')?.getBoundingClientRect();
    const at = rect ? {x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale} : {x: -1, y: -1};
    const now = performance.now() / 1000 - r.t0;
    if (r.trans) { r.trans = null; if (s.playing) r.stepStart = now; }
    const tl = s.timeline(p, s.slide);
    const tMain = s.playing ? now - r.stepStart : 0;
    const before = {slide: s.slide, frame: frameAt(p, s, tl, tMain)};
    const hits = hitShapes(p, p.slides[s.slide], at);
    const vis = new Map<string, boolean>(hits.map((h: Any) => { const st = s.animState(tl, h.id, tMain); return [h.id, st.visible && st.opacity > 0]; }));
    const res = s.click(p, tl, hits, (id: string) => vis.get(id) ?? true, now, r.last);
    apply(res, now, before);
    force();
  };

  const onMove = (e: React.PointerEvent) => {
    const r = R.current;
    r.pointerAt = performance.now() / 1000 - r.t0;
    const box0 = root.current?.getBoundingClientRect();
    if (r.pointer === 'laser' && box0) r.laserAt = {x: e.clientX - box0.left, y: e.clientY - box0.top};
    if (r.drawing) {
      const at = slidePoint(e);
      if (at) { if (r.pointer === 'eraser') eraseAt(at); else r.drawing.points.push([at.x, at.y, 1]); }
    }
    force();
  };
  const onPointerUp = () => {
    const r = R.current;
    const k: Stroke | null = r.drawing;
    if (!k) return;
    r.drawing = null;
    if (r.pointer !== 'eraser' && k.points.length) {
      if (k.points.length === 1) k.points.push([k.points[0][0], k.points[0][1], 1]);
      r.ink.set(r.drawingSlide, [...(r.ink.get(r.drawingSlide) ?? []), k]);
    }
    force();
  };
  const onContextMenu = (e: React.MouseEvent) => {
    if (mode !== 'show' || embedded || R.current.keepAsk) return;
    e.preventDefault();
    const box0 = root.current?.getBoundingClientRect();
    R.current.menu = {x: e.clientX - (box0?.left ?? 0), y: e.clientY - (box0?.top ?? 0)};
    force();
  };

  // ---- the picture ---------------------------------------------------------------------------

  const r = R.current;
  const now = r.now;
  const s: ShowState | null = r.state;
  let slideIndex = mode === 'show' ? s!.slide : from;
  let frame: AnimFrame | null = null;
  let fx: Any = null;
  let backOpacity = 1;
  const t: Trans | null = r.trans;
  const transNow = t && t.ready ? Math.min(Math.max((now - t.start) / Math.max(t.dur, 1e-3), 0), 1) : 0;
  if (mode === 'show' && s) {
    const tl = s.timeline(pres, s.slide);
    frame = frameAt(pres, s, tl, s.playing ? now - r.stepStart : 0);
    if (t && !t.ready && t.oldSlide !== null) { slideIndex = t.oldSlide; frame = t.oldFrame; }
  } else if (mode === 'animation' && r.preview) {
    const tl = r.preview.tl;
    const time = r.preview.from + (now - r.preview.start);
    frame = animFrame(tl, (id: string, p: number | null) => tl.stateAt(id, p, Math.min(time, tl.totalDuration())));
  } else if (mode === 'transition') {
    // The new slide as it stands when the transition ends (shown once the transition is done: the preview closes).
    frame = null;
  }
  const morphing = !!(t && t.ready && t.morph && t.oldSlide !== null);
  let morphNew: Any = null, morphOld: Any = null;
  if (morphing && t) {
    const oldS = pres.slides[t.oldSlide!], newS = pres.slides[t.newSlide];
    const newTl = s ? s.timeline(pres, t.newSlide) : timelineFor(pres, t.newSlide);
    const hiddenIds = new Set<string>(newS.shapes.filter((sh: Any) => { const st = newTl.state(sh.id, null, 0, 0); return !st.visible; }).map((sh: Any) => sh.id));
    const plan = morphPlan(pres, oldS, newS, transNow, (id: string) => hiddenIds.has(id));
    morphOld = plan.old; morphNew = plan.new;
    backOpacity = plan.mix;
  }

  // The layers drawn over black during a transition.
  const painting = !!(t && t.ready && !t.morph);
  useLayoutEffect(() => {
    const c = glass.current;
    if (!c) return;
    if (!renderer.current || renderer.current.canvas !== c) { renderer.current?.dispose(); renderer.current = new LayerRenderer(c); }
    const rr = renderer.current;
    if (painting && t && t.tex) {
      rr.resize(px.w, px.h);
      if ((rr as Any).__tex !== t.tex) { rr.setTextures(t.tex); (rr as Any).__tex = t.tex; }
      const parts = usesSlideParts(t.kind, t.option);
      // Without the pieces a Dynamic Content transition needs, its whole slides stand in.
      let layers = transitionFrame(t.kind, t.option, transNow, size.width / size.height);
      if (!parts) layers = layers.filter((l: Any) => wholeSource(l.source) !== null || l.source === 'black' || l.source === 'white');
      rr.draw(layers);
    }
  });
  useEffect(() => () => renderer.current?.dispose(), []);

  const slide = pres.slides[slideIndex];
  const wrapStyle = {left: (box.w - pw) / 2, top: (box.h - ph) / 2, width: pw, height: ph};
  // The toolbar is always there, faint until the pointer moves (PowerPoint's hidden toolbar at the bottom left).
  const toolbarActive = now - r.pointerAt < TOOLBAR_MS;
  const toolbarOn = mode === 'show' && !embedded && !r.ended;
  const laser = pres.show?.laserColor ?? {r: 255, g: 0, b: 0};
  const exitText = r.ended || s?.ended;
  // Report where the show is when it changes.
  const status = mode === 'show' && s ? {slide: s.slide, step: s.step, playing: s.playing, ended: !!exitText, transition: t ? `${t.kind}:${t.ready ? 'on' : 'wait'}` : null, blank: r.blank as string | null,
    pointer: r.pointer as string, ink: ((r.ink.get(s.slide) as Stroke[] | undefined) ?? []).length, keepAsk: !!r.keepAsk} : null;
  const statusKey = status ? JSON.stringify(status) : '';
  useEffect(() => { if (status && onStatus && !R.current.done) onStatus(status); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey]);

  return <div ref={root} className={`show-stage${embedded ? ' is-embedded' : ''}`} onPointerDown={onPointerDown} onPointerMove={onMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onContextMenu={onContextMenu}
    style={mode === 'show' && !embedded ? {cursor: r.pointer === 'laser' ? 'none' : r.pointer === 'pen' || r.pointer === 'highlighter' ? 'crosshair' : r.pointer === 'eraser' ? 'cell' : undefined} : undefined} data-show-pointer={mode === 'show' ? r.pointer : undefined}
    data-show-slide={mode === 'show' ? String(slideIndex) : undefined}
    data-show-step={mode === 'show' && s ? String(s.step) : undefined} data-show-playing={mode === 'show' && s ? String(s.playing) : undefined}
    data-show-transition={t ? `${t.kind}:${t.ready ? 'on' : 'wait'}` : undefined} data-show-ended={exitText ? 'true' : undefined} tabIndex={-1}>
    {slide && !exitText ? <div className={`show-slide${painting || mode === 'transition' ? ' is-hidden' : ''}`} style={wrapStyle}>
      {morphing && t ? <>
        <SlideView content={pres} slide={pres.slides[t.oldSlide!]} fx={(id: string) => morphOld?.get(id) ?? {opacity: 1 - backOpacity}} className="show-svg"/>
        <SlideView content={pres} slide={pres.slides[t.newSlide]} fx={(id: string) => morphNew?.get(id) ?? {opacity: backOpacity}} backOpacity={backOpacity} parts="all" className="show-svg is-over"/>
      </> : <SlideView content={pres} slide={slide} anim={frame} fx={fx} className="show-svg"/>}
      {mode === 'show' && !embedded && !morphing ? <InkLayer width={size.width} height={size.height} strokes={[...((r.ink.get(slideIndex) as Stroke[] | undefined) ?? []), ...(r.drawing && r.pointer !== 'eraser' && r.drawingSlide === slideIndex ? [r.drawing as Stroke] : [])]}/> : null}
      {mode === 'show' && !embedded && !morphing ? <MediaLayer key={slideIndex} content={pres} slide={slide} scale={pw / Math.max(size.width, 1)} mode="show"/> : null}
    </div> : null}
    <canvas ref={glass} className={`show-glass${painting ? ' is-on' : ''}`} style={wrapStyle} width={px.w} height={px.h}/>
    {r.blank ? <div className={`show-blank is-${r.blank}`}/> : null}
    {mode === 'show' && r.pointer === 'laser' && r.laserAt && !exitText && !r.keepAsk ? <div className="show-laser" style={{left: r.laserAt.x, top: r.laserAt.y}}>
      <i style={{background: `rgba(${laser.r},${laser.g},${laser.b},.28)`}}/><b style={{background: cssRgb(laser)}}/></div> : null}
    {exitText ? <div className="show-end">{END_TEXT}</div> : null}
    {r.goto ? <div className="show-goto" role="status">{r.goto}</div> : null}
    {rehearsal.current && mode === 'show' && !exitText ? <RehearseClock rh={rehearsal.current} onNext={() => { const x = R.current; if (x.ended) { finish(); return; } x.blank = null; navigate(y => y.next(pres)); }} onChange={force}/> : null}
    {mode === 'show' && !embedded && r.menu && !r.keepAsk ? <PointerMenu at={r.menu} pointer={r.pointer} ink={((r.ink.get(slideIndex) as Stroke[] | undefined) ?? []).length > 0}
      onPointer={choosePointer} onErase={eraseInk} onNext={() => { r.menu = null; navigate(x => x.next(pres)); }} onPrevious={() => { r.menu = null; navigate(x => x.prev(pres)); }}
      onBlank={c => { r.blank = r.blank === c ? null : c; r.menu = null; force(); }} onEnd={() => { r.menu = null; finish(); }}/> : null}
    {r.keepAsk ? <div className="show-keep" role="alertdialog" aria-label="Keep ink annotations"><div>
      <p>Do you want to keep your ink annotations?</p>
      <span><button type="button" data-keep="keep" onClick={() => answerInk(true)}>Keep</button><button type="button" data-keep="discard" onClick={() => answerInk(false)}>Discard</button></span></div></div> : null}
    {toolbarOn ? <div className={`show-toolbar${toolbarActive ? '' : ' is-idle'}`} role="toolbar" aria-label="Slide show">
      <button type="button" aria-label="Previous" onClick={() => navigate(x => x.prev(pres))}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" aria-label="Next" onClick={() => navigate(x => x.next(pres))}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" aria-label="Pen and pointer options" aria-haspopup="menu" aria-expanded={!!r.menu} className={r.pointer !== 'arrow' ? 'is-on' : undefined}
        onClick={() => { R.current.menu = R.current.menu ? null : {x: 14, y: -1}; force(); }}><svg viewBox="0 0 16 16" width="16" height="16"><path d="m10.2 2.8 3 3-6.9 6.9-3.6.6.6-3.6zM9 4l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/></svg></button>
      <button type="button" aria-label="End show" onClick={finish}><svg viewBox="0 0 16 16" width="16" height="16"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
    </div> : null}
  </div>;
}

/** The pen's and highlighter's strokes over the slide, in slide points. */
function InkLayer({width, height, strokes}: {width: number; height: number; strokes: Stroke[]}) {
  if (!strokes.length) return null;
  return <svg className="show-ink" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    {strokes.map((k, i) => <polyline key={i} fill="none" points={k.points.map(q => `${q[0]},${q[1]}`).join(' ')} stroke={cssRgb(k.color)} strokeOpacity={k.highlighter ? 0.45 : 1}
      strokeWidth={k.width} strokeLinecap={k.highlighter ? 'butt' : 'round'} strokeLinejoin="round"/>)}
  </svg>;
}

/** PowerPoint's pointer menu of a running show: Next, Previous, the pointers, Erase All Ink on Slide, the screens and End Show. */
function PointerMenu({at, pointer, ink, onPointer, onErase, onNext, onPrevious, onBlank, onEnd}: {at: {x: number; y: number}; pointer: Pointer; ink: boolean; onPointer: (p: Pointer) => void; onErase: () => void;
  onNext: () => void; onPrevious: () => void; onBlank: (c: 'black' | 'white') => void; onEnd: () => void}) {
  const item = (label: string, on: () => void, extra: {checked?: boolean; disabled?: boolean} = {}) => <button type="button" role="menuitem" key={label} disabled={extra.disabled} onClick={on}
    aria-checked={extra.checked === undefined ? undefined : extra.checked}>{extra.checked ? <i aria-hidden="true">&#10003;</i> : <i aria-hidden="true"/>}{label}</button>;
  const style = at.y < 0 ? {left: at.x, bottom: 58} : {left: at.x, top: at.y};
  return <div className="show-pmenu" role="menu" aria-label="Slide show" style={style}>
    {item('Next', onNext)}{item('Previous', onPrevious)}<hr/>
    {POINTER_ITEMS.map(([p, label]) => item(label, () => onPointer(p), {checked: pointer === p}))}
    {item('Erase All Ink on Slide', onErase, {disabled: !ink})}<hr/>
    {item('Black Screen', () => onBlank('black'))}{item('White Screen', () => onBlank('white'))}<hr/>
    {item('End Show', onEnd)}
  </div>;
}

/** The Recording toolbar of Rehearse Timings: Next, Pause, this slide's time with Repeat, and the show's total. */
function RehearseClock({rh, onNext, onChange}: {rh: {showStart: number; slideStart: number; pausedAt: number | null}; onNext: () => void; onChange: () => void}) {
  const at = rh.pausedAt ?? performance.now();
  const t = (at - rh.slideStart) / 1000, total = (at - rh.showStart) / 1000;
  const mm = (v: number) => String(Math.floor(v / 60)).padStart(2, '0');
  const pause = () => {
    const now = performance.now();
    if (rh.pausedAt === null) rh.pausedAt = now;
    else { const d = now - rh.pausedAt; rh.slideStart += d; rh.showStart += d; rh.pausedAt = null; }
    onChange();
  };
  const repeat = () => { rh.slideStart = rh.pausedAt ?? performance.now(); onChange(); };
  const ic = (d: string) => <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  return <div className="show-rehearse" role="toolbar" aria-label="Recording" style={{position: 'absolute', left: 12, top: 12, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: 'rgba(30,30,34,.88)', color: '#fff', font: '13px system-ui', zIndex: 5}}>
    <button type="button" aria-label="Next" title="Next" onClick={onNext} style={RB}>{ic('M3 8h9m-3.5-4L12.5 8 8.5 12')}</button>
    <button type="button" aria-label={rh.pausedAt === null ? 'Pause Recording' : 'Resume Recording'} title={rh.pausedAt === null ? 'Pause Recording' : 'Resume Recording'} onClick={pause} style={RB}>{rh.pausedAt === null ? ic('M5.5 3.5v9m5-9v9') : ic('M5 3.5 12 8l-7 4.5z')}</button>
    <span role="timer" aria-label="Slide time" style={{minWidth: 62, textAlign: 'center', fontVariantNumeric: 'tabular-nums'}}>{`${mm(t)}:${(t % 60).toFixed(1).padStart(4, '0')}`}</span>
    <button type="button" aria-label="Repeat" title="Repeat (restart this slide's time)" onClick={repeat} style={RB}>{ic('M12.5 8a4.5 4.5 0 1 1-1.4-3.2M12.5 2.5v2.8H9.7')}</button>
    <span style={{marginLeft: 6, paddingLeft: 10, borderLeft: '1px solid rgba(255,255,255,.25)', color: '#c9c9d0', fontVariantNumeric: 'tabular-nums'}} aria-label="Total time">{`Total ${mm(total)}:${String(Math.floor(total % 60)).padStart(2, '0')}`}</span>
  </div>;
}
const RB: React.CSSProperties = {display: 'grid', placeItems: 'center', width: 28, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: '#e8e8ec', cursor: 'pointer'};

void morphPairs; void useState;
