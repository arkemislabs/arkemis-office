// PPTX → Prism schema-2 content: what File > Open reads for .pptx / .potx / .ppsx (and the theme of
// a .thmx for Design > Themes > Browse).
//
// Translated from deckcraft crates/pptx/src/lib.rs, xml.rs, opc.rs, read.rs, read/dml.rs,
// read/shapes.rs, read/theme.rs, read/timing.rs, custgeom.rs (reader half), maps.rs (reader half)
// and tables.rs (GUID half), cfb.rs (password-protected files, named as such by `read` as
// crates/engine/src/cmd/file.rs `open_other` does), with the transition/animation tables of crates/model/src/anim.rs and
// the warp adjust defaults of crates/geom/src/warp.rs, at deckcraft commit
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The package is read leniently, as upstream: unknown parts are skipped, malformed parts are
// ignored, every size and depth is bounded; masters, layouts, themes, slides, shapes (preset and
// custom geometry, text bodies, pictures, media, groups, connectors, tables, 3-D models), notes,
// comments (legacy and modern), sections, custom shows, show settings, guides, document properties,
// embedded fonts, tags, kept custom-XML parts, transitions and the animation timing tree (flattened
// to the Animation Pane list) land in the deckcraft model (core/prism/model) as Prism schema 2.
//
// What differs (docs/behaviour-fidelity.md), and why:
// * Charts and SmartArt. Upstream reads charts into its chart model and SmartArt into an editable
//   group with a diagram outline. Prism's model (core/prism/model) has no chart or diagram module
//   yet, so both are read as `opaque` objects: their XML and every part they point to (the chart
//   part with its embedded workbook and style parts, the diagram data/layout/style/colour/drawing
//   parts) are kept, so File > Save writes them back unchanged; the fallback picture, when the file
//   has one, is what the slide shows. Upstream's opaque reader keeps only parts without their own
//   relationships; this reader keeps those too (`parts[i][3]`, the part's own relationships, each
//   [rId, type, mediaId, nested...]), because otherwise a chart would be lost on save.
// * Media bytes are base64 strings in `media[].data` (Prism's JSON model), not a side store.
// * Offsets in text are UTF-16 code units (core/prism/model/text.mjs).
// No DOM, no Node built-ins (JSZip and TextDecoder are allowed in core/*/formats).

import {readChartPart} from '../lib/chart-read.mjs';
import * as dgm from '../lib/dgm.mjs';
import {shapeGeometry} from '../model/render.mjs';
import JSZip from 'jszip';
import {inflateCapped, ZIP_PART, ZIP_XML_PART, ZIP_TOTAL} from '../../common/lib/zip-guard.mjs';
import {fromHex, fromF64, fromHsl, preset as presetColor, slotFromXml, transformFromXml, BLACK, WHITE, rgb, THEME_SLOTS, schemeSet} from '../model/color.mjs';
import {anchorFromXml, textDirFromXml, alignFromXml, listSet, bodyText} from '../model/text.mjs';
import {shape as newShape, slide as newSlide, phFromXml, layoutFromXml, defaultShowSettings, defaultHeaderFooter, defaultProperties, fixNextId, walk} from '../model/presentation.mjs';
import {blankPresentation, buildMaster, WIDE} from '../model/defaults.mjs';
import {defaultTheme, defaultFormat} from '../model/theme.mjs';
import {info as presetInfo} from '../model/geom/index.mjs';
import {ctxForSlide, ctxForLayout, parents} from '../model/resolve.mjs';
import {normalizeTable, tableStyles as builtinTableStyles} from '../model/table.mjs';

export const UPSTREAM = Object.freeze({repo: 'deckcraft', commit: 'f893f6af7d36a5409fd804e81a34fd895cfefedf',
  files: ['crates/pptx/src/lib.rs', 'crates/pptx/src/xml.rs', 'crates/pptx/src/opc.rs', 'crates/pptx/src/read.rs', 'crates/pptx/src/read/dml.rs',
    'crates/pptx/src/read/shapes.rs', 'crates/pptx/src/read/theme.rs', 'crates/pptx/src/read/timing.rs', 'crates/pptx/src/custgeom.rs',
    'crates/pptx/src/maps.rs', 'crates/pptx/src/tables.rs', 'crates/pptx/src/cfb.rs', 'crates/model/src/anim.rs', 'crates/geom/src/warp.rs',
    'crates/engine/src/cmd/file.rs']});

export class PptxError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const notPptx = m => new PptxError('NotPptx', `not a PPTX file: ${m}`);
const warn = () => {}; // upstream logs with log::warn!; nothing is shown to the person.

// =================================================================================================
// xml.rs: a small, lenient, bounded XML tree

export const MAX_DEPTH = 256;
export const MAX_NODES = 4_000_000;

const localOf = name => { const i = name.lastIndexOf(':'); return i < 0 ? name : name.slice(i + 1); };

/** One element: `name` (qualified), `attrs` ([k, v] pairs in document order), `children` (El | string). */
export class El {
  constructor(name, attrs = [], children = []) { this.name = name; this.attrs = attrs; this.children = children; }
  get local() { return localOf(this.name); }
  get prefix() { const i = this.name.indexOf(':'); return i < 0 ? '' : this.name.slice(0, i); }
  is(local) { return this.local === local; }
  /** Attribute by name; a prefixed name matches any prefix with that local name; a bare name falls back to a prefixed attribute. */
  attr(name) {
    const i = name.indexOf(':');
    if (i >= 0) {
      const l = name.slice(i + 1);
      const hit = this.attrs.find(([k]) => k.includes(':') && !k.startsWith('xmlns') && localOf(k) === l);
      return hit ? hit[1] : null;
    }
    const hit = this.attrs.find(([k]) => k === name) ?? this.attrs.find(([k]) => !k.startsWith('xmlns') && localOf(k) === name);
    return hit ? hit[1] : null;
  }
  hasAttr(name) { return this.attr(name) !== null; }
  setAttr(name, value) {
    const a = this.attrs.find(([k]) => k === name);
    if (a) a[1] = String(value); else this.attrs.push([name, String(value)]);
  }
  i64(name) {
    const raw = this.attr(name);
    if (raw === null) return null;
    const v = raw.trim();
    if (/^[+-]?\d+$/.test(v)) { const n = Number(v); return Number.isFinite(n) ? Math.max(-9e18, Math.min(9e18, n)) : null; }
    const f = parseFloatStrict(v);
    return f === null ? null : Math.trunc(Math.max(-9e18, Math.min(9e18, f)));
  }
  i32(name) { const v = this.i64(name); return v === null ? null : Math.max(-2147483648, Math.min(2147483647, v)); }
  u32(name) { const v = this.i64(name); return v === null ? null : Math.max(0, Math.min(4294967295, v)); }
  f64(name) { const raw = this.attr(name); return raw === null ? null : parseFloatStrict(raw.trim()); }
  bool(name) {
    const raw = this.attr(name);
    if (raw === null) return null;
    const v = raw.trim();
    if (v === '1' || v === 'true' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'off') return false;
    return null;
  }
  elements() { return this.children.filter(c => c instanceof El); }
  child(local) { return this.children.find(c => c instanceof El && c.is(local)) ?? null; }
  childrenNamed(local) { return this.children.filter(c => c instanceof El && c.is(local)); }
  path(names) {
    let cur = this;
    for (const n of names) { cur = cur.child(n); if (!cur) return null; }
    return cur;
  }
  find(local) {
    const rec = (e, depth) => {
      if (depth > MAX_DEPTH) return null;
      for (const c of e.elements()) {
        if (c.is(local)) return c;
        const f = rec(c, depth + 1);
        if (f) return f;
      }
      return null;
    };
    return rec(this, 0);
  }
  findAll(local, out = []) {
    const rec = (e, depth) => {
      if (depth > MAX_DEPTH) return;
      for (const c of e.elements()) { if (c.is(local)) out.push(c); rec(c, depth + 1); }
    };
    rec(this, 0);
    return out;
  }
  text() {
    let s = '';
    const rec = (e, depth) => {
      if (depth > MAX_DEPTH) return;
      for (const c of e.children) { if (typeof c === 'string') s += c; else rec(c, depth + 1); }
    };
    rec(this, 0);
    return s;
  }
  childVal(local) { return this.child(local)?.attr('val') ?? null; }
  clone() { return new El(this.name, this.attrs.map(([k, v]) => [k, v]), this.children.map(c => (typeof c === 'string' ? c : c.clone()))); }
  toXml() {
    let s = '';
    const rec = (e, depth) => {
      if (depth > MAX_DEPTH) return;
      s += `<${e.name}`;
      for (const [k, v] of e.attrs) s += ` ${k}="${escAttr(v)}"`;
      if (!e.children.length) { s += '/>'; return; }
      s += '>';
      for (const c of e.children) { if (typeof c === 'string') s += esc(c); else rec(c, depth + 1); }
      s += `</${e.name}>`;
    };
    rec(this, 0);
    return s;
  }
}

function parseFloatStrict(v) {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|infinity|nan)$/i.test(v)) return null;
  const f = Number(v);
  return Number.isFinite(f) ? f : null;
}

const xmlChar = cp => cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp !== 0xFFFE && cp !== 0xFFFF);
/** Escape text content (drops characters XML can't hold; CR as a character reference so it survives). */
export function esc(s) {
  let o = '';
  for (const ch of String(s)) {
    if (ch === '&') o += '&amp;';
    else if (ch === '<') o += '&lt;';
    else if (ch === '>') o += '&gt;';
    else if (ch === '\r') o += '&#13;';
    else if (xmlChar(ch.codePointAt(0))) o += ch;
  }
  return o;
}
export function escAttr(s) {
  let o = '';
  for (const ch of String(s)) {
    if (ch === '&') o += '&amp;';
    else if (ch === '<') o += '&lt;';
    else if (ch === '>') o += '&gt;';
    else if (ch === '"') o += '&quot;';
    else if (ch === '\n') o += '&#10;';
    else if (ch === '\r') o += '&#13;';
    else if (ch === '\t') o += '&#9;';
    else if (xmlChar(ch.codePointAt(0))) o += ch;
  }
  return o;
}

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
function decodeRefs(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);/g, (_, r) => {
    if (r[0] === '#') {
      const cp = r[1] === 'x' || r[1] === 'X' ? Number.parseInt(r.slice(2), 16) : Number.parseInt(r.slice(1), 10);
      try { return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''; } catch { return ''; }
    }
    return ENTITIES[r] ?? '';
  });
}
const lineEnds = s => (s.includes('\r') ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s);
/** Attribute value: literal whitespace normalized to spaces, then references resolved (so `&#10;` stays a newline). */
const attrValue = s => decodeRefs(s.replace(/[\t\n\r]/g, ' '));
/** Text content: literal CR LF and lone CR read as LF, references resolved (so `&#13;` stays a CR). */
const textValue = s => decodeRefs(lineEnds(s));

function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 2 && ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF))) {
    const le = b[0] === 0xFF;
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
    const m = /^<\?xml[\s\S]*?\?>/.exec(s);
    return m ? s.slice(m[0].length) : s;
  }
  const s = new TextDecoder('utf-8').decode(b);
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/** Parse an XML document (bytes or string) into `{root: El, nsDecls()}`. Throws a PptxError for no root or limits passed. */
export function parseXml(input) {
  const src = typeof input === 'string' ? input : decodeBytes(input);
  const stack = [];
  let root = null;
  let nodes = 0;
  let i = 0;
  const n = src.length;
  const pushText = s => {
    if (!s || !stack.length) return;
    const p = stack[stack.length - 1];
    const last = p.children[p.children.length - 1];
    if (typeof last === 'string') p.children[p.children.length - 1] = last + s; else p.children.push(s);
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(textValue(src.slice(i))); break; }
    if (lt > i) pushText(textValue(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      pushText(lineEnds(src.slice(lt + 9, e < 0 ? n : e)));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE (with an optional internal subset): skipped.
      let j = lt + 2, depth = 0;
      while (j < n) { const c = src[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; j++; }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      const el = stack.pop();
      if (el) { if (stack.length) stack[stack.length - 1].children.push(el); else root = el; }
      if (root && !stack.length) break;
      continue;
    }
    // Start or empty tag.
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(lt + 1, j);
    const attrs = [];
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' ) { selfClose = true; j++; continue; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const key = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      let val = '';
      if (src[j] === '=') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, j + 1);
          val = src.slice(j + 1, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(src[e])) e++;
          val = src.slice(j, e);
          j = e;
        }
      }
      if (key) attrs.push([key, attrValue(val)]);
    }
    i = j;
    if (!name) continue;
    nodes++;
    if (root) break; // content after the root element is ignored
    const el = new El(name, attrs, []);
    if (selfClose) {
      if (nodes > MAX_NODES) throw new PptxError('Xml', 'malformed XML: document too large');
      if (stack.length) stack[stack.length - 1].children.push(el); else { root = el; break; }
    } else {
      if (nodes > MAX_NODES || stack.length >= MAX_DEPTH) throw new PptxError('Xml', 'malformed XML: document too large or too deeply nested');
      stack.push(el);
    }
  }
  while (stack.length) {
    const el = stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(el); else root = el;
  }
  if (!root) throw new PptxError('Xml', 'malformed XML: no root element');
  return {root, nsDecls: () => root.attrs.filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:')).map(([k, v]) => [k, v])};
}

// =================================================================================================
// opc.rs: the package (zip) and its relationships

// Security audit H3: tighter than the upstream limits, and enforced while inflating (not from the header).
export const MAX_PART = ZIP_PART;
export const MAX_XML_PART = ZIP_XML_PART;
export const MAX_TOTAL = ZIP_TOTAL;
/** Bytes inflated in total, kept or not (a zip bomb's discarded parts still cost the work). */
export const MAX_INFLATE_WORK = 2 * MAX_TOTAL;
export const MAX_ENTRIES = 50_000;
export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
export const NS_P15 = 'http://schemas.microsoft.com/office/powerpoint/2012/main';
export const NS_P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main';
export const NS_A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
export const NS_P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main';
export const RT_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const RT_MEDIA = 'http://schemas.microsoft.com/office/2007/relationships/media';
export const RT_MODEL3D = 'http://schemas.microsoft.com/office/2017/06/relationships/model3d';
export const RT_CORE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
export const SECTION_EXT_URI = '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}';
export const COMMENTS_EXT_URI = '{6950BFC3-D8DA-4A85-94F7-54DA5524770B}';
export const CT_COMMENTS_MODERN = 'application/vnd.ms-powerpoint.comments+xml';

export const norm = name => String(name).replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase();
export function dirOf(part) {
  const p = String(part).replace(/^\/+/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
export const fileOf = part => { const s = String(part); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); };
export function relsPath(part) {
  const p = String(part).replace(/^\/+/, '');
  const dir = dirOf(p), file = fileOf(p);
  return dir ? `${dir}/_rels/${file}.rels` : `_rels/${file}.rels`;
}
function percentDecode(s) {
  const bytes = [];
  const enc = new TextEncoder().encode(s);
  for (let i = 0; i < enc.length; i++) {
    const c = enc[i];
    if (c === 0x25 && i + 2 < enc.length) {
      const h = String.fromCharCode(enc[i + 1], enc[i + 2]);
      if (/^[0-9a-fA-F]{2}$/.test(h)) { bytes.push(Number.parseInt(h, 16)); i += 2; continue; }
    }
    bytes.push(c);
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}
/** Resolve a relationship target against the source part's folder (fragment dropped, %XX decoded, backslashes as slashes). */
export function resolve(base, target) {
  const t = percentDecode(String(target).split('#')[0]).replace(/\\/g, '/');
  const segs = t.startsWith('/') ? [] : String(base).split('/').filter(Boolean);
  for (const s of t.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') segs.pop(); else segs.push(s);
  }
  return segs.join('/');
}
/** Relative reference from part `from` to part `to`. */
export function relative(from, to) {
  const fd = dirOf(from).split('/').filter(Boolean);
  const td = dirOf(to).split('/').filter(Boolean);
  let common = 0;
  while (common < fd.length && common < td.length && fd[common] === td[common]) common++;
  let out = '';
  for (let k = common; k < fd.length; k++) out += '../';
  for (const s of td.slice(common)) out += `${s}/`;
  return out + fileOf(to);
}
/** Parts a chart or OLE object may refer to beside it (inside ppt/embeddings, charts, drawings or media; never a chart part itself). */
export function sidecarPart(name) {
  const segs = norm(name).split('/').filter(Boolean);
  if (segs.some(s => s === '.' || s === '..')) return false;
  if (segs[0] !== 'ppt' || !['embeddings', 'charts', 'drawings', 'media'].includes(segs[1])) return false;
  const file = segs[segs.length - 1] ?? '';
  const stem = file.startsWith('chart') ? file.slice(5) : '';
  const num = stem.endsWith('.xml.rels') ? stem.slice(0, -9) : stem.endsWith('.xml') ? stem.slice(0, -4) : '';
  if (stem !== file && num && /^\d+$/.test(num)) return false;
  return true;
}

export class Rels {
  constructor(items = []) { this.items = items; }
  get(id) { return this.items.find(r => r.id === id) ?? null; }
  target(id) { return this.get(id)?.target ?? null; }
  firstOf(kind) { return this.items.find(r => r.kind === kind) ?? null; }
  allOf(kind) { return this.items.filter(r => r.kind === kind); }
}
function relsOf(doc, part) {
  const base = dirOf(part);
  const out = new Rels();
  for (const r of doc.root.childrenNamed('Relationship')) {
    const id = r.attr('Id'), ty = r.attr('Type'), target = r.attr('Target');
    if (id === null || ty === null || target === null) continue;
    const external = (r.attr('TargetMode') ?? '').toLowerCase() === 'external';
    const kind = ty.slice(ty.lastIndexOf('/') + 1);
    out.items.push({id, kind, ty, targetRaw: target, target: external ? target : resolve(base, target), external});
  }
  return out;
}

/** An opened package: every part's bytes, by lower-case name. */
export class Package {
  constructor(parts) { this.parts = parts; this.ctCache = null; this.xmlCache = new Map(); }
  /** opc.rs `Package::open`; the limits are `open_within`'s (per part, kept in total, inflated in total). */
  static async open(bytes, {maxPart = MAX_PART, maxTotal = MAX_TOTAL, maxWork = MAX_INFLATE_WORK} = {}) {
    let zip;
    try { zip = await JSZip.loadAsync(bytes); } catch (e) { throw notPptx(String(e?.message ?? e)); }
    const files = Object.values(zip.files);
    if (files.length > MAX_ENTRIES) throw notPptx(`too many entries (${files.length})`);
    const parts = new Map();
    let total = 0, work = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (work >= maxWork) { warn(`decompression budget spent; skipping the remaining ${files.length - i} entries`); break; }
      if (f.dir) continue;
      const name = f.name.replace(/^\/+/, '');
      const declared = f._data?.uncompressedSize ?? 0;
      if (declared > maxPart) { warn(`skipping oversized part ${name}`); continue; }
      const cap = Math.max(0, Math.min(maxPart, maxTotal - total, maxWork - work, /\.(xml|rels|vml)$/i.test(name) ? MAX_XML_PART : maxPart));
      // Inflate at most cap + 1 bytes whatever the header says; charge what came out whether or not the part is kept.
      let data;
      try { data = await inflateCapped(f, cap, name); } catch (e) {
        if (e?.code === 'zip_limit') { work += cap + 1; warn(`part ${name} exceeds size limits; skipped`); continue; }
        warn(`could not read ${name}`); continue;
      }
      work += data.length;
      total += data.length;
      parts.set(name.toLowerCase(), {name, data});
    }
    return new Package(parts);
  }
  get(name) { return this.parts.get(norm(name))?.data ?? null; }
  originalName(name) { return this.parts.get(norm(name))?.name ?? null; }
  xmlBytes(name) {
    const b = this.get(name);
    if (!b || b.length > MAX_XML_PART) return null;
    return b;
  }
  /** A part parsed as XML, or null when missing, too large or malformed. Each call gets its own tree. */
  xml(name) {
    const b = this.get(name);
    if (!b || b.length > MAX_XML_PART) return null;
    try { return parseXml(b); } catch { warn(`${name}: malformed`); return null; }
  }
  text(name) { const b = this.get(name); if (!b) return null; try { return new TextDecoder('utf-8', {fatal: true}).decode(b); } catch { return null; } }
  rels(part) {
    const doc = this.xml(relsPath(part));
    return doc ? relsOf(doc, part) : new Rels();
  }
  contentType(part) {
    if (!this.ctCache) {
      const ov = new Map(), def = new Map();
      const doc = this.xml('[Content_Types].xml');
      if (doc) {
        for (const o of doc.root.childrenNamed('Override')) { const n = o.attr('PartName'), ct = o.attr('ContentType'); if (n !== null && ct !== null) ov.set(n.toLowerCase(), ct); }
        for (const d of doc.root.childrenNamed('Default')) { const e = d.attr('Extension'), ct = d.attr('ContentType'); if (e !== null && ct !== null) def.set(e.toLowerCase(), ct); }
      }
      this.ctCache = [ov, def];
    }
    const [ov, def] = this.ctCache;
    const p = `/${norm(part)}`;
    if (ov.has(p)) return ov.get(p);
    const ext = String(part).split('.').pop().toLowerCase();
    return def.get(ext) ?? null;
  }
}

/** Does this look like an OOXML package (a zip whose central directory lists `[Content_Types].xml`)? */
export async function sniff(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 2 || b[0] !== 0x50 || b[1] !== 0x4B) return false;
  try { const z = await JSZip.loadAsync(b); return !!z.file('[Content_Types].xml'); } catch { return false; }
}

