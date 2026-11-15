// What the slide surface paints for a shape: its geometry (preset or custom path), resolved
// fill/line paints, arrowheads and picture crop rectangles, in shape-local points.
// Translated from deckcraft crates/render/src/geometry.rs (shape_geometry, parse_path, crop_dest)
// and crates/render/src/stroke.rs (head_size, head_trims, open_arrow_setback, arrowheads, end
// points) at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// deckcraft rasterizes with its own renderer; Prism's surface draws the same geometry as SVG
// (architecture 16.3), so this module stops at the paint description.

import {build} from './geom/preset/build.mjs';
import {mitredByDefault} from './geom/preset/catalog.mjs';
import {pt, sub, add, mul, hypot, normalize, applyAffine, rect, arcToCubics} from './geom/kurbo.mjs';
import {dashPattern, colorAlpha} from './style.mjs';
import {ctxColor, fill as resolveFill, line as resolveLine, effects as resolveEffects} from './resolve.mjs';
import {BLACK} from './color.mjs';

/** Parse deckcraft's custom path syntax (`M x y L x y C … Q … Z`). */
export function parsePath(d) {
  const toks = String(d ?? '').split(/[\s,]+/).filter(Boolean);
  const out = [];
  const num = i => { const v = Number(toks[i]); return Number.isFinite(v) ? v : null; };
  let i = 0, started = false;
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'M') { const x = num(i + 1), y = num(i + 2); if (x !== null && y !== null) { out.push({t: 'M', p: pt(x, y)}); started = true; } i += 3; }
    else if (t === 'L') {
      const x = num(i + 1), y = num(i + 2);
      if (x !== null && y !== null) { out.push({t: started ? 'L' : 'M', p: pt(x, y)}); started = true; }
      i += 3;
    } else if (t === 'C') {
      const v = [1, 2, 3, 4, 5, 6].map(k => num(i + k));
      if (v.every(n => n !== null) && started) out.push({t: 'C', p1: pt(v[0], v[1]), p2: pt(v[2], v[3]), p: pt(v[4], v[5])});
      i += 7;
    } else if (t === 'Q') {
      const v = [1, 2, 3, 4].map(k => num(i + k));
      if (v.every(n => n !== null) && started) out.push({t: 'Q', p1: pt(v[0], v[1]), p: pt(v[2], v[3])});
      i += 5;
    } else if (t === 'Z' || t === 'z') { if (started) out.push({t: 'Z'}); i += 1; }
    else i += 1;
  }
  return out;
}

/** deckcraft render `shape_geometry`: the preset (falling back to rect) or custom paths at w × h. */
export function shapeGeometry(sh, w, h) {
  const g = sh.geom ?? {kind: 'preset', name: 'rect'};
  if (g.kind === 'custom') {
    const paths = (g.paths ?? []).map(p => {
      const pw = p.w > 0 ? p.w : Math.max(w, 1e-9), ph = p.h > 0 ? p.h : Math.max(h, 1e-9);
      return {path: applyAffine(parsePath(p.d), [w / pw, 0, 0, h / ph, 0, 0]), fill: p.fill ?? 'norm', stroke: p.stroke !== false, evenOdd: true};
    });
    return {paths, textRect: rect(0, 0, w, h), handles: [], sites: []};
  }
  return build(g.name ?? 'rect', w, h, g.adj ?? []) ?? build('rect', w, h, []) ?? {paths: [], textRect: rect(0, 0, w, h), handles: [], sites: []};
}

/** The rectangle a picture's image occupies given its crop (fractions; negative = padding). */
export function cropDest(b, crop = [0, 0, 0, 0]) {
  const [l, t, r, bb] = crop.map(v => (Number.isFinite(v) ? Math.min(Math.max(v, -10), 0.99) : 0));
  const visW = Math.max(1 - l - r, 1e-6), visH = Math.max(1 - t - bb, 1e-6);
  const fw = (b.x1 - b.x0) / visW, fh = (b.y1 - b.y0) / visH;
  return rect(b.x0 - l * fw, b.y0 - t * fh, b.x0 - l * fw + fw, b.y0 - t * fh + fh);
}

