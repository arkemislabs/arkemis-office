// Digests, ciphers and key derivations for digital IDs and signatures.
//
// Translated from printcraft crates/sign/src/keys.rs (DigestAlg: oid, name, digest, weakness,
// output_len, algorithm) and crates/sign/src/pkcs12.rs (bmp, pkcs12_kdf, Cipher::decrypt, hmac,
// pbkdf2) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream calls RustCrypto; here the primitives are the platform's Web Crypto (`crypto.subtle`,
// present in Electron's renderer and in Node) where it has them (SHA-1/256/384/512, HMAC,
// PBKDF2, AES-CBC), and small table-free implementations where it does not: SHA-1 and SHA-256
// synchronously (the PKCS #12 key derivation runs hundreds of thousands of rounds), and the
// 3DES-CBC and RC2-CBC that legacy .pfx files (Windows, older OpenSSL) are encrypted with.
// SHA-224, SHA-512/t, SHA-3 and RIPEMD-160 are named (so a signature using them is reported as
// "can't check yet") but not computed. No DOM, no Node built-ins.

import {SignError, unsupported, algorithm, concat} from './sign-der.mjs';

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new SignError('crypto', 'Cryptography is unavailable in this runtime.');
  return s;
};

/** keys.rs `DigestAlg`: name, OID, output length, Web Crypto name (null: not computed here). */
const DIGESTS = [
  ['Sha1', 'SHA-1', '1.3.14.3.2.26', 20, 'SHA-1'],
  ['Sha224', 'SHA-224', '2.16.840.1.101.3.4.2.4', 28, null],
  ['Sha256', 'SHA-256', '2.16.840.1.101.3.4.2.1', 32, 'SHA-256'],
  ['Sha384', 'SHA-384', '2.16.840.1.101.3.4.2.2', 48, 'SHA-384'],
  ['Sha512', 'SHA-512', '2.16.840.1.101.3.4.2.3', 64, 'SHA-512'],
  ['Sha512_224', 'SHA-512/224', '2.16.840.1.101.3.4.2.5', 28, null],
  ['Sha512_256', 'SHA-512/256', '2.16.840.1.101.3.4.2.6', 32, null],
  ['Sha3_224', 'SHA3-224', '2.16.840.1.101.3.4.2.7', 28, null],
  ['Sha3_256', 'SHA3-256', '2.16.840.1.101.3.4.2.8', 32, null],
  ['Sha3_384', 'SHA3-384', '2.16.840.1.101.3.4.2.9', 48, null],
  ['Sha3_512', 'SHA3-512', '2.16.840.1.101.3.4.2.10', 64, null],
  ['Ripemd160', 'RIPEMD-160', '1.3.36.3.2.1', 20, null],
].map(([key, name, oid, len, web]) => Object.freeze({key, name, oid, len, web}));
export const DigestAlg = Object.freeze(Object.fromEntries(DIGESTS.map(d => [d.key, d])));
export const digestFromOid = o => DIGESTS.find(d => d.oid === o) ?? null;
export const digestAlgorithm = d => algorithm(d.oid);

/** keys.rs `DigestAlg::weakness`. */
export function weakness(d) {
  if (d === DigestAlg.Sha1) return 'This signature uses SHA-1, a weak hash algorithm: collisions in it have been demonstrated. It still validates because many documents signed years ago use it, but it should not be relied on.';
  if (d === DigestAlg.Ripemd160) return 'This signature uses RIPEMD-160, a legacy 160-bit hash algorithm that is no longer recommended for signatures. It still validates, but it should not be relied on.';
  return null;
}

/** The digest of the concatenation of `parts`. */
export async function digest(d, parts) {
  if (!d.web) throw unsupported(`${d.name} digests`);
  if (d === DigestAlg.Sha1) return sha1(concat(parts));
  if (d === DigestAlg.Sha256) return sha256(concat(parts));
  return new Uint8Array(await subtle().digest(d.web, concat(parts)));
}

// ── SHA-1 and SHA-256, synchronous ─────────────────────────────────────────────────────────

