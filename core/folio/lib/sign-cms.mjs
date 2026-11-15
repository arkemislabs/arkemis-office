// CMS SignedData (RFC 5652) as PDF signatures use it: detached (adbe.pkcs7.detached,
// ETSI.CAdES.detached) or with the digest encapsulated (adbe.pkcs7.sha1).
//
// Translated from printcraft crates/sign/src/cms.rs (OIDs, SignerId, SignerInfo, SignedData
// parse/signer_certificate/verify_signature_noting, carried_certificates, parse_signer,
// sign_detached, build: content-type, message-digest and ESS signing-certificate-v2 signed
// attributes) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Web Crypto verifies a message rather than a digest, so `verify` is handed the signed message:
// the DER signed attributes, or (no signed attributes) the signed content itself.
// No DOM, no Node built-ins.

import {Tlv, tag, SignError, bad as derBad, unsupported, seq, setOf, oid, explicit, octets, tlv, int, uint, Time, concat, equalBytes} from './sign-der.mjs';
import {DigestAlg, digestFromOid, digestAlgorithm, digest, weakness, sha256} from './sign-crypto.mjs';
import {Certificate, signatureOid, OID} from './sign-x509.mjs';

export const SIGNED_DATA = '1.2.840.113549.1.7.2';
export const DATA = '1.2.840.113549.1.7.1';
const CONTENT_TYPE = '1.2.840.113549.1.9.3', MESSAGE_DIGEST = '1.2.840.113549.1.9.4', SIGNING_TIME = '1.2.840.113549.1.9.5';
const SIGNING_CERT_V2 = '1.2.840.113549.1.9.16.2.47', SIGNING_CERT = '1.2.840.113549.1.9.16.2.12', TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';

const bad = what => derBad(`CMS: ${what}`);
const strip = b => (b.length > 1 && b[0] === 0 ? b.subarray(1) : b);

function carriedCertificates(set) {
  const out = [];
  for (const c of set.children()) if (c.tag === tag.SEQUENCE) { try { out.push(Certificate.parse(c.raw)); } catch { /* skipped */ } }
  return out;
}

/** keys.rs `signature_algorithm`: the scheme and the digest a SignerInfo's signatureAlgorithm names. */
function signatureAlgorithm(t) {
  const p = t.children();
  const o = p[0].oid();
  if (o === OID.RSA) return {scheme: 'rsa', schemeDigest: null};
  if (o === OID.EC) return {scheme: 'ecdsa', schemeDigest: null};
  if (o === OID.ED25519) return {scheme: 'ed25519', schemeDigest: null};
  if (o === OID.RSA_PSS) {
    const params = p[1]?.children() ?? [];
    const h = params.find(x => x.tag === tag.ctx(0))?.inner().children()[0]?.oid();
    const saltT = params.find(x => x.tag === tag.ctx(2));
    return {scheme: 'pss', schemeDigest: h ? digestFromOid(h) : DigestAlg.Sha1, pss: {saltLength: saltT ? saltT.inner().u64() : 20}};
  }
  const s = signatureOid(o);
  if (!s) throw unsupported(`signature algorithm ${o}`);
  return {scheme: s.scheme, schemeDigest: s.digest};
}

function parseSigner(si) {
  const f = si.children();
  let i = 1;
  const sidT = f[i++];
  if (!sidT) throw bad('sid');
  let sid;
  if (sidT.tag === tag.SEQUENCE) {
    const p = sidT.children();
    if (p.length !== 2) throw bad('issuerAndSerialNumber');
    sid = {issuer: p[0].raw, serial: p[1].value};
  } else sid = {keyId: sidT.value};
  const dOid = f[i++]?.children()[0]?.oid();
  if (!dOid) throw bad('digestAlgorithm');
  const dig = digestFromOid(dOid);
  if (!dig) throw new SignError('unsupported', `digest ${dOid}`);
  let next = f[i++];
  if (!next) throw bad('signatureAlgorithm');
  let signedAttrs = null, messageDigest = null, contentType = null, signingTime = null, signingCertificate = false;
  if (next.tag === tag.ctx(0)) {
    const set = next.isIndefinite() ? tlv(tag.SET, next.value) : Uint8Array.from(next.raw);
    set[0] = tag.SET;
    let seenType = false, seenDigest = false;
    for (const a of next.children()) {
      const p = a.children();
      let o;
      try { o = p[0].oid(); } catch { continue; }
      let values = [];
      try { values = p[1]?.children() ?? []; } catch { values = []; }
      if (o === CONTENT_TYPE || o === MESSAGE_DIGEST) {
        const what = o === CONTENT_TYPE ? 'content type' : 'message digest';
        const seen = o === CONTENT_TYPE ? seenType : seenDigest;
        if (seen || values.length !== 1) throw bad(`the signed attributes must hold one ${what} with one value`);
        if (o === CONTENT_TYPE) seenType = true; else seenDigest = true;
      }
      const v = values[0];
      if (o === MESSAGE_DIGEST && v) messageDigest = v.value;
      else if (o === CONTENT_TYPE && v) contentType = v.oid();
      else if (o === SIGNING_TIME && v) { try { signingTime = v.time(); } catch { /* ignored */ } }
      else if (o === SIGNING_CERT_V2 || o === SIGNING_CERT) signingCertificate = true;
    }
    signedAttrs = set;
    next = f[i++];
    if (!next) throw bad('signatureAlgorithm');
  }
  const {scheme, schemeDigest, pss} = signatureAlgorithm(next);
  const sigT = f[i++];
  if (!sigT) throw bad('signature');
  const signature = sigT.octets('signature');
  let timestampToken = null;
  for (const t of f.slice(i)) {
    if (t.tag !== tag.ctx(1)) continue;
    for (const a of t.children()) {
      const p = a.children();
      try { if (p[0].oid() === TIMESTAMP_TOKEN) timestampToken = p[1].children()[0]?.raw ?? null; } catch { /* ignored */ }
    }
  }
  return {sid, digest: dig, signedAttrs, messageDigest, contentType, signingTime, signingCertificate, scheme, schemeDigest, pss, signature,
    timestamp: !!timestampToken, timestampToken};
}

