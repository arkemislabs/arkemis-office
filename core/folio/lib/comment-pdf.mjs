// Comment work that needs the PDF itself: new objects a comment points at (an attached file, a
// stamp's or signature's picture), Flatten comments, Summarize comments, and comment data files
// (XFDF export and import).
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/flatten.rs            placement (Algorithm 8.1), upright, selected, xobject_name,
//                                         flatten_in (appearances drawn into the page, comments removed)
//   crates/engine/src/comments.rs         SummarySort, comment_type_name, comment_kind, comment_summary
//   crates/engine/src/session/view.rs     summarize_comments (the summary as a new PDF of text pages)
//   crates/xfdf/src/xfdf.rs, common.rs    export_xfdf/xfdf_annots, import_xfdf/annot_from_xml/place,
//                                         SUBTYPES, FLAGS, esc, n, hex, parse_hex
//   crates/annot/src/create.rs            Shape::Attachment (/FS with an embedded file),
//                                         Shape::CustomStamp (/PCPicture)
//
// New objects are appended to the document's source as an incremental update
// (lib/sign-pdf.mjs writeIncremental), so the bytes a signature covers never change and the
// records' object references stay valid. No DOM, no Node built-ins.

import {PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFStream, StandardFonts, PDFDocument, rgb} from 'pdf-lib';
import {textFace, wrapLines} from './unicode-text.mjs';
import {pdfBytes} from '../../pdf-model.mjs';
import {writeIncremental, loadPdf} from './sign-pdf.mjs';
import {base64} from './page-source.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {textOf, nums, nameAt, isDict, text as pdfText} from './cos.mjs';
import {summaries} from '../model/annots.mjs';
import {parsePdfDate} from './dates.mjs';
import {FLAG} from '../model/types.mjs';
import {isCommentSubtype} from '../model/types.mjs';

const N = k => PDFName.of(k);
const keyOf = r => `${r.objectNumber} ${r.generationNumber}`;

// ── new objects in the source ──────────────────────────────────────────────────────────────

/**
 * Append objects made by `make(doc)` to the content's source: `make` registers them in the
 * pdf-lib document and returns what the caller needs (refs as {$ref}). Returns {sourceBase64, made}.
 */
export async function appendToSource(content, make) {
  const source = pdfBytes(content.sourceBase64);
  const doc = await loadPdf(source);
  const base = doc.context.largestObjectNumber;
  const made = await make(doc);
  const changed = new Set();
  for (const [r] of doc.context.enumerateIndirectObjects()) if (r.objectNumber > base) changed.add(keyOf(r));
  if (!changed.size) return {sourceBase64: content.sourceBase64, made};
  return {sourceBase64: base64(writeIncremental(source, doc, changed)), made};
}

export const jsonRef = ref => ({$ref: [ref.objectNumber, ref.generationNumber]});
const isPng = b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = b => b[0] === 0xff && b[1] === 0xd8;

/** An embedded PNG or JPEG: {ref, width, height}. signature_image.rs accepts PNG or JPEG up to 4 MiB. */
export async function embedPicture(doc, bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new CommandError('invalid_params', 'the image is empty');
  if (bytes.length > 4 << 20) throw new CommandError('too_large', 'Choose a PNG or JPEG image of up to 4 MB');
  let img;
  try {
    if (isPng(bytes)) img = await doc.embedPng(bytes);
    else if (isJpeg(bytes)) img = await doc.embedJpg(bytes);
    else throw new CommandError('invalid_params', 'Choose a PNG or JPEG image');
    await img.embed();
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError('invalid_params', `The image can't be read: ${e.message}`);
  }
  return {ref: img.ref, width: img.width, height: img.height};
}

