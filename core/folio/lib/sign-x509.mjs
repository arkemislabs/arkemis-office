// Keys and certificates: public keys and their verification, private keys and signing, X.509
// certificates (names, validity, extensions, chains) and a new self-signed digital ID.
//
// Translated from printcraft crates/sign/src/keys.rs (oid, SIGNATURE_OIDS, Scheme, PublicKey
// from_spki/describe/verify, PrivateKey from_pkcs8/generate_rsa/generate_p256/
// signature_algorithm/preferred_digest/sign) and crates/sign/src/x509.rs (Name parse/
// common_name/organization/unit/email/country/display_name/display/build, Certificate parse/
// signing_problem/may_timestamp/is_self_signed/signed_by/may_issue/valid_at/display_name/
// fingerprint/serial_hex/self_signed, Extensions::read, PROCESSED_EXTENSIONS,
// DOCUMENT_SIGNING_EKUS, build_chain/build_chain_noted, load_certificates, to_pem) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream signs with aws-lc-rs/RustCrypto; here RSA PKCS#1 v1.5, RSA-PSS and ECDSA P-256/P-384
// go through Web Crypto (`crypto.subtle`), which takes the message rather than its digest, so
// verification is handed the bytes that were signed. Verification and signing are therefore
// asynchronous. Brainpool, P-521 and Ed25519 keys are read and named but reported as not
// supported for checking. No DOM, no Node built-ins.

import {Tlv, tag, SignError, bad, unsupported, Time, seq, setOf, oid, explicit, octets, boolean, bitString, tlv, int, uint, nul, utf8, printable, ia5,
  algorithm, concat, hex, equalBytes, toBase64, fromBase64, latin1} from './sign-der.mjs';
import {DigestAlg, digestFromOid, digest, sha1, sha256} from './sign-crypto.mjs';

export const OID = Object.freeze({
  RSA: '1.2.840.113549.1.1.1', RSA_PSS: '1.2.840.113549.1.1.10', MGF1: '1.2.840.113549.1.1.8', EC: '1.2.840.10045.2.1',
  P256: '1.2.840.10045.3.1.7', P384: '1.3.132.0.34', P521: '1.3.132.0.35', ED25519: '1.3.101.112',
  BRAINPOOL_P256: '1.3.36.3.3.2.8.1.1.7', BRAINPOOL_P384: '1.3.36.3.3.2.8.1.1.11', BRAINPOOL_P512: '1.3.36.3.3.2.8.1.1.13',
});

/** keys.rs `SIGNATURE_OIDS`: [oid, scheme, digest]. */
const SIGNATURE_OIDS = [
  ['1.2.840.113549.1.1.5', 'rsa', 'Sha1'], ['1.2.840.113549.1.1.14', 'rsa', 'Sha224'], ['1.2.840.113549.1.1.11', 'rsa', 'Sha256'],
  ['1.2.840.113549.1.1.12', 'rsa', 'Sha384'], ['1.2.840.113549.1.1.13', 'rsa', 'Sha512'], ['1.2.840.113549.1.1.15', 'rsa', 'Sha512_224'],
  ['1.2.840.113549.1.1.16', 'rsa', 'Sha512_256'], ['2.16.840.1.101.3.4.3.13', 'rsa', 'Sha3_224'], ['2.16.840.1.101.3.4.3.14', 'rsa', 'Sha3_256'],
  ['2.16.840.1.101.3.4.3.15', 'rsa', 'Sha3_384'], ['2.16.840.1.101.3.4.3.16', 'rsa', 'Sha3_512'], ['1.3.36.3.3.1.2', 'rsa', 'Ripemd160'],
  ['1.2.840.10045.4.1', 'ecdsa', 'Sha1'], ['1.2.840.10045.4.3.1', 'ecdsa', 'Sha224'], ['1.2.840.10045.4.3.2', 'ecdsa', 'Sha256'],
  ['1.2.840.10045.4.3.3', 'ecdsa', 'Sha384'], ['1.2.840.10045.4.3.4', 'ecdsa', 'Sha512'], ['2.16.840.1.101.3.4.3.9', 'ecdsa', 'Sha3_224'],
  ['2.16.840.1.101.3.4.3.10', 'ecdsa', 'Sha3_256'], ['2.16.840.1.101.3.4.3.11', 'ecdsa', 'Sha3_384'], ['2.16.840.1.101.3.4.3.12', 'ecdsa', 'Sha3_512'],
  ['0.4.0.127.0.7.1.1.4.1.1', 'ecdsa', 'Sha1'], ['0.4.0.127.0.7.1.1.4.1.2', 'ecdsa', 'Sha224'], ['0.4.0.127.0.7.1.1.4.1.3', 'ecdsa', 'Sha256'],
  ['0.4.0.127.0.7.1.1.4.1.4', 'ecdsa', 'Sha384'], ['0.4.0.127.0.7.1.1.4.1.5', 'ecdsa', 'Sha512'],
];
export const signatureOid = o => { const e = SIGNATURE_OIDS.find(x => x[0] === o); return e ? {scheme: e[1], digest: DigestAlg[e[2]]} : null; };

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new SignError('crypto', 'Cryptography is unavailable in this runtime.');
  return s;
};

