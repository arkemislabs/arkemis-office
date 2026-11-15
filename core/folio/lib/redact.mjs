// Apply redactions: remove, for good, everything under the redaction marks, then draw the marks'
// boxes; and Remove hidden information / Sanitize.
//
// Translated from printcraft crates/redact/src/lib.rs (marks, apply_to: localize_resources, redact_page_content,
// remove_page_annotations, removal of fields under a mark, the boxes, verification, Report), overlay.rs
// (the box and its overlay text, repeat, alignment, auto size) and sanitize.rs (the Hidden categories:
// scan and remove) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// The folio model keeps the file's bytes: this works on a pdf-lib document of the source, and the
// command that calls it stores the result as the new source in one undoable change, with the marks
// and the comments under them taken out of the page records. Fail closed: a page whose content can't
// be read, vertical text, or anything still found under a mark after the rewrite refuses the whole
// operation and the document stays as it was. What is removed is gone from the bytes: replaced
// content streams, images and forms are deleted from the file (an unreachable object would still be
// written), so a Save leaves no trace.
// No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFName, PDFArray, PDFDict, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber, PDFBool, decodePDFRawStream} from 'pdf-lib';
import {Redactor, RedactError, parseContent, serializeContent, IDENTITY, overlaps} from './redact-content.mjs';
import {fontWidth, winAnsiBytes, firstUndrawable, undrawableMessage, literal} from './fonts.mjs';
import {readFields} from './form-read.mjs';
import {needsUnicode} from './unicode-text.mjs';
import * as E from './form-edit.mjs';

export {RedactError};

const N = s => PDFName.of(s);
const numOf = v => (v instanceof PDFNumber ? v.asNumber() : undefined);
const nameOf = v => (v instanceof PDFName ? v.decodeText() : undefined);
const fmtN = v => { const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; };

// ── marks ──────────────────────────────────────────────────────────────────────────────────────

