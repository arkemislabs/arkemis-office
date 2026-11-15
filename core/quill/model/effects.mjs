// Shape effects (DrawingML a:effectLst, ECMA-376 Part 1 §20.1.8): outer shadow, glow, soft edges,
// and the bands renderers overlay to approximate a blur.
// Translated from wordcraft crates/doc/src/effects.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `ShapeEffects` is `{shadow?, glow?, softEdge?}`; a Shadow is `{color, transparency, blur,
// distance, angle, rotWithShape}`, a Glow `{color, size, transparency}`. Lengths points, angles
// degrees, transparencies percent (0 = opaque); colours `[r, g, b]`. No DOM, no Node built-ins.

export const MAX_BLUR = 100;
export const MAX_DISTANCE = 200;
export const MAX_GLOW = 150;
export const MAX_SOFT_EDGE = 100;

/** clamp(v, lo, hi), or `dflt` when v is not finite (effects.rs / wordart.rs `clamp`). */
export const clampOr = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const remEuclid = (v, m) => ((v % m) + m) % m;

/** "Offset: Bottom Right". */
export const defaultShadow = () => ({color: [0, 0, 0], transparency: 60, blur: 4, distance: 3, angle: 45, rotWithShape: false});
export const defaultGlow = () => ({color: [0x15, 0x60, 0x82], size: 5, transparency: 60});

export const SHADOW_PRESETS = Object.freeze([
  ['offsetBottomRight', 'Offset: Bottom Right'], ['offsetBottom', 'Offset: Bottom'], ['offsetBottomLeft', 'Offset: Bottom Left'],
  ['offsetRight', 'Offset: Right'], ['offsetCenter', 'Offset: Center'], ['offsetLeft', 'Offset: Left'],
  ['offsetTopRight', 'Offset: Top Right'], ['offsetTop', 'Offset: Top'], ['offsetTopLeft', 'Offset: Top Left'],
].map(Object.freeze));

const PRESET_ANGLES = {offsetBottomRight: 45, offsetBottom: 90, offsetBottomLeft: 135, offsetLeft: 180, offsetTopLeft: 225, offsetTop: 270,
  offsetTopRight: 315, offsetRight: 0};

/** A shadow preset by id, or null. */
export function shadowPreset(id) {
  const d = defaultShadow();
  if (id === 'offsetCenter') return {...d, distance: 0, blur: 5};
  return Object.hasOwn(PRESET_ANGLES, id) ? {...d, angle: PRESET_ANGLES[id]} : null;
}

/** A shadow with every number finite and in range. */
export function sanitizedShadow(s) {
  const d = {...defaultShadow(), ...(s || {})};
  const angle = remEuclid(clampOr(d.angle, -1e6, 1e6, 45), 360);
  return {color: d.color, transparency: clampOr(d.transparency, 0, 100, 60), blur: clampOr(d.blur, 0, MAX_BLUR, 0),
    distance: clampOr(d.distance, 0, MAX_DISTANCE, 0), angle: Number.isFinite(angle) && angle < 360 ? angle : 0, rotWithShape: !!d.rotWithShape};
}
/** The shadow's offset from the shape [dx, dy], points (x right, y down). */
export function shadowOffset(s) {
  const z = sanitizedShadow(s);
  const a = z.angle * Math.PI / 180;
  return [z.distance * Math.cos(a), z.distance * Math.sin(a)];
}
export const shadowOpacity = s => 1 - sanitizedShadow(s).transparency / 100;

export function sanitizedGlow(g) {
  const d = {...defaultGlow(), ...(g || {})};
  return {color: d.color, size: clampOr(d.size, 0, MAX_GLOW, 0), transparency: clampOr(d.transparency, 0, 100, 60)};
}
export const glowOpacity = g => 1 - sanitizedGlow(g).transparency / 100;

