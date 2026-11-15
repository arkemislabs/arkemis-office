// DrawingML outline dashes, measured in multiples of the stroke width.
// Translated from wordcraft crates/doc/src/line_dash.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A dash is stored as upstream serializes it: a preset name ('solid', 'dot', 'dash', 'longDash',
// 'dashDot', 'longDashDot', 'longDashDotDot', 'systemDash', 'systemDot', 'systemDashDot',
// 'systemDashDotDot') or `{custom: [[dash, space], ...]}` in 100000ths of the line width.
// No DOM, no Node built-ins.

export const DASH_PERCENT = 100_000;
export const MAX_DASH_STOPS = 64;
const MIN_DASH_POINTS = 0.01;
const MAX_DASH_POINTS = 20_000;

const OOXML = {dot: 'dot', dash: 'dash', lgDash: 'longDash', dashDot: 'dashDot', lgDashDot: 'longDashDot', lgDashDotDot: 'longDashDotDot',
  sysDash: 'systemDash', sysDot: 'systemDot', sysDashDot: 'systemDashDot', sysDashDotDot: 'systemDashDotDot'};
const TO_OOXML = Object.fromEntries([['solid', 'solid'], ...Object.entries(OOXML).map(([k, v]) => [v, k])]);
const PRESETS = {dot: [1, 3], dash: [4, 3], longDash: [8, 3], dashDot: [4, 3, 1, 3], longDashDot: [8, 3, 1, 3], longDashDotDot: [8, 3, 1, 3, 1, 3],
  systemDash: [3, 1], systemDot: [1, 1], systemDashDot: [3, 1, 1, 1], systemDashDotDot: [3, 1, 1, 1, 1, 1]};

export const LINE_DASHES = Object.freeze(['solid', ...Object.keys(PRESETS)]);

/** From an a:prstDash value (unknown values are solid). */
export const lineDashFromOoxml = v => OOXML[v] ?? 'solid';
/** The a:prstDash value, or null for a custom dash. */
export const lineDashOoxml = d => (typeof d === 'string' ? TO_OOXML[d] ?? 'solid' : null);
export const lineDashIsSolid = d => d === undefined || d === null || d === 'solid';

const dashPoints = (ratio, width) => {
  const w = Number.isFinite(width) ? Math.min(200, Math.max(0.25, width)) : 0.75;
  return Math.min(MAX_DASH_POINTS, Math.max(MIN_DASH_POINTS, ratio * w));
};

/** Page-point dash/gap lengths for painters (empty for solid). Hostile custom lists are bounded. */
export function dashPattern(d, width) {
  if (d && typeof d === 'object' && Array.isArray(d.custom)) {
    return d.custom.slice(0, MAX_DASH_STOPS).flatMap(([a, b]) => [a, b]).map(v => dashPoints((Number(v) || 0) / DASH_PERCENT, width));
  }
  const p = PRESETS[d];
  return p ? p.map(v => dashPoints(v, width)) : [];
}