const bboxOfQuad = q => {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** The overlay look of a redact record: font, size and colour from /DA, alignment from /Q, repetition from /Repeat. */
export function overlayLook(dict) {
  const look = {font: 'Helv', size: 0, color: [1, 0, 0], align: 1, repeat: false};
  const da = dict.DA?.$t;
  if (typeof da === 'string') {
    const t = da.split(/\s+/).filter(Boolean);
    t.forEach((w, i) => {
      if (w === 'rg' && i >= 3) { const c = [t[i - 3], t[i - 2], t[i - 1]].map(Number); if (c.every(Number.isFinite)) look.color = c; }
      else if (w === 'g' && i >= 1 && Number.isFinite(Number(t[i - 1]))) look.color = [Number(t[i - 1]), Number(t[i - 1]), Number(t[i - 1])];
      else if (w === 'Tf' && i >= 2) { look.font = t[i - 2].replace(/^\//, ''); look.size = Math.max(0, Number(t[i - 1]) || 0); }
    });
  }
  look.align = Math.min(Math.max(Number.isInteger(dict.Q) ? dict.Q : 1, 0), 2);
  look.repeat = dict.Repeat === true;
  return look;
}

/** Every redaction mark of the model, page by page: {page, id, rects (user space), fill, overlay, look}. */
export function marksOf(content) {
  const out = [];
  (content?.pages ?? []).forEach((page, pi) => {
    for (const r of page.annots ?? []) {
      if (r.dict?.Subtype !== '/Redact') continue;
      const q = Array.isArray(r.dict.QuadPoints) ? r.dict.QuadPoints : [];
      const rects = [];
      for (let i = 0; i + 8 <= q.length; i += 8) {
        const b = bboxOfQuad(q.slice(i, i + 8));
        if (b.every(Number.isFinite)) rects.push(b);
      }
      if (!rects.length && Array.isArray(r.dict.Rect) && r.dict.Rect.length === 4) {
        const v = r.dict.Rect;
        rects.push([Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]);
      }
      const ic = r.dict.IC;
      const fill = Array.isArray(ic) ? (ic.length === 1 ? [ic[0], ic[0], ic[0]] : ic.length === 3 ? ic : ic.length === 4 ? [(1 - ic[0]) * (1 - ic[3]), (1 - ic[1]) * (1 - ic[3]), (1 - ic[2]) * (1 - ic[3])] : null) : null;
      out.push({page: pi, id: r.id, rects, fill, overlay: r.dict.OverlayText?.$t ?? '', look: overlayLook(r.dict), unreadable: !rects.length});
    }
  });
  return out;
}

// ── the boxes ──────────────────────────────────────────────────────────────────────────────────

const OVERLAY_FONTS = {Helv: ['PCHelv', 'Helvetica'], TiRo: ['PCTimes', 'Times-Roman'], Cour: ['PCCour', 'Courier']};
const MAX_OVERLAY_BYTES = 8 * 1024 * 1024;

/**
 * overlay.rs `content`: each mark's box in its colour, then its overlay text. Returns the operators and the fonts used. An overlay text in a script the standard faces cannot
 * draw is set with the system font of `uni` (lib/unicode-text.mjs, shaped, in reading order) and its fonts come back as `unicodeFonts` ({name, ref}).
 */
export function overlayContent(marks, uni = null) {
  const fonts = new Set();
  let out = '';
  for (const m of marks) {
    if (!m.fill) continue;
    out += `q ${m.fill.map(fmtN).join(' ')} rg\n`;
    for (const r of m.rects) out += `${fmtN(r[0])} ${fmtN(r[1])} ${fmtN(r[2] - r[0])} ${fmtN(r[3] - r[1])} re f\n`;
    out += 'Q\n';
    if (!m.overlay) continue;
    const look = m.look;
    const [res, face] = OVERLAY_FONTS[look.font] ?? OVERLAY_FONTS.Helv;
    const own = !!uni && needsUnicode(m.overlay) && uni.canDraw(m.overlay);
    if (!own) fonts.add(res);
    const width = (s, size) => (own ? uni.width(s, size) : fontWidth(face, s, size));
    const [cr, cg, cb] = look.color.map(v => Math.min(1, Math.max(0, v)));
    for (const r of m.rects) {
      const w = r[2] - r[0];
      const h = r[3] - r[1];
      let size = look.size > 0 ? look.size : Math.min(h * 0.7, 12);
      const tw = width(m.overlay, size);
      if (look.size <= 0 && tw > w - 2 && tw > 0) size *= Math.max(0, w - 2) / tw;
      if (size < 2) continue;
      let line = m.overlay;
      let count = 1;
      if (look.repeat) {
        const unit = Math.max(width(`${m.overlay} `, size), 0.01);
        const across = Math.max(1, Math.floor((w - 2) / unit));
        count = Math.max(1, Math.floor(h / (size * 1.2)));
        if (across * (m.overlay.length + 1) * count > MAX_OVERLAY_BYTES) throw new RedactError('limit', 'The redaction appearance exceeds the 8 MiB budget; reduce the marked area, turn off repeated text or apply fewer pages at once (nothing was redacted).');
        line = Array.from({length: across}, () => m.overlay).join(' ');
      }
      const show = (text, sz) => (own ? uni.ops(text, sz) : `${literal(winAnsiBytes(text))} Tj `);
      const lw = width(line, size);
      const x = look.align === 0 ? r[0] + 1 : look.align === 2 ? r[2] - 1 - lw : r[0] + (w - lw) / 2;
      let y = r[1] + (h + count * size * 1.2) / 2 - size * 0.95;
      out += `q ${fmtN(r[0])} ${fmtN(r[1])} ${fmtN(w)} ${fmtN(h)} re W n BT ${fmtN(cr)} ${fmtN(cg)} ${fmtN(cb)} rg ${own ? '' : `/${res} ${fmtN(size)} Tf `}`;
      for (let i = 0; i < count; i++) { out += `1 0 0 1 ${fmtN(x)} ${fmtN(y)} Tm ${show(line, size)}`; y -= size * 1.2; }
      out += 'ET Q\n';
    }
  }
  return {text: out, fonts, unicodeFonts: uni ? uni.fonts() : []};
}

// ── reading a page ─────────────────────────────────────────────────────────────────────────────

/** The decoded bytes of every content stream of a page, joined (strict: a stream that can't be decoded refuses). */
function pageContent(doc, page, index) {
  const context = doc.context;
  const node = page.node;
  const c = node.get(N('Contents'));
  const list = [];
  const one = o => {
    const v = context.lookup(o);
    if (v instanceof PDFArray) v.asArray().forEach(one);
    else if (v instanceof PDFStream) list.push(v);
    else if (v !== undefined && !(v?.constructor?.name === 'PDFNull')) throw new RedactError('unreadable', `Page ${index + 1} has content that can't be read, so it can't be redacted safely.`);
  };
  if (c) one(c);
  const parts = [];
  for (const s of list) {
    try { parts.push(decodePDFRawStream(s instanceof PDFRawStream ? s : PDFRawStream.of(s.dict, s.getContents())).decode()); } catch { throw new RedactError('unreadable', `Page ${index + 1} has content that can't be read, so it can't be redacted safely.`); }
  }
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; out[at++] = 10; }
  return {bytes: out, streams: list};
}

const effectiveResources = (doc, page) => {
  const r = page.node.Resources?.() ?? doc.context.lookup(page.node.get(N('Resources')));
  return r instanceof PDFDict ? r : null;
};

const rectOfDict = (context, d) => {
  const a = context.lookup(d.get(N('Rect')));
  if (!(a instanceof PDFArray) || a.size() !== 4) return null;
  const v = a.asArray().map(x => numOf(context.lookup(x)));
  if (v.some(x => x === undefined || !Number.isFinite(x))) return null;
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
};

const keyOfRef = r => `${r.objectNumber} ${r.generationNumber}`;

// ── reachability: nothing unreachable stays in the file ────────────────────────────────────────

/** Delete every indirect object no trailer entry reaches: pdf-lib writes every object it holds, reachable or not. */
export function collectGarbage(doc) {
  const context = doc.context;
  const seen = new Set();
  const stack = [];
  const push = o => {
    if (o instanceof PDFRef) { const k = keyOfRef(o); if (!seen.has(k)) { seen.add(k); stack.push(o); } return; }
    if (o instanceof PDFDict) { for (const v of o.values()) push(v); return; }
    if (o instanceof PDFArray) { for (const v of o.asArray()) push(v); return; }
    if (o instanceof PDFStream) push(o.dict);
  };
  const t = context.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt]) if (o) push(o);
  while (stack.length) {
    const r = stack.pop();
    const o = context.lookup(r);
    if (o) push(o);
  }
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) if (!seen.has(keyOfRef(ref))) { context.delete(ref); removed++; }
  return removed;
}

