// Shape Fill: the gradients Shape Format › Shape Fill › Gradient offers and the Format Shape pane builds on, and
// reading a `shape.fill` request.
//
// Translated from wordcraft crates/engine/src/cmd/shape_fill.rs (`parse`, `params`, `variations`, `presets`,
// `default_gradient`, `corner_tile`, `linear_direction_name`, `path_direction_name`, `LINEAR_DIRECTIONS`,
// `PATH_DIRECTIONS`, the `stops` editing helpers) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// A fill is the model's: `[r, g, b]`, `{type: 'solid', color, transparency}` or `{type: 'gradient', stops, kind,
// tile?, rotWithShape, flip?}` (model/fill.mjs). No DOM, no Node built-ins.

import {rgbModified, parseRgb, rgbHex} from '../model/props.mjs';
import {sanitizedFill, fillForm, fillMainColor, storedFill} from '../model/fill.mjs';
import {MAX_STOPS} from '../model/wordart.mjs';
import {CommandError} from '../../kernel/errors.mjs';

/** Most stops read from a command (the fill keeps at most MAX_STOPS after sanitizing). */
const MAX_PARAM_STOPS = 64;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bad = m => new CommandError('invalid_params', `\`gradient\`: ${m}`);

/**
 * What a `shape.fill` request sets: `{kind: 'none'}`, `{kind: 'solid', color, transparency|undefined}` or
 * `{kind: 'fill', fill}` (parse).
 */
export function parseFill(p) {
  const g = p.gradient;
  if (g === undefined || g === null) {
    // The palette's No Color arrives as `auto`.
    if (p.color === undefined || p.color === null || /^(auto|automatic|none)$/i.test(String(p.color))) return {kind: 'none'};
    const color = parseRgb(p.color);
    if (!color) throw new CommandError('invalid_params', '`color`: "RRGGBB"', {path: '/color'});
    return {kind: 'solid', color, transparency: p.transparency};
  }
  // No Gradient: the shape's colour, solid (the egui menu's first tile).
  if (g === 'none') return {kind: 'main'};
  if (typeof g !== 'object' || Array.isArray(g)) throw bad('an object');
  if (!Array.isArray(g.stops)) throw bad('`stops` is a list');
  const stops = g.stops.slice(0, MAX_PARAM_STOPS).map(st => {
    const color = parseRgb(st?.color);
    if (!color) throw new CommandError('invalid_params', '`color`: "RRGGBB"');
    return {pos: num(st.pos, 0), color, transparency: num(st.transparency, 0)};
  });
  if (stops.length < 2) throw bad('two or more stops');
  const rect = (key, dflt) => (Array.isArray(g[key]) ? [0, 1, 2, 3].map(i => num(g[key][i], dflt)) : null);
  const path = shape => ({type: 'path', shape, focus: rect('focus', 50) ?? [50, 50, 50, 50]});
  let kind;
  switch (g.type ?? 'linear') {
    case 'linear': kind = {type: 'linear', angle: num(g.angle, 90), scaled: !!g.scaled}; break;
    case 'radial': kind = path('circle'); break;
    case 'rectangular': kind = path('rect'); break;
    case 'path': kind = path('shape'); break;
    default: throw bad(`unknown type \`${g.type}\``);
  }
  const tile = rect('tile', 0);
  const fill = sanitizedFill({type: 'gradient', stops, kind, ...(tile ? {tile} : {}), rotWithShape: g.rotateWithShape ?? true, flip: 'none'});
  if (!fill) throw bad('no stops');
  return {kind: 'fill', fill};
}

/** The `shape.fill` params that set `fill` (null: no fill). */
export function fillParams(fill) {
  const f = fillForm(fill);
  if (!f) return {color: null};
  if (f.type === 'solid') return {color: rgbHex(f.color), transparency: f.transparency ?? 0};
  const out = {stops: f.stops.map(s => ({pos: s.pos, color: rgbHex(s.color), transparency: s.transparency ?? 0})), rotateWithShape: !!f.rotWithShape};
  if (f.tile) out.tile = [...f.tile];
  if (f.kind?.type === 'path') { out.type = f.kind.shape === 'circle' ? 'radial' : f.kind.shape === 'rect' ? 'rectangular' : 'path'; out.focus = [...f.kind.focus]; }
  else { out.type = 'linear'; out.angle = f.kind?.angle ?? 90; out.scaled = !!f.kind?.scaled; }
  return {gradient: out};
}

/** The directions Format Shape offers for a linear gradient, as angles (0 left to right, 90 top to bottom). */
export const LINEAR_DIRECTIONS = Object.freeze([45, 90, 135, 0, 180, 315, 270, 225]);
/** Radial and rectangular gradients start at: each corner, then the centre (percent insets l, t, r, b). */
export const PATH_DIRECTIONS = Object.freeze([[100, 100, 0, 0], [0, 100, 100, 0], [50, 50, 50, 50], [100, 0, 0, 100], [0, 0, 100, 100]].map(Object.freeze));

/** The tile rectangle Word gives a gradient starting from each corner (observed for the bottom right; the rest mirror it). */
const CORNERS = Object.freeze([[[100, 100, 0, 0], [0, 0, -100, -100]], [[0, 100, 100, 0], [-100, 0, 0, -100]], [[100, 0, 0, 100], [0, -100, -100, 0]],
  [[0, 0, 100, 100], [-100, -100, 0, 0]]]);
export function cornerTile(focus) {
  const hit = CORNERS.find(([f]) => f.every((v, i) => v === focus[i]));
  return hit ? [...hit[1]] : null;
}

