// The small "flow" model every text format (plain text, Markdown, HTML, RTF, ODT) maps to and from:
// paragraphs with a kind (heading, quote, code…), list membership, alignment and formatted inline
// spans; tables of cells holding blocks. `toContent` and `fromContent` convert between it and Quill
// schema-2 content.
//
// Translated from wordcraft crates/formats (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   src/model.rs, src/model/types.rs, src/model/to_doc.rs, src/model/from_doc.rs, src/model/color.rs,
//   src/model/media.rs, src/comments.rs (Print Markup notes).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Shapes (upstream's enums as plain objects; absent = upstream's default):
//   Fmt     {bold, italic, underline, strike, code, sup, sub, link, color, size, font, background, ins, del, fmtChange}
//   Inline  {t:'text', text, fmt} | {t:'image', img:{b64, ext, w, h, alt}} | {t:'anchor', name} | {t:'figure', alt}
//           | {t:'equation', linear, display} | {t:'ruby', base, ruby, fmt}
//   Para    {t:'para', kind:'normal'|'heading'|'title'|'quote'|'code'|'rule', level (heading 1..6), list:{ordered, level, start}|null,
//            align, pageBreak, keepNext, inlines, spacing:{before, after, line, left, right, first}, borders, section, markIns, markDel, fmtChange}
//   FTable  {t:'table', rows: Cell[][], widths: number[], borderless}
//   Cell    {blocks, colspan, rowspan, covered, header, shading, borders, valign}
//   Flow    {blocks, meta:{title, author, subject, keywords, description, created}}
// Differences from upstream (docs/behaviour-fidelity.md): picture bytes travel as base64 (the
// model's media form); offsets are UTF-16. The `_` prefix keeps this helper out of the generated
// format index (scripts/gen/registry.mjs), it is shared by the formats-* units' readers/writers.
// No DOM, no Node built-ins.

import {createContent} from '../model/content.mjs';
import {Document, BODY} from '../model/document.mjs';
import * as P from '../model/para.mjs';
import {levelsFor} from '../model/numbering.mjs';
import {levelOf} from '../model/numbering.mjs';
import {chain, resolvePara, upsertStyle, style as newStyle} from '../model/styles.mjs';
import {highlightRgb, bordersAnyVisible, borderVisible, tableLook, same} from '../model/props.mjs';
import {textWidth, defaultSection} from '../model/section.mjs';
import {roman, letters} from '../model/numfmt.mjs';
import {isSymbolFont, mapText} from '../model/symbol-fonts.mjs';
import {newTable, emptyCell} from '../model/table.mjs';
import {OBJ} from '../model/text.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
  files: ['crates/formats/src/model.rs', 'crates/formats/src/model/types.rs', 'crates/formats/src/model/to_doc.rs',
    'crates/formats/src/model/from_doc.rs', 'crates/formats/src/model/color.rs', 'crates/formats/src/model/media.rs', 'crates/formats/src/comments.rs']});

/** Font used for code spans and code blocks. */
export const MONO_FONT = 'Courier New';
/** Style id of code-block paragraphs. */
export const CODE_STYLE = 'Code';
/** Nesting limit for tables in tables (hostile input). */
export const MAX_DEPTH = 8;
/** Longest font name the importers keep (UTF-8 bytes). */
export const MAX_FONT_NAME = 256;
/** Longest hyperlink target the importers keep (UTF-8 bytes). */
export const MAX_LINK = 8 << 10;
const MAX_RUN_STRINGS = 64 << 20;
/** Base text size a phonetic guide falls back to. */
export const RUBY_BASE_SIZE = 10.5;
const MAX_ROWS = 4096, MAX_COLS = 63;

const utf8Len = s => new TextEncoder().encode(s).length;

/** Messages about what an import left out, once per kind per document (types.rs `dropped`). */
export const importLog = {reported: new Set(), messages: []};
export function beginImport() { importLog.reported = new Set(); importLog.messages = []; }
const DROPPED = {
  font: `import: font names longer than ${MAX_FONT_NAME} bytes are dropped; that text keeps the surrounding font`,
  link: `import: links longer than ${MAX_LINK} bytes are dropped; their text is kept`,
  runStrings: `import: the document's runs carry more than ${MAX_RUN_STRINGS} bytes of links and font names; later runs lose them`,
  styleName: `import: style names longer than ${MAX_FONT_NAME} bytes are cut short`,
};
export function dropped(kind) {
  if (importLog.reported.has(kind)) return;
  importLog.reported.add(kind);
  importLog.messages.push(DROPPED[kind]);
}
export function keptFont(name) { if (utf8Len(name) <= MAX_FONT_NAME) return name; dropped('font'); return null; }
export function keptLink(target) { if (utf8Len(target) <= MAX_LINK) return target; dropped('link'); return null; }

// --- types.rs -------------------------------------------------------------------------------

export const fmt = (o = {}) => ({bold: false, italic: false, underline: false, strike: false, code: false, sup: false, sub: false, link: null,
  color: null, size: null, font: null, background: null, ins: null, del: null, fmtChange: null, ...o});
export const fmtEq = (a, b) => a === b || same(a, b);
export const para = (kind = 'normal', o = {}) => ({t: 'para', kind, level: 0, list: null, align: null, pageBreak: false, keepNext: false, inlines: [],
  spacing: {}, borders: null, section: null, markIns: null, markDel: null, fmtChange: null, ...o});
export const heading = (n, o = {}) => para('heading', {level: Math.max(1, Math.min(6, n)), ...o});
export const cell = (o = {}) => ({blocks: [], colspan: 1, rowspan: 1, covered: false, header: false, shading: null, borders: null, valign: null, ...o});
export const ftable = (o = {}) => ({t: 'table', rows: [], widths: [], borderless: false, ...o});
export const meta = (o = {}) => ({title: '', author: '', subject: '', keywords: '', description: '', created: '', ...o});
export const flow = (blocks = [], m = {}) => ({blocks, meta: meta(m)});

