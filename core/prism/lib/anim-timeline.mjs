// A slide's animation sequence: click steps, effect start times and the state of every shape (and
// paragraph) at any moment of the show; the effect curves (easing, entrance / emphasis / exit /
// motion-path evaluation) and motion paths.
// Translated from deckcraft crates/anim/src/{lib,easing,path,effects,timeline}.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins. Every function accepts hostile numbers (NaN, huge or negative times).
//
// Differences from Rust, all representation only: ids are strings (schema 2), a sequence is `null`
// (the main click sequence) or the trigger shape's id, an Rgba is `{r, g, b, a}`.

import {paragraphBuildRoles, ANIMATIONS} from '../formats/pptx-read.mjs';
import {resolveColor} from '../model/style.mjs';
import {builtinColorSchemes} from '../model/theme.mjs';
import {schemeGet, lerp as lerpColor, fromHex, rgb, rgba} from '../model/color.mjs';
import {walk} from '../model/presentation.mjs';
import {defaultPath, presetPath} from './anim-tables.mjs';

export const PARAGRAPH_STAGGER = 0.5;
const MAX_EFFECTS = 100_000;
const MAX_ITERATIONS = 1e6;

const finite = (v, d) => (Number.isFinite(v) ? v : d);
export const clampf = (v, lo, hi, nan) => (Number.isNaN(v) ? nan : Math.min(Math.max(v, lo), hi));

// ---------------------------------------------------------------------------------------------
// AnimState

