// Saving a signed PDF the way Acrobat does: never rewriting the signed bytes. What changed since
// the file was read (comments added, edited or deleted, pages turned) is appended as an
// incremental update, so every signature keeps covering exactly what it signed and validation
// reports the later changes (comments are permitted by approval signatures and DocMDP level 3).
//
// Translated from printcraft crates/sign/src/pdf/signing.rs (sign: the document written with
// `pdfcraft_cos::write_incremental` after the edits), crates/engine (a signed document's saves are
// incremental: Session::save for a document with signatures) and crates/annot/src/draw.rs /
// lookup.rs (the records written as annotation dictionaries with their appearance, as
// core/folio/model/pdf-write.mjs writes them) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {PDFName, PDFRef, PDFArray, degrees} from 'pdf-lib';
import {pdfBytes} from '../../pdf-model.mjs';
import {fromJson} from '../model/pdf-write.mjs';
import {readSource, pageAnnotEntries, imported} from '../model/pdf-read.mjs';
import {build} from '../model/appearance.mjs';
import {FLAG, NOTE_SIZE} from '../model/types.mjs';
import {pdfKey, nameAt, nums} from './cos.mjs';
import {normalize} from './geom.mjs';
import {loadPdf, writeIncremental} from './sign-pdf.mjs';
import {toBase64, latin1} from './sign-der.mjs';
import {modelFields} from './form-read.mjs';

const N = k => PDFName.of(k);
const keyOf = r => `${r.objectNumber} ${r.generationNumber}`;
const rot = v => ((v % 360) + 360) % 360;
const untouched = r => !!r.src && !r.edited && r.ap === 'source';
const binaryBytes = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

/** Whether the file holds signatures (a signature dictionary with /ByteRange). */
export function hasSignatures(bytes) {
  return /\/ByteRange\s*\[/.test(latin1(bytes));
}

/** Pages in their source order, none deleted, duplicated or reordered: what an incremental update can express. */
export const sameStructure = (content, sourcePages) => content.pages.length === sourcePages && content.pages.every((p, i) => p.sourceIndex === i && !p.duplicateOf);

function formStream(context, f) {
  const dict = {Type: '/XObject', Subtype: '/Form', FormType: 1, BBox: f.bbox, Resources: f.resources ?? {}};
  if (f.matrix) dict.Matrix = f.matrix;
  const d = fromJson(context, dict);
  const stream = context.flateStream(binaryBytes(f.content), {});
  for (const [k, v] of d.entries()) stream.dict.set(k, v);
  return context.register(stream);
}

/** pdf-write.mjs `writeRecord`, for one record written into an update. */
function recordDict(context, record, pageRef, refs, popupRefs) {
  const d = JSON.parse(JSON.stringify(record.dict));
  const sub = nameAt(d, 'Subtype');
  if (!d.NM) d.NM = {$t: record.id};
  let apRef = null;
  if (record.ap === 'build') {
    const f = build(d);
    if (f) apRef = formStream(context, f);
    if ((sub === 'Text' || sub === 'FileAttachment') && apRef) {
      const r = nums(d, 'Rect');
      if (r && r.length === 4) { const x = Math.min(r[0], r[2]), top = Math.max(r[1], r[3]); d.Rect = [x, top - NOTE_SIZE, x + NOTE_SIZE, top]; }
    }
    delete d.AS;
  } else if (record.ap === 'empty') apRef = context.register(context.stream(new Uint8Array(0), {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0]}));
  const dict = fromJson(context, {...d, AP: undefined});
  dict.delete(N('AP'));
  if (apRef) {
    const ap = context.obj({});
    if (d.AP && typeof d.AP === 'object' && !Array.isArray(d.AP)) for (const [k, v] of Object.entries(d.AP)) if (!['N', 'D', 'R'].includes(k)) ap.set(N(pdfKey(k)), fromJson(context, v));
    ap.set(N('N'), apRef);
    dict.set(N('AP'), ap);
  } else if (d.AP !== undefined) dict.set(N('AP'), fromJson(context, d.AP));
  dict.set(N('P'), pageRef);
  if (record.irt && refs.has(record.irt)) dict.set(N('IRT'), refs.get(record.irt));
  if (popupRefs.has(record.id)) dict.set(N('Popup'), popupRefs.get(record.id));
  return dict;
}

function popupDict(context, record, parentRef, pageRef) {
  const popup = fromJson(context, {Type: '/Annot', Subtype: '/Popup', Rect: normalize(record.popup.Rect), Open: !!record.popup.Open, F: FLAG.PRINT | FLAG.NO_ZOOM | FLAG.NO_ROTATE});
  popup.set(N('Parent'), parentRef);
  popup.set(N('P'), pageRef);
  return popup;
}

