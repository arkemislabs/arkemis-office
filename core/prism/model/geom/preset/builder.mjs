// Preset path builder and shared shape helpers.
// Translated from deckcraft crates/geom/src/preset/builder.rs and the FillMode/Handle/Geometry
// parts of crates/geom/src/preset/catalog.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {pt, add, sub, mul, hypot2, dot, arcToCubics, rect, rectFromPoints, ZERO} from '../kurbo.mjs';

// Rust f64 semantics: max/min ignore NaN; clamp keeps NaN.
export const fmax = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));
export const fmin = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.min(a, b));
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const rad = d => (d * Math.PI) / 180;
export const deg = r => (r * 180) / Math.PI;
/** Rust `rem_euclid`. */
export const remEuclid = (a, b) => { const r = a % b; return r < 0 ? r + Math.abs(b) : r; };

/** How a sub-path is filled. Lighten/Darken variants shade the shape's fill (3-D looking faces). */
export const FillMode = Object.freeze({Norm: 'norm', None: 'none', Lighten: 'lighten', LightenLess: 'lightenLess', Darken: 'darken', DarkenLess: 'darkenLess'});

/**
 * A draggable adjust handle (the yellow dot). `pos = origin + dir * value`; dragging projects the
 * pointer onto `dir`. An `angle` handle instead measures the pointer's angle about `origin`
 * (1/60 000 degree, y down, 0° at +x).
 */
export function handle(index, origin, dir, value, min, max) {
  return {index, pos: add(origin, mul(dir, value)), origin, dir, min, max, angle: false};
}
/** An angle handle on the `rx`×`ry` ellipse around `center` at visual angle `value`. */
export function angleHandle(index, center, rx, ry, value) {
  const t = rad(vis(value / 60000, rx, ry));
  return {index, pos: pt(center.x + rx * Math.cos(t), center.y + ry * Math.sin(t)), origin: center, dir: ZERO, min: 0, max: 21600000, angle: true};
}
/** The adjust value for a pointer at `p` (shape-local space). */
export function handleValueAt(h, p) {
  if (h.angle) {
    const d = sub(p, h.origin);
    if (!(Number.isFinite(d.x) && Number.isFinite(d.y)) || Math.hypot(d.x, d.y) < 1e-9) return h.min;
    const v = Math.round(remEuclid(deg(Math.atan2(d.y, d.x)), 360) * 60000);
    return v >= h.max ? h.min : v;
  }
  const l2 = hypot2(h.dir);
  if (l2 < 1e-18) return h.min;
  const v = dot(sub(p, h.origin), h.dir) / l2;
  if (!Number.isFinite(v)) return h.min;
  return Math.round(clamp(v, Math.min(h.min, h.max), Math.max(h.max, h.min)));
}

/** The union outline used for hit testing and selection (all filled or stroked sub-paths). */
export const outline = g => g.paths.flatMap(s => s.path);
/** Whether nothing is filled (lines, connectors, arcs, brackets). */
export const isOpen = g => g.paths.every(s => s.fill === FillMode.None);

// ---------- path builder ----------

export class Pb {
  constructor() { this.p = []; this.cur = pt(0, 0); }
  m(x, y) { this.cur = pt(x, y); this.p.push({t: 'M', p: this.cur}); return this; }
  l(x, y) { this.cur = pt(x, y); this.p.push({t: 'L', p: this.cur}); return this; }
  c(x1, y1, x2, y2, x, y) { this.cur = pt(x, y); this.p.push({t: 'C', p1: pt(x1, y1), p2: pt(x2, y2), p: this.cur}); return this; }
  q(x1, y1, x, y) { this.cur = pt(x, y); this.p.push({t: 'Q', p1: pt(x1, y1), p: this.cur}); return this; }
  curveTo(p1, p2, p) { this.p.push({t: 'C', p1, p2, p}); }
  /**
   * Elliptic arc continuing from the current point, which lies on the ellipse at parametric angle
   * `st` (degrees); sweeps `sw` degrees (positive = clockwise on screen).
   */
  arc(wr, hr, st, sw) {
    const s = rad(st), e = rad(st + sw);
    const c = pt(this.cur.x - wr * Math.cos(s), this.cur.y - hr * Math.sin(s));
    arcToCubics(c, pt(Math.abs(wr), Math.abs(hr)), s, e - s, 0, 0.05, (p1, p2, p) => this.p.push({t: 'C', p1, p2, p}));
    this.cur = pt(c.x + wr * Math.cos(e), c.y + hr * Math.sin(e));
    return this;
  }
  /**
   * A DrawingML `arcTo`: angles are where the ray from the ellipse's centre at that angle meets
   * it (not the ellipse's parameter), so elliptical arcs start and end where the standard's
   * shapes expect.
   */
  arcSpec(wr, hr, st, sw) {
    const par = a => { const r = rad(a); return Math.atan2(wr * Math.sin(r), hr * Math.cos(r)); };
    const t0 = par(st);
    let d = par(st + sw) - t0;
    const tau = Math.PI * 2;
    if (Math.abs(sw) >= 360) d = sw < 0 ? -tau : tau;
    else {
      while (sw > 0 && d < 0) d += tau;
      while (sw < 0 && d > 0) d -= tau;
    }
    return this.arc(wr, hr, deg(t0), deg(d));
  }
  z() { this.p.push({t: 'Z'}); return this; }
  poly(pts) {
    pts.forEach(([x, y], i) => (i === 0 ? this.m(x, y) : this.l(x, y)));
    return this.z();
  }
  ellipse(cx, cy, rx, ry) { this.m(cx + rx, cy); this.arc(rx, ry, 0, 360); return this.z(); }
  take() { const p = this.p; this.p = []; return p; }
}

