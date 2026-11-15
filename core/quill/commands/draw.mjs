// Draw tab (U:quill/draw) and Review › Ink › Hide Ink: the drawing tools (Select, Lasso Select, Eraser),
// the pens (Pen, Pencil, Highlighter, their colour and thickness, Add Pen and the pen gallery), drawing
// and erasing ink strokes, moving, recolouring and deleting what the lasso picked, Ink to Shape (a
// stroke that looks like a line, arrow, rectangle, ellipse, triangle or polygon becomes that shape) and
// Ink Replay (the strokes in the order they were drawn).
//
// Translated from wordcraft crates/engine/src/cmd/draw.rs (`specs`, `pen`, `add_pen`, `stroke`, `erase`,
// `lasso`, `lasso_move`, `lasso_delete`, `lasso_color`, `convert_selection`, `replay`) and the pen logic of
// crates/ui-egui/src/ribbon/draw.rs (`update_gallery_pen`, `gallery_pen`) at
// aadb077e072b7de05f724e359d8db82e151f125c; the engine is in core/quill/lib/draw-ink.mjs and
// draw-shape.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What dragging on the page does is the document view (`view.draw.mode`), never an edit; `draw.stroke`
// and `draw.erase` change the document, one undo step each. The page view turns a drag into these
// commands (src/apps/quill/surface/draw-input.ts), and the bridge's `ui.pointer` does the same from
// points. Four helpers stand for what upstream's ribbon code decides on the spot: `draw.usePen` (a gallery
// pen), `draw.penColor` and `draw.penWidth` (the colour and thickness menus change the pen in use, and the
// lasso selection's colour while ink is selected). Not here: Ink to Math and the Ruler stencil (no
// upstream engine; hidden) and Draw with Touch (the spec lists no such control).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import {UPSTREAM_COMMIT, layoutFor} from '../lib/caret-session.mjs';
import * as P from '../model/para.mjs';
import {BODY, cmpPos} from '../model/document.mjs';
import {defaultFloat} from '../model/para.mjs';
import {inkFreeform, parseInkTool, inkDefaultColor, inkDefaultWidth, MAX_INK_PER_PAGE, MAX_POINTS, placedPaths, isInk} from '../model/freeform.mjs';
import {Spin} from '../lib/geom.mjs';
import {shapeName} from '../lib/draw-shape.mjs';
import {
  MIN_WIDTH, MAX_WIDTH, MAX_LASSO_POINTS, LASSO_SAMPLES, MAX_MOVE, MAX_PENS, drawOf, setDraw, hideInkOf, pensOf, customPen, parseColor, hex, stateJson,
  lassoSelection, keepLasso, posJson, objectAtPos, inkOn, inkAt, pageParam, pointsParam, deleteObject, nextOrder, anchorParagraph, nearestLine, setShape, convertAt,
  arrowPieces, near, localTo, afterDeleting, pairWithNeighbour, inside, strokesInDrawingOrder,
} from '../lib/draw-ink.mjs';
import {pairParts} from '../lib/draw-shape.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/draw.rs', 'crates/engine/src/cmd/ink_shape.rs', 'crates/ui-egui/src/ribbon/draw.rs']};
const NONE = s.object({});
const failed = m => new CommandError('failed', m);
const bad = m => new CommandError('invalid_params', m);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ready = T.ready;
const PEN_PARAMS = s.object({color: s.optional(s.string({max: 16})), width: s.optional(s.number())});
const dToolOf = d => (['pen', 'pencil', 'highlighter'].includes(d.mode) ? d.mode : 'pen');

/** Pick up a pen, optionally changing its colour and thickness (pen). */
function pickPen(ctx, tool, p, gallery = null) {
  const d = drawOf(ctx);
  const set = {...d[tool]};
  if (p.color !== undefined) { const c = parseColor(p.color); if (!c) throw bad('`color` is RRGGBB'); set.color = c; }
  if (Number.isFinite(p.width)) set.width = clamp(p.width, MIN_WIDTH, MAX_WIDTH);
  setDraw(ctx, {mode: tool, [tool]: set, gallery});
  return stateJson(ctx);
}

