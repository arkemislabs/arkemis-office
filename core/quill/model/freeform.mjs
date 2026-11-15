// Freeform shapes: geometry drawn point by point (DrawingML a:custGeom), such as an ink stroke
// drawn with a pen, pencil or highlighter (Draw tab); plus the drawing-item kinds of charts,
// SmartArt and native ink previews (graphic.rs).
// Translated from wordcraft crates/doc/src/freeform.rs and crates/doc/src/graphic.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Freeform `{w, h, paths: [{pts: [[x, y]...], closed, d?}], alpha, ink?, order?}`; `d` (SVG path data in the w × h space, Edit Points') keeps the curves `pts` flattens. A graphic object's
// `graphic` is `{kind: 'chart'|'diagram'|'ink', items, w, h, source?, smartArt?, chart?}`; items are
// `{type:'shape', rect, kind, fill, stroke, strokeWidth}` | `{type:'path', segs, fill, stroke,
// strokeWidth}` | `{type:'text', rect, text, size, color, bold, align, font}` | `{type:'image',
// rect, media}`; a path segment is `{move: [x, y]}` | `{line: [x, y]}` | `{cubic: [6 numbers]}` |
// `'close'` (serde's external tagging). No DOM, no Node built-ins.

export const MAX_POINTS = 5_000;
export const MAX_PATHS = 256;
export const MAX_INK_PER_PAGE = 2_000;
const MAX_COORD = 1.0e6;
const MAX_PATH_DATA = 400_000;

export const INK_TOOLS = Object.freeze(['pen', 'pencil', 'highlighter']);
export const parseInkTool = s => (INK_TOOLS.includes(String(s ?? '').toLowerCase()) ? String(s).toLowerCase() : null);
const INK = {pen: {color: [0, 0, 0], width: 1.5, alpha: 1}, pencil: {color: [0x59, 0x59, 0x59], width: 1, alpha: 0.85},
  highlighter: {color: [0xff, 0xff, 0x00], width: 12, alpha: 0.5}};
/** The colour a new stroke gets (black pen, grey pencil, yellow highlighter). */
export const inkDefaultColor = t => [...(INK[t] ?? INK.pen).color];
export const inkDefaultWidth = t => (INK[t] ?? INK.pen).width;
/** How opaque its strokes are. */
export const inkAlpha = t => (INK[t] ?? INK.pen).alpha;

export const defaultFreeform = () => ({w: 0, h: 0, paths: [], alpha: 1});

/** Safe geometry: non-finite points dropped, coordinates clamped, counts capped, alpha 0–1. */
export function sanitizedFreeform(f) {
  const fin = v => (Number.isFinite(v) ? Math.min(MAX_COORD, Math.max(-MAX_COORD, v)) : 0);
  const out = {...defaultFreeform(), ...(f || {})};
  out.w = Math.max(0, fin(out.w));
  out.h = Math.max(0, fin(out.h));
  out.alpha = Number.isFinite(out.alpha) ? Math.min(1, Math.max(0, out.alpha)) : 1;
  out.paths = (out.paths || []).slice(0, MAX_PATHS)
    .map(p => ({pts: (p.pts || []).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).slice(0, MAX_POINTS).map(([x, y]) => [fin(x), fin(y)]),
      closed: !!p.closed, ...(typeof p.d === 'string' && p.d.length <= MAX_PATH_DATA ? {d: p.d} : {})}))
    .filter(p => p.pts.length);
  if (out.ink === null || out.ink === undefined) delete out.ink;
  if (out.order === null || out.order === undefined) delete out.order;
  return out;
}

/** An ink stroke through `pts` (shape-local points in the w × h frame). */
export const inkFreeform = (tool, w, h, pts) => sanitizedFreeform({w, h, paths: [{pts, closed: false}], alpha: inkAlpha(tool), ink: tool});
export const isInk = f => !!f?.ink;

/** The paths mapped onto a frame at (x, y) of fw × fh: [[pts, closed]]. */
export function placedPaths(f, x, y, fw, fh) {
  let sx = f.w > 0 ? fw / f.w : 1, sy = f.h > 0 ? fh / f.h : 1;
  if (!Number.isFinite(sx)) sx = 1;
  if (!Number.isFinite(sy)) sy = 1;
  return (f.paths || []).slice(0, MAX_PATHS).map(p => [p.pts.slice(0, MAX_POINTS).map(([px, py]) => [x + px * sx, y + py * sy]), !!p.closed]);
}

const segDistance = (a, b, p) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  const cx = a[0] + t * dx, cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
};

/** Distance from (px, py) to the nearest path placed on the frame; null without points. */
export function freeformDistance(f, x, y, fw, fh, px, py) {
  let best = null;
  for (const [pts, closed] of placedPaths(f, x, y, fw, fh)) {
    const n = pts.length;
    const segs = closed && n > 2 ? n : Math.max(0, n - 1);
    const consider = (a, b) => { const d = segDistance(a, b, [px, py]); if (Number.isFinite(d) && (best === null || d < best)) best = d; };
    if (n === 1) consider(pts[0], pts[0]);
    for (let i = 0; i < segs; i++) consider(pts[i], pts[(i + 1) % n]);
  }
  return best;
}

// --- graphic.rs ---------------------------------------------------------------------------------

export const GRAPHIC_KINDS = Object.freeze(['chart', 'diagram', 'ink']);
/** What the graphic is, in words: the alt text of one that has none of its own. */
export const graphicNoun = k => (GRAPHIC_KINDS.includes(k) ? k : 'chart');
export const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);
export const defaultGraphic = () => ({kind: 'chart', items: [], w: 0, h: 0});

/** A path segment's kind and numbers: ['move'|'line'|'cubic'|'close', numbers]. */
export function pathSeg(s) {
  if (s === 'close') return ['close', []];
  for (const k of ['move', 'line', 'cubic']) if (Array.isArray(s?.[k])) return [k, s[k]];
  return null;
}
