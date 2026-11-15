// Shared helpers of the comment and Fill & Sign commands: pages and comments by address, the
// displayed axes of a turned page, and the boxes text and marks are placed in.
//
// Translated from printcraft crates/engine/src/fill_sign.rs (displayed_offset, text_box_at),
// crates/engine/src/signature_image.rs (upright_box), crates/annot/src/types.rs
// (FillMark::rect_at) and crates/ui-egui/src/tools/comments/geometry.rs (text_box_rect,
// drawn_box) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Geometry in command params follows the bridge convention (docs/architecture.md 14.5): page view
// points, origin at the top-left of the displayed page. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {viewMatrixFor, viewToUser, pageRotation, normalize} from './geom.mjs';
import {textWidth, wrap} from './fonts.mjs';
import {s} from '../../kernel/schema.mjs';

export const pagesOf = ctx => (Array.isArray(ctx.doc?.pages) ? ctx.doc.pages : []);
export const pageAddress = page => `/pg:${encodeURIComponent(page.id)}`;
export const annotAddress = (page, r) => `${pageAddress(page)}/annot:${encodeURIComponent(r.id)}`;
export const rgbOf = hex => { const h = String(hex).replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
export const hexOf = c => (Array.isArray(c) && c.length === 3 ? `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null);

/** A page by id or 1-based number: {pi, page}. */
export function pageAt(ctx, idOrNumber) {
  const pages = pagesOf(ctx);
  let pi = -1;
  if (typeof idOrNumber === 'number') pi = idOrNumber - 1;
  else {
    const id = String(idOrNumber ?? '').replace(/^\/pg:/, '');
    pi = pages.findIndex(p => p.id === decodeURIComponent(id));
  }
  if (pi < 0 || pi >= pages.length) throw new CommandError('not_found', `page ${idOrNumber} does not exist`, {page: idOrNumber});
  return {pi, page: pages[pi]};
}

/** The page the command acts on: `page`, else the page shown (view.page / activePageId), else the first. */
export function currentPage(ctx, page) {
  if (page !== undefined && page !== null) return pageAt(ctx, page);
  const pages = pagesOf(ctx);
  const id = ctx.view?.pageId ?? ctx.doc?.activePageId;
  const pi = Math.max(0, pages.findIndex(p => p.id === id));
  if (!pages[pi]) throw new CommandError('disabled', 'no PDF open');
  return {pi, page: pages[pi]};
}

/** A comment by address `/pg:<id>/annot:<id>`, else the selected one: {pi, page, index, record}. */
export function commentAt(ctx, address) {
  let addr = address;
  if (!addr) {
    const sel = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
    if (sel && /\/annot:/.test(sel.anchor)) addr = sel.anchor;
  }
  if (!addr) throw new CommandError('invalid_params', 'select a comment first (or pass annotation)', {path: '/annotation'});
  const m = /^\/pg:([^/]+)\/annot:([^/]+)$/.exec(String(addr));
  if (!m) throw new CommandError('invalid_params', 'annotation must be /pg:<id>/annot:<id>', {path: '/annotation'});
  const {pi, page} = pageAt(ctx, decodeURIComponent(m[1]));
  const id = decodeURIComponent(m[2]);
  const index = (page.annots ?? []).findIndex(r => r.id === id);
  if (index < 0) throw new CommandError('not_found', `annotation ${id} is not on page ${page.id}`, {address: addr});
  return {pi, page, index, record: page.annots[index]};
}

/** Display axes as user-space vectors: [right x, right y, up x, up y] (fill_sign.rs). */
const axes = rotation => { const [a, b, c, d] = viewMatrixFor(rotation, [0, 0, 0, 0]); return [a, b, c, d]; };

/** fill_sign.rs `displayed_offset`: `at` moved `right` and `up` points as displayed. */
export function displayedOffset(rotation, at, right, up) {
  const [a, b, c, d] = axes(rotation);
  return [at[0] + a * right + c * up, at[1] + b * right + d * up];
}

/** signature_image.rs `upright_box`: a box `width` x `height` as displayed, left edge at `at`, vertically centred. */
export function uprightBox(rotation, at, width, height) {
  if (![...at, width, height].every(Number.isFinite)) return null;
  const [a, b, c, d] = axes(rotation);
  const right = [a * width, b * width], up = [c * height / 2, d * height / 2];
  return [at[0] + Math.min(right[0], 0) - Math.abs(up[0]), at[1] + Math.min(right[1], 0) - Math.abs(up[1]),
    at[0] + Math.max(right[0], 0) + Math.abs(up[0]), at[1] + Math.max(right[1], 0) + Math.abs(up[1])];
}

/** fill_sign.rs `text_box_at`: the box with its displayed top-left corner at `at`. */
export const textBoxAt = (rotation, at, width, height) => uprightBox(rotation, displayedOffset(rotation, at, 0, -height / 2), width, height);

/** geometry.rs `text_box_rect`: a text box sized to its text, displayed top-left at `at`. */
export function textBoxRect(at, text, size, rotation) {
  const pad = 2;
  const longest = Math.max(0, ...String(text).split('\n').map(l => textWidth(l, size)));
  const w = Math.min(300, Math.max(40, longest + 2 * pad + 4));
  const lines = Math.max(wrap(String(text), size, w - 2 * pad).length, 1);
  const h = lines * size * 1.2 + 2 * pad + 2;
  return textBoxAt(rotation, at, w, h) ?? [at[0], at[1] - h, at[0] + w, at[1]];
}

/** types.rs `FillMark::rect_at`: 12 x 12 points (the line 36 x 4), centred on `at`, turned with the page. */
export function markRectAt(mark, at, rotation) {
  let [w, h] = mark === 'Line' ? [36, 4] : [12, 12];
  if ([90, 270].includes(((rotation % 360) + 360) % 360)) [w, h] = [h, w];
  return [at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2];
}

/** A view point on `page` → user space. */
export const userPoint = (page, p) => viewToUser(page, p[0], p[1]);
/** A view rect [x, y, w, h] on `page` → a user-space rectangle. */
export function userRect(page, [x, y, w, h]) {
  const a = viewToUser(page, x, y), b = viewToUser(page, x + w, y + h);
  return normalize([a[0], a[1], b[0], b[1]]);
}

export {pageRotation};

// ── param schemas shared by the comment tools ──────────────────────────────────────────────
export const pointParam = desc => s.array(s.number({min: -100000, max: 100000}), {min: 2, max: 2, description: desc});
export const rectParam = desc => s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4, description: desc ?? '[x, y, width, height] in page view points (top-left origin)'});
export const colorParam = s.optional(s.color({description: "Color like #E52222 (default: the tool's colour)"}));
export const opacityParam = s.optional(s.number({min: 0.1, max: 1, description: 'Opacity 0.1–1'}));
export const pageParam = s.optional(s.union([s.string({min: 1, max: 120}), s.integer({min: 1, max: 100000})], {description: 'Page id or 1-based number (default: the page shown)'}));
export const annotationParam = s.optional(s.address('annotation', {description: 'The comment /pg:<id>/annot:<id> (default: the selected comment)'}));