/** Content type for a file name's extension (deckcraft `mime_for`). */
export function mimeFor(name) {
  const ext = String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '';
  return {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    svg: 'image/svg+xml', emf: 'image/x-emf', wmf: 'image/x-wmf', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv', avi: 'video/x-msvideo', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', wma: 'audio/x-ms-wma',
    ogg: 'audio/ogg', flac: 'audio/flac', glb: 'model/gltf-binary', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fntdata: 'application/x-fontdata'}[ext] ?? 'application/octet-stream';
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Bytes → base64 (Prism keeps media bytes as base64 in its JSON model). */
export function base64Encode(bytes) {
  let out = '';
  const b = bytes;
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}
/** base64 → bytes (lenient: whitespace and unknown characters are skipped). */
export function base64Decode(s) {
  const clean = String(s ?? '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0, acc = 0, bits = 0;
  for (const c of clean) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xFF; }
  }
  return out.subarray(0, o);
}

// =================================================================================================
// tables.rs (GUIDs of table styles) and model table_styles()

const KNOWN_TABLE_STYLES = [
  ['{2D5ABB26-0587-4C30-8999-92F81FD0307C}', 'none'], ['{5940675A-B579-460E-94D1-54222C63F5DA}', 'grid'],
  ['{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', 'medium2-accent1'], ['{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}', 'medium2-tx1'],
  ['{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}', 'medium2-accent2'], ['{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}', 'medium2-accent3'],
  ['{00A15C55-8517-42AA-B614-E9B94910E393}', 'medium2-accent4'], ['{7DF18680-E054-41AD-8BC1-D1AEF772440D}', 'medium2-accent5'],
  ['{93296810-A885-4BE3-A3E7-6D5BEEA58F35}', 'medium2-accent6'],
];
export const BUILTIN_WRITE_TABLE_STYLES = ['none', 'grid', 'medium2-accent1'];
export {KNOWN_TABLE_STYLES};
const M64 = (1n << 64n) - 1n;
function fnv(s, seed) {
  let h = 0xcbf29ce484222325n ^ seed;
  for (const b of new TextEncoder().encode(s)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & M64; }
  return h;
}
const hexn = (v, w) => v.toString(16).toUpperCase().padStart(w, '0');
/** A stable GUID derived from `text` (deckcraft `tables::guid`). */
export function guid(text) {
  const a = fnv(text, 0x516372616674n), b = fnv(text, 0x7461626c6573n);
  return `{${hexn((a >> 32n) & 0xFFFFFFFFn, 8)}-${hexn((a >> 16n) & 0xFFFFn, 4)}-4${hexn(a & 0x0FFFn, 3)}-8${hexn((b >> 48n) & 0x0FFFn, 3)}-${hexn(b & 0xFFFFFFFFFFFFn, 12)}}`;
}
export const ownTableGuid = style => guid(`deckcraft-table-style:${style}`);
export const isOwnTableGuid = g => builtinTableStyles().some(([id]) => ownTableGuid(id) === String(g).toUpperCase());
export function tableStyleFromGuid(g) {
  const up = String(g).toUpperCase();
  const k = KNOWN_TABLE_STYLES.find(([id]) => id === up);
  if (k) return k[1];
  for (const [id] of builtinTableStyles()) if (ownTableGuid(id) === up) return id;
  return g ? String(g) : 'none';
}

// =================================================================================================
// anim.rs / maps.rs tables shared with the writer

/** (kind, label, group, default duration ms, options) — deckcraft `TRANSITIONS`. */
export const TRANSITIONS = Object.freeze([
  ['none', 'None', 'Subtle', 0, []], ['morph', 'Morph', 'Subtle', 2000, ['objects', 'words', 'characters']],
  ['fade', 'Fade', 'Subtle', 700, ['smoothly', 'throughBlack']], ['push', 'Push', 'Subtle', 1000, ['u', 'd', 'l', 'r']],
  ['wipe', 'Wipe', 'Subtle', 1000, ['r', 'l', 'u', 'd', 'ru', 'lu', 'rd', 'ld']], ['split', 'Split', 'Subtle', 1500, ['vertOut', 'vertIn', 'horzOut', 'horzIn']],
  ['reveal', 'Reveal', 'Subtle', 2000, ['smoothlyLeft', 'smoothlyRight', 'blackLeft', 'blackRight']], ['cut', 'Cut', 'Subtle', 0, ['', 'throughBlack']],
  ['randomBar', 'Random Bars', 'Subtle', 1000, ['vert', 'horz']], ['shape', 'Shape', 'Subtle', 2000, ['circle', 'diamond', 'plus', 'in', 'out']],
  ['uncover', 'Uncover', 'Subtle', 1000, ['l', 'r', 'u', 'd', 'lu', 'ru', 'ld', 'rd']], ['cover', 'Cover', 'Subtle', 1000, ['l', 'r', 'u', 'd', 'lu', 'ru', 'ld', 'rd']],
  ['flash', 'Flash', 'Subtle', 1000, []], ['fallOver', 'Fall Over', 'Exciting', 2000, ['l', 'r']], ['drape', 'Drape', 'Exciting', 2000, ['l', 'r']],
  ['curtains', 'Curtains', 'Exciting', 2000, []], ['wind', 'Wind', 'Exciting', 2000, ['l', 'r']], ['prestige', 'Prestige', 'Exciting', 2000, []],
  ['fracture', 'Fracture', 'Exciting', 2000, []], ['crush', 'Crush', 'Exciting', 2000, []], ['peelOff', 'Peel Off', 'Exciting', 1500, ['l', 'r']],
  ['pageCurlDouble', 'Page Curl', 'Exciting', 1500, ['l', 'r', 'singleL', 'singleR']], ['airplane', 'Airplane', 'Exciting', 2000, ['l', 'r']],
  ['origami', 'Origami', 'Exciting', 2000, ['l', 'r']], ['dissolve', 'Dissolve', 'Exciting', 1200, []], ['checker', 'Checkerboard', 'Exciting', 1500, ['horz', 'vert']],
  ['blinds', 'Blinds', 'Exciting', 1600, ['vert', 'horz']], ['clock', 'Clock', 'Exciting', 2000, ['clockwise', 'counterClockwise', 'wedge']],
  ['ripple', 'Ripple', 'Exciting', 1400, ['center', 'lu', 'ru', 'ld', 'rd']], ['honeycomb', 'Honeycomb', 'Exciting', 3000, []],
  ['glitter', 'Glitter', 'Exciting', 2500, ['l', 'r', 'u', 'd', 'hexL', 'hexR', 'hexU', 'hexD']], ['vortex', 'Vortex', 'Exciting', 3000, ['l', 'r', 'u', 'd']],
  ['shred', 'Shred', 'Exciting', 2000, ['stripsIn', 'stripsOut', 'particlesIn', 'particlesOut']], ['switch', 'Switch', 'Exciting', 1250, ['l', 'r']],
  ['flip', 'Flip', 'Exciting', 1250, ['l', 'r']], ['gallery', 'Gallery', 'Exciting', 1500, ['l', 'r']], ['cube', 'Cube', 'Exciting', 1250, ['l', 'r', 'u', 'd']],
  ['doors', 'Doors', 'Exciting', 1400, ['vert', 'horz']], ['box', 'Box', 'Exciting', 1250, ['l', 'r', 'u', 'd']], ['comb', 'Comb', 'Exciting', 1000, ['horz', 'vert']],
  ['zoom', 'Zoom', 'Exciting', 1000, ['in', 'out', 'rotate']], ['random', 'Random', 'Exciting', 2000, []], ['pan', 'Pan', 'Dynamic Content', 1000, ['u', 'd', 'l', 'r']],
  ['ferris', 'Ferris Wheel', 'Dynamic Content', 2000, ['l', 'r']], ['conveyor', 'Conveyor', 'Dynamic Content', 2000, ['l', 'r']],
  ['rotate', 'Rotate', 'Dynamic Content', 2000, ['l', 'r', 'u', 'd']], ['window', 'Window', 'Dynamic Content', 1250, ['vert', 'horz']],
  ['orbit', 'Orbit', 'Dynamic Content', 2000, ['l', 'r', 'u', 'd']], ['flythrough', 'Fly Through', 'Dynamic Content', 1000, ['in', 'out', 'inBounce', 'outBounce']],
]);

const E = 'entrance', M = 'emphasis', X = 'exit', P = 'path', MD = 'media';
const DIR8 = ['b', 'lb', 'l', 'lt', 't', 'rt', 'r', 'rb'];
/** (effect, label, class, preset id, default duration ms, options) — deckcraft `ANIMATIONS`. */
export const ANIMATIONS = Object.freeze([
  ['appear', 'Appear', E, 1, 0, []], ['fade', 'Fade', E, 10, 500, []], ['fly', 'Fly In', E, 2, 500, DIR8], ['float', 'Float In', E, 42, 1000, ['u', 'd']],
  ['split', 'Split', E, 16, 500, ['horzIn', 'horzOut', 'vertIn', 'vertOut']], ['wipe', 'Wipe', E, 22, 500, ['b', 'l', 't', 'r']],
  ['shape', 'Shape', E, 6, 2000, ['circleIn', 'circleOut', 'boxIn', 'boxOut', 'diamondIn', 'diamondOut', 'plusIn', 'plusOut']],
  ['wheel', 'Wheel', E, 21, 2000, ['1', '2', '3', '4', '8']], ['randomBars', 'Random Bars', E, 14, 500, ['horz', 'vert']], ['grow', 'Grow & Turn', E, 31, 500, []],
  ['zoom', 'Zoom', E, 53, 500, ['in', 'out']], ['swivel', 'Swivel', E, 45, 2000, ['horz', 'vert']], ['bounce', 'Bounce', E, 26, 2000, []],
  ['blinds', 'Blinds', E, 3, 500, ['horz', 'vert']], ['box', 'Box', E, 4, 500, ['in', 'out']], ['checkerboard', 'Checkerboard', E, 5, 500, ['across', 'down']],
  ['circle', 'Circle', E, 6, 500, ['in', 'out']], ['diamond', 'Diamond', E, 8, 500, ['in', 'out']], ['dissolve', 'Dissolve In', E, 9, 500, []],
  ['peek', 'Peek In', E, 12, 500, ['b', 'l', 't', 'r']], ['strips', 'Strips', E, 18, 500, ['lu', 'ru', 'ld', 'rd']], ['expand', 'Expand', E, 55, 500, []],
  ['rise', 'Rise Up', E, 37, 1000, []], ['spinner', 'Spinner', E, 49, 1000, []],
  ['pulse', 'Pulse', M, 26, 500, []], ['colorPulse', 'Color Pulse', M, 27, 500, []], ['teeter', 'Teeter', M, 32, 1000, []],
  ['spin', 'Spin', M, 8, 2000, ['clockwise', 'counterClockwise']], ['growShrink', 'Grow/Shrink', M, 6, 2000, ['both', 'horz', 'vert']],
  ['desaturate', 'Desaturate', M, 35, 500, []], ['darken', 'Darken', M, 25, 500, []], ['lighten', 'Lighten', M, 30, 500, []],
  ['transparency', 'Transparency', M, 9, 500, []], ['objectColor', 'Object Color', M, 19, 2000, []], ['complementaryColor', 'Complementary Color', M, 21, 500, []],
  ['lineColor', 'Line Color', M, 7, 2000, []], ['fillColor', 'Fill Color', M, 1, 2000, []], ['fontColor', 'Font Color', M, 3, 2000, []],
  ['underline', 'Underline', M, 18, 500, []], ['boldFlash', 'Bold Flash', M, 10, 500, []], ['wave', 'Wave', M, 34, 500, []],
  ['disappear', 'Disappear', X, 1, 0, []], ['fadeOut', 'Fade', X, 10, 500, []], ['flyOut', 'Fly Out', X, 2, 500, DIR8], ['floatOut', 'Float Out', X, 42, 1000, ['u', 'd']],
  ['splitOut', 'Split', X, 16, 500, ['horzIn', 'horzOut', 'vertIn', 'vertOut']], ['wipeOut', 'Wipe', X, 22, 500, ['b', 'l', 't', 'r']],
  ['shapeOut', 'Shape', X, 6, 2000, ['circleIn', 'circleOut']], ['wheelOut', 'Wheel', X, 21, 2000, ['1', '2', '3', '4', '8']],
  ['randomBarsOut', 'Random Bars', X, 14, 500, ['horz', 'vert']], ['shrinkTurn', 'Shrink & Turn', X, 31, 500, []], ['zoomOut', 'Zoom', X, 53, 500, ['in', 'out']],
  ['swivelOut', 'Swivel', X, 45, 2000, ['horz', 'vert']], ['bounceOut', 'Bounce', X, 26, 2000, []], ['dissolveOut', 'Dissolve Out', X, 9, 500, []],
  ['blindsOut', 'Blinds', X, 3, 500, ['horz', 'vert']], ['boxOut', 'Box', X, 4, 500, ['in', 'out']], ['checkerboardOut', 'Checkerboard', X, 5, 500, ['across', 'down']],
  ['diamondOut', 'Diamond', X, 8, 500, ['in', 'out']], ['peekOut', 'Peek Out', X, 12, 500, ['b', 'l', 't', 'r']], ['stripsOut', 'Strips', X, 18, 500, ['lu', 'ru', 'ld', 'rd']],
  ['sinkDown', 'Sink Down', X, 37, 1000, []], ['spinnerOut', 'Spinner', X, 49, 1000, []], ['contract', 'Contract', X, 55, 500, []],
  ['lines', 'Lines', P, 64, 2000, ['down', 'up', 'right', 'left']], ['arcs', 'Arcs', P, 37, 2000, ['down', 'up', 'right', 'left']],
  ['turns', 'Turns', P, 43, 2000, ['down', 'up', 'right', 'left']],
  ['shapes', 'Shapes', P, 1, 2000, ['circle', 'diamond', 'hexagon', 'triangle', 'square', 'trapezoid', 'octagon', 'parallelogram', 'pentagon']],
  ['loops', 'Loops', P, 61, 2000, []], ['diagonalDownRight', 'Diagonal Down Right', P, 49, 2000, []], ['diagonalUpRight', 'Diagonal Up Right', P, 56, 2000, []],
  ['zigzag', 'Zigzag', P, 38, 2000, []], ['sineWave', 'Sine Wave', P, 40, 2000, []], ['pathWave', 'Wave', P, 47, 2000, []], ['decayingWave', 'Decaying Wave', P, 60, 2000, []],
  ['heartbeat', 'Heartbeat', P, 45, 2000, []], ['sCurve1', 'S Curve 1', P, 59, 2000, []], ['sCurve2', 'S Curve 2', P, 39, 2000, []], ['stairsDown', 'Stairs Down', P, 62, 2000, []],
  ['bounceRight', 'Bounce Right', P, 54, 2000, []], ['bounceLeft', 'Bounce Left', P, 41, 2000, []], ['spiralRight', 'Spiral Right', P, 46, 2000, []],
  ['spiralLeft', 'Spiral Left', P, 55, 2000, []], ['spring', 'Spring', P, 53, 2000, []], ['funnel', 'Funnel', P, 52, 2000, []], ['swoosh', 'Swoosh', P, 30, 2000, []],
  ['star4', '4 Point Star', P, 16, 2000, []], ['star5', '5 Point Star', P, 5, 2000, []], ['star6', '6 Point Star', P, 11, 2000, []], ['star8', '8 Point Star', P, 17, 2000, []],
  ['heart', 'Heart', P, 9, 2000, []], ['crescentMoon', 'Crescent Moon', P, 6, 2000, []], ['teardrop', 'Teardrop', P, 18, 2000, []], ['football', 'Football', P, 12, 2000, []],
  ['plusPath', 'Plus', P, 32, 2000, []], ['rightTriangle', 'Right Triangle', P, 2, 2000, []], ['curvedSquare', 'Curved Square', P, 20, 2000, []],
  ['figure8Horizontal', 'Horizontal Figure 8', P, 26, 2000, []], ['figure8Vertical', 'Vertical Figure 8', P, 22, 2000, []], ['loopDeLoop', 'Loop de Loop', P, 24, 2000, []],
  ['bean', 'Bean', P, 31, 2000, []], ['peanut', 'Peanut', P, 27, 2000, []], ['neutron', 'Neutron', P, 29, 2000, []], ['customPath', 'Custom Path', P, 0, 2000, []],
  ['play', 'Play', MD, 1, 0, []], ['pause', 'Pause', MD, 2, 0, []], ['stop', 'Stop', MD, 3, 0, []],
]);
const CLASS_XML = {entrance: 'entr', emphasis: 'emph', exit: 'exit', path: 'path', media: 'mediacall'};
export const animClassXml = c => CLASS_XML[c] ?? 'entr';
export const animClassFromXml = s => ({emph: 'emphasis', exit: 'exit', path: 'path', mediacall: 'media'}[s] ?? 'entrance');
export const animationInfo = (effect, cls) => ANIMATIONS.find(a => a[0] === effect && a[2] === cls) ?? ANIMATIONS.find(a => a[0] === effect) ?? null;
/** deckcraft `Animation::default()`. */
export const defaultAnimation = () => ({shape: '0', class: 'entrance', effect: 'fade', option: '', start: 'onClick', durationMs: 500, delayMs: 0, repeat: 1, rewind: false,
  textBuild: 'asOne', paragraph: null, path: null, trigger: null, amount: null, color: null, presetId: null, presetSubtype: null, after: null, sound: null,
  smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false});
/** deckcraft `Transition::default()`. */
export const defaultTransition = () => ({kind: 'none', option: '', durationMs: 1000, advanceOnClick: true, advanceAfterMs: null, sound: null});

const INOUT = [['in', 16], ['out', 32]], HV = [['horz', 10], ['vert', 5]], DIR4 = [['b', 4], ['l', 8], ['t', 1], ['r', 2]];
const SPLIT = [['horzIn', 21], ['horzOut', 42], ['vertIn', 26], ['vertOut', 37]], WHEEL = [['1', 1], ['2', 2], ['3', 3], ['4', 4], ['8', 8]];
const STRIPS = [['lu', 9], ['ru', 3], ['ld', 12], ['rd', 6]], CHECK = [['across', 10], ['down', 5]], DIRS4 = [['down', 4], ['up', 1], ['right', 2], ['left', 8]];
const SUBTYPES = [
  ['fly', [['b', 4], ['lb', 12], ['l', 8], ['lt', 9], ['t', 1], ['rt', 3], ['r', 2], ['rb', 6]]], ['flyOut', [['b', 4], ['lb', 12], ['l', 8], ['lt', 9], ['t', 1], ['rt', 3], ['r', 2], ['rb', 6]]],
  ['peek', DIR4], ['wipe', DIR4], ['wipeOut', DIR4], ['strips', STRIPS], ['split', SPLIT], ['splitOut', SPLIT], ['zoom', INOUT], ['zoomOut', INOUT],
  ['box', INOUT], ['circle', INOUT], ['diamond', INOUT], ['randomBars', HV], ['randomBarsOut', HV], ['blinds', HV], ['swivel', HV], ['swivelOut', HV],
  ['blindsOut', HV], ['boxOut', INOUT], ['checkerboardOut', CHECK], ['diamondOut', INOUT], ['peekOut', DIR4], ['stripsOut', STRIPS], ['checkerboard', CHECK],
  ['wheel', WHEEL], ['wheelOut', WHEEL], ['float', [['u', 0], ['d', 4]]], ['floatOut', [['u', 0], ['d', 4]]],
  ['shape', [['circleIn', 16], ['circleOut', 32], ['boxIn', 16], ['boxOut', 32], ['diamondIn', 16], ['diamondOut', 32], ['plusIn', 16], ['plusOut', 32]]],
  ['shapeOut', [['circleIn', 16], ['circleOut', 32]]], ['lines', DIRS4], ['arcs', DIRS4], ['turns', DIRS4],
];
export function optionFromSubtype(effect, sub) {
  const m = SUBTYPES.find(([e]) => e === effect)?.[1];
  return m?.find(([, s]) => s === sub)?.[0] ?? '';
}
export function subtypeFromOption(effect, option) {
  const m = SUBTYPES.find(([e]) => e === effect)?.[1];
  const hit = m?.find(([o]) => o === option);
  return hit ? hit[1] : null;
}
export const effectForPreset = (cls, preset) => ANIMATIONS.find(a => a[2] === cls && a[3] === preset && a[0] !== 'customPath')?.[0] ?? null;
export const fallbackEffect = cls => ({entrance: 'fade', exit: 'fadeOut', emphasis: 'pulse', path: 'customPath', media: 'play'}[cls] ?? 'fade');

