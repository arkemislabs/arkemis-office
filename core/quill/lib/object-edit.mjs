// Picture Format and Shape Format: finding the selected picture, shape, text box or canvas and changing it in
// one undoable step.
//
// Translated from wordcraft crates/engine/src/cmd/objects/select.rs (`selected`, `selected_all`, `has_picture`,
// `has_shape`, `has_shape_or_canvas`, `has_object`, `has_movable`, `has_sizable`, `with_obj`, `edit_obj`,
// `obj_size`, `text_box_target`, `min_size`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The same helpers are in objects/arrange.mjs (Layout ›
// Arrange); they are copied here so the two tabs do not depend on that file. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {open, finish, ready, ordered, samePos, layoutFor} from './caret-session.mjs';
import {selectedObjects} from '../context.mjs';
import * as P from '../model/para.mjs';

export const FROZEN = "diagrams can't be moved or resized yet";
export const disabled = reason => new CommandError('disabled', reason);

/** The first drawing in the selection (or just before a collapsed caret): {pos, obj}, or null. */
export function selectedIn(d, sel) {
  const [a, b] = ordered(sel);
  if (a.story !== b.story) return null;
  return selectedObjects(d.content, a, b, 1)[0] ?? null;
}

/** The drawings in the selection, at most `max`. */
export function selectedAll(d, sel, max = 10000) {
  const [a, b] = ordered(sel);
  if (a.story !== b.story) return [];
  return selectedObjects(d.content, a, b, max);
}

/** The reason `ok` fails for the selected drawing, or null when it holds (`ok(obj)`: string reason | null). */
export function reasonFor(ctx, ok, none) {
  const st = ready(ctx);
  if (!st.enabled) return st.reason;
  try {
    const d = ctx.model.open(ctx);
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    const hit = selectedIn(d, {anchor: r.anchor, focus: r.focus});
    if (!hit) return none;
    return ok(hit.obj, d, hit);
  } catch { return none; }
}

/** A command `state` for the selected drawing: enabled when `ok` returns null (else its reason). */
export const stateFor = (ok, none, extra = null) => ctx => {
  const reason = reasonFor(ctx, ok, none);
  if (reason) return {enabled: false, reason};
  if (!extra) return {enabled: true};
  try {
    const d = ctx.model.open(ctx);
    const r = ctx.model.selection(ctx)[ctx.selection?.primary ?? 0] ?? ctx.model.selection(ctx)[0];
    return {enabled: true, ...extra(selectedIn(d, {anchor: r.anchor, focus: r.focus}).obj, ctx, d)};
  } catch { return {enabled: true}; }
};

export const isPicture = o => o?.type === 'image';
export const isShape = o => o?.type === 'shape';
export const isShapeOrCanvas = o => o?.type === 'shape' || P.isCanvas(o);
/** has_movable: charts and diagrams are frozen (a chart with its data is resized, a diagram is not). */
export const movable = o => (o?.type === 'graphic' && !o.graphic?.chart ? FROZEN : null);
export const NO_PICTURE = 'select a picture first';
export const NO_SHAPE = 'select a shape first';
export const NO_OBJECT = 'select a picture or shape first';

/** A drawing's size [w, h], points (obj_size). */
export const sizeOf = o => [Number.isFinite(o?.w) ? o.w : 0, Number.isFinite(o?.h) ? o.h : 0];

/** The selected drawing and the session: throws `disabled` (with `reason`) when `ok` fails. */
export function target(ctx, ok, none) {
  const S = open(ctx);
  const hit = selectedIn(S.d, S.sel);
  if (!hit) throw disabled(none);
  const why = ok(hit.obj, S.d, hit);
  if (why) throw disabled(why);
  return {S, ...hit};
}

/**
 * Change the drawing at `pos` through `f(obj) -> newObj` (edit_obj): the paragraph is copied for writing and the
 * object replaced. Returns the new object.
 */
export function editAt(S, pos, f) {
  const para = S.d.paraMut(pos.story, pos.path);
  const cur = P.objectAt(para, pos.off);
  if (!cur) throw new CommandError('failed', 'object vanished');
  const next = f(cur);
  P.setObjectAt(para, pos.off, next);
  return next;
}

/** with_obj: change the selected drawing and commit (one undo step); the result carries the new object. */
export function withObject(ctx, ok, none, f, extra = {}) {
  const {S, pos} = target(ctx, ok, none);
  const next = editAt(S, pos, f);
  return finish(ctx, S, {edit: true, result: {object: next, ...extra}});
}

export {open, finish, ready, ordered, samePos};

// ---- several objects at once (Shift+click, Group, Align, Distribute) -------------------------------------------------------


const posKey = p => `${p.story}|${p.path.join('.')}|${p.off}`;
export const samePlace = (a, b) => posKey(a) === posKey(b);

/**
 * The pictures, shapes, text boxes and groups the selection holds: the first drawing of each of its ranges (the object
 * Shift+click added is a range of its own), the primary range's first (picked_objects). [{pos, obj}]
 */
export function pickedAll(S) {
  const ranges = S.ctx.model.selection(S.ctx);
  const first = ranges[S.ctx.selection?.primary ?? 0] ?? ranges[0];
  const out = [], seen = new Set();
  for (const r of [first, ...ranges.filter(x => x !== first)]) {
    const [a, b] = ordered({anchor: S.d.clamp(r.anchor), focus: S.d.clamp(r.focus)});
    if (a.story !== b.story) continue;
    for (const h of selectedObjects(S.d.content, a, b, a.off === b.off && samePath2(a, b) ? 1 : 10000)) {
      const k = posKey(h.pos);
      if (!seen.has(k)) { seen.add(k); out.push(h); }
    }
  }
  return out;
}
const samePath2 = (a, b) => a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);

/** Where the layout put the drawing at `pos`: {page, rect, origin, rot} (layout.object), or null when it isn't laid out. */
export function objectHit(ctx, pos) {
  const lay = layoutFor(ctx);
  const is = it => it.kind === 'object' && it.story === pos.story && it.off === pos.off && it.path.length === pos.path.length && it.path.every((v, i) => v === pos.path[i]);
  for (let pi = 0; pi < (lay?.pages?.length ?? 0); pi++) {
    const it = lay.pages[pi].items.find(is);
    if (it) return {page: pi, rect: it.rect, origin: it.origin ?? {x: it.rect.x, y: it.rect.y}, rot: it.rot ?? 0, wrap: it.wrap};
  }
  return null;
}

/** Every drawing of the body in reading order (all_objects): [{pos, obj}]. */
export function allObjects(S) {
  const out = [];
  for (const path of S.d.paraPaths('body')) {
    const para = S.d.para('body', path);
    for (const [off, obj] of P.objectsWithOffsets(para)) if (P.isDrawing(obj)) out.push({pos: {story: 'body', path, off}, obj});
  }
  return out;
}

/** Select drawings: the first is the primary range, the others ranges of their own. */
export function selectPicks(ctx, S, positions) {
  const ranges = positions.map(p => ({anchor: {...p, path: [...p.path]}, focus: {...p, path: [...p.path], off: p.off + 1}}));
  S.sel = ranges[0];
  ctx.model.setSelection(ctx, ranges);
  return ranges;
}
