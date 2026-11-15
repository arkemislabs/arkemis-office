// Signing: Fill & Sign (typed text, dates, marks, saved signature and initials), digital IDs
// (create a self-signed ID, use one from a .pfx/.p12 file), certificate signing and certifying
// (visible or invisible) with an incremental save, and the Signatures panel with validation,
// trusted certificates and the certificate viewer.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:325-341   catalog ids, labels, Needs (Document, Annotate, Nothing)
//   crates/ui-egui/src/commands.rs:633-700  sign.digital/certify (drag the signature area),
//                                           certify_invisible (straight to the dialog), validate
//                                           (re-check with the trusted certificates, open the panel),
//                                           panel, fill tools (pad when nothing is saved), remove/change
//   crates/ui-egui/src/tools/fill_sign.rs   typed, place, page_input (lib/sign-fill.mjs)
//   crates/ui-egui/src/tools/sign_ui.rs     DigitalIdEntry, KEY_ALGORITHMS, NewIdDraft, SignGraphic,
//                                           SignDraft, create_digital_id (self-signed, 5 years, serial
//                                           from SHA-256(name, now)), import_digital_id, finish_signing
//                                           (Save As "<stem>_signed.pdf", then the signed file is the
//                                           document), trust_certificate, remove_digital_id, entry_for
//   crates/ui-egui/src/tools/sign_ui/panel.rs   the panel's rows, certificate viewer (cert_viewer, certificate_pem)
//   crates/sign/src/**                      lib/sign-*.mjs
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/sign.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {createAnnotation} from '../model/annots.mjs';
import {annotateState, meta, author, toolStyle} from '../model/index.mjs';
import {viewToUser, userRectToView, pageRotation} from '../lib/geom.mjs';
import {pagesOf, currentPage, annotAddress, pointParam, rectParam, pageParam, rgbOf} from '../lib/comment-geometry.mjs';
import {FILL_TOOLS, MARK_LABELS, TEXT_SIZE, validTextSize, formatDate, DATE_FORMATS, DEFAULT_DATE_FORMAT, typedTop, typedShape, markShape, initialsOf,
  signatureShape, imageRect, savedSig, savedGraphic, typedPlacement} from '../lib/sign-fill.mjs';
import {scriptMissing, MAX_SIGNATURE_CHARS} from '../lib/sign-script.mjs';
import {pictureStamp} from './comment.mjs';
import {readOther, writeOther, interactive, readState, stem} from '../lib/page-files.mjs';
import {base64} from '../lib/page-source.mjs';
import {listSignatures, sign as signPdf, TrustStore, Status, DEFAULT_APPEARANCE} from '../lib/sign-pdf.mjs';
import {saveIncremental, contentFromBytes} from '../lib/sign-incremental.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {open as openP12, write as writeP12, DigitalId, MIN_PASSWORD_CHARS} from '../lib/sign-pkcs12.mjs';
import {PrivateKey, Certificate, Name, loadCertificates} from '../lib/sign-x509.mjs';
import {Time, fromBase64, toBase64, hex} from '../lib/sign-der.mjs';
import {DigestAlg, digest} from '../lib/sign-crypto.mjs';
import {pdfDate} from '../lib/dates.mjs';
import pad from '../dialogs/signature-pad.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/fill_sign.rs', 'crates/ui-egui/src/tools/sign_ui.rs',
    'crates/ui-egui/src/tools/sign_ui/dialog.rs', 'crates/ui-egui/src/tools/sign_ui/panel.rs', 'crates/engine/src/fill_sign.rs', 'crates/engine/src/signature_image.rs',
    'crates/sign/src/pdf/signing.rs', 'crates/sign/src/pdf/validate.rs', 'crates/sign/src/pkcs12.rs', 'crates/sign/src/x509.rs']};

/** sign_ui.rs `KEY_ALGORITHMS`. */
export const KEY_ALGORITHMS = Object.freeze([['2048-bit RSA', 'rsa2048'], ['3072-bit RSA', 'rsa3072'], ['4096-bit RSA', 'rsa4096'], ['256-bit ECDSA (P-256)', 'p256']]);
/** sign_ui.rs certify levels: 1 no changes, 2 form fill and signing, 3 also comments. */
export const PERMITTED = Object.freeze(['No changes allowed', 'Form fill-in and digital signatures', 'Annotations, form fill-in, and digital signatures']);

const now = ctx => (typeof ctx.host?.now === 'function' ? ctx.host.now() : Date.now());
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : {enabled: false, reason: 'no PDF open'});
const user = (page, p) => viewToUser(page, p[0], p[1]);

function add(ctx, pi, page, shape, contents, label, p = {}) {
  const style = toolStyle(ctx, 'sign.fill', shape);
  if (p.color) style.color = rgbOf(p.color);
  const record = createAnnotation({shape, style, contents: contents ?? '', author: author(ctx), rotation: pageRotation(page)}, meta(ctx));
  ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
  ctx.setUndoLabel(label);
  return {id: record.id, annotation: annotAddress(page, record), rect: userRectToView(page, record.dict.Rect)};
}

