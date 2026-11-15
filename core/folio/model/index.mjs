// The folio foundation API (ctx.model for every folio command; docs/architecture.md 5.1, 16.4).
//
// Wraps the translated printcraft modules (crates/annot → annots.mjs, appearance.mjs, types.mjs;
// crates/render text → text.mjs, extract.mjs; crates/engine commands.rs `Needs` → permissions
// below) and the existing schema-1 translations (core/pdf-model.mjs, pdf-page-labels.mjs,
// pdf-bookmarks.mjs) at printcraft 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import * as annots from './annots.mjs';
import * as appearance from './appearance.mjs';
import * as types from './types.mjs';
import {PageText, layout} from './text.mjs';
import {pageText, cachedPageText, rememberPageText, registerTextProvider} from './page-text.mjs';
import {labelAt} from '../../pdf-page-labels.mjs';
import {pdfDate} from '../lib/dates.mjs';
import {viewRectToQuad, userToView, viewToUser, viewSize, pageRotation, cropBox} from '../lib/geom.mjs';
import {CommandError} from '../../kernel/errors.mjs';

export {annots, appearance, types, PageText, layout, pageText, cachedPageText, rememberPageText, registerTextProvider};
export {viewRectToQuad, userToView, viewToUser, viewSize, pageRotation, cropBox};

/** The content's pages (empty for a document with no PDF yet). */
export const pagesOf = content => (Array.isArray(content?.pages) ? content.pages : []);
export const pageIndexOf = (content, pageId) => pagesOf(content).findIndex(p => p.id === pageId);
export function pageById(content, pageId) {
  const i = pageIndexOf(content, pageId);
  if (i < 0) throw new CommandError('not_found', `page ${pageId} does not exist`, {page: pageId});
  return pagesOf(content)[i];
}

/** The page's label (pdf-page-labels.mjs `labelAt`), or its 1-based number. */
export function pageLabel(content, index) {
  const ranges = content?.pageLabels;
  if (Array.isArray(ranges) && ranges.length) { try { return labelAt(ranges, index, pagesOf(content).length); } catch { /* fall through */ } }
  return String(index + 1);
}

/** Whether comments were read from the file into the model (folio schema 2). */
export const commentsLoaded = content => content?.folio === 2;

/**
 * commands.rs `Needs::Annotate`: a document is open whose security allows adding and changing
 * comments. Returns a ControlState.
 */
export function annotateState(content) {
  if (!pagesOf(content).length) return {enabled: false, reason: 'no PDF open'};
  if (content.permissions && content.permissions.annotate === false) return {enabled: false, reason: "this PDF's permissions don't allow adding comments"};
  if (!commentsLoaded(content)) return {enabled: false, reason: 'the PDF is still opening'};
  return {enabled: true};
}

/** The values stamped onto an edit (types.rs `Meta`): a PDF date and a fresh /NM. */
export function meta(ctx) {
  const now = typeof ctx.host?.now === 'function' ? ctx.host.now() : Date.now();
  const id = typeof ctx.host?.uid === 'function' ? ctx.host.uid() : globalThis.crypto.randomUUID();
  return {date: pdfDate(now), id: String(id)};
}

/** comments.rs CommentPrefs.author: Preferences ▸ Identity (`prefs.identity.name`), else no /T. */
export const author = ctx => String(ctx.prefs?.identity?.name ?? ctx.prefs?.author ?? '');

/** comments.rs CommentPrefs.style(tool): the per-tool default style, with the person's saved changes (`prefs.commentStyles`). */
export function toolStyle(ctx, tool, shape) {
  const base = types.defaultStyle(shape);
  const saved = ctx.prefs?.commentStyles?.[tool];
  if (!saved || typeof saved !== 'object') return base;
  return {
    color: Array.isArray(saved.color) && saved.color.length === 3 ? saved.color : base.color,
    opacity: Number.isFinite(saved.opacity) ? Math.min(1, Math.max(0.1, saved.opacity)) : base.opacity,
    width: Number.isFinite(saved.width) ? saved.width : base.width,
    fill: saved.fill === undefined ? base.fill : saved.fill,
  };
}

/** Selected glyphs → one view rect per line → markup quads in user space (canvas/selection.rs `selection_quads`). */
export function rangeQuads(page, text, first, last) {
  const a = Math.min(first, last), b = Math.max(first, last);
  return text.lineRects(a, b + 1).map(r => viewRectToQuad(page, r));
}
