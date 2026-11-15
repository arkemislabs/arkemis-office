// Standards: PDF/A verify and convert (ISO 19005-2 and -3, levels b), the declared standards (PDF/A, PDF/UA, output intents), removing a declared id, and the PDF/UA and
// PDF/X checks that read the same objects.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/preflight
//   lib.rs   `verify` (what it checks, clause by clause), `convert` (what it fixes without changing how pages look), `declared`, device colour use of content
//   xmp.rs   the identification read from the XMP packet, the packet `convert` writes, PDF dates as XMP dates
//   icc.rs   the small sRGB profile the output intent carries
// Not translated: PDF/A-1 and the "u" and "a" levels (upstream has -2b and -3b), colour conversion, font embedding, transparency flattening. A document that passes
// verify has passed the checks `PDFA_CHECKED` lists and nothing else: the checks in `PDFA_NOT_VERIFIED` are not made, so a pass is never a statement of conformance.
// The PDF/UA and PDF/X checks (`pdfuaCheck`, `pdfxCheck`) are not checked against upstream (it has neither): they follow ISO 14289-1 and ISO 15930-7 for the points
// that can be read from the objects, and say which points they do not check. No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString, PDFNumber, PDFBool, PDFRawStream, PDFNull, decodePDFRawStream} from 'pdf-lib';
import {parseContent} from './redact-content.mjs';
import {pageStreams} from './text-interp.mjs';

const N = s => PDFName.of(s);
const key = r => `${r.objectNumber} ${r.generationNumber}`;
const look = (doc, v) => doc.context.lookup(v);
const dictOf = (doc, v) => { const o = v instanceof PDFRef ? look(doc, v) : v; return o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null; };
const nameText = v => (v instanceof PDFName ? v.decodeText() : undefined);
const strText = v => { if (v instanceof PDFString || v instanceof PDFHexString) { try { return v.decodeText(); } catch { return ''; } } return null; };
const intOf = v => (v instanceof PDFNumber && Number.isInteger(v.asNumber()) ? v.asNumber() : undefined);
const arrayOf = (doc, v) => { const o = look(doc, v); return o instanceof PDFArray ? o.asArray() : null; };
const isTrue = v => v instanceof PDFBool && v.asBoolean();

export const PDFA_ID = 'http://www.aiim.org/pdfa/ns/id/';
export const PDFUA_ID = 'http://www.aiim.org/pdfua/ns/id/';
const MAX_XMP_BYTES = 8 * 1024 * 1024;

export const LEVELS = {A2b: {part: 2, label: 'PDF/A-2b'}, A3b: {part: 3, label: 'PDF/A-3b'}};
/** Upstream `Level::from_id`. */
export function levelOf(id) {
  const k = String(id ?? '').toLowerCase().replace(/[/\- ]/g, '');
  return {pdfa2b: 'A2b', a2b: 'A2b', '2b': 'A2b', pdfa3b: 'A3b', a3b: 'A3b', '3b': 'A3b'}[k] ?? null;
}

// ── XMP ─────────────────────────────────────────────────────────────────────────────────────

const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** xmp.rs `value`: an attribute or the first element's text (the first rdf:li of a list). */
export function xmpValue(xmp, k) {
  for (const q of ['"', "'"]) {
    const attr = `${k}=${q}`;
    const i = xmp.indexOf(attr);
    if (i >= 0) { const rest = xmp.slice(i + attr.length); const e = rest.indexOf(q); return e >= 0 ? unescapeXml(rest.slice(0, e)) : null; }
  }
  const open = `<${k}>`, close = `</${k}>`;
  const o = xmp.indexOf(open);
  if (o < 0) return null;
  const start = o + open.length;
  const end = xmp.indexOf(close, start);
  if (end < 0) return null;
  const inner = xmp.slice(start, end);
  const li = inner.indexOf('<rdf:li');
  if (li >= 0) {
    const s = inner.indexOf('>', li) + 1;
    const e = inner.indexOf('</rdf:li>', s);
    return e < 0 ? null : unescapeXml(inner.slice(s, e).trim());
  }
  return unescapeXml(inner.trim());
}

/** xmp.rs `identifier`: an identification property by its namespace, whatever prefix the packet gives it (no DTD, bounded size). */
export function xmpIdentifier(xmp, namespace, local) {
  if (xmp.length > MAX_XMP_BYTES || /<!DOCTYPE/i.test(xmp)) return null;
  const prefixes = [...xmp.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']*)["']/g)].filter(m => m[2] === namespace).map(m => m[1]);
  if (!prefixes.length) prefixes.push(namespace === PDFA_ID ? 'pdfaid' : 'pdfuaid');
  for (const p of prefixes) {
    const v = xmpValue(xmp, `${p}:${local}`);
    if (v !== null) return v.trim();
  }
  return null;
}

/** xmp.rs `iso_date`: a PDF date as an XMP date. */
export function isoDate(pdf) {
  const d = String(pdf).trim().replace(/^D:/, '');
  const digits = (/^\d*/.exec(d) ?? [''])[0];
  if (digits.length < 4) return null;
  const part = (a, b, def) => digits.slice(a, b) || def;
  const [y, mo, da, h, mi, s] = [part(0, 4, '0000'), part(4, 6, '01'), part(6, 8, '01'), part(8, 10, '00'), part(10, 12, '00'), part(12, 14, '00')];
  const rest = d.slice(digits.length);
  let tz = 'Z';
  if (rest[0] === '+' || rest[0] === '-') { const t = rest.slice(1).replace(/\D/g, ''); tz = `${rest[0]}${t.slice(0, 2) || '00'}:${t.slice(2, 4) || '00'}`; }
  return `${y}-${mo}-${da}T${h}:${mi}:${s}${tz}`;
}

const info = (doc, k) => { const i = dictOf(doc, doc.context.trailerInfo.Info); const s = i ? strText(look(doc, i.get(N(k)))) : null; return s || null; };

