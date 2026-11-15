// WordArt: text effects on runs ([MS-DOCX] §2.6 w14:textFill, textOutline, shadow, glow,
// reflection) and text warps on shapes (DrawingML a:prstTxWarp, ECMA-376 §20.1.9.19).
// Translated from wordcraft crates/doc/src/wordart.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// TextEffects `{fill?, outline?, shadow?, glow?, reflection?}`; TextFill `{type:'none'}` |
// `{type:'solid', color, transparency}` | `{type:'gradient', stops, angle}`; GradStop
// `{pos, color, transparency}`; TextOutline `{color: [r,g,b]|null, width, transparency}`;
// Reflection `{transparency, size, distance, blur}`; TextWarp `{preset, adj?: [name, value][]}`.
// No DOM, no Node built-ins.

import {clampOr, sanitizedShadow, sanitizedGlow, MAX_BLUR} from './effects.mjs';
import {THEME_COLORS} from './content.mjs';

export const MAX_STOPS = 10;
export const MAX_OUTLINE = 20;
export const MAX_REFLECTION_GAP = 100;
export const MAX_ADJ = 8;
export const MAX_ADJ_VALUE = 100_000_000;

const remEuclid = (v, m) => ((v % m) + m) % m;

export const defaultTextOutline = () => ({color: [0, 0, 0], width: 0.75, transparency: 0});
export const defaultReflection = () => ({transparency: 50, size: 50, distance: 0, blur: 0.5});

/** At most MAX_STOPS stops, positions and transparencies 0–100, in order (stable sort). */
export function sanitizedStops(stops) {
  return (stops || []).slice(0, MAX_STOPS)
    .map(g => ({pos: clampOr(g.pos, 0, 100, 0), color: g.color, transparency: clampOr(g.transparency ?? 0, 0, 100, 0)}))
    .map((s, i) => [s, i]).sort((a, b) => a[0].pos - b[0].pos || a[1] - b[1]).map(([s]) => s);
}

/** A text fill in range, or null (a gradient without stops is no gradient). */
export function sanitizedTextFill(f) {
  if (!f) return null;
  switch (f.type) {
    case 'none': return {type: 'none'};
    case 'solid': return {type: 'solid', color: f.color, transparency: clampOr(f.transparency ?? 0, 0, 100, 0)};
    case 'gradient': {
      const s = sanitizedStops(f.stops);
      if (!s.length) return null;
      return {type: 'gradient', stops: s, angle: remEuclid(clampOr(f.angle ?? 0, -1e6, 1e6, 0), 360)};
    }
    default: return null;
  }
}
/** One colour standing for a text fill (a gradient's middle stop); null for no fill. */
export function textFillMainColor(f) {
  if (!f || f.type === 'none') return null;
  if (f.type === 'solid') return f.color;
  return f.stops?.[Math.floor(f.stops.length / 2)]?.color ?? null;
}

const has = (o, k) => o?.[k] !== undefined && o?.[k] !== null;
export const textEffectsIsEmpty = e => !e || !['fill', 'outline', 'shadow', 'glow', 'reflection'].some(k => has(e, k));

/** Finite, in range; zero-size glows dropped. */
export function sanitizedTextEffects(e) {
  const out = {};
  if (has(e, 'fill')) { const f = sanitizedTextFill(e.fill); if (f) out.fill = f; }
  if (has(e, 'outline')) {
    const o = {...defaultTextOutline(), ...e.outline};
    out.outline = {color: o.color ?? null, width: clampOr(o.width, 0, MAX_OUTLINE, 0.75), transparency: clampOr(o.transparency, 0, 100, 0)};
  }
  if (has(e, 'shadow')) out.shadow = sanitizedShadow(e.shadow);
  if (has(e, 'glow')) { const g = sanitizedGlow(e.glow); if (g.size > 0) out.glow = g; }
  if (has(e, 'reflection')) {
    const r = {...defaultReflection(), ...e.reflection};
    out.reflection = {transparency: clampOr(r.transparency, 0, 100, 50), size: clampOr(r.size, 0, 100, 50),
      distance: clampOr(r.distance, 0, MAX_REFLECTION_GAP, 0), blur: clampOr(r.blur, 0, MAX_BLUR, 0)};
  }
  return out;
}

/** Every set field of `patch` on top of `base` (style, then direct formatting). Returns a new object. */
export function overlayTextEffects(base, patch) {
  const out = {...(base || {})};
  for (const k of ['fill', 'outline', 'shadow', 'glow', 'reflection']) if (has(patch, k)) out[k] = patch[k];
  return out;
}

/** WordArt styles (Shape Format › WordArt Styles, Insert › WordArt): [id, label]. */
export const ART_STYLES = Object.freeze([
  ['solid', 'Solid Accent'], ['outlined', 'Light with Outline'], ['hollow', 'Hollow'], ['gradient', 'Accent Gradient'],
  ['shadowed', 'Dark with Shadow'], ['glowing', 'Soft Glow'], ['reflected', 'Accent with Reflection'], ['sunset', 'Warm Gradient with Outline'],
].map(Object.freeze));

