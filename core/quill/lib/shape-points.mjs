// Edit Points for Word shapes: a shape's outline as path data, edited with PowerPoint's path engine (core/prism/lib/points.mjs), and
// written back as a freeform whose paths keep their curves.
//
// Not in wordcraft (it has no Edit Points); the engine is deckcraft's crates/engine/src/cmd/points.rs through core/prism, imported and
// not edited. Not checked against upstream for Word. A Word shape's geometry is turned into the same shape PowerPoint edits: custom
// paths in shape-local points under a box (here the object's frame on the page, with its turn and flips), edited by
// `pts.withPath`-style functions, then read back: the box is fitted round the outline again and a floating object stays where it was.
// A freeform path is `{pts, closed, d?}`: `d` (SVG path data in the freeform's w × h) is the exact outline, `pts` its flattening.
// No DOM, no Node built-ins.

import * as pts from '../../prism/lib/points.mjs';
import {shapeGeometry} from '../../prism/model/render.mjs';
import {sanitizedFreeform, MAX_POINTS} from '../model/freeform.mjs';

/** Word's shape kinds as DrawingML preset names (the outline PowerPoint's geometry draws for them). */
export const PRESETS = Object.freeze({
  rectangle: 'rect', roundedRectangle: 'roundRect', ellipse: 'ellipse', flowchartOr: 'flowChartOr', triangle: 'triangle', rightTriangle: 'rtTriangle',
  diamond: 'diamond', arrow: 'rightArrow', arrowLeft: 'leftArrow', arrowUp: 'upArrow', arrowDown: 'downArrow', star: 'star5', heart: 'heart',
});

/** Whether the shape has an outline whose points can be edited: a closed preset or a freeform that is not ink. */
export const editableShape = o => o?.type === 'shape' && o.story == null && ((o.kind === 'freeform' && !!o.freeform && !o.freeform.ink) || Object.hasOwn(PRESETS, o.kind));
/** Whether the shape is already a freeform (Edit Points is on it). */
export const isEdited = o => o?.type === 'shape' && o.kind === 'freeform' && !!o.freeform && !o.freeform.ink && (o.freeform.paths ?? []).some(p => typeof p.d === 'string');

const f3 = v => { const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; };
/** Path data of a polyline path. */
const polyline = p => (p.pts.length ? `M ${p.pts.map(([x, y]) => `${f3(x)} ${f3(y)}`).join(' L ')}${p.closed ? ' Z' : ''}` : '');

/** Path data cut into one string per sub-path (a Move starts each), so a freeform path is one outline. */
export function subpaths(d) {
  const out = [];
  let cur = [];
  for (const s of pts.parse(d)) {
    if (s.t === 'M' && cur.length) { out.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out.filter(c => c.some(s => s.t !== 'M' && s.t !== 'Z')).map(c => pts.write(c));
}

/** The shape's outline as custom paths in its own points, one per sub-path: [{d, w, h, fill, stroke}]. */
export function outlineOf(o) {
  const w = Math.max(o.w, 1), h = Math.max(o.h, 1);
  if (o.kind === 'freeform' && o.freeform) {
    const f = o.freeform;
    return f.paths.map(p => ({d: typeof p.d === 'string' ? p.d : polyline(p), w: f.w > 0 ? f.w : w, h: f.h > 0 ? f.h : h, fill: p.closed ? 'norm' : 'none', stroke: true}));
  }
  const name = PRESETS[o.kind] ?? 'rect';
  return pts.toCustom(shapeGeometry({geom: {kind: 'preset', name}}, w, h).paths, w, h)
    .flatMap(cp => subpaths(cp.d).map(d => ({...cp, d, fill: /Zs*$/.test(d) ? cp.fill : 'none'})));
}

/** A PowerPoint-style shape over the object: custom paths under a box at `rect` (page points) turned as the object is. */
export function editableOf(o, rect) {
  const f = o.float ?? {};
  const paths = outlineOf(o);
  const x = {x: rect.x, y: rect.y, w: rect.w, h: rect.h, rot: f.rot ?? 0, flipH: !!f.flipH, flipV: !!f.flipV};
  pts.normalize(paths, x.w, x.h);
  return {geom: {kind: 'custom', paths}, xfrm: x};
}

/** A path's data flattened to points (12 steps a curve), in the same space. */
export function flatten(d) {
  const segs = pts.parse(d), out = [];
  let closed = false, cur = null;
  for (const s of segs) {
    if (s.t === 'M') { cur = s.pts[0]; out.push([cur.x, cur.y]); } else if (s.t === 'L') { cur = s.pts[0]; out.push([cur.x, cur.y]); } else if (s.t === 'Z') closed = true;
    else if (cur) {
      const ctrl = [cur, ...s.pts];
      for (let i = 1; i <= 12; i++) {
        let p = ctrl;
        const t = i / 12;
        while (p.length > 1) p = p.slice(1).map((b, k) => ({x: p[k].x + (b.x - p[k].x) * t, y: p[k].y + (b.y - p[k].y) * t}));
        out.push([p[0].x, p[0].y]);
      }
      cur = s.pts[s.pts.length - 1];
    }
  }
  // A closing edge back onto the start is the Z.
  if (closed && out.length > 2 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return {pts: out.slice(0, MAX_POINTS), closed};
}

/**
 * The object after editing: `after` is the PowerPoint-style shape `editableOf` made (box and paths edited), `before` the box it
 * started from. The object becomes a freeform of the new box; a floating one moves by what the box did on the page.
 */
export function written(o, before, after) {
  const x = after.xfrm;
  const free = sanitizedFreeform({w: x.w, h: x.h, alpha: 1, paths: after.geom.paths.flatMap(cp => subpaths(cp.d)).map(d => ({...flatten(d), d}))});
  const out = {...o, kind: 'freeform', w: x.w, h: x.h, freeform: free};
  const dx = x.x - before.x, dy = x.y - before.y;
  if (o.float && (o.float.wrap ?? 'inline') !== 'inline' && (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9)) {
    const f = {...o.float};
    // An aligned object is placed by its offsets from here on: where it is now, plus the move.
    if (f.hAlign) { f.hRel = 'page'; f.x = before.x; delete f.hAlign; }
    if (f.vAlign) { f.vRel = 'page'; f.y = before.y; delete f.vAlign; }
    f.x = (Number.isFinite(f.x) ? f.x : 0) + dx;
    f.y = (Number.isFinite(f.y) ? f.y : 0) + dy;
    out.float = f;
  }
  return out;
}

export {pts};
