// Geometry shared by the folio model: rectangles, quadrilaterals and the page view transform.
//
// Translated from printcraft crates/annot/src/create.rs (normalize, bounds, grow, finite),
// crates/annot/src/types.rs (rect_quad), crates/model/src/lib.rs (view_matrix_for) and
// crates/render/src/inspect/model.rs (view_to_user, view_rect_to_quad) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Spaces: *user space* is the PDF page's own coordinates (points, y up), where annotation
// dictionaries live. *View space* is the page as displayed: points from the top-left corner of
// the crop box after the page's rotation, y down (docs/architecture.md 14.5).
// No DOM, no Node built-ins.

/** create.rs `finite`: every value finite and within ±1e7. */
export const finite = v => v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e7);

/** create.rs `normalize`: corners in either order → [x0 y0 x1 y1] with x0 ≤ x1, y0 ≤ y1. */
export const normalize = r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

/** create.rs `bounds`: the bounding box of points, or null for none. */
export function bounds(points) {
  let out = null;
  for (const [x, y] of points) out = out ? [Math.min(out[0], x), Math.min(out[1], y), Math.max(out[2], x), Math.max(out[3], y)] : [x, y, x, y];
  return out;
}

/** create.rs `grow`. */
export const grow = (r, by) => [r[0] - by, r[1] - by, r[2] + by, r[3] + by];

/** types.rs `rect_quad`: a rectangle as a quad in Acrobat's order (top-left, top-right, bottom-left, bottom-right). */
export function rectQuad(r) {
  const [x0, y0, x1, y1] = normalize(r);
  return [x0, y1, x1, y1, x0, y0, x1, y0];
}

/** The four corners of a quad `[x1 y1 … x4 y4]`. */
export const quadPoints = q => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];

/** A flat number list split into quads of eight. */
export function quadsOf(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i + 8 <= list.length; i += 8) out.push(list.slice(i, i + 8));
  return out;
}

/** model `view_matrix_for`: display axes → user space for a page turned `rotation` with crop box `crop`. */
export function viewMatrixFor(rotation, crop) {
  const [x0, y0, x1, y1] = crop;
  switch (rotation) {
    case 90: return [0, 1, -1, 0, x1, y0];
    case 180: return [-1, 0, 0, -1, x1, y1];
    case 270: return [0, -1, 1, 0, x0, y1];
    default: return [1, 0, 0, 1, x0, y0];
  }
}

/** The page's displayed rotation: its own /Rotate plus the rotation the person added. */
export const pageRotation = page => ((((page?.sourceRotation ?? 0) + (page?.rotation ?? 0)) % 360) + 360) % 360;

/** The crop box in user space ([0 0 w h] when the content does not record one). */
export const cropBox = page => (Array.isArray(page?.box) && page.box.length === 4 ? page.box : [0, 0, page?.width ?? 0, page?.height ?? 0]);

/** Displayed size of a page in points (width and height swap at 90 and 270 degrees). */
export function viewSize(page) {
  const [x0, y0, x1, y1] = cropBox(page);
  const w = x1 - x0, h = y1 - y0;
  return pageRotation(page) % 180 ? {width: h, height: w} : {width: w, height: h};
}

/** User space → view space (points, y down, top-left of the displayed page). */
export function userToView(page, x, y) {
  const [x0, y0, x1, y1] = cropBox(page);
  switch (pageRotation(page)) {
    case 90: return [y - y0, x - x0];
    case 180: return [x1 - x, y - y0];
    case 270: return [y1 - y, x1 - x];
    default: return [x - x0, y1 - y];
  }
}

/** inspect/model.rs `view_to_user`: view space → user space. */
export function viewToUser(page, vx, vy) {
  const [x0, y0, x1, y1] = cropBox(page);
  switch (pageRotation(page)) {
    case 90: return [x0 + vy, y0 + vx];
    case 180: return [x1 - vx, y0 + vy];
    case 270: return [x1 - vy, y1 - vx];
    default: return [x0 + vx, y1 - vy];
  }
}

/** inspect/model.rs `view_rect_to_user`. */
export function viewRectToUser(page, r) {
  const a = viewToUser(page, r[0], r[1]), b = viewToUser(page, r[2], r[3]);
  return normalize([a[0], a[1], b[0], b[1]]);
}

/** View rectangle [x0 y0 x1 y1] → user-space rectangle, and back. */
export function userRectToView(page, r) {
  const a = userToView(page, r[0], r[1]), b = userToView(page, r[2], r[3]);
  return normalize([a[0], a[1], b[0], b[1]]);
}

/** inspect/model.rs `view_rect_to_quad`: top-left, top-right, bottom-left, bottom-right as read on screen. */
export function viewRectToQuad(page, r) {
  const q = [];
  for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]) q.push(...viewToUser(page, x, y));
  return q;
}

/** A user-space quad's corners in view space. */
export const quadToView = (page, q) => quadPoints(q).map(([x, y]) => userToView(page, x, y));

/** Multiply affine matrices [a b c d e f]: `m1` then `m2` (PDF order: point · m1 · m2). */
export function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** render/text.rs `quad_contains`: a point in or on a convex quad (corners in drawing order). */
export function quadContains(quad, x, y) {
  let positive = false, negative = false;
  for (let k = 0; k < 4; k++) {
    const a = quad[k], b = quad[(k + 1) % 4];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Number.isNaN(cross)) return false;
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
  }
  return positive !== negative;
}

/** Distance from a point to a segment. */
export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
