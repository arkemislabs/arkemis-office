// Morph: matching shapes between two slides and interpolating their boxes.
// Translated from deckcraft crates/anim/src/morph.rs (`morph_pairs`, `morph_xfrm`, `morph_crop`,
// and the plan of `morph_frame`: which shapes move, which cross-fade) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.
//
// deckcraft builds a frame of shapes with fresh ids for its renderer. The show here draws the old
// and the new slide as two layers and gives each shape an override (`plan.old` / `plan.new`:
// box, fill colour, opacity, crop, hidden), so shapes keep resolving their placeholders, theme and
// style against their own slide. Not translated: the outline morph of a changed geometry and the
// word-by-word / character-by-character text morph (those cross-fade).

import {ctxForSlide, xfrm as resolveXfrm, fill as resolveFill, ctxColor} from '../model/resolve.mjs';
import {paraText} from '../model/text.mjs';
import {kindName} from '../model/presentation.mjs';
import {smooth, clampf} from './anim-timeline.mjs';
import {lerp as lerpColor} from '../model/color.mjs';

const lerp = (a, b, t) => { const v = a + (b - a) * t; return Number.isFinite(v) ? v : t < 0.5 ? a : b; };
const textOf = s => (s.text?.paragraphs ?? []).map(paraText).join('\n');
const presetName = s => (s.geom?.kind === 'custom' ? null : s.geom?.name ?? 'rect');

/**
 * Pairs [shape on `a`, shape on `b`] Morph animates: first by `!!name` (forced match), then by exact
 * name, then by the same kind and text, then by the same kind and preset geometry if neither
 * carries text. Each shape is used once; top-level shapes only (groups move whole).
 */
export function morphPairs(a, b) {
  const pairs = [];
  const usedA = new Set(), usedB = new Set();
  const passes = [
    (x, y) => (x.name ?? '').startsWith('!!') && x.name === y.name,
    (x, y) => !!x.name && x.name === y.name,
    (x, y) => kindName(x) === kindName(y) && textOf(x).trim() !== '' && textOf(x) === textOf(y),
    (x, y) => kindName(x) === kindName(y) && presetName(x) !== null && presetName(x) === presetName(y) && textOf(x).trim() === '' && textOf(y).trim() === '',
  ];
  for (const pass of passes) {
    (a.shapes ?? []).forEach((sa, i) => {
      if (usedA.has(i)) return;
      const j = (b.shapes ?? []).findIndex((sb, k) => !usedB.has(k) && pass(sa, sb));
      if (j >= 0) { usedA.add(i); usedB.add(j); pairs.push([sa.id, b.shapes[j].id]); }
    });
  }
  return pairs;
}

