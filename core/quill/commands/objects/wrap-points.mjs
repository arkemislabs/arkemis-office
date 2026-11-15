// Layout and Picture, Shape Format › Arrange › Wrap Text › Edit Wrap Points, and Set as Default Layout.
//
// Not checked against upstream (wordcraft keeps and reads a wrap polygon, crates/doc wrap.rs, and lays Tight and Through text round it, but has no way
// to edit one; these follow Word):
// - Edit Wrap Points shows the outline text follows round a Tight or Through object as a polygon with a handle at each point (`view.wrapPoints`);
//   the first use makes the wrapping Tight and gives the object a wrap polygon of its own outline (a shape's geometry, a picture's rectangle), saved as
//   wp:wrapPolygon edited="1". `wrap.movePoint`, `wrap.addPoint` and `wrap.deletePoint` change it (a polygon keeps at least three points), `wrap.reset`
//   takes the edited polygon off again. Coordinates are fractions of the object (0 to 1 across it; a point may lie outside, as Word allows).
// - Set as Default Layout keeps the selected object's wrapping (and the sides text flows on and its distance from the text) in the person's settings;
//   a picture, shape, text box or canvas inserted afterwards starts with it.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import * as P from '../../model/para.mjs';
import {shapeOutline, wrapPolygonFromUnit, wrapPolygonUnit, MAX_WRAP_POINTS} from '../../model/wrap.mjs';
import {stateFor, target, editAt, finish, isPicture, isShape, NO_OBJECT} from '../../lib/object-edit.mjs';
import {viewOf} from '../../lib/view-layout.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/doc/src/wrap.rs']};
const NONE = s.object({});
const bad = m => new CommandError('invalid_params', m);
const OK = 'select a picture or shape first';
const ok = o => (isPicture(o) || isShape(o) ? null : OK);
const objState = stateFor(ok, OK);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The wrap polygon of the object, or the outline it would get: a shape's own geometry, else its rectangle. */
function startingPolygon(o) {
  const unit = isShape(o) && o.kind !== 'freeform' ? shapeOutline(o.kind ?? 'rectangle', o.w, o.h, o.corner ?? null) : null;
  return unit && unit.length >= 3 ? unit : [[0, 0], [0, 1], [1, 1], [1, 0]];
}

const polygonOf = o => (o.float?.wrapPolygon?.points?.length >= 3 ? wrapPolygonUnit(o.float.wrapPolygon) : null);
const withPolygon = (o, unit) => ({...o, float: {...(o.float ?? P.defaultFloat()), wrapPolygon: wrapPolygonFromUnit(true, unit)}});

function editWrapPoints(ctx, p) {
  const cur = !!viewOf(ctx.view).wrapPoints;
  const on = typeof p.value === 'boolean' ? p.value : !cur;
  if (!on) { ctx.setView({wrapPoints: false}); return {value: false}; }
  const {S, pos, obj} = target(ctx, ok, OK);
  const next = editAt(S, pos, o => {
    const f = {...(o.float ?? P.defaultFloat())};
    if (f.wrap !== 'tight' && f.wrap !== 'through') f.wrap = 'tight';
    return withPolygon({...o, float: f}, polygonOf(o) ?? startingPolygon(o));
  });
  ctx.setView({wrapPoints: true});
  return finish(ctx, S, {edit: true, result: {value: true, object: next, points: polygonOf(next)?.length ?? 0}});
}

function change(ctx, f) {
  const {S, pos} = target(ctx, ok, OK);
  const next = editAt(S, pos, o => {
    const unit = polygonOf(o) ?? startingPolygon(o);
    return withPolygon(o, f(unit.map(q => [...q])) ?? unit);
  });
  return finish(ctx, S, {edit: true, result: {object: next, points: polygonOf(next)?.length ?? 0}});
}
const coord = (v, k) => { if (!Number.isFinite(v)) throw bad(`\`${k}\` is a fraction of the object`); return clamp(v, -2, 3); };

const stateEditing = ctx => { const st = objState(ctx); return st.enabled ? {...st, checked: !!viewOf(ctx.view).wrapPoints} : st; };
const layoutOf = f => ({wrap: f.wrap ?? 'inline', ...(f.wrapText ? {wrapText: f.wrapText} : {}), dist: f.dist ?? 0, distTop: f.distTop ?? 0, distBottom: f.distBottom ?? 0});

