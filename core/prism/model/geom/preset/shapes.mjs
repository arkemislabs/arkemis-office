// Speech-bubble, cloud, equation, ribbon, scroll and action-button presets.
// Translated from deckcraft crates/geom/src/preset/shapes.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {pt, add, sub, mul, rect, rectInset, applyAffine} from '../kurbo.mjs';
import {Pb, fill, shade, simple, strokeOnly, cornerRect, SQUARE4, midSites, tipHandle, FillMode, fmax, fmin, clamp, rad} from './builder.mjs';

export function wedgeRect(w, h, a0, a1, rIn) {
  const tip = pt(w / 2 + (w * a0) / 1e5, h / 2 + (h * a1) / 1e5);
  const inside = tip.x > 0 && tip.x < w && tip.y > 0 && tip.y < h;
  const dx = (tip.x - w / 2) / fmax(w, 1e-9), dy = (tip.y - h / 2) / fmax(h, 1e-9);
  const b = new Pb();
  const r = fmin(fmin(rIn, w / 2), h / 2);
  // Walk clockwise from the top-left; insert the wedge on the edge facing the tip.
  const horiz = Math.abs(dx) > Math.abs(dy);
  // The wedge's base: 2..5 twelfths of the edge on the tip's side of the centre when it is before
  // it, 7..10 twelfths when after.
  const [bx0, bx1] = tip.x < w / 2 ? [(w * 2) / 12, (w * 5) / 12] : [(w * 7) / 12, (w * 10) / 12];
  const [by0, by1] = tip.y < h / 2 ? [(h * 2) / 12, (h * 5) / 12] : [(h * 7) / 12, (h * 10) / 12];
  b.m(r, 0);
  if (!inside && !horiz && dy < 0) b.l(bx0, 0).l(tip.x, tip.y).l(bx1, 0);
  b.l(w - r, 0);
  if (r > 0) b.arc(r, r, 270, 90);
  if (!inside && horiz && dx > 0) b.l(w, by0).l(tip.x, tip.y).l(w, by1);
  b.l(w, h - r);
  if (r > 0) b.arc(r, r, 0, 90);
  if (!inside && !horiz && dy > 0) b.l(bx1, h).l(tip.x, tip.y).l(bx0, h);
  b.l(r, h);
  if (r > 0) b.arc(r, r, 90, 90);
  if (!inside && horiz && dx < 0) b.l(0, by1).l(tip.x, tip.y).l(0, by0);
  b.l(0, r);
  if (r > 0) b.arc(r, r, 180, 90);
  b.z();
  const g = simple(b.take(), rectInset(rect(0, 0, w, h), -r * 0.29289), w, h);
  g.handles.push(tipHandle(w, h, tip));
  return g;
}

/** ECMA-376 cloud outline arcs (radii in 43200ths, angles in 60000ths of a degree), from (3900, 14370). */
const CLOUD_ARCS = [
  [6753, 9190, -11429249, 7426832], [5333, 7267, -8646143, 5396714], [4365, 5945, -8748475, 5983381], [4857, 6595, -7859164, 7034504],
  [5333, 7273, -4722533, 6541615], [6775, 9220, -2776035, 7816140], [5785, 7867, 37501, 6842000], [6752, 9215, 1347096, 6910353],
  [7720, 10543, 3974558, 4542661], [4360, 5918, -16496525, 8804134], [4345, 5945, -14809710, 9151131],
];
/** The cloud's creases: short arcs inside the outline, each from its own start point. */
const CLOUD_CREASES = [
  [4693, 26177, 4345, 5945, 5204520, 1585770], [6928, 34899, 4360, 5918, 4416628, 686848], [16478, 39090, 6752, 9215, 8257449, 844866],
  [28827, 34751, 6752, 9215, 387196, 959901], [34129, 22954, 5785, 7867, -4217541, 4255042], [41798, 15354, 5333, 7273, 1819082, 1665090],
  [38324, 5426, 4857, 6595, -824660, 891534], [29078, 3952, 4857, 6595, -8950887, 1091722], [22141, 4720, 4365, 5945, -9809656, 1061181],
  [14000, 5192, 6753, 9190, -4002417, 739161], [4127, 15789, 6753, 9190, 9459261, 711490],
];

