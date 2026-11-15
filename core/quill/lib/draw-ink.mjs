// The Draw tab's engine: what dragging on the page does (select, lasso, eraser, a pen), each pen's
// colour and thickness, ink strokes laid out on a page, where a new stroke is anchored, the lasso, and
// Ink to Shape / Ink Replay.
//
// Translated from wordcraft crates/engine/src/cmd/draw.rs (`DrawMode`, `PenSettings`, `CustomPen`,
// `DrawState`, `PlacedInk`, `ink_on`, `ink_at`, `points_param`, `delete_object`, `next_order`, `place`,
// `lasso_selection`, `inside`, `convert_at`, `set_shape`, `arrow_pieces`, `pair_with_neighbour`,
// `strokes_in_drawing_order`) and crates/engine/src/cmd/objects/arrange.rs (`anchor_paragraph`,
// `nearest_line`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// An ink stroke is a floating freeform shape (`{type: 'shape', kind: 'freeform', freeform: {ink, order,
// paths}, stroke, strokeWidth, float}`) anchored to the paragraph under where it starts, in front of the
// text (a highlighter's behind it). The draw state is the document view (`view.draw`): the tool, the
// pens, Ink to Shape, the lasso selection (valid while the document is as it was) and Ink Replay; the
// pen gallery is a preference. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {BODY, cmpPos} from '../model/document.mjs';
import {columnBoxes, sectionOf} from '../model/section.mjs';
import {Spin} from './geom.mjs';
import {pageLines} from '../layout/hit.mjs';
import {
  MAX_POINTS, MAX_INK_PER_PAGE, INK_TOOLS, parseInkTool, inkDefaultColor, inkDefaultWidth, inkFreeform, freeformDistance, placedPaths, sanitizedFreeform,
} from '../model/freeform.mjs';
import {recognise, arrowParts, pairParts, shapeName, shapeBounds} from './draw-shape.mjs';

/** Thinnest and thickest ink, points. */
export const MIN_WIDTH = 0.25;
export const MAX_WIDTH = 72;
/** How far from a stroke (beyond its half width) the eraser still takes it, points. */
export const ERASE_SLOP = 3;
/** Most points of a lasso loop that are kept (a longer loop is thinned out). */
export const MAX_LASSO_POINTS = 512;
/** Points of a stroke tested against the lasso (spread along it). */
export const LASSO_SAMPLES = 64;
/** Farthest the lasso moves its selection in one step, points. */
export const MAX_MOVE = 10_000;
/** Most pens the gallery keeps. */
export const MAX_PENS = 24;
export const MODES = Object.freeze(['select', 'lasso', 'eraser', ...INK_TOOLS]);

const params = m => new CommandError('invalid_params', m);
const failed = m => new CommandError('failed', m);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---- the state ------------------------------------------------------------------------------------------

const penOf = tool => ({color: inkDefaultColor(tool), width: inkDefaultWidth(tool)});
export const defaultDraw = () => ({mode: 'select', pen: penOf('pen'), pencil: penOf('pencil'), highlighter: penOf('highlighter'), inkToShape: false, lasso: null, replay: false, gallery: null});

/** The Draw state of a command context, with upstream's defaults. */
export function drawOf(ctx) {
  const v = ctx?.view?.draw ?? {};
  const d = defaultDraw();
  return {...d, ...v, pen: {...d.pen, ...v.pen}, pencil: {...d.pencil, ...v.pencil}, highlighter: {...d.highlighter, ...v.highlighter}};
}
export const setDraw = (ctx, patch) => ctx.setView({draw: {...drawOf(ctx), ...patch}});
export const hideInkOf = ctx => !!ctx?.view?.hideInk;

/**
 * The pens a fresh profile has, as Word's Draw tab starts: a black pen, a red pen, a blue pen, a pencil and a yellow highlighter
 * (wordcraft ships an empty gallery; Word's own default pens are these). Until the person adds, removes or changes a pen the gallery
 * is this list; from then on it is their list (preference `draw.pens`), also when they removed every pen.
 */