/** A DER ECDSA-Sig-Value → raw r‖s of `size` bytes each (what Web Crypto takes). */
function ecdsaRaw(sig, size, notes) {
  let parts;
  try {
    const [t, rest] = Tlv.parseBer(sig);
    if (t.tag !== tag.SEQUENCE) throw bad('ECDSA');
    parts = t.children();
    if (rest.length || parts.length !== 2 || parts.some(p => p.tag !== tag.INTEGER)) notes?.push('The ECDSA signature is not in canonical DER (trailing bytes, padding or a missing sign byte); it was read anyway.');
  } catch {
    if (sig.length === 2 * size) { notes?.push('The ECDSA signature is the raw r and s values instead of a DER sequence; it was read anyway.'); return sig; }
    throw bad('ECDSA signature');
  }
  const fit = v => { let b = v; while (b.length > size && b[0] === 0) b = b.subarray(1); if (b.length > size) throw bad('ECDSA signature'); const o = new Uint8Array(size); o.set(b, size - b.length); return o; };
  return concat([fit(parts[0].value), fit(parts[1].value)]);
}
const ecdsaDer = raw => { const h = raw.length / 2; return seq([uint(raw.subarray(0, h)), uint(raw.subarray(h))]); };

/** keys.rs `PublicKey`. */
export class PublicKey {
  constructor(kind, spki, extra = {}) { this.kind = kind; this.spki = spki; Object.assign(this, extra); }

  static fromSpki(t) {
    const parts = t.children();
    if (parts.length !== 2) throw bad('SubjectPublicKeyInfo');
    const alg = parts[0].children();
    const o = alg[0]?.oid();
    if (o === OID.RSA || o === OID.RSA_PSS) {
      const key = Tlv.parseAll(parts[1].bits()).children();
      return new PublicKey('rsa', t.raw, {n: key[0].uintBytes(), e: key[1].uintBytes()});
    }
    if (o === OID.EC) {
      const curve = alg[1]?.tag === tag.OID ? alg[1].oid() : null;
      const named = {[OID.P256]: 'P-256', [OID.P384]: 'P-384', [OID.P521]: 'P-521', [OID.BRAINPOOL_P256]: 'brainpoolP256r1',
        [OID.BRAINPOOL_P384]: 'brainpoolP384r1', [OID.BRAINPOOL_P512]: 'brainpoolP512r1'}[curve];
      if (!named) return new PublicKey('unsupported', t.raw, {what: `EC curve ${curve ?? '?'}`});
      return new PublicKey(named === 'P-256' || named === 'P-384' || named === 'P-521' ? named : 'brainpool', t.raw, {curve: named});
    }
    if (o === OID.ED25519) return new PublicKey('Ed25519', t.raw);
    return new PublicKey('unsupported', t.raw, {what: `key algorithm ${o}`});
  }

