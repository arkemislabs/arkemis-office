// Putting content on a page's /Contents: marks behind or on top, the q/Q wrapper that keeps the
// original content's graphics state away from what is drawn on top, and the content lexer that
// tells whether the original content leaves state set (`isolation`).
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/edit/src/place.rs — page_list, check, contents, add_resources, page_fonts,
//    free_font_name, add_page_resources, WRAP_OPEN / WRAP_CLOSE / OLD_WRAP_CLOSE, is_wrap_close,
//    wrapper_role, stream_tag, tagged, isolation (Clean / Unknown / TooDeep), place, place_tagged,
//    check_on_top, place_inside_wrapper, stamp, begin, END, undrawable, text_op;
//  * crates/content/src/lib.rs — Pieces::join (pieces joined with one space), parse (operators with
//    their spans, skipped bytes), comment_edges, pieces_of.
// pdfcraft's COS document is pdf-lib's here (PDFDocument, PDFDict, PDFRawStream); streams the mark
// adds are Flate-compressed like upstream's Stream::flate. No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFNumber, decodePDFRawStream} from 'pdf-lib';
import {CommandError} from '../../kernel/errors.mjs';
import {viewMatrixFor} from './geom.mjs';
import {winAnsiBytes, literal, n} from './fonts.mjs';

const N = s => PDFName.of(s);
export const bin = s => { const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; };
export const str = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };

// ---------------------------------------------------------------------------------------------
// Pages (pdfcraft_model::Page facts the edit crate uses)

/** The pdf-lib page list (place.rs page_list). */
export const pageList = doc => doc.getPages();

/** place.rs `check`: every index is a page ("page N does not exist", 1-based). */
export function check(pages, count) {
  const bad = pages.find(p => !Number.isInteger(p) || p < 0 || p >= count);
  if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
}

