// Draw tab: Select Objects and Lasso Select, the pens (blue, black, red, highlighter, and Add Pen's Pen,
// Pencil and Highlighter), the Eraser, Ink to Shape and Ink Replay, and the commands the page's drawing
// gestures run (`draw.stroke`, `draw.erase`, `draw.lasso` with a loop, `draw.lassoMove`, `draw.lassoDelete`).
// Translated from gridcraft crates/engine/src/cmd/draw.rs (`pen`, `eraser`, `lasso`, `stroke`, `ink_to_shape`)
// and crates/ui-egui/src/grid/interact.rs (`handle_draw_tool`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/draw.
//
// What the pointer does on the sheet is the document view (`view.draw`: tool, colour, width, the strokes the lasso
// holds): a pen drag becomes `draw.stroke`, an eraser drag `draw.erase` at each point, a lasso loop `draw.lasso
// {points}`. The surface (src/apps/grid/surface/view.ts) turns pointer events into these commands and the bridge's
// `ui.pointer` runs the very same gesture. Ink is a shape of kind `ink` (core/grid/lib/ink.mjs); strokes are
// pinned where they were drawn and save to the workbook as DrawingML polylines (xlsx-drawing.mjs).
// Differences kept on purpose: a pen button picks that pen (colour and width) even while another pen is on, and
// switches off only when it is the pen in use; the lasso and Select Objects are two tools (upstream's lasso only
// leaves the pen), the lasso holding the strokes inside its loop for Delete and dragging.
// Not here: Ink to Math (no handwriting recognition) and Draw with Touch (the sheet takes no touch input apart
// from the mouse): hidden, see docs/spec/patches/grid/draw.json.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2} from '../lib/edit-targets.mjs';
import {setIn} from '../lib/edit-parts.mjs';
import {bad, baseDoc, failed} from '../lib/data-common.mjs';
import {nextObjectId, topZ, objectRect, anchorAt, selectedObject} from '../lib/objects.mjs';
import {PENS, MIN_INK_WIDTH, MAX_INK_WIDTH, MAX_INK_POINTS, inkShapes, inkPoints, inkText, inkWidth, widthFill, inPolygon, shapeOfStroke, bounds, inkHit} from '../lib/ink.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/draw.rs', 'crates/ui-egui/src/grid/interact.rs', 'crates/xlsx/src/drawing/ink.rs']};
const HEX = /^#?[0-9a-fA-F]{6}$/;
const TOOLS = ['pen', 'pencil', 'highlighter'];
const PROTECTED = 'The cell or chart you are trying to change is on a protected sheet. To make a change, unprotect the sheet.';
const DEFAULT_PEN = {color: '#1F5FC9', width: 2};
const protectedSheet = sheet => !!sheet?.protection?.enabled && !sheet.protection.objects;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** The view's drawing state: {tool: ''|'pen'|'eraser'|'lasso', color, width, lasso: [ids]}. */
export const drawOf = ctx => ({tool: '', ...DEFAULT_PEN, lasso: [], ...(ctx.view?.draw ?? {})});
const setDraw = (ctx, patch) => ctx.setView({draw: {...drawOf(ctx), ...patch}});
const upper = c => `#${String(c).replace(/^#/, '').toUpperCase()}`;

function sheetOf(ctx) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  return {content, si, sheet: content.sheets[si]};
}

// ---- tools ------------------------------------------------------------------------------------------------------

function pen(ctx, p) {
  const d = drawOf(ctx);
  const kind = p.kind === undefined ? null : p.kind;
  if (kind && !TOOLS.includes(kind)) throw bad('draw.pen', '`kind` is pen, pencil or highlighter');
  let color = d.color, width = d.width;
  if (kind) { color = PENS[kind].color; width = PENS[kind].width; }
  if (p.color !== undefined) {
    if (!HEX.test(String(p.color).trim())) throw bad('draw.pen', '`color` is #RRGGBB');
    color = upper(String(p.color).trim());
  }
  if (p.width !== undefined) width = clamp(p.width, MIN_INK_WIDTH, MAX_INK_WIDTH);
  // A button that names a pen (colour or width) switches to it; the pen already in use switches off.
  const same = d.tool === 'pen' && upper(d.color) === upper(color) && Number(d.width) === Number(width);
  const on = typeof p.on === 'boolean' ? p.on : !same;
  setDraw(ctx, {tool: on ? 'pen' : '', color, width, lasso: []});
  return {tool: on ? 'pen' : '', color, width};
}
function eraser(ctx, p) {
  const d = drawOf(ctx);
  const on = typeof p.on === 'boolean' ? p.on : d.tool !== 'eraser';
  setDraw(ctx, {tool: on ? 'eraser' : '', lasso: []});
  return {tool: on ? 'eraser' : ''};
}

