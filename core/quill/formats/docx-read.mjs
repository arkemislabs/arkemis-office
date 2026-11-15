// DOCX (WordprocessingML) → Quill schema-2 content: what File > Open reads from a .docx/.docm/
// .dotx/.dotm, and what File > Save writes back through docx-write.mjs.
//
// Translated from wordcraft crates/docx (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   src/xml.rs            the bounded namespace-canonicalising XML tree (El, parse, esc, W)
//   src/units.rs          lenient OOXML numbers and universal measures
//   src/package.rs        the zip package, relationships, content types, part-name resolution
//   src/read.rs           the reader driver (part order, moves, linked text boxes)
//   src/read/props.rs     w:rPr / w:pPr / w:tblPr / w:trPr / w:tcPr / w:sectPr readers, theme colours and fonts
//   src/read/styles.rs    styles.xml and numbering.xml
//   src/read/parts.rs     revisions, media, headers/footers, theme, colour mapping, font table
//   src/read/meta.rs      settings, footnotes/endnotes and separators, comments (+ commentsExtended/Ids/Extensible), core and app
//                         properties, read_bibliography (bibliography sources from customXml; the b:Sources parser itself is
//                         _docx-bibliography.mjs, from src/bibliography.rs)
//   src/read/toc.rs       unstyle_toc_links, toc_control_to_toc, toc_field_to_heading, field_to_heading, toc_range_end: a TOC
//                         written by Word or by us reads back into the engine's shape (heading with an empty TOC field + entries)
//   src/read/story.rs, story/blocks.rs, story/runs.rs, story/fields.rs   stories, paragraphs, runs, fields, tables, markers
//   src/read/sdt.rs       content controls
//   src/read/story/drawing.rs (pictures: wp:inline / wp:anchor / pic:pic, anchors, wrap, alt text, crop, spin)
//   src/read/story/vml.rs (vml_watermark: Word's text watermark in a header), read/math.rs (read_math_pr)
//   src/custom.rs         custom document properties
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What differs from upstream, and why (docs/behaviour-fidelity.md):
// * Offsets and run lengths are UTF-16 code units (the model's unit), not UTF-8 bytes.
// * Drawings the model has no translation for yet (DrawingML shapes, text boxes, groups, canvases,
//   charts, SmartArt, VML, OLE objects, ink, Office 2016 charts) are kept whole as `opaque` docx
//   objects together with every package part they reference (upstream's `keep_embedded`), so a
//   save writes them back byte-for-byte equivalent; their plain text (a text box's words) is kept
//   for search and plain-text export. Equations keep their OMML (`omml`) beside the linear text.
// * Parts the reader does not model (font table, web settings, glossary, custom XML, people,
//   thumbnails, VBA projects and their related parts) are kept in `passthrough` with a manifest of
//   their relationships and content types (upstream's `keep_unmodelled`), so saving re-relates them.
//   A custom XML part read as bibliography sources is not kept (upstream's `keep_custom_xml`): the
//   writer writes the sources' own part, so a saved file never holds two bibliographies.
// * Paragraph ids come from `w14:paraId` when it is a valid, unused id (architecture 14.2).
// No DOM; jszip is the one dependency (allowed in core/*/formats, architecture 5.3).

import JSZip from 'jszip';
import {ZipBudget, ZipLimitError, ZIP_XML_PART, ZIP_PART, ZIP_TOTAL} from '../../common/lib/zip-guard.mjs';
import {createContent, defaultSettings, defaultCore, comment as newComment, defaultWatermark, watermarkFrame} from '../model/content.mjs';
import {defaultSection, sectionOf} from '../model/section.mjs';
import {bodyFromBlocks} from '../model/body.mjs';
import {Document, BODY} from '../model/document.mjs';
import {emptyStyleSheet, setTablePart, emptyPartFormat, chain, addDefaultGallery, getStyle, TABLE_PARTS} from '../model/styles.mjs';
import {level as newLevel} from '../model/numbering.mjs';
import {numFormatFromOoxml} from '../model/numfmt.mjs';
import {
  parseRgb, highlightFromOoxml, underlineFromOoxml, borderStyleFromOoxml, ligaturesFromOoxml, textDirectionFromOoxml, rgbWithLum,
  charIsEmpty, paraIsEmpty, charFormatting, paraFormatting, charMinus, defaultTableLook, textVertFromOoxml, valignFromAnchor,
} from '../model/props.mjs';
import {OBJ} from '../model/text.mjs';
import {defaultFloat, capAlt, wrapTextFromOoxml, floatAlignFromOoxml, RUBY_ALIGNS, rubyRaise} from '../model/para.mjs';
import * as P from '../model/para.mjs';
import {controlLockFromOoxml, CHECKED, UNCHECKED, MAX_CONTROL_TEXT, MAX_LIST_ITEMS, contentControl, controlEvents, pairEvents} from '../model/ranges.mjs';
import {parse as parseBibliography, Seen, MAX_SOURCES} from './_docx-bibliography.mjs';
import {readFill, readEffects} from './_docx-shape-fx.mjs';
import {readTextEffect} from './_docx-text-fx.mjs';
import {effectsExtent} from '../model/effects.mjs';
import {writtenTocSpan} from './docx-write.mjs';
import {ID_RE, newId} from '../model/ids.mjs';
import {normalizeDegrees, Spin} from '../lib/geom.mjs';
import {sanitizedFreeform} from '../model/freeform.mjs';
import {write as writePath} from '../../prism/lib/points.mjs';
import {readChartSpec} from '../lib/chart-part.mjs';
import {readSmartArt} from '../lib/docx-smartart.mjs';
import {presetOfKind} from '../lib/shape-presets.mjs';
import {ommlToLinear, ommlJustification} from '../lib/omml.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/docx/src/read.rs']});

// =============================================================================================
// xml.rs
// =============================================================================================

export const MAX_DEPTH = 256;
export const MAX_ELEMENTS = 8_000_000;
export const MAX_ATTRS = 1024;

/** Known namespaces and the canonical prefix used for them (read and write). */
export const NAMESPACES = Object.freeze([
  ['w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'],
  ['r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
  ['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'],
  ['a', 'http://schemas.openxmlformats.org/drawingml/2006/main'],
  ['c', 'http://schemas.openxmlformats.org/drawingml/2006/chart'],
  ['pic', 'http://schemas.openxmlformats.org/drawingml/2006/picture'],
  ['mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006'],
  ['w14', 'http://schemas.microsoft.com/office/word/2010/wordml'],
  ['wpi', 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk'],
  ['w15', 'http://schemas.microsoft.com/office/word/2012/wordml'],
  ['wp14', 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing'],
  ['wps', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'],
  ['wpg', 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup'],
  ['wpc', 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas'],
  ['dgm', 'http://schemas.openxmlformats.org/drawingml/2006/diagram'],
  ['dsp', 'http://schemas.microsoft.com/office/drawing/2008/diagram'],
  ['m', 'http://schemas.openxmlformats.org/officeDocument/2006/math'],
  ['v', 'urn:schemas-microsoft-com:vml'],
  ['o', 'urn:schemas-microsoft-com:office:office'],
  ['w10', 'urn:schemas-microsoft-com:office:word'],
  ['cx', 'http://schemas.microsoft.com/office/drawing/2014/chartex'],
  ['cx1', 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex'],
  ['cx2', 'http://schemas.microsoft.com/office/drawing/2015/10/21/chartex'],
  ['cx3', 'http://schemas.microsoft.com/office/drawing/2016/5/9/chartex'],
  ['cx4', 'http://schemas.microsoft.com/office/drawing/2016/5/10/chartex'],
  ['cx5', 'http://schemas.microsoft.com/office/drawing/2016/5/11/chartex'],
  ['cx6', 'http://schemas.microsoft.com/office/drawing/2016/5/12/chartex'],
  ['cx7', 'http://schemas.microsoft.com/office/drawing/2016/5/13/chartex'],
  ['cx8', 'http://schemas.microsoft.com/office/drawing/2016/5/14/chartex'],
]);
export const DECORATIVE_EXT = '{C183D7F6-B498-43B3-948B-1728B52AA6E4}';
export const DECORATIVE_NS = 'http://schemas.microsoft.com/office/drawing/2017/decorative';
const OTHER_NAMESPACES = [
  ['b', 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'],
  ['rel', 'http://schemas.openxmlformats.org/package/2006/relationships'],
  ['ct', 'http://schemas.openxmlformats.org/package/2006/content-types'],
  ['cp', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'],
  ['dc', 'http://purl.org/dc/elements/1.1/'],
  ['dcterms', 'http://purl.org/dc/terms/'],
  ['xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
  ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ['ep', 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'],
  ['op', 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'],
  ['vt', 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'],
];
const STRICT_NS = [
  ['w', 'http://purl.oclc.org/ooxml/wordprocessingml/main'],
  ['r', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  ['wp', 'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing'],
  ['a', 'http://purl.oclc.org/ooxml/drawingml/main'],
  ['pic', 'http://purl.oclc.org/ooxml/drawingml/picture'],
  ['m', 'http://purl.oclc.org/ooxml/officeDocument/math'],
];
const PREFIX_BY_URI = new Map();
for (const [p, u] of [...NAMESPACES, ...OTHER_NAMESPACES, ...STRICT_NS]) if (!PREFIX_BY_URI.has(u)) PREFIX_BY_URI.set(u, p);
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function prefixFor(uri, extra) {
  for (const [p, u] of extra) if (u === uri) return p;
  return PREFIX_BY_URI.get(uri) ?? '?';
}
const REQUIREMENT_EXTRA = new Map([
  ['http://schemas.microsoft.com/office/drawing/2010/main', 'a14'],
  ['http://schemas.microsoft.com/office/word/2015/wordml/symex', 'w16se'],
  ['http://schemas.microsoft.com/office/word/2016/wordml/cid', 'w16cid'],
  ['http://schemas.microsoft.com/office/word/2018/wordml', 'w16'],
  ['http://schemas.microsoft.com/office/word/2018/wordml/cex', 'w16cex'],
  ['http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash', 'w16sdtdh'],
]);
function requirementPrefix(uri) {
  const p = prefixFor(uri, []);
  return p !== '?' ? p : REQUIREMENT_EXTRA.get(uri) ?? '?';
}

const REL_ELEMENTS = new Set(['a:blip', 'a:hlinkClick', 'a:hlinkHover', 'a:audioFile', 'a:videoFile', 'c:chart', 'cx:chart', 'dgm:relIds', 'o:OLEObject',
  'v:fill', 'v:imagedata', 'w:attachedTemplate', 'w:control', 'w:embedBold', 'w:embedBoldItalic', 'w:embedItalic', 'w:embedRegular',
  'w:footerReference', 'w:headerReference', 'w:hyperlink', 'w:object', 'w:subDoc', 'w14:contentPart']);
const REL_ALIASES = new Set(['id', 'embed', 'link', 'pict', 'dm', 'lo', 'qs', 'cs', 'relid']);
/** Is attribute `k` of element `element` a relationship id? */
export const isRelAttr = (element, k) => k.startsWith('r:') || k === 'o:relid' || (REL_ELEMENTS.has(element) && REL_ALIASES.has(k));

export class DocxError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; this.name = 'DocxError'; }
}

/** An element with canonical-prefixed name and attributes; kids are El or string. */
export class El {
  constructor(name, attrs = [], kids = []) { this.name = name; this.attrs = attrs; this.kids = kids; }
  /** Attribute by canonical name, falling back to an unqualified attribute of the same local name. */
  attr(name) {
    for (const [k, v] of this.attrs) if (k === name) return v;
    const i = name.lastIndexOf(':');
    if (i >= 0) {
      const local = name.slice(i + 1);
      for (const [k, v] of this.attrs) if (k === local) return v;
    }
    return null;
  }
  *els() { for (const k of this.kids) if (typeof k !== 'string') yield k; }
  elList() { return this.kids.filter(k => typeof k !== 'string'); }
  child(name) { for (const k of this.kids) if (typeof k !== 'string' && k.name === name) return k; return null; }
  children(name) { return this.kids.filter(k => typeof k !== 'string' && k.name === name); }
  /** `w:val` of a child. */
  childVal(name) { return this.child(name)?.attr('w:val') ?? null; }
  /** Direct text content. */
  text() { let s = ''; for (const k of this.kids) if (typeof k === 'string') s += k; return s; }
  /** All descendant text (depth-bounded). */
  deepText() {
    let s = '';
    const go = (e, d) => { if (d > MAX_DEPTH) return; for (const k of e.kids) { if (typeof k === 'string') s += k; else go(k, d + 1); } };
    go(this, 0);
    return s;
  }
  /** First descendant with this name (depth first, bounded). */
  find(name) {
    const go = (e, d) => {
      if (d > MAX_DEPTH) return null;
      for (const c of e.kids) {
        if (typeof c === 'string') continue;
        if (c.name === name) return c;
        const f = go(c, d + 1);
        if (f) return f;
      }
      return null;
    };
    return go(this, 0);
  }
  /** The element as XML with canonical prefixes; unknown-namespace names are dropped. */
  toXml() {
    const out = [];
    const go = (e, d) => {
      if (d > MAX_DEPTH || e.name.startsWith('?:')) return;
      out.push('<', e.name);
      for (const [k, v] of e.attrs) { if (k.startsWith('?:')) continue; out.push(' ', k, '="', esc(v), '"'); }
      if (!e.kids.length) { out.push('/>'); return; }
      out.push('>');
      for (const k of e.kids) { if (typeof k === 'string') out.push(esc(k)); else go(k, d + 1); }
      out.push('</', e.name, '>');
    };
    go(this, 0);
    return out.join('');
  }
  local() { const i = this.name.lastIndexOf(':'); return i >= 0 ? this.name.slice(i + 1) : this.name; }
}

/** UTF-16 LE/BE text with a BOM as a string (null without one). */
export function utf16ToString(bytes) {
  if (bytes.length < 2) return null;
  let le;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) le = true;
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) le = false;
  else return null;
  const n = (bytes.length - 2) >> 1;
  const units = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const a = bytes[2 + 2 * i], b = bytes[3 + 2 * i];
    units[i] = le ? a | (b << 8) : (a << 8) | b;
  }
  let s = '';
  for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, units.subarray(i, i + 8192));
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

const utf8 = new TextDecoder('utf-8');
/** Bytes (or a string) as XML text: UTF-16 with a BOM transcoded, a UTF-8 BOM stripped. */
export function xmlText(bytes) {
  if (typeof bytes === 'string') return bytes.charCodeAt(0) === 0xfeff ? bytes.slice(1) : bytes;
  const u16 = utf16ToString(bytes);
  if (u16 !== null) return u16;
  const s = utf8.decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

const PREDEFINED = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
function decodeRefs(s, strict) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
      if (strict) throw new DocxError('Xml', 'a character reference is not valid');
      return '';
    }
    const v = PREDEFINED[e];
    if (v !== undefined) return v;
    if (strict) throw new DocxError('Xml', 'an entity is not defined');
    return '';
  });
}

const NAME_END = /[\s/>]/;

/**
 * Parse XML into its root El (xml.rs `parse_with`): canonical prefixes by namespace URI, bounded
 * depth, element and attribute counts. `strict`: a mismatched end tag, a second root, an element
 * left open or an undefined entity is an error (the main document part).
 */
export function parseXml(input, {strict = false, extra = []} = {}) {
  const s = xmlText(input);
  const stack = [];
  const scopes = [new Map([['xml', XML_NS]])];
  let root = null, count = 0, i = 0;
  const n = s.length;
  const resolve = prefix => { for (let k = scopes.length - 1; k >= 0; k--) { const u = scopes[k].get(prefix); if (u !== undefined) return u; } return undefined; };
  const attach = el => { if (stack.length) stack[stack.length - 1].kids.push(el); else if (!root) root = el; };
  const pushText = t => {
    if (!t || !stack.length) return;
    const top = stack[stack.length - 1];
    const last = top.kids[top.kids.length - 1];
    if (typeof last === 'string') top.kids[top.kids.length - 1] = last + t; else top.kids.push(t);
  };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { if (stack.length) pushText(decodeRefs(s.slice(i), strict)); break; }
    if (lt > i && stack.length) pushText(decodeRefs(s.slice(i, lt), strict));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) { if (strict) throw new DocxError('Xml', 'comment not closed'); break; } i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); if (e < 0) { if (strict) throw new DocxError('Xml', 'CDATA not closed'); break; } pushText(s.slice(lt + 9, e)); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt + 2); if (e < 0) throw new DocxError('Xml', 'processing instruction not closed'); i = e + 2; continue; }
    if (s.startsWith('<!', lt)) {
      let depth = 0, k = lt + 2;
      for (; k < n; k++) { const c = s[k]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      i = k + 1;
      continue;
    }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt + 2);
      if (e < 0) throw new DocxError('Xml', 'end tag not closed');
      const qname = s.slice(lt + 2, e).trim();
      i = e + 1;
      const el = stack.pop();
      scopes.pop();
      if (!el) { if (strict) throw new DocxError('Xml', 'unexpected end tag'); continue; }
      if (strict && el._q !== qname) throw new DocxError('Xml', `expected </${el._q}>, found </${qname}>`);
      delete el._q;
      attach(el);
      if (!strict && root && !stack.length) break;
      continue;
    }
    // A start tag: name, then attributes up to `>` or `/>` (quoted values may hold `>`).
    let k = lt + 1;
    while (k < n && !NAME_END.test(s[k])) k++;
    const qname = s.slice(lt + 1, k);
    if (!qname) throw new DocxError('Xml', 'empty element name');
    const raw = [];
    let empty = false;
    for (;;) {
      while (k < n && /\s/.test(s[k])) k++;
      if (k >= n) throw new DocxError('Xml', 'start tag not closed');
      if (s[k] === '>') { k++; break; }
      if (s[k] === '/' && s[k + 1] === '>') { empty = true; k += 2; break; }
      const a0 = k;
      while (k < n && !/[\s=/>]/.test(s[k])) k++;
      const an = s.slice(a0, k);
      while (k < n && /\s/.test(s[k])) k++;
      let av = '';
      if (s[k] === '=') {
        k++;
        while (k < n && /\s/.test(s[k])) k++;
        const q = s[k];
        if (q === '"' || q === "'") { const e = s.indexOf(q, k + 1); if (e < 0) throw new DocxError('Xml', 'attribute value not closed'); av = s.slice(k + 1, e); k = e + 1; }
        else { const a1 = k; while (k < n && !/[\s>]/.test(s[k]) && !(s[k] === '/' && s[k + 1] === '>')) k++; av = s.slice(a1, k); }
      } else if (!an) { k++; continue; }
      if (raw.length >= MAX_ATTRS) throw new DocxError('Limit', 'too many attributes on one element');
      raw.push([an, av]);
    }
    i = k;
    if (strict && root && !stack.length) throw new DocxError('Xml', 'more than one root element');
    if (++count > MAX_ELEMENTS) throw new DocxError('Limit', 'too many XML elements');
    const scope = new Map();
    for (const [an, av] of raw) {
      if (an === 'xmlns') scope.set('', decodeRefs(av, false));
      else if (an.startsWith('xmlns:')) scope.set(an.slice(6), decodeRefs(av, false));
    }
    scopes.push(scope);
    const colon = qname.indexOf(':');
    const ePrefix = colon >= 0 ? qname.slice(0, colon) : '';
    const eLocal = colon >= 0 ? qname.slice(colon + 1) : qname;
    const eUri = resolve(ePrefix);
    const name = eUri !== undefined && eUri !== '' ? `${prefixFor(eUri, extra)}:${eLocal}` : eLocal;
    const el = new El(name, [], []);
    for (const [an, av] of raw) {
      if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
      const c = an.indexOf(':');
      let aname = an;
      if (c >= 0) {
        const u = resolve(an.slice(0, c));
        aname = u !== undefined ? `${prefixFor(u, extra)}:${an.slice(c + 1)}` : an.slice(c + 1);
      }
      let val = decodeRefs(av.replace(/[\t\n\r]/g, ' '), strict);
      if (name === 'mc:Choice' && aname === 'Requires') {
        const req = val.split(/\s+/).filter(Boolean).slice(0, 65);
        val = req.length > 64 || req.some(p => p.length > 128) ? '?' : req.map(p => { const u = resolve(p); return u === undefined ? '?' : requirementPrefix(u); }).join(' ');
      }
      el.attrs.push([aname, val]);
    }
    if (empty) { scopes.pop(); attach(el); if (!strict && root && !stack.length) break; }
    else {
      if (stack.length >= MAX_DEPTH) throw new DocxError('Limit', 'XML nesting too deep');
      el._q = qname;
      stack.push(el);
    }
  }
  if (strict && stack.length) throw new DocxError('Xml', 'an element is not closed');
  while (stack.length) { const el = stack.pop(); delete el._q; attach(el); }
  if (!root) throw new DocxError('Xml', 'no root element');
  return root;
}

const xmlCharOk = c => c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000;
/** Escape text for element content or attribute values (drops characters XML can't carry). */
export function esc(s) {
  s = String(s);
  let o = '';
  for (const ch of s) {
    switch (ch) {
      case '&': o += '&amp;'; break;
      case '<': o += '&lt;'; break;
      case '>': o += '&gt;'; break;
      case '"': o += '&quot;'; break;
      case "'": o += '&apos;'; break;
      case '\t': o += '&#9;'; break;
      case '\n': o += '&#10;'; break;
      case '\r': o += '&#13;'; break;
      default: if (xmlCharOk(ch.codePointAt(0))) o += ch;
    }
  }
  return o;
}

/** A string-building XML writer (xml.rs `W`). */
export class W {
  constructor(decl = true) { this.parts = decl ? ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'] : []; }
  _attrs(attrs) { for (const [k, v] of attrs) if (v !== null && v !== undefined) this.parts.push(' ', k, '="', esc(v), '"'); }
  open(name, attrs = []) { this.parts.push('<', name); this._attrs(attrs); this.parts.push('>'); }
  empty(name, attrs = []) { this.parts.push('<', name); this._attrs(attrs); this.parts.push('/>'); }
  close(name) { this.parts.push('</', name, '>'); }
  text(t) { this.parts.push(esc(t)); }
  leaf(name, attrs, t) { this.open(name, attrs); this.text(t); this.close(name); }
  val(name, v) { this.empty(name, [['w:val', v]]); }
  raw(s) { this.parts.push(s); }
  toString() { return this.parts.join(''); }
  bytes() { return new TextEncoder().encode(this.toString()); }
}

/** `xmlns:` declarations for the body-part namespaces, plus `mc:Ignorable`. */
export function bodyNs() {
  const v = NAMESPACES.map(([p, u]) => [`xmlns:${p}`, u]);
  v.push(['mc:Ignorable', 'w14 w15 wp14']);
  return v;
}

// =============================================================================================
// units.rs
// =============================================================================================

export const MAX_LEN_PT = 14_400;
// Upstream rounds to f32; the schema-2 model holds doubles (its built-in values are 1.15, 43.2, ...),
// so measures stay doubles here and 276/240 reads back as the 1.15 the model wrote.

/** A number or universal measure (`1in`, `2.5cm`, `12pt`…) in points; `perPt` file units per point. */
export function measure(s, perPt) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t || t.length > 40) return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  let pt;
  switch (m[2].trim().toLowerCase()) {
    case '': pt = v / perPt; break;
    case 'pt': pt = v; break;
    case 'in': pt = v * 72; break;
    case 'cm': pt = v * 72 / 2.54; break;
    case 'mm': pt = v * 72 / 25.4; break;
    case 'pc': case 'pi': pt = v * 12; break;
    case 'px': pt = v * 0.75; break;
    case 'emu': pt = v / 12_700; break;
    default: return null;
  }
  return Number.isFinite(pt) ? Math.max(-MAX_LEN_PT, Math.min(MAX_LEN_PT, pt)) : null;
}
/** `w:line` under `lineRule="auto"`: the multiple of single spacing. */
export function lineMultiple(s) {
  const t = String(s ?? '').trim();
  const measured = /[A-Za-z]$/.test(t);
  const v = measure(t, 240);
  return v === null ? null : measured ? v * 20 / 240 : v;
}
/** Plain integer (accepts decimals, rounds). */
export function int(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t || t.length > 40) return null;
  if (/^[+-]?\d+$/.test(t)) return Number(t);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? Math.round(v) : null;
}
export const u32Of = s => { const v = int(s); return v === null ? null : Math.max(0, Math.min(0xffffffff, v)); };
/** Twips attribute → points. */
export const tw = (e, attr) => measure(e?.attr(attr), 20);
/** ST_OnOff: absent `w:val` = on; 0/false/off = off. */
export const onOff = e => { const v = e.attr('w:val'); return v === null || !['0', 'false', 'off', 'False', 'FALSE'].includes(v.trim()); };
/** A plain `bool` upstream field (serde skips false): stored only when true, so absent = false. */
/** settings.xml `m:mathPr` (read/math.rs read_math_pr): equation line breaking. */
export function readMathPr(e) {
  const val = n => e.child(n)?.attr('m:val') ?? null;
  const on = n => { const c = e.child(n); if (!c) return false; const v = c.attr('m:val'); return v === null || !['0', 'false', 'off', 'False', 'FALSE'].includes(v.trim()); };
  const bin = val('m:brkBin'), sub = val('m:brkBinSub');
  const m = {brkBin: bin === 'after' ? 'after' : bin === 'repeat' ? 'repeat' : 'before', brkBinSub: sub === '-+' ? 'minusPlus' : sub === '+-' ? 'plusMinus' : 'minusMinus',
    wrapIndent: 18, wrapRight: on('m:wrapRight')};
  const wi = e.child('m:wrapIndent') ? measure(e.child('m:wrapIndent').attr('m:val'), 20) : null;
  if (wi !== null && Number.isFinite(wi) && wi >= 0) m.wrapIndent = Math.min(wi, 1584);
  return m;
}
// --- read/story/vml.rs: Word's text watermark --------------------------------------------------

