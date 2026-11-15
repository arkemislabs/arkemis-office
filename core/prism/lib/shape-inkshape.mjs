// Draw › Ink to Shape: recognise a hand-drawn stroke as a line, rectangle, ellipse or triangle.
// A stroke is closed when its ends meet; a closed stroke is classified by how much of its bounding
// box it covers (rectangle ≈ 1, ellipse ≈ π/4, triangle ≈ ½) and, for ellipses, by how evenly it
// keeps its distance from the centre.
// Translated from deckcraft crates/engine/src/inkshape.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/shape. No DOM, no Node built-ins.

/** Strokes smaller than this (points) stay ink. */
const MIN_SIZE = 6;
const MAX_POINTS = 100000;

/**
 * `recognize`: `points` as `[x, y]` pairs → `{kind:'line', x0, y0, x1, y1}` |
 * `{kind:'rect'|'ellipse', x, y, w, h}` | `{kind:'triangle', x, y, w, h, flipV}` | null.
 */
export function recognize(points) {
  const pts = [];
  for (const q of points ?? []) {
    if (pts.length >= MAX_POINTS) break;
    if (Number.isFinite(q?.[0]) && Number.isFinite(q?.[1])) pts.push([q[0], q[1]]);
  }
  if (pts.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = x1 - x0, h = y1 - y0;
  const size = Math.max(w, h);
  if (!Number.isFinite(size) || size < MIN_SIZE) return null;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (length <= 0) return null;
  // Open stroke: a line if nearly straight, otherwise not a shape.
  if (gap > 0.25 * size) return gap / length > 0.92 ? {kind: 'line', x0: first[0], y0: first[1], x1: last[0], y1: last[1]} : null;
  // Closed but flat: a line drawn back and forth isn't a shape.
  if (Math.min(w, h) < 0.15 * size) return null;
  // Covered area (shoelace, the gap closed) over the bounding box.
  let a2 = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  const cover = (Math.abs(a2) / 2) / (w * h);
  // Ellipse fit: distance from the centre in box-normalised units should stay near 1.
  const cx = x0 + w / 2, cy = y0 + h / 2;
  let spread = 0;
  for (const [x, y] of pts) spread += Math.abs(Math.hypot((x - cx) / (w / 2), (y - cy) / (h / 2)) - 1);
  spread /= pts.length;
  if (cover > 0.86) return {kind: 'rect', x: x0, y: y0, w, h};
  if (cover > 0.66 && spread < 0.12) return {kind: 'ellipse', x: x0, y: y0, w, h};
  if (cover >= 0.35 && cover < 0.66) {
    // Apex: the side of the box with fewer points near it is where the triangle narrows.
    const nearTop = pts.filter(([, y]) => y < y0 + h * 0.15).length;
    const nearBottom = pts.filter(([, y]) => y > y1 - h * 0.15).length;
    return {kind: 'triangle', x: x0, y: y0, w, h, flipV: nearBottom < nearTop};
  }
  return null;
}
