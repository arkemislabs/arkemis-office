// Signatures in a PDF (ISO 32000-2 §12.8): listing and validating signature fields, and signing
// with an incremental save.
//
// Translated from printcraft crates/sign/src/pdf.rs (SignatureInfo, summary), pdf/types.rs
// (TrustStore, Status, kind, Modification, the WORDINGS), pdf/listing.rs (text, sig_fields,
// Field::signature/has_foreign_value, annot_pages, nums, list, mk_rotation), pdf/validate.rs
// (validate_into, docmdp, unhex, finish_validation; the verdicts and their sentences),
// pdf/changes.rs (classify_changes, ChangedObjectClassifier, added_annots, acroform_kind,
// page_change_kind, change_kind, signed_page_resources, is_signature_dict, extensions_kept),
// pdf/signing.rs (Appearance, AppearanceLabels, SignOptions, check_signing_permissions, BR_MARK,
// sign, locate, display_date, appearance, fmt) and graphic.rs (Graphic::draw, fit, bounds,
// image_xobject) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream reads the file with its own COS crate; here pdf-lib parses it, and the incremental
// update is written by hand (pdf-lib only writes whole files): the changed and new objects,
// then a cross-reference section of the same kind as the file's last one (a table, or an
// uncompressed cross-reference stream) whose /Prev points at it, so the signed revision's bytes
// stay exactly as they were. Not translated: RFC 3161 timestamps (sign.timestamp is
// catalogue-only upstream too), revocation evidence in /DSS, adbe.x509.rsa_sha1, encrypted
// documents (refused), and the Inter fallback font for non-Latin appearance text (refused).
// Product wording: upstream's "PdfCraft" in sentences the person reads is "Arkemis".

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString, PDFHexString, PDFStream, PDFRawStream, PDFBool, PDFNull} from 'pdf-lib';
import {SignError, Time, fromHex, hex, ascii, latin1, concat, equalBytes} from './sign-der.mjs';
import {DigestAlg, digest, weakness} from './sign-crypto.mjs';
import {buildChain} from './sign-x509.mjs';
import {SignedData, DATA, signDetached} from './sign-cms.mjs';
import {smoothSegments} from '../model/appearance.mjs';
import {textWidth, wrap, firstUndrawable, undrawableMessage, winAnsiBytes, literal} from './fonts.mjs';

const APP = 'Arkemis';
const pdfErr = m => new SignError('pdf', m);

// ── types.rs ───────────────────────────────────────────────────────────────────────────────

export const Status = Object.freeze({Valid: 'valid', Unknown: 'unknown', Invalid: 'invalid'});
export const kind = Object.freeze({
  PAGE_CONTENT: 'page content', FORM_FILL: 'form fill', COMMENTS: 'comments', SIGNATURE: 'signature', SECURITY_STORE: 'document security store',
  METADATA: 'metadata', LINKS: 'links', STRUCTURE: 'document structure', PAGES: 'pages added or removed', OTHER: 'other changes',
  UNREADABLE: 'the signed version could not be read',
});

/** pdf.rs `SignatureInfo::summary`. */
export function summary(info) {
  if (!info.signed) return 'Unsigned signature field';
  return info.status === Status.Valid ? 'Signature is valid' : info.status === Status.Invalid ? 'Signature is invalid' : 'Signature validity is unknown';
}

/** Certificates the person trusts for signing (Acrobat: Trusted Certificates). */
export class TrustStore {
  constructor(certs = []) { this.certs = certs; }
  trusts(c) { return this.certs.some(t => equalBytes(t.raw, c.raw)); }
}

// ── COS over pdf-lib ───────────────────────────────────────────────────────────────────────

const N = k => PDFName.of(k);
const keyOf = r => `${r.objectNumber} ${r.generationNumber}`;
const resolve = (ctx, o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const dictOf = (ctx, o) => { const v = resolve(ctx, o); return v instanceof PDFDict ? v : v instanceof PDFStream ? v.dict : null; };
const arrayOf = (ctx, o) => { const v = resolve(ctx, o); return v instanceof PDFArray ? v.asArray() : null; };
const nameIn = (d, k) => { const v = d?.get(N(k)); return v instanceof PDFName ? v.decodeText() : null; };
const intIn = (ctx, d, k) => { const v = resolve(ctx, d?.get(N(k))); return v instanceof PDFNumber ? v.asNumber() : null; };

/** listing.rs `text`. */
function text(ctx, d, k) {
  const o = resolve(ctx, d?.get(N(k)));
  let s;
  if (o instanceof PDFString || o instanceof PDFHexString) s = o.decodeText();
  else if (o instanceof PDFName) s = o.decodeText();
  else return null;
  s = s.replace(/^\0+|\0+$/g, '').trim();
  return s || null;
}

/** listing.rs `nums`. */
function nums(ctx, d, k) {
  const a = arrayOf(ctx, d?.get(N(k)));
  return a ? a.map(x => resolve(ctx, x)).filter(x => x instanceof PDFNumber).map(x => x.asNumber()) : null;
}

/** The serialized bytes of an object: what "unchanged" is judged by. */
function encode(o) {
  if (o === undefined || o === null) return null;
  const size = o.sizeInBytes();
  const buf = new Uint8Array(size);
  o.copyBytesInto(buf, 0);
  return buf;
}
const sameObject = (a, b) => { const x = encode(a), y = encode(b); return !!x && !!y && equalBytes(x, y); };

/** The document's page objects in order. */
const pageRefs = doc => doc.getPages().map(p => p.ref);

async function load(bytes) {
  return PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false});
}

// ── listing.rs ─────────────────────────────────────────────────────────────────────────────

/** Every signature field, depth first in /Fields order: {name, ref, dict, widgets: [{ref, dict}]}. */
export function sigFields(doc) {
  const ctx = doc.context, out = [];
  const af = dictOf(ctx, doc.catalog.get(N('AcroForm')));
  const fields = af ? arrayOf(ctx, af.get(N('Fields'))) : null;
  if (!fields) return out;
  const seen = new Set();
  const stack = [...fields].reverse().map(f => [f, '', null]);
  while (stack.length) {
    const [o, prefix, inheritedFt] = stack.pop();
    if (o instanceof PDFRef) { if (seen.has(keyOf(o))) continue; seen.add(keyOf(o)); }
    const d = dictOf(ctx, o);
    if (!d) continue;
    const part = text(ctx, d, 'T');
    const name = part ? (prefix ? `${prefix}.${part}` : part) : prefix;
    const ft = nameIn(d, 'FT') ?? inheritedFt;
    const kids = arrayOf(ctx, d.get(N('Kids'))) ?? [];
    const sub = [], widgets = [];
    for (const k of kids) (dictOf(ctx, k)?.has(N('T')) ? sub : widgets).push(k);
    for (const k of [...sub].reverse()) stack.push([k, name, ft]);
    if (ft === 'Sig' && part) {
      const ws = widgets.map(w => ({ref: w instanceof PDFRef ? w : null, dict: dictOf(ctx, w)})).filter(w => w.dict);
      if (nameIn(d, 'Subtype') === 'Widget') ws.unshift({ref: o instanceof PDFRef ? o : null, dict: d});
      out.push({name, ref: o instanceof PDFRef ? o : null, dict: d, widgets: ws});
    }
  }
  return out;
}

