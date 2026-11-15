// Shape Format › Edit Shape › Edit Points: turn a shape into a freeform and move, add or delete the
// vertices of its outline, change point and segment types, move a point's handles, open and close
// the outline. While points are edited every custom path of the shape is kept in shape-local points
// (its w and h equal the shape's size); after each change the box is fitted around the outline again,
// keeping it in place on the slide. Edit Points itself is view state (`view.editPoints`): the shape
// and the vertex whose handles show; the pointer layer drags vertices and handles (lib/pointer.mjs).
// Translated from deckcraft crates/engine/src/cmd/points.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasSelection, targets, currentSlide, editShapes} from '../lib/shape-common.mjs';
import {selectedShapeIds, xfrmOf} from '../model/doc.mjs';
import {findShape, isLine} from '../model/presentation.mjs';
import {shapeGeometry} from '../model/render.mjs';
import * as pts from '../lib/points.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/points.rs', 'crates/engine/src/tools/pointer.rs']};
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const idP = s.optional(ID), path = s.optional(s.integer({min: 0})), idx = s.optional(s.integer({min: 0}));
const num = s.number();

/** The one shape whose points are edited: `id`, or the single selected shape. */
function target(ctx, p, cmd) {
  const sl = currentSlide(ctx, cmd);
  const ids = p.id !== undefined ? [String(p.id)] : selectedShapeIds(ctx.doc, ctx.selection).map(String);
  if (p.id === undefined && ids.length !== 1) throw bad(cmd, 'select one shape');
  const sh = findShape(sl.shapes, ids[0]);
  if (!sh) throw bad(cmd, 'no such shape');
  if (!sl.shapes.some(t => t.id === sh.id)) throw bad(cmd, "a shape in a group can't have its points edited; ungroup it first");
  if (sh.kind?.type !== 'shape' || isLine(sh)) throw bad(cmd, 'only a shape with an outline has points to edit');
  if (sh.locked) throw bad(cmd, 'the shape is locked');
  return {sl, id: sh.id};
}

/** Makes the shape a freeform in shape-local points (the state Edit Points works in). */
function prepare(sh) {
  const x = sh.xfrm;
  if (sh.geom?.kind === 'custom') pts.normalize(sh.geom.paths, x.w, x.h);
  else sh.geom = {kind: 'custom', paths: pts.toCustom(shapeGeometry(sh, x.w, x.h).paths, x.w, x.h)};
}

/** Runs `f(segs, vertexSegments, xfrm)` on path `pathIndex` of the shape, then refits its box. */
function editPath(ctx, p, cmd, f, forget = false) {
  const {id} = target(ctx, p, cmd);
  const pathIndex = p.path ?? 0;
  editShapes(ctx, {ids: [id]}, cmd, sh => {
    prepare(sh);
    const cp = sh.geom.paths[pathIndex];
    if (!cp) throw bad(cmd, 'no such path');
    const segs = pts.parse(cp.d), vs = pts.vertices(segs);
    if (f(segs, vs, sh.xfrm)) { cp.d = pts.write(segs); pts.refit(sh); }
  });
  if (forget) forgetKind(ctx, id, pathIndex);
  return {};
}

const view = ctx => ctx.view?.editPoints ?? null;
/** The editing state as the pointer layer reads it. */
export const editing = ctx => {
  const e = view(ctx);
  if (!e) return null;
  const ids = selectedShapeIds(ctx.doc, ctx.selection);
  if (ids.length !== 1 || String(ids[0]) !== String(e.id)) return null;
  // Only a freeform has points: after Undo takes the conversion back, Edit Points is over.
  let sh = null;
  try { sh = findShape(currentSlide(ctx, 'shape.editPoints').shapes, e.id); } catch { /* no slide */ }
  return sh?.geom?.kind === 'custom' ? e : null;
};
function forgetKind(ctx, id, pathIndex) {
  const e = view(ctx);
  if (e?.vertex && String(e.id) === String(id) && e.vertex[0] === pathIndex) ctx.setView({editPoints: {...e, vertex: null}});
}

