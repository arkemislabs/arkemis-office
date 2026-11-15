// pdf.js for the folio surface (docs/architecture.md 16.4: pdf.js keeps painting the pages).
//
// One loaded document per PDF source, shared by the page view, the thumbnails and the page-text
// provider (core/folio/model/page-text.mjs registerTextProvider), so selection, markup and the
// bridge read the glyphs of the very operator lists the canvas is painted from. Page rasters are
// painted without the comments the model has changed: pdf.js draws the file's own annotations
// only while their record is untouched (annotationStorage `noView`, AnnotationMode.ENABLE_STORAGE);
// everything else is painted from the model (content-paint.mjs) over the raster, as printcraft
// paints a page and then its comments (crates/ui-egui/src/canvas.rs, tools/comments/paint.rs).

import * as pdfjs from 'pdfjs-dist';
import type {PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy} from 'pdfjs-dist';
import {pdfBytes} from '../../../../core/pdf-model.mjs';
import {extractPageText} from '../../../../core/folio/model/extract.mjs';
import {registerTextProvider} from '../../../../core/folio/model/page-text.mjs';
import {pageRotation} from '../../../../core/folio/lib/geom.mjs';
import {createPdfRenderQueue} from '../../../../core/pdf-render-queue.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', document.baseURI).href;

export interface PdfSource { uid: number; base64: string; task: PDFDocumentLoadingTask; doc: Promise<PDFDocumentProxy>; refs: number; idle: ReturnType<typeof setTimeout> | null;
  pages: Map<number, Promise<PDFPageProxy>>; annots: Map<number, Promise<{id: string; subtype: string}[]>> }

const sources: PdfSource[] = [];
let nextUid = 1;
const IDLE_MS = 30_000;

/** The loaded document for a PDF source (reference counted; `release` when done). */
export function acquire(base64: string): PdfSource {
  let s = sources.find(x => x.base64 === base64);
  if (!s) {
    // Untrusted files: caps on image and canvas size (a PDF can declare huge ones). pdf.js 6 compiles nothing with eval.
    const task = pdfjs.getDocument({data: pdfBytes(base64), enableXfa: false, maxImageSize: 16_777_216, canvasMaxAreaInBytes: 64 * 1024 * 1024});
    s = {uid: nextUid++, base64, task, doc: task.promise, refs: 0, idle: null, pages: new Map(), annots: new Map()};
    sources.push(s);
  }
  if (s.idle) { clearTimeout(s.idle); s.idle = null; }
  s.refs++;
  return s;
}

export function release(s: PdfSource) {
  s.refs = Math.max(0, s.refs - 1);
  if (s.refs || s.idle) return;
  s.idle = setTimeout(() => {
    s.idle = null;
    if (s.refs) return;
    const i = sources.indexOf(s);
    if (i >= 0) sources.splice(i, 1);
    s.task.destroy().catch(() => {});
  }, IDLE_MS);
}

export function page(s: PdfSource, index: number): Promise<PDFPageProxy> {
  let p = s.pages.get(index);
  if (!p) { p = s.doc.then(d => d.getPage(index + 1)); s.pages.set(index, p); }
  return p;
}

/** The file's own annotations on a source page: pdf.js ids ("12R") and subtypes. */
export function fileAnnots(s: PdfSource, index: number) {
  let a = s.annots.get(index);
  if (!a) {
    a = page(s, index).then(p => p.getAnnotations({intent: 'display'})).then(list => list.map((x: any) => ({id: String(x.id), subtype: String(x.subtype ?? '')})));
    s.annots.set(index, a);
  }
  return a;
}

/** A record's source object as pdf.js names it (Ref.toString). */
export const refId = (src: [number, number] | undefined) => (src ? `${src[0]}R${src[1] ? src[1] : ''}` : null);

// Selection and markup read the page text from the document the canvas paints.
registerTextProvider(async (content: any, p: any) => {
  const s = acquire(content.sourceBase64);
  try { return await extractPageText(pdfjs, await page(s, p.sourceIndex), {rotation: pageRotation(p)}); } finally { release(s); }
});

const queue = createPdfRenderQueue(2);
/** Raster counters for the page view's state query: requested, started, painted, failed, the last failure. */
export const rasterStats = {requested: 0, started: 0, stage: '', painted: 0, failed: 0, error: ''};

/**
 * Paint a source page at `scale` device pixels per point into a new canvas. `shown` lists the
 * file annotations pdf.js may draw (every other comment of the page is hidden: the model paints it).
 */
export async function raster(s: PdfSource, index: number, rotation: number, scale: number, shown: Set<string>, signal: AbortSignal): Promise<HTMLCanvasElement> {
  rasterStats.requested++;
  return queue(async () => {
    rasterStats.started++;
    rasterStats.stage = 'document';
    const doc = await s.doc;
    rasterStats.stage = 'page';
    const p = await page(s, index);
    rasterStats.stage = 'annotations';
    const annots = await fileAnnots(s, index);
    rasterStats.stage = 'render';
    for (const a of annots) {
      if (a.subtype === 'Widget' || a.subtype === 'Link' || a.subtype === 'Popup') continue;
      doc.annotationStorage.setValue(a.id, {noView: !shown.has(a.id)});
    }
    if (signal.aborted) throw new DOMException('Rendering cancelled', 'AbortError');
    const viewport = p.getViewport({scale, rotation});
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const task = p.render({canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE, background: '#ffffff'} as any);
    // pdf.js continues a render on the next animation frame, which never comes while the window is
    // covered: the page would stay blank until it is uncovered. The next frame or 16 ms, whichever
    // is first, keeps painting off-screen canvases going.
    task.onContinue = (cont: () => void) => {
      let done = false;
      const go = () => { if (!done) { done = true; cont(); } };
      requestAnimationFrame(go);
      setTimeout(go, 16);
    };
    const abort = () => task.cancel();
    signal.addEventListener('abort', abort, {once: true});
    try { await task.promise; rasterStats.painted++; } catch (e: any) { if (e?.name !== 'RenderingCancelledException') { rasterStats.failed++; rasterStats.error = String(e?.message ?? e); } throw e; } finally { signal.removeEventListener('abort', abort); rasterStats.stage = ''; }
    return canvas;
  }, {signal});
}

/** The document's outline (bookmarks) as pdf.js reads it, with each entry's page index. */
export async function outline(s: PdfSource): Promise<OutlineNode[]> {
  const doc = await s.doc;
  const items = (await doc.getOutline()) ?? [];
  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(d) || !d.length) return null;
      const ref = d[0];
      if (typeof ref === 'number') return ref;
      return await doc.getPageIndex(ref);
    } catch { return null; }
  };
  const walk = async (list: any[], depth: number): Promise<OutlineNode[]> => Promise.all(list.slice(0, 2000).map(async (it, i) => ({
    key: `${depth}.${i}`, title: String(it.title ?? ''), page: await resolve(it.dest), children: depth < 32 ? await walk(it.items ?? [], depth + 1) : [],
    bold: !!it.bold, italic: !!it.italic,
  })));
  return walk(items, 0);
}
export interface OutlineNode { key: string; title: string; page: number | null; children: OutlineNode[]; bold?: boolean; italic?: boolean }

/** organize/src/view.rs: the navigation panel the file asks for on opening (/PageMode). */
export async function initialPanel(s: PdfSource): Promise<'pages' | 'bookmarks' | null> {
  try {
    const mode = await (await s.doc).getPageMode();
    return mode === 'UseThumbs' ? 'pages' : mode === 'UseOutlines' ? 'bookmarks' : null;
  } catch { return null; }
}

export {pdfjs};