/** xmp.rs `packet`: the identification and the document information, kept consistent. */
export function xmpPacket(doc, level) {
  let props = '';
  const t = info(doc, 'Title'); if (t) props += `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escXml(t)}</rdf:li></rdf:Alt></dc:title>\n`;
  const a = info(doc, 'Author'); if (a) props += `   <dc:creator><rdf:Seq><rdf:li>${escXml(a)}</rdf:li></rdf:Seq></dc:creator>\n`;
  const s = info(doc, 'Subject'); if (s) props += `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escXml(s)}</rdf:li></rdf:Alt></dc:description>\n`;
  const k = info(doc, 'Keywords'); if (k) props += `   <pdf:Keywords>${escXml(k)}</pdf:Keywords>\n`;
  const p = info(doc, 'Producer'); if (p) props += `   <pdf:Producer>${escXml(p)}</pdf:Producer>\n`;
  const c = info(doc, 'Creator'); if (c) props += `   <xmp:CreatorTool>${escXml(c)}</xmp:CreatorTool>\n`;
  const cd = info(doc, 'CreationDate'); const cdi = cd && isoDate(cd); if (cdi) props += `   <xmp:CreateDate>${cdi}</xmp:CreateDate>\n`;
  const md = info(doc, 'ModDate'); const mdi = md && isoDate(md); if (mdi) props += `   <xmp:ModifyDate>${mdi}</xmp:ModifyDate>\n`;
  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n`
    + `  <rdf:Description rdf:about=""\n    xmlns:dc="http://purl.org/dc/elements/1.1/"\n    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"\n    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n`
    + `    xmlns:pdfaid="${PDFA_ID}">\n   <pdfaid:part>${LEVELS[level].part}</pdfaid:part>\n   <pdfaid:conformance>B</pdfaid:conformance>\n${props}  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
}

// ── the sRGB profile (icc.rs) ───────────────────────────────────────────────────────────────

const s15f16 = v => { const n = Math.round(v * 65536); return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = s => Array.from(s, c => c.charCodeAt(0));
const xyz = (x, y, z) => [...ascii('XYZ '), 0, 0, 0, 0, ...s15f16(x), ...s15f16(y), ...s15f16(z)];
const descTag = text => { const a = [...ascii(text), 0]; return [...ascii('desc'), 0, 0, 0, 0, ...u32(a.length), ...a, ...new Array(8).fill(0), ...new Array(70).fill(0)]; };
const textTag = text => [...ascii('text'), 0, 0, 0, 0, ...ascii(text), 0];
function curve() {
  const out = [...ascii('curv'), 0, 0, 0, 0, ...u32(1024)];
  for (let i = 0; i < 1024; i++) {
    const v = i / 1023;
    const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const n = Math.round(lin * 65535);
    out.push((n >> 8) & 255, n & 255);
  }
  return out;
}
/** icc.rs `srgb`: a small matrix/TRC sRGB profile. */
export function srgbProfile() {
  const tags = [['desc', descTag('sRGB (Arkemis)')], ['cprt', textTag('No copyright, use freely')], ['wtpt', xyz(0.9642, 1.0, 0.8249)], ['rXYZ', xyz(0.4361, 0.2225, 0.0139)],
    ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7141)], ['rTRC', curve()]];
  const count = tags.length + 2;
  let offset = 128 + 4 + count * 12;
  const table = [...u32(count)];
  const data = [];
  let trc = [0, 0];
  for (const [sig, body] of tags) {
    table.push(...ascii(sig), ...u32(offset), ...u32(body.length));
    if (sig === 'rTRC') trc = [offset, body.length];
    data.push(...body);
    const pad = (4 - (body.length % 4)) % 4;
    data.push(...new Array(pad).fill(0));
    offset += body.length + pad;
  }
  for (const sig of ['gTRC', 'bTRC']) table.push(...ascii(sig), ...u32(trc[0]), ...u32(trc[1]));
  const size = 128 + table.length + data.length;
  const h = [...u32(size), 0, 0, 0, 0, 2, 0x10, 0, 0, ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '), ...new Array(12).fill(0), ...ascii('acsp'), 0, 0, 0, 0,
    ...new Array(4 + 4 + 4 + 8).fill(0), 0, 0, 0, 0, ...s15f16(0.9642), ...s15f16(1.0), ...s15f16(0.8249), 0, 0, 0, 0];
  while (h.length < 128) h.push(0);
  return Uint8Array.from([...h, ...table, ...data]);
}

// ── what a document declares ────────────────────────────────────────────────────────────────

const catalogOf = doc => doc.catalog;
const decoded = (s, limit) => { try { const b = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : null; return b && b.length <= limit ? b : null; } catch { return null; } };

/** The XMP metadata stream of the catalog, as text. */
export function metadataText(doc) {
  const m = look(doc, catalogOf(doc).get(N('Metadata')));
  if (!(m instanceof PDFStream)) return null;
  const b = decoded(m, MAX_XMP_BYTES);
  return b ? new TextDecoder('utf-8').decode(b) : null;
}

/** lib.rs `declared`: the standards the XMP says, and the output intents' condition identifiers. */
export function declared(doc) {
  const d = {pdfa: null, pdfua: null, outputIntents: []};
  const x = metadataText(doc);
  if (x) {
    const part = Number.parseInt(xmpIdentifier(x, PDFA_ID, 'part') ?? '', 10);
    const conf = xmpIdentifier(x, PDFA_ID, 'conformance') ?? '';
    if (Number.isInteger(part)) d.pdfa = {part, conformance: conf.toUpperCase()};
    const ua = Number.parseInt(xmpIdentifier(x, PDFUA_ID, 'part') ?? '', 10);
    if (Number.isInteger(ua)) d.pdfua = ua;
  }
  for (const oi of arrayOf(doc, catalogOf(doc).get(N('OutputIntents'))) ?? []) {
    const od = dictOf(doc, oi);
    if (od) d.outputIntents.push(strText(look(doc, od.get(N('OutputConditionIdentifier')))) ?? '');
  }
  return d;
}

/** The standards as the Standards panel names them: "PDF/A-2b", "PDF/UA-1". */
export function declaredNames(d) {
  return [...(d.pdfa ? [`PDF/A-${d.pdfa.part}${d.pdfa.conformance.toLowerCase()}`] : []), ...(d.pdfua ? [`PDF/UA-${d.pdfua}`] : [])];
}

/** Edit::RemoveStandardId: the identification leaves the XMP (the rest of the packet stays). */
export function removeStandardId(doc, standard = 'pdfa') {
  const ns = standard === 'pdfua' ? PDFUA_ID : PDFA_ID;
  const m = look(doc, catalogOf(doc).get(N('Metadata')));
  const x = metadataText(doc);
  if (!x || !(m instanceof PDFStream)) return false;
  const prefixes = [...x.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']*)["']/g)].filter(r => r[2] === ns).map(r => r[1]);
  if (!prefixes.length) return false;
  let out = x;
  for (const p of prefixes) {
    out = out.replace(new RegExp(`\\s*<${p}:[A-Za-z]+>[^<]*</${p}:[A-Za-z]+>`, 'g'), '').replace(new RegExp(`\\s+${p}:[A-Za-z]+\\s*=\\s*("[^"]*"|'[^']*')`, 'g'), '').replace(new RegExp(`\\s+xmlns:${p}\\s*=\\s*("[^"]*"|'[^']*')`, 'g'), '');
  }
  if (out === x) return false;
  const dict = {Type: 'Metadata', Subtype: 'XML'};
  catalogOf(doc).set(N('Metadata'), doc.context.register(doc.context.stream(new TextEncoder().encode(out), dict)));
  return true;
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_ACTIONS = new Set(['JavaScript', 'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView']);
const FORBIDDEN_ANNOTS = new Set(['Sound', 'Movie', 'Screen', '3D', 'RichMedia']);
const MAX_ACTION_CHAIN = 1024;