const savePens = (ctx, pens) => ctx.updatePrefs({draw: {...(ctx.prefs?.draw ?? {}), pens}});

/** The gallery pen in use, if any (its kind, colour and thickness are the tool's now). */
function activePen(ctx) {
  const d = drawOf(ctx);
  if (!['pen', 'pencil', 'highlighter'].includes(d.mode)) return -1;
  const pens = pensOf(ctx);
  return Number.isInteger(d.gallery) && pens[d.gallery]?.kind === d.mode ? d.gallery : -1;
}

function addPen(ctx, p) {
  const d = drawOf(ctx);
  const v = {...p};
  // The menu adds a pen as that kind's current colour and thickness (draw.rs ribbon: Add Pen items).
  if (p.current) {
    const kind = p.kind === undefined ? 'pen' : parseInkTool(p.kind);
    if (!kind) throw bad('`kind` is pen, pencil or highlighter');
    v.kind = kind;
    v.color = hex(d[kind].color);
    v.width = d[kind].width;
  }
  delete v.current;
  const pen = customPen(v);
  const pens = pensOf(ctx);
  if (pens.length >= MAX_PENS) throw failed(`the pen gallery holds at most ${MAX_PENS} pens`);
  savePens(ctx, [...pens, pen]);
  setDraw(ctx, {mode: pen.kind, [pen.kind]: {color: pen.color, width: pen.width}, gallery: pens.length});
  return {pen: {kind: pen.kind, color: hex(pen.color), width: pen.width}, index: pens.length, pens: pens.length + 1};
}

function removePen(ctx, p) {
  const pens = pensOf(ctx);
  if (!Number.isInteger(p.index) || p.index < 0) throw bad('`index` (0-based) is required');
  if (p.index >= pens.length) throw bad(`no pen ${p.index}`);
  const removed = pens[p.index];
  savePens(ctx, pens.filter((_, i) => i !== p.index));
  // The pen in use keeps its place in the gallery (or is no gallery pen any more when it was the one removed).
  const g = drawOf(ctx).gallery;
  if (Number.isInteger(g) && g >= p.index) setDraw(ctx, {gallery: g === p.index ? null : g - 1});
  return {removed: {kind: removed.kind, color: hex(removed.color), width: removed.width}, pens: pens.length - 1};
}

/** A gallery pen: picked up as its kind with its colour and thickness (the ribbon's gallery_pen click). */
function usePen(ctx, p) {
  const pen = pensOf(ctx)[p.index];
  if (!pen) throw bad(`no pen ${p.index}`);
  return pickPen(ctx, pen.kind, {color: hex(pen.color), width: pen.width}, p.index);
}

/** The colour menu: the lasso selection's outline while ink is selected, else the pen in use (and its gallery pen). */
function penColor(ctx, p) {
  if (lassoSelection(ctx)) return ctx.run('draw.lassoColor', {color: p.color});
  const tool = dToolOf(drawOf(ctx));
  const i = activePen(ctx);
  const r = pickPen(ctx, tool, {color: p.color}, i < 0 ? null : i);
  syncGalleryPen(ctx, i, tool);
  return r;
}
function penWidth(ctx, p) {
  const tool = dToolOf(drawOf(ctx));
  const i = activePen(ctx);
  const r = pickPen(ctx, tool, {width: p.width}, i < 0 ? null : i);
  syncGalleryPen(ctx, i, tool);
  return r;
}
/** After the colour or thickness menu changed `tool`'s settings, the gallery pen that was in use takes them too (update_gallery_pen). */
function syncGalleryPen(ctx, i, tool) {
  if (i < 0) return;
  const set = drawOf(ctx)[tool];
  const pens = pensOf(ctx).map((q, k) => (k === i && q.kind === tool ? {...q, color: set.color, width: set.width} : q));
  savePens(ctx, pens);
}