const fieldSignature = (ctx, f) => dictOf(ctx, f.dict.get(N('V')));
const hasForeignValue = (ctx, f) => { const v = resolve(ctx, f.dict.get(N('V'))); return v !== undefined && v !== PDFNull && !(v instanceof PDFDict); };

/** listing.rs `mk_rotation`. */
function mkRotation(ctx, w) {
  const mk = dictOf(ctx, w.get(N('MK')));
  const r = intIn(ctx, mk, 'R');
  if (r == null || !Number.isFinite(r)) return 0;
  const q = ((Math.round(r) % 360) + 360) % 360;
  return [90, 180, 270].includes(q) ? q : 0;
}

function unhex(s) { return fromHex(latin1(s).replace(/\s+/g, '')); }

/** validate.rs `docmdp`: the DocMDP permission level (1–3) of a signature value, or null. */
function docmdp(ctx, v) {
  for (const r of arrayOf(ctx, v.get(N('Reference'))) ?? []) {
    const d = dictOf(ctx, r);
    if (nameIn(d, 'TransformMethod') !== 'DocMDP') continue;
    const p = intIn(ctx, dictOf(ctx, d.get(N('TransformParams'))), 'P') ?? 2;
    return Math.min(3, Math.max(1, p));
  }
  return null;
}

/** Signed revisions opened for change classification, by length. */
class RevisionCache {
  constructor(bytes) { this.bytes = bytes; this.map = new Map(); this.digests = new Map(); }
  async revision(end) {
    if (!this.map.has(end)) this.map.set(end, load(this.bytes.subarray(0, end)).catch(() => null));
    return this.map.get(end);
  }
  async digest(d, l0, o1, end) {
    const k = `${d.key}:${l0}:${o1}:${end}`;
    if (!this.digests.has(k)) this.digests.set(k, digest(d, [this.bytes.subarray(0, l0), this.bytes.subarray(o1, end)]));
    return this.digests.get(k);
  }
}

/** The 1-based number of the revision `bytes[..end]` ends: its cross-reference sections. */
function revisionNumber(bytes, end) {
  const s = latin1(bytes.subarray(0, end));
  return Math.max(1, (s.match(/startxref/g) ?? []).length);
}

/**
 * listing.rs `list`: every signature field, validated. `bytes`: the file as stored.
 * @returns {Promise<object[]>} SignatureInfo records (plain objects; certificates as Certificate)
 */
export async function listSignatures(bytes, trust = new TrustStore()) {
  const doc = await load(bytes);
  const ctx = doc.context;
  const pages = pageRefs(doc);
  const annotPage = new Map();
  pages.forEach((p, i) => { for (const a of arrayOf(ctx, dictOf(ctx, p).get(N('Annots'))) ?? []) if (a instanceof PDFRef) annotPage.set(keyOf(a), i); });
  const cache = new RevisionCache(bytes);
  const out = [];
  for (const f of sigFields(doc)) {
    const w = f.widgets[0];
    let page = w?.ref ? annotPage.get(keyOf(w.ref)) ?? null : null;
    if (page == null && w?.dict.get(N('P')) instanceof PDFRef) { const i = pages.findIndex(p => keyOf(p) === keyOf(w.dict.get(N('P')))); page = i < 0 ? null : i; }
    const r = w ? nums(ctx, w.dict, 'Rect') : null;
    const rect = r && r.length === 4 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : null;
    const flags = intIn(ctx, w?.dict, 'F') ?? 0;
    const visible = !!rect && rect[2] - rect[0] > 0.5 && rect[3] - rect[1] > 0.5 && (flags & (2 | 32)) === 0;
    const v = fieldSignature(ctx, f);
    const info = {field: f.name, signed: !!v, page, rect, visible, signer: null, certificate: null, chain: [], date: null, signingTime: null, reason: null,
      location: null, contact: null, subFilter: null, docTimestamp: false, certify: null, revision: 0, signedLen: 0, digest: null, algorithm: null,
      timestamp: false, timestampTime: null, status: Status.Unknown, modification: {kind: 'none', changes: []}, details: []};
    if (v) await validateInto(doc, bytes, trust, v, info, cache);
    info.summary = summary(info);
    out.push(info);
  }
  return out;
}

// ── validate.rs ────────────────────────────────────────────────────────────────────────────

