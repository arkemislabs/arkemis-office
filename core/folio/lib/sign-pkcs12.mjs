// PKCS #12 digital ID files (RFC 7292): `.p12` / `.pfx`, as Acrobat, OpenSSL, macOS Keychain and
// Windows export them.
//
// Translated from printcraft crates/sign/src/pkcs12.rs (OIDs, WRITE_ROUNDS, MIN_PASSWORD_CHARS,
// OPEN_BUDGET/Budget, DigitalId, pbe_decrypt, bags, normalize, pem_body, open, write) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Reading supports PBES2 (PBKDF2 with HMAC-SHA-1/256/384/512; AES-128/192/256-CBC or 3DES-CBC)
// and the legacy PKCS #12 PBE schemes (SHA-1 with 3DES or RC2), and checks the MAC. Writing
// uses PBES2 AES-256-CBC with PBKDF2-HMAC-SHA-256 and an HMAC-SHA-256 MAC at WRITE_ROUNDS, as
// upstream. No DOM, no Node built-ins.

import {Tlv, tag, SignError, bad, unsupported, seq, setOf, oid, explicit, octets, tlv, int, nul, concat, equalBytes, fromBase64, latin1} from './sign-der.mjs';
import {DigestAlg, digestFromOid, digestAlgorithm, hmac, pbkdf2, pkcs12Kdf, bmp, aesCbcDecrypt, aesCbcEncrypt, des3CbcDecrypt, rc2CbcDecrypt, random, sha1} from './sign-crypto.mjs';
import {PrivateKey, Certificate} from './sign-x509.mjs';

const DATA = '1.2.840.113549.1.7.1', ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const KEY_BAG = '1.2.840.113549.1.12.10.1.1', SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2', CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const X509_CERT = '1.2.840.113549.1.9.22.1', FRIENDLY_NAME = '1.2.840.113549.1.9.20', LOCAL_KEY_ID = '1.2.840.113549.1.9.21';
const PBES2 = '1.2.840.113549.1.5.13', PBKDF2 = '1.2.840.113549.1.5.12';
const HMACS = {'1.2.840.113549.2.7': DigestAlg.Sha1, '1.2.840.113549.2.9': DigestAlg.Sha256, '1.2.840.113549.2.10': DigestAlg.Sha384, '1.2.840.113549.2.11': DigestAlg.Sha512};
const HMAC_SHA256 = '1.2.840.113549.2.9';
const AES = {'2.16.840.1.101.3.4.1.2': 16, '2.16.840.1.101.3.4.1.22': 24, '2.16.840.1.101.3.4.1.42': 32};
const AES256_CBC = '2.16.840.1.101.3.4.1.42', DES_EDE3_CBC = '1.2.840.113549.3.7';
const PBE_SHA_3DES = '1.2.840.113549.1.12.1.3', PBE_SHA_2DES = '1.2.840.113549.1.12.1.4', PBE_SHA_RC2_128 = '1.2.840.113549.1.12.1.5', PBE_SHA_RC2_40 = '1.2.840.113549.1.12.1.6';

/** Key-derivation rounds for new files: OWASP's figure for PBKDF2-HMAC-SHA-256. */
export const WRITE_ROUNDS = 600_000;
/** The shortest password a new digital ID may have (NIST SP 800-63B). */
export const MIN_PASSWORD_CHARS = 8;
/** The most key-derivation work one `open` does, in hash blocks over every derivation in the file. */
const OPEN_BUDGET = 10_000_000;

class Budget {
  constructor(left) { this.left = left; }
  spend(d, rounds, len) {
    const blocks = Math.max(1, Math.ceil(len / Math.max(1, d.len)));
    const cost = Math.max(1, rounds) * blocks;
    if (cost > this.left || rounds > 0xffffffff) throw new SignError('unsupported', `not supported: PKCS #12 files that need more than ${OPEN_BUDGET} rounds of key derivation (${rounds} asked for)`);
    this.left -= cost;
    return rounds;
  }
}