/** The identity state: shown, nothing applied. */
export const identityState = () => ({visible: true, opacity: 1, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, clip: null, tint: null});
export const hiddenState = () => ({...identityState(), visible: false});
export function isIdentity(s) {
  const d = identityState();
  return s.visible === d.visible && s.opacity === d.opacity && s.offsetX === 0 && s.offsetY === 0 && s.scaleX === 1 && s.scaleY === 1 && s.rotate === 0 && !s.clip && !s.tint;
}
/** Apply `d` on top of `a`: opacities and scales multiply, offsets and rotations add, clips intersect, a tint replaces. */
export function compose(a, d) {
  let clip;
  if (a.clip && d.clip) clip = [Math.max(a.clip[0], d.clip[0]), Math.max(a.clip[1], d.clip[1]), Math.min(a.clip[2], d.clip[2]), Math.min(a.clip[3], d.clip[3])];
  else clip = a.clip ?? d.clip ?? null;
  return {
    visible: a.visible && d.visible, opacity: a.opacity * d.opacity, offsetX: a.offsetX + d.offsetX, offsetY: a.offsetY + d.offsetY,
    scaleX: a.scaleX * d.scaleX, scaleY: a.scaleY * d.scaleY, rotate: a.rotate + d.rotate, clip, tint: d.tint ?? a.tint,
  };
}
/** Replace any non-finite number with its neutral value and clamp opacity and clip. */
export function sanitized(s) {
  const out = {...s};
  out.opacity = clampf(finite(s.opacity, 1), 0, 1, 1);
  out.offsetX = finite(s.offsetX, 0); out.offsetY = finite(s.offsetY, 0);
  out.scaleX = finite(s.scaleX, 1); out.scaleY = finite(s.scaleY, 1);
  out.rotate = finite(s.rotate, 0);
  if (s.clip) {
    const l = clampf(finite(s.clip[0], 0), 0, 1, 0), t = clampf(finite(s.clip[1], 0), 0, 1, 0);
    const r = clampf(finite(s.clip[2], 1), 0, 1, 1), b = clampf(finite(s.clip[3], 1), 0, 1, 1);
    out.clip = [l, t, Math.max(r, l), Math.max(b, t)];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Easing (easing.rs)

/** PowerPoint-style easing: `accel` / `decel` are the fractions of the duration speeding up and slowing down; `bounce` bounces against the end. */
export function ease(pIn, accel, decel, bounce) {
  const p = clampf(pIn, 0, 1, 0);
  let a = clampf(accel, 0, 1, 0), d = clampf(decel, 0, 1, 0);
  if (a + d > 1) { const s = a + d; a /= s; d /= s; }
  const v = 2 / (2 - a - d);
  let y;
  if (a > 0 && p < a) y = (v * p * p) / (2 * a);
  else if (d > 0 && p > 1 - d) { const q = 1 - p; y = 1 - (v * q * q) / (2 * d); }
  else y = (v * a) / 2 + v * (p - a);
  const b = clampf(bounce, 0, 1, 0);
  if (b > 0) {
    const hit = 1 - b;
    if (p < hit) { const q = hit > 0 ? p / hit : 1; y = q * q; }
    else { const s = (p - hit) / b; y = 1 - bounceHops(s) * 0.25; }
  }
  return clampf(y, -1, 2, 0);
}
function bounceHops(sIn) {
  const s = clampf(sIn, 0, 1, 1);
  const hops = 3;
  const k = Math.min(Math.floor(s * hops), hops - 1);
  const local = s * hops - k;
  return 0.5 ** k * Math.sin(local * Math.PI);
}
/** Classic bounce-out: falls to 1 and bounces with decaying height. */
export function bounceOut(pIn) {
  const p = clampf(pIn, 0, 1, 0);
  const n = 7.5625, d = 2.75;
  let y;
  if (p < 1 / d) y = n * p * p;
  else if (p < 2 / d) { const q = p - 1.5 / d; y = n * q * q + 0.75; }
  else if (p < 2.5 / d) { const q = p - 2.25 / d; y = n * q * q + 0.9375; }
  else { const q = p - 2.625 / d; y = n * q * q + 0.984375; }
  return Math.min(y, 1);
}
/** Smooth ease-in-out (cubic smoothstep). */
export function smooth(pIn) { const p = clampf(pIn, 0, 1, 0); return p * p * (3 - 2 * p); }

// ---------------------------------------------------------------------------------------------
// Motion paths (path.rs): `M x y L x y C x1 y1 x2 y2 x y Q x1 y1 x y Z E`, lowercase = relative,
// slide-fraction units relative to the shape's start, evaluated by arc length.

const MAX_TOKENS = 100_000, MAX_POINTS = 20_000, CURVE_STEPS = 16;

function tokenize(s) {
  const cs = [...String(s).slice(0, 1_000_000)];
  const out = [];
  let i = 0;
  const digit = c => c !== undefined && c >= '0' && c <= '9';
  while (i < cs.length && out.length < MAX_TOKENS) {
    const c = cs[i];
    if (/\s/.test(c) || c === ',') { i++; continue; }
    if (digit(c) || c === '.' || c === '-' || c === '+') {
      const start = i;
      i++;
      let seenDot = c === '.';
      while (i < cs.length) {
        const d = cs[i];
        if (digit(d)) i++;
        else if (d === '.' && !seenDot) { seenDot = true; i++; }
        else if ((d === 'e' || d === 'E') && (digit(cs[i + 1]) || ((cs[i + 1] === '-' || cs[i + 1] === '+') && digit(cs[i + 2])))) {
          i += 2;
          while (digit(cs[i])) i++;
          break;
        } else break;
      }
      const v = Number(cs.slice(start, i).join(''));
      out.push(Number.isFinite(v) ? {num: v} : {cmd: '?'});
      continue;
    }
    out.push({cmd: c});
    i++;
  }
  return out;
}

export class MotionPath {
  constructor(points = [], cum = []) { this.points = points; this.cum = cum; }
  /** Parse a path. Malformed input yields the part parsed before the error (possibly empty). */
  static parse(s) {
    const toks = tokenize(s);
    const pts = [];
    let cur = [0, 0], start = [0, 0], cmd = 'M', i = 0;
    const push = p => { if (pts.length < MAX_POINTS) pts.push(p); };
    const num = k => (toks[k] && toks[k].num !== undefined ? toks[k].num : null);
    outer:
    while (i < toks.length) {
      if (toks[i].cmd !== undefined) {
        cmd = toks[i].cmd;
        i++;
        switch (cmd) {
          case 'Z': case 'z': push(start); cur = start; continue;
          case 'E': case 'e': break outer;
          case 'M': case 'm': case 'L': case 'l': case 'C': case 'c': case 'Q': case 'q': case 'H': case 'h': case 'V': case 'v': continue;
          default: break outer;
        }
      }
      const rel = cmd === cmd.toLowerCase();
      const base = rel ? cur : [0, 0];
      const up = cmd.toUpperCase();
      const need = up === 'M' || up === 'L' ? 2 : up === 'C' ? 6 : up === 'Q' ? 4 : up === 'H' || up === 'V' ? 1 : -1;
      if (need < 0) break;
      const v = [0, 0, 0, 0, 0, 0];
      let ok = true;
      for (let k = 0; k < need; k++) { const x = num(i + k); if (x === null) ok = false; else v[k] = x; }
      if (!ok) break;
      i += need;
      switch (up) {
        case 'M': cur = [base[0] + v[0], base[1] + v[1]]; start = cur; push(cur); cmd = rel ? 'l' : 'L'; break;
        case 'L': if (!pts.length) push(cur); cur = [base[0] + v[0], base[1] + v[1]]; push(cur); break;
        case 'H': case 'V':
          if (!pts.length) push(cur);
          cur = up === 'H' ? [base[0] + v[0], cur[1]] : [cur[0], base[1] + v[0]];
          push(cur);
          break;
        case 'C': {
          if (!pts.length) push(cur);
          const p0 = cur, p1 = [base[0] + v[0], base[1] + v[1]], p2 = [base[0] + v[2], base[1] + v[3]], p3 = [base[0] + v[4], base[1] + v[5]];
          for (let k = 1; k <= CURVE_STEPS; k++) {
            const t = k / CURVE_STEPS, u = 1 - t;
            const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
            push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
          }
          cur = p3;
          break;
        }
        case 'Q': {
          if (!pts.length) push(cur);
          const p0 = cur, p1 = [base[0] + v[0], base[1] + v[1]], p2 = [base[0] + v[2], base[1] + v[3]];
          for (let k = 1; k <= CURVE_STEPS; k++) {
            const t = k / CURVE_STEPS, u = 1 - t;
            push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
          }
          cur = p2;
          break;
        }
        default: break outer;
      }
    }
    const kept = pts.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const cum = [];
    let acc = 0, prev = null;
    for (const p of kept) {
      if (prev) { const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]); if (Number.isFinite(d)) acc += d; }
      cum.push(acc);
      prev = p;
    }
    return new MotionPath(kept, cum);
  }
  length() { return this.cum.length ? this.cum[this.cum.length - 1] : 0; }
  /** Position at arc-length fraction `p` (0..1), relative to the path's origin (0, 0). */
  at(pIn) {
    const first = this.points[0] ?? [0, 0];
    const len = this.length();
    if (!(len > 0) || !Number.isFinite(len)) return first;
    const target = clampf(pIn, 0, 1, 0) * len;
    let lo = 0, hi = this.cum.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.cum[m] < target) lo = m + 1; else hi = m; }
    const i = lo;
    if (i === 0) return first;
    if (i >= this.points.length) return this.points[this.points.length - 1] ?? first;
    const a = this.points[i - 1], b = this.points[i], ca = this.cum[i - 1], cb = this.cum[i];
    const seg = cb - ca;
    const f = seg > 0 ? (target - ca) / seg : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
}

