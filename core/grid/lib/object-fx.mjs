// What the Shape Format, Picture Format and Chart Format tabs set on a floating object: shape styles, effects (shadow, glow,
// soft edges, reflection, bevel), WordArt on a shape's text, rotation, a picture's corrections, colour, transparency,
// borders, styles, crop, and the arithmetic they share.
// Not in gridcraft (its ribbon draws none of these tabs; its objects keep a fill, a line, a text and an alt text only): the
// presets and their names are Excel's, the effects are Quill's (core/quill/model/effects.mjs, translated from wordcraft
// effects.rs), the stored fields are ours and save as DrawingML (xlsx-drawing.mjs). Not checked against upstream.
// No DOM, no Node built-ins.
//
// Stored on a chart, picture or shape: `fx` {shadow, glow, softEdge, reflection, bevel} (Quill's model: points, [r, g, b]),
// `alt`, `decorative`, `rotation` (degrees clockwise), `flipH`, `flipV` (pictures and shapes), `group` (an id its members share).
// On a shape: `style` (the gallery tile applied), `textFx` {fill, outline, shadow, glow, reflection} (WordArt, Quill's model).
// On a picture: `adjust`, `crop`, `border`, `geom`, `orig` (the bytes Reset Picture returns to), `look` {effect}.
// On a chart: `area` {fill, line, lineWidth} (the chart area), `textFx` {fill, outline}.

import {sanitizedEffects, shapeEffectsIsEmpty, shadowPreset, reflectionPreset, bevelPreset, sanitizedGlow, defaultGlow} from '../../quill/model/effects.mjs';

export {sanitizedEffects, shapeEffectsIsEmpty, shadowPreset, reflectionPreset, bevelPreset, sanitizedGlow, defaultGlow};
export const PIC_GEOMS = Object.freeze(['rect', 'roundRect', 'ellipse', 'triangle', 'diamond', 'hexagon', 'octagon']);

// ---- shape styles (Shape Styles gallery) ---------------------------------------------------------------------------------

const STYLE_COLUMNS = [['Dark 1', 1], ['Accent 1', 4], ['Accent 2', 5], ['Accent 3', 6], ['Accent 4', 7], ['Accent 5', 8], ['Accent 6', 9]];
const STYLE_ROWS = ['Colored Outline', 'Colored Fill', 'Light 1 Outline, Colored Fill', 'Subtle Effect', 'Moderate Effect', 'Intense Effect'];
/**
 * The 42 styles of Excel's gallery (six rows of Dark 1 and the six accent colours), each {id, label, fill, line, lineWidth, shadow}
 * with theme colours ({theme, tint}): Colored Outline (a white fill), Colored Fill, Light 1 Outline Colored Fill (a pale tint, no
 * outline), Subtle Effect, Moderate Effect (with a shadow) and Intense Effect (a darker fill with a white line).
 */
export const SHAPE_STYLES = Object.freeze(STYLE_ROWS.flatMap((row, r) => STYLE_COLUMNS.map(([name, theme], c) => {
  const id = r * 7 + c, black = theme === 1;
  const white = {theme: 0, tint: 0}, accent = {theme, tint: 0};
  const dark = {theme, tint: black ? 0 : -0.5};
  const fill = r === 0 ? white : r === 1 || r === 3 || r === 4 ? accent : r === 2 ? {theme, tint: black ? 0.85 : 0.8} : {theme, tint: black ? 0.25 : -0.25};
  const line = r === 0 ? accent : r === 1 ? dark : r === 2 ? 'auto' : r === 3 || r === 4 ? accent : white;
  return Object.freeze({id, label: `${row} - ${name}`, fill, line, lineWidth: r === 0 ? 1.5 : 1, shadow: r === 4});
})));

// ---- picture adjustments -------------------------------------------------------------------------------------------------