const p12bad = what => bad(`PKCS #12: ${what}`);
const utf8 = s => new TextEncoder().encode(s);

/** Decrypt `ct` with the password-based scheme `alg` (an AlgorithmIdentifier Tlv). */
async function pbeDecrypt(alg, password, ct, budget) {
  const parts = alg.children();
  const o = parts[0]?.oid();
  const params = parts[1];
  if (!params) throw p12bad('algorithm parameters');
  if (o === PBES2) {
    const [kdf, scheme] = params.children();
    if (!kdf || !scheme) throw p12bad('PBES2 parameters');
    const k = kdf.children();
    if (k[0]?.oid() !== PBKDF2) throw unsupported('PBES2 key derivation other than PBKDF2');
    const kp = k[1].children();
    const salt = kp[0].octets('salt');
    const rounds = kp[1].u64();
    const prfT = kp.slice(2).find(t => t.tag === tag.SEQUENCE);
    let prf = DigestAlg.Sha1;
    if (prfT) { const po = prfT.children()[0]?.oid(); prf = HMACS[po]; if (!prf) throw unsupported(`PBKDF2 PRF ${po}`); }
    const sc = scheme.children();
    const co = sc[0]?.oid();
    const keyLen = AES[co] ?? (co === DES_EDE3_CBC ? 24 : 0);
    if (!keyLen) throw unsupported(`PBES2 cipher ${co ?? '?'}`);
    const iv = sc[1].octets('IV');
    budget.spend(prf, rounds, keyLen);
    const key = await pbkdf2(prf, utf8(password), salt, rounds, keyLen);
    return co === DES_EDE3_CBC ? des3CbcDecrypt(key, iv, ct) : aesCbcDecrypt(key, iv, ct);
  }
  if ([PBE_SHA_3DES, PBE_SHA_2DES, PBE_SHA_RC2_128, PBE_SHA_RC2_40].includes(o)) {
    const p = params.children();
    const salt = p[0].octets('salt');
    const rounds = p[1].u64();
    const [cipher, keyLen] = o === PBE_SHA_3DES ? ['3des', 24] : o === PBE_SHA_2DES ? ['3des', 16] : o === PBE_SHA_RC2_128 ? ['rc2', 16] : ['rc2', 5];
    const pw = bmp(password);
    budget.spend(DigestAlg.Sha1, rounds, keyLen);
    budget.spend(DigestAlg.Sha1, rounds, 8);
    let key = await pkcs12Kdf(DigestAlg.Sha1, pw, salt, 1, rounds, keyLen);
    if (key.length === 16 && cipher === '3des') key = concat([key, key.subarray(0, 8)]);
    const iv = await pkcs12Kdf(DigestAlg.Sha1, pw, salt, 2, rounds, 8);
    return cipher === '3des' ? des3CbcDecrypt(key, iv, ct) : rc2CbcDecrypt(key, keyLen * 8, iv, ct);
  }
  throw unsupported(`PKCS #12 encryption ${o}`);
}

async function bags(safeContents, password, out, budget) {
  for (const bag of Tlv.parseAllBer(safeContents).children()) {
    const f = bag.children();
    let id;
    try { id = f[0].oid(); } catch { continue; }
    if (f[1]?.tag !== tag.ctx(0)) continue;
    let value;
    try { value = f[1].inner(); } catch { continue; }
    let localKeyId = null, friendlyName = null;
    if (f[2]) for (const a of f[2].children()) {
      const p = a.children();
      const v = p[1]?.children()?.[0];
      const ao = p[0]?.oid?.();
      if (ao === LOCAL_KEY_ID && v) { try { localKeyId = v.octets('local key id'); } catch { /* skipped */ } }
      if (ao === FRIENDLY_NAME && v) friendlyName = v.text();
    }
    let kind;
    if (id === KEY_BAG) kind = {key: value.raw};
    else if (id === SHROUDED_KEY_BAG) {
      const p = value.children();
      if (p.length !== 2) throw p12bad('EncryptedPrivateKeyInfo');
      kind = {key: await pbeDecrypt(p[0], password, p[1].octets('encrypted private key'), budget)};
    } else if (id === CERT_BAG) {
      const p = value.children();
      if (p[0]?.oid?.() !== X509_CERT) continue;
      try { kind = {cert: p[1].inner().octets('certificate')}; } catch { continue; }
    } else continue;
    out.push({...kind, localKeyId, friendlyName});
  }
}

