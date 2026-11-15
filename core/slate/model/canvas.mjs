// The page canvas: note containers, ProseMirror steps and ink (F:slate foundation).
//
// Slate has no ArtCraft upstream; behaviour follows OneNote's page surface (docs/spec/slate.json
// panes › page-canvas): clicking anywhere on the page starts a note container at that point,
// containers are moved by their top bar and resized by their width handle, and ink lies on its
// own layer over the notes (pen strokes and highlighter strokes, erased stroke by stroke).
//
// Text edits are ProseMirror steps applied through the kernel app op (schema.mjs `apply`), so
// the same edit runs headless and in the editor and undo maps the caret. Ink strokes are plain
// JSON records on the page (`pages[id].ink`).
//
// No DOM, no Node built-ins.

import {ReplaceStep, AttrStep, Transform} from '@tiptap/pm/transform';
import {Slice, Fragment} from '@tiptap/pm/model';
import {CommandError} from '../../kernel/errors.mjs';
import {INK_FX, INK_KINDS, LIMITS, nodeOf} from '../schema.mjs';
import {blockIndex, containerNode, findContainer} from './page.mjs';
import {authorOf, beforeEdit, stampEdit} from '../lib/history.mjs';

const iso = ctx => new Date(ctx.host.now()).toISOString();
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const pageOf = (ctx, pageId) => {
  const page = ctx.doc?.pages?.[pageId];
  need(page, 'not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  return page;
};

/** The current ProseMirror doc of a page inside the transaction. */
export const pageDoc = (ctx, pageId) => nodeOf(pageOf(ctx, pageId).body);

/** Apply ProseMirror steps (JSON) to a page body. Returns the number of steps applied. */
export function applySteps(ctx, pageId, steps) {
  pageOf(ctx, pageId);
  need(Array.isArray(steps), 'invalid_params', 'steps must be an array', {path: '/steps'});
  if (!steps.length) return 0;
  beforeEdit(ctx, pageId);
  const recording = ctx.view?.recording;
  const before = recording && recording.page === pageId && !recording.paused ? pageDoc(ctx, pageId) : null;
  ctx.change.apply({type: 'steps', page: pageId, steps, modified: iso(ctx), by: authorOf(ctx)});
  if (before) linkNotes(ctx, pageId, before, recording);
  return steps.length;
}

/**
 * Notes typed while a recording runs are linked to its moment (OneNote's audio search by time): a
 * paragraph that is new or whose text changed gets `audio: {media, t}` (seconds into the
 * recording) unless it has one already. The recording's own embedded object is not a note.
 */
function linkNotes(ctx, pageId, before, recording) {
  const after = pageDoc(ctx, pageId);
  const was = blockIndex(before);
  const t = Math.max(0, Math.round((ctx.host.now() - recording.start - (recording.pausedFor ?? 0)) / 100) / 10);
  const tr = new Transform(after);
  after.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (node.attrs.audio || !node.textContent.trim()) return false;
    const old = was.get(node.attrs.id)?.node;
    if (old && old.textContent === node.textContent) return false;
    tr.setNodeAttribute(pos, 'audio', {media: recording.id, t});
    return false;
  });
  if (tr.steps.length) ctx.change.apply({type: 'steps', page: pageId, steps: tr.steps.map(s => s.toJSON())});
}

/** Default width of a new note container (OneNote grows it with the text up to this). */
export const DEFAULT_CONTAINER_WIDTH = null;
export const MIN_CONTAINER_WIDTH = 48;

/**
 * Start a note container at (x, y) in page px (OneNote: click anywhere and type). `text` lines
 * become paragraphs. Returns {container, paragraph} ids.
 * @param {any} ctx
 * @param {string} pageId
 * @param {{x: number, y: number, width?: number|null, text?: string, id?: string}} opts
 */
