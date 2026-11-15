// The text being edited, read and written through the kernel: deckcraft's `TextSel` (shape,
// anchor and caret as (paragraph, char), cell, notes, line end) carried as one kernel selection
// range of text addresses, the body it edits (`body_of` / `body_mut`), `edit_text` (edit the body
// and the selection together, reset the shrink scale, refit an auto-sizing text box), the text
// layout used for caret movement, and the deckcraft engine's predicates and param helpers the
// slide, text, edit, selection and find families share.
// Translated from deckcraft crates/engine/src/cmd/text.rs (`body_of`, `body_mut`, `edit_text`),
// crates/engine/src/cmd/text/layout.rs (`fit_text_box`, `fit_shrink_scale`, `layout_for`,
// `pos_param`), crates/engine/src/cmd.rs (`has_doc`, `has_slide`, `has_selection`, `has_text`,
// `bad`, `opt_usize_param`, `id_param`, `ids_param`, `targets`, `current_names`, `NO_ID_SPACE`) and
// crates/engine/src/lib.rs (`TextSel`, `Selection`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/text owns this file; the
// other Prism units import it. No DOM, no Node built-ins.
//
// Units: positions are [paragraph, offset] with UTF-16 offsets (core/prism/model/edit.mjs); the
// kernel selection carries flat body offsets (`\n` between paragraphs), see model/doc.mjs.

import {CommandError} from '../../kernel/errors.mjs';
import {posOf, offsetOf, paraLen} from '../model/text.mjs';
import {findShape, walk, isGroup} from '../model/presentation.mjs';
import {
  isSchema2, currentSlideId, selectedSlideIds, selectedShapeIds, textSelection, slideById, shapeChain, slidePath, shapeJsonPath,
  shapeAddress, selectShapes, xfrmOf,
} from '../model/doc.mjs';
import {ctxForSlide, body as resolveBody} from '../model/resolve.mjs';
import {layoutText} from '../model/textlayout.mjs';
import {shapeGeometry} from '../model/render.mjs';

export const UPSTREAM_COMMIT = 'f893f6af7d36a5409fd804e81a34fd895cfefedf';

// ---------------------------------------------------------------------------------------------
// Errors, predicates and params (deckcraft cmd.rs)

export const NO_TEXT_POINT = 'no text insertion point';
export const NOTHING_SELECTED = 'nothing selected';
export const SELECT_TEXT_OR_SHAPE = 'select text or a shape';
export const NO_ID_SPACE = 'the presentation has used every object id and can hold no more';

/** deckcraft `bad(cmd, msg)`: a BadParams error naming the command. */
export const bad = (cmd, msg, data) => new CommandError('invalid_params', `${cmd}: ${msg}`, {command: cmd, ...(data ?? {})});

const noDoc = {enabled: false, reason: 'no presentation open'};
export const hasDoc = ctx => (isSchema2(ctx.doc) ? {enabled: true} : noDoc);
export const hasSlide = ctx => (!isSchema2(ctx.doc) ? noDoc : ctx.doc.slides.length ? {enabled: true} : {enabled: false, reason: 'no slides'});
export const hasSelection = ctx => (!isSchema2(ctx.doc) ? noDoc
  : selectedShapeIds(ctx.doc, ctx.selection).length ? {enabled: true} : {enabled: false, reason: NOTHING_SELECTED});
export const hasText = ctx => (!isSchema2(ctx.doc) ? noDoc : textSelection(ctx.doc, ctx.selection) ? {enabled: true} : {enabled: false, reason: NO_TEXT_POINT});
export const always = () => ({enabled: true});

/** Throw the predicate's reason when it fails (the kernel checks `state` too; bridges may call run directly in tests). */
export function need(ctx, pred, cmd) {
  const st = pred(ctx);
  if (!st.enabled) throw new CommandError('disabled', `${cmd}: ${st.reason}`, {command: cmd, reason: st.reason});
}

/**
 * `opt_usize_param`: undefined when absent or null; an error when present but not a valid index
 * (negative, fractional, not a number), so a bad index never falls back to the selection.
 */
export function optIndex(p, key, cmd) {
  const v = p?.[key];
  if (v === undefined || v === null) return undefined;
  if (!Number.isSafeInteger(v) || v < 0) throw bad(cmd, `\`${key}\` is not a valid index: ${JSON.stringify(v)}`, {path: `/${key}`});
  return v;
}
/** `usize_param`: a non-negative integer or undefined (anything else is ignored). */
export const usizeParam = (p, key) => (Number.isSafeInteger(p?.[key]) && p[key] >= 0 ? p[key] : undefined);

