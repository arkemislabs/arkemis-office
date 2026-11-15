// Excel-compatible password hashes for protection (ECMA-376 Part 1 18.2.29 and 18.3.1.66 attribute sets): the
// legacy 16-bit hash (`password="CC1A"`) and the iterated, salted hash (algorithmName, hashValue, saltValue,
// spinCount). Protection is a convenience, not security, but verification really checks the password: an
// unsupported variant is refused, never accepted.
//
// Translated from gridcraft crates/model/src/password.rs (`PasswordHash::new_sha512`, `verify`, `salt_from`,
// `legacy_hash`, `iterated`) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt. The digests
// are the synchronous SHA-2 of core/quill/lib/review-protect.mjs (100,000 rounds per check).
//
// A stored hash is the object the file holds: {algorithmName, hashValue, saltValue, spinCount} or {password: 'CC1A'}.
// A password is never written to a journal or a log: callers pass it through `s.secret` params.

import {sha512, iterateAppended} from '../../quill/lib/review-protect.mjs';

/** Excel's default spin count for new passwords. */
export const DEFAULT_SPIN_COUNT = 100_000;
/** The documented maximum spin count; a file asking for more would only make verification hang. */
export const MAX_SPIN_COUNT = 10_000_000;

const b64 = u => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => { try { const t = atob(String(s).trim()); return Uint8Array.from(t, c => c.charCodeAt(0)); } catch { return null; } };
const utf8 = s => new TextEncoder().encode(s);

let counter = 0;
/** A 16-byte salt derived from `seed` (callers mix in what varies: names, a counter, the clock). */
export function saltFrom(seed) { return sha512(utf8(seed)).slice(0, 16); }

/** A new SHA-512 hash with Excel's default spin count, salted from `what` is protected, a counter and the clock. */
export function newPasswordHash(password, what = '') {
  counter += 1;
  const rnd = globalThis.crypto?.getRandomValues ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).join(',') : '';
  const salt = saltFrom(`${what}\u0000${counter}\u0000${Date.now()}\u0000${rnd}`);
  return {algorithmName: 'SHA-512', hashValue: b64(iterateAppended('SHA-512', salt, password, DEFAULT_SPIN_COUNT)), saltValue: b64(salt), spinCount: DEFAULT_SPIN_COUNT};
}

/** Lets the window draw: the hash runs in slices of about 40 ms with a pause between them. */
const pause = () => new Promise(r => setTimeout(r, 0));
const SLICE = 1500;

/** H0 = H(salt + UTF-16LE password), Hn = H(Hn-1 + n as 32-bit little-endian) in slices that give the event loop a turn; SHA-384 and SHA-256 (verifying only) run whole. */
async function iterateSliced(name, salt, password, spin) {
  if (name !== 'SHA-512') return iterateAppended(name, salt, password, spin);
  const pw = [...String(password)].flatMap(ch => { const u = ch.charCodeAt(0); return [u & 0xff, u >> 8]; });
  let x = sha512(Uint8Array.from([...salt, ...pw]));
  const buf = new Uint8Array(68);
  const n = Math.min(spin, MAX_SPIN_COUNT);
  for (let i = 0; i < n; i++) {
    buf.set(x);
    buf[64] = i & 0xff; buf[65] = (i >>> 8) & 0xff; buf[66] = (i >>> 16) & 0xff; buf[67] = (i >>> 24) & 0xff;
    x = sha512(buf);
    if ((i + 1) % SLICE === 0) await pause();
  }
  return x;
}

/** newPasswordHash that does not hold the window still: the same Excel SHA-512 hash and spin count, computed in slices. */
export async function newPasswordHashAsync(password, what = '') {
  counter += 1;
  const rnd = globalThis.crypto?.getRandomValues ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).join(',') : '';
  const salt = saltFrom(`${what}\u0000${counter}\u0000${Date.now()}\u0000${rnd}`);
  return {algorithmName: 'SHA-512', hashValue: b64(await iterateSliced('SHA-512', salt, password, DEFAULT_SPIN_COUNT)), saltValue: b64(salt), spinCount: DEFAULT_SPIN_COUNT};
}

/** verifyPassword in slices (the same checks and the same errors). */
export async function verifyPasswordAsync(stored, password) {
  const pw = String(password ?? '');
  if (stored && typeof stored.password === 'string' && !stored.algorithmName) return legacyHash(pw) === parseInt(stored.password, 16);
  const {algorithmName, hashValue, saltValue} = stored ?? {};
  const spin = Number(stored?.spinCount ?? 0);
  if (!algorithmName) throw new Error('the stored password hash is damaged');
  if (spin > MAX_SPIN_COUNT) throw new Error(`the password uses a spin count of ${spin}, more than the ${MAX_SPIN_COUNT} allowed`);
  const want = unb64(hashValue), salt = unb64(saltValue);
  if (!want || !salt) throw new Error('the stored password hash is damaged');
  const name = ALGORITHMS[String(algorithmName).toUpperCase().replace(/_/g, '-')];
  if (!name) throw new Error(`passwords hashed with ${algorithmName} aren't supported`);
  const got = await iterateSliced(name, salt, pw, spin);
  return got.length === want.length && got.every((x, i) => x === want[i]);
}

/** The legacy 16-bit hash: each UTF-16 unit contributes its low byte (its high byte when the low one is zero), folded in from the last character with a 15-bit rotation, then the length and 0xCE4B. */
export function legacyHash(password) {
  const bytes = [...String(password)].flatMap(ch => { const u = ch.charCodeAt(0); return [(u & 0xff) !== 0 ? u & 0xff : u >> 8]; });
  const rotate = v => ((v >> 14) & 1) | ((v << 1) & 0x7fff);
  let h = 0;
  for (let i = bytes.length - 1; i >= 0; i--) h = rotate(h) ^ bytes[i];
  h = rotate(h) ^ bytes.length;
  return (h ^ 0xce4b) & 0xffff;
}

const ALGORITHMS = {'SHA-512': 'SHA-512', 'SHA-384': 'SHA-384', 'SHA-256': 'SHA-256'};

/** Whether `password` matches the stored hash; throws an Error with Excel's wording when the hash cannot be checked. */
export function verifyPassword(stored, password) {
  const pw = String(password ?? '');
  if (stored && typeof stored.password === 'string' && !stored.algorithmName) return legacyHash(pw) === parseInt(stored.password, 16);
  const {algorithmName, hashValue, saltValue} = stored ?? {};
  const spin = Number(stored?.spinCount ?? 0);
  if (!algorithmName) throw new Error('the stored password hash is damaged');
  if (spin > MAX_SPIN_COUNT) throw new Error(`the password uses a spin count of ${spin}, more than the ${MAX_SPIN_COUNT} allowed`);
  const want = unb64(hashValue), salt = unb64(saltValue);
  if (!want || !salt) throw new Error('the stored password hash is damaged');
  const name = ALGORITHMS[String(algorithmName).toUpperCase().replace(/_/g, '-')];
  if (!name) throw new Error(`passwords hashed with ${algorithmName} aren't supported`);
  const got = iterateAppended(name, salt, pw, spin);
  return got.length === want.length && got.every((x, i) => x === want[i]);
}

/** Whether a protection record carries a password. */
export const hasPassword = p => !!p && (typeof p.password === 'string' || !!p.algorithmName);
