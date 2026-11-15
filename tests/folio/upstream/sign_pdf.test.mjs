// Ported from printcraft crates/sign/tests/it/pdf.rs (validates_a_signature_made_by_openssl,
// signing round trips) and chain.rs (a_proper_chain_is_built through a trusted root) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT): lib/sign-pdf.mjs listing, validation and signing.
//
// Behaviour fidelity: 1. ArtCraft validates a signature it did not make (OpenSSL's
// adbe.pkcs7.detached): unknown until the signer is trusted, then valid, and a later comment is an
// allowed change; a signature from an ID issued by a trusted root is valid through the chain.
// Acrobat reports the same. 2. Ours, on the same file. 3. These tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFArray, PDFString, PDFRef} from 'pdf-lib';
import {data} from './sign_testdata.mjs';
import {open} from '../../../core/folio/lib/sign-pkcs12.mjs';
import {listSignatures, TrustStore, sign, writeIncremental} from '../../../core/folio/lib/sign-pdf.mjs';
import {loadCertificates} from '../../../core/folio/lib/sign-x509.mjs';

async function editAfterAddComment(bytes) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false});
  const page = doc.getPage(0);
  const note = doc.context.register(doc.context.obj({Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('A note')}));
  const annots = page.node.get(PDFName.of('Annots'));
  const changed = new Set([`${note.objectNumber} 0`]);
  if (annots instanceof PDFArray) { annots.push(note); changed.add(`${page.ref.objectNumber} ${page.ref.generationNumber}`); }
  else if (annots instanceof PDFRef) { doc.context.lookup(annots).push(note); changed.add(`${annots.objectNumber} ${annots.generationNumber}`); }
  else { page.node.set(PDFName.of('Annots'), doc.context.obj([note])); changed.add(`${page.ref.objectNumber} ${page.ref.generationNumber}`); }
  return writeIncremental(bytes, doc, changed);
}

test('validates_a_signature_made_by_openssl', async () => {
  const bytes = data('openssl-signed.pdf');
  let [s] = await listSignatures(bytes, new TrustStore());
  assert.equal(s.field, 'OpenSSL');
  assert.equal(s.subFilter, 'adbe.pkcs7.detached');
  assert.equal(s.status, 'unknown', s.details.join(' | '));
  assert.equal(s.signer, 'Test Signer RSA');
  assert.equal(s.signingTime?.year, 2026, 'from the CMS signing-time attribute');
  assert.equal(s.visible, false);
  const rsa = (await open(data('rsa-aes.p12'), 'test')).certificate;
  [s] = await listSignatures(bytes, new TrustStore([rsa]));
  assert.equal(s.status, 'valid', s.details.join(' | '));
  const edited = await editAfterAddComment(bytes);
  [s] = await listSignatures(edited, new TrustStore());
  assert.equal(s.modification.kind, 'allowed');
  assert.deepEqual(s.modification.changes, ['comments']);
});

test('a signature by an ID issued by a trusted root is valid through the chain (chain.rs a_proper_chain_is_built)', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const bytes = await doc.save({useObjectStreams: false});
  const id = await open(data('chain.p12'), 'test');
  const signed = await sign(bytes, id, {page: 0, rect: [20, 20, 220, 80], date: 'D:20261030120000Z', reason: 'chain'});
  const [root] = loadCertificates(data('ca.crt.pem'));
  const [unknown] = await listSignatures(signed, new TrustStore());
  assert.equal(unknown.status, 'unknown');
  const [s] = await listSignatures(signed, new TrustStore([root]));
  assert.equal(s.status, 'valid', s.details.join(' | '));
  assert.deepEqual(s.chain.map(c => c.subject.commonName()), ['Ada Lovelace', 'PrintCraft Test Root CA']);
});

test('signing appends to files with an xref table and with an xref stream; a second signature keeps the first valid', async () => {
  const id = await open(data('ec-p256.p12'), 'test');
  for (const useObjectStreams of [false, true]) {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save({useObjectStreams});
    const signed = await sign(bytes, id, {page: 0, rect: null, date: 'D:20261030120000Z'});
    assert.deepEqual(Buffer.from(signed.subarray(0, bytes.length)), Buffer.from(bytes));
    const [s] = await listSignatures(signed, new TrustStore([id.certificate]));
    assert.equal(s.status, 'valid', `${useObjectStreams}: ${s.details.join(' | ')}`);
    assert.equal(s.visible, false, 'no rectangle: invisible');
    const second = await sign(signed, id, {page: 0, rect: [10, 10, 100, 40], date: 'D:20261030120100Z'});
    const both = await listSignatures(second, new TrustStore([id.certificate]));
    assert.equal(both.length, 2);
    assert.equal(both[0].status, 'valid', 'the first signature stays valid after a second one is added');
    assert.equal(both[0].modification.kind, 'allowed');
    assert.equal(both[1].modification.kind, 'none');
  }
});
