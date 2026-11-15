// More preset outlines: line callouts, arrow callouts, curved and circular arrows, curved ribbons,
// gears, tabs and chart markers.
// Translated from deckcraft crates/geom/src/preset/extra.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {pt, add, sub, mul, div, hypot, rect, rectInset, rectAbs, rectFromPoints, applyAffine, transformRectBbox, ZERO} from '../kurbo.mjs';
import {
  Pb, fill, fillEo, fillOnly, shade, strokeOnly, simple, cornerRect, SQUARE4, midSites, Dir, orient, handle, vis, FillMode, fmax, fmin, clamp, rad, deg, remEuclid,
} from './builder.mjs';

/** Builds the presets this module knows; null for any other name. `a(i)` is adjust value i. */
export function buildExtra(name, w, h, a) {
  const ss = fmin(w, h);
  const full = rect(0, 0, w, h);
  const b = new Pb();
  switch (name) {
    case 'lineInv': {
      const l = b.m(0, h).l(w, 0).take();
      return {paths: [strokeOnly(l)], textRect: full, handles: [], sites: [pt(0, h), pt(w, 0)]};
    }
    case 'nonIsoscelesTrapezoid': {
      const max = (50000 * w) / fmax(ss, 1e-9);
      const v1 = clamp(a(0), 0, max), v2 = clamp(a(1), 0, max);
      const d1 = (ss * v1) / 1e5, d2 = (ss * v2) / 1e5;
      const g = simple(b.poly([[0, h], [d1, 0], [w - d2, 0], [w, h]]).take(), rect(d1 * 0.66, h * 0.2, w - d2 * 0.66, h), w, h);
      g.handles.push(handle(0, ZERO, pt(ss / 1e5, 0), v1, 0, max));
      g.handles.push(handle(1, pt(w, 0), pt(-ss / 1e5, 0), v2, 0, max));
      return g;
    }
    case 'pieWedge': {
      b.m(0, h).arc(w, h, 180, 90).l(w, h).z();
      return simple(b.take(), rect(w * 0.29289, h * 0.29289, w, h), w, h);
    }
    case 'flowChartOfflineStorage': {
      const tri = b.poly([[0, 0], [w, 0], [w / 2, h]]).take();
      const bar = new Pb().m(w * 0.4, h * 0.8).l(w * 0.6, h * 0.8).take();
      return {paths: [fill(tri), strokeOnly(bar)], textRect: rect(w / 4, 0, w * 0.75, h * 0.8), handles: [],
        sites: [pt(w / 2, 0), pt(w / 4, h / 2), pt(w / 2, h), pt(w * 0.75, h / 2)]};
    }
    case 'chartX': case 'chartStar': case 'chartPlus': {
      const body = cornerRect(w, h, SQUARE4);
      const l = new Pb();
      if (name !== 'chartPlus') l.m(0, 0).l(w, h).m(0, h).l(w, 0);
      if (name !== 'chartX') l.m(w / 2, 0).l(w / 2, h);
      if (name === 'chartPlus') l.m(0, h / 2).l(w, h / 2);
      return {paths: [fillOnly(body), strokeOnly(l.take())], textRect: full, handles: [], sites: midSites(w, h)};
    }
    case 'cornerTabs': case 'squareTabs': case 'plaqueTabs': {
      // Each tab's size is a twentieth of the diagonal.
      const d = fmin(fmin(Math.hypot(w, h) / 20, w / 2), h / 2);
      if (name === 'cornerTabs') {
        b.poly([[0, 0], [d, 0], [0, d]]);
        b.poly([[w - d, 0], [w, 0], [w, d]]);
        b.poly([[w, h - d], [w, h], [w - d, h]]);
        b.poly([[0, h - d], [d, h], [0, h]]);
      } else if (name === 'squareTabs') {
        b.poly([[0, 0], [d, 0], [d, d], [0, d]]);
        b.poly([[w - d, 0], [w, 0], [w, d], [w - d, d]]);
        b.poly([[w - d, h - d], [w, h - d], [w, h], [w - d, h]]);
        b.poly([[0, h - d], [d, h - d], [d, h], [0, h]]);
      } else if (d > 0) {
        b.m(0, 0).l(d, 0).arc(d, d, 0, 90).z();
        b.m(w, 0).l(w, d).arc(d, d, 90, 90).z();
        b.m(w, h).l(w - d, h).arc(d, d, 180, 90).z();
        b.m(0, h).l(0, h - d).arc(d, d, 270, 90).z();
      } else b.m(0, 0).z();
      return {paths: [fill(b.take())], textRect: rectInset(full, -d), handles: [], sites: midSites(w, h)};
    }
    case 'callout1': case 'callout2': case 'callout3': case 'accentCallout1': case 'accentCallout2': case 'accentCallout3':
    case 'borderCallout2': case 'borderCallout3': case 'accentBorderCallout1': case 'accentBorderCallout2': case 'accentBorderCallout3': {
      const last = name[name.length - 1];
      const n = last === '2' ? 2 : last === '3' ? 3 : 1;
      return lineCallout(w, h, a, n + 1, name.startsWith('accent'), name.includes('order'));
    }
    case 'leftRightArrowCallout': case 'upDownArrowCallout': {
      const vertical = name === 'upDownArrowCallout';
      const [l, t] = vertical ? [h, w] : [w, h];
      const s2 = fmin(l, t);
      const head = fmin((s2 * fmax(a(1), 0)) / 1e5, t / 2);
      const shaft = fmin((s2 * fmax(a(0), 0)) / 1e5, head * 2);
      const hl = fmin((s2 * fmax(a(2), 0)) / 1e5, l / 2);
      const boxl = fmin((l * fmax(a(3), 0)) / 1e5, l - 2 * hl);
      const c = t / 2, b0 = (l - boxl) / 2, b1 = (l + boxl) / 2;
      let ps = [[0, c], [hl, c - head], [hl, c - shaft / 2], [b0, c - shaft / 2], [b0, 0], [b1, 0], [b1, c - shaft / 2], [l - hl, c - shaft / 2],
        [l - hl, c - head], [l, c], [l - hl, c + head], [l - hl, c + shaft / 2], [b1, c + shaft / 2], [b1, t], [b0, t], [b0, c + shaft / 2],
        [hl, c + shaft / 2], [hl, c + head]];
      const d = vertical ? Dir.Down : Dir.Right;
      ps = orient(d, w, h, ps);
      const tr = orient(d, w, h, [[b0, 0], [b1, t]]);
      return simple(b.poly(ps).take(), rectAbs(rectFromPoints(pt(tr[0][0], tr[0][1]), pt(tr[1][0], tr[1][1]))), w, h);
    }
    case 'quadArrowCallout': {
      const head = fmin((ss * fmax(a(1), 0)) / 1e5, ss / 2);
      const shaft = fmin((ss * fmax(a(0), 0)) / 1e5, head * 2);
      const hl = fmin((ss * fmax(a(2), 0)) / 1e5, ss / 2);
      const k = clamp(a(3), 0, 100000) / 1e5;
      const bw = fmax(fmin(w * k, w - 2 * hl), shaft), bh = fmax(fmin(h * k, h - 2 * hl), shaft);
      const cx = w / 2, cy = h / 2;
      const bx0 = cx - bw / 2, bx1 = cx + bw / 2, by0 = cy - bh / 2, by1 = cy + bh / 2;
      const s2 = shaft / 2, hd = head;
      const ps = [[0, cy], [hl, cy - hd], [hl, cy - s2], [bx0, cy - s2], [bx0, by0], [cx - s2, by0], [cx - s2, hl], [cx - hd, hl], [cx, 0], [cx + hd, hl],
        [cx + s2, hl], [cx + s2, by0], [bx1, by0], [bx1, cy - s2], [w - hl, cy - s2], [w - hl, cy - hd], [w, cy], [w - hl, cy + hd], [w - hl, cy + s2],
        [bx1, cy + s2], [bx1, by1], [cx + s2, by1], [cx + s2, h - hl], [cx + hd, h - hl], [cx, h], [cx - hd, h - hl], [cx - s2, h - hl], [cx - s2, by1],
        [bx0, by1], [bx0, cy + s2], [hl, cy + s2], [hl, cy + hd]];
      return simple(b.poly(ps).take(), rect(bx0, by0, bx1, by1), w, h);
    }
    case 'curvedRightArrow': case 'curvedLeftArrow': case 'curvedUpArrow': case 'curvedDownArrow': return curvedArrow(name, w, h, a(0), a(1), a(2));
    case 'swooshArrow': return swoosh(w, h, a(0), a(1));
    case 'ellipseRibbon': case 'ellipseRibbon2': return ellipseRibbon(name === 'ellipseRibbon2', w, h, a(0), a(1), a(2));
    case 'leftRightRibbon': return leftRightRibbon(w, h, a(0), a(1), a(2));
    case 'gear6': case 'gear9': return gear(name === 'gear6' ? 6 : 9, w, h, a(0), a(1));
    case 'funnel': return funnel(w, h);
    case 'circularArrow': case 'leftCircularArrow': case 'leftRightCircularArrow': return circularArrow(name, w, h, [a(0), a(1), a(2), a(3), a(4)]);
    default: return null;
  }
}