async function validateInto(doc, bytes, trust, v, info, cache) {
  const ctx = doc.context;
  if (nameIn(v, 'SubFilter') === 'ETSI.RFC3161') {
    info.subFilter = 'ETSI.RFC3161'; info.docTimestamp = true; info.timestamp = true;
    info.status = Status.Unknown;
    info.details.push(`${APP} can't check this signature yet: RFC 3161 document timestamps.`);
    return;
  }
  info.date = text(ctx, v, 'M');
  info.reason = text(ctx, v, 'Reason');
  info.location = text(ctx, v, 'Location');
  info.contact = text(ctx, v, 'ContactInfo');
  info.subFilter = nameIn(v, 'SubFilter');
  info.signer = text(ctx, v, 'Name');
  info.certify = docmdp(ctx, v);
  const invalid = why => { info.status = Status.Invalid; info.details.push(why); };
  const br = nums(ctx, v, 'ByteRange');
  if (!br || br.length !== 4 || br.some(x => x < 0 || !Number.isInteger(x))) return invalid('The signature has no valid byte range.');
  const [o0, l0, o1, l1] = br;
  if (o0 !== 0 || o1 < l0 || o1 + l1 > bytes.length || o1 - l0 < 2) return invalid("The signature's byte range does not match the file.");
  const gap = bytes.subarray(l0, o1);
  if (gap[0] !== 0x3c || gap[gap.length - 1] !== 0x3e) return invalid("The signature's byte range does not exclude exactly its contents.");
  const contents = unhex(gap.subarray(1, gap.length - 1));
  if (!contents) return invalid('The signature contents are not hexadecimal.');
  const covered = o1 + l1;
  info.signedLen = covered;
  info.revision = revisionNumber(bytes, covered);
  const unsupportedNow = why => { info.status = Status.Unknown; info.details.push(`${APP} can't check this signature yet: ${why}.`); };
  if (info.subFilter === 'adbe.x509.rsa_sha1') return unsupportedNow('the legacy adbe.x509.rsa_sha1 format');
  let sd;
  try { sd = SignedData.parse(contents); } catch (e) {
    if (e.kind === 'unsupported') return unsupportedNow(e.message.replace(/^not supported: /, ''));
    return invalid(`The signature could not be read (${e.message}).`);
  }
  const s = sd.signer;
  info.details.push(...sd.quirks);
  info.digest = s.digest.name;
  info.timestamp = s.timestamp;
  if (s.timestampToken) info.details.push(`The signature carries an unverified timestamp: ${APP} does not check RFC 3161 tokens yet, so the signing time claimed by the signer is used instead.`);
  let contentDigest, signedContent;
  try {
    if (sd.content) {
      if (!equalBytes(sd.content, await cache.digest(DigestAlg.Sha1, l0, o1, covered))) return invalid('The document has been altered or corrupted since the signature was applied.');
      signedContent = sd.content;
      contentDigest = await digest(s.digest, [sd.content]);
    } else {
      signedContent = concat([bytes.subarray(0, l0), bytes.subarray(o1, covered)]);
      contentDigest = await cache.digest(s.digest, l0, o1, covered);
    }
  } catch (e) {
    if (e.kind === 'unsupported') return unsupportedNow(e.message.replace(/^not supported: /, ''));
    return invalid(`The signature could not be checked (${e.message}).`);
  }
  if (s.signedAttrs) {
    if (s.contentType && s.contentType !== DATA) return invalid("The signature's signed attributes name a content type other than data, so it is not a signature of the document.");
    if (!s.contentType) info.details.push("The signature's signed attributes have no content type, which CMS requires; it was read anyway.");
    if (!s.messageDigest) return invalid("The signature's signed attributes have no message digest, so the signature does not cover the document.");
  }
  if (sd.econtentType !== DATA) return invalid('The signature could not be read (malformed data: CMS: the encapsulated content is not data).');
  if (s.messageDigest && !equalBytes(s.messageDigest, contentDigest)) return invalid('The document has been altered or corrupted since the signature was applied.');
  const cert = sd.signerCertificate();
  if (!cert) return invalid("The signer's certificate is not in the signature.");
  info.algorithm = `${cert.publicKey.describe()} with ${(s.schemeDigest ?? s.digest).name}`;
  info.signer = cert.displayName();
  const notes = [];
  let ok;
  try { ok = await sd.verifySignature(cert, signedContent, notes); } catch (e) {
    info.certificate = cert;
    if (e.kind === 'unsupported') return unsupportedNow(e.message.replace(/^not supported: /, ''));
    return invalid(`The signature could not be checked (${e.message}).`);
  }
  if (!ok) { info.certificate = cert; return invalid("The signature value does not match the signer's certificate: the signature is corrupt."); }
  info.details.push(...notes);
  await finishValidation(doc, bytes, trust, info, cache, {covered, certificate: cert, embedded: sd.certificates, cmsTime: s.signingTime});
}

async function finishValidation(doc, bytes, trust, info, cache, {covered, certificate: cert, embedded, cmsTime}) {
  info.signingTime = cmsTime ?? (info.date ? Time.fromPdf(info.date) : null);
  const pool = [...embedded, ...trust.certs];
  const at = info.timestampTime ?? info.signingTime;
  const {chain, refused} = await buildChain(cert, pool, at);
  const trusted = chain.some(c => trust.trusts(c));
  info.chain = chain;
  info.certificate = cert;
  if (refused && !trusted) info.details.push(refused);
  const tail = bytes.subarray(covered);
  if (covered === bytes.length || tail.every(b => b === 0 || b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c)) info.modification = {kind: 'none', changes: []};
  else {
    const old = await cache.revision(covered);
    if (old) {
      const v = sigFields(old).map(f => fieldSignature(old.context, f)).filter(Boolean)
        .find(x => { const b = nums(old.context, x, 'ByteRange'); return b && b.length === 4 && b[2] + b[3] === covered; });
      if (v) info.certify = docmdp(old.context, v);
    }
    info.modification = classifyChanges(doc, old, info.certify);
  }
  let problems = false;
  const m = info.modification;
  if (m.kind === 'none') info.details.push('This document has not been modified since this signature was applied.');
  else if (m.kind === 'allowed') info.details.push(`The document has been modified since this signature was applied, but the changes are permitted (${m.changes.join(', ')}).`);
  else { info.status = Status.Invalid; info.details.push(`The document has been altered since this signature was applied in ways it does not permit (${m.changes.join(', ')}).`); problems = true; }
  const t = info.timestampTime ?? info.signingTime;
  if (t && !cert.validAt(t)) {
    info.details.push("The signer's certificate was not valid at the time of signing.");
    if (!problems) info.status = Status.Unknown;
    problems = true;
  }
  const why = cert.signingProblem();
  if (why) { info.details.push(why); if (!problems) info.status = Status.Unknown; problems = true; }
  if (!trusted) {
    info.details.push("The signer's identity is unknown because it has not been included in your list of trusted certificates and none of its parent certificates are trusted certificates.");
    if (!problems) info.status = Status.Unknown;
  } else {
    info.details.push("The signer's identity is valid.");
    if (!problems) info.status = Status.Valid;
  }
  info.details.push(info.timestamp ? 'The signature includes an embedded timestamp.' : "Signing time is from the clock on the signer's computer.");
}

// ── changes.rs ─────────────────────────────────────────────────────────────────────────────

const without = (d, keys) => {
  if (!d) return null;
  const e = d.entries().filter(([k]) => !keys.includes(k.decodeText())).sort((a, b) => (a[0].decodeText() < b[0].decodeText() ? -1 : 1));
  return e.map(([k, v]) => `${k.decodeText()}=${latin1(encode(v))}`).join('\n');
};
const refsIn = (ctx, o) => (arrayOf(ctx, o) ?? []).filter(x => x instanceof PDFRef).map(keyOf);

