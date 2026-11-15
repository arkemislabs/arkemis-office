// Preset shape geometry: builds the outline, text rectangle, adjust handles and connection sites
// of a preset at a size with adjust values (ratios in 1/100 000, angles in 1/60 000 degree).
// Translated from deckcraft crates/geom/src/preset/build.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {pt, add, sub, mul, hypot, normalize, rect, rectInset, rectAbs, rectFromPoints, applyAffine, arcToCubics, ZERO} from '../kurbo.mjs';
import {
  Pb, fill, fillEo, fillOnly, shade, strokeOnly, simple, vis, polygonRegular, star, starTextRect, cornerRect, Corner, SQUARE4, midSites,
  Dir, orient, lenThick, arrow, doubleArrow, specPts, ellipseSites, tipHandle, handle, angleHandle, FillMode, fmax, fmin, clamp, rad, deg,
} from './builder.mjs';
import {info} from './catalog.mjs';
import {actionButton, cloud, math, ribbon, scroll, wedgeRect} from './shapes.mjs';
import {buildExtra} from './extra.mjs';

const R4 = r => [Corner.round(r), Corner.round(r), Corner.round(r), Corner.round(r)];

/**
 * Builds the geometry for preset `name` at size `w`×`h` with adjust values `adj` (missing values
 * use the preset's defaults). Unknown names return null; the caller falls back to `rect`.
 * @returns {{paths: {path: object[], fill: string, stroke: boolean, evenOdd: boolean}[], textRect: object, handles: object[], sites: object[]} | null}
 */
export function build(name, w, h, adj = []) {
  if (!(Number.isFinite(w) && Number.isFinite(h))) return null;
  const defaults = info(name)?.defaults ?? [];
  const c = {name, w: fmax(w, 0), h: fmax(h, 0), a(i) {
    const v = adj[i] ?? defaults[i] ?? 0;
    return Number.isFinite(v) ? v : 0;
  }};
  return rectAndTriangleShapes(c) ?? polygonAndSymbolShapes(c) ?? bracketAndArrowShapes(c) ?? flowchartAndStarShapes(c)
    ?? calloutWaveAndConnectorShapes(c) ?? buildExtra(name, c.w, c.h, i => c.a(i));
}

function rectAndTriangleShapes(c) {
  const {name, w, h} = c;
  const ss = fmin(w, h);
  const full = rect(0, 0, w, h);
  const a = i => c.a(i);
  const b = new Pb();
  switch (name) {
    case 'rect': case 'textBox': case 'flowChartProcess': return simple(cornerRect(w, h, SQUARE4), full, w, h);
    case 'actionButtonBlank': case 'actionButtonBackPrevious': case 'actionButtonForwardNext': case 'actionButtonBeginning': case 'actionButtonEnd':
    case 'actionButtonHome': case 'actionButtonInformation': case 'actionButtonReturn': case 'actionButtonMovie': case 'actionButtonDocument':
    case 'actionButtonSound': case 'actionButtonHelp':
      return actionButton(name, w, h);
    case 'roundRect': {
      const v = clamp(a(0), 0, 50000);
      const r = (ss * v) / 100000;
      const g = simple(cornerRect(w, h, R4(r)), rectInset(full, -r * 0.29289), w, h);
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'flowChartAlternateProcess': return simple(cornerRect(w, h, R4(ss / 6)), rectInset(full, (-ss / 6) * 0.29289), w, h);
    case 'snip1Rect': {
      const v = clamp(a(0), 0, 50000);
      const d = (ss * v) / 100000;
      const g = simple(cornerRect(w, h, [Corner.square(), Corner.snip(d), Corner.square(), Corner.square()]), rect(0, d / 2, w - d / 2, h), w, h);
      g.handles.push(handle(0, pt(w, 0), pt(-ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'snip2SameRect': {
      const d1 = (ss * clamp(a(0), 0, 50000)) / 1e5, d2 = (ss * clamp(a(1), 0, 50000)) / 1e5;
      return simple(cornerRect(w, h, [Corner.snip(d1), Corner.snip(d1), Corner.snip(d2), Corner.snip(d2)]), rectInset(full, -fmax(d1, d2) / 2), w, h);
    }
    case 'snip2DiagRect': {
      const d1 = (ss * clamp(a(0), 0, 50000)) / 1e5, d2 = (ss * clamp(a(1), 0, 50000)) / 1e5;
      return simple(cornerRect(w, h, [Corner.snip(d1), Corner.snip(d2), Corner.snip(d1), Corner.snip(d2)]), rectInset(full, -fmax(d1, d2) / 2), w, h);
    }
    case 'snipRoundRect': {
      const r = (ss * clamp(a(0), 0, 50000)) / 1e5, d = (ss * clamp(a(1), 0, 50000)) / 1e5;
      return simple(cornerRect(w, h, [Corner.round(r), Corner.snip(d), Corner.square(), Corner.square()]), rectInset(full, -fmax(r, d) / 2), w, h);
    }
    case 'round1Rect': {
      const r = (ss * clamp(a(0), 0, 50000)) / 1e5;
      return simple(cornerRect(w, h, [Corner.square(), Corner.round(r), Corner.square(), Corner.square()]), rectInset(full, -r * 0.29289), w, h);
    }
    case 'round2SameRect': {
      const r1 = (ss * clamp(a(0), 0, 50000)) / 1e5, r2 = (ss * clamp(a(1), 0, 50000)) / 1e5;
      return simple(cornerRect(w, h, [Corner.round(r1), Corner.round(r1), Corner.round(r2), Corner.round(r2)]), rectInset(full, -fmax(r1, r2) * 0.29289), w, h);
    }
    case 'round2DiagRect': {
      const r1 = (ss * clamp(a(0), 0, 50000)) / 1e5, r2 = (ss * clamp(a(1), 0, 50000)) / 1e5;
      return simple(cornerRect(w, h, [Corner.round(r1), Corner.round(r2), Corner.round(r1), Corner.round(r2)]), rectInset(full, -fmax(r1, r2) * 0.29289), w, h);
    }
    case 'ellipse': case 'flowChartConnector': {
      const g = simple(b.ellipse(w / 2, h / 2, w / 2, h / 2).take(), rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), w, h);
      g.sites = ellipseSites(w, h);
      return g;
    }
    case 'triangle': case 'flowChartExtract': {
      const v = name === 'triangle' ? clamp(a(0), 0, 100000) : 50000;
      const ax = (w * v) / 100000;
      const g = simple(b.poly([[0, h], [ax, 0], [w, h]]).take(), rect(ax / 2, h / 2, (ax + w) / 2, h), w, h);
      g.sites = [pt(ax, 0), pt(ax / 2, h / 2), pt(0, h), pt(w / 2, h), pt(w, h), pt((ax + w) / 2, h / 2)];
      if (name === 'triangle') g.handles.push(handle(0, ZERO, pt(w / 100000, 0), v, 0, 100000));
      return g;
    }
    case 'flowChartMerge': return simple(b.poly([[0, 0], [w, 0], [w / 2, h]]).take(), rect(w / 4, 0, w * 0.75, h / 2), w, h);
    case 'rtTriangle': return simple(b.poly([[0, 0], [0, h], [w, h]]).take(), rect(w / 12, (h * 7) / 12, (w * 7) / 12, (h * 11) / 12), w, h);
    case 'parallelogram': case 'flowChartInputOutput': {
      const max = (100000 * w) / fmax(ss, 1e-9);
      const v = name === 'parallelogram' ? clamp(a(0), 0, max) : (20000 * w) / fmax(ss, 1e-9);
      const off = (ss * v) / 100000;
      const g = simple(b.poly([[0, h], [off, 0], [w, 0], [w - off, h]]).take(),
        rect(off / 2 + off * 0.2, h * 0.08, w - off / 2 - off * 0.2, h * 0.92), w, h);
      if (name === 'parallelogram') g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, max));
      return g;
    }
    case 'trapezoid': {
      const max = (50000 * w) / fmax(ss, 1e-9);
      const v = clamp(a(0), 0, max);
      const off = (ss * v) / 100000;
      const g = simple(b.poly([[0, h], [off, 0], [w - off, 0], [w, h]]).take(), rect(off * 0.66, h * 0.2, w - off * 0.66, h), w, h);
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, max));
      return g;
    }
    case 'flowChartManualOperation': return simple(b.poly([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]).take(), rect(w * 0.2, 0, w * 0.8, h), w, h);
    case 'diamond': case 'flowChartDecision':
      return simple(b.poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]).take(), rect(w / 4, h / 4, w * 0.75, h * 0.75), w, h);
    case 'flowChartSort': {
      const d = b.poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]).take();
      const line = new Pb().m(0, h / 2).l(w, h / 2).take();
      return {paths: [fill(d), strokeOnly(line)], textRect: rect(w / 4, h / 4, w * 0.75, h * 0.75), handles: [], sites: midSites(w, h)};
    }
    default: return null;
  }
}