/** The path and vertex a command acts on: its own, else the vertex last picked or right-clicked in Edit Points. */
const vtx = (ctx, p, cmd) => {
  const v = view(ctx)?.vertex;
  const index = p.index ?? v?.[1];
  if (index === undefined) throw bad(cmd, 'give `index`, or pick a point first');
  return {...p, index, path: p.path ?? (p.index === undefined ? v?.[0] : undefined) ?? 0};
};
/** The path and segment (the vertex ending it) a command acts on: its own, else the segment last right-clicked. */
const segp = (ctx, p, cmd) => {
  const g = view(ctx)?.segment;
  const segment = p.segment ?? g?.[1];
  if (segment === undefined) throw bad(cmd, 'give `segment`, or right-click a segment first');
  return {...p, segment, path: p.path ?? (p.segment === undefined ? g?.[0] : undefined) ?? 0, ...(p.t === undefined && p.segment === undefined && g?.[2] !== undefined ? {t: g[2]} : {})};
};
const need = (v, cmd, what) => { if (v === undefined) throw bad(cmd, `no such ${what}`); return v; };
const pt = (p, cmd) => {
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y))) throw bad(cmd, 'give `x` and `y` in slide points');
  return {x: Math.min(Math.max(p.x, -1e5), 1e5), y: Math.min(Math.max(p.y, -1e5), 1e5)};
};

