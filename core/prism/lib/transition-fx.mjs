// Slide transitions as layers of textured quads: a frame is drawn over black, each layer maps part
// of a source image (old slide, new slide, their backgrounds or contents alone, or a solid colour)
// onto a quad in slide-unit space (0..1, y down), with an opacity per corner. Perspective comes
// from projecting 3-D cards (`layerMesh` keeps their textures straight); soft edges come from
// per-corner opacity ramps; wedges are triangles (the 4th corner repeats the 3rd).
// Translated from deckcraft crates/anim/src/{transition,transition_geom,transition_fx,mesh}.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.
//
// The motions, curves, directions and option meanings were measured frame by frame on
// PowerPoint's video export of synthetic decks (upstream tools/synth_transitions.ps1). `t` is
// linear progress (0..1) through the transition's duration; each effect applies its own curve.
// Directions follow the file format's option: for Push, Wipe, Cover, Uncover, Pan, Vortex, Cube…
// `dir` is where things move (`l`: toward the left); for Glitter it is the side the effect starts
// from; Ripple's corner is where the wave heads.

import {ease, smooth, clampf} from './anim-timeline.mjs';
import {TRANSITIONS} from '../formats/pptx-read.mjs';

const PI = Math.PI;
export const DEFAULT_ASPECT = 16 / 9;
export const FULL = [0, 0, 1, 1];

/** Sources a layer can show. */
export const SOURCES = Object.freeze(['old', 'new', 'black', 'white', 'oldBack', 'newBack', 'oldContent', 'newContent']);
const isPartSource = s => s === 'oldBack' || s === 'newBack' || s === 'oldContent' || s === 'newContent';
/** The whole-slide source to draw instead when the parts aren't available: a background becomes its slide, content becomes nothing. */
export const wholeSource = s => (s === 'oldBack' ? 'old' : s === 'newBack' ? 'new' : s === 'oldContent' || s === 'newContent' ? null : s);
export {isPartSource};

const OLD = 'old', NEW = 'new', BLACK = 'black', WHITE = 'white', OLD_BACK = 'oldBack', NEW_BACK = 'newBack', OLD_CONTENT = 'oldContent', NEW_CONTENT = 'newContent';

// ---------------------------------------------------------------------------------------------
// Layers

export const corners = r => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
const ones = () => [1, 1, 1, 1];
/** `src` rectangle of the source drawn into the `dst` rectangle. */
export const layerRect = (source, src, dst, alpha) => ({source, src, quad: corners(dst), uv: corners(src), alpha, fade: ones()});
export const layerFull = (source, alpha) => layerRect(source, FULL, FULL, alpha);
/** `src` rectangle of the source drawn onto a quad. */
export const layerQuad = (source, src, quad, alpha) => ({source, src, quad, uv: corners(src), alpha, fade: ones()});
/** The part of the source under `dst` drawn in place. */
const inplace = (source, dst, alpha) => layerRect(source, dst, dst, alpha);
/** A triangle with its own texture coordinates and corner opacities. */
function triUv(source, p, uv, fade, alpha) {
  const xs = uv.map(u => u[0]), ys = uv.map(u => u[1]);
  return {source, src: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], quad: [p[0], p[1], p[2], p[2]], uv: [uv[0], uv[1], uv[2], uv[2]], alpha,
    fade: [fade[0], fade[1], fade[2], fade[2]]};
}
const faded = (l, fade) => ({...l, fade});
/** A black copy of this layer's shape at `k` of its opacity: shading a card. */
const shade = (l, k) => ({...l, source: BLACK, alpha: l.alpha * Math.min(Math.max(k, 0), 1)});

function sanitizeLayer(l) {
  const f = v => (Number.isFinite(v) ? Math.min(Math.max(v, -1e6), 1e6) : 0);
  return {
    source: l.source,
    src: l.src.map(v => Math.min(Math.max(f(v), 0), 1)),
    quad: l.quad.map(c => [f(c[0]), f(c[1])]),
    uv: l.uv.map(c => [Math.min(Math.max(f(c[0]), 0), 1), Math.min(Math.max(f(c[1]), 0), 1)]),
    alpha: clampf(l.alpha, 0, 1, 0),
    fade: l.fade.map(a => clampf(a, 0, 1, 0)),
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers (transition_geom.rs)

const ss = smooth;
const q2 = x => ease(x, 0.5, 0.5, 0);
const powInout = (xIn, n) => { const x = Math.min(Math.max(xIn, 0), 1); return x < 0.5 ? 0.5 * (2 * x) ** n : 1 - 0.5 * (2 - 2 * x) ** n; };
const ein = xIn => { const x = Math.min(Math.max(xIn, 0), 1); return x * x; };
const eout = xIn => { const x = 1 - Math.min(Math.max(xIn, 0), 1); return 1 - x * x; };
/** Progress through the window [a, b] of t, clamped to 0..1. */
const win = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : Math.min(Math.max((t - a) / (b - a), 0), 1));

const M64 = (1n << 64n) - 1n;
export function hash64(x0) {
  let x = (BigInt.asUintN(64, BigInt(x0)) + 0x9e3779b97f4a7c15n) & M64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & M64;
  return x ^ (x >> 31n);
}
const rndCache = new Map();
/** Deterministic pseudo-random value in [0, 1). */
export function rnd(i) {
  let v = rndCache.get(i);
  if (v === undefined) {
    v = Number(hash64(i) >> 11n) / 2 ** 53;
    if (rndCache.size > 200_000) rndCache.clear();
    rndCache.set(i, v);
  }
  return v;
}

const offsetRect = (r, dx, dy) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
const center = r => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const scaleRectAbout = (r, s, c) => [c[0] + (r[0] - c[0]) * s, c[1] + (r[1] - c[1]) * s, c[0] + (r[2] - c[0]) * s, c[1] + (r[3] - c[1]) * s];
const scaleRect = (r, s) => scaleRectAbout(r, s, center(r));
/** The whole source moved by (dx, dy). */
const moved = (source, dx, dy, alpha) => layerRect(source, FULL, offsetRect(FULL, dx, dy), alpha);
/** The whole source scaled by `s` about (cx, cy) and moved. */
const scaled = (source, s, cx, cy, dx, dy, alpha) => layerRect(source, FULL, offsetRect(scaleRectAbout(FULL, s, [cx, cy]), dx, dy), alpha);
/** Rotate a point about a pivot by `deg` (clockwise on screen), in a slide `a` wide per unit of height. */
function rot(p, c, deg, a) {
  const r = (deg * PI) / 180, s = Math.sin(r), co = Math.cos(r);
  const x = (p[0] - c[0]) * a, y = p[1] - c[1];
  return [c[0] + (x * co - y * s) / a, c[1] + x * s + y * co];
}
const rotQuad = (q, c, deg, a) => q.map(p => rot(p, c, deg, a));
/** Motion direction of an option: l, r, u, d and diagonals. */
function dir(opt, def) {
  const d = [0, 0];
  if (opt.includes('l')) d[0] = -1;
  if (opt.includes('r')) d[0] = 1;
  if (opt.includes('u')) d[1] = -1;
  if (opt.includes('d')) d[1] = 1;
  return d[0] === 0 && d[1] === 0 ? def : d;
}

/** A rectangle with a soft border `f` wide (slide units) fading out to nothing. */
function softRect(source, src, dst, f, alpha) {
  const v = [layerRect(source, src, dst, alpha)];
  if (f <= 1e-6) return v;
  const [l, t, r, b] = dst;
  const fx = f, fy = (f * 16) / 9;
  const uvAt = (x, y) => [r > l ? src[0] + ((Math.min(Math.max(x, l), r) - l) / (r - l)) * (src[2] - src[0]) : src[0],
    b > t ? src[1] + ((Math.min(Math.max(y, t), b) - t) / (b - t)) * (src[3] - src[1]) : src[1]];
  const q = (pts, fade) => {
    const uv = pts.map(p => uvAt(p[0], p[1]));
    const xs = uv.map(p => p[0]), ys = uv.map(p => p[1]);
    v.push({source, src: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], quad: pts, uv, alpha, fade});
  };
  q([[l, t - fy], [r, t - fy], [r, t], [l, t]], [0, 0, 1, 1]);
  q([[l, b], [r, b], [r, b + fy], [l, b + fy]], [1, 1, 0, 0]);
  q([[l - fx, t], [l, t], [l, b], [l - fx, b]], [0, 1, 1, 0]);
  q([[r, t], [r + fx, t], [r + fx, b], [r, b]], [1, 0, 0, 1]);
  q([[l - fx, t - fy], [l, t - fy], [l, t], [l - fx, t]], [0, 0, 1, 0]);
  q([[r, t - fy], [r + fx, t - fy], [r + fx, t], [r, t]], [0, 0, 0, 1]);
  q([[r, b], [r + fx, b], [r + fx, b + fy], [r, b + fy]], [1, 0, 0, 0]);
  q([[l - fx, b], [l, b], [l, b + fy], [l - fx, b + fy]], [0, 1, 0, 0]);
  return v;
}

