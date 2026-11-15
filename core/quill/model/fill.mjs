// Shape fills: what paints a shape's, text box's or canvas's interior, and an outline's gradient
// (DrawingML a:solidFill / a:gradFill, ECMA-376 §20.1.8.54 and §20.1.8.33; VML v:fill).
// Translated from wordcraft crates/doc/src/fill.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A fill is stored as upstream serializes it: an opaque solid fill is `[r, g, b]`; otherwise
// `{type: 'solid', color, transparency}` or `{type: 'gradient', stops, kind, tile?, rotWithShape,
// flip?}` with kind `{type: 'linear', angle, scaled}` | `{type: 'path', shape: 'circle'|'rect'|
// 'shape', focus: [l, t, r, b]}`. Transparencies percent; rectangles percent insets.
// No DOM, no Node built-ins.

import {clampOr} from './effects.mjs';
import {sanitizedStops} from './wordart.mjs';

export const PATH_SHAPES = Object.freeze(['circle', 'rect', 'shape']);
export const GRADIENT_FLIPS = Object.freeze(['none', 'x', 'y', 'xy']);
const MAX_INSET = 1000;
const insetRect = r => r.map(v => clampOr(v, -MAX_INSET, MAX_INSET, 0));

/** An opaque solid fill ([r, g, b]). */
export const solidFill = color => [...color];

/** Read any stored form as {type:'solid', color, transparency} or {type:'gradient', ...}. */
export function fillForm(f) {
  if (Array.isArray(f)) return {type: 'solid', color: f, transparency: 0};
  if (f?.type === 'solid') return {type: 'solid', color: f.color, transparency: f.transparency ?? 0};
  if (f?.type === 'gradient') return f;
  if (f?.type === 'picture') return f;
  return null;
}
/** The stored form of a fill: an opaque solid one as `[r, g, b]` (fill.rs Serialize). */
export function storedFill(f) {
  const x = fillForm(f);
  if (!x) return null;
  if (x.type === 'solid') return x.transparency === 0 ? [...x.color] : {type: 'solid', color: x.color, transparency: x.transparency};
  return x;
}

/** The one colour standing for the fill: the solid colour, or a gradient's middle stop. */
export function fillMainColor(f) {
  const x = fillForm(f);
  if (!x) return [0, 0, 0];
  if (x.type === 'solid') return x.color;
  if (x.type === 'picture') return Array.isArray(x.avg) && x.avg.length === 3 ? x.avg : [128, 128, 128];
  return x.stops?.[Math.floor(x.stops.length / 2)]?.color ?? [0, 0, 0];
}

/** Finite, in range; a one-stop gradient is that stop's solid colour; with no stops, null (no fill). */
export function sanitizedFill(f) {
  const x = fillForm(f);
  if (!x) return null;
  if (x.type === 'solid') return storedFill({type: 'solid', color: x.color, transparency: clampOr(x.transparency, 0, 100, 0)});
  // A picture or texture fill (Shape Fill › Picture, Texture): a media key, stretched or tiled at `scale` percent.
  if (x.type === 'picture') {
    if (typeof x.media !== 'string' || !x.media) return null;
    const out = {type: 'picture', media: x.media, tile: !!x.tile, scale: clampOr(x.scale ?? 100, 1, 1000, 100), transparency: clampOr(x.transparency ?? 0, 0, 100, 0)};
    if (Array.isArray(x.avg) && x.avg.length === 3) out.avg = x.avg.map(v => clampOr(v, 0, 255, 128));
    if (typeof x.texture === 'string') out.texture = x.texture.slice(0, 40);
    return out;
  }
  const stops = sanitizedStops(x.stops);
  if (!stops.length) return null;
  if (stops.length === 1) return storedFill({type: 'solid', color: stops[0].color, transparency: stops[0].transparency});
  let kind;
  if (x.kind?.type === 'path') kind = {type: 'path', shape: PATH_SHAPES.includes(x.kind.shape) ? x.kind.shape : 'circle', focus: insetRect(x.kind.focus ?? [0, 0, 0, 0])};
  else {
    const a = clampOr(x.kind?.angle ?? 0, -1e6, 1e6, 0);
    kind = {type: 'linear', angle: (((a % 360) + 360) % 360) % 360, scaled: !!x.kind?.scaled};
  }
  const out = {type: 'gradient', stops, kind, rotWithShape: !!x.rotWithShape};
  if (x.tile) out.tile = insetRect(x.tile);
  if (x.flip && x.flip !== 'none' && GRADIENT_FLIPS.includes(x.flip)) out.flip = x.flip;
  return out;
}