/** A declaration of a VML style string (the last one wins). */
export function vmlStyle(style, key) {
  const decls = String(style ?? '').split(';').reverse();
  for (const d of decls) { const i = d.indexOf(':'); if (i >= 0 && d.slice(0, i).trim().toLowerCase() === key.toLowerCase()) return d.slice(i + 1).trim(); }
  return null;
}
/** A textpath style value with one pair of surrounding quotes removed and CSS escapes mapped back. */
export function cssString(v) {
  v = String(v).trim();
  for (const q of ['"', "'"]) if (v.length >= 2 && v.startsWith(q) && v.endsWith(q)) { v = v.slice(1, -1); break; }
  v = v.trim();
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c !== '\\') { out += c; continue; }
    let hex = '';
    while (hex.length < 6 && /[0-9a-fA-F]/.test(v[i + 1] ?? '')) hex += v[++i];
    if (!hex) { if (i + 1 < v.length) out += v[++i]; else out += '\\'; continue; }
    const cp = parseInt(hex, 16);
    if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) out += String.fromCodePoint(cp);
    if (/\s/.test(v[i + 1] ?? '')) i++;
  }
  return out;
}
const VML_NAMED = {black: [0, 0, 0], white: [255, 255, 255], silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128], red: [255, 0, 0],
  maroon: [128, 0, 0], yellow: [255, 255, 0], olive: [128, 128, 0], lime: [0, 255, 0], green: [0, 128, 0], aqua: [0, 255, 255], teal: [0, 128, 128],
  blue: [0, 0, 255], navy: [0, 0, 128], fuchsia: [255, 0, 255], purple: [128, 0, 128], lightgray: [211, 211, 211], darkgray: [169, 169, 169]};
/** A VML colour: rgb(), #rgb, #rrggbb or a colour name (read/shape_style.rs vml_color). */
export function vmlColor(v) {
  const t = String(v ?? '').trim();
  const m = /^rgba?\(([^)]*)\)?/i.exec(t);
  if (m) {
    const nums = m[1].split(',').slice(0, 3).map(x => { x = x.trim(); if (x.endsWith('%')) { const f = Number(x.slice(0, -1)); return Number.isFinite(f) ? Math.round(Math.max(0, Math.min(100, f)) * 2.55) : NaN; } const f = Number(x); return x && Number.isFinite(f) ? Math.round(Math.max(0, Math.min(255, f))) : NaN; });
    if (nums.length === 3 && nums.every(n => !Number.isNaN(n))) return nums;
  }
  const tok = t.split(/\s+/)[0] ?? '';
  const hex = tok.startsWith('#') ? tok.slice(1) : tok;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) return parseRgb([...hex].map(c => c + c).join(''));
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseRgb(hex);
  return VML_NAMED[tok.toLowerCase()] ? [...VML_NAMED[tok.toLowerCase()]] : null;
}
const vmlFraction = v => { const t = String(v).trim(); let n; if (t.endsWith('f')) n = Number(t.slice(0, -1).trim()) / 65_536; else if (t.endsWith('%')) n = Number(t.slice(0, -1).trim()) / 100; else n = Number(t); return t && Number.isFinite(n) ? n : null; };
/**
 * Word's text watermark (Design > Watermark): a VML shape in a header whose v:textpath draws its
 * `string` in the textpath's font-family, filled with the shape's fillcolor, semitransparent when its
 * v:fill has an opacity below 1, diagonal when turned. Only Word's watermark shape (its id), or text
 * placed absolutely and centred both ways, counts; other header WordArt is null.
 */
export function vmlWatermark(shape) {
  const tp = shape.child('v:textpath');
  if (!tp || ['f', 'false', '0'].includes(tp.attr('on') ?? '')) return null;
  const style = shape.attr('style') ?? '';
  const centred = k => (vmlStyle(style, k) ?? '').toLowerCase() === 'center';
  const word = (shape.attr('id') ?? '').startsWith('PowerPlusWaterMarkObject');
  const placed = (vmlStyle(style, 'position') ?? '').toLowerCase() === 'absolute' && centred('mso-position-horizontal') && centred('mso-position-vertical');
  if (!word && !placed) return null;
  const str = tp.attr('string');
  if (str === null) return null;
  const text = [...str].slice(0, 200).join('');
  if (!text.trim()) return null;
  const def = defaultWatermark();
  const fam = vmlStyle(tp.attr('style') ?? '', 'font-family');
  const font = fam !== null ? [...cssString(fam)].slice(0, 100).join('') : '';
  const color = vmlColor(shape.attr('fillcolor')) ?? def.color;
  const op = shape.child('v:fill')?.attr('opacity');
  const opacity = op !== null && op !== undefined ? Math.max(0, Math.min(1, vmlFraction(op) ?? 1)) : 1;
  const len = k => { const v = vmlStyle(style, k); const m = v === null ? null : measure(v, 1); return m !== null && m > 0 ? Math.min(m, 4000) : null; };
  const w = len('width'), h = len('height');
  const rot = (() => { const v = vmlStyle(style, 'rotation'); if (v === null) return 0; const r = v.endsWith('fd') ? Number(v.slice(0, -2)) / 65_536 : Number(v); return Number.isFinite(r) ? r : 0; })();
  const wm = {text, font: font || def.font, color, diagonal: normalizeDegrees(rot) !== 0, semitransparent: opacity < 1};
  if (w !== null && h !== null) wm.size = [w, h];
  return wm;
}
export const setFlag = (o, k, v) => { if (v) o[k] = true; else delete o[k]; };
export const flag = (parent, name) => { const c = parent.child(name); return c ? onOff(c) : null; };
const onOffAttr = (e, name) => { const v = e.attr(name); return v !== null && !['0', 'false', 'off'].includes(v); };

// =============================================================================================
// package.rs
// =============================================================================================

// Security audit H3: tighter than the upstream limits; the cap is enforced while inflating, not from the header.
export const MAX_PART = ZIP_PART;
export const MAX_XML_PART = ZIP_XML_PART;
export const MAX_TOTAL = ZIP_TOTAL;
export const MAX_ENTRIES = 20_000;
const RT_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const RT = Object.freeze({
  OFFICE_DOC: RT_BASE + 'officeDocument',
  CORE: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  APP: RT_BASE + 'extended-properties',
  CUSTOM: RT_BASE + 'custom-properties',
  CUSTOM_XML_PROPS: RT_BASE + 'customXmlProps',
  CHART: RT_BASE + 'chart',
  STYLES: RT_BASE + 'styles',
  NUMBERING: RT_BASE + 'numbering',
  SETTINGS: RT_BASE + 'settings',
  ATTACHED_TEMPLATE: RT_BASE + 'attachedTemplate',
  FONT_TABLE: RT_BASE + 'fontTable',
  THEME: RT_BASE + 'theme',
  FOOTNOTES: RT_BASE + 'footnotes',
  ENDNOTES: RT_BASE + 'endnotes',
  COMMENTS: RT_BASE + 'comments',
  COMMENTS_EX: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  COMMENTS_IDS: 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
  COMMENTS_EXTENSIBLE: 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible',
  HEADER: RT_BASE + 'header',
  FOOTER: RT_BASE + 'footer',
  IMAGE: RT_BASE + 'image',
  HYPERLINK: RT_BASE + 'hyperlink',
  VBA_PROJECT: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
  CUSTOM_XML: RT_BASE + 'customXml',
  GLOSSARY: RT_BASE + 'glossaryDocument',
});
/** Passthrough keys this reader and docx-write.mjs share. */
export const KEPT_PARTS = 'arkemis:kept.parts';
export const EMBEDDED_PARTS = 'arkemis:embedded.parts';
export const APP_KEPT = 'arkemis:app.kept';
export const APP_KEPT_PROPS = Object.freeze(['Template', 'Manager', 'Company', 'HyperlinkBase', 'HyperlinksChanged', 'LinksUpToDate', 'SharedDoc',
  'ScaleCrop']);
/** Placeholder a kept drawing's relationship attribute holds: `@rel:<type>|<package path>|<external 0/1>`. */
export const REL_MARK = '@rel:';

/** Does relationship type `t` match `full` (ignoring the transitional/strict prefix)? */
export const relIs = (t, full) => t === full || t.split('/').pop() === full.split('/').pop();

/** Resolve a relative target against a source directory into a package path. */
export function resolvePath(dir, target) {
  const t = String(target).split('#')[0];
  const parts = t.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}
/** The relative reference from part `from` to part `to`. */
export function relativePath(from, to) {
  const fd = from.split('/').filter(Boolean); fd.pop();
  const tp = to.split('/').filter(Boolean);
  const td = tp.slice(0, -1);
  let common = 0;
  while (common < fd.length && common < td.length && fd[common] === td[common]) common++;
  const out = [...new Array(fd.length - common).fill('..'), ...tp.slice(common)];
  const s = out.join('/');
  return s.split('/')[0].includes(':') ? `./${s}` : s;
}
const splitDir = part => { const p = part.replace(/^\/+/, ''); const i = p.lastIndexOf('/'); return i >= 0 ? [p.slice(0, i), p.slice(i + 1)] : ['', p]; };
export const relsPathOf = part => { const [d, f] = splitDir(part); return d ? `${d}/_rels/${f}.rels` : `_rels/${f}.rels`; };

export class Rels {
  constructor(list = []) { this.list = list; }
  byId(id) { return this.list.find(r => r.id === id) ?? null; }
  byType(full) { return this.list.find(r => relIs(r.kind, full)) ?? null; }
}

/** The decompressed parts of a package (bounded); part names compare case-insensitively. */
export class Package {
  constructor(files) {
    this.files = files;
    this.lower = new Map();
    for (const name of [...files.keys()].sort()) { const l = name.toLowerCase(); if (!this.lower.has(l)) this.lower.set(l, name); }
    this._xml = new Map();
  }
  static async open(bytes, {maxPart = MAX_PART, maxTotal = MAX_TOTAL} = {}) {
    let zip;
    try { zip = await JSZip.loadAsync(bytes); } catch (e) { throw new DocxError('Zip', `not a valid zip package: ${e?.message ?? e}`); }
    const entries = Object.values(zip.files).filter(f => !f.dir);
    if (entries.length > MAX_ENTRIES) throw new DocxError('Limit', `${entries.length} zip entries`);
    const files = new Map();
    const budget = new ZipBudget({total: maxTotal, part: maxPart, xmlPart: Math.min(maxPart, MAX_XML_PART)});
    for (const f of entries) {
      const name = f.name.replace(/^\/+/, '');
      const declared = f._data?.uncompressedSize ?? 0;
      if (declared > maxPart) throw new DocxError('Limit', `part ${name} declares ${declared} bytes`);
      let buf;
      try { buf = await budget.bytes(f, name); } catch (e) {
        if (e instanceof ZipLimitError) throw new DocxError('Limit', `part ${name} decompresses past the size limit`);
        continue;
      }
      files.set(name, buf);
    }
    return new Package(files);
  }
  canonical(name) { return this.lower.get(String(name).replace(/^\/+/, '').toLowerCase()) ?? null; }
  get(name) { const c = this.canonical(name); return c ? this.files.get(c) : null; }
  xml(name, strict = false) {
    const c = this.canonical(name);
    if (!c) return null;
    const key = c + (strict ? '!' : '');
    if (this._xml.has(key)) return this._xml.get(key);
    const el = parseXml(this.files.get(c), {strict});
    this._xml.set(key, el);
    return el;
  }
  /** xml() that logs and returns null for a broken optional part. */
  xmlLenient(name) { try { return this.xml(name); } catch { return null; } }
  rels(part) {
    const [dir] = splitDir(part);
    const root = this.xmlLenient(relsPathOf(part));
    const rels = new Rels();
    if (!root) return rels;
    for (const r of root.elList()) {
      if (r.local() !== 'Relationship') continue;
      const id = r.attr('Id'), target = r.attr('Target');
      if (id === null || target === null) continue;
      const external = (r.attr('TargetMode') ?? '').toLowerCase() === 'external';
      let resolved = target;
      if (!external) { const p = resolvePath(dir, target); resolved = this.canonical(p) ?? p; }
      rels.list.push({id, kind: r.attr('Type') ?? '', target: resolved, external});
    }
    return rels;
  }
}

/** `[Content_Types].xml`: Override by part name, then Default by extension. */
export class ContentTypes {
  constructor(pkg) {
    this.overrides = new Map();
    this.defaults = new Map();
    const root = pkg.xmlLenient('[Content_Types].xml');
    if (!root) return;
    for (const e of root.elList()) {
      const key = e.attr('PartName') ?? e.attr('Extension'), t = e.attr('ContentType');
      if (key === null || t === null) continue;
      const map = e.local() === 'Override' ? this.overrides : this.defaults;
      const k = key.replace(/^\/+/, '').toLowerCase();
      if (!map.has(k)) map.set(k, t);
    }
  }
  of(part) {
    const p = part.replace(/^\/+/, '').toLowerCase();
    if (this.overrides.has(p)) return this.overrides.get(p);
    const i = p.lastIndexOf('.');
    return i >= 0 ? this.defaults.get(p.slice(i + 1)) ?? null : null;
  }
}

// =============================================================================================
// base64 (media and passthrough parts are base64 strings in schema-2 content)
// =============================================================================================

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? '=' : B64[c & 63]);
  }
  return out;
}
export function fromBase64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(s), 'base64'));
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map(k => B64.indexOf(clean[i + k] ?? 'A'));
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < out.length && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
const textBytes = s => new TextEncoder().encode(s);

// =============================================================================================
// read/props.rs
// =============================================================================================

const BIDI_THEME_FALLBACK_FONT = 'Times New Roman';
const LEVEL_ONLY = 0xffffffff;
const SCRIPTS = ['Arab', 'Armn', 'Beng', 'Cans', 'Cher', 'Cyrl', 'Deva', 'Ethi', 'Geor', 'Grek', 'Gujr', 'Guru', 'Hang', 'Hans', 'Hant', 'Hebr', 'Jpan',
  'Khmr', 'Knda', 'Laoo', 'Latn', 'Mlym', 'Mong', 'Mymr', 'Orya', 'Sinh', 'Syrc', 'Taml', 'Telu', 'Tfng', 'Thaa', 'Thai', 'Tibt', 'Uigh', 'Viet', 'Yiii'];
/** The script a language tag is written in, as a theme's `a:font script` names it. */
export function langScript(tag) {
  const parts = String(tag).split(/[-_]/).filter(Boolean);
  const lang = (parts.shift() ?? '').toLowerCase();
  const rest = parts.slice(0, 8);
  for (const p of rest) { const s = SCRIPTS.find(x => x.toLowerCase() === p.toLowerCase()); if (s) return s; }
  const has = r => rest.some(p => r.includes(p.toLowerCase()));
  switch (lang) {
    case 'ar': case 'fa': case 'ur': case 'ps': case 'sd': case 'ckb': case 'prs': return 'Arab';
    case 'ug': return 'Uigh';
    case 'vi': return 'Viet';
    case 'he': case 'yi': return 'Hebr';
    case 'syr': return 'Syrc';
    case 'dv': return 'Thaa';
    case 'th': return 'Thai';
    case 'hi': case 'mr': case 'ne': case 'sa': case 'kok': return 'Deva';
    case 'bn': case 'as': return 'Beng';
    case 'pa': return has(['pk']) ? 'Arab' : 'Guru';
    case 'gu': return 'Gujr';
    case 'or': return 'Orya';
    case 'ta': return 'Taml';
    case 'te': return 'Telu';
    case 'kn': return 'Knda';
    case 'ml': return 'Mlym';
    case 'si': return 'Sinh';
    case 'lo': return 'Laoo';
    case 'km': return 'Khmr';
    case 'bo': return 'Tibt';
    case 'my': return 'Mymr';
    case 'am': case 'ti': return 'Ethi';
    case 'chr': return 'Cher';
    case 'iu': return 'Cans';
    case 'ii': return 'Yiii';
    case 'ka': return 'Geor';
    case 'hy': return 'Armn';
    case 'el': return 'Grek';
    case 'ja': return 'Jpan';
    case 'ko': return 'Hang';
    case 'zh': return has(['tw', 'hk', 'mo']) ? 'Hant' : 'Hans';
    default: return 'Latn';
  }
}

/** A text frame (`w:framePr` without a drop cap). */
function textFrame(k) {
  const len = n => { const v = tw(k, n); return v === null || !Number.isFinite(v) ? null : Math.max(-1584, Math.min(1584, v)); };
  const word = (n, allowed, d) => { const v = k.attr(n); return v !== null && allowed.includes(v) ? v : d; };
  const align = (n, allowed) => { const v = k.attr(n); return v !== null && allowed.includes(v) ? v : null; };
  const w = len('w:w'), h = len('w:h');
  const out = {
    hExact: k.attr('w:hRule') === 'exact', x: len('w:x') ?? 0, y: len('w:y') ?? 0,
    hAnchor: word('w:hAnchor', ['text', 'margin', 'page'], 'page'), vAnchor: word('w:vAnchor', ['text', 'margin', 'page'], 'page'),
    wrap: word('w:wrap', ['around', 'auto', 'notBeside', 'none', 'tight', 'through'], 'auto'),
    hSpace: Math.max(0, len('w:hSpace') ?? 0), vSpace: Math.max(0, len('w:vSpace') ?? 0),
  };
  if (w !== null && w > 0) out.w = w;
  if (h !== null && Math.abs(h) > 0) out.h = Math.abs(h);
  const xa = align('w:xAlign', ['left', 'center', 'right', 'inside', 'outside']); if (xa) out.xAlign = xa;
  const ya = align('w:yAlign', ['top', 'center', 'bottom', 'inside', 'outside']); if (ya) out.yAlign = ya;
  return out;
}

export function alignOf(v) {
  switch (v) {
    case 'center': return 'center';
    case 'right': case 'end': return 'right';
    case 'both': case 'justify': case 'lowKashida': case 'mediumKashida': case 'highKashida': return 'justify';
    case 'distribute': case 'thaiDistribute': return 'distribute';
    default: return 'left';
  }
}
export function tabLeaderOf(v) {
  switch (v) { case 'dot': return 'dot'; case 'hyphen': return 'hyphen'; case 'underscore': case 'heavy': return 'underscore'; case 'middleDot': return 'middleDot'; default: return 'none'; }
}
function tabStop(t) {
  const pos = tw(t, 'w:pos');
  if (pos === null) return null;
  const v = t.attr('w:val') ?? 'left';
  const align = {center: 'center', right: 'right', end: 'right', decimal: 'decimal', bar: 'bar', clear: 'clear'}[v] ?? 'left';
  return {pos, align, leader: tabLeaderOf(t.attr('w:leader') ?? 'none')};
}
function plainShdFill(e) {
  const fill = parseRgb(e.attr('w:fill'));
  if (fill) return fill;
  if (e.attr('w:val') === 'solid') return parseRgb(e.attr('w:color'));
  return null;
}
export function borderOfEl(e) {
  const style = borderStyleFromOoxml(e.attr('w:val') ?? 'single');
  const width = Math.max(0, Math.min(12, measure(e.attr('w:sz'), 8) ?? 0.5));
  const color = parseRgb(e.attr('w:color'));
  const space = Math.max(0, Math.min(31, measure(e.attr('w:space'), 1) ?? 0));
  return {style, width, color, space};
}
/** `w:pBdr`, `w:tblBorders`, `w:tcBorders`, `w:pgBorders`. */
export function bordersOfEl(e) {
  const b = {};
  for (const k of e.els()) {
    switch (k.local()) {
      case 'top': b.top = borderOfEl(k); break;
      case 'left': case 'start': b.left = borderOfEl(k); break;
      case 'bottom': b.bottom = borderOfEl(k); break;
      case 'right': case 'end': b.right = borderOfEl(k); break;
      case 'between': case 'insideH': b.between = borderOfEl(k); break;
      case 'insideV': b.inside_v = borderOfEl(k); break;
      case 'tl2br': b.diagDown = borderOfEl(k); break;
      case 'tr2bl': b.diagUp = borderOfEl(k); break;
      default:
    }
  }
  return b;
}
function marginSides(e) {
  const get = names => { for (const n of names) { const c = e.child(n); if (c) { const v = tw(c, 'w:w'); return v === null ? null : Math.max(0, Math.min(1584, v)); } } return null; };
  return [get(['w:top']), get(['w:left', 'w:start']), get(['w:bottom']), get(['w:right', 'w:end'])];
}
export const marginsOfEl = e => marginSides(e).map(v => v ?? 0);
const fracAttr = (k, n) => k.attr(n);

