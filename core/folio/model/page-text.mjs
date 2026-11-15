// Page text for commands and addresses: one PageText per (source, page, rotation), cached.
//
// The renderer registers a provider backed by the pdf.js document its pages are painted from, so
// selection, markup and the bridge read the very glyphs on screen; headless hosts and tests fall
// back to pdf.js's Node build. Extraction itself is model/extract.mjs (printcraft
// crates/render/src/text/device.rs at 3109bb2359759e24ef490e1cdbdba00722b20972, MIT, see
// assets/third-party-licenses/artcraft-reference.txt).
// No DOM, no Node built-ins.

import {PageText} from './text.mjs';
import {extractPageText} from './extract.mjs';
import {pageRotation} from '../lib/geom.mjs';
import {pdfBytes} from '../../pdf-model.mjs';

const LIMIT = 4000;
const cache = new Map();
let provider = null;
let sources = [];   // [{base64, doc: Promise<PDFDocumentProxy>}] for the fallback provider

const keyOf = (content, page) => `${content.sourceBase64.length}:${content.sourceBase64.slice(-64)}:${content.sourceBase64.slice(0, 64)}:${page.sourceIndex}:${pageRotation(page)}`;

/** The renderer's provider: `(content, page) => Promise<PageText>`; null restores the fallback. */
export function registerTextProvider(fn) { provider = fn; }

/** Put a PageText the surface already extracted into the cache. */
export function rememberPageText(content, page, text) { remember(keyOf(content, page), text); }

function remember(key, text) {
  cache.set(key, text);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
}

/** The cached text of a page, or null (synchronous: for state() and resolvers). */
export function cachedPageText(content, page) { return cache.get(keyOf(content, page)) ?? null; }

let nodePdfjs = null;
async function fallbackPdfjs() {
  // Only when there is no provider (Node hosts and tests). A variable specifier keeps the renderer
  // bundle from including pdf.js's Node build (the renderer always registers a provider).
  const spec = ['pdfjs-dist', 'legacy', 'build', 'pdf.mjs'].join('/');
  if (!nodePdfjs) nodePdfjs = import(spec);
  return nodePdfjs;
}

async function fallbackText(content, page) {
  const pdfjs = await fallbackPdfjs();
  let entry = sources.find(s => s.base64 === content.sourceBase64);
  if (!entry) {
    const task = pdfjs.getDocument({data: pdfBytes(content.sourceBase64), useSystemFonts: false, isEvalSupported: false, verbosity: 0});
    entry = {base64: content.sourceBase64, task, doc: task.promise};
    sources.unshift(entry);
    for (const old of sources.splice(3)) old.task.destroy().catch(() => {});
  }
  const doc = await entry.doc;
  const p = await doc.getPage(page.sourceIndex + 1);
  return extractPageText(pdfjs, p, {rotation: pageRotation(page)});
}

/** The PageText of a content page (async; cached). */
export async function pageText(content, page) {
  const key = keyOf(content, page);
  const hit = cache.get(key);
  if (hit) return hit;
  const text = await (provider ? provider(content, page) : fallbackText(content, page));
  const pt = text instanceof PageText ? text : PageText.fromJSON(text);
  remember(key, pt);
  return pt;
}

/** Drop the fallback provider's open documents (tests). */
export async function releaseTextSources() {
  const old = sources;
  sources = [];
  cache.clear();
  for (const s of old) await s.task.destroy().catch(() => {});
}