  bits() { if (this.kind !== 'rsa') return 0; let n = this.n; while (n.length && !n[0]) n = n.subarray(1); return n.length ? (n.length - 1) * 8 + (32 - Math.clz32(n[0])) : 0; }

  /** keys.rs `describe`. */
  describe() {
    switch (this.kind) {
      case 'rsa': return `RSA ${this.bits()}-bit`;
      case 'P-256': return 'ECDSA P-256';
      case 'P-384': return 'ECDSA P-384';
      case 'P-521': return 'ECDSA P-521';
      case 'brainpool': return `ECDSA ${this.curve}`;
      case 'Ed25519': return 'Ed25519';
      default: return `unsupported (${this.what})`;
    }
  }

  /**
   * Verify `signature` over `message` with `scheme` ('rsa' | 'pss' | 'ecdsa') and digest `d`.
   * Returns true/false; throws SignError 'unsupported' for what can't be checked here.
   */
  async verify(scheme, d, message, signature, notes = null, pss = null) {
    if (!d.web) throw unsupported(d.name);
    if (this.kind === 'rsa' && (scheme === 'rsa' || scheme === 'pss')) {
      const name = scheme === 'pss' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5';
      const key = await subtle().importKey('spki', rsaSpki(this), {name, hash: d.web}, false, ['verify']).catch(() => { throw bad('RSA public key'); });
      const modLen = Math.ceil(this.bits() / 8);
      let sig = signature;
      if (sig.length !== modLen) {
        notes?.push("The RSA signature value does not have the length of the key's modulus (leading zero bytes dropped or added); it was read anyway.");
        let s = sig; while (s.length > modLen && s[0] === 0) s = s.subarray(1);
        const o = new Uint8Array(modLen); if (s.length <= modLen) o.set(s, modLen - s.length); sig = o;
      }
      const params = scheme === 'pss' ? {name, saltLength: pss?.saltLength ?? d.len} : {name};
      return subtle().verify(params, key, sig, message);
    }
    if ((this.kind === 'P-256' || this.kind === 'P-384' || this.kind === 'P-521') && scheme === 'ecdsa') {
      const size = {'P-256': 32, 'P-384': 48, 'P-521': 66}[this.kind];
      const key = await subtle().importKey('spki', this.spki, {name: 'ECDSA', namedCurve: this.kind}, false, ['verify']).catch(() => { throw bad('EC public key'); });
      return subtle().verify({name: 'ECDSA', hash: d.web}, key, ecdsaRaw(signature, size, notes), message);
    }
    if (this.kind === 'brainpool' || this.kind === 'Ed25519' || this.kind === 'unsupported') throw unsupported(`${this.describe()} signatures`);
    throw bad(`a ${this.describe()} key can't make ${scheme} signatures`);
  }
}

/** An RSA SPKI with the plain rsaEncryption algorithm (an RSA-PSS SPKI is re-labelled for Web Crypto). */
const rsaSpki = k => seq([algorithm(OID.RSA, nul()), bitString(seq([uint(k.n), uint(k.e)]))]);

/** keys.rs `PrivateKey`: a PKCS #8 key that signs. */
export class PrivateKey {
  constructor(pkcs8, kind, publicKey) { this.pkcs8 = pkcs8; this.kind = kind; this.publicKey = publicKey; }