/** Context for property reading: theme fonts and colours, style id aliases (PropCtx). */
export class PropCtx {
  constructor() {
    this.majorFont = ''; this.minorFont = ''; this.majorCs = ''; this.minorCs = ''; this.majorScripts = []; this.minorScripts = [];
    this.bidiScript = null; this.themeColors = []; this.colorMap = null; this.alias = new Map(); this.theme = [];
  }
  styleId(id) { return this.alias.get(id) ?? id; }
  themeFont(t) {
    const major = t.startsWith('major');
    if (t.endsWith('Bidi')) return this.bidiThemeFont(major);
    const latin = major ? this.majorFont : this.minorFont;
    return latin ? latin : null;
  }
  bidiThemeFont(major) {
    const [latin, cs, scripts] = major ? [this.majorFont, this.majorCs, this.majorScripts] : [this.minorFont, this.minorCs, this.minorScripts];
    if (!this.bidiScript) return BIDI_THEME_FALLBACK_FONT;
    const byScript = this.bidiScript === 'Latn' ? latin || null : scripts.find(([s]) => s === this.bidiScript)?.[1] || null;
    return byScript || cs || BIDI_THEME_FALLBACK_FONT;
  }
  themeColor(e, attr, tint, shade) {
    const logical = i => this.colorMap?.[i] ?? i;
    const slot = {dark1: 0, light1: 1, dark2: 2, light2: 3, text1: logical(0), background1: logical(1), text2: logical(2), background2: logical(3),
      accent1: logical(4), accent2: logical(5), accent3: logical(6), accent4: logical(7), accent5: logical(8), accent6: logical(9),
      hyperlink: logical(10), followedHyperlink: logical(11)}[e.attr(attr) ?? ''];
    if (slot === undefined) return null;
    let c = this.themeColors[slot];
    if (!c) return null;
    const byte = a => { const v = e.attr(a); if (v === null) return null; const n = parseInt(v.trim(), 16); return /^[0-9a-fA-F]{1,2}$/.test(v.trim()) && n <= 255 ? n / 255 : null; };
    const t = byte(tint), s = byte(shade);
    if (t !== null) c = rgbWithLum(c, l => l * t + (1 - t));
    if (s !== null) c = rgbWithLum(c, l => l * s);
    return [...c];
  }
  shdFill(e) {
    const t = this.themeColor(e, 'w:themeFill', 'w:themeFillTint', 'w:themeFillShade');
    if (t) return t;
    if (e.attr('w:val') === 'solid' && !parseRgb(e.attr('w:fill'))) {
      const c = this.themeColor(e, 'w:themeColor', 'w:themeTint', 'w:themeShade');
      if (c) return c;
    }
    return plainShdFill(e);
  }
  rpr(e) {
    const c = {};
    for (const k of e.els()) {
      switch (k.name) {
        case 'w:rStyle': { const v = k.attr('w:val'); if (v) c.style = this.styleId(v); else delete c.style; break; }
        case 'w:rFonts': {
          const named = a => { const f = k.attr(a); return f ? f : null; };
          const themed = a => { const t = k.attr(a); return t !== null ? this.themeFont(t) : null; };
          const font = themed('w:asciiTheme') ?? named('w:ascii') ?? themed('w:hAnsiTheme') ?? named('w:hAnsi');
          if (font !== null) c.font = font; else delete c.font;
          const cs = k.attr('w:cs'); if (cs && cs.length < 256) c.fontCs = cs; else delete c.fontCs;
          const ea = k.attr('w:eastAsia'); if (ea && ea.length < 256) c.fontEa = ea; else delete c.fontEa;
          break;
        }
        case 'w:b': c.bold = onOff(k); break;
        case 'w:bCs': c.boldCs = onOff(k); break;
        case 'w:i': c.italic = onOff(k); break;
        case 'w:iCs': c.italicCs = onOff(k); break;
        case 'w:cs': c.cs = onOff(k); break;
        case 'w:caps': c.caps = onOff(k); break;
        case 'w:smallCaps': c.smallCaps = onOff(k); break;
        case 'w:strike': c.strike = onOff(k); break;
        case 'w:dstrike': c.doubleStrike = onOff(k); break;
        case 'w:outline': c.outline = onOff(k); break;
        case 'w:shadow': c.shadow = onOff(k); break;
        case 'w:emboss': c.emboss = onOff(k); break;
        case 'w:imprint': c.engrave = onOff(k); break;
        case 'w:noProof': c.noProof = onOff(k); break;
        case 'w:vanish': c.hidden = onOff(k); break;
        case 'w:rtl': c.rtl = onOff(k); break;
        case 'w:color': {
          const t = this.themeColor(k, 'w:themeColor', 'w:themeTint', 'w:themeShade');
          const v = k.attr('w:val');
          let col = null;
          if (t) col = {Rgb: t};
          else if (v !== null && v.toLowerCase() === 'auto') col = 'Auto';
          else if (v !== null) { const r = parseRgb(v); col = r ? {Rgb: r} : null; }
          if (col) c.color = col; else delete c.color;
          break;
        }
        case 'w:spacing': { const v = tw(k, 'w:val'); if (v !== null) c.spacing = Math.max(-1584, Math.min(1584, v)); else delete c.spacing; break; }
        case 'w:w': { const v = measure((k.attr('w:val') ?? '').replace(/%+$/, ''), 1); if (v !== null) c.scale = Math.max(1, Math.min(600, v)); else delete c.scale; break; }
        case 'w:kern': { const v = measure(k.attr('w:val'), 2); if (v !== null) c.kern = Math.max(0, Math.min(1638, v)); else delete c.kern; break; }
        case 'w:position': { const v = measure(k.attr('w:val'), 2); if (v !== null) c.position = Math.max(-1584, Math.min(1584, v)); else delete c.position; break; }
        case 'w:sz': { const v = measure(k.attr('w:val'), 2); if (v !== null && v > 0) c.size = Math.max(1, Math.min(1638, v)); else delete c.size; break; }
        case 'w:szCs': { const v = measure(k.attr('w:val'), 2); if (v !== null && v > 0) c.sizeCs = Math.max(1, Math.min(1638, v)); else delete c.sizeCs; break; }
        case 'w:highlight': { const v = k.attr('w:val'); if (v !== null) c.highlight = highlightFromOoxml(v); else delete c.highlight; break; }
        case 'w:u': {
          const v = k.attr('w:val');
          if (v !== null) c.underline = underlineFromOoxml(v); else delete c.underline;
          const uc = this.themeColor(k, 'w:themeColor', 'w:themeTint', 'w:themeShade') ?? parseRgb(k.attr('w:color'));
          if (uc) c.underlineColor = uc; else delete c.underlineColor;
          break;
        }
        case 'w:bdr': c.border = borderOfEl(k); break;
        case 'w:shd': { const f = this.shdFill(k); if (f) c.shading = f; else delete c.shading; break; }
        case 'w:vertAlign': { const v = k.attr('w:val'); if (v !== null) c.vertAlign = v === 'superscript' ? 'superscript' : v === 'subscript' ? 'subscript' : 'baseline'; else delete c.vertAlign; break; }
        case 'w:eastAsianLayout': { const l = eastAsianLayout(k); if (Object.keys(l).length) c.eastAsianLayout = l; else delete c.eastAsianLayout; break; }
        case 'w:lang': {
          const g = a => { const v = k.attr(a)?.trim(); return v && v.length < 64 ? v : null; };
          const l = g('w:val'), b = g('w:bidi'), ea = g('w:eastAsia');
          if (l) c.lang = l; else delete c.lang;
          if (b) c.langBidi = b; else delete c.langBidi;
          if (ea) c.langEa = ea; else delete c.langEa;
          break;
        }
        case 'w14:ligatures': { const l = ligaturesFromOoxml(k.attr('w14:val')); if (l) c.ligatures = l; else delete c.ligatures; break; }
        default:
          // Other w14 text effects (glow, shadow, reflection, outline, fill): kept as their XML
          // until the WordArt reader (read/wordart.rs) is translated, so a save writes them back.
          if (k.name.startsWith('w14:')) {
            const fx = {...(c.textEffects || {})};
            const got = readTextEffect(k);
            if (got) fx[got.key] = got.value; else fx.xml = [...(fx.xml || []), k.toXml()];
            c.textEffects = fx;
          }
      }
    }
    return c;
  }
  /** `w:pPr` (without `w:sectPr`): [paragraph props, paragraph-mark char props]. */
  ppr(e) {
    const p = {};
    let mark = {};
    for (const k of e.els()) {
      switch (k.name) {
        case 'w:pStyle': { const v = k.attr('w:val'); if (v) p.style = this.styleId(v); else delete p.style; break; }
        case 'w:keepNext': p.keepNext = onOff(k); break;
        case 'w:keepLines': p.keepLines = onOff(k); break;
        case 'w:pageBreakBefore': p.pageBreakBefore = onOff(k); break;
        case 'w:widowControl': p.widowControl = onOff(k); break;
        case 'w:contextualSpacing': p.contextualSpacing = onOff(k); break;
        case 'w:mirrorIndents': p.mirrorIndents = onOff(k); break;
        case 'w:suppressAutoHyphens': p.suppressHyphens = onOff(k); break;
        case 'w:suppressLineNumbers': p.suppressLineNumbers = onOff(k); break;
        case 'w:bidi': p.bidi = onOff(k); break;
        case 'w:kinsoku': p.kinsoku = onOff(k); break;
        case 'w:wordWrap': p.wordWrap = onOff(k); break;
        case 'w:overflowPunct': p.overflowPunct = onOff(k); break;
        case 'w:topLinePunct': p.topLinePunct = onOff(k); break;
        case 'w:autoSpaceDE': p.autoSpaceDE = onOff(k); break;
        case 'w:autoSpaceDN': p.autoSpaceDN = onOff(k); break;
        case 'w:snapToGrid': p.snapToGrid = onOff(k); break;
        case 'w:framePr': {
          const kind = k.attr('w:dropCap');
          if (kind === 'drop' || kind === 'margin') {
            p.dropCap = Math.max(1, Math.min(10, u32Of(k.attr('w:lines')) ?? 3));
            if (kind === 'margin') p.dropCapMargin = true; else delete p.dropCapMargin;
            const d = tw(k, 'w:hSpace');
            if (d !== null && Number.isFinite(d) && d > 0) p.dropCapDistance = Math.min(d, 1584); else delete p.dropCapDistance;
          } else p.frame = textFrame(k);
          break;
        }
        case 'w:numPr': {
          const num = u32Of(k.childVal('w:numId'));
          const ilvl = u32Of(k.childVal('w:ilvl'));
          const lvl = Math.min(ilvl ?? 0, 8);
          if (num !== null) p.numbering = {num, level: lvl};
          else if (ilvl !== null) p.numbering = {num: LEVEL_ONLY, level: lvl};
          break;
        }
        case 'w:pBdr': p.borders = bordersOfEl(k); break;
        case 'w:shd': { const f = this.shdFill(k); if (f) p.shading = f; else delete p.shading; break; }
        case 'w:tabs': p.tabs = k.children('w:tab').slice(0, 64).map(tabStop).filter(Boolean); break;
        case 'w:spacing': {
          const b = tw(k, 'w:before'); if (b !== null) p.spaceBefore = Math.max(0, b);
          const a = tw(k, 'w:after'); if (a !== null) p.spaceAfter = Math.max(0, a);
          const auto = n => { const v = k.attr(n); return v === null ? null : ['1', 'true', 'on'].includes(v.trim()); };
          const ba = auto('w:beforeAutospacing'); if (ba !== null) p.spaceBeforeAuto = ba;
          const aa = auto('w:afterAutospacing'); if (aa !== null) p.spaceAfterAuto = aa;
          const line = k.attr('w:line');
          if (line !== null) {
            const rule = (k.attr('w:lineRule') ?? 'auto').toLowerCase();
            let ls = null;
            if (rule === 'exact') { const v = measure(line, 20); if (v !== null) ls = {rule: 'exactly', value: Math.abs(v)}; }
            else if (rule === 'atleast') { const v = measure(line, 20); if (v !== null) ls = {rule: 'atLeast', value: Math.abs(v)}; }
            else { const v = lineMultiple(line); if (v !== null) ls = {rule: 'multiple', value: Math.max(0.06, Math.min(132, Math.abs(v)))}; }
            if (ls) p.lineSpacing = ls; else delete p.lineSpacing;
          }
          break;
        }
        case 'w:ind': {
          const l = tw(k, 'w:left') ?? tw(k, 'w:start'); if (l !== null) p.indentLeft = l;
          const r = tw(k, 'w:right') ?? tw(k, 'w:end'); if (r !== null) p.indentRight = r;
          const h = tw(k, 'w:hanging');
          if (h !== null) p.indentFirst = -h; else { const f = tw(k, 'w:firstLine'); if (f !== null) p.indentFirst = f; }
          const chars = a => { const v = int(k.attr(a)); return v === null ? null : Math.max(-158_400, Math.min(158_400, v)) / 100; };
          const lc = chars('w:leftChars') ?? chars('w:startChars'); if (lc !== null) p.indentLeftChars = lc;
          const rc = chars('w:rightChars') ?? chars('w:endChars'); if (rc !== null) p.indentRightChars = rc;
          const hc = chars('w:hangingChars'), fc = chars('w:firstLineChars');
          if (hc !== null && (hc !== 0 || fc === null)) p.indentFirstChars = -hc;
          else if (fc !== null) p.indentFirstChars = fc;
          break;
        }
        case 'w:jc': { const v = k.attr('w:val'); if (v !== null) p.align = alignOf(v); else delete p.align; break; }
        case 'w:outlineLvl': { const v = u32Of(k.attr('w:val')); if (v !== null) p.outlineLevel = Math.min(v, 9); else delete p.outlineLevel; break; }
        case 'w:rPr': mark = this.rpr(k); break;
        default:
      }
    }
    return [p, mark];
  }
  tblpr(e) {
    const t = {};
    for (const k of e.els()) {
      switch (k.name) {
        case 'w:tblStyle': { const v = k.attr('w:val'); if (v) t.style = this.styleId(v); break; }
        case 'w:tblW': {
          const ty = k.attr('w:type') ?? 'dxa', w = k.attr('w:w') ?? '0';
          if (ty === 'pct') { const v = w.endsWith('%') ? measure(w.slice(0, -1), 1) : measure(w, 50); if (v !== null && Math.min(1000, Math.max(0, v)) > 0) t.widthPct = Math.min(1000, Math.max(0, v)); }
          else if (ty !== 'auto' && ty !== 'nil') { const v = measure(w, 20); if (v !== null && v > 0) t.width = v; }
          break;
        }
        case 'w:jc': { const v = k.attr('w:val'); if (v !== null) t.align = alignOf(v); break; }
        case 'w:tblInd': { const v = tw(k, 'w:w'); if (v !== null) t.indent = v; break; }
        case 'w:tblBorders': t.borders = bordersOfEl(k); break;
        case 'w:shd': { const f = this.shdFill(k); if (f) t.shading = f; break; }
        case 'w:tblLayout': setFlag(t, 'fixed', k.attr('w:type') === 'fixed'); break;
        case 'w:bidiVisual': setFlag(t, 'bidiVisual', onOff(k)); break;
        case 'w:tblCellMar': t.cellMargins = marginsOfEl(k); break;
        case 'w:tblLook': { const l = lookOf(k); if (JSON.stringify(l) !== JSON.stringify(defaultTableLook())) t.look = l; else delete t.look; break; }
        case 'w:tblpPr': t.float = tableFloat(k); break;
        case 'w:tblOverlap': if (t.float) t.float.overlap = k.attr('w:val') !== 'never'; break;
        case 'w:tblCaption': { const v = k.attr('w:val'); if (v !== null) t.caption = capAlt(v); break; }
        case 'w:tblDescription': { const v = k.attr('w:val'); if (v !== null) t.description = capAlt(v); break; }
        default:
      }
    }
    return t;
  }
}

/** `w:tblLook` in the attribute form or the legacy hex bitmask form. */
export function lookOf(e) {
  const l = {headerRow: false, totalRow: false, bandedRows: false, firstColumn: false, lastColumn: false, bandedColumns: false};
  const v = e.attr('w:val');
  if (v !== null) {
    let bits = parseInt(v.trim(), 16);
    if (!/^[0-9a-fA-F]+$/.test(v.trim())) bits = 0x04a0;
    l.headerRow = (bits & 0x20) !== 0; l.totalRow = (bits & 0x40) !== 0; l.firstColumn = (bits & 0x80) !== 0; l.lastColumn = (bits & 0x100) !== 0;
    l.bandedRows = (bits & 0x200) === 0; l.bandedColumns = (bits & 0x400) === 0;
  }
  const b = n => { const x = e.attr(n); return x === null ? null : !['0', 'false', 'off'].includes(x); };
  if (b('w:firstRow') !== null) l.headerRow = b('w:firstRow');
  if (b('w:lastRow') !== null) l.totalRow = b('w:lastRow');
  if (b('w:firstColumn') !== null) l.firstColumn = b('w:firstColumn');
  if (b('w:lastColumn') !== null) l.lastColumn = b('w:lastColumn');
  if (b('w:noHBand') !== null) l.bandedRows = !b('w:noHBand');
  if (b('w:noVBand') !== null) l.bandedColumns = !b('w:noVBand');
  return l;
}

export function trpr(e) {
  const r = {};
  for (const k of e.els()) {
    switch (k.name) {
      case 'w:trHeight': {
        const v = tw(k, 'w:val'); if (v !== null) r.height = Math.abs(v); else delete r.height;
        const rule = (k.attr('w:hRule') ?? '').toLowerCase();
        r.heightRule = rule === 'exact' ? 'exact' : rule === 'auto' ? 'auto' : 'atLeast';
        break;
      }
      case 'w:tblHeader': setFlag(r, 'header', onOff(k)); break;
      case 'w:cantSplit': setFlag(r, 'cantSplit', onOff(k)); break;
      case 'w:gridBefore': r.gridBefore = Math.min(u32Of(k.attr('w:val')) ?? 0, 63); break;
      case 'w:gridAfter': r.gridAfter = Math.min(u32Of(k.attr('w:val')) ?? 0, 63); break;
      case 'w:wBefore': { const v = gapWidth(k); if (v !== null) r.wBefore = v; break; }
      case 'w:wAfter': { const v = gapWidth(k); if (v !== null) r.wAfter = v; break; }
      default:
    }
  }
  return r;
}
function gapWidth(k) {
  const t = k.attr('w:type');
  if (t !== null && t !== 'dxa') return null;
  const v = tw(k, 'w:w');
  return v !== null && v >= 0 ? Math.min(v, MAX_LEN_PT) : null;
}

/** `w:tcPr`: [cell props, whether the cell is a legacy hMerge continuation]. */
export function tcpr(pc, e) {
  const c = {span: 1};
  let hcont = false;
  for (const k of e.els()) {
    switch (k.name) {
      case 'w:tcW': {
        const t = k.attr('w:type');
        if (t === null || t === 'dxa') { const v = tw(k, 'w:w'); if (v !== null && v > 0) c.width = v; else delete c.width; }
        else if (t === 'pct') {
          const w = k.attr('w:w') ?? '0';
          const v = w.endsWith('%') ? measure(w.slice(0, -1), 1) : measure(w, 50);
          const p = v === null ? null : Math.max(0, Math.min(100, v));
          if (p !== null && p > 0) c.widthPct = p; else delete c.widthPct;
        }
        break;
      }
      case 'w:gridSpan': c.span = Math.max(1, Math.min(63, u32Of(k.attr('w:val')) ?? 1)); break;
      case 'w:hMerge': hcont = k.attr('w:val') !== 'restart'; break;
      case 'w:vMerge': c.vmerge = k.attr('w:val') === 'restart' ? 'restart' : 'continue'; break;
      case 'w:tcBorders': c.borders = bordersOfEl(k); break;
      case 'w:shd': { const f = pc.shdFill(k); if (f) c.shading = f; else delete c.shading; break; }
      case 'w:noWrap': setFlag(c, 'noWrap', onOff(k)); break;
      case 'w:hideMark': setFlag(c, 'hideMark', onOff(k)); break;
      case 'w:tcMar': {
        const sides = marginSides(k);
        if (sides.every(v => v !== null)) c.margins = sides; else c.partialMargins = sides;
        break;
      }
      case 'w:textDirection': c.textDirection = textDirectionFromOoxml(k.attr('w:val') ?? ''); setFlag(c, 'textDirectionSet', k.attr('w:val') === 'lrTb'); break;
      case 'w:vAlign': { const v = k.attr('w:val'); c.valign = v === 'center' ? 'center' : v === 'bottom' ? 'bottom' : 'top'; break; }
      default:
    }
  }
  return [c, hcont];
}

const notePosOf = v => (['pageBottom', 'beneathText', 'sectEnd', 'docEnd'].includes(v) ? v : null);
const noteRestartOf = v => (['continuous', 'eachSect', 'eachPage'].includes(v) ? v : null);
/** `w:footnotePr` / `w:endnotePr`. */
export function notePr(e, fmt) {
  const out = {};
  const pos = notePosOf(e.childVal('w:pos')); if (pos) out.pos = pos;
  if (fmt) { const f = e.childVal('w:numFmt'); if (f !== null) out.numFmt = numFormatFromOoxml(f); }
  const st = int(e.childVal('w:numStart')); if (st !== null) out.numStart = Math.max(1, Math.min(32_767, st));
  const rs = noteRestartOf(e.childVal('w:numRestart')); if (rs) out.numRestart = rs;
  return out;
}

/** `w:sectPr` content: [section, header/footer references]. */
export function sectpr(e, id = newId()) {
  const s = defaultSection(id);
  const refs = [];
  for (const k of e.els()) {
    switch (k.name) {
      case 'w:headerReference': case 'w:footerReference': {
        const rid = k.attr('r:id');
        if (rid !== null) refs.push({footer: k.name === 'w:footerReference', kind: k.attr('w:type') ?? 'default', rid});
        break;
      }
      case 'w:type': s.start = {continuous: 'continuous', evenPage: 'evenPage', oddPage: 'oddPage', nextColumn: 'nextColumn'}[k.attr('w:val')] ?? 'nextPage'; break;
      case 'w:pgSz': {
        const w = tw(k, 'w:w'); if (w !== null && w >= 36) s.pageW = w;
        const h = tw(k, 'w:h'); if (h !== null && h >= 36) s.pageH = h;
        const o = k.attr('w:orient');
        s.landscape = o === 'landscape' ? true : o !== null ? false : s.pageW > s.pageH;
        break;
      }
      case 'w:pgMar': {
        const m = (n, d) => { const v = tw(k, n); return Math.min(v === null ? d : Math.abs(v), Math.max(s.pageW, s.pageH)); };
        s.marginTop = m('w:top', s.marginTop); s.marginBottom = m('w:bottom', s.marginBottom);
        s.marginLeft = m('w:left', s.marginLeft); s.marginRight = m('w:right', s.marginRight);
        s.header = m('w:header', s.header); s.footer = m('w:footer', s.footer); s.gutter = m('w:gutter', s.gutter);
        break;
      }
      case 'w:cols': {
        const c = {count: Math.max(1, Math.min(45, u32Of(k.attr('w:num')) ?? 1)), space: 36, separator: false, widths: []};
        const sp = tw(k, 'w:space'); if (sp !== null) c.space = Math.max(0, sp);
        const sep = k.attr('w:sep'); c.separator = sep !== null && !['0', 'false', 'off'].includes(sep);
        const eq = k.attr('w:equalWidth');
        if (eq !== null && ['0', 'false', 'off'].includes(eq)) {
          c.widths = k.children('w:col').slice(0, 45).map(col => [Math.max(0, tw(col, 'w:w') ?? 0), Math.max(0, tw(col, 'w:space') ?? 0)]);
          if (c.widths.length) c.count = c.widths.length;
        }
        s.columns = c;
        break;
      }
      case 'w:footnotePr': s.footnotePr = notePr(k, true); break;
      case 'w:endnotePr': s.endnotePr = notePr(k, true); break;
      case 'w:formProt': s.formProt = onOff(k); break;
      case 'w:titlePg': s.titlePage = onOff(k); break;
      case 'w:bidi': s.rtl = onOff(k); break;
      case 'w:textDirection': s.textDirection = textDirectionFromOoxml(k.attr('w:val') ?? ''); s.textDirectionSet = k.attr('w:val') === 'lrTb'; break;
      case 'w:pgNumType': {
        s.pageNumStart = u32Of(k.attr('w:start'));
        const f = k.attr('w:fmt'); if (f !== null) s.pageNumFormat = numFormatFromOoxml(f);
        s.pageNumSet = s.pageNumStart === null && s.pageNumFormat === 'decimal';
        break;
      }
      case 'w:lnNumType': {
        const l = {countBy: 1, start: 1, distance: 0, restart: 'page'};
        const cb = u32Of(k.attr('w:countBy')); if (cb !== null) l.countBy = Math.max(1, Math.min(100, cb));
        const st = int(k.attr('w:start')); if (st !== null) l.start = Math.max(0, Math.min(32_767, st)) + 1;
        l.distance = Math.max(0, tw(k, 'w:distance') ?? 0);
        l.restart = {newSection: 'section', continuous: 'continuous'}[k.attr('w:restart')] ?? 'page';
        s.lineNumbers = l;
        break;
      }
      case 'w:vAlign': s.valign = {center: 'center', both: 'justify', bottom: 'bottom'}[k.attr('w:val')] ?? 'top'; break;
      case 'w:pgBorders': s.pageBorders = bordersOfEl(k); break;
      case 'w:docGrid': {
        const g = {type: 'default', linePitch: 18, charSpace: 0};
        const t = k.attr('w:type'); if (['default', 'lines', 'linesAndChars', 'snapToChars'].includes(t)) g.type = t;
        const p = tw(k, 'w:linePitch'); if (p !== null && Number.isFinite(p) && p > 0) g.linePitch = Math.min(p, 1584);
        const cs = int(k.attr('w:charSpace')); if (cs !== null) g.charSpace = Math.max(-1584 * 4096, Math.min(1584 * 4096, cs));
        s.docGrid = g;
        break;
      }
      default:
    }
  }
  return [s, refs];
}

function tableFloat(e) {
  const pt = n => { const v = measure(e.attr(n), 20); return v === null ? 0 : Math.max(-31_680, Math.min(31_680, v)); };
  const dist = n => Math.max(0, Math.min(1584, pt(n)));
  const rel = (n, text) => ({page: 'page', margin: 'margin'}[e.attr(n)] ?? text);
  const align = n => { const v = e.attr(n); return v === null ? null : floatAlignFromOoxml(v); };
  const f = {hRel: rel('w:horzAnchor', 'column'), vRel: rel('w:vertAnchor', 'paragraph'), x: pt('w:tblpX'), y: pt('w:tblpY'),
    dist: [dist('w:leftFromText'), dist('w:topFromText'), dist('w:rightFromText'), dist('w:bottomFromText')], overlap: true};
  const ha = align('w:tblpXSpec'); if (ha) f.hAlign = ha;
  const va = align('w:tblpYSpec'); if (va) f.vAlign = va;
  return f;
}

function eastAsianLayout(e) {
  const fl = n => { const v = e.attr(n)?.trim(); return v === undefined ? null : ['1', 'true', 'on'].includes(v) ? true : ['0', 'false', 'off'].includes(v) ? false : null; };
  const out = {};
  const id = int(e.attr('w:id')); if (id !== null && id >= -2147483648 && id <= 2147483647) out.id = id;
  const c = fl('w:combine'); if (c !== null) out.combine = c;
  const b = e.attr('w:combineBrackets')?.trim(); if (['none', 'round', 'square', 'angle', 'curly'].includes(b)) out.combineBrackets = b;
  const v = fl('w:vert'); if (v !== null) out.vert = v;
  const vc = fl('w:vertCompress'); if (vc !== null) out.vertCompress = vc;
  return out;
}

/** Resolve level-only numbering in `p` against its style chain (resolve_level_only). */
function chainList(sheet, styleId) {
  const ch = chain(sheet, styleId);
  for (let i = ch.length - 1; i >= 0; i--) { const n = ch[i]?.para?.numbering; if (n && n.num !== LEVEL_ONLY) return n.num; }
  return null;
}
function resolveLevelOnly(sheet, p, styleId) {
  if (p.numbering && p.numbering.num === LEVEL_ONLY) {
    const num = chainList(sheet, p.style ?? styleId);
    if (num === null) delete p.numbering; else p.numbering = {num, level: p.numbering.level};
  }
}

// =============================================================================================
// read/styles.rs
// =============================================================================================

export const LOWER_NAMES = Object.freeze([['caption', 'Caption'], ['header', 'Header'], ['footer', 'Footer'], ['footnote text', 'Footnote Text'],
  ['footnote reference', 'Footnote Reference'], ['endnote text', 'Endnote Text'], ['endnote reference', 'Endnote Reference'],
  ['annotation text', 'Annotation Text'], ['annotation reference', 'Annotation Reference'], ['annotation subject', 'Annotation Subject'],
  ['table of figures', 'Table of Figures'], ['normal indent', 'Normal Indent'], ['line number', 'Line Number'], ['page number', 'Page Number'],
  ['index heading', 'Index Heading'], ['envelope address', 'Envelope Address'], ['envelope return', 'Envelope Return'], ['toa heading', 'TOA Heading'],
  ['table of authorities', 'Table of Authorities']]);
