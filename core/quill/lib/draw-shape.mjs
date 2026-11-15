// Draw › Ink to Shape: a small geometric recogniser that tells whether a hand-drawn stroke is a
// straight line, a rectangle (or square), an ellipse (or circle), a triangle or another polygon of
// up to eight corners, or an arrow (a shaft plus a head drawn in one stroke, or a line and a head
// drawn as two strokes). An open stroke is a line when it stays close to the chord between its ends;
// a closed one is an ellipse when its points sit on the ellipse inscribed in its bounds (low RMS of
// the normalised radius), else a polygon from its corners (the closed path simplified with
// Ramer–Douglas–Peucker, near-straight and crowded corners merged) when that polygon stays close to
// every point. Anything else (scribbles, curves, letters) stays ink.
//
// Translated from wordcraft crates/engine/src/cmd/ink_shape.rs (`recognise`, `arrow`,
// `closed_arrow`, `head_fits`, `arrow_parts`, `pair_parts`, `heads`, `clean`, `shaft_tip`,
// `corners`, `rdp`, `upright`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// A recognised shape: {type: 'line', a, b} | {type: 'arrow', a, b, headAtEnd, headAtStart} |
// {type: 'rectangle'|'ellipse', x, y, w, h} | {type: 'polygon', corners}. No DOM, no Node built-ins.

import {MAX_POINTS} from '../model/freeform.mjs';

/** Smallest stroke (its longer side, points) that is turned into a shape: a tap or a tick stays ink. */
const MIN_SIZE = 6.0;
/** Most corners a polygon may have. */
export const MAX_CORNERS = 8;
const BARB_LEN = [0.05, 0.5];
const BARB_ANGLE = [15.0, 75.0];
/** How far a two-stroke arrow's head apex may sit from the line's end, as a fraction of the line. */
const PAIR_REACH = 0.12;

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** What it is, for messages and command results (InkShape::name). */
export function shapeName(s) {
  switch (s.type) {
    case 'line': return 'line';
    case 'arrow': return 'arrow';
    case 'rectangle': return s.w === s.h ? 'square' : 'rectangle';
    case 'ellipse': return s.w === s.h ? 'circle' : 'ellipse';
    default: return s.corners.length === 3 ? 'triangle' : 'polygon';
  }
}

/** Left, top, width and height of `pts` (zero for none). */
export function bbox(pts) {
  const f = pts[0];
  if (!f) return [0, 0, 0, 0];
  let [x0, y0, x1, y1] = [f[0], f[1], f[0], f[1]];
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** A shape's bounds: left, top, width, height (InkShape::bounds). */
export function shapeBounds(s) {
  switch (s.type) {
    case 'rectangle': case 'ellipse': return [s.x, s.y, s.w, s.h];
    case 'line': case 'arrow': return bbox([s.a, s.b]);
    default: return bbox(s.corners);
  }
}

/** Distance from `p` to the segment `a`–`b`. */
function segDistance(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return dist([a[0] + t * dx, a[1] + t * dy], p);
}

/** Distance from `p` to the closed polygon through `c`. */
function polygonDistance(c, p) {
  let best = Infinity;
  for (let i = 0; i < c.length; i++) best = Math.min(best, segDistance(c[i], c[(i + 1) % c.length], p));
  return best;
}

/** Finite, not absurdly far points only (at most MAX_POINTS), without repeats (clean). */
export function clean(pts) {
  const p = [];
  for (const q of pts.slice(0, MAX_POINTS)) {
    if (!(Number.isFinite(q[0]) && Number.isFinite(q[1]) && Math.abs(q[0]) < 1e6 && Math.abs(q[1]) < 1e6)) continue;
    const last = p[p.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) p.push([q[0], q[1]]);
  }
  return p;
}

/** How far the points stray from the ellipse inscribed in the w × h box at (x0, y0) (ellipse_rms). */
function ellipseRms(p, x0, y0, w, h) {
  const rx = w / 2, ry = h / 2;
  if (rx <= 0 || ry <= 0 || !p.length) return Infinity;
  const cx = x0 + rx, cy = y0 + ry;
  let sum = 0;
  for (const [x, y] of p) sum += (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) ** 2;
  return Math.sqrt(sum / p.length);
}

/** A box drawn nearly square made square, same centre (snap_square). */
function snapSquare(x, y, w, h) {
  if (Math.abs(w - h) <= 0.12 * Math.max(w, h)) { const s = (w + h) / 2; return [x + (w - s) / 2, y + (h - s) / 2, s, s]; }
  return [x, y, w, h];
}

/** How far the path turns at `b` coming from `a` and going on to `c`, degrees (turning). */
function turning(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
  if (lu <= 0 || lv <= 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180) / Math.PI;
}

/** Ramer–Douglas–Peucker simplification of an open path (iterative); keeps both ends (rdp). */
function rdp(p, eps) {
  const n = p.length;
  if (n < 3) return p.slice();
  const keep = new Array(n).fill(false);
  keep[0] = true; keep[n - 1] = true;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = [a, 0];
    for (let i = a + 1; i < b; i++) { const d = segDistance(p[a], p[b], p[i]); if (d > far[1]) far = [i, d]; }
    if (far[1] > eps) { keep[far[0]] = true; stack.push([a, far[0]], [far[0], b]); }
  }
  return p.filter((_, i) => keep[i]);
}

