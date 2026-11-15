// Cell styles (font, fill, borders, alignment, number format, protection), interned per workbook,
// and theme colours.
// Translated from gridcraft crates/model/src/style.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored form: `content.styles[id]` is a sparse style object (only what differs from the default),
// id 0 is the Normal style. A cell's `s` is the id. Colours: '#RRGGBB', {theme: i, tint: -1..1}, or
// absent for Automatic.
//   {font?: {name?, size?, bold?, italic?, underline?: 'single'|'double'|'singleAccounting'|'doubleAccounting',
//            strike?, color?, vert?: 'superscript'|'subscript'},
//    fill?: {pattern: 'solid'|'gray50'|..., fg?, bg?},
//    borders?: {left?|right?|top?|bottom?|diagDown?|diagUp?: {style: 'thin'|..., color?}},
//    align?: {h?: 'left'|'center'|'right'|'fill'|'justify'|'centerAcross'|'distributed', v?: 'top'|'center'|'justify'|'distributed',
//             wrap?, shrink?, indent?, rotation?},
//    numFmt?: '0.00', protection?: {locked?: false, hidden?: true}}
// No DOM, no Node built-ins.

export const DEFAULT_FONT = 'Calibri';
export const DEFAULT_FONT_SIZE = 11;

export const DEFAULT_THEME = Object.freeze({
  name: 'Craft',
  colors: Object.freeze([0xFFFFFF, 0x000000, 0xE8E8E8, 0x0E2841, 0x156082, 0xE97132, 0x196B24, 0x0F9ED5, 0xA02B93, 0x4EA72E, 0x467886, 0x96607D]),
  majorFont: DEFAULT_FONT,
  minorFont: DEFAULT_FONT,
});

/** Border line widths in pixels (BorderStyle::width). */
export const BORDER_WIDTH = Object.freeze({none: 0, hair: 1, thin: 1, dashed: 1, dotted: 1, dashDot: 1, dashDotDot: 1, medium: 2, mediumDashed: 2,
  mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3, double: 3});

/** The fully resolved default style. */
export const DEFAULT_STYLE = Object.freeze({
  font: Object.freeze({name: DEFAULT_FONT, size: DEFAULT_FONT_SIZE, bold: false, italic: false, underline: 'none', strike: false, color: null, vert: 'baseline'}),
  fill: Object.freeze({pattern: 'none', fg: null, bg: null}),
  borders: Object.freeze({left: null, right: null, top: null, bottom: null, diagDown: null, diagUp: null}),
  align: Object.freeze({h: 'general', v: 'bottom', wrap: false, shrink: false, indent: 0, rotation: 0}),
  numFmt: 'General',
  protection: Object.freeze({locked: true, hidden: false}),
});

// ---------------------------------------------------------------------------------------------
// Colours

