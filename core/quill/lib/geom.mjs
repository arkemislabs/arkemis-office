// Geometry and units shared by the Quill model, layout and commands: points, twips, EMU,
// half-points, measurement parsing and formatting, rectangles, drawing spins, paper sizes.
// Translated from wordcraft crates/geom/src/lib.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Layout works in points (1/72 inch). Upstream computes in f32; values that overflow f32 are
// treated as upstream treats them (Math.fround), so parse_measure refuses the same inputs.
// No DOM, no Node built-ins.

export const PT_PER_IN = 72;
export const TWIPS_PER_PT = 20;
export const EMU_PER_PT = 12_700;
export const PT_PER_CM = 72 / 2.54;

/** NaN and infinities become 0 so arithmetic stays defined. */
export const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const roundHalfAway = v => (v < 0 ? -Math.round(-v) : Math.round(v));

export const twips = v => v / TWIPS_PER_PT;
export const toTwips = pt => roundHalfAway(finite(pt * TWIPS_PER_PT));
export const emu = v => v / EMU_PER_PT;
export const toEmu = pt => roundHalfAway(finite(pt) * EMU_PER_PT);
export const halfPoints = v => v / 2;
export const toHalfPoints = pt => roundHalfAway(finite(pt) * 2);

/** Measurement units shown in the UI (Options › Advanced › Show measurements in units of). */
export const UNITS = Object.freeze(['inches', 'centimeters', 'millimeters', 'points', 'picas']);
const SUFFIX = {inches: '"', centimeters: ' cm', millimeters: ' mm', points: ' pt', picas: ' pi'};
const PER = {inches: PT_PER_IN, centimeters: PT_PER_CM, millimeters: PT_PER_CM / 10, points: 1, picas: 12};

export const unitSuffix = u => SUFFIX[u] ?? SUFFIX.inches;
export const ptPerUnit = u => PER[u] ?? PER.inches;

/** `pt` as a number in `unit`, at most two decimals, no unit (`2,54` with `,`). */
export function unitNumber(unit, pt, decimal = '.') {
  const v = finite(pt) / ptPerUnit(unit);
  let s = v.toFixed(2);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s.replace('.', decimal);
}
/** `pt` in `unit` the way Word's fields show it (`1"`, `2.54 cm`, `12 pt`). */
export const formatUnit = (unit, pt, decimal = '.') => unitNumber(unit, pt, decimal) + unitSuffix(unit);

const F32_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/**
 * A measurement typed by a user (`1"`, `1 in`, `2.5cm`, `12pt`, `3 pi`, `10 mm`, `1.5 li`, `4px`)
 * in points; a bare number is in `defaultUnit`. Either decimal separator works. null when it
 * can't be read or overflows.
 */
export function parseMeasure(s, defaultUnit = 'inches') {
  const t = String(s ?? '').trim().toLowerCase().replace(/−/g, '-');
  if (!t) return null;
  let split = t.search(/[^0-9.\-+,]/);
  if (split < 0) split = t.length;
  const num = t.slice(0, split).replace(/,/g, '.'), unit = t.slice(split).trim();
  if (!F32_NUMBER.test(num)) return null;
  const v = Math.fround(Number(num));
  if (!Number.isFinite(v)) return null;
  let k;
  switch (unit) {
    case '': k = ptPerUnit(defaultUnit); break;
    case '"': case 'in': case 'inch': case 'inches': k = PT_PER_IN; break;
    case 'cm': k = PT_PER_CM; break;
    case 'mm': k = PT_PER_CM / 10; break;
    case 'pt': case 'pts': case 'point': case 'points': k = 1; break;
    case 'pi': case 'pc': case 'pica': case 'picas': k = 12; break;
    case 'li': case 'line': case 'lines': k = 12; break;
    case 'px': k = 0.75; break;
    default: return null;
  }
  const res = Math.fround(v * Math.fround(k));
  return Number.isFinite(res) ? res : null;
}

// --- rectangles ---------------------------------------------------------------------------------

/** An axis-aligned rectangle (points, y down); w and h never negative. */
export const rect = (x, y, w, h) => ({x: finite(x), y: finite(y), w: Math.max(0, finite(w)), h: Math.max(0, finite(h))});
export const rectRight = r => r.x + r.w;
export const rectBottom = r => r.y + r.h;
export const rectContains = (r, p) => p.x >= r.x && p.x <= rectRight(r) && p.y >= r.y && p.y <= rectBottom(r);
export const rectIntersects = (a, b) => a.x < rectRight(b) && b.x < rectRight(a) && a.y < rectBottom(b) && b.y < rectBottom(a);
export function rectUnion(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return rect(x, y, Math.max(rectRight(a), rectRight(b)) - x, Math.max(rectBottom(a), rectBottom(b)) - y);
}
export const rectInset = (r, l, t, rr, b) => rect(r.x + l, r.y + t, r.w - l - rr, r.h - t - b);
export const rectExpand = (r, d) => rectInset(r, -d, -d, -d, -d);

// --- spins --------------------------------------------------------------------------------------

/** An angle in degrees brought into 0..360 (NaN and infinities become 0). */
export function normalizeDegrees(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 0;
  const d = ((deg % 360) + 360) % 360;
  return d >= 0 && d < 360 ? d : 0;
}