export const DEFAULT_PENS = Object.freeze([
  {kind: 'pen', color: [0, 0, 0], width: 1.5},
  {kind: 'pen', color: [255, 0, 0], width: 1.5},
  {kind: 'pen', color: [0, 112, 192], width: 1.5},
  {kind: 'pencil', color: [0, 0, 0], width: 1},
  {kind: 'highlighter', color: [255, 255, 0], width: 12},
].map(p => Object.freeze(p)));

/** The pen gallery (Draw › Drawing Tools): the person's saved pens (junk dropped), or the defaults when none were ever saved. */
export function pensOf(ctx) {
  const saved = ctx?.prefs?.draw?.pens;
  if (!Array.isArray(saved)) return DEFAULT_PENS.map(p => ({...p, color: [...p.color]}));
  const out = [];
  for (const v of saved) {
    if (out.length >= MAX_PENS) break;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    try { out.push(customPen(v)); } catch { /* a saved pen that is not one is dropped */ }
  }
  return out;
}

/** A pen from `{kind?, color?, width?}` (the kind's defaults for what is left out; the width clamped) (custom_pen). */
export function customPen(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw params('a pen is {"kind", "color", "width"}');
  let kind = 'pen';
  if (v.kind !== undefined && v.kind !== null) { kind = parseInkTool(v.kind); if (!kind) throw params('`kind` is pen, pencil or highlighter'); }
  let color = inkDefaultColor(kind);
  if (v.color !== undefined && v.color !== null) { color = parseColor(v.color); if (!color) throw params('`color` is RRGGBB'); }
  const width = Number.isFinite(v.width) ? clamp(v.width, MIN_WIDTH, MAX_WIDTH) : inkDefaultWidth(kind);
  return {kind, color, width};
}

export function parseColor(s) {
  if (Array.isArray(s) && s.length === 3 && s.every(Number.isFinite)) return s.map(x => clamp(Math.round(x), 0, 255));
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(t) ? [0, 2, 4].map(i => Number.parseInt(t.slice(i, i + 2), 16)) : null;
}
export const hex = c => c.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');

/** The state as the commands report it (colours as RRGGBB). */
export function stateJson(ctx) {
  const d = drawOf(ctx);
  const pen = p => ({color: hex(p.color), width: p.width});
  return {mode: d.mode, pen: pen(d.pen), pencil: pen(d.pencil), highlighter: pen(d.highlighter), pens: pensOf(ctx).map(p => ({kind: p.kind, color: hex(p.color), width: p.width})),
    inkToShape: d.inkToShape, replay: d.replay, hideInk: hideInkOf(ctx), lasso: lassoSelection(ctx) ? lassoSelection(ctx).items.length : 0};
}

// ---- the lasso selection ----------------------------------------------------------------------------------

/** The current lasso selection, if the document hasn't changed under it. */
export function lassoSelection(ctx) {
  const l = drawOf(ctx).lasso;
  return l && l.version === ctx.version && l.items?.length ? l : null;
}
/** Keep `sel` selected after the mutating command running now (which bumps the version once). */
export const keepLasso = (ctx, sel) => setDraw(ctx, {lasso: {...sel, version: (ctx.version ?? 0) + 1}});

// ---- pages and ink ----------------------------------------------------------------------------------------------

export const posJson = p => ({story: p.story, path: [...p.path], off: p.off});
const samePos = (a, b) => a.story === b.story && a.off === b.off && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);

/** The object at `pos` in `d`, or null. */
export const objectAtPos = (d, pos) => { const p = d.para(pos.story, pos.path); return p ? P.objectAt(p, pos.off) : null; };

/** Ink strokes laid out on `page`, in the page's drawing order (ink_on): {pos, rect, spin, freeform, color, width}. */
export function inkOn(d, layout, page) {
  const pg = layout?.pages?.[page];
  if (!pg) return [];
  const out = [];
  for (const it of pg.items) {
    if (it.kind !== 'object') continue;
    const o = objectAtPos(d, it);
    if (o?.type === 'shape' && o.freeform?.ink) {
      out.push({pos: {story: it.story, path: it.path, off: it.off}, rect: it.rect, spin: new Spin(o.float?.rot ?? 0, o.float?.flipH, o.float?.flipV), freeform: o.freeform,
        color: o.stroke ?? null, width: Number.isFinite(o.strokeWidth) ? o.strokeWidth : 1});
    }
  }
  return out;
}

