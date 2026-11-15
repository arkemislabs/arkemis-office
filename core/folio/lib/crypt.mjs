// The PDF standard security handler (ISO 32000-2 section 7.6): every revision, standalone.
//
// Translated from printcraft crates/crypt/src/lib.rs (SecurityHandler::open / authenticate_owner /
// permissions, Algorithms 1 to 10 of the specification: file key and U / O values for R2 to R4, the
// R6 hash 2.B, key unwrap for R5 and R6, create) and crates/crypt/src/rc4.rs at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
//
// Upstream calls RustCrypto. Here SHA-2 and AES-CBC are the platform's Web Crypto (present in the
// renderer, in the format worker and in Node), so every function that ciphers is async; MD5 (which
// Web Crypto lacks) and RC4 are small synchronous implementations. No DOM, no Node built-ins.
//
// Passwords are bytes in here and nowhere else: nothing in this file logs, stores or returns one.

export class CryptError extends Error {
  constructor(code, message) { super(message); this.name = 'CryptError'; this.code = code; }
}
const wrongPassword = () => new CryptError('wrong_password', 'The password is incorrect.');
const unsupported = what => new CryptError('unsupported', `Unsupported security handler: ${what}`);
const malformed = what => new CryptError('malformed', `Malformed encryption dictionary: ${what}`);

/** 32-byte padding string of revisions 2 to 4 (7.6.4.3.2, step a). */
export const PADDING = Uint8Array.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);

/** How a crypt filter ciphers (/CFM). */
export const Method = Object.freeze({Identity: 'Identity', Rc4: 'Rc4', Aes128: 'Aes128', Aes256: 'Aes256'});
/** Which password authenticated the document. */
export const Auth = Object.freeze({Owner: 'owner', User: 'user'});
/** What to create. */
export const Algorithm = Object.freeze({Rc4_40: 'Rc4_40', Rc4_128: 'Rc4_128', Aes128: 'Aes128', Aes256: 'Aes256'});

// ── bytes ──────────────────────────────────────────────────────────────────────────────────────

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const hexOf = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const bytesOfHex = h => Uint8Array.from((h.match(/../g) ?? []).map(x => parseInt(x, 16)));
const le32 = n => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

// ── RC4 ────────────────────────────────────────────────────────────────────────────────────────

/** RC4 (revisions 2 to 4). Encrypting and decrypting are the same. */
export function rc4(key, data) {
  if (!key.length) return Uint8Array.from(data);
  const s = Uint8Array.from({length: 256}, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + s[a]) & 255;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = data[k] ^ s[(s[a] + s[b]) & 255];
  }
  return out;
}

// ── MD5 (RFC 1321) ─────────────────────────────────────────────────────────────────────────────

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Uint32Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