/** The source shown in place through an opacity field `f(x, y)` (0..1) sampled on an `n` × `m` grid; fully opaque runs of cells merge. */
function field(source, nIn, mIn, f) {
  const n = Math.min(Math.max(nIn, 1), 256), m = Math.min(Math.max(mIn, 1), 256);
  const vals = new Float64Array((n + 1) * (m + 1));
  for (let j = 0; j <= m; j++) for (let i = 0; i <= n; i++) { const v = f(i / n, j / m); vals[j * (n + 1) + i] = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0; }
  const at = (i, j) => vals[j * (n + 1) + i] ?? 0;
  const out = [];
  for (let j = 0; j < m; j++) {
    const y0 = j / m, y1 = (j + 1) / m;
    let run = null;
    for (let i = 0; i <= n; i++) {
      const full = i < n && at(i, j) >= 1 && at(i + 1, j) >= 1 && at(i, j + 1) >= 1 && at(i + 1, j + 1) >= 1;
      if (full) { if (run === null) run = i; continue; }
      if (run !== null) { out.push(inplace(source, [run / n, y0, i / n, y1], 1)); run = null; }
      if (i === n) break;
      const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (c.every(v => v <= 0)) continue;
      out.push(faded(inplace(source, [i / n, y0, (i + 1) / n, y1], 1), c));
    }
  }
  return out;
}
/** Opacity of a soft edge at position `p` when the edge's middle is at `c` and it ramps over `w`. */
const edge = (c, p, w) => (w <= 1e-9 ? (p <= c ? 1 : 0) : Math.min(Math.max((c - p) / w + 0.5, 0), 1));
/** Point on the unit square's boundary seen from its centre at angle `ang` (radians, clockwise from 12 o'clock). */
function boundary(ang, a) {
  const dx = Math.sin(ang) / a, dy = -Math.cos(ang);
  const m = Math.max(Math.abs(dx) / 0.5, Math.abs(dy) / 0.5, 1e-9);
  return [0.5 + dx / m, 0.5 + dy / m];
}
/** The source shown in place through an angular opacity field `f(angle)`: a fan of thin wedges from the centre. */
function fan(source, a, steps, f) {
  const n = Math.min(Math.max(steps, 8), 720);
  const angles = Array.from({length: n + 1}, (_, k) => (2 * PI * k) / n);
  for (const c of [[1, 0], [1, 1], [0, 1], [0, 0]]) {
    const ang = Math.atan2((c[0] - 0.5) * a, -(c[1] - 0.5));
    angles.push(((ang % (2 * PI)) + 2 * PI) % (2 * PI));
  }
  angles.sort((x, y) => x - y);
  const uniq = angles.filter((x, i) => i === 0 || Math.abs(x - angles[i - 1]) >= 1e-9);
  const out = [];
  const c = [0.5, 0.5];
  for (let i = 0; i + 1 < uniq.length; i++) {
    const x = uniq[i], y = uniq[i + 1];
    const fx = Math.min(Math.max(f(x), 0), 1), fy = Math.min(Math.max(f(y), 0), 1);
    if (fx <= 0 && fy <= 0) continue;
    const bx = boundary(x, a), by = boundary(y, a);
    out.push(triUv(source, [c, bx, by], [c, bx, by], [(fx + fy) / 2, fx, fy], 1));
  }
  return out;
}

/** Keep the part of a convex polygon where `n · p <= d`. */
function clipPoly(poly, n, d) {
  const out = [];
  const side = p => n[0] * p[0] + n[1] * p[1] - d;
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) { const k = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]); }
  });
  return out;
}
/** A convex polygon as triangles: vertices drawn at `map(p)` with texture coordinate `p`. */
function polyLayers(source, poly, alpha, map) {
  if (!poly.length) return [];
  const first = poly[0];
  const out = [];
  for (let i = 1; i + 1 < poly.length; i++) out.push(triUv(source, [map(first), map(poly[i]), map(poly[i + 1])], [first, poly[i], poly[i + 1]], [1, 1, 1], alpha));
  return out;
}
const rectPoly = r => corners(r);

// ---- 3-D -------------------------------------------------------------------------------------

const v3 = (x, y, z) => ({x, y, z});
const vadd = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const vsub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
/** Rotate about the vertical axis through `c` (degrees; positive turns the right side away). */
function yaw(v, c, deg) { const r = (deg * PI) / 180, s = Math.sin(r), co = Math.cos(r); const p = vsub(v, c); return vadd(v3(p.x * co - p.z * s, p.y, p.x * s + p.z * co), c); }
/** Rotate about the horizontal axis through `c` (degrees; positive turns the top away). */
function pitch(v, c, deg) { const r = (deg * PI) / 180, s = Math.sin(r), co = Math.cos(r); const p = vsub(v, c); return vadd(v3(p.x, p.y * co + p.z * s, -p.y * s + p.z * co), c); }
/** Rotate in the screen plane about `c` (degrees, clockwise). */
function roll(v, c, deg) { const r = (deg * PI) / 180, s = Math.sin(r), co = Math.cos(r); const p = vsub(v, c); return vadd(v3(p.x * co - p.y * s, p.x * s + p.y * co, p.z), c); }

