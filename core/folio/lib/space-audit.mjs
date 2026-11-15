// Audit Space Usage: how the file's bytes are spent now, by kind of content (not what optimizing would save).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/optimize/src/audit.rs `audit_space`:
// every object belongs to the first kind that reaches it (the page resources' images, forms, fonts, colour spaces, shadings, patterns and graphics states, the
// annotations' appearance resources, the structure tree, the form, the pages' annotations (Forms for widgets, Comments for the rest), contents and thumbnails, bookmarks,
// named destinations, embedded files); an object's size is its serialization plus the 20 + 20 bytes of its cross-reference entry and `N G obj`/`endobj` framing; what the
// kinds do not account for is Document Overhead, and the shares are of the file's length. Sizes are pdf-lib's serialization of each object, which is not byte for byte
// the Rust serializer's: the categories and their order are upstream's, the numbers are close. No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFName, PDFDict, PDFArray, PDFRef, PDFStream} from 'pdf-lib';

const N = s => PDFName.of(s);
export const CATEGORIES = ['Images', 'Content Streams', 'Fonts', 'X Object Forms', 'Structure Info', 'Bookmarks', 'Thumbnails', 'Comments', 'Forms', 'Named Destinations',
  'Color Spaces', 'Shadings', 'Patterns', 'Extended Graphics States', 'Embedded Files', 'Document Overhead'];
const MAX_FORM_DEPTH = 64;
const nameText = v => (v instanceof PDFName ? v.decodeText() : undefined);

/**
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {number} fileLength the file's length in bytes
 * @returns {{category: string, bytes: number, percent: number}[]} every category, in upstream's order
 */
export function auditSpace(doc, fileLength) {
  const ctx = doc.context;
  const look = v => ctx.lookup(v);
  const owner = new Map();
  const dictOf = v => { const o = v instanceof PDFRef ? look(v) : v; return o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : PDFDict.withContext(ctx); };
  const claim = (start, cat) => {
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const o = stack.pop();
      if (o instanceof PDFRef) {
        if (seen.has(o.objectNumber) || owner.has(o.objectNumber)) continue;
        seen.add(o.objectNumber);
        const obj = look(o);
        if (obj instanceof PDFDict && ['Page', 'Pages'].includes(nameText(look(obj.get(N('Type')))))) continue;
        owner.set(o.objectNumber, cat);
        if (obj) stack.push(obj);
      } else if (o instanceof PDFArray) stack.push(...o.asArray());
      else if (o instanceof PDFDict) { for (const [k, v] of o.entries()) if (!['Parent', 'P'].includes(k.decodeText())) stack.push(v); }
      else if (o instanceof PDFStream) { for (const [k, v] of o.dict.entries()) if (k.decodeText() !== 'Parent') stack.push(v); }
    }
  };
  const resources = (res, depth) => {
    const xo = dictOf(res.get(N('XObject')));
    for (const [, x] of xo.entries()) {
      if (!(x instanceof PDFRef)) continue;
      const obj = look(x);
      if (obj instanceof PDFStream && nameText(look(obj.dict.get(N('Subtype')))) === 'Image') claim(x, 'Images');
      else if (obj instanceof PDFStream && depth < MAX_FORM_DEPTH && !owner.has(x.objectNumber)) {
        owner.set(x.objectNumber, 'X Object Forms');
        resources(dictOf(obj.dict.get(N('Resources'))), depth + 1);
        claim(obj.dict, 'X Object Forms');
      } else claim(x, 'X Object Forms');
    }
    for (const [key, cat] of [['Font', 'Fonts'], ['ColorSpace', 'Color Spaces'], ['Shading', 'Shadings'], ['Pattern', 'Patterns'], ['ExtGState', 'Extended Graphics States']]) {
      const v = res.get(N(key));
      if (v) claim(v, cat);
    }
  };
  const annots = page => { const a = look(page.node.get(N('Annots'))); return a instanceof PDFArray ? a.asArray() : []; };
  const appearanceResources = annot => {
    const ap = dictOf(dictOf(annot).get(N('AP')));
    for (const [, v] of ap.entries()) {
      const o = look(v);
      const streams = o instanceof PDFStream ? [o.dict] : o instanceof PDFDict ? [...o.entries()].map(([, s]) => look(s)).filter(s => s instanceof PDFStream).map(s => s.dict) : [];
      for (const d of streams) resources(dictOf(d.get(N('Resources'))), 1);
    }
  };
  const annotCategory = annot => { const d = annot instanceof PDFRef ? look(annot) : null; return d instanceof PDFDict && nameText(look(d.get(N('Subtype')))) === 'Widget' ? 'Forms' : 'Comments'; };
  const cat = doc.catalog;
  const pages = doc.getPages();
  for (const p of pages) resources(dictOf(p.node.Resources?.() ?? null), 0);
  const form = dictOf(cat.get(N('AcroForm')));
  resources(dictOf(form.get(N('DR'))), 0);
  for (const p of pages) for (const x of annots(p)) appearanceResources(x);
  const struct = cat.get(N('StructTreeRoot'));
  if (struct) {
    for (const p of pages) for (const x of annots(p)) claim(x, annotCategory(x));
    claim(struct, 'Structure Info');
  }
  if (cat.get(N('AcroForm'))) claim(cat.get(N('AcroForm')), 'Forms');
  for (const p of pages) {
    for (const x of annots(p)) claim(x, annotCategory(x));
    const c = p.node.get(N('Contents'));
    if (c) claim(c, 'Content Streams');
    const t = p.node.get(N('Thumb'));
    if (t) claim(t, 'Thumbnails');
  }
  if (cat.get(N('Outlines'))) claim(cat.get(N('Outlines')), 'Bookmarks');
  const names = dictOf(cat.get(N('Names')));
  const dests = names.get(N('Dests')) ?? cat.get(N('Dests'));
  if (dests) claim(dests, 'Named Destinations');
  if (names.get(N('EmbeddedFiles'))) claim(names.get(N('EmbeddedFiles')), 'Embedded Files');
  const bytes = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const c = owner.get(ref.objectNumber);
    if (c) bytes.set(c, (bytes.get(c) ?? 0) + obj.sizeInBytes() + 40);
  }
  const counted = [...bytes.values()].reduce((a, b) => a + b, 0);
  const total = Math.max(fileLength, counted, 1);
  bytes.set('Document Overhead', total - counted);
  return CATEGORIES.map(category => { const b = bytes.get(category) ?? 0; return {category, bytes: b, percent: b * 100 / total}; });
}