/** cms.rs `SignedData`. */
export class SignedData {
  /** Parse a ContentInfo holding SignedData; bytes after it (the placeholder's zero padding) are ignored. */
  static parse(bytes) {
    const [ci0] = Tlv.parseBer(bytes);
    const quirks = [];
    if (ci0.isIndefinite()) quirks.push('The signature is BER-encoded (indefinite lengths) rather than DER; it was read leniently.');
    const ci = ci0.expect(tag.SEQUENCE, 'ContentInfo').children();
    if (ci.length !== 2) throw bad('ContentInfo');
    if (ci[0].oid() !== SIGNED_DATA) throw bad('not SignedData');
    const sd = ci[1].expect(tag.ctx(0), 'content').inner().children();
    const encap = sd[2]?.children();
    if (!encap) throw bad('encapContentInfo');
    const econtentType = encap[0]?.oid();
    if (!econtentType) throw bad('eContentType');
    let content = null;
    if (encap[1]?.tag === tag.ctx(0)) {
      const inner = encap[1].inner();
      if (inner.tag !== tag.OCTET_STRING) quirks.push('The signed content is a constructed (segmented) OCTET STRING, as BER allows; it was read anyway.');
      content = inner.octets('eContent');
    }
    const certificates = [];
    let infos = null;
    for (const t of sd.slice(3)) {
      if (t.tag === tag.ctx(0)) certificates.push(...carriedCertificates(t));
      else if (t.tag === tag.SET) infos = t;
    }
    if (!infos) throw bad('no signerInfos');
    const si = infos.children()[0];
    if (!si) throw bad('no signer');
    const signer = parseSigner(si);
    if (signer.contentType && signer.contentType !== econtentType) throw bad('the signed content type is not the encapsulated content type');
    const out = new SignedData();
    Object.assign(out, {certificates, signer, content, econtentType, quirks});
    return out;
  }

  signerCertificate() {
    const sid = this.signer.sid;
    return this.certificates.find(c => (sid.keyId ? equalBytes(c.subjectKeyId, sid.keyId)
      : equalBytes(c.issuer.raw, sid.issuer) && equalBytes(strip(c.serial), strip(sid.serial)))) ?? null;
  }

  /**
   * cms.rs `verify_signature_noting`. `signedContent`: what was signed when there are no signed
   * attributes (the document byte ranges, or adbe.pkcs7.sha1's encapsulated digest).
   * Returns true/false; notes get the tolerated irregularities. Throws 'unsupported'.
   */
  async verifySignature(cert, signedContent, notes = []) {
    const s = this.signer;
    if (s.scheme === 'ed25519') throw unsupported('Ed25519 signatures');
    const named = s.schemeDigest ?? s.digest;
    const algs = [named];
    if (!algs.includes(s.digest)) algs.push(s.digest);
    const message = s.signedAttrs ?? signedContent;
    for (const alg of algs) {
      const attempt = [];
      if (await cert.publicKey.verify(s.scheme, alg, message, s.signature, attempt, s.pss)) {
        notes.push(...attempt);
        for (const w of [s.digest, alg].map(weakness).filter(Boolean)) if (!notes.includes(w)) notes.push(w);
        if (alg !== named) notes.push("The signature algorithm and the SignerInfo's digest algorithm name different hashes; the signature was made with the SignerInfo's.");
        return true;
      }
    }
    return false;
  }
}

const attribute = (o, value) => seq([oid(o), setOf([value])]);

/**
 * cms.rs `sign_detached` / `build`: a detached CMS SignedData over `contentDigest`, with the
 * content-type, message-digest and ESS signing-certificate-v2 signed attributes (CAdES).
 */
export async function signDetached(key, cert, chain, alg, contentDigest) {
  const certHash = sha256(cert.raw);
  const generalNames = seq([explicit(4, cert.issuer.raw)]);
  const ess = seq([seq([seq([octets(certHash), seq([generalNames, uint(cert.serial)])])])]);
  const attrs = [attribute(CONTENT_TYPE, oid(DATA)), attribute(MESSAGE_DIGEST, octets(contentDigest)), attribute(SIGNING_CERT_V2, ess)];
  const set = setOf(attrs);
  const signature = await key.sign(alg, set);
  const signedAttrs = Uint8Array.from(set);
  signedAttrs[0] = tag.ctx(0);
  const sid = seq([cert.issuer.raw, uint(cert.serial)]);
  const signer = seq([int(1), sid, digestAlgorithm(alg), signedAttrs, key.signatureAlgorithm(alg), octets(signature)]);
  const certs = [cert.raw, ...chain.filter(c => !equalBytes(c.raw, cert.raw)).map(c => c.raw)];
  const signedData = seq([int(1), setOf([digestAlgorithm(alg)]), seq([oid(DATA)]), tlv(tag.ctx(0), concat(certs)), setOf([signer])]);
  return seq([oid(SIGNED_DATA), explicit(0, signedData)]);
}

export {digest, Time};