function normalize(bytes) {
  let s = 0, e = bytes.length;
  const ws = b => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;
  while (s < e && ws(bytes[s])) s++;
  while (e > s && ws(bytes[e - 1])) e--;
  const t = bytes.subarray(s, e);
  if (t[0] === 0x30) return t;
  const text = latin1(t);
  if (text.startsWith('-----BEGIN')) {
    const begin = text.indexOf('-----BEGIN ');
    const nl = text.indexOf('\n', begin);
    const bodyStart = nl < 0 ? text.length : nl + 1;
    const end = text.indexOf('-----END ');
    if (end < bodyStart) throw p12bad('PEM file has no END marker');
    const body = text.slice(bodyStart, end);
    if (!body.trim()) throw p12bad('PEM file has an empty body');
    return fromBase64(body.replace(/\s+/g, ''));
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) return fromBase64(text.replace(/\s+/g, ''));
  return t;
}

/** A digital ID: the signing key, its certificate and the other certificates in the file. */
export class DigitalId {
  constructor(key, certificate, chain = [], friendlyName = null) { Object.assign(this, {key, certificate, chain, friendlyName}); }
}

/** Open a `.p12` / `.pfx` file. A wrong password is a SignError with kind 'wrong_password'. */
export async function open(bytes, password) {
  const der = normalize(bytes);
  let pfx;
  try { pfx = Tlv.parseAllBer(der).children(); } catch (e) { throw p12bad(`not a PKCS #12 file: ${e.message}`); }
  const authSafe = pfx[1]?.children();
  if (!authSafe) throw p12bad('authSafe');
  if (authSafe[0]?.oid() !== DATA) throw unsupported('public-key protected PKCS #12 files');
  const content = authSafe[1].inner().octets('authSafe');
  const budget = new Budget(OPEN_BUDGET);
  if (pfx[2]) {
    const m = pfx[2].children();
    const di = m[0].children();
    const algOid = di[0].children()[0].oid();
    const d = digestFromOid(algOid);
    if (!d || ![DigestAlg.Sha1, DigestAlg.Sha256, DigestAlg.Sha384, DigestAlg.Sha512].includes(d)) throw unsupported(`MAC digest ${algOid}`);
    const expected = di[1].octets('MAC');
    const salt = m[1].octets('MAC salt');
    const iterations = m[2] ? m[2].u64() : 1;
    budget.spend(d, iterations, d.len);
    const key = await pkcs12Kdf(d, bmp(password), salt, 3, iterations, d.len);
    if (!equalBytes(await hmac(d, key, content), expected)) throw new SignError('wrong_password', 'the password is incorrect');
  }
  const all = [];
  for (const ci of Tlv.parseAllBer(content).children()) {
    const p = ci.children();
    const kind = p[0].oid();
    const body = p[1].inner();
    if (kind === DATA) await bags(body.octets('SafeContents'), password, all, budget);
    else if (kind === ENCRYPTED_DATA) {
      const ed = body.children();
      const eci = ed[1].children();
      const alg = eci[1];
      const t = eci[2];
      let ct;
      if (t?.tag === tag.ctxPrim(0)) ct = t.value;
      else if (t?.tag === tag.ctx(0)) ct = concat(t.children().map(s => s.octets('encryptedContent')));
      else throw p12bad('encryptedContent');
      await bags(await pbeDecrypt(alg, password, ct, budget), password, all, budget);
    }
  }
  const keyBag = all.find(b => b.key);
  if (!keyBag) throw p12bad('no private key');
  const key = await PrivateKey.fromPkcs8(keyBag.key);
  const certs = [];
  for (const b of all) if (b.cert) { try { certs.push([Certificate.parse(b.cert), b]); } catch { /* skipped */ } }
  let idx = keyBag.localKeyId ? certs.findIndex(([, b]) => b.localKeyId && equalBytes(b.localKeyId, keyBag.localKeyId)) : -1;
  if (idx < 0) idx = certs.findIndex(([c]) => equalBytes(c.publicKey.spki, key.publicKey.spki));
  if (idx < 0) throw p12bad('no certificate for the private key');
  const friendlyName = keyBag.friendlyName ?? certs[idx][1].friendlyName ?? null;
  const certificate = certs[idx][0];
  if (!equalBytes(certificate.publicKey.spki, key.publicKey.spki)) throw p12bad('the certificate does not match the private key');
  return new DigitalId(key, certificate, certs.filter((_, i) => i !== idx).map(([c]) => c), friendlyName);
}

