// Writing the folio model back into PDF bytes: page order, duplicates and rotation, every comment
// as a real annotation dictionary with its appearance stream (/AP /N), pop-ups, /IRT replies,
// page labels and bookmarks.
//
// Translated from printcraft crates/annot/src/create.rs (add_annotation: /P, /Popup with /Parent,
// the Popup's flags), crates/annot/src/draw.rs (apply_appearance: a new /N, the old /D and /R
// dropped, note and attachment icons pinned to a NOTE_SIZE box at the top-left of /Rect, the
// undrawn mark), crates/annot/src/modify.rs (reply's empty appearance) and
// crates/annot/src/lookup.rs (set_annots) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Page structure follows the existing
// schema-1 writer core/pdf-document.mjs (exportPdf); labels and bookmarks reuse
// core/pdf-label-tree.mjs and core/pdf-outline-tree.mjs.
//
// Unchanged comments read from the file are written back as the very same objects (their own
// appearance, unknown keys and all); only /NM is added to comments that had none, so the ids the
// bridge addresses survive a save and reopen (docs/architecture.md 14.5).

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFBool, PDFNull, degrees} from 'pdf-lib';
import {readPdfBookmarks, writePdfBookmarks} from '../../pdf-outline-tree.mjs';
import {readPdfLabelRanges, writePdfLabelRanges} from '../../pdf-label-tree.mjs';
import {dropDeletedPdfLabelPages} from '../../pdf-page-labels.mjs';
import {pdfBytes} from '../../pdf-model.mjs';
import {pdfKey, isRef, isText, isBytes, isName, nameAt, nums, textOf} from '../lib/cos.mjs';
import {normalize} from '../lib/geom.mjs';
import {UNDRAWN_MARK} from '../lib/fonts.mjs';
import {build, undrawableText, displayStamp, withUnicode} from './appearance.mjs';
import {unicodeFor, needsUnicode} from '../lib/unicode-text.mjs';
import {textsOf} from '../../common/lib/pdf-fonts.mjs';
import {FLAG, NOTE_SIZE} from './types.mjs';
import {pageAnnotEntries, imported} from './pdf-read.mjs';
import {saveEncrypted} from '../lib/protect.mjs';

const rot = v => ((v % 360) + 360) % 360;

/** PDF literal string for ASCII text, hex UTF-16 otherwise. */
function pdfText(s) {
  if (/^[\x20-\x7e\t\r\n]*$/.test(s)) return PDFString.of(s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
  return PDFHexString.fromText(s);
}

/** The JSON form (lib/cos.mjs) → a pdf-lib object in `context`. */
export function fromJson(context, v) {
  if (v === null || v === undefined) return PDFNull;
  if (v instanceof PDFRef) return v;   // a font embedded for the person's own text (appearance.mjs)
  if (typeof v === 'number') return PDFNumber.of(Number.isFinite(v) ? v : 0);
  if (typeof v === 'boolean') return v ? PDFBool.True : PDFBool.False;
  if (isName(v)) return PDFName.of(v.slice(1));
  if (typeof v === 'string') return pdfText(v);
  if (Array.isArray(v)) return context.obj(v.map(x => fromJson(context, x)));
  if (isRef(v)) return PDFRef.of(v.$ref[0], v.$ref[1]);
  if (isText(v)) return pdfText(v.$t);
  if (isBytes(v)) return PDFHexString.of(v.$x);
  const dict = context.obj({});
  for (const [k, x] of Object.entries(v)) {
    if (k === '$annot') continue;
    dict.set(PDFName.of(pdfKey(k)), fromJson(context, x));
  }
  return dict;
}

const binaryBytes = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

/** An appearance form XObject from model/appearance.mjs `build`. */
function formStream(context, f) {
  const dict = {Type: '/XObject', Subtype: '/Form', FormType: 1, BBox: f.bbox, Resources: f.resources ?? {}};
  if (f.matrix) dict.Matrix = f.matrix;
  const d = fromJson(context, dict);
  const stream = context.flateStream(binaryBytes(f.content), {});
  for (const [k, v] of d.entries()) stream.dict.set(k, v);
  return context.register(stream);
}

function emptyForm(context) {
  const stream = context.stream(new Uint8Array(0), {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0]});
  return context.register(stream);
}