export const ADJUST_DEFAULT = Object.freeze({brightness: 0, contrast: 0, saturation: 100, tone: 0, recolor: '', transparency: 0});
export const RECOLORS = Object.freeze([['', 'No Recolor'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia'], ['washout', 'Washout'], ['blackWhite', 'Black and White: 50%']]);
export const BRIGHTNESS = Object.freeze([-40, -20, 0, 20, 40]);
export const CONTRAST = Object.freeze([-40, -20, 0, 20, 40]);
export const SATURATIONS = Object.freeze([0, 33, 66, 100, 133, 167, 200]);
/** Colour tone, warm to cool (Excel's Temperature 4700 K to 11200 K): 100 is the warmest. */
export const TONES = Object.freeze([100, 66, 33, 0, -33, -66, -100]);
export const TONE_KELVIN = Object.freeze({100: 4700, 66: 5300, 33: 5900, 0: 6500, '-33': 7200, '-66': 8800, '-100': 11200});
export const TRANSPARENCIES = Object.freeze([0, 15, 30, 50, 65, 80, 95]);
export const ADJUST_KEYS = Object.freeze(Object.keys(ADJUST_DEFAULT));

export const adjustOf = img => ({...ADJUST_DEFAULT, ...(img?.adjust ?? {})});
export const isPlainAdjust = a => ADJUST_KEYS.every(k => a[k] === ADJUST_DEFAULT[k]);

/** The CSS `filter` of a picture's corrections and colour (not its transparency: that is the opacity). '' when nothing is adjusted. */
export function cssFilter(adj) {
  const a = {...ADJUST_DEFAULT, ...adj};
  const f = [];
  if (a.brightness) f.push(`brightness(${(1 + a.brightness / 100).toFixed(3)})`);
  if (a.contrast) f.push(`contrast(${(1 + a.contrast / 100).toFixed(3)})`);
  if (a.saturation !== 100) f.push(`saturate(${(a.saturation / 100).toFixed(3)})`);
  if (a.tone > 0) f.push(`sepia(${(a.tone / 250).toFixed(3)})`);
  else if (a.tone < 0) f.push(`hue-rotate(${(a.tone * 0.35).toFixed(1)}deg)`);
  switch (a.recolor) {
    case 'grayscale': f.push('grayscale(1)'); break;
    case 'sepia': f.push('sepia(1)'); break;
    case 'washout': f.push('brightness(1.5) contrast(0.6)'); break;
    case 'blackWhite': f.push('grayscale(1) contrast(100)'); break;
    default: break;
  }
  return f.join(' ');
}
/** The opacity a picture's transparency leaves (1 = opaque). */
export const opacityOf = adj => 1 - Math.min(100, Math.max(0, adjustOf({adjust: adj}).transparency)) / 100;

/** `brightness=20,contrast=-20` as an adjustments patch; null when it is no preset. */
export function parsePreset(text) {
  const out = {};
  for (const part of String(text ?? '').split(',')) {
    const [k, v] = part.split('=');
    if (!ADJUST_KEYS.includes(k)) return null;
    if (k === 'recolor') { if (!RECOLORS.some(([id]) => id === v)) return null; out[k] = v; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

// ---- picture styles (Picture Styles gallery) -----------------------------------------------------------------------------

/** Picture styles the sheet can draw: a border, a frame shape and an effect. {id, label, border, geom, fx}. */
export const PICTURE_STYLES = Object.freeze([
  {id: 'simpleFrameWhite', label: 'Simple Frame, White', border: {color: '#FFFFFF', width: 7}, geom: 'rect', fx: 'shadow'},
  {id: 'beveledMatteWhite', label: 'Beveled Matte, White', border: {color: '#FFFFFF', width: 14}, geom: 'rect', fx: 'bevel'},
  {id: 'metalFrame', label: 'Metal Frame', border: {color: '#A6A6A6', width: 5}, geom: 'rect', fx: 'bevel'},
  {id: 'simpleFrameBlack', label: 'Simple Frame, Black', border: {color: '#000000', width: 7}, geom: 'rect', fx: 'shadow'},
  {id: 'moderateFrameBlack', label: 'Moderate Frame, Black', border: {color: '#000000', width: 4}, geom: 'rect', fx: null},
  {id: 'thickMatteBlack', label: 'Thick Matte, Black', border: {color: '#000000', width: 18}, geom: 'rect', fx: null},
  {id: 'dropShadowRectangle', label: 'Drop Shadow Rectangle', border: null, geom: 'rect', fx: 'shadow'},
  {id: 'centerShadowRectangle', label: 'Center Shadow Rectangle', border: null, geom: 'rect', fx: 'center'},
  {id: 'reflectedRounded', label: 'Reflected Rounded Rectangle', border: {color: '#FFFFFF', width: 5}, geom: 'roundRect', fx: 'reflection'},
  {id: 'roundedRectangle', label: 'Rounded Diagonal Corner, White', border: {color: '#FFFFFF', width: 6}, geom: 'roundRect', fx: null},
  {id: 'roundedShadow', label: 'Drop Shadow Rounded Rectangle', border: null, geom: 'roundRect', fx: 'shadow'},
  {id: 'metalRoundedRectangle', label: 'Metal Rounded Rectangle', border: {color: '#A6A6A6', width: 6}, geom: 'roundRect', fx: null},
  {id: 'softEdgeRectangle', label: 'Soft Edge Rectangle', border: null, geom: 'rect', fx: 'softEdge'},
  {id: 'metalOval', label: 'Metal Oval', border: {color: '#A6A6A6', width: 6}, geom: 'ellipse', fx: null},
  {id: 'softEdgeOval', label: 'Soft Edge Oval', border: null, geom: 'ellipse', fx: 'softEdge'},
  {id: 'oval', label: 'Oval', border: null, geom: 'ellipse', fx: null},
  {id: 'ovalShadow', label: 'Drop Shadow Oval', border: null, geom: 'ellipse', fx: 'shadow'},
  {id: 'reflectedOval', label: 'Reflected Oval', border: {color: '#FFFFFF', width: 5}, geom: 'ellipse', fx: 'reflection'},
  {id: 'bevelPerspective', label: 'Beveled Perspective', border: {color: '#FFFFFF', width: 8}, geom: 'rect', fx: 'bevel'},
  {id: 'glowRectangle', label: 'Glow Rectangle', border: null, geom: 'rect', fx: 'glow'},
]);
/** The effect set a picture style names. */
export function styleFx(name) {
  switch (name) {
    case 'shadow': return {shadow: shadowPreset('offsetBottomRight')};
    case 'center': return {shadow: shadowPreset('offsetCenter')};
    case 'reflection': return {reflection: reflectionPreset('half')};
    case 'bevel': return {bevel: bevelPreset('circle')};
    case 'softEdge': return {softEdge: 8};
    case 'glow': return {glow: {...defaultGlow(), size: 8}};
    default: return null;
  }
}

// ---- crop ----------------------------------------------------------------------------------------------------------------

export const ASPECTS = Object.freeze({'1:1': [1, 1], '2:3': [2, 3], '3:2': [3, 2], '3:4': [3, 4], '4:3': [4, 3], '4:5': [4, 5], '5:4': [5, 4], '9:16': [9, 16], '16:9': [16, 9], '16:10': [16, 10]});
export const cropOf = img => ({l: 0, t: 0, r: 0, b: 0, ...(img?.crop ?? {})});
const clamp01 = v => Math.round(Math.min(0.95, Math.max(0, Number.isFinite(v) ? v : 0)) * 1e6) / 1e6;

/** A crop of fractions (each side 0 to 0.95, each axis keeping 5%). */
export function normalizeCrop(c) {
  const out = {l: clamp01(c.l), t: clamp01(c.t), r: clamp01(c.r), b: clamp01(c.b)};
  if (out.l + out.r > 0.95) out.r = Math.round(Math.max(0, 0.95 - out.l) * 1e6) / 1e6;
  if (out.t + out.b > 0.95) out.b = Math.round(Math.max(0, 0.95 - out.t) * 1e6) / 1e6;
  return out;
}

/** The crop that cuts a `w` x `h` picture to the ratio `aw`:`ah`, from the middle (the crop to add). */
export function centeredCrop(w, h, aw, ah) {
  const want = aw / ah, have = w / h;
  if (Math.abs(want - have) < 1e-6) return {l: 0, t: 0, r: 0, b: 0};
  if (want < have) { const keep = want / have; return {l: (1 - keep) / 2, t: 0, r: (1 - keep) / 2, b: 0}; }
  const keep = have / want;
  return {l: 0, t: (1 - keep) / 2, r: 0, b: (1 - keep) / 2};
}

// ---- rotation ------------------------------------------------------------------------------------------------------------

/** An angle in degrees as 0 (inclusive) to 360 (exclusive). */
export const normAngle = a => ((Math.round(a * 100) / 100 % 360) + 360) % 360;