/** commands.rs: picking a Fill & Sign tool makes it the quick tool. */
function pickFill(ctx, id) { ctx.setView({tool: id, highlighter: false}); return {tool: id}; }

const fillSign = ctx => ctx.prefs?.fillSign ?? {};
const saved = (ctx, initials) => savedSig(fillSign(ctx)[initials ? 'initials' : 'signature']);

// ── digital IDs (sign_ui.rs) ───────────────────────────────────────────────────────────────

const ids = ctx => (Array.isArray(ctx.prefs?.digitalIds) ? ctx.prefs.digitalIds : []);
const trusted = ctx => (Array.isArray(ctx.prefs?.trustedCertificates) ? ctx.prefs.trustedCertificates : []);
function trustStore(ctx) {
  const certs = [];
  for (const pem of trusted(ctx)) { try { certs.push(...loadCertificates(new TextEncoder().encode(pem))); } catch { /* a damaged entry is skipped */ } }
  return new TrustStore(certs);
}

/** sign_ui.rs `entry_for`: what the Choose list shows for an ID. */
function entryFor(where, cert, extra = {}) {
  return {path: where.path ?? null, p12: where.p12 ?? null, name: cert.displayName(), issuer: cert.issuer.displayName(), email: cert.subject.email() ?? '',
    expires: cert.notAfter.toString(), fingerprint: cert.fingerprint(), ...extra};
}
function findId(ctx, ref) {
  const list = ids(ctx);
  if (ref == null) { const first = list.find(e => !e.unusable); if (!first) throw new CommandError('invalid_params', 'Choose a digital ID.', {path: '/digitalId'}); return first; }
  const e = typeof ref === 'number' ? list[ref] : list.find(x => x.fingerprint === ref || x.path === ref || x.name === ref);
  if (!e || e.unusable) throw new CommandError('not_found', 'Choose a digital ID.', {path: '/digitalId'});
  return e;
}

async function openId(ctx, entry, password) {
  let bytes;
  if (entry.p12) bytes = fromBase64(entry.p12);
  else {
    const f = ctx.host?.files;
    if (typeof f?.readFile !== 'function') throw new CommandError('unavailable', "this build can't read the digital ID file yet");
    const r = await f.readFile(entry.path, {maxBytes: 1 << 20});
    bytes = fromBase64(r.base64);
  }
  try { return await openP12(bytes, password); } catch (e) {
    if (e.kind === 'wrong_password') throw new CommandError('invalid_params', 'The password is incorrect.', {path: '/password'});
    throw new CommandError('failed', e.message);
  }
}

/** panel.rs cert_viewer: one certificate's Summary and Details. */
export function certificateDetails(c) {
  // x509.rs: keyUsage bit i is KeyUsage bit i of RFC 5280 (0 = digitalSignature).
  const bits = ['Digital Signature', 'Non-Repudiation', 'Key Encipherment', 'Data Encipherment', 'Key Agreement', 'Certificate Signing', 'CRL Signing', 'Encipher Only', 'Decipher Only'];
  const usage = c.keyUsage == null ? [] : bits.filter((_, i) => c.keyUsage & (1 << i));
  const eku = {'1.3.6.1.5.5.7.3.4': 'Email Protection', '1.2.840.113583.1.1.5': 'Adobe Authentic Documents Trust', '1.3.6.1.5.5.7.3.3': 'Code Signing',
    '1.3.6.1.5.5.7.3.8': 'Time Stamping', '1.3.6.1.4.1.311.10.3.12': 'Document Signing', '1.3.6.1.5.5.7.3.36': 'Document Signing', '2.5.29.37.0': 'Any Purpose'};
  return {
    issuedTo: c.subject.display(), issuedBy: c.issuer.display(), name: c.displayName(), issuer: c.issuer.displayName(),
    validFrom: c.notBefore.toString(), validTo: c.notAfter.toString(), version: c.version + 1, serial: c.serialHex(), publicKey: c.publicKey.describe(),
    keyUsage: c.keyUsage == null ? 'Not present' : usage.join(', '), extendedKeyUsage: c.extendedKeyUsage ? c.extendedKeyUsage.map(o => eku[o] ?? o).join(', ') : 'Not present',
    basicConstraints: c.hasBasicConstraints ? (c.isCa ? 'Certificate authority: Yes' : 'Certificate authority: No') : 'Not present',
    sha256: c.fingerprint(), sha1: c.sha1Fingerprint(), selfSigned: hex(c.issuer.raw) === hex(c.subject.raw), pem: c.toPem(),
    extensions: c.extensions.map(e => ({oid: e.oid, critical: e.critical})),
  };
}

/** The bytes the open document stands for: its source when unchanged, else appended to it incrementally (or rewritten). */
async function documentBytes(content) {
  const inc = await saveIncremental(content);
  if (inc) return inc;
  return writeFolioPdf(content);
}