/** MD5 of `data` (Web Crypto has no MD5). */
export function md5(data) {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len << 3) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      const sh = MD5_S[((i >> 4) << 2) | (i & 3)];
      b = (b + ((f << sh) | (f >>> (32 - sh)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const o = new DataView(out.buffer);
  o.setUint32(0, a0, true); o.setUint32(4, b0, true); o.setUint32(8, c0, true); o.setUint32(12, d0, true);
  return out;
}

// ── SHA-2 and AES-CBC (Web Crypto) ─────────────────────────────────────────────────────────────

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CryptError('crypto', 'Cryptography is unavailable in this runtime.');
  return s;
};
const sha = async (name, data) => new Uint8Array(await subtle().digest(name, data));
const sha256 = data => sha('SHA-256', data);

const keyCache = new Map();
async function aesKey(key, usage) {
  const id = `${hexOf(key)}:${usage}`;
  let k = keyCache.get(id);
  if (!k) {
    k = await subtle().importKey('raw', key, 'AES-CBC', false, [usage]);
    if (keyCache.size > 256) keyCache.clear();
    keyCache.set(id, k);
  }
  return k;
}

/** AES-CBC encrypt; `pad` adds PKCS#7 padding, else `data` must be a whole number of blocks. */
export async function aesCbcEncrypt(key, iv, data, pad) {
  const out = new Uint8Array(await subtle().encrypt({name: 'AES-CBC', iv}, await aesKey(key, 'encrypt'), data));
  return pad ? out : out.subarray(0, data.length);
}

/**
 * AES-CBC decrypt. `unpad` strips PKCS#7 padding (a bad padding is tolerated: the data as it came,
 * as printcraft's tolerant reader does); otherwise whole blocks come back untouched (Web Crypto
 * always checks padding, so one block of valid padding is made and appended).
 */
export async function aesCbcDecrypt(key, iv, data, unpad) {
  const whole = data.length - (data.length % 16);
  if (!whole) return new Uint8Array(0);
  const body = data.subarray(0, whole);
  const k = await aesKey(key, 'decrypt');
  if (unpad) {
    try { return new Uint8Array(await subtle().decrypt({name: 'AES-CBC', iv}, k, body)); } catch { /* bad padding: below */ }
  }
  const last = body.subarray(whole - 16);
  const block = new Uint8Array(await subtle().encrypt({name: 'AES-CBC', iv: last}, await aesKey(key, 'encrypt'), new Uint8Array(0))).subarray(0, 16);
  const plain = new Uint8Array(await subtle().decrypt({name: 'AES-CBC', iv}, k, concat(body, block))).subarray(0, whole);
  if (!unpad) return plain;
  const n = plain[plain.length - 1];
  return n >= 1 && n <= 16 && n <= plain.length ? plain.subarray(0, plain.length - n) : plain;
}

// ── AES decryption, synchronous ────────────────────────────────────────────────────────────────
// The reader of an encrypted file (lib/protect.mjs) decrypts each object as the parser reaches it, and a
// parser cannot wait for Web Crypto; AES decryption is the one cipher it needs synchronously. FIPS 197,
// the straightforward inverse cipher with computed tables.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 255;
    q = (q ^ (q << 1)) & 255; q = (q ^ (q << 2)) & 255; q = (q ^ (q << 4)) & 255; q ^= q & 0x80 ? 0x09 : 0;
    const rot = (x, n) => ((x << n) | (x >> (8 - n))) & 255;
    SBOX[p] = q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}
const xtime = x => ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 255;
const gmul = (a, b) => { let r = 0; for (; b; b >>= 1) { if (b & 1) r ^= a; a = xtime(a); } return r; };
const M9 = Uint8Array.from({length: 256}, (_, i) => gmul(i, 9));
const M11 = Uint8Array.from({length: 256}, (_, i) => gmul(i, 11));
const M13 = Uint8Array.from({length: 256}, (_, i) => gmul(i, 13));
const M14 = Uint8Array.from({length: 256}, (_, i) => gmul(i, 14));

function expandKey(key) {
  const nk = key.length >> 2;
  const rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) { t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]); rcon = xtime(rcon); }
    else if (nk > 6 && i % nk === 4) t = t.map(b => SBOX[b]);
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return {w, rounds};
}

function decryptBlock({w, rounds}, input, out) {
  const s = Uint8Array.from(input);
  const addKey = r => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
  const invShiftSub = () => {
    const t = Uint8Array.from(s);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[((c + r) & 3) * 4 + r] = INV_SBOX[t[c * 4 + r]];
  };
  addKey(rounds);
  for (let r = rounds - 1; r >= 0; r--) {
    invShiftSub();
    addKey(r);
    if (r === 0) break;
    for (let c = 0; c < 4; c++) {
      const [a, b, d, e] = [s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]];
      s[c * 4] = M14[a] ^ M11[b] ^ M13[d] ^ M9[e];
      s[c * 4 + 1] = M9[a] ^ M14[b] ^ M11[d] ^ M13[e];
      s[c * 4 + 2] = M13[a] ^ M9[b] ^ M14[d] ^ M11[e];
      s[c * 4 + 3] = M11[a] ^ M13[b] ^ M9[d] ^ M14[e];
    }
  }
  out.set(s);
}

const M2 = Uint8Array.from({length: 256}, (_, i) => xtime(i));
const M3 = Uint8Array.from({length: 256}, (_, i) => xtime(i) ^ i);

const ST = new Uint8Array(16);
const TT = new Uint8Array(16);
// ShiftRows as an index map: output position c*4+row takes input ((c + row) & 3) * 4 + row.
const SHIFT = Uint8Array.from({length: 16}, (_, i) => (((i >> 2) + (i & 3)) & 3) * 4 + (i & 3));