// ---------------------------------------------------------------------------------------------
// Effects (effects.rs)

/** Map an exit effect id to the entrance effect it mirrors. */
export function exitBase(effect) {
  return ({disappear: 'appear', fadeOut: 'fade', flyOut: 'fly', floatOut: 'float', splitOut: 'split', wipeOut: 'wipe', shapeOut: 'shape', wheelOut: 'wheel',
    randomBarsOut: 'randomBars', shrinkTurn: 'grow', zoomOut: 'zoom', swivelOut: 'swivel', bounceOut: 'bounce', dissolveOut: 'dissolve', blindsOut: 'blinds',
    boxOut: 'box', checkerboardOut: 'checkerboard', diamondOut: 'diamond', peekOut: 'peek', stripsOut: 'strips', sinkDown: 'rise', spinnerOut: 'spinner',
    contract: 'expand'})[effect] ?? effect;
}
const PERSISTS = new Set(['spin', 'growShrink', 'desaturate', 'darken', 'lighten', 'transparency', 'objectColor', 'complementaryColor', 'lineColor', 'fillColor', 'fontColor']);
export const emphasisPersists = effect => PERSISTS.has(effect);
const DEFAULT_SMOOTH = new Set(['fly', 'float', 'rise', 'peek', 'lines', 'arcs', 'turns', 'shapes', 'loops', 'customPath']);
const usesDefaultSmoothing = effect => DEFAULT_SMOOTH.has(effect) || presetPath(effect) !== null;

/** The path for a motion-path animation: its own, or the preset default. */
export function motionPath(effect, option, own) {
  return MotionPath.parse(typeof own === 'string' && own.trim() ? own : defaultPath(effect, option));
}