/** The annotation dictionary for a record, with its appearance and structural links. */
function writeRecord(context, record, pageRef, refs, popupRefs, pageRefs = new Map()) {
  const d = JSON.parse(JSON.stringify(record.dict));
  // A link to a page of this document names it by id (`$pg`): the page's object now. A page that is gone leaves a link with no action.
  if (d.A && Array.isArray(d.A.D) && d.A.D[0] && typeof d.A.D[0] === 'object' && '$pg' in d.A.D[0]) {
    const target = pageRefs.get(d.A.D[0].$pg);
    if (target) d.A = {...d.A, D: [{$ref: [target.objectNumber, target.generationNumber]}, ...d.A.D.slice(1)]}; else delete d.A;
  }
  const sub = nameAt(d, 'Subtype');
  if (!d.NM) d.NM = {$t: record.id};
  let apRef = null;
  if (record.ap === 'build') {
    const f = build(d) ?? (sub === 'Stamp' ? displayStamp({...d, AP: undefined}) : null);
    if (f) apRef = formStream(context, f);
    const bad = undrawableText(d);
    if (bad) d[UNDRAWN_MARK] = {$t: bad[1]}; else delete d[UNDRAWN_MARK];
    if ((sub === 'Text' || sub === 'FileAttachment') && apRef) {
      const r = nums(d, 'Rect');
      if (r && r.length === 4) { const x = Math.min(r[0], r[2]), top = Math.max(r[1], r[3]); d.Rect = [x, top - NOTE_SIZE, x + NOTE_SIZE, top]; }
    }
    delete d.AS;
  } else if (record.ap === 'empty') apRef = emptyForm(context);
  const dict = fromJson(context, {...d, AP: undefined});
  dict.delete(PDFName.of('AP'));
  if (apRef) {
    const ap = context.obj({});
    if (d.AP && typeof d.AP === 'object' && !Array.isArray(d.AP)) for (const [k, v] of Object.entries(d.AP)) if (!['N', 'D', 'R'].includes(k)) ap.set(PDFName.of(pdfKey(k)), fromJson(context, v));
    ap.set(PDFName.of('N'), apRef);
    dict.set(PDFName.of('AP'), ap);
  } else if (d.AP !== undefined) dict.set(PDFName.of('AP'), fromJson(context, d.AP));
  dict.set(PDFName.of('P'), pageRef);
  if (record.irt && refs.has(record.irt)) dict.set(PDFName.of('IRT'), refs.get(record.irt));
  const popupRef = popupRefs.get(record.id);
  if (popupRef) dict.set(PDFName.of('Popup'), popupRef);
  return dict;
}

function writePopup(context, record, parentRef, pageRef) {
  const popup = fromJson(context, {Type: '/Annot', Subtype: '/Popup', Rect: normalize(record.popup.Rect), Open: !!record.popup.Open,
    F: FLAG.PRINT | FLAG.NO_ZOOM | FLAG.NO_ROTATE});
  popup.set(PDFName.of('Parent'), parentRef);
  popup.set(PDFName.of('P'), pageRef);
  return popup;
}

/** Whether a record can be written back as the object it was read from. */
const untouched = r => r.src && !r.edited && r.ap === 'source';

/**
 * Write the content (folio schema 2, or schema 1 without comment records) to PDF bytes.
 * @param {object} content
 * @param {{encrypt?: boolean}} [opts] encrypt: write the file with the document's password security
 *   (`content.security`, protect.mjs); Save does, the internal rewrites (materialize, extract) do not.
 * @returns {Promise<Uint8Array>}
 */