/** An ellipse-centred frame for the circular arrows: the band's middle runs on (rx, ry), its edges th/2 either side. */
class Ring {
  constructor(c, rx, ry, th, hw) { Object.assign(this, {c, rx, ry, th, hw}); }
  /** The point at visual angle `d` on the ellipse grown by `grow`. */
  at(d, grow) {
    const ax = fmax(this.rx + grow, 0), ay = fmax(this.ry + grow, 0);
    const t = rad(vis(d, ax, ay));
    return pt(this.c.x + ax * Math.cos(t), this.c.y + ay * Math.sin(t));
  }
  /** Parametric angle (degrees) of `p` on the ellipse grown by `grow`. */
  param(p, grow) {
    const ax = fmax(this.rx + grow, 1e-9), ay = fmax(this.ry + grow, 1e-9);
    return deg(Math.atan2((p.y - this.c.y) / ay, (p.x - this.c.x) / ax));
  }
  /** Where the line `b + s·u` meets the ellipse grown by `grow`, nearest `b` on side `sign`. */
  cross(b, u, grow, sign) {
    const ax = fmax(this.rx + grow, 1e-9), ay = fmax(this.ry + grow, 1e-9);
    const px = (b.x - this.c.x) / ax, py = (b.y - this.c.y) / ay;
    const ux = u.x / ax, uy = u.y / ay;
    const qa = ux * ux + uy * uy;
    const qb = 2 * (px * ux + py * uy);
    const qc = px * px + py * py - 1;
    const disc = qb * qb - 4 * qa * qc;
    // The line misses (a long head on a thin ring): the edge carries on from the base centre.
    if (qa < 1e-18 || disc < 0) return b;
    const r = Math.sqrt(disc);
    const s0 = (-qb - r) / (2 * qa), s1 = (-qb + r) / (2 * qa);
    const s = sign > 0 ? (s0 >= 0 ? s0 : s1) : s1 <= 0 ? s1 : s0;
    return add(b, mul(u, s));
  }
  /** An arrow head whose base centre sits on the middle ellipse at `base` and whose tip at `base + sweep`. */
  head(base, sweep) {
    const b = this.at(base, 0);
    const tip = this.at(base + sweep, 0);
    const d = sub(tip, this.c);
    const u = hypot(d) > 1e-12 ? div(d, hypot(d)) : pt(1, 0);
    const half = this.th / 2;
    return [this.cross(b, u, half, 1), add(b, mul(u, this.hw)), tip, sub(b, mul(u, this.hw)), this.cross(b, u, -half, -1)];
  }
}