export class EffectSpec {
  constructor(f) { Object.assign(this, f); }
  eased(p) {
    if (this.accel <= 0 && this.decel <= 0 && this.bounce <= 0 && usesDefaultSmoothing(this.effect)) return smooth(p);
    return ease(p, this.accel, this.decel, this.bounce);
  }
  /** The state delta at linear progress `p` (0..1) while the effect plays; `cur` is the shape's current fill colour. */
  evalAt(pIn, cur) {
    const p = clampf(pIn, 0, 1, 0);
    let s;
    switch (this.class) {
      case 'entrance': s = this.entrance(p, false); break;
      case 'exit': s = this.entrance(1 - p, true); break;
      case 'emphasis': s = this.emphasis(p, cur); break;
      case 'path': s = this.motion(p); break;
      default: s = identityState();
    }
    return sanitized(s);
  }
  /** The state the effect leaves behind once done. */
  endState(cur) {
    switch (this.class) {
      case 'exit': return hiddenState();
      case 'emphasis': return emphasisPersists(this.effect) ? sanitized(this.emphasis(1, cur)) : identityState();
      case 'path': return sanitized(this.motion(1));
      default: return identityState();
    }
  }
  entrance(p, exit) {
    const e = this.eased(p), q = 1 - e;
    const o = this.option ?? '';
    const {x, y, w, h} = this.xf;
    const sw = this.slideW, sh = this.slideH;
    const st = identityState();
    const centerClip = (fIn, horz, vert) => {
      const f = Math.min(Math.max(fIn, 0), 1) / 2;
      return [horz ? 0.5 - f : 0, vert ? 0.5 - f : 0, horz ? 0.5 + f : 1, vert ? 0.5 + f : 1];
    };
    switch (this.effect) {
      case 'appear': st.visible = p > 0; break;
      case 'fade': case 'dissolve': case 'randomBars': case 'blinds': case 'checkerboard': case 'wheel': st.opacity = e; break;
      case 'fly': {
        const oo = o === '' ? 'b' : o;
        if (oo.includes('l')) st.offsetX = -(x + w) * q;
        if (oo.includes('r')) st.offsetX = (sw - x) * q;
        if (oo.includes('t')) st.offsetY = -(y + h) * q;
        if (oo.includes('b')) st.offsetY = (sh - y) * q;
        break;
      }
      case 'float': case 'rise': {
        const down = o === 'd';
        let dir = down ? -1 : 1;
        if (exit) dir = -dir;
        st.offsetY = dir * 0.1 * sh * q;
        st.opacity = e;
        break;
      }
      case 'split': {
        const horz = o.startsWith('horz');
        st.clip = horz ? centerClip(e, false, true) : centerClip(e, true, false);
        if (o.endsWith('In')) st.opacity = e;
        break;
      }
      case 'wipe': st.clip = o === 'l' ? [0, 0, e, 1] : o === 't' ? [0, 0, 1, e] : o === 'r' ? [1 - e, 0, 1, 1] : [0, 1 - e, 1, 1]; break;
      case 'shape': case 'circle': case 'box': case 'diamond': case 'expandClip': {
        const round = this.effect === 'circle' || this.effect === 'diamond' || o.startsWith('circle') || o.startsWith('diamond') || o.startsWith('plus');
        const f = round ? Math.min(e * Math.SQRT2, 1) : e;
        st.clip = centerClip(f, true, true);
        if (o.endsWith('In') || o === 'in') st.opacity = e;
        break;
      }
      case 'grow': st.scaleX = e; st.scaleY = e; st.rotate = -90 * q; st.opacity = e; break;
      case 'zoom': { const s = o === 'out' ? 1 + 3 * q : e; st.scaleX = s; st.scaleY = s; st.opacity = e; break; }
      case 'swivel': {
        const s = e * Math.cos(q * 2.5 * Math.PI);
        if (o === 'vert') st.scaleY = s; else st.scaleX = s;
        st.opacity = Math.min(e, 1);
        break;
      }
      case 'bounce': {
        const b = bounceOut(p);
        st.offsetY = -(0.25 * sh) * (1 - b);
        st.offsetX = -0.1 * sw * (1 - p);
        st.opacity = Math.min(p * 4, 1);
        break;
      }
      case 'peek':
        if (o === 'l') { st.offsetX = -w * q; st.clip = [q, 0, 1, 1]; }
        else if (o === 'r') { st.offsetX = w * q; st.clip = [0, 0, e, 1]; }
        else if (o === 't') { st.offsetY = -h * q; st.clip = [0, q, 1, 1]; }
        else { st.offsetY = h * q; st.clip = [0, 0, 1, e]; }
        break;
      case 'strips': st.clip = o === 'ru' ? [0, q, e, 1] : o === 'ld' ? [q, 0, 1, e] : o === 'rd' ? [0, 0, e, e] : [q, q, 1, 1]; break;
      case 'expand': st.scaleX = 0.3 + 0.7 * e; st.opacity = e; break;
      case 'spinner': st.rotate = 360 * q; st.scaleX = 0.5 + 0.5 * e; st.scaleY = 0.5 + 0.5 * e; st.opacity = e; break;
      default: st.opacity = e;
    }
    return st;
  }
  emphasis(p, cur) {
    const e = this.eased(p);
    const bump = Math.sin(p * Math.PI);
    const st = identityState();
    const target = this.color ?? rgb(0xc0, 0, 0);
    switch (this.effect) {
      case 'pulse': st.scaleX = 1 + 0.1 * bump; st.scaleY = st.scaleX; break;
      case 'colorPulse': st.tint = lerpColor(cur, target, bump); break;
      case 'teeter': st.rotate = 8 * Math.sin(p * 4 * Math.PI) * (1 - p * 0.5); break;
      case 'spin': {
        const amt = Math.min(Math.max(Number.isFinite(this.amount) ? this.amount : 360, -36000), 36000);
        st.rotate = (this.option === 'counterClockwise' ? -1 : 1) * amt * e;
        break;
      }
      case 'growShrink': {
        const amt = Math.min(Math.max(Number.isFinite(this.amount) && this.amount > 0 ? this.amount : 1.5, 0), 100);
        const s = 1 + (amt - 1) * e;
        if (this.option === 'horz') st.scaleX = s;
        else if (this.option === 'vert') st.scaleY = s;
        else { st.scaleX = s; st.scaleY = s; }
        break;
      }
      case 'desaturate': {
        const l = Math.min(Math.max(Math.round(0.299 * cur.r + 0.587 * cur.g + 0.114 * cur.b), 0), 255);
        st.tint = lerpColor(cur, rgba(l, l, l, cur.a), e);
        break;
      }
      case 'darken': st.tint = lerpColor(cur, rgba(0, 0, 0, cur.a), 0.4 * e); break;
      case 'lighten': st.tint = lerpColor(cur, rgba(255, 255, 255, cur.a), 0.4 * e); break;
      case 'transparency': {
        const a = Math.min(Math.max(Number.isFinite(this.amount) ? this.amount : 0.5, 0), 1);
        st.opacity = 1 - a * e;
        break;
      }
      case 'objectColor': case 'fillColor': case 'lineColor': case 'fontColor': st.tint = lerpColor(cur, target, e); break;
      case 'complementaryColor': st.tint = lerpColor(cur, rgba(255 - cur.r, 255 - cur.g, 255 - cur.b, cur.a), e); break;
      case 'underline': case 'boldFlash':
        st.scaleX = 1 + 0.04 * bump; st.scaleY = st.scaleX;
        if (this.effect === 'boldFlash') st.tint = lerpColor(cur, rgba(0, 0, 0, cur.a), 0.3 * bump);
        break;
      case 'wave': st.offsetY = -0.02 * this.slideH * bump; st.scaleY = 1 + 0.05 * bump; break;
      default: break;
    }
    return st;
  }
  motion(p) {
    const e = this.eased(p);
    const [fx, fy] = this.path ? this.path.at(e) : [0, 0];
    return {...identityState(), offsetX: fx * this.slideW, offsetY: fy * this.slideH};
  }
}