export const fill = path => ({path, fill: FillMode.Norm, stroke: true, evenOdd: false});
export const fillEo = path => ({path, fill: FillMode.Norm, stroke: true, evenOdd: true});
export const shade = (path, m) => ({path, fill: m, stroke: true, evenOdd: false});
export const strokeOnly = path => ({path, fill: FillMode.None, stroke: true, evenOdd: false});
export const fillOnly = path => ({path, fill: FillMode.Norm, stroke: false, evenOdd: false});

/** Parametric angle on an rx×ry ellipse for a visual angle `deg` (file angles are visual). */
export function vis(d, rx, ry) {
  const t = rad(d);
  return deg(Math.atan2(rx * Math.sin(t), ry * Math.cos(t)));
}

export function polygonRegular(n, w, h, phase) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rad(phase + (360 * i) / n);
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return normalizePts(pts, w, h);
}

/** Scale `pts` so their bounding box fills 0..w × 0..h. */
function normalizePts(pts, w, h) {
  let x0 = Number.MAX_VALUE, y0 = Number.MAX_VALUE, x1 = -Number.MAX_VALUE, y1 = -Number.MAX_VALUE;
  for (const [x, y] of pts) { x0 = fmin(x0, x); y0 = fmin(y0, y); x1 = fmax(x1, x); y1 = fmax(y1, y); }
  const sx = x1 - x0 > 1e-12 ? w / (x1 - x0) : 0;
  const sy = y1 - y0 > 1e-12 ? h / (y1 - y0) : 0;
  return pts.map(([x, y]) => [(x - x0) * sx, (y - y0) * sy]);
}

/**
 * An n-pointed star as ECMA-376 draws it: points on an ellipse around (hc, vc · vf) with radii half
 * the box stretched by the preset's `hf` / `vf`, the inner corners `inner` of the way out.
 */
export function star(n, w, h, inner) {
  const [hf, vf] = n === 5 ? [1.05146, 1.10557] : n === 6 ? [1.1547, 1] : n === 7 ? [1.02572, 1.0521] : n === 10 ? [1.05146, 1] : [1, 1];
  const rx = (w / 2) * hf, ry = (h / 2) * vf, cy = (h / 2) * vf;
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rad(-90 + (180 * i) / n);
    const r = i % 2 === 0 ? 1 : inner;
    pts.push([w / 2 + r * rx * Math.cos(a), cy + r * ry * Math.sin(a)]);
  }
  return pts;
}

/** The text rectangle ECMA-376 gives a star (`inner` is the adjust over 50000), where known. */
export function starTextRect(n, w, h, inner) {
  const hc = w / 2, vc = h / 2;
  if (n === 4) {
    const dx = hc * inner * Math.cos(rad(45)), dy = vc * inner * Math.sin(rad(45));
    return rect(hc - dx, vc - dy, hc + dx, vc + dy);
  }
  if (n === 5) {
    const swd2 = hc * 1.05146, shd2 = vc * 1.10557, svc = vc * 1.10557;
    const iwd2 = swd2 * inner, ihd2 = shd2 * inner;
    const sdx1 = iwd2 * Math.cos(rad(18));
    const sdy1 = ihd2 * Math.sin(rad(54));
    return rect(hc - sdx1, svc - sdy1, hc + sdx1, svc + ihd2);
  }
  return null;
}

export const Corner = Object.freeze({square: () => ({k: 'square'}), round: r => ({k: 'round', r}), snip: r => ({k: 'snip', r})});
const SQUARE = Object.freeze({k: 'square'});
export const SQUARE4 = [SQUARE, SQUARE, SQUARE, SQUARE];

