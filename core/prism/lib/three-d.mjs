// A shape's 3-D settings (Format Shape › Effects › 3-D Format and 3-D Rotation, the ribbon's Bevel
// gallery): kept as the shape's `a:scene3d` / `a:sp3d` XML on its effects (`raw3d`), read into
// fields, changed, and written back.
// Translated from deckcraft crates/engine/src/cmd/three_d.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

/** Camera presets PowerPoint offers (3-D Rotation › Presets). */
export const CAMERAS = Object.freeze(['orthographicFront', 'isometricTopUp', 'isometricTopDown', 'isometricBottomUp', 'isometricBottomDown', 'isometricLeftUp',
  'isometricLeftDown', 'isometricRightUp', 'isometricRightDown', 'isometricOffAxis1Left', 'isometricOffAxis1Right', 'isometricOffAxis1Top', 'obliqueTopLeft', 'obliqueTopRight', 'obliqueBottomLeft', 'obliqueBottomRight', 'perspectiveFront',
  'perspectiveLeft', 'perspectiveRight', 'perspectiveAbove', 'perspectiveBelow', 'perspectiveAboveLeftFacing', 'perspectiveAboveRightFacing',
  'perspectiveContrastingLeftFacing', 'perspectiveContrastingRightFacing', 'perspectiveHeroicLeftFacing', 'perspectiveHeroicRightFacing',
  'perspectiveHeroicExtremeLeftFacing', 'perspectiveHeroicExtremeRightFacing', 'perspectiveRelaxed', 'perspectiveRelaxedModerately']);

/** Bevel presets (`ST_BevelPresetType`), in PowerPoint's gallery order. */
export const BEVELS = Object.freeze(['circle', 'relaxedInset', 'cross', 'coolSlant', 'angle', 'softRound', 'convex', 'slope', 'divot', 'riblet', 'hardEdge', 'artDeco']);
export const BEVEL_LABELS = Object.freeze({circle: 'Circle', relaxedInset: 'Relaxed Inset', cross: 'Cross', coolSlant: 'Cool Slant', angle: 'Angle', softRound: 'Soft Round',
  convex: 'Convex', slope: 'Slope', divot: 'Divot', riblet: 'Riblet', hardEdge: 'Hard Edge', artDeco: 'Art Deco'});

/** Materials (`ST_PresetMaterialType`). */
export const MATERIALS = Object.freeze(['warmMatte', 'matte', 'plastic', 'metal', 'dkEdge', 'softEdge', 'flat', 'legacyWireframe', 'powder', 'translucentPowder', 'clear', 'softmetal']);

/** Light rigs (`ST_LightRigType`) PowerPoint offers. */
export const LIGHTS = Object.freeze(['threePt', 'balanced', 'soft', 'harsh', 'flood', 'contrasting', 'morning', 'sunrise', 'sunset', 'chilly', 'freezing', 'flat', 'twoPt', 'glow', 'brightRoom']);

const ALL_CAMERAS = Object.freeze(['legacyObliqueTopLeft', 'legacyObliqueTop', 'legacyObliqueTopRight', 'legacyObliqueLeft', 'legacyObliqueFront', 'legacyObliqueRight',
  'legacyObliqueBottomLeft', 'legacyObliqueBottom', 'legacyObliqueBottomRight', 'legacyPerspectiveTopLeft', 'legacyPerspectiveTop', 'legacyPerspectiveTopRight',
  'legacyPerspectiveLeft', 'legacyPerspectiveFront', 'legacyPerspectiveRight', 'legacyPerspectiveBottomLeft', 'legacyPerspectiveBottom', 'legacyPerspectiveBottomRight',
  'orthographicFront', 'isometricTopUp', 'isometricTopDown', 'isometricBottomUp', 'isometricBottomDown', 'isometricLeftUp', 'isometricLeftDown', 'isometricRightUp',
  'isometricRightDown', 'isometricOffAxis1Left', 'isometricOffAxis1Right', 'isometricOffAxis1Top', 'isometricOffAxis2Left', 'isometricOffAxis2Right',
  'isometricOffAxis2Top', 'isometricOffAxis3Left', 'isometricOffAxis3Right', 'isometricOffAxis3Bottom', 'isometricOffAxis4Left', 'isometricOffAxis4Right',
  'isometricOffAxis4Bottom', 'obliqueTopLeft', 'obliqueTop', 'obliqueTopRight', 'obliqueLeft', 'obliqueRight', 'obliqueBottomLeft', 'obliqueBottom', 'obliqueBottomRight',
  'perspectiveFront', 'perspectiveLeft', 'perspectiveRight', 'perspectiveAbove', 'perspectiveBelow', 'perspectiveAboveLeftFacing', 'perspectiveAboveRightFacing',
  'perspectiveContrastingLeftFacing', 'perspectiveContrastingRightFacing', 'perspectiveHeroicLeftFacing', 'perspectiveHeroicRightFacing',
  'perspectiveHeroicExtremeLeftFacing', 'perspectiveHeroicExtremeRightFacing', 'perspectiveRelaxed', 'perspectiveRelaxedModerately']);