function padMessage(m) {
  const bitLen = m.length * 8;
  const n = (((m.length + 9 + 63) >> 6) << 6);
  const out = new Uint8Array(n);
  out.set(m);
  out[m.length] = 0x80;
  const dv = new DataView(out.buffer);
  dv.setUint32(n - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(n - 4, bitLen >>> 0);
  return out;
}

export function sha1(m) {
  const p = padMessage(m), dv = new DataView(p.buffer), w = new Uint32Array(80);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let o = 0; o < p.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20), ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h));
  return out;
}

const K256 = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256(m) {
  const p = padMessage(m), dv = new DataView(p.buffer), w = new Uint32Array(64);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < p.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

/**
 * Hash a digest `count` more times (the PKCS #12 KDF's inner loop): the input is always one
 * digest long, so every round is a single padded block hashed in place.
 */
function repeatHash(d, a, count) {
  if (count <= 0) return a;
  const sha2 = d === DigestAlg.Sha256, len = sha2 ? 32 : 20;
  const w = new Uint32Array(sha2 ? 64 : 80);
  const st = new Int32Array(sha2 ? 8 : 5);
  for (let i = 0; i < len / 4; i++) st[i] = (a[4 * i] << 24) | (a[4 * i + 1] << 16) | (a[4 * i + 2] << 8) | a[4 * i + 3];
  if (sha2) sha256Rounds(st, count);
  for (let round = 0; !sha2 && round < count; round++) {
    // The block: the previous digest, 0x80, zeros, and the bit length.
    w.fill(0, 0, 16);
    for (let i = 0; i < len / 4; i++) w[i] = st[i];
    w[len / 4] = 0x80000000;
    w[15] = len * 8;
    {
      for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
      let A = 0x67452301, B = 0xefcdab89, Cc = 0x98badcfe, Dd = 0x10325476, Ee = 0xc3d2e1f0;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (B & Cc) | (~B & Dd) : i < 40 ? B ^ Cc ^ Dd : i < 60 ? (B & Cc) | (B & Dd) | (Cc & Dd) : B ^ Cc ^ Dd;
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const t = (((A << 5) | (A >>> 27)) + f + Ee + k + w[i]) >>> 0;
        Ee = Dd; Dd = Cc; Cc = (B << 30) | (B >>> 2); B = A; A = t;
      }
      st[0] = 0x67452301 + A; st[1] = 0xefcdab89 + B; st[2] = 0x98badcfe + Cc; st[3] = 0x10325476 + Dd; st[4] = 0xc3d2e1f0 + Ee;
    }
  }
  const out = new Uint8Array(len), ov = new DataView(out.buffer);
  st.forEach((x, i) => ov.setInt32(i * 4, x));
  return out;
}

const K256I = Int32Array.from(K256);