/** The corners of the closed path through `p` (corners). */
function corners(p, diag) {
  const eps = 0.05 * diag;
  const start = p[0];
  if (!start) return [];
  let far = [0, 0];
  p.forEach((q, i) => { const d = dist(start, q); if (d > far[1]) far = [i, d]; });
  const i = Math.min(far[0], p.length);
  const a = p.slice(0, i), b = p.slice(i);
  const ring = rdp([...a, ...b.slice(0, 1)], eps);
  const back = rdp([...b, start], eps);
  // The halves share the far point and the start.
  ring.pop();
  back.pop();
  ring.push(...back);
  // Merge until every corner turns sharply and none sits on top of the next.
  while (ring.length > 3) {
    const n = ring.length;
    const turn = k => turning(ring[(k + n - 1) % n], ring[k], ring[(k + 1) % n]);
    let best = [0, Infinity];
    for (let k = 0; k < n; k++) { const t = turn(k); if (t < best[1]) best = [k, t]; }
    let short = -1;
    for (let j = 0; j < n; j++) if (dist(ring[j], ring[(j + 1) % n]) < 0.1 * diag) { short = j; break; }
    if (best[1] < 30) ring.splice(best[0], 1);
    else if (short >= 0) {
      // Of the two crowded corners keep the sharper.
      const k = turn(short) < turn((short + 1) % n) ? short : (short + 1) % n;
      ring.splice(k, 1);
    } else break;
  }
  return ring;
}

