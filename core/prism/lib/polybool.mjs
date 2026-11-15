// Boolean operations on filled areas (Shape Format › Merge Shapes): union, intersection, difference
// and exclusive-or of polygon sets under the non-zero winding rule, plus Fragment's arrangement.
// deckcraft uses the i_overlay crate; this is the same result by a plain arrangement: every edge is
// split where it meets another, each piece is kept when the answer differs on its two sides, and the
// kept pieces are linked into rings. An area is `[[x, y][]]`: closed rings (no repeated first point).
// Plain JS, no DOM. MIT, see assets/third-party-licenses/artcraft-reference.txt.

const key = p => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;

/** Winding number of `p` against the rings of an area. */
export function winding(area, p) {
  let w = 0;
  for (const ring of area) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      if (a[1] <= p[1]) {
        if (b[1] > p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) > 0) w++;
      } else if (b[1] <= p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) < 0) w--;
    }
  }
  return w;
}

/** Signed area of a ring (positive counter-clockwise in a y-up system). */
export const ringArea = r => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
/** Absolute area of an area (rings summed, holes counted as the winding says they are: even-odd by nesting is not needed here). */
export const areaSize = area => Math.abs(area.reduce((s, r) => s + ringArea(r), 0));

function intersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  const qp = [c[0] - a[0], c[1] - a[1]];
  if (Math.abs(den) < 1e-12) {
    // Parallel: overlapping collinear edges contribute their end points.
    if (Math.abs(qp[0] * r[1] - qp[1] * r[0]) > 1e-9 * (Math.abs(r[0]) + Math.abs(r[1]) + 1)) return [];
    const len2 = r[0] * r[0] + r[1] * r[1];
    if (!len2) return [];
    return [(qp[0] * r[0] + qp[1] * r[1]) / len2, ((d[0] - a[0]) * r[0] + (d[1] - a[1]) * r[1]) / len2].filter(t => t > 1e-9 && t < 1 - 1e-9);
  }
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  return t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9 && t > 1e-9 && t < 1 - 1e-9 ? [t] : [];
}

/** `rule(inA, inB)` over areas `a` and `b`; the boundary of the result as rings. */
export function overlay(a, b, rule) {
  if (!a.length && !b.length) return [];
  const segs = [];
  for (const [area] of [[a], [b]]) for (const ring of area) for (let i = 0; i < ring.length; i++) segs.push([ring[i], ring[(i + 1) % ring.length]]);
  const pts = segs.map(() => []);
  const bb = segs.map(([p, q]) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of bb) { minX = Math.min(minX, s[0]); minY = Math.min(minY, s[1]); maxX = Math.max(maxX, s[2]); maxY = Math.max(maxY, s[3]); }
  const eps = Math.max(Math.max(maxX - minX, maxY - minY) * 1e-5, 1e-6);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (bb[i][0] > bb[j][2] + 1e-9 || bb[j][0] > bb[i][2] + 1e-9 || bb[i][1] > bb[j][3] + 1e-9 || bb[j][1] > bb[i][3] + 1e-9) continue;
    for (const t of intersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) pts[i].push(t);
    for (const t of intersect(segs[j][0], segs[j][1], segs[i][0], segs[i][1])) pts[j].push(t);
  }
  const seen = new Set(), out = [];
  segs.forEach(([p, q], i) => {
    const ts = [0, ...pts[i].sort((x, y) => x - y), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const s = k === 0 ? p : [p[0] + (q[0] - p[0]) * ts[k], p[1] + (q[1] - p[1]) * ts[k]];
      const e = k + 2 === ts.length ? q : [p[0] + (q[0] - p[0]) * ts[k + 1], p[1] + (q[1] - p[1]) * ts[k + 1]];
      const ks = key(s), ke = key(e);
      if (ks === ke) continue;
      const id = ks < ke ? `${ks}|${ke}` : `${ke}|${ks}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const dx = e[0] - s[0], dy = e[1] - s[1], len = Math.hypot(dx, dy);
      const m = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2], nx = (-dy / len) * eps, ny = (dx / len) * eps;
      const L = [m[0] + nx, m[1] + ny], R = [m[0] - nx, m[1] - ny];
      const left = rule(winding(a, L) !== 0, winding(b, L) !== 0), right = rule(winding(a, R) !== 0, winding(b, R) !== 0);
      if (left === right) continue;
      out.push(left ? [s, e] : [e, s]);
    }
  });
  const from = new Map();
  out.forEach((sg, i) => { const k = key(sg[0]); (from.get(k) ?? from.set(k, []).get(k)).push(i); });
  const used = new Array(out.length).fill(false), rings = [];
  for (let i = 0; i < out.length; i++) {
    if (used[i]) continue;
    const ring = [];
    let cur = i;
    while (cur !== -1 && !used[cur]) {
      used[cur] = true;
      ring.push(out[cur][0]);
      const next = (from.get(key(out[cur][1])) ?? []).find(j => !used[j]);
      cur = next === undefined ? -1 : next;
    }
    if (ring.length > 2) rings.push(ring);
  }
  return rings;
}

const union = (x, y) => overlay(x, y, (p, q) => p || q);
const inter = (x, y) => overlay(x, y, (p, q) => p && q);
const diff = (x, y) => overlay(x, y, (p, q) => p && !q);
const xor = (x, y) => overlay(x, y, (p, q) => p !== q);

/** The merged areas for `op` (one per resulting shape), deckcraft merge.rs `merge_areas`. */
export function mergeAreas(op, areas) {
  if (!areas.length) return [];
  const [first, ...rest] = areas;
  const fold = f => rest.reduce((acc, b) => (!acc.length && f === union ? b : f(acc, b)), first);
  let out;
  if (op === 'union') out = [fold(union)];
  else if (op === 'combine') out = [fold(xor)];
  else if (op === 'intersect') out = [fold(inter)];
  else if (op === 'subtract') out = [diff(first, rest.reduce((acc, b) => union(acc, b), []))];
  else {
    // Fragment: every region of the arrangement becomes its own shape.
    let pieces = [first], covered = first;
    for (const b of rest) {
      const next = [];
      for (const p of pieces) { next.push(inter(p, b)); next.push(diff(p, b)); }
      next.push(diff(b, covered));
      covered = union(covered, b);
      pieces = next;
    }
    out = pieces;
  }
  return out.filter(a => a.length && areaSize(a) > 0.01);
}