const loopPoints = p => (Array.isArray(p.points) ? p.points.filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])).slice(0, MAX_INK_POINTS) : []);

/** Where a stroke's anchor corner stands on the sheet, in pixels. */
const originOf = (sheet, shape) => { const r = objectRect(sheet, shape.anchor); return {x: r.x, y: r.y}; };

/** The strokes with most of their points inside a loop (sheet pixels). */
function strokesInside(sheet, poly) {
  const out = [];
  for (const shape of inkShapes(sheet)) {
    const o = originOf(sheet, shape);
    const pts = inkPoints(shape);
    if (!pts.length) continue;
    const inside = pts.filter(([x, y]) => inPolygon(poly, o.x + x, o.y + y)).length;
    if (inside * 2 >= pts.length) out.push(shape.id);
  }
  return out;
}

function lasso(ctx, p) {
  if (p.clear === true) { setDraw(ctx, {lasso: []}); return {selected: [], count: 0}; }
  if (p.points === undefined) {
    if (p.mode === 'lasso') { setDraw(ctx, {tool: 'lasso', lasso: []}); return {tool: 'lasso'}; }
    // Select Objects (upstream `draw.lasso`): no tool, objects are picked by clicking them.
    setDraw(ctx, {tool: '', lasso: []});
    return {tool: ''};
  }
  const poly = loopPoints(p);
  if (poly.length < 3) throw bad('draw.lasso', 'a lasso loop needs at least three points');
  const {sheet} = sheetOf(ctx);
  const selected = strokesInside(sheet, poly);
  setDraw(ctx, {lasso: selected});
  return {selected, count: selected.length};
}

// ---- strokes ----------------------------------------------------------------------------------------------------

function stroke(ctx, p) {
  const raw = Array.isArray(p.points) ? p.points : [];
  const pts = raw.filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])).slice(0, MAX_INK_POINTS);
  if (pts.length < 2) throw bad('draw.stroke', 'a stroke needs at least two points');
  const {content, si, sheet} = sheetOf(ctx);
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  const d = drawOf(ctx);
  const kind = p.tool === undefined ? null : p.tool;
  if (kind && !TOOLS.includes(kind)) throw bad('draw.stroke', '`tool` is pen, pencil or highlighter');
  let color = kind ? PENS[kind].color : d.color, width = kind ? PENS[kind].width : d.width;
  if (p.color !== undefined) {
    if (!HEX.test(String(p.color).trim())) throw bad('draw.stroke', '`color` is #RRGGBB');
    color = upper(String(p.color).trim());
  }
  if (p.width !== undefined) width = p.width;
  width = clamp(Number(width) || 2, MIN_INK_WIDTH, MAX_INK_WIDTH);
  const {x0, y0, x1, y1} = bounds(pts);
  const minx = Math.max(0, x0), miny = Math.max(0, y0);
  const w = Math.max(1, x1 - minx), h = Math.max(1, y1 - miny);
  const id = nextObjectId(content);
  const anchor = anchorAt(sheet, minx, miny, Math.round(w * 10) / 10, Math.round(h * 10) / 10, 'absolute');
  const shape = {id, ...topZ(sheet), kind: 'ink', anchor, fill: widthFill(Math.round(width)), line: upper(color), text: inkText(pts.map(([x, y]) => [x - minx, y - miny]))};
  setIn(ctx.change, ['sheets', si, 'shapes'], [...(sheet.shapes ?? []), shape]);
  return {shape: id};
}

function erase(ctx, p) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw bad('draw.erase', '`x` and `y` are sheet pixels');
  const {si, sheet} = sheetOf(ctx);
  const hit = inkHit(sheet, p.x, p.y, Number.isFinite(p.radius) ? p.radius : 4);
  if (!hit) throw failed('no ink stroke there');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  ctx.change.set(['sheets', si, 'shapes'], sheet.shapes.filter((_, i) => i !== hit.index));
  const lasso = drawOf(ctx).lasso;
  if (lasso.includes(hit.shape.id)) setDraw(ctx, {lasso: lasso.filter(id => id !== hit.shape.id)});
  return {erased: hit.shape.id};
}