/** Interpolate a box from `a` to `b` at `t`: position and size linearly, rotation along the shortest way round; flips switch at the midpoint. */
export function morphXfrm(a, b, tIn) {
  const t = clampf(tIn, 0, 1, 0);
  if (t >= 1) return b;
  if (t <= 0) return a;
  const ra = Number.isFinite(a.rot) ? a.rot : 0, rb = Number.isFinite(b.rot) ? b.rot : 0;
  let d = (((rb - ra) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  const rot = (((ra + d * t) % 360) + 360) % 360;
  const late = t >= 0.5;
  const out = {x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), rot: Number.isFinite(rot) ? rot : 0};
  const fh = late ? b.flipH : a.flipH, fv = late ? b.flipV : a.flipV;
  if (fh) out.flipH = true;
  if (fv) out.flipV = true;
  return out;
}

/** The crop of a picture morphing from box `xa` cropped by `ca` to `xb` cropped by `cb`, when its box is `x` at progress `t`. */
export function morphCrop(ca, xa, cb, xb, x, t) {
  const axis = ([pa, sa, la, ha], [pb, sb, lb, hb], [p, s]) => {
    const va = 1 - la - ha, vb = 1 - lb - hb;
    if (va <= 1e-6 || vb <= 1e-6) return [lerp(la, lb, t), lerp(ha, hb, t)];
    const ea = sa / va, eb = sb / vb;
    const e = lerp(ea, eb, t);
    if (!Number.isFinite(e) || Math.abs(e) <= 1e-9) return [lerp(la, lb, t), lerp(ha, hb, t)];
    const o = lerp(pa - la * ea, pb - lb * eb, t);
    const lo = (p - o) / e;
    return [lo, 1 - lo - s / e];
  };
  const [l, r] = axis([xa.x, xa.w, ca[0], ca[2]], [xb.x, xb.w, cb[0], cb[2]], [x.x, x.w]);
  const [tp, bt] = axis([xa.y, xa.h, ca[1], ca[3]], [xb.y, xb.h, cb[1], cb[3]], [x.y, x.h]);
  const c = [l, tp, r, bt];
  return c.every(Number.isFinite) ? c : cb;
}

const content = s => { const {id, name, xfrm, fill, ...rest} = s; return rest; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cropOf = s => (s.kind?.type === 'picture' ? s.kind.fill?.crop ?? [0, 0, 0, 0] : [0, 0, 0, 0]);
const uncropped = s => { const c = content(s); if (c.kind?.type === 'picture') c.kind = {...c.kind, fill: {...c.kind.fill, crop: [0, 0, 0, 0]}}; return c; };
const recropped = (a, b) => a.kind?.type === 'picture' && !same(cropOf(a), cropOf(b)) && same(uncropped(a), uncropped(b));
const outlined = s => ['shape', 'picture', 'connector'].includes(s.kind?.type);
const reshaped = (a, b) => !same(a.geom, b.geom) && outlined(a) && outlined(b) && same({...content(a), geom: null}, {...content(b), geom: null});

function solid(ctx, s) {
  if (!ctx) return null;
  const [f, ph] = resolveFill(ctx, s);
  return f && f.kind === 'solid' ? ctxColor(ctx, f.color, ph) : null;
}
const boxOf = (ctx, s) => (ctx ? resolveXfrm(ctx, s) : s.xfrm ?? null);

/**
 * What to draw at progress `tIn` (0..1, eased here) of a Morph from slide `a` to slide `b`:
 * `{mix, old, new}`: `mix` is how far the new slide's background and graphics have faded in (the old
 * ones are drawn under it), `old` and `new` map a shape id to its override
 * `{xfrm?, fill?, crop?, opacity, hide?}` (a shape without an entry is drawn as it is, at its own
 * slide's opacity `1 - mix` for the old slide's shapes and `mix` for the new slide's). `hiddenB(id)`
 * is true for new-slide shapes that are not shown yet (entrance animations).
 */
/** @param {(id: string) => boolean} [hiddenB] */
export function morphPlan(pres, a, b, tIn, hiddenB = _id => false) {
  const s = smooth(clampf(tIn, 0, 1, 0));
  const ca = ctxForSlide(pres, a), cb = ctxForSlide(pres, b);
  const pairs = morphPairs(a, b).filter(([, ib]) => !hiddenB(ib));
  const plan = {mix: s, old: new Map(), new: new Map()};
  for (const sa of a.shapes ?? []) {
    if (!pairs.some(([ia]) => ia === sa.id)) plan.old.set(sa.id, {opacity: 1 - s});
  }
  for (const sb of b.shapes ?? []) {
    const pair = pairs.find(([, ib]) => ib === sb.id);
    const sa = pair ? (a.shapes ?? []).find(x => x.id === pair[0]) : null;
    if (!sa) { plan.new.set(sb.id, hiddenB(sb.id) ? {opacity: 0, hide: true} : {opacity: s}); continue; }
    const xa = boxOf(ca, sa), xb = boxOf(cb, sb);
    const x = xa && xb ? morphXfrm(xa, xb, s) : xb;
    if (reshaped(sa, sb) || recropped(sa, sb) || same(content(sa), content(sb))) {
      const o = {opacity: 1};
      if (x) o.xfrm = x;
      if (recropped(sa, sb)) o.crop = xa && xb && x ? morphCrop(cropOf(sa), xa, cropOf(sb), xb, x, s) : cropOf(sa).map((v, i) => lerp(v, cropOf(sb)[i], s));
      const fa = solid(ca, sa), fb = solid(cb, sb);
      if (fa && fb && (fa.r !== fb.r || fa.g !== fb.g || fa.b !== fb.b || fa.a !== fb.a)) o.fill = lerpColor(fa, fb, s);
      plan.new.set(sb.id, o);
      plan.old.set(sa.id, {opacity: 0, hide: true});
    } else {
      // Different content: the new shape fades in under the fading old one, both on the moving box.
      plan.new.set(sb.id, {opacity: s, ...(x ? {xfrm: x} : {})});
      plan.old.set(sa.id, {opacity: 1 - s, ...(x ? {xfrm: x} : {})});
    }
  }
  return plan;
}