/** Shape ids are strings in schema 2; the bridge may send numbers (deckcraft's u32 ids). */
export const idOf = v => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && v ? v : null);
/** `id_param`: undefined when absent, an error when present but invalid. */
export function idParam(p, key, cmd) {
  const v = p?.[key];
  if (v === undefined || v === null) return undefined;
  const id = idOf(v);
  if (id === null) throw bad(cmd, `\`${key}\` is not a valid shape id: ${JSON.stringify(v)}`, {path: `/${key}`});
  return id;
}
/** `ids_param`: the valid ids of an array param (others dropped), or undefined when absent. */
export const idsParam = (p, key) => (Array.isArray(p?.[key]) ? p[key].map(idOf).filter(x => x !== null) : undefined);
/** `pos_param`: `[paragraph, char]` or undefined. */
const idx = v => (Number.isInteger(v) && v >= 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : null);
export const posParam = (p, key) => {
  const a = p?.[key];
  return Array.isArray(a) && a.length >= 2 && idx(a[0]) !== null && idx(a[1]) !== null ? [idx(a[0]), idx(a[1])] : undefined;
};
/** `[row, col]` of a `cell` param, or null. */
export const cellParam = p => {
  const a = p?.cell;
  return Array.isArray(a) && a.length >= 2 && Number.isSafeInteger(a[0]) && a[0] >= 0 && Number.isSafeInteger(a[1]) && a[1] >= 0 ? [a[0], a[1]] : null;
};

// ---------------------------------------------------------------------------------------------
// The deckcraft Selection read from the kernel selection

/** deckcraft `Selection`: {slide (index), slideId, slides (ids), shapes (ids), text}. */
export function selectionOf(ctx) {
  const c = ctx.doc;
  const slideId = currentSlideId(c, ctx.selection);
  const slide = slideById(c, slideId);
  return {
    slideId, slide, slideIndex: Math.max(0, (c.slides ?? []).findIndex(s => s.id === slideId)),
    slides: selectedSlideIds(c, ctx.selection), shapes: selectedShapeIds(c, ctx.selection), text: textSelection(c, ctx.selection),
  };
}

/** Every shape on the current slide (groups included) by id. */
export const shapeOnSlide = (sl, id) => findShape(sl?.shapes, id);

/**
 * `body_of`: the body a text selection `t` edits (notes, a table cell's text or the shape's), or
 * null when it is gone. A shape without a body reads as an empty one (text.edit creates it).
 */
export function bodyOf(content, t) {
  const sl = slideById(content, t.slide);
  if (!sl) return null;
  if (t.notes) return sl.notes ?? {body: {}, paragraphs: []};
  const sh = findShape(sl.shapes, t.shape);
  if (!sh) return null;
  if (t.cell) return sh.kind?.type === 'table' ? sh.kind.rows?.[t.cell[0]]?.cells?.[t.cell[1]]?.text ?? null : null;
  return sh.text ?? {body: {}, paragraphs: []};
}
/** JSON path of the body `t` edits. */
export function bodyPath(content, t) {
  if (t.notes) { const p = slidePath(content, t.slide); return p ? [...p, 'notes'] : null; }
  const sp = shapeJsonPath(content, t.slide, t.shape);
  if (!sp) return null;
  return t.cell ? [...sp, 'kind', 'rows', t.cell[0], 'cells', t.cell[1], 'text'] : [...sp, 'text'];
}

/** The text selection as positions: {anchor: [p, c], caret: [p, c]} in `body`. */
export const textPositions = (body, t) => ({anchor: posOf(body, t.anchor), caret: posOf(body, t.caret)});
export const cmpPos = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
export const ordered = (a, b) => (cmpPos(a, b) <= 0 ? [a, b] : [b, a]);
export const samePos = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Kernel address of a text offset in the body `t` edits. */
export function textAddr(content, t, off) {
  if (t.notes) return `/sl:${t.slide}/notes/t:${off}`;
  const sl = slideById(content, t.slide);
  const chain = (sl && shapeChain(sl, t.shape)) ?? t.chain ?? [t.shape];
  const base = shapeAddress(t.slide, chain);
  return t.cell ? `${base}/r:${t.cell[0]}/c:${t.cell[1]}/t:${off}` : `${base}/t:${off}`;
}
/** A kernel selection for text `t` with anchor/caret positions in `body`. */
export function textSelectionFor(content, t, body, anchor, caret) {
  return {ranges: [{anchor: textAddr(content, t, offsetOf(body, anchor)), focus: textAddr(content, t, offsetOf(body, caret))}], primary: 0};
}
/** Select text: `t` names the body (slide, shape/notes/cell); positions are clamped to `body`. */
export function setTextSelection(ctx, t, body, anchor, caret, {lineEnd = false} = {}) {
  const a = clampPos(body, anchor), c = clampPos(body, caret);
  ctx.setSelection(textSelectionFor(ctx.doc, t, body, a, c));
  // deckcraft `TextSel.line_end`: the caret drawn at the end of a wrapped line (End).
  if (lineEnd || ctx.view?.textLineEnd) ctx.setView({textLineEnd: lineEnd ? [...c] : null});
}
/** Clamp a position into a body (an empty body has [0, 0]). */
export function clampPos(body, [p, c]) {
  const ps = body?.paragraphs ?? [];
  if (!ps.length) return [0, 0];
  const pi = Math.min(Math.max(p, 0), ps.length - 1);
  return [pi, Math.min(Math.max(c, 0), paraLen(ps[pi]))];
}