  static async fromPkcs8(der) {
    let info;
    try { info = Tlv.parseAll(der).children(); } catch { throw new SignError('wrong_password', 'the password is incorrect'); }
    const alg = info[1]?.children() ?? [];
    const o = alg[0]?.oid();
    if (o === OID.RSA) {
      const key = await subtle().importKey('pkcs8', der, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, true, ['sign']).catch(() => { throw bad('RSA private key'); });
      const jwk = await subtle().exportKey('jwk', key);
      const b = s => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
      const spki = rsaSpki({n: b(jwk.n), e: b(jwk.e)});
      return new PrivateKey(der, 'rsa', PublicKey.fromSpki(Tlv.parseAll(spki)));
    }
    if (o === OID.EC) {
      const curve = {[OID.P256]: 'P-256', [OID.P384]: 'P-384', [OID.P521]: 'P-521'}[alg[1]?.oid?.()];
      if (!curve) throw unsupported('this EC curve for signing');
      const key = await subtle().importKey('pkcs8', der, {name: 'ECDSA', namedCurve: curve}, true, ['sign']).catch(() => { throw bad('EC private key'); });
      const jwk = await subtle().exportKey('jwk', key);
      const pub = await subtle().importKey('jwk', {kty: 'EC', crv: curve, x: jwk.x, y: jwk.y, ext: true}, {name: 'ECDSA', namedCurve: curve}, true, ['verify']);
      const spki = new Uint8Array(await subtle().exportKey('spki', pub));
      return new PrivateKey(der, curve, PublicKey.fromSpki(Tlv.parseAll(spki)));
    }
    throw unsupported(`private keys of type ${o}`);
  }

  static async generateRsa(bits) {
    if (![2048, 3072, 4096].includes(bits)) throw unsupported(`${bits}-bit RSA keys`);
    const kp = await subtle().generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256'}, true, ['sign', 'verify']);
    return PrivateKey.fromPkcs8(new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey)));
  }

  static async generateP256() {
    const kp = await subtle().generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    return PrivateKey.fromPkcs8(new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey)));
  }

  /** The digest a signature with this key should use: SHA-256, or SHA-384 for P-384. */
  preferredDigest() { return this.kind === 'P-384' ? DigestAlg.Sha384 : this.kind === 'P-521' ? DigestAlg.Sha512 : DigestAlg.Sha256; }

  /** The signature AlgorithmIdentifier this key writes with `d`. */
  signatureAlgorithm(d) {
    const scheme = this.kind === 'rsa' ? 'rsa' : 'ecdsa';
    const e = SIGNATURE_OIDS.find(x => x[1] === scheme && DigestAlg[x[2]] === d && !x[0].startsWith('0.4.0'));
    const o = e?.[0] ?? (scheme === 'rsa' ? '1.2.840.113549.1.1.11' : '1.2.840.10045.4.3.2');
    return algorithm(o, scheme === 'rsa' ? nul() : null);
  }

  /** Sign `msg` (hashed with `d`). New signatures never use SHA-1. */
  async sign(d, msg) {
    if (![DigestAlg.Sha256, DigestAlg.Sha384, DigestAlg.Sha512].includes(d)) throw unsupported(`${d.name} for new signatures`);
    if (this.kind === 'rsa') {
      const key = await subtle().importKey('pkcs8', this.pkcs8, {name: 'RSASSA-PKCS1-v1_5', hash: d.web}, false, ['sign']);
      return new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', key, msg));
    }
    const key = await subtle().importKey('pkcs8', this.pkcs8, {name: 'ECDSA', namedCurve: this.kind}, false, ['sign']);
    return ecdsaDer(new Uint8Array(await subtle().sign({name: 'ECDSA', hash: d.web}, key, msg)));
  }
}

// ── x509.rs ────────────────────────────────────────────────────────────────────────────────

const CN = '2.5.4.3', C = '2.5.4.6', O = '2.5.4.10', OU = '2.5.4.11', EMAIL = '1.2.840.113549.1.9.1';

/** x509.rs `Name`: the attributes in order, and the raw DER. */
export class Name {
  constructor(attrs, raw) { this.attrs = attrs; this.raw = raw; }

  static parse(t) {
    const attrs = [];
    for (const rdn of t.children()) for (const atv of rdn.children()) {
      const p = atv.children();
      const o = p[0]?.oid();
      const v = p[1]?.text();
      if (o && v != null) attrs.push([o, v]);
    }
    return new Name(attrs, t.raw);
  }