/** An arrowhead's [width, length] for a line `lw` wide (small 2, medium 3, large 5 × max(lw, 2)). */
export function headSize(e, lw) {
  const sz = s => (s === 'sm' ? 2 : s === 'lg' ? 5 : 3);
  const k = Math.max(lw, 2);
  return [sz(e.w) * k, sz(e.len) * k];
}
function openArrowSetback(wl, ll, lw) {
  const half = Math.atan2(wl / 2, ll);
  return Math.sin(half) > 1e-6 ? Math.min(lw / 2 / Math.sin(half), ll) : 0;
}
/** How much of a `lw`-wide line to leave off at its start and end, under its arrowheads. */
export function headTrims(line, lw) {
  const cap = line.cap === 'square' ? lw / 2 : 0;
  const trim = e => {
    if (!e) return 0;
    const [wl, ll] = headSize(e, lw);
    if (e.kind === 'triangle') return ll + cap;
    if (e.kind === 'stealth') return Math.min(ll * (0.6 + (0.4 * lw) / Math.max(wl, 1e-9)), ll) + cap;
    if (e.kind === 'arrow') return openArrowSetback(wl, ll, Math.max(lw, 0.75)) + cap;
    return 0;
  };
  return [trim(line.head), trim(line.tail)];
}

/** The first two and last two distinct points of a stroked outline (flattened ends). */
function endPoints(path) {
  const pts = [];
  let last = null;
  for (const el of path) {
    if (el.t === 'M' || el.t === 'L') pts.push(el.p);
    else if (el.t === 'C') { pts.push(el.p2, el.p); }
    else if (el.t === 'Q') { pts.push(el.p1, el.p); }
    last = el;
  }
  if (pts.length < 2) return null;
  const first = pts[0];
  const second = pts.slice(1).find(q => hypot(sub(q, first)) > 1e-6) ?? pts[1];
  const lastP = pts[pts.length - 1];
  const prev = [...pts].reverse().slice(1).find(q => hypot(sub(q, lastP)) > 1e-6) ?? pts[pts.length - 2];
  return [[first, second], [lastP, prev], last];
}

/** Shorten an open path by `start` at its first segment and `end` at its last (line segments exactly; curves at their end points). */
export function trimEnds(path, start, end) {
  if (!path.length || path[path.length - 1].t === 'Z') return path;
  const out = path.map(e => ({...e}));
  const move = (from, toward, by) => { const d = sub(toward, from); const l = hypot(d); return l > by ? add(from, mul(d, by / l)) : toward; };
  if (start > 0 && out.length > 1 && out[0].t === 'M') {
    const next = out[1].t === 'C' || out[1].t === 'Q' ? out[1].p1 : out[1].p;
    out[0] = {t: 'M', p: move(out[0].p, next, start)};
  }
  if (end > 0 && out.length > 1) {
    const lastEl = out[out.length - 1];
    const prevPt = lastEl.t === 'C' ? lastEl.p2 : lastEl.t === 'Q' ? lastEl.p1 : out[out.length - 2].p;
    out[out.length - 1] = {...lastEl, p: move(lastEl.p, prevPt, end)};
  }
  return out;
}

/** Arrowhead outlines for a line on geometry `geo`: [{path, filled, strokeWidth?}]. */
export function arrowheads(line, geo, lw) {
  const sp = geo.paths.find(p => p.stroke);
  const ends = sp && endPoints(sp.path);
  if (!ends) return [];
  const [[a, a2], [b, b2]] = ends;
  const out = [];
  for (const [e, tip, from] of [[line.head, a, a2], [line.tail, b, b2]]) {
    if (!e || e.kind === 'none') continue;
    const [wl, ll] = headSize(e, lw);
    const dir = normalize(sub(tip, from));
    if (!Number.isFinite(dir.x)) continue;
    const n = pt(-dir.y, dir.x);
    const base = sub(tip, mul(dir, ll));
    if (e.kind === 'oval') {
      const p = [];
      const ang = Math.atan2(dir.y, dir.x);
      const s0 = pt(tip.x + (ll / 2) * Math.cos(ang), tip.y + (ll / 2) * Math.sin(ang));
      p.push({t: 'M', p: s0});
      arcToCubics(tip, pt(ll / 2, wl / 2), 0, Math.PI * 2, ang, 0.05, (p1, p2, q) => p.push({t: 'C', p1, p2, p: q}));
      p.push({t: 'Z'});
      out.push({path: p, filled: true});
    } else if (e.kind === 'diamond') {
      out.push({path: [{t: 'M', p: add(tip, mul(dir, ll / 2))}, {t: 'L', p: add(tip, mul(n, wl / 2))}, {t: 'L', p: sub(tip, mul(dir, ll / 2))},
        {t: 'L', p: sub(tip, mul(n, wl / 2))}, {t: 'Z'}], filled: true});
    } else if (e.kind === 'stealth') {
      out.push({path: [{t: 'M', p: tip}, {t: 'L', p: add(base, mul(n, wl / 2))}, {t: 'L', p: sub(tip, mul(dir, ll * 0.6))}, {t: 'L', p: sub(base, mul(n, wl / 2))}, {t: 'Z'}], filled: true});
    } else if (e.kind === 'arrow') {
      const leg = Math.max(lw, 0.75);
      const back = mul(dir, openArrowSetback(wl, ll, leg));
      out.push({path: [{t: 'M', p: sub(add(base, mul(n, wl / 2)), back)}, {t: 'L', p: sub(tip, back)}, {t: 'L', p: sub(sub(base, mul(n, wl / 2)), back)}], filled: false, strokeWidth: leg});
    } else {
      out.push({path: [{t: 'M', p: tip}, {t: 'L', p: add(base, mul(n, wl / 2))}, {t: 'L', p: sub(base, mul(n, wl / 2))}, {t: 'Z'}], filled: true});
    }
  }
  return out;
}

