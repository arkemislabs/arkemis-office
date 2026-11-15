// Ink on a page: the pen catalogue, selections of strokes and the geometry of editing them
// (Draw tab; U:slate/draw).
//
// Slate has no ArtCraft upstream; this is OneNote's Draw tab. A stroke is a plain record on the page
// (`pages[id].ink`, core/slate/model/canvas.mjs): tool (pen, pencil, highlighter), colour, width,
// points (page px) and optionally `fx` (galaxy or rainbow ink), `group` (the strokes of one drawn
// shape move, rotate and delete together) and `shape` (which shape it came from). Strokes are
// selected by the Lasso as `/pg:<page>/ink:<id>` addresses, one range per stroke; the order of the
// array is the order they are painted in (Arrange).
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {normalizeStroke, strokeBounds, strokeHit} from '../model/canvas.mjs';

/** Pixels per millimetre at 96 dpi: OneNote names pen widths in mm. */
export const MM = 96 / 25.4;
export const mm = v => Math.round(v * MM * 100) / 100;

export const PENS_PREF = 'slate.pens';

/** OneNote's pen tray (Draw › Pens): four 0.5 mm pens, a 1 mm pencil, galaxy and rainbow pens, three 6 mm highlighters. */
export const DEFAULT_PENS = Object.freeze([
  {id: 'black-pen', name: 'Black Pen (0.5 mm)', type: 'pen', color: '#000000', width: mm(0.5), fx: null, icon: 'pen-black'},
  {id: 'blue-pen', name: 'Blue Pen (0.5 mm)', type: 'pen', color: '#0070c0', width: mm(0.5), fx: null, icon: 'pen-blue'},
  {id: 'red-pen', name: 'Red Pen (0.5 mm)', type: 'pen', color: '#ff0000', width: mm(0.5), fx: null, icon: 'pen-red'},
  {id: 'green-pen', name: 'Green Pen (0.5 mm)', type: 'pen', color: '#00b050', width: mm(0.5), fx: null, icon: 'pen-green'},
  {id: 'pencil', name: 'Pencil (1 mm)', type: 'pencil', color: '#5f5f5f', width: mm(1), fx: null, icon: 'pencil'},
  {id: 'galaxy-pen', name: 'Galaxy Pen', type: 'pen', color: '#7a4dd8', width: mm(1.2), fx: 'galaxy', icon: 'pen-galaxy'},
  {id: 'rainbow-pen', name: 'Rainbow Pen', type: 'pen', color: '#ff7a00', width: mm(1.2), fx: 'rainbow', icon: 'pen-rainbow'},
  {id: 'yellow-highlighter', name: 'Yellow Highlighter (6 mm)', type: 'highlighter', color: '#ffff00', width: mm(6), fx: null, icon: 'highlighter-yellow'},
  {id: 'green-highlighter', name: 'Green Highlighter (6 mm)', type: 'highlighter', color: '#92d050', width: mm(6), fx: null, icon: 'highlighter-green'},
  {id: 'pink-highlighter', name: 'Pink Highlighter (6 mm)', type: 'highlighter', color: '#ff66cc', width: mm(6), fx: null, icon: 'highlighter-pink'},
]);

/** Thicknesses of the Color & Thickness dialog (mm) and its colours (OneNote's names; Galaxy and Rainbow are inks). */
export const THICKNESSES = Object.freeze([0.25, 0.35, 0.5, 0.7, 1, 2, 3.5, 6, 8]);
export const PEN_COLORS = Object.freeze({Black: '#000000', Gray: '#7f7f7f', Red: '#ff0000', Orange: '#ff8c00', Yellow: '#ffff00', Green: '#00b050', 'Light Blue': '#00b0f0',
  Blue: '#0070c0', 'Dark Blue': '#002060', Purple: '#7030a0', Pink: '#ff66cc', Brown: '#7f4f24', White: '#ffffff', Galaxy: '#7a4dd8', Rainbow: '#ff7a00', Gold: '#c9a227', Silver: '#a8a9ad', Bronze: '#a0662b'});