/** deckcraft `build_filled`: does a paragraph have visible text? */
export const buildFilled = p => (p.runs ?? []).some(r => String(r.text ?? '').trim() !== '');
export const MAX_BUILD_PARAGRAPHS = 1000;
/** deckcraft `paragraph_build_roles`: `{top:true}`, `{member:i}` or `{unowned:true}` per paragraph. */
export function paragraphBuildRoles(text) {
  const filled = (text.paragraphs ?? []).filter(buildFilled).map(p => p.level ?? 0);
  const top = filled.length ? Math.min(...filled) : 0;
  let tops = 0, owner = null;
  return (text.paragraphs ?? []).map((p, i) => {
    if ((p.level ?? 0) <= top && buildFilled(p) && tops < MAX_BUILD_PARAGRAPHS) { tops++; owner = i; return {top: true}; }
    return owner === null ? {unowned: true} : {member: owner};
  });
}

const SIMPLE_TRANSITIONS = [['dissolve', 'p', 'dissolve'], ['random', 'p', 'random'], ['honeycomb', 'p14', 'honeycomb'], ['flash', 'p14', 'flash']];
export const INVX_LEFT = ['wind', 'airplane', 'origami'];
export {SIMPLE_TRANSITIONS};
/** maps.rs `transition_from_xml`: a transition effect element → [kind, option], or null for an effect not modelled. */
export function transitionFromXml(e) {
  const r = transitionFromXmlRaw(e);
  if (!r) return null;
  const t = TRANSITIONS.find(x => x[0] === r[0]);
  const hasOpts = !t || t[4].length > 0;
  return [r[0], hasOpts ? r[1] : ''];
}
function transitionFromXmlRaw(e) {
  const dir = d => e.attr('dir') ?? d;
  switch (e.local) {
    case 'fade': return ['fade', e.bool('thruBlk') === true ? 'throughBlack' : 'smoothly'];
    case 'cut': return ['cut', e.bool('thruBlk') === true ? 'throughBlack' : ''];
    case 'push': return ['push', dir('l')];
    case 'wipe': return ['wipe', dir('l')];
    case 'strips': return ['wipe', dir('lu')];
    case 'split': return ['split', `${e.attr('orient') ?? 'horz'}${(e.attr('dir') ?? 'out') === 'in' ? 'In' : 'Out'}`];
    case 'randomBar': return ['randomBar', dir('horz')];
    case 'circle': return ['shape', 'circle'];
    case 'diamond': return ['shape', 'diamond'];
    case 'plus': return ['shape', 'plus'];
    case 'zoom': return ['shape', e.attr('dir') === 'in' ? 'in' : 'out'];
    case 'warp': return ['zoom', e.attr('dir') === 'in' ? 'in' : 'out'];
    case 'newsflash': return ['zoom', 'rotate'];
    case 'pull': return ['uncover', dir('l')];
    case 'cover': return ['cover', dir('l')];
    case 'checker': return ['checker', dir('horz')];
    case 'blinds': return ['blinds', dir('horz')];
    case 'comb': return ['comb', dir('horz')];
    case 'wheel': return ['clock', 'clockwise'];
    case 'wheelReverse': return ['clock', 'counterClockwise'];
    case 'wedge': return ['clock', 'wedge'];
    case 'vortex': return ['vortex', dir('l')];
    case 'switch': return ['switch', dir('r')];
    case 'flip': return ['flip', dir('r')];
    case 'ripple': return ['ripple', dir('center')];
    case 'doors': return ['doors', dir('horz')];
    case 'window': return ['window', dir('horz')];
    case 'ferris': return ['ferris', dir('l')];
    case 'gallery': return ['gallery', dir('l')];
    case 'conveyor': return ['conveyor', dir('l')];
    case 'pan': return ['pan', dir('l')];
    case 'glitter': { const d = dir('l'); return e.attr('pattern') === 'hexagon' ? ['glitter', `hex${d.toUpperCase()}`] : ['glitter', d]; }
    case 'shred': {
      const particles = ['rectangle', 'crush'].includes(e.attr('pattern'));
      return ['shred', `${particles ? 'particles' : 'strips'}${e.attr('dir') === 'out' ? 'Out' : 'In'}`];
    }
    case 'reveal': return ['reveal', `${e.bool('thruBlk') === true ? 'black' : 'smoothly'}${e.attr('dir') === 'r' ? 'Right' : 'Left'}`];
    case 'flythrough': return ['flythrough', `${e.attr('dir') === 'out' ? 'out' : 'in'}${e.bool('hasBounce') === true ? 'Bounce' : ''}`];
    case 'prism': {
      const content = e.bool('isContent') === true, inv = e.bool('isInverted') === true;
      return [content ? (inv ? 'orbit' : 'rotate') : (inv ? 'box' : 'cube'), dir('l')];
    }
    case 'prstTrans': {
      const prst = e.attr('prst') ?? 'fallOver';
      const inv = e.bool('invX') === true;
      if (prst === 'pageCurlSingle') return ['pageCurlDouble', inv ? 'singleR' : 'singleL'];
      if (!TRANSITIONS.some(t => t[0] === prst)) return null;
      const left = INVX_LEFT.includes(prst) ? inv : !inv;
      return [prst, left ? 'l' : 'r'];
    }
    case 'morph': return ['morph', {byWord: 'words', byChar: 'characters'}[e.attr('option')] ?? 'objects'];
    default: { const s = SIMPLE_TRANSITIONS.find(x => x[2] === e.local); return s ? [s[0], ''] : null; }
  }
}

/** crates/geom/src/warp.rs `adjust_defaults`. */
export function warpAdjustDefaults(name) {
  switch (name) {
    case 'textPlain': return [50000];
    case 'textStop': return [25000];
    case 'textTriangle': case 'textTriangleInverted': return [50000];
    case 'textChevron': return [25000];
    case 'textChevronInverted': return [75000];
    case 'textRingInside': case 'textRingOutside': return [60000];
    case 'textArchUp': case 'textCircle': case 'textButton': return [10800000];
    case 'textArchDown': return [0];
    case 'textArchUpPour': case 'textCirclePour': case 'textButtonPour': return [10800000, 50000];
    case 'textArchDownPour': return [0, 25000];
    case 'textCurveUp': case 'textCurveDown': return [45977];
    case 'textCanUp': return [85000];
    case 'textCanDown': return [14286];
    case 'textWave1': case 'textWave2': return [12500, 0];
    case 'textDoubleWave1': case 'textWave4': return [6250, 0];
    case 'textInflate': case 'textDeflate': return [18750];
    case 'textInflateBottom': return [60000];
    case 'textDeflateBottom': case 'textDeflateTop': return [50000];
    case 'textInflateTop': return [40000];
    case 'textDeflateInflate': return [35000];
    case 'textDeflateInflateDeflate': return [25000];
    case 'textFadeRight': case 'textFadeLeft': case 'textFadeUp': case 'textFadeDown': return [33333];
    case 'textSlantUp': return [55556];
    case 'textSlantDown': return [44444];
    case 'textCascadeUp': case 'textCascadeDown': return [44444];
    default: return [];
  }
}

// =================================================================================================
// read.rs: the importer state and part helpers

const EMU_PER_PT = 12700;
const emuToPt = v => v / EMU_PER_PT;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
/** Set `o[k] = v` only when v is not null/undefined (Option fields are absent when None). */
const put = (o, k, v) => { if (v !== null && v !== undefined) o[k] = v; return o; };

class Imp {
  constructor(pkg) {
    this.pkg = pkg;
    this.media = [];
    this.mediaByPart = new Map();
    this.next = 0;
    this.slideByPart = new Map();
    this.customShowNames = new Map();
    this.tableStyleIds = [];
    this.vmlPreviews = new Map();
  }
  alloc() { this.next = Math.min(this.next + 1, 0xFFFFFFFF); return this.next; }
  /** The media item for a package part, added once. */
  mediaFor(part) {
    const key = norm(part);
    if (this.mediaByPart.has(key)) return this.mediaByPart.get(key);
    const data = this.pkg.get(part);
    if (!data) return null;
    const name = fileOf(this.pkg.originalName(part) ?? part);
    const ct = this.pkg.contentType(part);
    const contentType = ct && ct.length ? ct : mimeFor(name);
    const id = String(this.alloc());
    this.media.push({id, name, contentType, data: base64Encode(data), link: null});
    this.mediaByPart.set(key, id);
    return id;
  }
  /** A linked (external) media item, added once per URL. */
  mediaLink(url) {
    const hit = this.media.find(m => m.link === url);
    if (hit) return hit.id;
    const id = String(this.alloc());
    const name = url.slice(url.lastIndexOf('/') + 1);
    this.media.push({id, name, contentType: mimeFor(name), data: '', link: url});
    return id;
  }
}

class Part {
  constructor(pkg, name, doc) {
    this.name = name;
    this.rels = pkg.rels(name);
    this.ns = doc.nsDecls();
    this.innerNs = innerDecls(doc.root, this.ns);
  }
  keep(el) { return keepXml(el, this.ns); }
  keepInner(el) { return keepXml(el, [...this.ns, ...this.innerNs]); }
}
function innerDecls(root, ns) {
  const out = [], map = new Map(), clash = new Set();
  const rec = (e, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const [k, v] of e.attrs.filter(([k]) => k.startsWith('xmlns:'))) {
      if (map.has(k)) { if (map.get(k) !== v) clash.add(k); } else if (out.length < 1000) { map.set(k, v); out.push([k, v]); }
    }
    for (const c of e.elements()) rec(c, depth + 1);
  };
  const rootNs = new Set(ns.map(([k]) => k));
  for (const c of root.elements()) rec(c, 1);
  return out.filter(([k]) => !clash.has(k) && !rootNs.has(k));
}
/** An element's XML with the namespace declarations its prefixes need (so it can be written back on its own). */
export function keepXml(el, ns) {
  const used = new Set();
  const rec = (e, depth) => {
    if (depth > MAX_DEPTH) return;
    const i = e.name.indexOf(':');
    if (i >= 0) used.add(e.name.slice(0, i));
    for (const [k] of e.attrs) { const j = k.indexOf(':'); if (j >= 0) { const p = k.slice(0, j); if (p !== 'xmlns' && p !== 'xml') used.add(p); } }
    for (const c of e.elements()) rec(c, depth + 1);
  };
  rec(el, 0);
  const out = el.clone();
  for (const [k, v] of ns) {
    const p = k.startsWith('xmlns:') ? k.slice(6) : '';
    if (p && used.has(p) && !out.attrs.some(([a]) => a === k)) out.attrs.push([k, v]);
  }
  return out.toXml();
}

const SUPPORTED_MC = ['p14', 'p15', 'p159', 'a14', 'a16', 'p1510', 'a15', 'c14', 'p188', 'cx1'];
const chartexReadable = ch => ch.findAll('graphicData').some(g => (g.attr('uri') ?? '').endsWith('/chartex'));
export const isModel3d = rel => !rel.external && (rel.kind === 'model3d' || rel.target.toLowerCase().endsWith('.glb'));
function choiceHasModel3d(el, rels) {
  const rec = (e, depth) => {
    if (depth > 16) return false;
    if (e.is('contentPart')) { const id = e.attr('r:id'); if (id && rels.get(id) && isModel3d(rels.get(id))) return true; }
    return e.elements().some(c => rec(c, depth + 1));
  };
  return rec(el, 0);
}
/**
 * Resolve markup-compatibility blocks in place: the first Choice whose requirements we read (and
 * whose content we model), else the Fallback. A Choice holding a 3-D model stays for the shape reader.
 * Note: charts written as cx1 choices are kept only when readable; here they are opaque either way.
 */
export function resolveMc(el, depth = 0, rels = null) {
  if (depth > MAX_DEPTH) return;
  if (el.children.some(c => c instanceof El && c.is('AlternateContent'))) {
    const out = [];
    for (const c of el.children) {
      if (!(c instanceof El && c.is('AlternateContent'))) { out.push(c); continue; }
      const ac = c;
      if (rels && ac.childrenNamed('Choice').some(ch => choiceHasModel3d(ch, rels))) { out.push(ac); continue; }
      const choice = ac.childrenNamed('Choice').find(ch => {
        const req = (ch.attr('Requires') ?? '').split(/\s+/).filter(Boolean);
        const reqOk = req.every(r => SUPPORTED_MC.includes(r));
        const modelled = !ch.elements().some(e => e.is('contentPart')) && (!(ch.attr('Requires') ?? '').includes('cx1') || chartexReadable(ch));
        return reqOk && modelled;
      });
      const branch = choice ?? ac.child('Fallback');
      if (branch) {
        for (const n of branch.children) {
          if (!(n instanceof El)) continue;
          const e = n.clone();
          for (const [k, v] of [...branch.attrs, ...ac.attrs]) if (k.startsWith('xmlns') && !e.attrs.some(([a]) => a === k)) e.attrs.push([k, v]);
          out.push(e);
        }
      }
    }
    el.children = out;
  }
  for (const c of el.elements()) resolveMc(c, depth + 1, rels);
}
function load(pkg, name) {
  const d = pkg.xml(name);
  if (!d) return null;
  resolveMc(d.root, 0, pkg.rels(name));
  return d;
}
function maxCnvPr(el, m) {
  for (const c of el.findAll('cNvPr')) { const id = c.u32('id'); if (id !== null && id < MAX_KEPT_ID) m.v = Math.max(m.v, id); }
}

/** Add-in tags of a holder's `p:custDataLst` (name/value pairs from `ppt/tags/tagN.xml`). */
function tags(imp, part, holder) {
  const list = holder.child('custDataLst');
  if (!list) return [];
  const out = [];
  for (const t of list.childrenNamed('tags').slice(0, 100)) {
    const rel = part.rels.get(t.attr('r:id') ?? '');
    const doc = rel ? imp.pkg.xml(rel.target) : null;
    if (!doc) continue;
    for (const tag of doc.root.childrenNamed('tag').slice(0, 10000)) { const n = tag.attr('name'); if (n !== null) out.push([n, tag.attr('val') ?? '']); }
  }
  return out;
}

const KEPT_RELS = [['http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml', false],
  ['http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels', true],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties', true]];
function keepable(name) {
  const n = String(name).toLowerCase();
  return !!n && !n.includes('..') && !n.startsWith('ppt/') && n !== 'docprops/core.xml' && n !== 'docprops/app.xml' && !n.startsWith('[content_types]');
}
function keptParts(pkg, presPath) {
  const out = [];
  for (const [holder, fromRoot] of [['', true], [presPath, false]]) {
    const doc = pkg.xml(relsPath(holder));
    if (!doc) continue;
    const base = dirOf(holder);
    for (const r of doc.root.childrenNamed('Relationship')) {
      const ty = r.attr('Type'), target = r.attr('Target');
      if (ty === null || target === null) continue;
      if ((r.attr('TargetMode') ?? '').toLowerCase() === 'external' || !KEPT_RELS.some(([t, root]) => t === ty && root === fromRoot)) continue;
      const name = resolve(base, target);
      if (!keepable(name) || out.some(k => k.name.toLowerCase() === name.toLowerCase()) || out.length >= 400) continue;
      const xml = pkg.text(name);
      if (xml === null) continue;
      out.push({name, contentType: pkg.contentType(name) ?? '', xml, relType: ty, fromRoot});
      const rp = relsPath(name);
      const relsXml = pkg.text(rp);
      if (relsXml !== null) {
        for (const sub of pkg.rels(name).items.filter(s => !s.external && keepable(s.target))) {
          const x = pkg.text(sub.target);
          if (x !== null && !out.some(k => k.name.toLowerCase() === sub.target.toLowerCase())) {
            out.push({name: sub.target, contentType: pkg.contentType(sub.target) ?? '', xml: x, relType: '', fromRoot: false});
          }
        }
        out.push({name: rp, contentType: '', xml: relsXml, relType: '', fromRoot: false});
      }
    }
  }
  return out;
}

const isRelAttr = (k, v) => !k.startsWith('xmlns') && k.includes(':') && ['id', 'embed', 'link', 'dm', 'lo', 'qs', 'cs', 'pict', 'href'].includes(k.slice(k.lastIndexOf(':') + 1)) && v !== '';
export {isRelAttr};
/** Relationship ids an element refers to (sorted, unique). */
export function relRefs(el) {
  const out = new Set();
  const rec = (e, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const [k, v] of e.attrs) if (isRelAttr(k, v)) out.add(v);
    for (const c of e.elements()) rec(c, depth + 1);
  };
  rec(el, 0);
  return [...out].sort();
}
export const hasRelRefs = el => relRefs(el).length > 0;
export const colorMap = cm => cm.attrs.filter(([k]) => !k.startsWith('xmlns')).map(([k, v]) => [k, v]);

// =================================================================================================
// read/dml.rs: DrawingML

const pt = (e, name) => { const v = e.i64(name); return v === null ? null : emuToPt(v); };
const pct = (e, name) => { const v = e.f64(name); return v === null ? null : v / 100000; };
const ang = (e, name) => { const v = e.f64(name); return v === null ? null : v / 60000; };
const linToSrgb = v => { const x = clamp(v, 0, 1); return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055; };

/** A colour element (`a:srgbClr`, `a:schemeClr`, `a:sysClr`, `a:prstClr`, `a:scrgbClr`, `a:hslClr`) with its transforms. */
export function colorEl(c) {
  let base;
  switch (c.local) {
    case 'srgbClr': base = {kind: 'rgb', rgb: fromHex(c.attr('val') ?? '000000') ?? BLACK}; break;
    case 'schemeClr': base = {kind: 'scheme', slot: slotFromXml(c.attr('val') ?? '') ?? 'tx1'}; break;
    case 'sysClr': base = {kind: 'system', name: c.attr('val') ?? 'windowText', last: fromHex(c.attr('lastClr') ?? '') ?? (c.attr('val') === 'window' ? WHITE : BLACK)}; break;
    case 'prstClr': base = {kind: 'preset', name: c.attr('val') ?? 'black'}; break;
    case 'scrgbClr': { const f = n => linToSrgb((c.f64(n) ?? 0) / 100000); base = {kind: 'rgb', rgb: fromF64(f('r'), f('g'), f('b'), 1)}; break; }
    case 'hslClr': base = {kind: 'rgb', rgb: fromHsl((c.f64('hue') ?? 0) / 60000, (c.f64('sat') ?? 0) / 100000, (c.f64('lum') ?? 0) / 100000, 255)}; break;
    default: return null;
  }
  base = {...base};
  const mods = c.elements().slice(0, 32).map(m => transformFromXml(m.local, m.i32('val'))).filter(Boolean);
  return mods.length ? {base, mods} : {base};
}
export const color = container => { for (const e of container.elements()) { const c = colorEl(e); if (c) return c; } return null; };
const rgbRef = c => ({base: {kind: 'rgb', rgb: c}});
const schemeRef = slot => ({base: {kind: 'scheme', slot}});