export function linearDirectionName(angle) {
  return {0: 'Linear Right', 45: 'Linear Diagonal - Top Left to Bottom Right', 90: 'Linear Down', 135: 'Linear Diagonal - Top Right to Bottom Left', 180: 'Linear Left',
    225: 'Linear Diagonal - Bottom Right to Top Left', 270: 'Linear Up', 315: 'Linear Diagonal - Bottom Left to Top Right'}[Math.round(angle)] ?? 'Linear';
}
export function pathDirectionName(focus) {
  const k = focus.map(v => Math.round(v)).join(',');
  return {'0,0,100,100': 'From Top Left Corner', '100,0,0,100': 'From Top Right Corner', '0,100,100,0': 'From Bottom Left Corner', '100,100,0,0': 'From Bottom Right Corner'}[k] ?? 'From Center';
}

const gradient = (stops, kind, tile = null) => ({type: 'gradient', stops: stops.map(([pos, color]) => ({pos, color, transparency: 0})), kind, ...(tile ? {tile} : {}), rotWithShape: true});

/**
 * Shape Fill › Gradient's Light and Dark Variations of `c`, each {fill, name}, in Word's order (a grid five wide):
 * three stops at 0, 50 and 100%, light ones `c` tinted to 66, 44.5 and 23.5% with saturation ×1.6, dark ones shaded
 * to 30, 67.5 and 100% with saturation ×1.15; linear ones scaled with the shape, the rest circular.
 */
export function variations(c) {
  const tiles = (m, steps, sat) => {
    const stops = steps.map((v, i) => [i * 50, rgbModified(rgbModified(c, m, v), 'satMod', sat)]);
    const lin = angle => ({fill: gradient(stops, {type: 'linear', angle, scaled: true}), name: linearDirectionName(angle)});
    const corner = i => { const [focus, tile] = CORNERS[i]; return {fill: gradient(stops, {type: 'path', shape: 'circle', focus: [...focus]}, [...tile]), name: pathDirectionName(focus)}; };
    const centre = {fill: gradient(stops, {type: 'path', shape: 'circle', focus: [50, 50, 50, 50]}), name: pathDirectionName([50, 50, 50, 50])};
    return [lin(45), lin(90), lin(135), corner(0), corner(1), lin(0), centre, lin(180), corner(2), corner(3), lin(315), lin(270), lin(225)];
  };
  return [tiles('tint', [0.66, 0.445, 0.235], 1.6), tiles('shade', [0.3, 0.675, 1.0], 1.15)];
}

/** The 30 preset gradients from the theme's six accents, in five styles (our own design, as upstream). */
export const PRESET_STYLES = Object.freeze(['Soft', 'Lit from Top', 'Deep', 'Lit from Bottom', 'Center Glow']);
export function presets(theme) {
  const accent = i => theme?.[4 + i] ?? [68, 114, 196];
  const down = {type: 'linear', angle: 90, scaled: false};
  const out = [];
  for (let style = 0; style < 5; style++) {
    for (let i = 0; i < 6; i++) {
      const c = accent(i);
      const t = v => rgbModified(c, 'tint', v), sh = v => rgbModified(c, 'shade', v);
      out.push([
        gradient([[0, t(0.2)], [100, t(0.6)]], down),
        gradient([[0, t(0.4)], [50, c], [100, sh(0.75)]], down),
        gradient([[0, c], [100, sh(0.5)]], down),
        gradient([[0, sh(0.75)], [50, c], [100, t(0.4)]], down),
        gradient([[0, t(0.4)], [100, sh(0.75)]], {type: 'path', shape: 'circle', focus: [50, 50, 50, 50]}),
      ][style]);
    }
  }
  return out;
}

/**
 * The gradient Format Shape's Gradient fill starts from, from the theme's first accent whatever the shape's colour:
 * four stops, 0% at 95% lighter, 74% and 83% at 55% lighter, 100% at 70% lighter, top to bottom, scaled with the shape.
 */
export function defaultGradient(accent1) {
  const lighter = off => rgbModified(rgbModified(accent1, 'lumMod', 1 - off), 'lumOff', off);
  const stops = [[0, 0.95], [74, 0.55], [83, 0.55], [100, 0.7]].map(([pos, off]) => ({pos, color: lighter(off), transparency: 0}));
  return {type: 'gradient', stops, kind: {type: 'linear', angle: 90, scaled: true}, rotWithShape: true};
}

/** The gradient's colour and transparency at `pos` percent (stops::at). */
export function stopAt(stops, pos) {
  const after = stops.findIndex(s => s.pos >= pos);
  if (after <= 0) { const s = after < 0 ? stops[stops.length - 1] : stops[0]; return s ? [s.color, s.transparency ?? 0] : [[0, 0, 0], 0]; }
  const a = stops[after - 1], b = stops[after];
  const t = b.pos > a.pos ? (pos - a.pos) / (b.pos - a.pos) : 0;
  const mix = (x, y) => Math.max(0, Math.min(255, Math.round(x + (y - x) * t)));
  return [[mix(a.color[0], b.color[0]), mix(a.color[1], b.color[1]), mix(a.color[2], b.color[2])], (a.transparency ?? 0) + ((b.transparency ?? 0) - (a.transparency ?? 0)) * t];
}
/** Add a stop at `pos` in the gradient's colour there; its index, or null when full (stops::add). Edits the array. */
export function addStop(stops, pos) {
  if (stops.length >= MAX_STOPS) return null;
  const [color, transparency] = stopAt(stops, pos);
  let i = stops.findIndex(s => s.pos > pos);
  if (i < 0) i = stops.length;
  stops.splice(i, 0, {pos, color, transparency});
  return i;
}

export {storedFill, fillMainColor};
