// Writing strokes into a page (Draw tab; U:slate/draw): one place that adds, replaces and removes
// strokes so the pen, the shapes, Ink to Shape and the bridge all go through the same checks.
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {LIMITS} from '../schema.mjs';
import {normalizeStroke} from '../model/canvas.mjs';
import {recognize, shapePolylines} from './shapes.mjs';
import {beforeEdit, stampEdit} from './history.mjs';

const iso = ctx => new Date(ctx.host.now()).toISOString();
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };

export const newStrokeId = ctx => `k${ctx.host.uid()}`;
export const newGroupId = ctx => `g${ctx.host.uid()}`;

function pageInk(ctx, pageId) {
  const page = ctx.doc.pages[pageId];
  need(page, 'not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  return page.ink;
}

/** Append strokes (records without ids) to a page; returns their ids. */
export function addStrokes(ctx, pageId, strokes) {
  const ink = pageInk(ctx, pageId);
  need(ink.length + strokes.length <= LIMITS.strokes, 'too_large', `A page holds at most ${LIMITS.strokes} strokes`);
  const made = strokes.map(s => normalizeStroke(s, s.id ?? newStrokeId(ctx)));
  for (const s of made) need(!ink.some(x => x.id === s.id) && made.filter(y => y.id === s.id).length === 1, 'invalid_params', `Stroke ${s.id} already exists`);
  beforeEdit(ctx, pageId);
  ctx.change.set(['pages', pageId, 'ink'], [...ink, ...made]);
  stampEdit(ctx, pageId);
  return made.map(s => s.id);
}

/** Replace the whole ink array of a page (an edit that changes many strokes at once). */
export function setInk(ctx, pageId, ink) {
  need(ink.length <= LIMITS.strokes, 'too_large', `A page holds at most ${LIMITS.strokes} strokes`);
  beforeEdit(ctx, pageId);
  ctx.change.set(['pages', pageId, 'ink'], ink);
  stampEdit(ctx, pageId);
}

/** The strokes of a shape: its polylines in the pen's colour and width, sharing one group. */
export function shapeStrokes(ctx, shape, from, to, style) {
  const group = newGroupId(ctx);
  return shapePolylines(shape, from, to).map(points => ({tool: style.tool, color: style.color, width: style.width, points,
    ...(style.fx ? {fx: style.fx} : {}), group, shape}));
}

/**
 * Ink to Shape: a stroke that is recognised as a shape becomes that shape's strokes (same pen); any
 * other stroke is returned as it is.
 */
export function snapStroke(ctx, stroke) {
  const hit = recognize(stroke.points);
  if (!hit) return {strokes: [stroke], shape: null};
  return {strokes: shapeStrokes(ctx, hit.shape, hit.from, hit.to, stroke), shape: hit.shape};
}