/** A perspective camera looking at the slide plane from `d` slide heights away. */
class Cam {
  constructor(a, d) { this.a = a; this.d = d; }
  p(v) { const k = this.d / Math.max(this.d + v.z, this.d * 0.02); return [(v.x * k) / this.a + 0.5, v.y * k + 0.5]; }
  rect(r) { return corners(r).map(p => v3((p[0] - 0.5) * this.a, p[1] - 0.5, 0)); }
  unit(x, y) { return v3((x - 0.5) * this.a, y - 0.5, 0); }
  quad(c) { return c.map(v => this.p(v)); }
}
/** Signed area of a quad (positive: front side facing the viewer). */
function area(q) { let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
/** A card: `src` of the source mapped onto 3-D corners, if it faces the viewer; `shadeK` darkens it. Seen from behind it is left out unless `back` is set. */
function card(cam, source, src, c, alpha, shadeK, back) {
  const q = cam.quad(c);
  if (!q.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return [];
  const front = area(q) > 0;
  if (!front && !back) return [];
  const l = layerQuad(source, src, q, alpha);
  const v = [l];
  if (shadeK > 0.001) v.push(shade(l, shadeK));
  return v;
}
/** How much a card is darkened by the light behind the viewer: 0 facing straight on. */
function facingShade(c, k) {
  const u = vsub(c[1], c[0]), w = vsub(c[3], c[0]);
  const n = v3(u.y * w.z - u.z * w.y, u.z * w.x - u.x * w.z, u.x * w.y - u.y * w.x);
  const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
  if (len < 1e-12) return 0;
  return Math.min(Math.max(k * (1 - Math.abs(n.z / len)), 0), 1);
}

// ---------------------------------------------------------------------------------------------
// The effects (transition_fx.rs)

const RANDOM_KINDS = ['fade', 'push', 'wipe', 'split', 'reveal', 'randomBar', 'shape', 'uncover', 'cover', 'fallOver', 'drape', 'curtains', 'wind', 'prestige', 'fracture',
  'crush', 'peelOff', 'pageCurlDouble', 'airplane', 'origami', 'dissolve', 'checker', 'blinds', 'clock', 'ripple', 'honeycomb', 'glitter', 'vortex', 'shred', 'switch', 'flip',
  'gallery', 'cube', 'doors', 'box', 'comb', 'zoom', 'pan', 'ferris', 'conveyor', 'rotate', 'window', 'orbit', 'flythrough'];

function layers(kind, o, t, a, depth) {
  switch (kind) {
    case 'none': return [layerFull(NEW, 1)];
    case 'cut': return o === 'throughBlack' && t < 0.5 ? [layerFull(BLACK, 1)] : [layerFull(NEW, 1)];
    case 'fade': return o === 'throughBlack' ? throughBlack(t, 0.5, 0.5) : [layerFull(OLD, 1), layerFull(NEW, ss(t))];
    case 'morph': return [layerFull(OLD, 1), layerFull(NEW, ss(t))];
    case 'push': { const [dx, dy] = dir(o, [-1, 0]); const s = q2(t); return [moved(OLD, dx * s, dy * s, 1), moved(NEW, dx * (s - 1), dy * (s - 1), 1)]; }
    case 'uncover': {
      const [dx, dy] = dir(o, [-1, 0]);
      const s = o.length === 2 ? ein(win(t, 0.05, 0.35)) : powInout(t, 3);
      return [layerFull(NEW, 1), moved(OLD, dx * s, dy * s, 1)];
    }
    case 'cover': {
      const [dx, dy] = dir(o, [-1, 0]);
      const s = o.length === 2 ? 1 - (1 - win(t, 0.07, 0.95)) ** 3 : powInout(t, 4);
      return [layerFull(OLD, 1), moved(NEW, dx * (s - 1), dy * (s - 1), 1)];
    }
    case 'wipe': return wipe(o, t);
    case 'split': return split(o, t);
    case 'reveal': return reveal(o, t);
    case 'randomBar': return randomBars(o === 'vert', t);
    case 'shape': return shapeFx(o, t, a);
    case 'flash': return flash(t);
    case 'dissolve': return dissolve(t);
    case 'checker': return checker(o === 'vert', t, a);
    case 'blinds': return blinds(o === 'vert', t, a);
    case 'clock': return clock(o, t, a);
    case 'ripple': return ripple(o, t, a);
    case 'comb': return comb(o === 'vert', t);
    case 'zoom': return zoom(o, t, a);
    case 'pan': return pan(o, t);
    case 'fallOver': return fallOver(o === 'r', t, a);
    case 'drape': return drape(o === 'r', t, a);
    case 'curtains': return curtains(t, a);
    case 'wind': return wind(o === 'r', t, a);
    case 'prestige': return prestige(t, a);
    case 'fracture': return fracture(t, a);
    case 'crush': return crush(t, a);
    case 'peelOff': return peelOff(o === 'r', t);
    case 'pageCurlDouble': return pageCurl(o, t);
    case 'airplane': return airplane(o === 'r', t, a);
    case 'origami': return origami(o === 'r', t, a);
    case 'honeycomb': return honeycomb(t, a);
    case 'glitter': return glitter(o, t, a);
    case 'vortex': return vortex(o, t, a);
    case 'shred': return shred(o, t, a);
    case 'switch': return switchFx(o === 'r', t, a);
    case 'flip': return flip(o === 'r', t, a);
    case 'gallery': return gallery(o === 'r', t, a);
    case 'conveyor': return conveyor(o === 'r', t, a);
    case 'cube': case 'box': case 'rotate': case 'orbit': return prism(kind, o, t, a);
    case 'doors': case 'window': return doors(kind === 'window', o === 'horz', t, a);
    case 'ferris': return ferris(o === 'r', t, a);
    case 'flythrough': return flythrough(o, t);
    case 'random':
      if (depth === 0) {
        let h = 0x51edn;
        for (const b of new TextEncoder().encode(o)) h = hash64(h ^ BigInt(b));
        const k = RANDOM_KINDS[Number(h % BigInt(RANDOM_KINDS.length))] ?? 'fade';
        const opt = TRANSITIONS.find(x => x[0] === k)?.[4][0] ?? '';
        return layers(k, opt, t, a, depth + 1);
      }
      return [layerFull(OLD, 1), layerFull(NEW, ss(t))];
    default: return [layerFull(OLD, 1), layerFull(NEW, ss(t))];
  }
}

/** Old fades to black over [0, `out`], new fades in from black over [`inn`, 1] (smoothstep). */
function throughBlack(t, out, inn) {
  const v = [layerFull(BLACK, 1)];
  if (t < out) v.push(layerFull(OLD, 1 - ss(win(t, 0, out))));
  if (t > inn) v.push(layerFull(NEW, ss(win(t, inn, 1))));
  return v;
}

// ---- Subtle ----------------------------------------------------------------------------------

const WIPE_SOFT = 0.8;
/** Where the middle of the soft edge is at `t`: from fully before the slide to fully past it. */
const wipePos = t => -WIPE_SOFT / 2 + (1 + WIPE_SOFT) * 1.05 * t;

function wipe(o, t) {
  const c = wipePos(t);
  const p = o === 'l' ? (x) => 1 - x : o === 'u' ? (x, y) => 1 - y : o === 'd' ? (x, y) => y
    : o === 'lu' ? (x, y) => (2 - x - y) / 2 : o === 'ru' ? (x, y) => (1 + x - y) / 2 : o === 'ld' ? (x, y) => (1 - x + y) / 2 : o === 'rd' ? (x, y) => (x + y) / 2 : (x) => x;
  const diag = o.length === 2;
  const [n, m] = diag ? [32, 18] : o === 'u' || o === 'd' ? [1, 36] : [48, 1];
  return [layerFull(OLD, 1), ...field(NEW, n, m, (x, y) => edge(c, p(x, y), WIPE_SOFT))];
}
function split(o, t) {
  const horz = o.startsWith('horz'), inward = o.endsWith('In');
  const c = wipePos(t);
  const p = (x, y) => { const d = horz ? Math.abs(y - 0.5) * 2 : Math.abs(x - 0.5) * 2; return inward ? 1 - d : d; };
  const [n, m] = horz ? [1, 36] : [48, 1];
  return [layerFull(OLD, 1), ...field(NEW, n, m, (x, y) => edge(c, p(x, y), WIPE_SOFT))];
}
function reveal(o, t) {
  const dx = o.endsWith('Right') ? 1 : -1;
  if (o.startsWith('black')) {
    const v = [layerFull(BLACK, 1)];
    if (t < 0.4) { const u = win(t, 0, 0.38); v.push(moved(OLD, dx * 0.12 * ein(u), 0, 1 - ss(u))); }
    if (t > 0.55) { const u = win(t, 0.55, 1); v.push(moved(NEW, -dx * 0.12 * (1 - eout(u)), 0, ss(u))); }
    return v;
  }
  const v = [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, ss(t))];
  if (t < 0.5) { const u = win(t, 0, 0.45); v.push(moved(OLD_CONTENT, dx * 0.12 * ein(u), 0, 1 - ss(u))); }
  if (t > 0.45) { const u = win(t, 0.47, 0.95); v.push(moved(NEW_CONTENT, -dx * 0.12 * (1 - eout(u)), 0, ss(u))); }
  return v;
}
function randomBars(vert, t) {
  const n = 160, w = 0.2;
  const v = [layerFull(OLD, 1)];
  for (let i = 0; i < n; i++) {
    const start = rnd(i * 7 + 17) * (1 - w);
    const k = win(t, start, start + w);
    if (k <= 0) continue;
    const a = i / n, b = (i + 1) / n;
    v.push(inplace(NEW, vert ? [a, 0, b, 1] : [0, a, 1, b], k));
  }
  return v;
}
function shapeFx(o, t, a) {
  if (o === 'in') {
    const s = 1 - win(t, 0, 0.5);
    const v = [layerFull(NEW, 1)];
    if (s > 0) v.push(...softRect(OLD, FULL, scaleRect(FULL, s), 0.012, 1));
    return v;
  }
  if (o === 'out') {
    const s = win(t, 0.5, 1);
    const v = [layerFull(OLD, 1)];
    if (s > 0) v.push(...softRect(NEW, FULL, scaleRect(FULL, s), 0.012, 1));
    return v;
  }
  const soft = 0.18;
  const c = -soft / 2 + (1 + soft) * t;
  let f;
  if (o === 'diamond') f = (x, y) => edge(c, Math.abs(x - 0.5) + Math.abs(y - 0.5), soft);
  else if (o === 'plus') f = (x, y) => edge(c, Math.min(Math.abs(x - 0.5), Math.abs(y - 0.5)) * 2, soft);
  else { const rmax = Math.sqrt((0.5 * a) ** 2 + 0.25); f = (x, y) => edge(c, Math.sqrt(((x - 0.5) * a) ** 2 + (y - 0.5) ** 2) / rmax, soft); }
  return [layerFull(OLD, 1), ...field(NEW, 48, 27, f)];
}
function flash(t) {
  const white = t < 0.1 ? t / 0.1 : t < 0.47 ? 1 : 1 - win(t, 0.47, 0.88);
  return [layerFull(t < 0.2 ? OLD : NEW, 1), layerFull(WHITE, white)];
}

// ---- Exciting: patterns ----------------------------------------------------------------------

function dissolve(t) {
  const n = 48, m = 27;
  const v = [layerFull(OLD, 1)];
  for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) {
    if (t > rnd(r * n + c + 991) * 0.97) v.push(inplace(NEW, [c / n, r / m, (c + 1) / n, (r + 1) / m], 1));
  }
  return v;
}
/** One tile flipping in 3-D about its own vertical (or horizontal) axis: old face for the first half of `k`, new face for the second. */
function flipTile(cam, cell, k, verticalAxis, out) {
  if (k <= 0) { out.push(inplace(OLD, cell, 1)); return; }
  if (k >= 1) { out.push(inplace(NEW, cell, 1)); return; }
  const ang = 180 * k;
  const cc = center(cell);
  const c3 = cam.unit(cc[0], cc[1]);
  const [src, deg] = k < 0.5 ? [OLD, ang] : [NEW, ang - 180];
  const pts = cam.rect(cell).map(p => (verticalAxis ? yaw(p, c3, deg) : pitch(p, c3, deg)));
  out.push(...card(cam, src, cell, pts, 1, facingShade(pts, 0.6), true));
}
function checker(vert, t, a) {
  const n = 10, m = 8;
  const cam = new Cam(a, 3);
  const v = [layerFull(BLACK, 1)];
  for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) {
    const cell = [c / n, r / m, (c + 1) / n, (r + 1) / m];
    const across = vert ? r / m : c / n;
    const start = across * 0.55 + rnd(r * n + c + 5) * 0.12;
    flipTile(cam, cell, q2(win(t, start, start + 0.3)), !vert, v);
  }
  return v;
}
function blinds(vert, t, a) {
  const n = 12;
  const cam = new Cam(a, 3);
  const v = [layerFull(BLACK, 1)];
  for (let i = 0; i < n; i++) {
    const s = i / n, e = (i + 1) / n;
    const cell = vert ? [s, 0, e, 1] : [0, s, 1, e];
    const start = 0.1 + (0.3 * i) / n;
    flipTile(cam, cell, q2(win(t, start, start + 0.4)), vert, v);
  }
  return v;
}
function clock(o, t, a) {
  const soft = 0.12;
  const c = -soft / 2 + (1 + soft) * t;
  const f = ang => {
    let p;
    if (o === 'counterClockwise') p = (2 * PI - ang) / (2 * PI);
    else if (o === 'wedge') { const d = ang > PI ? 2 * PI - ang : ang; p = d / PI; }
    else p = ang / (2 * PI);
    return edge(c, p, soft);
  };
  return [layerFull(OLD, 1), ...fan(NEW, a, 240, f)];
}
function ripple(o, t, a) {
  const origin = o === 'lu' ? [1, 1] : o === 'ru' ? [0, 1] : o === 'ld' ? [1, 0] : o === 'rd' ? [0, 0] : [0.5, 0.5];
  const far = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => Math.sqrt(((p[0] - origin[0]) * a) ** 2 + (p[1] - origin[1]) ** 2)).reduce((x, y) => Math.max(x, y), 0);
  const soft = 0.16;
  const c = -soft / 2 + (1 + soft) * t;
  const dist = (x, y) => Math.sqrt(((x - origin[0]) * a) ** 2 + (y - origin[1]) ** 2) / Math.max(far, 1e-6);
  const v = [layerFull(OLD, 1), ...field(NEW, 48, 27, (x, y) => edge(c, dist(x, y), soft))];
  v.push(...field(BLACK, 48, 27, (x, y) => {
    const d = dist(x, y);
    const inside = edge(c, d, soft);
    const w = Math.abs(Math.sin((d - c) * 30));
    return 0.18 * inside * (1 - w) * (1 - t);
  }));
  return v;
}
function comb(vert, t) {
  const n = vert ? 10 : 7;
  const v = [layerFull(NEW, 1)];
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    const d = (n - 1 - i) % 2 === 0 ? 1 : -1;
    const start = 0.06 + (0.05 * (n - 1 - i) * 7) / n;
    const s = ein(win(t, start, start + 0.55));
    if (s >= 1) continue;
    const band = vert ? [a, 0, b, 1] : [0, a, 1, b];
    const [ox, oy] = vert ? [0, d * s] : [d * s, 0];
    v.push(layerRect(OLD, band, offsetRect(band, ox, oy), 1));
  }
  return v;
}
function zoom(o, t, a) {
  if (o === 'rotate') {
    const u = win(t, 0.1, 0.98);
    const s = 0.1 + 0.9 * u;
    const ang = 360 * (1 - u);
    const q = rotQuad(corners(scaleRect(FULL, s)), [0.5, 0.5], ang, a);
    return [layerFull(OLD, 1), layerQuad(NEW, FULL, q, 0.35 + 0.65 * ss(win(t, 0, 0.45)))];
  }
  if (o === 'out') {
    const s = eout(win(t, 0, 0.8));
    return [scaled(NEW, 1.9 - 0.9 * s, 0.5, 0.5, 0, 0, 1), scaled(OLD, 1 - 0.5 * eout(t), 0.5, 0.5, 0, 0, 1 - ss(win(t, 0, 0.95)))];
  }
  return [layerFull(BLACK, 1), scaled(OLD, 1 + 0.3 * ss(t), 0.5, 0.5, 0, 0, 1 - ss(win(t, 0, 0.9))), scaled(NEW, 0.5 + 0.5 * ss(win(t, 0.15, 0.95)), 0.5, 0.5, 0, 0, ss(win(t, 0, 0.85)))];
}

