// Ported from printcraft crates/sign/tests/it/crypto.rs and src/der.rs tests at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT): digital ID files (lib/sign-pkcs12.mjs),
// certificates (lib/sign-x509.mjs) and CMS signatures (lib/sign-cms.mjs).
//
// Behaviour fidelity: 1. ArtCraft opens every OpenSSL flavour of .p12 (AES and legacy RC2/3DES,
// RSA and ECDSA, with a chain), refuses a wrong password as such, and makes self-signed IDs that
// survive a .p12 round trip and sign; Acrobat opens the same files. 2. Ours does the same with
// the very files upstream tests. 3. The tests below (names are the Rust tests').
import test from 'node:test';
import assert from 'node:assert/strict';
import {data} from './sign_testdata.mjs';
import {open, write, DigitalId} from '../../../core/folio/lib/sign-pkcs12.mjs';
import {Certificate, Name, PrivateKey, loadCertificates} from '../../../core/folio/lib/sign-x509.mjs';
import {Time, Tlv} from '../../../core/folio/lib/sign-der.mjs';
import {signDetached, SignedData} from '../../../core/folio/lib/sign-cms.mjs';
import {DigestAlg, digest} from '../../../core/folio/lib/sign-crypto.mjs';

test('opens_every_openssl_flavour_of_pkcs12', async () => {
  for (const [file, cn, key] of [
    ['rsa-aes.p12', 'Test Signer RSA', 'RSA 2048-bit'], ['rsa-legacy.p12', 'Test Signer RSA', 'RSA 2048-bit'],
    ['ec-p256.p12', 'Test Signer EC', 'ECDSA P-256'], ['ec-p384.p12', 'Test Signer P384', 'ECDSA P-384'], ['chain.p12', 'Ada Lovelace', 'RSA 2048-bit'],
  ]) {
    const id = await open(data(file), 'test');
    assert.equal(id.certificate.subject.commonName(), cn, file);
    assert.equal(id.key.publicKey.describe(), key, file);
    await assert.rejects(open(data(file), 'nope'), e => e.kind === 'wrong_password', file);
  }
  assert.equal((await open(data('rsa-aes.p12'), 'test')).friendlyName, 'Test Signer RSA');
  const chain = await open(data('chain.p12'), 'test');
  assert.equal(chain.chain.length, 1);
  assert.equal(chain.certificate.subject.email(), 'ada@example.com');
  assert.ok(chain.chain[0].isCa && await chain.chain[0].isSelfSigned());
  assert.ok(await chain.certificate.signedBy(chain.chain[0].publicKey), 'the leaf is issued by the root');
  assert.ok(!(await chain.certificate.isSelfSigned()));
  assert.equal(chain.certificate.keyUsage & 0b11, 0b11, 'digitalSignature + nonRepudiation');
});

test('new_digital_ids_are_self_signed_and_survive_a_p12_round_trip', async () => {
  const name = Name.build('Grace Hopper', 'Compilers', 'Navy', 'grace@example.com', 'us');
  const now = new Time(2026, 10, 2, 12, 0, 0);
  for (const key of [await PrivateKey.generateRsa(2048), await PrivateKey.generateP256()]) {
    const cert = await Certificate.selfSigned(name, key, now, 5, Uint8Array.of(0x42, 0x01));
    assert.ok(await cert.isSelfSigned());
    assert.equal(cert.subject.display(), 'C=US, O=Navy, OU=Compilers, CN=Grace Hopper, E=grace@example.com');
    assert.equal(cert.notAfter.year, 2031);
    assert.equal(cert.keyUsage & 0b11, 0b11);
    const id = new DigitalId(key, cert, [], 'Grace Hopper');
    const p12 = await write(id, 's3cret', {rounds: 2048});
    const back = await open(p12, 's3cret');
    assert.ok(back.certificate.same(id.certificate));
    assert.equal(back.friendlyName, 'Grace Hopper');
    await assert.rejects(open(p12, 'wrong'), e => e.kind === 'wrong_password');
    const d = await digest(DigestAlg.Sha256, [new TextEncoder().encode('x')]);
    const sig = await signDetached(back.key, back.certificate, [], DigestAlg.Sha256, d);
    assert.ok(SignedData.parse(sig), 'the CMS parses');
  }
});

test('certificates_load_from_pem_and_der_and_export_as_pem', () => {
  const [c] = loadCertificates(data('rsa.crt.pem'));
  assert.equal(c.subject.commonName(), 'Test Signer RSA');
  assert.ok(loadCertificates(c.raw)[0].same(c), 'DER loads too');
  assert.ok(loadCertificates(new TextEncoder().encode(c.toPem()))[0].same(c), 'exported PEM loads back');
});

test('der times: UTCTime before 2050, GeneralizedTime after, PDF dates to UTC', () => {
  const t = new Time(2049, 12, 31, 23, 59, 59);
  assert.equal(Tlv.parseAll(t.encode()).time().toString(), t.toString());
  assert.equal(Tlv.parseAll(new Time(2050, 1, 1, 0, 0, 0).encode()).time().year, 2050);
  assert.equal(Time.fromPdf("D:20261030120000+05'30'").toString(), '2026.10.30 06:30:00 UTC');
});