function isAction(d) {
  const t = nameText(d.get(N('Type')));
  return t !== undefined ? t === 'Action' : !(d.has(N('P')) && d.has(N('K')));
}

/** The first forbidden action type in the action or in the actions written in its /Next (chain_forbidden). */
function chainForbidden(doc, a) {
  let read = 0;
  const seen = new Set();
  const held = [];
  const walk = start => {
    const stack = [start];
    while (stack.length) {
      const d = stack.pop();
      if (++read > MAX_ACTION_CHAIN) return 'too deeply chained';
      const s = nameText(d.get(N('S')));
      if (s && FORBIDDEN_ACTIONS.has(s)) return s;
      const next = d.get(N('Next'));
      if (next instanceof PDFDict) stack.push(next);
      else if (next instanceof PDFArray) { for (const x of next.asArray()) if (x instanceof PDFDict) stack.push(x); }
      else if (next instanceof PDFRef && !seen.has(key(next))) {
        seen.add(key(next));
        const l = look(doc, next);
        if (l instanceof PDFArray) held.push(...l.asArray().filter(x => x instanceof PDFDict).slice(0, MAX_ACTION_CHAIN));
      }
    }
    return null;
  };
  let r = walk(a);
  if (r) return r;
  while (held.length) { r = walk(held.pop()); if (r) return r; }
  return null;
}

const forbiddenValue = (doc, o) => { const v = o instanceof PDFRef ? look(doc, o) : o; return v instanceof PDFDict ? chainForbidden(doc, v) !== null : v === undefined || v === PDFNull; };

// ── device colour ───────────────────────────────────────────────────────────────────────────

const isContentDict = d => { const t = nameText(d.get(N('Subtype'))); return t !== undefined ? t === 'Form' : d.has(N('BBox')) && !d.has(N('ShadingType')); };
const MAX_CONTENT_STREAM = 32 * 1024 * 1024;

/** lib.rs `uses_device_colour`: which device spaces content and objects use, and whether DefaultRGB/DefaultCMYK are defined. */
export function deviceColour(doc) {
  const used = {gray: false, rgb: false, cmyk: false, defaultRgb: false, defaultCmyk: false};
  const referenced = new Set();
  for (const page of doc.getPages()) {
    const c = page.node.get(N('Contents'));
    const list = c instanceof PDFRef ? (look(doc, c) instanceof PDFArray ? look(doc, c).asArray() : [c]) : c instanceof PDFArray ? c.asArray() : [];
    for (const x of list) if (x instanceof PDFRef) referenced.add(key(x));
  }
  const type3 = (d, depth) => {
    if (depth > 8) return;
    if (nameText(d.get(N('Subtype'))) === 'Type3') { const procs = dictOf(doc, d.get(N('CharProcs'))); if (procs) for (const [, p] of procs.entries()) if (p instanceof PDFRef) referenced.add(key(p)); }
    for (const [, v] of d.entries()) { if (v instanceof PDFDict) type3(v, depth + 1); else if (v instanceof PDFArray) for (const x of v.asArray()) if (x instanceof PDFDict) type3(x, depth + 1); }
  };
  const objects = [...doc.context.enumerateIndirectObjects()];
  for (const [, o] of objects) { const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null; if (d) type3(d, 0); }
  const mark = (name, inline) => {
    if (name === 'DeviceGray' || (inline && name === 'G')) used.gray = true;
    else if (name === 'DeviceRGB' || (inline && name === 'RGB')) used.rgb = true;
    else if (name === 'DeviceCMYK' || (inline && name === 'CMYK')) used.cmyk = true;
  };
  for (const [ref, o] of objects) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    const res = dictOf(doc, d.get(N('Resources')));
    for (const holder of [d, res]) {
      const spaces = holder ? dictOf(doc, holder.get(N('ColorSpace'))) : null;
      if (spaces) { if (spaces.has(N('DefaultRGB'))) used.defaultRgb = true; if (spaces.has(N('DefaultCMYK'))) used.defaultCmyk = true; }
    }
    const cs = look(doc, d.get(N('ColorSpace')));
    if (cs instanceof PDFName) mark(cs.decodeText(), false);
    if (!(used.gray && used.rgb && used.cmyk) && o instanceof PDFStream && (referenced.has(key(ref)) || isContentDict(o.dict))) {
      const data = decoded(o, MAX_CONTENT_STREAM);
      if (!data) continue;
      for (const op of parseContent(data)) {
        if (used.gray && used.rgb && used.cmyk) break;
        if (op.op === 'g' || op.op === 'G') used.gray = true;
        else if (op.op === 'rg' || op.op === 'RG') used.rgb = true;
        else if (op.op === 'k' || op.op === 'K') used.cmyk = true;
        else if ((op.op === 'cs' || op.op === 'CS') && op.args[0]?.k === 'name') mark(op.args[0].v, false);
        else if (op.op === 'BI') {
          const e = (op.dict ?? []).find(([k]) => k === 'CS' || k === 'ColorSpace');
          const v = e?.[1];
          if (v?.k === 'name') mark(v.v, true);
          else if (v?.k === 'arr' && v.a[0]?.k === 'name' && (v.a[0].v === 'I' || v.a[0].v === 'Indexed') && v.a[1]?.k === 'name') mark(v.a[1].v, true);
        }
      }
    }
  }
  return {...used, any: used.gray || used.rgb || used.cmyk};
}