const FILL_NAMES = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'];
export function fillOf(imp, part, parent) {
  const f = parent.elements().find(e => FILL_NAMES.includes(e.local));
  return f ? fillEl(imp, part, f) : null;
}
export function fillEl(imp, part, f) {
  switch (f.local) {
    case 'noFill': return {kind: 'none'};
    case 'solidFill': return {kind: 'solid', color: color(f) ?? rgbRef(BLACK)};
    case 'gradFill': return {kind: 'gradient', ...gradient(f)};
    case 'blipFill': {
      const p = blipFill(imp, part, f);
      if (!p) return {kind: 'none'};
      if (!f.child('stretch') && !f.child('tile')) p.mode = {kind: 'tile', tx: 0, ty: 0, sx: 1, sy: 1, flip: 'none', align: 'tl'};
      return {kind: 'picture', ...p};
    }
    case 'pattFill': return {kind: 'pattern', ...pattern(f)};
    case 'grpFill': return {kind: 'group'};
    default: return null;
  }
}
const pattern = f => ({preset: f.attr('prst') ?? 'pct5', fg: (f.child('fgClr') && color(f.child('fgClr'))) ?? rgbRef(BLACK), bg: (f.child('bgClr') && color(f.child('bgClr'))) ?? rgbRef(WHITE)});
export function gradient(f) {
  const stops = (f.child('gsLst')?.childrenNamed('gs') ?? []).slice(0, 256).map(g => ({pos: clamp(pct(g, 'pos') ?? 0, 0, 1), color: color(g) ?? rgbRef(BLACK)}));
  stops.sort((a, b) => a.pos - b.pos);
  let shape;
  const l = f.child('lin'), p = f.child('path');
  if (l) shape = {kind: 'linear', angle: ang(l, 'ang') ?? 0, scaled: l.bool('scaled') ?? false};
  else if (p) { const r = p.child('fillToRect'); const g = n => (r ? pct(r, n) ?? 0 : 0); shape = {kind: 'path', path: p.attr('path') ?? 'circle', focus: [g('l'), g('t'), g('r'), g('b')]}; }
  else shape = {kind: 'linear', angle: 90, scaled: false};
  const out = {stops, shape, rotateWithShape: f.bool('rotWithShape') ?? true};
  const tr = f.child('tileRect');
  if (tr) {
    const tile = ['l', 't', 'r', 'b'].map(n => clamp(pct(tr, n) ?? 0, -10, 10));
    if (tile.some(v => v !== 0)) out.tile = tile;
  }
  return out;
}
/** deckcraft `PictureAdjust::default()`. */
export const defaultAdjust = () => ({brightness: 0, contrast: 0, saturation: null, grayscale: false, duotone: null, clearColor: null, sharpen: 0});
/** deckcraft `PictureFill::default()` with `media`. */
export const pictureFill = media => ({media, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: defaultAdjust()});
export function blipFill(imp, part, bf) {
  const blip = bf.child('blip');
  const media = blip ? mediaRef(imp, part, blip) : null;
  if (media === null) return null;
  const pf = pictureFill(media);
  if (!(bf.bool('rotWithShape') ?? true)) pf.upright = true;
  const layer = blip.child('extLst')?.find('imgLayer');
  if (layer) {
    const effect = layer.elements().filter(e => e.local === 'imgEffect').flatMap(e => e.elements()).map(e => e.local).find(n => n.startsWith('artistic'));
    const original = effect ? mediaRef(imp, part, layer) : null;
    if (effect && original !== null) pf.artistic = {effect, original};
  }
  for (const e of blip.elements()) {
    switch (e.local) {
      case 'alphaModFix': pf.alpha = clamp(pct(e, 'amt') ?? 1, 0, 1); break;
      case 'lum': pf.adjust.brightness = clamp(pct(e, 'bright') ?? 0, -1, 1); pf.adjust.contrast = clamp(pct(e, 'contrast') ?? 0, -1, 1); break;
      case 'grayscl': pf.adjust.grayscale = true; break;
      case 'biLevel': pf.adjust.bilevel = clamp(pct(e, 'thresh') ?? 0.5, 0, 1); break;
      case 'alphaInv': pf.adjust.alphaInv = true; break;
      case 'duotone': { const cs = e.elements().map(colorEl).filter(Boolean); if (cs.length === 2) pf.adjust.duotone = [cs[0], cs[1]]; break; }
      case 'clrChange': { const c = e.child('clrFrom') && color(e.child('clrFrom')); if (c?.base?.kind === 'rgb') pf.adjust.clearColor = c.base.rgb; break; }
      default: break;
    }
  }
  const sr = bf.child('srcRect');
  if (sr) pf.crop = ['l', 't', 'r', 'b'].map(n => clamp(pct(sr, n) ?? 0, -10, 1));
  const t = bf.child('tile');
  if (t) pf.mode = {kind: 'tile', tx: pt(t, 'tx') ?? 0, ty: pt(t, 'ty') ?? 0, sx: pct(t, 'sx') ?? 1, sy: pct(t, 'sy') ?? 1, flip: t.attr('flip') ?? 'none', align: t.attr('algn') ?? 'tl'};
  else {
    const r = bf.path(['stretch', 'fillRect']);
    pf.mode = {kind: 'stretch', fillRect: ['l', 't', 'r', 'b'].map(n => clamp((r ? pct(r, n) : null) ?? 0, -10, 1))};
  }
  return pf;
}
/** The media an element's `r:embed` / `r:link` names (embedded part, else the external link). */
export function mediaRef(imp, part, b) {
  for (const attr of ['r:embed', 'r:link']) {
    const id = b.attr(attr);
    if (!id) continue;
    const r = part.rels.get(id);
    if (!r) continue;
    if (r.external) return imp.mediaLink(r.target);
    const m = imp.mediaFor(r.target);
    if (m !== null || attr === 'r:link') return m;
  }
  return null;
}
export function line(imp, part, ln) {
  const l = {};
  const w = pt(ln, 'w');
  if (w !== null) l.width = clamp(w, 0, 2000);
  const cap = ln.attr('cap');
  if (cap !== null) l.cap = cap === 'rnd' ? 'round' : cap === 'sq' ? 'square' : 'flat';
  const cmpd = ln.attr('cmpd');
  if (cmpd !== null) l.compound = {sng: 'single', dbl: 'double', thickThin: 'thickThin', thinThick: 'thinThick', tri: 'triple'}[cmpd] ?? 'single';
  put(l, 'fill', fillOf(imp, part, ln));
  for (const e of ln.elements()) {
    switch (e.local) {
      case 'prstDash': l.dash = {kind: 'preset', name: e.attr('val') ?? 'solid'}; break;
      case 'custDash': l.dash = {kind: 'custom', pattern: e.childrenNamed('ds').slice(0, 64).map(d => [pct(d, 'd') ?? 1, pct(d, 'sp') ?? 1])}; break;
      case 'round': l.join = 'round'; break;
      case 'bevel': l.join = 'bevel'; break;
      case 'miter': l.join = 'miter'; break;
      case 'headEnd': l.head = lineEnd(e); break;
      case 'tailEnd': l.tail = lineEnd(e); break;
      case 'extLst': {
        for (const ext of e.childrenNamed('ext')) {
          const sk = ext.child('sketch')?.attr('style');
          if (sk === 'curved' || sk === 'freehand' || sk === 'scribble') l.sketch = sk;
        }
        break;
      }
      default: break;
    }
  }
  return l;
}
const lineEnd = e => ({kind: e.attr('type') ?? 'none', w: e.attr('w') ?? 'med', len: e.attr('len') ?? 'med'});
const shadow = (e, inner) => ({
  color: color(e) ?? rgbRef(BLACK), blur: Math.max(pt(e, 'blurRad') ?? 0, 0), dist: pt(e, 'dist') ?? 0, dir: ang(e, 'dir') ?? 0, inner,
  sx: pct(e, 'sx') ?? 1, sy: pct(e, 'sy') ?? 1, kx: ang(e, 'kx') ?? 0, ky: ang(e, 'ky') ?? 0, align: e.attr('algn') ?? (inner ? '' : 'b'),
  rotateWithShape: e.bool('rotWithShape') ?? true,
});
export function effects(el) {
  const fx = {};
  for (const e of el.elements()) {
    switch (e.local) {
      case 'outerShdw': fx.outerShadow = shadow(e, false); break;
      case 'prstShdw': fx.outerShadow = {...shadow(e, false), align: 'b'}; break;
      case 'innerShdw': fx.innerShadow = shadow(e, true); break;
      case 'glow': fx.glow = {color: color(e) ?? rgbRef(BLACK), radius: Math.max(pt(e, 'rad') ?? 0, 0)}; break;
      case 'softEdge': fx.softEdge = Math.max(pt(e, 'rad') ?? 0, 0); break;
      case 'fillOverlay': {
        let fill = null;
        for (const f of e.elements()) {
          if (f.local === 'solidFill') { const c = color(f); if (c) { fill = {kind: 'solid', color: c}; break; } }
          if (f.local === 'gradFill') { fill = {kind: 'gradient', ...gradient(f)}; break; }
        }
        if (fill) fx.fillOverlay = {blend: e.attr('blend') ?? 'over', fill};
        break;
      }
      case 'reflection':
        fx.reflection = {blur: pt(e, 'blurRad') ?? 0, startAlpha: pct(e, 'stA') ?? 1, endAlpha: pct(e, 'endA') ?? 0, endPos: pct(e, 'endPos') ?? 1, dist: pt(e, 'dist') ?? 0};
        break;
      default: break;
    }
  }
  return fx;
}
/** `a:xfrm` → [xfrm, child xfrm or null] (groups carry chOff/chExt). */
export function xfrm(x) {
  const off = x.child('off'), ext = x.child('ext');
  const g = (e, n) => (e ? pt(e, n) ?? 0 : 0);
  const xf = {x: g(off, 'x'), y: g(off, 'y'), w: Math.max(g(ext, 'cx'), 0), h: Math.max(g(ext, 'cy'), 0)};
  const rot = ang(x, 'rot') ?? 0;
  if (Number.isFinite(rot) && rot !== 0) xf.rot = rot;
  if (x.bool('flipH')) xf.flipH = true;
  if (x.bool('flipV')) xf.flipV = true;
  const o = x.child('chOff'), e = x.child('chExt');
  const child = o && e ? {x: g(o, 'x'), y: g(o, 'y'), w: Math.max(g(e, 'cx'), 0), h: Math.max(g(e, 'cy'), 0)} : null;
  return [xf, child];
}
export function bodyPr(b) {
  const p = {};
  put(p, 'insetL', pt(b, 'lIns')); put(p, 'insetT', pt(b, 'tIns')); put(p, 'insetR', pt(b, 'rIns')); put(p, 'insetB', pt(b, 'bIns'));
  put(p, 'anchor', b.attr('anchor') === null ? null : anchorFromXml(b.attr('anchor')));
  put(p, 'anchorCtr', b.bool('anchorCtr'));
  put(p, 'wrap', b.attr('wrap') === null ? null : b.attr('wrap') !== 'none');
  put(p, 'vert', b.attr('vert') === null ? null : textDirFromXml(b.attr('vert')));
  put(p, 'rot', ang(b, 'rot'));
  const nc = b.u32('numCol');
  put(p, 'columns', nc === null ? null : clamp(nc, 1, 16));
  put(p, 'colSpacing', pt(b, 'spcCol'));
  put(p, 'rtlCol', b.bool('rtlCol'));
  put(p, 'upright', b.bool('upright'));
  put(p, 'spaceFirstLast', b.bool('spcFirstLastPara'));
  for (const e of b.elements()) {
    switch (e.local) {
      case 'normAutofit': {
        const fs = pct(e, 'fontScale');
        const a = {kind: 'shrink', lineReduction: clamp(pct(e, 'lnSpcReduction') ?? 0, 0, 1)};
        if (fs !== null) a.fontScale = clamp(fs, 0.01, 1);
        p.autofit = a;
        break;
      }
      case 'spAutoFit': p.autofit = {kind: 'shape'}; break;
      case 'noAutofit': p.autofit = {kind: 'none'}; break;
      case 'prstTxWarp': {
        const w = e.attr('prst');
        if (w && w !== 'textNoShape') { p.warp = w; const adj = warpAdjusts(w, e); if (adj.length) p.warpAdj = adj; } else delete p.warp;
        break;
      }
      default: break;
    }
  }
  return p;
}
function adjIndex(n, max) {
  if (n === 'adj') return 0;
  const m = /^adj(\d+)$/.exec(n);
  if (!m) return null;
  const k = Number(m[1]);
  return k >= 1 && k <= max ? k - 1 : null;
}
const fmlaVal = gd => {
  const f = (gd.attr('fmla') ?? '').trim();
  if (!f.startsWith('val')) return null;
  const v = parseFloatStrict(f.slice(3).trim());
  return v;
};
function warpAdjusts(preset, e) {
  const adj = [];
  const av = e.child('avLst');
  if (!av) return adj;
  const defaults = warpAdjustDefaults(preset);
  for (const gd of av.childrenNamed('gd').slice(0, 16)) {
    const idx = adjIndex(gd.attr('name') ?? '', 8);
    const v = fmlaVal(gd);
    if (idx === null || v === null) continue;
    while (adj.length <= idx) adj.push(defaults[adj.length] ?? 0);
    adj[idx] = clamp(v, -1e9, 1e9);
  }
  return adj;
}
function spacing(e) {
  const p = e.child('spcPct');
  if (p) return {kind: 'pct', v: clamp(pct(p, 'val') ?? 1, 0, 100)};
  const s = e.child('spcPts');
  return s ? {kind: 'pts', v: clamp(s.f64('val') ?? 0, 0, 1000000) / 100} : null;
}
/** `a:pPr` / `a:lvlNpPr` → [level or null, ParaProps, default RunProps or null]. */
export function ppr(imp, part, p) {
  const pp = {};
  put(pp, 'align', p.attr('algn') === null ? null : alignFromXml(p.attr('algn')));
  put(pp, 'marginLeft', pt(p, 'marL')); put(pp, 'marginRight', pt(p, 'marR')); put(pp, 'indent', pt(p, 'indent'));
  put(pp, 'rtl', p.bool('rtl')); put(pp, 'fontAlign', p.attr('fontAlgn'));
  put(pp, 'eastAsianLineBreak', p.bool('eaLnBrk')); put(pp, 'latinLineBreak', p.bool('latinLnBrk')); put(pp, 'hangingPunct', p.bool('hangingPunct'));
  put(pp, 'defaultTab', pt(p, 'defTabSz'));
  const l = p.u32('lvl');
  const lvl = l === null ? null : Math.min(l, 8);
  let def = null;
  for (const e of p.elements()) {
    switch (e.local) {
      case 'lnSpc': put(pp, 'lineSpacing', spacing(e)); break;
      case 'spcBef': put(pp, 'spaceBefore', spacing(e)); break;
      case 'spcAft': put(pp, 'spaceAfter', spacing(e)); break;
      case 'buNone': pp.bullet = {kind: 'none'}; break;
      case 'buChar': pp.bullet = {kind: 'char', char: [...(e.attr('char') ?? '•')].slice(0, 4).join('')}; break;
      case 'buAutoNum': pp.bullet = {kind: 'autoNum', scheme: e.attr('type') ?? 'arabicPeriod', startAt: clamp(e.u32('startAt') ?? 1, 1, 32767)}; break;
      case 'buBlip': { const b = e.child('blip'); const m = b ? mediaRef(imp, part, b) : null; if (m !== null) pp.bullet = {kind: 'picture', media: m}; break; }
      case 'buFont': put(pp, 'bulletFont', e.attr('typeface')); break;
      case 'buClr': put(pp, 'bulletColor', color(e)); break;
      case 'buSzPct': { const v = pct(e, 'val'); put(pp, 'bulletSize', v === null ? null : clamp(v, 0.25, 4)); break; }
      case 'tabLst': pp.tabs = e.childrenNamed('tab').slice(0, 64).map(t => ({pos: pt(t, 'pos') ?? 0, align: t.attr('algn') ?? 'l'})); break;
      case 'defRPr': def = rpr(imp, part, e); break;
      default: break;
    }
  }
  return [lvl, pp, def];
}
/** A hyperlink or action (`a:hlinkClick`, `a:hlinkHover`, `a:hlinkMouseOver`). */
export function hyperlink(imp, part, h) {
  const rel = part.rels.get(h.attr('r:id') ?? '');
  const action = h.attr('action') ?? '';
  let a;
  if (action.startsWith('ppaction://hlinkshowjump?jump=')) {
    const rest = action.slice('ppaction://hlinkshowjump?jump='.length);
    const k = {nextslide: 'nextSlide', previousslide: 'previousSlide', firstslide: 'firstSlide', lastslide: 'lastSlide', endshow: 'endShow', lastslideviewed: 'lastViewed'}[rest];
    if (!k) return null;
    a = {kind: k};
  } else if (action.startsWith('ppaction://hlinksldjump')) {
    const slide = rel ? imp.slideByPart.get(norm(rel.target)) : undefined;
    if (slide === undefined) return null;
    a = {kind: 'slide', slide};
  } else if (action.startsWith('ppaction://customshow?')) {
    const q = action.slice('ppaction://customshow?'.length).split('&');
    const id = q.find(kv => kv.startsWith('id='))?.slice(3) ?? '0';
    const ret = q.find(kv => kv.startsWith('return='))?.slice(7);
    a = {kind: 'customShow', name: imp.customShowNames.get(id) ?? id};
    if (ret === 'false' || ret === '0') a.returns = false;
  } else if (action.startsWith('ppaction://program')) a = {kind: 'program', path: rel?.target ?? ''};
  else if (action.startsWith('ppaction://media')) a = {kind: 'playMedia'};
  else if (action === '' || action.startsWith('ppaction://hlinkfile')) {
    if (!rel || !rel.target) return null;
    const s = !rel.external ? imp.slideByPart.get(norm(rel.target)) : undefined;
    a = s !== undefined ? {kind: 'slide', slide: s} : {kind: 'url', url: rel.target};
  } else return null;
  const out = {action: a, tooltip: h.attr('tooltip') ?? '', highlightClick: h.bool('highlightClick') ?? false};
  const snd = h.child('snd');
  const sound = snd ? mediaRef(imp, part, snd) : null;
  if (sound !== null) out.sound = sound;
  if (h.bool('endSnd')) out.stopSound = true;
  return out;
}
const typeface = e => { const t = e.attr('typeface'); return t ? [...t].slice(0, 256).join('') : null; };
export function rpr(imp, part, r) {
  const p = {};
  put(p, 'lang', r.attr('lang'));
  const sz = r.f64('sz');
  put(p, 'size', sz === null ? null : clamp(sz / 100, 1, 4000));
  put(p, 'bold', r.bool('b')); put(p, 'italic', r.bool('i')); put(p, 'underline', r.attr('u'));
  const st = r.attr('strike');
  put(p, 'strike', st === null ? null : st === 'sngStrike' ? 'single' : st === 'dblStrike' ? 'double' : 'none');
  const bl = pct(r, 'baseline');
  put(p, 'baseline', bl === null ? null : clamp(bl, -10, 10));
  const cap = r.attr('cap');
  put(p, 'caps', cap === null ? null : cap === 'small' ? 'small' : cap === 'all' ? 'all' : 'none');
  const spc = r.f64('spc');
  put(p, 'spacing', spc === null ? null : clamp(spc / 100, -4000, 4000));
  const kern = r.f64('kern');
  put(p, 'kern', kern === null ? null : clamp(kern / 100, 0, 4000));
  put(p, 'noProof', r.bool('noProof'));
  for (const e of r.elements()) {
    const n = e.local;
    if (n === 'ln') p.outline = line(imp, part, e);
    else if (FILL_NAMES.includes(n)) put(p, 'fill', fillEl(imp, part, e));
    else if (n === 'effectLst') {
      const fx = effects(e);
      put(p, 'shadow', fx.outerShadow); put(p, 'innerShadow', fx.innerShadow); put(p, 'glow', fx.glow); put(p, 'reflection', fx.reflection); put(p, 'softEdge', fx.softEdge);
    } else if (n === 'highlight') put(p, 'highlight', color(e));
    else if (n === 'uFill') { const s = e.child('solidFill'); put(p, 'underlineColor', s ? color(s) : null); }
    else if (n === 'latin') put(p, 'font', typeface(e));
    else if (n === 'ea') put(p, 'fontEa', typeface(e));
    else if (n === 'cs') put(p, 'fontCs', typeface(e));
    else if (n === 'sym') put(p, 'fontSym', typeface(e));
    else if (n === 'hlinkClick') put(p, 'link', hyperlink(imp, part, e));
    else if (n === 'hlinkMouseOver') put(p, 'hover', hyperlink(imp, part, e));
  }
  return p;
}
export function listStyle(imp, part, ls) {
  let out = {levels: []};
  for (const e of ls.elements()) {
    const m = /^lvl(\d)pPr$/.exec(e.local);
    if (!m) continue;
    const l = Number(m[1]);
    if (l < 1 || l > 9) continue;
    const [, para, run] = ppr(imp, part, e);
    out = listSet(out, l - 1, {para, run: run ?? {}});
  }
  return out;
}
const listEmpty = ls => (ls?.levels ?? []).every(x => !x);
export function textBody(imp, part, tx) {
  const b = tx.child('bodyPr');
  const out = {body: b ? bodyPr(b) : {}};
  const raw3d = b ? b.elements().filter(c => c.is('scene3d') || c.is('sp3d')).map(c => part.keep(c)).join('') : '';
  if (raw3d) out.body.raw3d = raw3d;
  const ls = tx.child('lstStyle');
  if (ls) { const s = listStyle(imp, part, ls); if (!listEmpty(s)) out.listStyle = s; }
  out.paragraphs = tx.childrenNamed('p').slice(0, 100000).map(p => paragraph(imp, part, p));
  return out;
}
const MAX_PARAGRAPH_RUNS = 10000;
const isEmptyObj = o => !o || Object.keys(o).length === 0;
const mkRun = (text, props, kind) => {
  const r = {text};
  if (!isEmptyObj(props)) r.props = props;
  if (kind && kind.kind !== 'text') r.kind = kind;
  return r;
};
function pushTextRuns(para, props, text) {
  const pieces = text.split(/[\u000b\n]/);
  pieces.forEach((piece, i) => {
    if (para.runs.length >= MAX_PARAGRAPH_RUNS) return;
    if (i > 0) para.runs.push(mkRun('', structuredClone(props), {kind: 'break'}));
    if (piece && para.runs.length < MAX_PARAGRAPH_RUNS) para.runs.push(mkRun(piece, structuredClone(props)));
  });
}
export function paragraph(imp, part, p) {
  const para = {level: 0, runs: []};
  const runProps = e => { const r = e.child('rPr'); return r ? rpr(imp, part, r) : {}; };
  for (const e of p.elements()) {
    switch (e.local) {
      case 'pPr': {
        const [lvl, pp, def] = ppr(imp, part, e);
        para.level = lvl ?? 0;
        if (!isEmptyObj(pp)) para.props = pp;
        if (def && !isEmptyObj(def)) para.defProps = def;
        break;
      }
      case 'r': pushTextRuns(para, runProps(e), e.child('t')?.text() ?? ''); break;
      case 'br': if (para.runs.length < MAX_PARAGRAPH_RUNS) para.runs.push(mkRun('', runProps(e), {kind: 'break'})); break;
      case 'fld': if (para.runs.length < MAX_PARAGRAPH_RUNS) para.runs.push(mkRun(e.child('t')?.text() ?? '', runProps(e), {kind: 'field', field: e.attr('type') ?? ''})); break;
      case 'm': {
        if (para.runs.length < MAX_PARAGRAPH_RUNS) {
          const text = e.findAll('t').map(t => t.text()).join('');
          const omml = e.elements().map(c => part.keepInner(c)).join('');
          para.runs.push(mkRun(text, {}, {kind: 'math', omml}));
        }
        break;
      }
      case 'endParaRPr': { const ep = rpr(imp, part, e); if (!isEmptyObj(ep)) para.endProps = ep; break; }
      default: break;
    }
  }
  return para;
}