/** The ink stroke on `page` under (x, y), topmost first; none while ink is hidden (ink_at). */
export function inkAt(ctx, d, layout, page, x, y) {
  if (hideInkOf(ctx) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const all = inkOn(d, layout, page);
  for (let i = all.length - 1; i >= 0; i--) {
    const k = all[i];
    const reach = clamp(k.width, 0, MAX_WIDTH) / 2 + ERASE_SLOP;
    // A turned stroke is drawn turned about its frame's centre: test the point turned back into the stroke's own frame.
    const r = k.rect;
    const [u, v] = k.spin.unapply(r.x + r.w / 2, r.y + r.h / 2, x, y);
    const dist = freeformDistance(k.freeform, r.x, r.y, r.w, r.h, u, v);
    if (dist !== null && dist <= reach) return k.pos;
  }
  return null;
}

/** The page `v.page` names (0-based) in the layout, or an error (page_param). */
export function pageParam(layout, v) {
  const page = v?.page;
  if (!Number.isInteger(page) || page < 0) throw params('`page` (0-based) is required');
  if (!layout || page >= layout.pages.length) throw params(`no page ${page}`);
  return page;
}

/** `points` as page points: at most `max`, malformed ones dropped, each clamped to the pw × ph page (points_param). */
export function pointsParam(v, max, pw, ph) {
  if (!Array.isArray(v?.points)) throw params('`points` ([[x, y], …]) is required');
  const out = [];
  for (const pt of v.points.slice(0, max)) {
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    out.push([clamp(pt[0], 0, pw), clamp(pt[1], 0, ph)]);
  }
  return out;
}

/** Delete the object at `pos`, keeping the text selection on the same text (delete_object). */
export function deleteObject(S, pos) {
  S.d.deleteRange(pos, {...pos, off: pos.off + 1});
  for (const k of ['anchor', 'focus']) {
    const at = S.sel[k];
    if (at.story === pos.story && at.path.length === pos.path.length && at.path.every((v, i) => v === pos.path[i]) && at.off > pos.off) S.sel = {...S.sel, [k]: {...at, off: Math.max(pos.off, at.off - 1)}};
  }
}

/** The next stroke's place in the drawing order: one after the latest drawn (next_order). */
export function nextOrder(d) {
  let latest = 0;
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    for (const o of p?.objects ?? []) if (o.type === 'shape' && Number.isFinite(o.freeform?.order)) latest = Math.max(latest, o.freeform.order);
  }
  return latest + 1;
}

/** The top-level paragraph of `story` under (x, y) on `page` (anchor_paragraph). */
export function anchorParagraph(d, layout, page, [x, y], story) {
  const pg = layout.pages[page];
  if (!pg) return null;
  const items = story === BODY ? pg.items : pg.header.concat(pg.footer);
  const pieces = items.filter(it => it.kind === 'lines' && it.story === story && it.path.length === 1).map(it => ({path: it.path, left: it.x, top: it.y, starts: it.l0 === 0}));
  const starts = pieces.filter(p => p.starts).map(p => [p.path, p.top]);
  const boxes = story === BODY ? columnBoxes(sectionOf(d.sections()[pg.section]?.[1])) : [];
  const cols = boxes.map(([cx, w]) => [pg.body.x + cx, pg.body.x + cx + w]).filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1])).sort((a, b) => a[0] - b[0]);
  const colOf = px => { for (let i = cols.length - 1; i >= 0; i--) if (cols[i][0] <= px + 0.5) return i; return 0; };
  const col = colOf(x);
  const inCol = pieces.filter(p => p.starts && colOf(p.left) === col).map(p => [p.path, p.top]);
  const pick = v => { for (let i = v.length - 1; i >= 0; i--) if (v[i][1] <= y + 0.5) return v[i][0]; return v[0]?.[0] ?? null; };
  return pick(inCol) ?? pick(starts);
}

/** The start of the top-level line of `story` on `page` nearest to `y` (nearest_line). */
export function nearestLine(layout, page, y, story) {
  const pg = layout.pages[page];
  if (!pg) return null;
  const lines = pageLines(pg, story).filter(l => l.path.length === 1);
  const d = l => (y < l.top ? l.top - y : Math.max(y - l.bottom, 0));
  let best = null;
  for (const l of lines) if (best === null || d(l) < d(best)) best = l;
  if (!best) return null;
  return {story, path: best.path, off: best.para.lines[best.li]?.start ?? 0};
}

