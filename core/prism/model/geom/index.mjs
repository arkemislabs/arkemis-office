// DeckCraft geometry: units, shape transforms and preset shape generators.
// Translated from deckcraft crates/geom/src/lib.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// The document model keeps positions in points (1/72 inch). Office Open XML stores EMU (12 700 per
// point); emuToPt and ptToEmu convert losslessly for integer EMU values, so files round-trip.

import {
  pt, add, sub, mul, dot, hypot, hypot2, affTranslate, affRotate, affScaleXY, affMul, affChain, apply, rect, rectFromPoints,
  rectUnionPt, flatten,
} from './kurbo.mjs';

export * as kurbo from './kurbo.mjs';
export {build, CATALOG, CATEGORIES, categoryLabel, info, isLineLike, mitredByDefault, FillMode, handleValueAt, outline, isOpen} from './preset/index.mjs';
export {pathD as squirclePathD} from './squircle.mjs';

export const EMU_PER_PT = 12700;
export const EMU_PER_IN = 914400;
export const EMU_PER_CM = 360000;

export const emuToPt = emu => emu / EMU_PER_PT;
/** Points to EMU, rounded. Non-finite input becomes 0; huge values saturate. */
export function ptToEmu(p) {
  if (!Number.isFinite(p)) return 0;
  const v = Math.round(p * EMU_PER_PT);
  if (v >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (v <= Number.MIN_SAFE_INTEGER) return Number.MIN_SAFE_INTEGER;
  return v + 0;
}

/** Display units for measurements (deckcraft `Unit`). */
export const Unit = Object.freeze({
  inches: {ppu: 72, suffix: '"'},
  centimeters: {ppu: 72 / 2.54, suffix: ' cm'},
  points: {ppu: 1, suffix: ' pt'},
  pixels: {ppu: 0.75, suffix: ' px'},
});
export const pointsPerUnit = unit => (Unit[unit] ?? Unit.inches).ppu;
/** `2.08"` style text for a length in points. */
export function formatUnit(unit, p) {
  const u = Unit[unit] ?? Unit.inches;
  return `${(p / u.ppu).toFixed(2)}${u.suffix}`;
}
/** Parses `2.5`, `2.5"`, `2.5 in`, `6 cm`, `30 pt`, `40px`, `5mm` into points. A bare number uses `unit`. */
export function parseUnit(unit, text) {
  const t = String(text).trim().toLowerCase();
  let end = 0;
  while (end < t.length && /[0-9.+-]/.test(t[end])) end++;
  const numText = t.slice(0, end);
  if (!numText || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(numText)) return null;
  const num = Number(numText);
  const rest = t.slice(end).trim();
  const ppu = rest === '' ? pointsPerUnit(unit)
    : ['"', 'in', 'inch', 'inches'].includes(rest) ? 72
      : rest === 'cm' ? 72 / 2.54 : rest === 'mm' ? 72 / 25.4 : ['pt', 'pts'].includes(rest) ? 1 : rest === 'px' ? 0.75 : null;
  if (ppu === null) return null;
  const v = num * ppu;
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Xfrm: a shape's placement on its slide (or in its group's child space): offset, extent,
// rotation (degrees clockwise) and flips. Rotation and flips are about the centre.

export const xfrm = (x, y, w, h, extra = {}) => ({x, y, w, h, ...extra});
export const xfrmRect = x => rect(x.x, x.y, x.x + x.w, x.y + x.h);
export const xfrmCenter = x => pt(x.x + x.w / 2, x.y + x.h / 2);
/** Local shape space (0..w, 0..h) → parent space, applying flips and rotation about the centre. */
export function xfrmAffine(x) {
  const c = pt(x.w / 2, x.h / 2);
  const sx = x.flipH ? -1 : 1, sy = x.flipV ? -1 : 1;
  return affChain(affTranslate(add(pt(x.x, x.y), c)), affRotate(((x.rot ?? 0) * Math.PI) / 180), affScaleXY(sx, sy), affTranslate(mul(c, -1)));
}
/** Axis-aligned bounds of the rotated box in parent space. */
export function xfrmBounds(x) {
  const a = xfrmAffine(x);
  const ps = [pt(0, 0), pt(x.w, 0), pt(x.w, x.h), pt(0, x.h)].map(p => apply(a, p));
  let r = rectFromPoints(ps[0], ps[1]);
  r = rectUnionPt(rectUnionPt(r, ps[2]), ps[3]);
  return r;
}
export const xfrmIsFinite = x => [x.x, x.y, x.w, x.h, x.rot ?? 0].every(Number.isFinite);
/** Rotation normalised to 0..360. */
export function rotNorm(x) { const r = (x.rot ?? 0) % 360; return r < 0 ? r + 360 : r; }

/** Serialize an Xfrm the way deckcraft does (rot only when non-zero, flips only when set). */
export function cleanXfrm(x) {
  const out = {x: x.x, y: x.y, w: x.w, h: x.h};
  if (x.rot) out.rot = x.rot;
  if (x.flipH) out.flipH = true;
  if (x.flipV) out.flipV = true;
  return out;
}

/** Maps a group's child coordinate space (`ch` rect) onto the group's own box. */
export function groupChildAffine(group, ch) {
  const cw = ch.x1 - ch.x0, chh = ch.y1 - ch.y0;
  const sx = Math.abs(cw) > 1e-9 ? group.w / cw : 1;
  const sy = Math.abs(chh) > 1e-9 ? group.h / chh : 1;
  return affChain(xfrmAffine(group), affScaleXY(sx, sy), affTranslate(pt(-ch.x0, -ch.y0)));
}

/** Distance from `p` to the segment `a`–`b`. */
export function distToSegment(p, a, b) {
  const ab = sub(b, a);
  const len2 = hypot2(ab);
  if (len2 < 1e-12) return hypot(sub(p, a));
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
  return hypot(sub(p, add(a, mul(ab, t))));
}

/** Is `p` within `tol` of the outline of `path` (flattened)? */
export function nearPath(path, p, tol) {
  let hit = false, start = pt(0, 0), last = pt(0, 0);
  flatten(path, 0.25, el => {
    if (hit) return;
    if (el.t === 'M') { start = el.p; last = el.p; }
    else if (el.t === 'L') { if (distToSegment(p, last, el.p) <= tol) hit = true; last = el.p; }
    else if (el.t === 'Z') { if (distToSegment(p, last, start) <= tol) hit = true; last = start; }
  });
  return hit;
}

/** Snap `v` to the nearest multiple of `step` (step <= 0 returns `v`). */
export const snap = (v, step) => (step > 0 && Number.isFinite(step) ? Math.round(v / step) * step : v);

export {affMul};