export const PEN_FX = Object.freeze({Galaxy: 'galaxy', Rainbow: 'rainbow'});
const TYPE_ICON = {pen: 'pen-black', pencil: 'pencil', highlighter: 'highlighter-yellow'};
const TYPE_NAME = {pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter'};
const TYPE_DEFAULT = {pen: {color: '#000000', width: mm(0.5)}, pencil: {color: '#5f5f5f', width: mm(1)}, highlighter: {color: '#ffff00', width: mm(6)}};

const mmText = w => `${Math.round((w / MM) * 100) / 100} mm`.replace(/\.0+ mm$/, ' mm');
/** A pen's name as the tray shows it. */
export const penName = p => p.name ?? `${TYPE_NAME[p.type]} (${mmText(p.width)})`;

/** The pens now: the default tray, or the person's own list (added, removed or changed pens). */
export function pensOf(prefs) {
  const own = prefs?.[PENS_PREF];
  const list = Array.isArray(own) ? own : DEFAULT_PENS;
  return list.map(p => ({...p, name: p.name ?? penName(p), icon: p.icon ?? TYPE_ICON[p.type]}));
}

export function findPen(prefs, id) {
  const p = pensOf(prefs).find(x => x.id === id);
  if (!p) throw new CommandError('not_found', `No pen ${id}`, {path: '/penId'});
  return p;
}

/** A new pen of a type: its default colour and width, named for its type. */
export function newPen(type, id) {
  const d = TYPE_DEFAULT[type];
  if (!d) throw new CommandError('invalid_params', 'A pen is a pen, a pencil or a highlighter', {path: '/type'});
  const p = {id, type, color: d.color, width: d.width, fx: null};
  return {...p, name: penName(p), icon: TYPE_ICON[type]};
}

/** The tool state a pen sets in the document view (`view.ink`, read by the ink layer). */
export const penTool = p => ({tool: p.type, penId: p.id, color: p.color, width: p.width, ...(p.fx ? {fx: p.fx} : {})});

// ---------------------------------------------------------------------------------------------
// Selection

const INK_ADDRESS = /^\/pg:([^/]+)\/ink:([^/]+)$/;

/** The strokes the selection names (Lasso): {pageId, ids, strokes} or null. Strokes of one shape come together. */
export function selectedInk(ctx) {
  if (!isNotebook(ctx.doc)) return null;
  const ranges = ctx.selection?.ranges ?? [];
  let pageId = null;
  const ids = [];
  for (const r of ranges) {
    const m = INK_ADDRESS.exec(r.anchor ?? '');
    if (!m) continue;
    const pg = decodeURIComponent(m[1]);
    if (pageId && pg !== pageId) continue;
    pageId = pg;
    ids.push(decodeURIComponent(m[2]));
  }
  if (!pageId || !ctx.doc.pages[pageId]) return null;
  const page = ctx.doc.pages[pageId];
  const wanted = new Set(ids);
  const strokes = page.ink.filter(s => wanted.has(s.id));
  if (!strokes.length) return null;
  return {pageId, ids: strokes.map(s => s.id), strokes};
}

export const inkSelection = (pageId, ids) => ({ranges: ids.map(id => ({anchor: `/pg:${pageId}/ink:${id}`, focus: `/pg:${pageId}/ink:${id}`})), primary: 0});

/** State helper: enabled when strokes are selected. */
export function inkState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return selectedInk(ctx) ? {enabled: true} : {enabled: false, reason: 'Select ink or a shape with the Lasso first'};
}

/** The page the Draw commands act on. */
export function pageOf(ctx, given) {
  if (!isNotebook(ctx.doc)) throw new CommandError('disabled', 'No notebook is open');
  const pageId = given ?? currentLocation(ctx.doc, ctx.selection).pageId;
  if (!pageId || !ctx.doc.pages[pageId]) throw new CommandError('disabled', 'No page is open');
  return pageId;
}
export function pageState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'};
}