const rect = b => [b.x, b.y, b.x + b.width, b.y + b.height];
/** Page::crop (the crop box inside the media box). */
export function cropOf(page) {
  const m = rect(page.getMediaBox()), c = rect(page.getCropBox());
  const lo = (a, b) => [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
  const mm = lo(m), cc = lo(c);
  const r = [Math.max(mm[0], cc[0]), Math.max(mm[1], cc[1]), Math.min(mm[2], cc[2]), Math.min(mm[3], cc[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : mm;
}
/** Page::user_unit (1 unless /UserUnit ≥ 1). */
export function userUnit(page) {
  const u = page.node.lookup(N('UserUnit'));
  const v = u instanceof PDFNumber ? u.asNumber() : 1;
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 75000) : 1;
}
/** Page::rotation: `extra` is the model's own turn on top of the file's /Rotate (pdf-write writes their sum). */
export const rotationOf = (page, extra = 0) => ((((page.getRotation().angle + extra) % 360) + 360) % 360);
/** Page::display_size: after /UserUnit and /Rotate. */
export function displaySize(page, extra = 0) {
  const c = cropOf(page), u = userUnit(page);
  const w = (c[2] - c[0]) * u, h = (c[3] - c[1]) * u;
  return rotationOf(page, extra) % 180 === 0 ? [w, h] : [h, w];
}
/** Page::view_matrix: display space (origin bottom-left as shown, y up) → user space. */
export function viewMatrix(page, extra = 0) {
  const m = viewMatrixFor(rotationOf(page, extra), cropOf(page));
  const u = userUnit(page);
  return u === 1 ? m : [m[0] / u, m[1] / u, m[2] / u, m[3] / u, m[4], m[5]];
}

// ---------------------------------------------------------------------------------------------
// Streams and tags

/** A stream's decoded bytes (PDFRawStream with its filters, or a pdf-lib content stream). */
export function decoded(stream, limit = Infinity) {
  let out;
  if (stream instanceof PDFRawStream) out = stream.dict.get(N('Filter')) ? decodePDFRawStream(stream).decode() : stream.getContents();
  else if (typeof stream?.getUnencodedContents === 'function') out = stream.getUnencodedContents();
  else if (typeof stream?.getContents === 'function') out = stream.getContents();
  else return null;
  if (out.length > limit) throw new CommandError('too_large', 'the page content is too large');
  return out;
}

const resolve = (doc, o) => (o instanceof PDFRef ? doc.context.lookup(o) : o);

/** place.rs `stream_tag`: the /PCMark name in a content stream's dictionary (never decompresses). */
export function streamTag(doc, o) {
  const s = resolve(doc, o);
  const d = s instanceof PDFDict ? s : s?.dict;
  const t = d instanceof PDFDict ? d.get(N('PCMark')) : null;
  return t instanceof PDFName ? t.decodeText() : null;
}

/** place.rs `tagged`: a stream dictionary with /PCMark tag. */
const tagged = (doc, tag) => doc.context.obj({PCMark: tag});

/** place.rs `contents`: the page's /Contents as a list of references (inline content promoted). */
export function contents(doc, page) {
  const c = page.node.get(N('Contents'));
  if (c === undefined) return [];
  if (c instanceof PDFRef) {
    const t = doc.context.lookup(c);
    return t instanceof PDFArray ? t.asArray().slice() : [c];
  }
  if (c instanceof PDFArray) return c.asArray().slice();
  return [doc.context.register(c)];
}
const setContents = (doc, page, list) => page.node.set(N('Contents'), doc.context.obj(list));

export const WRAP_OPEN = 'q %Arkemis\n';
export const WRAP_CLOSE = '\nQ %Arkemis\n';
// Files saved before the app's own name went into the markers carry %PdfCraft (and, older still, a close marker without the
// line break before it): they are still recognised when read, and get %Arkemis once their wrapper is written again.
export const LEGACY_WRAP_OPEN = 'q %PdfCraft\n';
export const LEGACY_WRAP_CLOSE = '\nQ %PdfCraft\n';
export const OLD_WRAP_CLOSE = 'Q %PdfCraft\n';

/** Whether a stream's text is a wrapper's open marker (this app's, or a file saved earlier). */
export const isWrapOpen = t => t === WRAP_OPEN || t === LEGACY_WRAP_OPEN;

/** place.rs `is_wrap_close`. */
export function isWrapClose(s) {
  let rest = s;
  while (rest.startsWith('\nEMC')) rest = rest.slice(4);
  const legacy = rest.length === s.length;
  for (;;) {
    if (rest === WRAP_CLOSE || rest === LEGACY_WRAP_CLOSE || (legacy && rest === OLD_WRAP_CLOSE)) return true;
    if (rest.startsWith('\nQ')) rest = rest.slice(2);
    else return false;
  }
}

/** place.rs `wrapper_role`: true for a wrapper's open, false for its close, null otherwise. */
export function wrapperRole(doc, o) {
  if (streamTag(doc, o) !== 'Wrap') return null;
  const s = resolve(doc, o);
  let bytes;
  try { bytes = decoded(s, 64 * 1024); } catch { return null; }
  if (!bytes) return null;
  const t = str(bytes);
  if (isWrapOpen(t)) return true;
  return isWrapClose(t) ? false : null;
}

// ---------------------------------------------------------------------------------------------
// The content lexer (crates/content Pieces::join / parse / comment_edges)

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Pieces::join: the streams joined with one space after each; `ends[i]` is the end of piece i. */
export function joinPieces(pieces) {
  let total = 0;
  for (const p of pieces) total += p.length + 1;
  const data = new Uint8Array(total), ends = [];
  let at = 0;
  for (const p of pieces) { data.set(p, at); at += p.length; data[at++] = 0x20; ends.push(at); }
  return {data, ends};
}
/** Pieces::piece_of. */
export function pieceOf(ends, at) {
  let lo = 0, hi = ends.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] <= at) lo = mid + 1; else hi = mid; }
  return Math.min(lo, Math.max(0, ends.length - 1));
}

/**
 * Pieces::parse: operators with their operands (kind 'name' | 'num' | 'str' | 'array' | 'dict' |
 * 'other') and spans [start, end) in the joined data, the count of stray bytes skipped, and per
 * piece whether a comment runs into it from the piece before and out of it into the next.
 */