const THICKNESS = Object.freeze({pen: [0.5, 1, 1.5, 2.5, 3.5, 5], pencil: [0.5, 1, 1.5, 2.5, 3.5, 5], highlighter: [4, 8, 12, 18, 24]});

// ---- drawing and erasing ----------------------------------------------------------------------------------------

/**
 * Insert floating `obj` with its top-left at (x, y) on `page`, anchored to the body paragraph under `anchor`
 * (positioned from its column and top), or, where no paragraph starts on the page, to the nearest line and
 * positioned on the page. Returns where its character went (place).
 */
function place(ctx, S, layout, obj, page, [x, y], anchor) {
  const where = anchorParagraph(S.d, layout, page, anchor, BODY);
  let at, onPage = false;
  if (where) at = {story: BODY, path: where, off: 0};
  else {
    at = nearestLine(layout, page, anchor[1], BODY);
    if (!at) throw bad('no text on that page to anchor to');
    onPage = true;
  }
  S.d.insertObject(at, obj, {});
  for (const k of ['anchor', 'focus']) {
    const q = S.sel[k];
    if (q.story === at.story && q.path.length === at.path.length && q.path.every((v, i) => v === at.path[i]) && q.off > at.off) S.sel = {...S.sel, [k]: {...q, off: q.off + 1}};
  }
  let origin = {x: 0, y: 0};
  if (!onPage) {
    // Lay out the new object to find where its paragraph puts it (the edit so far is committed, so the layout sees it).
    ctx.model.commit(ctx, S.d);
    const lay = layoutFor(ctx);
    const hit = lay?.pages?.[page]?.items.find(it => it.kind === 'object' && it.story === at.story && it.off === at.off && it.path.length === at.path.length && it.path.every((v, i) => v === at.path[i]))
      ?? lay?.pages?.flatMap(pg => pg.items).find(it => it.kind === 'object' && it.story === at.story && it.off === at.off && it.path.length === at.path.length && it.path.every((v, i) => v === at.path[i]));
    if (!hit) throw failed("the stroke isn't laid out");
    origin = hit.origin ?? {x: hit.rect.x, y: hit.rect.y};
  }
  const q = S.d.paraMut(at.story, at.path);
  const k = P.objectsWithOffsets(q).findIndex(([off]) => off === at.off);
  q.objects = q.objects.map((o, i) => (i === k ? {...o, float: {...o.float, hRel: onPage ? 'page' : 'column', vRel: onPage ? 'page' : 'paragraph', x: x - origin.x, y: y - origin.y}} : o));
  return at;
}