const ALL_LIGHTS = Object.freeze(['legacyFlat1', 'legacyFlat2', 'legacyFlat3', 'legacyFlat4', 'legacyNormal1', 'legacyNormal2', 'legacyNormal3', 'legacyNormal4',
  'legacyHarsh1', 'legacyHarsh2', 'legacyHarsh3', 'legacyHarsh4', ...LIGHTS]);
const LIGHT_DIRS = Object.freeze(['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br']);
const ALL_MATERIALS = Object.freeze(['legacyMatte', 'legacyPlastic', 'legacyMetal', 'legacyWireframe', 'matte', 'plastic', 'metal', 'warmMatte', 'translucentPowder',
  'powder', 'dkEdge', 'softEdge', 'clear', 'flat', 'softmetal']);

const EMU = 12700, ANGLE = 60000, MAX_PT = 1584;

/** `value` when it is one of `list`, else `fallback`: values from a file are written back into XML, so nothing outside these lists may pass. */
const known = (value, list, fallback) => (typeof value === 'string' && list.includes(value) ? value : fallback);
const attrs = tag => {
  const out = {};
  for (const m of String(tag).matchAll(/([A-Za-z:]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const finite = v => { const n = Number(v); return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export const flat3d = () => ({camera: 'orthographicFront', rot: null, light: 'threePt', lightDir: 't', top: null, bottom: null, depth: 0, contour: 0, z: 0, material: 'warmMatte', colors: ''});

const COLOR_RE = /^<a:(extrusionClr|contourClr)>(?:<a:srgbClr val="[0-9A-Fa-f]{6}"\/>|<a:schemeClr val="[A-Za-z0-9]{1,16}"\/>)<\/a:\1>$/;

/** Reads kept 3-D XML (`a:scene3d` and `a:sp3d`); unknown or invalid parts take their defaults. */
export function parse3d(raw) {
  const s = flat3d();
  if (typeof raw !== 'string' || !raw) return s;
  const text = raw.replace(/\s+/g, ' ');
  const cam = /<a:camera\b([^>]*?)(\/>|>(.*?)<\/a:camera>)/.exec(text);
  if (cam) {
    s.camera = known(attrs(cam[1]).prst, ALL_CAMERAS, 'orthographicFront');
    const rot = cam[3] ? /<a:rot\b([^>]*?)\/?>/.exec(cam[3]) : null;
    if (rot) {
      const a = attrs(rot[1]), d = k => (finite(a[k]) ?? 0) / ANGLE;
      s.rot = [d('lon'), d('lat'), d('rev')];
    }
  }
  const rig = /<a:lightRig\b([^>]*?)\/?>/.exec(text);
  if (rig) {
    const a = attrs(rig[1]);
    s.light = known(a.rig, ALL_LIGHTS, 'threePt');
    s.lightDir = known(a.dir, LIGHT_DIRS, 't');
  }
  const sp = /<a:sp3d\b([^>]*?)(\/>|>(.*?)<\/a:sp3d>)/.exec(text);
  if (sp) {
    const a = attrs(sp[1]), pt = (k, lo) => clamp((finite(a[k]) ?? 0) / EMU, lo, MAX_PT);
    s.depth = pt('extrusionH', 0);
    s.contour = pt('contourW', 0);
    s.z = pt('z', -MAX_PT);
    s.material = known(a.prstMaterial, ALL_MATERIALS, 'warmMatte');
    const inner = sp[3] ?? '';
    for (const [tag, key] of [['bevelT', 'top'], ['bevelB', 'bottom']]) {
      const b = new RegExp(`<a:${tag}\\b([^>]*?)\\/?>`).exec(inner);
      if (b) {
        const ba = attrs(b[1]), len = k => clamp((finite(ba[k]) ?? 76200) / EMU, 0, MAX_PT);
        s[key] = {preset: known(ba.prst, BEVELS, 'circle'), w: len('w'), h: len('h')};
      }
    }
    s.colors = [...inner.matchAll(/<a:(?:extrusionClr|contourClr)>.*?<\/a:(?:extrusionClr|contourClr)>/g)].map(m => m[0]).filter(x => COLOR_RE.test(x)).join('');
  }
  return s;
}

/** Whether this is a flat shape with no 3-D at all. */
export const isFlat3d = s => s.camera === 'orthographicFront' && (!s.rot || s.rot.every(v => v === 0)) && !s.top && !s.bottom && s.depth === 0 && s.contour === 0 && s.z === 0;

/** The `a:scene3d` and `a:sp3d` XML, or null for a flat shape. */
export function to3dXml(s) {
  if (isFlat3d(s)) return null;
  const e = pt => Math.round(pt * EMU);
  let x = `<a:scene3d><a:camera prst="${s.camera}"`;
  if (s.rot) {
    const a = d => Math.round((((d % 360) + 360) % 360) * ANGLE) % 21_600_000;
    x += `><a:rot lat="${a(s.rot[1])}" lon="${a(s.rot[0])}" rev="${a(s.rot[2])}"/></a:camera>`;
  } else x += '/>';
  x += `<a:lightRig rig="${s.light}" dir="${s.lightDir}"/></a:scene3d><a:sp3d`;
  if (s.z !== 0) x += ` z="${e(s.z)}"`;
  if (s.depth > 0) x += ` extrusionH="${e(s.depth)}"`;
  if (s.contour > 0) x += ` contourW="${e(s.contour)}"`;
  if (s.material !== 'warmMatte') x += ` prstMaterial="${s.material}"`;
  x += '>';
  for (const [tag, b] of [['bevelT', s.top], ['bevelB', s.bottom]]) if (b) x += `<a:${tag} w="${e(b.w)}" h="${e(b.h)}" prst="${b.preset}"/>`;
  return `${x}${s.colors}</a:sp3d>`;
}

/**
 * Applies `{camera?, rotX?, rotY?, rotZ?, z?, bevelTop?, bevelTopW?, bevelTopH?, bevelBottom?, bevelBottomW?, bevelBottomH?, depth?,
 * contour?, material?, lighting?}` (in place).
 */
export function apply3d(s, p) {
  const f = k => { const v = p?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  const pick = (k, list) => (typeof p?.[k] === 'string' && list.includes(p[k]) ? p[k] : null);
  const cam = pick('camera', CAMERAS);
  if (cam) { s.camera = cam; s.rot = null; } // a preset sets its own angles
  const [rx, ry, rz] = [f('rotX'), f('rotY'), f('rotZ')];
  if (rx !== null || ry !== null || rz !== null) {
    const [ox, oy, oz] = s.rot ?? [0, 0, 0];
    const d = (v, o) => (v === null ? o : ((v % 360) + 360) % 360);
    s.rot = [d(rx, ox), d(ry, oy), d(rz, oz)];
  }
  if (f('z') !== null) s.z = clamp(f('z'), -MAX_PT, MAX_PT);
  for (const [key, slot] of [['bevelTop', 'top'], ['bevelBottom', 'bottom']]) {
    const v = p?.[key];
    if (v === 'none') s[slot] = null;
    else if (typeof v === 'string' && BEVELS.includes(v)) s[slot] = {w: 6, h: 6, ...(s[slot] ?? {}), preset: v};
    if (s[slot]) {
      if (f(`${key}W`) !== null) s[slot].w = clamp(f(`${key}W`), 0, MAX_PT);
      if (f(`${key}H`) !== null) s[slot].h = clamp(f(`${key}H`), 0, MAX_PT);
    }
  }
  if (f('depth') !== null) s.depth = clamp(f('depth'), 0, MAX_PT);
  if (f('contour') !== null) s.contour = clamp(f('contour'), 0, MAX_PT);
  const mat = pick('material', MATERIALS);
  if (mat) s.material = mat;
  const light = pick('lighting', LIGHTS);
  if (light) s.light = light;
  return s;
}

/** Sets a shape's 3-D settings on its effects, keeping `bevel` (the top bevel's preset) in step. */
export function store3d(e, s) {
  e.raw3d = to3dXml(s);
  e.bevel = e.raw3d ? s.top?.preset ?? null : null;
}

/** The bevel preset a shape's effects carry (`none` for none). */
export const bevelOf = fx => parse3d(fx?.raw3d).top?.preset ?? fx?.bevel ?? 'none';