export function insertContainer(ctx, pageId, {x, y, width = null, text = '', id}) {
  need(Number.isFinite(x) && Number.isFinite(y), 'invalid_params', 'x and y are page coordinates in px');
  need(x >= 0 && y >= 0 && x <= 50000 && y <= 500000, 'invalid_params', 'The point is outside the page');
  need(width === null || (Number.isFinite(width) && width >= MIN_CONTAINER_WIDTH && width <= 20000), 'invalid_params', `A container is at least ${MIN_CONTAINER_WIDTH} px wide`);
  const doc = pageDoc(ctx, pageId);
  const cid = id ?? `c${ctx.host.uid()}`;
  const node = containerNode({id: cid, x: Math.round(x), y: Math.round(y), width: width === null ? null : Math.round(width), text}, () => `b${ctx.host.uid()}`);
  const end = doc.content.size;
  applySteps(ctx, pageId, [new ReplaceStep(end, end, new Slice(Fragment.from(node), 0, 0)).toJSON()]);
  return {container: cid, paragraph: node.firstChild.attrs.id};
}

/** Move a note container to (x, y) (dragging its top bar). */
export function moveContainer(ctx, pageId, containerId, {x, y}) {
  need(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 50000 && y <= 500000, 'invalid_params', 'x and y are page coordinates in px');
  const {pos, node} = findContainer(pageDoc(ctx, pageId), containerId, `/pg:${pageId}/c:${containerId}`);
  const steps = [];
  if (node.attrs.x !== Math.round(x)) steps.push(new AttrStep(pos, 'x', Math.round(x)).toJSON());
  if (node.attrs.y !== Math.round(y)) steps.push(new AttrStep(pos, 'y', Math.round(y)).toJSON());
  return applySteps(ctx, pageId, steps) > 0;
}

/** Set a note container's width (its resize handle); null lets it size to its text. */
export function resizeContainer(ctx, pageId, containerId, width) {
  need(width === null || (Number.isFinite(width) && width >= MIN_CONTAINER_WIDTH && width <= 20000), 'invalid_params', `A container is at least ${MIN_CONTAINER_WIDTH} px wide`);
  const {pos, node} = findContainer(pageDoc(ctx, pageId), containerId, `/pg:${pageId}/c:${containerId}`);
  const w = width === null ? null : Math.round(width);
  if (node.attrs.width === w) return false;
  applySteps(ctx, pageId, [new AttrStep(pos, 'width', w).toJSON()]);
  return true;
}

/** Delete a note container with everything in it. */
export function deleteContainer(ctx, pageId, containerId) {
  const {pos, node} = findContainer(pageDoc(ctx, pageId), containerId, `/pg:${pageId}/c:${containerId}`);
  applySteps(ctx, pageId, [new ReplaceStep(pos, pos + node.nodeSize, Slice.empty).toJSON()]);
}

// ---------------------------------------------------------------------------------------------
// Ink

export const INK_TOOLS = INK_KINDS;

/** Validate and normalize a stroke: points are page px, rounded to 0.1 px. */
export function normalizeStroke(stroke, id) {
  need(stroke && typeof stroke === 'object', 'invalid_params', 'A stroke is an object');
  need(INK_TOOLS.includes(stroke.tool), 'invalid_params', 'A stroke is drawn with a pen, a pencil or a highlighter', {path: '/stroke/tool'});
  need(typeof stroke.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(stroke.color), 'invalid_params', 'A stroke colour is #RRGGBB', {path: '/stroke/color'});
  need(Number.isFinite(stroke.width) && stroke.width > 0 && stroke.width <= 200, 'invalid_params', 'A stroke width is 0–200 px', {path: '/stroke/width'});
  const pts = stroke.points;
  need(Array.isArray(pts) && pts.length >= 2 && pts.length % 2 === 0 && pts.length <= LIMITS.points && pts.every(Number.isFinite),
    'invalid_params', 'points is a flat list of x, y pairs', {path: '/stroke/points'});
  const points = pts.map(v => Math.round(v * 10) / 10);
  need(stroke.fx === undefined || stroke.fx === null || INK_FX.includes(stroke.fx), 'invalid_params', 'A stroke fx is galaxy or rainbow', {path: '/stroke/fx'});
  need(stroke.group === undefined || (typeof stroke.group === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(stroke.group)), 'invalid_params', 'A stroke group is an id', {path: '/stroke/group'});
  need(stroke.shape === undefined || (typeof stroke.shape === 'string' && stroke.shape.length <= 40), 'invalid_params', 'A stroke shape is a name', {path: '/stroke/shape'});
  return {id, tool: stroke.tool, color: stroke.color.toLowerCase(), width: Math.round(stroke.width * 100) / 100, points,
    ...(stroke.fx ? {fx: stroke.fx} : {}), ...(stroke.group ? {group: stroke.group} : {}), ...(stroke.shape ? {shape: stroke.shape} : {})};
}

