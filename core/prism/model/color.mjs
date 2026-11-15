// DeckCraft colour: sRGB colours, theme colour slots and DrawingML-style colour transforms (tint,
// shade, luminance modulation/offset, alpha…), so theme-relative colours resolve the way
// presentation files expect.
// Translated from deckcraft crates/color/src/lib.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// An Rgba is `{r, g, b, a}` with 0–255 integer components (straight alpha), as deckcraft
// serializes it. A ColorTransform is `{op, val?}` (serde `tag = "op", content = "val"`), values in
// file units (percentages ×1000, angles ×60000).

/** Rust `f64 as u8`: saturating, NaN → 0. */
const u8 = v => (Number.isNaN(v) ? 0 : v <= 0 ? 0 : v >= 255 ? 255 : Math.trunc(v));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const rgb = (r, g, b) => ({r, g, b, a: 255});
export const rgba = (r, g, b, a) => ({r, g, b, a});
export const BLACK = Object.freeze(rgb(0, 0, 0));
export const WHITE = Object.freeze(rgb(255, 255, 255));
export const TRANSPARENT = Object.freeze(rgba(0, 0, 0, 0));
export const rgbaEq = (x, y) => !!x && !!y && x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a;

/** `RRGGBB` or `#RRGGBB` (also `RRGGBBAA` and `RGB`). */
export function fromHex(input) {
  let s = String(input).trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-fA-F]*$/.test(s)) return null;
  const byte = i => Number.parseInt(s.slice(i, i + 2), 16);
  if (s.length === 6) return rgb(byte(0), byte(2), byte(4));
  if (s.length === 8) return rgba(byte(0), byte(2), byte(4), byte(6));
  if (s.length === 3) { const n = i => Number.parseInt(s[i], 16) * 17; return rgb(n(0), n(1), n(2)); }
  return null;
}
/** `RRGGBB` uppercase (no alpha). */
export const hex = c => [c.r, c.g, c.b].map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('');
/** CSS color text for rendering (`#rrggbb` or `rgba(...)`). */
export const css = c => (c.a === 255 ? `#${hex(c).toLowerCase()}` : `rgba(${c.r},${c.g},${c.b},${+(c.a / 255).toFixed(4)})`);
export const withAlpha = (c, a) => ({...c, a});
export const toF32 = c => [c.r / 255, c.g / 255, c.b / 255, c.a / 255];
export function fromF64(r, g, b, a) {
  const k = v => (Number.isFinite(v) ? u8(Math.round(clamp(v, 0, 1) * 255)) : 0);
  return {r: k(r), g: k(g), b: k(b), a: k(a)};
}
const lin = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** Relative luminance (WCAG), 0–1. */
export const luminance = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
/** WCAG contrast ratio between two colours (1–21). */
export function contrast(x, y) {
  const a = luminance(x), b = luminance(y);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
export function toHsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (Math.abs(max - min) < 1e-12) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = Math.abs(max - r) < 1e-12 ? (g - b) / d + (g < b ? 6 : 0) : Math.abs(max - g) < 1e-12 ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function fromHsl(hIn, sIn, lIn, a) {
  const h = ((((hIn % 360) + 360) % 360) / 360);
  const s = clamp(sIn, 0, 1);
  const l = clamp(lIn, 0, 1);
  if (s === 0) return fromF64(l, l, l, a / 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = tIn => {
    const t = tIn < 0 ? tIn + 1 : tIn > 1 ? tIn - 1 : tIn;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return fromF64(f(h + 1 / 3), f(h), f(h - 1 / 3), a / 255);
}
/** Linear interpolation (straight alpha). */
export function lerp(x, o, tIn) {
  const t = Number.isFinite(tIn) ? clamp(tIn, 0, 1) : 0;
  const m = (a, b) => u8(clamp(Math.round(a + (b - a) * t), 0, 255));
  return {r: m(x.r, o.r), g: m(x.g, o.g), b: m(x.b, o.b), a: m(x.a, o.a)};
}

/** The twelve theme colour slots, plus the mapped aliases and `phClr`. */
export const THEME_SLOTS = Object.freeze(['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']);
export const SLOTS = Object.freeze([...THEME_SLOTS, 'bg1', 'tx1', 'bg2', 'tx2', 'phClr']);
export const isSlot = s => SLOTS.includes(s);
export const slotFromXml = s => (SLOTS.includes(s) ? s : null);
const SLOT_LABELS = {dk1: 'Text/Background - Dark 1', tx1: 'Text/Background - Dark 1', lt1: 'Text/Background - Light 1', bg1: 'Text/Background - Light 1',
  dk2: 'Text/Background - Dark 2', tx2: 'Text/Background - Dark 2', lt2: 'Text/Background - Light 2', bg2: 'Text/Background - Light 2',
  accent1: 'Accent 1', accent2: 'Accent 2', accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', accent6: 'Accent 6',
  hlink: 'Hyperlink', folHlink: 'Followed Hyperlink', phClr: 'Placeholder colour'};
export const slotLabel = s => SLOT_LABELS[s] ?? '';

const SLOT_INDEX = {dk1: 0, tx1: 0, lt1: 1, bg1: 1, dk2: 2, tx2: 2, lt2: 3, bg2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8,
  accent6: 9, hlink: 10, folHlink: 11, phClr: 4};
/** A colour scheme `{name, colors: Rgba[12]}`: the colour in `slot`. */
export const schemeGet = (scheme, slot) => scheme?.colors?.[SLOT_INDEX[slot]] ?? BLACK;
/** A copy of `scheme` with `slot` set (only the twelve theme slots). */
export function schemeSet(scheme, slot, c) {
  const i = THEME_SLOTS.indexOf(slot);
  if (i < 0) return scheme;
  const colors = scheme.colors.slice();
  colors[i] = c;
  return {...scheme, colors};
}

export const TRANSFORM_OPS = Object.freeze(['tint', 'shade', 'lumMod', 'lumOff', 'satMod', 'satOff', 'hueMod', 'hueOff', 'alpha', 'alphaMod', 'alphaOff',
  'comp', 'inv', 'gray', 'redMod', 'greenMod', 'blueMod']);
const UNIT_OPS = new Set(['comp', 'inv', 'gray']);
/** A transform from its XML element name and value (`null` for an unknown name). */
export function transformFromXml(name, val) {
  if (!TRANSFORM_OPS.includes(name)) return null;
  return UNIT_OPS.has(name) ? {op: name} : {op: name, val: Math.trunc(val ?? 0)};
}

/** Apply transforms to a base colour. */
export function apply(base, transforms = []) {
  let c = base;
  for (const t of transforms) c = applyOne(c, t);
  return c;
}

const pct = v => v / 100000;
const toLin = v => lin(v);
const fromLin = vIn => { const v = clamp(vIn, 0, 1); return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; };
const mapLinear = (c, f) => fromF64(fromLin(f(toLin(c.r))), fromLin(f(toLin(c.g))), fromLin(f(toLin(c.b))), c.a / 255);

function applyOne(c, t) {
  const v = t.val ?? 0;
  switch (t.op) {
    // tint: towards white by (1 - value); shade: towards black. Office applies these in linear light.
    case 'tint': { const k = clamp(pct(v), 0, 1); return mapLinear(c, x => x * k + (1 - k)); }
    case 'shade': { const k = clamp(pct(v), 0, 1); return mapLinear(c, x => x * k); }
    case 'lumMod': { const [h, s, l] = toHsl(c); return fromHsl(h, s, l * pct(v), c.a); }
    case 'lumOff': { const [h, s, l] = toHsl(c); return fromHsl(h, s, l + pct(v), c.a); }
    case 'satMod': { const [h, s, l] = toHsl(c); return fromHsl(h, s * pct(v), l, c.a); }
    case 'satOff': { const [h, s, l] = toHsl(c); return fromHsl(h, s + pct(v), l, c.a); }
    case 'hueMod': { const [h, s, l] = toHsl(c); return fromHsl(h * pct(v), s, l, c.a); }
    case 'hueOff': { const [h, s, l] = toHsl(c); return fromHsl(h + v / 60000, s, l, c.a); }
    case 'alpha': return withAlpha(c, u8(Math.round(clamp(pct(v), 0, 1) * 255)));
    case 'alphaMod': return withAlpha(c, u8(clamp(Math.round(c.a * pct(v)), 0, 255)));
    case 'alphaOff': return withAlpha(c, u8(clamp(Math.round(c.a + pct(v) * 255), 0, 255)));
    case 'comp': { const [h, s, l] = toHsl(c); return fromHsl(h + 180, s, l, c.a); }
    case 'inv': return {r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a};
    case 'gray': { const y = u8(clamp(Math.round(0.299 * c.r + 0.587 * c.g + 0.114 * c.b), 0, 255)); return {r: y, g: y, b: y, a: c.a}; }
    case 'redMod': return {...c, r: u8(clamp(Math.round(c.r * pct(v)), 0, 255))};
    case 'greenMod': return {...c, g: u8(clamp(Math.round(c.g * pct(v)), 0, 255))};
    case 'blueMod': return {...c, b: u8(clamp(Math.round(c.b * pct(v)), 0, 255))};
    default: return c;
  }
}

/** The colour-picker grid under each theme colour: lighter 80/60/40%, darker 25/50% (dark/light colours differ). */
export function themeVariants(c) {
  const l = toHsl(c)[2];
  const lm = (m, o) => (o === undefined ? [{op: 'lumMod', val: m}] : [{op: 'lumMod', val: m}, {op: 'lumOff', val: o}]);
  if (l < 0.2) return [[lm(10000, 90000), 'Lighter 90%'], [lm(25000, 75000), 'Lighter 75%'], [lm(50000, 50000), 'Lighter 50%'], [lm(75000, 25000), 'Lighter 25%'], [lm(90000, 10000), 'Lighter 10%']];
  if (l > 0.8) return [[lm(95000), 'Darker 5%'], [lm(85000), 'Darker 15%'], [lm(75000), 'Darker 25%'], [lm(65000), 'Darker 35%'], [lm(50000), 'Darker 50%']];
  return [[lm(20000, 80000), 'Lighter 80%'], [lm(40000, 60000), 'Lighter 60%'], [lm(60000, 40000), 'Lighter 40%'], [lm(75000), 'Darker 25%'], [lm(50000), 'Darker 50%']];
}

/** Standard colours row of the colour picker. */
export const STANDARD_COLORS = Object.freeze([
  [rgb(0xc0, 0, 0), 'Dark Red'], [rgb(0xff, 0, 0), 'Red'], [rgb(0xff, 0xc0, 0), 'Orange'], [rgb(0xff, 0xff, 0), 'Yellow'], [rgb(0x92, 0xd0, 0x50), 'Light Green'],
  [rgb(0, 0xb0, 0x50), 'Green'], [rgb(0, 0xb0, 0xf0), 'Light Blue'], [rgb(0, 0x70, 0xc0), 'Blue'], [rgb(0, 0x20, 0x60), 'Dark Blue'], [rgb(0x70, 0x30, 0xa0), 'Purple'],
]);

const PRESETS = {black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], lime: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  maroon: [128, 0, 0], navy: [0, 0, 128], olive: [128, 128, 0], purple: [128, 0, 128], teal: [0, 128, 128], orange: [255, 165, 0], pink: [255, 192, 203],
  brown: [165, 42, 42], gold: [255, 215, 0], ltGray: [211, 211, 211], lightGray: [211, 211, 211], dkGray: [169, 169, 169], darkGray: [169, 169, 169]};
/** A few CSS-like preset colour names (`prstClr`). */
export const preset = name => (PRESETS[name] ? rgb(...PRESETS[name]) : null);

/** Every preset colour name a file may write (ST_PresetColorVal with the later editions' aliases). */
export const PRESET_NAMES = Object.freeze(('aliceBlue antiqueWhite aqua aquamarine azure beige bisque black blanchedAlmond blue blueViolet brown burlyWood cadetBlue '
  + 'chartreuse chocolate coral cornflowerBlue cornsilk crimson cyan darkBlue darkCyan darkGoldenrod darkGray darkGrey darkGreen darkKhaki darkMagenta '
  + 'darkOliveGreen darkOrange darkOrchid darkRed darkSalmon darkSeaGreen darkSlateBlue darkSlateGray darkSlateGrey darkTurquoise darkViolet dkBlue dkCyan '
  + 'dkGoldenrod dkGray dkGrey dkGreen dkKhaki dkMagenta dkOliveGreen dkOrange dkOrchid dkRed dkSalmon dkSeaGreen dkSlateBlue dkSlateGray dkSlateGrey '
  + 'dkTurquoise dkViolet deepPink deepSkyBlue dimGray dimGrey dodgerBlue firebrick floralWhite forestGreen fuchsia gainsboro ghostWhite gold goldenrod '
  + 'gray grey green greenYellow honeydew hotPink indianRed indigo ivory khaki lavender lavenderBlush lawnGreen lemonChiffon lightBlue lightCoral lightCyan '
  + 'lightGoldenrodYellow lightGray lightGrey lightGreen lightPink lightSalmon lightSeaGreen lightSkyBlue lightSlateGray lightSlateGrey lightSteelBlue '
  + 'lightYellow ltBlue ltCoral ltCyan ltGoldenrodYellow ltGray ltGrey ltGreen ltPink ltSalmon ltSeaGreen ltSkyBlue ltSlateGray ltSlateGrey ltSteelBlue '
  + 'ltYellow lime limeGreen linen magenta maroon medAquamarine medBlue medOrchid medPurple medSeaGreen medSlateBlue medSpringGreen medTurquoise '
  + 'medVioletRed mediumAquamarine mediumBlue mediumOrchid mediumPurple mediumSeaGreen mediumSlateBlue mediumSpringGreen mediumTurquoise mediumVioletRed '
  + 'midnightBlue mintCream mistyRose moccasin navajoWhite navy oldLace olive oliveDrab orange orangeRed orchid paleGoldenrod paleGreen paleTurquoise '
  + 'paleVioletRed papayaWhip peachPuff peru pink plum powderBlue purple red rosyBrown royalBlue saddleBrown salmon sandyBrown seaGreen seaShell sienna '
  + 'silver skyBlue slateBlue slateGray slateGrey snow springGreen steelBlue tan teal thistle tomato turquoise violet wheat white whiteSmoke yellow yellowGreen').split(' '));
/** Every system colour name a file may write (ST_SystemColorVal). */
export const SYSTEM_NAMES = Object.freeze(('scrollBar background activeCaption inactiveCaption menu window windowFrame menuText windowText captionText '
  + 'activeBorder inactiveBorder appWorkspace highlight highlightText btnFace btnShadow grayText btnText inactiveCaptionText btnHighlight 3dDkShadow 3dLight '
  + 'infoText infoBk hotLight gradientActiveCaption gradientInactiveCaption menuHighlight menuBar').split(' '));
export const isPresetName = n => PRESET_NAMES.includes(n);
export const isSystemName = n => SYSTEM_NAMES.includes(n);