/** Append text, merging with the previous span when the formatting matches (Para::push_text). */
export function pushText(p, s, f) {
  if (!s) return;
  const last = p.inlines[p.inlines.length - 1];
  if (last?.t === 'text' && fmtEq(last.fmt, f)) { last.text += s; return; }
  p.inlines.push({t: 'text', text: s, fmt: f});
}
/** Plain text (images and anchors left out; equations as their linear text, ruby as its base). */
export function paraText(p) {
  let s = '';
  for (const i of p.inlines) if (i.t === 'text') s += i.text; else if (i.t === 'equation') s += i.linear; else if (i.t === 'ruby') s += i.base;
  return s;
}
/** paraText as it reads on screen: symbol-font text as its Unicode equivalents (plain-text export). */
export function shownText(p) {
  let s = '';
  for (const i of p.inlines) {
    if (i.t === 'text') s += i.fmt?.font && isSymbolFont(i.fmt.font) ? mapText(i.fmt.font, i.text) : i.text;
    else if (i.t === 'equation') s += i.linear; else if (i.t === 'ruby') s += i.base;
  }
  return s;
}
export const paraIsEmpty = p => p.inlines.every(i => i.t === 'text' && !i.text);
/** Remove whitespace at the very start and end of the paragraph's text (Para::trim). */
export function trim(p) { trimWith(p, ' \t\r\n', ' \t\r\n'); }
export function trimWith(p, start, end) {
  const isS = c => start.includes(c), isE = c => end.includes(c);
  const trimStart = t => { let i = 0; while (i < t.length && isS(t[i])) i++; return t.slice(i); };
  let k = 0;
  while (k < p.inlines.length && p.inlines[k].t === 'text' && !trimStart(p.inlines[k].text)) k++;
  p.inlines.splice(0, k);
  if (p.inlines[0]?.t === 'text') p.inlines[0] = {...p.inlines[0], text: trimStart(p.inlines[0].text)};
  while (p.inlines.length && p.inlines[p.inlines.length - 1].t === 'text') {
    const last = p.inlines[p.inlines.length - 1];
    let n = last.text.length;
    while (n > 0 && isE(last.text[n - 1])) n--;
    if (n) { p.inlines[p.inlines.length - 1] = {...last, text: last.text.slice(0, n)}; break; }
    p.inlines.pop();
  }
}
/** Text of a cell: paragraphs joined by `\n`. */
export function cellText(c) {
  return c.blocks.map(b => (b.t === 'para' ? paraText(b) : b.rows.flatMap(r => r.map(cellText)).join(' '))).join('\n');
}
export const tableCols = t => Math.max(0, ...t.rows.map(r => r.reduce((n, c) => n + clampSpan(c.colspan), 0)));
const clampSpan = s => Math.max(1, Math.min(63, s | 0 || 1));
/** Insert covered cells into the rows below each row-spanning cell (FTable::insert_covered). */
export function insertCovered(t) {
  const MAX_COVERED_WORK = 1 << 17;
  let work = 0;
  for (let r = 0; r < t.rows.length; r++) {
    let g = 0;
    for (let ci = 0; ci < (t.rows[r]?.length ?? 0); ci++) {
      const c = t.rows[r][ci];
      const span = clampSpan(c.colspan), rs = Math.max(1, Math.min(1000, c.rowspan | 0 || 1));
      if (rs > 1 && !c.covered) {
        for (let k = 1; k < rs; k++) {
          if (++work > MAX_COVERED_WORK) return;
          const row = t.rows[r + k];
          if (!row) break;
          let x = 0, at = row.length;
          for (let i = 0; i < row.length; i++) { if (x >= g) { at = i; break; } x += clampSpan(row[i].colspan); }
          if (row.length < 64) row.splice(at, 0, cell({colspan: span, covered: true}));
        }
      }
      g += span;
    }
  }
}
/** `inlines` with equations as their linear text, for formats without equations. */
export function equationsAsText(inlines) {
  if (!inlines.some(i => i.t === 'equation')) return inlines;
  const p = para();
  for (const i of inlines) {
    if (i.t === 'equation') pushText(p, i.linear, fmt()); else if (i.t === 'text') pushText(p, i.text, i.fmt); else p.inlines.push(i);
  }
  return p.inlines;
}
/** `inlines` with ruby as its base text, for formats without ruby markup. */
export function rubyAsText(inlines) {
  if (!inlines.some(i => i.t === 'ruby')) return inlines;
  const p = para();
  for (const i of inlines) if (i.t === 'ruby') pushText(p, i.base, i.fmt); else p.inlines.push(i);
  return p.inlines;
}
/** Text with U+FFFC and stray controls removed (clean_text). */
export function cleanText(s) {
  let out = '';
  for (const c of String(s)) {
    if (c === OBJ) continue;
    const cp = c.codePointAt(0);
    const control = cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
    if (control && !'\t\n\u000C\u000E'.includes(c)) continue;
    out += c;
  }
  return out;
}
/** The ruby a format without its own ruby markup gets (types.rs ruby_object). */
export function rubyObject(base, ruby, baseSize) {
  const bs = Number.isFinite(baseSize) ? Math.max(1, Math.min(1584, baseSize)) : RUBY_BASE_SIZE;
  const size = Math.max(1, Math.floor(bs) / 2);
  const raise = Math.max(0, Math.min(1584, P.rubyRaise(0, bs, size)));
  return {type: 'ruby', base, ruby, align: 'center', size, raise, base_size: bs};
}

