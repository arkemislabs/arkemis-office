// The parts of the `kurbo` 2-D curve library that deckcraft's geom crate uses (Point, Vec2, Rect,
// Affine, BezPath, Arc → cubic Béziers, flattening, bounding boxes, winding numbers), written for
// the Prism foundation. deckcraft (crates/geom/src/lib.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf) re-exports kurbo; this module keeps the same
// semantics so the translated preset geometry gives the same outlines. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Points and vectors are plain `{x, y}` objects; a Rect is `{x0, y0, x1, y1}`; an Affine is the
// kurbo coefficient array `[a, b, c, d, e, f]` mapping (x, y) to (a·x + c·y + e, b·x + d·y + f).
// A BezPath is an array of elements: `{t:'M', p}`, `{t:'L', p}`, `{t:'Q', p1, p}`,
// `{t:'C', p1, p2, p}`, `{t:'Z'}`.

export const pt = (x, y) => ({x, y});
export const ZERO = Object.freeze({x: 0, y: 0});
export const add = (a, b) => ({x: a.x + b.x, y: a.y + b.y});
export const sub = (a, b) => ({x: a.x - b.x, y: a.y - b.y});
export const mul = (a, k) => ({x: a.x * k, y: a.y * k});
export const div = (a, k) => ({x: a.x / k, y: a.y / k});
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const hypot2 = a => a.x * a.x + a.y * a.y;
export const hypot = a => Math.hypot(a.x, a.y);
export const normalize = a => div(a, hypot(a));

// ---------------------------------------------------------------------------------------------
// Rect

export const rect = (x0, y0, x1, y1) => ({x0, y0, x1, y1});
export const rectFromPoints = (a, b) => ({x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y)});
export const rectFromOriginSize = (x, y, w, h) => rectAbs({x0: x, y0: y, x1: x + w, y1: y + h});
export const rectAbs = r => ({x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1)});
export const rectWidth = r => r.x1 - r.x0;
export const rectHeight = r => r.y1 - r.y0;
export const rectCenter = r => ({x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2});
/** kurbo `Rect::inset`: grows by `d` on every side (negative shrinks). */
export const rectInset = (r, d) => ({x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d});
export const rectUnion = (a, b) => ({x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1)});
export const rectUnionPt = (r, p) => ({x0: Math.min(r.x0, p.x), y0: Math.min(r.y0, p.y), x1: Math.max(r.x1, p.x), y1: Math.max(r.y1, p.y)});
export const rectTranslate = (r, v) => ({x0: r.x0 + v.x, y0: r.y0 + v.y, x1: r.x1 + v.x, y1: r.y1 + v.y});
export const rectContains = (r, p) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
export const rectIntersects = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

// ---------------------------------------------------------------------------------------------
// Affine

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
export const affTranslate = v => [1, 0, 0, 1, v.x, v.y];
export const affScale = k => [k, 0, 0, k, 0, 0];
export const affScaleXY = (sx, sy) => [sx, 0, 0, sy, 0, 0];
export const affRotate = th => { const s = Math.sin(th), c = Math.cos(th); return [c, s, -s, c, 0, 0]; };
/** `a * b`: apply `b` first, then `a` (kurbo's `Mul`). */
export function affMul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export const affChain = (...ms) => ms.reduce((acc, m) => affMul(acc, m), IDENTITY);
export const apply = (m, p) => ({x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5]});
export const applyVec = (m, v) => ({x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y});
export const affDeterminant = m => m[0] * m[3] - m[1] * m[2];
export function affInverse(m) {
  const inv = 1 / affDeterminant(m);
  return [
    inv * m[3], -inv * m[1], -inv * m[2], inv * m[0],
    inv * (m[2] * m[5] - m[3] * m[4]), inv * (m[1] * m[4] - m[0] * m[5]),
  ];
}
/** kurbo `transform_rect_bbox`. */
export function transformRectBbox(m, r) {
  const ps = [pt(r.x0, r.y0), pt(r.x1, r.y0), pt(r.x1, r.y1), pt(r.x0, r.y1)].map(p => apply(m, p));
  return ps.slice(1).reduce(rectUnionPt, rectFromPoints(ps[0], ps[0]));
}

// ---------------------------------------------------------------------------------------------
// BezPath

export function applyAffine(path, m) {
  return path.map(el => {
    switch (el.t) {
      case 'M': case 'L': return {t: el.t, p: apply(m, el.p)};
      case 'Q': return {t: 'Q', p1: apply(m, el.p1), p: apply(m, el.p)};
      case 'C': return {t: 'C', p1: apply(m, el.p1), p2: apply(m, el.p2), p: apply(m, el.p)};
      default: return el;
    }
  });
}