function addedAnnots(doc, added) {
  const kinds = added.map(k => { const d = dictOf(doc.context, refFromKey(k)); return [nameIn(d, 'Subtype') === 'Widget', nameIn(d, 'FT') === 'Sig']; });
  if (kinds.length && kinds.every(([w, s]) => w && s)) return kind.SIGNATURE;
  if (kinds.length && kinds.every(([w]) => w)) return kind.FORM_FILL;
  return kind.COMMENTS;
}
const refFromKey = k => { const [n, g] = k.split(' ').map(Number); return PDFRef.of(n, g); };
const acroform = doc => dictOf(doc.context, doc.catalog.get(N('AcroForm')));

function acroformKind(doc, old, now, before) {
  const b = before ?? acroform(old) ?? null;
  if (without(now, ['Fields', 'SigFlags']) !== (b ? without(b, ['Fields', 'SigFlags']) : '')) return kind.FORM_FILL;
  const oldFields = b ? refsIn(old.context, b.get(N('Fields'))) : [];
  const added = refsIn(doc.context, now.get(N('Fields'))).filter(r => !oldFields.includes(r));
  return !added.length || addedAnnots(doc, added) === kind.SIGNATURE ? kind.SIGNATURE : kind.FORM_FILL;
}

const isSignatureDict = d => ['Sig', 'DocTimeStamp', 'SigRef', 'TransformParams'].includes(nameIn(d, 'Type')) || nameIn(d, 'FT') === 'Sig';

function pageChangeKind(doc, old, d, before) {
  if (!before) return kind.PAGE_CONTENT;
  if (without(d, ['Annots']) !== without(before, ['Annots'])) return kind.PAGE_CONTENT;
  const was = refsIn(old.context, before.get(N('Annots')));
  const added = refsIn(doc.context, d.get(N('Annots'))).filter(r => !was.includes(r));
  return addedAnnots(doc, added);
}

function changeKind(doc, old, d, before) {
  const ty = nameIn(d, 'Type');
  const signatureOk = !before || isSignatureDict(before);
  if (before && nameIn(before, 'Subtype') === 'Widget' && nameIn(before, 'FT') === 'Sig' && dictOf(old.context, before.get(N('V'))) && !sameObject(before, d)) return kind.PAGE_CONTENT;
  if (['Sig', 'DocTimeStamp', 'SigRef', 'TransformParams'].includes(ty) && !before) return kind.SIGNATURE;
  if (ty === 'Catalog') {
    const keys = ['AcroForm', 'DSS', 'Perms', 'Metadata', 'NeedsRendering', 'Extensions'];
    if (!before) return kind.FORM_FILL;
    if (without(d, keys) !== without(before, keys)) return kind.STRUCTURE;
    const bf = before.get(N('AcroForm')), df = d.get(N('AcroForm'));
    if (!sameObject(bf ?? PDFNull, df ?? PDFNull)) return acroformKind(doc, old, acroform(doc) ?? doc.context.obj({}), null);
    if (!sameObject(before.get(N('Perms')) ?? PDFNull, d.get(N('Perms')) ?? PDFNull)) return kind.SIGNATURE;
    return kind.METADATA;
  }
  if (ty === 'Page') {
    if (!before) return kind.COMMENTS;
    return pageChangeKind(doc, old, d, before);
  }
  if (ty === 'Pages') return before ? kind.PAGES : kind.STRUCTURE;
  const sub = nameIn(d, 'Subtype');
  if (sub === 'Widget') return nameIn(d, 'FT') === 'Sig' && signatureOk ? kind.SIGNATURE : kind.FORM_FILL;
  if (sub === 'Link') return kind.LINKS;
  if (sub && (ty === 'Annot' || d.has(N('Rect')))) return kind.COMMENTS;
  if (nameIn(d, 'FT') === 'Sig' && signatureOk) return kind.SIGNATURE;
  if (d.has(N('Fields'))) return acroformKind(doc, old, d, before);
  if (d.has(N('FT')) || (d.has(N('T')) && d.has(N('Kids'))) || d.has(N('DR'))) return kind.FORM_FILL;
  if (!before) return kind.FORM_FILL;
  return kind.OTHER;
}

/** changes.rs `signed_page_resources`: what the signed pages draw from, true for containers. */
function signedPageResources(old, pages) {
  const CATEGORIES = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'];
  const ctx = old.context, roles = new Map();
  const stop = new Set([...pages, keyOf(old.context.trailerInfo.Root)]);
  const reach = (o, depth) => {
    if (roles.size >= 50000 || depth > 32) return;
    let v = o;
    if (o instanceof PDFRef) { const k = keyOf(o); if (stop.has(k) || roles.has(k) && roles.get(k) === false) return; roles.set(k, false); v = ctx.lookup(o); }
    if (v instanceof PDFDict) for (const [, x] of v.entries()) reach(x, depth + 1);
    else if (v instanceof PDFStream) for (const [, x] of v.dict.entries()) reach(x, depth + 1);
    else if (v instanceof PDFArray) for (const x of v.asArray()) reach(x, depth + 1);
  };
  const resources = page => {
    let cur = page;
    for (let i = 0; i < 64 && cur; i++) {
      const d = dictOf(ctx, refFromKey(cur));
      if (!d) return null;
      if (d.has(N('Resources'))) return d.get(N('Resources'));
      const p = d.get(N('Parent'));
      cur = p instanceof PDFRef ? keyOf(p) : null;
    }
    return null;
  };
  for (const page of pages) {
    const res = resources(page);
    if (!res) continue;
    const container = o => { if (o instanceof PDFRef && !roles.has(keyOf(o))) roles.set(keyOf(o), true); return dictOf(ctx, o); };
    const d = container(res);
    if (!d) continue;
    for (const c of CATEGORIES) {
      const v = d.get(N(c));
      if (!v) continue;
      const entries = container(v);
      if (entries) for (const [, e] of entries.entries()) reach(e, 0);
    }
  }
  return roles;
}

