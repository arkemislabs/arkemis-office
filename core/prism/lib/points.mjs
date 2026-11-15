// Edit Points path editing: parse a freeform's path data into segments, move, add and delete its
// vertices, change point and segment types, open and close outlines, and refit the shape's box.
// A segment is {t: 'M'|'L'|'C'|'Q'|'Z', pts: [{x, y}…]}: M and L hold their point, C its two control
// points then its end, Q its control point then its end. A vertex is named by the index of the
// segment that ends on it.
// Translated from deckcraft crates/engine/src/cmd/points.rs (`parse`, `write`, `vertices`, `move_vertex`,
// `split`, `remove_vertex`, `set_type`, `point_kind`, `set_handle`, `open_at`, `close_at`,
// `delete_segment_at`, `refit`, `segment_at`, `slide_vertices`, `slide_handles`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Plain JS, no DOM.

const P = (x, y) => ({x, y});
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const add = (a, b) => P(a.x + b.x, a.y + b.y);
const mul = (a, k) => P(a.x * k, a.y * k);
const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const hyp = a => Math.hypot(a.x, a.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const seg = (t, ...pts) => ({t, pts});
const end = s => (s && s.t !== 'Z' ? s.pts[s.pts.length - 1] : null);
const isM = s => s?.t === 'M';

/** Parses path data (`M x y L x y C … Q … Z`); malformed commands are skipped, a closing edge is made explicit. */
export function parse(d) {
  const toks = String(d ?? '').split(/[\s,]+/).filter(Boolean);
  const num = i => { const v = Number(toks[i]); return toks[i] !== undefined && Number.isFinite(v) ? v : undefined; };
  const pt = i => { const x = num(i), y = num(i + 1); return x === undefined || y === undefined ? null : P(x, y); };
  const out = [];
  let i = 0;
  while (i < toks.length && out.length < 100_000) {
    let s = null, n = 1;
    switch (toks[i]) {
      case 'M': { const a = pt(i + 1); s = a && seg('M', a); n = 3; break; }
      case 'L': { const a = pt(i + 1); s = a && seg('L', a); n = 3; break; }
      case 'C': { const a = pt(i + 1), b = pt(i + 3), c = pt(i + 5); s = a && b && c && seg('C', a, b, c); n = 7; break; }
      case 'Q': { const a = pt(i + 1), b = pt(i + 3); s = a && b && seg('Q', a, b); n = 5; break; }
      case 'Z': s = seg('Z'); break;
      default: break;
    }
    if (s?.t === 'Z') {
      const start = [...out].reverse().find(isM)?.pts[0];
      const e = end(out.at(-1));
      if (start && e && hyp(sub(start, e)) > 1e-6) out.push(seg('L', start));
    }
    if (s) {
      if (!out.length && s.t === 'L') s = seg('M', s.pts[0]);
      else if (!out.length && s.t !== 'M') { i += n; continue; }
      out.push(s);
    }
    i += n;
  }
  return out;
}

const f = v => { const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; };
const pp = q => `${f(q.x)} ${f(q.y)}`;
/** Path data for `segs`. */
export const write = segs => segs.map(s => (s.t === 'Z' ? 'Z' : `${s.t} ${s.pts.map(pp).join(' ')}`)).join(' ');

/** Whether segment `i` ends back on its sub-path's start right before a `Z` (the closing edge of a closed outline). */
function closesOntoStart(segs, i) {
  if (segs[i + 1]?.t !== 'Z') return false;
  const start = [...segs.slice(0, i + 1)].reverse().find(isM)?.pts[0];
  const e = end(segs[i]);
  return !!start && !!e && !isM(segs[i]) && hyp(sub(start, e)) < 1e-6;
}

/** The segments whose end is a vertex, in order. */
export const vertices = segs => segs.map((_, i) => i).filter(i => end(segs[i]) && !closesOntoStart(segs, i));

const shift = (segs, i, which, d) => { const s = segs[i]; if (s) for (const w of which) if (s.pts[w]) s.pts[w] = add(s.pts[w], d); };
const endPoints = s => (s?.t === 'C' ? [1, 2] : s?.t === 'Q' ? [1] : s?.t === 'M' || s?.t === 'L' ? [0] : []);

/** The closing edge of the closed sub-path starting at move `si`, or undefined. */
function closeOf(segs, si) {
  for (let j = si + 1; j < segs.length && !isM(segs[j]); j++) if (closesOntoStart(segs, j)) return j;
  return undefined;
}

/** Moves the vertex ending segment `si` by `d`, with the control points attached to it. */
export function moveVertex(segs, si, d) {
  const close = isM(segs[si]) ? closeOf(segs, si) : undefined;
  shift(segs, si, endPoints(segs[si]), d);
  if (segs[si + 1]?.t === 'C') shift(segs, si + 1, [0], d);
  if (close !== undefined) shift(segs, close, endPoints(segs[close]), d);
}

/** The point where segment `si` starts. */
export function segStart(segs, si) {
  const prev = segs.slice(0, si), last = prev.at(-1);
  if (!last) return null;
  return last.t === 'Z' ? [...prev].reverse().find(isM)?.pts[0] ?? null : end(last);
}

/** Splits segment `si` at `t`, adding a vertex there. False for a move or close. */
export function split(segs, si, t) {
  const p0 = segStart(segs, si);
  if (!p0) return false;
  const s = segs[si];
  let a, b;
  if (s?.t === 'L') { a = seg('L', lerp(p0, s.pts[0], t)); b = seg('L', s.pts[0]); }
  else if (s?.t === 'Q') {
    const [c, p1] = s.pts, m0 = lerp(p0, c, t), m1 = lerp(c, p1, t), m = lerp(m0, m1, t);
    a = seg('Q', m0, m); b = seg('Q', m1, p1);
  } else if (s?.t === 'C') {
    const [c1, c2, p1] = s.pts, a1 = lerp(p0, c1, t), a2 = lerp(c1, c2, t), a3 = lerp(c2, p1, t), b1 = lerp(a1, a2, t), b2 = lerp(a2, a3, t), m = lerp(b1, b2, t);
    a = seg('C', a1, b1, m); b = seg('C', b2, a3, p1);
  } else return false;
  segs[si] = a;
  segs.splice(si + 1, 0, b);
  return true;
}

/** The sub-path holding segment `si`: from its move up to the next move (or the end). */
export function subpath(segs, si) {
  let from = 0;
  for (let j = si; j >= 0; j--) if (isM(segs[j])) { from = j; break; }
  let to = segs.length;
  for (let j = si + 1; j < segs.length; j++) if (isM(segs[j])) { to = j; break; }
  return [from, to];
}

/** Removes the vertex ending segment `si`. A sub-path keeps at least two vertices. */
export function removeVertex(segs, si) {
  const [from, to] = subpath(segs, si);
  if (vertices(segs).filter(v => v >= from && v < to).length <= 2) return false;
  if (isM(segs[si])) {
    // The next vertex becomes the start; a closed outline's closing edge now ends there.
    const next = end(segs[si + 1]);
    if (!next) return false;
    segs.splice(si + 1, 1);
    segs[si] = seg('M', next);
    let close;
    for (let j = si + 1; j < segs.length && !isM(segs[j]); j++) if (segs[j + 1]?.t === 'Z') { close = j; break; }
    if (close !== undefined && segs[close].t !== 'Z' && segs[close].t !== 'M') segs[close].pts[segs[close].pts.length - 1] = next;
    return true;
  }
  const a = segs[si], b = segs[si + 1];
  if (a?.t === 'C' && b?.t === 'C') {
    segs.splice(si + 1, 1);
    segs[si] = seg('C', a.pts[0], b.pts[1], b.pts[2]);
  } else segs.splice(si, 1);
  return true;
}

/** The segment that ends at the vertex ending segment `si`: the closing edge for a closed sub-path's start, none for an open one's. */
export function endingSegment(segs, si) {
  if (isM(segs[si])) return closeOf(segs, si);
  return si;
}

/** Whether segment `j` is a straight line or a curve (null for a move or close). */
export function segmentKind(segs, j) {
  const s = segs[j];
  return s?.t === 'L' ? 'straight' : s?.t === 'C' || s?.t === 'Q' ? 'curved' : null;
}

/** Turns segment `j` into a cubic with the same shape. */
function toCubic(segs, j) {
  const p0 = segStart(segs, j), s = segs[j];
  if (!p0) return;
  if (s?.t === 'L') segs[j] = seg('C', lerp(p0, s.pts[0], 1 / 3), lerp(p0, s.pts[0], 2 / 3), s.pts[0]);
  else if (s?.t === 'Q') { const [c, p1] = s.pts; segs[j] = seg('C', lerp(p0, c, 2 / 3), lerp(p1, c, 2 / 3), p1); }
}

/** Makes segment `j` a straight line (dropping its handles) or a curve with handles at its thirds. */
export function setSegment(segs, j, curved) {
  if (curved) toCubic(segs, j);
  else if (segs[j]?.t === 'C' || segs[j]?.t === 'Q') segs[j] = seg('L', end(segs[j]));
}

/** Opens the closed sub-path through the vertex ending segment `si` there. False for an open sub-path. */
export function openAt(segs, si) {
  const [from, to] = subpath(segs, si);
  const z = to - 1;
  if (!(z > si && segs[z]?.t === 'Z')) return false;
  const v = end(segs[si]);
  if (!v) return false;
  const after = segs.slice(si + 1, z), before = segs.slice(from + 1, si + 1);
  segs.splice(from, to - from, seg('M', v), ...after, ...before);
  return true;
}

/** Deletes the segment ending at the vertex ending segment `si` from its closed sub-path, which opens there. */
export function deleteSegmentAt(segs, si) {
  const [from] = subpath(segs, si);
  if (!openAt(segs, si)) return false;
  const [, to] = subpath(segs, from);
  if (to > from + 1) segs.splice(to - 1, 1);
  return true;
}

/** Closes the open sub-path through the vertex ending segment `si`: a straight segment joins its ends. False for a closed one. */
export function closeAt(segs, si) {
  const [from, to] = subpath(segs, si);
  const last = Math.max(to - 1, 0);
  if (last <= from || segs[last]?.t === 'Z') return false;
  const start = segs[from]?.pts[0], e = end(segs[last]);
  if (!isM(segs[from]) || !start || !e) return false;
  const add2 = [];
  if (hyp(sub(start, e)) >= 1e-6) add2.push(seg('L', start));
  add2.push(seg('Z'));
  segs.splice(to, 0, ...add2);
  return true;
}

// ---- handles and point types -----------------------------------------------------------------

/** The control-handle slots of the vertex ending segment `si`: [segment, point index] for the incoming and the outgoing handle (cubics only). */
export function handleSlots(segs, si) {
  const incoming = isM(segs[si]) ? closeOf(segs, si) : si;
  const inc = incoming !== undefined && segs[incoming]?.t === 'C' ? [incoming, 1] : null;
  const out = segs[si + 1]?.t === 'C' ? [si + 1, 0] : null;
  return [inc, out];
}
const getPt = (segs, slot) => (slot && segs[slot[0]]?.t === 'C' ? segs[slot[0]].pts[slot[1]] : null);
const setPt = (segs, slot, p) => { if (slot && segs[slot[0]]?.pts[slot[1]]) segs[slot[0]].pts[slot[1]] = p; };

/** The type a vertex's handles show: smooth (in line, equal), straight (in line) or corner. */
export function pointKind(segs, si) {
  const v = end(segs[si]), [hi, ho] = handleSlots(segs, si);
  const a = getPt(segs, hi), b = getPt(segs, ho);
  if (!v || !a || !b) return 'corner';
  const da = sub(a, v), db = sub(b, v), la = hyp(da), lb = hyp(db);
  if (la < 1e-6 || lb < 1e-6) return 'corner';
  const cos = dot(da, db) / (la * lb);
  if (cos > -0.9998) return 'corner';
  return Math.abs(la - lb) <= 0.01 * Math.max(la, lb) ? 'smooth' : 'straight';
}

/** Sets the point type of the vertex ending segment `si`: its segments become curves, smooth and straight points get their handles in line. */
export function setType(segs, si, kind) {
  const incoming = isM(segs[si]) ? closeOf(segs, si) : si;
  if (incoming !== undefined) toCubic(segs, incoming);
  toCubic(segs, si + 1);
  if (kind === 'corner') return;
  const v = end(segs[si]), [hi, ho] = handleSlots(segs, si);
  const a = getPt(segs, hi), b = getPt(segs, ho);
  if (!v || !hi || !ho || !a || !b) return;
  let li = hyp(sub(a, v)), lo = hyp(sub(b, v));
  let dir = sub(b, a);
  if (hyp(dir) < 1e-9) {
    const prev = segStart(segs, hi[0]) ?? v, next = end(segs[ho[0]]) ?? v;
    dir = sub(next, prev);
  }
  const len = hyp(dir);
  if (len < 1e-9) return;
  const u = mul(dir, 1 / len);
  if (kind === 'smooth') { const m = li + lo > 1e-9 ? (li + lo) / 2 : len / 6; li = m; lo = m; }
  setPt(segs, hi, sub(v, mul(u, li)));
  setPt(segs, ho, add(v, mul(u, lo)));
}

/** Moves handle `out` (else the incoming one) of the vertex ending segment `si` to `p`; the other follows as the point's type says. */
export function setHandle(segs, si, out, p, kind) {
  const k = kind ?? pointKind(segs, si);
  const [hi, ho] = handleSlots(segs, si);
  const [mine, other] = out ? [ho, hi] : [hi, ho];
  const v = end(segs[si]);
  if (!mine || !v) return false;
  setPt(segs, mine, p);
  const q = other ? getPt(segs, other) : null;
  if (other && k !== 'corner' && q) {
    const d = sub(p, v), l = hyp(d);
    if (l > 1e-9) setPt(segs, other, sub(v, mul(mul(d, 1 / l), k === 'smooth' ? l : hyp(sub(q, v)))));
  }
  return true;
}

// ---- shapes ------------------------------------------------------------------------------------

/** Fits the shape's box around its outline again, keeping the drawing where it is on the slide (the shape's paths are in its local points). */
export function refit(sh) {
  const x = sh.xfrm;
  if (!x || sh.geom?.kind !== 'custom') return;
  const paths = sh.geom.paths, all = paths.map(p => parse(p.d));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const segs of all) for (const s of segs) for (const q of s.pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  if (!Number.isFinite(x0)) return;
  const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
  if (Math.abs(x0) < 1e-6 && Math.abs(y0) < 1e-6 && Math.abs(w - x.w) < 1e-6 && Math.abs(h - x.h) < 1e-6) return;
  // The new centre in slide space: the old box's affine (rotation and flips about its centre) applied to it.
  const cx = x.w / 2, cy = x.h / 2, lx = x0 + w / 2 - cx, ly = y0 + h / 2 - cy;
  const sx = x.flipH ? -1 : 1, sy = x.flipV ? -1 : 1, r = ((x.rot ?? 0) * Math.PI) / 180;
  const fx = lx * sx, fy = ly * sy;
  const c = P(x.x + cx + fx * Math.cos(r) - fy * Math.sin(r), x.y + cy + fx * Math.sin(r) + fy * Math.cos(r));
  paths.forEach((p, k) => {
    for (const s of all[k]) s.pts = s.pts.map(q => P(q.x - x0, q.y - y0));
    p.d = write(all[k]);
    p.w = w;
    p.h = h;
  });
  sh.xfrm = {...x, x: c.x - w / 2, y: c.y - h / 2, w, h};
}

/** Rescales every path of a custom geometry to shape-local points (`w`/`h` equal the shape's size). */
export function normalize(paths, w, h) {
  for (const p of paths) {
    const sx = p.w > 0 ? w / p.w : 1, sy = p.h > 0 ? h / p.h : 1;
    if (Math.abs(sx - 1) > 1e-12 || Math.abs(sy - 1) > 1e-12) {
      const segs = parse(p.d);
      for (const s of segs) s.pts = s.pts.map(q => P(q.x * sx, q.y * sy));
      p.d = write(segs);
    }
    p.w = w;
    p.h = h;
  }
}

/** The shape's local-to-slide matrix [a b c d e f] (rotation and flips about the box centre). */
export function affineOf(x) {
  const sx = x.flipH ? -1 : 1, sy = x.flipV ? -1 : 1, r = ((x.rot ?? 0) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  const cx = x.w / 2, cy = x.h / 2;
  return [a, b, c, d, x.x + cx - (a * cx + c * cy), x.y + cy - (b * cx + d * cy)];
}
export const toSlide = (m, q) => P(m[0] * q.x + m[2] * q.y + m[4], m[1] * q.x + m[3] * q.y + m[5]);
export function toLocal(m, q) {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  const x = q.x - m[4], y = q.y - m[5];
  return P((m[3] * x - m[2] * y) / det, (-m[1] * x + m[0] * y) / det);
}

/** Vertices of every path of `sh` in slide points. */
export function slideVertices(sh, x) {
  if (sh.geom?.kind !== 'custom') return [];
  const m = affineOf(x);
  return sh.geom.paths.map(p => {
    const sx = p.w > 0 ? x.w / p.w : 1, sy = p.h > 0 ? x.h / p.h : 1, segs = parse(p.d);
    return vertices(segs).map(i => toSlide(m, P(end(segs[i]).x * sx, end(segs[i]).y * sy)));
  });
}

/** The vertex of `sh` near slide point `p`: [path, index], or null. */
export function vertexAt(sh, x, p, tol) {
  const all = slideVertices(sh, x);
  for (let pi = 0; pi < all.length; pi++) for (let i = 0; i < all[pi].length; i++) if (hyp(sub(all[pi][i], p)) <= tol) return [pi, i];
  return null;
}

/** Handles of vertex `index` of path `path` of `sh` in slide points: {hin, hout, v}. */
export function slideHandles(sh, x, path, index) {
  const cp = sh.geom?.kind === 'custom' ? sh.geom.paths[path] : null;
  if (!cp) return null;
  const sx = cp.w > 0 ? x.w / cp.w : 1, sy = cp.h > 0 ? x.h / cp.h : 1, m = affineOf(x);
  const to = q => toSlide(m, P(q.x * sx, q.y * sy));
  const segs = parse(cp.d), si = vertices(segs)[index];
  if (si === undefined) return null;
  const [hi, ho] = handleSlots(segs, si);
  const hin = getPt(segs, hi), hout = getPt(segs, ho);
  return {hin: hin ? to(hin) : null, hout: hout ? to(hout) : null, v: to(end(segs[si]))};
}

function segmentPoint(segs, si, p0, t, scale) {
  const s = segs[si];
  let q;
  if (s?.t === 'L') q = lerp(p0, s.pts[0], t);
  else if (s?.t === 'Q') q = lerp(lerp(p0, s.pts[0], t), lerp(s.pts[0], s.pts[1], t), t);
  else if (s?.t === 'C') {
    const [c1, c2, p1] = s.pts, a = lerp(p0, c1, t), b = lerp(c1, c2, t), c = lerp(c2, p1, t);
    q = lerp(lerp(a, b, t), lerp(b, c, t), t);
  } else return null;
  return P(q.x * scale[0], q.y * scale[1]);
}

function segmentEndVertex(segs, vs, si) {
  if (closesOntoStart(segs, si)) {
    let m = -1;
    for (let j = si - 1; j >= 0; j--) if (isM(segs[j])) { m = j; break; }
    return m < 0 ? -1 : vs.indexOf(m);
  }
  return vs.indexOf(si);
}

function nearestOnSegment(segs, si, p0, scale, local, tol) {
  const at = t => segmentPoint(segs, si, p0, t, scale);
  let near = null;
  for (let k = 1; k < 32; k++) {
    const t = k / 32, q = at(t);
    if (!q) continue;
    const d = hyp(sub(q, local));
    if (d <= tol && (!near || d < near[0])) near = [d, t];
  }
  if (!near) return null;
  let [d, t] = near, step = 1 / 32;
  for (let it = 0; it < 4; it++) {
    step /= 8;
    const c = t;
    for (let k = -8; k <= 8; k++) {
      const u = Math.min(Math.max(c + k * step, 0), 1), q = at(u);
      if (!q) continue;
      const e = hyp(sub(q, local));
      if (e < d) { d = e; t = u; }
    }
  }
  return [d, t];
}

/** The segment of `sh`'s outline near slide point `p`: {path, index (of the vertex ending it), t}, or null. */
export function segmentAt(sh, x, p, tol) {
  if (sh.geom?.kind !== 'custom') return null;
  const local = toLocal(affineOf(x), p);
  let best = null;
  sh.geom.paths.forEach((cp, pi) => {
    const scale = [cp.w > 0 ? x.w / cp.w : 1, cp.h > 0 ? x.h / cp.h : 1], segs = parse(cp.d), vs = vertices(segs);
    for (let si = 0; si < segs.length; si++) {
      const p0 = segStart(segs, si);
      if (!p0) continue;
      const ev = segmentEndVertex(segs, vs, si);
      if (ev < 0) continue;
      const r = nearestOnSegment(segs, si, p0, scale, local, tol);
      if (r && (!best || r[0] < best.d)) best = {d: r[0], path: pi, index: ev, t: r[1]};
    }
  });
  return best && {path: best.path, index: best.index, t: best.t};
}

/** A preset's outline as custom paths in shape-local points: `paths` are shapeGeometry's {path: elements, fill, stroke}. */
export function toCustom(paths, w, h) {
  return paths.map(sp => {
    const segs = (sp.path ?? []).map(e => (e.t === 'M' ? seg('M', e.p) : e.t === 'L' ? seg('L', e.p) : e.t === 'Q' ? seg('Q', e.p1, e.p) : e.t === 'C' ? seg('C', e.p1, e.p2, e.p) : seg('Z')));
    return {w, h, d: write(segs), fill: sp.fill ?? 'norm', stroke: sp.stroke !== false};
  });
}

// ---- reading a shape's path --------------------------------------------------------------------

/** Point types of every path, and the kind of the segment ending at each vertex (for shape.points and the menus). */
export function describe(sh) {
  const types = [], kinds = [];
  if (sh.geom?.kind === 'custom') {
    for (const cp of sh.geom.paths) {
      const segs = parse(cp.d), vs = vertices(segs);
      types.push(vs.map(si => pointKind(segs, si)));
      kinds.push(vs.map(si => { const j = endingSegment(segs, si); return j === undefined ? null : segmentKind(segs, j); }));
    }
  }
  return {types, kinds};
}

/** Whether the outline through vertex `index` of path `path` is closed. */
export function closedAt(sh, path, index) {
  const cp = sh.geom?.paths?.[path];
  if (!cp) return null;
  const segs = parse(cp.d), si = vertices(segs)[index];
  if (si === undefined) return null;
  const [, to] = subpath(segs, si);
  return segs[to - 1]?.t === 'Z';
}

// ---- pointer drags -----------------------------------------------------------------------------

/** A copy of freeform `sh` with path `pathIndex` edited by `f(segs, vertexSegments, xfrm)` (true when it changed) and the box refitted; `sh` itself when nothing changed. */
export function withPath(sh, pathIndex, f) {
  const cp = sh.geom?.kind === 'custom' ? sh.geom.paths[pathIndex] : null;
  if (!cp || !sh.xfrm) return sh;
  const out = structuredClone(sh), c = out.geom.paths[pathIndex];
  const segs = parse(c.d);
  if (!f(segs, vertices(segs), out.xfrm)) return sh;
  c.d = write(segs);
  refit(out);
  return out;
}
/** `sh` with vertex `index` of path `path` moved to slide point `to` (a vertex drag). */
export function movedVertex(sh, path, index, to) {
  return withPath(sh, path, (segs, vs, x) => {
    const si = vs[index];
    if (si === undefined) return false;
    const local = toLocal(affineOf(x), to), cur = segs[si].pts.at(-1);
    moveVertex(segs, si, P(local.x - cur.x, local.y - cur.y));
    return true;
  });
}
/** `sh` with the in or out handle of vertex `index` moved to slide point `to` (a handle drag); `kind` is the point type remembered for the vertex. */
export function movedHandle(sh, path, index, out, to, kind) {
  return withPath(sh, path, (segs, vs, x) => {
    const si = vs[index];
    return si !== undefined && setHandle(segs, si, out, toLocal(affineOf(x), to), kind ?? undefined);
  });
}