/** Sweep (degrees) from `a` to `b` turning one way: positive when `dir > 0`. */
const turn = (a, b, dir) => (dir > 0 ? remEuclid(b - a, 360) : -remEuclid(a - b, 360));

function circularArrow(name, w, h, a) {
  const ss = fmin(w, h);
  if (ss <= 0) return simple(cornerRect(w, h, SQUARE4), rect(0, 0, w, h), w, h);
  const a5 = clamp(a[4], 0, 25000);
  const hw = (ss * a5) / 1e5;
  const th = (ss * clamp(a[0], 0, 2 * a5)) / 1e5;
  const ring = new Ring(pt(w / 2, h / 2), fmax(w / 2 - hw, th / 2), fmax(h / 2 - hw, th / 2), th, hw);
  const dg = v => (v / 60000) % 360;
  const sweep = dg(a[1]), end = dg(a[2]), start = dg(a[3]);
  const half = th / 2;
  const b = new Pb();
  const edgeArc = (from, to, grow, dir) => {
    const ax = fmax(ring.rx + grow, 0), ay = fmax(ring.ry + grow, 0);
    const s = ring.param(from, grow), e = ring.param(to, grow);
    b.arc(ax, ay, s, turn(s, e, dir));
  };
  if (name === 'leftRightCircularArrow') {
    const hs = ring.head(start, -sweep);
    const he = ring.head(end, sweep);
    b.m(hs[0].x, hs[0].y);
    edgeArc(hs[0], he[0], half, 1);
    b.l(he[1].x, he[1].y).l(he[2].x, he[2].y).l(he[3].x, he[3].y).l(he[4].x, he[4].y);
    edgeArc(he[4], hs[4], -half, -1);
    b.l(hs[3].x, hs[3].y).l(hs[2].x, hs[2].y).l(hs[1].x, hs[1].y).z();
  } else {
    const dir = name === 'circularArrow' ? 1 : -1;
    const he = ring.head(end, sweep);
    const o0 = ring.at(start, half), i0 = ring.at(start, -half);
    b.m(o0.x, o0.y);
    edgeArc(o0, he[0], half, dir);
    b.l(he[1].x, he[1].y).l(he[2].x, he[2].y).l(he[3].x, he[3].y).l(he[4].x, he[4].y);
    edgeArc(he[4], i0, -half, -dir);
    b.z();
  }
  return simple(b.take(), rect(0, 0, w, h), w, h);
}