export function parsePieces(data, ends, {maxOps = Infinity} = {}) {
  const ops = [];
  let operands = [], opStart = -1, skipped = 0, i = 0;
  const edges = ends.map(() => [false, false]);
  let boundary = 0;
  const comment = (from, to) => {
    // crates/content comment_edges: the separator of piece `boundary` is the last byte before its end.
    while (boundary < ends.length) {
      const sep = ends[boundary] - 1;
      if (sep >= to) break;
      if (sep >= from) { edges[boundary][1] = true; if (boundary + 1 < edges.length) edges[boundary + 1][0] = true; }
      boundary++;
    }
  };
  const operand = (kind, start, value) => { if (opStart < 0) opStart = start; operands.push({kind, value}); };
  const skipString = j => {
    let depth = 1; j++;
    while (j < data.length && depth > 0) {
      const c = data[j];
      if (c === 0x5c) { j += 2; continue; }
      if (c === 0x28) depth++;
      else if (c === 0x29) depth--;
      j++;
    }
    return depth === 0 ? j : -1;
  };
  // A composite operand ([...] or <<...>>) is read whole; nested errors make it stray bytes.
  const skipComposite = (j, open, close) => {
    let depth = 0;
    while (j < data.length) {
      const c = data[j];
      if (c === 0x28) { const e = skipString(j); if (e < 0) return -1; j = e; continue; }
      if (c === 0x25) { while (j < data.length && data[j] !== 10 && data[j] !== 13) j++; continue; }
      if (open === '[' && c === 0x5b) { depth++; j++; continue; }
      if (open === '[' && c === 0x5d) { depth--; j++; if (!depth) return j; continue; }
      if (open === '<<' && c === 0x3c && data[j + 1] === 0x3c) { depth++; j += 2; continue; }
      if (open === '<<' && c === 0x3e && data[j + 1] === 0x3e) { depth--; j += 2; if (!depth) return j; continue; }
      if (close === 'x') return -1;
      j++;
    }
    return -1;
  };
  while (i < data.length) {
    const c = data[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) {
      const from = i;
      while (i < data.length && data[i] !== 10 && data[i] !== 13) i++;
      comment(from, i);
      continue;
    }
    if (c === 0x28) { const e = skipString(i); if (e < 0) { skipped += data.length - i; break; } operand('str', i); i = e; continue; }
    if (c === 0x5b) { const e = skipComposite(i, '['); if (e < 0) { skipped += data.length - i; break; } operand('array', i); i = e; continue; }
    if (c === 0x3c && data[i + 1] === 0x3c) { const e = skipComposite(i, '<<'); if (e < 0) { skipped += data.length - i; break; } operand('dict', i); i = e; continue; }
    if (c === 0x3c) { let j = i + 1; while (j < data.length && data[j] !== 0x3e) j++; if (j >= data.length) { skipped += data.length - i; break; } operand('str', i); i = j + 1; continue; }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < data.length && !WS.has(data[j]) && !DELIM.has(data[j])) j++;
      operand('name', i, str(data.subarray(i + 1, j)));
      i = j;
      continue;
    }
    if (DELIM.has(c)) { skipped++; i++; continue; }   // a stray ) ] } >
    let j = i;
    while (j < data.length && !WS.has(data[j]) && !DELIM.has(data[j])) j++;
    const word = str(data.subarray(i, j));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { operand('num', i, Number(word)); i = j; continue; }
    if (word === 'true' || word === 'false' || word === 'null') { operand('other', i); i = j; continue; }
    const start = opStart < 0 ? i : opStart;
    ops.push({op: word, operands, start, end: j});
    if (ops.length > maxOps) return {ops, skipped, edges, tooMany: true};
    operands = []; opStart = -1;
    i = j;
    if (word === 'ID') {
      // Inline image data: up to whitespace EI whitespace.
      let k = i + 1;
      while (k < data.length && !(WS.has(data[k - 1]) && data[k] === 0x45 && data[k + 1] === 0x49 && (k + 2 >= data.length || WS.has(data[k + 2])))) k++;
      i = k;
    }
  }
  if (operands.length) skipped += 1;
  return {ops, skipped, edges};
}

// ---------------------------------------------------------------------------------------------
// isolation (place.rs)

export const ISOLATION_MAX_STREAMS = 100_000;
export const ISOLATION_MAX_BYTES = 128 * 1024 * 1024;
export const ISOLATION_MAX_OPS = 1_000_000;
export const ISOLATION_MAX_DEPTH = 10_000;

/**
 * place.rs `isolation`: {clean: {suffix, wrappers, marked}} | {unknown: {unclosed, marked}} | {tooDeep: true}.
 */
