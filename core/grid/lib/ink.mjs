// Ink on a worksheet: the strokes the Draw tab's pens leave, what the eraser and the lasso find, and
// what Ink to Shape makes of a stroke.
// Translated from gridcraft crates/engine/src/cmd/draw.rs (`stroke`, `ink_width`, `ink_points`,
// `ink_to_shape`) and crates/xlsx/src/drawing/ink.rs (the width and the highlighter's alpha) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The erasing and lasso tests are Excel's: the eraser takes the stroke it touches, the lasso the strokes
// most of whose points are inside the loop (not checked against upstream, which has neither test).
//
// A stroke is a shape of kind `ink` pinned where it was drawn (anchor mode `absolute`): its `text` holds the
// points as `x,y;x,y;...` in pixels from the anchor's top-left corner, its `line` the colour and its `fill`
// the width in the red channel (`#RR0000`: shapes have no width field). No DOM, no Node built-ins.

import {objectRect} from './objects.mjs';

export const MIN_INK_WIDTH = 0.5, MAX_INK_WIDTH = 40;
export const MAX_INK_POINTS = 20_000;
/** A stroke wider than this is a highlighter: drawn at 45% (xlsx `a:alpha 45000`). */
export const HIGHLIGHTER_WIDTH = 8;
export const HIGHLIGHTER_ALPHA = 0.45;

/** The pens the Draw tab offers: [name, colour, width] (ribbon/insert.rs and Excel's Add Pen menu). */
export const PENS = Object.freeze({
  pen: {color: '#000000', width: 2},
  pencil: {color: '#595959', width: 1},
  highlighter: {color: '#F2E33A', width: 12},
});

/** The points of a stroke shape as [[x, y]] from its anchor corner. */
export function inkPoints(shape) {
  const out = [];
  for (const part of String(shape?.text ?? '').split(';')) {
    const [x, y] = part.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}
/** The text of points: `x,y;x,y`, one decimal. */
export const inkText = pts => pts.map(([x, y]) => `${(Math.round(x * 10) / 10)},${(Math.round(y * 10) / 10)}`).join(';');

/** The width of a stroke (the red channel of its fill; 2 when it has none). */
export function inkWidth(shape) {
  const m = /^#([0-9a-fA-F]{2})[0-9a-fA-F]{4}$/.exec(typeof shape?.fill === 'string' ? shape.fill : '');
  return m ? Math.max(1, parseInt(m[1], 16)) : 2;
}
/** The fill that holds a width. */
export const widthFill = width => `#${Math.min(255, Math.max(0, Math.round(width))).toString(16).padStart(2, '0').toUpperCase()}0000`;
/** 1 for a pen, the highlighter's alpha for a wide stroke. */
export const inkAlpha = shape => (inkWidth(shape) > HIGHLIGHTER_WIDTH ? HIGHLIGHTER_ALPHA : 1);

const isInk = o => o?.kind === 'ink';
export const inkShapes = sheet => (sheet?.shapes ?? []).filter(isInk);

/** A stroke's points in sheet pixels, given where its anchor corner is: `origin` {x, y}. */
export const inkSheetPoints = (shape, origin) => inkPoints(shape).map(([x, y]) => [origin.x + x, origin.y + y]);

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** Whether (x, y) is within `reach` pixels of the stroke's line (points in the same space as x, y). */
export function nearInk(points, width, x, y, reach = 4) {
  const r = width / 2 + reach;
  if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= r;
  for (let i = 1; i < points.length; i++) if (distToSegment(x, y, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]) <= r) return true;
  return false;
}

/** Whether (x, y) is inside the polygon (even-odd). */
export function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The shape kind a stroke looks like (upstream `ink_to_shape`): an open stroke is a line; a closed one (its ends
 * within a quarter of its size) is a rectangle when three corners of its box are touched, a triangle when it has
 * an apex at the top and both bottom corners, else an ellipse. `w`, `h` are the stroke's box.
 */
export function shapeOfStroke(pts, w, h) {
  w = Math.max(1, w); h = Math.max(1, h);
  const first = pts[0], last = pts[pts.length - 1];
  const closed = first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.25 * Math.max(w, h);
  if (!closed) return 'line';
  const near = (cx, cy) => pts.some(q => Math.hypot(q[0] - cx, q[1] - cy) < 0.15 * Math.max(Math.min(w, h), 8));
  const corners = [near(0, 0), near(w, 0), near(0, h), near(w, h)].filter(Boolean).length;
  if (corners >= 3) return 'rectangle';
  if (near(w / 2, 0) && near(0, h) && near(w, h)) return 'triangle';
  return 'ellipse';
}

/** The bounding box of points: {x0, y0, x1, y1}. */
export function bounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return {x0, y0, x1, y1};
}

/** The topmost stroke of a sheet within `reach` pixels of (x, y) in sheet pixels, as {index, shape}, or null. */
export function inkHit(sheet, x, y, reach = 4) {
  const list = sheet?.shapes ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const shape = list[i];
    if (shape.kind !== 'ink') continue;
    const r = objectRect(sheet, shape.anchor);
    const pts = inkPoints(shape).map(([px, py]) => [r.x + px, r.y + py]);
    if (nearInk(pts, inkWidth(shape), x, y, reach)) return {index: i, shape};
  }
  return null;
}