// =================================================================================================
// custgeom.rs (reader half)

const DEG = 60000;
const toRad = a => a / DEG * Math.PI / 180;
const toAng = r => r * 180 / Math.PI * DEG;
const finite = v => (Number.isFinite(v) ? clamp(v, -1e15, 1e15) : 0);
/** DrawingML shape guide formulas (`a:gd fmla`) over the built-in variables. */
export class Guides {
  constructor(w, h) {
    w = finite(w); h = finite(h);
    const ss = Math.min(w, h), ls = Math.max(w, h);
    const v = new Map([['w', w], ['h', h], ['l', 0], ['t', 0], ['r', w], ['b', h], ['hc', w / 2], ['vc', h / 2], ['ss', ss], ['ls', ls]]);
    for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) { v.set(`wd${d}`, w / d); v.set(`hd${d}`, h / d); v.set(`ssd${d}`, ss / d); }
    for (const [k, x] of [['cd2', 10800000], ['cd4', 5400000], ['cd8', 2700000], ['3cd4', 16200000], ['3cd8', 8100000], ['5cd8', 13500000], ['7cd8', 18900000]]) v.set(k, x);
    this.vars = v;
  }
  get(name) {
    const n = String(name).trim();
    if (this.vars.has(n)) return this.vars.get(n);
    const f = parseFloatStrict(n);
    return f === null ? 0 : finite(f);
  }
  set(name, v) { if (this.vars.size < 10000) this.vars.set(name, finite(v)); }
  eval(fmla) {
    const parts = String(fmla).split(/\s+/).filter(Boolean);
    const op = parts[0] ?? '';
    const args = parts.slice(1, 4).map(a => this.get(a));
    const a = i => args[i] ?? 0;
    const div = (n, d) => (d === 0 ? 0 : n / d);
    let r;
    switch (op) {
      case '*/': r = div(a(0) * a(1), a(2)); break;
      case '+-': r = a(0) + a(1) - a(2); break;
      case '+/': r = div(a(0) + a(1), a(2)); break;
      case '?:': r = a(0) > 0 ? a(1) : a(2); break;
      case 'abs': r = Math.abs(a(0)); break;
      case 'at2': r = toAng(Math.atan2(a(1), a(0))); break;
      case 'cat2': r = a(0) * Math.cos(Math.atan2(a(2), a(1))); break;
      case 'sat2': r = a(0) * Math.sin(Math.atan2(a(2), a(1))); break;
      case 'cos': r = a(0) * Math.cos(toRad(a(1))); break;
      case 'sin': r = a(0) * Math.sin(toRad(a(1))); break;
      case 'tan': r = a(0) * Math.tan(toRad(a(1))); break;
      case 'max': r = Math.max(a(0), a(1)); break;
      case 'min': r = Math.min(a(0), a(1)); break;
      case 'mod': r = Math.sqrt(a(0) * a(0) + a(1) * a(1) + a(2) * a(2)); break;
      case 'pin': r = a(1) < a(0) ? a(0) : a(1) > a(2) ? a(2) : a(1); break;
      case 'sqrt': r = Math.sqrt(Math.max(a(0), 0)); break;
      case 'val': r = a(0); break;
      default: r = 0;
    }
    return finite(r);
  }
  evalList(list) {
    if (!list) return;
    for (const gd of list.childrenNamed('gd').slice(0, 5000)) {
      const name = gd.attr('name'), f = gd.attr('fmla');
      if (name === null || f === null) continue;
      this.set(name, this.eval(f));
    }
  }
}
function num(v) {
  const r = Math.round(finite(v) * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}
function arcTo(d, cur, wr, hr, st, sw) {
  if (Math.abs(wr) < 1e-9 || Math.abs(hr) < 1e-9 || sw === 0) return cur;
  const param = (a) => Math.atan2(wr * Math.sin(a), hr * Math.cos(a));
  const stR = toRad(st), swR = clamp(toRad(sw), -4 * Math.PI, 4 * Math.PI);
  const t0 = param(stR);
  let t1 = param(stR + swR);
  if (Math.abs(swR) >= 2 * Math.PI - 1e-9) t1 = t0 + Math.sign(swR) * 2 * Math.PI;
  else {
    while (swR > 0 && t1 < t0) t1 += 2 * Math.PI;
    while (swR < 0 && t1 > t0) t1 -= 2 * Math.PI;
  }
  const cx = cur[0] - wr * Math.cos(t0), cy = cur[1] - hr * Math.sin(t0);
  const total = t1 - t0;
  const n = clamp(Math.ceil(Math.abs(total) / (Math.PI / 2)), 1, 16);
  const step = total / n;
  const k = 4 / 3 * Math.tan(step / 4);
  let a = t0, end = cur;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    const p1 = [cx + wr * (ca - k * sa), cy + hr * (sa + k * ca)];
    const p2 = [cx + wr * (cb + k * sb), cy + hr * (sb - k * cb)];
    end = [cx + wr * cb, cy + hr * sb];
    d.s += `C ${[p1, p2, end].map(([x, y]) => `${num(x)} ${num(y)} `).join('')}`;
    a = b;
  }
  return end;
}
const FILL_MODES = ['none', 'lighten', 'lightenLess', 'darken', 'darkenLess'];
/** `a:custGeom` → custom paths (`{w, h, d, fill, stroke}` in path units). */
export function readCustGeom(cg, wEmu, hEmu) {
  const out = [];
  const pl = cg.child('pathLst');
  if (!pl) return out;
  for (const p of pl.childrenNamed('path').slice(0, 1000)) {
    const pw = p.f64('w') ?? 0, ph = p.f64('h') ?? 0;
    const [gw, gh] = pw > 0 || ph > 0 ? [pw, ph] : [wEmu, hEmu];
    const g = new Guides(gw, gh);
    g.evalList(cg.child('avLst'));
    g.evalList(cg.child('gdLst'));
    const d = {s: ''};
    let cur = [0, 0], start = [0, 0];
    const ptOf = q => [g.get(q.attr('x') ?? '0'), g.get(q.attr('y') ?? '0')];
    for (const c of p.elements().slice(0, 100000)) {
      switch (c.local) {
        case 'moveTo': { const q = c.child('pt'); if (q) { cur = ptOf(q); start = cur; d.s += `M ${num(cur[0])} ${num(cur[1])} `; } break; }
        case 'lnTo': { const q = c.child('pt'); if (q) { cur = ptOf(q); d.s += `L ${num(cur[0])} ${num(cur[1])} `; } break; }
        case 'cubicBezTo': { const ps = c.childrenNamed('pt').map(ptOf); if (ps.length === 3) { d.s += `C ${ps.map(([x, y]) => `${num(x)} ${num(y)} `).join('')}`; cur = ps[2]; } break; }
        case 'quadBezTo': { const ps = c.childrenNamed('pt').map(ptOf); if (ps.length === 2) { d.s += `Q ${ps.map(([x, y]) => `${num(x)} ${num(y)} `).join('')}`; cur = ps[1]; } break; }
        case 'arcTo': cur = arcTo(d, cur, g.get(c.attr('wR') ?? '0'), g.get(c.attr('hR') ?? '0'), g.get(c.attr('stAng') ?? '0'), g.get(c.attr('swAng') ?? '0')); break;
        case 'close': d.s += 'Z '; cur = start; break;
        default: break;
      }
    }
    const fa = p.attr('fill') ?? 'norm';
    const fill = FILL_MODES.includes(fa) ? fa : 'norm';
    const [ow, oh] = pw > 0 || ph > 0 ? [pw, ph] : [Math.max(wEmu, 1), Math.max(hEmu, 1)];
    out.push({w: ow, h: oh, d: d.s.trimEnd(), fill, stroke: p.bool('stroke') ?? true});
  }
  return out;
}

// =================================================================================================
// read/shapes.rs

export const MAX_KEPT_ID = 1 << 30;
const MAX_TREE_DEPTH = 32;
const MAX_SHAPES = 20000;

/** Shape ids for one part: the file's own ids are kept where they are unique (so anchors and animations stay stable). */
class IdCtx {
  constructor(fresh = false) { this.used = new Set(); this.map = new Map(); this.fresh = fresh; this.count = 0; }
  assign(imp, fileId) {
    if (!this.fresh && fileId !== null && fileId >= 2 && fileId < MAX_KEPT_ID && !this.used.has(fileId)) {
      this.used.add(fileId);
      this.map.set(fileId, String(fileId));
      return String(fileId);
    }
    const n = imp.alloc();
    this.used.add(n);
    if (fileId !== null && !this.map.has(fileId)) this.map.set(fileId, String(n));
    return String(n);
  }
  lookup(fileId) { return this.map.get(fileId) ?? null; }
}

function spTree(imp, part, ctx, tree, depth) {
  const out = [];
  if (depth > MAX_TREE_DEPTH) return out;
  for (const e of tree.elements()) {
    if (ctx.count >= MAX_SHAPES) break;
    let s = null;
    switch (e.local) {
      case 'sp': s = spEl(imp, part, ctx, e); break;
      case 'pic': s = pic(imp, part, ctx, e); break;
      case 'grpSp': s = grp(imp, part, ctx, e, depth); break;
      case 'cxnSp': s = cxn(imp, part, ctx, e); break;
      case 'graphicFrame': s = frame(imp, part, ctx, e, depth); break;
      case 'contentPart': s = contentPart(imp, part, ctx, e); break;
      case 'AlternateContent': s = readModelAlternate(imp, part, ctx, e); break;
      default: break;
    }
    if (s) { ctx.count++; out.push(s); }
  }
  if (depth === 0) remapConnectors(out, ctx, 0);
  return out;
}
function controls(imp, part, ctx, el) {
  const out = [];
  for (const c of el.childrenNamed('control')) {
    if (ctx.count >= MAX_SHAPES) break;
    const p = c.child('pic');
    if (p) { ctx.count++; out.push(pic(imp, part, ctx, p)); }
  }
  return out;
}
function remapConnectors(shapes, ctx, depth) {
  if (depth > MAX_TREE_DEPTH) return;
  for (const s of shapes) {
    if (s.kind.type === 'connector') {
      for (const k of ['start', 'end']) {
        const e = s.kind[k];
        if (!e) continue;
        const m = ctx.lookup(Number(e[0]));
        s.kind[k] = m === null ? null : [m, e[1]];
      }
    } else if (s.kind.type === 'group') remapConnectors(s.kind.children, ctx, depth + 1);
  }
}
function isLocked(l) {
  const set = l.local === 'grpSpLocks' ? ['noGrp', 'noUngrp', 'noRot', 'noMove', 'noResize']
    : l.local === 'graphicFrameLocks' ? ['noGrp', 'noDrilldown', 'noMove', 'noResize']
      : ['noGrp', 'noRot', 'noMove', 'noResize', 'noEditPoints', 'noAdjustHandles', 'noChangeArrowheads', 'noChangeShapeType'];
  return set.every(a => l.bool(a) === true);
}
function base(imp, part, ctx, nv) {
  const c = nv?.child('cNvPr') ?? null;
  const s = newShape({id: ctx.assign(imp, c ? c.u32('id') : null)});
  if (c) {
    s.name = c.attr('name') ?? '';
    s.descr = c.attr('descr') ?? '';
    s.title = c.attr('title') ?? '';
    s.hidden = c.bool('hidden') ?? false;
    const hc = c.child('hlinkClick'), hh = c.child('hlinkHover');
    s.click = hc ? hyperlink(imp, part, hc) : null;
    s.hover = hh ? hyperlink(imp, part, hh) : null;
    s.decorative = c.find('decorative')?.bool('val') ?? false;
  }
  if (nv) {
    for (const e of nv.elements()) {
      if (e.local === 'cNvSpPr') { s.textBox = e.bool('txBox') ?? false; s.locked = !!e.child('spLocks') && isLocked(e.child('spLocks')); }
      else if (['cNvPicPr', 'cNvGrpSpPr', 'cNvCxnSpPr', 'cNvGraphicFramePr'].includes(e.local)) { const l = e.elements().find(x => x.local.endsWith('Locks')); s.locked = !!l && isLocked(l); }
      else if (e.local === 'nvPr') {
        const ph = e.child('ph');
        if (ph) {
          const t = ph.attr('type');
          s.ph = {kind: t === null ? 'obj' : phFromXml(t), idx: ph.u32('idx') ?? 0, vertical: ph.attr('orient') === 'vert', size: ph.attr('sz'), hasCustomPrompt: ph.bool('hasCustomPrompt') ?? false};
        }
        const tg = tags(imp, part, e);
        if (tg.length) s.tags = tg;
      }
    }
  }
  return s;
}
function presetGeom(pg) {
  const name = pg.attr('prst') ?? 'rect';
  const adj = [...(presetInfo(name)?.defaults ?? [])];
  let any = false;
  const av = pg.child('avLst');
  if (av) {
    for (const gd of av.childrenNamed('gd').slice(0, 16)) {
      const idx = adjIndex(gd.attr('name') ?? '', 16);
      const v = fmlaVal(gd);
      if (idx === null || v === null) continue;
      while (adj.length <= idx) adj.push(0);
      adj[idx] = v;
      any = true;
    }
  }
  return any ? {kind: 'preset', name, adj} : {kind: 'preset', name};
}
const markInheritedGeometry = (s, pr) => {
  if (s.ph && (!pr || (!pr.child('prstGeom') && !pr.child('custGeom')))) s.geom = {kind: 'custom', paths: []};
};
function spPr(imp, part, s, pr) {
  const x = pr.child('xfrm');
  if (x) s.xfrm = xfrm(x)[0];
  const pg = pr.child('prstGeom'), cg = pr.child('custGeom');
  if (pg) s.geom = presetGeom(pg);
  else if (cg) {
    const [w, h] = s.xfrm ? [Math.round(s.xfrm.w * EMU_PER_PT), Math.round(s.xfrm.h * EMU_PER_PT)] : [21600, 21600];
    const paths = readCustGeom(cg, w, h);
    if (paths.length) s.geom = {kind: 'custom', paths};
  }
  s.fill = fillOf(imp, part, pr);
  const ln = pr.child('ln');
  if (ln) s.line = line(imp, part, ln);
  const fx = pr.child('effectLst');
  if (fx) s.effects = effects(fx);
  const raw = pr.elements().filter(c => c.is('scene3d') || c.is('sp3d')).map(c => part.keep(c)).join('');
  if (raw) {
    s.effects = s.effects ?? {};
    const b = pr.path(['sp3d', 'bevelT']);
    if (b) s.effects.bevel = b.attr('prst') ?? 'circle'; else delete s.effects.bevel;
    s.effects.raw3d = raw;
  }
}
function styleOf(st) {
  const r = n => {
    const e = st.child(n);
    return e ? [Math.min(e.u32('idx') ?? 0, 1003), color(e) ?? schemeRef('accent1')] : [0, schemeRef('accent1')];
  };
  const font = st.child('fontRef');
  return {lineRef: r('lnRef'), fillRef: r('fillRef'), effectRef: r('effectRef'), fontRef: [font?.attr('idx') ?? 'minor', font ? color(font) : null]};
}
function spEl(imp, part, ctx, e) {
  const s = base(imp, part, ctx, e.child('nvSpPr'));
  const pr = e.child('spPr');
  if (pr) spPr(imp, part, s, pr);
  markInheritedGeometry(s, pr);
  if (e.bool('useBgFill') === true) s.fill = {kind: 'background'};
  const st = e.child('style');
  s.style = st ? styleOf(st) : null;
  const tx = e.child('txBody');
  s.text = tx ? textBody(imp, part, tx) : null;
  return s;
}
const ms = v => { if (v === null || v === undefined) return 0; const f = parseFloatStrict(String(v).trim()); return f === null ? 0 : Math.trunc(clamp(f, 0, 4294967295)); };
function findContentPart(el) {
  const rec = (e, depth) => (depth > 16 ? null : e.is('contentPart') ? e : e.elements().reduce((f, c) => f ?? rec(c, depth + 1), null));
  return rec(el, 0);
}
function contentPart(imp, part, ctx, e) {
  const id = e.attr('r:id');
  if (!id) return null;
  const rel = part.rels.get(id);
  if (!rel || !isModel3d(rel)) return null;
  const media = imp.mediaFor(rel.target);
  if (media === null) return null;
  const s = base(imp, part, ctx, e.child('nvContentPartPr'));
  const x = e.child('xfrm');
  if (x) s.xfrm = xfrm(x)[0];
  s.kind = {type: 'model3d', media, poster: null};
  return s;
}
function readModelAlternate(imp, part, ctx, e) {
  for (const ch of e.childrenNamed('Choice')) {
    const content = findContentPart(ch);
    const s = content ? contentPart(imp, part, ctx, content) : null;
    if (s) {
      const fb = e.child('Fallback');
      const poster = fb ? fb.findAll('blip').map(b => mediaRef(imp, part, b)).find(m => m !== null) ?? null : null;
      s.kind = {type: 'model3d', media: s.kind.media, poster};
      return s;
    }
  }
  const p = e.child('Fallback')?.elements().find(c => c.is('pic'));
  return p ? pic(imp, part, ctx, p) : null;
}
/** deckcraft `MediaClip::default()`. */
const mediaClip = fields => ({media: '0', video: false, poster: null, crop: [0, 0, 0, 0], trimStartMs: 0, trimEndMs: 0, fadeInMs: 0, fadeOutMs: 0, volume: 0,
  autoplay: false, loopPlay: false, rewind: false, playAcrossSlides: false, hideWhileNotPlaying: false, fullScreen: false, bookmarks: [], durationMs: 0,
  width: 0, height: 0, ...fields});