export function isolation(doc, list) {
  const unknown = {kind: 'unknown', unclosed: 0, marked: 0};
  if (list.length > ISOLATION_MAX_STREAMS) return unknown;
  let remaining = ISOLATION_MAX_BYTES;
  const data = [];
  for (const o of list) {
    const s = resolve(doc, o);
    let bytes;
    try { bytes = decoded(s, remaining); } catch { return unknown; }
    if (!bytes) return unknown;
    remaining -= bytes.length + 1;
    if (remaining < 0) return unknown;
    data.push(bytes);
  }
  const pieces = joinPieces(data);
  const parsed = parsePieces(pieces.data, pieces.ends, {maxOps: ISOLATION_MAX_OPS});
  if (parsed.skipped !== 0 || parsed.tooMany) return unknown;
  const edges = parsed.edges;
  let textOpen = false, pathOpen = false, dirty = false, malformed = false;
  const stack = [];
  let marked = 0, markedKnown = true, split = 0, previousLast = null;
  const wrappers = [];
  const texts = data.map(d => (d.length < 64 ? str(d) : null));
  for (const op of parsed.ops) {
    const first = pieceOf(pieces.ends, op.start), last = pieceOf(pieces.ends, op.end - 1);
    if (!stack.length && markedKnown && marked === 0 && !textOpen && !pathOpen && !dirty
      && (previousLast === null || first > previousLast) && !edges[first]?.[0]) split = first;
    previousLast = last;
    const beginMarked = op.op === 'BMC' ? op.operands.at(-1)?.kind === 'name'
      : op.op === 'BDC' ? op.operands.length >= 2 && op.operands[op.operands.length - 2]?.kind === 'name' : false;
    if (markedKnown) {
      if (beginMarked) {
        if (marked < ISOLATION_MAX_DEPTH) marked++;
        else { markedKnown = false; marked = 0; }
      } else if (op.op === 'EMC') marked = Math.max(0, marked - 1);
    }
    switch (op.op) {
      case 'BT': if (!textOpen) textOpen = true; else malformed = true; break;
      case 'ET': if (textOpen) textOpen = false; else malformed = true; break;
      case 'm': case 'l': case 'c': case 'v': case 'y': case 'h': case 're': case 'W': case 'W*': pathOpen = true; break;
      case 'n': case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': pathOpen = false; break;
      default: break;
    }
    if (op.op === 'q' && !op.operands.length && stack.length < ISOLATION_MAX_DEPTH) stack.push(first);
    else if (op.op === 'Q' && !op.operands.length) {
      const open = stack.pop();
      if (open === undefined) malformed = true;
      else {
        const wrap = i => i < list.length && streamTag(doc, list[i]) === 'Wrap';
        if (wrap(open) && wrap(first) && isWrapOpen(texts[open]) && texts[first] !== null && isWrapClose(texts[first])) wrappers.push([open, first]);
      }
    } else if (op.op === 'q' || op.op === 'Q') malformed = true;
    else if (!stack.length) dirty = true;
  }
  if (!markedKnown) return {kind: 'tooDeep'};
  if (malformed || textOpen || pathOpen || stack.length) return {kind: 'unknown', unclosed: malformed ? 0 : stack.length, marked};
  const commentOpen = !!edges.at(-1)?.[1];
  return {kind: 'clean', suffix: dirty || commentOpen || marked !== 0 ? split : null, wrappers, marked};
}

// ---------------------------------------------------------------------------------------------
// Resources

/** place.rs `page_fonts`: the fonts a page draws with (own or inherited resources). */
export function pageFonts(doc, page) {
  const res = page.node.Resources();
  const f = res?.lookup(N('Font'));
  return f instanceof PDFDict ? f : doc.context.obj({});
}

/** place.rs `free_font_name`. */
export function freeFontName(doc, fonts, preferred, base) {
  const usable = name => {
    const v = fonts.get(N(name));
    if (v === undefined) return true;
    const d = resolve(doc, v);
    if (!(d instanceof PDFDict)) return false;
    const nm = k => { const x = d.get(N(k)); return x instanceof PDFName ? x.decodeText() : null; };
    return d.keys().length === 4 && nm('Type') === 'Font' && nm('Subtype') === 'Type1' && nm('BaseFont') === base && nm('Encoding') === 'WinAnsiEncoding';
  };
  if (usable(preferred)) return preferred;
  const count = fonts.keys().length;
  for (let k = 1; k <= count + 1; k++) if (usable(`${preferred}_${k}`)) return `${preferred}_${k}`;
  return preferred;
}

