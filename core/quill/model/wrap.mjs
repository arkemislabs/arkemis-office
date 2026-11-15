// Wrap outlines: the shape text follows around a floating object with Tight or Through wrapping
// (ECMA-376 Part 1 §20.4.2.16 wrapPolygon, §20.4.2.17 wrapThrough, §20.4.2.18 wrapTight).
// Translated from wordcraft crates/doc/src/wrap.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A wrap polygon `{edited, points: [[x, y]...]}` is in a space where 21600 spans the object's
// width or height. Without one, an outline is derived: a shape's geometry, flattened; a
// picture's opaque pixels (alphaOutline); anything else its rectangle. Upstream works in f32;
// outlines here are doubles. No DOM, no Node built-ins.

import {cornerRadius} from './connector.mjs';

export const WRAP_SPACE = 21_600;
export const MAX_WRAP_POINTS = 1024;
export const MAX_DERIVED_POINTS = 64;
const MAX_COORD = WRAP_SPACE * 4;

const clampCoord = v => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(-MAX_COORD, Math.min(MAX_COORD, Math.trunc(n)));
};

/** A polygon from raw coordinates: clamped, capped at MAX_WRAP_POINTS; null with fewer than 3 points. */
export function wrapPolygon(edited, points) {
  const pts = [];
  for (const [x, y] of points) { if (pts.length >= MAX_WRAP_POINTS) break; pts.push([clampCoord(x), clampCoord(y)]); }
  return pts.length >= 3 ? {edited: !!edited, points: pts} : null;
}
/** From an outline in unit coordinates (0..1 across the object). */
export function wrapPolygonFromUnit(edited, pts) {
  return wrapPolygon(edited, pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).map(([x, y]) => [Math.round(x * WRAP_SPACE), Math.round(y * WRAP_SPACE)]));
}
/** The points in unit coordinates. */
export const wrapPolygonUnit = p => (p?.points || []).slice(0, MAX_WRAP_POINTS).map(([x, y]) => [x / WRAP_SPACE, y / WRAP_SPACE]);

/** A block arrow's outline in unit coordinates, pointing the way `kind` says (right by default). */
export function arrowOutline(kind, w, h) {
  const vertical = kind === 'arrowUp' || kind === 'arrowDown';
  const [len, thick] = vertical ? [h, w] : [w, h];
  const head = len > 0 ? Math.min(0.5 * thick / len, 1) : 0.5;
  const right = [[0, 0.3], [1 - head, 0.3], [1 - head, 0], [1, 0.5], [1 - head, 1], [1 - head, 0.7], [0, 0.7]];
  return right.map(([u, v]) => (kind === 'arrowLeft' ? [1 - u, v] : kind === 'arrowUp' ? [v, 1 - u] : kind === 'arrowDown' ? [v, u] : [u, v]));
}

/**
 * A shape's outline in unit coordinates (0..1 across a w × h frame), flattened to lines; null for
 * shapes whose outline is their rectangle. `corner` is a rounded rectangle's.
 */
export function shapeOutline(kind, w, h, corner = null) {
  const pos = v => (Number.isFinite(v) ? Math.min(1e6, Math.max(0, v)) : 0);
  w = pos(w); h = pos(h);
  const {PI} = Math, HALF = PI / 2, TAU = 2 * PI;
  switch (kind) {
    case 'rectangle': case 'textBox': case 'line': case 'freeform': case 'straightConnector': case 'elbowConnector': case 'curvedConnector':
      return null;
    case 'ellipse': case 'flowchartOr':
      return Array.from({length: 48}, (_, i) => { const a = i * TAU / 48; return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]; });
    case 'roundedRectangle': {
      const r = cornerRadius(corner, w, h);
      const [rx, ry] = w > 0 && h > 0 ? [r / w, r / h] : [0, 0];
      const pts = [];
      for (const [cx, cy, a0] of [[1 - rx, 1 - ry, 0], [rx, 1 - ry, HALF], [rx, ry, PI], [1 - rx, ry, PI + HALF]]) {
        for (let k = 0; k <= 6; k++) { const a = a0 + HALF * k / 6; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
      }
      return pts;
    }
    case 'triangle': return [[0.5, 0], [1, 1], [0, 1]];
    case 'rightTriangle': return [[0, 0], [1, 1], [0, 1]];
    case 'diamond': return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    case 'arrow': case 'arrowLeft': case 'arrowUp': case 'arrowDown': return arrowOutline(kind, w, h);
    case 'star':
      return Array.from({length: 10}, (_, i) => { const a = PI * i / 5 - HALF; const r = i % 2 === 0 ? 0.5 : 0.2; return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]; });
    case 'heart': {
      const curves = [
        [[0.5, 0.3], [0.5, 0], [0, 0], [0, 0.3]],
        [[0, 0.3], [0, 0.6], [0.4, 0.75], [0.5, 1]],
        [[0.5, 1], [0.6, 0.75], [1, 0.6], [1, 0.3]],
        [[1, 0.3], [1, 0], [0.5, 0], [0.5, 0.3]],
      ];
      const pts = [];
      for (const [p0, p1, p2, p3] of curves) {
        for (let k = 0; k < 10; k++) {
          const t = k / 10, u = 1 - t;
          const b = (a, bb, c, d) => u * u * u * a + 3 * u * u * t * bb + 3 * u * t * t * c + t * t * t * d;
          pts.push([b(p0[0], p1[0], p2[0], p3[0]), b(p0[1], p1[1], p2[1], p3[1])]);
        }
      }
      return pts;
    }
    default: return null;
  }
}

/** Largest side of the grid alphaOutline looks at. */
export const ALPHA_GRID = 48;

function convexHull(input) {
  const pts = input.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull = [];
  for (let pass = 0; pass < 2; pass++) {
    const start = hull.length;
    const seq = pass === 0 ? pts : pts.slice().reverse();
    for (const p of seq) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  return hull;
}

function simplifyConvex(pts, max) {
  pts = pts.slice();
  while (pts.length > Math.max(max, 3)) {
    const n = pts.length;
    let best = 0, bestArea = Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (area < bestArea) { bestArea = area; best = i; }
    }
    pts.splice(best, 1);
  }
  return pts;
}

/**
 * The outline of a picture's opaque pixels in unit coordinates: the convex hull of the cells of
 * a gw × gh grid that `opaque(x, y)` says hold visible pixels, at most MAX_DERIVED_POINTS points.
 * null when every cell is opaque (or none is).
 */
export function alphaOutline(gw, gh, opaque) {
  gw = Math.min(1024, Math.max(1, gw | 0)); gh = Math.min(1024, Math.max(1, gh | 0));
  const pts = [];
  let full = true;
  for (let y = 0; y < gh; y++) {
    let first = -1;
    for (let x = 0; x < gw; x++) if (opaque(x, y)) { first = x; break; }
    if (first < 0) { full = false; continue; }
    let last = first;
    for (let x = gw - 1; x >= first; x--) if (opaque(x, y)) { last = x; break; }
    full = full && first === 0 && last + 1 === gw;
    pts.push([first, y], [first, y + 1], [last + 1, y], [last + 1, y + 1]);
  }
  if (full || !pts.length) return null;
  const hull = simplifyConvex(convexHull(pts), MAX_DERIVED_POINTS);
  return hull.length >= 3 ? hull.map(([x, y]) => [x / gw, y / gh]) : null;
}