/** File style name → display name. */
export function uiStyleName(n) {
  const hit = LOWER_NAMES.find(([f]) => f === n);
  if (hit) return hit[1];
  for (const [pre, ui] of [['heading ', 'Heading '], ['toc ', 'TOC '], ['index ', 'Index ']]) {
    if (n.startsWith(pre)) { const d = n.slice(pre.length); if (/^\d$/.test(d)) return ui + d; }
  }
  return n;
}

// =============================================================================================
// custom.rs
// =============================================================================================

/** Custom document properties (`docProps/custom.xml`): [{name, kind, value}]. */
/** Simple variant types kept as text (custom.rs `SIMPLE`). */
export const CUSTOM_SIMPLE = Object.freeze(['lpwstr', 'lpstr', 'bstr', 'i1', 'i2', 'i4', 'i8', 'int', 'ui1', 'ui2', 'ui4', 'ui8', 'uint', 'r4', 'r8',
  'decimal', 'bool', 'date', 'filetime', 'cy', 'error', 'clsid']);
/**
 * Properties of a parsed `docProps/custom.xml` root (custom.rs `read`): a simple variant keeps its
 * text; anything else (vectors, blobs) is kept as its XML, kind `raw`.
 */
export function readCustomProps(root) {
  const out = [];
  for (const p of root.elList().filter(e => e.local() === 'property').slice(0, 10_000)) {
    const name = p.attr('name');
    if (!name) continue;
    const v = p.elList()[0];
    if (!v) continue;
    const kind = v.local();
    out.push(CUSTOM_SIMPLE.includes(kind) ? {name, kind, value: v.text()} : {name, kind: 'raw', value: v.toXml()});
  }
  return out;
}

// =============================================================================================
// read.rs + read/*.rs: the reader
// =============================================================================================

const MAX_PARTS = 50_000;
const MAX_HF_DEPTH = 4;
const MAX_TABLE_DEPTH = 24;
const MAX_FIELD_DEPTH = 32;
const MAX_STORY_DEPTH = 4;
const MAX_INSTR = 2 * 1024 * 1024;
const MAX_FORM = 64 * 1024;
const MAX_ROWS = 32_767;
const MAX_COLS = 63;
const MAX_TEMPLATE_PATH = 32 * 1024;
const MAX_EMBEDDED_PARTS = 4096;
const INK_URI = 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk';

/** Clean text from `w:t`: line ends become spaces, U+FFFC and other control characters go. */
export function cleanText(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\n' || ch === '\r') out += ' ';
    else if (ch === '\t') out += '\t';
    else if (ch === OBJ || c < 0x20) continue;
    else out += ch;
  }
  return out;
}
const KNOWN_REQUIRES = new Set(['wps', 'wpg', 'wpc', 'wpi', 'w14', 'w15', 'wp14', 'a14', 'w16se', 'w16cid', 'w16', 'w16cex', 'w16sdtdh', 'v', 'm']);
/** The Choice whose requirements are understood, else the Fallback, else any Choice. */
export function childrenOfChoice(ac) {
  const ok = c => (c.attr('Requires') ?? '').split(/\s+/).filter(Boolean).every(r => KNOWN_REQUIRES.has(r));
  return ac.children('mc:Choice').find(ok) ?? ac.child('mc:Fallback') ?? ac.child('mc:Choice');
}
const placeholderOf = s => [...s].map(c => (/\p{Cc}/u.test(c) ? ' ' : c)).slice(0, MAX_CONTROL_TEXT).join('').trim();

/** Paragraph content under construction (PB). */
class PB {
  constructor() { this.text = ''; this.runs = []; this.objects = []; }
  pushText(s, props) { if (!s) return; this.text += s; this.pushRun(s.length, props); }
  pushObj(o, props) { this.text += OBJ; this.objects.push(o); this.pushRun(1, props); }
  pushRun(len, props) {
    const last = this.runs[this.runs.length - 1];
    if (last && sameProps(last.props, props)) last.len += len;
    else this.runs.push({len, props});
  }
}
function sameProps(a, b) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
const cleanProps = p => { const o = {}; for (const k in p) if (p[k] !== undefined && p[k] !== null) o[k] = p[k]; return o; };

/** Normalize a built paragraph: drop empty runs, merge equal neighbours, strip empty props. */
function finishPara(para) {
  const runs = [];
  for (const r of para.runs) {
    if (r.len <= 0) continue;
    const props = cleanProps(r.props ?? {});
    const last = runs[runs.length - 1];
    if (last && sameProps(last.props ?? {}, props)) last.len += r.len;
    else runs.push(charIsEmpty(props) ? {len: r.len} : {len: r.len, props});
  }
  para.runs = runs;
  if (!para.objects?.length) delete para.objects;
  if (para.props && paraIsEmpty(para.props)) delete para.props;
  if (para.mark && charIsEmpty(cleanProps(para.mark))) delete para.mark; else if (para.mark) para.mark = cleanProps(para.mark);
  return para;
}

class FieldState {
  constructor(props, instr, locked, dirty, form) {
    this.instr = instr; this.phase = 'instr'; this.spilled = false; this.buf = []; this.props = props; this.locked = locked; this.dirty = dirty;
    this.range = false; this.form = form;
  }
}

/** A field's words with whether each was quoted (fields.rs `field_args`). */
export function fieldArgs(instr) {
  const out = [];
  const s = [...instr];
  let i = 0;
  while (i < s.length) {
    const c = s[i++];
    if (/\s/.test(c)) continue;
    let word = '';
    if (c === '"') {
      while (i < s.length) {
        const d = s[i++];
        if (d === '"') break;
        if (d === '\\' && (s[i] === '"' || s[i] === '\\')) word += s[i++];
        else word += d;
      }
      out.push([word, true]);
    } else {
      word += c;
      while (i < s.length && !/\s/.test(s[i]) && s[i] !== '"') word += s[i++];
      out.push([word, false]);
    }
  }
  return out;
}
/** Where a HYPERLINK field goes: url, url#bookmark (`\l`) or #bookmark; null for others. */
export function hyperlinkTarget(instr) {
  const first = instr.trim().split(/\s+/)[0] ?? '';
  if (first.toUpperCase() !== 'HYPERLINK') return null;
  const args = fieldArgs(instr);
  if (!args.length || args[0][1] || args[0][0].toUpperCase() !== 'HYPERLINK') return null;
  let url = null, anchor = null;
  for (let i = 1; i < args.length; i++) {
    const [a, quoted] = args[i];
    if (quoted || !a.startsWith('\\')) { url = url ?? a; continue; }
    const sw = a.toLowerCase();
    const value = sw === '\\l' || sw === '\\o' || sw === '\\t' ? args[++i] : undefined;
    if (sw === '\\l') anchor = value ? value[0] : null;
  }
  url = url?.trim() || null; anchor = anchor?.trim() || null;
  if (url && anchor) return `${url}#${anchor}`;
  if (url) return url;
  if (anchor) return `#${anchor}`;
  return null;
}
/** TOC fields and citation managers' ADDIN fields are kept as range fields. */
export const isToc = instr => /^\s*TOC(\s|$)/i.test(instr);
const isRangeInstr = instr => isToc(instr) || instr.trimStart().slice(0, 5).toUpperCase() === 'ADDIN';
const objPlain = o => {
  switch (o?.type) { case 'field': return o.result ?? ''; case 'equation': return o.linear ?? ''; case 'ruby': return o.base ?? ''; case 'positionalTab': return '\t'; case 'opaque': return o.text ?? ''; default: return ''; }
};
const isFramed = o => ['image', 'graphic', 'shape', 'group'].includes(o?.type) || (o?.type === 'opaque' && o.drawing);

class StoryCtx {
  constructor() { this.fields = []; this.ignoredBegins = 0; this.pending = []; this.storyDepth = 0; this.inHf = false; }
}
const sink = sc => {
  for (let i = sc.fields.length - 1; i >= 0; i--) {
    const f = sc.fields[i];
    if (!f.range) return f.spilled ? null : f;
  }
  return null;
};