// ---------------------------------------------------------------------------------------------
// Timeline (timeline.rs)

const secs = ms => ms / 1000;
function sanitizeXfrm(x, sw, sh) {
  const c = (v, lo, hi, d) => Math.min(Math.max(finite(v, d), lo), hi);
  return {...x, x: c(x.x, -1e7, 1e7, 0), y: c(x.y, -1e7, 1e7, 0), w: c(x.w, 0, 1e7, sw / 2), h: c(x.h, 0, 1e7, sh / 2)};
}
function shapeIndex(shapes) {
  const out = new Map();
  walk(shapes, s => { if (!out.has(s.id)) out.set(s.id, s); });
  return out;
}
const defaultScheme = () => builtinColorSchemes()[0] ?? null;

function buildSpec(a, xf, sw, sh, resolve) {
  return new EffectSpec({
    class: a.class,
    effect: a.class === 'exit' ? exitBase(a.effect) : a.effect,
    option: a.effect === 'sinkDown' ? 'd' : a.option ?? '',
    accel: a.smoothStart ?? 0, decel: a.smoothEnd ?? 0, bounce: a.bounceEnd ?? 0,
    amount: a.amount ?? null,
    color: a.color ? resolve(a.color) : null,
    path: a.class === 'path' ? motionPath(a.effect, a.option ?? '', a.path) : null,
    xf, slideW: sw, slideH: sh,
  });
}