export default defineCommands({
  family: 'objects/wrap-points',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'arrange.editWrapPoints', label: 'Edit Wrap Points', risk: 'edit', state: stateEditing,
      description: 'Edit Wrap Points (Layout, Picture and Shape Format › Wrap Text): shows or hides (`value`) the handles of the wrap polygon of the selected picture or shape; the first time it makes the wrapping Tight with a polygon of the object\'s outline. Not checked against upstream.',
      params: s.object({value: s.optional(s.boolean())}), run: editWrapPoints},
    {id: 'wrap.movePoint', label: 'Move Wrap Point', risk: 'edit', state: objState,
      description: 'Move Wrap Point: point `index` of the selected object\'s wrap polygon to (`x`, `y`) as fractions of the object. Not checked against upstream.',
      params: s.object({index: s.integer({min: 0, max: MAX_WRAP_POINTS}), x: s.number(), y: s.number()}),
      run: (ctx, p) => change(ctx, pts => {
        if (p.index >= pts.length) throw bad('no such point');
        pts[p.index] = [coord(p.x, 'x'), coord(p.y, 'y')];
        return pts;
      })},
    {id: 'wrap.addPoint', label: 'Add Wrap Point', risk: 'edit', state: objState,
      description: 'Add Wrap Point: a new point after point `index` of the wrap polygon, at (`x`, `y`) as fractions of the object (the middle of that side when omitted). Not checked against upstream.',
      params: s.object({index: s.integer({min: 0, max: MAX_WRAP_POINTS}), x: s.optional(s.number()), y: s.optional(s.number())}),
      run: (ctx, p) => change(ctx, pts => {
        if (p.index >= pts.length) throw bad('no such point');
        if (pts.length >= MAX_WRAP_POINTS) throw new CommandError('failed', 'the polygon has as many points as it can');
        const a = pts[p.index], b = pts[(p.index + 1) % pts.length];
        pts.splice(p.index + 1, 0, [p.x === undefined ? (a[0] + b[0]) / 2 : coord(p.x, 'x'), p.y === undefined ? (a[1] + b[1]) / 2 : coord(p.y, 'y')]);
        return pts;
      })},
    {id: 'wrap.deletePoint', label: 'Delete Wrap Point', risk: 'edit', state: objState,
      description: 'Delete Wrap Point: point `index` of the wrap polygon goes; a polygon keeps at least three. Not checked against upstream.',
      params: s.object({index: s.integer({min: 0, max: MAX_WRAP_POINTS})}),
      run: (ctx, p) => change(ctx, pts => {
        if (p.index >= pts.length) throw bad('no such point');
        if (pts.length <= 3) throw new CommandError('failed', 'a wrap polygon needs at least three points');
        pts.splice(p.index, 1);
        return pts;
      })},
    {id: 'wrap.reset', label: 'Reset Wrap Points', risk: 'edit', state: objState,
      description: 'Reset Wrap Points: the edited wrap polygon of the selected object goes, and text follows the object\'s own outline again. Not checked against upstream.',
      params: NONE,
      run(ctx) {
        const {S, pos} = target(ctx, ok, OK);
        const next = editAt(S, pos, o => { const f = {...(o.float ?? P.defaultFloat())}; delete f.wrapPolygon; return {...o, float: f}; });
        return finish(ctx, S, {edit: true, result: {object: next}});
      }},
    {id: 'arrange.setDefaultLayout', label: 'Set as Default Layout', risk: 'read', effect: 'prefs', state: stateFor(o => (isPicture(o) || isShape(o) || o?.type === 'graphic' ? null : NO_OBJECT), NO_OBJECT),
      description: 'Set as Default Layout (Layout, Picture, Shape and Chart Format › Wrap Text): the selected object\'s wrapping, the sides text flows on and its distance from the text become what a picture, shape, text box or canvas inserted afterwards starts with. Not checked against upstream.',
      params: NONE,
      run(ctx) {
        const {obj} = target(ctx, o => (isPicture(o) || isShape(o) || o?.type === 'graphic' ? null : NO_OBJECT), NO_OBJECT);
        const layout = layoutOf(obj.float ?? P.defaultFloat());
        ctx.updatePrefs({defaultLayout: layout});
        return {layout};
      }},
  ],
});