/** A funnel: an elliptical rim (with an open mouth) across the top quarter, straight sides down to a rounded spout. */
function funnel(w, h) {
  const RIM = 173, SPOUT = 163.4;
  const ss = fmin(w, h);
  const cx = w / 2, rimY = h / 4;
  const sx = w / 8, sy = h / 15;
  const spoutY = h - sy;
  const at = (rx, ry, cy, d) => { const t = rad(d); return pt(cx + rx * Math.cos(t), cy + ry * Math.sin(t)); };
  const p0 = at(cx, rimY, rimY, RIM);
  const p1 = at(sx, sy, spoutY, 180 - SPOUT);
  const b = new Pb();
  b.m(p0.x, p0.y).arc(cx, rimY, RIM, 540 - 2 * RIM);
  b.l(p1.x, p1.y).arc(sx, sy, 180 - SPOUT, 2 * SPOUT - 180).z();
  const d = ss / 20;
  b.ellipse(cx, rimY, fmax(cx - d, 0), fmax(rimY - d, 0));
  return {paths: [fillEo(b.take())], textRect: rect(w / 4, h / 2, w * 0.75, h - sy), handles: [], sites: midSites(w, h)};
}

/** A gear: an elliptical body with `n` teeth, the first pointing straight up. */
function gear(n, w, h, a0, a1) {
  const ss = fmin(w, h);
  const th = (ss * clamp(a0, 0, 20000)) / 1e5; // tooth height
  const leanMax = n === 6 ? 5380 : 2730;
  const l = (ss * clamp(a1, 0, fmin(clamp(a0, 0, 20000), leanMax))) / 1e5; // flank lean
  const cx = w / 2, cy = h / 2;
  const rx = fmax(cx - th, 0), ry = fmax(cy - th, 0);
  const r = fmax(ss / 2 - th, 1e-9);
  const half = Math.atan((th + l) / 2 / r);
  const step = (Math.PI * 2) / n;
  const onBody = t => pt(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  const b = new Pb();
  for (let k = 0; k < n; k++) {
    const t = -Math.PI / 2 + step * k;
    // The tooth stands along the body's normal at its centre.
    const nrm = pt(Math.cos(t) * ry, Math.sin(t) * rx);
    const u = hypot(nrm) > 1e-12 ? div(nrm, hypot(nrm)) : pt(Math.cos(t), Math.sin(t));
    const v = pt(-u.y, u.x);
    const r0 = onBody(t - half), r1 = onBody(t + half);
    const c0 = add(add(r0, mul(u, th)), mul(v, l)), c1 = sub(add(r1, mul(u, th)), mul(v, l));
    if (k === 0) b.m(r0.x, r0.y);
    else b.arc(rx, ry, deg(t - step + half), deg(step - 2 * half));
    b.l(c0.x, c0.y).l(c1.x, c1.y).l(r1.x, r1.y);
  }
  const tLast = -Math.PI / 2 + step * (n - 1);
  b.arc(rx, ry, deg(tLast + half), deg(step - 2 * half)).z();
  const k = Math.SQRT1_2;
  return simple(b.take(), rect(cx - rx * k, cy - ry * k, cx + rx * k, cy + ry * k), w, h);
}

/** Two arrows on a band that steps down in the middle, rolling over between them in a shaded curl. */
function leftRightRibbon(w, h, a0, a1, a2) {
  const ss = fmin(w, h);
  const sh = (h * clamp(a2, 0, 33333)) / 1e5;
  const bt = fmin((h * fmax(a0, 0)) / 1e5, h - sh);
  const cx = w / 2;
  const rx = w / 32, ry = fmin(sh / 4, w / 24);
  const hb = fmin((ss * fmax(a1, 0)) / 1e5, cx - rx);
  const yc = (h - sh) / 2;
  const lt = yc - bt / 2, lb = yc + bt / 2;
  const rt = lt + sh, rb = lb + sh;
  const edgeP = new Pb();
  edgeP.m(cx - rx, lb).l(hb, lb).l(hb, h - sh).l(0, yc).l(hb, 0).l(hb, lt).l(cx, lt);
  edgeP.arc(rx, ry, 270, 180).arc(rx, ry, 270, -90);
  const edge = edgeP.take();
  const left = new Pb();
  left.m(0, yc).l(hb, 0).l(hb, lt).l(cx, lt).arc(rx, ry, 270, 180).arc(rx, ry, 270, -180);
  left.l(cx, fmax(lb, lt + 4 * ry)).l(hb, lb).l(hb, h - sh).z();
  const curl = new Pb();
  curl.m(cx + rx, lt + ry).l(cx + rx, rt).l(cx, lt + 4 * ry).arc(rx, ry, 90, 180).arc(rx, ry, 90, -90).z();
  const right = new Pb();
  right.m(w, yc + sh).l(w - hb, h).l(w - hb, rb).l(cx, rb).arc(rx, ry, 90, 90).l(cx - rx, rt - ry).arc(rx, ry, 180, -90);
  right.l(w - hb, rt).l(w - hb, sh).z();
  return {
    paths: [fillOnly(left.take()), strokeOnly(edge), shade(curl.take(), FillMode.DarkenLess), fill(right.take())],
    textRect: rect(fmin(hb, cx - rx), rt, fmax(w - hb, cx + rx), fmax(lb, rt)),
    handles: [],
    sites: [pt(0, yc), pt(cx, rt), pt(w, yc + sh), pt(cx, lb)],
  };
}

/** Adds a piece of the parabola y = y0 + d·(1 − ((x − w/2)/(w/2))²) from the current point (at xa) to xb. */
function sag(b, w, d, y0, xa, xb) {
  const hw = fmax(w / 2, 1e-9);
  const f = x => y0 + d * (1 - ((x - hw) / hw) ** 2);
  const slope = (-2 * d * (xa - hw)) / (hw * hw);
  b.q((xa + xb) / 2, f(xa) + (slope * (xb - xa)) / 2, xb, f(xb));
}

/** A ribbon whose edges sag along one parabola; `up` mirrors it vertically. */
function ellipseRibbon(up, w, h, a0, a1, a2) {
  const th = (h * clamp(a0, 0, 100000)) / 1e5;
  const d = clamp(fmax((h * fmax(a2, 0)) / 1e5, th - (h - th) / 2), 0, th);
  const bw = (w * clamp(a1, 25000, 75000)) / 1e5;
  const x0 = (w - bw) / 2, x1 = (w + bw) / 2;
  const ear = w / 8;
  const xf = x0 + ear, xg = x1 - ear;
  const e = h - th;
  const off = th - d;
  const t = x => { const hw = fmax(w / 2, 1e-9); return d * (1 - ((x - hw) / hw) ** 2); };
  const ends = new Pb();
  ends.m(0, 0);
  sag(ends, w, d, 0, 0, xf);
  ends.l(xf, t(xf) + off).l(x0, t(x0) + off).l(x0, t(x0) + e);
  sag(ends, w, d, e, x0, 0);
  ends.l(ear, t(ear) + e / 2).z();
  ends.m(w, 0).l(w - ear, t(w - ear) + e / 2).l(w, e);
  sag(ends, w, d, e, w, x1);
  ends.l(x1, t(x1) + off).l(xg, t(xg) + off).l(xg, t(xg));
  sag(ends, w, d, 0, xg, w);
  ends.z();
  const folds = new Pb();
  folds.poly([[x0, t(x0) + off], [xf, t(xf)], [xf, t(xf) + off]]);
  folds.poly([[x1, t(x1) + off], [xg, t(xg)], [xg, t(xg) + off]]);
  const band = new Pb();
  band.m(x0, t(x0) + off);
  sag(band, w, d, off, x0, x1);
  band.l(x1, t(x1) + off + e);
  sag(band, w, d, off + e, x1, x0);
  band.z();
  let paths = [fill(ends.take()), shade(folds.take(), FillMode.DarkenLess), fill(band.take())];
  let text = rect(x0, th, x1, t(x0) + off + e);
  if (up) {
    const m = [1, 0, 0, -1, 0, h];
    paths = paths.map(s => ({...s, path: applyAffine(s.path, m)}));
    text = transformRectBbox(m, text);
  }
  return {paths, textRect: text, handles: [], sites: midSites(w, h)};
}

/** A sweeping arrow rising from the bottom-left corner. */
function swoosh(w, h, a0, a1) {
  const TILT = 0.1126, LIFT = 0.051;
  const ss = fmin(w, h);
  const e = ss / 8;
  const th = fmin((h * fmax(a0, 0)) / 1e5, fmax(h - 2 * e, 0));
  const hl = fmin(fmax((ss * fmax(a1, 0)) / 1e5, (e + th) * TILT), fmax(w - e * TILT, 0));
  const qx = w - hl;
  const b = new Pb();
  b.m(0, h).q(w / 6, h / 3, qx, e).l(qx - e * TILT, 0).l(w, clamp(e + th / 2 - LIFT * h, 0, 2 * e + th)).l(fmin(qx + (e + th) * TILT, w), 2 * e + th)
    .l(fmin(qx + th * TILT, w), e + th).q(w / 4, fmin(th + h / 12 + e, h), 0, h).z();
  return simple(b.take(), rect(0, 0, w, h), w, h);
}

/** A band that sweeps around half an ellipse and ends in an arrow head, turned for each direction. */
function curvedArrow(name, w, h, a0, a1, a2) {
  const alongX = name === 'curvedRightArrow' || name === 'curvedLeftArrow';
  const [cw, ch] = alongX ? [w, h] : [h, w];
  const ss = fmin(cw, ch);
  const head = fmin((ss * fmax(a1, 0)) / 1e5, ch / 2);
  const th = fmin((ss * fmax(a0, 0)) / 1e5, head);
  const hl = fmin((ss * fmax(a2, 0)) / 1e5, cw);
  const hh = head / 2;
  const r = fmax((ch - hh - th / 2) / 2, 0);
  const te = cw > 0 ? deg(Math.acos(clamp(-(hl / cw), -1, 1))) : 90;
  const back = new Pb();
  back.m(cw, 0).arc(cw, r, 270, -90).l(0, r + th).arc(cw, r, 180, 90).z();
  const front = new Pb();
  front.m(0, r).arc(cw, r, 180, te - 180);
  const yb = front.cur.y;
  const yc = yb + th / 2;
  front.l(cw - hl, yc - hh).l(cw, 2 * r + th / 2).l(cw - hl, yc + hh).l(cw - hl, yb + th).arc(cw, r, te, 180 - te).z();
  const m = name === 'curvedLeftArrow' ? [-1, 0, 0, 1, w, 0] : name === 'curvedUpArrow' ? [0, -1, 1, 0, 0, h] : name === 'curvedDownArrow' ? [0, 1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0];
  return {paths: [shade(applyAffine(back.take(), m), FillMode.DarkenLess), fill(applyAffine(front.take(), m))], textRect: rect(0, 0, w, h), handles: [], sites: midSites(w, h)};
}

/** A rectangle with a callout leader through `pts` points, optionally with an accent bar and a border. */
function lineCallout(w, h, a, pts, accent, border) {
  const body = cornerRect(w, h, SQUARE4);
  const at = i => [(w * clamp(a(2 * i + 1), -1e7, 1e7)) / 1e5, (h * clamp(a(2 * i), -1e7, 1e7)) / 1e5];
  const l = new Pb();
  const [x0, y0] = at(0);
  l.m(x0, y0);
  for (let i = 1; i < pts; i++) { const [x, y] = at(i); l.l(x, y); }
  const paths = [border ? fill(body) : fillOnly(body)];
  if (accent) paths.push(strokeOnly(new Pb().m(x0, 0).l(x0, h).take()));
  paths.push(strokeOnly(l.take()));
  return {paths, textRect: rect(0, 0, w, h), handles: [], sites: midSites(w, h)};
}