/** panel.rs rows: one per signature field, validated. */
async function validate(ctx) {
  const bytes = await documentBytes(ctx.doc);
  const list = await listSignatures(bytes, trustStore(ctx));
  return list.map((i, n) => ({
    index: n, field: i.field, signed: i.signed, summary: i.summary, status: i.status, signer: i.signer, page: i.page == null ? null : i.page + 1,
    rect: i.rect && i.page != null && pagesOf(ctx)[i.page] ? userRectToView(pagesOf(ctx)[i.page], i.rect) : null, visible: i.visible,
    date: i.date, signingTime: i.signingTime ? i.signingTime.toString() : null, reason: i.reason, location: i.location, contact: i.contact,
    certify: i.certify, revision: i.revision, subFilter: i.subFilter, algorithm: i.algorithm, digest: i.digest, timestamp: i.timestamp,
    modification: i.modification, details: i.details, chain: (i.chain ?? []).map(certificateDetails), certificate: i.certificate ? certificateDetails(i.certificate) : null,
  }));
}

/** The signature-area params of sign.digital / sign.certify (sign_ui.rs SignDraft). */
const signParams = {
  page: pageParam,
  rect: s.optional(rectParam('The visible signature\'s area [x, y, width, height] in page view points')),
  field: s.optional(s.string({min: 1, max: 1000, description: 'Sign this empty signature field instead'})),
  digitalId: s.optional(s.union([s.integer({min: 0, max: 1000}), s.string({min: 1, max: 4096})], {description: 'A listed digital ID: index, fingerprint, path or name (default: the first)'})),
  password: s.optional(s.secret({max: 1000, description: "The digital ID's password"})),
  reason: s.optional(s.string({max: 1000})), location: s.optional(s.string({max: 1000})),
  appearance: s.optional(s.object({name: s.optional(s.boolean()), date: s.optional(s.boolean()), reason: s.optional(s.boolean()), location: s.optional(s.boolean()),
    distinguishedName: s.optional(s.boolean()), labels: s.optional(s.boolean())}, {description: 'What the visible signature shows (Configure Signature Appearance)'})),
  graphic: s.optional(s.enum(['name', 'fillsign', 'image', 'none'], {description: "The left side: the signer's name, the saved Fill & Sign signature, an image, or nothing"})),
  imageBase64: s.optional(s.string({max: 6_000_000, description: 'The image (PNG or JPEG) for graphic "image"'})),
  path: s.optional(s.string({min: 1, max: 4096, description: 'Where the signed file is saved (from the window: the system Save dialog)'})),
};

async function finishSigning(ctx, p, certify) {
  if (!pagesOf(ctx).length) throw new CommandError('disabled', 'no PDF open');
  const visible = !!p.rect || !!p.field;
  const invisibleCertify = certify && !visible;
  if (!visible && !invisibleCertify) {
    // commands.rs:633: drag the area where the signature should appear.
    ctx.setView({tool: certify ? 'sign.certify' : 'sign.digital'});
    return {tool: certify ? 'sign.certify' : 'sign.digital', notice: 'Drag to draw the area where the signature should appear.'};
  }
  const entry = findId(ctx, p.digitalId);
  if (p.password == null) throw new CommandError('invalid_params', "Enter the digital ID's password.", {path: '/password'});
  const id = await openId(ctx, entry, p.password);
  const problem = id.certificate.signingProblem();
  if (problem) throw new CommandError('failed', problem);
  let rect = null, pageIndex = 0;
  if (p.rect) {
    const {pi, page} = currentPage(ctx, p.page);
    pageIndex = pi;
    const a = user(page, [p.rect[0], p.rect[1]]), b = user(page, [p.rect[0] + p.rect[2], p.rect[1] + p.rect[3]]);
    rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4) throw new CommandError('invalid_params', 'Drag a larger area for the signature.', {path: '/rect'});
  } else if (!p.field) pageIndex = currentPage(ctx, p.page).pi;
  let graphic = null;
  const choice = p.graphic ?? ctx.prefs?.signGraphic ?? 'name';
  if (visible && choice === 'fillsign') {
    graphic = savedGraphic(saved(ctx, false));
    if (!graphic) throw new CommandError('failed', 'The saved signature has nothing to draw.');
  } else if (visible && choice === 'image') {
    if (!p.imageBase64) throw new CommandError('invalid_params', 'Choose an image for the signature.', {path: '/imageBase64'});
    graphic = {encoded: fromBase64(p.imageBase64)};
  }
  const appearance = {...DEFAULT_APPEARANCE, ...(p.appearance ?? {})};
  if (visible && choice === 'none') appearance.name = false;
  const level = certify ? (p.permitted ?? 2) : null;
  const before = await documentBytes(ctx.doc);
  const opts = {page: pageIndex, rect, field: p.field ?? undefined, reason: p.reason, location: p.location, date: pdfDate(now(ctx)),
    certify: level ?? undefined, appearance, graphic: graphic ?? undefined};
  // finish_signing: signing saves, as in Acrobat; a cancelled Save cancels signing.
  const name = ctx.file?.title ?? ctx.file?.name ?? 'Untitled';
  let path = p.path ?? null;
  if (!path && interactive(ctx)) {
    const f = ctx.host?.files;
    if (typeof f?.pickSave !== 'function') throw new CommandError('unavailable', 'The Save dialog is not available here');
    const picked = await f.pickSave({kind: ctx.app, doc: ctx.docId, mode: 'copy', title: 'Save As', name: `${stem(name) || 'Untitled'}_signed.pdf`, filters: [{name: 'Adobe PDF Files', extensions: ['pdf']}], format: 'pdf'});
    if (!picked?.path) return {canceled: true};
    path = picked.path;
  }
  let signed;
  try { signed = await signPdf(before, id, opts); } catch (e) { throw new CommandError('failed', e.message); }
  const out = await writeOther(ctx, {path}, signed, {title: 'Save As', name: `${stem(name) || 'Untitled'}_signed.pdf`});
  const next = await contentFromBytes(ctx.doc, signed);
  for (const k of ['sourceBase64', 'pages', 'fields']) ctx.change.set([k], next[k]);
  ctx.setView({rightPanel: 'signatures', tool: null});
  if (p.graphic) ctx.updatePrefs({signGraphic: p.graphic});
  ctx.setUndoLabel(certify ? 'Certify' : 'Sign');
  const list = await listSignatures(signed, trustStore(ctx));
  const mine = list[list.length - 1];
  return {path: out.path ?? null, ...(out.base64 ? {base64: out.base64} : {}), field: mine?.field, status: mine?.status, summary: mine?.summary, signer: id.certificate.displayName()};
}

