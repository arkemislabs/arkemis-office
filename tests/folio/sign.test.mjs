// core/folio/commands/sign.mjs: Fill & Sign, digital IDs, certificate signing and certifying,
// the Signatures panel and validation, trusted certificates and the certificate viewer.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/tools/fill_sign.rs, sign_ui.rs, sign_ui/panel.rs,
//    crates/sign): Fill & Sign places typed text 0.6 em above the click (10 pt), the date in
//    m/d/yyyy, 12 pt check/cross/dot marks and a 36 × 4 line, and the saved signature or initials
//    (drawn strokes 150 pt wide, typed text in Dancing Script 32/24 pt tall, an image at most
//    150 × 32/24 pt); the signature pad opens when nothing is saved. Digital signing asks for a
//    digital ID (a self-signed one is created into a password-protected .p12, or a .pfx/.p12 is
//    used), its password and the appearance; the signed file is saved with Save As
//    "<name>_signed.pdf" as an incremental update (ETSI.CAdES.detached) and becomes the document;
//    the Signatures panel validates each signature (valid / invalid / unknown signer, changes since
//    signing). Acrobat's Fill & Sign and Use a certificate ▸ Digitally sign / Certify / Validate
//    behave the same way.
// 2. Ours does the same end to end: the tests below sign real PDFs, reopen the signed bytes,
//    validate them (valid after trusting the signer, unknown before), tamper with a copy (invalid),
//    and add a comment after signing (saved incrementally: the signature still covers its
//    revision and validation names the later change).
// 3. Proved by the tests below, tests/folio/upstream/sign_*.test.mjs (ported upstream tests) and
//    tests/e2e/folio/sign-fill-and-certificate.e2e.mjs (the window, through the bridge).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict, PDFArray} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip, expectApprovalRequired} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {listSignatures, TrustStore} from '../../core/folio/lib/sign-pdf.mjs';
import {saveIncremental} from '../../core/folio/lib/sign-incremental.mjs';
import {loadCertificates} from '../../core/folio/lib/sign-x509.mjs';
import {formatDate} from '../../core/folio/lib/sign-fill.mjs';

after(() => releaseTextSources());

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const session = (prefs = {identity: {name: 'Grace Hopper'}}, fixture = 'textPages') => createTestSession('folio', {fixture, prefs});
const last = (t, page = 0) => t.content.pages[page].annots.at(-1);
const bytesOf = b64 => new Uint8Array(Buffer.from(b64, 'base64'));
const ID = {name: 'Grace Hopper', organization: 'Navy', email: 'grace@example.com', country: 'US', algorithm: 'p256', password: 'secret123', confirm: 'secret123', rounds: 2000};

test('Fill & Sign Add text is a typewriter annotation 0.6 em above the click, 10 pt, "Add text"', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'sign.fill.text', {page: 'p1', at: [100, 100], text: 'Jane Doe'}, after => {
    const d = after.content.pages[0].annots.at(-1).dict;
    assert.equal(d.Subtype, '/FreeText');
    assert.equal(d.IT, '/FreeTextTypeWriter');
    assert.equal(d.PCFillSign, true);
    assert.match(d.DA.$t, /\/Helv 10 Tf/);
    assert.equal(d.Contents.$t, 'Jane Doe');
    assert.ok(Math.abs(d.Rect[3] - (692 + 6)) < 1e-9, 'the box starts 0.6 em above the click');
  });
  assert.equal(r.undoLabel, 'Add text');
  assert.deepEqual((await t.exec('sign.fill.text', {})).result, {tool: 'sign.fill.text'});
});

test('marks: check, cross, dot (12 × 12 pt) and line (36 × 4 pt), centred on the click', async () => {
  const t = await session();
  const cases = {'sign.fill.check': ['/PCCheck', 'Add checkmark', 12, 12], 'sign.fill.cross': ['/PCCross', 'Add cross', 12, 12],
    'sign.fill.dot': ['/PCDot', 'Add dot', 12, 12], 'sign.fill.line': ['/PCLine', 'Add line', 36, 4]};
  for (const [id, [name, label, w, h]] of Object.entries(cases)) {
    const r = await expectUndoRoundTrip(t, id, {page: 'p1', at: [200, 200]}, after => {
      const d = after.content.pages[0].annots.at(-1).dict;
      assert.equal(d.Name, name);
      assert.deepEqual([d.Rect[2] - d.Rect[0], d.Rect[3] - d.Rect[1]], [w, h]);
      assert.deepEqual([(d.Rect[0] + d.Rect[2]) / 2, (d.Rect[1] + d.Rect[3]) / 2], [200, 592]);
    });
    assert.equal(r.undoLabel, label);
  }
});