// ---- Ink to Shape -----------------------------------------------------------------------------------------------

/** The object at `pos` with `f(object)` applied (a copy), owned for changing in `S`. */
function updateObject(S, pos, f) {
  const q = S.d.paraMut(pos.story, pos.path);
  const k = P.objectsWithOffsets(q).findIndex(([off]) => off === pos.off);
  if (k < 0) return false;
  q.objects = q.objects.map((o, i) => (i === k ? f({...o}) : o));
  return true;
}

/** Make the drawing at `pos` the shape `found` (given in the drawing's own frame), keeping its colour and thickness, where it is (set_shape). */
export function setShape(S, pos, found) {
  const o = objectAtPos(S.d, pos);
  if (o?.type !== 'shape') throw failed('no drawing there');
  const [bx, by, bw0, bh0] = shapeBounds(found);
  const [bw, bh] = [Math.max(bw0, 1), Math.max(bh0, 1)];
  const outline = (pts, closed) => sanitizedFreeform({w: bw, h: bh, paths: [{pts, closed}], alpha: 1});
  const local = c => c.map(([x, y]) => [x - bx, y - by]);
  updateObject(S, pos, n => {
    const float = {...n.float};
    const extra = {...(n.extra ?? {})};
    let kind, geometry = null;
    switch (found.type) {
      case 'rectangle': kind = 'rectangle'; break;
      case 'ellipse': kind = 'ellipse'; break;
      case 'line': kind = 'freeform'; geometry = outline(local([found.a, found.b]), false); break;
      case 'polygon': kind = 'freeform'; geometry = outline(local(found.corners), true); break;
      default: {
        // A straight connector runs from its frame's top-left to bottom-right; flips turn it.
        float.flipH = found.b[0] < found.a[0];
        float.flipV = found.b[1] < found.a[1];
        extra.arrowEnd = !!found.headAtEnd;
        extra.arrowStart = !!found.headAtStart;
        kind = 'straightConnector';
      }
    }
    n.kind = kind;
    if (geometry) n.freeform = geometry; else delete n.freeform;
    n.fill = null;
    if (found.type === 'arrow') { n.w = bw0; n.h = bh0; } else { n.w = bw; n.h = bh; }
    float.x = (float.x ?? 0) + bx;
    float.y = (float.y ?? 0) + by;
    n.float = float;
    if (Object.keys(extra).length) n.extra = extra;
    return n;
  });
}

/** Replace the ink stroke at `pos` by the shape it looks like (convert_at): the shape's name, or null (nothing changed). */
export function convertAt(S, pos) {
  const o = objectAtPos(S.d, pos);
  if (o?.type !== 'shape') return null;
  const f = o.freeform;
  if (!f || !['pen', 'pencil'].includes(f.ink) || f.paths.length !== 1) return null;
  const fl = o.float ?? {};
  if ((fl.rot ?? 0) !== 0 || fl.flipH || fl.flipV) return null;
  // The stroke in its frame's own points (the frame may have been resized since).
  const placed = placedPaths(f, 0, 0, o.w, o.h)[0];
  if (!placed) return null;
  const found = recognise(placed[0]);
  if (!found) return null;
  setShape(S, pos, found);
  return shapeName(found);
}

/** The pieces of two-stroke arrows on `page` that `keep` accepts (arrow_pieces). */
export function arrowPieces(S, layout, page, keep, hide) {
  const pg = layout.pages[page];
  if (!pg) return [];
  const out = [];
  for (const it of pg.items) {
    if (it.kind !== 'object') continue;
    const pos = {story: it.story, path: it.path, off: it.off};
    if ((it.rot ?? 0) !== 0 || !keep(pos, it.rect)) continue;
    const o = objectAtPos(S.d, pos);
    if (o?.type !== 'shape' || !o.freeform || o.freeform.paths.length !== 1) continue;
    const f = o.freeform, fp = f.paths[0];
    const pen = ['pen', 'pencil'].includes(f.ink) && !hide;
    const shape = !f.ink && o.kind === 'freeform' && ((fp.pts.length === 2 && !fp.closed) || (fp.pts.length === 3 && fp.closed));
    const fl = o.float ?? {};
    if (!(pen || shape) || (fl.rot ?? 0) !== 0 || fl.flipH || fl.flipV) continue;
    const placed = placedPaths(f, it.rect.x, it.rect.y, it.rect.w, it.rect.h)[0];
    if (!placed) continue;
    const pts = placed[0].slice();
    if (placed[1] && pts[0]) pts.push(pts[0]);
    out.push({pos, rect: it.rect, order: f.order ?? null, parts: arrowParts(pts)});
  }
  return out;
}