/** Draw an ink stroke through page points (stroke). */
function stroke(ctx, p) {
  const S = T.open(ctx);
  const layout = layoutFor(ctx);
  const page = pageParam(layout, p);
  let tool;
  if (p.tool !== undefined) { tool = parseInkTool(p.tool); if (!tool) throw bad('`tool` is pen, pencil or highlighter'); } else tool = dToolOf(drawOf(ctx));
  const d = drawOf(ctx);
  const set = d[tool];
  let color = set.color;
  if (p.color !== undefined) { color = parseColor(p.color); if (!color) throw bad('`color` is RRGGBB'); }
  const width = Number.isFinite(p.width) ? clamp(p.width, MIN_WIDTH, MAX_WIDTH) : set.width;
  const pg = layout.pages[page];
  const [pw, ph] = [Math.max(pg.w, 1), clamp(pg.h, 1, 1e5)];
  const pts = pointsParam(p, MAX_POINTS, pw, ph);
  if (!pts.length) throw bad('`points` has no usable point');
  const first = pts[0];
  if (inkOn(S.d, layout, page).length >= MAX_INK_PER_PAGE) throw failed(`page ${page} already has ${MAX_INK_PER_PAGE} ink strokes`);
  // The frame: the points' bounds, grown by half the width so the stroke's ends fit.
  const pad = width / 2;
  let [x0, y0, x1, y1] = [first[0], first[1], first[0], first[1]];
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const [fx, fy] = [x0 - pad, y0 - pad];
  const [fw, fh] = [Math.max(x1 - x0 + width, 1), Math.max(y1 - y0 + width, 1)];
  const local = pts.map(([x, y]) => [x - fx, y - fy]);
  const wrap = tool === 'highlighter' ? 'behindText' : 'inFrontOfText';
  const freeform = {...inkFreeform(tool, fw, fh, local), order: nextOrder(S.d)};
  const obj = {type: 'shape', kind: 'freeform', w: fw, h: fh, fill: null, stroke: color, strokeWidth: width, float: {...defaultFloat(), wrap}, freeform};
  let at = place(ctx, S, layout, obj, page, [fx, fy], [first[0], first[1]]);
  // Ink to Shape: a stroke that looks like a shape becomes it, and a line and a head drawn as two strokes become one arrow (in the same undo step).
  let shape = null, rect = [fx, fy, fw, fh];
  if (d.inkToShape && tool !== 'highlighter') {
    ctx.model.commit(ctx, S.d);
    const lay = layoutFor(ctx);
    const arrow = pairWithNeighbour(S, lay, page, at, hideInkOf(ctx));
    if (arrow) {
      ctx.model.commit(ctx, S.d);
      const r = layoutFor(ctx)?.pages?.[page]?.items.find(it => it.kind === 'object' && it.story === arrow.story && it.off === arrow.off
        && it.path.length === arrow.path.length && it.path.every((v, i) => v === arrow.path[i]))?.rect;
      at = arrow;
      shape = 'arrow';
      if (r) rect = [r.x, r.y, r.w, r.h];
    } else shape = convertAt(S, at);
  }
  return T.finish(S, {pos: posJson(at), page, rect, shape});
}

/** Delete the ink stroke under a point (erase). */
function erase(ctx, p) {
  const S = T.open(ctx);
  const layout = layoutFor(ctx);
  const page = pageParam(layout, p);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw bad('`x` and `y` are required');
  const pos = inkAt(ctx, S.d, layout, page, p.x, p.y);
  if (!pos) throw failed('no ink stroke there');
  deleteObject(S, pos);
  return T.finish(S, {erased: posJson(pos)});
}

// ---- the lasso -----------------------------------------------------------------------------------------------------------

/** Select the ink inside a loop (most of a stroke's points inside it) and the drawings whose centre is inside it; without a loop, pick up the lasso (lasso). */
function lasso(ctx, p) {
  if (p.clear === true) { setDraw(ctx, {lasso: null}); return {selected: [], count: 0}; }
  if (p.points === undefined) { setDraw(ctx, {mode: 'lasso'}); return stateJson(ctx); }
  const layout = layoutFor(ctx);
  const page = pageParam(layout, p);
  const pg = layout.pages[page];
  let poly = pointsParam(p, MAX_POINTS, Math.max(pg.w, 1), clamp(pg.h, 1, 1e5));
  if (poly.length > MAX_LASSO_POINTS) { const step = Math.ceil(poly.length / MAX_LASSO_POINTS); poly = poly.filter((_, i) => i % step === 0); }
  if (poly.length < 3) throw bad('a lasso loop needs at least three points');
  const d = ctx.model.open(ctx);
  const items = [];
  for (const it of pg.items) {
    if (it.kind !== 'object') continue;
    const pos = {story: it.story, path: it.path, off: it.off};
    const o = objectAtPos(d, pos);
    if (!o) continue;
    const rect = it.rect;
    let picked;
    if (o.type === 'shape' && o.freeform?.ink) {
      if (hideInkOf(ctx)) picked = false;
      else {
        // Where the stroke is drawn: turned about its frame's centre.
        const spin = new Spin(o.float?.rot ?? 0, o.float?.flipH, o.float?.flipV);
        const [cx, cy] = [rect.x + rect.w / 2, rect.y + rect.h / 2];
        const pts = placedPaths(o.freeform, rect.x, rect.y, rect.w, rect.h).flatMap(([q]) => q).map(([x, y]) => spin.apply(cx, cy, x, y));
        const step = Math.max(1, Math.ceil(pts.length / LASSO_SAMPLES));
        let n = 0, hits = 0;
        for (let i = 0; i < pts.length; i += step) { n++; if (inside(poly, pts[i][0], pts[i][1])) hits++; }
        picked = n > 0 && hits * 10 >= n * 6;
      }
    } else picked = ['image', 'graphic', 'shape', 'group'].includes(o.type) && inside(poly, rect.x + rect.w / 2, rect.y + rect.h / 2);
    if (picked && !items.some(q => cmpPos(q, pos) === 0)) items.push(pos);
  }
  const selected = items.map(posJson);
  setDraw(ctx, {lasso: items.length ? {page, items, version: ctx.version} : null});
  return {page, count: selected.length, selected};
}