function polygonAndSymbolShapes(c) {
  const {name, w, h} = c;
  const ss = fmin(w, h);
  const full = rect(0, 0, w, h);
  const a = i => c.a(i);
  const b = new Pb();
  switch (name) {
    case 'pentagon': return simple(b.poly(polygonRegular(5, w, h, -90)).take(), rect(w * 0.2, h * 0.27, w * 0.8, h * 0.9), w, h);
    case 'heptagon': return simple(b.poly(polygonRegular(7, w, h, -90)).take(), rect(w * 0.16, h * 0.2, w * 0.84, h * 0.86), w, h);
    case 'decagon': return simple(b.poly(polygonRegular(10, w, h, 0)).take(), rect(w * 0.1, h * 0.17, w * 0.9, h * 0.83), w, h);
    case 'dodecagon': return simple(b.poly(polygonRegular(12, w, h, 15)).take(), rect(w * 0.13, h * 0.13, w * 0.87, h * 0.87), w, h);
    case 'hexagon': case 'flowChartPreparation': {
      const max = (50000 * w) / fmax(ss, 1e-9);
      const v = name === 'hexagon' ? clamp(a(0), 0, max) : (20000 * w) / fmax(ss, 1e-9);
      const off = (ss * v) / 100000;
      const g = simple(b.poly([[0, h / 2], [off, 0], [w - off, 0], [w, h / 2], [w - off, h], [off, h]]).take(),
        rect(off * 0.6, h * 0.14, w - off * 0.6, h * 0.86), w, h);
      if (name === 'hexagon') g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, max));
      return g;
    }
    case 'octagon': {
      const v = clamp(a(0), 0, 50000);
      const d = (ss * v) / 100000;
      const g = simple(b.poly([[d, 0], [w - d, 0], [w, d], [w, h - d], [w - d, h], [d, h], [0, h - d], [0, d]]).take(), rectInset(full, -d / 2), w, h);
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'plus': {
      const v = clamp(a(0), 0, 50000);
      const d = (ss * v) / 100000;
      const g = simple(b.poly([[d, 0], [w - d, 0], [w - d, d], [w, d], [w, h - d], [w - d, h - d], [w - d, h], [d, h], [d, h - d], [0, h - d], [0, d], [d, d]]).take(),
        rect(0, d, w, h - d), w, h);
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'frame': {
      const v = clamp(a(0), 0, 50000);
      const t = (ss * v) / 100000;
      b.poly([[0, 0], [w, 0], [w, h], [0, h]]);
      b.poly([[t, t], [w - t, t], [w - t, h - t], [t, h - t]]);
      const g = {paths: [fillEo(b.take())], textRect: rectInset(full, -t), handles: [], sites: midSites(w, h)};
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'halfFrame': {
      const t1 = (ss * clamp(a(0), 0, 50000)) / 1e5, t2 = (ss * clamp(a(1), 0, 50000)) / 1e5;
      return simple(b.poly([[0, 0], [w, 0], [w - t1, t1], [t2, t1], [t2, h - t2], [0, h]]).take(), full, w, h);
    }
    case 'corner': {
      const t1 = (ss * clamp(a(0), 0, 100000)) / 1e5, t2 = (ss * clamp(a(1), 0, 100000)) / 1e5;
      return simple(b.poly([[0, 0], [t2, 0], [t2, h - t1], [w, h - t1], [w, h], [0, h]]).take(), rect(0, h - t1, w, h), w, h);
    }
    case 'diagStripe': {
      const k = clamp(a(0), 0, 100000) / 1e5;
      return simple(b.poly([[0, h * k], [w * k, 0], [w, 0], [0, h]]).take(), rect(0, 0, w / 2, h / 2), w, h);
    }
    case 'plaque': {
      const v = clamp(a(0), 0, 50000);
      const r = (ss * v) / 100000;
      b.m(0, r).arc(r, r, 90, -90).l(w - r, 0).arc(r, r, 180, -90).l(w, h - r).arc(r, r, 270, -90).l(r, h).arc(r, r, 0, -90).z();
      const g = simple(b.take(), rectInset(full, -r * 0.7), w, h);
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'can': case 'flowChartMagneticDisk': {
      // The disk's ends are a third of its height (ECMA-376: ellipses of radius h/6).
      const max = (50000 * h) / fmax(ss, 1e-9);
      const v = name === 'can' ? clamp(a(0), 0, max) : ((100000 / 3) * h) / fmax(ss, 1e-9);
      const eh = (ss * v) / 100000;
      const r = eh / 2;
      const body = new Pb().m(0, r).l(0, h - r).arc(w / 2, r, 180, -180).l(w, r).arc(w / 2, r, 0, -180).z().take();
      const top = new Pb().ellipse(w / 2, r, w / 2, r).take();
      const g = {paths: [fill(body), shade(top, name === 'can' ? FillMode.Lighten : FillMode.Norm)], textRect: rect(0, eh, w, h - r), handles: [], sites: midSites(w, h)};
      if (name === 'can') g.handles.push(handle(0, pt(w / 2, 0), pt(0, ss / 100000), v, 0, max));
      return g;
    }
    case 'flowChartMagneticDrum': {
      // ECMA-376: end ellipses of radius w/6 across.
      const r = w / 6;
      const body = new Pb().m(r, 0).l(w - r, 0).arc(r, h / 2, 270, 180).l(r, h).arc(r, h / 2, 90, 180).z().take();
      const side = new Pb().m(w - r, 0).arc(r, h / 2, 270, -180).take();
      return {paths: [fill(body), strokeOnly(side)], textRect: rect(r, 0, w - 2 * r, h), handles: [], sites: midSites(w, h)};
    }
    case 'cube': {
      const v = clamp(a(0), 0, 100000);
      const d = (ss * v) / 100000;
      const front = new Pb().poly([[0, d], [w - d, d], [w - d, h], [0, h]]).take();
      const top = new Pb().poly([[0, d], [d, 0], [w, 0], [w - d, d]]).take();
      const side = new Pb().poly([[w - d, d], [w, 0], [w, h - d], [w - d, h]]).take();
      const g = {paths: [fill(front), shade(top, FillMode.LightenLess), shade(side, FillMode.DarkenLess)], textRect: rect(0, d, w - d, h), handles: [], sites: midSites(w, h)};
      g.handles.push(handle(0, pt(0, 0), pt(0, ss / 100000), v, 0, 100000));
      return g;
    }
    case 'bevel': {
      const v = clamp(a(0), 0, 50000);
      const d = (ss * v) / 100000;
      const inner = new Pb().poly([[d, d], [w - d, d], [w - d, h - d], [d, h - d]]).take();
      const top = new Pb().poly([[0, 0], [w, 0], [w - d, d], [d, d]]).take();
      const left = new Pb().poly([[0, 0], [d, d], [d, h - d], [0, h]]).take();
      const right = new Pb().poly([[w, 0], [w, h], [w - d, h - d], [w - d, d]]).take();
      const bottom = new Pb().poly([[0, h], [d, h - d], [w - d, h - d], [w, h]]).take();
      const g = {paths: [fill(inner), shade(top, FillMode.LightenLess), shade(left, FillMode.Lighten), shade(right, FillMode.DarkenLess), shade(bottom, FillMode.Darken)],
        textRect: rectInset(full, -d), handles: [], sites: midSites(w, h)};
      g.handles.push(handle(0, ZERO, pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'donut': {
      const v = clamp(a(0), 0, 50000);
      const t = (ss * v) / 100000;
      b.ellipse(w / 2, h / 2, w / 2, h / 2);
      b.ellipse(w / 2, h / 2, fmax(w / 2 - t, 0), fmax(h / 2 - t, 0));
      const g = {paths: [fillEo(b.take())], textRect: rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), handles: [], sites: ellipseSites(w, h)};
      g.handles.push(handle(0, pt(0, h / 2), pt(ss / 100000, 0), v, 0, 50000));
      return g;
    }
    case 'noSmoking': {
      const v = clamp(a(0), 0, 50000);
      const t = (ss * v) / 100000;
      const rx = fmax(w / 2 - t, 0), ry = fmax(h / 2 - t, 0);
      b.ellipse(w / 2, h / 2, w / 2, h / 2);
      b.ellipse(w / 2, h / 2, rx, ry);
      const ring = b.take();
      const th = Math.atan2(h, w);
      const dir = pt(Math.cos(th), Math.sin(th));
      const r = rx > 0 && ry > 0 ? (rx * ry) / Math.sqrt((ry * Math.cos(th)) ** 2 + (rx * Math.sin(th)) ** 2) : 0;
      const perp = mul(pt(-dir.y, dir.x), t / 2);
      const cc = pt(w / 2, h / 2);
      const ps = [sub(sub(cc, mul(dir, r)), perp), sub(add(cc, mul(dir, r)), perp), add(add(cc, mul(dir, r)), perp), add(sub(cc, mul(dir, r)), perp)];
      const bar = new Pb().poly(ps.map(q => [q.x, q.y])).take();
      return {paths: [fillEo(ring), fill(bar)], textRect: rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355),
        handles: [handle(0, pt(0, h / 2), pt(ss / 100000, 0), v, 0, 50000)], sites: ellipseSites(w, h)};
    }
    case 'blockArc': {
      const st = a(0) / 60000;
      const en = a(1) / 60000;
      const t = (ss * clamp(a(2), 0, 50000)) / 100000;
      let sw = en - st;
      if (sw <= 0) sw += 360;
      const rx = w / 2, ry = h / 2;
      const irx = fmax(rx - t, 0), iry = fmax(ry - t, 0);
      const s0 = vis(st, rx, ry);
      const e0 = vis(st + sw, rx, ry);
      let sweep = e0 - s0;
      if (sweep <= 0) sweep += 360;
      const si = vis(st + sw, irx, iry);
      const ei = vis(st, irx, iry);
      let isweep = ei - si;
      if (isweep >= 0) isweep -= 360;
      const p0 = pt(w / 2 + rx * Math.cos(rad(s0)), h / 2 + ry * Math.sin(rad(s0)));
      b.m(p0.x, p0.y).arc(rx, ry, s0, sweep);
      const pi = pt(w / 2 + irx * Math.cos(rad(si)), h / 2 + iry * Math.sin(rad(si)));
      b.l(pi.x, pi.y).arc(irx, iry, si, isweep).z();
      const g = simple(b.take(), full, w, h);
      const cc = pt(rx, ry);
      g.handles.push(angleHandle(0, cc, rx - t / 2, ry - t / 2, a(0)));
      // Thickness: slides inward from the outer edge along the end angle's ray.
      const pe = pt(rx + rx * Math.cos(rad(e0)), ry + ry * Math.sin(rad(e0)));
      let u = normalize(sub(cc, pe));
      if (!(Number.isFinite(u.x) && Number.isFinite(u.y))) u = ZERO;
      g.handles.push(handle(2, pe, mul(u, ss / 100000), clamp(a(2), 0, 50000), 0, 50000));
      return g;
    }
    case 'pie': case 'chord': case 'arc': {
      const rx = w / 2, ry = h / 2;
      const s = vis(a(0) / 60000, rx, ry);
      const e = vis(a(1) / 60000, rx, ry);
      let sw = e - s;
      if (sw <= 0) sw += 360;
      const p0 = pt(rx + rx * Math.cos(rad(s)), ry + ry * Math.sin(rad(s)));
      b.m(p0.x, p0.y).arc(rx, ry, s, sw);
      const text = rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355);
      let g;
      if (name === 'pie') { b.l(rx, ry).z(); g = simple(b.take(), text, w, h); }
      else if (name === 'chord') { b.z(); g = simple(b.take(), text, w, h); }
      else {
        const open = b.take();
        const f = [...open, {t: 'L', p: pt(rx, ry)}, {t: 'Z'}];
        g = {paths: [fillOnly(f), strokeOnly(open)], textRect: text, handles: [], sites: midSites(w, h)};
      }
      const cc = pt(rx, ry);
      g.handles.push(angleHandle(0, cc, rx, ry, a(0)));
      g.handles.push(angleHandle(1, cc, rx, ry, a(1)));
      return g;
    }
    case 'teardrop': {
      const k = clamp(a(0), 0, 200000) / 100000;
      const tip = [w / 2 + (w / 2) * k, h / 2 - (h / 2) * k];
      b.m(0, h / 2).arc(w / 2, h / 2, 180, 90);
      b.q(w / 2 + (w / 4) * k, 0, tip[0], tip[1]).q(w, h / 2 - (h / 4) * k, w, h / 2);
      b.arc(w / 2, h / 2, 0, 180).z();
      return simple(b.take(), rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), w, h);
    }
    case 'foldedCorner': {
      const v = clamp(a(0), 0, 50000);
      const d = (ss * v) / 100000;
      const body = new Pb().poly([[0, 0], [w, 0], [w, h - d], [w - d, h], [0, h]]).take();
      const fold = new Pb().m(w - d, h).l(w - d + d * 0.2, h - d + d * 0.2).l(w, h - d).z().take();
      return {paths: [fill(body), shade(fold, FillMode.DarkenLess)], textRect: rect(0, 0, w, h - d), handles: [], sites: midSites(w, h)};
    }
    case 'smileyFace': {
      const k = clamp(a(0), -4653, 4653) / 100000;
      const face = new Pb().ellipse(w / 2, h / 2, w / 2, h / 2).take();
      const eyes = new Pb();
      eyes.ellipse(w * 0.35, h * 0.37, w * 0.05, h * 0.05);
      eyes.ellipse(w * 0.65, h * 0.37, w * 0.05, h * 0.05);
      const ys = h * (0.72 - k);
      const smile = new Pb().m(w * 0.22, ys).q(w / 2, ys + h * k * 4 + h * 0, w * 0.78, ys).take();
      return {paths: [fill(face), shade(eyes.take(), FillMode.DarkenLess), strokeOnly(smile)],
        textRect: rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), handles: [], sites: ellipseSites(w, h)};
    }
    case 'heart': {
      // ECMA-376 heart: two cubic curves from the notch at the top to the point.
      const dx1 = (w * 49) / 48, dx2 = (w * 10) / 48;
      const y1 = -h / 3;
      b.m(w / 2, h / 4).c(w / 2 + dx2, y1, w / 2 + dx1, h / 4, w / 2, h).c(w / 2 - dx1, h / 4, w / 2 - dx2, y1, w / 2, h / 4).z();
      return simple(b.take(), rect(w * 0.2, h * 0.25, w * 0.8, h * 0.7), w, h);
    }
    case 'lightningBolt': {
      // ECMA-376 lightningBolt, in 21600ths of the box.
      const ps = specPts([[8472, 0], [12860, 6080], [11050, 6797], [16577, 12007], [14767, 12877], [21600, 21600], [10012, 14915], [12222, 13987],
        [5022, 9705], [7602, 8382], [0, 3890]], w, h);
      return simple(b.poly(ps).take(), rect((w * 8757) / 21600, (h * 7637) / 21600, (w * 13917) / 21600, (h * 12963) / 21600), w, h);
    }
    case 'sun': {
      // ECMA-376 sun: eight triangular rays around a circle of radius 50% - adj.
      const av = clamp(a(0), 12500, 46875);
      const g0 = 50000 - av;
      const g1 = (g0 * 30274) / 32768, g2 = (g0 * 12540) / 32768;
      const g10 = (50000 - g1) * 0.75, g11 = (50000 - g2) * 0.75;
      const g12 = g10 + 3662, g13 = g11 + 3662, g14 = g11 + 12500;
      const g15 = 100000 - g10, g16 = 100000 - g12, g17 = 100000 - g13, g18 = 100000 - g14;
      const x = g => (w * g) / 100000;
      const y = g => (h * g) / 100000;
      const ox1 = (w * 18436) / 21600, oy1 = (h * 3163) / 21600, ox2 = (w * 3163) / 21600, oy2 = (h * 18436) / 21600;
      const hc = w / 2, vc = h / 2;
      b.poly([[w, vc], [x(g15), y(g18)], [x(g15), y(g14)]]);
      b.poly([[ox1, oy1], [x(g16), y(g13)], [x(g17), y(g12)]]);
      b.poly([[hc, 0], [x(g18), y(g10)], [x(g14), y(g10)]]);
      b.poly([[ox2, oy1], [x(g13), y(g12)], [x(g12), y(g13)]]);
      b.poly([[0, vc], [x(g10), y(g14)], [x(g10), y(g18)]]);
      b.poly([[ox2, oy2], [x(g12), y(g17)], [x(g13), y(g16)]]);
      b.poly([[hc, h], [x(g14), y(g15)], [x(g18), y(g15)]]);
      b.poly([[ox1, oy2], [x(g17), y(g16)], [x(g16), y(g17)]]);
      b.ellipse(hc, vc, x(g0), y(g0));
      const g7 = (g0 * 23170) / 32768;
      const g = simple(b.take(), rect(x(50000 - g7), y(50000 - g7), x(50000 + g7), y(50000 + g7)), w, h);
      g.handles.push(handle(0, pt(0, vc), pt(w / 100000, 0), av, 12500, 46875));
      return g;
    }
    case 'moon': {
      // ECMA-376 moon: the outer edge is the left half of an ellipse w × h/2 centred on the right
      // edge; the inner edge an arc through the corners and (adj · w, middle) of a larger ellipse.
      const k = clamp(a(0), 0, 87500) / 100000;
      const ssf = fmax(ss, 1e-9);
      const g0 = ss * k;
      const g1 = fmax(ss - g0, 1e-9);
      const g2 = (g0 * g0) / g1;
      const g3 = (ss * ss) / g1;
      const g5 = 2 * g3 - g2;
      const g6 = g5 - g0;
      const dy1 = ((g5 / 2 - g0) * (h / 2)) / ssf;
      const g0w = (g0 * w) / ssf, g6w = (g6 * w) / ssf;
      const rx = (g6w - g0w) / 2;
      const cx = g0w + rx;
      b.m(w, 0).arc(w, h / 2, 270, -180);
      if (rx > 1e-9 && dy1 > 1e-9) {
        const t0 = Math.atan2(clamp(h / 2 / dy1, -1, 1), (w - cx) / rx);
        const t1 = Math.atan2(clamp(-(h / 2) / dy1, -1, 1), (w - cx) / rx) + Math.PI * 2;
        arcToCubics(pt(cx, h / 2), pt(rx, dy1), t0, t1 - t0, 0, 0.05, (p1, p2, p) => b.curveTo(p1, p2, p));
      }
      b.z();
      const g12 = (g0 * 9598) / 32768;
      const g13 = ss - g12;
      const dy4 = (Math.sqrt(fmax(ss * ss - g13 * g13, 0)) * (h / 2)) / ssf;
      return simple(b.take(), rect((g12 * w) / ssf, h / 2 - dy4, g0w, h / 2 + dy4), w, h);
    }
    default: return null;
  }
}

