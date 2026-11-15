// Colours, fills, lines and effects.
// Translated from deckcraft crates/model/src/style.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// JSON shapes (deckcraft serde): ColorRef `{base: {kind:'rgb', rgb} | {kind:'scheme', slot} |
// {kind:'preset', name} | {kind:'system', name, last}, mods?: ColorTransform[]}`; Fill
// `{kind:'none'} | {kind:'solid', color} | {kind:'gradient', stops, shape, rotateWithShape, tile?} |
// {kind:'picture', media, crop, mode, alpha, adjust, ...} | {kind:'pattern', preset, fg, bg} |
// {kind:'group'} | {kind:'background'}`; Line `{fill, width, dash, cap, join, compound, head, tail}`.

import {apply as applyTransforms, schemeGet, preset as presetColor, BLACK} from './color.mjs';

export const colorRgb = c => ({base: {kind: 'rgb', rgb: c}});
export const colorScheme = slot => ({base: {kind: 'scheme', slot}});
/** `ColorRef::with`: a copy with one more transform. */
export const colorWith = (c, m) => ({...c, mods: [...(c.mods ?? []), m]});
/** Resolve against a colour scheme; `ph` substitutes phClr (the style matrix colour). */
export function resolveColor(c, scheme, ph) {
  const b = c?.base;
  let base;
  if (!b) base = BLACK;
  else if (b.kind === 'rgb') base = b.rgb;
  else if (b.kind === 'scheme') base = b.slot === 'phClr' ? ph ?? schemeGet(scheme, 'accent1') : schemeGet(scheme, b.slot);
  else if (b.kind === 'preset') base = presetColor(b.name) ?? BLACK;
  else if (b.kind === 'system') base = b.last;
  else base = BLACK;
  return applyTransforms(base, c.mods ?? []);
}
/** Alpha (0–1) from an `alpha` transform, if any. */
export const colorAlpha = c => (c?.mods ?? []).reduce((a, m) => (m.op === 'alpha' ? Math.min(Math.max(m.val / 100000, 0), 1) : a), 1);

export const fillNone = () => ({kind: 'none'});
export const fillSolid = color => ({kind: 'solid', color});
export const isFillNone = f => f?.kind === 'none';

export const LINE_CAPS = Object.freeze(['flat', 'round', 'square']);
export const LINE_JOINS = Object.freeze(['round', 'bevel', 'miter']);
export const COMPOUNDS = Object.freeze(['single', 'double', 'thickThin', 'thinThick', 'triple']);
const COMPOUND_XML = {single: 'sng', double: 'dbl', thickThin: 'thickThin', thinThick: 'thinThick', triple: 'tri'};
export const compoundXml = c => COMPOUND_XML[c] ?? 'sng';
export const compoundFromXml = s => Object.entries(COMPOUND_XML).find(([, v]) => v === s)?.[0] ?? 'single';

export const DASH_PRESETS = Object.freeze(['solid', 'sysDot', 'sysDash', 'dash', 'dashDot', 'lgDash', 'lgDashDot', 'lgDashDotDot', 'dot', 'sysDashDot', 'sysDashDotDot']);
/** Dash/space lengths in multiples of the line width. */
export function dashPattern(dash) {
  if (!dash) return [];
  if (dash.kind === 'custom') return (dash.pattern ?? []).flatMap(([d, s]) => [d, s]);
  switch (dash.name) {
    case 'dot': return [1, 3];
    case 'dash': return [4, 3];
    case 'lgDash': return [8, 3];
    case 'dashDot': return [4, 3, 1, 3];
    case 'lgDashDot': return [8, 3, 1, 3];
    case 'lgDashDotDot': return [8, 3, 1, 3, 1, 3];
    case 'sysDash': return [3, 1];
    case 'sysDot': return [1, 1];
    case 'sysDashDot': return [3, 1, 1, 1];
    case 'sysDashDotDot': return [3, 1, 1, 1, 1, 1];
    default: return [];
  }
}

export const lineSolid = (color, width) => ({fill: fillSolid(color), width});
export const lineNone = () => ({fill: fillNone()});
const LINE_FIELDS = ['fill', 'width', 'dash', 'cap', 'join', 'compound', 'head', 'tail', 'sketch'];
/** `Line::inherit`: fill unset fields from `parent` (returns a new line). */
export function inheritLine(line, parent) {
  const out = {...line};
  for (const k of LINE_FIELDS) if (out[k] == null && parent?.[k] != null) out[k] = parent[k];
  return out;
}

const EFFECT_FIELDS = ['outerShadow', 'innerShadow', 'glow', 'softEdge', 'reflection', 'bevel', 'fillOverlay'];
export const effectsEmpty = e => !e || EFFECT_FIELDS.every(k => e[k] == null);

/** `ShapeStyle::accent`: accent fill, darker accent outline, light text (newly drawn shapes). */
export const accentStyle = slot => ({
  lineRef: [2, colorWith(colorScheme(slot), {op: 'shade', val: 50000})],
  fillRef: [1, colorScheme(slot)],
  effectRef: [0, colorScheme(slot)],
  fontRef: ['minor', colorScheme('lt1')],
});
/** `ShapeStyle::line`: the default for lines and connectors. */
export const lineStyle = slot => ({
  lineRef: [1, colorScheme(slot)],
  fillRef: [0, colorScheme(slot)],
  effectRef: [0, colorScheme(slot)],
  fontRef: ['minor', colorScheme('tx1')],
});