const lassoRequired = ctx => lassoSelection(ctx) ?? (() => { throw failed('nothing is selected with the lasso'); })();

/** Move the lasso-selected drawings by (dx, dy) points (lasso_move). */
function lassoMove(ctx, p) {
  const sel = lassoRequired(ctx);
  const S = T.open(ctx);
  const [dx, dy] = [p.dx, p.dy].map(v => (Number.isFinite(v) ? clamp(v, -MAX_MOVE, MAX_MOVE) : 0));
  let moved = 0;
  for (const pos of sel.items) {
    const o = objectAtPos(S.d, pos);
    if (!o || !(o.float && (o.float.wrap ?? 'inline') !== 'inline')) continue;
    const q = S.d.paraMut(pos.story, pos.path);
    const k = P.objectsWithOffsets(q).findIndex(([off]) => off === pos.off);
    q.objects = q.objects.map((x, i) => {
      if (i !== k) return x;
      const f = {...x.float};
      if (!f.hAlign) f.x = (f.x ?? 0) + dx;
      if (!f.vAlign) f.y = (f.y ?? 0) + dy;
      return {...x, float: f};
    });
    moved++;
  }
  if (!moved) throw failed('nothing selected can be moved');
  keepLasso(ctx, sel);
  return T.finish(S, {moved});
}

/** Delete the lasso-selected strokes and drawings (lasso_delete). */
function lassoDelete(ctx) {
  const sel = lassoRequired(ctx);
  const S = T.open(ctx);
  const items = [...sel.items].sort(cmpPos);
  let deleted = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (i < items.length - 1 && cmpPos(items[i], items[i + 1]) === 0) continue;
    if (objectAtPos(S.d, items[i])) { deleteObject(S, items[i]); deleted++; }
  }
  setDraw(ctx, {lasso: null});
  if (!deleted) throw failed('nothing selected to delete');
  return T.finish(S, {deleted});
}

/** Give the lasso-selected strokes and shapes this outline colour (lasso_color). */
function lassoColor(ctx, p) {
  const sel = lassoRequired(ctx);
  const color = parseColor(p.color);
  if (!color) throw bad('`color` is RRGGBB');
  const S = T.open(ctx);
  let changed = 0, mutated = false;
  for (const pos of sel.items) {
    const o = objectAtPos(S.d, pos);
    if (o?.type !== 'shape') continue;
    changed++;
    if (Array.isArray(o.stroke) && o.stroke.length === 3 && o.stroke.every((v, i) => v === color[i])) continue;  // already that colour: nothing to change
    mutated = true;
    const q = S.d.paraMut(pos.story, pos.path);
    const k = P.objectsWithOffsets(q).findIndex(([off]) => off === pos.off);
    q.objects = q.objects.map((x, i) => (i === k ? {...x, stroke: color} : x));
  }
  if (!changed) throw failed('nothing selected has an outline to recolour');
  if (mutated) keepLasso(ctx, sel);  // a change re-keys the selection to the next version; no change keeps it as it is
  return T.finish(S, {recolored: changed, color: hex(color)});
}