/** An embedded file stream (ISO 32000-2 §7.11.4) for a FileAttachment comment: {ref}. */
export function embedFile(doc, bytes, {name, mime, date}) {
  const ctx = doc.context;
  const params = {Size: bytes.length};
  if (date) params.ModDate = date;
  const stream = ctx.flateStream(bytes, {Type: 'EmbeddedFile', Params: params});
  if (mime) stream.dict.set(N('Subtype'), N(mime.replace(/\//g, '#2F')));
  return {ref: ctx.register(stream), name};
}

/** The /FS file specification of an attached file, in the JSON form. */
export const fileSpec = (name, ref, description) => {
  const fs = {Type: '/Filespec', F: pdfText(name), UF: pdfText(name), EF: {F: jsonRef(ref)}};
  if (description) fs.Desc = pdfText(description);
  return fs;
};

// ── flatten.rs ─────────────────────────────────────────────────────────────────────────────

const numsOf = (ctx, o) => { const v = o instanceof PDFRef ? ctx.lookup(o) : o; return v instanceof PDFArray ? v.asArray().map(x => (x instanceof PDFRef ? ctx.lookup(x) : x)).filter(x => x instanceof PDFNumber).map(x => x.asNumber()) : null; };
const fmt = v => { const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; };

/** flatten.rs `placement` (Algorithm 8.1). */
export function placement(bbox, matrix, rect) {
  if (!bbox || bbox.length !== 4) return null;
  const m = matrix && matrix.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
  const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
  const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) return null;
  const sx = (rect[2] - rect[0]) / (x1 - x0), sy = (rect[3] - rect[1]) / (y1 - y0);
  return [sx, 0, 0, sy, rect[0] - x0 * sx, rect[1] - y0 * sy];
}

/** flatten.rs `upright`: `m` followed by a turn of the page's /Rotate about the rect's upper-left corner. */
export function upright(m, degrees, rect) {
  const deg = ((degrees % 360) + 360) % 360;
  const sc = {90: [1, 0], 180: [0, -1], 270: [-1, 0]}[deg];
  if (!sc) return m;
  const [sin, cos] = sc;
  const [px, py] = [rect[0], rect[3]];
  const t = [cos, sin, -sin, cos, px - px * cos + py * sin, py - px * sin - py * cos];
  return [m[0] * t[0] + m[1] * t[2], m[0] * t[1] + m[1] * t[3], m[2] * t[0] + m[3] * t[2], m[2] * t[1] + m[3] * t[3],
    m[4] * t[0] + m[5] * t[2] + t[4], m[4] * t[1] + m[5] * t[3] + t[5]];
}

/**
 * flatten.rs `flatten_in` for comments (Which::Comments{comments: true}) or Fill & Sign items
 * (Which::FillSign) on the pages at `indices` of a pdf-lib document whose page i is model page i
 * (page-source.mjs `materialize`). Appearances are drawn into the page content and the
 * annotations removed (their pop-ups and replies with them). Returns the removed object keys.
 */
export function flattenPages(doc, indices, which = 'comments') {
  const ctx = doc.context;
  const pages = doc.getPages();
  const removed = new Set();
  let drawn = 0;
  for (const i of indices) {
    const page = pages[i];
    const node = page.node;
    const raw = node.get(N('Annots'));
    const list = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
    if (!(list instanceof PDFArray)) continue;
    const rotation = page.getRotation().angle;
    const res = node.Resources() ?? ctx.obj({});
    const xoRaw = res.get(N('XObject'));
    const xobjects = xoRaw instanceof PDFRef ? ctx.lookup(xoRaw) : xoRaw instanceof PDFDict ? xoRaw : ctx.obj({});
    let k = 0;
    const nextName = () => { let name; do { name = `PCFl${k++}`; } while (xobjects.get(N(name))); return name; };
    let content = '';
    const gone = new Set();
    for (const entry of list.asArray()) {
      const d = entry instanceof PDFRef ? ctx.lookup(entry) : entry;
      if (!(d instanceof PDFDict)) continue;
      const sub = d.get(N('Subtype'))?.decodeText?.() ?? '';
      const selected = which === 'fillsign' ? !['Link', 'Popup', 'Widget'].includes(sub) && d.get(N('PCFillSign')) !== undefined && String(d.get(N('PCFillSign'))) === 'true'
        : sub !== 'Widget' && isCommentSubtype(sub) && sub !== 'Popup';
      if (!selected) continue;
      const flagsObj = d.get(N('F'));
      const flags = flagsObj instanceof PDFNumber ? flagsObj.asNumber() : 0;
      if (flags & (FLAG.HIDDEN | FLAG.NO_VIEW)) continue;
      const rect = numsOf(ctx, d.get(N('Rect')));
      const ap = d.get(N('AP'));
      const apd = ap instanceof PDFRef ? ctx.lookup(ap) : ap;
      const n = apd instanceof PDFDict ? apd.get(N('N')) : null;
      const isReplyText = sub === 'Text' && d.get(N('IRT')) && String(d.get(N('RT')) ?? '') !== '/Group';
      if (n instanceof PDFRef && rect && rect.length === 4) {
        const form = ctx.lookup(n);
        const fd = form instanceof PDFStream ? form.dict : null;
        const r = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
        let m = fd ? placement(numsOf(ctx, fd.get(N('BBox'))), numsOf(ctx, fd.get(N('Matrix'))), r) : null;
        if (m) {
          if (flags & FLAG.NO_ROTATE) m = upright(m, rotation, r);
          const name = nextName();
          content += `q ${m.map(fmt).join(' ')} cm /${name} Do Q\n`;
          xobjects.set(N(name), n);
          drawn++;
        }
        if (entry instanceof PDFRef) gone.add(keyOf(entry));
      } else if (isReplyText || (n === null && sub === 'Text' && d.get(N('IRT')))) {
        // Replies and status changes have nothing to draw; they go with their parent below.
      }
    }
    // Pop-ups and replies of what was flattened go too.
    let more = true;
    while (more) {
      more = false;
      for (const entry of list.asArray()) {
        if (!(entry instanceof PDFRef) || gone.has(keyOf(entry))) continue;
        const d = ctx.lookup(entry);
        if (!(d instanceof PDFDict)) continue;
        const parent = d.get(N('Parent')) ?? d.get(N('IRT'));
        if (parent instanceof PDFRef && gone.has(keyOf(parent))) { gone.add(keyOf(entry)); more = true; }
      }
    }
    if (!gone.size) continue;
    const kept = list.asArray().filter(e => !(e instanceof PDFRef && gone.has(keyOf(e))));
    if (kept.length) node.set(N('Annots'), ctx.obj(kept)); else node.delete(N('Annots'));
    for (const g of gone) removed.add(g);
    if (content) {
      res.set(N('XObject'), xobjects);
      node.set(N('Resources'), res);
      const before = ctx.register(ctx.stream('q\n'));
      const after = ctx.register(ctx.flateStream(`Q\n${content}`));
      const contents = node.get(N('Contents'));
      const existing = contents instanceof PDFRef && ctx.lookup(contents) instanceof PDFArray ? ctx.lookup(contents).asArray()
        : contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
      node.set(N('Contents'), ctx.obj([before, ...existing, after]));
    }
  }
  return {removed, drawn};
}

// ── comments.rs: Summarize comments ────────────────────────────────────────────────────────

export const SUMMARY_SORTS = Object.freeze(['Page', 'Author', 'Date', 'Type']);

/** comments.rs `comment_type_name`. */
export function commentTypeName(subtype) {
  return {Text: 'Sticky Note', FreeText: 'Text Box', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly',
    Square: 'Rectangle', Circle: 'Oval', Line: 'Line', Ink: 'Pencil', Polygon: 'Polygon', PolyLine: 'Polygonal Line', Stamp: 'Stamp',
    Caret: 'Inserted Text', FileAttachment: 'File Attachment', Sound: 'Sound', Redact: 'Redaction'}[subtype] ?? subtype;
}

/** comments.rs `comment_kind`: callouts, clouds and typewriter text told apart by /IT. */
export function commentKind(a) {
  return {FreeTextCallout: 'Callout', PolygonCloud: 'Cloud', FreeTextTypeWriter: 'Typewriter'}[a.intent] ?? commentTypeName(a.subtype);
}

/** render's `pretty_date`: a PDF date as "YYYY-MM-DD HH:MM" (local to the date's own offset). */
export function prettyDate(pdf) {
  if (!pdf) return null;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(pdf));
  if (!m) return pdf;
  const [, y, mo = '01', d = '01', h = '00', mi = '00'] = m;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** render's `Annotation::is_comment`: listed comments (not replies, pop-ups or status changes). */
const isTopComment = a => !a.inReplyTo && !a.state && a.subtype !== 'Popup' && !a.hidden;

/**
 * comments.rs `comment_summary`: one block per comment (replies indented under it), "Page N"
 * headings when sorted by page; check marks and status replies left out.
 */
export function commentSummary(name, content, sort = 'Page') {
  const all = summaries(content).map(a => ({...a, modified: prettyDate(a.modified)}));
  const top = all.filter(isTopComment);
  const children = new Map();
  for (const r of all) if (!r.state && r.inReplyTo) { const k = r.inReplyTo; if (!children.has(k)) children.set(k, []); children.get(k).push(r); }
  const lines = [];
  const writeReplies = (parent, depth) => {
    if (depth > 64) return;
    for (const r of children.get(parent.id) ?? []) {
      if (r.grouped) continue;
      const indent = '    '.repeat(depth + 1);
      lines.push(`${indent}Author: ${r.author ?? ''}  Subject: Reply  Date: ${r.modified ?? ''}`);
      for (const line of (r.contents ?? '').split('\n')) if (r.contents) lines.push(`${indent}${line}`);
      writeReplies(r, depth + 1);
    }
  };
  let numbered = [];
  let last = -1, n = 0;
  for (const a of top) { if (a.page !== last) { last = a.page; n = 0; } n++; numbered.push([n, a]); }
  const cmp = (x, y) => (x == null ? (y == null ? 0 : -1) : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0);
  if (sort === 'Author') numbered = numbered.map((e, i) => [...e, i]).sort((x, y) => cmp(x[1].author, y[1].author) || x[2] - y[2]).map(e => [e[0], e[1]]);
  else if (sort === 'Date') numbered = numbered.map((e, i) => [...e, i]).sort((x, y) => cmp(x[1].modified, y[1].modified) || x[2] - y[2]).map(e => [e[0], e[1]]);
  else if (sort === 'Type') numbered = numbered.map((e, i) => [...e, i]).sort((x, y) => cmp(commentKind(x[1]), commentKind(y[1])) || x[2] - y[2]).map(e => [e[0], e[1]]);
  let out = `Summary of Comments on ${name}\n\n`;
  if (!numbered.length) return out + 'This document has no comments.\n';
  let heading = -1;
  for (const [num, a] of numbered) {
    if (sort === 'Page' && a.page !== heading) { heading = a.page; lines.push(`Page: ${a.page + 1}`); }
    lines.push(`Number: ${num}  Author: ${a.author ?? ''}  Subject: ${commentKind(a)}${sort !== 'Page' ? `  Page: ${a.page + 1}` : ''}  Date: ${a.modified ?? ''}`);
    if (a.contents) lines.push(a.contents);
    writeReplies(a, 0);
    lines.push('');
  }
  return out + lines.join('\n') + '\n';
}

/** session/view.rs `summarize_comments`: the summary text on Letter pages in Helvetica 10 pt. */
export async function summaryPdf(textBody, title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('Arkemis PDF');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10, lead = 13, margin = 54, W = 612, H = 792;
  const maxW = W - 2 * margin;
  // The comments are the person's own words: a script the standard face lacks is set in a system font embedded for it.
  const face = await textFace(doc, font, [textBody]);
  const safe = s => (face.unicode ? s : Array.from(s).map(ch => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join(''));
  const wrapped = [];
  for (const raw of textBody.replace(/\t/g, '    ').split('\n')) {
    const lead0 = /^ */.exec(raw)[0];
    let line = '';
    const words = safe(raw.trim()).split(/(\s+)/);
    if (!raw.trim()) { wrapped.push(''); continue; }
    for (const w of words) {
      const next = line + w;
      if (face.width(lead0 + next, size) > maxW && line.trim()) { wrapped.push(lead0 + line.trimEnd()); line = w.trimStart(); } else line = next;
    }
    wrapped.push(lead0 + line.trimEnd());
  }
  let page = null, y = 0;
  // CJK has no spaces to break at: a line still too wide breaks between characters.
  const finished = face.unicode ? wrapped.flatMap(l => (face.width(l, size) > maxW ? wrapLines(l, maxW, s => face.width(s, size)) : [l])) : wrapped;
  for (const l of finished) {
    if (!page || y < margin) { page = doc.addPage([W, H]); y = H - margin; }
    if (l) face.draw(page, l, {x: margin, y: y - size, size, color: rgb(0, 0, 0)});
    y -= lead;
  }
  if (!page) doc.addPage([W, H]);
  return doc.save();
}

// ── xfdf.rs ────────────────────────────────────────────────────────────────────────────────

export const XFDF_SUBTYPES = Object.freeze([['Text', 'text'], ['FreeText', 'freetext'], ['Line', 'line'], ['Square', 'square'], ['Circle', 'circle'],
  ['Polygon', 'polygon'], ['PolyLine', 'polyline'], ['Highlight', 'highlight'], ['Underline', 'underline'], ['Squiggly', 'squiggly'],
  ['StrikeOut', 'strikeout'], ['Stamp', 'stamp'], ['Caret', 'caret'], ['Ink', 'ink'], ['FileAttachment', 'fileattachment'], ['Sound', 'sound'], ['Redact', 'redact']]);
const XFDF_FLAGS = [[1, 'invisible'], [2, 'hidden'], [4, 'print'], [8, 'nozoom'], [16, 'norotate'], [32, 'noview'], [64, 'readonly'], [128, 'locked'], [256, 'togglenoview']];

/** common.rs `esc`. */
export function esc(s) {
  let o = '';
  for (const c of String(s)) {
    const code = c.codePointAt(0);
    if (c === '&') o += '&amp;'; else if (c === '<') o += '&lt;'; else if (c === '>') o += '&gt;'; else if (c === '"') o += '&quot;';
    else if (c === '\t') o += '&#9;'; else if (c === '\n') o += '&#10;'; else if (c === '\r') o += '&#13;';
    else if (code < 0x20 || c === '￾' || c === '￿') continue; else o += c;
  }
  return o;
}
/** common.rs `n`. */
export const xn = v => { let s = Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; };
/** common.rs `hex`. */
export function hexColor(c) {
  if (!Array.isArray(c)) return null;
  const v = c.length === 1 ? [c[0], c[0], c[0]] : c.length === 3 ? c : c.length === 4 ? [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])] : null;
  return v ? `#${v.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0').toUpperCase()).join('')}` : null;
}
/** common.rs `parse_hex`. */
export function parseHex(s) {
  const h = String(s).trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(h) ? [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) : null;
}
const csv = s => String(s).split(',').map(x => Number(x.trim())).filter(Number.isFinite);
const val = v => textOf(v) ?? (typeof v === 'string' && v.startsWith('/') ? v.slice(1) : null);

/** xfdf.rs `export_xfdf` (comments only: Comments ▸ Export all to data file). */
export function exportXfdf(content, file) {
  const names = new Map();
  for (const page of content.pages ?? []) for (const r of page.annots ?? []) names.set(r.id, textOf(r.dict.NM) ?? r.id);
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<annots>\n';
  (content.pages ?? []).forEach((page, pi) => {
    for (const r of page.annots ?? []) {
      const d = r.dict, sub = nameAt(d, 'Subtype');
      const tag = XFDF_SUBTYPES.find(([s]) => s === sub)?.[1];
      if (!tag) continue;
      let a = ` page="${pi}"`;
      const rect = nums(d, 'Rect');
      if (rect?.length === 4) a += ` rect="${xn(Math.min(rect[0], rect[2]))},${xn(Math.min(rect[1], rect[3]))},${xn(Math.max(rect[0], rect[2]))},${xn(Math.max(rect[1], rect[3]))}"`;
      const nm = textOf(d.NM) ?? r.id;
      for (const [key, attr] of [['NM', 'name'], ['T', 'title'], ['Subj', 'subject'], ['M', 'date'], ['CreationDate', 'creationdate'], ['RT', 'replyType'], ['State', 'state'], ['StateModel', 'statemodel'], ['Name', 'icon']]) {
        const v = key === 'NM' ? nm : val(d[key]);
        if (v != null && v !== '') a += ` ${attr}="${esc(v)}"`;
      }
      const flags = Number.isInteger(d.F) ? d.F : 0;
      a += ` flags="${XFDF_FLAGS.filter(([b]) => flags & b).map(([, s]) => s).join(',')}"`;
      const c = hexColor(d.C); if (c) a += ` color="${c}"`;
      const ic = hexColor(d.IC); if (ic) a += ` interior-color="${ic}"`;
      if (typeof d.CA === 'number') a += ` opacity="${xn(d.CA)}"`;
      if (isDict(d.BS) && typeof d.BS.W === 'number') a += ` width="${xn(d.BS.W)}"`;
      const quads = nums(d, 'QuadPoints'); if (quads?.length) a += ` coords="${quads.map(xn).join(',')}"`;
      const l = nums(d, 'L'); if (l?.length === 4) a += ` start="${xn(l[0])},${xn(l[1])}" end="${xn(l[2])},${xn(l[3])}"`;
      if (Array.isArray(d.LE) && d.LE.length === 2) a += ` head="${esc(String(d.LE[0]).replace(/^\//, ''))}" tail="${esc(String(d.LE[1]).replace(/^\//, ''))}"`;
      const cl = nums(d, 'CL');
      if (cl && (cl.length === 4 || cl.length === 6)) {
        a += ` callout="${cl.map(xn).join(',')}"`;
        const rd = nums(d, 'RD'); if (rd?.length === 4) a += ` fringe="${rd.map(xn).join(',')}"`;
        const it = nameAt(d, 'IT'); if (it) a += ` intent="${esc(it)}"`;
        if (typeof d.LE === 'string') a += ` head="${esc(d.LE.replace(/^\//, ''))}"`;
      }
      if (r.irt && names.has(r.irt)) a += ` inreplyto="${esc(names.get(r.irt))}"`;
      out += `<${tag}${a}>`;
      const contents = textOf(d.Contents); if (contents != null && contents !== '') out += `<contents>${esc(contents)}</contents>`;
      const da = textOf(d.DA); if (da) out += `<defaultappearance>${esc(da)}</defaultappearance>`;
      if (Array.isArray(d.InkList) && d.InkList.length) {
        out += '<inklist>';
        for (const g of d.InkList) { const pts = []; for (let i = 0; i + 1 < g.length; i += 2) pts.push(`${xn(g[i])},${xn(g[i + 1])}`); out += `<gesture>${pts.join(';')}</gesture>`; }
        out += '</inklist>';
      }
      const v = nums(d, 'Vertices');
      if (v?.length) { const pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push(`${xn(v[i])},${xn(v[i + 1])}`); out += `<vertices>${pts.join(';')}</vertices>`; }
      if (r.popup?.Rect) { const pr = r.popup.Rect; out += `<popup page="${pi}" rect="${pr.map(xn).join(',')}" open="${r.popup.Open ? 'yes' : 'no'}"/>`; }
      out += `</${tag}>\n`;
    }
  });
  out += '</annots>\n';
  out += `<f href="${esc(file)}"/>\n</xfdf>\n`;
  return out;
}

/** A small XML reader (elements, attributes, text, the five entities and character references). */
export function parseXml(src) {
  const s = String(src).replace(/^﻿/, '');
  const decodeEnt = t => t.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[e]));
  const root = {name: '#root', attrs: {}, children: [], text: ''};
  const stack = [root];
  let i = 0, depth = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const textPart = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (textPart) stack[stack.length - 1].text += decodeEnt(textPart);
    if (lt < 0) break;
    // An unterminated construct is malformed input: indexOf is -1 there, and carrying on from -1 + 2 would
    // send the scan back to the start of the file forever.
    const close = (end, skip, what) => { const e = s.indexOf(end, lt + skip); if (e < 0) throw new CommandError('invalid_params', `the file can't be read: ${what} is not closed`); return e; };
    if (s.startsWith('<?', lt)) { i = close('?>', 2, 'a processing instruction') + 2; continue; }
    if (s.startsWith('<!--', lt)) { i = close('-->', 4, 'a comment') + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = close(']]>', 9, 'a CDATA section'); stack[stack.length - 1].text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s.startsWith('<!', lt)) { i = close('>', 2, 'a declaration') + 1; continue; }
    const gt = s.indexOf('>', lt);
    if (gt < 0) throw new CommandError('invalid_params', "the file can't be read: an element is not closed");
    const body = s.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) { if (stack.length > 1) stack.pop(); depth--; continue; }
    const selfClose = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const el = {name: m[1].replace(/^.*:/, ''), attrs: {}, children: [], text: ''};
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(body.slice(m[1].length)))) el.attrs[a[1]] = decodeEnt(a[3] ?? a[4] ?? '');
    stack[stack.length - 1].children.push(el);
    if (!selfClose) { stack.push(el); if (++depth > 64) throw new CommandError('invalid_params', "the file can't be read: it nests too deep"); }
  }
  return root;
}