function encryptBlock({w, rounds}, input, out) {
  const s = ST;
  const t = TT;
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ w[i];
  for (let r = 1; r <= rounds; r++) {
    for (let i = 0; i < 16; i++) t[i] = SBOX[s[SHIFT[i]]];
    const k = r * 16;
    if (r < rounds) {
      for (let c = 0; c < 16; c += 4) {
        const a = t[c];
        const b = t[c + 1];
        const d = t[c + 2];
        const e = t[c + 3];
        s[c] = M2[a] ^ M3[b] ^ d ^ e ^ w[k + c];
        s[c + 1] = a ^ M2[b] ^ M3[d] ^ e ^ w[k + c + 1];
        s[c + 2] = a ^ b ^ M2[d] ^ M3[e] ^ w[k + c + 2];
        s[c + 3] = M3[a] ^ b ^ d ^ M2[e] ^ w[k + c + 3];
      }
    } else for (let i = 0; i < 16; i++) s[i] = t[i] ^ w[k + i];
  }
  for (let i = 0; i < 16; i++) out[i] = s[i];
}

/** AES-CBC encrypt of whole blocks, without waiting (the R6 password hash runs it hundreds of times). */
export function aesCbcEncryptSync(key, iv, data) {
  const sched = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  const block = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) block[i] = data[off + i] ^ prev[i];
    encryptBlock(sched, block, out.subarray(off, off + 16));
    prev = out.subarray(off, off + 16);
  }
  return out;
}

/** AES-CBC decrypt without waiting (same results as aesCbcDecrypt, which Web Crypto does). */
export function aesCbcDecryptSync(key, iv, data, unpad) {
  const whole = data.length - (data.length % 16);
  const sched = expandKey(key);
  const out = new Uint8Array(whole);
  let prev = iv;
  for (let off = 0; off < whole; off += 16) {
    const block = data.subarray(off, off + 16);
    decryptBlock(sched, block, out.subarray(off, off + 16));
    for (let i = 0; i < 16; i++) out[off + i] ^= prev[i];
    prev = block;
  }
  if (!unpad) return out;
  const n = out[out.length - 1];
  return n >= 1 && n <= 16 && n <= out.length ? out.subarray(0, out.length - n) : out;
}

// ── passwords ──────────────────────────────────────────────────────────────────────────────────

const PDFDOC_LOW = ['˘', 'ˇ', 'ˆ', '˙', '˝', '˛', '˚', '˜'];
const PDFDOC_HIGH = ['•', '†', '‡', '…', '—', '–', 'ƒ', '⁄', '‹', '›', '−', '‰', '„', '“', '”', '‘', '’', '‚', '™', 'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š', 'Ÿ', 'Ž', 'ı', 'ł', 'œ',
  'š', 'ž', '�', '€'];

/** Unicode character to its PDFDocEncoding byte, or null for one it lacks. */
export function pdfdocByte(ch) {
  const lo = PDFDOC_LOW.indexOf(ch);
  if (lo >= 0) return 0x18 + lo;
  const hi = PDFDOC_HIGH.indexOf(ch);
  if (hi >= 0 && ch !== '�') return 0x80 + hi;
  const n = ch.codePointAt(0);
  if ((n >= 0x18 && n <= 0x1f) || (n >= 0x80 && n <= 0xa0)) return null;
  return n < 256 ? n : null;
}

