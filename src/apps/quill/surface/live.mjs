// The live view state of each open Quill document in this window: its layout (one LayoutCache per
// document, laid out again only for edited paragraphs) and the session state upstream keeps beside
// the document and selection: the goal x of Up/Down, the page hint, the pending typing formatting,
// the typing burst (one Undo Typing per burst) and the page in view.
//
// Upstream: wordcraft crates/engine/src/session.rs (`Session::layout`, `goal_x`, `page_hint`,
// `pending`) and crates/ui-egui/src/canvas.rs (`prepare_layout`) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The caret and text ui-commands (src/apps/quill/ui-commands) read and write this state, and the
// page view (QuillSurface) paints from the same layout, so a key, a click and a bridge command see
// one layout. No DOM here; the renderer installs the Canvas2D shaper with `useCanvasShaper`.

import {layout as runLayout, LayoutCache, setDefaultShaper, getDefaultShaper, installPageResolver} from '../../../../core/quill/layout/index.mjs';
import {setPageResolver} from '../../../../core/quill/address.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {reviewPresentation} from '../../../../core/quill/lib/review-markup.mjs';
import {viewLayoutOptions} from '../../../../core/quill/lib/view-layout.mjs';

/** @type {Map<string, any>} */
const views = new Map();
/** Layouts of contents that no open view holds (page addresses of other documents). */
let spare = new WeakMap();
let resolverInstalled = false;

/** The person's preferences the layout reads (Track Changes Options: hidden deletions, deletions in balloons). */
let reviewPrefs = {};
export function setReviewPrefs(prefs) { reviewPrefs = prefs && typeof prefs === 'object' ? prefs : {}; }

/**
 * The layout options of the page view: the view the document is in (U:quill/view: Print Layout,
 * Web Layout at the window's width, Draft, Outline, Read Mode's columns, Immersive Reader's column;
 * `metrics` are the window's, measured by the page view), with what Display for Review asks (U:quill/review).
 */
export function layoutOptions(view, metrics = {}) {
  return {...viewLayoutOptions(view, metrics), showHidden: !!view?.showHidden, fieldCodes: !!view?.fieldCodes, mergeHighlight: !!view?.merge?.highlight, designMode: !!view?.designMode, filename: view?.filename ?? '', ...reviewPresentation(view, reviewPrefs).layout};
}

function optionsKey(o) { return JSON.stringify(o); }

function installResolver() {
  if (resolverInstalled) return;
  resolverInstalled = true;
  installPageResolver(setPageResolver, content => {
    for (const v of views.values()) if (v.content === content && v.lay) return v.lay;
    let l = spare.get(content);
    if (!l) { l = runLayout(content, {view: 'print'}); spare.set(content, l); }
    return l;
  });
}

/** The view state of a document (created on first use). */
export function viewOf(docId) {
  let v = views.get(docId);
  if (!v) {
    v = {docId, cache: new LayoutCache(), content: null, lay: null, key: '', shaper: null, goalX: null, pageHint: 0, pending: null,
      burst: 0, burstSel: null, viewedPage: null, listeners: new Set(), version: 0, metrics: {}};
    views.set(docId, v);
    installResolver();
  }
  return v;
}

/** Forget a document's view state (its window closed it). */
export function dropView(docId) { views.delete(docId); }

/**
 * The layout of `content` for document `docId`, laid out again only when the content, the options
 * or the shaper changed (the cache keeps unchanged paragraphs).
 */
export function layoutOf(docId, content, docView = null) {
  if (!isQuill2(content)) return null;
  const v = viewOf(docId);
  const opts = layoutOptions(docView, v.metrics);
  const key = optionsKey(opts);
  const shaper = getDefaultShaper();
  if (v.lay && v.content === content && v.key === key && v.shaper === shaper) return v.lay;
  if (v.key !== key || v.shaper !== shaper) v.cache = new LayoutCache();
  v.lay = runLayout(content, {...opts, cache: v.cache, shaper});
  v.content = content;
  v.key = key;
  v.shaper = shaper;
  v.version++;
  if (v.pageHint >= v.lay.pages.length) v.pageHint = Math.max(0, v.lay.pages.length - 1);
  return v.lay;
}

/** The layout for a command's context (ctx.docId, ctx.doc, ctx.view). */
export const layoutForCtx = ctx => layoutOf(ctx.docId ?? '', ctx.doc, ctx.view);

/**
 * The window's sizes the reflowed views lay out at (U:quill/view: Web Layout's width, Read Mode's
 * column width and height, in points); a change lays the document out again. Returns whether it changed.
 */
export function setMetrics(docId, metrics) {
  const v = viewOf(docId);
  const next = {...v.metrics, ...metrics};
  const same = ['webWidth', 'readWidth', 'readHeight'].every(k => Math.abs((next[k] ?? 0) - (v.metrics[k] ?? 0)) <= 0.5);
  if (same) return false;
  v.metrics = next;
  touch(docId);
  return true;
}

/** Notify the page view that view state changed without a session event (pending format, page hint). */
export function touch(docId) {
  const v = viewOf(docId);
  v.version++;
  for (const f of [...v.listeners]) { try { f(); } catch { /* a listener never breaks a command */ } }
}

export function subscribe(docId, f) {
  const v = viewOf(docId);
  v.listeners.add(f);
  return () => v.listeners.delete(f);
}

/** Install the renderer's Canvas2D shaper once (layouts made before keep their cache key). */
let canvasShaper = null;
export function useCanvasShaper(create) {
  if (!canvasShaper) {
    try { canvasShaper = create(); setDefaultShaper(canvasShaper); } catch { canvasShaper = null; }
  }
  return canvasShaper;
}

/** For tests: reset every view. */
export function resetViews() { views.clear(); spare = new WeakMap(); }