// ── commands ───────────────────────────────────────────────────────────────────────────────

function markTool(id) {
  const [label, mark] = FILL_TOOLS[id];
  return {
    id, label: `Fill & Sign: ${{Check: 'checkmark', Cross: 'cross', Dot: 'dot', Line: 'line'}[mark]}`, risk: 'edit',
    description: `Fill & Sign ${label}: a ${label.toLowerCase()} mark centred at \`at\` (page view points), 12 × 12 pt (the line 36 × 4), turned with the page. Without \`at\`, picks the tool.`,
    params: s.object({page: pageParam, at: s.optional(pointParam('Centre [x, y] in page view points')), color: s.optional(s.color())}),
    state: ctx => ({...annotateState(ctx.doc ?? {}), checked: ctx.view?.tool === id}),
    run(ctx, p) {
      if (!p.at) return pickFill(ctx, id);
      const {pi, page} = currentPage(ctx, p.page);
      return add(ctx, pi, page, markShape(mark, user(page, p.at), pageRotation(page)), '', MARK_LABELS[mark], p);
    },
  };
}

function placeSignature(id, initials) {
  const what = initials ? 'initials' : 'signature';
  return {
    id, label: initials ? 'Fill & Sign: initials' : 'Fill & Sign: sign', risk: 'edit', dialog: 'dialog.signature-pad',
    description: `Place the saved ${what} with its left edge at \`at\` (page view points), centred vertically, upright as the page is displayed: drawn strokes 150 pt wide, typed text in the script face ${initials ? 24 : 32} pt tall, an image at most 150 × ${initials ? 24 : 32} pt (fill_sign.rs place). With nothing saved, the signature pad opens.`,
    params: s.object({page: pageParam, at: s.optional(pointParam('Left edge [x, y] in page view points'))}),
    state: ctx => ({...annotateState(ctx.doc ?? {}), checked: ctx.view?.tool === id}),
    async run(ctx, p) {
      const sig = saved(ctx, initials);
      if (!p.at) {
        pickFill(ctx, id);
        if (!sig && interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
          const values = await ctx.host.openDialog('dialog.signature-pad', {initials});
          if (!values) return {tool: id};
          const call = pad.toCommand(values);
          await ctx.run(call.command, call.params);
        }
        return {tool: id, saved: !!saved(ctx, initials)};
      }
      if (!sig) throw new CommandError('disabled', `Create your ${what} first (Fill & Sign: change ${what}).`);
      const {pi, page} = currentPage(ctx, p.page);
      const at = user(page, p.at), rot = pageRotation(page);
      const label = initials ? 'Add initials' : 'Add signature';
      if (sig.image) {
        const bytes = fromBase64(sig.image);
        const size = sig.width && sig.height ? [sig.width, sig.height] : null;
        let rect = size ? imageRect(rot, at, size[0], size[1], initials) : null;
        if (!rect) rect = [at[0], at[1], at[0], at[1]];
        const record = await pictureStamp(ctx, page, bytes, rect, {name: initials ? 'Initials' : 'Signature', author: author(ctx), fillSign: true, label: 'Signature'});
        ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
        ctx.setUndoLabel(label);
        return {id: record.id, annotation: annotAddress(page, record), rect: userRectToView(page, record.dict.Rect)};
      }
      const shape = sig.drawn ? signatureShape(at, sig.drawn, rot) : typedPlacement(at, sig.typed, rot, initials);
      if (!shape) throw new CommandError('failed', `The saved ${what} has nothing to draw.`);
      return add(ctx, pi, page, shape, '', label);
    },
  };
}