/**
 * How a drawing is turned about its centre: mirrored first, then rotated `deg` clockwise
 * (page space, y down), as DrawingML's a:xfrm flipH, flipV and rot say (ECMA-376 §20.1.7.6).
 */
export class Spin {
  constructor(deg = 0, flipH = false, flipV = false) {
    this.deg = normalizeDegrees(deg);
    this.flipH = !!flipH;
    this.flipV = !!flipV;
  }
  isIdentity() { return normalizeDegrees(this.deg) === 0 && !this.flipH && !this.flipV; }
  /** [a, b, c, d]: x' = a·x + c·y, y' = b·x + d·y. */
  linear() {
    const r = normalizeDegrees(this.deg) * Math.PI / 180;
    const s = Math.sin(r), c = Math.cos(r);
    const fx = this.flipH ? -1 : 1, fy = this.flipV ? -1 : 1;
    return [c * fx, s * fx, -s * fy, c * fy];
  }
  /** The affine map [a, b, c, d, e, f] turning the page about (cx, cy). */
  matrix(cx, cy) {
    const [a, b, c, d] = this.linear();
    cx = finite(cx); cy = finite(cy);
    return [a, b, c, d, cx - (a * cx + c * cy), cy - (b * cx + d * cy)];
  }
  /** Where (x, y) goes when turned about (cx, cy). */
  apply(cx, cy, x, y) {
    const [a, b, c, d] = this.linear();
    const u = x - cx, v = y - cy;
    return [cx + a * u + c * v, cy + b * u + d * v];
  }
  /** The point apply() takes to (x, y). */
  unapply(cx, cy, x, y) {
    const [a, b, c, d] = this.linear();
    const u = x - cx, v = y - cy;
    return [cx + a * u + b * v, cy + c * u + d * v];
  }
  /** The axis-aligned box `r` covers once turned about its centre. */
  bounds(r) {
    const [bw, bh] = this.extent(r.w, r.h);
    return rect(r.x + (r.w - bw) / 2, r.y + (r.h - bh) / 2, bw, bh);
  }
  /** Width and height of the box a w × h rectangle covers once turned. */
  extent(w, h) {
    w = Math.abs(finite(w)); h = Math.abs(finite(h));
    const r = normalizeDegrees(this.deg) * Math.PI / 180;
    const s = Math.abs(Math.sin(r)), c = Math.abs(Math.cos(r));
    return [w * c + h * s, w * s + h * c];
  }
  /** This spin applied inside `outer` (a group member's spin within its group's). */
  within(outer) {
    const oneMirror = outer.flipH !== outer.flipV;
    const inner = oneMirror ? -this.deg : this.deg;
    return new Spin(outer.deg + inner, outer.flipH !== this.flipH, outer.flipV !== this.flipV);
  }
}

// --- paper --------------------------------------------------------------------------------------

/** Standard paper sizes (Layout › Size gallery), points, portrait. */
export const PAPER_SIZES = Object.freeze([
  ['Letter', 612, 792], ['Legal', 612, 1008], ['Executive', 522, 756], ['A3', 841.89, 1190.55], ['A4', 595.28, 841.89],
  ['A5', 419.53, 595.28], ['B4 (JIS)', 728.5, 1031.8], ['B5 (JIS)', 515.9, 728.5], ['Tabloid', 792, 1224], ['Statement', 396, 612],
  ['Envelope #10', 297, 684], ['Envelope DL', 311.8, 623.6],
].map(Object.freeze));

/** The paper size matching w × h (either orientation, within half a point), or null. */
export function paperName(w, h) {
  const hit = PAPER_SIZES.find(([, pw, ph]) => (Math.abs(pw - w) < 0.5 && Math.abs(ph - h) < 0.5) || (Math.abs(pw - h) < 0.5 && Math.abs(ph - w) < 0.5));
  return hit ? hit[0] : null;
}
/** The standard paper named `name` (case-insensitive): [name, w, h], or null. */
export function paperByName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return PAPER_SIZES.find(([p]) => p.toLowerCase() === n) ?? null;
}

/**
 * Fit a page onto other paper as Word's Pages per sheet › Scale to paper size does: the paper
 * turned to the page's orientation, one scale factor, centred. {paperW, paperH, k, dx, dy}.
 */
export function fitToPaper(pageW, pageH, paperW, paperH) {
  const ok = v => Number.isFinite(v) && v >= 1;
  const asIs = {paperW: pageW, paperH: pageH, k: 1, dx: 0, dy: 0};
  if (!(ok(pageW) && ok(pageH) && ok(paperW) && ok(paperH))) return asIs;
  const short = Math.min(paperW, paperH), long = Math.max(paperW, paperH);
  const [pw, ph] = pageW > pageH ? [long, short] : [short, long];
  const k = Math.min(pw / pageW, ph / pageH);
  const dx = (pw - pageW * k) / 2, dy = (ph - pageH * k) / 2;
  if (!(Number.isFinite(k) && k > 0 && Number.isFinite(dx) && Number.isFinite(dy))) return asIs;
  return {paperW: pw, paperH: ph, k, dx, dy};
}