class Reader {
  constructor(pkg, main) {
    this.pkg = pkg;
    this.main = main;
    this.c = createContent([]);
    this.c.body = null;
    this.c.parts = {};
    this.nextPart = 1;
    this.pc = new PropCtx();
    this.revs = new Map();
    this.moves = {open: [[], []], seen: new Map(), closedHere: [null, null]};
    this.mediaByPath = new Map();
    this.hfByPath = new Map();
    this.hfDepth = 0;
    this.footnotes = new Map();
    this.endnotes = new Map();
    this.currentNote = null;
    this.inNoteSep = false;
    this.commentMap = new Map();
    this.commentsEnded = new Set();
    this.bookmarks = new Map();
    this.perms = new Map();
    this.contentTypes = null;
    this.embedded = new Map();
    this.usedIds = new Set();
    this.embeddedRels = new Set();
  }
  types() { return this.contentTypes ?? (this.contentTypes = new ContentTypes(this.pkg)); }
  xml(path) { return this.pkg.xml(path); }
  id(prefer) {
    const p = typeof prefer === 'string' ? prefer.toLowerCase() : null;
    if (p && ID_RE.test(p) && p !== '00000000' && !this.usedIds.has(p)) { this.usedIds.add(p); return p; }
    let id;
    do id = newId(); while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }
  /**
   * A paragraph's id: its `w14:paraId` when valid and unused, else a fresh id shaped like one
   * (8 hex digits below 0x80000000), so the next save writes it as the paraId and the paragraph
   * keeps its id through every later save and open (architecture 14.2).
   */
  paraId(prefer) {
    const p = typeof prefer === 'string' ? prefer.toLowerCase() : null;
    if (p && ID_RE.test(p) && p !== '00000000' && !this.usedIds.has(p)) { this.usedIds.add(p); return p; }
    let id;
    do {
      let h = 0x811c9dc5;
      for (const ch of newId()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
      id = ((h & 0x7fffffff) || 1).toString(16).padStart(8, '0');
    } while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }
  /**
   * A table, row or cell id derived from the id of what it starts with (`prefix` + its last seven
   * characters). When that is taken (a cell starting with a nested table), the first free id with
   * the same tail and the next base-36 second character: deterministic, so a file always reads with
   * the same ids.
   */
  derived(prefix, id) {
    const d = derivedId(prefix, id);
    if (d === null) return this.id(null);
    for (let n = 0; n < 36; n++) {
      const c = n === 0 ? d : prefix + ((parseInt(d[1], 36) + n) % 36).toString(36) + d.slice(2);
      if (!this.usedIds.has(c)) return this.id(c);
    }
    return this.id(null);
  }
  newPara(prefer) { return {kind: 'para', id: this.paraId(prefer), text: '', runs: []}; }
  addPart(kind, blocks) {
    if (Object.keys(this.c.parts).length >= MAX_PARTS) return 0;
    const id = this.nextPart++;
    this.c.parts[id] = {kind, blocks: blocks.length ? blocks : [this.newPara()]};
    return id;
  }

  // --- revisions (parts.rs) ---
  revision(kind, e) { return this.revisionNamed(kind, e, null); }
  revisionNamed(kind, e, moveName) {
    const author = [...(e.attr('w:author') ?? '')].slice(0, 256).join('');
    const date = [...(e.attr('w:date') ?? '')].slice(0, 64).join('');
    const key = `${kind}\u0000${author}\u0000${date}\u0000${moveName ?? '\u0001'}`;
    if (this.revs.has(key)) return this.revs.get(key);
    const i = this.c.revisions.length;
    const r = {kind, author, date};
    if (moveName !== null) r.moveName = moveName;
    this.c.revisions.push(r);
    this.revs.set(key, i);
    return i;
  }
  // --- moves (read.rs MoveCtx) ---
  moveRange(e) {
    const map = {'w:moveFromRangeStart': [0, true], 'w:moveFromRangeEnd': [0, false], 'w:moveToRangeStart': [1, true], 'w:moveToRangeEnd': [1, false]};
    const hit = map[e.name];
    if (!hit) return;
    const [side, start] = hit;
    const id = [...(e.attr('w:id') ?? '')].slice(0, 64).join('');
    const m = this.moves;
    const open = m.open[side];
    if (start) {
      const name = [...(e.attr('w:name') ?? '')].slice(0, 256).join('');
      if (!name || open.length >= 64 || (m.seen.size >= 100_000 && !m.seen.has(name))) return;
      m.seen.set(name, (m.seen.get(name) ?? 0) | (1 << (side * 2)));
      open.push([id, name]);
    } else {
      let i = -1;
      for (let k = open.length - 1; k >= 0; k--) if (open[k][0] === id) { i = k; break; }
      if (i >= 0) {
        const [, name] = open.splice(i, 1)[0];
        m.seen.set(name, (m.seen.get(name) ?? 0) | (2 << (side * 2)));
        m.closedHere[side] = name;
      }
    }
  }
  moveRevision(to, e, mark) {
    const side = to ? 1 : 0;
    const open = this.moves.open[side];
    const top = open.length ? open[open.length - 1][1] : null;
    const name = mark ? top ?? this.moves.closedHere[side] : top;
    return this.revisionNamed(to ? 'insert' : 'delete', e, name ?? null);
  }
  finishMoves() {
    const ends = new Map();
    for (const r of this.c.revisions) if (r.moveName) ends.set(r.moveName, (ends.get(r.moveName) ?? 0) | (r.kind === 'delete' ? 1 : 2));
    const ok = new Set([...ends].filter(([n, e]) => e === 3 && this.moves.seen.get(n) === 0b1111).map(([n]) => n));
    for (const r of this.c.revisions) if (r.moveName && !ok.has(r.moveName)) delete r.moveName;
  }

  // --- media and kept parts ---
  mediaFor(rels, rid) {
    const rel = rels.byId(rid);
    if (!rel || rel.external) return null;
    if (this.mediaByPath.has(rel.target)) return this.mediaByPath.get(rel.target);
    const bytes = this.pkg.get(rel.target);
    if (!bytes) return null;
    let base = (rel.target.split('/').pop() || 'image').replace(/[^A-Za-z0-9._-]/g, '');
    if (!base || base.startsWith('.')) base = `image${base}`;
    let key = base, n = 1;
    while (key in this.c.media) {
      n++;
      const d = base.lastIndexOf('.');
      key = d > 0 ? `${base.slice(0, d)}_${n}${base.slice(d)}` : `${base}_${n}`;
    }
    this.c.media[key] = toBase64(bytes);
    this.mediaByPath.set(rel.target, key);
    return key;
  }
  /** Keep a package part (and, through its relationships, every part it needs) verbatim. */
  keepPartTree(path, depth = 0) {
    if (depth > 8 || this.embedded.has(path) || this.embedded.size >= MAX_EMBEDDED_PARTS) return;
    const bytes = this.pkg.get(path);
    if (!bytes) return;
    this.embedded.set(path, this.types().of(path) ?? 'application/octet-stream');
    this.c.passthrough[path] = toBase64(bytes);
    const rp = relsPathOf(path);
    const rb = this.pkg.get(rp);
    if (rb) {
      this.c.passthrough[rp] = toBase64(rb);
      for (const r of this.pkg.rels(path).list) if (!r.external) this.keepPartTree(r.target, depth + 1);
    }
  }
  /** An element kept as raw XML with its relationship ids turned into self-describing placeholders. */
  keepEmbedded(el, rels) {
    const clone = e => {
      const out = new El(e.name, e.attrs.map(([k, v]) => {
        if (!isRelAttr(e.name, k)) return [k, v];
        const rel = rels.byId(v);
        if (!rel) return [k, v];
        if (!rel.external) this.keepPartTree(rel.target);
        this.embeddedRels.add(rel.target);
        return [k, `${REL_MARK}${rel.kind}|${rel.target}|${rel.external ? 1 : 0}`];
      }), []);
      for (const k of e.kids) out.kids.push(typeof k === 'string' ? k : clone(k));
      return out;
    };
    return clone(el).toXml();
  }

  // --- headers / footers (parts.rs) ---
  loadHeaderFooter(path, footer) {
    if (this.hfByPath.has(path)) return this.hfByPath.get(path);
    if (Object.keys(this.c.parts).length >= MAX_PARTS || this.hfDepth >= MAX_HF_DEPTH) return null;
    const id = this.addPart(footer ? 'footer' : 'header', []);
    if (!id) return null;
    this.hfByPath.set(path, id);
    let root;
    try { root = this.xml(path); } catch { root = null; }
    if (!root) return id;
    const rels = this.pkg.rels(path);
    const sc = new StoryCtx();
    sc.inHf = true;
    const blocks = [];
    this.hfDepth++;
    this.readBlocks(sc, root, rels, blocks, 0);
    this.hfDepth = Math.max(0, this.hfDepth - 1);
    this.flushPending(sc, blocks);
    if (blocks.length) this.c.parts[id].blocks = blocks;
    return id;
  }

  readTheme(path) {
    const t = this.pkg.xmlLenient(path);
    if (!t) return;
    const s = this.c.settings;
    const name = t.attr('name'); if (name) s.themeName = name;
    const el = t.child('a:themeElements');
    if (!el) return;
    const cs = el.child('a:clrScheme');
    if (cs) {
      const names = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
      const colors = s.themeColors.map(c => [...c]);
      while (colors.length < 12) colors.push([0, 0, 0]);
      names.forEach((n, i) => {
        const c = cs.child(`a:${n}`);
        if (!c) return;
        const rgb = parseRgb(c.child('a:srgbClr')?.attr('val')) ?? parseRgb(c.child('a:sysClr')?.attr('lastClr'));
        if (rgb) colors[i] = rgb;
      });
      this.pc.themeColors = colors.map(c => [...c]);
      s.themeColors = colors;
    }
    const fs = el.child('a:fontScheme');
    if (fs) {
      const face = n => fs.child(n)?.child('a:latin')?.attr('typeface') || null;
      const mj = face('a:majorFont'); if (mj) s.majorFont = mj;
      const mn = face('a:minorFont'); if (mn) s.minorFont = mn;
      this.pc.majorCs = fs.child('a:majorFont')?.child('a:cs')?.attr('typeface') ?? '';
      this.pc.minorCs = fs.child('a:minorFont')?.child('a:cs')?.attr('typeface') ?? '';
      const scripts = n => (fs.child(n)?.children('a:font') ?? []).map(e => [e.attr('script'), e.attr('typeface')])
        .filter(([sc, tf]) => sc && tf && sc.length <= 8 && tf.length < 256).slice(0, 256);
      this.pc.majorScripts = scripts('a:majorFont');
      this.pc.minorScripts = scripts('a:minorFont');
    }
    this.pc.majorFont = s.majorFont;
    this.pc.minorFont = s.minorFont;
    this.pc.theme = s.themeColors.map(c => [...c]);
  }

  readColorMapping(path) {
    const root = this.pkg.xmlLenient(path);
    if (!root) return;
    const b = root.child('w:themeFontLang')?.attr('w:bidi');
    this.pc.bidiScript = b && b.trim() ? langScript(b) : null;
    const m = root.child('w:clrSchemeMapping');
    if (!m) return;
    const names = ['dark1', 'light1', 'dark2', 'light2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hyperlink', 'followedHyperlink'];
    const attrs = ['w:t1', 'w:bg1', 'w:t2', 'w:bg2', 'w:accent1', 'w:accent2', 'w:accent3', 'w:accent4', 'w:accent5', 'w:accent6', 'w:hyperlink',
      'w:followedHyperlink'];
    this.pc.colorMap = attrs.map((a, i) => { const v = m.attr(a); const k = v === null ? -1 : names.indexOf(v); return k >= 0 ? k : i; });
  }

  readFontFamilies(path) {
    const table = this.pkg.xmlLenient(path);
    if (!table) return;
    this.c.settings.romanFonts = table.children('w:font').filter(f => f.child('w:family')?.attr('w:val') === 'roman')
      .map(f => f.attr('w:name')).filter(n => n && n.length <= 256).slice(0, 2000);
  }

  // --- styles (styles.rs) ---
  readStyles(path) {
    const root = this.xml(path);
    if (!root) return;
    const styleEls = root.children('w:style').slice(0, 10_000);
    const hasNormal = styleEls.some(s => s.attr('w:styleId') === 'Normal');
    if (!hasNormal) {
      const def = styleEls.find(s => s.attr('w:type') === 'paragraph' && ['1', 'true'].includes(s.attr('w:default')));
      const id = def?.attr('w:styleId');
      if (id) this.pc.alias.set(id, 'Normal');
    }
    const taken = styleEls.map(s => s.attr('w:styleId')).filter(x => x !== null);
    for (const s of styleEls) {
      const t = s.attr('w:type');
      if (t !== null && t !== 'paragraph') continue;
      const id = s.attr('w:styleId'), name = s.childVal('w:name');
      if (id === null || name === null) continue;
      const n = name.trim().toLowerCase();
      let canonical;
      if (n === 'toc heading') canonical = 'TOCHeading';
      else { const m = /^toc (\d)$/.exec(n); if (m && +m[1] >= 1 && +m[1] <= 9) canonical = `TOC${m[1]}`; else continue; }
      if (!taken.includes(canonical) && !this.pc.alias.has(id)) { taken.push(canonical); this.pc.alias.set(id, canonical); }
    }
    const sheet = emptyStyleSheet();
    const dd = root.child('w:docDefaults');
    sheet.defaultParaPresent = !!dd?.child('w:pPrDefault');
    if (dd) {
      const r = dd.child('w:rPrDefault')?.child('w:rPr');
      if (r) sheet.defaultChr = this.pc.rpr(r);
      const p = dd.child('w:pPrDefault')?.child('w:pPr');
      if (p) { sheet.defaultPara = this.pc.ppr(p)[0]; delete sheet.defaultPara.frame; }
    }
    if (sheet.defaultChr.size === undefined) sheet.defaultChr.size = 10;
    const latent = root.child('w:latentStyles');
    if (latent) { const x = latent.toXml(); if (x.length <= 1 << 20) sheet.latentStyles = x; }
    for (const s of styleEls) {
      const rawId = s.attr('w:styleId');
      if (!rawId) continue;
      const id = this.pc.styleId(rawId);
      const kind = {character: 'character', table: 'table', numbering: 'numbering'}[s.attr('w:type') ?? 'paragraph'] ?? 'paragraph';
      const nm = s.childVal('w:name');
      const r = n => { const v = s.childVal(n); return v ? this.pc.styleId(v) : null; };
      const isDefault = ['1', 'true'].includes(s.attr('w:default'));
      const englishDefault = (kind === 'paragraph' && id === 'Normal') || (kind === 'character' && id === 'DefaultParagraphFont')
        || (kind === 'table' && id === 'TableNormal') || (kind === 'numbering' && id === 'NoList');
      const basedOn = r('w:basedOn');
      const st = {
        id, name: nm !== null ? uiStyleName(nm) : id, kind, basedOn: basedOn !== id ? basedOn : null, next: r('w:next'), linked: r('w:link'),
        para: {}, chr: {}, priority: u32Of(s.childVal('w:uiPriority')), quick: flag(s, 'w:qFormat') ?? false,
        hidden: (flag(s, 'w:semiHidden') ?? false) || (flag(s, 'w:hidden') ?? false),
        builtin: !['1', 'true'].includes(s.attr('w:customStyle')), table: null,
      };
      if (flag(s, 'w:locked')) st.locked = true;
      if (isDefault && !englishDefault) st.default = true;
      const p = s.child('w:pPr'); if (p) st.para = this.pc.ppr(p)[0];
      const rp = s.child('w:rPr'); if (rp) st.chr = this.pc.rpr(rp);
      if (kind === 'table') {
        const parts = this.tableStyleParts(s, st);
        st.table = parts && Object.keys(parts).length ? parts : null;
      }
      const i = sheet.styles.findIndex(x => x.id === id);
      if (i >= 0) sheet.styles[i] = st; else sheet.styles.push(st);
    }
    // Styles that give only a list level take the list from their based-on style.
    const fixed = sheet.styles.map(s => {
      const n = s.para.numbering;
      if (n && n.num === LEVEL_ONLY) { const base = s.basedOn ? chainList(sheet, s.basedOn) : null; return base === null ? null : {num: base, level: n.level}; }
      return n ?? null;
    });
    sheet.styles.forEach((s, i) => { if (fixed[i]) s.para.numbering = fixed[i]; else delete s.para.numbering; });
    if (sheet.defaultPara.numbering?.num === LEVEL_ONLY) delete sheet.defaultPara.numbering;
    this.c.styles = sheet.styles.some(s => s.quick) ? sheet : addDefaultGallery(sheet);
  }
  tableStyleParts(s, st) {
    let t = {};
    const tp = s.child('w:tblPr');
    if (tp) {
      const b = tp.child('w:tblBorders'); if (b) t.borders = bordersOfEl(b);
      const shd = tp.child('w:shd'); const f = shd ? this.pc.shdFill(shd) : null; if (f) t.fill = f;
      const m = tp.child('w:tblCellMar'); if (m) t.cellMargins = marginsOfEl(m);
      const bs = u32Of(tp.childVal('w:tblStyleRowBandSize')); if (bs !== null) t.bandSize = Math.min(bs, 1000);
      const cbs = u32Of(tp.childVal('w:tblStyleColBandSize')); if (cbs !== null) t.colBandSize = Math.min(cbs, 1000);
    }
    for (const c of s.children('w:tblStylePr').slice(0, 64)) {
      const part = c.attr('w:type');
      if (!TABLE_PARTS.includes(part)) continue;
      const tc = c.child('w:tcPr');
      const ppr = c.child('w:pPr') ? this.pc.ppr(c.child('w:pPr'))[0] : null;
      const vv = tc?.childVal('w:vAlign');
      const f = {
        chr: c.child('w:rPr') ? this.pc.rpr(c.child('w:rPr')) : {},
        fill: tc?.child('w:shd') ? this.pc.shdFill(tc.child('w:shd')) : null,
        borders: tc?.child('w:tcBorders') ? bordersOfEl(tc.child('w:tcBorders')) : null,
        align: ppr?.align ?? null,
        vAlign: vv === null || vv === undefined ? null : vv === 'center' ? 'center' : vv === 'bottom' ? 'bottom' : 'top',
      };
      if (part === 'wholeTable') {
        if (ppr) st.para = {...st.para, ...ppr};
        st.chr = {...st.chr, ...f.chr};
        if (f.fill) t.fill = f.fill;
        const b = c.child('w:tblPr')?.child('w:tblBorders'); if (b) t.borders = bordersOfEl(b);
        if (f.vAlign) t.regions = {...(t.regions || {}), wholeTable: {...emptyPartFormat(), vAlign: f.vAlign}};
      } else t = setTablePart(t, part, f);
    }
    // Absent = default, as the model's own table styles are written (an empty CharProps, no fill,
    // no regions), so a style read back equals the one saved.
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v) && charIsEmpty(v))) delete t[k];
    }
    return t;
  }

  // --- numbering (styles.rs) ---
  readNumbering(path) {
    const root = this.xml(path);
    if (!root) return;
    const abstracts = [], links = [];
    for (const a of root.children('w:abstractNum').slice(0, 10_000)) {
      const id = u32Of(a.attr('w:abstractNumId'));
      if (id === null) continue;
      const levels = Array.from({length: 9}, () => newLevel({indent: 0, hanging: 0, text: ''}));
      for (const l of a.children('w:lvl')) {
        const i = u32Of(l.attr('w:ilvl')) ?? 0;
        if (i < 9) levels[i] = this.level(l);
      }
      const link = a.childVal('w:numStyleLink');
      if (link !== null) links.push([id, link]);
      const hex = v => v !== null && /^[0-9a-fA-F]{8}$/.test(v);
      const abs = {id, name: a.childVal('w:name'), levels};
      const nsid = a.childVal('w:nsid'); if (hex(nsid)) abs.nsid = nsid.toUpperCase();
      const tmpl = a.childVal('w:tmpl'); if (hex(tmpl)) abs.tmpl = tmpl.toUpperCase();
      const mlt = a.childVal('w:multiLevelType'); if (mlt === 'singleLevel' || mlt === 'hybridMultilevel') abs.multiLevelType = mlt;
      abstracts.push(abs);
    }
    const nums = [];
    for (const n of root.children('w:num').slice(0, 10_000)) {
      const id = u32Of(n.attr('w:numId')), abs = u32Of(n.childVal('w:abstractNumId'));
      if (id === null || abs === null) continue;
      const startOverrides = [], levelOverrides = [];
      for (const o of n.children('w:lvlOverride').slice(0, 9)) {
        const lvl = Math.min(u32Of(o.attr('w:ilvl')) ?? 0, 8);
        const so = u32Of(o.childVal('w:startOverride'));
        if (so !== null) startOverrides.push([lvl, so]);
        else { const s = u32Of(o.child('w:lvl')?.childVal('w:start')); if (s !== null) startOverrides.push([lvl, s]); }
        const l = o.child('w:lvl');
        if (l) levelOverrides.push([lvl, this.level(l)]);
      }
      const num = {id, abstractId: abs, startOverrides};
      if (levelOverrides.length) num.levelOverrides = levelOverrides;
      nums.push(num);
    }
    for (const [aid, style] of links) {
      const num = getStyle(this.c.styles, this.pc.styleId(style))?.para?.numbering?.num;
      const src = num === undefined ? undefined : nums.find(x => x.id === num)?.abstractId;
      const from = src !== undefined && src !== aid ? abstracts.find(a => a.id === src) : null;
      const to = abstracts.find(a => a.id === aid);
      if (from && to) to.levels = from.levels.map(l => ({...l}));
    }
    this.c.numbering = {abstracts, nums};
  }
  level(l) {
    const lv = newLevel({indent: 0, hanging: 0, text: ''});
    const st = u32Of(l.childVal('w:start')); if (st !== null) lv.start = st;
    const f = l.childVal('w:numFmt'); if (f !== null) lv.format = numFormatFromOoxml(f);
    const t = l.childVal('w:lvlText'); lv.text = t === null ? '' : [...t].slice(0, 64).join('');
    const j = l.childVal('w:lvlJc'); if (j !== null) lv.align = alignOf(j);
    const ind = l.child('w:pPr')?.child('w:ind');
    if (ind) {
      const v = tw(ind, 'w:left') ?? tw(ind, 'w:start'); if (v !== null) lv.indent = v;
      const h = tw(ind, 'w:hanging');
      if (h !== null) lv.hanging = h; else { const fl = tw(ind, 'w:firstLine'); if (fl !== null) lv.hanging = -fl; }
    }
    const r = l.child('w:rPr'); if (r) lv.chr = this.pc.rpr(r);
    lv.suffix = {space: 'space', nothing: 'nothing'}[l.childVal('w:suff')] ?? 'tab';
    lv.legal = flag(l, 'w:isLgl') ?? false;
    const restart = int(l.childVal('w:lvlRestart'));
    lv.restart = restart === null || restart !== 0;
    if (restart !== null && restart >= 1 && restart <= 9) lv.restartAfter = restart;
    const tab = l.child('w:pPr')?.child('w:tabs')?.children('w:tab').find(x => x.attr('w:val') === 'num');
    const tv = tab ? tw(tab, 'w:pos') : null;
    if (tv !== null && Number.isFinite(tv)) lv.tab = Math.max(-1584, Math.min(1584, tv));
    const ps = l.childVal('w:pStyle'); lv.style = ps ? this.pc.styleId(ps) : null;
    return lv;
  }

  // --- settings (meta.rs) ---
  readSettings(path) {
    const root = this.xml(path);
    if (!root) return;
    const rels = this.pkg.rels(path);
    const s = this.c.settings;
    for (const k of root.els()) {
      switch (k.name) {
        case 'w:attachedTemplate': {
          const rel = rels.byId(k.attr('r:id') ?? '');
          const t = rel?.target?.trim();
          s.attachedTemplate = t && t.length <= MAX_TEMPLATE_PATH ? t : null;
          break;
        }
        case 'w:linkStyles': s.linkStyles = onOff(k); break;
        // Mailings (U:quill/mailings): the kind of merge document; the data source is not kept (upstream drops it too).
        case 'w:mailMerge': { const kind = {formLetters: 'letters', email: 'emails', envelopes: 'envelopes', mailingLabels: 'labels', catalog: 'directory'}[k.childVal('w:mainDocumentType')]; s.mailMerge = kind ? {kind} : null; break; }
        case 'w:removePersonalInformation': s.removePersonalInfo = onOff(k); break;
        case 'w:removeDateAndTime': s.removeDateTime = onOff(k); break;
        case 'w:compat': {
          s.allowSpaceOfSameStyleInTable = k.child('w:allowSpaceOfSameStyleInTable') ? onOff(k.child('w:allowSpaceOfSameStyleInTable')) : false;
          const mode = k.children('w:compatSetting').find(c => c.attr('w:name') === 'compatibilityMode' && (c.attr('w:uri') === null || c.attr('w:uri') === 'http://schemas.microsoft.com/office/word'))?.attr('w:val');
          const m = u32Of(mode); if (m !== null) s.compatMode = Math.max(11, Math.min(99, m));
          s.sumParagraphSpacing = k.children('w:doNotUseHTMLParagraphAutoSpacing').some(onOff);
          s.doNotExpandShiftReturn = k.children('w:doNotExpandShiftReturn').some(onOff);
          break;
        }
        case 'w:trackRevisions': s.trackChanges = onOff(k); break;
        case 'w:doNotTrackMoves': s.trackMoves = !onOff(k); break;
        case 'w:defaultTabStop': { const v = tw(k, 'w:val'); if (v !== null && v > 0) s.defaultTab = Math.max(1, Math.min(1584, v)); break; }
        case 'w:evenAndOddHeaders': s.evenOddHeaders = onOff(k); break;
        case 'w:drawingGridHorizontalSpacing': case 'w:drawingGridVerticalSpacing': {
          const v = tw(k, 'w:val');
          if (v !== null && v > 0) { const c = Math.max(0.5, Math.min(1584, v)); if (k.name === 'w:drawingGridHorizontalSpacing') s.gridH = c; else s.gridV = c; }
          break;
        }
        case 'm:mathPr': s.math = readMathPr(k); break;
        case 'w:mirrorMargins': s.mirrorMargins = onOff(k); break;
        case 'w:autoHyphenation': s.autoHyphenation = onOff(k); break;
        case 'w:doNotHyphenateCaps': s.hyphenateCaps = !onOff(k); break;
        case 'w:hyphenationZone': { const v = tw(k, 'w:val'); if (v !== null && Number.isFinite(v) && v >= 0) s.hyphenationZone = Math.min(v, 1584); break; }
        case 'w:consecutiveHyphenLimit': { const v = u32Of(k.attr('w:val')); if (v !== null) s.consecutiveHyphenLimit = Math.min(v, 32_767); break; }
        case 'w:footnotePr': { const f = k.childVal('w:numFmt'); if (f !== null) s.footnoteFormat = numFormatFromOoxml(f); s.footnotePr = notePr(k, false); break; }
        case 'w:endnotePr': { const f = k.childVal('w:numFmt'); if (f !== null) s.endnoteFormat = numFormatFromOoxml(f); s.endnotePr = notePr(k, false); break; }
        case 'w:documentProtection': readProtection(k, s); break;
        // Word's view (U:quill/view): web, outline, normal (Draft); print and none are Print Layout.
        case 'w:view': { const v = {web: 'web', outline: 'outline', normal: 'draft'}[k.attr('w:val')]; s.view = v ?? null; break; }
        case 'w:zoom': {
          const percent = Math.max(10, Math.min(500, u32Of((k.attr('w:percent') ?? '').replace(/%+$/, '')) ?? 100));
          const fit = {fullPage: 'onePage', bestFit: 'pageWidth', textFit: 'textWidth'}[k.attr('w:val')] ?? null;
          s.zoom = percent !== 100 || fit ? {percent, fit} : null;
          break;
        }
        default:
      }
    }
  }

  // --- notes (meta.rs) ---
  readNotes(path, foot) {
    const root = this.xml(path);
    if (!root) return;
    const rels = this.pkg.rels(path);
    const tag = foot ? 'w:footnote' : 'w:endnote';
    for (const n of root.children(tag)) {
      const t = n.attr('w:type');
      if (t !== null && t !== 'normal') {
        if (['separator', 'continuationSeparator', 'continuationNotice'].includes(t)) this.readNoteSep(n, rels, foot, t);
        continue;
      }
      const fid = int(n.attr('w:id'));
      if (fid === null) continue;
      if (Object.keys(this.c.parts).length >= MAX_PARTS) break;
      const kind = foot ? 'footnote' : 'endnote';
      const id = this.addPart(kind, []);
      const sc = new StoryCtx();
      const blocks = [];
      this.currentNote = [kind, id];
      this.readBlocks(sc, n, rels, blocks, 0);
      this.flushPending(sc, blocks);
      this.currentNote = null;
      if (blocks.length) this.c.parts[id].blocks = blocks;
      (foot ? this.footnotes : this.endnotes).set(fid, id);
    }
  }
  readNoteSep(n, rels, foot, kind) {
    const seps = foot ? this.c.footnoteSeparators : this.c.endnoteSeparators;
    if (seps[kind]) return;
    const sc = new StoryCtx();
    const blocks = [];
    this.inNoteSep = true;
    this.readBlocks(sc, n, rels, blocks, 0);
    this.flushPending(sc, blocks);
    this.inNoteSep = false;
    if (!blocks.length) blocks.push(this.newPara());
    seps[kind] = blocks;
  }

  readApp(path) {
    const root = this.pkg.xmlLenient(path);
    if (!root) return;
    let kept = '';
    for (const e of root.els()) {
      const name = e.local(), value = e.text();
      if (APP_KEPT_PROPS.includes(name) && value.length <= 2048 && !/[\t\n]/.test(value)) kept += `${name}\t${value}\n`;
    }
    if (kept) this.c.passthrough[APP_KEPT] = toBase64(textBytes(kept));
  }

  // --- bibliography (meta.rs) ---
  /**
   * Sources from a `b:Sources` custom XML part (other custom XML is left alone); at most
   * MAX_SOURCES in all, and the document's citation style from `StyleName` (meta.rs `read_bibliography`).
   */
  readBibliography(path, seen) {
    const root = this.xml(path);
    if (!root || root.local() !== 'Sources') return;
    const room = Math.max(0, MAX_SOURCES - this.c.sources.length);
    const bib = parseBibliography(root, seen, room);
    if (this.c.settings.bibStyle === null || this.c.settings.bibStyle === undefined) this.c.settings.bibStyle = bib.style;
    this.c.sources.push(...bib.sources);
  }

  // --- comments (meta.rs) ---
  readComments(path, ext, ids, cex) {
    const root = this.xml(path);
    if (!root) return;
    const rels = this.pkg.rels(path);
    const byPara = new Map();
    let nextId = 0;
    const entries = new Map();
    const given = new Set(this.commentMap.values());
    for (const c of root.children('w:comment')) {
      if (Object.keys(this.c.parts).length >= MAX_PARTS) break;
      const fileId = c.attr('w:id') ?? '';
      if (this.commentMap.has(fileId)) continue;
      let id;
      if (/^\d+$/.test(fileId) && Number(fileId) <= 0xffffffff && !entries.has(Number(fileId))) id = Number(fileId);
      else { while (entries.has(nextId) || given.has(nextId)) nextId++; id = nextId; }
      const sc = new StoryCtx();
      const blocks = [];
      this.readBlocks(sc, c, rels, blocks, 0);
      this.flushPending(sc, blocks);
      const part = this.addPart('comment', blocks);
      const pid = c.children('w:p').pop()?.attr('w14:paraId');
      if (pid) byPara.set(pid, id);
      entries.set(id, newComment({author: c.attr('w:author') ?? '', initials: c.attr('w:initials') ?? '', date: c.attr('w:date') ?? '', part}));
      this.commentMap.set(fileId, id);
    }
    if (ext) {
      const x = this.pkg.xmlLenient(ext);
      for (const e of x?.elList() ?? []) {
        if (e.local() !== 'commentEx') continue;
        const cid = byPara.get(e.attr('w15:paraId'));
        if (cid === undefined) continue;
        const parent = byPara.get(e.attr('w15:paraIdParent'));
        const cm = entries.get(cid);
        if (cm) { cm.parent = parent !== undefined && parent !== cid ? parent : null; cm.resolved = ['1', 'true'].includes(e.attr('w15:done')); }
      }
    }
    const local = (e, name) => { for (const [k, v] of e.attrs) if (k.split(':').pop() === name) return v; return null; };
    const byDurable = new Map();
    if (ids) {
      const x = this.pkg.xmlLenient(ids);
      for (const e of x?.elList() ?? []) {
        if (e.local() !== 'commentId') continue;
        const cid = byPara.get(local(e, 'paraId'));
        const d = local(e, 'durableId');
        if (cid === undefined || !d || !durableIdOk(d)) continue;
        const cm = entries.get(cid);
        if (cm) { cm.durableId = d.toUpperCase(); byDurable.set(d.toUpperCase(), cid); }
      }
    }
    if (cex) {
      const x = this.pkg.xmlLenient(cex);
      for (const e of x?.elList() ?? []) {
        if (e.local() !== 'commentExtensible') continue;
        const cid = byDurable.get((local(e, 'durableId') ?? '').toUpperCase());
        const date = local(e, 'dateUtc');
        if (cid !== undefined && date && date.length <= 40 && /^[A-Za-z0-9:.+-]+$/.test(date)) entries.get(cid).dateUtc = date;
      }
    }
    for (const [k, v] of [...entries].sort((a, b) => a[0] - b[0])) this.c.comments[k] = v;
  }

  readCore(path) {
    const root = this.pkg.xmlLenient(path);
    if (!root) return;
    const c = this.c.core;
    for (const k of root.els()) {
      const t = k.text().trim();
      switch (k.name) {
        case 'dc:title': c.title = t; break;
        case 'dc:subject': c.subject = t; break;
        case 'dc:creator': c.creator = t; break;
        case 'cp:keywords': c.keywords = t; break;
        case 'dc:description': c.description = t; break;
        case 'cp:lastModifiedBy': c.lastModifiedBy = t; break;
        case 'cp:revision': c.revision = u32Of(t) ?? 0; break;
        case 'dcterms:created': c.created = t; break;
        case 'dcterms:modified': c.modified = t; break;
        case 'cp:category': c.category = t; break;
        default:
      }
    }
  }

  // --- stories (story.rs, story/blocks.rs) ---
  readBlocks(sc, parent, rels, out, depth) {
    if (depth > MAX_DEPTH) return;
    for (const e of parent.els()) {
      switch (e.name) {
        case 'w:p': {
          const p = this.readPara(sc, e, rels, depth);
          const prev = out[out.length - 1];
          if (prev?.kind === 'para' && prev.props?.dropCap && !prev.section && prev.text.length <= 16 && !p.props?.dropCap) {
            out.pop();
            const props = {...(p.props || {})};
            props.dropCap = prev.props.dropCap;
            if (prev.props.dropCapMargin !== undefined) props.dropCapMargin = prev.props.dropCapMargin;
            if (prev.props.dropCapDistance !== undefined) props.dropCapDistance = prev.props.dropCapDistance;
            const capFont = prev.runs[0]?.props?.font;
            const textFont = p.runs[0]?.props?.font;
            if (capFont !== undefined && capFont !== textFont) {
              prev.runs = prev.runs.map(r => { const q = {...(r.props || {})}; if (textFont === undefined) delete q.font; else q.font = textFont; return {len: r.len, props: q}; });
              props.dropCapFont = capFont;
            }
            const merged = {kind: 'para', id: prev.id, text: prev.text + p.text, runs: [...prev.runs, ...p.runs],
              objects: [...(prev.objects || []), ...(p.objects || [])], props, mark: p.mark};
            if (p.section) merged.section = p.section;
            out.push(finishPara(merged));
            continue;
          }
          out.push(p);
          break;
        }
        case 'w:tbl': {
          if (Math.floor(depth / 4) >= MAX_TABLE_DEPTH) {
            const p = this.newPara();
            p.text = cleanText(e.deepText());
            if (p.text) p.runs = [{len: p.text.length}];
            out.push(finishPara(p));
          } else {
            const t = this.readTable(sc, e, rels, depth);
            if (t) out.push(t);
          }
          break;
        }
        case 'w:sdt': this.readBlockSdt(sc, e, rels, out, depth); break;
        case 'w:customXml': case 'w:smartTag': case 'w:ins': case 'w:moveTo': this.readBlocks(sc, e, rels, out, depth + 1); break;
        case 'm:oMathPara': case 'm:oMath': {
          const wrapped = new El('w:p', [], [e]);
          out.push(this.readPara(sc, wrapped, rels, depth));
          break;
        }
        case 'mc:AlternateContent': { const c = childrenOfChoice(e); if (c) this.readBlocks(sc, c, rels, out, depth + 1); break; }
        case 'w:bookmarkStart': case 'w:bookmarkEnd': case 'w:commentRangeStart': case 'w:commentRangeEnd': case 'w:permStart': case 'w:permEnd': {
          const o = this.marker(e);
          if (o) sc.pending.push(o);
          break;
        }
        case 'w:moveFromRangeStart': case 'w:moveFromRangeEnd': case 'w:moveToRangeStart': case 'w:moveToRangeEnd': this.moveRange(e); break;
        default:
      }
    }
  }

  readBlockSdt(sc, e, rels, out, depth) {
    const content = e.child('w:sdtContent');
    if (!content) return;
    const ctl = sdtPr(e.child('w:sdtPr'), true);
    const ep = sdtEndPr(e.child('w:sdtEndPr')); if (ep) ctl.endPrXml = ep;
    const rp = e.child('w:sdtPr')?.child('w:rPr'); if (rp) ctl.runProps = this.pc.rpr(rp);
    const inner = [];
    this.readBlocks(sc, content, rels, inner, depth + 1);
    if (!inner.length) return;
    if (ctl.showingPlaceholder && inner[0].kind === 'para') ctl.placeholderText = placeholderOf(plainOf(inner[0]));
    const first = inner[0];
    if (first.kind === 'para') {
      const props = first.runs[0]?.props ?? first.mark ?? {};
      insertObjAt(first, 0, {type: 'controlStart', control: ctl}, props);
    } else first.controls = {open: [ctl, ...(first.controls?.open ?? [])], close: first.controls?.close ?? 0};
    const last = inner[inner.length - 1];
    if (last.kind === 'para') {
      const props = last.runs.length ? last.runs[last.runs.length - 1].props ?? {} : last.mark ?? {};
      insertObjAt(last, last.text.length, {type: 'controlEnd'}, props);
    } else last.controls = {open: last.controls?.open ?? [], close: (last.controls?.close ?? 0) + 1};
    out.push(...inner);
  }

  flushPending(sc, out) {
    if (!sc.pending.length) return;
    const p = lastParaOf(out, 0);
    if (p) {
      for (const o of sc.pending) {
        const props = p.runs.length ? p.runs[p.runs.length - 1].props ?? {} : {};
        p.text += OBJ;
        p.objects = [...(p.objects || []), o];
        p.runs.push(charIsEmpty(props) ? {len: 1} : {len: 1, props});
      }
      finishPara(p);
    }
    sc.pending = [];
  }

  marker(e) {
    const id = (e.attr('w:id') ?? '').trim();
    switch (e.name) {
      case 'w:bookmarkStart': {
        if (this.bookmarks.size >= 100_000) return null;
        const name = (e.attr('w:name') ?? '').trim();
        if (!name || name.length > 256) return null;
        this.bookmarks.set(id, name);
        return {type: 'bookmarkStart', name};
      }
      case 'w:bookmarkEnd': {
        const name = this.bookmarks.get(id) ?? (e.attr('w:name') ?? '').trim();
        return name && name.length <= 256 ? {type: 'bookmarkEnd', name} : null;
      }
      case 'w:commentRangeStart': { const c = this.commentMap.get(id); return c === undefined ? null : {type: 'commentStart', id: c}; }
      case 'w:permStart': {
        if (this.perms.size >= 100_000) return null;
        if (!this.perms.has(id)) this.perms.set(id, this.perms.size);
        const pid = this.perms.get(id);
        const text = a => { const v = e.attr(a); return v !== null && v.length <= 256 ? v : ''; };
        const group = text('w:edGrp'), editor = text('w:ed');
        if (!group && !editor) return null;
        const o = {type: 'permStart', id: pid};
        if (group) o.group = group;
        if (editor) o.editor = editor;
        return o;
      }
      case 'w:permEnd': { const p = this.perms.get(id); return p === undefined ? null : {type: 'permEnd', id: p}; }
      case 'w:commentRangeEnd': {
        const c = this.commentMap.get(id);
        if (c === undefined) return null;
        this.commentsEnded.add(c);
        return {type: 'commentEnd', id: c};
      }
      default: return null;
    }
  }

  readPara(sc, e, rels, depth) {
    const pb = new PB();
    const para = this.newPara(e.attr('w14:paraId'));
    let props = {}, mark = {};
    const markMoves = [null, null];
    this.moves.closedHere = [null, null];
    for (const o of sc.pending) pb.pushObj(o, {});
    sc.pending = [];
    const ppr = e.child('w:pPr');
    if (ppr) {
      [props, mark] = this.pc.ppr(ppr);
      resolveLevelOnly(this.c.styles, props, 'Normal');
      const rpr = ppr.child('w:rPr');
      if (rpr) {
        for (const k of rpr.els()) {
          if (k.name === 'w:ins') mark.ins = this.revision('insert', k);
          else if (k.name === 'w:del') mark.del = this.revision('delete', k);
          else if (k.name === 'w:moveTo') markMoves[1] = k;
          else if (k.name === 'w:moveFrom') markMoves[0] = k;
        }
        const fc = this.rprChange(rpr); if (fc) mark.fmtChange = fc;
      }
      const ch = ppr.child('w:pPrChange');
      if (ch) {
        let old = {};
        const o = ch.child('w:pPr');
        if (o) { old = this.pc.ppr(o)[0]; resolveLevelOnly(this.c.styles, old, 'Normal'); old = paraFormatting(old); }
        props.fmtChange = {rev: this.revision('format', ch), old};
      }
      if (props.numbering) {
        const nc = ppr.child('w:numPr')?.child('w:numberingChange');
        if (nc) props.numChange = {rev: this.revision('format', nc), original: [...(nc.attr('w:original') ?? '')].slice(0, 256).join('')};
      }
      const s = ppr.child('w:sectPr');
      if (s) para.section = this.readSection(s, rels, derivedId('s', para.id));
    }
    this.readInlineChildren(sc, pb, e, rels, {}, depth + 1);
    this.spillFields(sc, pb);
    if (markMoves[0]) mark.del = this.moveRevision(false, markMoves[0], true);
    if (markMoves[1]) mark.ins = this.moveRevision(true, markMoves[1], true);
    para.text = pb.text;
    para.runs = pb.runs;
    para.objects = pb.objects;
    para.props = props;
    para.mark = mark;
    if (sc.fields.some(f => f.phase === 'instr') && plainOf(para) === '') para.mark = {...para.mark, hidden: true};
    return finishPara(para);
  }

  rprChange(rpr) {
    const ch = rpr.child('w:rPrChange');
    if (!ch) return null;
    const o = ch.child('w:rPr');
    const old = o ? charFormatting(this.pc.rpr(o)) : {};
    return {rev: this.revision('format', ch), old};
  }

  readSection(s, rels, prefer = null) {
    const [sp, refs] = sectpr(s, this.id(prefer));
    const ch = s.child('w:sectPrChange');
    if (ch) {
      const o = ch.child('w:sectPr');
      const old = o ? sectpr(o, 'oldsect0')[0] : defaultSection('oldsect0');
      delete old.id;
      sp.fmtChange = {rev: this.revision('format', ch), old};
    }
    for (const r of refs) {
      const rel = rels.byId(r.rid);
      if (!rel || rel.external) continue;
      const id = this.loadHeaderFooter(rel.target, r.footer);
      if (!id) continue;
      const set = r.footer ? sp.footers : sp.headers;
      if (r.kind === 'first') set.first = id; else if (r.kind === 'even') set.even = id; else set.default = id;
    }
    return sp;
  }

  readTable(sc, t, rels, depth) {
    const table = {kind: 'table', id: null, props: {}, grid: [], rows: []};
    const tp = t.child('w:tblPr');
    if (tp) {
      table.props = this.pc.tblpr(tp);
      const ch = tp.child('w:tblPrChange');
      if (ch) { const o = ch.child('w:tblPr'); table.props.fmtChange = {rev: this.revision('format', ch), old: o ? this.pc.tblpr(o) : {}}; }
    }
    const g = t.child('w:tblGrid');
    if (g) table.grid = g.children('w:gridCol').slice(0, MAX_COLS).map(c => Math.max(0, Math.min(MAX_LEN_PT, tw(c, 'w:w') ?? 0)));
    const rows = [];
    collect(t, 'w:tr', rows, [], 0);
    for (const [tr, rowControls] of rows.slice(0, MAX_ROWS)) {
      const trp = tr.child('w:trPr');
      const row = {id: null, props: trp ? trpr(trp) : {}, cells: []};
      if (rowControls.open.length || rowControls.close) row.controls = rowControls;
      const ex = tr.child('w:tblPrEx'); if (ex) row.props.exceptions = this.pc.tblpr(ex);
      const rch = trp?.child('w:trPrChange');
      if (rch) { const o = rch.child('w:trPr'); row.props.fmtChange = {rev: this.revision('format', rch), old: o ? trpr(o) : {}}; }
      const tcs = [];
      collect(tr, 'w:tc', tcs, [], 0);
      for (const [tc, cellControls] of tcs.slice(0, MAX_COLS)) {
        const tcp = tc.child('w:tcPr');
        const [props, hcont] = tcp ? tcpr(this.pc, tcp) : [{span: 1}, false];
        const cch = tcp?.child('w:tcPrChange');
        if (cch) { const o = cch.child('w:tcPr'); props.fmtChange = {rev: this.revision('format', cch), old: o ? tcpr(this.pc, o)[0] : {}}; }
        if (hcont && row.cells.length) {
          const prev = row.cells[row.cells.length - 1];
          prev.props = {...prev.props, span: Math.min(63, (prev.props.span ?? 1) + Math.max(1, props.span ?? 1))};
          continue;
        }
        const blocks = [];
        this.readBlocks(sc, tc, rels, blocks, depth + 4);
        this.flushPending(sc, blocks);
        const cell = {id: this.derived('c', firstParaId(blocks)), props, blocks};
        if (cellControls.open.length || cellControls.close) cell.controls = cellControls;
        row.cells.push(cell);
      }
      if (row.cells.length) { row.id = this.derived('r', row.cells[0].id); table.rows.push(row); }
    }
    if (!table.rows.length) return null;
    table.id = this.derived('t', table.rows[0].id);
    if (!table.grid.length) {
      let cols = 0;
      for (const r of table.rows) cols = Math.max(cols, (r.props.gridBefore ?? 0) + r.cells.reduce((s, c) => s + (c.props.span ?? 1), 0) + (r.props.gridAfter ?? 0));
      table.grid = new Array(Math.max(1, Math.min(MAX_COLS, cols))).fill(72);
    }
    return table;
  }

  // --- runs (story/runs.rs) ---
  readInlineChildren(sc, pb, e, rels, ctx, depth) {
    if (depth > MAX_DEPTH) return;
    for (const k of e.els()) this.readInline(sc, pb, k, rels, ctx, depth);
  }
  /** Word's Picture watermark (a v:imagedata shape in a header): the picture as media at the size the shape has, washed out when it has Word's gain. */
  pictureWatermark(shape, rels) {
    const data = shape.child('v:imagedata');
    const rid = data?.attr('r:id') ?? data?.attr('r:embed') ?? data?.attr('o:relid');
    const media = rid ? this.mediaFor(rels, rid) : null;
    if (!media) return null;
    const style = shape.attr('style') ?? '';
    const len = k => { const v = vmlStyle(style, k); const m = v === null ? null : measure(v, 1); return m !== null && m > 0 ? Math.min(m, 4000) : null; };
    const w = len('width') ?? 300, h = len('height') ?? 300;
    return {picture: {media, w, h}, scale: 100, washout: data.attr('gain') !== null || data.attr('blacklevel') !== null, text: '', font: defaultWatermark().font, color: defaultWatermark().color, diagonal: false, semitransparent: true};
  }
  readInline(sc, pb, k, rels, ctx, depth) {
    switch (k.name) {
      case 'w:r': this.readRun(sc, pb, k, rels, ctx, depth); break;
      case 'w:hyperlink': {
        const rel = k.attr('r:id') !== null ? rels.byId(k.attr('r:id')) : null;
        const url = rel ? rel.target.trim() || null : null;
        const anchor = k.attr('w:anchor') || null;
        const link = url && anchor ? `${url}#${anchor}` : url ? url : anchor ? `#${anchor}` : ctx.link ?? null;
        const linkTip = link && k.attr('w:tooltip') ? k.attr('w:tooltip') : null;
        this.readInlineChildren(sc, pb, k, rels, {...ctx, link, linkTip}, depth + 1);
        break;
      }
      case 'w:ins': case 'w:moveTo':
        this.readInlineChildren(sc, pb, k, rels, {...ctx, ins: k.name === 'w:moveTo' ? this.moveRevision(true, k, false) : this.revision('insert', k)}, depth + 1);
        break;
      case 'w:del': case 'w:moveFrom':
        this.readInlineChildren(sc, pb, k, rels, {...ctx, del: k.name === 'w:moveFrom' ? this.moveRevision(false, k, false) : this.revision('delete', k)}, depth + 1);
        break;
      case 'w:moveFromRangeStart': case 'w:moveFromRangeEnd': case 'w:moveToRangeStart': case 'w:moveToRangeEnd': this.moveRange(k); break;
      case 'w:fldSimple': {
        const instr = k.attr('w:instr') ?? '';
        const r0 = k.child('w:r')?.child('w:rPr');
        const props = r0 ? this.runProps(r0, ctx) : runPropsNone(ctx);
        this.beginField(sc, props, instr, onOffAttr(k, 'w:fldLock'), onOffAttr(k, 'w:dirty'), '');
        this.separateField(sc, pb);
        this.readInlineChildren(sc, pb, k, rels, ctx, depth + 1);
        this.endField(sc, pb);
        break;
      }
      case 'w:bookmarkStart': case 'w:bookmarkEnd': case 'w:commentRangeStart': case 'w:commentRangeEnd': case 'w:permStart': case 'w:permEnd': {
        const o = this.marker(k);
        if (o) pb.pushObj(o, runPropsNone(ctx));
        break;
      }
      case 'w:sdt': {
        const c = k.child('w:sdtContent');
        if (!c) return;
        const ctl = sdtPr(k.child('w:sdtPr'), false);
        const ep = sdtEndPr(k.child('w:sdtEndPr')); if (ep) ctl.endPrXml = ep;
        const rp = k.child('w:sdtPr')?.child('w:rPr'); if (rp) ctl.runProps = this.pc.rpr(rp);
        const fr = c.find('w:rPr');
        const props = fr ? this.runProps(fr, ctx) : runPropsNone(ctx);
        const at = pb.text.length;
        pb.pushObj({type: 'controlStart', control: ctl}, props);
        this.readInlineChildren(sc, pb, c, rels, ctx, depth + 1);
        if (ctl.showingPlaceholder) ctl.placeholderText = placeholderOf(pb.text.slice(at).split(OBJ).join(''));
        const endProps = pb.runs.length ? pb.runs[pb.runs.length - 1].props : props;
        pb.pushObj({type: 'controlEnd'}, endProps);
        break;
      }
      case 'w:smartTag': case 'w:customXml': case 'w:dir': case 'w:bdo': this.readInlineChildren(sc, pb, k, rels, ctx, depth + 1); break;
      case 'm:oMath': case 'm:oMathPara': this.emitObj(sc, pb, this.equation(k), runPropsNone(ctx)); break;
      case 'mc:AlternateContent': {
        const kept = this.keptAlternate(k, rels);
        if (kept) { this.emitObj(sc, pb, kept, runPropsNone(ctx)); break; }
        const c = childrenOfChoice(k);
        if (c) this.readInlineChildren(sc, pb, c, rels, ctx, depth + 1);
        break;
      }
      case 'w:br': case 'w:cr': this.readRunChild(sc, pb, k, runPropsNone(ctx), rels, {note: null}, depth + 1); break;
      default:
    }
  }
  runProps(rpr, ctx) {
    const p = this.pc.rpr(rpr);
    if (ctx.link) p.link = ctx.link;
    if (ctx.link && ctx.linkTip) p.linkTip = ctx.linkTip;
    if (ctx.ins !== undefined && ctx.ins !== null) p.ins = ctx.ins;
    if (ctx.del !== undefined && ctx.del !== null) p.del = ctx.del;
    const fc = this.rprChange(rpr); if (fc) p.fmtChange = fc;
    return p;
  }
  readRun(sc, pb, r, rels, ctx, depth) {
    const rp = r.child('w:rPr');
    const props = rp ? this.runProps(rp, ctx) : runPropsNone(ctx);
    const st = {note: null};
    for (const k of r.els()) this.readRunChild(sc, pb, k, props, rels, st, depth + 1);
    if (st.note) { const [kind, id, custom] = st.note; this.emitObj(sc, pb, noteRef(kind, id, custom ?? ''), props); }
  }
  readRunChild(sc, pb, k, props, rels, st, depth) {
    if (depth > MAX_DEPTH) return;
    if (st.note && st.note[2] !== null && k.name === 'w:t') { st.note[2] += cleanText(k.text()); return; }
    if (k.name !== 'w:rPr' && st.note) { const [kind, id, custom] = st.note; st.note = null; this.emitObj(sc, pb, noteRef(kind, id, custom ?? ''), props); }
    const inInstr = () => sc.fields.some(f => f.phase === 'instr');
    switch (k.name) {
      case 'w:t': case 'w:delText': this.emitText(sc, pb, cleanText(k.text()), props); break;
      case 'w:instrText': case 'w:delInstrText': {
        const f = sc.fields[sc.fields.length - 1];
        if (f && f.phase === 'instr' && !f.spilled && f.instr.length < MAX_INSTR) f.instr += k.text();
        break;
      }
      case 'w:tab': this.emitText(sc, pb, '\t', props); break;
      case 'w:ptab': {
        const align = ['left', 'center', 'right'].includes(k.attr('w:alignment')) ? k.attr('w:alignment') : null;
        const rel = ['margin', 'indent'].includes(k.attr('w:relativeTo')) ? k.attr('w:relativeTo') : null;
        if (align && rel) this.emitObj(sc, pb, {type: 'positionalTab', align, relative_to: rel, leader: tabLeaderOf(k.attr('w:leader') ?? 'none')}, props);
        else this.emitText(sc, pb, '\t', props);
        break;
      }
      case 'w:br': {
        if (inInstr()) return;
        const ty = (k.attr('w:type') ?? '').trim().toLowerCase();
        this.emitText(sc, pb, ty === 'page' ? '\u000C' : ty === 'column' ? '\u000E' : '\n', props);
        break;
      }
      case 'w:cr': if (!inInstr()) this.emitText(sc, pb, '\n', props); break;
      case 'w:noBreakHyphen': this.emitText(sc, pb, '‑', props); break;
      case 'w:softHyphen': this.emitText(sc, pb, '­', props); break;
      case 'w:sym': {
        let h = (k.attr('w:char') ?? '').trim();
        h = h.replace(/^0x/i, '').replace(/^u\+/i, '').replace(/^#x/i, '');
        const cp = /^[0-9a-fA-F]+$/.test(h) ? parseInt(h, 16) : NaN;
        if (Number.isFinite(cp) && cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          const p = {...props};
          const f = k.attr('w:font');
          if (f && f.trim()) p.symFont = f;
          this.emitText(sc, pb, String.fromCodePoint(cp), p);
        }
        break;
      }
      case 'w:fldChar': {
        const t = k.attr('w:fldCharType');
        if (t === 'begin') {
          const ff = k.child('w:ffData');
          let form = ff ? ff.toXml() : '';
          if (form.length > MAX_FORM) form = '';
          this.beginField(sc, {...props}, '', onOffAttr(k, 'w:fldLock'), onOffAttr(k, 'w:dirty'), form);
        } else if (t === 'separate') this.separateField(sc, pb);
        else if (t === 'end') this.endField(sc, pb);
        break;
      }
      case 'w:drawing': { const o = this.readDrawing(sc, k, rels); if (o) this.emitObj(sc, pb, o, props); break; }
      case 'w:pict': {
        // read/story/vml.rs read_vml_all: in a header or footer, Word's text watermark is the
        // document's watermark (the first one found), drawn on every page, not a shape of its own.
        let pict = k;
        if (sc.inHf && !sc.storyDepth) {
          const shapes = k.elList().filter(e => e.name.startsWith('v:') && e.local() !== 'shapetype');
          const picMarks = shapes.filter(e => /^WordPictureWatermark/.test(e.attr('id') ?? '') && e.child('v:imagedata'));
          const marks = [...shapes.filter(e => vmlWatermark(e) !== null), ...picMarks];
          if (marks.length) {
            if (!this.c.settings.watermark) this.c.settings.watermark = picMarks.includes(marks[0]) ? this.pictureWatermark(marks[0], rels) : vmlWatermark(marks[0]);
            const rest = k.kids.filter(e => typeof e === 'string' || !marks.includes(e));
            if (!rest.some(e => typeof e !== 'string' && e.name.startsWith('v:') && e.local() !== 'shapetype')) break;
            pict = new El(k.name, k.attrs, rest);
          }
        }
        this.emitObj(sc, pb, this.opaqueRun(pict, rels), props);
        break;
      }
      case 'w:object': case 'w:contentPart': this.emitObj(sc, pb, this.opaqueRun(k, rels), props); break;
      case 'w:footnoteReference': case 'w:endnoteReference': {
        const foot = k.local() === 'footnoteReference';
        const fid = int(k.attr('w:id'));
        const id = fid === null ? undefined : (foot ? this.footnotes : this.endnotes).get(fid);
        if (id !== undefined) st.note = [foot ? 'footnote' : 'endnote', id, onOffAttr(k, 'w:customMarkFollows') ? '' : null];
        break;
      }
      case 'w:footnoteRef': case 'w:endnoteRef': {
        const kind = k.local() === 'footnoteRef' ? 'footnote' : 'endnote';
        if (this.currentNote && this.currentNote[0] === kind) st.note = [kind, this.currentNote[1], null];
        break;
      }
      case 'w:separator': case 'w:continuationSeparator':
        if (this.inNoteSep) {
          const el = k.name === 'w:continuationSeparator' ? 'w:continuationSeparator' : 'w:separator';
          this.emitObj(sc, pb, {type: 'opaque', format: 'docx', xml: `<w:r><${el}/></w:r>`, text: ''}, props);
        }
        break;
      case 'w:commentReference': {
        const cid = this.commentMap.get(k.attr('w:id') ?? '');
        if (cid !== undefined && !this.commentsEnded.has(cid)) { this.commentsEnded.add(cid); pb.pushObj({type: 'commentEnd', id: cid}, props); }
        break;
      }
      case 'w:pgNum': this.emitObj(sc, pb, {type: 'field', instr: 'PAGE', result: '', locked: false}, props); break;
      case 'w:ruby': this.readRuby(sc, pb, k, props); break;
      case 'mc:AlternateContent': {
        const kept = this.keptAlternate(k, rels);
        if (kept) { this.emitObj(sc, pb, kept, props); break; }
        const c = childrenOfChoice(k);
        if (c) for (const x of c.els()) this.readRunChild(sc, pb, x, props, rels, st, depth + 1);
        break;
      }
      default:
    }
  }
  /** `w:ruby`: one ruby object in the base text's formatting. */
  readRuby(sc, pb, k, props) {
    const MAX = 4096;
    const part = name => {
      let text = '', first = null;
      for (const r of k.child(name)?.children('w:r') ?? []) {
        if (first === null) first = r.child('w:rPr') ? this.pc.rpr(r.child('w:rPr')) : {};
        for (const t of r.elList()) if ((t.name === 'w:t' || t.name === 'w:delText') && text.length < MAX) text += cleanText(t.text()).replace(/\t/g, ' ');
      }
      return [[...text].slice(0, MAX).join(''), first];
    };
    const [base, baseProps] = part('w:rubyBase');
    const [ruby, rubyProps] = part('w:rt');
    const bp = {...(baseProps ?? {})};
    for (const x of ['link', 'linkTip', 'ins', 'del']) { if (props[x] !== undefined) bp[x] = props[x]; else delete bp[x]; }
    if (!base) return;
    if (!ruby) { this.emitText(sc, pb, base, bp); return; }
    const pr = k.child('w:rubyPr');
    const val = n => pr?.child(n)?.attr('w:val') ?? null;
    const pt = n => { const v = measure(val(n), 2); return v !== null && Number.isFinite(v) && v >= 0 ? v : null; };
    let rp = {...(rubyProps ?? {})};
    const hb = pt('w:hpsBaseText');
    const baseSize = Math.min((hb !== null && hb > 0 ? hb : bp.size) ?? 0, 1584);
    const hs = pt('w:hps');
    const size = Math.max(1, Math.min(1584, (hs !== null && hs > 0 ? hs : rp.size) ?? (baseSize > 0 ? baseSize / 2 : 5)));
    const raise = Math.min(pt('w:hpsRaise') ?? rubyRaise(0, Math.max(baseSize, size), size), 1584);
    delete rp.size; delete rp.sizeCs;
    rp = charMinus(rp, bp);
    const align = RUBY_ALIGNS.includes(val('w:rubyAlign')) ? val('w:rubyAlign') : 'center';
    const lang = [...(val('w:lid') ?? '')].slice(0, 32).join('');
    const obj = {type: 'ruby', base, ruby, align, size, raise, base_size: baseSize};
    if (lang) obj.lang = lang;
    if (!charIsEmpty(rp)) obj.props = rp;
    this.emitObj(sc, pb, obj, bp);
  }
  emitText(sc, pb, s, props) {
    const f = sink(sc);
    if (f) { if (f.phase === 'result' && f.buf.length < 100_000) f.buf.push(['t', s, props]); }
    else pb.pushText(s, props);
  }
  emitObj(sc, pb, o, props) {
    const f = sink(sc);
    if (f) { if (f.phase === 'result' && f.buf.length < 100_000) f.buf.push(['o', o, props]); }
    else pb.pushObj(o, props);
  }

  // --- fields (story/fields.rs) ---
  beginField(sc, props, instr, locked, dirty, form) {
    if (sc.fields.length >= MAX_FIELD_DEPTH || sc.ignoredBegins > 0) { sc.ignoredBegins++; return; }
    sc.fields.push(new FieldState(props, instr, locked, dirty, form));
  }
  static parentInInstr(sc) {
    const n = sc.fields.length;
    const p = n >= 2 ? sc.fields[n - 2] : null;
    return !!p && !p.spilled && !p.range && p.phase === 'instr';
  }
  fieldStartObj(f) { const o = {type: 'fieldStart', instr: f.instr.trim(), locked: f.locked}; if (f.dirty) o.dirty = true; return o; }
  separateField(sc, pb) {
    if (sc.ignoredBegins > 0) return;
    const nested = Reader.parentInInstr(sc);
    const f = sc.fields[sc.fields.length - 1];
    if (!f || f.range) return;
    f.phase = 'result';
    if (!f.spilled && !nested && isRangeInstr(f.instr)) {
      f.range = true;
      this.emitObj(sc, pb, this.fieldStartObj(f), f.props);
    }
  }
  endField(sc, pb) {
    if (sc.ignoredBegins > 0) { sc.ignoredBegins--; return; }
    const nested = Reader.parentInInstr(sc);
    const f = sc.fields.pop();
    if (!f) return;
    if (f.range) { this.emitObj(sc, pb, {type: 'fieldEnd'}, f.props); return; }
    if (f.spilled) return;
    if (f.phase === 'instr' && !nested && isRangeInstr(f.instr)) {
      this.emitObj(sc, pb, this.fieldStartObj(f), f.props);
      this.emitObj(sc, pb, {type: 'fieldEnd'}, f.props);
      return;
    }
    const target = nested ? null : hyperlinkTarget(f.instr);
    if (target !== null) {
      for (const [kind, x, p] of f.buf) {
        const q = p.link ? p : {...p, link: target};
        if (kind === 't') this.emitText(sc, pb, x, q); else this.emitObj(sc, pb, x, q);
      }
      return;
    }
    const tracked = f.buf.some(([, , p]) => (p.ins ?? null) !== (f.props.ins ?? null) || (p.del ?? null) !== (f.props.del ?? null));
    if (!nested && (tracked || f.buf.some(([k, x]) => k === 'o' && isFramed(x)))) {
      this.emitObj(sc, pb, this.fieldStartObj(f), f.props);
      for (const [kind, x, p] of f.buf) { if (kind === 't') this.emitText(sc, pb, x, p); else this.emitObj(sc, pb, x, p); }
      this.emitObj(sc, pb, {type: 'fieldEnd'}, f.props);
      return;
    }
    let result = '';
    for (const [kind, x] of f.buf) result += kind === 't' ? x : objPlain(x);
    let props = f.props;
    for (const [kind, x, p] of f.buf) { if ((kind === 't' && x) || (kind === 'o' && objPlain(x))) { props = p; break; } }
    const obj = {type: 'field', instr: f.instr.trim(), result, locked: f.locked};
    if (f.dirty) obj.dirty = true;
    if (f.form) obj.form = f.form;
    const parent = sc.fields[sc.fields.length - 1];
    if (parent && !parent.spilled && parent.phase === 'instr') { parent.instr += result; return; }
    this.emitObj(sc, pb, obj, props);
  }
  spillFields(sc, pb) {
    for (const f of sc.fields) {
      if (f.spilled || f.range) continue;
      f.spilled = true;
      const o = {type: 'field', instr: f.instr.trim(), result: '', locked: f.locked};
      if (f.dirty) o.dirty = true;
      if (f.form) o.form = f.form;
      f.form = '';
      pb.pushObj(o, f.props);
      for (const [kind, x, p] of f.buf) { if (kind === 't') pb.pushText(x, p); else pb.pushObj(x, p); }
      f.buf = [];
    }
  }

  // --- drawings (story/drawing.rs) ---
  readDrawing(sc, d, rels) {
    let c = d.child('wp:inline'), anchored = false;
    if (!c) { c = d.child('wp:anchor'); anchored = true; }
    if (!c) return null;
    const ext = c.child('wp:extent');
    const dim = n => Math.max(0, Math.min(MAX_LEN_PT, measure(ext?.attr(n), 12_700) ?? 0));
    const w = dim('cx'), h = dim('cy');
    const gd = c.child('a:graphic')?.child('a:graphicData');
    if (!gd) return null;
    const uri = gd.attr('uri') ?? '';
    // Shapes this app wrote (ink strokes, Ink to Shape results): real shapes in the model, not kept whole.
    const wpc = gd.child('wpc:wpc');
    if (wpc && /^Drawing Canvas \d+$/.test(c.child('wp:docPr')?.attr('name') ?? '') && !wpc.child('wps:wsp') && !wpc.child('wpg:wgp') && !wpc.find('pic:pic')) {
      // A Drawing Canvas this app wrote: an empty canvas with its fill and outline.
      const solid = e => parseRgb(e?.child('a:solidFill')?.child('a:srgbClr')?.attr('val'));
      const ln = wpc.child('wpc:whole')?.child('a:ln');
      const lw = measure(ln?.attr('w'), 12_700);
      const float = anchored ? anchorFloat(c) : defaultFloat();
      return {type: 'group', w, h, float, ch_w: w, ch_h: h, children: [], canvas: {fill: (wpc.child('wpc:bg') && readFill(wpc.child('wpc:bg'))) || solid(wpc.child('wpc:bg')), stroke: ln && !ln.child('a:noFill') ? solid(ln) : null, strokeWidth: lw === null ? 0.75 : lw}};
    }
    const wsp = gd.child('wps:wsp');
    if (wsp) {
      const shape = this.readShape(wsp, c, anchored, w, h, rels);
      if (shape) return shape;
    }
    if (uri.endsWith('/chart')) {
      const chart = this.readChartFrame(gd, c, d, rels, anchored, w, h);
      if (chart) return chart;
    }
    if (uri.endsWith('/diagram')) {
      const sa = this.readSmartArtFrame(gd, c, rels, anchored, w, h);
      if (sa) return sa;
    }
    const picture = uri.endsWith('/picture') || (!gd.child('wps:wsp') && !gd.child('wpg:wgp') && !gd.child('wpc:wpc') && !uri.endsWith('/chart')
      && !uri.endsWith('/diagram') && uri !== INK_URI && gd.find('a:blip'));
    if (!picture) return this.opaqueRun(d, rels, w, h);
    const [alt, meta] = nvAlt(c.child('wp:docPr'));
    const float = anchored ? anchorFloat(c) : defaultFloat();
    if (meta.title || meta.decorative) float.alt = meta;
    if (onOffAttr(c.child('wp:docPr') ?? new El('x'), 'hidden')) float.hidden = true;
    const ee = c.child('wp:effectExtent');
    if (ee) float.effect = ['l', 't', 'r', 'b'].map(n => Math.max(-1584, Math.min(1584, measure(ee.attr(n), 12_700) ?? 0)));
    const obj = this.readPic(gd, rels, w, h, alt, float);
    if (!obj) return this.opaqueRun(d, rels, w, h);
    const sp = new Spin(obj.float.rot ?? 0, obj.float.flipH, obj.float.flipV);
    const [bw, bh] = sp.extent(w, h);
    const px = (bw - w) / 2, py = (bh - h) / 2;
    obj.float.effect = (obj.float.effect ?? [0, 0, 0, 0]).map((e, i) => (e !== 0 ? Math.max(0, Math.min(1584, e - (i % 2 === 0 ? px : py))) : 0));
    return obj;
  }
  /** A diagram (`dgm:relIds`): its data part read into an editable SmartArt model (lib/docx-smartart.mjs); null (kept whole) when it has none. */
  readSmartArtFrame(gd, c, rels, anchored, w, h) {
    const read = readSmartArt(this.pkg, rels, gd);
    if (!read) return null;
    const spec = read.spec;
    for (const t of read.targets) this.embeddedRels.add(t);
    const [alt, meta] = nvAlt(c.child('wp:docPr'));
    const float = anchored ? anchorFloat(c) : defaultFloat();
    if (meta.title || meta.decorative) float.alt = meta;
    if (onOffAttr(c.child('wp:docPr') ?? new El('x'), 'hidden')) float.hidden = true;
    return {type: 'graphic', w, h, alt, float, graphic: {kind: 'diagram', items: [], w, h, smartArt: spec}};
  }
  /**
   * A chart (`c:chart` in a drawing): the chart part is read into the chart model (lib/chart-part.mjs) and kept as it was (`graphic.raw`:
   * the drawing's markup, which the writer puts back until a command edits the chart or its frame changes). A chart whose plot the
   * model cannot hold (3-D, bubble, mixed groups) returns null and is kept whole as an opaque drawing.
   */
  readChartFrame(gd, c, d, rels, anchored, w, h) {
    const rid = gd.child('c:chart')?.attr('r:id');
    const rel = rid ? rels.byId(rid) : null;
    if (!rel || rel.external) return null;
    const chart = readChartSpec(this.pkg.xmlLenient(rel.target));
    if (!chart) return null;
    const [alt, meta] = nvAlt(c.child('wp:docPr'));
    const float = anchored ? anchorFloat(c) : defaultFloat();
    if (meta.title || meta.decorative) float.alt = meta;
    if (onOffAttr(c.child('wp:docPr') ?? new El('x'), 'hidden')) float.hidden = true;
    const raw = {xml: `<w:r>${this.keepEmbedded(d, rels)}</w:r>`, w, h, float: JSON.stringify(float)};
    return {type: 'graphic', w, h, alt, float, graphic: {kind: 'chart', chart, raw}};
  }
  /**
   * A `wps:wsp` this app wrote (its drawing is named `Ink <Pen> <n> [#order]` or `Shape <n>`) with no text box,
   * gradient, picture fill or effects: preset or custom geometry, solid fill, outline and arrowheads (read/freeform.rs
   * `cust_geom`, `ink_tool`, `ink_order`, `line_alpha`). Anything else stays kept whole (null).
   */
  readShape(wsp, c, anchored, w, h, rels = null) {
    const name = c.child('wp:docPr')?.attr('name') ?? '';
    if (!/^(Ink (Pen|Pencil|Highlighter)\b|Shape \d+$|Text Box \d+$)/.test(name)) return null;
    const isBox = /^Text Box/.test(name);
    // A text box this app wrote (its text and body properties); linked boxes and anything else stay whole.
    if (wsp.child('wps:linkedTxbx') || (wsp.child('wps:txbx') && !(isBox && rels))) return null;
    const sp = wsp.child('wps:spPr');
    if (!sp || sp.child('a:pattFill')) return null;
    // A gradient or see-through fill and shadow, glow and soft edges (Shape Format) this reads; anything else keeps the shape whole.
    const fx = readEffects(sp);
    if (fx === undefined) return null;
    const ln = sp.child('a:ln');
    if (ln?.child('a:gradFill') || ln?.child('a:prstDash') || ln?.child('a:custDash')) return null;
    const PRST = {rect: 'rectangle', roundRect: 'roundedRectangle', ellipse: 'ellipse', flowChartOr: 'flowchartOr', triangle: 'triangle', rtTriangle: 'rightTriangle', diamond: 'diamond',
      line: 'line', straightConnector1: 'straightConnector', bentConnector3: 'elbowConnector', curvedConnector3: 'curvedConnector', rightArrow: 'arrow', leftArrow: 'arrowLeft',
      upArrow: 'arrowUp', downArrow: 'arrowDown', star5: 'star', heart: 'heart'};
    const float = anchored ? anchorFloat(c) : defaultFloat();
    const spin = xfrmSpin(sp);
    if (spin.deg) float.rot = normalizeDegrees(spin.deg);
    if (spin.flipH) float.flipH = true;
    if (spin.flipV) float.flipV = true;
    if (onOffAttr(c.child('wp:docPr') ?? new El('x'), 'hidden')) float.hidden = true;
    const obj = {type: 'shape', kind: 'rectangle', w, h, fill: null, stroke: null, strokeWidth: 0.75, float};
    if (isBox) {
      const txbx = wsp.child('wps:txbx')?.child('w:txbxContent');
      const sc = new StoryCtx();
      const blocks = [];
      if (txbx) { this.readBlocks(sc, txbx, rels, blocks, 4); this.flushPending(sc, blocks); }
      const id = this.addPart('textBox', blocks.length ? blocks : []);
      if (blocks.length) this.c.parts[id].blocks = blocks;
      const bp = wsp.child('wps:bodyPr');
      const body = {vert: textVertFromOoxml(bp?.attr('vert') ?? 'horz'), anchor: valignFromAnchor(bp?.attr('anchor') ?? 't'), next: null, inset: null, autoFit: false};
      const ins = ['lIns', 'tIns', 'rIns', 'bIns'].map(k => int(bp?.attr(k)));
      if (ins.every(v => v !== null)) body.inset = ins;
      this.c.parts[id].body = body;
      obj.kind = 'textBox';
      obj.story = id;
      const warp = bp?.child('a:prstTxWarp');
      if (warp?.attr('prst') && warp.attr('prst') !== 'textNoShape') {
        const adj = (warp.child('a:avLst')?.children('a:gd') ?? []).map(g => [g.attr('name'), Number(/-?\d+/.exec(g.attr('fmla') ?? '')?.[0] ?? 0)]).filter(([n]) => n);
        (obj.extra ??= {}).warp = {preset: warp.attr('prst'), adj};
      }
    }
    const geom = readCustGeom(sp, w, h);
    const tool = /^Ink (Pen|Pencil|Highlighter)\b/.exec(name)?.[1]?.toLowerCase() ?? null;
    if (geom) {
      obj.kind = 'freeform';
      obj.freeform = geom;
    } else {
      const prst = sp.child('a:prstGeom')?.attr('prst') ?? '';
      // Any other catalogue preset keeps its own name as its kind (core/quill/lib/shape-presets.mjs).
      if (!(prst in PRST) && (isBox || !presetOfKind(prst))) return null;
      if (!isBox) obj.kind = PRST[prst] ?? prst;
    }
    const solid = e => parseRgb(e?.child('a:solidFill')?.child('a:srgbClr')?.attr('val'));
    const fill = readFill(sp, rid => (rels && rid ? this.mediaFor(rels, rid) : null));
    if (fill === undefined && (sp.child('a:solidFill') || sp.child('a:gradFill') || sp.child('a:blipFill'))) return null;
    obj.fill = fill ?? solid(sp) ?? null;
    if (fx.shadow || fx.glow || fx.softEdge || fx.reflection || fx.bevel) { obj.effects = fx; float.effect = effectsExtent(fx, [w, h]); }
    if (ln && !ln.child('a:noFill')) {
      obj.stroke = solid(ln) ?? [0, 0, 0];
      const lw = measure(ln.attr('w'), 12_700);
      obj.strokeWidth = lw === null ? 0.75 : Math.max(0, Math.min(100, lw));
      const alpha = int(ln.child('a:solidFill')?.child('a:srgbClr')?.child('a:alpha')?.attr('val'));
      if (geom && tool) geom.alpha = alpha === null ? 1 : Math.max(0, Math.min(100_000, alpha)) / 100_000;
      if (ln.child('a:headEnd')?.attr('type') && ln.child('a:headEnd').attr('type') !== 'none') (obj.extra ??= {}).arrowStart = true;
      if (ln.child('a:tailEnd')?.attr('type') && ln.child('a:tailEnd').attr('type') !== 'none') (obj.extra ??= {}).arrowEnd = true;
    }
    if (geom && tool) {
      geom.ink = tool;
      const order = /#(\d+)\s*$/.exec(name);
      if (order) geom.order = Number(order[1]);
    }
    return obj;
  }
  readPic(pic, rels, w, h, alt, float) {
    const blip = pic.find('a:blip');
    if (!blip) return null;
    const spin = xfrmSpin(pic.find('pic:spPr'));
    if (spin.deg) float.rot = normalizeDegrees(spin.deg);
    if (spin.flipH) float.flipH = true;
    if (spin.flipV) float.flipV = true;
    const rid = blip.attr('r:embed');
    const media = rid !== null ? this.mediaFor(rels, rid) : null;
    if (!media) return null;
    const crop = [0, 0, 0, 0];
    const sr = pic.find('a:srcRect');
    if (sr) ['l', 't', 'r', 'b'].forEach((n, i) => { const v = int(sr.attr(n)); if (v !== null) crop[i] = Math.max(0, Math.min(100_000, v)) / 100_000; });
    const img = {type: 'image', media, w, h, alt, float, crop};
    // A picture's shadow, glow, soft edges, reflection and bevel (Picture Format › Picture Effects).
    const fx = readEffects(pic.find('pic:spPr') ?? new El('x'));
    if (fx && (fx.shadow || fx.glow || fx.softEdge || fx.reflection || fx.bevel)) { img.effects = fx; float.effect = effectsExtent(fx, [w, h]); }
    return img;
  }
  /** A run child the model can't represent yet, kept whole (and its parts) for the next save. */
  opaqueRun(k, rels, w = 0, h = 0) {
    const xml = `<w:r>${this.keepEmbedded(k, rels)}</w:r>`;
    const txbx = k.find('w:txbxContent');
    const text = txbx ? cleanText(paragraphsText(txbx)) : '';
    const o = {type: 'opaque', format: 'docx', xml, text};
    if (k.name === 'w:drawing' || k.name === 'w:pict' || k.name === 'w:object') { o.drawing = true; if (w || h) { o.w = w; o.h = h; } }
    return o;
  }
  /** Native ink and Office 2016 charts in mc:AlternateContent are kept whole (choice and fallback). */
  keptAlternate(ac, rels) {
    const choice = ac.children('mc:Choice').find(c => {
      const uri = c.child('w:drawing')?.find('a:graphicData')?.attr('uri');
      return uri === INK_URI || uri === 'http://schemas.microsoft.com/office/drawing/2014/chartex';
    });
    if (!choice) return null;
    const req = choice.attr('Requires') ?? '';
    if (!req.split(/\s+/).filter(Boolean).length || req.split(/\s+/).includes('?')) return null;
    const kept = new El('mc:AlternateContent', [], [choice, ...(ac.child('mc:Fallback') ? [ac.child('mc:Fallback')] : [])]);
    return {type: 'opaque', format: 'docx', xml: `<w:r>${this.keepEmbedded(kept, rels)}</w:r>`, text: '', drawing: true};
  }
  equation(k) {
    // The linear text is read from the math (lib/omml.mjs); the markup itself is kept for the next save until the equation is changed.
    const display = k.name === 'm:oMathPara';
    const o = {type: 'equation', linear: ommlToLinear(k), display, omml: k.toXml()};
    const jc = display ? ommlJustification(k) : null;
    if (jc === 'left' || jc === 'right' || jc === 'centerGroup') o.math = {jc};
    return o;
  }

  // --- kept parts (read.rs keep_unmodelled / keep_custom_xml / read_vba_related) ---
  keepUnmodelled(rootRels, rels) {
    const handled = [RT.STYLES, RT.NUMBERING, RT.SETTINGS, RT.THEME, RT.FOOTNOTES, RT.ENDNOTES, RT.COMMENTS, RT.COMMENTS_EX, RT.COMMENTS_IDS,
      RT.COMMENTS_EXTENSIBLE, RT.HEADER, RT.FOOTER, RT.IMAGE, RT.HYPERLINK, RT.OFFICE_DOC, RT.CORE, RT.APP, RT.CUSTOM];
    const lines = [];
    const take = (scope, list) => {
      for (const r of list) {
        if (handled.some(t => relIs(r.kind, t))) continue;
        // A bibliography read into the model is written from it (embed.rs `keep_custom_xml`).
        if (!r.external && relIs(r.kind, RT.CUSTOM_XML) && this.c.sources.length && this.isSourcesPart(r.target)) continue;
        if (r.external) { lines.push([scope, r.kind, r.target, '', '1', r.id].join('\t')); continue; }
        if (this.embedded.size >= MAX_EMBEDDED_PARTS) break;
        this.keepPartTree(r.target);
        if (this.pkg.get(r.target)) lines.push([scope, r.kind, r.target, this.types().of(r.target) ?? 'application/octet-stream', '0', r.id].join('\t'));
      }
    };
    take('D', rels.list.filter(r => !this.embeddedRels.has(r.target)));
    take('P', rootRels.list);
    if (lines.length) this.c.passthrough[KEPT_PARTS] = toBase64(textBytes(lines.join('\n') + '\n'));
  }
  /** Whether the part at `path` is a `b:Sources` document. */
  isSourcesPart(path) { try { return this.xml(path)?.local() === 'Sources'; } catch { return false; } }
}

