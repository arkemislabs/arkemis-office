// Shape Format › Edit Shape › Edit Points: turn the selected shape into a freeform and move, add or delete the vertices of its
// outline, change point and segment types, move a point's handles, open and close the outline.
//
// wordcraft has no Edit Points, so this is not checked against upstream for Word. The path engine is PowerPoint's
// (core/prism/lib/points.mjs, deckcraft crates/engine/src/cmd/points.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf, MIT, see
// assets/third-party-licenses/artcraft-reference.txt), imported and not edited; the commands keep Prism's ids and parameters.
// Coordinates are page points on the page the shape is on (Prism's are slide points). Entering Edit Points makes the shape a
// freeform whose paths keep their curves (lib/shape-points.mjs); after each change the box is fitted round the outline again
// and a floating shape stays where it was on the page. Edit Points itself is view state (`view.editPoints`): the vertex whose
// handles show, the segment last picked, the remembered point type. The pointer layer (surface/EditPoints.tsx) drags vertices and
// handles, Ctrl-click adds or deletes, and right-click picks a vertex or segment for its menu (`view.editPointsPick`).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {UPSTREAM_COMMIT, ready} from '../../lib/caret-session.mjs';
import {open, finish, selectedIn, objectHit, editAt, disabled, reasonFor, NO_SHAPE} from '../../lib/object-edit.mjs';
import {editableShape, isEdited, editableOf, written, pts} from '../../lib/shape-points.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: []};
const bad = (cmd, msg) => new CommandError('invalid_params', `${cmd}: ${msg}`);
const path = s.optional(s.integer({min: 0})), idx = s.optional(s.integer({min: 0}));
const num = s.number();
const WHY = 'select a shape that has an outline first';

/** The one selected shape and where the layout put it: {S, pos, obj, rect}. */
function pick(ctx) {
  const S = open(ctx);
  const hit = selectedIn(S.d, S.sel);
  if (!hit || !editableShape(hit.obj)) throw disabled(hit ? WHY : NO_SHAPE);
  const where = objectHit(ctx, hit.pos);
  if (!where) throw new CommandError('failed', "the shape isn't laid out");
  return {S, pos: hit.pos, obj: hit.obj, rect: where.rect};
}

const view = ctx => ctx.view?.editPoints ?? null;
/** The editing state, while the selected shape is still a freeform of path data (after Undo takes the conversion back, Edit Points is over). */
function editing(ctx) {
  const e = view(ctx);
  if (!e) return null;
  try {
    const d = ctx.model.open(ctx);
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    return isEdited(selectedIn(d, {anchor: r.anchor, focus: r.focus})?.obj) ? e : null;
  } catch { return null; }
}
const forgetKind = (ctx, pathIndex) => {
  const e = view(ctx);
  if (e?.vertex && e.vertex[0] === pathIndex) ctx.setView({editPoints: {...e, vertex: null}});
};

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
const at = (p, cmd) => {
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y))) throw bad(cmd, 'give `x` and `y` in page points');
  return {x: Math.min(Math.max(p.x, -1e5), 1e5), y: Math.min(Math.max(p.y, -1e5), 1e5)};
};

/** Runs `f(segs, vertexSegments, xfrm)` on path `p.path` of the shape's outline, refits the box and writes the shape back (one undo step). */
function editPath(ctx, p, cmd, f, forget = false) {
  const {S, pos, obj, rect} = pick(ctx);
  const sh = editableOf(obj, rect);
  const pathIndex = p.path ?? 0;
  const cp = sh.geom.paths[pathIndex];
  if (!cp) throw bad(cmd, 'no such path');
  const segs = pts.parse(cp.d), vs = pts.vertices(segs);
  if (!f(segs, vs, sh.xfrm)) return {};
  cp.d = pts.write(segs);
  pts.refit(sh);
  editAt(S, pos, o => written(o, {x: rect.x, y: rect.y, w: rect.w, h: rect.h}, sh));
  const out = finish(ctx, S, {edit: true, result: {}});
  if (forget) forgetKind(ctx, pathIndex);
  return out;
}

const stateShape = ctx => {
  const r = reasonFor(ctx, o => (editableShape(o) ? null : WHY), NO_SHAPE);
  return r ? {enabled: false, reason: r} : {enabled: true};
};