  get(o) { return this.attrs.find(a => a[0] === o)?.[1] ?? null; }
  commonName() { return this.get(CN); }
  organization() { return this.get(O); }
  unit() { return this.get(OU); }
  email() { return this.get(EMAIL); }
  country() { return this.get(C); }
  displayName() { return this.commonName() ?? this.organization() ?? this.display(); }
  display() {
    const key = {[CN]: 'CN', [C]: 'C', [O]: 'O', [OU]: 'OU', [EMAIL]: 'E', '2.5.4.7': 'L', '2.5.4.8': 'ST'};
    return this.attrs.map(([o, v]) => `${key[o] ?? o}=${v}`).join(', ');
  }

  /** A name from its parts (empty ones left out), in the usual order. */
  static build(cn, ou, o, email, country) {
    const rdns = [], attrs = [];
    const add = (id, enc, v) => { if (String(v).trim()) { rdns.push(setOf([seq([oid(id), enc])])); attrs.push([id, String(v).trim()]); } };
    const ctry = String(country ?? '').trim().toUpperCase();
    if (ctry.length === 2) add(C, printable(ctry), ctry);
    add(O, utf8(String(o ?? '').trim()), o ?? '');
    add(OU, utf8(String(ou ?? '').trim()), ou ?? '');
    add(CN, utf8(String(cn ?? '').trim()), cn ?? '');
    add(EMAIL, ia5(String(email ?? '').trim()), email ?? '');
    return new Name(attrs, tlv(tag.SEQUENCE, concat(rdns)));
  }
}

const PROCESSED_EXTENSIONS = ['2.5.29.19', '2.5.29.15', '2.5.29.14', '2.5.29.35', '2.5.29.37', '1.3.6.1.5.5.7.1.1', '2.5.29.31', '2.5.29.17', '2.5.29.18', '2.5.29.32', '1.3.6.1.5.5.7.1.3'];
const EKU_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
const DOCUMENT_SIGNING_EKUS = ['2.5.29.37.0', '1.3.6.1.5.5.7.3.4', '1.3.6.1.5.5.7.3.3', '1.3.6.1.5.5.7.3.36', '1.2.840.113583.1.1.5', '1.3.6.1.4.1.311.10.3.12'];
const SIGNING_BITS = 0b11;

function readExtension(ext, o, value) {
  const parse = () => Tlv.parseAll(value.value);
  switch (o) {
    case '2.5.29.19': {
      ext.hasBasicConstraints = true;
      let fields;
      try { fields = parse().children(); } catch { return; }
      ext.isCa = fields[0]?.tag === tag.BOOLEAN && fields[0].value[0] !== 0;
      const pl = fields.find(t => t.tag === tag.INTEGER);
      if (pl) { try { ext.pathLen = pl.u64(); } catch { ext.pathLen = 0; } }
      return;
    }
    case '2.5.29.15': {
      ext.keyUsage = 0;
      let bits;
      try { bits = parse(); } catch { return; }
      let u = 0;
      [...bits.value.subarray(1, 3)].forEach((byte, i) => { for (let j = 0; j < 8; j++) if (byte & (0x80 >> j)) u |= 1 << (i * 8 + j); });
      ext.keyUsage = u;
      return;
    }
    case '2.5.29.14': try { ext.subjectKeyId = parse().value; } catch { /* skipped */ } return;
    case '2.5.29.35': try { ext.authorityKeyId = parse().children().find(t => t.tag === tag.ctxPrim(0) || t.tag === tag.ctx(0))?.value ?? null; } catch { /* skipped */ } return;
    case '2.5.29.37': {
      let purposes = [];
      try { const eku = parse(); if (eku.tag === tag.SEQUENCE) purposes = eku.children().map(t => t.oid()); } catch { purposes = []; }
      ext.extendedKeyUsage = purposes;
      return;
    }
    default: return;
  }
}

