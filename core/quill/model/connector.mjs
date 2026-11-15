// Connectors and the shape properties beyond fill and outline: a shape's drawing id, text warp,
// rounded-rectangle corner, line caps, arrowheads and a connector's glued ends.
// Translated from wordcraft crates/doc/src/connector.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A shape object's `extra` is `{id?, warp?, start?, end?, arrowStart?, arrowEnd?, corner?, dash?,
// cap?, outlineFill?}` (absent = default: 0, none, false, 'solid', 'flat'). A connector is a line
// from its frame's top-left to its bottom-right corner (flips swap corners); each end may be glued
// to a connection site of another shape (`{id, site}`, a:stCxn / a:endCxn). No DOM, no Node built-ins.

import {finite, Spin} from '../lib/geom.mjs';

export const LINE_CAPS = Object.freeze(['flat', 'square', 'round']);
/** From ST_LineCap ('sq', 'rnd'; anything else is flat). */
export const lineCapFromOoxml = v => (v === 'sq' ? 'square' : v === 'rnd' ? 'round' : 'flat');
export const lineCapOoxml = c => (c === 'square' ? 'sq' : c === 'round' ? 'rnd' : 'flat');

export const MAX_CORNER = 50_000;
export const DEFAULT_CORNER = 0.16;
export const MAX_SITE = 64;

/** Whether a shape's extra properties are all defaults. */
export function shapeExtraIsEmpty(e) {
  if (!e) return true;
  return !(e.id) && e.warp == null && e.start == null && e.end == null && !e.arrowStart && !e.arrowEnd && e.corner == null
    && (e.dash == null || e.dash === 'solid') && (e.cap == null || e.cap === 'flat') && e.outlineFill == null;
}

/** The corner radius, points, of a w × h rounded rectangle with `corner` (100000ths of the shorter side). */
export function cornerRadius(corner, w, h) {
  const side = Math.max(0, Math.min(finite(w), finite(h)));
  return side * (corner === null || corner === undefined ? DEFAULT_CORNER : Math.min(corner, MAX_CORNER) / 100_000);
}

const CONNECTORS = new Set(['straightConnector', 'elbowConnector', 'curvedConnector']);
export const isConnector = kind => CONNECTORS.has(kind);
/** A line or connector: drawn as an open path, never filled. */
export const isOpen = kind => kind === 'line' || isConnector(kind);

/** The connection sites of a kind shape w × h in its own unrotated frame, by index. */
export function sites(kind, w, h) {
  w = finite(w); h = finite(h);
  const cx = w / 2, cy = h / 2;
  switch (kind) {
    case 'ellipse': {
      const dx = cx * Math.SQRT1_2, dy = cy * Math.SQRT1_2;
      return [[cx, 0], [cx - dx, cy - dy], [0, cy], [cx - dx, cy + dy], [cx, h], [cx + dx, cy + dy], [w, cy], [cx + dx, cy - dy]];
    }
    case 'triangle': return [[cx, 0], [cx / 2, cy], [0, h], [cx, h], [w, h], [cx + cx / 2, cy]];
    case 'rightTriangle': return [[0, 0], [0, cy], [0, h], [cx, h], [w, h], [cx, cy]];
    case 'line': case 'straightConnector': case 'elbowConnector': case 'curvedConnector': return [[0, 0], [w, h]];
    default: return [[cx, 0], [0, cy], [cx, h], [w, cy]];
  }
}

/** Site `site` of a shape with frame [x, y, w, h], turned by `spin` about its centre; null if none. */
export function sitePoint(kind, rect, spin, site) {
  const [x, y, w, h] = rect;
  const s = sites(kind, w, h)[site];
  if (!s) return null;
  const cx = x + w / 2, cy = y + h / 2;
  const [px, py] = spin.apply(cx, cy, x + s[0], y + s[1]);
  return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
}

/** The site nearest to page point `at`: [index, point, distance], or null. */
export function nearestSite(kind, rect, spin, at) {
  const n = sites(kind, rect[2], rect[3]).length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const p = sitePoint(kind, rect, spin, i);
    if (!p) continue;
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (!best || d < best[2]) best = [i, p, d];
  }
  return best;
}

/** The frame of a connector from `start` to `end`: {x, y, w, h, flipH, flipV}. */
export function route(start, end) {
  const x0 = finite(start[0]), y0 = finite(start[1]), x1 = finite(end[0]), y1 = finite(end[1]);
  return {x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), flipH: x1 < x0, flipV: y1 < y0};
}

/** A connector's [start, end] from its frame (route's inverse). */
export function ends(x, y, w, h, flipH, flipV) {
  const [xa, xb] = flipH ? [x + w, x] : [x, x + w];
  const [ya, yb] = flipV ? [y + h, y] : [y, y + h];
  return [[xa, ya], [xb, yb]];
}