function pic(imp, part, ctx, e) {
  const s = base(imp, part, ctx, e.child('nvPicPr'));
  const pr = e.child('spPr');
  if (pr) spPr(imp, part, s, pr);
  const st = e.child('style');
  s.style = st ? styleOf(st) : null;
  const bf = e.child('blipFill');
  const pf = bf ? blipFill(imp, part, bf) : null;
  const nvpr = e.path(['nvPicPr', 'nvPr']);
  const vf = nvpr?.child('videoFile') ?? null, af = nvpr?.child('audioFile') ?? null;
  const p14 = nvpr?.child('extLst')?.find('media') ?? null;
  if (vf || af || p14) {
    const media = (p14 ? mediaRef(imp, part, p14) : null) ?? ((vf ?? af) ? mediaRef(imp, part, vf ?? af) : null);
    if (media !== null) {
      const clip = mediaClip({media, video: !!vf || !af, poster: pf ? pf.media : null, crop: pf ? pf.crop : [0, 0, 0, 0], volume: 1});
      if (p14) {
        const t = p14.child('trim');
        if (t) { clip.trimStartMs = ms(t.attr('st')); clip.trimEndMs = ms(t.attr('end')); }
        const f = p14.child('fade');
        if (f) { clip.fadeInMs = ms(f.attr('in')); clip.fadeOutMs = ms(f.attr('out')); }
        const l = p14.child('bmkLst');
        if (l) clip.bookmarks = l.childrenNamed('bmk').slice(0, 1000).map(b => [b.attr('name') ?? '', ms(b.attr('time'))]);
      }
      s.kind = {type: 'media', ...clip};
      return s;
    }
  }
  if (pf) s.kind = {type: 'picture', fill: pf};
  return s;
}
function grp(imp, part, ctx, e, depth) {
  const s = base(imp, part, ctx, e.child('nvGrpSpPr'));
  let child = null;
  const pr = e.child('grpSpPr');
  if (pr) {
    const x = pr.child('xfrm');
    if (x) { const [xf, ch] = xfrm(x); s.xfrm = xf; child = ch; }
    s.fill = fillOf(imp, part, pr);
    const fx = pr.child('effectLst');
    if (fx) s.effects = effects(fx);
  }
  const children = spTree(imp, part, ctx, e, depth + 1);
  const ch = child ?? (s.xfrm ? {x: s.xfrm.x, y: s.xfrm.y, w: s.xfrm.w, h: s.xfrm.h} : {x: 0, y: 0, w: 0, h: 0});
  s.kind = {type: 'group', children, child: ch};
  return s;
}
function cxn(imp, part, ctx, e) {
  const nv = e.child('nvCxnSpPr');
  const s = base(imp, part, ctx, nv);
  const pr = e.child('spPr');
  if (pr) spPr(imp, part, s, pr);
  const st = e.child('style');
  s.style = st ? styleOf(st) : null;
  const c = nv?.child('cNvCxnSpPr');
  const end = n => { const x = c?.child(n); const id = x?.u32('id'); return x && id !== null ? [String(id), x.u32('idx') ?? 0] : null; };
  s.kind = {type: 'connector', start: end('stCxn'), end: end('endCxn')};
  return s;
}
/**
 * The parts an opaque object's XML points to, each `[rId, relType, mediaId, nested]` where `nested`
 * holds that part's own relationships the same way (a chart's workbook and style parts...).
 */
function opaqueParts(imp, el, rels, depth = 0) {
  const out = [];
  for (const id of relRefs(el)) {
    const rel = rels.get(id);
    if (!rel || rel.external) continue;
    const kept = keptPart(imp, rel, depth);
    if (kept) out.push(kept);
  }
  return out;
}
function keptPart(imp, rel, depth) {
  const media = imp.mediaFor(rel.target);
  if (media === null) return null;
  const entry = [rel.id, rel.ty, media];
  if (depth < 4) {
    const sub = imp.pkg.rels(rel.target);
    const nested = [];
    for (const r of sub.items) {
      if (r.external) { nested.push([r.id, r.ty, imp.mediaLink(r.target)]); continue; }
      const k = keptPart(imp, r, depth + 1);
      if (k) nested.push(k);
    }
    if (nested.length) entry.push(nested);
  }
  return entry;
}
function frame(imp, part, ctx, e, depth = 0) {
  const s = base(imp, part, ctx, e.child('nvGraphicFramePr'));
  const x = e.child('xfrm');
  if (x) s.xfrm = xfrm(x)[0];
  const gd = e.path(['graphic', 'graphicData']);
  const uri = gd?.attr('uri') ?? '';
  const tbl = gd?.child('tbl');
  if (tbl) { s.kind = {type: 'table', ...table(imp, part, tbl)}; return s; }
  if (uri.endsWith('/diagram')) { const g = smartArt(imp, part, ctx, s, gd, depth); if (g) return g; }
  const ole = gd?.find('oleObj') ?? null;
  const preview = e.findAll('blip').map(b => mediaRef(imp, part, b)).find(m => m !== null)
    ?? (ole && ole.attr('spid') ? vmlPreview(imp, part, ole.attr('spid')) : null) ?? null;
  const opr = ole?.find('pic')?.child('spPr');
  if (opr) {
    if (s.fill === null) s.fill = fillOf(imp, part, opr);
    if (s.line === null) { const ln = opr.child('ln'); s.line = ln ? line(imp, part, ln) : null; }
  }
  const label = ole ? ole.attr('progId') ?? ole.attr('name') ?? 'Object' : uri.endsWith('/diagram') ? 'SmartArt' : uri.includes('chart') ? 'Chart' : (uri.split('/').pop() || 'Object');
  const kept = {type: 'opaque', xml: part.keep(e), preview, label, parts: opaqueParts(imp, e, part.rels)};
  // A chart the shared chart engine draws becomes a chart shape that keeps its original part until it is edited.
  if (uri.endsWith('/chart')) {
    const rid = gd.find('chart')?.attr('r:id');
    const rel = rid ? part.rels.get(rid) : null;
    const model = rel && !rel.external ? readChartPart(imp.pkg.xml(rel.target)?.root) : null;
    if (model) { s.kind = {type: 'chart', ...model, raw: kept}; return s; }
  }
  s.kind = kept;
  return s;
}
// SmartArt (deckcraft read/shapes.rs `smartart`, `smartart_text_rects`, `text_on_rect`, `diagram_outline`): the pre-drawn shapes of the diagram's drawing part as a
// group, with the outline from its data part for the Text Pane and the layout, quick style and colour parts kept to be written back.
function smartArt(imp, part, ctx, frameShape, gd, depth) {
  if (depth > 8) return null;
  const relIds = gd.child('relIds');
  const dm = relIds ? part.rels.get(relIds.attr('r:dm') ?? '') : null;
  if (!dm || dm.external) return null;
  const data = imp.pkg.xml(dm.target);
  if (!data) return null;
  const drawingRel = part.rels.get(data.root.find('dataModelExt')?.attr('relId') ?? '');
  if (!drawingRel || drawingRel.external) return null;
  const d = load(imp.pkg, drawingRel.target);
  const tree = d?.root.child('spTree');
  if (!tree) return null;
  const dpart = new Part(imp.pkg, drawingRel.target, d);
  const sub = new IdCtx(true);
  const children = spTree(imp, dpart, sub, tree, depth + 1);
  if (!children.length) return null;
  const kids = smartArtTextRects(imp, sub, tree, children, depth + 1);
  const g = frameShape;
  const x = g.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
  g.kind = {type: 'group', children: kids, child: {x: 0, y: 0, w: x.w, h: x.h}};
  g.diagram = diagramOutline(imp, part, relIds, data.root);
  if (g.diagram) {
    // Node pictures, from the blips of the data model's presentation points.
    const rels = imp.pkg.rels(dm.target);
    for (const [k, rid] of dgm.nodePictures(data.root)) {
      const r = rels.get(rid);
      const media = r && !r.external ? imp.mediaFor(r.target) : null;
      if (media !== null && g.diagram.nodes[k]) g.diagram.nodes[k].picture = media;
    }
  }
  return g;
}
/** A SmartArt drawing shape keeps its text rectangle in `dsp:txXfrm`, apart from the shape's own box: put each shape's text on that rectangle. `shapes` are what `spTree` read from `tree`, in order. */
function smartArtTextRects(imp, ctx, tree, shapes, depth) {
  if (depth > MAX_TREE_DEPTH) return shapes;
  const out = [];
  const rest = [...shapes];
  for (const e of tree.elements().filter(el => ['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'].includes(el.local))) {
    const s = rest.shift();
    if (!s) break;
    let extra = null;
    if (e.local === 'grpSp' && s.kind.type === 'group') s.kind.children = smartArtTextRects(imp, ctx, e, s.kind.children, depth + 1);
    else if (e.local === 'sp' && s.kind.type === 'shape') {
      const t = e.child('txXfrm');
      if (t) extra = textOnRect(imp, ctx, s, xfrm(t)[0]);
    }
    out.push(s);
    if (extra) out.push(extra);
  }
  return out.concat(rest);
}
/**
 * Lay out the text of `s` on `t`, a text rectangle in the same space as the shape's box. When it is the shape's text area shrunk by some margin the shape keeps its text
 * with wider insets. Otherwise (a rectangle reaching outside the shape, or turned against it) the text moves to a new frameless text shape over `s`, which is returned.
 */
function textOnRect(imp, ctx, s, t) {
  const EPS = 0.01;
  const x = s.xfrm;
  const finite = r => r && [r.x, r.y, r.w, r.h, r.rot ?? 0].every(Number.isFinite);
  if (!finite(x) || !finite(t) || t.w <= EPS || t.h <= EPS) return null;
  const body = s.text && (s.text.paragraphs ?? []).some(p => (p.runs ?? []).some(r => r.text)) ? s.text : null;
  if (!body) return null;
  const turn = a => ((a % 360) + 360) % 360;
  const upright = a => turn((a ?? 0) + EPS) < 2 * EPS;
  const bp = body.body ?? (body.body = {});
  if (!x.flipH && !x.flipV && upright(t.rot) && upright(bp.rot) && (!bp.vert || bp.vert === 'horz') && bp.upright !== true) {
    // Same orientation as the shape: the rectangle as insets from the shape's text area.
    const rad = -((x.rot ?? 0) * Math.PI) / 180;
    const dx = t.x + t.w / 2 - (x.x + x.w / 2), dy = t.y + t.h / 2 - (x.y + x.h / 2);
    const cx = dx * Math.cos(rad) - dy * Math.sin(rad) + x.w / 2, cy = dx * Math.sin(rad) + dy * Math.cos(rad) + x.h / 2;
    const l = cx - t.w / 2, top = cy - t.h / 2, r = l + t.w, b = top + t.h;
    let area = {x0: 0, y0: 0, x1: x.w, y1: x.h};
    try { area = shapeGeometry(s, x.w, x.h).textRect ?? area; } catch { /* the whole box */ }
    const extra = [l - area.x0, top - area.y0, area.x1 - r, area.y1 - b];
    if (extra.every(v => Number.isFinite(v) && v >= -EPS)) {
      const [el, et, er, eb] = extra.map(v => Math.max(v, 0));
      bp.insetL = (bp.insetL ?? 7.2) + el; bp.insetT = (bp.insetT ?? 3.6) + et; bp.insetR = (bp.insetR ?? 7.2) + er; bp.insetB = (bp.insetB ?? 3.6) + eb;
      return null;
    }
  }
  if (ctx.count >= MAX_SHAPES) return null;
  ctx.count++;
  const text = s.text;
  s.text = null;
  // No fill, outline or effects; the style keeps only the text colour and font.
  const style = s.style ? {...s.style, fillRef: [0, s.style.fillRef?.[1]], lineRef: [0, s.style.lineRef?.[1]], effectRef: [0, s.style.effectRef?.[1]]} : null;
  const out = newShape({id: ctx.assign(imp, null), name: s.name, xfrm: {...t, rot: turn((x.rot ?? 0) + (t.rot ?? 0)), flipH: false, flipV: false}, fill: {kind: 'none'},
    line: {fill: {kind: 'none'}, width: null, dash: null, cap: null, join: null, compound: null, head: null, tail: null}, style, text, click: s.click ?? null, hover: s.hover ?? null});
  return out;
}
/** The outline of a SmartArt graphic (for the Text Pane), with its layout, quick style and colour parts kept to be written back. */
function diagramOutline(imp, part, relIds, data) {
  const nodes = dgm.outline(data);
  if (!nodes.length) return null;
  const rel = attr => { const r = part.rels.get(relIds.attr(attr) ?? ''); return r && !r.external ? r : null; };
  const raw = attr => {
    const r = rel(attr);
    const bytes = r ? imp.pkg.get(r.target) : null;
    if (!bytes || bytes.length > 4 << 20) return null;
    try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return null; }
  };
  const lo = rel('r:lo');
  const loRoot = lo ? imp.pkg.xml(lo.target)?.root : null;
  const cat = loRoot?.child('catLst')?.child('cat')?.attr('type') ?? '';
  const ids = dgm.docIds(data);
  const id = loRoot?.attr('uniqueId') || ids.lo;
  const vars = dgm.layoutVars(data);
  const out = {kind: dgm.kindFor(id, cat), nodes, style: dgm.styleFor(ids.qs), colors: dgm.colorsFor(ids.cs), imported: true, layoutId: id};
  const lx = raw('r:lo'), sx = raw('r:qs'), cxml = raw('r:cs');
  if (lx) out.layoutXml = lx;
  if (sx) out.styleXml = sx;
  if (cxml) out.colorsXml = cxml;
  if (vars.rtl) out.rtl = true;
  if (vars.hang) out.hang = vars.hang;
  return out;
}
function vmlPreview(imp, part, spid) {
  for (const rel of part.rels.items.filter(r => r.kind === 'vmlDrawing' && !r.external)) {
    const key = norm(rel.target);
    if (!imp.vmlPreviews.has(key)) imp.vmlPreviews.set(key, vmlIndex(imp.pkg, rel.target));
    const target = imp.vmlPreviews.get(key).get(spid);
    if (target) return imp.mediaFor(target);
  }
  return null;
}
function vmlIndex(pkg, vml) {
  const out = new Map();
  const doc = pkg.xml(vml);
  if (!doc) return out;
  const rels = pkg.rels(vml);
  for (const s of doc.root.findAll('shape')) {
    const id = s.attr('id');
    if (id === null || out.has(id)) continue;
    const img = s.find('imagedata');
    const rid = img ? img.attr('o:relid') ?? img.attr('r:id') : null;
    const r = rid ? rels.get(rid) : null;
    if (r && !r.external) out.set(id, r.target);
  }
  return out;
}
/** deckcraft `Cell::default()`. */
const cell0 = () => ({text: {body: {}, paragraphs: []}, fill: null, borders: [null, null, null, null], diagDown: null, diagUp: null, margins: null, anchor: null,
  gridSpan: 1, rowSpan: 1, hMerge: false, vMerge: false, vertical: null});
function table(imp, part, tbl) {
  const t = {cols: [], rows: [], style: 'grid', firstRow: false, firstCol: false, lastRow: false, lastCol: false, bandRow: false, bandCol: false};
  const pr = tbl.child('tblPr');
  if (pr) {
    const bf = pr.elements().find(e => e.local.endsWith('Fill') && e.local !== 'noFill');
    const bg = bf ? fillEl(imp, part, bf) : null;
    if (bg) t.background = bg;
    for (const k of ['firstRow', 'firstCol', 'lastRow', 'lastCol', 'bandRow', 'bandCol']) t[k] = pr.bool(k) ?? false;
    const id = pr.child('tableStyleId')?.text();
    if (id !== undefined && id !== null) {
      const up = id.trim().toUpperCase();
      t.style = imp.tableStyleIds.includes(up) && !isOwnTableGuid(up) ? up : tableStyleFromGuid(id.trim());
    }
  }
  t.cols = (tbl.child('tblGrid')?.childrenNamed('gridCol') ?? []).slice(0, 1000).map(c => clamp(pt(c, 'w') ?? 72, 0, 20000));
  for (const tr of tbl.childrenNamed('tr').slice(0, 1000)) {
    t.rows.push({height: clamp(pt(tr, 'h') ?? 0, 0, 20000), cells: tr.childrenNamed('tc').slice(0, 1000).map(tc => cellOf(imp, part, tc))});
  }
  if (!t.cols.length) t.cols = Array(t.rows.reduce((m, r) => Math.max(m, r.cells.length), 0)).fill(72);
  return normalizeTable(t);
}
function cellOf(imp, part, tc) {
  const c = cell0();
  c.gridSpan = clamp(tc.u32('gridSpan') ?? 1, 1, 1000);
  c.rowSpan = clamp(tc.u32('rowSpan') ?? 1, 1, 1000);
  c.hMerge = tc.bool('hMerge') ?? false;
  c.vMerge = tc.bool('vMerge') ?? false;
  const tx = tc.child('txBody');
  if (tx) c.text = textBody(imp, part, tx);
  const pr = tc.child('tcPr');
  if (pr) {
    if (['marL', 'marR', 'marT', 'marB'].some(n => pr.hasAttr(n))) c.margins = [pt(pr, 'marL') ?? 7.2, pt(pr, 'marR') ?? 7.2, pt(pr, 'marT') ?? 3.6, pt(pr, 'marB') ?? 3.6];
    c.anchor = pr.attr('anchor') === null ? null : anchorFromXml(pr.attr('anchor'));
    c.vertical = pr.attr('vert') === null ? null : textDirFromXml(pr.attr('vert'));
    ['lnL', 'lnR', 'lnT', 'lnB'].forEach((n, i) => { const ln = pr.child(n); if (ln) c.borders[i] = line(imp, part, ln); });
    const dd = pr.child('lnTlToBr'), du = pr.child('lnBlToTr');
    c.diagDown = dd ? line(imp, part, dd) : null;
    c.diagUp = du ? line(imp, part, du) : null;
    c.fill = fillOf(imp, part, pr);
  }
  return c;
}

// =================================================================================================
// read/theme.rs

function fontSet(e) {
  const tf = n => e?.child(n)?.attr('typeface') ?? '';
  const out = {latin: tf('latin'), ea: tf('ea'), cs: tf('cs')};
  const scripts = (e?.childrenNamed('font') ?? []).filter(f => f.attr('script') !== null).slice(0, 256).map(f => ({script: f.attr('script'), typeface: f.attr('typeface') ?? ''}));
  if (scripts.length) out.scripts = scripts;
  return out;
}
function readTheme(imp, part, root) {
  const t = structuredClone(defaultTheme());
  t.name = root.attr('name') ?? 'Theme';
  const te = root.child('themeElements');
  if (!te) return t;
  const cs = te.child('clrScheme');
  if (cs) {
    let scheme = {name: cs.attr('name') ?? '', colors: [...t.colors.colors]};
    for (const slot of THEME_SLOTS) {
      const c = cs.child(slot) ? color(cs.child(slot)) : null;
      if (!c) continue;
      const b = c.base;
      const rgbv = b.kind === 'rgb' ? b.rgb : b.kind === 'system' ? b.last : b.kind === 'preset' ? presetColor(b.name) ?? BLACK : null;
      if (rgbv) scheme = schemeSet(scheme, slot, rgbv);
    }
    t.colors = scheme;
  }
  const fs = te.child('fontScheme');
  if (fs) t.fonts = {name: fs.attr('name') ?? '', major: fontSet(fs.child('majorFont')), minor: fontSet(fs.child('minorFont'))};
  const fm = te.child('fmtScheme');
  if (fm) {
    const dflt = defaultFormat();
    const f = {name: fm.attr('name') ?? '', fills: [], lines: [], effects: [], bgFills: []};
    const l1 = fm.child('fillStyleLst');
    if (l1) f.fills = l1.elements().slice(0, 16).map(e => fillEl(imp, part, e)).filter(Boolean);
    const l2 = fm.child('lnStyleLst');
    if (l2) f.lines = l2.childrenNamed('ln').slice(0, 16).map(e => line(imp, part, e));
    const l3 = fm.child('effectStyleLst');
    if (l3) {
      f.effects = l3.childrenNamed('effectStyle').slice(0, 16).map(e => {
        const el = e.child('effectLst');
        const fx = el ? effects(el) : {};
        const b = e.path(['sp3d', 'bevelT']);
        if (b) fx.bevel = b.attr('prst') ?? 'circle';
        const raw = e.elements().filter(c => c.is('scene3d') || c.is('sp3d')).map(c => part.keep(c)).join('');
        if (raw) fx.raw3d = raw;
        return fx;
      });
    }
    const l4 = fm.child('bgFillStyleLst');
    if (l4) f.bgFills = l4.elements().slice(0, 16).map(e => fillEl(imp, part, e)).filter(Boolean);
    const pad = (v, d) => { while (v.length < 3 && d[v.length]) v.push(structuredClone(d[v.length])); };
    pad(f.fills, dflt.fills); pad(f.lines, dflt.lines); pad(f.bgFills, dflt.bgFills);
    while (f.effects.length < 3) f.effects.push({});
    t.format = f;
  }
  const extra = root.elements().filter(e => e.is('objectDefaults') || e.is('extraClrSchemeLst')).filter(e => !hasRelRefs(e)).map(e => part.keep(e)).join('');
  if (extra) t.rawExtra = extra;
  return t;
}

// =================================================================================================
// read/timing.rs