export default defineCommands({
  family: 'points',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.editPoints', label: 'Edit Points', risk: 'edit', state: (ctx) => { const st = hasSelection(ctx); return st.enabled ? {enabled: true, checked: !!editing(ctx)} : st; },
      description: '{on?: bool (default: toggle), id?} — enter or leave Edit Points for one selected shape; entering turns a preset into a freeform',
      params: s.object({on: s.optional(s.boolean()), id: idP}),
      run(ctx, p) {
        const on = p.on ?? !editing(ctx);
        if (!on) { ctx.setView({editPoints: null}); return {editing: null}; }
        const {id} = target(ctx, p, 'shape.editPoints');
        editShapes(ctx, {ids: [id]}, 'shape.editPoints', sh => { prepare(sh); });
        ctx.setView({editPoints: {id, vertex: null}});
        return {editing: id};
      }},
    {id: 'shape.points', label: 'Points', risk: 'read', state: hasSelection, description: '{id?} → {id, paths: [[[x, y] slide pt]], types: [[smooth|straight|corner]], segments: [[straight|curved|null]]}',
      params: s.object({id: idP}),
      run(ctx, p) {
        const sl = currentSlide(ctx, 'shape.points');
        const id = p.id !== undefined ? String(p.id) : String(selectedShapeIds(ctx.doc, ctx.selection)[0] ?? '');
        const sh = findShape(sl.shapes, id);
        if (!sh) throw bad('shape.points', 'no such shape');
        const x = xfrmOf(ctx.doc, sl.id, sh), d = pts.describe(sh);
        return {id: sh.id, paths: pts.slideVertices(sh, x).map(v => v.map(q => [q.x, q.y])), types: d.types, segments: d.kinds};
      }},
    {id: 'shape.movePoint', label: 'Move Point', risk: 'edit', state: hasSelection, description: '{path?: 0, index, x, y: slide pt, id?}',
      params: s.object({path, index: idx, x: num, y: num, id: idP}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.movePoint'), to = pt(p, 'shape.movePoint');
        return editPath(ctx, p, 'shape.movePoint', (segs, vs, x) => {
          const si = need(vs[p.index], 'shape.movePoint', 'point');
          const local = pts.toLocal(pts.affineOf(x), to), cur = segs[si].pts.at(-1);
          pts.moveVertex(segs, si, {x: local.x - cur.x, y: local.y - cur.y});
          return true;
        });
      }},
    {id: 'shape.addPoint', label: 'Add Point', risk: 'edit', state: hasSelection, description: '{path?: 0, segment: index of the vertex ending it, t?: 0..1 (0.5), id?}',
      params: s.object({path, segment: idx, t: s.optional(num), id: idP}),
      run(ctx, p0) {
        const p = segp(ctx, p0, 'shape.addPoint'), t = Math.min(Math.max(Number.isFinite(p.t) ? p.t : 0.5, 0.01), 0.99);
        return editPath(ctx, p, 'shape.addPoint', (segs, vs) => {
          let si = need(vs[p.segment], 'shape.addPoint', 'segment');
          si = pts.endingSegment(segs, si);
          if (si === undefined) throw bad('shape.addPoint', 'the first point ends no segment');
          if (!pts.split(segs, si, t)) throw bad('shape.addPoint', 'no segment ends at that point');
          return true;
        }, true);
      }},
    {id: 'shape.pointType', label: 'Point Type', risk: 'edit', state: hasSelection, description: '{path?: 0, index, type: smooth|straight|corner, id?} — smooth: handles in line and equal; straight: in line; corner: independent',
      params: s.object({path, index: idx, type: s.enum(['smooth', 'straight', 'corner']), id: idP}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.pointType');
        const r = editPath(ctx, p, 'shape.pointType', (segs, vs) => { pts.setType(segs, need(vs[p.index], 'shape.pointType', 'point'), p.type); return true; });
        // A straight point's handles can differ in length: remember the choice for handle drags.
        ctx.setView({editPoints: {...(view(ctx) ?? {id: target(ctx, p, 'shape.pointType').id}), vertex: [p.path ?? 0, p.index], segment: null, kind: p.type}});
        return r;
      }},
    {id: 'shape.moveHandle', label: 'Move Handle', risk: 'edit', state: hasSelection, description: '{path?: 0, index, side: in|out, x, y: slide pt, type?: smooth|straight|corner (default: read from the handles), id?}',
      params: s.object({path, index: idx, side: s.enum(['in', 'out']), x: num, y: num, type: s.optional(s.enum(['smooth', 'straight', 'corner'])), id: idP}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.moveHandle'), to = pt(p, 'shape.moveHandle');
        return editPath(ctx, p, 'shape.moveHandle', (segs, vs, x) => {
          const si = need(vs[p.index], 'shape.moveHandle', 'point');
          if (!pts.setHandle(segs, si, p.side === 'out', pts.toLocal(pts.affineOf(x), to), p.type)) throw bad('shape.moveHandle', 'that side of the point has no handle');
          return true;
        });
      }},
    {id: 'shape.deletePoint', label: 'Delete Point', risk: 'edit', state: hasSelection, description: '{path?: 0, index, id?}',
      params: s.object({path, index: idx, id: idP}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.deletePoint');
        return editPath(ctx, p, 'shape.deletePoint', (segs, vs) => {
        if (!pts.removeVertex(segs, need(vs[p.index], 'shape.deletePoint', 'point'))) throw bad('shape.deletePoint', 'an outline keeps at least two points');
        return true;
      }, true);
      }},
    {id: 'shape.deleteSegment', label: 'Delete Segment', risk: 'edit', state: hasSelection,
      description: "{path?: 0, segment: index of the vertex ending it, id?}: removes a segment of a closed outline, which opens there; it starts at the segment's end and ends at its start",
      params: s.object({path, segment: idx, id: idP}),
      run(ctx, p0) {
        const p = segp(ctx, p0, 'shape.deleteSegment');
        return editPath(ctx, p, 'shape.deleteSegment', (segs, vs) => {
        const si = need(vs[p.segment], 'shape.deleteSegment', 'segment');
        if (pts.endingSegment(segs, si) === undefined) throw bad('shape.deleteSegment', 'the first point of an open outline ends no segment');
        if (!pts.deleteSegmentAt(segs, si)) throw bad('shape.deleteSegment', 'only a segment of a closed outline can be deleted');
        return true;
      }, true);
      }},
    {id: 'shape.segmentType', label: 'Segment Type', risk: 'edit', state: hasSelection, description: "{path?: 0, segment: index of the vertex ending it, type: straight|curved, id?} — straight drops the segment's handles; curved gives it handles at its thirds",
      params: s.object({path, segment: idx, type: s.enum(['straight', 'curved']), id: idP}),
      run(ctx, p0) {
        const p = segp(ctx, p0, 'shape.segmentType');
        return editPath(ctx, p, 'shape.segmentType', (segs, vs) => {
        const si = need(vs[p.segment], 'shape.segmentType', 'segment');
        const j = pts.endingSegment(segs, si);
        if (j === undefined) throw bad('shape.segmentType', 'the first point of an open outline ends no segment');
        if (pts.segmentKind(segs, j) === (p.type === 'curved' ? 'curved' : 'straight')) return false;
        pts.setSegment(segs, j, p.type === 'curved');
        return true;
      });
      }},
    {id: 'shape.openPath', label: 'Open Path', risk: 'edit', state: hasSelection, description: '{path?: 0, index, id?} — break a closed outline at a point, which becomes its two ends',
      params: s.object({path, index: idx, id: idP}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.openPath');
        return editPath(ctx, p, 'shape.openPath', (segs, vs) => {
        if (!pts.openAt(segs, need(vs[p.index], 'shape.openPath', 'point'))) throw bad('shape.openPath', 'the outline is open already');
        return true;
      }, true);
      }},
    {id: 'shape.closePath', label: 'Close Path', risk: 'edit', state: hasSelection, description: '{path?: 0, index: any point of the open outline, id?} — join its ends with a straight segment (one point when they meet)',
      params: s.object({path, index: idx, id: idP}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.closePath');
        return editPath(ctx, p, 'shape.closePath', (segs, vs) => {
        if (!pts.closeAt(segs, need(vs[p.index], 'shape.closePath', 'point'))) throw bad('shape.closePath', 'the outline is closed already');
        return true;
      }, true);
      }},
  ],
});
void targets;