export function cloud(name, w, h, a0, a1) {
  // Drawn in the path's own 43200-unit square, then stretched to the box.
  const toBox = [w / 43200, 0, 0, h / 43200, 0, 0];
  const dg = v => v / 60000;
  const b = new Pb();
  b.m(3900, 14370);
  for (const [wr, hr, st, sw] of CLOUD_ARCS) b.arcSpec(wr, hr, dg(st), dg(sw));
  b.z();
  const creases = new Pb();
  for (const [x, y, wr, hr, st, sw] of CLOUD_CREASES) creases.m(x, y).arcSpec(wr, hr, dg(st), dg(sw));
  const paths = [fill(applyAffine(b.take(), toBox))];
  if (name === 'cloud') paths.push(strokeOnly(applyAffine(creases.take(), toBox)));
  const textRect = rect((w * 2977) / 21600, (h * 3262) / 21600, (w * 17087) / 21600, (h * 17337) / 21600);
  const handles = [];
  if (name === 'cloudCallout') {
    const tip = pt(w / 2 + (w * a0) / 1e5, h / 2 + (h * a1) / 1e5);
    const c = pt(w / 2, h / 2);
    const bubbles = new Pb();
    for (const [k, r] of [[0.55, 0.06], [0.75, 0.045], [0.95, 0.03]]) {
      const q = add(c, mul(sub(tip, c), k));
      if (!(q.x > w * 0.1 && q.x < w * 0.9 && q.y > h * 0.1 && q.y < h * 0.9) || k > 0.9) bubbles.ellipse(q.x, q.y, w * r, h * r);
    }
    paths.push(fill(bubbles.take()));
    handles.push(tipHandle(w, h, tip));
  }
  return {paths, textRect, handles, sites: midSites(w, h)};
}

/**
 * The equation shapes, by ECMA-376's formulas. Their bars span 73.49% of the width; the plus and
 * multiply bars are `adj1` of the shorter side thick, the others' `adj1` of the height.
 */