/** A rectangle with each corner (TL, TR, BR, BL) square, rounded or snipped. */
export function cornerRect(w, h, c) {
  const b = new Pb();
  const size = k => (k.k === 'square' ? 0 : fmax(k.r, 0));
  const s0 = size(c[0]);
  b.m(s0, 0);
  const s1 = size(c[1]);
  b.l(w - s1, 0);
  if (c[1].k === 'round' && c[1].r > 0) b.arc(c[1].r, c[1].r, 270, 90);
  else if (c[1].k === 'snip') b.l(w, s1);
  const s2 = size(c[2]);
  b.l(w, h - s2);
  if (c[2].k === 'round' && c[2].r > 0) b.arc(c[2].r, c[2].r, 0, 90);
  else if (c[2].k === 'snip') b.l(w - s2, h);
  const s3 = size(c[3]);
  b.l(s3, h);
  if (c[3].k === 'round' && c[3].r > 0) b.arc(c[3].r, c[3].r, 90, 90);
  else if (c[3].k === 'snip') b.l(0, h - s3);
  b.l(0, s0);
  if (c[0].k === 'round' && c[0].r > 0) b.arc(c[0].r, c[0].r, 180, 90);
  else if (c[0].k === 'snip') b.l(s0, 0);
  b.z();
  return b.take();
}

export const midSites = (w, h) => [pt(w / 2, 0), pt(0, h / 2), pt(w / 2, h), pt(w, h / 2)];

/** Orientation for single-axis arrows built along +x. */
export const Dir = Object.freeze({Right: 'right', Left: 'left', Up: 'up', Down: 'down'});

/** Map canonical (u along the arrow's length L, v across thickness T) to shape space. */
export function orient(d, w, h, pts) {
  return pts.map(([u, v]) => (d === Dir.Right ? [u, v] : d === Dir.Left ? [w - u, v] : d === Dir.Up ? [v, h - u] : [v, u]));
}

export const lenThick = (d, w, h) => (d === Dir.Right || d === Dir.Left ? [w, h] : [h, w]);

export function arrow(d, w, h, a1In, a2) {
  const [l, t] = lenThick(d, w, h);
  const ss = fmin(l, t);
  const a1 = clamp(a1In, 0, 100000) / 100000;
  const dx = fmin((ss * clamp(a2, 0, (100000 * l) / fmax(ss, 1e-9))) / 100000, l);
  const y1 = t / 2 - (t * a1) / 2;
  const y2 = t / 2 + (t * a1) / 2;
  let pts = [[0, y1], [l - dx, y1], [l - dx, 0], [l, t / 2], [l - dx, t], [l - dx, y2], [0, y2]];
  pts = orient(d, w, h, pts);
  const tr = orient(d, w, h, [[0, y1], [l - dx + dx * (y1 / fmax(t / 2, 1e-9)), y2]]);
  const text = rectFromPoints(pt(tr[0][0], tr[0][1]), pt(tr[1][0], tr[1][1]));
  const g = {paths: [fill(new Pb().poly(pts).take())], textRect: text, handles: [], sites: midSites(w, h)};
  // handle 0: shaft thickness on the head base; handle 1: head length.
  const o = orient(d, w, h, [[l - dx, t / 2], [l, t / 2]]);
  const o0 = pt(o[0][0], o[0][1]), o1 = pt(o[1][0], o[1][1]);
  const across = d === Dir.Right || d === Dir.Left ? pt(0, -t / 2 / 100000) : pt(-t / 2 / 100000, 0);
  const along = mul(sub(o0, o1), ss / 100000 / fmax(dx, 1e-9));
  g.handles.push(handle(0, o0, across, a1 * 100000, 0, 100000));
  if (dx > 1e-9) g.handles.push(handle(1, o1, along, a2, 0, (100000 * l) / fmax(ss, 1e-9)));
  return g;
}

export function doubleArrow(vertical, w, h, a1In, a2) {
  const [l, t] = vertical ? [h, w] : [w, h];
  const ss = fmin(l, t);
  const a1 = clamp(a1In, 0, 100000) / 100000;
  const dx = fmin((ss * fmax(a2, 0)) / 100000, l / 2);
  const y1 = t / 2 - (t * a1) / 2;
  const y2 = t / 2 + (t * a1) / 2;
  let pts = [[0, t / 2], [dx, 0], [dx, y1], [l - dx, y1], [l - dx, 0], [l, t / 2], [l - dx, t], [l - dx, y2], [dx, y2], [dx, t]];
  pts = orient(vertical ? Dir.Down : Dir.Right, w, h, pts);
  const r = vertical ? rect(y1, dx, y2, h - dx) : rect(dx, y1, w - dx, y2);
  return {paths: [fill(new Pb().poly(pts).take())], textRect: r, handles: [], sites: midSites(w, h)};
}

/** Points given in 21600ths of the box (as ECMA-376 defines many fixed shapes), scaled to it. */
export const specPts = (pts, w, h) => pts.map(([x, y]) => [(w * x) / 21600, (h * y) / 21600]);

export const simple = (path, text, w, h) => ({paths: [fill(path)], textRect: text, handles: [], sites: midSites(w, h)});

export function ellipseSites(w, h) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = rad(-90 - 45 * i);
    out.push(pt(w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)));
  }
  return out;
}

/** A free 2-D handle is represented as index 0 with the box as direction; callers move both values. */
export const tipHandle = (w, h, tip) => ({index: 0, pos: tip, origin: pt(w / 2, h / 2), dir: pt(w / 1e5, h / 1e5), min: -1e6, max: 1e6, angle: false});