// ---- Exciting: 3-D and shapes ----------------------------------------------------------------

function fallOver(right, t, a) {
  const cam = new Cam(a, 2.2);
  const u = ein(win(t, 0, 0.88));
  const pivot = v3(0, 0.5, 0);
  const side = right ? 1 : -1;
  const pts = cam.rect(FULL).map(p => roll(pitch(p, pivot, 92 * u), pivot, side * 6 * u));
  const v = [layerFull(NEW, 1)];
  if (u < 1) v.push(...card(cam, OLD, FULL, pts, 1, facingShade(pts, 0.4), true));
  return v;
}
function drape(right, t, a) {
  const cam = new Cam(a, 2.2);
  const u = q2(win(t, 0.25, 0.62));
  const wob = 4 * (1 - win(t, 0.6, 1)) * Math.sin(win(t, 0.6, 1) * PI * 2);
  const ang = 90 * (1 - u) + wob * u;
  const pivot = v3(0, -0.5, 0);
  const side = right ? -1 : 1;
  const pts = cam.rect(FULL).map(p => roll(pitch(p, pivot, -ang), pivot, side * 3 * (1 - u)));
  const v = [layerFull(OLD, 1)];
  if (u > 0) v.push(...card(cam, NEW, FULL, pts, 1, facingShade(pts, 0.5), true));
  return v;
}
function curtains(t) {
  const open = q2(win(t, 0, 0.35));
  const lift = ein(win(t, 0.62, 0.9));
  const wTop = 0.5 - 0.22 * open, wBot = 0.5 - 0.12 * open;
  const up = 0.15 * lift, sw = 0.75 * lift;
  const left = [[-sw, -up], [wTop - sw, -up], [wBot - 0.6 * sw, 1 - up], [-0.6 * sw, 1 - up]];
  const right = [[1 - wTop + sw, -up], [1 + sw, -up], [1 + 0.6 * sw, 1 - up], [1 - wBot + 0.6 * sw, 1 - up]];
  return [layerFull(NEW, 1), layerQuad(OLD, [0, 0, 0.5, 1], left, 1), layerQuad(OLD, [0.5, 0, 1, 1], right, 1)];
}
function wind(right, t, a) {
  const cam = new Cam(a, 2.2);
  const u = ein(win(t, 0.12, 0.8));
  const side = right ? 1 : -1;
  const pivot = v3(0, 0, 0);
  const pts = cam.rect(FULL).map(p => {
    const w = yaw(pitch(p, v3(0, -0.5, 0), -25 * u), pivot, -side * 20 * u);
    return v3(w.x + (side * 1.6 * u * a) / 2, w.y - 0.8 * u, w.z + 0.5 * u);
  });
  const v = [layerFull(NEW, 1)];
  if (u < 1) v.push(...card(cam, OLD, FULL, pts, 1, 0, true));
  return v;
}
function prestige(t, a) {
  const cam = new Cam(a, 2.2);
  const lift = q2(win(t, 0.4, 0.62));
  const fly = ein(win(t, 0.5, 0.85));
  const pivot = v3(0, -0.5, 0);
  const pts = cam.rect(FULL).map(p => {
    const w = roll(pitch(p, pivot, -40 * lift), pivot, -12 * fly);
    return v3(w.x - (0.4 * fly * a) / 2, w.y - 1.3 * fly, w.z - 0.2 * fly);
  });
  const v = [layerFull(NEW, 1)];
  if (fly < 1) v.push(...card(cam, OLD, FULL, pts, 1, facingShade(pts, 0.3), true));
  return v;
}
function fracture(t, a) {
  const v = [layerFull(NEW, 1)];
  const crack = ss(win(t, 0.06, 0.2));
  if (crack <= 0) { v.push(layerFull(OLD, 1)); return v; }
  const n = 36;
  const rings = [0, 0.3, 0.6, 1];
  const c = [0.5, 0.5];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * PI * (i + 0.35 * rnd(i))) / n;
    const a1 = (2 * PI * (i + 1 + 0.35 * rnd((i + 1) % n))) / n;
    for (let r = 0; r < 3; r++) {
      const r0 = rings[r], r1 = r === 2 ? 1.6 : rings[r + 1];
      const p = (ang, rr) => { const b = boundary(ang, a); return [c[0] + (b[0] - c[0]) * rr, c[1] + (b[1] - c[1]) * rr]; };
      const pts = [p(a0, r0), p(a1, r0), p(a1, r1), p(a0, r1)];
      const id = i * 3 + r;
      const mid = [(pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4, (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4];
      const start = 0.3 + 0.28 * Math.min(Math.max(mid[1], 0), 1) + 0.1 * rnd(id + 300);
      const k = win(t, start, start + 0.35);
      const gap = 0.015 * crack;
      const out = [(mid[0] - c[0]) * gap * 4, (mid[1] - c[1]) * gap * 4 + 1.4 * k * k];
      const ang = (rnd(id + 7) - 0.5) * 50 * k;
      const q = pts.map(pp => {
        const p2 = [mid[0] + (pp[0] - mid[0]) * (1 - 0.06 * crack) + out[0], mid[1] + (pp[1] - mid[1]) * (1 - 0.06 * crack) + out[1]];
        return rot(p2, [mid[0] + out[0], mid[1] + out[1]], ang, a);
      });
      const uv = pts.map(pp => [Math.min(Math.max(pp[0], 0), 1), Math.min(Math.max(pp[1], 0), 1)]);
      if (k < 1) {
        const l = {source: OLD, src: FULL, quad: q, uv, alpha: 1, fade: ones()};
        v.push(l, shade(l, 0.1 * crack * rnd(id + 9) + 0.2 * k));
      }
    }
  }
  return v;
}
function crush(t, a) {
  const v = [layerFull(NEW, 1)];
  const k = q2(win(t, 0.08, 0.55));
  const drop = ein(win(t, 0.65, 1));
  const size = 1 - 0.45 * k;
  const cx = 0.5 - 0.1 * k + 0.05 * drop, cy = 0.5 + 0.05 * k + 0.8 * drop;
  const n = 40;
  const c = [0.5, 0.5];
  const j = (ang, idx) => {
    const b = boundary(ang, a);
    const dx = (b[0] - 0.5) * a, dy = b[1] - 0.5;
    const len = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-9);
    const r = 0.45;
    const round = [0.5 + ((dx / len) * r) / a, 0.5 + (dy / len) * r];
    const jag = 1 - 0.18 * k * rnd((idx % n) + 77);
    const p = [b[0] + (round[0] - b[0]) * k, b[1] + (round[1] - b[1]) * k];
    return [cx + (p[0] - c[0]) * size * jag, cy + (p[1] - c[1]) * size * jag];
  };
  for (let i = 0; i < n; i++) {
    const a0 = (2 * PI * i) / n, a1 = (2 * PI * (i + 1)) / n;
    const p0 = j(a0, i), p1 = j(a1, i + 1);
    const u0 = boundary(a0, a), u1 = boundary(a1, a);
    const l = triUv(OLD, [[cx, cy], p0, p1], [c, u0, u1], [1, 1, 1], 1);
    v.push(l, shade(l, 0.35 * k * rnd(i + 13)));
  }
  return v;
}
function peelOff(right, t) {
  const u = ss(win(t, 0.2, 0.95));
  const [cx, cy] = right ? [0, 1] : [1, 1];
  const nd = right ? [1, -1] : [-1, -1];
  const len = Math.sqrt(nd[0] * nd[0] + nd[1] * nd[1]);
  const n = [nd[0] / len, nd[1] / len];
  const span = Math.SQRT2;
  const d0 = n[0] * cx + n[1] * cy;
  const fold = d0 + span * 1.25 * u;
  const v = [layerFull(NEW, 1)];
  const full = rectPoly(FULL);
  v.push(...polyLayers(OLD, clipPoly(full, [-n[0], -n[1]], -fold), 1, p => p));
  const peeled = clipPoly(full, n, fold);
  const refl = p => { const d = n[0] * p[0] + n[1] * p[1] - fold; return [p[0] - 2 * d * n[0], p[1] - 2 * d * n[1]]; };
  for (const l of polyLayers(OLD, peeled, 1, refl)) v.push(l, shade(l, 0.25));
  return v;
}
function pageCurl(o, t) {
  const single = o.startsWith('single');
  const right = o.endsWith('r') || o.endsWith('R');
  const v = [layerFull(NEW, 1)];
  const roll_ = (area_, k, toLeft) => {
    const w = area_[2] - area_[0];
    const r = 0.06;
    if (toLeft) {
      const e = area_[2] - (w + r) * k;
      const keep = [area_[0], area_[1], Math.max(e, area_[0]), area_[3]];
      if (keep[2] > keep[0]) v.push(inplace(OLD, keep, 1));
      const band = [Math.max(e, area_[0]), area_[1], Math.max(Math.min(e + r, area_[2]), area_[0]), area_[3]];
      if (band[2] > band[0] && k < 1) {
        const l = layerRect(OLD, [band[0], area_[1], area_[2], area_[3]], band, 1);
        v.push(l, faded(shade(l, 0.3), [0.2, 1, 1, 0.2]));
      }
    } else {
      const e = area_[0] + (w + r) * k;
      const keep = [Math.min(e, area_[2]), area_[1], area_[2], area_[3]];
      if (keep[2] > keep[0]) v.push(inplace(OLD, keep, 1));
      const band = [Math.min(Math.max(e - r, area_[0]), area_[2]), area_[1], Math.min(e, area_[2]), area_[3]];
      if (band[2] > band[0] && k < 1) {
        const l = layerRect(OLD, [area_[0], area_[1], band[2], area_[3]], band, 1);
        v.push(l, faded(shade(l, 0.3), [1, 0.2, 0.2, 1]));
      }
    }
  };
  if (single) roll_(FULL, q2(win(t, 0.25, 0.85)), !right);
  else {
    const k1 = q2(win(t, 0.1, 0.6)), k2 = q2(win(t, 0.45, 0.85));
    if (right) { roll_([0, 0, 0.5, 1], k1, false); roll_([0.5, 0, 1, 1], k2, false); }
    else { roll_([0.5, 0, 1, 1], k1, true); roll_([0, 0, 0.5, 1], k2, true); }
  }
  return v;
}
function airplane(right, t) {
  const fold = q2(win(t, 0, 0.3));
  const fly = ein(win(t, 0.82, 0.95));
  const v = [layerFull(NEW, 1)];
  if (fly >= 1) return v;
  const mx = p => (right ? [1 - p[0], p[1]] : p);
  const drift = 0.04 * win(t, 0.3, 0.82);
  const pose = p0 => {
    const p = [p0[0] + drift, p0[1] + drift];
    const c = [0.75, 0.65];
    const k = 1 - 0.85 * fly;
    return [c[0] + (p[0] - c[0]) * k - 0.4 * fly, c[1] + (p[1] - c[1]) * k - 1 * fly];
  };
  const dart = [[0.42, 0.28], [1.02, 0.66], [1, 0.72], [0.46, 1.08]];
  const flat = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const pts = flat.map((f, i) => mx(pose([f[0] + (dart[i][0] - f[0]) * fold, f[1] + (dart[i][1] - f[1]) * fold])));
  const uv = flat.map(mx);
  const l1 = triUv(OLD, [pts[0], pts[1], pts[2]], [uv[0], uv[1], uv[2]], [1, 1, 1], 1);
  const l2 = triUv(OLD, [pts[0], pts[2], pts[3]], [uv[0], uv[2], uv[3]], [1, 1, 1], 1);
  v.push(l1, shade(l1, 0.1 * fold), l2, shade(l2, 0.3 * fold));
  return v;
}
function origami(right, t) {
  const fold = q2(win(t, 0, 0.2));
  const fly = ein(win(t, 0.2, 0.85));
  const side = right ? 1 : -1;
  const v = [layerFull(NEW, 1)];
  if (win(t, 0.2, 0.92) >= 1) return v;
  const size = 1 - 0.35 * fold;
  const cx = 0.47 + side * 0.65 * fly, cy = 0.42 + 0.05 * fly;
  const flap = Math.sin(t * 18) * 0.08 * fold;
  const body = p => [cx + (p[0] - 0.5) * size, cy + (p[1] - 0.5) * size];
  const shape = [[[0, 0], [-0.45 * side, -0.25 - flap]], [[1, 0], [0.15 * side, -0.4 + flap]], [[1, 1], [0.45 * side, 0.05]], [[0, 1], [-0.1 * side, 0.2]]];
  const pts = shape.map(([f, b]) => body([f[0] + (0.5 + b[0] - f[0]) * fold, f[1] + (0.5 + b[1] - f[1]) * fold]));
  const uv = shape.map(([f]) => f);
  const l1 = triUv(OLD, [pts[0], pts[1], pts[2]], [uv[0], uv[1], uv[2]], [1, 1, 1], 1);
  const l2 = triUv(OLD, [pts[0], pts[2], pts[3]], [uv[0], uv[2], uv[3]], [1, 1, 1], 1);
  v.push(l1, shade(l1, 0.15 * fold), l2, shade(l2, 0.3 * fold));
  return v;
}
function honeycomb(t, a) {
  const cols = 11;
  const w = 1 / cols;
  const rh = w * a * 0.5;
  const rows = Math.max(Math.ceil(1 / (rh * 0.866) - 1 / 3), 1) + 1;
  const v = [layerFull(BLACK, 1)];
  const seam = ss(win(t, 0, 0.12)) * (1 - ss(win(t, 0.85, 1)));
  const hex = (cx, cy, s) => Array.from({length: 6}, (_, k) => { const ang = (PI / 3) * k + PI / 6; return [cx + Math.cos(ang) * s * w * 0.577, cy + Math.sin(ang) * s * rh * 0.577]; });
  for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) {
    const cx = (c + (r % 2 === 1 ? 0.5 : 0)) * w;
    const cy = r * rh * 0.866;
    const id = r * 64 + c;
    const srcHex = hex(cx, cy, 1);
    const outStart = 0.1 + 0.2 * rnd(id + 1);
    const outK = ein(win(t, outStart, outStart + 0.12));
    const inStart = 0.38 + 0.42 * rnd(id + 3);
    const inK = eout(win(t, inStart, inStart + 0.1));
    const gap = 1 - 0.1 * seam;
    const cell = (src, s, alpha) => {
      const dst = hex(cx, cy, s);
      for (let k = 0; k < 6; k++) v.push(triUv(src, [[cx, cy], dst[k], dst[(k + 1) % 6]], [[cx, cy], srcHex[k], srcHex[(k + 1) % 6]], [1, 1, 1], alpha));
    };
    if (t < 0.5 && outK < 1) cell(OLD, gap * (1 + 3 * outK), 1 - outK * outK);
    if (inK > 0) cell(NEW, gap * (0.3 + 0.7 * inK), 1);
  }
  return v;
}
function glitter(o, t, a) {
  const hexes = o.startsWith('hex');
  const d = (hexes ? o.slice(3) : o).toLowerCase();
  const [n, m] = hexes ? [28, 16] : [40, 22];
  const cam = new Cam(a, 3);
  const v = [layerFull(OLD, 1)];
  for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) {
    const cell = [c / n, r / m, (c + 1) / n, (r + 1) / m];
    const cc = center(cell);
    const grad = d === 'r' ? 1 - cc[0] : d === 'u' ? cc[1] : d === 'd' ? 1 - cc[1] : cc[0];
    const start = 0.75 * grad * 0.85 + rnd(r * n + c + 77) * 0.12;
    const k = win(t, start, start + 0.25);
    if (k <= 0) continue;
    v.push(inplace(BLACK, cell, 1));
    flipTile(cam, cell, k, true, v);
  }
  return v;
}
function vortex(o, t, a) {
  const [dx, dy] = dir(o, [-1, 0]);
  const n = 48, m = 27;
  const v = [layerFull(BLACK, 1)];
  for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) {
    const id = r * n + c;
    const cell = [c / n, r / m, (c + 1) / n, (r + 1) / m];
    const cc = center(cell);
    const lead = Math.min(Math.max(0.5 + (cc[0] - 0.5) * dx + (cc[1] - 0.5) * dy, 0), 1);
    const go = 0.4 * lead + 0.08 * rnd(id + 31);
    const ko = win(t, go, go + 0.35);
    const end = 0.62 + 0.3 * (1 - lead) + 0.06 * rnd(id + 41);
    const kn = 1 - win(t, end - 0.35, end);
    const piece = (src, k) => {
      const swirl = 2 * PI * (rnd(id + 5) - 0.5) * k;
      const off = [dx * k * 0.8 + Math.sin(swirl) * 0.15 * k, dy * k * 0.8 - Math.abs(Math.cos(swirl)) * 0.12 * k];
      const s = 0.8 - 0.5 * k;
      const r2 = offsetRect(scaleRect(cell, s), off[0], off[1]);
      const q = rotQuad(corners(r2), center(r2), rnd(id) * 360 * k, a);
      v.push(layerQuad(src, cell, q, 1 - k * k));
    };
    if (kn < 1) piece(NEW, kn);
    if (ko > 0 && ko < 1 && kn >= 1) piece(OLD, ko);
    else if (ko <= 0) v.push(inplace(OLD, cell, 1));
  }
  return v;
}
function shred(o, t, a) {
  const particles = o.startsWith('particles') || o.startsWith('rect');
  const out = o.endsWith('Out');
  const cam = new Cam(a, 2.5);
  const v = [layerFull(BLACK, 1)];
  const [src, k] = t < 0.55 ? [OLD, q2(win(t, 0.05, 0.55))] : [NEW, 1 - q2(win(t, 0.55, 0.95))];
  if (particles) {
    const n = 64, m = 36;
    for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) {
      const id = r * n + c;
      const cell = [c / n, r / m, (c + 1) / n, (r + 1) / m];
      const cc = center(cell);
      const z = (out ? -0.6 : 1.5) * k * (0.5 + rnd(id));
      const jitter = [(rnd(id + 1) - 0.5) * 0.4 * k, (rnd(id + 2) - 0.5) * 0.4 * k];
      const p3 = cam.unit(cc[0] + jitter[0], cc[1] + jitter[1]);
      const pc = cam.p(v3(p3.x, p3.y, z));
      const s = (0.8 * (1 - 0.3 * k) * cam.d) / Math.max(cam.d + z, 0.1);
      const r2 = offsetRect(scaleRect(cell, s), pc[0] - cc[0], pc[1] - cc[1]);
      const l = layerRect(src, cell, r2, 1 - 0.3 * k * rnd(id + 5));
      v.push(l, shade(l, 0.4 * k));
    }
  } else {
    const n = 30;
    for (let i = 0; i < n; i++) {
      const x0 = i / n, x1 = (i + 1) / n;
      const cell = [x0, 0, x1, 1];
      const z = (out ? -0.3 : 1) * k * k * (0.6 + rnd(i + 11));
      const tilt = (rnd(i + 12) - 0.5) * 30 * k;
      const drop = (rnd(i + 13) - 0.3) * 0.25 * k;
      const inset = 0.004 * k;
      const w3 = cam.rect([x0 + inset, 0, x1 - inset, 1]);
      const c3 = cam.unit((x0 + x1) / 2, 0.5);
      const pts = w3.map(p => { const q = yaw(roll(p, c3, tilt * 0.2), c3, tilt); return v3(q.x, q.y + drop, q.z + z); });
      v.push(...card(cam, src, cell, pts, 1, 0.3 * k, true));
    }
  }
  return v;
}
function switchFx(right, t, a) {
  const cam = new Cam(a, 2.5);
  const side = right ? -1 : 1;
  const u = (t + ss(t)) / 2;
  const k = Math.sin(u * PI);
  const shift = 0.5 * k * a;
  const o0 = v3(0, 0, 0);
  const old = cam.rect(FULL).map(p => { const q = yaw(p, o0, side * 14 * k); return v3(q.x - side * shift, q.y, q.z + 0.12 * k); });
  const nw = cam.rect(FULL).map(p => { const q = yaw(p, o0, -side * 14 * k); return v3(q.x + side * shift, q.y, q.z + 0.12 * k); });
  const v = [layerFull(BLACK, 1)];
  const oc = card(cam, OLD, FULL, old, 1, facingShade(old, 0.3), true);
  const nc = card(cam, NEW, FULL, nw, 1, facingShade(nw, 0.3), true);
  if (u < 0.5) v.push(...nc, ...oc); else v.push(...oc, ...nc);
  return v;
}
function flip(right, t, a) {
  const cam = new Cam(a, 2.5);
  const s = q2(t);
  const side = right ? 1 : -1;
  const deg = 180 * s * side;
  const back = 0.6 * Math.sin(s * PI);
  const c = v3(0, 0, 0);
  const pts = cam.rect(FULL).map(p => { const q = yaw(p, c, deg); return v3(q.x, q.y, q.z + back); });
  const v = [layerFull(BLACK, 1)];
  if (s < 0.5) v.push(...card(cam, OLD, FULL, pts, 1, facingShade(pts, 0.5), true));
  else { const m = [pts[1], pts[0], pts[3], pts[2]]; v.push(...card(cam, NEW, FULL, m, 1, facingShade(m, 0.5), true)); }
  return v;
}
function gallery(right, t, a) {
  const cam = new Cam(a, 2.5);
  const side = right ? 1 : -1;
  const k = ss(win(t, 0, 0.35)) * (1 - ss(win(t, 0.7, 1)));
  const s = q2(win(t, 0.3, 0.8));
  const gap = 0.15;
  const back = 0.7 * k;
  const yawA = -side * 22 * k;
  const v = [layerFull(BLACK, 1)];
  for (const [src, shift] of [[OLD, side * s], [NEW, side * (s - 1)]]) {
    const x0 = shift * (a + gap);
    const pts = cam.rect(FULL).map(p => v3(p.x + x0, p.y, p.z + back)).map(p => yaw(p, v3(0, 0, back), yawA));
    const refl = [pts[3], pts[2], v3(pts[2].x, pts[2].y + 0.25, pts[2].z), v3(pts[3].x, pts[3].y + 0.25, pts[3].z)];
    v.push({source: src, src: [0, 0.75, 1, 1], quad: cam.quad(refl), uv: [[0, 1], [1, 1], [1, 0.75], [0, 0.75]], alpha: 0.3 * k, fade: [1, 1, 0, 0]});
    v.push(...card(cam, src, FULL, pts, 1, 0, true));
  }
  return v;
}
function conveyor(right, t, a) {
  const cam = new Cam(a, 2.5);
  const side = right ? 1 : -1;
  const k = ss(win(t, 0, 0.35)) * (1 - ss(win(t, 0.65, 1)));
  const s = q2(win(t, 0.33, 0.75));
  const back = 0.45 * k;
  const yawA = -side * 18 * k;
  const v = [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, ss(t))];
  for (const [src, shift] of [[OLD_CONTENT, side * s], [NEW_CONTENT, side * (s - 1)]]) {
    const x0 = shift * a * 1.05;
    const pts = cam.rect(FULL).map(p => v3(p.x + x0, p.y, p.z + back)).map(p => yaw(p, v3(0, 0, back), yawA));
    v.push(...card(cam, src, FULL, pts, 1, 0, true));
  }
  return v;
}
function prism(kind, o, t, a) {
  const [dx, dy] = dir(o, [-1, 0]);
  const vertical = dy !== 0 && dx === 0;
  const content = kind === 'rotate' || kind === 'orbit';
  const inverted = kind === 'box' || kind === 'orbit';
  const cam = new Cam(a, 2.5);
  const s = q2(t);
  const half = vertical ? 0.5 : a / 2;
  const c = v3(0, 0, inverted ? -half : half);
  const sign = vertical ? -dy : dx;
  const deg = 90 * s * sign * (inverted ? -1 : 1);
  const turn = (p, base) => (vertical ? pitch(p, c, base + deg) : yaw(p, c, base + deg));
  const sideBase = -90 * sign * (inverted ? -1 : 1);
  const [os, ns] = content ? [OLD_CONTENT, NEW_CONTENT] : [OLD, NEW];
  let old = cam.rect(FULL).map(p => turn(p, 0));
  let nw = cam.rect(FULL).map(p => turn(p, sideBase));
  const near = Math.min(...old.map(p => p.z), ...nw.map(p => p.z));
  const lift = inverted ? 0 : -Math.min(near, 0) - Math.max(near, 0);
  const back = (inverted ? 0.5 : 0.15) * Math.sin(s * PI);
  const push = q => q.map(p => v3(p.x, p.y, p.z + lift + back));
  old = push(old); nw = push(nw);
  const v = content ? [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, ss(t))] : [layerFull(BLACK, 1)];
  v.push(...card(cam, os, FULL, old, 1, content ? 0 : facingShade(old, 0.6), false));
  v.push(...card(cam, ns, FULL, nw, 1, content ? 0 : facingShade(nw, 0.6), false));
  return v;
}
function doors(window_, horz, t, a) {
  const cam = new Cam(a, 2.2);
  const open = ein(win(t, 0.05, 0.68));
  const come = q2(win(t, 0, 0.72));
  const [os, ns] = window_ ? [OLD_CONTENT, NEW_CONTENT] : [OLD, NEW];
  const v = window_ ? [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, ss(t))] : [layerFull(BLACK, 1)];
  const halves = horz ? [[[0, 0, 1, 0.5], -1], [[0, 0.5, 1, 1], 1]] : [[[0, 0, 0.5, 1], -1], [[0.5, 0, 1, 1], 1]];
  if (open < 1) {
    for (const [r, sgn] of halves) {
      const hinge = horz ? cam.unit(0.5, sgn < 0 ? 0 : 1) : cam.unit(sgn < 0 ? 0 : 1, 0.5);
      const ang = 30 * open, slide = 0.55 * open;
      const pts = cam.rect(r).map(p => {
        const q = horz ? pitch(p, hinge, sgn * ang) : yaw(p, hinge, -sgn * ang);
        return horz ? v3(q.x, q.y + sgn * slide, q.z) : v3(q.x + sgn * slide * a, q.y, q.z);
      });
      const dark = window_ ? 0 : 0.7 * open;
      const alpha = window_ ? 1 - ss(win(t, 0.2, 0.6)) : 1;
      v.push(...card(cam, os, r, pts, alpha, dark, true));
    }
  }
  v.push(scaled(ns, 0.5 + 0.5 * come, 0.5, 0.5, 0, 0, window_ ? ss(t) : ss(win(t, 0.05, 0.62))));
  return v;
}
function ferris(right, t, a) {
  const side = right ? -1 : 1;
  const v = [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, ss(t))];
  const out = ein(win(t, 0, 0.5));
  if (out < 1) {
    const dx = -side * 0.45 * out ** 1.5, dy = 0.9 * out;
    v.push(layerQuad(OLD_CONTENT, FULL, rotQuad(corners(offsetRect(FULL, dx, dy)), [0.5 + dx, 0.5 + dy], side * -15 * out, a), 1));
  }
  const inn = q2(win(t, 0.5, 1));
  if (inn > 0) {
    const k = 1 - inn;
    const dx = -side * 0.5 * k ** 1.3, dy = -0.75 * k;
    const r = offsetRect(scaleRect(FULL, 1 - 0.25 * k), dx, dy);
    v.push(layerQuad(NEW_CONTENT, FULL, rotQuad(corners(r), center(r), side * -18 * k, a), 1));
  }
  return v;
}
function pan(o, t) {
  const [dx, dy] = dir(o, [-1, 0]);
  const s = ease(t, 0.2, 0.8, 0);
  return [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, s), moved(OLD_CONTENT, dx * s, dy * s, 1), moved(NEW_CONTENT, dx * (s - 1), dy * (s - 1), 1)];
}
function flythrough(o, t) {
  const bounce = o.endsWith('Bounce');
  const out = o.startsWith('out');
  const s = q2(t);
  const b = bounce ? 0.08 * Math.sin(win(t, 0.6, 1) * PI) : 0;
  const oldA = 1 - ss(win(t, 0, 0.6)), newA = ss(win(t, 0.3, 0.95));
  const [os, ns] = out ? [1 - 0.5 * s, 1.8 - 0.8 * s - b] : [1 + 1.5 * s, 0.4 + 0.6 * s + b];
  return [layerFull(OLD_BACK, 1), layerFull(NEW_BACK, ss(t)), scaled(NEW_CONTENT, ns, 0.5, 0.5, 0, 0, newA), scaled(OLD_CONTENT, os, 0.5, 0.5, 0, 0, oldA)];
}