function changeSaved(id, initials) {
  const what = initials ? 'initials' : 'signature';
  return {
    id, label: initials ? 'Fill & Sign: change initials' : 'Fill & Sign: change signature', risk: 'read', undo: 'none', dialog: 'dialog.signature-pad',
    description: `Create or change the saved ${what} (the signature pad's Apply): \`typed\` text in the script face, \`drawn\` strokes (x 0–1 across the pad, y up, in pad widths) or an \`image\` (PNG/JPEG base64, \`path\`, or the system Open dialog). Kept in Preferences, never in a document.`,
    params: s.object({typed: s.optional(s.string({max: 1000})), drawn: s.optional(s.array(s.array(pointParam('[x, y]'), {max: 20000}), {max: 500})),
      image: s.optional(s.string({max: 6_000_000})), path: s.optional(s.string({min: 1, max: 4096})), pickImage: s.optional(s.boolean())}),
    async run(ctx, p) {
      let value;
      if (p.typed != null) {
        const t = p.typed.trim();
        if (!t) throw new CommandError('invalid_params', `Type your ${what}.`, {path: '/typed'});
        if (Array.from(t).length > MAX_SIGNATURE_CHARS) throw new CommandError('invalid_params', `At most ${MAX_SIGNATURE_CHARS} characters.`, {path: '/typed'});
        const missing = scriptMissing(t);
        if (missing) throw new CommandError('invalid_params', `The signature font can't draw "${missing}". Draw your ${what} or use an image instead.`, {path: '/typed'});
        value = {typed: t};
      } else if (p.drawn) {
        if (!p.drawn.some(st => st.length > 1)) throw new CommandError('invalid_params', `Draw your ${what} below.`, {path: '/drawn'});
        value = {drawn: p.drawn.filter(st => st.length)};
      } else if (p.image || p.path || p.pickImage) {
        const file = p.image ? {bytes: fromBase64(p.image)} : await readOther(ctx, {path: p.path}, {title: 'Open', filters: [{name: 'Images', extensions: ['png', 'jpg', 'jpeg']}]});
        if (!file) return {canceled: true};
        if (file.bytes.length > 4 << 20) throw new CommandError('too_large', 'Choose a PNG or JPEG image of up to 4 MB.');
        const b = file.bytes;
        const png = b[0] === 0x89 && b[1] === 0x50, jpg = b[0] === 0xff && b[1] === 0xd8;
        if (!png && !jpg) throw new CommandError('invalid_params', 'Choose a PNG or JPEG image.');
        const size = png ? [new DataView(b.buffer, b.byteOffset).getUint32(16), new DataView(b.buffer, b.byteOffset).getUint32(20)] : jpegSize(b);
        value = {image: toBase64(b), width: size?.[0], height: size?.[1]};
      } else if (interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
        // From the menu: the signature pad (commands.rs:682), and Apply runs this again with its values.
        const values = await ctx.host.openDialog('dialog.signature-pad', {initials});
        if (!values) return {canceled: true};
        const call = pad.toCommand(values);
        return ctx.run(call.command, call.params);
      } else throw new CommandError('invalid_params', `Type, draw or choose an image for your ${what}.`);
      ctx.updatePrefs({fillSign: {...fillSign(ctx), [initials ? 'initials' : 'signature']: value}});
      return {saved: Object.keys(value)[0]};
    },
  };
}

function jpegSize(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
    i += 2 + len;
  }
  return null;
}