/** changes.rs `classify_changes`: what later revisions changed, under DocMDP `p` (null: approval). */
export function classifyChanges(doc, old, p) {
  if (!old) return {kind: 'disallowed', changes: [kind.UNREADABLE]};
  const octx = old.context, ctx = doc.context;
  const signedPages = new Set(pageRefs(old).map(keyOf));
  const oldContent = new Set();
  for (const pg of signedPages) {
    const c = dictOf(octx, refFromKey(pg))?.get(N('Contents'));
    if (c instanceof PDFRef) { oldContent.add(keyOf(c)); for (const x of arrayOf(octx, c) ?? []) if (x instanceof PDFRef) oldContent.add(keyOf(x)); }
    else if (c instanceof PDFArray) for (const x of c.asArray()) if (x instanceof PDFRef) oldContent.add(keyOf(x));
  }
  const oldCatalog = old.catalog;
  const oldMetadata = oldCatalog.get(N('Metadata')) instanceof PDFRef ? keyOf(oldCatalog.get(N('Metadata'))) : null;
  const signedAnnots = new Set([...signedPages].map(pg => dictOf(octx, refFromKey(pg))?.get(N('Annots'))).filter(a => a instanceof PDFRef).map(keyOf));
  const signedResources = signedPageResources(old, signedPages);
  const oldInfo = octx.trailerInfo.Info instanceof PDFRef ? keyOf(octx.trailerInfo.Info) : null;
  const allowed = [], disallowed = [];
  const add = (list, w) => { if (!list.includes(w)) list.push(w); };
  if (keyOf(ctx.trailerInfo.Root) !== keyOf(octx.trailerInfo.Root)) add(disallowed, kind.STRUCTURE);
  const current = new Set();
  for (const [ref, now] of ctx.enumerateIndirectObjects()) {
    const k = keyOf(ref);
    current.add(k);
    const before = octx.lookup(ref);
    if (before !== undefined && sameObject(before, now)) continue;
    let what = null;
    const role = signedResources.get(k);
    if (role === false) what = kind.PAGE_CONTENT;
    else if (role === true) {
      const prev = before instanceof PDFDict ? before : null;
      const kept = prev && now instanceof PDFDict && prev.entries().every(([kk, v]) => { const x = now.get(kk); return x !== undefined && sameObject(x, v); });
      what = kept ? null : kind.PAGE_CONTENT;
      if (kept) continue;
    } else if (now instanceof PDFArray && signedAnnots.has(k) && before instanceof PDFArray) {
      const was = before.asArray().filter(x => x instanceof PDFRef).map(keyOf);
      const kept = now.asArray().filter(x => x instanceof PDFRef).map(keyOf);
      const removed = was.filter(r => !kept.includes(r));
      if (!removed.length) what = addedAnnots(doc, kept.filter(r => !was.includes(r)));
      else what = removed.some(r => nameIn(dictOf(octx, refFromKey(r)), 'Subtype') === 'Widget') ? kind.OTHER : kind.COMMENTS;
    } else if (now instanceof PDFDict) {
      const prev = before instanceof PDFDict ? before : null;
      if (signedPages.has(k)) what = pageChangeKind(doc, old, now, prev);
      else if (prev && k === oldInfo) what = kind.METADATA;
      else what = changeKind(doc, old, now, prev);
    } else if (now instanceof PDFStream) {
      const wasPlumbing = before instanceof PDFStream && ['XRef', 'ObjStm'].includes(nameIn(before.dict, 'Type'));
      if (oldContent.has(k)) what = kind.PAGE_CONTENT;
      else if (before === undefined || wasPlumbing) what = null;
      else if (nameIn(now.dict, 'Type') === 'Metadata' && k === oldMetadata) what = kind.METADATA;
      else what = kind.OTHER;
    } else if (before === undefined) what = null;
    else what = kind.OTHER;
    if (!what) continue;
    const ok = what === kind.SIGNATURE || what === kind.SECURITY_STORE || what === kind.METADATA
      || (what === kind.FORM_FILL && (p === 2 || p === 3 || p == null)) || (what === kind.COMMENTS && (p === 3 || p == null));
    add(ok ? allowed : disallowed, what);
  }
  for (const [ref, was] of octx.enumerateIndirectObjects()) {
    const k = keyOf(ref);
    if (current.has(k)) continue;
    const signedRole = oldContent.has(k) || signedPages.has(k) || signedResources.has(k);
    if (!signedRole && was instanceof PDFStream && ['XRef', 'ObjStm'].includes(nameIn(was.dict, 'Type'))) continue;
    add(disallowed, signedRole ? kind.PAGE_CONTENT : kind.OTHER);
  }
  return disallowed.length ? {kind: 'disallowed', changes: disallowed} : {kind: 'allowed', changes: allowed};
}

// ── signing.rs ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_APPEARANCE = Object.freeze({name: true, date: true, reason: false, location: false, distinguishedName: false, labels: true});
export const DEFAULT_LABELS = Object.freeze({signedBy: 'Digitally signed by', distinguishedName: 'DN: ', reason: 'Reason: ', location: 'Location: ', date: 'Date: '});

/** signing.rs `fmt`. */
export const fmt = v => { const s = (Math.round(v * 100) / 100).toFixed(2); return s.replace(/0+$/, '').replace(/\.$/, '') || '0'; };

/** signing.rs `display_date`: "2026.10.02 14:03:11 +02'00'" from a PDF date. */
export function displayDate(pdf) {
  const s = String(pdf ?? '').replace(/^D:/, '');
  const g = (a, b) => s.slice(a, b) || '00';
  const z = s.slice(14);
  const tz = z ? (z.startsWith('Z') ? ' Z' : ` ${z}`) : '';
  return `${g(0, 4)}.${g(4, 6)}.${g(6, 8)} ${g(8, 10)}:${g(10, 12)}:${g(12, 14)}${tz}`;
}

const BR_MARK = [1111111111, 2222222222, 3333333333];

/** graphic.rs `fit`. */
function fit(b, area) {
  const bw = Math.max(b[2] - b[0], 1e-9), bh = Math.max(b[3] - b[1], 1e-9);
  const k = Math.min(area[2] / bw, area[3] / bh);
  return [k, area[0] + (area[2] - (b[2] - b[0]) * k) / 2, area[1] + (area[3] - (b[3] - b[1]) * k) / 2];
}

function graphicBounds(points) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (!p.every(Number.isFinite)) throw pdfErr("the signature graphic has a point that isn't a number");
    b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
  }
  if (!b.every(Number.isFinite)) throw pdfErr('the signature graphic is empty');
  return b;
}

/**
 * graphic.rs `Graphic::draw`: {strokes} (y up, pad 1 wide), {outlines} (closed, non-zero fill) or
 * {image: {width, height, rgba}} drawn into `area` [x, y, w, h]; returns content and an image.
 */