const near = (a, b) => {
  const reach = 0.2 * Math.max(a.w, a.h, b.w, b.h);
  const grow = (r, g) => ({x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g});
  const x = grow(a, reach), y = grow(b, reach);
  return Number.isFinite(reach) && x.x <= y.x + y.w && y.x <= x.x + x.w && x.y <= y.y + y.h && y.y <= x.y + x.h;
};
export {near};

/** `shape` (in page points) in the frame of the object laid out at `rect` (local_to). */
export function localTo(shape, rect) {
  const m = ([x, y]) => [x - rect.x, y - rect.y];
  switch (shape.type) {
    case 'arrow': return {...shape, a: m(shape.a), b: m(shape.b)};
    case 'line': return {...shape, a: m(shape.a), b: m(shape.b)};
    case 'rectangle': case 'ellipse': return {...shape, x: shape.x - rect.x, y: shape.y - rect.y};
    default: return {...shape, corners: shape.corners.map(m)};
  }
}

/** Where `pos` is once the objects at `deleted` (none of them `pos`) are gone (after_deleting). */
export function afterDeleting(pos, deleted) {
  const before = deleted.filter(d => d.story === pos.story && d.path.length === pos.path.length && d.path.every((v, i) => v === pos.path[i]) && d.off < pos.off).length;
  return {...pos, off: Math.max(0, pos.off - before)};
}

/** Ink to Shape while drawing: when the stroke just drawn at `nw` and another on the page are a line and an arrowhead (either drawn first), make the line an arrow and drop the head. Returns where the arrow is (pair_with_neighbour). */
export function pairWithNeighbour(S, layout, page, nw, hide) {
  const mine = layout.pages[page]?.items.find(it => it.kind === 'object' && samePos(it, nw))?.rect;
  if (!mine) return null;
  // Only the new stroke and its neighbours are recognised, not the whole page.
  const pieces = arrowPieces(S, layout, page, (pos, rect) => samePos(pos, nw) || near(mine, rect), hide);
  const at = pieces.findIndex(k => samePos(k.pos, nw));
  if (at < 0) return null;
  const me = pieces.splice(at, 1)[0];
  // The most recently drawn first; shapes and ink from files don't record an order and come after, latest on the page first.
  pieces.sort((a, b) => (b.order ?? -1) - (a.order ?? -1) || cmpPos(b.pos, a.pos));
  for (const other of pieces) {
    for (const [line, head] of [[other, me], [me, other]]) {
      const arrow = pairParts(line.parts, head.parts);
      if (arrow) {
        setShape(S, line.pos, localTo(arrow, line.rect));
        deleteObject(S, head.pos);
        return afterDeleting(line.pos, [head.pos]);
      }
    }
  }
  return null;
}

/** Whether (x, y) is inside the closed loop `poly` (even–odd rule) (inside). */
export function inside(poly, x, y) {
  const n = poly.length;
  let odd = false;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + n - 1) % n];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) odd = !odd;
  }
  return odd;
}

/** Every ink stroke in the document with its page, in the order it was drawn (strokes_in_drawing_order). */
export function strokesInDrawingOrder(ctx, d, layout) {
  if (hideInkOf(ctx)) return [];
  const all = [];
  for (let page = 0; page < layout.pages.length; page++) for (const k of inkOn(d, layout, page)) all.push({page, ...k});
  all.sort((a, b) => (a.freeform.order ?? 0) - (b.freeform.order ?? 0));
  return all;
}

export {MAX_POINTS, MAX_INK_PER_PAGE, inkFreeform, nextOrder as drawingOrderNext};
