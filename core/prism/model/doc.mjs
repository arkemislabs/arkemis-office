// Schema-2 document helpers for Prism commands and the surface: where things are in the content
// tree, the current slide and selected shapes (deckcraft engine `Selection`, carried as kernel
// selection addresses), id allocation through the change API, and whole-object writes that keep
// addresses and anchors mapping correctly.
// Follows deckcraft crates/engine/src/lib.rs (Selection, DocState) and crates/engine/src/cmd.rs
// (current_shapes, xfrm_of, has_slide/has_selection) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Selection (kernel `{ranges: [{anchor, focus}], primary}`), as deckcraft's Selection:
//   current slide, nothing selected      → one range `/sl:<id>`
//   slides selected in the thumbnail pane → one range `/sl:<id>` per slide (in order picked)
//   shapes selected on the current slide  → one range `/sl:<id>/sp:<id>` per shape (group members
//                                           as `/sl:<id>/sp:<group>/sp:<child>`)
//   text being edited                     → one range: anchor `/sl:<id>/sp:<id>/t:<a>`, focus
//                                           `/sl:<id>/sp:<id>/t:<b>` (body offsets, UTF-16)
//   speaker notes being edited            → `/sl:<id>/notes/t:<a>` … `/sl:<id>/notes/t:<b>`
//   table cell text                       → `/sl:<id>/sp:<tbl>/r:<i>/c:<j>/t:<a>` …
// Writing rule for commands: change a shape or slide by replacing the whole object
// (`replaceShape`, `replaceSlide`) or by `set` on a field path below it; text edits replace the
// shape (or its `text`) so anchors on text map through the edit (see address.mjs mapThrough).

import {findShape, shapePath, walk, allocId, masterFor, slideTitle, isGroup, virtualSlide, virtualTarget} from './presentation.mjs';
import {ctxForSlide, xfrm as resolveXfrm} from './resolve.mjs';
import {parse} from '../address.mjs';

/** Is this Prism schema-2 content (a deckcraft Presentation)? */
export const isSchema2 = c => !!c && typeof c === 'object' && Array.isArray(c.masters) && !!c.slideSize;

export const slideAddress = id => `/sl:${id}`;
/** Address of a shape: `chain` is the group chain down to the shape (ids). */
export const shapeAddress = (slideId, chain) => `/sl:${slideId}${(Array.isArray(chain) ? chain : [chain]).map(id => `/sp:${id}`).join('')}`;
export const textAddress = (slideId, chain, off) => `${shapeAddress(slideId, chain)}/t:${off}`;

/** Parse a selection range endpoint into {slide, chain: shapeIds, text?, notes?, cell?}. */
export function parseSel(addr) {
  let ast;
  try { ast = parse(addr); } catch { return null; }
  const out = {slide: null, chain: [], text: null, notes: false, cell: null};
  for (const sg of ast.segments ?? []) {
    if (sg.kind === 'sl') out.slide = sg.key;
    else if (sg.kind === 'sp') out.chain.push(sg.key);
    else if (sg.kind === 'notes') out.notes = true;
    else if (sg.kind === 'r') out.cell = [Number(sg.key), out.cell?.[1] ?? 0];
    else if (sg.kind === 'c') out.cell = [out.cell?.[0] ?? 0, Number(sg.key)];
    else if (sg.kind === 't') { const [a] = String(sg.key).split('-'); out.text = Number(a); }
  }
  return out.slide === null ? null : out;
}

/** The current slide id (deckcraft `selection.slide`): the primary selection's slide, else `activeSlideId`, else the first. */
export function currentSlideId(content, selection) {
  const slides = content?.slides ?? [];
  const ranges = selection?.ranges ?? [];
  const order = ranges.length ? [ranges[selection.primary ?? 0], ...ranges] : [];
  for (const r of order) {
    const p = r && parseSel(r.focus ?? r.anchor);
    if (p && (slides.some(s => s.id === p.slide) || virtualTarget(content, p.slide))) return p.slide;
  }
  if (content?.activeSlideId && slides.some(s => s.id === content.activeSlideId)) return content.activeSlideId;
  return slides[0]?.id ?? null;
}
export function currentSlideIndex(content, selection) {
  const id = currentSlideId(content, selection);
  const i = (content?.slides ?? []).findIndex(s => s.id === id);
  return i < 0 ? 0 : i;
}
/** Slides selected in the thumbnail pane (deckcraft `selection.slides`), in document order. */
export function selectedSlideIds(content, selection) {
  const ids = new Set();
  for (const r of selection?.ranges ?? []) {
    const p = parseSel(r.anchor);
    if (p && !p.chain.length && !p.notes) ids.add(p.slide);
  }
  return (content?.slides ?? []).filter(s => ids.has(s.id)).map(s => s.id);
}
/** Selected shapes on the current slide (deckcraft `selection.shapes`): ids of the last chain element, in selection order. */
export function selectedShapeIds(content, selection) {
  const cur = currentSlideId(content, selection);
  const out = [];
  for (const r of selection?.ranges ?? []) {
    const p = parseSel(r.anchor);
    if (p && p.slide === cur && p.chain.length && !out.includes(p.chain[p.chain.length - 1])) out.push(p.chain[p.chain.length - 1]);
  }
  return out;
}
/** The text selection (deckcraft `TextSel`): {slide, chain, shape, anchor, caret, notes, cell} or null. */
export function textSelection(content, selection) {
  const r = selection?.ranges?.[selection.primary ?? 0];
  if (!r) return null;
  const a = parseSel(r.anchor), f = parseSel(r.focus ?? r.anchor);
  if (!a || !f || a.text === null || f.text === null) return null;
  return {slide: a.slide, chain: a.chain, shape: a.chain[a.chain.length - 1] ?? null, anchor: a.text, caret: f.text, notes: a.notes, cell: a.cell};
}