/** SVG path data (numbers rounded to 1/1000). */
export function svgPath(path) {
  const n = v => (Math.round(v * 1000) / 1000 + 0).toString();
  const p = q => `${n(q.x)} ${n(q.y)}`;
  let out = '';
  for (const el of path) {
    if (el.t === 'M') out += `M${p(el.p)}`;
    else if (el.t === 'L') out += `L${p(el.p)}`;
    else if (el.t === 'Q') out += `Q${p(el.p1)} ${p(el.p)}`;
    else if (el.t === 'C') out += `C${p(el.p1)} ${p(el.p2)} ${p(el.p)}`;
    else if (el.t === 'Z') out += 'Z';
  }
  return out;
}

const lerp = (a, b, t) => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
function evalQuad(p0, p1, p2, t) { const mt = 1 - t; return {x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x, y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y}; }
function evalCubic(p0, p1, p2, p3, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y};
}

/**
 * Flatten to move/line/close elements within `tolerance` (kurbo `flatten`), calling `cb(el)`.
 * Curves are subdivided uniformly with a segment count from their control polygon's deviation.
 */
export function flatten(path, tolerance, cb) {
  let last = ZERO;
  const tol = Math.max(1e-6, tolerance);
  for (const el of path) {
    if (el.t === 'M') { last = el.p; cb({t: 'M', p: el.p}); }
    else if (el.t === 'L') { last = el.p; cb({t: 'L', p: el.p}); }
    else if (el.t === 'Z') cb({t: 'Z'});
    else if (el.t === 'Q') {
      const dd = hypot(sub(add(last, el.p), mul(el.p1, 2)));
      const n = Math.max(1, Math.min(1000, Math.ceil(Math.sqrt(dd / (4 * tol)))));
      for (let i = 1; i <= n; i++) cb({t: 'L', p: i === n ? el.p : evalQuad(last, el.p1, el.p, i / n)});
      last = el.p;
    } else if (el.t === 'C') {
      const d1 = hypot(sub(add(last, el.p2), mul(el.p1, 2))), d2 = hypot(sub(add(el.p1, el.p), mul(el.p2, 2)));
      const dd = Math.max(d1, d2) * 0.75;
      const n = Math.max(1, Math.min(1000, Math.ceil(Math.sqrt(dd / tol))));
      for (let i = 1; i <= n; i++) cb({t: 'L', p: i === n ? el.p : evalCubic(last, el.p1, el.p2, el.p, i / n)});
      last = el.p;
    }
  }
}

function quadExtrema(a, b, c) { const d = a - 2 * b + c; if (Math.abs(d) < 1e-12) return []; const t = (a - b) / d; return t > 0 && t < 1 ? [t] : []; }
function cubicExtrema(a, b, c, d) {
  // derivative: 3[(b-a)(1-t)^2 + 2(c-b)t(1-t) + (d-c)t^2]
  const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = b - a;
  const out = [];
  if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) out.push(-C / B); }
  else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) { const r = Math.sqrt(disc); out.push((-B + r) / (2 * A), (-B - r) / (2 * A)); }
  }
  return out.filter(t => t > 0 && t < 1);
}

/** Exact axis-aligned bounding box (kurbo `Shape::bounding_box`); an empty path gives a zero rect. */
export function boundingBox(path) {
  let r = null, last = ZERO;
  const addP = p => { r = r ? rectUnionPt(r, p) : {x0: p.x, y0: p.y, x1: p.x, y1: p.y}; };
  for (const el of path) {
    if (el.t === 'M' || el.t === 'L') { addP(el.p); last = el.p; }
    else if (el.t === 'Q') {
      addP(last); addP(el.p);
      for (const t of [...quadExtrema(last.x, el.p1.x, el.p.x), ...quadExtrema(last.y, el.p1.y, el.p.y)]) addP(evalQuad(last, el.p1, el.p, t));
      last = el.p;
    } else if (el.t === 'C') {
      addP(last); addP(el.p);
      for (const t of [...cubicExtrema(last.x, el.p1.x, el.p2.x, el.p.x), ...cubicExtrema(last.y, el.p1.y, el.p2.y, el.p.y)]) addP(evalCubic(last, el.p1, el.p2, el.p, t));
      last = el.p;
    }
  }
  return r ?? {x0: 0, y0: 0, x1: 0, y1: 0};
}