// --- color.rs --------------------------------------------------------------------------------

function hslToRgb(h, s, l) {
  h = (((h / 360) % 1) + 1) % 1; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const v8 = x => Math.max(0, Math.min(255, Math.round(x * 255)));
  if (s === 0) { const v = v8(l); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue = t => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [v8(hue(h + 1 / 3)), v8(hue(h)), v8(hue(h - 1 / 3))];
}
const NAMED = {black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], lime: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128],
  silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0], navy: [0, 0, 128], purple: [128, 0, 128], teal: [0, 128, 128], orange: [255, 165, 0]};
/** A CSS / HTML colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `hsl(...)` or a basic name. */
export function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const hex = x => (/^[0-9a-f]+$/.test(x) ? parseInt(x, 16) : NaN);
    if (h.length === 3 || h.length === 4) { const v = [0, 1, 2].map(i => hex(h[i]) * 17); return v.some(Number.isNaN) ? null : v; }
    if (h.length === 8 || h.length === 6) { const v = [0, 2, 4].map(i => hex(h.slice(i, i + 2))); return v.some(Number.isNaN) ? null : v; }
    return null;
  }
  const fn = (/^(rgba?|hsla?)\((.*)$/).exec(s);
  if (fn) {
    const inner = fn[2].replace(/\)+$/, '').trim().split('/')[0];
    const parts = inner.includes(',') ? inner.split(',') : inner.split(/\s+/).filter(Boolean);
    if (fn[1].startsWith('rgb')) {
      const v = parts.slice(0, 3).map(x => { x = x.trim(); if (x.endsWith('%')) { const f = Number(x.slice(0, -1)); return Number.isFinite(f) ? Math.round(Math.max(0, Math.min(100, f)) * 2.55) : NaN; } const f = Number(x); return x && Number.isFinite(f) ? Math.round(Math.max(0, Math.min(255, f))) : NaN; }).filter(x => !Number.isNaN(x));
      return v.length === 3 ? v : null;
    }
    if (parts.length < 3) return null;
    const hs = parts[0].trim();
    let h;
    if (hs.endsWith('deg')) h = Number(hs.slice(0, -3)); else if (hs.endsWith('rad')) h = Number(hs.slice(0, -3)) * 180 / Math.PI;
    else if (hs.endsWith('turn')) h = Number(hs.slice(0, -4)) * 360; else h = Number(hs);
    const pct = x => { x = x.trim(); const v = x.endsWith('%') ? Number(x.slice(0, -1)) / 100 : Number(x); return Number.isFinite(v) && x ? Math.max(0, Math.min(1, v)) : null; };
    const sv = pct(parts[1]), lv = pct(parts[2]);
    if (!Number.isFinite(h) || sv === null || lv === null) return null;
    return hslToRgb(h, sv, lv);
  }
  return NAMED[s] ? [...NAMED[s]] : null;
}

