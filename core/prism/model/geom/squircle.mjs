// Rectangles with smoothed ("squircle") corners.
// Translated from deckcraft crates/geom/src/squircle.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// For a corner of radius r and smoothing s (0 = circular, 1 = no arc left), the corner takes
// p = (1 + s)·r of each edge. The arc keeps 90°·(1 − s) around the corner's diagonal and each
// side of it is a cubic whose handles lie on the edge. When p would exceed half the shorter side,
// the smoothing is reduced first, then the radius.

const round = v => Math.round(v * 1000) / 1000 + 0;
const num = v => String(round(v));

/** The outline of a w × h rectangle with corners of radius `radius` smoothed by `smoothing` (0..1), as path data. */
export function pathD(wIn, hIn, radius, smoothing) {
  const w = Number.isFinite(wIn) ? Math.max(wIn, 0) : 0;
  const h = Number.isFinite(hIn) ? Math.max(hIn, 0) : 0;
  const half = Math.min(w, h) / 2;
  const r = Number.isFinite(radius) ? Math.min(Math.max(radius, 0), half) : 0;
  let s = Number.isFinite(smoothing) ? Math.min(Math.max(smoothing, 0), 1) : 0;
  if (r <= 0) return `M 0 0 L ${num(w)} 0 L ${num(w)} ${num(h)} L 0 ${num(h)} Z`;
  s = Math.max(Math.min(s, half / r - 1), 0);
  const c = corner(r, s);
  const corners = [
    (u, v) => [w - u, v], // top right
    (u, v) => [w - v, h - u], // bottom right
    (u, v) => [u, h - v], // bottom left
    (u, v) => [v, u], // top left
  ];
  const p = (f, [u, v]) => { const [x, y] = f(u, v); return `${num(x)} ${num(y)}`; };
  let d = '';
  corners.forEach((f, i) => {
    const segs = segments(c);
    d += i === 0 ? `M ${p(f, segs[0])}` : ` L ${p(f, segs[0])}`;
    for (let k = 0; k < 3; k++) {
      const b = 1 + k * 3;
      d += ` C ${p(f, segs[b])} ${p(f, segs[b + 1])} ${p(f, segs[b + 2])}`;
    }
  });
  return d + ' Z';
}

/** One corner in (u, v) terms: distance back along the incoming edge, distance along the outgoing. */
export function corner(r, s) {
  const p = (1 + s) * r;
  const arc = (Math.PI / 2) * (1 - s);
  const arcChord = Math.sin(arc / 2) * r * Math.SQRT2;
  const alpha = (Math.PI / 2 - arc) / 2;
  const p3p4 = r * Math.tan(alpha / 2);
  const beta = (Math.PI / 4) * s;
  const c = p3p4 * Math.cos(beta);
  const d = c * Math.tan(beta);
  const b = Math.max((p - arcChord - c - d) / 3, 0);
  const a = 2 * b;
  return {p, a, b, c, d, r, arc};
}

/** Ten points: the start on the incoming edge, then three cubics (edge → arc, arc, arc → edge). */
export function segments({p, a, b, r, arc}) {
  const e0 = [p, 0], e1 = [p - a, 0], e2 = [p - a - b, 0];
  const start = (Math.PI / 4) * 5 + arc / 2;
  const end = start - arc;
  const at = t => [r + r * Math.cos(t), r + r * Math.sin(t)];
  const k = (4 / 3) * Math.tan(arc / 4) * r;
  const a0 = at(start), a3 = at(end);
  const a1 = [a0[0] + k * Math.sin(start), a0[1] - k * Math.cos(start)];
  const a2 = [a3[0] - k * Math.sin(end), a3[1] + k * Math.cos(end)];
  return [e0, e1, e2, a0, a1, a2, a3, [e2[1], e2[0]], [e1[1], e1[0]], [e0[1], e0[0]]];
}