/** place.rs `add_page_resources`: standard faces and an opacity state into the page's own (copied) resources. */
export function addPageResources(doc, page, opacity, faces) {
  const ctx = doc.context;
  const inherited = page.node.Resources();
  const res = inherited ? inherited.clone(ctx) : ctx.obj({});
  const f = res.lookup(N('Font'));
  const fonts = f instanceof PDFDict ? f.clone(ctx) : ctx.obj({});
  for (const [name, base] of faces) fonts.set(N(name), ctx.obj({Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding'}));
  res.set(N('Font'), fonts);
  if (opacity !== null && opacity !== undefined) {
    const g = res.lookup(N('ExtGState'));
    const gs = g instanceof PDFDict ? g.clone(ctx) : ctx.obj({});
    gs.set(N(`PCGS${Math.round(opacity * 100)}`), ctx.obj({Type: 'ExtGState', CA: opacity, ca: opacity}));
    res.set(N('ExtGState'), gs);
  }
  page.node.set(N('Resources'), res);
}

/** place.rs `add_resources`: Helvetica always; Times and Courier when `content` names them. */
export function addResources(doc, page, opacity, content = null) {
  const faces = [];
  for (const [name, base] of [['PCHelv', 'Helvetica'], ['PCTimes', 'Times-Roman'], ['PCCour', 'Courier']]) {
    if (name !== 'PCHelv' && !(content && new RegExp(`/${name}(?![A-Za-z0-9_])`).test(content))) continue;
    faces.push([name, base]);
  }
  addPageResources(doc, page, opacity, faces);
}

// ---------------------------------------------------------------------------------------------
// Placing

const tooDeep = () => new CommandError('invalid_params', "the page's marked content is nested too deeply to add anything on top of it");

/** place.rs `place_tagged`: put `content` (a binary string) on the page tagged `tag`, behind or on top. */
export function placeTagged(doc, page, tag, content, behind) {
  const ctx = doc.context;
  const list = contents(doc, page);
  const behindKinds = ['Background', 'Watermark'];
  let behindMarks = 0;
  while (behindMarks < list.length && behindKinds.includes(streamTag(doc, list[behindMarks]))) behindMarks++;
  let wrap = null;
  if (!behind) {
    const iso = isolation(doc, list);
    if (iso.kind === 'clean') wrap = iso.suffix === null ? null : [iso.suffix, 0, iso.marked];
    else if (iso.kind === 'unknown') wrap = behindMarks < list.length ? [behindMarks, iso.unclosed, iso.marked] : null;
    else throw tooDeep();
  }
  const markRef = ctx.register(ctx.flateStream(bin(content), {PCMark: tag}));
  if (behind) {
    let at = 0;
    for (let i = behindMarks - 1; i >= 0; i--) if (streamTag(doc, list[i]) === 'Background') { at = i + 1; break; }
    list.splice(at, 0, markRef);
  } else {
    if (wrap) {
      const [split, unclosed, marked] = wrap;
      const close = '\nEMC'.repeat(marked) + '\nQ'.repeat(unclosed) + WRAP_CLOSE;
      const open = ctx.register(ctx.stream(bin(WRAP_OPEN), {PCMark: 'Wrap'}));
      const closeRef = ctx.register(ctx.stream(bin(close), {PCMark: 'Wrap'}));
      list.splice(Math.min(split, list.length), 0, open);
      list.push(closeRef);
    }
    list.push(markRef);
  }
  setContents(doc, page, list);
  return markRef;
}

/** place.rs `check_on_top`: the refusal place_tagged gives on top, before anything changes. */
export function checkOnTop(doc, page) {
  if (isolation(doc, contents(doc, page)).kind === 'tooDeep') throw tooDeep();
}

/** place.rs `place_inside_wrapper`: content first inside the q/Q wrapper (a header's shrink). */
export function placeInsideWrapper(doc, page, tag, content) {
  const list = contents(doc, page);
  const open = list.findIndex(o => streamTag(doc, o) === 'Wrap');
  if (open < 0) return;
  const ctx = doc.context;
  list.splice(open + 1, 0, ctx.register(ctx.flateStream(bin(content), {PCMark: tag})));
  setContents(doc, page, list);
}

/** place.rs `stamp`: permanent content on top of page `index`, Helvetica as /PCHelv. */
export function stamp(doc, index, tag, content) {
  const all = pageList(doc);
  check([index], all.length);
  checkOnTop(doc, all[index]);
  addResources(doc, all[index], null, content);
  return placeTagged(doc, all[index], tag, content, false);
}

/** marks.rs `matrix_number`: a real as pdfcraft_cos serializes it (no exponent, trailing zeros trimmed). */
export function matrixNumber(v) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** place.rs `begin`: the marked-content artifact a mark is drawn in, in display space. */
export function begin(kind, subtype, m) {
  return `q\n/Artifact <</Type /Pagination /Subtype /${subtype} /PCMark /${kind}>> BDC\n${m.map(matrixNumber).join(' ')} cm\n`;
}
export const END = 'EMC\nQ\n';

/** place.rs `undrawable_message`. */
export function undrawableMessage(ch) {
  return `the standard fonts can't draw "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}); only Western European characters can be added as text for now`;
}
export const undrawable = ch => new CommandError('invalid_params', undrawableMessage(ch));

/** place.rs `text_op`. */
export const textOp = (x, y, text) => `1 0 0 1 ${n(x)} ${n(y)} Tm ${literal(winAnsiBytes(text))} Tj\n`;