/**
 * A resolved paint for a fill: `{kind:'none'} | {kind:'solid', color} | {kind:'gradient', stops:
 * [{pos, color}], linear: {angle, scaled} | null, path: string | null, rotateWithShape} |
 * {kind:'picture', media, crop, mode, alpha} | {kind:'pattern', preset, fg, bg}`.
 */
export function paintOf(ctx, f, ph) {
  if (!f || f.kind === 'none') return {kind: 'none'};
  if (f.kind === 'solid') return {kind: 'solid', color: ctxColor(ctx, f.color, ph)};
  if (f.kind === 'gradient') return {kind: 'gradient', stops: (f.stops ?? []).map(s => ({pos: s.pos, color: ctxColor(ctx, s.color, ph)})),
    linear: f.shape?.kind === 'linear' ? {angle: f.shape.angle ?? 0, scaled: !!f.shape.scaled} : null, path: f.shape?.kind === 'path' ? f.shape.path : null,
    focus: f.shape?.focus ?? null, rotateWithShape: f.rotateWithShape !== false};
  if (f.kind === 'pattern') return {kind: 'pattern', preset: f.preset, fg: ctxColor(ctx, f.fg, ph), bg: ctxColor(ctx, f.bg, ph)};
  if (f.kind === 'picture') return {kind: 'picture', media: f.media, crop: f.crop ?? [0, 0, 0, 0], mode: f.mode ?? {kind: 'stretch'}, alpha: f.alpha ?? null};
  return {kind: 'none'};
}

/** Everything the surface needs to paint shape `sh` at its size: geometry, fill/line paints, dash, heads. */
export function shapePaint(ctx, sh, w, h, {background} = {}) {
  const geo = shapeGeometry(sh, w, h);
  const [f, fph] = resolveFill(ctx, sh);
  const [l, lph] = resolveLine(ctx, sh);
  let fill = paintOf(ctx, f, fph);
  if (f?.kind === 'background' && background) fill = background;
  const lineFill = l.fill ? paintOf(ctx, l.fill, lph) : {kind: 'none'};
  const lw = l.width ?? 0.75;
  const pattern = dashPattern(l.dash);
  const presetName = sh.geom?.kind === 'preset' ? sh.geom.name : null;
  const join = l.join ?? (presetName && mitredByDefault(presetName) ? 'miter' : 'round');
  const [effects] = resolveEffects(ctx, sh);
  const heads = lineFill.kind !== 'none' && (l.head || l.tail) ? arrowheads(l, geo, lw) : [];
  const trims = heads.length ? headTrims(l, lw) : [0, 0];
  return {geo, fill, line: {paint: lineFill, width: lw, dash: pattern.map(v => v * lw), cap: l.cap ?? 'flat', join, compound: l.compound ?? 'single', sketch: l.sketch ?? null, heads, trims,
    color: lineFill.kind === 'solid' ? lineFill.color : BLACK}, effects, alpha: f?.kind === 'solid' ? colorAlpha(f.color) : 1};
}
