// Reduce File Size and the PDF Optimizer's structural settings, on the PDF's objects.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/optimize/src/lib.rs
// `Settings` and `optimize_with_progress`:
//   discard_thumbnails          every page's /Thumb removed
//   discard_alternate_images    /Alternates removed from image XObjects
//   discard_tags                /StructTreeRoot and /MarkInfo from the catalog, /StructParents from the pages
//   discard_print_settings      the print keys of /ViewerPreferences (PrintScaling, Duplex, PickTrayByPDFSize, PrintPageRange, NumCopies, PrintArea, PrintClip)
//   lzw_to_flate                LZW-only streams stored with Flate instead
//   flate_unencoded             streams stored without a filter Flate-compressed when that is smaller (not XMP metadata, not XRef, not under 64 bytes)
//   object_streams              non-stream objects packed into compressed object streams (PDF 1.5)
// and what a full rewrite keeps: only the objects the document still reaches (the catalog, the Info dictionary), so everything an earlier edit left
// behind goes. Not translated: the image settings (down-sampling and re-compressing colour, grey and black-and-white pictures, about 1,400 lines of
// images.rs), merging a picture drawn as stacked fragments (fragments.rs), removing unused XObject names (unused.rs), removing links that point
// nowhere and unreferenced named destinations (links.rs), the target PDF version. Reduce File Size therefore saves the structural part of what
// upstream saves; a picture-heavy file shrinks little. No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, decodePDFRawStream} from 'pdf-lib';

const N = s => PDFName.of(s);

export const DEFAULTS = Object.freeze({
  discardThumbnails: true, discardAlternates: true, discardTags: false, discardPrintSettings: false,
  lzwToFlate: true, flateUnencoded: true, objectStreams: true, discardUnused: true,
});
const PRINT_KEYS = ['PrintScaling', 'Duplex', 'PickTrayByPDFSize', 'PrintPageRange', 'NumCopies', 'PrintArea', 'PrintClip'];

const filterNames = (context, stream) => {
  const f = context.lookup(stream.dict.get(N('Filter')));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map(x => context.lookup(x)).filter(x => x instanceof PDFName).map(x => x.decodeText());
  return [];
};

/** The refs the document reaches from its trailer. */
function reachable(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const push = v => { if (v instanceof PDFRef) { const k = `${v.objectNumber} ${v.generationNumber}`; if (!seen.has(k)) { seen.add(k); stack.push(v); } } else if (v) stack.push(v); };
  push(ctx.trailerInfo.Root); push(ctx.trailerInfo.Info); push(ctx.trailerInfo.Encrypt);
  while (stack.length) {
    const v = stack.pop();
    const o = v instanceof PDFRef ? ctx.lookup(v) : v;
    if (o instanceof PDFDict) for (const [, x] of o.entries()) push(x);
    else if (o instanceof PDFArray) for (const x of o.asArray()) push(x);
    else if (o instanceof PDFStream) for (const [, x] of o.dict.entries()) push(x);
  }
  return seen;
}

/**
 * Optimize `doc` (a pdf-lib document) in place with `settings`; returns what was done.
 * @returns {{thumbnails: number, alternates: number, tagsRemoved: boolean, printSettings: number, lzw: number, compressed: number, unused: number}}
 */
export function optimizeDocument(doc, settings = DEFAULTS) {
  const ctx = doc.context;
  const report = {thumbnails: 0, alternates: 0, tagsRemoved: false, printSettings: 0, lzw: 0, compressed: 0, unused: 0};
  if (settings.discardThumbnails) for (const page of doc.getPages()) if (page.node.has(N('Thumb'))) { page.node.delete(N('Thumb')); report.thumbnails++; }
  if (settings.discardAlternates) {
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (o instanceof PDFStream && o.dict.has(N('Alternates')) && ctx.lookup(o.dict.get(N('Subtype')))?.decodeText?.() === 'Image') { o.dict.delete(N('Alternates')); report.alternates++; }
    }
  }
  if (settings.discardTags && doc.catalog.has(N('StructTreeRoot'))) {
    doc.catalog.delete(N('StructTreeRoot')); doc.catalog.delete(N('MarkInfo'));
    for (const page of doc.getPages()) page.node.delete(N('StructParents'));
    report.tagsRemoved = true;
  }
  if (settings.discardPrintSettings) {
    const vp = ctx.lookup(doc.catalog.get(N('ViewerPreferences')));
    if (vp instanceof PDFDict) for (const k of PRINT_KEYS) if (vp.has(N(k))) { vp.delete(N(k)); report.printSettings++; }
  }
  if (settings.lzwToFlate) {
    for (const [ref, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue;
      const f = filterNames(ctx, o);
      if (f.length !== 1 || !['LZWDecode', 'LZW'].includes(f[0])) continue;
      try {
        const plain = decodePDFRawStream(o).decode();
        const dict = o.dict.clone(ctx);
        dict.delete(N('Filter')); dict.delete(N('DecodeParms')); dict.delete(N('Length'));
        ctx.assign(ref, ctx.flateStream(plain, Object.fromEntries([...dict.entries()].map(([k, v]) => [k.decodeText(), v]))));
        report.lzw++;
      } catch { /* a stream that does not decode cleanly stays as it is */ }
    }
  }
  if (settings.flateUnencoded) {
    for (const [ref, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue;
      const type = ctx.lookup(o.dict.get(N('Type')));
      const t = type instanceof PDFName ? type.decodeText() : '';
      if (o.dict.has(N('Filter')) || t === 'Metadata' || t === 'XRef' || o.contents.length < 64) continue;
      const packed = ctx.flateStream(o.contents, Object.fromEntries([...o.dict.entries()].filter(([k]) => k.decodeText() !== 'Length').map(([k, v]) => [k.decodeText(), v])));
      if (packed.contents.length < o.contents.length) { ctx.assign(ref, packed); report.compressed++; }
    }
  }
  if (settings.discardUnused) {
    const keep = reachable(doc);
    for (const [ref] of [...ctx.enumerateIndirectObjects()]) if (!keep.has(`${ref.objectNumber} ${ref.generationNumber}`)) { ctx.delete(ref); report.unused++; }
  }
  return report;
}

/** Optimize PDF bytes: the new bytes, what was done and the sizes. */
export async function optimizePdf(bytes, settings = DEFAULTS) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const report = optimizeDocument(doc, settings);
  const out = await doc.save({useObjectStreams: settings.objectStreams !== false, updateFieldAppearances: false});
  return {bytes: out, report, before: bytes.length, after: out.length};
}