export class Timeline {
  constructor() {
    /** Every effect: {timing, spec, after}. */
    this.effects = [];
    this.main = [];
    /** [triggerShapeId, steps[]] in order of first appearance. */
    this.triggers = [];
    this.colors = new Map();
    /** By-paragraph builds animate first-level paragraphs; deeper ones follow their parent: [shape, member, owner]. */
    this.groups = [];
  }

  /**
   * Build the timeline of `slide` (slide size in points). Options: `scheme` (a colour scheme for
   * theme colours), `xfrmOf(id)` (placeholders inherit their box from the layout; the lookup wins
   * over `shape.xfrm`), `resolve(colorRef)` (overrides the scheme).
   */
  static of(slide, slideW, slideH, {scheme, xfrmOf, resolve: res} = {}) {
    const sw = Math.min(Math.max(finite(slideW, 960), 1), 1e7), sh = Math.min(Math.max(finite(slideH, 540), 1), 1e7);
    const sc = scheme ?? defaultScheme();
    const resolve = res ?? (c => (sc ? resolveColor(c, sc.colors ? sc : {colors: sc}, null) : c?.base?.kind === 'rgb' ? c.base.rgb : rgb(0x15, 0x60, 0x82)));
    const accent = sc ? schemeGet(sc, 'accent1') : rgb(0x15, 0x60, 0x82);
    const tl = new Timeline();
    const anims = slide?.animations ?? [];
    if (!anims.length) return tl;
    const shapes = shapeIndex(slide.shapes);
    const paraCache = new Map();
    const seqs = [{seq: null, members: []}];
    const seqIndex = new Map([['', 0]]);
    anims.forEach((a, ai) => {
      const key = a.trigger != null ? `t:${a.trigger}` : '';
      let i = seqIndex.get(key);
      if (i === undefined) { seqs.push({seq: a.trigger, members: []}); i = seqs.length - 1; seqIndex.set(key, i); }
      seqs[i].members.push(ai);
    });
    const grouped = new Set();
    for (const {seq, members} of seqs) {
      if (tl.effects.length >= MAX_EFFECTS) break;
      const steps = [];
      let groupBegin = 0, maxEnd = 0;
      for (const ai of members) {
        const a = anims[ai];
        if (!a) continue;
        if (tl.effects.length >= MAX_EFFECTS) break;
        const shape = shapes.get(a.shape);
        let paras;
        if (a.paragraph != null) paras = [a.paragraph];
        else if (a.textBuild === 'byParagraph') {
          if (!paraCache.has(a.shape)) {
            const v = [];
            if (shape?.text) {
              paragraphBuildRoles(shape.text).forEach((role, i) => {
                if (role.top) v.push(i);
                else if (role.member !== undefined) {
                  const k = `${a.shape}|${i}|${role.member}`;
                  if (!grouped.has(k)) { grouped.add(k); tl.groups.push([a.shape, i, role.member]); }
                }
              });
            }
            if (!v.length) v.push(null);
            paraCache.set(a.shape, v);
          }
          paras = paraCache.get(a.shape);
        } else paras = [null];
        const xf0 = xfrmOf?.(a.shape) ?? shape?.xfrm ?? {x: sw / 4, y: sh / 4, w: sw / 2, h: sh / 2};
        const xf = sanitizeXfrm(xf0, sw, sh);
        const spec = buildSpec(a, xf, sw, sh, resolve);
        const dur = secs(a.durationMs ?? 0), delay = secs(a.delayMs ?? 0);
        const untilNextClick = a.repeat === 0xffffffff;
        const iterations = untilNextClick || (a.repeat ?? 1) <= 1 ? 1 : Math.min(a.repeat, MAX_ITERATIONS);
        const span = dur * (a.autoReverse ? 2 : 1) * iterations;
        let after = {kind: 'none'};
        if (a.after === 'hide') after = {kind: 'hide'};
        else if (a.after === 'hideOnNextClick') after = {kind: 'hideOnNextClick'};
        else if (typeof a.after === 'string') { const c = fromHex(a.after); if (c) after = {kind: 'dim', color: c}; }
        let firstStart = 0;
        paras.forEach((para, k) => {
          let mode = k === 0 ? a.start : a.start === 'onClick' ? 'onClick' : 'withPrevious';
          const firstOfSeq = steps.length === 0;
          if (firstOfSeq && seq !== null) mode = 'onClick';
          if (mode === 'onClick') { steps.push({auto: false, duration: 0}); groupBegin = 0; maxEnd = 0; }
          else if (mode === 'withPrevious') { if (firstOfSeq) steps.push({auto: true, duration: 0}); }
          else { if (firstOfSeq) steps.push({auto: true, duration: 0}); groupBegin = maxEnd; }
          const start = k > 0 && a.start !== 'onClick' ? firstStart + k * PARAGRAPH_STAGGER : groupBegin + delay;
          if (k === 0) firstStart = start;
          const end = start + span;
          maxEnd = Math.max(maxEnd, end);
          const step = Math.max(steps.length - 1, 0);
          const last = steps[steps.length - 1];
          if (last) last.duration = Math.max(last.duration, a.class === 'media' ? start : end);
          tl.effects.push({
            timing: {anim: ai, shape: a.shape, paragraph: para, sequence: seq, step, start, duration: dur, iterations, untilNextClick, autoReverse: !!a.autoReverse,
              rewind: !!a.rewind, span, class: a.class},
            spec, after,
          });
        });
      }
      if (seq === null) tl.main = steps; else tl.triggers.push([seq, steps]);
    }
    const colored = new Set();
    for (const e of tl.effects) {
      const id = e.timing.shape;
      if (colored.has(id)) continue;
      colored.add(id);
      const f = shapes.get(id)?.fill;
      tl.colors.set(id, f && f.kind === 'solid' ? resolve(f.color) : accent);
    }
    return tl;
  }