/** Select shapes on a slide by id (group members by their chain). */
export function selectShapeIds(ctx, slideId, ids) {
  const sl = slideById(ctx.doc, slideId);
  ctx.setSelection(selectShapes(slideId, ids.map(id => (sl && shapeChain(sl, id)) ?? [id])));
}
/**
 * Select slides: `ids` are the selected slides (thumbnail pane) and `current` the current slide
 * (deckcraft `sel.slide`); the current slide is the primary range.
 */
export function selectSlideList(ctx, ids, current) {
  const list = ids.length ? [...ids] : current ? [current] : [];
  if (current && !list.includes(current)) list.push(current);
  const ranges = list.map(id => ({anchor: `/sl:${id}`, focus: `/sl:${id}`}));
  ctx.setSelection({ranges, primary: Math.max(0, current ? list.indexOf(current) : list.length - 1)});
}

// ---------------------------------------------------------------------------------------------
// edit_text

/**
 * deckcraft `edit_text`: run `f(body, sel)` on the body being edited and write the body and the
 * selection back. `sel` is {anchor, caret} as positions; `f` returns {body, result?} (the model's
 * edit functions return new bodies). Then the shrink-on-overflow scale is reset (the text
 * changed) and an auto-sizing text box is refitted.
 */
export function editText(ctx, cmd, f) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad(cmd, NO_TEXT_POINT);
  const body = bodyOf(ctx.doc, t);
  const path = bodyPath(ctx.doc, t);
  if (!body || !path) throw bad(cmd, 'the text being edited is gone');
  const sel = textPositions(body, t);
  const out = f(body, sel) ?? {};
  let nb = out.body ?? body;
  const af = nb.body?.autofit;
  if (af?.kind === 'shrink') {
    const next = {...af, lineReduction: 0};
    if (af.fontScale != null) next.fontScale = 1;
    nb = {...nb, body: {...nb.body, autofit: next}};
  }
  if (nb !== body) ctx.change.set(path, nb);
  setTextSelection(ctx, t, nb, sel.anchor, sel.caret, {lineEnd: !!out.lineEnd});
  if (!t.notes && !t.cell) fitTextBox(ctx, t.slide, t.shape, ctx.host);
  return out.result;
}

// ---------------------------------------------------------------------------------------------
// Text layout (for caret movement and fitting)

/** Text metrics from the host (the renderer measures with the canvas's own fonts); else the layout's default. */
export function measurer(host) {
  const m = host?.measureText;
  if (typeof m !== 'function') return {};
  const spec = f => ({family: f.family, size: f.size, weight: f.bold ? 700 : 400, style: f.italic ? 'italic' : 'normal'});
  return {measure: (f, text) => Number(m.call(host, spec(f), text)?.width ?? 0)};
}

/** The box a top-level or grouped shape is drawn in (deckcraft `xfrm_of`; group members use their own). */
function boxOf(content, slideId, sh) {
  const sl = slideById(content, slideId);
  const top = (sl?.shapes ?? []).some(s => s.id === sh.id);
  return top ? xfrmOf(content, slideId, sh) : sh.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
}

/** deckcraft `layout_for`: the layout of the shape text being edited (null for notes and table cells). */
export function layoutFor(content, t, host, body) {
  if (t.notes || t.cell) return null;
  const sl = slideById(content, t.slide);
  const sh = sl && findShape(sl.shapes, t.shape);
  const rctx = sl && ctxForSlide(content, sl);
  if (!sh || !rctx) return null;
  const x = boxOf(content, t.slide, sh);
  const geo = shapeGeometry(sh, x.w, x.h);
  const b = body ?? sh.text ?? {body: {}, paragraphs: []};
  const lay = b.paragraphs?.length ? b : {...b, paragraphs: [{level: 0, runs: []}]};
  try { return layoutText(rctx, sh, lay, {rect: geo.textRect, ...measurer(host)}); } catch { return null; }
}