const MIRROR_X = w => [-1, 0, 0, 1, w, 0];

function bracketAndArrowShapes(c) {
  const {name, w, h} = c;
  const ss = fmin(w, h);
  const full = rect(0, 0, w, h);
  const a = i => c.a(i);
  const b = new Pb();
  switch (name) {
    case 'cloud': case 'cloudCallout': return cloud(name, w, h, a(0), a(1));
    case 'bracketPair': {
      const r = (ss * clamp(a(0), 0, 50000)) / 1e5;
      const l = new Pb();
      l.m(r, h).arc(r, r, 90, 90).l(0, r).arc(r, r, 180, 90);
      l.m(w - r, 0).arc(r, r, 270, 90).l(w, h - r).arc(r, r, 0, 90);
      const f = cornerRect(w, h, R4(r));
      return {paths: [fillOnly(f), strokeOnly(l.take())], textRect: rectInset(full, -r * 0.29289), handles: [], sites: midSites(w, h)};
    }
    case 'bracePair': {
      const r = (ss * clamp(a(0), 0, 25000)) / 1e5;
      const l = new Pb();
      l.m(2 * r, h).arc(r, r, 90, 90).l(r, h / 2 + r).arc(r, r, 0, -90).arc(r, r, 90, -90).l(r, r).arc(r, r, 180, 90);
      l.m(w - 2 * r, 0).arc(r, r, 270, 90).l(w - r, h / 2 - r).arc(r, r, 180, -90).arc(r, r, 270, -90).l(w - r, h - r).arc(r, r, 0, 90);
      const f = cornerRect(w, h, R4(r));
      return {paths: [fillOnly(f), strokeOnly(l.take())], textRect: rectInset(full, -r * 1.2), handles: [], sites: midSites(w, h)};
    }
    case 'leftBracket': case 'rightBracket': {
      const r = fmin((ss * clamp(a(0), 0, (50000 * h) / fmax(ss, 1e-9))) / 1e5, h / 2);
      const l = new Pb();
      l.m(w, h).arc(w, r, 90, 90).l(0, r).arc(w, r, 180, 90);
      let path = l.take();
      if (name === 'rightBracket') path = applyAffine(path, MIRROR_X(w));
      // Filled (when the shape has a fill) out to the straight side, as PowerPoint does.
      const area = [...path, {t: 'Z'}];
      return {paths: [fillOnly(area), strokeOnly(path)], textRect: full, handles: [], sites: midSites(w, h)};
    }
    case 'leftBrace': case 'rightBrace': {
      const r = fmin((ss * clamp(a(0), 0, (25000 * h) / fmax(ss, 1e-9))) / 1e5, h / 4);
      const my = (h * clamp(a(1), 0, 100000)) / 1e5;
      const hw = w / 2;
      const l = new Pb();
      l.m(w, h).arc(hw, r, 90, 90).l(hw, my + r).arc(hw, r, 0, -90).arc(hw, r, 90, -90).l(hw, r).arc(hw, r, 180, 90);
      let path = l.take();
      if (name === 'rightBrace') path = applyAffine(path, MIRROR_X(w));
      const area = [...path, {t: 'Z'}];
      return {paths: [fillOnly(area), strokeOnly(path)], textRect: full, handles: [], sites: midSites(w, h)};
    }
    case 'rightArrow': return arrow(Dir.Right, w, h, a(0), a(1));
    case 'leftArrow': return arrow(Dir.Left, w, h, a(0), a(1));
    case 'upArrow': return arrow(Dir.Up, w, h, a(0), a(1));
    case 'downArrow': return arrow(Dir.Down, w, h, a(0), a(1));
    case 'leftRightArrow': return doubleArrow(false, w, h, a(0), a(1));
    case 'upDownArrow': return doubleArrow(true, w, h, a(0), a(1));
    case 'notchedRightArrow': case 'stripedRightArrow': {
      const g = arrow(Dir.Right, w, h, a(0), a(1));
      const k = clamp(a(0), 0, 100000) / 1e5;
      const y1 = h / 2 - (h * k) / 2, y2 = h / 2 + (h * k) / 2;
      const dx = fmin((ss * fmax(a(1), 0)) / 1e5, w);
      if (name === 'notchedRightArrow') {
        // The notch's edges run parallel to the head's.
        const n = dx * k;
        g.paths = [fill(new Pb().poly([[0, y1], [w - dx, y1], [w - dx, 0], [w, h / 2], [w - dx, h], [w - dx, y2], [0, y2], [n, h / 2]]).take())];
      } else {
        const s = ss / 32;
        const start = 5 * s;
        const ps = [[start, y1], [w - dx, y1], [w - dx, 0], [w, h / 2], [w - dx, h], [w - dx, y2], [start, y2]];
        const stripes = new Pb();
        stripes.poly([[0, y1], [s, y1], [s, y2], [0, y2]]);
        stripes.poly([[2 * s, y1], [4 * s, y1], [4 * s, y2], [2 * s, y2]]);
        g.paths = [fill(stripes.take()), fill(new Pb().poly(ps).take())];
      }
      return g;
    }
    case 'homePlate': case 'chevron': {
      const max = (100000 * w) / fmax(ss, 1e-9);
      const v = clamp(a(0), 0, max);
      const d = fmin((ss * v) / 1e5, w);
      const ps = name === 'homePlate' ? [[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]] : [[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]];
      const text = name === 'homePlate' ? rect(0, 0, w - d / 2, h) : w - d > d ? rect(d, 0, w - d, h) : rect(0, 0, w, h);
      const g = simple(b.poly(ps).take(), text, w, h);
      g.handles.push(handle(0, pt(w, 0), pt(-ss / 1e5, 0), v, 0, max));
      return g;
    }
    case 'quadArrow': {
      const t = (ss * clamp(a(0), 0, 50000)) / 1e5, hw = (ss * clamp(a(1), 0, 50000)) / 1e5, hl = (ss * clamp(a(2), 0, 50000)) / 1e5;
      const cx = w / 2, cy = h / 2;
      const t2 = t / 2, hw2 = hw;
      const ps = [[0, cy], [hl, cy - hw2], [hl, cy - t2], [cx - t2, cy - t2], [cx - t2, hl], [cx - hw2, hl], [cx, 0], [cx + hw2, hl], [cx + t2, hl],
        [cx + t2, cy - t2], [w - hl, cy - t2], [w - hl, cy - hw2], [w, cy], [w - hl, cy + hw2], [w - hl, cy + t2], [cx + t2, cy + t2], [cx + t2, h - hl],
        [cx + hw2, h - hl], [cx, h], [cx - hw2, h - hl], [cx - t2, h - hl], [cx - t2, cy + t2], [hl, cy + t2], [hl, cy + hw2]];
      return simple(b.poly(ps).take(), rect(cx - t2, cy - t2, cx + t2, cy + t2), w, h);
    }
    case 'leftRightUpArrow': {
      const t = (ss * clamp(a(0), 0, 50000)) / 1e5, hw = (ss * clamp(a(1), 0, 50000)) / 1e5, hl = (ss * clamp(a(2), 0, 50000)) / 1e5;
      const cx = w / 2;
      const by = h - hw; // horizontal shaft centre
      const ps = [[0, by], [hl, by - hw], [hl, by - t / 2], [cx - t / 2, by - t / 2], [cx - t / 2, hl], [cx - hw, hl], [cx, 0], [cx + hw, hl],
        [cx + t / 2, hl], [cx + t / 2, by - t / 2], [w - hl, by - t / 2], [w - hl, by - hw], [w, by], [w - hl, h], [w - hl, by + t / 2], [hl, by + t / 2], [hl, h]];
      return simple(b.poly(ps).take(), rect(hl, by - t / 2, w - hl, by + t / 2), w, h);
    }
    case 'leftUpArrow': case 'bentUpArrow': {
      const t = (ss * clamp(a(0), 0, 50000)) / 1e5, hw = (ss * clamp(a(1), 0, 50000)) / 1e5, hl = (ss * clamp(a(2), 0, 50000)) / 1e5;
      let ps;
      if (name === 'leftUpArrow') {
        const cx = w - hw, cy = h - hw;
        ps = [[0, cy], [hl, cy - hw], [hl, cy - t / 2], [cx - t / 2, cy - t / 2], [cx - t / 2, hl], [cx - hw, hl], [cx, 0], [w, hl], [cx + t / 2, hl],
          [cx + t / 2, cy + t / 2], [hl, cy + t / 2], [hl, h]];
      } else {
        const cx = w - hw;
        ps = [[0, h - t], [cx - t / 2, h - t], [cx - t / 2, hl], [cx - hw, hl], [cx, 0], [w, hl], [cx + t / 2, hl], [cx + t / 2, h], [0, h]];
      }
      return simple(b.poly(ps).take(), full, w, h);
    }
    case 'bentArrow': {
      const t = (ss * clamp(a(0), 0, 50000)) / 1e5, hw = (ss * clamp(a(1), 0, 50000)) / 1e5, hl = (ss * clamp(a(2), 0, 50000)) / 1e5;
      const r = (ss * clamp(a(3), 0, 100000)) / 1e5;
      const cy = hw;
      const ro = fmax(r, t);
      const ri = fmax(ro - t, 0);
      b.m(0, h).l(0, cy - t / 2 + ro).arc(ro, ro, 180, 90).l(w - hl, cy - t / 2).l(w - hl, 0).l(w, cy).l(w - hl, 2 * hw).l(w - hl, cy + t / 2);
      b.l(t + ri, cy + t / 2);
      if (ri > 0) b.arc(ri, ri, 270, -90);
      b.l(t, h).z();
      return simple(b.take(), full, w, h);
    }
    case 'uturnArrow': {
      const t = (ss * clamp(a(0), 0, 25000)) / 1e5, hw = (ss * clamp(a(1), 0, 25000)) / 1e5, hl = (ss * clamp(a(2), 0, 25000)) / 1e5;
      const r = (ss * clamp(a(3), 0, 100000)) / 1e5;
      const hy = fmax((h * clamp(a(4), 0, 100000)) / 1e5, hl + t);
      const ax = w - hw;
      const ro = fmin(fmax(r, t), (ax + t / 2) / 2);
      const ri = fmax(ro - t, 0);
      b.m(0, h).l(0, ro).arc(ro, ro, 180, 90).l(ax + t / 2 - ro, 0).arc(ro, ro, 270, 90);
      b.l(ax + t / 2, hy - hl).l(w, hy - hl).l(ax, hy).l(ax - hw, hy - hl).l(ax - t / 2, hy - hl).l(ax - t / 2, ro);
      if (ri > 0) b.arc(ri, ri, 0, -90);
      b.l(t + ri, t);
      if (ri > 0) b.arc(ri, ri, 270, -90);
      b.l(t, h).z();
      return simple(b.take(), full, w, h);
    }
    case 'rightArrowCallout': case 'leftArrowCallout': case 'upArrowCallout': case 'downArrowCallout': {
      const d = name === 'rightArrowCallout' ? Dir.Right : name === 'leftArrowCallout' ? Dir.Left : name === 'upArrowCallout' ? Dir.Up : Dir.Down;
      const [l, t] = lenThick(d, w, h);
      const ss2 = fmin(l, t);
      const shaft = (ss2 * clamp(a(0), 0, 100000)) / 1e5;
      const head = (ss2 * clamp(a(1), 0, 100000)) / 1e5;
      const hl = (ss2 * clamp(a(2), 0, 100000)) / 1e5;
      const boxl = fmin((l * clamp(a(3), 0, 100000)) / 1e5, l - hl);
      const cc = t / 2;
      let ps = [[0, 0], [boxl, 0], [boxl, cc - shaft / 2], [l - hl, cc - shaft / 2], [l - hl, cc - head], [l, cc], [l - hl, cc + head], [l - hl, cc + shaft / 2],
        [boxl, cc + shaft / 2], [boxl, t], [0, t]];
      ps = orient(d, w, h, ps);
      const tr = orient(d, w, h, [[0, 0], [boxl, t]]);
      return simple(b.poly(ps).take(), rectAbs(rectFromPoints(pt(tr[0][0], tr[0][1]), pt(tr[1][0], tr[1][1]))), w, h);
    }
    case 'mathPlus': case 'mathMinus': case 'mathEqual': case 'mathDivide': case 'mathMultiply': case 'mathNotEqual':
      return math(name, w, h, a(0), a(1), a(2));
    default: return null;
  }
}