test('Date writes today in Preferences ▸ Date format (m/d/yyyy by default)', async () => {
  const t = await session();
  const r = await t.exec('sign.fill.date', {page: 'p1', at: [100, 100]});
  assert.equal(r.result.text, '10/29/2026', 'the test clock is 2026-10-29');
  assert.equal(formatDate(Date.UTC(2026, 0, 5, 12), 'dddd, mmmm d, yyyy'), 'Monday, January 5, 2026');
  assert.equal(formatDate(Date.UTC(2026, 0, 5, 12), 'dd.mm.yyyy'), '05.01.2026');
  await t.exec('sign.fill.date', {page: 'p1', at: [100, 200], format: 'yyyy-mm-dd'});
  assert.equal(last(t).dict.Contents.$t, '2026-10-29');
});

test('Sign with nothing saved is refused; a typed signature is placed in the script face, 32 pt tall, left edge at the click', async () => {
  const t = await session();
  await assert.rejects(t.exec('sign.fill.signature', {page: 'p1', at: [100, 300]}), /Create your signature first/);
  await t.exec('sign.fill.signature.change', {typed: 'Grace Hopper'});
  assert.deepEqual((await t.exec('sign.fill.saved', {})).result.signature, {typed: 'Grace Hopper'});
  const r = await expectUndoRoundTrip(t, 'sign.fill.signature', {page: 'p1', at: [100, 300]}, after => {
    const d = after.content.pages[0].annots.at(-1).dict;
    assert.equal(d.Subtype, '/Stamp');
    assert.equal(d.Name, '/PCTypedSignature');
    assert.ok(d.PCOutline.length > 5, 'the name is drawn as filled outlines');
    assert.equal(d.Rect[0], 100);
    assert.ok(Math.abs((d.Rect[1] + d.Rect[3]) / 2 - 492) < 1e-6, 'centred vertically on the click');
    assert.ok(d.Rect[3] - d.Rect[1] <= 32 + 1e-9);
    assert.ok(d.Rect[2] - d.Rect[0] <= 150 + 1e-6, 'within the 150 pt placement width');
  });
  assert.equal(r.undoLabel, 'Add signature');
  await assert.rejects(t.exec('sign.fill.signature.change', {typed: 'Саша'}), /can't draw/, 'letters the script face lacks are refused');
});

test('drawn initials are placed 150 pt wide as an Ink signature; image initials are a picture stamp; Remove forgets them', async () => {
  const t = await session();
  await t.exec('sign.fill.initials.change', {drawn: [[[0, 0.1], [0.5, 0.3], [1, 0.1]]]});
  await t.exec('sign.fill.initials', {page: 'p1', at: [100, 300]});
  const d = last(t).dict;
  assert.equal(d.Subtype, '/Ink');
  assert.equal(d.PCFillSign, true);
  assert.equal(d.InkList[0][0], 100);
  assert.ok(Math.abs(d.InkList[0].at(-2) - 250) < 1e-9, '150 pt across');
  await t.exec('sign.fill.initials.change', {image: PNG_1x1});
  await t.exec('sign.fill.initials', {page: 'p1', at: [100, 400]});
  const img = last(t).dict;
  assert.equal(img.Subtype, '/Stamp');
  assert.ok(img.PCPicture.$ref);
  assert.equal(img.PCFillSign, true);
  assert.ok(Math.abs(img.Rect[3] - img.Rect[1] - 24) < 1e-9, 'initials images are 24 pt tall');
  await t.exec('sign.fill.initials.remove', {});
  assert.equal((await t.exec('sign.fill.saved', {})).result.initials, null);
  assert.equal(t.state('sign.fill.initials.remove').enabled, false);
});

async function withId(t) {
  const r = await t.exec('sign.id.create', ID);
  assert.ok(r.result.p12, 'with no path the .p12 is kept with the settings');
  return r.result;
}

test('a self-signed digital ID is a real .p12 that opens with its password; a wrong password is refused', async () => {
  const t = await session();
  await assert.rejects(t.exec('sign.id.create', {...ID, password: 'short', confirm: 'short'}), /at least 8 characters/);
  await assert.rejects(t.exec('sign.id.create', {...ID, confirm: 'different1'}), /do not match/);
  const made = await withId(t);
  const list = (await t.exec('sign.id.list', {})).result.ids;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Grace Hopper');
  assert.equal(list[0].issuer, 'Grace Hopper', 'self-signed');
  const t2 = await session({});
  await assert.rejects(t2.exec('sign.id.import', {base64: made.p12, password: 'wrong-one'}), /The password is incorrect/);
  const imp = await t2.exec('sign.id.import', {base64: made.p12, password: ID.password});
  assert.equal(imp.result.fingerprint, made.fingerprint);
  await t2.exec('sign.id.remove', {digitalId: 0});
  assert.equal((await t2.exec('sign.id.list', {})).result.ids.length, 0);
});

test('signing is irreversible: the bridge must ask first', async () => {
  const t = await session();
  await withId(t);
  const data = await expectApprovalRequired(t, 'sign.digital', {page: 'p1', rect: [72, 600, 200, 60], password: ID.password});
  assert.ok(data);
});

test('Digitally sign: a visible signature saved incrementally; unknown signer until trusted, then valid; a tampered copy is invalid', async () => {
  const t = await session();
  await withId(t);
  const before = Buffer.from(t.content.sourceBase64, 'base64');
  const r = await t.exec('sign.digital', {page: 'p1', rect: [72, 600, 200, 60], password: ID.password, reason: 'I approve', location: 'Arlington'});
  assert.equal(r.result.field, 'Signature1');
  assert.equal(r.result.status, 'unknown', "the signer's identity is unknown until trusted");
  const signed = bytesOf(r.result.base64);
  assert.deepEqual(Buffer.from(signed.subarray(0, before.length)), before, 'the original bytes are kept: the signature is an incremental update');
  assert.equal(t.content.sourceBase64, r.result.base64, 'the signed file is the document now');
  assert.equal(t.doc.view.rightPanel, 'signatures');
  // The dictionaries Acrobat reads.
  const doc = await PDFDocument.load(signed);
  const af = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  assert.equal(af.get(PDFName.of('SigFlags')).asNumber(), 3);
  const w = doc.context.lookup(af.lookup(PDFName.of('Fields'), PDFArray).get(0));
  assert.equal(w.lookup(PDFName.of('FT')).decodeText(), 'Sig');
  const v = w.lookup(PDFName.of('V'), PDFDict);
  assert.equal(v.lookup(PDFName.of('Filter')).decodeText(), 'Adobe.PPKLite');
  assert.equal(v.lookup(PDFName.of('SubFilter')).decodeText(), 'ETSI.CAdES.detached');
  assert.equal(v.lookup(PDFName.of('Reason')).decodeText(), 'I approve');
  assert.ok(w.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')), 'the visible signature has an appearance');
  // Validation, as the panel shows it.
  let panel = (await t.exec('sign.validate', {})).result.signatures;
  assert.equal(panel[0].summary, 'Signature validity is unknown');
  assert.match(panel[0].details.join(' '), /not been modified since this signature was applied/);
  await t.exec('sign.trust', {field: 'Signature1'});
  panel = (await t.exec('sign.validate', {})).result.signatures;
  assert.equal(panel[0].summary, 'Signature is valid');
  assert.equal(panel[0].signer, 'Grace Hopper');
  assert.equal(panel[0].reason, 'I approve');
  const viewer = (await t.exec('sign.certificate', {field: 'Signature1'})).result;
  assert.equal(viewer.trusted, true);
  assert.match(viewer.chain[0].issuedTo, /Grace Hopper/);
  assert.equal(viewer.chain[0].keyUsage, 'Digital Signature, Non-Repudiation');
  // A tampered copy: one byte inside the signed range changed.
  const tampered = signed.slice();
  const at = Buffer.from(tampered).indexOf('/MediaBox');
  tampered[at + 12] = tampered[at + 12] === 0x30 ? 0x31 : 0x30;
  const trust = new TrustStore(loadCertificates(new TextEncoder().encode(viewer.chain[0].pem)));
  const bad = await listSignatures(tampered, trust);
  assert.equal(bad[0].status, 'invalid');
  assert.match(bad[0].details.join(' '), /altered or corrupted/);
});

test('a comment added after signing is saved as another incremental update: the signature stays valid and names the change', async () => {
  const t = await session();
  await withId(t);
  const r = await t.exec('sign.digital', {page: 'p1', rect: [72, 600, 200, 60], password: ID.password});
  await t.exec('sign.trust', {field: r.result.field});
  await t.exec('comment.note', {page: 'p1', at: [300, 300], text: 'after signing'});
  const bytes = await saveIncremental(t.content);
  const signed = bytesOf(r.result.base64);
  assert.ok(bytes.length > signed.length);
  assert.deepEqual(Buffer.from(bytes.subarray(0, signed.length)), Buffer.from(signed), 'the signed revision is untouched');
  const panel = (await t.exec('sign.validate', {})).result.signatures;
  assert.equal(panel[0].status, 'valid');
  assert.notEqual(panel[0].modification.kind, 'none');
  assert.ok(panel[0].modification.changes.includes('comments'), JSON.stringify(panel[0].modification));
  // Rewriting the whole file instead (what a non-incremental save would do) breaks the signature.
  const rewritten = await writeFolioPdf(t.content);
  const broken = await listSignatures(rewritten);
  assert.notEqual(broken[0]?.status, 'valid');
});

test('Certify (invisible) with "No changes allowed": a later comment makes the certification invalid', async () => {
  const t = await session();
  await withId(t);
  const r = await t.exec('sign.certify_invisible', {password: ID.password, permitted: 1});
  assert.ok(r.result.field);
  const doc = await PDFDocument.load(bytesOf(r.result.base64));
  assert.ok(doc.catalog.lookup(PDFName.of('Perms'), PDFDict).get(PDFName.of('DocMDP')), 'the certification is in /Perms /DocMDP');
  await t.exec('sign.trust', {field: r.result.field});
  assert.equal((await t.exec('sign.validate', {})).result.signatures[0].status, 'valid');
  await t.exec('comment.note', {page: 'p1', at: [300, 300], text: 'not allowed'});
  const panel = (await t.exec('sign.validate', {})).result.signatures;
  assert.equal(panel[0].status, 'invalid');
  assert.match(panel[0].details.join(' '), /does not permit/);
});

test('the Fill & Sign signature as the graphic of a visible digital signature; a wrong password is refused', async () => {
  const t = await session();
  await withId(t);
  await t.exec('sign.fill.signature.change', {typed: 'Grace'});
  await assert.rejects(t.exec('sign.digital', {page: 'p1', rect: [72, 600, 200, 60], password: 'nope-nope'}), /The password is incorrect/);
  const r = await t.exec('sign.digital', {page: 'p1', rect: [72, 600, 200, 60], password: ID.password, graphic: 'fillsign'});
  assert.equal(r.result.status, 'unknown');
  assert.equal(t.session.prefs.signGraphic, 'fillsign', 'the graphic last signed with is remembered');
  const r2 = await (await session()).exec('sign.digital', {page: 'p1', rect: [72, 600, 200, 60]}).catch(e => e);
  assert.match(String(r2.message), /Choose a digital ID/);
});

test('Digitally sign without an area picks the drag tool (commands.rs:633); the panel lists nothing for an unsigned file', async () => {
  const t = await session();
  const r = await t.exec('sign.digital', {});
  assert.equal(r.result.tool, 'sign.digital');
  assert.equal(t.doc.view.tool, 'sign.digital');
  const p = await t.exec('sign.panel', {});
  assert.deepEqual(p.result.signatures, []);
  assert.equal(t.doc.view.rightPanel, 'signatures');
});

test('Certificate Viewer: Export… gives the PEM; Remove from Trusted Certificates makes the signer unknown again; Fill & Sign Remove forgets the signature', async () => {
  const t = await session();
  await withId(t);
  await t.exec('sign.digital', {page: 'p1', rect: [72, 600, 200, 60], password: ID.password});
  await t.exec('sign.trust', {field: 'Signature1'});
  const viewer = (await t.exec('sign.certificate', {field: 'Signature1'})).result;
  // No Save dialog outside a window: the certificate comes back as PEM, the same one the viewer shows.
  const exported = (await t.exec('sign.certificate.export', {field: 'Signature1'})).result;
  assert.equal(exported.pem, viewer.chain[0].pem);
  assert.match(exported.pem, /^-----BEGIN CERTIFICATE-----/);
  const fingerprint = loadCertificates(new TextEncoder().encode(exported.pem))[0].fingerprint();
  assert.equal((await t.exec('sign.untrust', {fingerprint})).result.trusted, 0);
  assert.equal((await t.exec('sign.validate', {})).result.signatures[0].summary, 'Signature validity is unknown');
  // Untrusting a fingerprint that isn't trusted changes nothing.
  assert.equal((await t.exec('sign.untrust', {fingerprint: 'not-a-fingerprint'})).result.trusted, 0);

  await t.exec('sign.fill.signature.change', {typed: 'Grace Hopper'});
  assert.equal(t.state('sign.fill.signature.remove').enabled, true);
  assert.deepEqual((await t.exec('sign.fill.signature.remove', {})).result, {removed: 'signature'});
  assert.equal((await t.exec('sign.fill.saved', {})).result.signature, null);
  assert.equal(t.state('sign.fill.signature.remove').enabled, false);
});