/** Selection objects for the kernel. */
export const selectSlides = ids => ({ranges: ids.map(id => ({anchor: slideAddress(id), focus: slideAddress(id)})), primary: Math.max(ids.length - 1, 0)});
export const selectShapes = (slideId, chains) => (chains.length
  ? {ranges: chains.map(c => ({anchor: shapeAddress(slideId, c), focus: shapeAddress(slideId, c)})), primary: chains.length - 1}
  : selectSlides([slideId]));
export const selectText = (slideId, chain, anchor, caret) => ({ranges: [{anchor: textAddress(slideId, chain, anchor), focus: textAddress(slideId, chain, caret)}], primary: 0});
export const selectNotes = (slideId, anchor, caret) => ({ranges: [{anchor: `/sl:${slideId}/notes/t:${anchor}`, focus: `/sl:${slideId}/notes/t:${caret}`}], primary: 0});

export const slideById = (content, id) => (content?.slides ?? []).find(s => s.id === id) ?? virtualSlide(content, id);
/** A slide's size: the deck's, or the page of a handout or notes master being edited. */
export const slideSizeOf = (content, slide) => slide?.size ?? content.slideSize;
/** The group chain (ids from the top-level shape down) to shape `id` on a slide; null when absent. */
export function shapeChain(sl, id) {
  const chain = [];
  const rec = (list, depth) => {
    if (depth > 64) return false;
    for (const s of list ?? []) {
      chain.push(s.id);
      if (s.id === id) return true;
      if (isGroup(s) && rec(s.kind.children, depth + 1)) return true;
      chain.pop();
    }
    return false;
  };
  return rec(sl?.shapes, 0) ? chain : null;
}
/** JSON path of slide `slideId` (`['slides', i]`) or null. */
export function slidePath(content, slideId) {
  const i = (content?.slides ?? []).findIndex(s => s.id === slideId);
  if (i >= 0) return ['slides', i];
  return virtualTarget(content, slideId)?.path ?? null;
}
/** content with slide put back: a real slide in slides, a virtual one's shapes into its master, layout, handout or notes master. */
export function withSlideReplaced(content, slide) {
  const i = (content.slides ?? []).findIndex(s => s.id === slide.id);
  if (i >= 0) { const slides = content.slides.slice(); slides[i] = slide; return {...content, slides}; }
  const t = virtualTarget(content, slide.id);
  if (!t) return content;
  const next = {...t.node, shapes: slide.shapes};
  if (t.kind === 'handout') return {...content, handoutMaster: next};
  if (t.kind === 'notes') return {...content, notesMaster: next};
  const masters = content.masters.slice();
  masters[t.mi] = t.kind === 'master' ? next : {...masters[t.mi], layouts: masters[t.mi].layouts.map((l, k) => (k === t.li ? next : l))};
  return {...content, masters};
}
/** JSON path of shape `shapeId` on slide `slideId` (groups included) or null. */
export function shapeJsonPath(content, slideId, shapeId) {
  const sp = slidePath(content, slideId);
  if (!sp) return null;
  const rel = shapePath(slideById(content, slideId)?.shapes, shapeId);
  return rel ? [...sp, 'shapes', ...rel] : null;
}
export const shapeOn = (content, slideId, shapeId) => findShape(slideById(content, slideId)?.shapes, shapeId);

/** The shape's effective box (deckcraft `cmd::xfrm_of`): its own, else the placeholder chain's. */
export function xfrmOf(content, slideId, sh) {
  const sl = slideById(content, slideId);
  const ctx = sl ? ctxForSlide(content, sl) : null;
  return ctx ? resolveXfrm(ctx, sh) : sh.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
}

/**
 * Allocate `n` fresh ids through the change API (deckcraft `alloc_id` repeated): writes `nextId`
 * once. Throws when the deck has run out of ids.
 */
export function allocIds(ctx, n = 1) {
  let p = ctx.doc;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const a = allocId(p);
    if (!a) throw Object.assign(new Error('the presentation has run out of object ids'), {code: 'invalid_params'});
    ids.push(a[0]);
    p = {...p, nextId: a[1]};
  }
  if (n > 0) ctx.change.set(['nextId'], p.nextId);
  return ids;
}

/** Replace a shape object (found by id on slide `slideId`). */
export function replaceShape(ctx, slideId, sh) {
  const path = shapeJsonPath(ctx.doc, slideId, sh.id);
  if (!path) throw Object.assign(new Error(`no shape ${sh.id}`), {code: 'not_found'});
  ctx.change.set(path, sh);
}
/** Replace a slide object (by id). */
export function replaceSlide(ctx, sl) {
  const path = slidePath(ctx.doc, sl.id);
  if (!path) throw Object.assign(new Error(`no slide ${sl.id}`), {code: 'not_found'});
  ctx.change.set(path, sl);
}

/** deckcraft `cmd::has_slide`/`has_selection` state helpers (disabled reasons verbatim). */
export const hasSlideState = content => (isSchema2(content) || Array.isArray(content?.slides)
  ? (content.slides.length ? {enabled: true} : {enabled: false, reason: 'no slides'}) : {enabled: false, reason: 'no presentation open'});

/** Thumbnail/outline title of a slide. */
export {slideTitle, masterFor, walk};
