// What a 3-D camera does to a flat shape on the slide: the 3-D Rotation presets (Parallel, Perspective, Oblique) and
// a shape's own rotation angles become one 2-D map of the shape (an orthographic projection of the plane turned by
// X, Y and Z), and an extrusion depth becomes the offset the shape's back drawn that far behind it.
// PowerPoint's behaviour, approximated and not checked against upstream: deckcraft keeps the camera and extrusion
// (core/prism/lib/three-d.mjs) but never draws them. The angles of the presets are chosen to look like
// PowerPoint's; the perspective presets are drawn with the same orthographic projection (no foreshortening
// towards the vanishing point). No DOM, no Node built-ins.

import {parse3d, isFlat3d} from './three-d.mjs';

/** The turn of each camera preset as [about X (tilt), about Y (swing), about Z (roll)] in degrees. */
export const CAMERA_ROTATION = Object.freeze({
  orthographicFront: [0, 0, 0],
  isometricTopUp: [-54.736, 45, 0], isometricTopDown: [54.736, -45, 0],
  isometricBottomUp: [54.736, 45, 0], isometricBottomDown: [-54.736, -45, 0],
  isometricLeftUp: [-35.264, 45, 0], isometricLeftDown: [35.264, 45, 0],
  isometricRightUp: [-35.264, -45, 0], isometricRightDown: [35.264, -45, 0],
  isometricOffAxis1Left: [-20.7, 60, 0], isometricOffAxis1Right: [-20.7, -60, 0], isometricOffAxis1Top: [-58, 20, 0],
  obliqueTopLeft: [0, 0, 0], obliqueTop: [0, 0, 0], obliqueTopRight: [0, 0, 0], obliqueLeft: [0, 0, 0], obliqueRight: [0, 0, 0],
  obliqueBottomLeft: [0, 0, 0], obliqueBottom: [0, 0, 0], obliqueBottomRight: [0, 0, 0],
  perspectiveFront: [0, 0, 0], perspectiveLeft: [0, 30, 0], perspectiveRight: [0, -30, 0], perspectiveAbove: [-30, 0, 0], perspectiveBelow: [30, 0, 0],
  perspectiveAboveLeftFacing: [-25, 30, 0], perspectiveAboveRightFacing: [-25, -30, 0],
  perspectiveContrastingLeftFacing: [-10, 40, 0], perspectiveContrastingRightFacing: [-10, -40, 0],
  perspectiveHeroicLeftFacing: [15, 35, 0], perspectiveHeroicRightFacing: [15, -35, 0],
  perspectiveHeroicExtremeLeftFacing: [20, 50, 0], perspectiveHeroicExtremeRightFacing: [20, -50, 0],
  perspectiveRelaxed: [-12, 0, 0], perspectiveRelaxedModerately: [-20, 0, 0],
});

/** Where the back of a shape with an oblique camera lies, as a unit direction on the slide (the sign of x and y: left/right, up/down). */
const OBLIQUE = Object.freeze({
  obliqueTopLeft: [-1, -1], obliqueTop: [0, -1], obliqueTopRight: [1, -1], obliqueLeft: [-1, 0], obliqueRight: [1, 0],
  obliqueBottomLeft: [-1, 1], obliqueBottom: [0, 1], obliqueBottomRight: [1, 1],
});

const rad = d => (d * Math.PI) / 180;

/** The angles a 3-D state is drawn with: its own when it has them, else its preset's. */
export function anglesOf(s3) {
  const base = CAMERA_ROTATION[s3.camera] ?? [0, 0, 0];
  if (!s3.rot) return base;
  // `rot` is [lon, lat, rev]: the swing, the tilt and the roll the file stores; a preset's own angles still apply under them.
  const wrap = v => (v > 180 ? v - 360 : v);
  return [base[0] + wrap(s3.rot[1]), base[1] + wrap(s3.rot[0]), base[2] + wrap(s3.rot[2])];
}

/**
 * The map the camera puts on the shape's plane and the offset of its back per point of depth:
 * `{a, b, c, d}` (the 2x2 matrix, x' = a x + c y, y' = b x + d y: SVG's matrix order) and `ex`, `ey`.
 * Null when the camera leaves the shape as it is and there is nothing to extrude.
 */