/** A stable id derived from another (tables, rows, cells and sections have no id of their own in the file). */
const derivedId = (prefix, id) => (typeof id === 'string' && id.length === 8 ? prefix + id.slice(1) : null);
const firstParaId = blocks => { for (const b of blocks) { if (b.kind === 'para') return b.id; const r = b.rows?.[0]?.cells?.[0]; if (r) return r.id; } return null; };
const runPropsNone = ctx => {
  const p = {};
  if (ctx.link) p.link = ctx.link;
  if (ctx.link && ctx.linkTip) p.linkTip = ctx.linkTip;
  if (ctx.ins !== undefined && ctx.ins !== null) p.ins = ctx.ins;
  if (ctx.del !== undefined && ctx.del !== null) p.del = ctx.del;
  return p;
};
const noteRef = (kind, id, custom) => { const o = {type: 'noteRef', kind, id}; if (custom) o.custom = custom; return o; };
const plainOf = p => { if (!p.objects?.length) return p.text; let out = '', k = 0; for (const c of p.text) { if (c === OBJ) out += objPlain(p.objects[k++]); else out += c; } return out; };
function paragraphsText(e) {
  const out = [];
  const go = (x, d) => { if (d > MAX_DEPTH) return; for (const c of x.els()) { if (c.name === 'w:p') { out.push(c.children('w:r').map(r => r.children('w:t').map(t => t.text()).join('')).join('')); } else go(c, d + 1); } };
  go(e, 0);
  return out.join(' ');
}
function lastParaOf(out, depth) {
  const b = out[out.length - 1];
  if (!b) return null;
  if (b.kind === 'para') return b;
  if (depth < MAX_TABLE_DEPTH) { const r = b.rows[b.rows.length - 1]; const c = r?.cells[r.cells.length - 1]; return c ? lastParaOf(c.blocks, depth + 1) : null; }
  return null;
}
function insertObjAt(p, off, o, props) {
  let k = 0;
  for (let i = 0; i < off; i++) if (p.text[i] === OBJ) k++;
  p.text = p.text.slice(0, off) + OBJ + p.text.slice(off);
  const objs = [...(p.objects || [])];
  objs.splice(k, 0, o);
  p.objects = objs;
  const runs = [];
  let s = 0, done = false;
  for (const r of p.runs) {
    if (!done && off <= s + r.len && (off < s + r.len || off === p.text.length - 1)) {
      const a = off - s;
      if (a > 0) runs.push({len: a, props: r.props});
      runs.push({len: 1, props});
      if (r.len - a > 0) runs.push({len: r.len - a, props: r.props});
      done = true;
    } else runs.push(r);
    s += r.len;
  }
  if (!done) runs.push({len: 1, props});
  p.runs = runs;
  finishPara(p);
}