// Reflection and bevel (a:reflection, a:sp3d bevelT) follow deckcraft's effects (crates/doc effects: Reflection {blur, startAlpha,
// endAlpha, endPos, dist}, Bevel presets), which Word shares; wordcraft's ShapeEffects has the three above only.
/** A reflection: a mirrored copy under the shape that fades out (alphas 0–1, endPos the fraction of the height reached, dist points). */
export const defaultReflection = () => ({blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.35, dist: 0});
/** The reflection presets Format Shape offers: Tight, Half and Full (touching), by id. */
export const REFLECTION_PRESETS = Object.freeze([['tight', 'Tight Reflection', {endPos: 0.35, dist: 0}], ['half', 'Half Reflection', {endPos: 0.55, dist: 4}], ['full', 'Full Reflection', {endPos: 0.9, dist: 4}]].map(Object.freeze));
export const reflectionPreset = id => { const hit = REFLECTION_PRESETS.find(r => r[0] === id); return hit ? {...defaultReflection(), ...hit[2]} : null; };
/** The bevel shapes (a:bevelT prst) with their menu names. */
export const BEVELS = Object.freeze([['relaxedInset', 'Relaxed Inset'], ['circle', 'Circle'], ['slope', 'Slope'], ['cross', 'Cross'], ['angle', 'Angle'], ['softRound', 'Soft Round'],
  ['convex', 'Convex'], ['coolSlant', 'Cool Slant'], ['divot', 'Divot'], ['riblet', 'Riblet'], ['hardEdge', 'Hard Edge'], ['artDeco', 'Art Deco']].map(Object.freeze));
export const bevelPreset = id => (BEVELS.some(b => b[0] === id) ? {preset: id, w: 6, h: 6} : null);
export function sanitizedReflection(r) {
  const d = {...defaultReflection(), ...(r || {})};
  return {blur: clampOr(d.blur, 0, MAX_BLUR, 0.5), startAlpha: clampOr(d.startAlpha, 0, 1, 0.5), endAlpha: clampOr(d.endAlpha, 0, 1, 0), endPos: clampOr(d.endPos, 0, 1, 0.35), dist: clampOr(d.dist, 0, MAX_DISTANCE, 0)};
}
export function sanitizedBevel(b) {
  const id = typeof b === 'string' ? b : b?.preset;
  if (!BEVELS.some(x => x[0] === id)) return null;
  return {preset: id, w: clampOr(b?.w, 0, 100, 6), h: clampOr(b?.h, 0, 100, 6)};
}

export const shapeEffectsIsEmpty = e => !e || (e.shadow == null && e.glow == null && e.softEdge == null && e.reflection == null && e.bevel == null);

/** Finite, in range; zero-size glows and soft edges dropped. */
export function sanitizedEffects(e) {
  const out = {};
  if (e?.shadow) out.shadow = sanitizedShadow(e.shadow);
  if (e?.glow) { const g = sanitizedGlow(e.glow); if (g.size > 0) out.glow = g; }
  if (e?.softEdge !== undefined && e?.softEdge !== null) { const r = clampOr(e.softEdge, 0, MAX_SOFT_EDGE, 0); if (r > 0) out.softEdge = r; }
  if (e?.reflection) out.reflection = sanitizedReflection(e.reflection);
  if (e?.bevel) { const b = sanitizedBevel(e.bevel); if (b) out.bevel = b; }
  return out;
}

/** How far the effects reach beyond the frame [left, top, right, bottom], points (wp:effectExtent). */
export function effectsExtent(e, size = null) {
  const z = sanitizedEffects(e);
  let out = [0, 0, 0, 0];
  if (z.glow) out = [z.glow.size, z.glow.size, z.glow.size, z.glow.size];
  if (z.shadow) {
    const [dx, dy] = shadowOffset(z.shadow);
    const r = z.shadow.blur / 2;
    const reach = [r - dx, r - dy, r + dx, r + dy];
    out = out.map((o, i) => Math.max(o, Math.max(reach[i], 0)));
  }
  // A reflection reaches below the shape by its gap and the part of the height it shows.
  if (z.reflection && size) out[3] = Math.max(out[3], z.reflection.dist + z.reflection.endPos * size[1]);
  return out.map(v => Math.round(v * 100) / 100);
}

/**
 * Bands approximating a blurred edge: [grow, alpha] pairs, each a copy of the silhouette grown by
 * `grow` points and filled at `alpha`; overlaid they ramp from `opacity` at `from` to nothing at `to`.
 */
export function bands(from, to, opacity) {
  from = clampOr(from, -1000, 1000, 0); to = clampOr(to, -1000, 1000, 0);
  opacity = clampOr(opacity, 0, 1, 0);
  if (opacity <= 0) return [];
  const span = Math.max(to - from, 0);
  if (span < 0.25) return [[(from + to) / 2, opacity]];
  const n = Math.min(12, Math.max(3, Math.ceil(span / 1.5)));
  const out = [];
  for (let m = 1; m <= n; m++) {
    const grow = to - span * (m - 0.5) / n;
    const before = 1 - opacity * (m - 1) / n;
    const after = 1 - opacity * m / n;
    const alpha = before > 0 ? 1 - after / before : 1;
    out.push([grow, Math.min(1, Math.max(0, alpha))]);
  }
  return out;
}