  /** Number of steps in the main sequence (clicks, plus an automatic first step when the first effect starts with/after previous). */
  steps() { return this.main.length; }
  stepIsAuto(i) { return !!this.main[i]?.auto; }
  stepDuration(i) { return this.main[i]?.duration ?? 0; }
  /** Media effects (Play, Pause, Stop) of main step `step` that start after `from` and by `to` seconds into it, in order. */
  mediaCues(step, from, to) {
    return this.effects.map(e => e.timing).filter(e => e.class === 'media' && e.sequence === null && e.step === step && e.start > from && e.start <= to)
      .sort((a, b) => a.start - b.start);
  }
  totalDuration() { return this.main.reduce((n, s) => n + s.duration, 0); }
  /** Map a time on the "play everything" clock to `[step, t]` for `state`. */
  locate(time) {
    let t = Math.max(finite(time, 0), 0);
    for (let i = 0; i < this.main.length; i++) {
      const s = this.main[i];
      if (t < s.duration || (t === 0 && s.duration === 0 && i === 0)) return [i, t];
      t -= s.duration;
    }
    return [this.main.length, 0];
  }
  /** Where effect `anim` (index into `slide.animations`) starts on the play-everything clock; null for a triggered effect or one not on the slide. */
  startOf(anim) {
    let best = null;
    for (const e of this.effects) {
      const t = e.timing;
      if (t.anim !== anim || t.sequence !== null) continue;
      if (!best || t.step < best.step || (t.step === best.step && t.start < best.start)) best = t;
    }
    if (!best) return null;
    let before = 0;
    for (let i = 0; i < best.step; i++) before += this.main[i]?.duration ?? 0;
    return before + best.start;
  }
  triggerShapes() { return this.triggers.map(([s]) => s); }
  triggerSteps(trigger) { return this.triggers.find(([s]) => s === trigger)?.[1].length ?? 0; }
  triggerStepDuration(trigger, i) { return this.triggers.find(([s]) => s === trigger)?.[1][i]?.duration ?? 0; }
  /** All effect timings in sequence order. */
  timings() { return this.effects.map(e => e.timing); }
  isEmpty() { return this.effects.length === 0; }
  /** Paragraph indices of `shape` animated separately (by-paragraph builds). */
  paragraphTargets(shape) {
    const v = this.effects.filter(e => e.timing.shape === shape).map(e => e.timing.paragraph).filter(p => p !== null && p !== undefined);
    const extra = this.groups.filter(g => g[0] === shape && v.includes(g[2])).map(g => g[1]);
    return [...new Set([...v, ...extra])].sort((a, b) => a - b);
  }
  animatedShapes() { return [...new Set(this.effects.map(e => e.timing.shape))]; }

