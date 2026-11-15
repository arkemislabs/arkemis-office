// Reading a PDF into the folio model: page boxes, every annotation as a comment record (with its
// pop-up and /IRT folded in), form fields with their widgets, bookmarks and page labels.
//
// Translated from printcraft crates/annot/src/lookup.rs (annots, annot_dict: inline entries and
// references, final_ref chains), crates/annot/src/info.rs (summaries: /IRT by reference, pop-ups
// and widgets are not comments) and crates/render/src/inspect (page boxes) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Bookmarks and page labels use the existing translations core/pdf-outline-tree.mjs and
// core/pdf-label-tree.mjs (printcraft crates/organize/src/outline.rs, labels.rs).
//
// pdf-lib (pure JS, already a dependency) parses the file; it runs in both hosts and in node --test.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFBool, PDFNull, PDFStream} from 'pdf-lib';
import {jsonKey} from '../lib/cos.mjs';
import {normalize} from '../lib/geom.mjs';
import {readFields as readForm} from '../lib/form-read.mjs';

const MAX_DEPTH = 32;
/** Keys the model keeps structurally rather than in the dictionary. */
export const STRUCTURAL_KEYS = ['P', 'Popup', 'IRT', 'Parent'];

/** A pdf-lib object → the JSON form (lib/cos.mjs). References are kept, never followed. */
export function toJson(obj, depth = 0) {
  if (depth > MAX_DEPTH || obj === undefined) return null;
  if (obj instanceof PDFRef) return {$ref: [obj.objectNumber, obj.generationNumber]};
  if (obj instanceof PDFName) return `/${obj.decodeText()}`;
  if (obj instanceof PDFString || obj instanceof PDFHexString) return {$t: obj.decodeText()};
  if (obj instanceof PDFNumber) return obj.asNumber();
  if (obj instanceof PDFBool) return obj.asBoolean();
  if (obj === PDFNull || obj instanceof PDFStream) return null;
  if (obj instanceof PDFArray) return obj.asArray().map(x => toJson(x, depth + 1));
  if (obj instanceof PDFDict) {
    const out = {};
    for (const [k, v] of obj.entries()) out[jsonKey(k.decodeText())] = toJson(v, depth + 1);
    return out;
  }
  return null;
}

const refKey = r => `${r.objectNumber} ${r.generationNumber}`;

/** lookup.rs `final_ref`: follow a reference to a reference, a few steps. */
function finalRef(context, r) {
  for (let i = 0; i < 8; i++) {
    const o = context.lookup(r);
    if (o instanceof PDFRef) r = o; else break;
  }
  return r;
}

/** The annotation entries of a page: [{ref|null, dict}] (inline entries have no reference). */
export function pageAnnotEntries(doc, page) {
  const arr = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < arr.size(); i++) {
    const raw = arr.get(i);
    let ref = raw instanceof PDFRef ? finalRef(doc.context, raw) : null;
    const dict = ref ? doc.context.lookup(ref) : raw;
    if (dict instanceof PDFDict) out.push({ref, dict, entry: raw});
  }
  return out;
}

const subtypeOfDict = d => { const s = d.lookup(PDFName.of('Subtype')); return s instanceof PDFName ? s.decodeText() : null; };

/** Annotations a folio record represents: everything but form widgets (fields own them) and pop-ups (folded into their parent). */
export const imported = subtype => !!subtype && subtype !== 'Widget' && subtype !== 'Popup';

/**
 * Read the comment records of one page. `used` collects ids already taken in the document.
 * Returns records in /Annots order.
 */
export function readPageAnnots(doc, page, used = new Set()) {
  const entries = pageAnnotEntries(doc, page);
  const records = [], byRef = new Map();
  for (const {ref, dict} of entries) {
    const subtype = subtypeOfDict(dict);
    if (!imported(subtype)) continue;
    const json = toJson(dict);
    for (const k of STRUCTURAL_KEYS) delete json[k];
    let id = typeof json.NM?.$t === 'string' && json.NM.$t.trim() ? json.NM.$t.trim() : ref ? `src-${ref.objectNumber}-${ref.generationNumber}` : null;
    if (!id) id = `inline-${records.length}`;
    while (used.has(id)) id = `${id}~`;
    used.add(id);
    const record = {id, dict: json, ap: 'source'};
    if (ref) record.src = [ref.objectNumber, ref.generationNumber];
    // Fold the pop-up in: its rectangle and open state go with the comment.
    const popup = dict.lookup(PDFName.of('Popup'));
    if (popup instanceof PDFDict) {
      const r = popup.lookup(PDFName.of('Rect'));
      const rect = r instanceof PDFArray ? r.asArray().map(x => (x instanceof PDFNumber ? x.asNumber() : 0)) : null;
      const open = popup.lookup(PDFName.of('Open'));
      if (rect && rect.length === 4) record.popup = {Rect: normalize(rect), Open: open instanceof PDFBool ? open.asBoolean() : false};
      const pr = dict.get(PDFName.of('Popup'));
      if (pr instanceof PDFRef) record.popupSrc = [pr.objectNumber, pr.generationNumber];
    }
    const irt = dict.get(PDFName.of('IRT'));
    if (irt instanceof PDFRef) record.irtRef = refKey(finalRef(doc.context, irt));
    if (ref) byRef.set(refKey(ref), record);
    records.push(record);
  }
  return {records, byRef};
}

/** Form fields with their widgets (form-read.mjs: widgets carry their source page index in `page`). */
export function readFields(doc) {
  try { return readForm(doc); } catch { return []; }
}

/**
 * Read a PDF's pages and annotations: what migration and import attach to the content.
 * @param {Uint8Array} bytes
 */
export async function readSource(bytes) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const used = new Set();
  const allByRef = new Map();
  const pages = doc.getPages().map((page, sourceIndex) => {
    const box = page.getCropBox();
    const {records, byRef} = readPageAnnots(doc, page, used);
    for (const [k, v] of byRef) allByRef.set(k, v);
    return {sourceIndex, box: [box.x, box.y, box.x + box.width, box.y + box.height], width: box.width, height: box.height,
      sourceRotation: ((page.getRotation().angle % 360) + 360) % 360, annots: records};
  });
  // /IRT by reference (info.rs: /NM need not be unique).
  for (const page of pages) for (const r of page.annots) {
    if (r.irtRef) { const parent = allByRef.get(r.irtRef); if (parent) r.irt = parent.id; }
    delete r.irtRef;
  }
  return {doc, pages, fields: readFields(doc)};
}
