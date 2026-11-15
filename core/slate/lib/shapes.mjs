// Shapes drawn as ink (Draw › Shapes, Ink to Shape; U:slate/draw).
//
// Slate has no ArtCraft upstream. In OneNote a shape from the gallery is drawn by dragging on the
// page and is then ink like any other: it can be selected, moved, rotated, ordered and erased.
// Ours produces the shape as strokes (polylines, page px) that share a `group`, so they stay one
// object under the Lasso. Lines and arrows run from the drag's start to its end; every other shape
// fills the rectangle the drag spans (a circle the square at its start).
//
// Ink to Shape recognises a hand-drawn stroke: a straight run becomes a line, a closed loop a
// triangle, rectangle, diamond or oval (a circle when it is round), drawn in the same pen.
//
// No DOM, no Node built-ins.

export const SHAPES = Object.freeze(['line', 'arrow', 'double-arrow', 'rectangle', 'oval', 'circle', 'triangle', 'right-triangle', 'parallelogram', 'diamond',
  'pentagon', 'hexagon', 'trapezoid', 'cube', 'cylinder', 'cone', 'pyramid', 'graph-xy', 'graph-xyz', 'graph-quadrant', 'graph-four-quadrant']);

const f = v => Math.round(v * 10) / 10;
const flat = pts => pts.flatMap(([x, y]) => [f(x), f(y)]);