export function projection(s3) {
  if (!s3 || (isFlat3d(s3) && s3.depth === 0)) return null;
  const [ax, ay, az] = anglesOf(s3).map(rad);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  // R = Rz * Rx * Ry on points (x right, y down, z towards the viewer).
  const r00 = cz * cy - sz * sx * sy, r01 = -sz * cx, r02 = cz * sy + sz * sx * cy;
  const r10 = sz * cy + cz * sx * sy, r11 = cz * cx, r12 = sz * sy - cz * sx * cy;
  if (s3.depth === 0 && Math.abs(r00 - 1) + Math.abs(r01) + Math.abs(r10) + Math.abs(r11 - 1) < 1e-6) return null;
  const ob = OBLIQUE[s3.camera];
  const [ex, ey] = ob ? [ob[0] * 0.7071, ob[1] * 0.7071] : [-r02, -r12];
  return {a: r00, b: r10, c: r01, d: r11, ex, ey};
}

/** The SVG matrix (a b c d e f) of the camera about the point (cx, cy) of the shape's own space. */
export function aboutCenter(p, cx, cy) {
  return [p.a, p.b, p.c, p.d, cx - p.a * cx - p.c * cy, cy - p.b * cx - p.d * cy];
}

/** The camera of kept 3-D XML (`a:scene3d`, `a:sp3d`), or null when it draws nothing. */
export function cameraOf(raw3d) {
  if (typeof raw3d !== 'string' || !raw3d) return null;
  const s3 = parse3d(raw3d);
  const p = projection(s3);
  return p ? {...p, depth: s3.depth, s3} : null;
}

/** The camera presets of the 3-D Rotation menu, in PowerPoint's groups, with their labels. */
export const CAMERA_MENU = Object.freeze([
  {group: 'Parallel', items: [['isometricLeftDown', 'Isometric Left Down'], ['isometricRightUp', 'Isometric Right Up'], ['isometricTopUp', 'Isometric Top Up'],
    ['isometricOffAxis1Left', 'Off Axis 1 Left'], ['isometricOffAxis1Right', 'Off Axis 1 Right'], ['isometricOffAxis1Top', 'Off Axis 1 Top']]},
  {group: 'Perspective', items: [['perspectiveAboveLeftFacing', 'Perspective Above Left Facing'], ['perspectiveAboveRightFacing', 'Perspective Above Right Facing'],
    ['perspectiveContrastingLeftFacing', 'Perspective Contrasting Left Facing'], ['perspectiveContrastingRightFacing', 'Perspective Contrasting Right Facing'],
    ['perspectiveHeroicLeftFacing', 'Perspective Heroic Left Facing'], ['perspectiveHeroicRightFacing', 'Perspective Heroic Right Facing'],
    ['perspectiveHeroicExtremeLeftFacing', 'Perspective Heroic Extreme Left Facing'], ['perspectiveHeroicExtremeRightFacing', 'Perspective Heroic Extreme Right Facing'],
    ['perspectiveRelaxed', 'Perspective Relaxed'], ['perspectiveRelaxedModerately', 'Perspective Relaxed Moderately']]},
  {group: 'Oblique', items: [['obliqueTopLeft', 'Oblique Top Left'], ['obliqueTopRight', 'Oblique Top Right'], ['obliqueBottomLeft', 'Oblique Bottom Left'], ['obliqueBottomRight', 'Oblique Bottom Right']]},
]);

/** The 12 effect presets of Shape Effects › Preset: the `shape.effects` arguments each applies after clearing the effects. */
export const EFFECT_PRESETS = Object.freeze([
  {shadow: 'outer', bevel: 'circle'},
  {shadow: 'bottom', bevel: 'relaxedInset'},
  {shadow: 'center', bevel: 'cross'},
  {reflection: 'tight', bevel: 'coolSlant'},
  {reflection: 'half', bevel: 'angle'},
  {glow: 8, bevel: 'softRound'},
  {shadow: 'perspective', bevel: 'convex'},
  {shadow: 'outer', bevel: 'slope', threeD: {camera: 'isometricLeftDown', depth: 12}},
  {shadow: 'outer', bevel: 'divot', threeD: {camera: 'isometricRightUp', depth: 20}},
  {shadow: 'bottom', bevel: 'riblet', threeD: {camera: 'perspectiveRelaxed', depth: 14}},
  {shadow: 'outer', bevel: 'hardEdge', threeD: {camera: 'obliqueTopRight', depth: 25}},
  {reflection: 'tight', bevel: 'artDeco', threeD: {camera: 'perspectiveHeroicLeftFacing', depth: 15}},
]);
