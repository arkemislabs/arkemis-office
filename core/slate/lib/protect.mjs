// Password-protected sections (Review > Password; U:slate/review). Slate has no ArtCraft upstream;
// the behaviour is OneNote's: a section can be protected with a password, locked (its pages are
// not shown or searched) and unlocked with the password; Lock All locks every protected section.
//
// What is stored, and where:
//   * A protected section carries `protection`: {version, kdf: 'PBKDF2-SHA256', iterations, salt,
//     cipher: 'AES-256-GCM', iv, data}. `data` is the section's pages encrypted with a key derived
//     from the password (PBKDF2-SHA256, 210 000 rounds, a random salt per section). The password
//     itself is never stored anywhere; it is right when the data decrypts (GCM authenticates it).
//   * What is encrypted ("the payload"): the section's page list, every page record (body, ink,
//     attachments, pictures), the saved versions of those pages and the Recycle Bin entries of its
//     deleted pages. Nothing of it is written to the notebook folder, the vault file or a version
//     file in plain text: the section file keeps only the section's name, colour and the blob.
//   * `locked: true` on the section record means the payload is not in memory: `pages` is [], and
//     the page records, versions and bin entries are gone from the open notebook. Unlocking decrypts
//     them back in; locking encrypts the current payload and removes it again.
//   * While a section is unlocked its pages are in the open notebook as usual. The notebook as it is
//     SAVED is always `sealForDisk(content)`: every protected section as if it were locked, with its
//     payload freshly encrypted. The key stays in this module's memory only (never in the document,
//     the journal or a result), per notebook and section, until Lock or Lock All.
//
// No DOM, no Node built-ins: Web Crypto (globalThis.crypto.subtle) only.

import {CommandError} from '../../kernel/errors.mjs';

export const PROTECTION_VERSION = 1;
export const PBKDF2_ITERATIONS = 210_000;
export const MAX_PASSWORD = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode('arkemis.slate.section.v1');

// ---------------------------------------------------------------------------------------------
// Bytes

const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = text => Uint8Array.from(atob(String(text)), c => c.charCodeAt(0));
const random = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

function subtle() {
  const sub = globalThis.crypto?.subtle;
  if (!sub) throw new CommandError('unavailable', 'This computer cannot encrypt: Web Crypto is missing, so a section cannot be password protected.');
  return sub;
}

// ---------------------------------------------------------------------------------------------
// Keys held in memory

const keys = new Map();
const keyId = (content, sectionId) => `${content.notebook.id}/${sectionId}`;
export const hasKey = (content, sectionId) => keys.has(keyId(content, sectionId));
export const keyFor = (content, sectionId) => keys.get(keyId(content, sectionId)) ?? null;
export const forgetKey = (content, sectionId) => { keys.delete(keyId(content, sectionId)); };
export function forgetAllKeys(content) {
  const prefix = content ? `${content.notebook.id}/` : '';
  for (const k of [...keys.keys()]) if (k.startsWith(prefix)) keys.delete(k);
}
export const rememberKey = (content, sectionId, key) => { keys.set(keyId(content, sectionId), key); };

// ---------------------------------------------------------------------------------------------
// Crypto

export const isProtected = section => !!section && typeof section.protection === 'object' && section.protection !== null;
export const isLocked = section => isProtected(section) && section.locked === true;

/** A fresh protection header (salt and rounds) and the key a password makes with it. */
export async function newKey(password, iterations = PBKDF2_ITERATIONS) {
  const salt = b64(random(16));
  return {salt, iterations, key: await deriveKey(password, salt, iterations)};
}