/** RGB of 0xRRGGBB. */
const rgbOf = v => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
function rgbToHsl([r0, g0, b0]) {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue = t0 => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}
/** Excel's tint: towards black (negative) or white (positive) in HSL lightness. */
export function applyTint(rgb, tint) {
  if (!tint) return rgb;
  const [h, s, l] = rgbToHsl(rgb);
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return hslToRgb(h, s, Math.min(1, Math.max(0, nl)));
}
/** A stored colour → [r, g, b], or null for Automatic. */
export function resolveColor(c, theme = DEFAULT_THEME) {
  if (c === null || c === undefined || c === 'auto') return null;
  if (typeof c === 'string') {
    let h = c.trim().replace(/^#/, '');
    if (h.length === 8) h = h.slice(2);
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return rgbOf(parseInt(h, 16));
  }
  if (typeof c === 'object' && Number.isInteger(c.theme)) {
    const base = theme.colors[c.theme] ?? 0;
    return applyTint(rgbOf(base), c.tint ?? 0);
  }
  return null;
}
export const hex = rgb => (rgb ? '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase() : null);
export const colorHex = (c, theme) => hex(resolveColor(c, theme));

// ---------------------------------------------------------------------------------------------
// Resolve, intern, derive

const resolved = new WeakMap();
/** A sparse style object → the full style (defaults filled in), cached per object. */
export function resolveStyle(st) {
  if (!st) return DEFAULT_STYLE;
  let r = resolved.get(st);
  if (r) return r;
  r = Object.freeze({
    font: Object.freeze({...DEFAULT_STYLE.font, ...(st.font ?? {})}),
    fill: Object.freeze({...DEFAULT_STYLE.fill, ...(st.fill ?? {})}),
    borders: Object.freeze({...DEFAULT_STYLE.borders, ...(st.borders ?? {})}),
    align: Object.freeze({...DEFAULT_STYLE.align, ...(st.align ?? {})}),
    numFmt: st.numFmt ?? 'General',
    protection: Object.freeze({...DEFAULT_STYLE.protection, ...(st.protection ?? {})}),
  });
  resolved.set(st, r);
  return r;
}

/** The style table of a workbook content (index 0 is Normal). */
export const styleTable = content => (Array.isArray(content?.styles) && content.styles.length ? content.styles : [{}]);
/** Sparse style of an id (unknown ids fall back to Normal, as StyleTable::get). */
export function styleById(content, id) {
  const t = styleTable(content);
  return t[id ?? 0] ?? t[0] ?? {};
}

/** Removes defaults from a style so equal styles compare equal (the interning key). */
export function sparseStyle(full) {
  const out = {};
  const sub = (k, defaults) => {
    const v = full[k];
    if (!v) return;
    const o = {};
    for (const [p, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (k === 'borders') { if (x && x.style && x.style !== 'none') o[p] = x.color ? {style: x.style, color: x.color} : {style: x.style}; continue; }
      if (defaults[p] !== x && !(x === null && defaults[p] === null)) o[p] = x;
    }
    if (Object.keys(o).length) out[k] = o;
  };
  sub('font', DEFAULT_STYLE.font);
  sub('fill', DEFAULT_STYLE.fill);
  if (out.fill && (out.fill.pattern === undefined || out.fill.pattern === 'none') && !out.fill.fg && !out.fill.bg) delete out.fill;
  sub('borders', DEFAULT_STYLE.borders);
  sub('align', DEFAULT_STYLE.align);
  if (full.numFmt && full.numFmt !== 'General') out.numFmt = full.numFmt;
  sub('protection', DEFAULT_STYLE.protection);
  return out;
}
/** Canonical text of a sparse style (sorted keys). */
export function styleKey(st) {
  const sort = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(st ?? {}));
}
const indexes = new WeakMap();
function indexOf(table) {
  let m = indexes.get(table);
  if (m) return m;
  m = new Map();
  table.forEach((st, i) => { const k = styleKey(st); if (!m.has(k)) m.set(k, i); });
  indexes.set(table, m);
  return m;
}
/** The id of an equal style already in the table, or -1. */
export function findStyle(content, sparse) {
  return indexOf(styleTable(content)).get(styleKey(sparse)) ?? -1;
}

/**
 * Interns a style through the change API (gridcraft StyleTable::intern): returns the id of an
 * equal style, appending it to `content.styles` when new. `change` is ctx.change.
 */
export function internStyle(change, content, style) {
  const sparse = sparseStyle(resolveStyle(style));
  if (!Object.keys(sparse).length) return 0;
  const cur = change.get(['styles']);
  const table = Array.isArray(cur) && cur.length ? cur : null;
  if (table) {
    const id = indexOf(table).get(styleKey(sparse));
    if (id !== undefined) return id;
  }
  // The id is read before the splice: a change that hands back the live array grows it in place.
  const id = table ? table.length : 1;
  if (!table) change.set(['styles'], [{}, sparse]);
  else change.splice(['styles'], table.length, 0, sparse);
  return id;
}

/** Applies a patch to a style id and interns the result (StyleTable::derive). */
export function deriveStyle(change, content, id, patch) {
  const base = resolveStyle(styleById({styles: change.get(['styles']) ?? content.styles}, id));
  const next = mergeStyle(base, patch);
  return internStyle(change, content, next);
}
/** Deep-merges a style patch into a full style ({font: {bold: true}} etc.); `null` clears a part. */
export function mergeStyle(base, patch) {
  const out = {font: {...base.font}, fill: {...base.fill}, borders: {...base.borders}, align: {...base.align}, numFmt: base.numFmt, protection: {...base.protection}};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'numFmt') { out.numFmt = v ?? 'General'; continue; }
    if (!(k in out)) continue;
    if (v === null) { out[k] = {...DEFAULT_STYLE[k]}; continue; }
    Object.assign(out[k], v);
  }
  return out;
}

/** Whether a resolved style shows nothing beyond the defaults. */
export const isDefaultStyle = st => styleKey(sparseStyle(st)) === '{}';