const utf8 = s => new TextEncoder().encode(s);
/** Revisions 2 to 4: PDFDocEncoding, at most 32 bytes, characters it lacks dropped. */
const legacyPassword = pw => Uint8Array.from(Array.from(pw).map(pdfdocByte).filter(b => b !== null).slice(0, 32));
/** The byte strings an R2 to R4 password may have been written as (see printcraft legacy_candidates). */
const legacyCandidates = pw => {
  const out = [legacyPassword(pw)];
  if (Array.from(pw).some(c => pdfdocByte(c) === null)) out.push(utf8(pw).subarray(0, 32));
  return out;
};
/** Revisions 5 and 6: SASLprep (RFC 4013) in UTF-8, at most 127 bytes. */
export function saslPassword(pw) {
  // Map: non-ASCII spaces to a plain space, characters mapped to nothing removed; then NFKC.
  const mapped = Array.from(pw).filter(c => !/[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/.test(c)).map(c => (/[   -​  　]/.test(c) ? ' ' : c)).join('');
  return utf8(mapped.normalize('NFKC')).subarray(0, 127);
}
const pad = pw => { const out = PADDING.slice(); out.set(pw.subarray(0, 32)); out.set(PADDING.subarray(0, 32 - Math.min(pw.length, 32)), Math.min(pw.length, 32)); return out; };

/** The bytes new encryption derives keys from (printcraft effective_password): equal bytes are one password to the file. */
export function effectivePassword(algorithm, password) {
  return algorithm === Algorithm.Aes256 ? saslPassword(password) : pad(legacyPassword(password));
}

// ── the /Encrypt values ────────────────────────────────────────────────────────────────────────

/**
 * Read the handler's values from a COS /Encrypt dictionary the caller already resolved:
 * `{Filter, V, R, Length, O, U, OE, UE, Perms, P, EncryptMetadata, CF: {name: 'V2'|'AESV2'|'AESV3'|...}, StmF, StrF, EFF, CFLength}`
 * (strings as Uint8Array). Missing values take the specification's defaults.
 */
export function encryptDict(raw) {
  const v = raw.V ?? 0;
  const cfLen = raw.CFLength > 0 ? raw.CFLength : null;
  let lengthBits;
  if (v >= 5) lengthBits = 256;
  else if (v === 4) lengthBits = cfLen === null ? 128 : cfLen <= 32 ? cfLen * 8 : cfLen;
  else lengthBits = raw.Length ?? 40;
  const methods = {V2: Method.Rc4, AESV2: Method.Aes128, AESV3: Method.Aes256};
  return {
    filter: raw.Filter ?? '', v, r: raw.R ?? 0, lengthBits,
    o: raw.O ?? new Uint8Array(0), u: raw.U ?? new Uint8Array(0), oe: raw.OE ?? new Uint8Array(0), ue: raw.UE ?? new Uint8Array(0), perms: raw.Perms ?? new Uint8Array(0),
    p: (raw.P ?? -1) | 0, encryptMetadata: raw.EncryptMetadata !== false,
    cryptFilters: Object.entries(raw.CF ?? {}).map(([name, cfm]) => [name, methods[cfm] ?? Method.Identity]),
    stmF: raw.StmF ?? 'Identity', strF: raw.StrF ?? 'Identity', effF: raw.EFF ?? '',
  };
}

const keyLen = d => (d.r === 2 ? 5 : Math.min(Math.max(d.lengthBits, 40), 128) >> 3);

// Revisions 2 to 4 --------------------------------------------------------------------------------

/** Algorithm 2: the file key from a (user) password. */
function fileKeyR4(d, id0, pw) {
  const n = keyLen(d);
  let digest = md5(concat(pad(pw), d.o.subarray(0, 32), le32(d.p), id0, d.r >= 4 && !d.encryptMetadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)));
  if (d.r >= 3) for (let i = 0; i < 50; i++) digest = md5(digest.subarray(0, n));
  return digest.slice(0, n);
}