// --- media.rs --------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64Encode(data) {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i], b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2, len = Math.min(3, data.length - i);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (len > 1 ? B64[(n >> 6) & 63] : '=') + (len > 2 ? B64[n & 63] : '=');
  }
  return out;
}
/** Lenient base64 (URL-safe alphabet too, whitespace skipped); null on a bad character. */
export function base64Decode(s) {
  const out = [];
  let acc = 0, bits = 0;
  for (const c of String(s)) {
    let v;
    if (c >= 'A' && c <= 'Z') v = c.charCodeAt(0) - 65; else if (c >= 'a' && c <= 'z') v = c.charCodeAt(0) - 71; else if (c >= '0' && c <= '9') v = c.charCodeAt(0) + 4;
    else if (c === '+' || c === '-') v = 62; else if (c === '/' || c === '_') v = 63; else if (c === '=') break; else if (/\s/.test(c)) continue; else return null;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}
export function percentDecode(s) {
  const b = new TextEncoder().encode(s), out = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x25 && i + 2 < b.length + 0 && /^[0-9a-fA-F]{2}$/.test(String.fromCharCode(b[i + 1] ?? 0, b[i + 2] ?? 0))) { out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16)); i += 2; continue; }
    out.push(b[i]);
  }
  return Uint8Array.from(out);
}
/** The bytes of a `data:` URI. */
export function dataUri(uri) {
  const rest = String(uri).trim();
  if (!rest.startsWith('data:')) return null;
  const k = rest.indexOf(',');
  if (k < 0) return null;
  const head = rest.slice(5, k), data = rest.slice(k + 1);
  return head.endsWith(';base64') ? base64Decode(data) : percentDecode(data);
}
export function mimeOf(ext) {
  return {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    ico: 'image/x-icon'}[ext] ?? 'application/octet-stream';
}
/** The picture type of `data` by its signature. */
export function sniffImage(d) {
  if (!d || d.length < 4) return null;
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'png';
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpeg';
  if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) return 'gif';
  if (d.length >= 12 && d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 && d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) return 'webp';
  if (d[0] === 0x42 && d[1] === 0x4d) return 'bmp';
  return null;
}
/** Pixel size of a picture, read from its header (image_px). */
export function imagePx(d) {
  const t = sniffImage(d);
  const u16be = i => (d[i] << 8) | d[i + 1], u16le = i => d[i] | (d[i + 1] << 8), u32be = i => ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];
  const u32le = i => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) + d[i + 3] * 0x1000000;
  try {
    if (t === 'png' && d.length >= 24) return [u32be(16), u32be(20)];
    if (t === 'gif' && d.length >= 10) return [u16le(6), u16le(8)];
    if (t === 'bmp' && d.length >= 26) return [Math.abs(u32le(18) | 0), Math.abs(u32le(22) | 0)];
    if (t === 'webp' && d.length >= 30) {
      const kind = String.fromCharCode(d[12], d[13], d[14], d[15]);
      if (kind === 'VP8X') return [1 + (d[24] | (d[25] << 8) | (d[26] << 16)), 1 + (d[27] | (d[28] << 8) | (d[29] << 16))];
      if (kind === 'VP8L') { const b = u32le(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
      if (kind === 'VP8 ') return [u16le(26) & 0x3fff, u16le(28) & 0x3fff];
    }
    if (t === 'jpeg') {
      let i = 2;
      while (i + 9 < d.length) {
        if (d[i] !== 0xff) { i++; continue; }
        const m = d[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u16be(i + 7), u16be(i + 5)];
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        i += 2 + u16be(i + 2);
      }
    }
  } catch { /* truncated */ }
  return null;
}
/** A flow picture from bytes, sized from `w`/`h` (points) or its pixels at 96 dpi, at most 468 pt wide. */
export function makeImg(data, w, h, alt) {
  const ext = sniffImage(data);
  if (!ext) return null;
  const px = imagePx(data);
  const [pw, ph] = px ? [Math.max(1, px[0] * 0.75), Math.max(1, px[1] * 0.75)] : [72, 72];
  const ok = v => Number.isFinite(v) && v > 0;
  let W, H;
  if (ok(w) && ok(h)) [W, H] = [w, h]; else if (ok(w)) [W, H] = [w, w * ph / pw]; else if (ok(h)) [W, H] = [h * pw / ph, h]; else [W, H] = [pw, ph];
  if (W > 468) { H *= 468 / W; W = 468; }
  const cl = v => Math.max(1, Math.min(1584, v));
  return {b64: base64Encode(data), ext, w: cl(W), h: cl(H), alt: alt ?? ''};
}

// --- to_doc.rs -------------------------------------------------------------------------------

/** CharProps of a flow span (to_doc.rs char_props). */
export function charProps(f) {
  const cp = {};
  if (f.bold) cp.bold = true;
  if (f.italic) cp.italic = true;
  if (f.underline) cp.underline = 'single';
  if (f.strike) cp.strike = true;
  if (f.sup) cp.vertAlign = 'superscript'; else if (f.sub) cp.vertAlign = 'subscript';
  if (f.link) cp.link = f.link;
  if (f.color) cp.color = {Rgb: [...f.color]};
  if (Number.isFinite(f.size) && f.size >= 1 && f.size <= 1638) cp.size = f.size;
  if (f.code) cp.font = MONO_FONT; else if (f.font) cp.font = f.font;
  if (f.background) cp.shading = [...f.background];
  return cp;
}
const codeStyle = () => newStyle({id: CODE_STYLE, name: CODE_STYLE, kind: 'paragraph', basedOn: 'Normal',
  para: {spaceAfter: 0, spaceBefore: 0, lineSpacing: {rule: 'multiple', value: 1}}, chr: {font: MONO_FONT, size: 10}, quick: false});
const ruleBorders = () => ({bottom: {style: 'single', width: 0.75, color: [0xa0, 0xa0, 0xa0], space: 1}});

function append(p, text, props, obj) {
  let piece;
  if (obj) { (p.objects ||= []).push(obj); piece = OBJ; } else piece = text.includes(OBJ) ? text.split(OBJ).join('') : text;
  if (!piece) return;
  p.text += piece;
  const last = p.runs[p.runs.length - 1];
  if (last && same(last.props ?? {}, props)) last.len += piece.length;
  else p.runs.push(Object.keys(props).length ? {len: piece.length, props: {...props}} : {len: piece.length});
}

/** Paragraph properties of a flow paragraph (its list as instance `listNum`). */
function paraProps(p, listNum) {
  const out = {};
  const style = p.kind === 'heading' ? `Heading${Math.max(1, Math.min(6, p.level || 1))}` : p.kind === 'title' ? 'Title' : p.kind === 'quote' ? 'Quote'
    : p.kind === 'code' ? CODE_STYLE : null;
  if (style) out.style = style;
  if (p.kind === 'rule') out.borders = ruleBorders(); else if (p.borders) out.borders = p.borders;
  if (p.list && listNum !== null && listNum !== undefined) {
    if (!out.style) out.style = 'ListParagraph';
    out.numbering = {num: listNum, level: Math.min(8, p.list.level)};
  }
  if (p.align) out.align = p.align;
  const sp = p.spacing || {};
  for (const [k, m] of [['before', 'spaceBefore'], ['after', 'spaceAfter'], ['line', 'lineSpacing'], ['left', 'indentLeft'], ['right', 'indentRight'], ['first', 'indentFirst']]) {
    if (sp[k] !== undefined && sp[k] !== null) out[m] = sp[k];
  }
  if (p.pageBreak) out.pageBreakBefore = true;
  return out;
}

const revKey = (kind, m) => `${kind}\u0000${m.author ?? ''}\u0000${m.date ?? ''}\u0000${m.id ?? ''}`;

class Builder {
  constructor(doc) {
    this.doc = doc;
    this.revs = new Map();
    (doc.c.revisions || []).forEach((r, i) => { if (!r.moveName) { const k = revKey(r.kind, {author: r.author, date: r.date}); if (!this.revs.has(k)) this.revs.set(k, i); } });
    this.runStrings = 0;
  }
  revision(kind, m) {
    const key = revKey(kind, m);
    if (this.revs.has(key)) return this.revs.get(key);
    const revs = [...(this.doc.c.revisions || [])];
    const i = revs.length;
    revs.push({kind, author: m.author ?? '', date: m.date ?? ''});
    this.doc.setField('revisions', revs);
    this.revs.set(key, i);
    return i;
  }
  budget(cp) {
    const n = utf8Len(cp.link ?? '') + utf8Len(cp.font ?? '');
    if (this.runStrings + n <= MAX_RUN_STRINGS) { this.runStrings += n; return cp; }
    if (cp.link || cp.font) dropped('runStrings');
    const out = {...cp}; delete out.link; delete out.font;
    return out;
  }
  para(p, listNum) {
    const out = P.newParagraph(this.doc.newId());
    const props = paraProps(p, listNum);
    if (p.fmtChange) {
      const o = p.fmtChange.old, now = p.list;
      const oldNum = o.list && now && listNum !== null && listNum !== undefined && o.list.ordered === now.ordered ? listNum : o.list ? this.newList([o.list]) : null;
      props.fmtChange = {rev: this.revision('format', p.fmtChange.mark), old: paraProps(o, oldNum)};
    }
    if (p.keepNext) props.keepNext = true;
    if (Object.keys(props).length) out.props = props;
    if (p.section) out.section = p.section;
    for (const i of p.inlines) {
      if (i.t === 'text') {
        const t = cleanText(i.text);
        let cp = this.budget(charProps(i.fmt));
        if (i.fmt.ins) cp.ins = this.revision('insert', i.fmt.ins);
        if (i.fmt.del) cp.del = this.revision('delete', i.fmt.del);
        if (i.fmt.fmtChange) cp.fmtChange = {rev: this.revision('format', i.fmt.fmtChange.mark), old: this.budget(charProps(i.fmt.fmtChange.old))};
        if (p.kind === 'code') {
          if (cp.font === MONO_FONT) { cp = {...cp}; delete cp.font; }
          if (cp.fmtChange?.old?.font === MONO_FONT) { const old = {...cp.fmtChange.old}; delete old.font; cp.fmtChange = {...cp.fmtChange, old}; }
        }
        append(out, t, cp, null);
      } else if (i.t === 'image') {
        const key = this.doc.addMedia(i.img.b64, i.img.ext);
        const fin = (v, d) => (Number.isFinite(v) ? v : d);
        const w = Math.max(1, Math.min(1584, fin(i.img.w, 72))), h = Math.max(1, Math.min(1584, fin(i.img.h, 72)));
        append(out, '', {}, {type: 'image', media: key, w, h, alt: i.img.alt ?? '', float: P.defaultFloat(), crop: [0, 0, 0, 0]});
      } else if (i.t === 'anchor') {
        append(out, '', {}, {type: 'bookmarkStart', name: i.name});
        append(out, '', {}, {type: 'bookmarkEnd', name: i.name});
      } else if (i.t === 'equation') {
        const linear = cleanText(i.linear);
        if (linear) append(out, '', {}, {type: 'equation', linear, display: !!i.display});
      } else if (i.t === 'ruby') {
        const base = cleanText(i.base), ruby = cleanText(i.ruby);
        const cp = this.budget(charProps(i.fmt));
        if (!base || !ruby) append(out, base || ruby, cp, null);
        else append(out, '', cp, rubyObject(base, ruby, cp.size ?? RUBY_BASE_SIZE));
      }
    }
    if (p.markIns || p.markDel) {
      out.mark = {...(out.mark || {})};
      if (p.markIns) out.mark.ins = this.revision('insert', p.markIns);
      if (p.markDel) out.mark.del = this.revision('delete', p.markDel);
    }
    P.normalize(out);
    return out;
  }
  /** A new list instance whose levels follow the kinds used in `group` (first use per level). */
  newList(group) {
    const numLevels = levelsFor('numbered'), bulLevels = levelsFor('bullet');
    const kinds = Array(9).fill(null), starts = Array(9).fill(null);
    for (const li of group) { const l = Math.min(8, li.level); if (kinds[l] === null) kinds[l] = li.ordered; }
    for (const li of group) { const l = Math.min(8, li.level); if (starts[l] === null) starts[l] = li.start; }
    const first = group[0]?.ordered ?? false;
    const levels = Array.from({length: 9}, (_, i) => {
      const ordered = kinds[i] ?? first;
      const level = structuredClone((ordered ? numLevels : bulLevels)[i]);
      if (ordered && starts[i] !== null) level.start = starts[i];
      return level;
    });
    const numbering = this.doc.c.numbering;
    const aid = Math.max(-1, ...numbering.abstracts.map(a => a.id)) + 1;
    const nid = Math.max(1, Math.max(0, ...numbering.nums.map(n => n.id)) + 1);
    this.doc.setField('numbering', {...numbering, abstracts: [...numbering.abstracts, {id: aid, name: null, levels}], nums: [...numbering.nums, {id: nid, abstractId: aid, startOverrides: []}]});
    return nid;
  }
  blocks(blocks, depth) {
    const out = [];
    for (let i = 0; i < blocks.length;) {
      const b = blocks[i];
      if (b.t === 'para' && b.list) {
        let j = i, top = null;
        const group = [];
        while (j < blocks.length && blocks[j].t === 'para' && blocks[j].list) {
          const li = blocks[j].list;
          if (li.level === 0) { if (top !== null && top !== li.ordered) break; top = li.ordered; }
          group.push(li); j++;
        }
        const num = this.newList(group);
        for (const q of blocks.slice(i, j)) out.push(this.para(q, num));
        i = Math.max(j, i + 1);
        continue;
      }
      if (b.t === 'para') out.push(this.para(b, null));
      else if (depth >= MAX_DEPTH) { for (const row of b.rows) for (const c of row) out.push(...this.blocks(c.blocks, depth)); }
      else { const tb = this.table(b, depth); if (tb) out.push(tb); }
      i++;
    }
    return out;
  }
  table(t, depth) {
    const rows = t.rows.filter(r => r.length).slice(0, MAX_ROWS);
    if (!rows.length) return null;
    const cols = Math.max(1, Math.min(MAX_COLS, tableCols(t)));
    const width = Math.max(72, textWidth(this.doc.c.lastSection));
    const tb = newTable(1, cols, width, () => this.doc.newId());
    if (t.borderless) delete tb.props.style;
    if (t.widths.length === cols && t.widths.every(w => Number.isFinite(w) && w > 1)) tb.grid = t.widths.map(w => Math.max(6, Math.min(1584, w)));
    tb.rows = [];
    for (const r of rows) {
      const row = {id: this.doc.newId(), props: {}, cells: []};
      if (r.length && r.every(c => c.header)) row.props.header = true;
      let g = 0;
      for (const c of r.slice(0, MAX_COLS)) {
        const span = Math.min(clampSpan(c.colspan), Math.max(1, cols - g));
        const w = tb.grid.slice(g, Math.min(g + span, tb.grid.length)).reduce((a, b) => a + b, 0) || 72;
        g += span;
        const bl = this.blocks(c.blocks, depth + 1);
        if (!bl.length || bl[bl.length - 1].kind === 'table') bl.push(P.newParagraph(this.doc.newId()));
        const props = {width: w, span};
        if (c.covered) props.vmerge = 'continue'; else if (c.rowspan > 1) props.vmerge = 'restart';
        if (c.shading) props.shading = c.shading;
        if (c.borders) props.borders = c.borders;
        if (c.valign) props.valign = c.valign;
        row.cells.push({id: this.doc.newId(), props, blocks: bl});
      }
      if (!row.cells.length) row.cells.push(emptyCell(() => this.doc.newId()));
      tb.rows.push(row);
    }
    return tb;
  }
}

export const usesKind = (blocks, k, depth = 0) => depth <= MAX_DEPTH
  && blocks.some(b => (b.t === 'para' ? b.kind === k : b.rows.some(r => r.some(c => usesKind(c.blocks, k, depth + 1)))));

/** Schema-2 content from a flow (to_doc / to_doc_in: `section` is the page tables size to). */
export function toContent(fl, section = null) {
  const c = createContent();
  if (section) c.lastSection = section;
  const doc = new Document(c);
  if (usesKind(fl.blocks, 'code')) doc.setField('styles', upsertStyle(doc.c.styles, codeStyle()));
  const body = new Builder(doc).blocks(fl.blocks, 0);
  const m = fl.meta || meta();
  doc.setField('core', {...doc.c.core, title: m.title, creator: m.author, subject: m.subject, keywords: m.keywords, description: m.description, created: m.created});
  const out = doc.c;
  return finishBody(out, body);
}
function finishBody(content, blocks) {
  const c = createContent(blocks.length ? blocks : null);
  content.body = c.body;
  if (!blocks.length || blocks[blocks.length - 1].kind === 'table') content.body = createContent([...blocks, P.newParagraph()]).body;
  return content;
}
/** `blocks` as content blocks of `doc` (a Document; pictures go into its media), for a part an importer adds (part_blocks). */
export function partBlocks(doc, blocks) {
  const out = new Builder(doc).blocks(blocks, 0);
  if (!out.length) out.push(P.newParagraph(doc.newId()));
  return out;
}

// --- from_doc.rs -----------------------------------------------------------------------------

/** Is this a monospace family name? */
export function isMono(font) {
  const f = String(font).toLowerCase();
  return f.includes('courier') || f.includes('mono') || f.includes('consolas') || f.includes('menlo') || f.includes('code') || f === 'monaco';
}
function isCodeStyle(c, id) {
  const names = s => { const l = String(s ?? '').toLowerCase().replace(/[ \-_]/g, ''); return l === 'code' || l.includes('preformatted') || l === 'plaintext' || l === 'codeblock' || l === 'sourcecode'; };
  return chain(c.styles, id).some(s => names(s.id) || names(s.name)) || names(id);
}
function effective(c, cp) {
  let out = {};
  if (cp.style) for (const s of chain(c.styles, cp.style)) if (s.kind === 'character') out = {...out, ...s.chr};
  const direct = {...cp}; delete direct.style;
  for (const [k, v] of Object.entries(direct)) if (v !== undefined) out[k] = v;
  return out;
}
function fmtOf(c, cp, inCode) {
  const e = effective(c, cp || {});
  const code = !inCode && !!e.font && isMono(e.font);
  const shown = e.symFont && String(e.symFont).trim() ? e.symFont : e.font ?? null;
  return fmt({
    bold: !!e.bold, italic: !!e.italic, underline: !!e.underline && e.underline !== 'none' && !e.link, strike: !!e.strike || !!e.doubleStrike, code,
    sup: e.vertAlign === 'superscript', sub: e.vertAlign === 'subscript', link: e.link ?? null,
    color: e.color && typeof e.color === 'object' && Array.isArray(e.color.Rgb) ? [...e.color.Rgb] : null, size: e.size ?? null,
    font: code || inCode ? null : shown, background: (e.highlight ? highlightRgb(e.highlight) : null) ?? e.shading ?? null,
  });
}
const revMark = (c, i) => { const r = c.revisions?.[i]; return r ? {author: r.author, date: r.date, id: i} : {author: '', date: '', id: null}; };

function propsKind(c, props, blank) {
  const rp = resolvePara(c.styles, props || {});
  const st = props?.style ?? 'Normal';
  const ch = chain(c.styles, st);
  let kind = 'normal', level = 0;
  if (rp.outlineLevel !== null && rp.outlineLevel !== undefined && rp.outlineLevel < 9) { kind = 'heading'; level = Math.min(6, rp.outlineLevel + 1); }
  else if (ch.some(s => s.id === 'Title')) kind = 'title';
  else if (ch.some(s => s.id === 'Quote' || s.id === 'IntenseQuote')) kind = 'quote';
  else if (isCodeStyle(c, st)) kind = 'code';
  else if (blank && borderVisible(rp.borders?.bottom)) kind = 'rule';
  let list = null;
  const n = rp.numbering;
  if (n) {
    const lv = levelOf(c.numbering, n.num, n.level);
    if (lv) list = {ordered: !['bullet', 'none'].includes(lv.format), level: Math.min(8, n.level), start: lv.start ?? 1};
  }
  return [kind, level, list];
}
/** Paragraph kind, heading level and list membership of a content paragraph (para_kind). */
export function paraKind(c, p) {
  const blank = !P.plainText(p).trim() && (p.objects ?? []).every(P.isMarker);
  return propsKind(c, p.props, blank);
}
function mediaExt(key, b64) {
  const t = sniffImage(base64Decode(String(b64).slice(0, 64)) ?? []);
  if (t) return t;
  const e = String(key).split('.').pop();
  return e && e !== key && e.length <= 5 ? e.toLowerCase() : 'png';
}

/** A content paragraph as flow paragraphs: a page break inside the text starts a new one (flow_paras). */
export function flowParas(c, p, tracked = false) {
  const [kind, level, list] = paraKind(c, p);
  const done = [];
  const pp = p.props || {};
  const borders = kind === 'rule' ? null : bordersAnyVisible(pp.borders) ? pp.borders : null;
  const mk = (pageBreak, l) => para(kind, {level, list: l, align: pp.align ?? null, pageBreak, keepNext: !!pp.keepNext, borders});
  let out = mk(!!pp.pageBreakBefore, list);
  const inCode = kind === 'code';
  let k = 0;
  const objs = p.objects ?? [];
  for (const [s, e, props] of P.runRanges(p)) {
    const text = p.text.slice(s, e);
    const hidden = !!props.hidden || props.del !== undefined && props.del !== null;
    const hiddenText = !!props.hidden || (props.del !== undefined && props.del !== null && !tracked);
    const f = fmtOf(c, props, inCode);
    if (tracked) {
      if (props.ins !== undefined && props.ins !== null) f.ins = revMark(c, props.ins);
      if (props.del !== undefined && props.del !== null) f.del = revMark(c, props.del);
      if (props.fmtChange) f.fmtChange = {mark: revMark(c, props.fmtChange.rev), old: fmtOf(c, props.fmtChange.old, inCode)};
    }
    let buf = '';
    const flush = () => { if (buf) { pushText(out, buf, f); buf = ''; } };
    for (const ch of text) {
      if (ch === P.PAGE_BREAK) {
        if (!hidden) {
          pushText(out, buf, f); buf = '';
          const next = mk(true, null);
          const prev = out;
          out = next;
          if (!prev.inlines.length) { out.pageBreak = out.pageBreak || prev.pageBreak; out.list = prev.list; } else done.push(prev);
        }
        continue;
      }
      if (ch !== OBJ) { buf += ch; continue; }
      const o = objs[k++];
      if (hidden || P.objectFrame(o)?.[2]?.hidden) continue;
      if (!o) continue;
      if (o.type === 'image') {
        flush();
        const alt = P.isDecorative(o) ? '' : o.alt ?? '';
        const data = c.media?.[o.media];
        if (data) out.inlines.push({t: 'image', img: {b64: data, ext: mediaExt(o.media, data), w: o.w, h: o.h, alt}});
        else if (alt) buf += alt;
      } else if (o.type === 'graphic') {
        flush();
        if (String(o.alt ?? '').trim()) out.inlines.push({t: 'figure', alt: o.alt});
      } else if (o.type === 'equation') {
        flush();
        out.inlines.push({t: 'equation', linear: o.linear ?? '', display: !!o.display});
      } else if (o.type === 'ruby') {
        flush();
        out.inlines.push({t: 'ruby', base: o.base ?? '', ruby: o.ruby ?? '', fmt: {...f}});
      } else if (o.type === 'bookmarkStart' && o.name !== '_GoBack') {
        flush();
        out.inlines.push({t: 'anchor', name: o.name});
      } else buf += P.objectPlainText(o);
    }
    if (!hiddenText) pushText(out, buf, f);
  }
  if (tracked) {
    const m = p.mark || {};
    if (m.ins !== undefined && m.ins !== null) out.markIns = revMark(c, m.ins);
    if (m.del !== undefined && m.del !== null) out.markDel = revMark(c, m.del);
    if (pp.fmtChange) {
      const [k2, l2, li2] = propsKind(c, pp.fmtChange.old, !out.inlines.length);
      out.fmtChange = {mark: revMark(c, pp.fmtChange.rev), old: para(k2, {level: l2, list: li2, align: pp.fmtChange.old?.align ?? null, pageBreak: !!pp.fmtChange.old?.pageBreakBefore})};
    }
  }
  if (p.section) out.section = p.section;
  done.push(out);
  return done;
}
function flowBlocks(c, blocks, depth, tracked) {
  const out = [];
  for (const b of blocks) {
    if (b.kind === 'para') out.push(...flowParas(c, b, tracked));
    else if (depth < MAX_DEPTH) out.push(flowTable(c, b, depth, tracked));
    else for (const r of b.rows) for (const cl of r.cells) out.push(...flowBlocks(c, cl.blocks, depth, tracked));
  }
  return out;
}
function flowTable(c, t, depth, tracked) {
  const look = tableLook(t.props);
  const gridCol = (ri, ci) => { const r = t.rows[ri]; let g = r.props?.gridBefore ?? 0; for (let i = 0; i < ci; i++) g += clampSpan(r.cells[i].props?.span); return g; };
  const cellAtGrid = (ri, g) => { const r = t.rows[ri]; if (!r) return -1; let x = r.props?.gridBefore ?? 0; for (let i = 0; i < r.cells.length; i++) { if (x === g) return i; x += clampSpan(r.cells[i].props?.span); if (x > g) return -1; } return -1; };
  const rows = t.rows.map((r, ri) => {
    const header = !!r.props?.header || (ri === 0 && look.headerRow && t.rows.length > 1);
    return r.cells.map((cl, ci) => {
      let rowspan = 1;
      if (cl.props?.vmerge === 'restart') {
        const g = gridCol(ri, ci);
        for (let k2 = ri + 1; k2 < t.rows.length; k2++) { const i = cellAtGrid(k2, g); if (i < 0 || t.rows[k2].cells[i].props?.vmerge !== 'continue') break; rowspan++; }
      }
      return cell({blocks: flowBlocks(c, cl.blocks, depth + 1, tracked), colspan: clampSpan(cl.props?.span), rowspan, covered: cl.props?.vmerge === 'continue',
        header, shading: cl.props?.shading ?? null, borders: cl.props?.borders ?? null, valign: cl.props?.valign ?? null});
    });
  });
  const borderless = !t.props?.style && !bordersAnyVisible(t.props?.borders) && t.rows.every(r => r.cells.every(cl => !bordersAnyVisible(cl.props?.borders)));
  return ftable({rows, widths: [...(t.grid ?? [])], borderless});
}
/** The document body as a flow (from_doc); `tracked` keeps tracked changes (from_doc_tracked). */
export function fromContent(c, tracked = false) {
  const core = c.core || {};
  const blocks = flowBlocks(c, c.body.chunks.flat(), 0, tracked);
  return {blocks, meta: meta({title: core.title ?? '', author: core.creator ?? '', subject: core.subject ?? '', keywords: core.keywords ?? '',
    description: core.description ?? '', created: core.created ?? ''})};
}

/** List labels in document order ("1.", "a.", "•") by a per-level counter (ListCounter). */
export class ListCounter {
  constructor() { this.reset(); }
  reset() { this.counts = Array(9).fill(0); this.ordered = Array(9).fill(false); }
  next(li) {
    const lv = Math.min(8, li.level);
    if (this.ordered[lv] !== li.ordered) { this.ordered[lv] = li.ordered; this.counts[lv] = 0; }
    if (this.counts[lv] === 0) this.counts[lv] = Math.max(0, (li.start ?? 1) - 1);
    const n = ++this.counts[lv];
    for (let d = lv + 1; d < 9; d++) this.counts[d] = 0;
    return n;
  }
  label(li) {
    const n = this.next(li);
    if (!li.ordered) return ['•', '◦', '▪'][li.level % 3];
    return li.level % 3 === 0 ? `${n}.` : li.level % 3 === 1 ? `${letters(n)}.` : `${roman(n)}.`;
  }
}

// --- comments.rs -----------------------------------------------------------------------------

const MAX_QUOTE = 200, MAX_COMMENTS = 5000, MAX_REPLIES = 200, MAX_PARENT_CHAIN = 64;
const authorOf = a => (String(a ?? '').trim() ? String(a).trim() : 'Author');
function partPlain(c, part) {
  const pt = c.parts?.[part];
  if (!pt) return '';
  return pt.blocks.filter(b => b.kind === 'para').map(P.plainText).join('\n').split(/\s+/).filter(Boolean).join(' ');
}
/** The document's comments in anchor order, with the text they comment on and their replies (notes). */
export function commentNotes(c) {
  const comments = c.comments || {};
  const ids = Object.keys(comments).map(Number);
  if (!ids.length) return [];
  const root = id => { let cur = id; for (let i = 0; i < MAX_PARENT_CHAIN; i++) { const p = comments[cur]?.parent; if (p !== null && p !== undefined && p !== cur && comments[p]) cur = p; else break; } return cur; };
  const order = [], seen = new Set(), quotes = new Map();
  let open = [];
  const d = new Document(c);
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    let k = 0;
    for (const ch of p.text) {
      if (ch === OBJ) {
        const o = p.objects?.[k++];
        if (o?.type === 'commentStart') { if (!seen.has(o.id)) { seen.add(o.id); order.push(o.id); } if (!open.includes(o.id) && open.length < 64) open.push(o.id); }
        else if (o?.type === 'commentEnd') open = open.filter(x => x !== o.id);
        continue;
      }
      for (const id of open) { const q = quotes.get(id) ?? ''; if ([...q].length <= MAX_QUOTE) quotes.set(id, q + ch); }
    }
    for (const id of open) quotes.set(id, (quotes.get(id) ?? '') + ' ');
  }
  for (const id of [...ids].sort((a, b) => a - b)) if (!seen.has(id)) { seen.add(id); order.push(id); }
  const sorted = ids.sort((a, b) => a - b);
  const replyIds = new Map();
  for (const id of sorted) { const r = root(id); if (r !== id) { const v = replyIds.get(r) ?? []; if (v.length < MAX_REPLIES) v.push(id); replyIds.set(r, v); } }
  const out = [];
  const tops = order.filter(id => comments[id] && root(id) === id).slice(0, MAX_COMMENTS);
  for (const id of tops) {
    const cm = comments[id];
    let quote = (quotes.get(id) ?? '').split(/\s+/).filter(Boolean).join(' ');
    if ([...quote].length > MAX_QUOTE) quote = `${[...quote].slice(0, MAX_QUOTE).join('')}…`;
    const replies = (replyIds.get(id) ?? []).map(r => [authorOf(comments[r].author), partPlain(c, comments[r].part)]);
    out.push({author: authorOf(cm.author), quote, text: partPlain(c, cm.part), replies});
  }
  return out;
}

export {defaultSection, OBJ};