// ---- Ink to Shape and Ink Replay ----------------------------------------------------------------------------------------

/** Turn the lasso-selected strokes that look like shapes into those shapes, and a selected line and arrowhead drawn as two strokes into one arrow (convert_selection). */
function convertSelection(ctx) {
  const sel = lassoRequired(ctx);
  const S = T.open(ctx);
  const layout = layoutFor(ctx);
  const has = (list, pos) => list.some(q => cmpPos(q, pos) === 0);
  const pieces = arrowPieces(S, layout, sel.page, pos => has(sel.items, pos), hideInkOf(ctx));
  const used = [], heads = [], converted = [];
  for (const line of pieces.filter(k => k.parts.line)) {
    for (const head of pieces.filter(k => k.parts.heads.length)) {
      if (cmpPos(line.pos, head.pos) === 0 || has(used, line.pos) || has(used, head.pos) || !near(line.rect, head.rect)) continue;
      const arrow = pairParts(line.parts, head.parts);
      if (arrow) {
        setShape(S, line.pos, localTo(arrow, line.rect));
        used.push(line.pos, head.pos);
        heads.push(head.pos);
        converted.push([line.pos, 'arrow']);
      }
    }
  }
  for (const pos of sel.items.filter(q => !has(used, q))) {
    const name = convertAt(S, pos);
    if (name) converted.push([pos, name]);
  }
  if (!converted.length) throw failed('none of the selected strokes looks like a shape');
  // The heads went into their arrows; last first, so the earlier ones keep their place.
  heads.sort(cmpPos);
  for (let i = heads.length - 1; i >= 0; i--) deleteObject(S, heads[i]);
  const items = sel.items.filter(q => !has(heads, q)).map(q => afterDeleting(q, heads));
  const list = converted.map(([pos, name]) => ({pos: posJson(afterDeleting(pos, heads)), shape: name}));
  keepLasso(ctx, {...sel, items});
  return T.finish(S, {count: list.length, converted: list});
}

function inkToShape(ctx, p) {
  if (typeof p.value === 'boolean') { setDraw(ctx, {inkToShape: p.value}); return {value: p.value}; }
  // With strokes lasso-selected it converts them; otherwise it turns the mode on or off.
  const sel = lassoSelection(ctx);
  const d = ctx.model.open(ctx);
  if (sel && sel.items.some(pos => objectAtPos(d, pos)?.freeform?.ink)) return ctx.run('draw.convertInk', {});
  const value = !drawOf(ctx).inkToShape;
  setDraw(ctx, {inkToShape: value});
  return {value};
}

function replay(ctx, p) {
  const on = typeof p.value === 'boolean' ? p.value : !drawOf(ctx).replay;
  const d = ctx.model.open(ctx);
  const strokes = on ? strokesInDrawingOrder(ctx, d, layoutFor(ctx)) : [];
  if (on && !strokes.length) throw failed('there is no ink to replay');
  setDraw(ctx, {replay: on});
  return {replaying: on, strokes: strokes.map(k => ({page: k.page, pos: posJson(k.pos), order: k.freeform.order ?? null, tool: k.freeform.ink ?? null,
    points: k.freeform.paths.reduce((n, q) => n + q.pts.length, 0)}))};
}

const toolState = mode => ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: drawOf(ctx).mode === mode} : r; };
const lassoState = ctx => { const r = ready(ctx); if (!r.enabled) return r; return lassoSelection(ctx) ? {enabled: true} : {enabled: false, reason: 'Nothing is selected with the lasso'}; };

/** The gallery pen in use: the one picked up with Use Pen or Add Pen (the plain Pen, Pencil and Highlighter buttons use none). */
const isCurrentPen = (ctx, i) => drawOf(ctx).gallery === i;