/** Winding number of `p` (nonzero = inside), on the flattened path; open sub-paths close implicitly. */
export function winding(path, p) {
  let w = 0, start = null, last = null;
  const seg = (a, b) => {
    if (a.y <= p.y) { if (b.y > p.y && cross(a, b, p) > 0) w++; }
    else if (b.y <= p.y && cross(a, b, p) < 0) w--;
  };
  const cross = (a, b, q) => (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y);
  flatten(path, 0.1, el => {
    if (el.t === 'M') { if (start && last) seg(last, start); start = el.p; last = el.p; }
    else if (el.t === 'L') { if (last) seg(last, el.p); last = el.p; }
    else if (el.t === 'Z') { if (start && last) seg(last, start); last = start; }
  });
  if (start && last) seg(last, start);
  return w;
}

/** Even-odd containment (flattened). */
export function containsEvenOdd(path, p) { return evenOddCount(path, p) % 2 === 1; }
function evenOddCount(path, p) {
  let n = 0, start = null, last = null;
  const seg = (a, b) => { if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) n++; };
  flatten(path, 0.1, el => {
    if (el.t === 'M') { if (start && last) seg(last, start); start = el.p; last = el.p; }
    else if (el.t === 'L') { if (last) seg(last, el.p); last = el.p; }
    else if (el.t === 'Z') { if (start && last) seg(last, start); last = start; }
  });
  if (start && last) seg(last, start);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Arc (kurbo `Arc::append_iter` / `to_cubic_beziers`)

function sampleEllipse(rx, ry, xRot, angle) {
  const u = rx * Math.cos(angle), v = ry * Math.sin(angle);
  const s = Math.sin(xRot), c = Math.cos(xRot);
  return {x: u * c - v * s, y: u * s + v * c};
}

/**
 * Cubic Béziers approximating the elliptical arc (kurbo `Arc::to_cubic_beziers`): calls
 * `cb(p1, p2, p)` for each segment.
 */
export function arcToCubics(center, radii, startAngle, sweepAngle, xRotation, tolerance, cb) {
  const sign = Math.sign(sweepAngle);
  const scaledErr = Math.max(radii.x, radii.y) / tolerance;
  const nErr = Math.max(Math.pow(1.1163 * scaledErr, 1 / 6), 3.999999);
  const n = Math.ceil(nErr * Math.abs(sweepAngle) * (1 / (2 * Math.PI)));
  if (!Number.isFinite(n) || n <= 0) return;
  const angleStep = sweepAngle / n;
  const armLen = (4 / 3) * Math.abs(Math.tan(angleStep / 4)) * sign;
  let angle0 = startAngle;
  let p0 = sampleEllipse(radii.x, radii.y, xRotation, angle0);
  for (let i = 0; i < n; i++) {
    const angle1 = angle0 + angleStep;
    const p1 = add(p0, mul(sampleEllipse(radii.x, radii.y, xRotation, angle0 + Math.PI / 2), armLen));
    const p3 = sampleEllipse(radii.x, radii.y, xRotation, angle1);
    const p2 = sub(p3, mul(sampleEllipse(radii.x, radii.y, xRotation, angle1 + Math.PI / 2), armLen));
    cb(add(center, p1), add(center, p2), add(center, p3));
    angle0 = angle1;
    p0 = p3;
  }
}

/** Signed area (kurbo `Shape::area`), computed on the flattened path; open sub-paths close implicitly. */
export function area(path) {
  let a = 0, start = null, last = null;
  const seg = (p, q) => { a += p.x * q.y - q.x * p.y; };
  flatten(path, 0.01, el => {
    if (el.t === 'M') { if (start && last) seg(last, start); start = el.p; last = el.p; }
    else if (el.t === 'L') { if (last) seg(last, el.p); last = el.p; }
    else if (el.t === 'Z') { if (start && last) seg(last, start); last = start; }
  });
  if (start && last) seg(last, start);
  return a / 2;
}

/** Distance from `p` to the nearest point of the flattened path. */
export function distanceToPath(path, p, tolerance = 0.001) {
  let best = Infinity, prev = ZERO, start = ZERO;
  const segDist = (a, b) => {
    const d = sub(b, a);
    const l2 = hypot2(d);
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / l2)) : 0;
    return hypot(sub(add(a, mul(d, t)), p));
  };
  flatten(path, tolerance, el => {
    if (el.t === 'M') { prev = el.p; start = el.p; return; }
    const q = el.t === 'L' ? el.p : start;
    best = Math.min(best, segDist(prev, q));
    prev = q;
  });
  return best;
}