/** Open Path shows for the point picked on a closed outline, Close Path for one on an open outline (the point menu leaves the other out). */
const stateWhen = closedWanted => ctx => {
  const st = stateShape(ctx);
  const v = view(ctx)?.vertex;
  if (!st.enabled || !v) return st;
  try {
    const {obj, rect} = pick(ctx);
    const closed = pts.closedAt(editableOf(obj, rect), v[0], v[1]);
    return closed === null || closed === closedWanted ? st : {enabled: false, hidden: true, reason: closedWanted ? 'the outline is open already' : 'the outline is closed already'};
  } catch { return st; }
};

export default defineCommands({
  family: 'objects/points',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.editPoints', label: 'Edit Points', risk: 'edit',
      // Leaving Edit Points always works (the surface ends it when something else is selected).
      state: (ctx, p) => { const st = stateShape(ctx); return st.enabled || p?.on === false ? {enabled: true, checked: !!editing(ctx)} : st; },
      description: '{on?: bool (default: toggle)} — enter or leave Edit Points for the selected shape; entering turns a preset shape into a freeform that keeps its curves',
      params: s.object({on: s.optional(s.boolean())}),
      run(ctx, p) {
        const on = p.on ?? !editing(ctx);
        if (!on) { ready(ctx); ctx.setView({editPoints: null}); return {editing: false}; }
        const {S, pos, obj, rect} = pick(ctx);
        let out = {};
        if (!isEdited(obj)) {
          const sh = editableOf(obj, rect);
          editAt(S, pos, o => written(o, {x: rect.x, y: rect.y, w: rect.w, h: rect.h}, sh));
          out = finish(ctx, S, {edit: true, result: {}});
        }
        ctx.setView({editPoints: {vertex: null, segment: null}});
        return {...out, editing: true};
      }},
    {id: 'shape.points', label: 'Points', risk: 'read', effect: 'view', state: stateShape,
      description: '{} → {paths: [[[x, y] page pt]], types: [[smooth|straight|corner]], segments: [[straight|curved|null]]}: the vertices of the selected shape\'s outline, with each point\'s type and the kind of the segment ending at it',
      params: s.object({}),
      run(ctx) {
        const {obj, rect} = pick(ctx);
        const sh = editableOf(obj, rect), d = pts.describe(sh);
        return {paths: pts.slideVertices(sh, sh.xfrm).map(v => v.map(q => [q.x, q.y])), types: d.types, segments: d.kinds};
      }},
    {id: 'shape.movePoint', label: 'Move Point', risk: 'edit', state: stateShape, description: '{path?: 0, index, x, y: page pt}',
      params: s.object({path, index: idx, x: num, y: num}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.movePoint'), to = at(p, 'shape.movePoint');
        return editPath(ctx, p, 'shape.movePoint', (segs, vs, x) => {
          const si = need(vs[p.index], 'shape.movePoint', 'point');
          const local = pts.toLocal(pts.affineOf(x), to), cur = segs[si].pts.at(-1);
          pts.moveVertex(segs, si, {x: local.x - cur.x, y: local.y - cur.y});
          return true;
        });
      }},
    {id: 'shape.addPoint', label: 'Add Point', risk: 'edit', state: stateShape, description: '{path?: 0, segment: index of the vertex ending it, t?: 0..1 (0.5)}',
      params: s.object({path, segment: idx, t: s.optional(num)}),
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
    {id: 'shape.pointType', label: 'Point Type', risk: 'edit', state: stateShape, description: '{path?: 0, index, type: smooth|straight|corner} — smooth: handles in line and equal; straight: in line; corner: independent',
      params: s.object({path, index: idx, type: s.enum(['smooth', 'straight', 'corner'])}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.pointType');
        const r = editPath(ctx, p, 'shape.pointType', (segs, vs) => { pts.setType(segs, need(vs[p.index], 'shape.pointType', 'point'), p.type); return true; });
        // A straight point's handles can differ in length: remember the choice for handle drags.
        ctx.setView({editPoints: {...(view(ctx) ?? {}), vertex: [p.path ?? 0, p.index], segment: null, kind: p.type}});
        return r;
      }},
    {id: 'shape.moveHandle', label: 'Move Handle', risk: 'edit', state: stateShape, description: '{path?: 0, index, side: in|out, x, y: page pt, type?: smooth|straight|corner (default: read from the handles)}',
      params: s.object({path, index: idx, side: s.enum(['in', 'out']), x: num, y: num, type: s.optional(s.enum(['smooth', 'straight', 'corner']))}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.moveHandle'), to = at(p, 'shape.moveHandle');
        return editPath(ctx, p, 'shape.moveHandle', (segs, vs, x) => {
          const si = need(vs[p.index], 'shape.moveHandle', 'point');
          if (!pts.setHandle(segs, si, p.side === 'out', pts.toLocal(pts.affineOf(x), to), p.type)) throw bad('shape.moveHandle', 'that side of the point has no handle');
          return true;
        });
      }},
    {id: 'shape.deletePoint', label: 'Delete Point', risk: 'edit', state: stateShape, description: '{path?: 0, index}',
      params: s.object({path, index: idx}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.deletePoint');
        return editPath(ctx, p, 'shape.deletePoint', (segs, vs) => {
          if (!pts.removeVertex(segs, need(vs[p.index], 'shape.deletePoint', 'point'))) throw bad('shape.deletePoint', 'an outline keeps at least two points');
          return true;
        }, true);
      }},
    {id: 'shape.deleteSegment', label: 'Delete Segment', risk: 'edit', state: stateShape,
      description: "{path?: 0, segment: index of the vertex ending it}: removes a segment of a closed outline, which opens there; it starts at the segment's end and ends at its start",
      params: s.object({path, segment: idx}),
      run(ctx, p0) {
        const p = segp(ctx, p0, 'shape.deleteSegment');
        return editPath(ctx, p, 'shape.deleteSegment', (segs, vs) => {
          const si = need(vs[p.segment], 'shape.deleteSegment', 'segment');
          if (pts.endingSegment(segs, si) === undefined) throw bad('shape.deleteSegment', 'the first point of an open outline ends no segment');
          if (!pts.deleteSegmentAt(segs, si)) throw bad('shape.deleteSegment', 'only a segment of a closed outline can be deleted');
          return true;
        }, true);
      }},
    {id: 'shape.segmentType', label: 'Segment Type', risk: 'edit', state: stateShape, description: "{path?: 0, segment: index of the vertex ending it, type: straight|curved} — straight drops the segment's handles; curved gives it handles at its thirds",
      params: s.object({path, segment: idx, type: s.enum(['straight', 'curved'])}),
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
    {id: 'shape.openPath', label: 'Open Path', risk: 'edit', state: stateWhen(true), description: '{path?: 0, index} — break a closed outline at a point, which becomes its two ends',
      params: s.object({path, index: idx}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.openPath');
        return editPath(ctx, p, 'shape.openPath', (segs, vs) => {
          if (!pts.openAt(segs, need(vs[p.index], 'shape.openPath', 'point'))) throw bad('shape.openPath', 'the outline is open already');
          return true;
        }, true);
      }},
    {id: 'shape.closePath', label: 'Close Path', risk: 'edit', state: stateWhen(false), description: '{path?: 0, index: any point of the open outline} — join its ends with a straight segment (one point when they meet)',
      params: s.object({path, index: idx}),
      run(ctx, p0) {
        const p = vtx(ctx, p0, 'shape.closePath');
        return editPath(ctx, p, 'shape.closePath', (segs, vs) => {
          if (!pts.closeAt(segs, need(vs[p.index], 'shape.closePath', 'point'))) throw bad('shape.closePath', 'the outline is closed already');
          return true;
        }, true);
      }},
    {id: 'view.editPointsPick', label: 'Pick Point', risk: 'read', effect: 'view', state: stateShape,
      description: '{vertex?: [path, index] | null, segment?: [path, vertex ending it, t] | null} — the point or segment Edit Points acts on next (the pointer layer sets it on a click or a right-click; the point menus read it)',
      params: s.object({vertex: s.optional(s.array(s.integer({min: 0}))), segment: s.optional(s.array(s.number()))}),
      run(ctx, p) {
        ready(ctx);
        const e = view(ctx);
        if (!e) throw disabled('turn on Edit Points first');
        ctx.setView({editPoints: {...e, vertex: p.vertex?.length === 2 ? p.vertex : null, segment: p.segment?.length === 3 ? p.segment : null}});
        return {};
      }},
  ],
});