const pensList = ctx => pensOf(ctx).map((p, i) => ({selected: isCurrentPen(ctx, i), id: String(i), label: `${({pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter'})[p.kind]}: ${p.width} pt, #${hex(p.color)}`,
  value: i, icon: ({pen: 'pen', pencil: 'pencil', highlighter: 'highlight'})[p.kind], accent: `#${hex(p.color)}`, bar: clamp(p.width * 0.6, 1.5, 8)}));

export default defineCommands({
  family: 'draw',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'draw.select', label: 'Select', risk: 'read', effect: 'view', state: toolState('select'), description: 'Select: dragging on the page selects text and drawings again.', params: NONE,
      run: ctx => { setDraw(ctx, {mode: 'select'}); return stateJson(ctx); }},
    {id: 'draw.lasso', label: 'Lasso Select', risk: 'read', effect: 'view', state: toolState('lasso'),
      description: 'Lasso Select: dragging draws a loop that selects the ink inside it. With `points` ([[x, y], …] on `page`) it selects the ink inside that loop; `clear` drops the selection.',
      params: s.object({page: s.optional(s.integer({min: 0})), points: s.optional(s.array(s.array(s.number()))), clear: s.optional(s.boolean())}), run: lasso},
    {id: 'draw.lassoMove', label: 'Move Selected Ink', risk: 'edit', state: lassoState, description: 'Move Selected Ink: the lasso-selected strokes and drawings move by dx, dy points (one undo step).',
      params: s.object({dx: s.number(), dy: s.number()}), run: lassoMove},
    {id: 'draw.lassoDelete', label: 'Delete Selected Ink', risk: 'edit', state: lassoState, description: 'Delete Selected Ink: the lasso-selected strokes and drawings are deleted (one undo step).', params: NONE, run: lassoDelete},
    {id: 'draw.lassoColor', label: 'Recolor Selected Ink', risk: 'edit', state: lassoState, description: 'Recolor Selected Ink: the lasso-selected strokes and shapes get this outline colour (RRGGBB).',
      params: s.object({color: s.string({max: 16})}), run: lassoColor},
    {id: 'draw.eraser', label: 'Eraser', risk: 'edit', state: toolState('eraser'),
      description: 'Eraser: dragging over ink strokes deletes them. With a point (`page`, `x`, `y`) it erases the stroke there.',
      params: s.object({page: s.optional(s.integer({min: 0})), x: s.optional(s.number()), y: s.optional(s.number())}),
      run(ctx, p) {
        if (p.page !== undefined || p.x !== undefined || p.y !== undefined) return ctx.run('draw.erase', p);
        setDraw(ctx, {mode: 'eraser'});
        return stateJson(ctx);
      }},
    {id: 'draw.pen', label: 'Pen', risk: 'read', effect: 'view', state: toolState('pen'), description: 'Pen: dragging draws ink with the pen; `color` (RRGGBB) and `width` (points) change it.', params: PEN_PARAMS,
      run: (ctx, p) => pickPen(ctx, 'pen', p)},
    {id: 'draw.pencil', label: 'Pencil', risk: 'read', effect: 'view', state: toolState('pencil'), description: 'Pencil: dragging draws ink with the pencil; `color` and `width` change it.', params: PEN_PARAMS,
      run: (ctx, p) => pickPen(ctx, 'pencil', p)},
    {id: 'draw.highlighter', label: 'Highlighter', risk: 'read', effect: 'view', state: toolState('highlighter'), description: 'Highlighter: dragging draws translucent ink behind the text; `color` and `width` change it.', params: PEN_PARAMS,
      run: (ctx, p) => pickPen(ctx, 'highlighter', p)},
    {id: 'draw.addPen', label: 'Add Pen', risk: 'read', effect: 'prefs', state: ready,
      description: 'Add Pen: adds a pen (`kind` pen, pencil or highlighter, `color`, `width`) to the gallery and picks it up; `current` takes that kind\'s colour and thickness in use.',
      params: s.object({kind: s.optional(s.string({max: 16})), color: s.optional(s.string({max: 16})), width: s.optional(s.number()), current: s.optional(s.boolean())}), run: addPen},
    {id: 'draw.removePen', label: 'Remove Pen', risk: 'read', effect: 'prefs', state: ready, description: 'Remove Pen: removes gallery pen `index` (0-based).', params: s.object({index: s.integer({min: 0})}), run: removePen},
    {id: 'draw.usePen', label: 'Use Pen', risk: 'read', effect: 'view',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, value: pensList(ctx)} : r; },
      description: 'Use Pen: picks up gallery pen `index` with its colour and thickness.', params: s.object({index: s.integer({min: 0})}), run: usePen},
    {id: 'draw.penColor', label: 'Pen Color', risk: 'edit',
      state: ctx => { const r = ready(ctx); if (!r.enabled) return r; const d = drawOf(ctx); return {enabled: true, value: `#${hex(d[dToolOf(d)].color)}`}; },
      description: 'Pen Color: the colour of the pen in use (and of its gallery pen); while ink is lasso-selected, the selection\'s outline colour.', params: s.object({color: s.string({max: 16})}), run: penColor},
    {id: 'draw.penWidth', label: 'Pen Thickness', risk: 'read', effect: 'prefs',
      state: (ctx, p) => {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const d = drawOf(ctx), tool = dToolOf(d);
        if (p?.width !== undefined) return {enabled: true, checked: Math.abs(d[tool].width - Number(p.width)) < 0.01};
        return {enabled: true, value: THICKNESS[tool].map(w => ({id: String(w), label: `${w} pt`, value: w})), };
      },
      description: 'Pen Thickness: the thickness (points) of the pen in use (and of its gallery pen).', params: s.object({width: s.number()}), run: penWidth},
    {id: 'draw.stroke', label: 'Draw Ink', risk: 'edit', state: ready,
      description: 'Draw Ink: an ink stroke through `points` (page points, at most 5000) on `page`, with the pen in use or `tool`, `color` and `width`; one undo step.',
      params: s.object({page: s.integer({min: 0}), points: s.array(s.array(s.number())), tool: s.optional(s.string({max: 16})), color: s.optional(s.string({max: 16})), width: s.optional(s.number())}), run: stroke},
    {id: 'draw.erase', label: 'Erase Ink', risk: 'edit', state: ready, description: 'Erase Ink: deletes the ink stroke on `page` under (`x`, `y`) points.',
      params: s.object({page: s.integer({min: 0}), x: s.number(), y: s.number()}), run: erase},
    {id: 'draw.inkToShape', label: 'Ink to Shape', risk: 'edit',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: drawOf(ctx).inkToShape} : r; },
      description: 'Ink to Shape: converts the lasso-selected strokes to shapes, or turns Ink to Shape on or off (`value`): strokes drawn then that look like a shape become it.',
      params: s.object({value: s.optional(s.boolean())}), run: inkToShape},
    {id: 'draw.convertInk', label: 'Convert to Shapes', risk: 'edit', state: lassoState, description: 'Convert to Shapes: the lasso-selected strokes that look like shapes become those shapes (a line and an arrowhead become one arrow).', params: NONE, run: convertSelection},
    {id: 'draw.replay', label: 'Ink Replay', risk: 'read', effect: 'view',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: drawOf(ctx).replay} : r; },
      description: 'Ink Replay: starts or stops (`value`) playing the strokes back in the order they were drawn; returns that order.', params: s.object({value: s.optional(s.boolean())}), run: replay},
    {id: 'review.hideInk', label: 'Hide Ink', risk: 'read', effect: 'view',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: hideInkOf(ctx)} : r; },
      description: 'Hide Ink: the ink strokes are not drawn, erased or lasso-selected while hidden; `value` sets it.', params: s.object({value: s.optional(s.boolean())}),
      run: (ctx, p) => { const value = typeof p.value === 'boolean' ? p.value : !hideInkOf(ctx); ctx.setView({hideInk: value}); return {value}; }},
  ],
});

export {isInk, inkDefaultColor, inkDefaultWidth, shapeName};