export function math(name, w, h, a0, a1, a2) {
  const pin = (lo, v, hi) => fmin(fmax(v, lo), fmax(hi, lo));
  const ss = fmin(w, h);
  const hc = w / 2, vc = h / 2;
  const dx1 = (w * 73490) / 200000;
  const x1 = hc - dx1, x2 = hc + dx1;
  const b = new Pb();
  let text;
  if (name === 'mathPlus') {
    const av = pin(0, a0, 73490);
    const dy1 = (h * 73490) / 200000;
    const dx2 = (ss * av) / 200000;
    const y1 = vc - dy1, y2 = vc - dx2, y3 = vc + dx2, y4 = vc + dy1;
    const xa = hc - dx2, xb = hc + dx2;
    b.poly([[x1, y2], [xa, y2], [xa, y1], [xb, y1], [xb, y2], [x2, y2], [x2, y3], [xb, y3], [xb, y4], [xa, y4], [xa, y3], [x1, y3]]);
    text = rect(x1, y2, x2, y3);
  } else if (name === 'mathMinus') {
    const dy1 = (h * pin(0, a0, 100000)) / 200000;
    b.poly([[x1, vc - dy1], [x2, vc - dy1], [x2, vc + dy1], [x1, vc + dy1]]);
    text = rect(x1, vc - dy1, x2, vc + dy1);
  } else if (name === 'mathEqual') {
    const av = pin(0, a0, 36745);
    const g = pin(0, a1, 100000 - 2 * av);
    const dy1 = (h * av) / 100000, dy2 = (h * g) / 200000;
    const y2 = vc - dy2, y3 = vc + dy2;
    const y1 = y2 - dy1, y4 = y3 + dy1;
    b.poly([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
    b.poly([[x1, y3], [x2, y3], [x2, y4], [x1, y4]]);
    text = rect(x1, y1, x2, y4);
  } else if (name === 'mathNotEqual') {
    const av = pin(0, a0, 50000);
    const crAng = pin(4200000, a1, 6600000);
    const g = pin(0, a2, 100000 - 2 * av);
    const dy1 = (h * av) / 100000, dy2 = (h * g) / 200000;
    const hd2 = fmax(h / 2, 1e-9);
    const y2 = vc - dy2, y3 = vc + dy2;
    const y1 = y2 - dy1, y4 = y3 + dy1;
    const cadj2 = crAng - 5400000;
    const xadj2 = hd2 * Math.tan(rad(cadj2 / 60000));
    const len = Math.hypot(xadj2, hd2);
    const bhw = (len * dy1) / hd2;
    const x7 = hc + xadj2 - bhw / 2;
    const at = y => x7 - (xadj2 * y) / hd2;
    const x6 = at(y1), x5 = at(y2), x4 = at(y3), x3 = at(y4);
    const rx7 = x7 + bhw;
    const dx7 = (dy1 * hd2) / len;
    const dy3 = (dy1 * xadj2) / len;
    const [rx, lx, ry, ly] = cadj2 > 0 ? [x7 + dx7, x7, dy3, 0] : [rx7, rx7 - dx7, 0, -dy3];
    b.poly([[x1, y1], [x6, y1], [lx, ly], [rx, ry], [x6 + bhw, y1], [x2, y1], [x2, y2], [x5 + bhw, y2], [x4 + bhw, y3], [x2, y3], [x2, y4],
      [x3 + bhw, y4], [w - lx, h - ly], [w - rx, h - ry], [x3, y4], [x1, y4], [x1, y3], [x4, y3], [x5, y2], [x1, y2]]);
    text = rect(x1, y1, x2, y4);
  } else if (name === 'mathDivide') {
    const av = pin(1000, a0, 36745);
    const max3 = fmin((73490 - av) / 4, (36745 * w) / fmax(h, 1e-9));
    const r3 = pin(1000, a2, max3);
    const g = pin(0, a1, 73490 - 4 * r3 - av);
    const dy1 = (h * av) / 200000;
    const yg = (h * g) / 100000;
    const radius = (h * r3) / 100000;
    const y3 = vc - dy1, y4 = vc + dy1;
    const y2 = y3 - (yg + radius);
    const y1 = y2 - radius;
    b.ellipse(hc, y1 + radius, radius, radius);
    b.ellipse(hc, h - y1 - radius, radius, radius);
    b.poly([[x1, y3], [x2, y3], [x2, y4], [x1, y4]]);
    text = rect(x1, y3, x2, y4);
  } else {
    // mathMultiply: an X whose arms run along the box's diagonals.
    const th = (ss * pin(0, a0, 51965)) / 100000;
    const ang = Math.atan2(h, w);
    const sa = Math.sin(ang), ca = Math.cos(ang), ta = fmax(Math.tan(ang), 1e-9);
    const lm = Math.hypot(w, h) * (1 - 51965 / 100000);
    const xm = (ca * lm) / 2, ym = (sa * lm) / 2;
    const dxam = (sa * th) / 2, dyam = (ca * th) / 2;
    const xa = xm - dxam, ya = ym + dyam, xb = xm + dxam, yb = ym - dyam;
    const yc = (hc - xb) * ta + yb;
    const xd = w - xb, xe = w - xa;
    const xfe = (vc - ya) / ta;
    const xf = xe - xfe, xl = xa + xfe;
    const yg = h - ya, yh = h - yb, yi = h - yc;
    b.poly([[xa, ya], [xb, yb], [hc, yc], [xd, yb], [xe, ya], [xf, vc], [xe, yg], [xd, yh], [hc, yi], [xb, yh], [xa, yg], [xl, vc]]);
    text = rect(xa, yb, xe, yh);
  }
  return {paths: [fill(b.take())], textRect: text, handles: [], sites: midSites(w, h)};
}

export function ribbon(up, w, h, a0, a1) {
  const fold = (h * clamp(a0, 0, 33333)) / 1e5;
  const cw = (w * clamp(a1, 25000, 75000)) / 1e5; // centre band width
  const x0 = (w - cw) / 2;
  const x1 = w - x0;
  const ear = w / 8;
  const top = 0, bot = h;
  const b = new Pb();
  const shadeP = new Pb();
  if (up) {
    // centre band sits high; ends hang low.
    b.poly([[x0, top], [x1, top], [x1, bot - fold], [x0, bot - fold]]);
    const ends = new Pb();
    ends.poly([[0, fold], [x0 + ear * 0.5, fold], [x0 + ear * 0.5, bot], [0, bot], [ear, (fold + bot) / 2]]);
    ends.poly([[w, fold], [x1 - ear * 0.5, fold], [x1 - ear * 0.5, bot], [w, bot], [w - ear, (fold + bot) / 2]]);
    shadeP.poly([[x0, bot - fold], [x0 + ear * 0.5, bot - fold], [x0 + ear * 0.5, bot]]);
    shadeP.poly([[x1, bot - fold], [x1 - ear * 0.5, bot - fold], [x1 - ear * 0.5, bot]]);
    return {paths: [fill(ends.take()), shade(shadeP.take(), FillMode.DarkenLess), fill(b.take())], textRect: rect(x0, top, x1, bot - fold), handles: [], sites: midSites(w, h)};
  }
  b.poly([[x0, top + fold], [x1, top + fold], [x1, bot], [x0, bot]]);
  const ends = new Pb();
  ends.poly([[0, top], [x0 + ear * 0.5, top], [x0 + ear * 0.5, bot - fold], [0, bot - fold], [ear, (bot - fold) / 2]]);
  ends.poly([[w, top], [x1 - ear * 0.5, top], [x1 - ear * 0.5, bot - fold], [w, bot - fold], [w - ear, (bot - fold) / 2]]);
  shadeP.poly([[x0, top + fold], [x0 + ear * 0.5, top + fold], [x0 + ear * 0.5, top]]);
  shadeP.poly([[x1, top + fold], [x1 - ear * 0.5, top + fold], [x1 - ear * 0.5, top]]);
  return {paths: [fill(ends.take()), shade(shadeP.take(), FillMode.DarkenLess), fill(b.take())], textRect: rect(x0, top + fold, x1, bot), handles: [], sites: midSites(w, h)};
}

export function scroll(vertical, w, h, a0) {
  const ss = fmin(w, h);
  const r = (ss * clamp(a0, 0, 25000)) / 1e5 / 2;
  const b = new Pb();
  const curl = new Pb();
  if (vertical) {
    b.poly([[r, r * 2], [w - r, r * 2], [w - r, h - r], [r, h - r]]);
    b.ellipse(w / 2, r, w / 2 - r * 0, r);
    curl.ellipse(r, h - r, r, r);
    curl.ellipse(w - r * 2, r, r * 0.5, r * 0.5);
    return {paths: [fill(b.take()), shade(curl.take(), FillMode.DarkenLess)], textRect: rect(r, r * 2, w - r, h - r), handles: [], sites: midSites(w, h)};
  }
  b.poly([[r * 2, r], [w - r, r], [w - r, h - r], [r * 2, h - r]]);
  b.ellipse(r, h / 2, r, h / 2);
  curl.ellipse(w - r, r, r, r);
  curl.ellipse(r, h - r * 2, r * 0.5, r * 0.5);
  return {paths: [fill(b.take()), shade(curl.take(), FillMode.DarkenLess)], textRect: rect(r * 2, r, w - r, h - r), handles: [], sites: midSites(w, h)};
}

export function actionButton(name, w, h) {
  const body = cornerRect(w, h, SQUARE4);
  const ss = fmin(w, h);
  const cx = w / 2, cy = h / 2;
  const s = ss * 0.3;
  const g = new Pb();
  switch (name) {
    case 'actionButtonBackPrevious': g.poly([[cx + s, cy - s], [cx + s, cy + s], [cx - s, cy]]); break;
    case 'actionButtonForwardNext': g.poly([[cx - s, cy - s], [cx - s, cy + s], [cx + s, cy]]); break;
    case 'actionButtonBeginning':
      g.poly([[cx + s, cy - s], [cx + s, cy + s], [cx - s * 0.6, cy]]);
      g.poly([[cx - s, cy - s], [cx - s * 0.7, cy - s], [cx - s * 0.7, cy + s], [cx - s, cy + s]]);
      break;
    case 'actionButtonEnd':
      g.poly([[cx - s, cy - s], [cx - s, cy + s], [cx + s * 0.6, cy]]);
      g.poly([[cx + s * 0.7, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx + s * 0.7, cy + s]]);
      break;
    case 'actionButtonHome':
      g.poly([[cx, cy - s], [cx + s, cy], [cx + s * 0.7, cy], [cx + s * 0.7, cy + s], [cx - s * 0.7, cy + s], [cx - s * 0.7, cy], [cx - s, cy]]);
      break;
    case 'actionButtonInformation': case 'actionButtonHelp': g.ellipse(cx, cy, s, s); break;
    case 'actionButtonReturn':
      g.m(cx + s, cy - s * 0.6).l(cx + s, cy + s * 0.2).q(cx + s, cy + s * 0.8, cx + s * 0.4, cy + s * 0.8).l(cx - s * 0.5, cy + s * 0.8);
      g.l(cx - s * 0.5, cy + s * 0.4).l(cx - s, cy + s * 0.9).l(cx - s * 0.5, cy + s * 1.4).l(cx - s * 0.5, cy + s).l(cx + s * 0.6, cy + s)
        .l(cx + s * 0.6, cy - s * 0.6).z();
      break;
    case 'actionButtonMovie':
      g.poly([[cx - s, cy - s * 0.6], [cx + s * 0.4, cy - s * 0.6], [cx + s * 0.4, cy + s * 0.6], [cx - s, cy + s * 0.6]]);
      g.poly([[cx + s * 0.4, cy], [cx + s, cy - s * 0.5], [cx + s, cy + s * 0.5]]);
      break;
    case 'actionButtonDocument':
      g.poly([[cx - s * 0.7, cy - s], [cx + s * 0.3, cy - s], [cx + s * 0.7, cy - s * 0.6], [cx + s * 0.7, cy + s], [cx - s * 0.7, cy + s]]);
      break;
    case 'actionButtonSound':
      g.poly([[cx - s, cy - s * 0.35], [cx - s * 0.5, cy - s * 0.35], [cx, cy - s], [cx, cy + s], [cx - s * 0.5, cy + s * 0.35], [cx - s, cy + s * 0.35]]);
      break;
    default: break;
  }
  return {paths: [fill(body), shade(g.take(), FillMode.DarkenLess)], textRect: rect(0, 0, w, h), handles: [], sites: midSites(w, h)};
}