function flowchartAndStarShapes(c) {
  const {name, w, h} = c;
  const ss = fmin(w, h);
  const full = rect(0, 0, w, h);
  const a = i => c.a(i);
  const b = new Pb();
  switch (name) {
    case 'flowChartPredefinedProcess': {
      const r = new Pb().poly([[0, 0], [w, 0], [w, h], [0, h]]).take();
      const l = new Pb();
      l.m(w / 8, 0).l(w / 8, h).m((w * 7) / 8, 0).l((w * 7) / 8, h);
      return {paths: [fill(r), strokeOnly(l.take())], textRect: rect(w / 8, 0, (w * 7) / 8, h), handles: [], sites: midSites(w, h)};
    }
    case 'flowChartInternalStorage': {
      const r = new Pb().poly([[0, 0], [w, 0], [w, h], [0, h]]).take();
      const l = new Pb();
      l.m(w / 8, 0).l(w / 8, h).m(0, h / 8).l(w, h / 8);
      return {paths: [fill(r), strokeOnly(l.take())], textRect: rect(w / 8, h / 8, w, h), handles: [], sites: midSites(w, h)};
    }
    case 'flowChartDocument': {
      const u = (x, y) => [(w * x) / 21600, (h * y) / 21600];
      const p1 = u(21600, 17322), p2 = u(10800, 17322), p3 = u(10800, 23922), p4 = u(0, 20172);
      b.m(0, 0).l(w, 0).l(p1[0], p1[1]).c(p2[0], p2[1], p3[0], p3[1], p4[0], p4[1]).z();
      return simple(b.take(), rect(0, 0, w, (h * 17322) / 21600), w, h);
    }
    case 'flowChartMultidocument': {
      // ECMA-376 multidocument (21600ths): two back pages peeking out above and right of the
      // front one; the back pages' edges are outlined only where they show.
      const x = v => (w * v) / 21600;
      const y = v => (h * v) / 21600;
      const front = p => { p.m(0, y(20782)).c(x(9298), y(23542), x(9298), y(18022), x(18595), y(18022)).l(x(18595), y(3675)).l(0, y(3675)).z(); };
      const mid = p => {
        p.m(x(1532), y(3675)).l(x(1532), y(1815)).l(x(20000), y(1815)).l(x(20000), y(16252));
        p.c(x(19298), y(16252), x(18595), y(16352), x(18595), y(16352));
      };
      const back = p => {
        p.m(x(2972), y(1815)).l(x(2972), 0).l(w, 0).l(w, y(14392));
        p.c(x(20800), y(14392), x(20000), y(14467), x(20000), y(14467));
      };
      const area = new Pb();
      front(area);
      mid(area);
      area.l(x(18595), y(3675)).z();
      back(area);
      area.l(x(20000), y(1815)).z();
      const outlineP = new Pb();
      outlineP.m(0, y(3675)).l(x(18595), y(3675)).l(x(18595), y(18022));
      outlineP.c(x(9298), y(18022), x(9298), y(23542), 0, y(20782)).z();
      mid(outlineP);
      back(outlineP);
      return {paths: [fillOnly(area.take()), strokeOnly(outlineP.take())], textRect: rect(0, y(3675), x(18595), y(17322)), handles: [], sites: midSites(w, h)};
    }
    case 'flowChartTerminator': {
      const rx = fmin(w * 0.16, w / 2);
      b.m(rx, 0).l(w - rx, 0).arc(rx, h / 2, 270, 180).l(rx, h).arc(rx, h / 2, 90, 180).z();
      return simple(b.take(), rect(rx * 0.3, h * 0.15, w - rx * 0.3, h * 0.85), w, h);
    }
    case 'flowChartManualInput': return simple(b.poly([[0, h / 5], [w, 0], [w, h], [0, h]]).take(), rect(0, h / 5, w, h), w, h);
    case 'flowChartOffpageConnector': return simple(b.poly([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]).take(), rect(0, 0, w, h * 0.8), w, h);
    case 'flowChartPunchedCard': return simple(b.poly([[w * 0.2, 0], [w, 0], [w, h], [0, h], [0, h * 0.2]]).take(), rect(0, h * 0.2, w, h), w, h);
    case 'flowChartPunchedTape': {
      // ECMA-376: each long edge is two half-ellipses a quarter of the width wide and a tenth of
      // the height deep, one bulging in and one out.
      const rx = w / 4, ry = h / 10;
      b.m(0, ry).arc(rx, ry, 180, -180).arc(rx, ry, 180, 180).l(w, h - ry).arc(rx, ry, 0, -180).arc(rx, ry, 0, 180).z();
      return simple(b.take(), rect(0, h / 5, w, h * 0.8), w, h);
    }
    case 'flowChartSummingJunction': case 'flowChartOr': {
      const e = new Pb().ellipse(w / 2, h / 2, w / 2, h / 2).take();
      const l = new Pb();
      if (name === 'flowChartOr') l.m(w / 2, 0).l(w / 2, h).m(0, h / 2).l(w, h / 2);
      else {
        const dx = (w / 2) * Math.SQRT1_2, dy = (h / 2) * Math.SQRT1_2;
        l.m(w / 2 - dx, h / 2 - dy).l(w / 2 + dx, h / 2 + dy).m(w / 2 + dx, h / 2 - dy).l(w / 2 - dx, h / 2 + dy);
      }
      return {paths: [fill(e), strokeOnly(l.take())], textRect: rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), handles: [], sites: ellipseSites(w, h)};
    }
    case 'flowChartCollate': return simple(b.poly([[0, 0], [w, 0], [0, h], [w, h]]).take(), rect(w / 4, h / 4, w * 0.75, h * 0.75), w, h);
    case 'flowChartOnlineStorage': {
      const rx = w / 6;
      b.m(rx, 0).l(w, 0).arc(rx, h / 2, 270, -180).l(rx, h).arc(rx, h / 2, 90, 180).z();
      return simple(b.take(), rect(rx, 0, w - rx, h), w, h);
    }
    case 'flowChartDelay': {
      b.m(0, 0).l(w / 2, 0).arc(w / 2, h / 2, 270, 180).l(0, h).z();
      return simple(b.take(), rect(0, h * 0.15, w * 0.85, h * 0.85), w, h);
    }
    case 'flowChartMagneticTape': {
      b.m(w / 2, h).arc(w / 2, h / 2, 90, 90).arc(w / 2, h / 2, 180, 90).arc(w / 2, h / 2, 270, 90).arc(w / 2, h / 2, 0, 45);
      const q = b.cur;
      b.l(w, q.y).l(w, h).z();
      return simple(b.take(), rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), w, h);
    }
    case 'flowChartDisplay': {
      const rx = w / 6;
      b.m(0, h / 2).l(rx, 0).l(w - rx, 0).arc(rx, h / 2, 270, 180).l(rx, h).z();
      return simple(b.take(), rect(rx, 0, w - rx, h), w, h);
    }
    case 'star4': case 'star5': case 'star6': case 'star7': case 'star8': case 'star10': case 'star12': case 'star16': case 'star24': case 'star32': {
      const n = Number.parseInt(name.slice(4), 10) || 5;
      const v = clamp(a(0), 0, 50000);
      const inner = v / 50000;
      const text = starTextRect(n, w, h, inner) ?? rectInset(full, -ss * (0.5 - inner * 0.5) * 0.5);
      const g = simple(b.poly(star(n, w, h, inner)).take(), text, w, h);
      g.handles.push(handle(0, pt(w / 2, h / 2), pt(0, -h / 2 / 50000), v, 0, 50000));
      return g;
    }
    case 'irregularSeal1': {
      const ps = specPts([[10800, 5800], [14522, 0], [14155, 5325], [18380, 4457], [16702, 7315], [21097, 8137], [17607, 10475], [21600, 13290],
        [16837, 12942], [18145, 18095], [14020, 14457], [13247, 19737], [10532, 14935], [8485, 21600], [7715, 15627], [4762, 17617], [5667, 13937],
        [135, 14587], [3722, 11775], [0, 8615], [4627, 7617], [370, 2295], [7312, 6320], [8352, 2295]], w, h);
      return simple(b.poly(ps).take(), rect((w * 4627) / 21600, (h * 6320) / 21600, (w * 16702) / 21600, (h * 13937) / 21600), w, h);
    }
    case 'irregularSeal2': {
      const ps = specPts([[11462, 4342], [14790, 0], [14525, 5777], [18007, 3172], [16380, 6532], [21600, 6645], [16985, 9402], [18270, 11290],
        [16380, 12310], [18877, 15632], [14640, 14350], [14942, 17370], [12180, 15935], [11612, 18842], [9872, 17370], [8700, 19712], [7527, 18125],
        [4917, 21600], [4805, 18240], [1285, 17825], [3330, 15370], [0, 12877], [3935, 11592], [1172, 8270], [5372, 7817], [4502, 3625], [8550, 6382],
        [9722, 1887]], w, h);
      return simple(b.poly(ps).take(), rect((w * 5372) / 21600, (h * 6382) / 21600, (w * 14640) / 21600, (h * 15935) / 21600), w, h);
    }
    default: return null;
  }
}