/** Points of an ellipse (or part of one) as a polyline. */
function ellipse(cx, cy, rx, ry, from = 0, to = Math.PI * 2, steps = 48) {
  const out = [];
  const n = Math.max(8, Math.round((steps * Math.abs(to - from)) / (Math.PI * 2)));
  for (let i = 0; i <= n; i++) { const a = from + ((to - from) * i) / n; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
}
const closed = pts => [...pts, pts[0]];

/** An arrowhead (two short lines) at `tip` for a line arriving from `from`. */
function head(from, tip, size) {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const w = Math.PI / 7;
  return [[tip[0] - size * Math.cos(a - w), tip[1] - size * Math.sin(a - w)], tip, [tip[0] - size * Math.cos(a + w), tip[1] - size * Math.sin(a + w)]];
}

/**
 * The polylines of a shape. `from` and `to` are the drag's corners {x, y}. Returns an array of flat
 * point lists. Unknown shapes throw.
 */
export function shapePolylines(shape, from, to) {
  const x0 = Math.min(from.x, to.x), y0 = Math.min(from.y, to.y);
  let w = Math.abs(to.x - from.x), h = Math.abs(to.y - from.y);
  const sizeHead = Math.max(5, Math.min(14, Math.hypot(w, h) * 0.18));
  const P = (u, v) => [x0 + u * w, y0 + v * h];
  switch (shape) {
    case 'line': return [flat([[from.x, from.y], [to.x, to.y]])];
    case 'arrow': return [flat([[from.x, from.y], [to.x, to.y]]), flat(head([from.x, from.y], [to.x, to.y], sizeHead))];
    case 'double-arrow': return [flat([[from.x, from.y], [to.x, to.y]]), flat(head([from.x, from.y], [to.x, to.y], sizeHead)), flat(head([to.x, to.y], [from.x, from.y], sizeHead))];
    case 'rectangle': return [flat(closed([P(0, 0), P(1, 0), P(1, 1), P(0, 1)]))];
    case 'oval': return [flat(ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2))];
    case 'circle': {
      const side = Math.max(w, h);
      const sx = to.x >= from.x ? from.x : from.x - side, sy = to.y >= from.y ? from.y : from.y - side;
      return [flat(ellipse(sx + side / 2, sy + side / 2, side / 2, side / 2))];
    }
    case 'triangle': return [flat(closed([P(0.5, 0), P(1, 1), P(0, 1)]))];
    case 'right-triangle': return [flat(closed([P(0, 0), P(1, 1), P(0, 1)]))];
    case 'parallelogram': return [flat(closed([P(0.25, 0), P(1, 0), P(0.75, 1), P(0, 1)]))];
    case 'diamond': return [flat(closed([P(0.5, 0), P(1, 0.5), P(0.5, 1), P(0, 0.5)]))];
    case 'pentagon': return [flat(closed([P(0.5, 0), P(1, 0.38), P(0.81, 1), P(0.19, 1), P(0, 0.38)]))];
    case 'hexagon': return [flat(closed([P(0.25, 0), P(0.75, 0), P(1, 0.5), P(0.75, 1), P(0.25, 1), P(0, 0.5)]))];
    case 'trapezoid': return [flat(closed([P(0.2, 0), P(0.8, 0), P(1, 1), P(0, 1)]))];
    case 'cube': return [flat(closed([P(0, 0.3), P(0.7, 0.3), P(0.7, 1), P(0, 1)])), flat([P(0, 0.3), P(0.3, 0), P(1, 0), P(1, 0.7), P(0.7, 1)]), flat([P(0.7, 0.3), P(1, 0)])];
    case 'cylinder': {
      const ry = 0.15 * h;
      return [flat(ellipse(x0 + w / 2, y0 + ry, w / 2, ry)), flat([[x0, y0 + ry], [x0, y0 + h - ry]]), flat([[x0 + w, y0 + ry], [x0 + w, y0 + h - ry]]),
        flat(ellipse(x0 + w / 2, y0 + h - ry, w / 2, ry, 0, Math.PI, 24))];
    }
    case 'cone': {
      const ry = 0.15 * h;
      return [flat([[x0, y0 + h - ry], [x0 + w / 2, y0], [x0 + w, y0 + h - ry]]), flat(ellipse(x0 + w / 2, y0 + h - ry, w / 2, ry))];
    }
    case 'pyramid': return [flat(closed([P(0.5, 0), P(0, 0.8), P(0.5, 1), P(1, 0.8)])), flat([P(0.5, 0), P(0.5, 1)]), flat([P(0, 0.8), P(1, 0.8)])];
    case 'graph-xy': return [flat([P(0, 0.5), P(1, 0.5)]), flat([P(0.5, 1), P(0.5, 0)]), flat(head(P(0, 0.5), P(1, 0.5), sizeHead * 0.8)), flat(head(P(1, 0.5), P(0, 0.5), sizeHead * 0.8)),
      flat(head(P(0.5, 1), P(0.5, 0), sizeHead * 0.8)), flat(head(P(0.5, 0), P(0.5, 1), sizeHead * 0.8))];
    case 'graph-xyz': return [flat([P(0.15, 0.7), P(1, 0.7)]), flat([P(0.15, 0.7), P(0.15, 0)]), flat([P(0.15, 0.7), P(0, 1)]), flat(head(P(0.15, 0.7), P(1, 0.7), sizeHead * 0.8)),
      flat(head(P(0.15, 0.7), P(0.15, 0), sizeHead * 0.8)), flat(head(P(0.15, 0.7), P(0, 1), sizeHead * 0.8))];
    case 'graph-quadrant': return [flat([P(0, 1), P(1, 1)]), flat([P(0, 1), P(0, 0)]), flat(head(P(0, 1), P(1, 1), sizeHead * 0.8)), flat(head(P(0, 1), P(0, 0), sizeHead * 0.8))];
    case 'graph-four-quadrant': {
      const ticks = [];
      for (let i = 1; i <= 3; i++) for (const t of [0.5 - i * 0.125, 0.5 + i * 0.125]) { ticks.push(flat([P(t, 0.5 - 0.02), P(t, 0.5 + 0.02)])); ticks.push(flat([P(0.5 - 0.02 * (h ? w / h : 1), t), P(0.5 + 0.02 * (h ? w / h : 1), t)])); }
      return [flat([P(0, 0.5), P(1, 0.5)]), flat([P(0.5, 1), P(0.5, 0)]), flat(head(P(0, 0.5), P(1, 0.5), sizeHead * 0.8)), flat(head(P(1, 0.5), P(0, 0.5), sizeHead * 0.8)),
        flat(head(P(0.5, 1), P(0.5, 0), sizeHead * 0.8)), flat(head(P(0.5, 0), P(0.5, 1), sizeHead * 0.8)), ...ticks];
    }
    default: throw new Error(`Unknown shape ${shape}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Ink to Shape

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pairs = pts => { const o = []; for (let i = 0; i + 1 < pts.length; i += 2) o.push([pts[i], pts[i + 1]]); return o; };

function pathLength(p) { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; }
function perpendicular(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len ? Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len : dist(p, a);
}
/** Douglas-Peucker: the corners of a path within `eps`. */
function simplify(p, eps) {
  if (p.length < 3) return p.slice();
  let max = 0, at = 0;
  for (let i = 1; i < p.length - 1; i++) { const d = perpendicular(p[i], p[0], p[p.length - 1]); if (d > max) { max = d; at = i; } }
  if (max <= eps) return [p[0], p[p.length - 1]];
  return [...simplify(p.slice(0, at + 1), eps).slice(0, -1), ...simplify(p.slice(at), eps)];
}
const area = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; };

/**
 * What a hand-drawn stroke is meant to be: {shape, from, to} for shapePolylines, or null when it
 * is a scribble (a stroke shorter than 24 px, or one that fits none of the shapes).
 */
export function recognize(points) {
  const p = pairs(points);
  if (p.length < 4) return null;
  const len = pathLength(p);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (len < 24 || diag < 16) return null;
  const gap = dist(p[0], p[p.length - 1]);
  // A straight run: no point strays far from the chord.
  const bow = Math.max(...p.map(q => perpendicular(q, p[0], p[p.length - 1])));
  if (gap > len * 0.5 && bow <= Math.max(4, len * 0.06)) return {shape: 'line', from: {x: p[0][0], y: p[0][1]}, to: {x: p[p.length - 1][0], y: p[p.length - 1][1]}};
  // A closed loop: the ends meet.
  if (gap > Math.max(diag * 0.3, 14)) return null;
  const loop = p.concat([p[0]]);
  const corners = simplify(loop, Math.max(4, diag * 0.09));
  const vertices = corners.length - 1;
  const circularity = (4 * Math.PI * area(p)) / (len * len);
  const box = {from: {x: x0, y: y0}, to: {x: x1, y: y1}};
  if (vertices === 3) return {shape: 'triangle', ...box};
  if (vertices === 4) {
    // Corners on the box's edges mean a rectangle; corners at the middles of its sides a diamond.
    const near = (c, ex, ey) => Math.abs(c[0] - ex) <= w * 0.2 && Math.abs(c[1] - ey) <= h * 0.2;
    const mids = corners.slice(0, 4).filter(c => near(c, (x0 + x1) / 2, y0) || near(c, (x0 + x1) / 2, y1) || near(c, x0, (y0 + y1) / 2) || near(c, x1, (y0 + y1) / 2)).length;
    if (mids >= 3) return {shape: 'diamond', ...box};
    return {shape: 'rectangle', ...box};
  }
  if (circularity > 0.78 && vertices >= 5) {
    const round = Math.abs(w - h) <= Math.max(w, h) * 0.18;
    return round ? {shape: 'circle', from: {x: x0, y: y0}, to: {x: x0 + Math.max(w, h), y: y0 + Math.max(w, h)}} : {shape: 'oval', ...box};
  }
  return null;
}