/**
 * deckcraft `fit_text_box` + `fit_shrink_scale`: after the text changed, store the shrink scale the
 * layout computes for a body that has none saved, and grow or shrink a "Resize shape to fit
 * text" box to its text. Part of the edit (no undo step of its own).
 */
export function fitTextBox(ctx, slideId, id, host) {
  const sl = slideById(ctx.doc, slideId);
  const sh = sl && findShape(sl.shapes, id);
  const rctx = sl && ctxForSlide(ctx.doc, sl);
  if (!sh?.text || !rctx) return;
  const path = shapeJsonPath(ctx.doc, slideId, id);
  if (!path) return;
  const ms = measurer(host);
  const x = boxOf(ctx.doc, slideId, sh);
  // fit_shrink_scale
  const af = sh.text.body?.autofit;
  if (af?.kind === 'shrink' && (af.fontScale == null || (af.fontScale === 1 && !(af.lineReduction > 0)))) {
    const tr = shapeGeometry(sh, x.w, x.h).textRect;
    const probe = {...sh.text, body: {...sh.text.body, autofit: {kind: 'shrink', fontScale: 1, lineReduction: 0}}};
    let l = null;
    try { l = layoutText(rctx, {...sh, text: probe}, probe, {rect: tr, refit: true, ...ms}); } catch { l = null; }
    if (l && (l.fontScale < 1 || l.lineReduction > 0)) {
      ctx.change.set([...path, 'text', 'body', 'autofit'], {kind: 'shrink', fontScale: l.fontScale, lineReduction: l.lineReduction});
    }
  }
  // fit_text_box
  const cur = findShape(slideById(ctx.doc, slideId).shapes, id);
  const bp = resolveBody(rctx, cur);
  if (bp.autofit?.kind !== 'shape') return;
  const nx = {...x};
  try {
    if (bp.wrap === false) {
      const tr0 = shapeGeometry(cur, x.w, x.h).textRect;
      const wide = {...tr0, x1: tr0.x0 + 100000};
      const s2 = {...cur, text: {...cur.text, body: {...cur.text.body, wrap: false}}};
      const l = layoutText(rctx, s2, cur.text, {rect: wide, noShrink: true, ...ms});
      const w = Math.max(0, ...l.lines.map(li => (li.startOffset ?? 0) + (li.width ?? 0)));
      nx.w = Math.max(w + (bp.insetL ?? 7.2) + (bp.insetR ?? 7.2) + 1, 20);
    }
    const tr = shapeGeometry(cur, nx.w, nx.h).textRect;
    const body = cur.text.paragraphs?.length ? cur.text : {...cur.text, paragraphs: [{level: 0, runs: []}]};
    const l = layoutText(rctx, cur, body, {rect: tr, noShrink: true, ...ms});
    const need = l.contentHeight + (bp.insetT ?? 3.6) + (bp.insetB ?? 3.6);
    const extra = Math.max(nx.h - (tr.y1 - tr.y0), 0);
    nx.h = Math.max(need + extra, 8);
  } catch { return; }
  if (Math.abs(nx.h - x.h) < 0.01 && Math.abs(nx.w - x.w) < 0.01 && cur.xfrm) return;
  ctx.change.set([...path, 'xfrm'], nx);
}

// ---------------------------------------------------------------------------------------------
// Shapes of the current slide

/** `targets`: the `ids` param (validated) or the selected shapes. */
export function targets(ctx, p, cmd) {
  if (Array.isArray(p?.ids)) {
    const badId = p.ids.find(v => idOf(v) === null);
    if (badId !== undefined) throw bad(cmd, `\`ids\` has an invalid shape id: ${JSON.stringify(badId)}`, {path: '/ids'});
    const ids = p.ids.map(idOf);
    if (ids.length) return ids;
  }
  const one = idParam(p, 'id', cmd);
  if (one !== undefined) return [one];
  return selectedShapeIds(ctx.doc, ctx.selection);
}

/** `current_names`: names of the shapes on the current slide. */
export function currentNames(sl) {
  const out = new Set();
  walk(sl?.shapes ?? [], s => out.add(s.name ?? ''));
  return out;
}

/** Deep-map every shape (groups included, depth-bounded like `walk`). Returns a new list. */
export function mapShapes(list, f, depth = 0) {
  return (list ?? []).map(s => {
    let n = f(s);
    if (depth < 64 && isGroup(n)) n = {...n, kind: {...n.kind, children: mapShapes(n.kind.children, f, depth + 1)}};
    return n;
  });
}