/** lib.rs `pdfa_intent_profile`: `undefined` with no PDF/A output intent; else the profile's colour components (null when it does not say). */
function pdfaIntentProfile(doc) {
  for (const oi of arrayOf(doc, catalogOf(doc).get(N('OutputIntents'))) ?? []) {
    const d = dictOf(doc, oi);
    if (!d || nameText(look(doc, d.get(N('S')))) !== 'GTS_PDFA1') continue;
    const prof = look(doc, d.get(N('DestOutputProfile')));
    if (!(prof instanceof PDFStream)) return null;
    const n = intOf(look(doc, prof.dict.get(N('N'))));
    if (n !== undefined) return n;
    const b = decoded(prof, 16 << 20);
    const sig = b ? String.fromCharCode(...b.slice(16, 20)) : '';
    return sig === 'GRAY' ? 1 : sig === 'RGB ' ? 3 : sig === 'CMYK' ? 4 : null;
  }
  return undefined;
}

// ── verify ──────────────────────────────────────────────────────────────────────────────────

/** What `verify` checks, and what it does not: the Standards dialog lists both so a pass is not read as conformance. */
export const PDFA_CHECKED = [
  'XMP metadata is present and identifies the file (pdfaid part and conformance B), and its title matches the document information',
  'The document is not encrypted',
  'An output intent with an ICC profile is present when device colour is used, and its profile suits DeviceRGB and DeviceCMYK',
  'No additional actions on the document, pages, fields or annotations; no JavaScript, Launch, Sound, Movie, ResetForm, ImportData, Hide, SetOCGState, Rendition, Trans or GoTo3DView actions',
  'NeedAppearances is not set',
  'Annotations: no multimedia, printable and not hidden, with an appearance stream',
  'Every font is embedded (Type 3 fonts excepted)',
  'No LZW compression and no external streams',
  'Images do not ask to be interpolated and have no alternates or OPI; no PostScript XObjects',
  'Embedded files: none in PDF/A-2b; an AFRelationship for each in PDF/A-3b',
];
export const PDFA_NOT_VERIFIED = [
  'Whether the embedded ICC profiles are valid and the colour data matches them',
  'Whether embedded fonts hold every glyph the text uses, and their encodings and widths',
  'The XMP packet against the PDF/A extension schemas (custom properties) and its consistency with every information key',
  'Transparency, blend modes and optional content rules',
  'Page content: operator and syntax rules, resource names, and the size limits of ISO 19005',
  'The structure of the file itself (cross-reference table, object numbers, stream lengths, the file header and trailer)',
  'Embedded files in PDF/A-2b that are themselves PDF/A (they are all reported)',
];

/**
 * lib.rs `verify`: the problems of `doc` against `level` (A2b or A3b).
 * @returns {{clause: string, message: string, page: number|null, fixable: boolean}[]}
 */