// ── apply ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply `marks` ({page: source index, rects, fill, overlay, look}) to the pdf-lib document `doc`, in place. `options.unicode` is the Unicode text set made ready for the overlay
 * texts (unicodeFor(doc, texts)): without it an overlay text the standard faces cannot draw is refused.
 * Throws RedactError (the document may be part rewritten: callers work on a copy and drop it).
 * @returns {{pages: number, marks: number, glyphs: number, imagesRemoved: number, imagesCleared: number, pathsRemoved: number, pathsClipped: number, formsRewritten: number, annotations: number, fields: number}}
 */
export function applyMarks(doc, marks, options = {}) {
  const uni = options.unicode ?? null;
  const context = doc.context;
  const report = {pages: new Set(marks.map(m => m.page)).size, marks: marks.length, glyphs: 0, imagesRemoved: 0, imagesCleared: 0, pathsRemoved: 0, pathsClipped: 0, formsRewritten: 0, annotations: 0, fields: 0};
  // Overlay text is drawn in the standard fonts, or in a system font for another script: text neither can draw is refused before anything changes.
  for (const m of marks) {
    const bad = firstUndrawable(m.overlay);
    if (bad && !(uni && uni.canDraw(m.overlay))) throw new RedactError('undrawable', `${undrawableMessage(`the overlay text of a redaction mark on page ${m.page + 1}`, bad)}; change or clear that mark's overlay text, then apply again (nothing was redacted).`);
  }
  const byPage = new Map();
  for (const m of marks) (byPage.get(m.page) ?? byPage.set(m.page, []).get(m.page)).push(m);
  const doomedFields = new Set();
  const fields = readFields(doc);
  for (const [pi, pageMarks] of byPage) {
    const page = doc.getPage(pi);
    const rects = pageMarks.flatMap(m => m.rects);
    // 1. The page's content.
    const {bytes} = pageContent(doc, page, pi);
    const redactor = new Redactor({context, rects});
    const resources = effectiveResources(doc, page);
    const result = redactor.process(parseContent(bytes), resources, {ctm: IDENTITY});
    for (const k of Object.keys(redactor.report)) if (k in report) report[k] += redactor.report[k];
    // 2. The boxes, their fonts and the resources: the page gets resources of its own (the shared ones stay as they were).
    const overlay = overlayContent(pageMarks, uni);
    const res = redactor.cloneResources(resources, result);
    if (overlay.fonts.size || overlay.unicodeFonts.length) {
      const fontsDict = context.lookup(res.get(N('Font')));
      const fd = fontsDict instanceof PDFDict ? fontsDict.clone() : context.obj({});
      for (const f of overlay.fonts) {
        const base = Object.values(OVERLAY_FONTS).find(([n]) => n === f)[1];
        fd.set(N(f), context.register(context.obj({Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding'})));
      }
      for (const f of overlay.unicodeFonts) fd.set(N(f.name), f.ref);
      res.set(N('Font'), fd);
    }
    page.node.set(N('Resources'), res);
    const body = serializeContent(result.ops);
    const head = new TextEncoder().encode('q\n');
    const tail = new TextEncoder().encode(`\nQ\n%PCRedactionBoxes\n${overlay.text}`);
    const joined = new Uint8Array(head.length + body.length + tail.length);
    joined.set(head, 0); joined.set(body, head.length); joined.set(tail, head.length + body.length);
    const stream = context.flateStream(joined);
    page.node.set(N('Contents'), context.register(stream));
    // 3. Annotations under a mark go: comments, links, and the widgets (their fields follow); replies and pop-ups of a removed one too.
    const annots = page.node.Annots?.();
    if (annots instanceof PDFArray) {
      const removed = new Set();
      const entries = annots.asArray();
      const info = entries.map(e => {
        const d = context.lookup(e);
        return d instanceof PDFDict ? {entry: e, dict: d, rect: rectOfDict(context, d), sub: nameOf(context.lookup(d.get(N('Subtype'))))} : {entry: e, dict: null, rect: null, sub: null};
      });
      info.forEach(i => { if (i.dict && (i.sub === 'Redact' || (i.rect && rects.some(r => overlaps(r, i.rect, 0))))) { removed.add(i); } });
      const refKey = e => (e instanceof PDFRef ? keyOfRef(e) : null);
      for (let grew = true; grew;) {
        grew = false;
        const keys = new Set([...removed].map(i => refKey(i.entry)).filter(Boolean));
        for (const i of info) {
          if (removed.has(i) || !i.dict) continue;
          const irt = i.dict.get(N('IRT'));
          const parent = i.dict.get(N('Parent'));
          if ((irt instanceof PDFRef && keys.has(keyOfRef(irt)) && i.sub !== 'Widget') || (i.sub === 'Popup' && parent instanceof PDFRef && keys.has(keyOfRef(parent)))) { removed.add(i); grew = true; }
        }
      }
      const kept = info.filter(i => !removed.has(i)).map(i => i.entry);
      for (const i of removed) {
        if (i.sub === 'Widget') { const k = refKey(i.entry); const f = fields.find(x => x.widgets.some(w => w.id === k?.replace(' ', '-') || w.id === k)); if (f) doomedFields.add(f.name); }
        else if (i.sub !== 'Redact') report.annotations++;
      }
      if (kept.length) page.node.set(N('Annots'), context.obj(kept)); else page.node.delete(N('Annots'));
    }
    // A widget the field list knows by page and rectangle (when the reference test above found none).
    for (const f of fields) for (const w of f.widgets) if (w.page === pi && w.rect && rects.some(r => overlaps(r, w.rect, 0))) doomedFields.add(f.name);
  }
  // 4. Form fields with a widget under a mark (all their widgets go).
  for (const name of doomedFields) { try { E.deleteField(doc, name); report.fields++; } catch { /* already gone with another field */ } }
  collectGarbage(doc);
  return report;
}

/**
 * The verification pass: re-read every redacted page of `doc` and count glyphs and inline images still
 * under a region. Marks' own boxes and overlay text are allowed (they are what the mark became).
 */
export function residueOf(doc, marks, overlays = true) {
  const context = doc.context;
  let residue = 0;
  const byPage = new Map();
  for (const m of marks) (byPage.get(m.page) ?? byPage.set(m.page, []).get(m.page)).push(m);
  for (const [pi, pageMarks] of byPage) {
    const page = doc.getPage(pi);
    const rects = pageMarks.flatMap(m => m.rects);
    const {bytes} = pageContent(doc, page, pi);
    let ops = parseContent(bytes);
    if (overlays) {
      // The last stream apply wrote is the overlay: cut it off before checking.
      const text = new TextDecoder('latin1').decode(bytes);
      const cut = text.lastIndexOf('%PCRedactionBoxes');
      if (cut >= 0 && text.startsWith('q\n')) ops = parseContent(bytes.subarray(0, cut));
    }
    const redactor = new Redactor({context, rects, mode: 'verify'});
    redactor.process(ops, effectiveResources(doc, page), {ctm: IDENTITY});
    residue += redactor.residue;
  }
  return residue;
}

// ── Remove hidden information ──────────────────────────────────────────────────────────────────

export const HIDDEN = Object.freeze([
  {id: 'metadata', label: 'Metadata'}, {id: 'attachments', label: 'File attachments'}, {id: 'comments', label: 'Comments and markups'},
  {id: 'form-fields', label: 'Form fields'}, {id: 'hidden-text', label: 'Hidden text'}, {id: 'hidden-layers', label: 'Hidden layers'},
  {id: 'bookmarks', label: 'Bookmarks'}, {id: 'links-actions-scripts', label: 'Links, actions and JavaScripts'}, {id: 'private-data', label: 'Private data of other applications'}]);

const listAnnots = (doc, page) => { const a = page.node.Annots?.(); return a instanceof PDFArray ? a.asArray().map(e => ({entry: e, dict: doc.context.lookup(e)})).filter(x => x.dict instanceof PDFDict) : []; };
const subOf = (context, d) => nameOf(context.lookup(d.get(N('Subtype'))));
const COMMENT_SUBTYPES = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'Redact']);

/** Names of off optional-content groups (the default configuration's /OFF). */
function offGroups(doc) {
  const ocp = doc.context.lookup(doc.catalog.get(N('OCProperties')));
  if (!(ocp instanceof PDFDict)) return new Set();
  const d = doc.context.lookup(ocp.get(N('D')));
  const off = d instanceof PDFDict ? doc.context.lookup(d.get(N('OFF'))) : null;
  return new Set(off instanceof PDFArray ? off.asArray().filter(x => x instanceof PDFRef).map(keyOfRef) : []);
}

/** What each category would remove: [{id, label, count}]. */
export function scanHidden(doc) {
  const context = doc.context;
  const out = {};
  const info = context.lookup(context.trailerInfo.Info);
  const meta = context.lookup(doc.catalog.get(N('Metadata')));
  out.metadata = (info instanceof PDFDict ? info.keys().length : 0) + (meta ? 1 : 0);
  const names = context.lookup(doc.catalog.get(N('Names')));
  const ef = names instanceof PDFDict ? context.lookup(names.get(N('EmbeddedFiles'))) : null;
  let att = ef ? 1 : 0;
  let comments = 0;
  let links = 0;
  const pages = doc.getPages();
  for (const p of pages) for (const {dict} of listAnnots(doc, p)) {
    const s = subOf(context, dict);
    if (s === 'FileAttachment') att++;
    else if (COMMENT_SUBTYPES.has(s) && s !== 'Popup') comments++;
    else if (s === 'Link') links++;
  }
  out.attachments = att;
  out.comments = comments;
  out['form-fields'] = readFields(doc).length;
  let hidden = 0;
  for (let i = 0; i < pages.length; i++) {
    try {
      const {bytes} = pageContent(doc, pages[i], i);
      const box = pages[i].getCropBox();
      const r = new Redactor({context, rects: [], hiddenText: [box.x, box.y, box.x + box.width, box.y + box.height]});
      r.process(parseContent(bytes), effectiveResources(doc, pages[i]), {ctm: IDENTITY});
      hidden += r.report.hiddenText;
    } catch { /* unreadable pages are counted as nothing here: removal refuses them */ }
  }
  out['hidden-text'] = hidden;
  out['hidden-layers'] = offGroups(doc).size;
  out.bookmarks = context.lookup(doc.catalog.get(N('Outlines'))) ? 1 : 0;
  out['links-actions-scripts'] = links + (doc.catalog.has(N('OpenAction')) ? 1 : 0) + (doc.catalog.has(N('AA')) ? 1 : 0) + (names instanceof PDFDict && names.has(N('JavaScript')) ? 1 : 0);
  let priv = doc.catalog.has(N('PieceInfo')) ? 1 : 0;
  for (const p of pages) if (p.node.has(N('PieceInfo'))) priv++;
  out['private-data'] = priv;
  return HIDDEN.map(h => ({id: h.id, label: h.label, count: out[h.id] ?? 0}));
}

/**
 * Remove the chosen categories from `doc`, in place. Form fields are flattened (their appearance stays as
 * page content); hidden text and hidden layers are cut out of the page content.
 * @returns {{removed: Record<string, number>}}
 */
export function removeHidden(doc, ids) {
  const context = doc.context;
  const want = new Set(ids);
  const removed = {};
  const count = (k, n = 1) => { removed[k] = (removed[k] ?? 0) + n; };
  const pages = doc.getPages();
  if (want.has('form-fields')) {
    const n = readFields(doc).length;
    if (n) { E.flattenFields(doc); for (const f of readFields(doc)) { try { E.deleteField(doc, f.name); } catch { /* gone */ } } count('form-fields', n); }
  }
  if (want.has('hidden-text') || want.has('hidden-layers')) {
    const off = want.has('hidden-layers') ? offGroups(doc) : new Set();
    pages.forEach((page, pi) => {
      const box = page.getCropBox();
      const {bytes} = pageContent(doc, page, pi);
      const redactor = new Redactor({context, rects: [], hiddenText: want.has('hidden-text') ? [box.x, box.y, box.x + box.width, box.y + box.height] : null});
      let ops = parseContent(bytes);
      if (off.size) ops = stripOffLayers(context, ops, effectiveResources(doc, page), off, n => count('hidden-layers', n));
      const result = redactor.process(ops, effectiveResources(doc, page), {ctm: IDENTITY});
      if (redactor.report.hiddenText) count('hidden-text', redactor.report.hiddenText);
      const res = redactor.cloneResources(effectiveResources(doc, page), result);
      page.node.set(N('Resources'), res);
      page.node.set(N('Contents'), context.register(context.flateStream(serializeContent(result.ops))));
    });
    if (want.has('hidden-layers') && off.size) { doc.catalog.delete(N('OCProperties')); }
  }
  if (want.has('comments') || want.has('attachments') || want.has('links-actions-scripts')) {
    for (const page of pages) {
      const annots = page.node.Annots?.();
      if (!(annots instanceof PDFArray)) continue;
      const gone = new Set();
      for (const {entry, dict} of listAnnots(doc, page)) {
        const s = subOf(context, dict);
        if ((want.has('comments') && COMMENT_SUBTYPES.has(s) && s !== 'Redact') || (want.has('attachments') && s === 'FileAttachment') || (want.has('links-actions-scripts') && s === 'Link')) { gone.add(entry); count(s === 'FileAttachment' ? 'attachments' : s === 'Link' ? 'links-actions-scripts' : 'comments'); }
      }
      const kept = annots.asArray().filter(e => !gone.has(e));
      if (kept.length) page.node.set(N('Annots'), context.obj(kept)); else page.node.delete(N('Annots'));
    }
  }
  if (want.has('metadata')) {
    const info = context.lookup(context.trailerInfo.Info);
    if (info instanceof PDFDict) { count('metadata', info.keys().length); context.trailerInfo.Info = context.register(context.obj({})); }
    if (doc.catalog.has(N('Metadata'))) { doc.catalog.delete(N('Metadata')); count('metadata'); }
    for (const p of pages) p.node.delete(N('Metadata'));
  }
  if (want.has('attachments')) {
    const names = context.lookup(doc.catalog.get(N('Names')));
    if (names instanceof PDFDict && names.has(N('EmbeddedFiles'))) { names.delete(N('EmbeddedFiles')); count('attachments'); }
    if (doc.catalog.has(N('AF'))) doc.catalog.delete(N('AF'));
  }
  if (want.has('bookmarks') && doc.catalog.has(N('Outlines'))) { doc.catalog.delete(N('Outlines')); count('bookmarks'); }
  if (want.has('links-actions-scripts')) {
    for (const k of ['OpenAction', 'AA']) if (doc.catalog.has(N(k))) { doc.catalog.delete(N(k)); count('links-actions-scripts'); }
    const names = context.lookup(doc.catalog.get(N('Names')));
    if (names instanceof PDFDict && names.has(N('JavaScript'))) { names.delete(N('JavaScript')); count('links-actions-scripts'); }
    for (const p of pages) p.node.delete(N('AA'));
  }
  if (want.has('private-data')) {
    if (doc.catalog.has(N('PieceInfo'))) { doc.catalog.delete(N('PieceInfo')); count('private-data'); }
    for (const p of pages) if (p.node.has(N('PieceInfo'))) { p.node.delete(N('PieceInfo')); count('private-data'); }
  }
  collectGarbage(doc);
  return {removed};
}

/** Cut marked-content blocks of optional content groups that are off. */
function stripOffLayers(context, ops, resources, off, counted) {
  const props = resources ? context.lookup(resources.get(N('Properties'))) : null;
  const isOff = op => {
    if (op.op !== 'BDC' || op.args[0]?.k !== 'name' || op.args[0].v !== 'OC' || op.args[1]?.k !== 'name' || !(props instanceof PDFDict)) return false;
    const ref = props.get(N(op.args[1].v));
    return ref instanceof PDFRef && off.has(keyOfRef(ref));
  };
  const out = [];
  let skipDepth = 0;
  let depth = 0;
  for (const op of ops) {
    if (skipDepth) {
      if (op.op === 'BDC' || op.op === 'BMC') depth++;
      else if (op.op === 'EMC') { depth--; if (depth === 0) { skipDepth = 0; } }
      continue;
    }
    if (isOff(op)) { skipDepth = 1; depth = 1; counted(1); continue; }
    out.push(op);
  }
  return out;
}

export {PDFHexString, PDFString, PDFBool};