/** Gather `name` children through w:sdt/w:customXml wrappers, with the controls around each. */
function collect(e, name, out, pending, depth) {
  if (depth > 8) return;
  for (const k of e.els()) {
    if (k.name === name) out.push([k, {open: pending.splice(0), close: 0}]);
    else if (k.name === 'w:sdt') {
      const c = k.child('w:sdtContent');
      if (!c) continue;
      const ctl = sdtPr(k.child('w:sdtPr'), true);
      const ep = sdtEndPr(k.child('w:sdtEndPr')); if (ep) ctl.endPrXml = ep;
      const before = out.length;
      pending.push(ctl);
      collect(c, name, out, pending, depth + 1);
      if (out.length > before) out[out.length - 1][1].close += 1;
      else pending.pop();
    } else if (k.name === 'w:customXml') collect(k, name, out, pending, depth + 1);
  }
}

// --- read/sdt.rs ---
const MAX_EXTRA = 64 * 1024;
const ctlText = v => [...(v ?? '')].filter(c => c !== OBJ && !/\p{Cc}/u.test(c)).slice(0, MAX_CONTROL_TEXT).join('');
const ctlOn = e => { const v = e.attr('w:val') ?? e.attr('w14:val') ?? e.attr('w15:val'); return v === null || !['0', 'false', 'off'].includes(v); };
function ctlSymbol(e, d) {
  if (!e) return [d, ''];
  const h = e.attr('w14:val');
  const cp = h !== null && /^[0-9a-fA-F]+$/.test(h.trim()) ? parseInt(h.trim(), 16) : NaN;
  const ok = Number.isFinite(cp) && cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && cp !== 0xfffc;
  return [ok ? String.fromCodePoint(cp) : d, ctlText(e.attr('w14:font'))];
}
const ctlItems = e => e.children('w:listItem').slice(0, MAX_LIST_ITEMS).map(i => ({display: ctlText(i.attr('w:displayText')), value: ctlText(i.attr('w:value'))}));
/** The control `w:sdtPr` describes (a rich text control without one). */
export function sdtPr(pr, block) {
  const c = contentControl({type: 'richText'});
  c.block = block;
  c.placeholderText = '';
  if (!pr) return c;
  let extraLen = 0;
  for (const k of pr.els()) {
    switch (k.name) {
      case 'w:rPr': c.rprXml = k.toXml(); break;
      case 'w:alias': c.title = ctlText(k.attr('w:val')); break;
      case 'w:tag': c.tag = ctlText(k.attr('w:val')); break;
      case 'w:id': { const v = k.attr('w:val'); if (v !== null && /^\s*[+-]?\d+\s*$/.test(v)) c.id = Number(v.trim()); break; }
      case 'w:lock': c.lock = controlLockFromOoxml(k.attr('w:val') ?? ''); break;
      case 'w:placeholder': c.placeholder = ctlText(k.child('w:docPart')?.attr('w:val')); break;
      case 'w:temporary': c.temporary = ctlOn(k); break;
      case 'w:showingPlcHdr': c.showingPlaceholder = ctlOn(k); break;
      case 'w:richText': c.kind = {type: 'richText'}; break;
      case 'w:text': { const v = k.attr('w:multiLine'); c.kind = {type: 'text', multiLine: v !== null && !['0', 'false', 'off'].includes(v)}; break; }
      case 'w14:checkbox': {
        const [checkedChar, checkedFont] = ctlSymbol(k.child('w14:checkedState'), CHECKED);
        const [uncheckedChar, uncheckedFont] = ctlSymbol(k.child('w14:uncheckedState'), UNCHECKED);
        c.kind = {type: 'checkBox', checked: k.child('w14:checked') ? ctlOn(k.child('w14:checked')) : false, checkedChar, checkedFont, uncheckedChar, uncheckedFont};
        break;
      }
      case 'w:comboBox': c.kind = {type: 'comboBox', items: ctlItems(k), lastValue: ctlText(k.attr('w:lastValue'))}; break;
      case 'w:dropDownList': c.kind = {type: 'dropDown', items: ctlItems(k), lastValue: ctlText(k.attr('w:lastValue'))}; break;
      case 'w:date': {
        const v = n => ctlText(k.childVal(n));
        c.kind = {type: 'date', fullDate: ctlText(k.attr('w:fullDate')), format: v('w:dateFormat'), lid: v('w:lid'), calendar: v('w:calendar'), storeAs: v('w:storeMappedDataAs')};
        break;
      }
      case 'w:picture': c.kind = {type: 'picture'}; break;
      case 'w:docPartObj': case 'w:docPartList':
        c.kind = {type: 'gallery', list: k.name === 'w:docPartList', gallery: ctlText(k.childVal('w:docPartGallery')), category: ctlText(k.childVal('w:docPartCategory')),
          unique: k.child('w:docPartUnique') ? ctlOn(k.child('w:docPartUnique')) : false};
        break;
      case 'w15:repeatingSection': {
        const t = k.child('w15:sectionTitle');
        c.kind = {type: 'repeatingSection', title: ctlText(t?.attr('w:val') ?? t?.attr('w15:val')),
          noInsertDelete: k.child('w15:doNotAllowInsertDeleteSection') ? ctlOn(k.child('w15:doNotAllowInsertDeleteSection')) : false};
        break;
      }
      case 'w15:repeatingSectionItem': c.kind = {type: 'repeatingSectionItem'}; break;
      // Show as and Color (Word's Content Control Properties).
      case 'w15:appearance': { const v = k.attr('w15:val'); if (v === 'tags' || v === 'hidden') c.appearance = v; break; }
      case 'w15:color': { const v = k.attr('w:val'); if (/^[0-9a-fA-F]{6}$/.test(v ?? '')) c.color = v.toUpperCase(); break; }
      default: {
        const x = k.toXml();
        if (x && extraLen + x.length <= MAX_EXTRA) { extraLen += x.length; (c.extra ||= []).push(x); }
      }
    }
  }
  return c;
}
export const sdtEndPr = e => { if (!e) return ''; const x = e.toXml(); return x.length <= MAX_EXTRA ? x : ''; };

/** Alt text of a wp:docPr / pic:cNvPr: [description, {title, decorative}]. */
function nvAlt(p) {
  if (!p) return ['', {}];
  const title = capAlt(p.attr('title') ?? '');
  const d = p.attr('descr');
  const descr = d ? capAlt(d) : title;
  const decorative = (p.child('a:extLst')?.children('a:ext') ?? []).filter(x => (x.attr('uri') ?? '').toUpperCase() === DECORATIVE_EXT)
    .some(x => x.elList().some(e => e.local() === 'decorative' && onOffAttr(e, 'val')));
  const meta = {};
  if (title) meta.title = title;
  if (decorative) meta.decorative = true;
  return [descr, meta];
}