/** A quadrilateral whose sides run (nearly) across and down the page, alternately (upright). */
function upright(c) {
  const n = c.length;
  const dirs = c.map((a, i) => {
    const b = c[(i + 1) % n];
    const deg = ((((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 180) + 180) % 180;
    if (deg <= 15 || deg >= 165) return true;
    if (deg >= 75 && deg <= 105) return false;
    return null;
  });
  return dirs.every(d => d !== null) && dirs.every((d, i) => d !== dirs[(i + 1) % n]);
}

/** A shaft drawn from the start of `p`: [index of its tip, the tip, the shaft's length], or null (shaft_tip). */
function shaftTip(p) {
  const tail = p[0];
  if (!tail) return null;
  const dmax = p.reduce((m, q) => Math.max(m, dist(tail, q)), 0);
  let ti = p.findIndex(q => dist(tail, q) >= dmax - Math.max(0.03 * dmax, 2));
  if (ti < 0) return null;
  let best = dist(tail, p[ti]);
  for (let i = ti + 1; i < p.length; i++) {
    const d = dist(tail, p[i]);
    if (d >= best) { ti = i; best = d; } else if (d < best - 0.5) break;
  }
  const tip = p[ti];
  const shaft = dist(tail, tip);
  if (shaft < MIN_SIZE || p.slice(0, ti + 1).some(q => segDistance(tail, tip, q) > Math.max(0.06 * shaft, 1.5))) return null;
  return [ti, tip, shaft];
}

/** Whether a head whose barbs run from `apex` to `b1` and `b2` fits a shaft from `tail` to `tip` (head_fits). */
function headFits(tail, tip, apex, b1, b2) {
  const shaft = dist(tail, tip);
  const l1 = dist(apex, b1), l2 = dist(apex, b2);
  if (!(shaft > 0 && l1 > 0 && l2 > 0)) return false;
  const back = [tail[0] - tip[0], tail[1] - tip[1]];
  const angleSide = (e, len) => {
    const u = [e[0] - apex[0], e[1] - apex[1]];
    const angle = (Math.acos(Math.min(1, Math.max(-1, (back[0] * u[0] + back[1] * u[1]) / (shaft * len)))) * 180) / Math.PI;
    return [angle, back[0] * u[1] - back[1] * u[0]];
  };
  const [a1, s1] = angleSide(b1, l1), [a2, s2] = angleSide(b2, l2);
  const ok = (l, a) => l >= BARB_LEN[0] * shaft && l <= BARB_LEN[1] * shaft && a >= BARB_ANGLE[0] && a <= BARB_ANGLE[1];
  const similar = Math.max(l1, l2) <= 2.5 * Math.min(l1, l2) && Math.abs(a1 - a2) <= 35;
  return ok(l1, a1) && ok(l2, a2) && s1 * s2 < 0 && similar;
}

/** An arrow drawn shaft first, the pen then drawing one barb, coming back to the tip and drawing the other (arrow). */
function arrow(p) {
  const tail = p[0];
  const st = shaftTip(p);
  if (!tail || !st) return null;
  const [ti, tip, shaft] = st;
  const head = p.slice(ti);
  const reach = head.reduce((m, q) => Math.max(m, dist(tip, q)), 0);
  const barbs = [];
  let out = false, gap = Infinity;
  for (const q of head) {
    const d = dist(tip, q);
    if (d > 0.25 * reach) {
      if (!out) {
        if (barbs.length === 2) return null;
        barbs.push([d, q]);
        out = true;
      } else {
        const b = barbs[barbs.length - 1];
        if (b && d > b[0]) barbs[barbs.length - 1] = [d, q];
      }
    } else {
      out = false;
      if (barbs.length === 1) gap = Math.min(gap, d);
    }
  }
  if (barbs.length !== 2) return null;
  const [[l1, b1], [l2, b2]] = barbs;
  if (gap > 0.35 * Math.min(l1, l2) || shaft <= 0) return null;
  return headFits(tail, tip, tip, b1, b2) ? {type: 'arrow', a: tail, b: tip, headAtEnd: true, headAtStart: false} : null;
}

/** An arrow with a closed triangle head, drawn shaft first (closed_arrow). */
function closedArrow(p) {
  const tail = p[0];
  const st = shaftTip(p);
  if (!tail || !st) return null;
  const [ti, tip] = st;
  const head = p.slice(ti);
  const b1 = head.reduce((m, q) => (dist(tip, q) > dist(tip, m) ? q : m), tip);
  const b2 = head.reduce((m, q) => (segDistance(tip, b1, q) > segDistance(tip, b1, m) ? q : m), tip);
  const l1 = dist(tip, b1), l2 = dist(tip, b2);
  const last = head[head.length - 1];
  if (Math.min(l1, l2) <= 0 || !last || dist(last, tip) > 0.35 * Math.min(l1, l2)) return null;
  const tri = [tip, b1, b2];
  if (head.some(q => polygonDistance(tri, q) > Math.max(0.15 * l1, 1.5))) return null;
  return headFits(tail, tip, tip, b1, b2) ? {type: 'arrow', a: tail, b: tip, headAtEnd: true, headAtStart: false} : null;
}

/** The shape `pts` draws, if it is one (recognise). */
export function recognise(pts) {
  const p = clean(pts);
  const first = p[0], last = p[p.length - 1];
  if (!first || !last || p.length < 2) return null;
  const [x0, y0, w, h] = bbox(p);
  const size = Math.max(w, h);
  const diag = Math.hypot(w, h);
  if (size < MIN_SIZE) return null;
  let length = 0;
  for (let i = 1; i < p.length; i++) length += dist(p[i - 1], p[i]);
  const gap = dist(first, last);
  // A line: the stroke barely leaves the chord between its ends and doesn't double back.
  if (gap > 0.85 * length && gap >= MIN_SIZE) {
    const off = p.reduce((m, q) => Math.max(m, segDistance(first, last, q)), 0);
    if (off <= Math.max(0.06 * gap, 1.5)) return {type: 'line', a: first, b: last};
  }
  // An arrow: a shaft and a head, drawn in one stroke (either end first).
  const rev = p.slice().reverse();
  const found = arrow(p) ?? arrow(rev) ?? closedArrow(p) ?? closedArrow(rev);
  if (found) return found;
  // Other shapes are closed: the stroke ends near where it began and goes around.
  if (gap > 0.2 * size || length < 2 * size) return null;
  const rms = ellipseRms(p, x0, y0, w, h);
  if (w > 0.2 * size && h > 0.2 * size && rms < 0.06) { const [x, y, ww, hh] = snapSquare(x0, y0, w, h); return {type: 'ellipse', x, y, w: ww, h: hh}; }
  const cs = corners(p, diag);
  const fits = cs.length >= 3 && p.every(q => polygonDistance(cs, q) <= 0.08 * diag);
  if (fits && cs.length === 4 && upright(cs)) {
    const [bx, by, bw, bh] = bbox(cs);
    const [x, y, ww, hh] = snapSquare(bx, by, bw, bh);
    return {type: 'rectangle', x, y, w: ww, h: hh};
  }
  if (fits && cs.length <= MAX_CORNERS) return {type: 'polygon', corners: cs};
  // A wobbly round stroke is still an ellipse.
  if (w > 0.2 * size && h > 0.2 * size && rms < 0.1) { const [x, y, ww, hh] = snapSquare(x0, y0, w, h); return {type: 'ellipse', x, y, w: ww, h: hh}; }
  return null;
}

/** The ways the cleaned points can be an arrowhead on their own, as [apex, barb end, barb end] (heads). */
function heads(p, found) {
  if (found?.type === 'polygon' && found.corners.length === 3) {
    const [x, y, z] = found.corners;
    return [[x, y, z], [y, z, x], [z, x, y]];
  }
  const f = p[0], l = p[p.length - 1];
  if (!f || !l) return [];
  // The apex: the point farthest from the chord between the ends.
  let ai = -1, apex = null;
  p.forEach((q, i) => { if (apex === null || segDistance(f, l, q) > segDistance(f, l, apex)) { ai = i; apex = q; } });
  if (apex === null) return [];
  const straight = (a, b, arm) => {
    const len = dist(a, b);
    return len >= 1 && arm.every(q => segDistance(a, b, q) <= Math.max(0.12 * len, 1.5));
  };
  if (ai === 0 || ai + 1 >= p.length || !straight(f, apex, p.slice(0, ai + 1)) || !straight(apex, l, p.slice(ai))) return [];
  return [[apex, f, l]];
}

/** `pts` as a possible half of a two-stroke arrow (arrow_parts): {line: [a, b] | null, heads}. */
export function arrowParts(pts) {
  const p = clean(pts);
  const found = recognise(p);
  return {line: found?.type === 'line' ? [found.a, found.b] : null, heads: heads(p, found)};
}

/** One arrow from two strokes already recognised by arrowParts (pair_parts): the arrow, or null. */
export function pairParts(line, head) {
  if (!line.line) return null;
  const [a, b] = line.line;
  let best = null;
  for (const [apex, b1, b2] of head.heads) {
    for (const [tail, tip] of [[a, b], [b, a]]) {
      const off = dist(apex, tip);
      const near = off <= Math.max(PAIR_REACH * dist(tail, tip), 3);
      if (near && (best === null || off < best[0]) && headFits(tail, tip, apex, b1, b2)) best = [off, {type: 'arrow', a: tail, b: tip, headAtEnd: true, headAtStart: false}];
    }
  }
  return best ? best[1] : null;
}