export function verify(doc, level, {encrypted = false} = {}) {
  const out = [];
  const L = LEVELS[level];
  const issue = (clause, message, page = null, fixable = true) => out.push({clause, message, page, fixable});
  const cat = catalogOf(doc);
  const x = metadataText(doc);
  if (x === null) issue('6.6.2.1', 'The document has no XMP metadata');
  else {
    const part = xmpIdentifier(x, PDFA_ID, 'part'), conf = xmpIdentifier(x, PDFA_ID, 'conformance');
    if (part !== String(L.part) || (conf ?? '').toUpperCase() !== 'B') issue('6.6.4', `The metadata doesn't identify the file as ${L.label}`);
    const title = info(doc, 'Title');
    const xt = xmpValue(x, 'dc:title');
    if (title && xt !== null && xt !== title) issue('6.6.3', 'The title in the metadata and the document information differ');
  }
  if (doc.context.trailerInfo.Encrypt || encrypted) issue('6.1.3', 'The document is encrypted');
  const used = deviceColour(doc);
  const intent = pdfaIntentProfile(doc);
  if (intent === undefined) {
    if (used.any) {
      issue('6.2.3', 'Device colour is used, but there is no PDF/A output intent', null, !used.cmyk);
      if (used.cmyk) issue('6.2.4.3', 'DeviceCMYK is used: it needs a CMYK output intent (not added automatically)', null, false);
    }
  } else {
    if (used.cmyk && !used.defaultCmyk && intent !== 4) issue('6.2.4.3', "DeviceCMYK is used, but the PDF/A output intent isn't a CMYK profile", null, false);
    if (used.rgb && !used.defaultRgb && intent !== 3) issue('6.2.4.3', "DeviceRGB is used, but the PDF/A output intent isn't an RGB profile", null, false);
  }
  if (cat.has(N('AA'))) issue('6.5.2', 'The document has additional actions (/AA)');
  const names = dictOf(doc, cat.get(N('Names')));
  if (names && names.has(N('JavaScript'))) issue('6.5.1', 'The document has document-level JavaScript');
  const af = dictOf(doc, cat.get(N('AcroForm')));
  if (af && isTrue(af.get(N('NeedAppearances')))) issue('6.4.1', 'The form asks viewers to make appearances (NeedAppearances)');
  const pages = doc.getPages();
  const annotPage = new Map();
  pages.forEach((p, i) => { for (const r of arrayOf(doc, p.node.get(N('Annots'))) ?? []) if (r instanceof PDFRef && !annotPage.has(key(r))) annotPage.set(key(r), i); });
  pages.forEach((p, i) => { if (p.node.has(N('AA'))) issue('6.5.2', `Page ${i + 1} has additional actions`, i); });
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    checkObject(doc, level, ref, d, o, annotPage.get(key(ref)) ?? null, issue);
  }
  const seen = new Set();
  return out.filter(i => { const k = `${i.clause}|${i.message}|${i.page}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function checkObject(doc, level, ref, d, o, page, issue) {
  const ty = nameText(look(doc, d.get(N('Type')))), sub = nameText(look(doc, d.get(N('Subtype'))));
  const own = d.has(N('S')) && isAction(d) ? d : null;
  for (const a of [own, d.get(N('A')) instanceof PDFDict ? d.get(N('A')) : null, d.get(N('OpenAction')) instanceof PDFDict ? d.get(N('OpenAction')) : null]) {
    if (!a) continue;
    const n = chainForbidden(doc, a);
    if (n) issue('6.5.1', `A ${n} action isn't allowed`);
  }
  const isAnnot = ty === 'Annot' || (sub !== undefined && d.has(N('Rect')) && d.has(N('P')));
  if (isAnnot) {
    const name = sub ?? '';
    if (sub && FORBIDDEN_ANNOTS.has(sub)) { issue('6.3.1', `${name} annotations aren't allowed`, page); return; }
    const flags = intOf(look(doc, d.get(N('F')))) ?? 0;
    if (sub !== 'Popup' && ((flags & 4) === 0 || (flags & (1 | 2 | 32)) !== 0)) issue('6.3.2', `A ${name} annotation isn't set to print, or is hidden`, page);
    const ap = dictOf(doc, d.get(N('AP')));
    if (!(ap && ap.has(N('N'))) && sub !== 'Popup' && sub !== 'Link') {
      const r = arrayOf(doc, d.get(N('Rect')));
      const v = r ? r.map(x => look(doc, x)).filter(x => x instanceof PDFNumber).map(x => x.asNumber()) : [];
      const zero = v.length === 4 && Math.abs(v[2] - v[0]) < 1e-6 && Math.abs(v[3] - v[1]) < 1e-6;
      if (!zero) issue('6.3.3', `A ${name} annotation has no appearance stream`, page, false);
    }
    if (d.has(N('AA'))) issue('6.5.2', `A ${name} annotation has additional actions`, page);
  }
  if (d.has(N('FT')) && d.has(N('AA')) && ty !== 'Annot') issue('6.5.2', 'A form field has additional actions');
  if (ty === 'Font' || (d.has(N('BaseFont')) && sub !== undefined)) checkFont(doc, d, issue);
  if (o instanceof PDFStream) {
    const f = look(doc, o.dict.get(N('Filter')));
    const filters = f instanceof PDFName ? [f.decodeText()] : f instanceof PDFArray ? f.asArray().map(x => nameText(look(doc, x))).filter(Boolean) : [];
    if (filters.includes('LZWDecode')) issue('6.1.7.2', 'A stream uses LZW compression', null, false);
    if (o.dict.has(N('F')) || o.dict.has(N('FFilter'))) issue('6.1.7.1', 'A stream refers to an external file', null, false);
    if (sub === 'Image') {
      if (isTrue(look(doc, o.dict.get(N('Interpolate'))))) issue('6.2.8', 'An image asks to be interpolated');
      if (o.dict.has(N('Alternates')) || o.dict.has(N('OPI'))) issue('6.2.8', 'An image has alternates or OPI information');
    }
    if (sub === 'PS') issue('6.2.9', "PostScript XObjects aren't allowed", null, false);
  }
  if (ty === 'Filespec' && d.has(N('EF'))) {
    if (level === 'A2b') issue('6.8', 'Embedded files must be PDF/A files themselves (use PDF/A-3 for others)', null, false);
    else if (!d.has(N('AFRelationship'))) issue('6.8', 'An embedded file has no AFRelationship');
  }
}