export default defineCommands({
  family: 'sign',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'sign.fill.text', label: 'Fill & Sign: add text', risk: 'edit',
      description: 'Fill & Sign Add text: typed text (a typewriter annotation sized to its text) starting 0.6 em above `at`, as displayed (fill_sign.rs typed, 10 pt by default). Without `at`, picks the tool.',
      params: s.object({page: pageParam, at: s.optional(pointParam('Where the person clicked [x, y] in page view points')), text: s.optional(s.string({max: 10000})),
        fontSize: s.optional(s.number({min: 4, max: 300})), color: s.optional(s.color())}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: ctx.view?.tool === 'sign.fill.text'}),
      run(ctx, p) {
        if (!p.at) return pickFill(ctx, 'sign.fill.text');
        const txt = (p.text ?? '').trim();
        if (!txt) throw new CommandError('invalid_params', 'type the text first', {path: '/text'});
        const size = validTextSize(p.fontSize ?? ctx.prefs?.fillSign?.textSize ?? TEXT_SIZE) ?? TEXT_SIZE;
        const {pi, page} = currentPage(ctx, p.page);
        const rot = pageRotation(page);
        return add(ctx, pi, page, typedShape(typedTop(rot, user(page, p.at), size), txt, size, rot), txt, 'Add text', p);
      },
    },
    markTool('sign.fill.check'), markTool('sign.fill.cross'), markTool('sign.fill.dot'), markTool('sign.fill.line'),
    {
      id: 'sign.fill.date', label: 'Fill & Sign: date', risk: 'edit',
      description: `Fill & Sign Date: today's date in Preferences ▸ Date format (default ${DEFAULT_DATE_FORMAT}; \`format\` overrides) as typed text at \`at\`. Without \`at\`, picks the tool.`,
      params: s.object({page: pageParam, at: s.optional(pointParam('[x, y] in page view points')), format: s.optional(s.string({min: 1, max: 64, description: `A date pattern, e.g. ${DATE_FORMATS.slice(0, 4).join(', ')}`})),
        fontSize: s.optional(s.number({min: 4, max: 300}))}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: ctx.view?.tool === 'sign.fill.date'}),
      run(ctx, p) {
        if (!p.at) return pickFill(ctx, 'sign.fill.date');
        const txt = formatDate(now(ctx), p.format ?? ctx.prefs?.dateFormat ?? DEFAULT_DATE_FORMAT);
        const size = validTextSize(p.fontSize ?? ctx.prefs?.fillSign?.textSize ?? TEXT_SIZE) ?? TEXT_SIZE;
        const {pi, page} = currentPage(ctx, p.page);
        const rot = pageRotation(page);
        return {...add(ctx, pi, page, typedShape(typedTop(rot, user(page, p.at), size), txt, size, rot), txt, 'Add text'), text: txt};
      },
    },
    placeSignature('sign.fill.signature', false),
    placeSignature('sign.fill.initials', true),
    changeSaved('sign.fill.signature.change', false),
    changeSaved('sign.fill.initials.change', true),
    {
      id: 'sign.fill.signature.remove', label: 'Fill & Sign: remove saved signature', risk: 'read', undo: 'none',
      description: 'Forget the saved Fill & Sign signature (placed ones stay in their documents).',
      params: s.object({}),
      state: ctx => (saved(ctx, false) ? {enabled: true} : {enabled: false, reason: 'no signature is saved'}),
      run(ctx) { const fs = {...fillSign(ctx)}; delete fs.signature; ctx.updatePrefs({fillSign: fs}); return {removed: 'signature'}; },
    },
    {
      id: 'sign.fill.initials.remove', label: 'Fill & Sign: remove saved initials', risk: 'read', undo: 'none',
      description: 'Forget the saved Fill & Sign initials.',
      params: s.object({}),
      state: ctx => (saved(ctx, true) ? {enabled: true} : {enabled: false, reason: 'no initials are saved'}),
      run(ctx) { const fs = {...fillSign(ctx)}; delete fs.initials; ctx.updatePrefs({fillSign: fs}); return {removed: 'initials'}; },
    },
    {
      id: 'sign.fill.saved', label: 'Saved signature', risk: 'read', undo: 'none',
      description: 'The saved Fill & Sign signature and initials (for the Sign menu and the pad), and the initials the pad suggests from the author name.',
      params: s.object({}),
      run(ctx) {
        const view = v => (v ? (v.typed ? {typed: v.typed} : v.drawn ? {drawn: v.drawn} : {image: true, width: v.width, height: v.height}) : null);
        return {signature: view(saved(ctx, false)), initials: view(saved(ctx, true)), author: author(ctx), suggestedInitials: initialsOf(author(ctx))};
      },
    },
    // ── certificates ──
    {
      id: 'sign.digital', label: 'Digitally sign', risk: 'irreversible', needs: 'worker', dialog: 'dialog.sign-digital-id',
      description: 'Digitally sign with a digital ID: a visible signature in `rect` (or the empty signature field `field`), CMS (ETSI.CAdES.detached, SHA-256) over the whole file, written as an incremental update and saved to a new file (Save As "<name>_signed.pdf"); the signed file becomes the document. Without an area, picks the drag tool.',
      params: s.object(signParams),
      summary: (ctx, p) => `Sign the document${p.field ? ` in field ${p.field}` : ''} and save the signed copy${p.path ? ` to ${p.path}` : ''}`,
      state: documentState,
      run: (ctx, p) => finishSigning(ctx, p, false),
    },
    {
      id: 'sign.certify', label: 'Certify (visible signature)', risk: 'irreversible', needs: 'worker', dialog: 'dialog.sign-digital-id',
      description: 'Certify with a visible signature: as Digitally sign, plus a DocMDP certification that says which changes stay allowed (`permitted`: 1 none, 2 form fill-in and signing, 3 also comments).',
      params: s.object({...signParams, permitted: s.optional(s.integer({min: 1, max: 3}))}),
      summary: () => 'Certify the document and save the certified copy',
      state: documentState,
      run: (ctx, p) => finishSigning(ctx, p, true),
    },
    {
      id: 'sign.certify_invisible', label: 'Certify (invisible signature)', risk: 'irreversible', needs: 'worker', dialog: 'dialog.sign-digital-id',
      description: 'Certify with an invisible signature (DocMDP `permitted` 1–3, default 2), saved to a new file.',
      params: s.object({...signParams, permitted: s.optional(s.integer({min: 1, max: 3}))}),
      summary: () => 'Certify the document (invisible signature) and save the certified copy',
      state: documentState,
      run: (ctx, p) => finishSigning(ctx, {...p, rect: undefined, field: undefined}, true),
    },
    {
      id: 'sign.validate', label: 'Validate all signatures', risk: 'read', undo: 'none', needs: 'worker',
      description: 'Validate every signature against the document as it is now and the trusted certificates, and show the Signatures panel: valid, invalid or unknown signer, and what changed after signing.',
      params: s.object({}),
      state: documentState,
      async run(ctx) {
        if (!pagesOf(ctx).length) throw new CommandError('disabled', 'no PDF open');
        ctx.setView({rightPanel: 'signatures'});
        return {signatures: await validate(ctx)};
      },
    },
    {
      id: 'sign.panel', label: 'Signatures panel', risk: 'read', undo: 'none', needs: 'worker',
      description: 'Show (or hide) the Signatures panel and list the signatures with their validation.',
      params: s.object({open: s.optional(s.boolean())}),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.rightPanel === 'signatures'}),
      async run(ctx, p) {
        if (!pagesOf(ctx).length) throw new CommandError('disabled', 'no PDF open');
        const open = p.open ?? ctx.view?.rightPanel !== 'signatures';
        ctx.setView({rightPanel: open ? 'signatures' : null});
        return {open, signatures: open ? await validate(ctx) : []};
      },
    },
    {
      id: 'sign.certificate', label: 'Certificate details', risk: 'read', undo: 'none', needs: 'worker', dialog: 'dialog.certificate-viewer',
      description: "A signature's certificate chain for the Certificate Viewer (Summary, Details, Trust): by `field` (default: the first signed field).",
      params: s.object({field: s.optional(s.string({min: 1, max: 1000}))}),
      async run(ctx, p) {
        const list = await validate(ctx);
        const row = p.field ? list.find(r => r.field === p.field) : list.find(r => r.signed);
        if (!row?.certificate) throw new CommandError('not_found', p.field ? `the field ${p.field} has no certificate` : 'the document has no signed signature');
        const store = trustStore(ctx);
        const trustedNow = row.chain.some(c => store.certs.some(t => t.fingerprint() === c.sha256));
        return {field: row.field, chain: row.chain.length ? row.chain : [row.certificate], trusted: trustedNow, status: row.status};
      },
    },
    {
      id: 'sign.trust', label: 'Add to Trusted Certificates', risk: 'read', undo: 'none', needs: 'worker',
      description: "Trust a certificate for validating signatures (Certificate Viewer ▸ Trust ▸ Add to Trusted Certificates): a signature's certificate by `field` (and `level` in its chain), or a PEM/DER certificate as `pem`/`base64`.",
      params: s.object({field: s.optional(s.string({min: 1, max: 1000})), level: s.optional(s.integer({min: 0, max: 10})), pem: s.optional(s.string({max: 100000})), base64: s.optional(s.string({max: 200000}))}),
      async run(ctx, p) {
        let certs;
        if (p.pem) certs = loadCertificates(new TextEncoder().encode(p.pem));
        else if (p.base64) certs = loadCertificates(fromBase64(p.base64));
        else {
          const list = await validate(ctx);
          const row = p.field ? list.find(r => r.field === p.field) : list.find(r => r.signed);
          const c = row?.chain?.[p.level ?? 0] ?? row?.certificate;
          if (!c) throw new CommandError('not_found', 'there is no certificate to trust');
          certs = loadCertificates(new TextEncoder().encode(c.pem));
        }
        const have = trusted(ctx);
        const add = certs.map(c => c.toPem()).filter(pem => !have.includes(pem));
        ctx.updatePrefs({trustedCertificates: [...have, ...add]});
        return {trusted: certs.map(c => c.displayName()), added: add.length};
      },
    },
    {
      id: 'sign.untrust', label: 'Remove from Trusted Certificates', risk: 'read', undo: 'none',
      description: 'Stop trusting a certificate (by SHA-256 fingerprint).',
      params: s.object({fingerprint: s.string({min: 1, max: 200})}),
      run(ctx, p) {
        const keep = trusted(ctx).filter(pem => { try { return loadCertificates(new TextEncoder().encode(pem))[0].fingerprint() !== p.fingerprint; } catch { return true; } });
        ctx.updatePrefs({trustedCertificates: keep});
        return {trusted: keep.length};
      },
    },
    {
      id: 'sign.certificate.export', label: 'Export certificate…', risk: 'read', undo: 'none', needs: 'worker',
      description: "Export a signature's certificate as PEM (Certificate Viewer ▸ Export…) to `path`, the system Save dialog, or returned as `pem`.",
      params: s.object({field: s.optional(s.string({min: 1, max: 1000})), level: s.optional(s.integer({min: 0, max: 10})), path: s.optional(s.string({min: 1, max: 4096}))}),
      async run(ctx, p) {
        const list = await validate(ctx);
        const row = p.field ? list.find(r => r.field === p.field) : list.find(r => r.signed);
        const c = row?.chain?.[p.level ?? 0] ?? row?.certificate;
        if (!c) throw new CommandError('not_found', 'there is no certificate to export');
        const out = await writeOther(ctx, p, new TextEncoder().encode(c.pem), {title: 'Export Certificate', name: `${c.name.replace(/[\\/:*?"<>|]/g, '_')}.pem`, filters: [{name: 'Certificate', extensions: ['pem', 'cer']}]});
        if (out.canceled) return {canceled: true};
        return out.path ? {path: out.path} : {pem: c.pem};
      },
    },
    // ── digital IDs ──
    {
      id: 'sign.id.list', label: 'Digital IDs', risk: 'read', undo: 'none',
      description: 'The digital IDs this app knows (Sign with a Digital ID ▸ Choose): name, issuer, email, expiry, fingerprint.',
      params: s.object({}),
      run: ctx => ({ids: ids(ctx).map((e, i) => ({index: i, name: e.name, issuer: e.issuer, email: e.email, expires: e.expires, fingerprint: e.fingerprint, path: e.path, unusable: e.unusable ?? null}))}),
    },
    {
      id: 'sign.id.create', label: 'Create a new Digital ID', risk: 'read', undo: 'none', needs: 'worker',
      description: `Configure New Digital ID ▸ Create: a self-signed ID (valid 5 years, for signing documents) saved to a password-protected .p12 (at least ${MIN_PASSWORD_CHARS} characters): to \`path\` when given, else kept with the app's settings. Key: ${KEY_ALGORITHMS.map(k => k[0]).join(', ')}.`,
      params: s.object({name: s.string({min: 1, max: 200}), unit: s.optional(s.string({max: 200})), organization: s.optional(s.string({max: 200})),
        email: s.optional(s.string({max: 320})), country: s.optional(s.string({max: 2})), algorithm: s.optional(s.enum(KEY_ALGORITHMS.map(k => k[1]))),
        password: s.secret({max: 1000}), confirm: s.secret({max: 1000}), path: s.optional(s.string({min: 1, max: 4096})), rounds: s.optional(s.integer({min: 1000, max: 600000}))}),
      async run(ctx, p) {
        if (!p.name.trim()) throw new CommandError('invalid_params', 'Enter a name.', {path: '/name'});
        if (Array.from(p.password).length < MIN_PASSWORD_CHARS) throw new CommandError('invalid_params', 'The password must have at least 8 characters.', {path: '/password'});
        if (p.password !== p.confirm) throw new CommandError('invalid_params', 'The passwords do not match.', {path: '/confirm'});
        const alg = p.algorithm ?? 'rsa2048';
        const key = alg === 'p256' ? await PrivateKey.generateP256() : await PrivateKey.generateRsa(alg === 'rsa4096' ? 4096 : alg === 'rsa3072' ? 3072 : 2048);
        const secs = Math.floor(now(ctx) / 1000);
        const dn = Name.build(p.name.trim(), p.unit ?? '', p.organization ?? '', p.email ?? '', (p.country ?? '').toUpperCase());
        const serial = (await digest(DigestAlg.Sha256, [new TextEncoder().encode(p.name), Uint8Array.from(String(secs), c => c.charCodeAt(0))])).subarray(0, 8);
        const cert = await Certificate.selfSigned(dn, key, Time.fromUnix(secs), 5, serial);
        const id = new DigitalId(key, cert, [], p.name.trim());
        const p12 = await writeP12(id, p.password, p.rounds ? {rounds: p.rounds} : undefined);
        let where;
        if (p.path) {
          const out = await writeOther(ctx, {path: p.path}, p12, {title: 'Save Digital ID', name: `${p.name.trim()}.p12`, filters: [{name: 'PKCS #12', extensions: ['p12', 'pfx']}]});
          where = {path: out.path};
        } else where = {p12: toBase64(p12)};
        const entry = entryFor(where, cert);
        const list = [...ids(ctx).filter(e => e.fingerprint !== entry.fingerprint), entry];
        ctx.updatePrefs({digitalIds: list});
        return {index: list.length - 1, name: entry.name, fingerprint: entry.fingerprint, path: entry.path, p12: where.p12 ? where.p12 : undefined};
      },
    },
    {
      id: 'sign.id.import', label: 'Use a Digital ID from a file', risk: 'read', undo: 'none', needs: 'worker',
      description: 'Configure New Digital ID ▸ Use a Digital ID from a file: a .pfx/.p12 (`path`, `base64`, or picked in the system Open dialog) opened with its password and added to the list.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 1_500_000})), password: s.secret({max: 1000})}),
      state: readState,
      async run(ctx, p) {
        const file = await readOther(ctx, p, {title: 'Locate Digital ID File', filters: [{name: 'Digital ID Files', extensions: ['pfx', 'p12']}]});
        if (!file) return {canceled: true};
        let id;
        try { id = await openP12(file.bytes, p.password); } catch (e) {
          if (e.kind === 'wrong_password') throw new CommandError('invalid_params', 'The password is incorrect.', {path: '/password'});
          throw new CommandError('failed', e.message);
        }
        const entry = entryFor(file.path ? {path: file.path} : {p12: toBase64(file.bytes)}, id.certificate);
        const list = [...ids(ctx).filter(e => e.fingerprint !== entry.fingerprint), entry];
        ctx.updatePrefs({digitalIds: list});
        return {index: list.length - 1, name: entry.name, issuer: entry.issuer, fingerprint: entry.fingerprint};
      },
    },
    {
      id: 'sign.id.remove', label: 'Remove digital ID', risk: 'read', undo: 'none',
      description: 'Remove a digital ID from the list (Sign with a Digital ID ▸ Remove); its file stays where it is.',
      params: s.object({digitalId: s.union([s.integer({min: 0, max: 1000}), s.string({min: 1, max: 4096})])}),
      run(ctx, p) {
        const e = findId(ctx, p.digitalId);
        const list = ids(ctx).filter(x => x !== e);
        ctx.updatePrefs({digitalIds: list});
        return {removed: e.name, remaining: list.length};
      },
    },
  ],
});

export {Status, certificateDetails as certDetails};