  /** State of `shape` (or of its paragraph `para`) when `step` main steps are fully played and step `step` has played for `t` seconds. */
  state(shape, para, step, t) { return this.stateOrdered(shape, para, step, t, [], []); }
  stateWith(shape, para, step, t, triggers) { return this.stateOrdered(shape, para, step, t, triggers, []); }
  /**
   * `stateWith` applying the effects of triggered sequences in the order their steps were started
   * (`stamps`: {trigger, step, at}), after those of the main sequence. `triggers`: {trigger, step, t}.
   */
  stateOrdered(shape, pararaw, step, t, triggers, stamps) {
    const para = pararaw === null || pararaw === undefined ? null : (this.groups.find(g => g[0] === shape && g[1] === pararaw)?.[2] ?? pararaw);
    const baseColor = this.colors.get(shape) ?? rgb(0x15, 0x60, 0x82);
    let st = identityState();
    const ordered = this.effects.filter(e => e.timing.shape === shape && (e.timing.paragraph ?? null) === para).sort((a, b) => a.timing.anim - b.timing.anim);
    if (ordered[0] && ordered[0].timing.class === 'entrance') st.visible = false;
    if (stamps.length) {
      const when = e => {
        if (e.timing.sequence === null) return 0;
        const s = stamps.find(x => x.trigger === e.timing.sequence && x.step === e.timing.step);
        return s ? s.at + 1 : Infinity;
      };
      ordered.sort((a, b) => (when(a) === when(b) ? a.timing.anim - b.timing.anim : when(a) < when(b) ? -1 : 1));
    }
    for (const e of ordered) {
      let pstep, pt;
      if (e.timing.sequence === null) { pstep = step; pt = t; }
      else { const p = triggers.find(x => x.trigger === e.timing.sequence); pstep = p ? p.step : 0; pt = p ? p.t : 0; }
      const cur = st.tint ?? baseColor;
      const revert = e.timing.rewind || e.timing.autoReverse;
      const status = statusOf(e.timing, pstep, pt);
      if (status.kind === 'active') {
        if (e.timing.class === 'entrance' || e.timing.class === 'exit') st.visible = true;
        st = compose(st, e.spec.evalAt(status.p, cur));
      } else if (status.kind === 'done') {
        const cls = e.timing.class;
        if (cls === 'entrance') st.visible = !revert;
        else if (cls === 'exit') st.visible = revert;
        else if ((cls === 'emphasis' || cls === 'path') && !revert) st = compose(st, e.spec.endState(cur));
        const af = e.after;
        if (af.kind === 'hide') st.visible = false;
        else if (af.kind === 'hideOnNextClick' && pstep > e.timing.step) st.visible = false;
        else if (af.kind === 'dim' && pstep > e.timing.step) st.tint = af.color;
      }
    }
    return sanitized(st);
  }
  /** State on the "play everything" clock (Animation Pane ▸ Play All, preview). */
  stateAt(shape, para, time) { const [s, t] = this.locate(time); return this.state(shape, para, s, t); }
}

function statusOf(e, step, tIn) {
  if (e.step < step) return {kind: 'done'};
  if (e.step > step) return {kind: 'notStarted'};
  const t = finite(tIn, 0);
  if (t <= 0) return {kind: 'notStarted'};
  const local = t - e.start;
  if (local < 0) return {kind: 'notStarted'};
  const dur = e.duration;
  if (Number.isNaN(dur) || dur <= 0 || !Number.isFinite(dur)) return {kind: 'done'};
  if (!e.untilNextClick && local >= e.span) return {kind: 'done'};
  const period = e.autoReverse ? 2 * dur : dur;
  let c = local % period;
  if (!Number.isFinite(c)) c = 0;
  const p = c > dur ? 2 - c / dur : c / dur;
  return {kind: 'active', p: Math.min(Math.max(p, 0), 1)};
}

/** The effects the Timeline knows by id (for the pane's bars: the table row of an animation). */
export const animationRow = (effect, cls) => ANIMATIONS.find(a => a[0] === effect && a[2] === cls) ?? ANIMATIONS.find(a => a[0] === effect) ?? null;