export function drawGraphic(ctx, g, area) {
  if (g.strokes) {
    const pts = g.strokes.reduce((a, s) => a + s.length, 0);
    if (pts > 300000) throw pdfErr(`the signature graphic has ${pts} points; at most 300000`);
    const curves = g.strokes.map(s => smoothSegments(s));
    const controls = curves.flat().flatMap(([a, b]) => [a, b]);
    const b = graphicBounds([...g.strokes.flat(), ...controls]);
    const width = Math.min(4, Math.max(0.3, fit(b, area)[0] * 0.01));
    const inset = [area[0] + width / 2, area[1] + width / 2, Math.max(area[2] - width, 0), Math.max(area[3] - width, 0)];
    const [k, x, y] = fit(b, inset);
    const at = q => `${fmt(x + (q[0] - b[0]) * k)} ${fmt(y + (q[1] - b[1]) * k)}`;
    let c = `q 0 G ${fmt(width)} w 1 J 1 j\n`;
    g.strokes.forEach((s, i) => {
      if (!s.length) return;
      const start = at(s[0]);
      c += `${start} m\n`;
      if (!curves[i].length) c += `${start} l\n`;
      for (const [p, q, e] of curves[i]) c += `${at(p)} ${at(q)} ${at(e)} c\n`;
      c += 'S\n';
    });
    return {content: c + 'Q\n', image: null};
  }
  if (g.outlines) {
    const closed = g.outlines.filter(c => c.length > 2);
    if (!closed.length) throw pdfErr('the signature graphic has no outline that encloses anything');
    const b = graphicBounds(closed.flat());
    const [k, x, y] = fit(b, area);
    let c = 'q 0 g\n';
    for (const contour of closed) { contour.forEach((p, i) => { c += `${fmt(x + (p[0] - b[0]) * k)} ${fmt(y + (p[1] - b[1]) * k)} ${i ? 'l' : 'm'}\n`; }); c += 'h\n'; }
    return {content: c + 'f\nQ\n', image: null};
  }
  if (g.embedded) {
    // A PNG or JPEG the person chose (SignGraphic::Image), already embedded by pdf-lib in `sign`.
    const {ref, width, height} = g.embedded;
    const [k, x, y] = fit([0, 0, width, height], area);
    return {content: `q ${fmt(width * k)} 0 0 ${fmt(height * k)} ${fmt(x)} ${fmt(y)} cm /Im1 Do Q
`, image: ref};
  }
  if (g.image) {
    const {width, height, rgba} = g.image;
    if (!width || !height || width > 8192 || height > 8192 || width * height > (1 << 24)) throw pdfErr(`the signature graphic image is ${width} x ${height} pixels; at most 8192 per side and 16 megapixels`);
    if (rgba.length !== width * height * 4) throw pdfErr("the signature graphic image's pixels don't match its size");
    const [k, x, y] = fit([0, 0, width, height], area);
    return {content: `q ${fmt(width * k)} 0 0 ${fmt(height * k)} ${fmt(x)} ${fmt(y)} cm /Im1 Do Q\n`, image: imageXObject(ctx, width, height, rgba)};
  }
  throw pdfErr('the signature graphic is empty');
}

/** graphic.rs `image_xobject`: RGB, with a soft mask when any pixel isn't opaque. */
export function imageXObject(ctx, width, height, rgba) {
  const n = width * height, rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n);
  let opaque = true;
  for (let i = 0; i < n; i++) { rgb[3 * i] = rgba[4 * i]; rgb[3 * i + 1] = rgba[4 * i + 1]; rgb[3 * i + 2] = rgba[4 * i + 2]; alpha[i] = rgba[4 * i + 3]; if (alpha[i] !== 255) opaque = false; }
  const dict = space => ({Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: space, BitsPerComponent: 8});
  const d = dict('DeviceRGB');
  if (!opaque) d.SMask = ctx.register(ctx.flateStream(alpha, dict('DeviceGray')));
  return ctx.register(ctx.flateStream(rgb, d));
}