/** The strokes a command acts on: `ids`, else the lasso's, else the selected stroke, else the last one. */
function targets(ctx, sheet, p) {
  const all = inkShapes(sheet);
  let ids = Array.isArray(p.ids) ? p.ids : Number.isInteger(p.id) ? [p.id] : drawOf(ctx).lasso;
  if (!ids.length) {
    const sel = selectedObject(ctx.doc, ctx.selection);
    const picked = sel && sel.kind === 'shape' ? all.find(x => x.id === sel.id) : null;
    ids = picked ? [picked.id] : all.length ? [all[all.length - 1].id] : [];
  }
  return all.filter(x => ids.includes(x.id));
}

function inkToShape(ctx, p) {
  const {si, sheet} = sheetOf(ctx);
  const list = targets(ctx, sheet, p);
  if (!list.length) throw bad('draw.inkToShape', 'no ink stroke to convert');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  const kinds = {};
  for (const shape of list) {
    const index = sheet.shapes.indexOf(shape);
    const pts = inkPoints(shape);
    const kind = shapeOfStroke(pts, shape.anchor.width, shape.anchor.height);
    const color = shape.line;
    kinds[shape.id] = kind;
    ctx.change.set(['sheets', si, 'shapes', index], {...shape, kind, fill: kind === 'line' ? color : 'auto', text: ''});
  }
  setDraw(ctx, {lasso: []});
  return {kinds, kind: kinds[list[list.length - 1].id]};
}

function lassoMove(ctx, p) {
  if (!Number.isFinite(p.dx) || !Number.isFinite(p.dy)) throw bad('draw.lassoMove', '`dx` and `dy` are pixels');
  const {si, sheet} = sheetOf(ctx);
  const ids = drawOf(ctx).lasso;
  if (!ids.length) throw failed('nothing is selected');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  sheet.shapes.forEach((shape, index) => {
    if (shape.kind !== 'ink' || !ids.includes(shape.id)) return;
    const o = originOf(sheet, shape);
    const a = anchorAt(sheet, Math.max(0, o.x + p.dx), Math.max(0, o.y + p.dy), shape.anchor.width, shape.anchor.height, 'absolute');
    ctx.change.set(['sheets', si, 'shapes', index, 'anchor'], a);
  });
  return {moved: ids.length};
}

function lassoDelete(ctx) {
  const {si, sheet} = sheetOf(ctx);
  const ids = drawOf(ctx).lasso;
  if (!ids.length) throw failed('nothing is selected');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  ctx.change.set(['sheets', si, 'shapes'], sheet.shapes.filter(shape => !(shape.kind === 'ink' && ids.includes(shape.id))));
  setDraw(ctx, {lasso: []});
  return {deleted: ids.length};
}

/** Ink Replay: the strokes appear again one by one in the order they were drawn (view state; the surface steps `n`). */
function inkReplay(ctx, p) {
  const {sheet} = sheetOf(ctx);
  const ids = inkShapes(sheet).map(x => x.id).sort((a, b) => a - b);
  if (p.stop === true) { ctx.setView({inkReplay: null}); return {replaying: false}; }
  if (Number.isInteger(p.step)) {
    const n = clamp(p.step, 0, ids.length);
    ctx.setView({inkReplay: n >= ids.length ? null : {ids, n}});
    return {replaying: n < ids.length, shown: n, total: ids.length};
  }
  if (!ids.length) throw failed('there is no ink to replay');
  ctx.setView({inkReplay: {ids, n: 0}});
  return {replaying: true, shown: 0, total: ids.length};
}

// ---- state ------------------------------------------------------------------------------------------------------

const toolState = (tool, match) => ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: match ? match(drawOf(ctx)) : drawOf(ctx).tool === tool} : hasDoc(ctx));
const penState = (ctx, p) => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const d = drawOf(ctx);
  const color = p?.color !== undefined ? upper(p.color) : null, width = p?.width !== undefined ? Number(p.width) : null;
  return {enabled: true, checked: d.tool === 'pen' && (color === null || upper(d.color) === color) && (width === null || Number(d.width) === width)};
};
const hasInk = ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const sheet = ctx.doc.sheets[gridSel(ctx).sheet];
  return inkShapes(sheet).length ? {enabled: true} : {enabled: false, reason: 'there is no ink on this sheet'};
};
const FLAG = s.optional(s.boolean());
const POINTS = s.array(s.array(s.number(), {min: 2, max: 2}), {max: MAX_INK_POINTS});