/** Algorithms 4 and 5: the /U value a key produces. */
function uValueR4(d, id0, key) {
  if (d.r === 2) return rc4(key, PADDING);
  let x = rc4(key, md5(concat(PADDING, id0)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map(b => b ^ i), x);
  return concat(x, new Uint8Array(16));
}

/** Algorithm 6: authenticate a user password; returns the file key, or null. */
function userKeyR4(d, id0, pw) {
  const check = dict => {
    const key = fileKeyR4(dict, id0, pw);
    const u = uValueR4(dict, id0, key);
    const n = dict.r === 2 ? 32 : 16;
    return dict.u.length >= n && eq(u.subarray(0, n), dict.u.subarray(0, n)) ? key : null;
  };
  // Some producers ignore /EncryptMetadata false when deriving the key; viewers open those files.
  return check(d) ?? (d.r >= 4 && !d.encryptMetadata ? check({...d, encryptMetadata: true}) : null);
}

/** The RC4 key of an owner password (Algorithm 3, steps a to d). */
function ownerRc4Key(d, ownerPw) {
  const n = keyLen(d);
  let digest = md5(pad(ownerPw));
  if (d.r >= 3) for (let i = 0; i < 50; i++) digest = md5(digest);
  return digest.slice(0, n);
}

/** Algorithm 7: authenticate an owner password; the file key, or null. */
function ownerKeyR4(d, id0, pw) {
  const rk = ownerRc4Key(d, pw);
  let user = d.o.slice(0, 32);
  if (d.r === 2) user = rc4(rk, user);
  else for (let i = 19; i >= 0; i--) user = rc4(rk.map(b => b ^ i), user);
  return userKeyR4(d, id0, user);
}

// Revisions 5 and 6 -------------------------------------------------------------------------------

/** The hash of a password: SHA-256 for R5, Algorithm 2.B for R6. */
async function hashR6(r, pw, salt, udata) {
  let k = await sha256(concat(pw, salt, udata));
  if (r === 5) return k;
  let round = 0;
  for (;;) {
    const unit = concat(pw, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length);
    const e = aesCbcEncryptSync(k.subarray(0, 16), k.subarray(16, 32), k1);
    let m = 0;
    for (let i = 0; i < 16; i++) m += e[i];
    m %= 3;
    k = await sha(m === 0 ? 'SHA-256' : m === 1 ? 'SHA-384' : 'SHA-512', e);
    round++;
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }
  return k.slice(0, 32);
}

/** Algorithm 2.A: authenticate as owner or user; the file key, or null. */
async function keyR6(d, pw, owner) {
  if (d.u.length < 48 || d.o.length < 48) throw malformed('/O and /U must be 48 bytes for R5/R6');
  const hashed = owner ? d.o.subarray(0, 48) : d.u.subarray(0, 48);
  const encrypted = owner ? d.oe : d.ue;
  const udata = owner ? d.u.subarray(0, 48) : new Uint8Array(0);
  if (!eq(await hashR6(d.r, pw, hashed.subarray(32, 40), udata), hashed.subarray(0, 32))) return null;
  if (encrypted.length < 32) throw malformed('/OE or /UE must be 32 bytes');
  const k = await hashR6(d.r, pw, hashed.subarray(40, 48), udata);
  return aesCbcDecrypt(k, new Uint8Array(16), encrypted.subarray(0, 32), false);
}

// ── the handler ────────────────────────────────────────────────────────────────────────────────

/** Permission bits of /P (Table 22). Owners have every permission. */
export function permissionsOf(bits, owner) {
  const bit = n => owner || ((bits >> (n - 1)) & 1) === 1;
  return {
    bits, owner,
    print: bit(3), modify: bit(4), copy: bit(5), annotate: bit(6),
    fillForms: bit(9) || bit(6), accessibility: bit(10), assemble: bit(11) || bit(4), printHigh: bit(12),
  };
}

/** The permissions in the document model's own words (content.permissions): false only where denied. */
export function modelPermissions(p) {
  if (p.owner) return null;
  return {print: p.print, modify: p.modify, copy: p.copy, annotate: p.annotate, fillForms: p.fillForms, accessibility: p.accessibility, assemble: p.assemble, printHigh: p.printHigh};
}

/** Whether the permissions leave security free to change (printcraft unrestricted: bits 3 to 6 and 9 to 12 all set). */
export const unrestricted = p => p.owner || (p.bits & 0b111100111100) === 0b111100111100;

export class SecurityHandler {
  constructor(dict, key, auth, recoveredUser = null) {
    this.dict = dict;
    this.key = key;
    this.auth = auth;
    this.recoveredUser = recoveredUser;
    const named = new Map();
    for (const [n, m] of dict.cryptFilters) if (!named.has(n)) named.set(n, m);
    const get = name => (!name || name === 'Identity' ? Method.Identity : named.get(name) ?? Method.Identity);
    this.named = {get};
    this.methods = {string: get(dict.strF), stream: get(dict.stmF), embedded: get(dict.effF || dict.stmF)};
  }

  /** Authenticate with `password` (owner first, then user; none = the empty password). */
  static async open(dict, id0, password = '') {
    if (dict.filter && dict.filter !== 'Standard') throw unsupported(`/Filter /${dict.filter}`);
    let found = null;
    if (dict.r >= 2 && dict.r <= 4) {
      for (const legacy of legacyCandidates(password)) {
        const owner = ownerKeyR4(dict, id0, legacy);
        if (owner) { found = [owner, Auth.Owner]; break; }
        const user = userKeyR4(dict, id0, legacy);
        if (user) { found = [user, Auth.User]; break; }
      }
    } else if (dict.r === 5 || dict.r === 6) {
      const pw = saslPassword(password);
      const owner = await keyR6(dict, pw, true);
      if (owner) found = [owner, Auth.Owner];
      else { const user = await keyR6(dict, pw, false); if (user) found = [user, Auth.User]; }
    } else throw unsupported(`revision ${dict.r}`);
    if (!found) throw wrongPassword();
    return new SecurityHandler(dict, found[0], found[1]);
  }

  /** Upgrade to owner access with the owner (permissions) password; any other is a wrong password. */
  async authenticateOwner(id0, password) {
    const owner = await SecurityHandler.open(this.dict, id0, password);
    if (owner.auth !== Auth.Owner || !eq(owner.key, this.key)) throw wrongPassword();
    return owner;
  }

  /** /P, and for R5 and R6 also /Perms (Algorithm 13): a permission counts only where both grant it. */
  async permissions() {
    let bits = this.dict.p;
    if (this.dict.r === 5 || this.dict.r === 6) {
      const block = this.dict.perms.subarray(0, 16);
      if (block.length === 16) {
        const plain = await aesCbcDecrypt(this.key, new Uint8Array(16), block, false);
        if (plain.length === 16 && String.fromCharCode(plain[9], plain[10], plain[11]) === 'adb') bits &= (plain[0] | (plain[1] << 8) | (plain[2] << 16) | (plain[3] << 24));
      }
    }
    return permissionsOf(bits, this.auth === Auth.Owner);
  }

  methodOf(kind) {
    if (this.dict.v < 4) return Method.Rc4;
    if (kind === null) return this.methods.string;
    if (kind === 'stream') return this.methods.stream;
    if (kind === 'embedded') return this.methods.embedded;
    return this.named.get(kind.named);
  }

  /** Algorithm 1: the key of one object. AES-256 uses the file key as it is. */
  objectKey(method, num, gen) {
    if (method === Method.Aes256) return this.key;
    const tail = method === Method.Aes128 ? utf8('sAlT') : new Uint8Array(0);
    return md5(concat(this.key, Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255), tail)).subarray(0, Math.min(this.key.length + 5, 16));
  }

  async apply(method, num, gen, data, encrypt) {
    if (method === Method.Identity) return Uint8Array.from(data);
    const key = this.objectKey(method, num, gen);
    if (method === Method.Rc4) return rc4(key, data);
    if (encrypt) {
      // A deterministic IV from the key, object and content: saves are reproducible and no IV repeats for different plaintexts.
      const iv = (await sha256(concat(key, le32(num), Uint8Array.of(gen & 255, (gen >> 8) & 255), data))).slice(0, 16);
      return concat(iv, await aesCbcEncrypt(key, iv, data, true));
    }
    if (data.length < 16) return new Uint8Array(0);
    return aesCbcDecrypt(key, data.subarray(0, 16), data.subarray(16), true);
  }

  /** Decrypt without waiting (what a parser needs): RC4 or AES. */
  decryptSync(method, num, gen, data) {
    if (method === Method.Identity) return Uint8Array.from(data);
    const key = this.objectKey(method, num, gen);
    if (method === Method.Rc4) return rc4(key, data);
    return data.length < 16 ? new Uint8Array(0) : aesCbcDecryptSync(key, data.subarray(0, 16), data.subarray(16), true);
  }

  decryptString(num, gen, data) { return this.apply(this.methodOf(null), num, gen, data, false); }
  encryptString(num, gen, data) { return this.apply(this.methodOf(null), num, gen, data, true); }
  decryptStream(num, gen, data, kind = 'stream') { return this.apply(this.methodOf(kind), num, gen, data, false); }
  encryptStream(num, gen, data, kind = 'stream') { return this.apply(this.methodOf(kind), num, gen, data, true); }
  get encryptsMetadata() { return this.dict.encryptMetadata; }
}