export async function deriveKey(password, saltB64, iterations) {
  const sub = subtle();
  const material = await sub.importKey('raw', enc.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return sub.deriveKey({name: 'PBKDF2', salt: unb64(saltB64), iterations, hash: 'SHA-256'}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

/** The blob for a payload: header copied from `header` ({salt, iterations}), a fresh iv, the encrypted data. */
export async function encryptPayload(key, header, payload) {
  const iv = random(12);
  const data = new Uint8Array(await subtle().encrypt({name: 'AES-GCM', iv, additionalData: AAD}, key, enc.encode(JSON.stringify(payload))));
  return {version: PROTECTION_VERSION, kdf: 'PBKDF2-SHA256', iterations: header.iterations, salt: header.salt, cipher: 'AES-256-GCM', iv: b64(iv), data: b64(data)};
}

/** The payload of a blob; null when the key is wrong (or the blob was changed). */
export async function decryptPayload(key, blob) {
  try {
    const plain = await subtle().decrypt({name: 'AES-GCM', iv: unb64(blob.iv), additionalData: AAD}, key, unb64(blob.data));
    const payload = JSON.parse(dec.decode(plain));
    return payload && Array.isArray(payload.pages) && payload.records && typeof payload.records === 'object' ? payload : null;
  } catch { return null; }
}

/** Whether a blob is one this version can read. */
export function checkBlob(blob) {
  const ok = blob && blob.version === PROTECTION_VERSION && blob.kdf === 'PBKDF2-SHA256' && blob.cipher === 'AES-256-GCM'
    && Number.isInteger(blob.iterations) && blob.iterations >= 10_000 && blob.iterations <= 5_000_000
    && typeof blob.salt === 'string' && typeof blob.iv === 'string' && typeof blob.data === 'string';
  if (!ok) throw new CommandError('failed', 'This section\'s protection was made by a newer version and cannot be opened here.');
  return blob;
}

/** The key a password makes for a protected section, checked against its blob; null when the password is wrong. */
export async function openWith(section, password) {
  const blob = checkBlob(section.protection);
  const key = await deriveKey(password, blob.salt, blob.iterations);
  const payload = await decryptPayload(key, blob);
  return payload ? {key, payload} : null;
}

// ---------------------------------------------------------------------------------------------
// The payload of a section

const binOf = content => (Array.isArray(content?.notebook?.recycleBin) ? content.notebook.recycleBin : []);

/** Pages, versions and deleted-page bin entries of a section, as they are in the open notebook. */
export function payloadOf(content, sectionId) {
  const section = content.sections[sectionId];
  const records = {}, versions = {};
  for (const e of section.pages) {
    if (content.pages[e.id]) records[e.id] = content.pages[e.id];
    if (content.versions?.[e.id]?.length) versions[e.id] = content.versions[e.id];
  }
  return {pages: section.pages.map(e => ({id: e.id, level: e.level})), records, versions,
    bin: binOf(content).filter(e => e.kind === 'page' && e.from?.sectionId === sectionId)};
}

/** The ids a section's payload takes with it when it is locked: its pages and its bin entries. */
export const binEntriesOf = (content, sectionId) => binOf(content).filter(e => e.kind === 'page' && e.from?.sectionId === sectionId);

// ---------------------------------------------------------------------------------------------
// The notebook as it is saved

/** Whether the notebook has any protected section (in the tree or in the Recycle Bin). */
export function hasProtected(content) {
  if (!content?.sections) return false;
  if (Object.values(content.sections).some(isProtected)) return true;
  return binOf(content).some(e => (e.kind === 'section' && isProtected(e.section)) || (e.kind === 'group' && Object.values(e.sections ?? {}).some(isProtected)));
}

/** Whether any protected section is unlocked (its pages are in memory). */
export const hasUnlocked = content => !!content?.sections && Object.values(content.sections).some(s => isProtected(s) && !isLocked(s));

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sealCache = new Map();          // keyId -> {sig, blob}
const entryCache = new WeakMap();     // bin entry -> sealed entry

async function sealSection(content, section, payload, sig) {
  const id = keyId(content, section.id);
  const cached = sealCache.get(id);
  if (cached && same(cached.sig, sig)) return cached.blob;
  const key = keys.get(id);
  if (!key) return null;
  const blob = await encryptPayload(key, section.protection, payload);
  sealCache.set(id, {sig, blob});
  return blob;
}

/**
 * The content to write to disk: every protected section locked, its payload encrypted. Content with
 * no unlocked protected section comes back as it is. An unlocked section whose key is missing (it
 * cannot happen through the commands) is written as locked with the blob it had: its plain text is
 * never written.
 */
export async function sealForDisk(content) {
  if (!hasProtected(content)) return content;
  const sections = {...content.sections};
  const pages = {...content.pages};
  let versions = content.versions;
  let bin = binOf(content);
  const dropBin = new Set();
  for (const s of Object.values(content.sections)) {
    if (!isProtected(s)) continue;
    const dropPages = s.pages.map(e => e.id);
    let blob = s.protection;
    if (!isLocked(s)) {
      const payload = payloadOf(content, s.id);
      const sig = [s.pages, s.protection, ...s.pages.map(e => content.pages[e.id]), ...s.pages.map(e => content.versions?.[e.id]), ...payload.bin];
      blob = (await sealSection(content, s, payload, sig)) ?? s.protection;
      for (const e of payload.bin) dropBin.add(e);
    }
    sections[s.id] = {...s, locked: true, pages: [], protection: blob};
    for (const id of dropPages) delete pages[id];
    if (versions && dropPages.some(id => versions[id])) { versions = {...versions}; for (const id of dropPages) delete versions[id]; }
  }
  if (dropBin.size) bin = bin.filter(e => !dropBin.has(e));
  // Deleted sections and section groups carry their pages: seal those that were protected.
  const sealed = [];
  for (const e of bin) sealed.push(await sealEntry(content, e));
  const binChanged = dropBin.size > 0 || sealed.some((e, i) => e !== bin[i]);
  const out = {...content, sections, pages};
  if (versions !== content.versions) { if (versions && Object.keys(versions).length) out.versions = versions; else delete out.versions; }
  if (binChanged) out.notebook = {...content.notebook, recycleBin: sealed};
  return out;
}

async function sealEntry(content, entry) {
  const holders = entry.kind === 'section' && entry.section ? {[entry.section.id]: entry.section} : entry.kind === 'group' ? entry.sections ?? {} : null;
  if (!holders || !Object.values(holders).some(s => isProtected(s) && !isLocked(s))) {
    // Protected and locked already (as loaded), or not protected: as it is. A locked section must hold no pages.
    return entry;
  }
  const cached = entryCache.get(entry);
  if (cached) return cached;
  const sections = {...holders};
  const records = {...(entry.pages ?? {})};
  for (const s of Object.values(holders)) {
    if (!isProtected(s) || isLocked(s)) continue;
    const key = keys.get(keyId(content, s.id));
    let blob = s.protection;
    if (key) {
      const payload = {pages: s.pages.map(e => ({id: e.id, level: e.level})), records: Object.fromEntries(s.pages.filter(e => records[e.id]).map(e => [e.id, records[e.id]])), versions: {}, bin: []};
      blob = await encryptPayload(key, s.protection, payload);
    }
    sections[s.id] = {...s, locked: true, pages: [], protection: blob};
    for (const e of s.pages) delete records[e.id];
  }
  const out = entry.kind === 'section' ? {...entry, section: sections[entry.section.id], pages: records} : {...entry, sections, pages: records};
  entryCache.set(entry, out);
  return out;
}