/** SHA-256 of a 32-byte message `count` times over, in int32 arithmetic (state in `st`). */
function sha256Rounds(st, count) {
  const w = new Int32Array(64);
  for (let round = 0; round < count; round++) {
    for (let i = 0; i < 8; i++) w[i] = st[i];
    w[8] = -2147483648; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = 256;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let A = 0x6a09e667 | 0, B = 0xbb67ae85 | 0, C = 0x3c6ef372 | 0, D = 0xa54ff53a | 0, E = 0x510e527f | 0, F = 0x9b05688c | 0, G = 0x1f83d9ab | 0, H = 0x5be0cd19 | 0;
    for (let i = 0; i < 64; i++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const t1 = (H + S1 + ((E & F) ^ (~E & G)) + K256I[i] + w[i]) | 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    st[0] = (0x6a09e667 + A) | 0; st[1] = (0xbb67ae85 + B) | 0; st[2] = (0x3c6ef372 + C) | 0; st[3] = (0xa54ff53a + D) | 0;
    st[4] = (0x510e527f + E) | 0; st[5] = (0x9b05688c + F) | 0; st[6] = (0x1f83d9ab + G) | 0; st[7] = (0x5be0cd19 + H) | 0;
  }
}

// ── HMAC, PBKDF2, the PKCS #12 KDF ─────────────────────────────────────────────────────────

export async function hmac(d, key, data) {
  if (!['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(d.web)) throw unsupported(`${d.name} in a PKCS #12 MAC`);
  const k = await subtle().importKey('raw', key, {name: 'HMAC', hash: d.web}, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}

export async function pbkdf2(prf, password, salt, rounds, len) {
  if (!['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(prf.web)) throw unsupported(`PBKDF2 with ${prf.name}`);
  const k = await subtle().importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({name: 'PBKDF2', hash: prf.web, salt, iterations: Math.max(1, rounds)}, k, len * 8));
}

/** The password as a BMPString with its terminating NUL (RFC 7292 Appendix B.1). */
export function bmp(password) {
  const out = [];
  for (let i = 0; i < password.length; i++) { const c = password.charCodeAt(i); out.push(c >> 8, c & 0xff); }
  out.push(0, 0);
  return Uint8Array.from(out);
}

/** The PKCS #12 key derivation function (RFC 7292 Appendix B.2). */
export async function pkcs12Kdf(d, password, salt, id, iterations, n) {
  const sizes = {SHA1: [20, 64], 'SHA-1': [20, 64], 'SHA-256': [32, 64], 'SHA-384': [48, 128], 'SHA-512': [64, 128]}[d.web];
  if (!sizes) return new Uint8Array(0);
  const v = sizes[1];
  const hash = d === DigestAlg.Sha1 ? sha1 : d === DigestAlg.Sha256 ? sha256 : null;
  const run = async m => (hash ? hash(m) : new Uint8Array(await subtle().digest(d.web, m)));
  const fill = s => { if (!s.length) return new Uint8Array(0); const len = v * Math.ceil(s.length / v); const o = new Uint8Array(len); for (let i = 0; i < len; i++) o[i] = s[i % s.length]; return o; };
  const D = new Uint8Array(v).fill(id);
  const I = concat([fill(salt), fill(password)]);
  const out = [];
  let have = 0;
  while (have < n) {
    let a = await run(concat([D, I]));
    if (hash) a = repeatHash(d, a, Math.max(1, iterations) - 1);
    else for (let k = 1; k < Math.max(1, iterations); k++) a = await run(a);
    const b = new Uint8Array(v);
    for (let k = 0; k < v; k++) b[k] = a[k % a.length];
    for (let off = 0; off < I.length; off += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const s = I[off + k] + b[k] + carry; I[off + k] = s & 0xff; carry = s >> 8; }
    }
    out.push(a);
    have += a.length;
  }
  return concat(out).subarray(0, n);
}

// ── ciphers ───────────────────────────────────────────────────────────────────────────────

const wrongPassword = () => new SignError('wrong_password', 'the password is incorrect');

export async function aesCbcDecrypt(key, iv, ct) {
  try {
    const k = await subtle().importKey('raw', key, 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await subtle().decrypt({name: 'AES-CBC', iv}, k, ct));
  } catch { throw wrongPassword(); }
}

export async function aesCbcEncrypt(key, iv, plain) {
  const k = await subtle().importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await subtle().encrypt({name: 'AES-CBC', iv}, k, plain));
}

function unpad(out, block) {
  const p = out[out.length - 1];
  if (!out.length || p < 1 || p > block || out.length < p) throw wrongPassword();
  for (let i = out.length - p; i < out.length; i++) if (out[i] !== p) throw wrongPassword();
  return out.subarray(0, out.length - p);
}

function cbcDecrypt(blockDecrypt, iv, ct, block = 8) {
  if (!ct.length || ct.length % block) throw wrongPassword();
  const out = new Uint8Array(ct.length);
  let prev = iv;
  for (let o = 0; o < ct.length; o += block) {
    const c = ct.subarray(o, o + block), p = blockDecrypt(c);
    for (let i = 0; i < block; i++) out[o + i] = p[i] ^ prev[i];
    prev = c;
  }
  return unpad(out, block);
}

// DES (FIPS 46-3) for 3DES-EDE-CBC.
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];
const bitsOf = b => { const o = []; for (const x of b) for (let i = 7; i >= 0; i--) o.push((x >> i) & 1); return o; };
const bytesOf = bits => { const o = new Uint8Array(bits.length / 8); for (let i = 0; i < bits.length; i++) o[i >> 3] |= bits[i] << (7 - (i & 7)); return o; };
const permute = (bits, table) => table.map(i => bits[i - 1]);

function desSubkeys(key) {
  const k = permute(bitsOf(key), PC1);
  let c = k.slice(0, 28), d = k.slice(28);
  return SHIFTS.map(s => { c = [...c.slice(s), ...c.slice(0, s)]; d = [...d.slice(s), ...d.slice(0, s)]; return permute([...c, ...d], PC2); });
}

function desBlock(block, subkeys) {
  const b = permute(bitsOf(block), IP);
  let l = b.slice(0, 32), r = b.slice(32);
  for (const k of subkeys) {
    const x = permute(r, E).map((v, i) => v ^ k[i]);
    const f = [];
    for (let s = 0; s < 8; s++) {
      const six = x.slice(s * 6, s * 6 + 6);
      const v = S[s][(six[0] << 5) | (six[5] << 4) | (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4]];
      f.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const pf = permute(f, P);
    [l, r] = [r, l.map((v, i) => v ^ pf[i])];
  }
  return bytesOf(permute([...r, ...l], FP));
}

/** 3DES-EDE in CBC mode, decrypting (key 24 bytes: K1 K2 K3). */
export function des3CbcDecrypt(key, iv, ct) {
  if (key.length !== 24 || iv.length !== 8) throw wrongPassword();
  const k = [0, 8, 16].map(o => desSubkeys(key.subarray(o, o + 8)));
  const dec = [k[2].slice().reverse(), k[1], k[0].slice().reverse()];
  return cbcDecrypt(c => desBlock(desBlock(desBlock(c, dec[0]), dec[1]), dec[2]), iv, ct);
}

// RC2 (RFC 2268) with an effective key length, CBC decrypting.
const PITABLE = Uint8Array.from([
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d, 0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2,
  0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32, 0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82,
  0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc, 0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03, 0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7,
  0x08, 0xe8, 0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a, 0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec,
  0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39, 0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9, 0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9,
  0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e, 0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad]);

function rc2Expand(key, bits) {
  const L = new Uint8Array(128);
  L.set(key);
  const T = key.length, T8 = (bits + 7) >> 3, TM = 0xff % (1 << (8 + bits - 8 * T8));
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}

function rc2DecryptBlock(c, K) {
  const R = [c[0] | (c[1] << 8), c[2] | (c[3] << 8), c[4] | (c[5] << 8), c[6] | (c[7] << 8)];
  const s = [1, 2, 3, 5];
  const rmix = (j, i) => {
    const x = R[i];
    R[i] = (((x >>> s[i]) | (x << (16 - s[i]))) & 0xffff);
    R[i] = (R[i] - K[j] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3] & 0xffff)) & 0xffff;
  };
  const rmash = i => { R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
  let j = 63;
  const mixRound = () => { for (let i = 3; i >= 0; i--) rmix(j--, i); };
  for (let n = 0; n < 5; n++) mixRound();
  for (let i = 3; i >= 0; i--) rmash(i);
  for (let n = 0; n < 6; n++) mixRound();
  for (let i = 3; i >= 0; i--) rmash(i);
  for (let n = 0; n < 5; n++) mixRound();
  return Uint8Array.from([R[0] & 0xff, R[0] >> 8, R[1] & 0xff, R[1] >> 8, R[2] & 0xff, R[2] >> 8, R[3] & 0xff, R[3] >> 8]);
}

export function rc2CbcDecrypt(key, bits, iv, ct) {
  if (!key.length || iv.length !== 8) throw wrongPassword();
  const K = rc2Expand(key, bits);
  return cbcDecrypt(c => rc2DecryptBlock(c, K), iv, ct);
}

/** Random bytes. */
export function random(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