export default defineCommands({
  family: 'draw',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'draw.pen', label: 'Pen', risk: 'read', effect: 'view',
      description: 'Pick a pen (or put it away): `color` (#RRGGBB), `width` (0.5 to 40 pixels), `kind` pen|pencil|highlighter for that pen\'s colour and width, `on`. Dragging on the sheet then draws ink.',
      params: s.object({on: FLAG, color: s.optional(s.string({max: 16})), width: s.optional(s.number({min: MIN_INK_WIDTH, max: MAX_INK_WIDTH})), kind: s.optional(s.enum(TOOLS))}),
      state: penState, run: pen},
    {id: 'draw.eraser', label: 'Eraser', risk: 'read', effect: 'view',
      description: 'Pick the eraser (or put it away): dragging over ink takes the strokes it touches.',
      params: s.object({on: FLAG}), state: toolState('eraser'), run: eraser},
    {id: 'draw.lasso', label: 'Lasso Select', risk: 'read', effect: 'view',
      description: 'Select Objects (no `mode`, the default): objects are picked by clicking them. `mode` lasso picks the lasso, whose loop (`points`, sheet pixels) selects the ink strokes inside it; `clear` drops that selection.',
      params: s.object({mode: s.optional(s.enum(['select', 'lasso'])), points: s.optional(POINTS), clear: FLAG}),
      state: (ctx, p) => (hasDoc(ctx).enabled ? {enabled: true, checked: p?.mode === 'lasso' ? drawOf(ctx).tool === 'lasso' : drawOf(ctx).tool === ''} : hasDoc(ctx)),
      run: lasso},
    {id: 'draw.stroke', label: 'Ink Stroke', risk: 'edit',
      description: 'Draw an ink stroke through `points` ([[x, y], …] in sheet pixels, at least two), `color`, `width`, or `tool` pen|pencil|highlighter for that pen. The stroke is a shape of kind ink pinned where it was drawn.',
      params: s.object({points: POINTS, color: s.optional(s.string({max: 16})), width: s.optional(s.number({min: MIN_INK_WIDTH, max: MAX_INK_WIDTH})), tool: s.optional(s.enum(TOOLS))}),
      state: hasDoc, run: stroke},
    {id: 'draw.erase', label: 'Erase Ink', risk: 'edit',
      description: 'Delete the ink stroke under (`x`, `y`) in sheet pixels (within `radius` of it, 4 by default): what the eraser does at each point of a drag.',
      params: s.object({x: s.number(), y: s.number(), radius: s.optional(s.number({min: 0, max: 100}))}), state: hasDoc, run: erase},
    {id: 'draw.inkToShape', label: 'Ink to Shape', risk: 'edit',
      description: 'Turn ink strokes (`id`/`ids`, else the lasso\'s, the selected stroke or the last one) into a rectangle, ellipse, triangle or line: whichever shape the stroke looks like.',
      params: s.object({id: s.optional(s.integer({min: 0})), ids: s.optional(s.array(s.integer({min: 0}), {max: 5000}))}), state: hasInk, run: inkToShape},
    {id: 'draw.lassoMove', label: 'Move Selected Ink', risk: 'edit',
      description: 'Move the strokes the lasso holds by `dx`, `dy` pixels.',
      params: s.object({dx: s.number(), dy: s.number()}), state: hasDoc, run: lassoMove},
    {id: 'draw.lassoDelete', label: 'Delete Selected Ink', risk: 'edit',
      description: 'Delete the strokes the lasso holds.', params: s.object({}), state: hasDoc, run: lassoDelete},
    {id: 'draw.inkReplay', label: 'Ink Replay', risk: 'read', effect: 'view',
      description: 'Replay the sheet\'s ink in the order it was drawn: with no params it starts (every stroke hidden), `step` n shows the first n strokes (the last step ends the replay), `stop` ends it.',
      params: s.object({step: s.optional(s.integer({min: 0})), stop: FLAG}), state: hasInk, run: inkReplay},
  ],
});