/** Write a digital ID as a `.p12` protected by `password`. `rounds` is for tests only. */
export async function write(id, password, {rounds = WRITE_ROUNDS} = {}) {
  const encrypt = async plain => {
    const salt = random(16), iv = random(16);
    const key = await pbkdf2(DigestAlg.Sha256, utf8(password), salt, rounds, 32);
    const ct = await aesCbcEncrypt(key, iv, plain);
    const kdf = seq([oid(PBKDF2), seq([octets(salt), int(rounds), seq([oid(HMAC_SHA256), nul()])])]);
    const alg = seq([oid(PBES2), seq([kdf, seq([oid(AES256_CBC), octets(iv)])])]);
    return {alg, ct};
  };
  const localId = sha1(id.certificate.raw);
  const attrs = [seq([oid(LOCAL_KEY_ID), setOf([octets(localId)])])];
  if (id.friendlyName) {
    const v = [];
    for (const ch of id.friendlyName) { const c = ch.charCodeAt(0); v.push(c >> 8, c & 0xff); }
    attrs.push(seq([oid(FRIENDLY_NAME), setOf([tlv(tag.BMP_STRING, Uint8Array.from(v))])]));
  }
  const attrSet = setOf(attrs);
  const certBag = (c, withAttrs) => {
    const value = explicit(0, seq([oid(X509_CERT), explicit(0, octets(c.raw))]));
    return withAttrs ? seq([oid(CERT_BAG), value, attrSet]) : seq([oid(CERT_BAG), value]);
  };
  const certsPlain = seq([certBag(id.certificate, true), ...id.chain.map(c => certBag(c, false))]);
  const encCerts = await encrypt(certsPlain);
  const eci = seq([oid(DATA), encCerts.alg, tlv(tag.ctxPrim(0), encCerts.ct)]);
  const ciCerts = seq([oid(ENCRYPTED_DATA), explicit(0, seq([int(0), eci]))]);
  const encKey = await encrypt(id.key.pkcs8);
  const keyBag = seq([oid(SHROUDED_KEY_BAG), explicit(0, seq([encKey.alg, octets(encKey.ct)])), attrSet]);
  const ciKey = seq([oid(DATA), explicit(0, octets(seq([keyBag])))]);
  const authSafe = seq([ciCerts, ciKey]);
  const salt = random(16);
  const macKey = await pkcs12Kdf(DigestAlg.Sha256, bmp(password), salt, 3, rounds, 32);
  const mac = await hmac(DigestAlg.Sha256, macKey, authSafe);
  const macData = seq([seq([digestAlgorithm(DigestAlg.Sha256), octets(mac)]), octets(salt), int(rounds)]);
  return seq([int(3), seq([oid(DATA), explicit(0, octets(authSafe))]), macData]);
}