/**
 * The content's PDF as an incremental update of its source: the source bytes as they are when
 * nothing changed, else those bytes followed by the changed pages, comments and pop-ups.
 * Returns null when the change can't be written incrementally (pages deleted, duplicated or
 * reordered): the caller then writes the whole file (and any signature stops covering it).
 * @returns {Promise<Uint8Array|null>}
 */
export async function saveIncremental(content) {
  const source = pdfBytes(content.sourceBase64);
  const doc = await loadPdf(source);
  const ctx = doc.context;
  const pages = doc.getPages();
  if (!sameStructure(content, pages.length)) return null;
  const base = ctx.largestObjectNumber;
  const changed = new Set();
  const refs = new Map(), popupRefs = new Map();
  for (const page of content.pages) for (const r of page.annots ?? []) {
    refs.set(r.id, untouched(r) || r.src ? PDFRef.of(r.src[0], r.src[1]) : ctx.nextRef());
    if (r.popup) popupRefs.set(r.id, r.popupSrc ? PDFRef.of(r.popupSrc[0], r.popupSrc[1]) : ctx.nextRef());
  }
  content.pages.forEach((model, i) => {
    const page = pages[i];
    const want = rot((model.sourceRotation ?? 0) + (model.rotation ?? 0));
    if (rot(page.getRotation().angle) !== want) { page.setRotation(degrees(want)); changed.add(keyOf(page.ref)); }
    if (!Array.isArray(model.annots)) return;
    const entries = pageAnnotEntries(doc, page);
    const fileRecords = entries.filter(e => imported(e.dict.lookup(N('Subtype'))?.decodeText?.() ?? null)).map(e => (e.ref ? keyOf(e.ref) : null));
    const modelRefs = model.annots.map(r => (r.src ? `${r.src[0]} ${r.src[1]}` : null));
    const same = model.annots.every(untouched) && fileRecords.length === modelRefs.length && fileRecords.every((k, j) => k === modelRefs[j]);
    if (same) return;
    // The page's /Annots: what the model does not represent keeps its place, then the records.
    const recordRefs = new Set([...refs.values(), ...popupRefs.values()].map(keyOf));
    const list = [];
    for (const e of entries) {
      const sub = e.dict.lookup(N('Subtype'));
      const name = sub instanceof PDFName ? sub.decodeText() : null;
      const parent = e.dict.get(N('Parent'));
      const orphanPopup = name === 'Popup' && !(e.ref && recordRefs.has(keyOf(e.ref))) && !(parent instanceof PDFRef && recordRefs.has(keyOf(parent)));
      if (!imported(name) && (name !== 'Popup' || orphanPopup)) list.push(e.entry);
    }
    for (const r of model.annots) {
      const ref = refs.get(r.id);
      list.push(ref);
      if (!untouched(r)) { ctx.assign(ref, recordDict(ctx, r, page.ref, refs, popupRefs)); changed.add(keyOf(ref)); }
      if (r.popup) {
        const pr = popupRefs.get(r.id);
        if (!r.popupSrc || !untouched(r)) { ctx.assign(pr, popupDict(ctx, r, ref, page.ref)); changed.add(keyOf(pr)); }
        list.push(pr);
      }
    }
    const raw = page.node.get(N('Annots'));
    if (raw instanceof PDFRef && ctx.lookup(raw) instanceof PDFArray) { ctx.assign(raw, ctx.obj(list)); changed.add(keyOf(raw)); }
    else { if (list.length) page.node.set(N('Annots'), ctx.obj(list)); else page.node.delete(N('Annots')); changed.add(keyOf(page.ref)); }
  });
  if (!changed.size) return source;
  for (const [r] of ctx.enumerateIndirectObjects()) if (r.objectNumber > base) changed.add(keyOf(r));
  return writeIncremental(source, doc, changed);
}

/**
 * The content after its source became `bytes` (signed, or saved incrementally): every page reads
 * its comments from the new file, so they are untouched records again and a later save appends.
 */
export async function contentFromBytes(content, bytes) {
  const src = await readSource(bytes);
  const pages = content.pages.map((p, i) => {
    const s = src.pages[i];
    return {...p, sourceIndex: i, duplicateOf: undefined, sourceRotation: s.sourceRotation, rotation: 0, box: s.box,
      annots: s.annots.map(r => JSON.parse(JSON.stringify(r))), overlays: []};
  });
  const fields = modelFields(src.fields ?? [], pages);
  for (const p of pages) if (p.duplicateOf === undefined) delete p.duplicateOf;
  return {...content, sourceBase64: toBase64(bytes), pages, fields};
}

/**
 * The bytes the document stands for now (what validation checks and what a save writes for a
 * signed document): the source when unchanged, else an incremental update; null when only a full
 * rewrite can express the change.
 */
export async function currentBytes(content) {
  return saveIncremental(content);
}
