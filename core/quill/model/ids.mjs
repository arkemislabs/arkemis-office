// Stable ids for Quill schema-2 content (docs/architecture.md section 14.2): every paragraph,
// table, row, cell, inline object (`oid`) and section carries an 8-character base36 id, made when
// it is created or imported and kept through edits. Upstream (wordcraft crates/doc) addresses by
// index paths only; the ids are the Arkemis addition the address grammar and anchors rely on.
// No DOM, no Node built-ins.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Ids are 8 lowercase base36 characters (DOCX readers may use a w14:paraId, lowercased). */
export const ID_RE = /^[0-9a-z]{8}$/;
export const isId = x => typeof x === 'string' && ID_RE.test(x);

let source = null;

function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A fresh random id; the first character is a letter, so an id never reads as an index path. */
export function newId() {
  if (source) return source();
  const b = randomBytes(8);
  let s = LETTERS[b[0] % 26];
  for (let i = 1; i < 8; i++) s += ALPHABET[b[i] % 36];
  return s;
}

/**
 * Replace the id source (tests: deterministic ids). Pass null to restore the random source.
 * Returns the previous source.
 */
export function setIdSource(fn) {
  const prev = source;
  source = typeof fn === 'function' ? fn : null;
  return prev;
}

/** A deterministic id source for tests: a, b, ... as `p0000001`, `p0000002`, ... */
export function sequentialIds(prefix = 'q') {
  let n = 0;
  return () => (prefix + (++n).toString(36).padStart(7, '0')).slice(0, 8);
}