function checkFont(doc, d, issue) {
  const sub = nameText(look(doc, d.get(N('Subtype'))));
  if (sub === 'Type3') return;
  const name = nameText(look(doc, d.get(N('BaseFont')))) ?? null;
  let descriptor;
  if (sub === 'Type0') { const desc = arrayOf(doc, d.get(N('DescendantFonts'))); const f = desc?.[0] ? dictOf(doc, desc[0]) : null; descriptor = f?.get(N('FontDescriptor')); }
  else descriptor = d.get(N('FontDescriptor'));
  const fd = descriptor ? dictOf(doc, descriptor) : null;
  const embedded = !!fd && (fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')));
  if (!embedded) issue('6.2.11.4', name ? `The font ${name} isn't embedded` : "A font isn't embedded", null, false);
}

// ── convert ─────────────────────────────────────────────────────────────────────────────────

/**
 * lib.rs `convert`: make the document conform as far as can be done without changing how pages look; returns what was fixed and the problems left.
 * Encryption is not part of the pdf-lib document (the working copy is plain): the command deals with it.
 */
export function convert(doc, level) {
  const ctx = doc.context;
  const fixed = [];
  const cat = catalogOf(doc);
  if (cat.delete(N('AA'))) fixed.push("Removed the document's additional actions");
  const oa = cat.get(N('OpenAction'));
  if (oa instanceof PDFDict && forbiddenValue(doc, oa)) { cat.delete(N('OpenAction')); fixed.push('Removed the open action'); }
  const names = dictOf(doc, cat.get(N('Names')));
  if (names && names.has(N('JavaScript'))) { names.delete(N('JavaScript')); fixed.push('Removed document-level JavaScript'); }
  const af = dictOf(doc, cat.get(N('AcroForm')));
  if (af && af.has(N('NeedAppearances'))) { af.delete(N('NeedAppearances')); fixed.push('Cleared NeedAppearances'); }
  if (pdfaIntentProfile(doc) === undefined && !deviceColour(doc).cmyk) {
    const icc = ctx.flateStream(srgbProfile(), {N: 3});
    const oi = ctx.obj({Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'), DestOutputProfile: ctx.register(icc)});
    const list = arrayOf(doc, cat.get(N('OutputIntents'))) ?? [];
    cat.set(N('OutputIntents'), ctx.obj([...list, oi]));
    fixed.push('Added an sRGB output intent');
  }
  const meta = ctx.stream(new TextEncoder().encode(xmpPacket(doc, level)), {Type: 'Metadata', Subtype: 'XML'});
  cat.set(N('Metadata'), ctx.register(meta));
  fixed.push(`Identified the file as ${LEVELS[level].label} in its XMP metadata`);
  let actions = 0, flags = 0, images = 0, removed = 0, files = 0;
  const pages = doc.getPages();
  for (const p of pages) if (p.node.delete(N('AA'))) actions++;
  for (const [ref, o] of [...ctx.enumerateIndirectObjects()]) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    const ty = nameText(look(doc, d.get(N('Type')))), sub = nameText(look(doc, d.get(N('Subtype'))));
    const isAnnot = ty === 'Annot';
    if (isAnnot && sub && FORBIDDEN_ANNOTS.has(sub)) {
      for (const p of pages) {
        const annots = arrayOf(doc, p.node.get(N('Annots'))) ?? [];
        if (annots.some(a => a instanceof PDFRef && key(a) === key(ref))) p.node.set(N('Annots'), ctx.obj(annots.filter(a => !(a instanceof PDFRef && key(a) === key(ref)))));
      }
      ctx.delete(ref);
      removed++;
      continue;
    }
    if (o instanceof PDFDict && (isAnnot || d.has(N('FT')))) {
      let changed = d.delete(N('AA'));
      const a = d.get(N('A'));
      if (a !== undefined && forbiddenValue(doc, a)) { d.delete(N('A')); changed = true; }
      if (changed) actions++;
      if (isAnnot && sub !== 'Popup') {
        const f = intOf(look(doc, d.get(N('F')))) ?? 0;
        const want = (f | 4) & ~(1 | 2 | 32);
        if (want !== f) { d.set(N('F'), PDFNumber.of(want)); flags++; }
      }
      continue;
    }
    if (o instanceof PDFStream && sub === 'Image') {
      let changed = false;
      if (isTrue(look(doc, d.get(N('Interpolate'))))) { d.set(N('Interpolate'), PDFBool.False); changed = true; }
      changed = d.delete(N('Alternates')) || changed;
      changed = d.delete(N('OPI')) || changed;
      if (changed) images++;
      continue;
    }
    if (level === 'A3b' && ty === 'Filespec' && d.has(N('EF')) && !d.has(N('AFRelationship'))) { d.set(N('AFRelationship'), N('Unspecified')); files++; }
  }
  for (const [ref, o] of [...ctx.enumerateIndirectObjects()]) {
    if (!(o instanceof PDFDict)) continue;
    if (o.has(N('S')) && isAction(o) && chainForbidden(doc, o)) { ctx.assign(ref, ctx.obj(null)); actions++; }
    else { const a = o.get(N('A')); if (a instanceof PDFDict && chainForbidden(doc, a)) { o.delete(N('A')); actions++; } }
  }
  for (const [n, what] of [[actions, 'removed forbidden or additional actions'], [flags, 'set annotations to print and show'], [images, 'cleared image interpolation and alternates'],
    [removed, 'removed multimedia annotations'], [files, "marked embedded files' relationship"]]) if (n > 0) fixed.push(`${n}: ${what}`);
  return {fixed, remaining: verify(doc, level)};
}

// ── PDF/UA and PDF/X checks (not checked against upstream) ──────────────────────────────────

/** What the PDF/UA check makes (ISO 14289-1), so the report can say what it did not. */
export const PDFUA_NOT_VERIFIED = [
  'Whether the reading order is logical, and whether alternate text describes its figure well',
  'Colour contrast, flicker, scripts, timed responses and repeated navigation',
  'Whether text really is tagged as what it looks like (headings, lists, tables and their header cells)',
  'Whether every page content item is in the right structure element (only that it is tagged or an artifact)',
  'Natural-language changes inside the document (/Lang on parts of the tree)',
  'Whether embedded fonts map every glyph to Unicode (only whether a mapping is declared)',
];

/**
 * The PDF/UA-1 check: the document identifies as PDF/UA, and the points of ISO 14289-1 the Accessibility Checker's rules cover pass. `report` is a11y.check's.
 * Never a statement of conformance: `checked` and `notVerified` say exactly what was and was not looked at.
 */
export function pdfuaCheck(doc, report, a11yInfo) {
  const decl = declared(doc);
  const rule = id => report.results.find(r => r.rule === id);
  const items = [];
  const add = (clause, label, ok, details = []) => items.push({clause, label, status: ok ? 'passed' : 'failed', details});
  add('5', 'The XMP metadata identifies the file as PDF/UA (pdfuaid:part)', decl.pdfua === 1, decl.pdfua === 1 ? [] : ['No pdfuaid:part 1 in the XMP metadata']);
  const MAP = [['7.1', 'Tagged PDF, marked as tagged', 'tagged-pdf'], ['7.1', 'All page content is tagged or an artifact', 'tagged-content'], ['7.18.1', 'Annotations are tagged', 'tagged-annotations'],
    ['7.18.3', 'The tab order follows the structure', 'tab-order'], ['7.21.8', 'Fonts declare a Unicode mapping', 'character-encoding'], ['7.18.4', 'Form fields are tagged', 'tagged-form-fields'],
    ['7.18.4', 'Form fields have descriptions', 'field-descriptions'], ['7.3', 'Figures have alternate text', 'figures-alt-text'], ['7.2', 'Heading levels do not skip', 'heading-nesting'],
    ['7.5', 'Tables have header cells, regular rows, and rows and cells in the right parents', 'table-headers'], ['7.9', 'Lists are tagged as lists', 'list-items'], ['7.2', 'The document language is set', 'primary-language'],
    ['7.1', 'The title is set and shown in the window', 'title'], ['7.1', 'Large documents have bookmarks', 'bookmarks']];
  for (const [clause, label, id] of MAP) {
    const r = rule(id);
    if (!r || r.status === 'skipped') { items.push({clause, label, status: 'not-checked', details: ['The rule was not run']}); continue; }
    let ok = r.status === 'passed', details = r.findings.map(f => f.message);
    if (id === 'table-headers') for (const extra of ['table-rows', 'table-cells', 'table-regularity']) { const e = rule(extra); if (e && e.status === 'failed') { ok = false; details = details.concat(e.findings.map(f => f.message)); } }
    if (id === 'list-items') { const e = rule('lbl-lbody'); if (e && e.status === 'failed') { ok = false; details = details.concat(e.findings.map(f => f.message)); } }
    items.push({clause, label, status: ok ? 'passed' : 'failed', details});
  }
  void a11yInfo;
  return {items, notVerified: PDFUA_NOT_VERIFIED};
}

export const PDFX_NOT_VERIFIED = [
  'The ICC output profile and whether colours are within the output condition',
  'Overprint, transparency flattening and spot colour rules',
  'Image resolution, font embedding of every glyph, trapping and the page content rules of ISO 15930',
  'The structure of the file itself',
];

/** A check of the points of PDF/X-4 (ISO 15930-7) that can be read from the objects. Not checked against upstream; not a statement of conformance. */
export function pdfxCheck(doc, {encrypted = false} = {}) {
  const items = [];
  const add = (clause, label, ok, detail) => items.push({clause, label, status: ok ? 'passed' : 'failed', details: ok ? [] : [detail]});
  const cat = catalogOf(doc);
  const x = metadataText(doc);
  const version = x ? xmpValue(x, 'pdfxid:GTS_PDFXVersion') : null;
  add('6.7', 'The XMP metadata declares the PDF/X version (pdfxid:GTS_PDFXVersion)', !!version && /^PDF\/X-/.test(version), 'No pdfxid:GTS_PDFXVersion in the XMP metadata');
  const oi = (arrayOf(doc, cat.get(N('OutputIntents'))) ?? []).map(o => dictOf(doc, o)).filter(Boolean);
  add('6.2', 'An output intent of type GTS_PDFX is present', oi.some(d => nameText(look(doc, d.get(N('S')))) === 'GTS_PDFX'), 'No output intent with /S /GTS_PDFX');
  add('6.1.1', 'The document is not encrypted', !(doc.context.trailerInfo.Encrypt || encrypted), 'The document is encrypted');
  const pages = doc.getPages();
  const noBox = pages.map((p, i) => (p.node.has(N('TrimBox')) || p.node.has(N('ArtBox')) ? -1 : i)).filter(i => i >= 0);
  add('6.1.2', 'Every page has a TrimBox or an ArtBox', !noBox.length, `Page ${noBox.slice(0, 5).map(i => i + 1).join(', ')}${noBox.length > 5 ? ' …' : ''} has neither a TrimBox nor an ArtBox`);
  let fonts = 0;
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    const ty = nameText(look(doc, d.get(N('Type')))), sub = nameText(look(doc, d.get(N('Subtype'))));
    if ((ty === 'Font' || (d.has(N('BaseFont')) && sub !== undefined)) && sub !== 'Type3') { const out = []; checkFont(doc, d, (a, b) => out.push(b)); fonts += out.length; }
  }
  add('6.3', 'Every font is embedded', fonts === 0, `${fonts} fonts are not embedded`);
  const bad = new Set();
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    const s = nameText(look(doc, d.get(N('S'))));
    if (s && ['JavaScript', 'Launch', 'Sound', 'Movie', 'Rendition', 'ImportData'].includes(s) && isAction(d)) bad.add(s);
    const sub = nameText(look(doc, d.get(N('Subtype'))));
    if (sub && ['Sound', 'Movie', 'Screen', '3D', 'RichMedia'].includes(sub) && d.has(N('Rect'))) bad.add(`${sub} annotation`);
  }
  add('6.9', 'No JavaScript, launch or multimedia actions or annotations', !bad.size, `Found: ${[...bad].join(', ')}`);
  return {items, notVerified: PDFX_NOT_VERIFIED};
}