export async function writeFolioPdf(content, {encrypt = false} = {}) {
  if (!content?.pages?.length) throw new Error('Open or create a PDF first.');
  const output = await PDFDocument.load(pdfBytes(content.sourceBase64), {updateMetadata: false, ignoreEncryption: true});
  const originalPages = output.getPages();
  for (const page of content.pages) if (page.sourceIndex >= originalPages.length) throw new Error('Invalid source page index.');
  const sourceBookmarks = readPdfBookmarks(output, content.pages);
  const bookmarksChanged = content.bookmarks !== undefined && JSON.stringify(content.bookmarks) !== JSON.stringify(sourceBookmarks);
  const sourceLabels = readPdfLabelRanges(output);
  const labelsChanged = content.pageLabels !== undefined && JSON.stringify(content.pageLabels) !== JSON.stringify(sourceLabels);
  const structural = content.pages.length !== originalPages.length || content.pages.some((p, i) => p.sourceIndex !== i);

  // Pages: the first model page per source page keeps the original object; others are copies.
  const representatives = new Map();
  for (const model of content.pages) { const prev = representatives.get(model.sourceIndex); if (!prev || (prev.duplicateOf && !model.duplicateOf)) representatives.set(model.sourceIndex, model); }
  const ordered = [];
  for (const model of content.pages) {
    if (representatives.get(model.sourceIndex) !== model) { const [copy] = await output.copyPages(output, [model.sourceIndex]); ordered.push({page: copy, copy: true}); }
    else ordered.push({page: originalPages[model.sourceIndex], copy: false});
  }
  if (structural) {
    for (let i = originalPages.length - 1; i >= 0; i--) output.removePage(i);
    for (const {page} of ordered) output.addPage(page);
  }

  const context = output.context;
  // Every record gets its output reference first, so replies and groups can point at their parents.
  const refs = new Map(), popupRefs = new Map();
  ordered.forEach(({copy}, i) => {
    for (const r of content.pages[i].annots ?? []) {
      refs.set(r.id, untouched(r) && !copy ? PDFRef.of(r.src[0], r.src[1]) : context.nextRef());
      if (r.popup) popupRefs.set(r.id, r.popupSrc && untouched(r) && !copy ? PDFRef.of(r.popupSrc[0], r.popupSrc[1]) : context.nextRef());
    }
  });
  const pageRefs = new Map(ordered.map(({page}, i) => [content.pages[i].id, page.ref]));
  // Free text and stamps typed in a script the standard faces lack are drawn with a system font embedded for them.
  const uni = await unicodeFor(output, textsOf(content.pages.map(p => (Array.isArray(p.annots) ? p.annots.filter(r => r.ap === 'build').map(r => r.dict) : []))).filter(needsUnicode));
  withUnicode(uni, () => ordered.forEach(({page, copy}, i) => {
    const model = content.pages[i];
    page.setRotation(degrees(rot((model.sourceRotation ?? 0) + (model.rotation ?? 0))));
    if (!Array.isArray(model.annots)) return;   // schema-1 content: comments were never read, the file's stay as they are
    // Entries the model does not represent (form widgets, orphan pop-ups) keep their place first.
    const recordRefs = new Set([...refs.values(), ...popupRefs.values()].map(r => `${r.objectNumber} ${r.generationNumber}`));
    const kept = [];
    for (const e of pageAnnotEntries(output, page)) {
      const sub = e.dict.lookup(PDFName.of('Subtype'));
      const name = sub instanceof PDFName ? sub.decodeText() : null;
      const isOrphanPopup = name === 'Popup' && !(e.ref && recordRefs.has(`${e.ref.objectNumber} ${e.ref.generationNumber}`)) && !(e.dict.get(PDFName.of('Parent')) instanceof PDFRef && recordRefs.has((r => `${r.objectNumber} ${r.generationNumber}`)(e.dict.get(PDFName.of('Parent')))));
      if (!imported(name) && (name !== 'Popup' || isOrphanPopup)) kept.push(e.entry);
    }
    const list = [...kept];
    for (const r of model.annots) {
      const ref = refs.get(r.id);
      if (untouched(r) && !copy) {
        // The same object; /NM written back when the file had none.
        const dict = context.lookup(ref);
        if (dict instanceof PDFDict && !dict.get(PDFName.of('NM'))) dict.set(PDFName.of('NM'), pdfText(r.id));
        if (dict instanceof PDFDict) dict.set(PDFName.of('P'), page.ref);
        list.push(ref);
        if (r.popup && r.popupSrc) list.push(popupRefs.get(r.id));
        else if (r.popup) { context.assign(popupRefs.get(r.id), writePopup(context, r, ref, page.ref)); list.push(popupRefs.get(r.id)); }
        continue;
      }
      context.assign(ref, writeRecord(context, r, page.ref, refs, popupRefs, pageRefs));
      list.push(ref);
      if (r.popup) { context.assign(popupRefs.get(r.id), writePopup(context, r, ref, page.ref)); list.push(popupRefs.get(r.id)); }
    }
    if (list.length) page.node.set(PDFName.of('Annots'), context.obj(list));
    else page.node.delete(PDFName.of('Annots'));
  }));

  const deleted = originalPages.map((_, i) => i).filter(i => !content.pages.some(p => p.sourceIndex === i));
  const labels = content.pageLabels ?? (structural ? dropDeletedPdfLabelPages(sourceLabels, deleted, content.pages.length) : sourceLabels);
  if (labelsChanged || structural) writePdfLabelRanges(output, labels);
  if (bookmarksChanged || structural) writePdfBookmarks(output, content.bookmarks ?? sourceBookmarks, content.pages);
  output.setProducer('Arkemis PDF');
  if (encrypt && content.security) return saveEncrypted(output, content.security);
  return output.save();
}

export {textOf};