/** x509.rs `Certificate`. */
export class Certificate {
  static parse(raw) {
    raw = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    const cert = Tlv.parseAll(raw).expect(tag.SEQUENCE, 'Certificate');
    const parts = cert.children();
    if (parts.length !== 3) throw bad('Certificate');
    const [tbs, sigAlg, sig] = parts;
    const f = tbs.children();
    let i = 0, version = 0;
    if (f[0]?.tag === tag.ctx(0)) { try { version = f[0].inner().u64(); } catch { version = 2; } i = 1; }
    const c = new Certificate();
    c.raw = raw; c.tbs = tbs.raw; c.sigAlg = sigAlg.raw; c.signature = sig.bits(); c.version = version;
    c.serial = f[i++]?.expect(tag.INTEGER, 'serial').value;
    i++;
    c.issuer = Name.parse(f[i++]);
    const validity = f[i++].children();
    if (validity.length !== 2) throw bad('validity');
    c.subject = Name.parse(f[i++]);
    c.publicKey = PublicKey.fromSpki(f[i++]);
    c.notBefore = validity[0].time(); c.notAfter = validity[1].time();
    const ext = {isCa: false, hasBasicConstraints: false, pathLen: null, keyUsage: null, subjectKeyId: null, authorityKeyId: null, extendedKeyUsage: null};
    c.unknownCritical = [];
    c.extensions = [];
    for (const t of f.slice(i)) {
      if (t.tag !== tag.ctx(3)) continue;
      for (const e of t.inner().children()) {
        const p = e.children();
        let o;
        try { o = p[0].oid(); } catch { continue; }
        const value = p[p.length - 1];
        if (value?.tag !== tag.OCTET_STRING) continue;
        const critical = p.length === 3 && p[1].tag === tag.BOOLEAN && p[1].value[0] !== 0;
        if (critical && !PROCESSED_EXTENSIONS.includes(o)) c.unknownCritical.push(o);
        c.extensions.push({oid: o, critical, value: value.value});
        readExtension(ext, o, value);
      }
    }
    Object.assign(c, ext);
    return c;
  }

  /** x509.rs `signing_problem`: the sentence, or null. */
  signingProblem() {
    if (this.keyUsage != null && (this.keyUsage & SIGNING_BITS) === 0) return "The signer's certificate does not allow digital signatures (its key usage has neither digital signature nor non-repudiation).";
    if (this.extendedKeyUsage && !this.extendedKeyUsage.some(o => DOCUMENT_SIGNING_EKUS.includes(o))) return "The signer's certificate is not issued for signing documents (its extended key usage has no document-signing purpose).";
    if (this.unknownCritical.length) return `The signer's certificate has critical extensions Arkemis does not recognize (${this.unknownCritical.join(', ')}).`;
    return null;
  }

  mayTimestamp() {
    return !!this.extendedKeyUsage?.includes(EKU_TIME_STAMPING) && (this.keyUsage == null || (this.keyUsage & SIGNING_BITS) !== 0) && !this.unknownCritical.length;
  }

  /** Whether `key` verifies this certificate's signature. */
  async signedBy(key) {
    try {
      const alg = Tlv.parseAll(this.sigAlg).children();
      const o = alg[0].oid();
      if (o === OID.RSA_PSS) {
        const p = alg[1]?.children() ?? [];
        const h = p.find(x => x.tag === tag.ctx(0))?.inner().children()[0]?.oid();
        const d = h ? digestFromOid(h) : DigestAlg.Sha1;
        const saltT = p.find(x => x.tag === tag.ctx(2));
        return await key.verify('pss', d, this.tbs, this.signature, null, {saltLength: saltT ? saltT.inner().u64() : 20});
      }
      const s = signatureOid(o);
      if (!s) return false;
      return await key.verify(s.scheme, s.digest, this.tbs, this.signature);
    } catch { return false; }
  }

  async isSelfSigned() { return equalBytes(this.issuer.raw, this.subject.raw) && this.signedBy(this.publicKey); }

  async mayIssue() {
    const KEY_CERT_SIGN = 1 << 5;
    const oldRoot = this.version < 2 && !this.hasBasicConstraints && await this.isSelfSigned();
    return (this.isCa || oldRoot) && (this.keyUsage == null || (this.keyUsage & KEY_CERT_SIGN) !== 0);
  }