// ── Output Preview (not checked against upstream) ───────────────────────────────────────────

/**
 * Print Production ▸ Output Preview, as far as it can be read from the objects: the output intent as the simulation profile, the colour spaces in use with the inks
 * they print on (process and spot), the pages that use each, and the warnings a printer would raise. The page is not simulated (that needs the renderer).
 * Not checked against upstream (it has no Output Preview).
 */
export function outputPreview(doc) {
  const pages = doc.getPages();
  const spaces = new Map();
  const spots = new Map();
  const warnings = [];
  const addSpace = (name, page) => { if (!spaces.has(name)) spaces.set(name, new Set()); if (page !== null) spaces.get(name).add(page); };
  const addSpot = (name, page) => { if (!spots.has(name)) spots.set(name, new Set()); if (page !== null) spots.get(name).add(page); };
  const readSpace = (cs, page, depth = 0) => {
    const v = cs instanceof PDFRef ? look(doc, cs) : cs;
    if (v instanceof PDFName) { const n = v.decodeText(); if (n.startsWith('Device') || n === 'Pattern') addSpace(n, page); return; }
    if (!(v instanceof PDFArray) || depth > 4) return;
    const a = v.asArray();
    const kind = nameText(look(doc, a[0]));
    if (!kind) return;
    addSpace(kind, page);
    if (kind === 'Separation') { const n = nameText(look(doc, a[1])); if (n && !['None'].includes(n)) { if (n === 'All') addSpot('All (registration)', page); else addSpot(n, page); } readSpace(a[2], page, depth + 1); }
    else if (kind === 'DeviceN') { for (const x of arrayOf(doc, a[1]) ?? []) { const n = nameText(look(doc, x)); if (n && n !== 'None') addSpot(n, page); } readSpace(a[2], page, depth + 1); }
    else if (kind === 'Indexed') readSpace(a[1], page, depth + 1);
  };
  const scanResources = (res, page) => {
    const cs = res ? dictOf(doc, res.get(N('ColorSpace'))) : null;
    if (cs) for (const [, v] of cs.entries()) readSpace(v, page);
    const xo = res ? dictOf(doc, res.get(N('XObject'))) : null;
    if (xo) for (const [, v] of xo.entries()) { const x = look(doc, v); if (x instanceof PDFStream && nameText(look(doc, x.dict.get(N('Subtype')))) === 'Image') { const c = x.dict.get(N('ColorSpace')); if (c) readSpace(c, page); } }
    const gs = res ? dictOf(doc, res.get(N('ExtGState'))) : null;
    if (gs) for (const [, v] of gs.entries()) {
      const g = dictOf(doc, v);
      if (!g) continue;
      const ca = look(doc, g.get(N('ca'))), CA = look(doc, g.get(N('CA')));
      const bm = nameText(look(doc, g.get(N('BM'))));
      const sm = look(doc, g.get(N('SMask')));
      if ((ca instanceof PDFNumber && ca.asNumber() < 1) || (CA instanceof PDFNumber && CA.asNumber() < 1) || (bm && bm !== 'Normal' && bm !== 'Compatible') || (sm && !(sm instanceof PDFName))) warnings.push({kind: 'transparency', page, message: 'Transparency is used (opacity, a blend mode or a soft mask)'});
      if (isTrue(look(doc, g.get(N('OP')))) || isTrue(look(doc, g.get(N('op'))))) warnings.push({kind: 'overprint', page, message: 'Overprint is set'});
    }
  };
  pages.forEach((p, i) => {
    const res = dictOf(doc, p.node.Resources?.() ?? null);
    scanResources(res, i);
    const group = dictOf(doc, p.node.get(N('Group')));
    if (group && nameText(look(doc, group.get(N('S')))) === 'Transparency') warnings.push({kind: 'transparency', page: i, message: 'The page has a transparency group'});
    const c = {gray: false, rgb: false, cmyk: false};
    try {
      for (const s of pageStreams(doc, p)) for (const op of parseContent(s.bytes)) {
        if (op.op === 'g' || op.op === 'G') c.gray = true; else if (op.op === 'rg' || op.op === 'RG') c.rgb = true; else if (op.op === 'k' || op.op === 'K') c.cmyk = true;
        if (c.gray && c.rgb && c.cmyk) break;
      }
    } catch { /* a page that cannot be read is skipped */ }
    if (c.gray) addSpace('DeviceGray', i); if (c.rgb) addSpace('DeviceRGB', i); if (c.cmyk) addSpace('DeviceCMYK', i);
  });
  const decl = declared(doc);
  const intents = (arrayOf(doc, catalogOf(doc).get(N('OutputIntents'))) ?? []).map(o => dictOf(doc, o)).filter(Boolean).map(d => ({type: nameText(look(doc, d.get(N('S')))) ?? '', id: strText(look(doc, d.get(N('OutputConditionIdentifier')))) ?? ''}));
  const has = n => spaces.has(n);
  const cmykIntent = pdfaIntentProfile(doc);
  if (has('DeviceRGB') && !intents.length) warnings.push({kind: 'color', page: null, message: 'DeviceRGB is used and the document has no output intent: its colors depend on the printer'});
  if (has('DeviceCMYK') && !intents.length) warnings.push({kind: 'color', page: null, message: 'DeviceCMYK is used and the document has no output intent: its inks depend on the press'});
  if (has('DeviceRGB') && cmykIntent === 4) warnings.push({kind: 'color', page: null, message: 'DeviceRGB is used and the output intent is a CMYK profile: the RGB colors will be converted'});
  if (spots.size) warnings.push({kind: 'spot', page: null, message: `${spots.size} spot color${spots.size === 1 ? '' : 's'}: ${[...spots.keys()].slice(0, 6).join(', ')}${spots.size > 6 ? ' …' : ''}`});
  const inks = [];
  if (has('DeviceCMYK')) inks.push(...['Cyan', 'Magenta', 'Yellow', 'Black'].map(name => ({name, kind: 'process', pages: [...spaces.get('DeviceCMYK')]})));
  else if (has('DeviceGray')) inks.push({name: 'Black', kind: 'process', pages: [...spaces.get('DeviceGray')]});
  for (const [name, set] of spots) inks.push({name, kind: 'spot', pages: [...set]});
  const seen = new Set();
  return {
    simulationProfile: intents[0]?.id || 'None (no output intent)',
    outputIntents: intents,
    declared: declaredNames(decl),
    colorSpaces: [...spaces.entries()].map(([name, set]) => ({name, pages: [...set].sort((a, b) => a - b)})).sort((a, b) => a.name.localeCompare(b.name)),
    separations: inks.map(i => ({...i, pages: i.pages.sort((a, b) => a - b)})),
    warnings: warnings.filter(w => { const k = `${w.kind}|${w.page}|${w.message}`; if (seen.has(k)) return false; seen.add(k); return true; }),
    note: 'This lists the inks and color spaces the document uses. The page is not simulated: separation and ink-limit previews need the page renderer.',
  };
}

export {chainForbidden};
void pageStreams;