function msAttr(e, name) {
  const raw = e.attr(name);
  if (raw === null) return null;
  const v = raw.trim();
  if (v === 'indefinite') return null;
  const f = parseFloatStrict(v);
  return f === null ? null : Math.trunc(clamp(f, 0, 86400000));
}
function transition(imp, part, t) {
  const effect = t.elements().find(e => e.local !== 'sndAc' && e.local !== 'extLst') ?? null;
  const tr = {...defaultTransition(), advanceOnClick: t.bool('advClick') ?? true, advanceAfterMs: msAttr(t, 'advTm')};
  const ko = effect ? transitionFromXml(effect) : null;
  if (ko) { tr.kind = ko[0]; tr.option = ko[1]; }
  else if (effect) { tr.kind = effect.local; tr.raw = part.keep(t); }
  else tr.kind = 'none';
  const defaultDur = TRANSITIONS.find(x => x[0] === tr.kind)?.[3] ?? 1000;
  const spd = t.attr('spd');
  tr.durationMs = msAttr(t, 'dur') ?? (spd === 'med' ? 750 : spd === 'slow' ? Math.max(defaultDur, 1000) : 500);
  const snd = t.path(['sndAc', 'stSnd', 'snd']);
  if (snd) {
    tr.sound = mediaRef(imp, part, snd);
    const l = t.path(['sndAc', 'stSnd'])?.attr('loop');
    if (l === '1' || l === 'true') tr.soundLoop = true;
  }
  if (t.path(['sndAc', 'endSnd'])) tr.stopSound = true;
  if (tr.kind === 'none' && tr.advanceOnClick && tr.advanceAfterMs === null && tr.sound === null && !tr.stopSound) return null;
  return tr;
}
function collect(e, trigger, out, depth) {
  if (depth > 64 || out.length > 10000) return;
  for (const c of e.elements()) {
    if (c.is('cTn') && c.hasAttr('presetClass')) { out.push({ctn: c, trigger}); continue; }
    let trig = trigger;
    if (c.is('seq')) {
      const ctn = c.child('cTn');
      if (ctn && ctn.attr('nodeType') === 'interactiveSeq') trig = ctn.path(['stCondLst', 'cond', 'tgtEl', 'spTgt'])?.u32('spid') ?? null;
    }
    collect(c, trig, out, depth + 1);
  }
}
function maxDur(e, depth) {
  if (depth > 64) return null;
  let best = null;
  for (const c of e.elements()) {
    if (c.is('cTn')) { const d = msAttr(c, 'dur'); if (d !== null && d > 1) best = best === null ? d : Math.max(best, d); }
    const d = maxDur(c, depth + 1);
    if (d !== null) best = best === null ? d : Math.max(best, d);
  }
  return best;
}
const findShapeDeep = (shapes, id) => { let f = null; walk(shapes, s => { if (!f && s.id === id) f = s; }); return f; };
function animations(imp, part, ctx, timing, shapes) {
  const tn = timing.child('tnLst');
  if (!tn) return [];
  const found = [];
  collect(tn, null, found, 0);
  const byPara = (timing.child('bldLst')?.childrenNamed('bldP') ?? []).filter(p => p.attr('build') === 'p' && p.u32('spid') !== null).map(p => [p.u32('spid'), p.attr('grpId') ?? '0']);
  const out = [];
  for (const f of found) {
    const c = f.ctn;
    const cls = animClassFromXml(c.attr('presetClass') ?? 'entr');
    const preset = c.u32('presetID') ?? 0;
    const sub = c.u32('presetSubtype') ?? 0;
    const tgt = c.find('spTgt');
    if (!tgt) continue;
    const fileId = tgt.u32('spid');
    if (fileId === null) continue;
    const shapeId = ctx.lookup(fileId);
    if (shapeId === null) continue;
    const paragraphIdx = tgt.path(['txEl', 'pRg'])?.u32('st') ?? null;
    let effect = effectForPreset(cls, preset) ?? fallbackEffect(cls);
    let option;
    if (cls === 'entrance' && preset === 47) { effect = 'float'; option = 'd'; }
    else if (cls === 'exit' && preset === 47) { effect = 'floatOut'; option = 'd'; }
    else option = optionFromSubtype(effect, sub);
    const nt = c.attr('nodeType');
    const a = {...defaultAnimation(), shape: shapeId, class: cls, effect, option, start: nt === 'clickEffect' ? 'onClick' : nt === 'afterEffect' ? 'afterPrevious' : 'withPrevious',
      durationMs: maxDur(c, 0) ?? 0, delayMs: (() => { const d = c.path(['stCondLst', 'cond']); return d ? msAttr(d, 'delay') ?? 0 : 0; })(), paragraph: paragraphIdx,
      trigger: f.trigger === null ? null : ctx.lookup(f.trigger), presetId: preset, presetSubtype: sub, autoReverse: c.bool('autoRev') ?? false,
      rewind: c.attr('fill') === 'remove', smoothStart: (c.f64('accel') ?? 0) / 100000, smoothEnd: (c.f64('decel') ?? 0) / 100000,
      bounceEnd: c.f64('bounceEnd') === null ? 0 : clamp(c.f64('bounceEnd') / 100000, 0, 1)};
    const rc = c.attr('repeatCount');
    if (rc === 'indefinite') a.repeat = 4294967295;
    else if (rc !== null) { const v = parseFloatStrict(rc); a.repeat = v === null ? 1 : Math.round(clamp(v / 1000, 1, 10000)); }
    const motion = c.find('animMotion');
    if (motion) a.path = motion.attr('path');
    const rot = c.find('animRot');
    if (rot) {
      const by = rot.f64('by');
      a.amount = by === null ? null : by / 60000;
      if (a.effect === 'spin' && a.amount !== null && a.amount < 0) a.option = 'counterClockwise';
    } else {
      const by = c.find('animScale')?.child('by');
      if (by) { const x = by.f64('x'); a.amount = x === null ? null : x / 100000; }
    }
    const to = c.find('animClr')?.child('to');
    if (to) a.color = color(to);
    const grp = c.attr('grpId') ?? '0';
    const build = paragraphIdx !== null && byPara.some(([s, g]) => s === fileId && g === grp);
    out.push({a, fileId, grp, build});
  }
  const sameBuild = (x, y) => x.build && y.build && x.fileId === y.fileId && x.grp === y.grp && x.a.trigger === y.a.trigger;
  const anims = [];
  let i = 0;
  while (i < out.length) {
    let j = i + 1;
    while (j < out.length && sameBuild(out[j - 1], out[j])) j++;
    const run = out.slice(i, j);
    i = j;
    const effs = run.map(r => r.a);
    const build = run[0].build;
    const text = findShapeDeep(shapes, effs[0].shape)?.text ?? null;
    if (build && text && playsAsBuild(effs, text)) anims.push({...effs[0], textBuild: 'byParagraph', paragraph: null});
    else anims.push(...effs);
  }
  return anims;
}
function playsAsBuild(effs, text) {
  const roles = paragraphBuildRoles(text);
  const expected = roles.map((r, i) => [i, r]).filter(([i, r]) => r.top || (r.member !== undefined && buildFilled(text.paragraphs[i])));
  const first = effs[0];
  if (!first) return false;
  const settings = a => JSON.stringify({...a, start: 'onClick', paragraph: null});
  const baseS = settings(first);
  let matched = 0;
  for (let k = 0; k < expected.length; k++) {
    const [i, role] = expected[k];
    const a = effs[k];
    if (!a) return false;
    const startOk = role.top ? (k === 0 ? true : first.start === 'onClick' ? a.start === 'onClick' : a.start === 'afterPrevious') : a.start === 'withPrevious';
    if (a.paragraph !== i || !startOk || settings(a) !== baseS) return false;
    matched = k + 1;
  }
  return matched === effs.length;
}

// =================================================================================================
// read.rs: masters, layouts, slides, notes, comments, presentation settings

function background(imp, part, csld) {
  const bg = csld.child('bg');
  if (!bg) return null;
  const pr = bg.child('bgPr');
  if (pr) return {kind: 'fill', fill: fillOf(imp, part, pr) ?? {kind: 'none'}};
  const r = bg.child('bgRef');
  if (!r) return null;
  return {kind: 'ref', idx: r.u32('idx') ?? 1001, color: color(r) ?? schemeRef('bg1')};
}
const sameLen = (v, d) => (Number.isFinite(v) && v >= 1 && v <= 20000 ? v : d);
const colorMapOverride = root => { const o = root.child('clrMapOvr')?.child('overrideClrMapping'); return o ? colorMap(o) : null; };
function keepExt(part, root) {
  const ext = root.child('extLst');
  if (!ext || hasRelRefs(ext)) return null;
  const s = ext.elements().map(e => part.keep(e)).join('');
  return s || null;
}

function readMaster(imp, path, doc, docs, layoutByPart) {
  const pkg = imp.pkg;
  const part = new Part(pkg, path, doc);
  const root = doc.root;
  const m = {id: '0', name: '', theme: structuredClone(defaultTheme()), shapes: [], background: null, titleStyle: {levels: []}, bodyStyle: {levels: []},
    otherStyle: {levels: []}, layouts: [], colorMap: [], preserve: root.bool('preserve') ?? false};
  const t = part.rels.firstOf('theme');
  const td = t ? pkg.xml(t.target) : null;
  if (td) m.theme = readTheme(imp, new Part(pkg, t.target, td), td.root);
  m.id = String(imp.alloc());
  const cm = root.child('clrMap');
  if (cm) m.colorMap = colorMap(cm);
  const csld = root.child('cSld');
  if (csld) {
    m.name = csld.attr('name') ?? '';
    m.background = background(imp, part, csld);
    const tree = csld.child('spTree');
    if (tree) m.shapes = spTree(imp, part, new IdCtx(), tree, 0);
  }
  if (!m.name) m.name = m.theme.name;
  const ts = root.child('txStyles');
  if (ts) {
    for (const [tag, key] of [['titleStyle', 'titleStyle'], ['bodyStyle', 'bodyStyle'], ['otherStyle', 'otherStyle']]) { const s = ts.child(tag); if (s) m[key] = listStyle(imp, part, s); }
  }
  const lpaths = (root.child('sldLayoutIdLst')?.childrenNamed('sldLayoutId') ?? []).map(x => part.rels.target(x.attr('r:id') ?? '')).filter(Boolean);
  for (const r of part.rels.allOf('slideLayout')) if (!lpaths.some(x => norm(x) === norm(r.target))) lpaths.push(r.target);
  for (const lp of lpaths.slice(0, 1000)) {
    const key = norm(lp);
    if (layoutByPart.has(key)) continue;
    const ld = docs.get(key);
    if (!ld) continue;
    const l = readLayout(imp, new Part(pkg, lp, ld), ld);
    layoutByPart.set(key, l.id);
    m.layouts.push(l);
  }
  if (!m.layouts.length) {
    imp.next += 1;
    m.layouts.push({id: String(imp.next), name: 'Blank', kind: 'blank', shapes: [], background: null, showMasterShapes: true, preserve: false});
  }
  const ext = keepExt(part, root);
  if (ext) m.rawExt = ext;
  return m;
}
function readLayout(imp, part, doc) {
  const root = doc.root;
  const l = {id: String(imp.alloc()), name: '', kind: layoutFromXml(root.attr('type') ?? 'cust'), shapes: [], background: null,
    showMasterShapes: root.bool('showMasterSp') ?? true, preserve: root.bool('preserve') ?? false};
  const csld = root.child('cSld');
  if (csld) {
    l.name = csld.attr('name') ?? '';
    l.background = background(imp, part, csld);
    const tree = csld.child('spTree');
    if (tree) l.shapes = spTree(imp, part, new IdCtx(), tree, 0);
  }
  const cm = colorMapOverride(root);
  if (cm) l.colorMap = cm;
  const ext = keepExt(part, root);
  if (ext) l.rawExt = ext;
  return l;
}
function readSlide(imp, part, doc, id, layout) {
  const root = doc.root;
  const s = newSlide({id, layout, hidden: root.bool('show') === false, showMasterShapes: root.bool('showMasterSp') ?? true});
  const cm = colorMapOverride(root);
  if (cm) s.colorMap = cm;
  const ctx = new IdCtx();
  const csld = root.child('cSld');
  if (csld) {
    s.name = csld.attr('name') ?? '';
    const tg = tags(imp, part, csld);
    if (tg.length) s.tags = tg;
    s.background = background(imp, part, csld);
    const tree = csld.child('spTree');
    if (tree) s.shapes = spTree(imp, part, ctx, tree, 0);
    const c = csld.child('controls');
    if (c) s.shapes.push(...controls(imp, part, ctx, c));
  }
  const t = root.child('transition');
  if (t) s.transition = transition(imp, part, t);
  const tm = root.child('timing');
  if (tm) s.animations = animations(imp, part, ctx, tm, s.shapes);
  const ext = keepExt(part, root);
  if (ext) s.rawExt = ext;
  return s;
}
function readNotes(imp, part, root) {
  const tree = root.path(['cSld', 'spTree']);
  if (!tree) return {body: {}, paragraphs: []};
  for (const sp of tree.childrenNamed('sp')) {
    const ph = sp.path(['nvSpPr', 'nvPr', 'ph']);
    const isBody = !!ph && (ph.attr('type') === 'body' || ph.attr('type') === null);
    const tx = sp.child('txBody');
    if (isBody && tx) {
      const t = textBody(imp, part, tx);
      delete t.listStyle;
      if ((t.paragraphs ?? []).every(p => !(p.runs ?? []).some(r => (r.kind?.kind === 'break') || (r.text ?? '') !== ''))) return {body: {}, paragraphs: []};
      return t;
    }
  }
  return {body: {}, paragraphs: []};
}
function readComments(pkg, pres, root, modern) {
  const authors = new Map();
  for (const kind of ['commentAuthors', 'authors']) {
    const r = pres.rels.firstOf(kind);
    const d = r ? pkg.xml(r.target) : null;
    if (!d) continue;
    for (const a of d.root.elements()) { const id = a.attr('id'); if (id !== null) authors.set(id, [a.attr('name') ?? '', a.attr('initials') ?? '']); }
  }
  const scale = modern ? 12700 : 8;
  const one = (e, depth) => {
    const [author, initials] = authors.get(e.attr('authorId') ?? '') ?? ['', ''];
    const t = e.child('text'), tb = e.child('txBody');
    const text = t ? t.text() : tb ? tb.childrenNamed('p').map(p => p.text()).join('\n') : '';
    const pos = e.child('pos');
    const replies = depth < 4 ? (e.child('replyLst')?.childrenNamed('reply') ?? []).slice(0, 1000).map(r => one(r, depth + 1)) : [];
    return {author, initials, text, date: e.attr('dt') ?? e.attr('created') ?? '', x: (pos?.f64('x') ?? 0) / scale, y: (pos?.f64('y') ?? 0) / scale,
      resolved: e.attr('status') === 'resolved', replies, shape: null};
  };
  return root.childrenNamed('cm').slice(0, 10000).map(c => one(c, 0));
}
function readShow(sp, shows) {
  const s = {...defaultShowSettings(), loopUntilEsc: sp.bool('loop') ?? false, withoutNarration: sp.bool('showNarration') === false,
    withoutAnimation: sp.bool('showAnimation') === false, useTimings: sp.bool('useTimings') ?? true};
  if (sp.child('browse')) s.showType = 'browsed';
  else if (sp.child('kiosk')) s.showType = 'kiosk';
  const r = sp.child('sldRg');
  if (r) s.range = [Math.max(r.u32('st') ?? 1, 1), Math.max(r.u32('end') ?? 1, 1)];
  const c = sp.child('custShow');
  if (c) { const id = c.attr('id') ?? ''; s.customShow = shows.get(id) ?? id; }
  const pc = sp.child('penClr');
  const pcol = pc ? color(pc) : null;
  if (pcol?.base?.kind === 'rgb') s.penColor = pcol.base.rgb;
  for (const ext of sp.child('extLst')?.childrenNamed('ext') ?? []) {
    const lc = ext.child('laserClr');
    const lcol = lc ? color(lc) : null;
    if (lcol?.base?.kind === 'rgb') s.laserColor = lcol.base.rgb;
  }
  return s;
}
function readCore(root, p) {
  for (const e of root.elements()) {
    const t = e.text();
    switch (e.local) {
      case 'title': p.title = t; break;
      case 'subject': p.subject = t; break;
      case 'creator': p.author = t; break;
      case 'keywords': p.keywords = t; break;
      case 'description': p.comments = t; break;
      case 'category': p.category = t; break;
      case 'lastModifiedBy': p.lastModifiedBy = t; break;
      case 'revision': { const n = Number.parseInt(t.trim(), 10); p.revision = Number.isFinite(n) && n >= 0 ? n : 0; break; }
      case 'created': p.created = t; break;
      case 'modified': p.modified = t; break;
      default: break;
    }
  }
}
function headerFooter(p) {
  const hf = defaultHeaderFooter();
  for (const s of p.slides) {
    for (const sh of s.shapes) {
      const k = sh.ph?.kind;
      if (k === 'slideNum') hf.slideNumber = true;
      else if (k === 'date') {
        hf.date = true;
        if (sh.text && !sh.text.paragraphs.some(pp => (pp.runs ?? []).some(r => r.kind?.kind === 'field')) && !hf.dateText) hf.dateText = bodyText(sh.text);
      } else if (k === 'footer') {
        hf.footer = true;
        if (!hf.footerText && sh.text) hf.footerText = bodyText(sh.text);
      }
    }
  }
  return hf;
}
function readEmbeddedFonts(imp, pres, root) {
  const list = root.child('embeddedFontLst');
  if (!list) return [];
  const out = [];
  for (const e of list.childrenNamed('embeddedFont').slice(0, 64)) {
    const font = e.child('font');
    const tf = font?.attr('typeface')?.trim();
    if (!tf) continue;
    const slot = name => {
      const id = e.child(name)?.attr('r:id');
      const target = id ? pres.rels.target(id) : null;
      const data = target ? imp.pkg.get(target) : null;
      if (!data || !data.length || data.length > 32 * 1024 * 1024) return null;
      return imp.mediaFor(target);
    };
    const f = {typeface: [...tf].slice(0, 255).join(''), regular: slot('regular'), bold: slot('bold'), italic: slot('italic'), boldItalic: slot('boldItalic')};
    if (f.regular === null && f.bold === null && f.italic === null && f.boldItalic === null) continue;
    const pan = font.attr('panose')?.trim();
    if (pan && /^[0-9a-fA-F]{20}$/.test(pan)) f.panose = pan;
    for (const k of ['pitchFamily', 'charset']) { const v = font.u32(k); if (v !== null && v <= 255) f[k] = v; }
    out.push(f);
  }
  return out;
}
function tableStyleDefs(imp, part, root) {
  const out = [];
  for (const st of root.childrenNamed('tblStyle').slice(0, 256)) {
    const id = st.attr('styleId');
    if (id === null) continue;
    const def = {id: id.toUpperCase(), name: st.attr('styleName') ?? '', parts: [], background: null, raw: part.keep(st)};
    const fillRef = fr => [fr.u32('idx') ?? 0, color(fr) ?? schemeRef('accent1')];
    const bg = st.child('tblBg');
    if (bg) {
      const ps = partStyle0();
      const f = bg.elements().find(e => e.local.endsWith('Fill'));
      if (f) ps.fill = fillEl(imp, part, f);
      const fr = bg.child('fillRef');
      if (fr) ps.fillRef = fillRef(fr);
      def.background = ps;
    }
    for (const el of st.elements()) {
      if (!TABLE_PARTS.includes(el.local)) continue;
      const ps = partStyle0();
      const tx = el.child('tcTxStyle');
      if (tx) { ps.textColor = color(tx); ps.bold = tx.attr('b') === null ? null : tx.attr('b') === 'on'; ps.italic = tx.attr('i') === null ? null : tx.attr('i') === 'on'; }
      const tc = el.child('tcStyle');
      if (tc) {
        const f = tc.child('fill')?.elements()[0];
        if (f) ps.fill = fillEl(imp, part, f);
        const fr = tc.child('fillRef');
        if (fr) ps.fillRef = fillRef(fr);
        const bd = tc.child('tcBdr');
        if (bd) {
          ['left', 'right', 'top', 'bottom', 'insideH', 'insideV'].forEach((side, i) => {
            const b = bd.child(side);
            if (!b) return;
            const ln = b.child('ln'), lr = b.child('lnRef');
            ps.borders[i] = ln ? {kind: 'line', line: line(imp, part, ln)} : lr ? {kind: 'ref', idx: lr.u32('idx') ?? 0, color: color(lr) ?? schemeRef('accent1')} : null;
          });
        }
      }
      def.parts.push([el.local, ps]);
    }
    out.push(def);
  }
  return out;
}
const TABLE_PARTS = ['wholeTbl', 'band1H', 'band2H', 'band1V', 'band2V', 'lastCol', 'firstCol', 'lastRow', 'firstRow', 'seCell', 'swCell', 'neCell', 'nwCell'];
const partStyle0 = () => ({fill: null, fillRef: null, borders: [null, null, null, null, null, null], textColor: null, bold: null, italic: null});

