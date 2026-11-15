// The PDF source behind the folio model, for edits that change page objects: loading it, reading
// pages added to it, making every model page its own source page ("materialize"), and writing the
// result back as the document's new source (one undoable change).
//
// printcraft edits its own COS document in place (crates/organize/src/lib.rs walk/rebuild,
// crates/edit/src/place.rs page_list) and its undo keeps whole-document snapshots
// (crates/engine/src/history.rs). The folio model keeps the file's bytes (`sourceBase64`) plus
// page records (core/folio/schema.mjs); an edit that changes what a page draws rewrites the
// source bytes, which the kernel's undo restores as one value. Translated against
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// pdf-lib (pure JS) parses and writes; no DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFRef} from 'pdf-lib';
import {pdfBytes, PDF_MAX_BYTES} from '../../pdf-model.mjs';
import {readPageAnnots} from '../model/pdf-read.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {CommandError} from '../../kernel/errors.mjs';

const rot = v => ((v % 360) + 360) % 360;

/** Bytes → base64 (chunked; btoa is in both hosts and Node). */
export function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return globalThis.btoa(s);
}

/** Base64 → bytes, with the model's size rule. */
export const bytesOf = b64 => pdfBytes(b64);

/** Whether `bytes` start like a PDF. */
export function looksLikePdf(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes('%PDF-');
}

/** Load a PDF the person picked (another file): refuses what is not a PDF or cannot be read. */
export async function loadOther(bytes, name = 'the file') {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new CommandError('invalid_params', `${name} is empty`);
  if (!looksLikePdf(bytes)) throw new CommandError('invalid_params', `${name} is not a PDF`);
  try {
    const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
    if (doc.isEncrypted) throw new CommandError('failed', `${name} is password protected: open it and remove the security first`);
    if (!doc.getPageCount()) throw new CommandError('failed', `${name} has no pages`);
    return doc;
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError('failed', `${name} could not be read as a PDF: ${e.message}`);
  }
}

/** The document's source as a pdf-lib document. */
export async function loadSource(content) {
  if (!content?.sourceBase64) throw new CommandError('disabled', 'no PDF open');
  return PDFDocument.load(bytesOf(content.sourceBase64), {updateMetadata: false, ignoreEncryption: true});
}

/** Every comment id used in the content. */
export const usedIds = content => new Set((content.pages ?? []).flatMap(p => (p.annots ?? []).map(r => r.id)));

/** The page records' facts read from a source page: crop box, size, /Rotate. */
export function pageFacts(page) {
  const box = page.getCropBox();
  return {box: [box.x, box.y, box.x + box.width, box.y + box.height], width: box.width, height: box.height,
    sourceRotation: rot(page.getRotation().angle)};
}

/**
 * Model page records for source pages `indices` of `doc` (pages added to the source): their facts
 * and comments (pdf-read.mjs readPageAnnots; /IRT by reference resolved among them).
 */
export function readNewPages(doc, indices, {used, newId}) {
  const pages = doc.getPages();
  const byRef = new Map();
  const out = indices.map(sourceIndex => {
    const page = pages[sourceIndex];
    const {records, byRef: refs} = readPageAnnots(doc, page, used);
    for (const [k, v] of refs) byRef.set(k, v);
    return {id: newId(), sourceIndex, ...pageFacts(page), rotation: 0, overlays: [], annots: records};
  });
  for (const p of out) for (const r of p.annots) {
    if (r.irtRef) { const parent = byRef.get(r.irtRef); if (parent) r.irt = parent.id; }
    delete r.irtRef;
  }
  for (const p of out) p.annots = JSON.parse(JSON.stringify(p.annots));
  return out;
}

/** Whether model page `i` shares its source page with another model page. */
export const sharesSource = (content, i) => content.pages.some((p, j) => j !== i && p.sourceIndex === content.pages[i].sourceIndex);

/**
 * Make every model page its own source page, in model order, with its rotation written: the
 * source becomes exactly what Save writes (model/pdf-write.mjs writeFolioPdf), page ids and
 * comment ids kept. Byte-level edits then address model page i as source page i.
 * @returns {Promise<{doc: PDFDocument, content: object}>}
 */
export async function materialize(content) {
  const bytes = await writeFolioPdf(content);
  const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const used = new Set();
  const byRef = new Map();
  const pages = doc.getPages().map((page, i) => {
    const model = content.pages[i];
    const {records, byRef: refs} = readPageAnnots(doc, page, used);
    for (const [k, v] of refs) byRef.set(k, v);
    const next = {...model, sourceIndex: i, ...pageFacts(page), rotation: 0, annots: Array.isArray(model.annots) ? records : model.annots};
    delete next.duplicateOf;
    return next;
  });
  for (const p of pages) for (const r of p.annots ?? []) {
    if (r.irtRef) { const parent = byRef.get(r.irtRef); if (parent) r.irt = parent.id; }
    delete r.irtRef;
  }
  for (const p of pages) if (p.annots) p.annots = JSON.parse(JSON.stringify(p.annots));
  return {doc, content: {...content, pages}};
}

/**
 * The source opened for editing the pages at `targets` (model indices): when every target is
 * the only model page on its source page, the source as it is; otherwise materialized first
 * (a duplicated page's copy must change alone, as printcraft's real page copies do).
 */
export async function editable(content, targets = content.pages.map((_, i) => i)) {
  if (targets.some(i => sharesSource(content, i))) return materialize(content);
  return {doc: await loadSource(content), content};
}

/** The pdf-lib page of model page `i` in a document from `editable`. */
export const sourcePage = (doc, content, i) => doc.getPage(content.pages[i].sourceIndex);

/**
 * Save `doc` as the document's new source and set the page records (one change each, so undo
 * restores both). `refresh`: model indices whose box, size and /Rotate are read back.
 */
export async function commit(ctx, doc, content, {refresh = [], pages = null} = {}) {
  const bytes = await doc.save({updateFieldAppearances: false});
  if (bytes.length > PDF_MAX_BYTES) throw new CommandError('too_large', 'The PDF would exceed the 10 MB limit');
  const list = (pages ?? content.pages).map(p => ({...p}));
  const src = doc.getPages();
  for (const i of refresh) {
    const facts = pageFacts(src[list[i].sourceIndex]);
    list[i] = {...list[i], ...facts};
  }
  ctx.change.set(['sourceBase64'], base64(bytes));
  ctx.change.set(['pages'], list);
  return bytes;
}

/** commit, for a source a worker already wrote: the new bytes become the document's source, the page records are set again (one undo step). */
export function commitBytes(ctx, content, bytes) {
  if (bytes.length > PDF_MAX_BYTES) throw new CommandError('too_large', 'The PDF would exceed the 10 MB limit');
  ctx.change.set(['sourceBase64'], base64(bytes));
  ctx.change.set(['pages'], content.pages.map(p => ({...p})));
  return bytes;
}

/** A page's object reference (for comparisons). */
export const refOf = page => (page.ref instanceof PDFRef ? `${page.ref.objectNumber} ${page.ref.generationNumber}` : null);

export {PDFDocument, PDFName};