/** xfdf.rs `annot_from_xml`: the annotation dictionary (JSON form) an XFDF element stands for. */
export function annotFromXml(node, subtype) {
  const rect = csv(node.attrs.rect ?? '');
  if (rect.length !== 4) return null;
  const d = {Type: '/Annot', Subtype: `/${subtype}`, Rect: rect};
  for (const [attr, key] of [['name', 'NM'], ['title', 'T'], ['subject', 'Subj'], ['date', 'M'], ['creationdate', 'CreationDate'], ['state', 'State'], ['statemodel', 'StateModel']]) {
    if (node.attrs[attr] != null) d[key] = pdfText(node.attrs[attr]);
  }
  if (node.attrs.replyType != null) d.RT = /^group$/i.test(node.attrs.replyType) ? '/Group' : '/R';
  if (node.attrs.icon != null) d.Name = `/${node.attrs.icon}`;
  d.F = (node.attrs.flags ?? 'print').split(',').map(f => XFDF_FLAGS.find(([, s]) => s === f.trim().toLowerCase())?.[0] ?? 0).reduce((x, y) => x | y, 0);
  const c = node.attrs.color && parseHex(node.attrs.color); if (c) d.C = c;
  const ic = node.attrs['interior-color'] && parseHex(node.attrs['interior-color']); if (ic) d.IC = ic;
  const o = Number(node.attrs.opacity); if (node.attrs.opacity != null && Number.isFinite(o)) d.CA = Math.min(1, Math.max(0, o));
  const w = Number(node.attrs.width); if (node.attrs.width != null && Number.isFinite(w)) d.BS = {W: Math.max(0, w), S: '/S'};
  if (node.attrs.coords) d.QuadPoints = csv(node.attrs.coords);
  if (node.attrs.start && node.attrs.end) { const s0 = csv(node.attrs.start), e0 = csv(node.attrs.end); if (s0.length === 2 && e0.length === 2) d.L = [...s0, ...e0]; }
  if (node.attrs.head != null || node.attrs.tail != null) d.LE = [`/${node.attrs.head ?? 'None'}`, `/${node.attrs.tail ?? 'None'}`];
  const cl = node.attrs.callout ? csv(node.attrs.callout) : null;
  if (cl && (cl.length === 4 || cl.length === 6)) {
    d.CL = cl;
    const rd = node.attrs.fringe ? csv(node.attrs.fringe) : null; if (rd?.length === 4) d.RD = rd;
    d.IT = `/${node.attrs.intent ?? 'FreeTextCallout'}`;
    if (node.attrs.head != null) d.LE = `/${node.attrs.head}`; else delete d.LE;
  }
  for (const ch of node.children) {
    if (ch.name === 'contents') d.Contents = pdfText(ch.text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
    else if (ch.name === 'defaultappearance') d.DA = pdfText(ch.text);
    else if (ch.name === 'inklist') d.InkList = ch.children.filter(g => g.name === 'gesture').map(g => g.text.split(';').flatMap(p => csv(p)));
    else if (ch.name === 'vertices') { const v = csv(ch.text.replace(/;/g, ',')); v.length -= v.length % 2; if (v.length) d.Vertices = v; }
  }
  return d;
}

/**
 * xfdf.rs `import_xfdf` (comments): {records: [{page, dict, nm, inReplyTo, popup}]} in file order.
 * Throws when the text is not XFDF.
 */
export function readXfdf(text) {
  const root = parseXml(text);
  const x = root.children.find(c => c.name === 'xfdf');
  if (!x) throw new CommandError('invalid_params', "this file isn't XFDF");
  const annots = x.children.find(c => c.name === 'annots');
  const out = [];
  for (const node of annots?.children ?? []) {
    const sub = XFDF_SUBTYPES.find(([, t]) => t === node.name.toLowerCase())?.[0];
    if (!sub) continue;
    const page = Number(node.attrs.page);
    if (!Number.isInteger(page) || page < 0) continue;
    const dict = annotFromXml(node, sub);
    if (!dict) continue;
    const pop = node.children.find(c => c.name === 'popup');
    const pr = pop?.attrs.rect ? csv(pop.attrs.rect) : null;
    out.push({page, dict, nm: node.attrs.name ?? null, inReplyTo: node.attrs.inreplyto ?? null,
      popup: pr?.length === 4 ? {Rect: pr, Open: pop.attrs.open === 'yes'} : null});
  }
  return out;
}

export {parsePdfDate, FLAG};