  validAt(t) { return this.notBefore.compare(t) <= 0 && t.compare(this.notAfter) <= 0; }
  displayName() { return this.subject.displayName(); }
  fingerprint() { return hex(sha256(this.raw)).match(/../g).join(' '); }
  sha1Fingerprint() { return hex(sha1(this.raw)).match(/../g).join(' '); }
  serialHex() { return hex(this.serial); }
  /** Two certificates are the same when their encodings are. */
  same(o) { return equalBytes(this.raw, o?.raw); }

  /**
   * x509.rs `self_signed`: what Acrobat's "Create a new digital ID ▸ save to file" makes. Valid
   * from `from` for `years`; usable for signing (digital signature and non-repudiation).
   */
  static async selfSigned(name, key, from, years, serial) {
    const d = key.preferredDigest();
    const sigAlg = key.signatureAlgorithm(d);
    const until = new Time(from.year + years, from.month, from.day, from.hour, from.minute, from.second);
    const spki = key.publicKey.spki;
    const ski = sha1(spki);
    const ext = (o, critical, value) => (critical ? seq([oid(o), boolean(true), octets(value)]) : seq([oid(o), octets(value)]));
    const keyUsage = tlv(tag.BIT_STRING, Uint8Array.of(6, 0b1100_0000));
    const extensions = seq([
      ext('2.5.29.15', true, keyUsage),
      ext('2.5.29.14', false, octets(ski)),
      ext('2.5.29.37', false, seq([oid('1.3.6.1.5.5.7.3.4'), oid('1.2.840.113583.1.1.5')])),
    ]);
    const tbs = seq([explicit(0, int(2)), uint(serial), sigAlg, name.raw, seq([from.encode(), until.encode()]), name.raw, spki, explicit(3, extensions)]);
    const signature = await key.sign(d, tbs);
    return Certificate.parse(seq([tbs, sigAlg, bitString(signature)]));
  }

  /** x509.rs `to_pem`. */
  toPem() { return `-----BEGIN CERTIFICATE-----\n${toBase64(this.raw).match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`; }
}

/**
 * x509.rs `build_chain_noted`: the chain from `leaf` up through `pool` as far as issuers can be
 * found and may issue, and why it stopped if a matching certificate was refused.
 * @returns {Promise<{chain: Certificate[], refused: string|null}>}
 */
export async function buildChain(leaf, pool, at = null) {
  const chain = [leaf];
  let refused = null;
  while (chain.length < 10) {
    const last = chain[chain.length - 1];
    if (equalBytes(last.issuer.raw, last.subject.raw)) break;
    const below = chain.length - 1;
    let found = null;
    for (const c of pool) {
      if (!equalBytes(c.subject.raw, last.issuer.raw) || chain.some(x => x.same(c)) || !(await last.signedBy(c.publicKey))) continue;
      let why = null;
      if (!(await c.mayIssue())) why = ['The certificate of ', ' is not a CA certificate that may issue certificates, so it is not used to vouch for ', '.'];
      else if (c.unknownCritical.length && !(await c.isSelfSigned())) why = ['The certificate of ', ' has critical extensions Arkemis does not recognize, so it is not used to vouch for ', '.'];
      else if (c.pathLen != null && below > c.pathLen) why = ['The certificate of ', ' does not allow this many CA certificates below it (path length), so it is not used to vouch for ', '.'];
      else if (at && !c.validAt(at)) why = ['The certificate of ', ' was not valid at the time of signing, so it is not used to vouch for ', '.'];
      if (!why) { found = c; break; }
      refused = `${why[0]}${c.displayName()}${why[1]}${last.displayName()}${why[2]}`;
    }
    if (!found) break;
    refused = null;
    chain.push(found);
  }
  return {chain, refused};
}

/** x509.rs `load_certificates`: DER, or PEM with CERTIFICATE blocks. */
export function loadCertificates(bytes) {
  if (bytes[0] === 0x30) return [Certificate.parse(bytes)];
  const text = latin1(bytes);
  const out = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let m;
  while ((m = re.exec(text))) out.push(Certificate.parse(fromBase64(m[1].replace(/\s+/g, ''))));
  if (!out.length) throw bad('no certificate found (expected DER, PEM or a PKCS #7 bundle)');
  return out;
}

export {digest};