/** signing.rs `appearance`: the visible signature (name large on the left or the graphic, details on the right). */
function appearanceStream(ctx, rect, turn, name, cert, opts) {
  turn = [90, 180, 270].includes(turn) ? turn : 0;
  const rw = Math.max(rect[2] - rect[0], 0), rh = Math.max(rect[3] - rect[1], 0);
  const [w, h] = turn % 180 === 0 ? [rw, rh] : [rh, rw];
  const a = {...DEFAULT_APPEARANCE, ...(opts.appearance ?? {})};
  const wording = {...DEFAULT_LABELS, ...(opts.labels ?? {})};
  const dn = cert.subject.display();
  if (w > 1 && h > 1) {
    for (const [on, what, s] of [[a.name, "the signer's name", name], [a.distinguishedName, "the certificate's subject", dn], [a.reason, 'the reason', opts.reason], [a.location, 'the location', opts.location]]) {
      const bad = on && s ? firstUndrawable(s.replace(/[\r\n]/g, '')) : null;
      if (bad) throw new SignError('unsupported', `${undrawableMessage(`${what} of the visible signature`, bad)}; sign without a visible appearance, or leave ${what} out of it`);
    }
  }
  const lines = [];
  const label = (l, v) => (a.labels ? `${l}${v}` : v);
  if (a.name) { lines.push(a.labels ? wording.signedBy : ''); lines.push(name); }
  if (a.distinguishedName) lines.push(label(wording.distinguishedName, dn));
  if (a.reason && opts.reason) lines.push(label(wording.reason, opts.reason));
  if (a.location && opts.location) lines.push(label(wording.location, opts.location));
  if (a.date) lines.push(label(wording.date, displayDate(opts.date)));
  const shown = lines.filter(Boolean);
  let out = '', image = null;
  const enc = l => literal(winAnsiBytes(l));
  if (w > 1 && h > 1) {
    const pad = Math.min(6, Math.max(1, h * 0.06));
    const [leftW, rightX] = opts.graphic ? (shown.length ? [w * 0.5, w * 0.5 + pad] : [w, pad]) : a.name ? [w * 0.5, w * 0.5 + pad] : [0, pad];
    const rightW = Math.max(w - rightX - pad, 1);
    if (opts.graphic) { const g = drawGraphic(ctx, opts.graphic, [pad, pad, Math.max(leftW - 2 * pad, 0), Math.max(h - 2 * pad, 0)]); out += g.content; image = g.image; }
    out += 'BT\n0 g\n';
    if (a.name && !opts.graphic) {
      const fitW = Math.max(leftW - 2 * pad, 1);
      const size = Math.max(Math.min(h * 0.4, 36, fitW / Math.max(textWidth(name, 1), 0.01)), 4);
      const words = wrap(name, size, fitW);
      let y = (h + words.length * size * 1.1) / 2 - size * 0.85;
      for (const l of words) { out += `/Helv ${fmt(size)} Tf 1 0 0 1 ${fmt(pad)} ${fmt(y)} Tm ${enc(l)} Tj\n`; y -= size * 1.1; }
    }
    let size = Math.min(h / (Math.max(shown.length, 1) * 1.15), 12);
    let wrapped;
    for (;;) {
      wrapped = shown.flatMap(l => wrap(l, size, rightW));
      if (wrapped.length * size * 1.15 <= h - 2 * pad || size <= 3) break;
      size *= 0.9;
    }
    let y = h - pad - size * 0.9;
    for (const l of wrapped) { out += `/Helv ${fmt(size)} Tf 1 0 0 1 ${fmt(rightX)} ${fmt(y)} Tm ${enc(l)} Tj\n`; y -= size * 1.15; }
    out += 'ET\n';
  }
  const fonts = ctx.obj({Helv: ctx.obj({Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding'})});
  const res = ctx.obj({Font: fonts});
  if (image) res.set(N('XObject'), ctx.obj({Im1: image}));
  const d = {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: res};
  if (turn) {
    const m = turn === 90 ? [0, 1, -1, 0, rect[0] + rw, rect[1]] : turn === 180 ? [-1, 0, 0, -1, rect[0] + rw, rect[1] + rh] : [0, -1, 1, 0, rect[0], rect[1] + rh];
    d.Matrix = m;
  }
  return ctx.flateStream(ascii(out), d);
}

/** The kind of the last cross-reference section, and where it starts. */
function lastXref(bytes) {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail) ?? /startxref\s+(\d+)/.exec(tail.slice(tail.lastIndexOf('startxref')));
  if (!m) throw pdfErr('the file has no cross-reference section to append to');
  const at = Number(m[1]);
  const head = latin1(bytes.subarray(at, at + 32));
  return {at, stream: !/^\s*xref/.test(head)};
}

/**
 * Write `changed` objects of `doc` (loaded from `base`) as an incremental update of `base`.
 * @param {Uint8Array} base
 * @param {PDFDocument} doc
 * @param {Set<string>} changed object keys "num gen"
 */
export function writeIncremental(base, doc, changed) {
  const ctx = doc.context;
  const prev = lastXref(base);
  const parts = [base];
  let length = base.length;
  const push = b => { parts.push(b); length += b.length; };
  if (base[base.length - 1] !== 0x0a && base[base.length - 1] !== 0x0d) push(ascii('\n'));
  const offsets = new Map();
  const nums = [...changed].map(refFromKey).sort((a, b) => a.objectNumber - b.objectNumber);
  for (const ref of nums) {
    const obj = ctx.lookup(ref);
    if (obj === undefined) continue;
    offsets.set(ref.objectNumber, [length, ref.generationNumber]);
    push(ascii(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(encode(obj));
    push(ascii('\nendobj\n'));
  }
  const t = ctx.trailerInfo;
  const trailer = {Root: t.Root};
  if (t.Info) trailer.Info = t.Info;
  if (t.ID) trailer.ID = t.ID;
  let size = ctx.largestObjectNumber + 1;
  if (prev.stream) {
    // An uncompressed cross-reference stream (W [1 4 2]) for the updated objects and itself.
    const xrefNum = size;
    size += 1;
    const xrefAt = length;
    offsets.set(xrefNum, [xrefAt, 0]);
    const keys = [...offsets.keys()].sort((a, b) => a - b);
    const index = [], rows = [];
    for (let i = 0; i < keys.length;) {
      let j = i;
      while (j + 1 < keys.length && keys[j + 1] === keys[j] + 1) j++;
      index.push(keys[i], j - i + 1);
      for (let k = i; k <= j; k++) { const [off, gen] = offsets.get(keys[k]); rows.push(1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, (gen >> 8) & 255, gen & 255); }
      i = j + 1;
    }
    const data = Uint8Array.from(rows);
    const dict = ctx.obj({Type: 'XRef', Size: size, W: [1, 4, 2], Index: index, Prev: prev.at, Length: data.length});
    for (const [k, v] of Object.entries(trailer)) dict.set(N(k), v);
    const stream = PDFRawStream.of(dict, data);
    push(ascii(`${xrefNum} 0 obj\n`));
    push(encode(stream));
    push(ascii('\nendobj\n'));
    push(ascii(`startxref\n${xrefAt}\n%%EOF\n`));
  } else {
    const xrefAt = length;
    const keys = [...offsets.keys()].sort((a, b) => a - b);
    let s = 'xref\n';
    for (let i = 0; i < keys.length;) {
      let j = i;
      while (j + 1 < keys.length && keys[j + 1] === keys[j] + 1) j++;
      s += `${keys[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) { const [off, gen] = offsets.get(keys[k]); s += `${String(off).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`; }
      i = j + 1;
    }
    push(ascii(s));
    const td = ctx.obj({Size: size, Prev: prev.at});
    for (const [k, v] of Object.entries(trailer)) td.set(N(k), v);
    push(ascii('trailer\n'));
    push(encode(td));
    push(ascii(`\nstartxref\n${xrefAt}\n%%EOF\n`));
  }
  return concat(parts);
}

/** signing.rs `locate`: the ByteRange numbers' offset, and the `<…>` placeholder's span. */
function locate(out, reserve) {
  const s = latin1(out);
  const mark = `0 ${BR_MARK.join(' ')}`;
  const br = s.indexOf(mark);
  if (br < 0 || s.indexOf(mark, br + 1) >= 0) throw pdfErr('ByteRange placeholder not found');
  const start = s.lastIndexOf('obj', br);
  const end = s.indexOf('endobj', br);
  if (start < 0) throw pdfErr('signature object not found');
  if (end < 0) throw pdfErr('unterminated signature object');
  const zeros = `<${'0'.repeat(reserve * 2)}>`;
  const c = s.indexOf(zeros, start);
  if (c < 0 || c > end) throw pdfErr('Contents placeholder not found');
  return {br, gap: [c, c + zeros.length]};
}

const pdfText = s => (/^[\x20-\x7e]*$/.test(s) ? PDFString.of(s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')) : PDFHexString.fromText(s));

/**
 * signing.rs `sign`: sign `bytes` with digital ID `id` and return the signed file (an
 * incremental update). opts: {field?, page (0-based), rect? (user space; null: invisible),
 * newFieldName?, reason?, location?, contact?, date (PDF date), certify? (1–3), appearance?,
 * labels?, graphic?}.
 */
export async function sign(bytes, id, opts) {
  const doc = await load(bytes);
  const ctx = doc.context;
  if (ctx.trailerInfo.Encrypt) throw pdfErr("encrypted documents can't be signed yet: remove the security first, or sign an unencrypted copy");
  const baseNumber = ctx.largestObjectNumber;
  const changed = new Set();
  const touch = ref => { if (ref instanceof PDFRef) changed.add(keyOf(ref)); };
  const root = ctx.trailerInfo.Root;
  const alg = id.key.preferredDigest();
  const reserve = 8192 + id.certificate.raw.length + id.chain.reduce((a, c) => a + c.raw.length, 0);
  const name = id.certificate.displayName();
  const v = ctx.obj({Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'ETSI.CAdES.detached', ByteRange: [0, ...BR_MARK]});
  v.set(N('Contents'), PDFHexString.of('0'.repeat(reserve * 2)));
  v.set(N('M'), PDFString.of(opts.date));
  v.set(N('Name'), pdfText(name));
  for (const [k, val] of [['Reason', opts.reason], ['Location', opts.location], ['ContactInfo', opts.contact]]) if (val && String(val).trim()) v.set(N(k), pdfText(String(val)));
  v.set(N('Prop_Build'), ctx.obj({App: ctx.obj({Name: APP})}));
  if (opts.certify) {
    const tp = ctx.obj({Type: 'TransformParams', P: Math.min(3, Math.max(1, opts.certify)), V: '1.2'});
    v.set(N('Reference'), ctx.obj([ctx.obj({Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: tp})]));
  }
  const sig = ctx.register(v);
  touch(sig);
  const catalog = doc.catalog;
  if (opts.certify) { catalog.set(N('Perms'), ctx.obj({DocMDP: sig})); touch(root); }
  const pages = pageRefs(doc);
  let widget, rect, turn;
  if (opts.field) {
    const f = sigFields(doc).find(x => x.name === opts.field);
    if (!f) throw pdfErr(`there is no signature field "${opts.field}"`);
    if (fieldSignature(ctx, f)) throw pdfErr(`the field "${f.name}" is already signed`);
    if (hasForeignValue(ctx, f)) throw pdfErr(`the value of the field "${f.name}" is not a signature`);
    if (!f.ref) throw pdfErr('the field is not an indirect object');
    f.dict.set(N('V'), sig);
    touch(f.ref);
    const w = f.widgets[0];
    if (!w) throw pdfErr('the field has no widget');
    const r = nums(ctx, w.dict, 'Rect');
    rect = r && r.length === 4 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : [0, 0, 0, 0];
    widget = w.ref ?? f.ref;
    turn = mkRotation(ctx, w.dict);
    const af = catalog.get(N('AcroForm'));
    const afd = dictOf(ctx, af);
    if (afd) { afd.set(N('SigFlags'), PDFNumber.of(3)); touch(af instanceof PDFRef ? af : root); }
  } else {
    const page = pages[opts.page ?? 0];
    if (!page) throw pdfErr(`page ${(opts.page ?? 0) + 1} does not exist`);
    const taken = new Set(sigFields(doc).map(f => f.name));
    let fname = opts.newFieldName;
    for (let i = 1; !fname; i++) if (!taken.has(`Signature${i}`)) fname = `Signature${i}`;
    rect = opts.rect ?? [0, 0, 0, 0];
    const w = ctx.obj({Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, F: 4 | 128});
    w.set(N('T'), pdfText(fname));
    w.set(N('V'), sig);
    w.set(N('P'), page);
    turn = doc.getPages()[opts.page ?? 0].getRotation().angle;
    turn = ((turn % 360) + 360) % 360;
    if (turn) w.set(N('MK'), ctx.obj({R: turn}));
    const wr = ctx.register(w);
    touch(wr);
    const pd = dictOf(ctx, page);
    const annots = pd.get(N('Annots'));
    if (annots instanceof PDFRef && ctx.lookup(annots) instanceof PDFArray) { ctx.lookup(annots).push(wr); touch(annots); }
    else {
      const arr = ctx.obj([...(arrayOf(ctx, annots) ?? []), wr]);
      pd.set(N('Annots'), arr);
      touch(page);
    }
    const afRaw = catalog.get(N('AcroForm'));
    const af = afRaw instanceof PDFRef ? ctx.lookup(afRaw) : afRaw instanceof PDFDict ? afRaw : ctx.obj({});
    const fields = [...(arrayOf(ctx, af.get(N('Fields'))) ?? []), wr];
    af.set(N('Fields'), ctx.obj(fields));
    af.set(N('SigFlags'), PDFNumber.of(3));
    if (afRaw instanceof PDFRef) touch(afRaw);
    else { catalog.set(N('AcroForm'), af); touch(root); }
    widget = wr;
  }
  if (opts.graphic?.encoded) {
    // graphic.rs Graphic::Image from a PNG or JPEG file: pdf-lib decodes and embeds it.
    const bytes = opts.graphic.encoded;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    await img.embed();
    opts = {...opts, graphic: {embedded: {ref: img.ref, width: img.width, height: img.height}}};
  }
  const ap = ctx.register(appearanceStream(ctx, rect, turn, name, id.certificate, opts));
  touch(ap);
  dictOf(ctx, widget).set(N('AP'), ctx.obj({N: ap}));
  touch(widget);
  // New objects the appearance made (an image, its soft mask).
  for (const [r] of ctx.enumerateIndirectObjects()) if (r.objectNumber > baseNumber) touch(r);
  // /Info ModDate, as every save.
  const info = ctx.trailerInfo.Info;
  if (info instanceof PDFRef && ctx.lookup(info) instanceof PDFDict) { ctx.lookup(info).set(N('ModDate'), PDFString.of(opts.date)); touch(info); }
  const out = writeIncremental(bytes, doc, changed);
  const {br, gap: [start, end]} = locate(out, reserve);
  const width = `0 ${BR_MARK.join(' ')}`.length;
  const brText = `0 ${start} ${end} ${out.length - end}`;
  if (brText.length > width) throw pdfErr('the document is too large to sign');
  out.set(ascii(brText.padEnd(width, ' ')), br);
  const d = await digest(alg, [out.subarray(0, start), out.subarray(end)]);
  const cms = await signDetached(id.key, id.certificate, id.chain, alg, d);
  if (cms.length > reserve) throw pdfErr('the signature does not fit its placeholder');
  out.set(ascii(hex(cms)), start + 1);
  return out;
}

export {load as loadPdf, latin1};