// ---------------------------------------------------------------------------------------------
// The public frame functions (transition.rs)

/**
 * Layers of the transition `kind` with `option` at linear progress `t` (0..1) on a slide `aspect`
 * wide per unit of height. Draw in order over black. At `t >= 1` the result is the new slide
 * alone; at `t <= 0` (or NaN) the old slide alone. Morph returns a plain crossfade (the show
 * renders morph frames with `morphFrame`). Layers with a part source need the slides rendered as
 * background and content (`usesSlideParts`).
 */
export function transitionFrame(kind, option, tIn, aspectIn = DEFAULT_ASPECT) {
  const t = clampf(tIn, 0, 1, 0);
  const aspect = Number.isFinite(aspectIn) && aspectIn > 0.01 ? Math.min(aspectIn, 100) : DEFAULT_ASPECT;
  const v = t >= 1 ? [layerFull(NEW, 1)] : t <= 0 ? [layerFull(OLD, 1)] : layers(kind, option ?? '', t, aspect, 0);
  return v.map(sanitizeLayer).filter(l => l.alpha > 0 && l.fade.some(a => a > 0));
}
/** Does `kind` animate the slides' backgrounds and contents separately (PowerPoint's Dynamic Content transitions and Reveal)? */
export function usesSlideParts(kind, option = '') {
  switch (kind) {
    case 'pan': case 'ferris': case 'conveyor': case 'rotate': case 'window': case 'orbit': case 'flythrough': return true;
    case 'reveal': return !String(option).startsWith('black');
    default: return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Triangle meshes (mesh.rs): a quad in perspective is split into a grid whose vertices follow the
// projective map from the source rectangle, so the picture looks like a flat card turned in 3-D.

const GRID = 8;
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const [dx1, dx2, dy1, dy2] = [x1 - x2, x3 - x2, y1 - y2, y3 - y2];
  const den = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(den) || Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  const m = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
  return m.every(Number.isFinite) ? m : null;
}
function applyProj(m, u, v) {
  let w = m[6] * u + m[7] * v + 1;
  if (Math.abs(w) < 1e-9) w = w < 0 ? -1e-9 : 1e-9;
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** The triangles of a layer: `{vertices: [{pos, uv, a}], triangles: [[i, j, k]]}`. */
export function layerMesh(l) {
  const q = l.quad, uv = l.uv;
  const fa = l.fade.map(f => f * l.alpha);
  if (q[3][0] === q[2][0] && q[3][1] === q[2][1] && uv[3][0] === uv[2][0] && uv[3][1] === uv[2][1]) {
    return {vertices: [0, 1, 2].map(k => ({pos: q[k], uv: uv[k], a: fa[k]})), triangles: [[0, 1, 2]]};
  }
  const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1]], e2 = [q[2][0] - q[3][0], q[2][1] - q[3][1]];
  const affine = Math.abs(e1[0] - e2[0]) < 1e-9 && Math.abs(e1[1] - e2[1]) < 1e-9;
  const h = affine ? null : squareToQuad(q);
  if (!h) return {vertices: [0, 1, 2, 3].map(k => ({pos: q[k], uv: uv[k], a: fa[k]})), triangles: [[0, 1, 2], [0, 2, 3]]};
  let span = 0;
  for (const p of q) for (const r of q) span = Math.max(span, Math.abs(p[0] - r[0]), Math.abs(p[1] - r[1]));
  const n = Math.min(Math.max(Math.ceil(span * 2 * GRID), 1), GRID);
  const vertices = [];
  for (let j = 0; j <= n; j++) {
    const b = j / n;
    for (let i = 0; i <= n; i++) {
      const a = i / n;
      const tt = lerp2(lerp2(uv[0], uv[1], a), lerp2(uv[3], uv[2], a), b);
      const at = fa[0] + (fa[1] - fa[0]) * a, ab = fa[3] + (fa[2] - fa[3]) * a;
      vertices.push({pos: applyProj(h, a, b), uv: tt, a: at + (ab - at) * b});
    }
  }
  const triangles = [];
  const w = n + 1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const p = j * w + i; triangles.push([p, p + 1, p + w + 1], [p, p + w + 1, p + w]); }
  return {vertices, triangles};
}