function anchorFloat(c) {
  const f = {...defaultFloat(), wrap: 'square'};
  const z = Number.parseInt((c.attr('relativeHeight') ?? '').trim(), 10);
  if (Number.isFinite(z) && z >= 0 && z <= 0xffffffff) f.z = z;
  const behind = onOffAttr(c, 'behindDoc');
  const kids = [];
  for (const k of c.els()) {
    if (k.name === 'mc:AlternateContent') kids.push(...(k.child('mc:Fallback')?.elList() ?? []));
    else kids.push(k);
  }
  for (const k of kids) {
    switch (k.name) {
      case 'wp:wrapSquare': f.wrap = 'square'; { const wt = wrapTextFromOoxml(k.attr('wrapText') ?? ''); if (wt && wt !== 'bothSides') f.wrapText = wt; } break;
      case 'wp:wrapTight': case 'wp:wrapThrough': {
        f.wrap = k.name === 'wp:wrapTight' ? 'tight' : 'through';
        const wt = wrapTextFromOoxml(k.attr('wrapText') ?? ''); if (wt && wt !== 'bothSides') f.wrapText = wt;
        const wpEl = k.child('wp:wrapPolygon');
        if (wpEl) {
          const pts = wpEl.elList().filter(e => e.name === 'wp:start' || e.name === 'wp:lineTo').map(e => [int(e.attr('x')) ?? 0, int(e.attr('y')) ?? 0]).slice(0, 10_000);
          if (pts.length >= 3) {
            const last = pts[pts.length - 1];
            if (pts.length > 3 && last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();
            // An unedited polygon round the whole frame says nothing the object doesn't (it's what is
            // written when there's no outline): keep deriving the outline.
            const edited = onOffAttr(wpEl, 'edited');
            const corners = pts.map(q => q.join(',')).sort().join(' ');
            if (edited || corners !== '0,0 0,21600 21600,0 21600,21600') f.wrapPolygon = {edited, points: pts};
          }
        }
        break;
      }
      case 'wp:wrapTopAndBottom': f.wrap = 'topAndBottom'; break;
      case 'wp:wrapNone': f.wrap = behind ? 'behindText' : 'inFrontOfText'; break;
      case 'wp:positionH': case 'wp:positionV': {
        const horiz = k.name === 'wp:positionH';
        const rf = k.attr('relativeFrom') ?? '';
        let rel;
        if (rf === 'page') rel = 'page';
        else if (rf === 'margin') rel = 'margin';
        else if (rf === 'insideMargin') rel = 'insideMargin';
        else if (rf === 'outsideMargin') rel = 'outsideMargin';
        else if (horiz && rf === 'leftMargin') rel = 'leftMargin';
        else if (horiz && rf === 'rightMargin') rel = 'rightMargin';
        else if (horiz && rf === 'character') rel = 'character';
        else if (!horiz && rf === 'topMargin') rel = 'topMargin';
        else if (!horiz && rf === 'bottomMargin') rel = 'bottomMargin';
        else if (!horiz && rf === 'line') rel = 'line';
        else rel = horiz ? 'column' : 'paragraph';
        const a = k.child('wp:align');
        const align = a ? floatAlignFromOoxml(a.text().trim()) : null;
        const off = measure(k.child('wp:posOffset')?.text(), 12_700) ?? 0;
        if (horiz) { f.hRel = rel; if (align) f.hAlign = align; f.x = off; } else { f.vRel = rel; if (align) f.vAlign = align; f.y = off; }
        break;
      }
      default:
    }
  }
  const dist = n => Math.max(0, Math.min(1584, measure(c.attr(n), 12_700) ?? 0));
  f.dist = Math.max(dist('distL'), dist('distR'));
  f.distTop = dist('distT');
  f.distBottom = dist('distB');
  if (!onOffAttr(c, 'layoutInCell') && c.attr('layoutInCell') !== null) f.outsideCell = true;
  return f;
}
/** The paths of the custom geometry in `sppr` mapped onto a w × h shape (points): lines and flattened Béziers; null without any (read/freeform.rs cust_geom). */
function readCustGeom(sppr, w, h) {
  const list = sppr.child('a:custGeom')?.child('a:pathLst');
  if (!list) return null;
  const MAX_PATHS = 256, MAX_POINTS = 5000, STEPS = 8, MAX_EMU = 1e12;
  const bezier = (ctrl, t) => {
    let p = ctrl;
    while (p.length > 1) p = p.slice(1).map((b, i) => [p[i][0] + (b[0] - p[i][0]) * t, p[i][1] + (b[1] - p[i][1]) * t]);
    return p[0] ?? [0, 0];
  };
  const paths = [];
  for (const p of list.children('a:path').slice(0, MAX_PATHS)) {
    const dim = (n, shape) => { const v = int(p.attr(n)); return v !== null && v > 0 ? v : shape * 12_700; };
    const [pw, ph] = [dim('w', w), dim('h', h)];
    const scale = ([x, y]) => [(x * (pw > 0 ? w / pw : 1 / 12_700)), (y * (ph > 0 ? h / ph : 1 / 12_700))];
    const pt = e => { const cx = n => { const v = int(e.attr(n)); return v === null ? null : Math.max(-MAX_EMU, Math.min(MAX_EMU, v)); }; const x = cx('x'), y = cx('y'); return x === null || y === null ? null : [x, y]; };
    let cur = [], dd = [];
    const done = [];
    const fillNone = p.attr('fill') === 'none';
    for (const seg of p.elList()) {
      if (cur.length >= MAX_POINTS || done.length >= MAX_PATHS) break;
      const pts = seg.children('a:pt').map(pt).filter(Boolean).slice(0, 8);
      switch (seg.local()) {
        case 'moveTo': if (cur.length) { done.push([cur, false, dd]); cur = []; dd = []; } if (pts[0]) { cur.push(pts[0]); dd.push({t: 'M', pts: [pts[0]]}); } break;
        case 'lnTo': if (pts[0]) { cur.push(pts[0]); dd.push({t: 'L', pts: [pts[0]]}); } break;
        case 'cubicBezTo': case 'quadBezTo': {
          const start = cur[cur.length - 1];
          if (!start) { if (pts.length) { cur.push(pts[pts.length - 1]); dd.push({t: 'M', pts: [pts[pts.length - 1]]}); } break; }
          const want = seg.local() === 'cubicBezTo' ? 3 : 2;
          if (pts.length === want) dd.push({t: want === 3 ? 'C' : 'Q', pts}); else dd.push({t: 'L', pts: [pts[pts.length - 1] ?? start]});
          const ctrl = [start, ...pts];
          for (let i = 1; i <= STEPS; i++) cur.push(bezier(ctrl, i / STEPS));
          break;
        }
        case 'close': if (cur.length) { done.push([cur, true, dd]); cur = []; dd = []; } break;
        default:
      }
    }
    if (cur.length) done.push([cur, cur.length > 2 && cur[0][0] === cur[cur.length - 1][0] && cur[0][1] === cur[cur.length - 1][1], dd]);
    for (const [pts, closed, segs] of done.slice(0, MAX_PATHS - paths.length)) {
      const isClosed = closed && !fillNone;
      const path = {pts: pts.slice(0, MAX_POINTS).map(scale), closed: isClosed};
      // Curves are kept as path data (Edit Points); a path of straight lines stays plain points.
      if (segs?.some(s => s.t === 'C' || s.t === 'Q') && pts.length < MAX_POINTS) {
        const sc = q => { const [x, y] = scale([q[0], q[1]]); return {x, y}; };
        path.d = writePath([...segs.map(s => ({t: s.t, pts: s.pts.map(sc)})), ...(isClosed ? [{t: 'Z', pts: []}] : [])]);
      }
      paths.push(path);
    }
  }
  const f = sanitizedFreeform({w, h, paths, alpha: 1});
  return f.paths.length ? f : null;
}

function xfrmSpin(sppr) {
  if (!sppr) return new Spin();
  const x = sppr.name === 'a:xfrm' || sppr.name === 'w14:xfrm' ? sppr : sppr.child('a:xfrm');
  if (!x) return new Spin();
  const r = int(x.attr('rot'));
  const rot = r === null ? 0 : (((r % 21_600_000) + 21_600_000) % 21_600_000) / 60_000;
  return new Spin(rot, onOffAttr(x, 'flipH'), onOffAttr(x, 'flipV'));
}

/** Restrict Editing (`w:documentProtection`): only enforced protection is kept. */
export const PROTECTION_HASH_ATTRS = Object.freeze(['w:algorithmName', 'w:hashValue', 'w:saltValue', 'w:spinCount', 'w:cryptProviderType',
  'w:cryptAlgorithmClass', 'w:cryptAlgorithmType', 'w:cryptAlgorithmSid', 'w:cryptSpinCount', 'w:cryptProvider', 'w:algIdExt', 'w:algIdExtSource',
  'w:cryptProviderTypeExt', 'w:cryptProviderTypeExtSource', 'w:hash', 'w:salt']);
function readProtection(k, s) {
  const on = v => !['0', 'false', 'off'].includes(v);
  const enf = k.attr('w:enforcement');
  if (enf === null || !on(enf)) return;
  const edit = ['readOnly', 'comments', 'trackedChanges', 'forms'].includes(k.attr('w:edit')) ? k.attr('w:edit') : null;
  const formatting = k.attr('w:formatting') !== null && on(k.attr('w:formatting'));
  if (!edit && !formatting) return;
  s.protection = edit ?? 'none';
  s.protectFormatting = formatting;
  s.protectHash = PROTECTION_HASH_ATTRS.map(n => [n, k.attr(n)]).filter(([, v]) => v && v.length <= 1024);
}
/** A usable `w16cid:durableId`: 1–8 hex digits, below 0x7FFFFFFF, not 0. */
export const durableIdOk = d => /^[0-9a-fA-F]{1,8}$/.test(d) && parseInt(d, 16) !== 0 && parseInt(d, 16) < 0x7fffffff;

/** Link chains of text boxes would go here (read.rs link_text_boxes); text boxes are kept opaque until the shape reader lands. */

// =============================================================================================
// read/toc.rs
// =============================================================================================

/** Custom XML parts looked at for bibliography sources (read.rs). */
export const MAX_BIBLIOGRAPHY_PARTS = 64;

const asciiLower = s => String(s).replace(/[A-Z]/g, ch => ch.toLowerCase());
/** Whether a body holds a TOC range field anywhere (the reader's shortcut before `unstyle_toc_links`). */
function hasTocRange(blocks, depth) {
  if (depth > MAX_DEPTH) return false;
  for (const b of blocks) {
    if (b.kind === 'para') { if ((b.objects ?? []).some(o => o.type === 'fieldStart' && isToc(o.instr ?? ''))) return true; }
    else for (const row of b.rows ?? []) for (const cell of row.cells ?? []) if (hasTocRange(cell.blocks ?? [], depth + 1)) return true;
  }
  return false;
}

/**
 * Word draws a table of contents' entry links without the Hyperlink character style (no blue, no
 * underline) though the entries carry it (measured in Word for Windows: a Hyperlink-styled run in a
 * hyperlink inside a TOC field's result is plain; one outside a hyperlink, another style, direct
 * formatting, or a hyperlink in another field keep their look). The style is dropped from those
 * runs so they look the same here; the links stay. The style is found by its built-in name:
 * localized Word and older files give it another id (`Hipervnculo`, `Hyperlnk`)
 * (read/toc.rs `unstyle_toc_links`). `d` is a Document; its body is changed.
 */
export function unstyleTocLinks(d) {
  const ids = new Set((d.content.styles?.styles ?? []).filter(s => s.kind === 'character' && asciiLower(s.name ?? '') === 'hyperlink').map(s => s.id));
  ids.add('Hyperlink');
  for (const f of d.fieldRanges(BODY)) {
    if (!isToc(f.instr ?? '')) continue;
    try {
      d.formatRange(f.start, f.end, c => { if (c.link && typeof c.style === 'string' && ids.has(c.style)) delete c.style; });
    } catch { /* upstream ignores a failed format_range */ }
  }
}

/** Paragraph `i` of `list`, copied in place so changing it leaves the list it was shared with alone (Arc::make_mut). */
const paraMutAt = (list, i) => {
  const b = list[i];
  if (b?.kind !== 'para') return null;
  const c = {...b};
  list[i] = c;
  return c;
};
const sameSpan = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

/**
 * Word's Table of Contents content control belongs to the TOC: the writer puts it back around the
 * TOC heading and its entries (`tocSpan`), which References > Update Table rebuilds. It is handed to
 * the TOC only when the writer would put it back around the same paragraphs; any other is kept as
 * read, or saving would drop it (#2427) (read/toc.rs `toc_control_to_toc`). Changes `body` (an
 * array of blocks) in place.
 */
export function tocControlToToc(body) {
  let span = null;
  {
    const events = controlEvents(body);
    const [pairs] = pairEvents(events);
    for (const [o, c, depth] of pairs) {
      const so = events[o], ec = events[c];
      if (!so || !so.open || so.off !== 0 || !ec || ec.open || ec.off === null) continue;
      const k = so.control?.kind;
      const toc = k?.type === 'gallery' && !k.list && k.gallery === 'Table of Contents';
      const end = body[ec.block];
      const atEnd = end?.kind === 'para' && end.text.length === ec.off + 1;
      if (depth === 0 && toc && atEnd) { span = [so.block, ec.block, ec.off]; break; }
    }
  }
  if (!span) return;
  const [s, e, off] = span;
  const toc = body.slice();
  // The end first: both markers may be in the same paragraph.
  { const p = paraMutAt(toc, e); if (p) try { P.deleteRange(p, off, p.text.length); } catch { /* as upstream's ignored error */ } }
  { const p = paraMutAt(toc, s); if (p) try { P.deleteRange(p, 0, 1); } catch { /* as upstream's ignored error */ } }
  tocFieldToHeading(toc);
  if (sameSpan(writtenTocSpan(toc), [s, e])) { body.splice(0, body.length, ...toc); return; }
  // TOCs the writer rebuilds in the same paragraphs once Update Table has turned them into the
  // engine's TOC (`range_toc_to_field`) are handed over as the range read, as without the control:
  // - Word's layout, the field's end alone in a paragraph after the entries (it goes with them);
  // - ours with a heading that isn't a `TOCHeading`, written empty and the field opening in the
  //   first entry. Kept in the control, that paragraph wouldn't be empty and each save and update
  //   would add a blank line above the entries (#2182).
  const engine = toc.slice();
  let last = e;
  // The entry before Word's paragraph holding nothing but the field's end, and that end's format.
  let endOnly = null;
  if (e >= 1 && e - 1 > s) {
    const p = engine[e];
    if (p?.kind === 'para' && !p.section && p.text.length === 1 && P.objectAt(p, 0)?.type === 'fieldEnd') endOnly = [e - 1, {...P.propsOfChar(p, 0)}];
  }
  if (endOnly) {
    const [l, props] = endOnly;
    engine.splice(e, 1);
    last = l;
    const p = paraMutAt(engine, l);
    if (p) P.insertObject(p, p.text.length, {type: 'fieldEnd'}, props);
  }
  // An empty paragraph opening the control takes the field. It may end a section, as above entries
  // in columns (#3889).
  const head = engine[s];
  if (head?.kind === 'para' && head.text.length === 0) fieldToHeading(engine, s + 1);
  else tocFieldToHeading(engine);
  if (sameSpan(writtenTocSpan(engine), [s, last])) body.splice(0, body.length, ...toc);
}

/**
 * Normalize only a complete TOC range that the engine's heading/entry representation can reproduce
 * exactly. Other imported TOCs keep their explicit boundaries, independent of styles
 * (read/toc.rs `toc_field_to_heading`). Changes `body` in place.
 */
export function tocFieldToHeading(body) {
  for (let i = 1; i < body.length; i++) {
    const h = body[i - 1];
    if (h?.kind === 'para' && h.props?.style === 'TOCHeading') fieldToHeading(body, i);
  }
}

/**
 * Moves the TOC field that opens paragraph `i` (a complete range over the entries, or an empty
 * field) to the end of paragraph `i - 1`, the engine's TOC heading, unless that one has a TOC field
 * already (read/toc.rs `field_to_heading`).
 */
function fieldToHeading(body, i) {
  const hasToc = o => o?.type === 'field' && isToc(o.instr ?? '');
  const h = body[i - 1];
  if (i === 0 || h?.kind !== 'para' || (h.objects ?? []).some(hasToc)) return;
  const p = body[i];
  if (p?.kind !== 'para') return;
  const o = P.objectAt(p, 0);
  let field, end = null;
  if (o?.type === 'fieldStart' && isToc(o.instr ?? '')) {
    field = {type: 'field', instr: o.instr, result: '', locked: !!o.locked};
    if (o.dirty) field.dirty = true;
    end = tocRangeEnd(body, i);
    if (end === null) return;
  } else if (o?.type === 'field' && !o.result && hasToc(o)) {
    field = {...o};
  } else return;
  const props = {...P.propsOfChar(p, 0)};
  // Delete the end first: the two markers may occupy the same paragraph.
  if (end !== null) {
    const q = paraMutAt(body, end);
    if (q) try { P.deleteRange(q, Math.max(0, q.text.length - 1), q.text.length); } catch { /* as upstream's ignored error */ }
  }
  { const q = paraMutAt(body, i); if (q) try { P.deleteRange(q, 0, 1); } catch { /* as upstream's ignored error */ } }
  const hh = paraMutAt(body, i - 1);
  if (hh) P.insertObject(hh, hh.text.length, field, props);
}

/**
 * The actual matching end must also be the end the styled writer would choose: at the end of the
 * last contiguous TOC entry, with no section break or trailing content outside it
 * (read/toc.rs `toc_range_end`).
 */
function tocRangeEnd(body, start) {
  const entry = p => p?.kind === 'para' && !p.section && typeof p.props?.style === 'string' && p.props.style.startsWith('TOC') && p.props.style !== 'TOCHeading';
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const p = body[i];
    if (!entry(p)) return null;
    for (const [off, o] of P.objectsWithOffsets(p)) {
      if (o.type === 'fieldStart') depth++;
      else if (o.type === 'fieldEnd') {
        if (depth === 0) return null;
        depth--;
        if (depth === 0) return off + 1 === p.text.length && !entry(body[i + 1]) ? i : null;
      }
    }
  }
  return null;
}

// =============================================================================================
// Entry points
// =============================================================================================

/** Is `bytes` a password-protected (encrypted, compound-file) package? */
export const isEncrypted = bytes => bytes?.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

/** Read a package into schema-2 content (read.rs `read_opened`). */
export async function readPackage(pkg) {
  const rootRels = pkg.rels('');
  const mainRel = rootRels.byType(RT.OFFICE_DOC);
  const main = mainRel && !mainRel.external ? mainRel.target : 'word/document.xml';
  const root = pkg.xml(main, true);
  if (!root) throw new DocxError('MissingPart', `missing part: ${main}`);
  if (root.name !== 'w:document') throw new DocxError('NotWord', `not a Word document: root element is ${root.name}`);
  const rels = pkg.rels(main);
  const r = new Reader(pkg, main);
  r.pc.majorFont = r.c.settings.majorFont;
  r.pc.minorFont = r.c.settings.minorFont;
  const part = t => { const x = rels.byType(t); return x && !x.external ? x.target : null; };
  const lenient = fn => { try { fn(); } catch { /* a broken optional part is skipped, as upstream logs and skips it */ } };
  const ft = part(RT.FONT_TABLE); if (ft) r.readFontFamilies(ft);
  const th = part(RT.THEME); if (th) r.readTheme(th);
  const st = part(RT.SETTINGS); if (st) r.readColorMapping(st);
  const sty = part(RT.STYLES); if (sty) lenient(() => r.readStyles(sty));
  const num = part(RT.NUMBERING); if (num) lenient(() => r.readNumbering(num));
  r.c.settings.compatMode = 12;
  if (st) lenient(() => r.readSettings(st));
  const fn = part(RT.FOOTNOTES); if (fn) lenient(() => r.readNotes(fn, true));
  const en = part(RT.ENDNOTES); if (en) lenient(() => r.readNotes(en, false));
  const cm = part(RT.COMMENTS);
  if (cm) lenient(() => r.readComments(cm, part(RT.COMMENTS_EX), part(RT.COMMENTS_IDS), part(RT.COMMENTS_EXTENSIBLE)));
  // Bibliography sources live in a custom XML data store (`b:Sources`), related from the package
  // root or the main part; Word's own files sometimes leave the relationship out, so the
  // conventional `customXml/itemN.xml` names are tried too. Each part is read at most once.
  const bibParts = [];
  for (const rel of [...rootRels.list, ...rels.list]) {
    if (relIs(rel.kind, RT.CUSTOM_XML) && !rel.external && !bibParts.includes(rel.target)) {
      bibParts.push(rel.target);
      if (bibParts.length >= MAX_BIBLIOGRAPHY_PARTS) break;
    }
  }
  for (let i = 1; i <= 16; i++) {
    const path = `customXml/item${i}.xml`;
    if (bibParts.length < MAX_BIBLIOGRAPHY_PARTS && pkg.get(path) && !bibParts.includes(path)) bibParts.push(path);
  }
  const seenSources = new Seen();
  for (const path of bibParts) {
    if (r.c.sources.length >= MAX_SOURCES) break;
    lenient(() => r.readBibliography(path, seenSources));
  }
  const bg = root.child('w:background');
  const bgc = parseRgb(bg?.attr('w:color'));
  if (bgc) r.c.settings.pageColor = bgc;
  const fill = bg?.child('v:background')?.child('v:fill');
  if (fill) {
    const rid = fill.attr('r:id') ?? fill.attr('r:embed') ?? fill.attr('o:relid');
    const media = rid !== null ? r.mediaFor(rels, rid) : null;
    if (media) r.c.settings.pagePicture = {media, fillType: [...(fill.attr('type') ?? '')].slice(0, 32).join(''), title: [...(fill.attr('o:title') ?? '')].slice(0, 255).join('')};
  }
  const body = root.child('w:body');
  let blocks = [];
  if (body) {
    const sc = new StoryCtx();
    r.readBlocks(sc, body, rels, blocks, 0);
    r.flushPending(sc, blocks);
    if (hasTocRange(blocks, 0)) {
      r.c.body = bodyFromBlocks(blocks);
      const d = new Document(r.c);
      unstyleTocLinks(d);
      blocks = d.content.body.chunks.flat();
    }
    tocControlToToc(blocks);
    tocFieldToHeading(blocks);
    const s = body.child('w:sectPr');
    if (s) r.c.lastSection = r.readSection(s, rels, 'lastsect');
  }
  if (!r.c.lastSection?.id) r.c.lastSection = defaultSection(r.id());
  const corePath = rootRels.byType(RT.CORE)?.target ?? 'docProps/core.xml';
  r.readCore(corePath);
  const app = rootRels.byType(RT.APP)?.target; if (app) r.readApp(app);
  const custom = rootRels.byType(RT.CUSTOM);
  if (custom) { const x = pkg.xmlLenient(custom.target); if (x) r.c.customProps = readCustomProps(x); }
  r.keepUnmodelled(rootRels, rels);
  if (r.embedded.size) r.c.passthrough[EMBEDDED_PARTS] = toBase64(textBytes([...r.embedded].map(([p, t]) => `${p}\t${t}`).join('\n') + '\n'));
  // A watermark in the box Word's Design > Watermark gives it for the page keeps no box of its own:
  // it follows the page, as when it was made (read.rs).
  const wm = r.c.settings.watermark;
  if (wm?.size) {
    const noSize = {...wm};
    delete noSize.size;
    const [dw, dh] = watermarkFrame(noSize, r.c.lastSection?.pageW ?? 612, r.c.lastSection?.pageH ?? 792);
    if (Math.abs(wm.size[0] - dw) < 0.06 && Math.abs(wm.size[1] - dh) < 0.06) delete wm.size;
  }
  r.finishMoves();
  if (!blocks.length) blocks.push(r.newPara());
  // Inline objects get stable ids (architecture 14.2), derived from their paragraph's.
  // An object's id is its paragraph's id with its index (base 36) for the last two characters; when
  // that is taken (the paragraph's own id ends that way), the next free suffix: deterministic, so the
  // same file always reads with the same ids.
  const oidFor = (b, k) => {
    const pre = b.id.slice(0, 6);
    for (let n = k; n < 36 * 36; n++) { const c = pre + n.toString(36).padStart(2, '0'); if (!r.usedIds.has(c)) return r.id(c); }
    return r.id(null);
  };
  const giveOids = bl => { for (const b of bl) { if (b.kind === 'para') (b.objects ?? []).forEach((o, k) => { if (!o.oid) o.oid = oidFor(b, k); }); else for (const row of b.rows) for (const cell of row.cells) giveOids(cell.blocks); } };
  giveOids(blocks);
  for (const p of Object.values(r.c.parts)) giveOids(p.blocks);
  for (const sep of [r.c.footnoteSeparators, r.c.endnoteSeparators]) for (const v of Object.values(sep)) giveOids(v);
  r.c.body = bodyFromBlocks(blocks);
  for (const [k, sep] of [['footnoteSeparators', r.c.footnoteSeparators], ['endnoteSeparators', r.c.endnoteSeparators]]) r.c[k] = sep;
  const d = new Document(r.c);
  d.ensureNonempty();
  return d.content;
}

/**
 * The format-worker entry point (electron/format-worker.cjs): `.docx` bytes → schema-2 content.
 * A password-protected package is refused with upstream's message (decryption is not translated yet).
 */
export async function read(bytes, _opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isEncrypted(b)) throw new DocxError('PasswordRequired', 'this document is protected with a password');
  return readPackage(await Package.open(b));
}