/** Add a stroke on the page's ink layer. Returns its id. */
export function addStroke(ctx, pageId, stroke) {
  const page = pageOf(ctx, pageId);
  need(page.ink.length < LIMITS.strokes, 'too_large', `A page holds at most ${LIMITS.strokes} strokes`);
  const st = normalizeStroke(stroke, stroke.id ?? `k${ctx.host.uid()}`);
  need(!page.ink.some(s => s.id === st.id), 'invalid_params', `Stroke ${st.id} already exists`);
  beforeEdit(ctx, pageId);
  ctx.change.splice(['pages', pageId, 'ink'], page.ink.length, 0, st);
  stampEdit(ctx, pageId);
  return st.id;
}

/** Remove strokes by id (the stroke eraser). Returns how many were removed. */
export function eraseStrokes(ctx, pageId, ids) {
  const page = pageOf(ctx, pageId);
  const wanted = new Set(ids);
  const at = page.ink.map((s, i) => (wanted.has(s.id) ? i : -1)).filter(i => i >= 0);
  if (at.length) beforeEdit(ctx, pageId);
  for (let k = at.length - 1; k >= 0; k--) ctx.change.splice(['pages', pageId, 'ink'], at[k], 1);
  if (at.length) stampEdit(ctx, pageId);
  return at.length;
}

/** Bounding box of a stroke (half the width around its points). */
export function strokeBounds(stroke) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < stroke.points.length; i += 2) {
    const x = stroke.points[i], y = stroke.points[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const h = stroke.width / 2;
  return {x: x0 - h, y: y0 - h, width: x1 - x0 + stroke.width, height: y1 - y0 + stroke.width};
}

const segDist2 = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
};

/** Does an eraser of radius r at (x, y) touch the stroke? (OneNote's stroke eraser) */
export function strokeHit(stroke, x, y, r) {
  const reach = r + stroke.width / 2;
  const p = stroke.points;
  if (p.length === 2) return segDist2(x, y, p[0], p[1], p[0], p[1]) <= reach * reach;
  for (let i = 0; i + 3 < p.length; i += 2) if (segDist2(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach * reach) return true;
  return false;
}

/** SVG path data for a stroke: a quadratic curve through the midpoints (smooth, no overshoot). */
export function strokePath(points) {
  const n = points.length / 2;
  if (n < 1) return '';
  const f = v => Math.round(v * 10) / 10;
  if (n === 1) return `M${f(points[0])} ${f(points[1])}l0.01 0`;
  if (n === 2) return `M${f(points[0])} ${f(points[1])}L${f(points[2])} ${f(points[3])}`;
  let d = `M${f(points[0])} ${f(points[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = points[2 * i], y = points[2 * i + 1];
    const mx = (x + points[2 * i + 2]) / 2, my = (y + points[2 * i + 3]) / 2;
    d += `Q${f(x)} ${f(y)} ${f(mx)} ${f(my)}`;
  }
  return d + `L${f(points[2 * n - 2])} ${f(points[2 * n - 1])}`;
}

/** Drop points closer than `min` px to the previous kept one (pointer input is dense). */
export function simplifyPoints(points, min = 0.75) {
  if (points.length <= 4) return points.slice();
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2], dy = points[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= min * min) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}
