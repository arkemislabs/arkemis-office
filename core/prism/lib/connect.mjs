// Connectors glued to shapes: connection sites, snapping line ends to them, and rerouting attached
// connectors whenever the shapes they connect move, resize or rotate.
// Translated from deckcraft crates/engine/src/connect.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Foundation-owned (F:prism).
// No DOM, no Node built-ins.
//
// A connector's ends are `kind: {type:'connector', start: [shapeId, site] | null, end: ...}`
// (deckcraft serde `Option<(ShapeId, u32)>`). Functions take the presentation and the slide id
// whose shapes they look at; `shapes` is that slide's (possibly edited) shape list.

import {shapeGeometry} from '../model/render.mjs';
import {isLine} from '../model/presentation.mjs';
import {xfrmAffine, xfrmBounds} from '../model/geom/index.mjs';
import {apply, pt, rectInset, rectContains, hypot, sub, rectFromPoints} from '../model/geom/kurbo.mjs';
import {ctxForSlide, xfrm as resolveXfrm} from '../model/resolve.mjs';

/** deckcraft `cmd::xfrm_of` on a slide whose shape list may be a working copy. */
export function boxOf(content, sl, sh) {
  const ctx = sl ? ctxForSlide(content, sl) : null;
  return (ctx ? resolveXfrm(ctx, sh) : sh.xfrm) ?? {x: 0, y: 0, w: 0, h: 0};
}

/** Connection sites of `s` in slide coordinates (index = site index stored on connectors). */
export function sites(content, sl, s) {
  if (isLine(s) || s.kind?.type === 'group' || s.kind?.type === 'ink') return [];
  const x = boxOf(content, sl, s);
  let local = shapeGeometry(s, x.w, x.h).sites ?? [];
  if (!local.length) local = [pt(x.w / 2, 0), pt(0, x.h / 2), pt(x.w / 2, x.h), pt(x.w, x.h / 2)];
  const a = xfrmAffine(x);
  return local.map(p => apply(a, p));
}

/** The nearest connection site within `radius` of `p` on any visible shape except `exclude`: [id, site, point]. */
export function nearestSite(content, sl, shapes, p, radius, exclude = null) {
  let best = null;
  for (const s of shapes) {
    if (s.id === exclude || s.hidden) continue;
    sites(content, sl, s).forEach((q, i) => {
      const d = hypot(sub(q, p));
      if (d <= radius && (!best || d < best[0])) best = [d, s.id, i, q];
    });
  }
  return best ? [best[1], best[2], best[3]] : null;
}

/** The shape whose sites should show while drawing or dragging a connector end near `p`. */
export function siteShapeAt(content, sl, shapes, p, margin, exclude = null) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.id === exclude || s.hidden || isLine(s) || s.kind?.type === 'ink') continue;
    if (rectContains(rectInset(xfrmBounds(boxOf(content, sl, s)), margin), p)) return s.id;
  }
  return null;
}

/** Line endpoints (start, end) of a line-like shape's box. */
export function endpoints(x) {
  const a = xfrmAffine(x);
  return [apply(a, pt(0, 0)), apply(a, pt(x.w, x.h))];
}

/** A line-like shape's box for endpoints `a` → `b` (flips encode direction): deckcraft `tools::line_xfrm`. */
export function lineXfrm(a, b) {
  const r = rectFromPoints(a, b);
  const out = {x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0};
  if (b.x < a.x) out.flipH = true;
  if (b.y < a.y) out.flipV = true;
  return out;
}

/**
 * Move the ends of connectors glued to shapes on slide `sl` to the current site positions;
 * connections to shapes that no longer exist are dropped. Mutates `sl.shapes` (a working copy).
 */
export function reroute(content, sl) {
  const list = sl.shapes;
  if (!list.some(s => s.kind?.type === 'connector' && (s.kind.start || s.kind.end))) return;
  const snapshot = list.slice();
  const site = (id, idx) => {
    const s = snapshot.find(x => x.id === id);
    if (!s) return null;
    const v = sites(content, sl, s);
    return v[idx] ?? v[0] ?? null;
  };
  snapshot.forEach((s, i) => {
    if (s.kind?.type !== 'connector') return;
    const {start, end} = s.kind;
    if (!start && !end) return;
    const x = boxOf(content, sl, s);
    let [p0, p1] = endpoints(x);
    const a = start ? site(start[0], start[1]) : null;
    const b = end ? site(end[0], end[1]) : null;
    if (a) p0 = a;
    if (b) p1 = b;
    const nx = lineXfrm(p0, p1);
    const changed = Math.abs(nx.x - x.x) > 1e-6 || Math.abs(nx.y - x.y) > 1e-6 || Math.abs(nx.w - x.w) > 1e-6 || Math.abs(nx.h - x.h) > 1e-6
      || !!nx.flipH !== !!x.flipH || !!nx.flipV !== !!x.flipV;
    const dropA = !!start && !a, dropB = !!end && !b;
    if (changed || dropA || dropB) {
      const kind = {...s.kind};
      if (dropA) kind.start = null;
      if (dropB) kind.end = null;
      list[i] = {...s, xfrm: nx, kind};
    }
  });
}

/**
 * Glue end `end` (0 = start, 1 = end) of line `id` to `to` ([shapeId, site]) or unglue with null.
 * Plain lines become connectors when glued. Mutates `list` (a working copy).
 */
export function setGlue(list, id, end, to) {
  const i = list.findIndex(s => s.id === id);
  if (i < 0) return;
  let s = list[i];
  if (s.kind?.type !== 'connector') {
    if (!to || s.kind?.type !== 'shape') return;
    s = {...s, kind: {type: 'connector', start: null, end: null}};
  }
  const kind = {...s.kind};
  if (end === 0) kind.start = to ? [to[0], to[1]] : null;
  else kind.end = to ? [to[0], to[1]] : null;
  list[i] = {...s, kind};
}