// ── creating encryption ────────────────────────────────────────────────────────────────────────

/**
 * Sixteen bytes of file identifier from `seed` (SHA-256 in counter mode, label `id`). /ID is written in the clear: deriving it the way the file key is
 * keeps that public value from being an unkeyed hash of the seed (printcraft 8f16855 crypt file_id).
 */
export async function fileId(seed) { return expand(seed, 'id', 16); }

/** Expand `seed` into `n` bytes (SHA-256 in counter mode). */
async function expand(seed, label, n) {
  const parts = [];
  let have = 0;
  for (let counter = 0; have < n; counter++) {
    const d = await sha256(concat(seed, utf8(label), le32(counter)));
    parts.push(d);
    have += d.length;
  }
  return concat(...parts).slice(0, n);
}

/**
 * Build the /Encrypt values and an owner-authenticated handler for new encryption.
 * `seed`: 32 bytes of entropy (from the caller, so tests are deterministic).
 */
export async function createEncryption({algorithm, userPassword = '', ownerPassword = '', permissions = -1, encryptMetadata = true, seed}, id0) {
  const p = (permissions | ~0xFFF | 0xC0) & ~3;
  const d = {filter: 'Standard', v: 0, r: 0, lengthBits: 0, o: null, u: null, oe: new Uint8Array(0), ue: new Uint8Array(0), perms: new Uint8Array(0), p, encryptMetadata,
    cryptFilters: [], stmF: 'Identity', strF: 'Identity', effF: ''};
  if (algorithm !== Algorithm.Aes256) {
    const user = legacyPassword(userPassword);
    const owner = ownerPassword === '' ? user : legacyPassword(ownerPassword);
    [d.v, d.r, d.lengthBits] = algorithm === Algorithm.Rc4_40 ? [1, 2, 40] : algorithm === Algorithm.Rc4_128 ? [2, 3, 128] : [4, 4, 128];
    if (algorithm === Algorithm.Aes128) { d.cryptFilters = [['StdCF', Method.Aes128]]; d.stmF = 'StdCF'; d.strF = 'StdCF'; }
    else d.encryptMetadata = true;
    const rk = ownerRc4Key(d, owner);
    let o = rc4(rk, pad(user));
    if (d.r >= 3) for (let i = 1; i <= 19; i++) o = rc4(rk.map(b => b ^ i), o);
    d.o = o;
    const key = fileKeyR4(d, id0, user);
    d.u = uValueR4(d, id0, key);
    return new SecurityHandler(d, key, Auth.Owner, user);
  }
  [d.v, d.r, d.lengthBits] = [5, 6, 256];
  d.cryptFilters = [['StdCF', Method.Aes256]]; d.stmF = 'StdCF'; d.strF = 'StdCF';
  const user = saslPassword(userPassword);
  const owner = saslPassword(ownerPassword);
  const key = await expand(seed, 'file key', 32);
  const salts = await expand(seed, 'salts', 32);
  const u = concat(await hashR6(6, user, salts.subarray(0, 8), new Uint8Array(0)), salts.subarray(0, 16));
  d.ue = await aesCbcEncrypt(await hashR6(6, user, salts.subarray(8, 16), new Uint8Array(0)), new Uint8Array(16), key, false);
  const o = concat(await hashR6(6, owner, salts.subarray(16, 24), u), salts.subarray(16, 32));
  d.oe = await aesCbcEncrypt(await hashR6(6, owner, salts.subarray(24, 32), u), new Uint8Array(16), key, false);
  d.u = u;
  d.o = o;
  const perms = new Uint8Array(16);
  perms.set(le32(p), 0);
  perms.set([255, 255, 255, 255], 4);
  perms[8] = encryptMetadata ? 0x54 : 0x46;
  perms.set([0x61, 0x64, 0x62], 9);
  perms.set(await expand(seed, 'perms', 4), 12);
  d.perms = await aesCbcEncrypt(key, new Uint8Array(16), perms, false);
  return new SecurityHandler(d, key, Auth.Owner, null);
}

/** A cryptographic seed (the platform's random source). */
export const randomSeed = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