function calloutWaveAndConnectorShapes(c) {
  const {name, w, h} = c;
  const ss = fmin(w, h);
  const full = rect(0, 0, w, h);
  const a = i => c.a(i);
  const b = new Pb();
  switch (name) {
    case 'ribbon': case 'ribbon2': return ribbon(name === 'ribbon2', w, h, a(0), a(1));
    case 'verticalScroll': case 'horizontalScroll': return scroll(name === 'verticalScroll', w, h, a(0));
    case 'wave': case 'doubleWave': {
      // ECMA-376 wave / doubleWave: the top and bottom edges are cubic waves (one or two periods)
      // of amplitude adj1, shifted sideways by adj2.
      const a1 = clamp(a(0), 0, name === 'wave' ? 20000 : 12500);
      const a2 = clamp(a(1), -10000, 10000);
      const y1 = (h * a1) / 100000;
      const dy2 = (y1 * 10) / 3;
      const y2 = y1 - dy2, y3 = y1 + dy2, y4 = h - y1;
      const y5 = y4 - dy2, y6 = y4 + dy2;
      const of2 = (w * a2) / 50000;
      const dx2 = fmin(of2, 0);
      const dxr = fmax(of2, 0);
      const x2 = -dx2, xr = w - dxr, xl = dxr, x10 = w + dx2;
      const textY = (h * a1) / 50000;
      if (name === 'wave') {
        const dx3 = (dx2 + xr) / 3;
        const x3 = x2 + dx3, x7 = xl + dx3;
        const x4 = (x3 + xr) / 2, x8 = (x7 + x10) / 2;
        b.m(x2, y1).c(x3, y2, x4, y3, xr, y1).l(x10, y4).c(x8, y6, x7, y5, xl, y4).z();
      } else {
        const dx3 = (dx2 + xr) / 6, dx4 = (dx2 + xr) / 3;
        const x3 = x2 + dx3, x4 = x2 + dx4, x5 = (x2 + xr) / 2;
        const x6 = x5 + dx3;
        const x7 = (x6 + xr) / 2;
        const x10b = xl + dx3, x11 = xl + dx4, x12 = (xl + x10) / 2;
        const x13 = x12 + dx3;
        const x14 = (x13 + x10) / 2;
        b.m(x2, y1).c(x3, y2, x4, y3, x5, y1).c(x6, y2, x7, y3, xr, y1).l(x10, y4);
        b.c(x14, y6, x13, y5, x12, y4).c(x11, y6, x10b, y5, xl, y4).z();
      }
      return simple(b.take(), rect(fmax(x2, xl), textY, fmin(xr, x10), h - textY), w, h);
    }
    case 'wedgeRectCallout': case 'wedgeRoundRectCallout': {
      const r = name === 'wedgeRoundRectCallout' ? (ss * clamp(a(2), 0, 50000)) / 1e5 : 0;
      return wedgeRect(w, h, a(0), a(1), r);
    }
    case 'wedgeEllipseCallout': {
      const tip = pt(w / 2 + (w * a(0)) / 1e5, h / 2 + (h * a(1)) / 1e5);
      const ang = deg(Math.atan2(tip.y - h / 2, tip.x - w / 2));
      const s = vis(ang + 10, w / 2, h / 2);
      const p0 = pt(w / 2 + (w / 2) * Math.cos(rad(s)), h / 2 + (h / 2) * Math.sin(rad(s)));
      const e = vis(ang - 10, w / 2, h / 2);
      let sw = e - s;
      if (sw <= 0) sw += 360;
      b.m(p0.x, p0.y).arc(w / 2, h / 2, s, sw).l(tip.x, tip.y).z();
      const g = simple(b.take(), rect(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355), w, h);
      g.handles = [tipHandle(w, h, tip)];
      return g;
    }
    case 'borderCallout1': {
      const r = new Pb().poly([[0, 0], [w, 0], [w, h], [0, h]]).take();
      const p1 = [(w * a(1)) / 1e5, (h * a(0)) / 1e5];
      const p2 = [(w * a(3)) / 1e5, (h * a(2)) / 1e5];
      const l = new Pb().m(p1[0], p1[1]).l(p2[0], p2[1]).take();
      return {paths: [fill(r), strokeOnly(l)], textRect: full, handles: [], sites: midSites(w, h)};
    }
    case 'line': case 'straightConnector1': {
      const l = new Pb().m(0, 0).l(w, h).take();
      return {paths: [strokeOnly(l)], textRect: full, handles: [], sites: [ZERO, pt(w, h)]};
    }
    case 'bentConnector2': {
      const l = new Pb().m(0, 0).l(w, 0).l(w, h).take();
      return {paths: [strokeOnly(l)], textRect: full, handles: [], sites: [ZERO, pt(w, h)]};
    }
    case 'bentConnector3': case 'bentConnector4': case 'bentConnector5': {
      const x = (w * a(0)) / 1e5;
      const l = new Pb().m(0, 0).l(x, 0).l(x, h).l(w, h).take();
      const g = {paths: [strokeOnly(l)], textRect: full, handles: [], sites: [ZERO, pt(w, h)]};
      g.handles.push(handle(0, pt(0, h / 2), pt(w / 1e5, 0), a(0), -1e6, 1e6));
      return g;
    }
    case 'curvedConnector2': case 'curvedConnector3': case 'curvedConnector4': case 'curvedConnector5': {
      const x = (w * (name === 'curvedConnector2' ? 100000 : a(0))) / 1e5;
      const l = new Pb().m(0, 0).c(x / 2, 0, x, h / 4, x, h / 2).c(x, h * 0.75, (x + w) / 2, h, w, h).take();
      return {paths: [strokeOnly(l)], textRect: full, handles: [], sites: [ZERO, pt(w, h)]};
    }
    default: return null;
  }
}

export {hypot};