/** The text effects of WordArt style `id` in theme colours `theme` (dk1, lt1, dk2, lt2, accent1…6); null if unknown. */
export function artStyle(id, theme = []) {
  const slot = i => theme[i] ?? THEME_COLORS[i] ?? [0, 0, 0];
  const dark = slot(2), light = slot(1), accent = slot(4), accent2 = slot(5);
  const solid = c => ({type: 'solid', color: c, transparency: 0});
  const line = (c, w) => ({color: c, width: w, transparency: 0});
  const grad = (a, b) => ({type: 'gradient', stops: [{pos: 0, color: a, transparency: 0}, {pos: 100, color: b, transparency: 0}], angle: 90});
  switch (id) {
    case 'solid': return {fill: solid(accent)};
    case 'outlined': return {fill: solid(light), outline: line(accent, 1)};
    case 'hollow': return {fill: {type: 'none'}, outline: line(dark, 1)};
    case 'gradient': return {fill: grad(accent, slot(7))};
    case 'shadowed': return {fill: solid(dark), shadow: {color: [0, 0, 0], transparency: 55, blur: 3, distance: 3, angle: 45, rotWithShape: false}};
    case 'glowing': return {fill: solid(light), outline: line(accent, 0.5), glow: {color: accent, size: 6, transparency: 55}};
    case 'reflected': return {fill: solid(accent), reflection: defaultReflection()};
    case 'sunset': return {fill: grad(accent2, slot(8)), outline: line(dark, 0.5)};
    default: return null;
  }
}

/** Every DrawingML preset text warp (ST_TextShapeType). */
export const WARP_PRESETS = Object.freeze(['textNoShape', 'textPlain', 'textStop', 'textTriangle', 'textTriangleInverted', 'textChevron',
  'textChevronInverted', 'textRingInside', 'textRingOutside', 'textArchUp', 'textArchDown', 'textCircle', 'textButton', 'textArchUpPour',
  'textArchDownPour', 'textCirclePour', 'textButtonPour', 'textCurveUp', 'textCurveDown', 'textCanUp', 'textCanDown', 'textWave1', 'textWave2',
  'textDoubleWave1', 'textWave4', 'textInflate', 'textDeflate', 'textInflateBottom', 'textDeflateBottom', 'textInflateTop', 'textDeflateTop',
  'textDeflateInflate', 'textDeflateInflateDeflate', 'textFadeRight', 'textFadeLeft', 'textFadeUp', 'textFadeDown', 'textSlantUp',
  'textSlantDown', 'textCascadeUp', 'textCascadeDown']);

/** The warps drawn bent (the others round-trip and draw flat), with menu labels. */
export const DRAWN_WARPS = Object.freeze([
  ['textArchUp', 'Arch Up'], ['textArchDown', 'Arch Down'], ['textCircle', 'Circle'], ['textWave1', 'Wave'], ['textSlantUp', 'Slant Up'],
  ['textSlantDown', 'Slant Down'], ['textInflate', 'Inflate'], ['textDeflate', 'Deflate'], ['textChevron', 'Chevron Up'],
  ['textChevronInverted', 'Chevron Down'], ['textTriangle', 'Triangle Up'], ['textTriangleInverted', 'Triangle Down'],
].map(Object.freeze));

/** A warp with a known preset, or null. */
export const textWarp = preset => (WARP_PRESETS.includes(preset) ? {preset, adj: []} : null);

/** Add an adjust value (short ASCII names, ±MAX_ADJ_VALUE, at most MAX_ADJ); returns the new warp. */
export function setWarpAdj(w, name, val) {
  if (typeof name !== 'string' || !name || name.length > 16 || !/^[A-Za-z0-9]+$/.test(name)) return w;
  const v = Math.max(-MAX_ADJ_VALUE, Math.min(MAX_ADJ_VALUE, Math.trunc(Number(val)) || 0));
  const adj = (w.adj || []).slice();
  const i = adj.findIndex(([n]) => n === name);
  if (i >= 0) adj[i] = [name, v];
  else if (adj.length < MAX_ADJ) adj.push([name, v]);
  return {...w, adj};
}
export const warpAdjValue = (w, name) => (w.adj || []).find(([n]) => n === name)?.[1] ?? null;

/** A known preset with capped adjust values, or null. */
export function sanitizedWarp(w) {
  let out = textWarp(w?.preset);
  if (!out) return null;
  for (const [n, v] of w.adj || []) out = setWarpAdj(out, n, v);
  return out;
}
export const warpIsPlain = w => w?.preset === 'textNoShape' || w?.preset === 'textPlain';
