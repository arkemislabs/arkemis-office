// Helpers for the ported printcraft crates/annot/src/tests.rs tests: a fixture document, adding
// comments the way upstream's add_annotation does, writing the PDF and reading it back
// (upstream's `reopen`, `list`, `ap_content`, `text`, `rect`).
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream} from 'pdf-lib';
import {createAnnotation} from '../../../core/folio/model/annots.mjs';
import {defaultStyle} from '../../../core/folio/model/types.mjs';
import {writeFolioPdf} from '../../../core/folio/model/pdf-write.mjs';
import {readSource} from '../../../core/folio/model/pdf-read.mjs';
import {schema1Content} from '../../../core/folio/fixtures.mjs';
import {migrateContent} from '../../../core/folio/migrate.mjs';

/** Upstream `fixture()`: two pages, an inline square comment on page 1 and a stamp on page 2. */
export async function fixtureContent() {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]), p2 = doc.addPage([612, 792]);
  const square = doc.context.obj({Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50], C: [1, 0, 0]});
  p1.node.set(PDFName.of('Annots'), doc.context.obj([square]));
  const stampAp = doc.context.register(doc.context.stream('0 0 1 rg 0 0 40 20 re f', {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 20]}));
  const stamp = doc.context.register(doc.context.obj({Type: 'Annot', Subtype: 'Stamp', Rect: [100, 100, 140, 120], Name: 'Approved', AP: {N: stampAp}}));
  p2.node.set(PDFName.of('Annots'), doc.context.obj([stamp]));
  return migrateContent(await schema1Content(await doc.save()));
}

export const meta = id => ({date: 'D:20261029120000Z', id});
/** Upstream `new(page, shape)`: author Ada, contents hello, the tool's default style. */
export const make = (shape, id) => createAnnotation({shape, style: defaultStyle(shape), contents: 'hello', author: 'Ada'}, meta(id));

export function addTo(content, page, record) {
  const pages = content.pages.map((p, i) => (i === page ? {...p, annots: [...(p.annots ?? []), record]} : p));
  return {...content, pages};
}
export function replaceIn(content, page, index, record) {
  const pages = content.pages.map((p, i) => (i === page ? {...p, annots: p.annots.map((r, j) => (j === index ? record : r))} : p));
  return {...content, pages};
}

/** Write and reopen: [{dict(PDFDict), subtype, ...}] of a page's /Annots, plus the pdf-lib document. */
export async function reopen(content) {
  const bytes = await writeFolioPdf(content);
  const doc = await PDFDocument.load(bytes);
  return {bytes, doc, list: page => {
    const arr = doc.getPage(page).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!arr) return [];
    return arr.asArray().map(e => ({ref: e instanceof PDFRef ? e : null, dict: e instanceof PDFRef ? doc.context.lookup(e) : e}));
  }};
}

export const name = (d, k) => { const v = d.lookup(PDFName.of(k)); return v instanceof PDFName ? v.decodeText() : null; };
export const text = (d, k) => { const v = d.lookup(PDFName.of(k)); return v && typeof v.decodeText === 'function' ? v.decodeText() : ''; };
export const nums = (d, k) => { const v = d.lookup(PDFName.of(k)); return v instanceof PDFArray ? v.asArray().map(x => (x instanceof PDFNumber ? x.asNumber() : NaN)) : null; };
export const rect = d => nums(d, 'Rect');
/** Upstream `ap_content`: the decoded normal appearance stream. */
export function apContent(doc, d) {
  const ap = d.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return '';
  const n = ap.lookup(PDFName.of('N'));
  if (!n) return '';
  const raw = n instanceof PDFRawStream ? decodePDFRawStream(n).decode() : n.getContents?.() ?? new Uint8Array();
  return String.fromCharCode(...raw);
}
export function apResources(doc, d) { return d.lookup(PDFName.of('AP')).lookup(PDFName.of('N')).dict.lookup(PDFName.of('Resources')); }
export {readSource};