/** Every stroke of the groups some of `ids` belong to, plus `ids` themselves. */
export function withGroups(ink, ids) {
  const set = new Set(ids);
  const groups = new Set(ink.filter(s => set.has(s.id) && s.group).map(s => s.group));
  return ink.filter(s => set.has(s.id) || (s.group && groups.has(s.group))).map(s => s.id);
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** Bounding box of strokes: {x, y, width, height, cx, cy}. */
export function boundsOf(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const b = strokeBounds(s);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return {x: x0, y: y0, width: x1 - x0, height: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2};
}

/** Is a point inside a polygon (a flat x, y list)? Even-odd rule. */
export function inPolygon(x, y, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Strokes the Lasso loop takes: those with at least half their points inside it. */
export function lassoHits(ink, loop) {
  if (loop.length < 6) return [];
  const hit = [];
  for (const s of ink) {
    const n = s.points.length / 2;
    let inside = 0;
    for (let i = 0; i < n; i++) if (inPolygon(s.points[2 * i], s.points[2 * i + 1], loop)) inside++;
    if (inside * 2 >= n) hit.push(s.id);
  }
  return hit;
}

const round1 = v => Math.round(v * 10) / 10 + 0;
const withPoints = (s, points) => ({...s, points});

/** Move strokes by (dx, dy), never past the page's top or left edge. */
export function moved(strokes, dx, dy) {
  let minX = Infinity, minY = Infinity;
  for (const st of strokes) for (let i = 0; i < st.points.length; i += 2) { minX = Math.min(minX, st.points[i]); minY = Math.min(minY, st.points[i + 1]); }
  const mx = Math.max(dx, -minX), my = Math.max(dy, -minY);
  return strokes.map(s => withPoints(s, s.points.map((v, i) => round1(v + (i % 2 ? my : mx)))));
}

/** Rotate strokes by `degrees` (clockwise on the page) around the middle of their bounds. */
export function rotated(strokes, degrees) {
  const b = boundsOf(strokes);
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const out = strokes.map(s => {
    const p = s.points.slice();
    for (let i = 0; i < p.length; i += 2) {
      const x = s.points[i] - b.cx, y = s.points[i + 1] - b.cy;
      p[i] = round1(b.cx + x * c - y * sn);
      p[i + 1] = round1(b.cy + x * sn + y * c);
    }
    return withPoints(s, p);
  });
  // Keep it on the page: shift back when the turn put it past the top or left edge.
  let minX = Infinity, minY = Infinity;
  for (const st of out) for (let i = 0; i < st.points.length; i += 2) { minX = Math.min(minX, st.points[i]); minY = Math.min(minY, st.points[i + 1]); }
  return minX < 0 || minY < 0 ? moved(out, Math.max(0, -minX), Math.max(0, -minY)) : out;
}

/** Mirror strokes across the vertical (horizontal flip) or horizontal (vertical flip) middle of their bounds. */
export function flipped(strokes, axis) {
  const b = boundsOf(strokes);
  return strokes.map(s => {
    const p = s.points.slice();
    for (let i = 0; i < p.length; i += 2) {
      if (axis === 'horizontal') p[i] = round1(2 * b.cx - s.points[i]);
      else p[i + 1] = round1(2 * b.cy - s.points[i + 1]);
    }
    return withPoints(s, p);
  });
}

/**
 * The point eraser: remove the parts of a stroke within `r` of the eraser's path; what is left of
 * each stroke is one or more strokes (a stroke cut in the middle becomes two). Returns
 * {ink, changed} with new strokes keeping the tool, colour, width, fx, group and shape.
 */
export function erasePoints(ink, path, r, newId) {
  const near = (x, y, s) => {
    const reach = r + s.width / 2;
    for (let i = 0; i + 1 < path.length; i += 2) {
      const dx = x - path[i], dy = y - path[i + 1];
      if (dx * dx + dy * dy <= reach * reach) return true;
      if (i + 3 < path.length && segmentNear(x, y, path[i], path[i + 1], path[i + 2], path[i + 3], reach)) return true;
    }
    return false;
  };
  const out = [];
  let changed = 0;
  let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
  for (let i = 0; i + 1 < path.length; i += 2) { px0 = Math.min(px0, path[i]); px1 = Math.max(px1, path[i]); py0 = Math.min(py0, path[i + 1]); py1 = Math.max(py1, path[i + 1]); }
  for (const s of ink) {
    // Skip strokes the path cannot reach at all (bounds first, then any point of the stroke within reach).
    const sb = strokeBounds(s);
    if (sb.x - r > px1 || sb.x + sb.width + r < px0 || sb.y - r > py1 || sb.y + sb.height + r < py0) { out.push(s); continue; }
    let touched = false;
    for (let i = 0; i + 1 < s.points.length && !touched; i += 2) if (near(s.points[i], s.points[i + 1], s)) touched = true;
    if (!touched) for (let i = 0; i + 3 < s.points.length && !touched; i += 2) if (near((s.points[i] + s.points[i + 2]) / 2, (s.points[i + 1] + s.points[i + 3]) / 2, s)) touched = true;
    if (!touched) { out.push(s); continue; }
    changed++;
    const pts = s.points;
    let run = [];
    let first = true;
    const flush = () => {
      if (run.length >= 4) out.push({...s, id: first ? s.id : newId(), points: run});
      else if (run.length === 2) out.push({...s, id: first ? s.id : newId(), points: [run[0], run[1], run[0] + 0.1, run[1]]});
      else return;
      first = false;
    };
    // Sample along the stroke: a segment longer than the eraser is checked at its midpoints too.
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (near(x, y, s)) { flush(); run = []; continue; }
      if (run.length && i >= 2) {
        const px = pts[i - 2], py = pts[i - 1];
        if (near((x + px) / 2, (y + py) / 2, s)) { flush(); run = []; }
      }
      run.push(x, y);
    }
    flush();
  }
  return {ink: out, changed};
}

function segmentNear(px, py, ax, ay, bx, by, reach) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy <= reach * reach;
}

/** Re-validate strokes the way a new one is (rounded points, bounded sizes). */
export const clean = strokes => strokes.map(s => normalizeStroke(s, s.id));