const walkMut = (shapes, f) => { for (const s of shapes ?? []) { f(s); if (s.kind?.type === 'group') walkMut(s.kind.children, f); } };
/** Shapes whose text is in a free shape keep their anchor only when it isn't middle (the model's default for shapes). */
function defaultTextAnchor(p) {
  const fix = shapes => walkMut(shapes, s => {
    if (!s.ph && !s.textBox && s.kind.type !== 'table' && s.text) {
      const got = s.text.body?.anchor ?? 'top';
      if (got === 'middle') delete s.text.body.anchor; else s.text.body.anchor = got;
    }
  });
  for (const m of p.masters) { fix(m.shapes); for (const l of m.layouts) fix(l.shapes); }
  for (const s of p.slides) fix(s.shapes);
}
/** Placeholders without their own geometry take their layout's (or master's) shape. */
function inheritPlaceholderGeometry(p) {
  const unset = g => g?.kind === 'custom' && !(g.paths ?? []).length;
  const rect = () => ({kind: 'preset', name: 'rect'});
  for (const m of p.masters) walkMut(m.shapes, s => { if (unset(s.geom)) s.geom = rect(); });
  const layoutGeoms = [];
  for (const m of p.masters) {
    for (const l of m.layouts) {
      const ctx = ctxForLayout(p, m, l);
      l.shapes.forEach((s, i) => {
        if (!unset(s.geom)) return;
        const [, mp] = parents(ctx, s);
        layoutGeoms.push([l, i, mp && !unset(mp.geom) ? structuredClone(mp.geom) : rect()]);
      });
    }
  }
  for (const [l, i, g] of layoutGeoms) l.shapes[i].geom = g;
  const slideGeoms = [];
  p.slides.forEach(sl => {
    const ctx = ctxForSlide(p, sl);
    if (!ctx) return;
    sl.shapes.forEach((s, i) => {
      if (!unset(s.geom)) return;
      const [lp, mp] = parents(ctx, s);
      const g = lp && !unset(lp.geom) ? lp.geom : mp && !unset(mp.geom) ? mp.geom : null;
      slideGeoms.push([sl, i, g ? structuredClone(g) : rect()]);
    });
  });
  for (const [sl, i, g] of slideGeoms) sl.shapes[i].geom = g;
  for (const sl of p.slides) walkMut(sl.shapes, s => { if (unset(s.geom)) s.geom = rect(); });
  for (const m of p.masters) for (const l of m.layouts) walkMut(l.shapes, s => { if (unset(s.geom)) s.geom = rect(); });
}

function readAuxMaster(imp, part, doc, m) {
  const csld = doc.root.child('cSld');
  if (csld) {
    m.background = background(imp, part, csld);
    const tree = csld.child('spTree');
    if (tree) m.shapes = spTree(imp, part, new IdCtx(), tree, 0);
  }
  const cm = doc.root.child('clrMap');
  if (cm) m.colorMap = colorMap(cm);
}
function readMasterTheme(imp, part, m) {
  const t = part.rels.firstOf('theme');
  const td = t ? imp.pkg.xml(t.target) : null;
  if (!td) return false;
  m.theme = readTheme(imp, new Part(imp.pkg, t.target, td), td.root);
  return true;
}
const auxMaster = (id, name) => ({id, name, theme: structuredClone(defaultTheme()), shapes: [], background: null, titleStyle: {levels: []}, bodyStyle: {levels: []},
  otherStyle: {levels: []}, layouts: [], colorMap: [], preserve: false});

/**
 * Read a .pptx / .potx / .ppsx package. Returns `{pres, lost}`: the presentation and the part names of
 * slides the file lists that couldn't be read (left out), as deckcraft `import_checked`.
 */
export async function importChecked(bytes) {
  const lost = [];
  const pkg = await Package.open(bytes);
  const rootRels = pkg.rels('');
  const presPath = rootRels.firstOf('officeDocument')?.target ?? 'ppt/presentation.xml';
  const presDoc = load(pkg, presPath);
  if (!presDoc) throw notPptx(`missing or unreadable ${presPath}`);
  const presEl = presDoc.root;
  if (!presEl.is('presentation')) throw notPptx(`${presPath} is not a presentation part`);
  const presPart = new Part(pkg, presPath, presDoc);
  // Masters and slides the presentation lists.
  let masterPaths = (presEl.child('sldMasterIdLst')?.childrenNamed('sldMasterId') ?? []).map(m => presPart.rels.target(m.attr('r:id') ?? '')).filter(Boolean);
  if (!masterPaths.length) masterPaths = presPart.rels.allOf('slideMaster').map(r => r.target);
  let slideEntries = (presEl.child('sldIdLst')?.childrenNamed('sldId') ?? []).slice(0, 10000)
    .map(s => [s.u32('id') ?? 0, presPart.rels.target(s.attr('r:id') ?? '')]).filter(([, p]) => p);
  const seenM = new Set();
  masterPaths = masterPaths.filter(m => { const k = norm(m); if (seenM.has(k)) return false; seenM.add(k); return true; });
  const seenS = new Set();
  slideEntries = slideEntries.filter(([, p]) => { const k = norm(p); if (seenS.has(k)) return false; seenS.add(k); return true; });
  // Load every master, layout and slide part once.
  const allParts = [...masterPaths];
  const seenL = new Set();
  for (const m of masterPaths) for (const r of pkg.rels(m).allOf('slideLayout')) { const k = norm(r.target); if (!seenL.has(k)) { seenL.add(k); allParts.push(r.target); } }
  allParts.push(...slideEntries.map(([, p]) => p));
  const docs = new Map();
  const maxId = {v: 0};
  for (const p of allParts) {
    const key = norm(p);
    if (docs.has(key)) continue;
    const d = load(pkg, p);
    if (d) { maxCnvPr(d.root, maxId); docs.set(key, d); }
  }
  const imp = new Imp(pkg);
  imp.next = Math.max(maxId.v, 1);
  // Slide ids first (so links between slides resolve while shapes are read).
  const slideIds = [];
  for (const [fileId, path] of slideEntries) {
    if (!docs.has(norm(path))) { lost.push(path); continue; }
    const id = String(imp.alloc());
    imp.slideByPart.set(norm(path), id);
    slideIds.push([fileId, path, id]);
  }
  for (const cs of presEl.child('custShowLst')?.childrenNamed('custShow') ?? []) {
    const id = cs.attr('id'), name = cs.attr('name');
    if (id !== null && name !== null) imp.customShowNames.set(id, name);
  }
  const p = blankPresentation(WIDE, defaultTheme(), false);
  p.masters = [];
  p.media = [];
  p.defaultTextStyle = {levels: []};
  // Presentation settings.
  const sz = presEl.child('sldSz');
  if (sz) { const w = sz.i64('cx'), h = sz.i64('cy'); p.slideSize = {width: sameLen(w === null ? 960 : emuToPt(w), 960), height: sameLen(h === null ? 540 : emuToPt(h), 540)}; }
  const nz = presEl.child('notesSz');
  if (nz) { const w = nz.i64('cx'), h = nz.i64('cy'); p.notesSize = {width: sameLen(w === null ? 540 : emuToPt(w), 540), height: sameLen(h === null ? 720 : emuToPt(h), 720)}; }
  p.firstSlideNumber = Math.min(presEl.u32('firstSlideNum') ?? 1, 9999);
  const dts = presEl.child('defaultTextStyle');
  if (dts) p.defaultTextStyle = listStyle(imp, presPart, dts);
  const tsRel = presPart.rels.firstOf('tableStyles');
  const tsDoc = tsRel ? load(pkg, tsRel.target) : null;
  if (tsDoc) {
    const defs = tableStyleDefs(imp, new Part(pkg, tsRel.target, tsDoc), tsDoc.root);
    if (defs.length) p.tableStyles = defs;
    imp.tableStyleIds = defs.map(s => s.id);
  }
  // Masters (with their themes and layouts).
  const layoutByPart = new Map();
  for (const mp of masterPaths) {
    const doc = docs.get(norm(mp));
    if (!doc) continue;
    p.masters.push(readMaster(imp, mp, doc, docs, layoutByPart));
  }
  if (!p.masters.length) {
    const [m] = buildMaster(p.slideSize, defaultTheme(), imp.next);
    imp.next += 200;
    p.masters.push(m);
  }
  // Slides, with notes and comments.
  const fallbackLayout = p.masters[0]?.layouts?.[0]?.id ?? '0';
  const fileSlideIds = new Map();
  const notesByTarget = new Map();
  for (const [fileId, path, id] of slideIds) {
    const doc = docs.get(norm(path));
    if (!doc) continue;
    const part = new Part(pkg, path, doc);
    const lr = part.rels.firstOf('slideLayout');
    const layout = (lr && layoutByPart.get(norm(lr.target))) ?? fallbackLayout;
    const slide = readSlide(imp, part, doc, id, layout);
    const n = part.rels.firstOf('notesSlide');
    if (n) {
      const key = norm(n.target);
      if (notesByTarget.has(key)) slide.notes = structuredClone(notesByTarget.get(key));
      else {
        const nd = load(pkg, n.target);
        if (nd) { const notes = readNotes(imp, new Part(pkg, n.target, nd), nd.root); notesByTarget.set(key, notes); slide.notes = structuredClone(notes); }
      }
    }
    const cparts = [];
    for (const c of part.rels.allOf('comments')) {
      const cd = pkg.xml(c.target);
      if (cd) cparts.push([cd, pkg.contentType(c.target) === CT_COMMENTS_MODERN || cd.root.prefix === 'p188']);
    }
    const hasModern = cparts.some(([, m]) => m);
    for (const [cd, modern] of cparts) { if (hasModern && !modern) continue; slide.comments.push(...readComments(pkg, presPart, cd.root, modern)); }
    fileSlideIds.set(fileId, id);
    p.slides.push(slide);
  }
  // Sections and unmodelled presentation extensions.
  const ext = presEl.child('extLst');
  if (ext) {
    const sl = ext.find('sectionLst');
    if (sl) {
      for (const s of sl.childrenNamed('section').slice(0, 10000)) {
        const slides = (s.child('sldIdLst')?.childrenNamed('sldId') ?? []).map(x => fileSlideIds.get(x.u32('id'))).filter(v => v !== undefined);
        p.sections.push({name: s.attr('name') ?? '', slides});
      }
    }
    const kept = ext.childrenNamed('ext').filter(e => e.attr('uri') !== SECTION_EXT_URI && !hasRelRefs(e)).map(e => presPart.keep(e)).join('');
    if (kept) p.rawExt = kept;
  }
  const ptags = tags(imp, presPart, presEl);
  if (ptags.length) p.tags = ptags;
  for (const cs of presEl.child('custShowLst')?.childrenNamed('custShow') ?? []) {
    const slides = (cs.child('sldLst')?.childrenNamed('sld') ?? []).map(s => presPart.rels.target(s.attr('r:id') ?? '')).filter(Boolean)
      .map(t => imp.slideByPart.get(norm(t))).filter(v => v !== undefined);
    p.customShows.push({name: cs.attr('name') ?? '', slides});
  }
  // Guides (view properties) and show settings (presentation properties).
  const vp = presPart.rels.firstOf('viewProps');
  const vd = vp ? pkg.xml(vp.target) : null;
  const gl = vd?.root.find('slideViewPr')?.find('guideLst');
  if (gl) {
    const guides = gl.childrenNamed('guide').map(g => ({vertical: g.attr('orient') !== 'horz', pos: (parseFloatStrict(g.attr('pos') ?? '0') ?? 0) / 8})).filter(g => Number.isFinite(g.pos)).slice(0, 1000);
    if (guides.length) p.guides = guides;
  }
  const pp = presPart.rels.firstOf('presProps');
  const pd = pp ? pkg.xml(pp.target) : null;
  const showPr = pd?.root.child('showPr');
  if (showPr) p.show = readShow(showPr, imp.customShowNames);
  // Notes and handout masters.
  const nmRel = presPart.rels.firstOf('notesMaster');
  const nmDoc = nmRel ? load(pkg, nmRel.target) : null;
  if (nmDoc) {
    const part = new Part(pkg, nmRel.target, nmDoc);
    const m = auxMaster(String(imp.alloc()), 'Notes Master');
    readMasterTheme(imp, part, m);
    readAuxMaster(imp, part, nmDoc, m);
    const ns = nmDoc.root.child('notesStyle');
    if (ns) m.bodyStyle = listStyle(imp, part, ns);
    p.notesMaster = m;
  }
  const hmRel = presPart.rels.firstOf('handoutMaster');
  const hmDoc = hmRel ? load(pkg, hmRel.target) : null;
  if (hmDoc) {
    const part = new Part(pkg, hmRel.target, hmDoc);
    const m = auxMaster(String(imp.alloc()), 'Handout Master');
    if (!readMasterTheme(imp, part, m) && p.masters[0]) m.theme = structuredClone(p.masters[0].theme);
    const n = hmDoc.root.child('cSld')?.attr('name');
    if (n) m.name = n;
    readAuxMaster(imp, part, hmDoc, m);
    p.handoutMaster = m;
  }
  // Document properties.
  p.props = defaultProperties();
  const core = rootRels.firstOf('core-properties');
  const cd = core ? pkg.xml(core.target) : null;
  if (cd) readCore(cd.root, p.props);
  const app = rootRels.firstOf('extended-properties');
  const ad = app ? pkg.xml(app.target) : null;
  if (ad) p.props.company = ad.root.child('Company')?.text() ?? '';
  const kept = keptParts(pkg, presPath);
  if (kept.length) p.keptParts = kept;
  inheritPlaceholderGeometry(p);
  defaultTextAnchor(p);
  p.headerFooter = headerFooter(p);
  p.embeddedFonts = readEmbeddedFonts(imp, presPart, presEl);
  p.media = imp.media;
  p.nextId = imp.next;
  p.nextId = fixNextId(p);
  return {pres: p, lost};
}

/** deckcraft `import`: the presentation alone. */
export async function importPptx(bytes) { return (await importChecked(bytes)).pres; }

/** Read the theme of a .thmx, or of a .pptx / .potx's first master, with its media: `{theme, media}`. */
export async function importTheme(bytes) {
  const pkg = await Package.open(bytes);
  const target = pkg.rels('').firstOf('officeDocument')?.target ?? null;
  let themePath;
  if (target && pkg.xml(target)?.root.is('theme')) themePath = target;
  else {
    const pres = target ?? 'ppt/presentation.xml';
    const presDoc = load(pkg, pres);
    if (!presDoc) throw notPptx('neither a theme nor a presentation');
    const presPart = new Part(pkg, pres, presDoc);
    const first = presDoc.root.child('sldMasterIdLst')?.childrenNamed('sldMasterId')[0];
    const master = (first ? presPart.rels.target(first.attr('r:id') ?? '') : null) ?? presPart.rels.allOf('slideMaster')[0]?.target ?? null;
    if (!master) throw notPptx('the presentation has no slide master');
    themePath = pkg.rels(master).firstOf('theme')?.target ?? null;
    if (!themePath) throw notPptx('the slide master has no theme');
  }
  const doc = load(pkg, themePath);
  if (!doc) throw notPptx(`missing or unreadable ${themePath}`);
  if (!doc.root.is('theme')) throw notPptx(`${themePath} is not a theme part`);
  const imp = new Imp(pkg);
  const theme = readTheme(imp, new Part(pkg, themePath, doc), doc.root);
  return {theme, media: imp.media};
}

/**
 * Format-worker entry (electron/formats-v2.cjs): the bytes of a .pptx → schema-2 content.
 * As deckcraft crates/engine/src/cmd/file.rs `open_other`: a package is imported; a
 * password-protected one (a compound file holding the encryption streams) is named as such instead
 * of failing as an unknown file. The document properties are the file's own (PowerPoint never fills
 * in the title from the file name).
 */
export async function read(bytes, {title, name} = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (!(await sniff(b)) && isEncrypted(b)) {
    const shown = name ? String(name) : `${title || 'Presentation'}.pptx`;
    throw new PptxError('Unsupported', `${shown} is password-protected. Prism can't open password-protected presentations yet.`);
  }
  const {pres} = await importChecked(b);
  return pres;
}

/** Shared with the writer and the PDF exporter (same unit). */
export const internals = {Package, Part, Imp, parseXml, keepXml, relRefs, isRelAttr, colorMap};

// ---- Password-protected packages: deckcraft crates/pptx/src/cfb.rs (is_encrypted, contains_utf16,
// directory_names). Just enough of the Compound File Binary (CFB/OLE2) container to tell a
// password-protected presentation apart: PowerPoint wraps an encrypted .pptx in a CFB holding
// EncryptionInfo and EncryptedPackage streams ([MS-OFFCRYPTO]) instead of a zip. Every read is
// bounds-checked and every loop bounded.
/** The CFB signature at the start of the file. */
export const SIGNATURE = Object.freeze([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
export const END_OF_CHAIN = 0xFFFFFFFE;
/** Sector ids at or above this are markers (free, end of chain, FAT/DIFAT sector), not sectors. */
const MAX_REG_SECT = 0xFFFFFFFA;
/** Directory sectors followed at most (4096 entries with 512-byte sectors). */
const MAX_DIR_SECTORS = 1024;
/** DIFAT sectors followed at most. */
const MAX_DIFAT_SECTORS = 1024;
/** Stream names that mark an encrypted (password-protected) OOXML package. */
const ENCRYPTED_STREAMS = ['EncryptedPackage', 'EncryptionInfo'];

const u16At = (b, at) => (at >= 0 && at + 2 <= b.length ? b[at] | (b[at + 1] << 8) : null);
const u32At = (b, at) => (at >= 0 && at + 4 <= b.length ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0 : null);
const startsWithSignature = b => b.length >= 8 && SIGNATURE.every((v, i) => b[i] === v);
const bytesOf = bytes => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []));

/**
 * Whether `bytes` is a compound file holding an encryption stream. Walks the directory through the
 * FAT; when the structure can't be followed (truncated or malformed), falls back to scanning the
 * bytes for the UTF-16LE stream names.
 */
export function isEncrypted(bytes) {
  const b = bytesOf(bytes);
  if (!startsWithSignature(b)) return false;
  const names = directoryNames(b);
  if (names) return names.some(n => ENCRYPTED_STREAMS.some(e => n.toLowerCase() === e.toLowerCase()));
  return ENCRYPTED_STREAMS.some(e => containsUtf16(b, e));
}

function containsUtf16(hay, needle) {
  const n = [];
  for (let i = 0; i < needle.length; i++) { const u = needle.charCodeAt(i); n.push(u & 255, u >> 8); }
  if (!n.length) return false;
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let k = 0; k < n.length; k++) if (hay[i + k] !== n[k]) continue outer;
    return true;
  }
  return false;
}

/** Names of every directory entry, or null when the directory can't be read. */
export function directoryNames(bytes) {
  const b = bytesOf(bytes);
  if (!startsWithSignature(b)) return null;
  const shift = u16At(b, 30);
  if (shift !== 9 && shift !== 12) return null;
  const size = 1 << shift;
  const per = size / 4;
  const sector = id => {
    const start = (id + 1) * size;
    return Number.isSafeInteger(start) && start + size <= b.length ? b.subarray(start, start + size) : null;
  };
  // The DIFAT: the FAT's sector ids, 109 in the header then chained DIFAT sectors.
  const difat = [];
  for (let i = 0; i < 109; i++) { const s = u32At(b, 76 + i * 4); if (s !== null && s < MAX_REG_SECT) difat.push(s); }
  let next = u32At(b, 68);
  if (next === null) return null;
  for (let n = 0; n < MAX_DIFAT_SECTORS; n++) {
    if (next >= MAX_REG_SECT) break;
    const s = sector(next);
    if (!s) return null;
    for (let i = 0; i < per - 1; i++) { const x = u32At(s, i * 4); if (x !== null && x < MAX_REG_SECT) difat.push(x); }
    next = u32At(s, (per - 1) * 4);
    if (next === null) return null;
  }
  const fatNext = id => {
    const fatSector = difat[Math.floor(id / per)];
    if (fatSector === undefined) return null;
    const s = sector(fatSector);
    return s ? u32At(s, (id % per) * 4) : null;
  };
  const names = [];
  let id = u32At(b, 48);
  if (id === null) return null;
  for (let n = 0; n < MAX_DIR_SECTORS; n++) {
    if (id === END_OF_CHAIN) return names;
    if (id >= MAX_REG_SECT) return null;
    const s = sector(id);
    if (!s) return null;
    for (let e = 0; e + 128 <= s.length; e += 128) {
      const len = u16At(s, e + 64);
      if (len === null) return null;
      if (len < 2 || len > 64) continue;
      // String::from_utf16_lossy: lone surrogates become U+FFFD.
      names.push(new TextDecoder('utf-16le').decode(s.subarray(e, e + Math.floor((len - 2) / 2) * 2)));
    }
    id = fatNext(id);
    if (id === null) return null;
  }
  // A directory longer than the bound (or a cyclic chain): report what was read.
  return names;
}