/** The path of a connector kind in a w × h frame at the origin, or null for other kinds. */
export function connectorSegs(kind, w, h) {
  w = finite(w); h = finite(h);
  const mx = w / 2;
  switch (kind) {
    case 'straightConnector': return [{move: [0, 0]}, {line: [w, h]}];
    case 'elbowConnector': return [{move: [0, 0]}, {line: [mx, 0]}, {line: [mx, h]}, {line: [w, h]}];
    case 'curvedConnector': return [{move: [0, 0]}, {cubic: [mx, 0, mx, h, w, h]}];
    default: return null;
  }
}

/** The unit direction a line or connector arrives at its end (`atEnd`) or leaves its start. */
export function endDirection(kind, w, h, atEnd) {
  let dx, dy;
  if (kind === 'elbowConnector' || kind === 'curvedConnector') [dx, dy] = Math.abs(w) > 0.01 || Math.abs(h) < 0.01 ? [1, 0] : [0, 1];
  else if (kind === 'line') [dx, dy] = [w, -h];
  else [dx, dy] = [w, h];
  const len = Math.hypot(dx, dy);
  const [ux, uy] = len > 1e-6 && Number.isFinite(len) ? [dx / len, dy / len] : [1, 0];
  return atEnd ? [ux, uy] : [-ux, -uy];
}

/** A float's rotation and flips (Float::spin). */
export const floatSpin = f => new Spin(f?.rot ?? 0, !!f?.flipH, !!f?.flipV);

/**
 * Re-route a group's glued connectors (connector.rs `reroute_group`). Returns the new group, or
 * the same object when nothing moved.
 */
export function rerouteGroup(group) {
  if (group?.type !== 'group') return group;
  const fin = finite;
  // Upstream divides in f32: a scale that underflows or overflows f32 counts as not invertible.
  const sx = fin(group.ch_w) > 0 ? Math.fround(fin(group.w) / group.ch_w) : 1;
  const sy = fin(group.ch_h) > 0 ? Math.fround(fin(group.h) / group.ch_h) : 1;
  const children = group.children || [];
  const shapes = [];
  for (const c of children) {
    const o = c.obj;
    if (o?.type === 'shape' && o.extra?.id) shapes.push([o.extra.id, o.kind, [c.x, c.y, o.w, o.h], floatSpin(o.float)]);
  }
  if (!shapes.length) return group;
  const find = e => {
    if (!e) return null;
    const s = shapes.find(x => x[0] === e.id);
    return s ? sitePoint(s[1], s[2], s[3], e.site) : null;
  };
  let moved = false;
  const next = children.map(c => {
    const o = c.obj;
    if (o?.type !== 'shape' || !isConnector(o.kind) || (o.extra?.start == null && o.extra?.end == null)) return c;
    const fs = find(o.extra.start), fe = find(o.extra.end);
    let s, e, fallback;
    if (fs && fe) { s = fs; e = fe; fallback = false; }
    else {
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return c;
      const x = fin(c.x) * sx, y = fin(c.y) * sy;
      const cw = Math.min(4000, Math.max(0, fin(o.w) * sx)), ch = Math.min(4000, Math.max(0, fin(o.h) * sy));
      const cx = x + cw / 2, cy = y + ch / 2;
      const spin = floatSpin(o.float);
      const s0 = spin.apply(cx, cy, x, y), e0 = spin.apply(cx, cy, x + cw, y + ch);
      s = fs ?? [s0[0] / sx, s0[1] / sy];
      e = fe ?? [e0[0] / sx, e0[1] / sy];
      fallback = true;
    }
    if (![...s, ...e].every(Number.isFinite)) return c;
    const f = route(s, e);
    if (![f.x, f.y, f.w, f.h].every(Number.isFinite)) return c;
    if (fallback && (f.w * sx > 4000 || f.h * sy > 4000)) return c;
    const fl = o.float || {};
    const same = Math.abs(f.x - c.x) < 0.01 && Math.abs(f.y - c.y) < 0.01 && Math.abs(f.w - o.w) < 0.01 && Math.abs(f.h - o.h) < 0.01;
    if (same && f.flipH === !!fl.flipH && f.flipV === !!fl.flipV && !(fl.rot)) return c;
    moved = true;
    const float = {...fl};
    delete float.rot;
    if (f.flipH) float.flipH = true; else delete float.flipH;
    if (f.flipV) float.flipV = true; else delete float.flipV;
    return {...c, x: f.x, y: f.y, obj: {...o, w: f.w, h: f.h, float}};
  });
  return moved ? {...group, children: next} : group;
}
