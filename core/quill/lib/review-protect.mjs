// Restrict Editing (U:quill/review, Review › Protect): editing restrictions (read only, comments,
// tracked changes, filling in forms), formatting limited to a selection of styles, exceptions —
// ranges everyone may still edit — and an optional password that guards Stop Protection; and
// their enforcement on every command (core/quill/hooks.mjs runs `checkBefore` and
// `outsideUnchanged` around each one, as upstream's Session::run does).
//
// Translated from wordcraft crates/engine/src/cmd/protect.rs (`MODES`, `state`, `enforced`,
// `editing_restricted`, `editable_by`, `restrict`, `stop_protection`, `add_exception`,
// `remove_exceptions`, `CONTROL_INSERTS`, `always_allowed`, `greyed_out`, `check_before`,
// `check_formatting`, `outside_unchanged`, `comments_unchanged`, `lists_unchanged`,
// `sources_unchanged`, `sections`, `outside`, `structure`, `next_region`) and
// crates/docx/src/crypt.rs (`protection_hash`, `check_protection_password`, `verify`,
// `legacy_key`, `legacy_key_hex`, `iterate_appended`, `DEFAULT_SPIN_COUNT`, `MAX_SPIN_COUNT`)
// at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// SHA-512 and SHA-384 are computed here synchronously (100,000 rounds per check); SHA-1 and
// SHA-256 come from the PDF unit's synchronous digests (core/folio/lib/sign-crypto.mjs).

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {BODY} from '../model/document.mjs';
import {lockCanEdit} from '../model/ranges.mjs';
import {deepEq} from './review-fmt.mjs';
import {sha1, sha256} from '../../folio/lib/sign-crypto.mjs';

/** The editing restrictions `w:edit` names. */
export const MODES = Object.freeze(['none', 'readOnly', 'comments', 'trackedChanges', 'forms']);
export const DEFAULT_SPIN_COUNT = 100_000;
const MAX_SPIN_COUNT = 10_000_000;
export const MAX_PASSWORD_CHARS = 255;
export const UNSUPPORTED_PASSWORD = "This password type isn't supported";

const disabled = msg => new CommandError('disabled', msg);
const params = msg => new CommandError('invalid_params', msg);

export const enforced = d => !!d.c.settings?.protection;
export const editingRestricted = d => { const m = d.c.settings?.protection; return !!m && m !== 'none'; };
export const editableBy = (r, author) => String(r.group ?? '').toLowerCase() === 'everyone' || (!!r.editor && String(r.editor).toLowerCase() === String(author).trim().toLowerCase());

/** The number of content controls that take entries (fillable_controls). */
const fillableControls = d => d.fillableControls();

/** The protection state, as review.restrict returns it and the Restrict Editing pane shows it (state). */
export function protectState(d, author, addr = p => p) {
  const st = d.c.settings ?? {};
  const regions = d.permRanges().filter(r => editableBy(r, author)).map(r => ({start: addr(r.start), end: addr(r.end)}));
  return {protection: st.protection ?? null, formatting: !!st.protectFormatting, password: (st.protectHash ?? []).length > 0,
    lockedStyles: (d.c.styles?.styles ?? []).filter(x => x.locked).map(x => x.id), exceptions: regions.length, regions, formFields: fillableControls(d)};
}

// ---- passwords (crypt.rs) -----------------------------------------------------------------------

const K512 = (() => {
  const hex = ['428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
    'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
    'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
    '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
    '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
    'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
    '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
    '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
    'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
    '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817'];
  const k = new Uint32Array(160);
  hex.forEach((h, i) => { k[2 * i] = parseInt(h.slice(0, 8), 16); k[2 * i + 1] = parseInt(h.slice(8), 16); });
  return k;
})();
const IV512 = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'];
const IV384 = ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'];

/** SHA-512 (or SHA-384 with `iv384`) of `m`, synchronously, with 32-bit halves. */
function sha2_512(m, iv = IV512, outLen = 64) {
  const len = m.length;
  const total = Math.ceil((len + 17) / 128) * 128;
  const p = new Uint8Array(total);
  p.set(m);
  p[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(p.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 0x1_0000_0000));
  dv.setUint32(total - 4, bits >>> 0);
  const h = new Uint32Array(16);
  iv.forEach((x, i) => { h[2 * i] = parseInt(x.slice(0, 8), 16); h[2 * i + 1] = parseInt(x.slice(8), 16); });
  const w = new Uint32Array(160);
  for (let o = 0; o < total; o += 128) {
    for (let i = 0; i < 32; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 80; i++) {
      // s0 = rotr1 ^ rotr8 ^ shr7 of w[i-15]; s1 = rotr19 ^ rotr61 ^ shr6 of w[i-2]
      let xh = w[2 * (i - 15)], xl = w[2 * (i - 15) + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = w[2 * (i - 2)]; xl = w[2 * (i - 2) + 1];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      let lo = (s0l >>> 0) + (s1l >>> 0) + w[2 * (i - 7) + 1] + w[2 * (i - 16) + 1];
      let hi = (s0h >>> 0) + (s1h >>> 0) + w[2 * (i - 7)] + w[2 * (i - 16)] + Math.floor(lo / 0x1_0000_0000);
      w[2 * i] = hi >>> 0; w[2 * i + 1] = lo >>> 0;
    }
    let [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl] = h;
    for (let i = 0; i < 80; i++) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      let lo = hl + (S1l >>> 0) + (chl >>> 0) + K512[2 * i + 1] + w[2 * i + 1];
      let hi = hh + (S1h >>> 0) + (chh >>> 0) + K512[2 * i] + w[2 * i] + Math.floor(lo / 0x1_0000_0000);
      const t1h = hi >>> 0, t1l = lo >>> 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      lo = (S0l >>> 0) + (mjl >>> 0);
      hi = (S0h >>> 0) + (mjh >>> 0) + Math.floor(lo / 0x1_0000_0000);
      const t2h = hi >>> 0, t2l = lo >>> 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      lo = dl + t1l; eh = (dh + t1h + Math.floor(lo / 0x1_0000_0000)) >>> 0; el = lo >>> 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      lo = t1l + t2l; ah = (t1h + t2h + Math.floor(lo / 0x1_0000_0000)) >>> 0; al = lo >>> 0;
    }
    const add = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let i = 0; i < 16; i += 2) {
      const lo = h[i + 1] + add[i + 1];
      h[i] = (h[i] + add[i] + Math.floor(lo / 0x1_0000_0000)) >>> 0;
      h[i + 1] = lo >>> 0;
    }
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) odv.setUint32(i * 4, h[i]);
  return out.slice(0, outLen);
}
export const sha512 = m => sha2_512(m);
const sha384 = m => sha2_512(m, IV384, 48);

const HASHES = {'SHA-1': [sha1, 20], 'SHA-256': [sha256, 32], 'SHA-384': [sha384, 48], 'SHA-512': [sha512, 64]};
const hashByName = n => {
  const k = String(n ?? '').trim().toUpperCase().replace(/^SHA(\d)/, 'SHA-$1');
  return HASHES[k] ? k : null;
};

const utf16le = s => { const out = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 * i] = c & 0xff; out[2 * i + 1] = c >> 8; } return out; };
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const b64 = u => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => { try { const t = atob(String(s).trim()); return Uint8Array.from(t, c => c.charCodeAt(0)); } catch { return null; } };

/** H0 = H(salt + password as UTF-16LE), Hn = H(Hn-1 + iterator LE) (iterate_appended). */
export function iterateAppended(hashName, salt, password, spin) {
  const [h] = HASHES[hashName];
  let x = h(cat(salt, utf16le(password)));
  const it = new Uint8Array(4);
  const buf = new Uint8Array(x.length + 4);
  for (let i = 0; i < Math.min(spin, MAX_SPIN_COUNT); i++) {
    it[0] = i & 0xff; it[1] = (i >>> 8) & 0xff; it[2] = (i >>> 16) & 0xff; it[3] = (i >>> 24) & 0xff;
    buf.set(x); buf.set(it, x.length);
    x = h(buf);
  }
  return x;
}

/** Word's checks on a password (check_password). */
export function checkPassword(pw) {
  if (!pw) throw params('the password is empty');
  if ([...pw].length > MAX_PASSWORD_CHARS) throw params(`passwords are at most ${MAX_PASSWORD_CHARS} characters`);
}

/** The `w:documentProtection` hash attributes for a password (protection_hash). */
export function protectionHash(password, spin = DEFAULT_SPIN_COUNT, salt = null) {
  checkPassword(password);
  const s = salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const n = Math.min(spin, MAX_SPIN_COUNT);
  return [['w:algorithmName', 'SHA-512'], ['w:hashValue', b64(iterateAppended('SHA-512', s, password, n))], ['w:saltValue', b64(s)], ['w:spinCount', String(n)]];
}

const LEGACY_INITIAL_CODE = [0xE1F0, 0x1D0F, 0xCC9C, 0x84C0, 0x110C, 0x0E10, 0xF1CE, 0x313E, 0x1872, 0xE139, 0xD40F, 0x84F9, 0x280C, 0xA96A, 0x4EC3];
const LEGACY_MATRIX = [
  [0xAEFC, 0x4DD9, 0x9BB2, 0x2745, 0x4E8A, 0x9D14, 0x2A09], [0x7B61, 0xF6C2, 0xFDA5, 0xEB6B, 0xC6F7, 0x9DCF, 0x2BBF], [0x4563, 0x8AC6, 0x05AD, 0x0B5A, 0x16B4, 0x2D68, 0x5AD0],
  [0x0375, 0x06EA, 0x0DD4, 0x1BA8, 0x3750, 0x6EA0, 0xDD40], [0xD849, 0xA0B3, 0x5147, 0xA28E, 0x553D, 0xAA7A, 0x44D5], [0x6F45, 0xDE8A, 0xAD35, 0x4A4B, 0x9496, 0x390D, 0x721A],
  [0xEB23, 0xC667, 0x9CEF, 0x29FF, 0x53FE, 0xA7FC, 0x5FD9], [0x47D3, 0x8FA6, 0x0F6D, 0x1EDA, 0x3DB4, 0x7B68, 0xF6D0], [0xB861, 0x60E3, 0xC1C6, 0x93AD, 0x377B, 0x6EF6, 0xDDEC],
  [0x45A0, 0x8B40, 0x06A1, 0x0D42, 0x1A84, 0x3508, 0x6A10], [0xAA51, 0x4483, 0x8906, 0x022D, 0x045A, 0x08B4, 0x1168], [0x76B4, 0xED68, 0xCAF1, 0x85C3, 0x1BA7, 0x374E, 0x6E9C],
  [0x3730, 0x6E60, 0xDCC0, 0xA9A1, 0x4363, 0x86C6, 0x1DAD], [0x3331, 0x6662, 0xCCC4, 0x89A9, 0x0373, 0x06E6, 0x0DCC], [0x1021, 0x2042, 0x4084, 0x8108, 0x1231, 0x2462, 0x48C4],
];

/** Word's legacy 32-bit password key (legacy_key). */
export function legacyKey(password) {
  const units = [];
  for (let i = 0; i < password.length; i++) units.push(password.charCodeAt(i));
  if (units[0] === 0xfeff) units.shift();
  const bytes = units.slice(0, LEGACY_INITIAL_CODE.length).map(u => ((u & 0xff) !== 0 ? u & 0xff : u >> 8));
  if (!bytes.length) return 0;
  let high = LEGACY_INITIAL_CODE[bytes.length - 1];
  const firstRow = LEGACY_MATRIX.length - bytes.length;
  bytes.forEach((c, k) => { const row = LEGACY_MATRIX[firstRow + k]; for (let bit = 0; bit < 7; bit++) if (c & (1 << bit)) high ^= row[bit]; });
  const rotate = w => ((w >> 14) & 0x0001) | ((w << 1) & 0x7fff);
  let low = 0;
  for (let k = bytes.length - 1; k >= 0; k--) low = rotate(low) ^ bytes[k];
  low = rotate(low) ^ bytes.length ^ 0xCE4B;
  return ((high << 16) | low) >>> 0;
}
const legacyKeyHex = pw => { const k = legacyKey(pw); return [k & 0xff, (k >>> 8) & 0xff, (k >>> 16) & 0xff, k >>> 24].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''); };

/** Does `password` match a Restrict Editing hash? 'none' | 'correct' | 'incorrect' | 'unsupported' (check_protection_password). */
export function checkProtectionPassword(attrs, password) {
  const get = k => { const hit = (attrs ?? []).find(([n]) => n === k); return hit ? String(hit[1]).trim() : null; };
  const verify = (hashName, want, salt, spin, input) => {
    const w = want === null ? null : unb64(want);
    if (!w) return 'unsupported';
    const s = salt === null ? new Uint8Array(0) : unb64(salt);
    if (!s) return 'unsupported';
    let n = 0;
    if (spin !== null) { n = /^\d+$/.test(spin) ? Number(spin) : NaN; if (!(n <= MAX_SPIN_COUNT)) return 'unsupported'; }
    if (w.length !== HASHES[hashName][1] || s.length > 1024) return 'unsupported';
    const got = iterateAppended(hashName, s, input, n);
    return got.length === w.length && got.every((x, i) => x === w[i]) ? 'correct' : 'incorrect';
  };
  if (get('w:hashValue') !== null) {
    const h = hashByName(get('w:algorithmName'));
    if (!h) return 'unsupported';
    return verify(h, get('w:hashValue'), get('w:saltValue'), get('w:spinCount'), password);
  }
  if (get('w:hash') === null) return 'none';
  const classOk = get('w:cryptAlgorithmClass') === null || get('w:cryptAlgorithmClass') === 'hash';
  const typeOk = get('w:cryptAlgorithmType') === null || get('w:cryptAlgorithmType') === 'typeAny';
  if (!classOk || !typeOk || get('w:algIdExt') !== null) return 'unsupported';
  const h = {4: 'SHA-1', 12: 'SHA-256', 13: 'SHA-384', 14: 'SHA-512'}[Number(get('w:cryptAlgorithmSid'))];
  if (!h) return 'unsupported';
  return verify(h, get('w:hash'), get('w:salt'), get('w:cryptSpinCount'), legacyKeyHex(password));
}

// ---- review.restrict ---------------------------------------------------------------------------

/** Stop Protection, with the document's password when it has one (stop_protection). */
export function stopProtection(d, password) {
  if (enforced(d)) {
    const r = checkProtectionPassword(d.c.settings.protectHash ?? [], password ?? '');
    if (r === 'incorrect' && !password) throw params("type the document's password to stop protection");
    if (r === 'incorrect') throw params('the password is incorrect');
    if (r === 'unsupported') throw disabled(UNSUPPORTED_PASSWORD);
  }
  d.updateField('settings', s => { s.protection = null; s.protectFormatting = false; s.protectHash = []; });
}

/** Make a..b an exception everyone may edit; returns the new selection (add_exception). */
export function addException(d, a, b) {
  if ((a.story === b.story && a.path.join() === b.path.join() && a.off === b.off) || a.story !== b.story) throw params('select the text that stays editable');
  const ids = d.permRanges().map(r => r.id);
  const id = ids.length ? Math.max(...ids) + 1 : 0;
  d.insertObject(b, {type: 'permEnd', id}, {});
  const afterStart = d.insertObject(a, {type: 'permStart', id, group: 'everyone', editor: ''}, {});
  const end = {...b, path: [...b.path], off: b.off + (b.story === a.story && b.path.join() === a.path.join() ? 1 : 0)};
  return {anchor: afterStart, focus: end};
}

/** Remove the exceptions that touch a..b (or all of them) (remove_exceptions). */
export function removeExceptions(d, a, b, all, cmp) {
  const ids = new Set(d.permRanges().filter(r => all || (r.start.story === a.story && cmp(r.start, b) <= 0 && cmp(a, r.end) <= 0)).map(r => r.id));
  if (!ids.size) return;
  for (const story of [BODY, ...Object.keys(d.c.parts ?? {}).map(Number)]) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p?.objects?.length) continue;
      const marks = P.objectsWithOffsets(p).filter(([, o]) => (o.type === 'permStart' || o.type === 'permEnd') && ids.has(o.id)).map(([off]) => off);
      for (let k = marks.length - 1; k >= 0; k--) d._pDelete(story, path, marks[k], marks[k] + 1);
    }
  }
}

// ---- enforcement -------------------------------------------------------------------------------

const CONTROL_INSERTS = ['developer.richText', 'developer.plainText', 'developer.picture', 'developer.buildingBlock', 'developer.checkBox', 'developer.comboBox',
  'developer.dropDown', 'developer.datePicker', 'developer.repeatingSection'];

/** Commands always allowed in a protected document (always_allowed). */
function alwaysAllowed(id, p) {
  if (id === 'review.restrict' || id === 'edit.undo' || id === 'edit.redo') return true;
  if (!id.startsWith('file.')) return false;
  if (id === 'file.privacyOptions' || id === 'file.properties' || id === 'file.setAuthor') return false;
  if (id === 'file.inspect') return !(Array.isArray(p?.remove) && p.remove.length);
  return true;
}

const commentOk = id => id.startsWith('review.') && (id.includes('Comment') || id === 'review.reply');

/** Why protection refuses command `id` whatever its params (greyed_out), or null. */
export function greyedOut(d, author, id) {
  const mode = d.c.settings?.protection;
  if (!mode || alwaysAllowed(id, null)) return null;
  if (mode === 'forms') {
    if (id === 'developer.removeControl') return 'stop protection before removing a content control';
    if (id === 'developer.properties') return "stop protection before changing a content control's properties";
    if (CONTROL_INSERTS.includes(id)) return 'stop protection before inserting a content control';
  }
  const tracked = ['review.accept', 'review.reject', 'review.acceptAll', 'review.rejectAll', 'review.trackChanges'].includes(id);
  const exceptions = () => d.permRanges().some(r => editableBy(r, author));
  switch (mode) {
    case 'readOnly': return exceptions() ? null : 'the document is protected (read only)';
    case 'forms': return fillableControls(d) ? null : 'the document is protected (read only)';
    case 'comments': return commentOk(id) || exceptions() ? null : 'only comments are allowed in this document';
    case 'trackedChanges': return tracked ? 'changes to this document are tracked' : null;
    default: return null;
  }
}

/** Formatting limited to a selection of styles: no direct formatting, and no locked style (check_formatting). */
function checkFormatting(d, id, p) {
  const style = {'para.style': p?.style, 'format.charStyle': p?.style, 'table.style': p?.style, 'para.normal': 'Normal', 'para.heading1': 'Heading1',
    'para.heading2': 'Heading2', 'para.heading3': 'Heading3'}[id];
  if (typeof style === 'string') {
    const locked = (d.c.styles?.styles ?? []).some(st => st.locked && (st.id === style || String(st.name ?? '').toLowerCase() === style.toLowerCase()));
    if (locked) throw disabled(`${id}: the style ${JSON.stringify(style)} is locked in this document`);
    return;
  }
  const direct = (id.startsWith('format.') && !['format.changeCase', 'format.state', 'format.fontDialog'].includes(id))
    || (id.startsWith('para.') && !['para.sort', 'para.dialog'].includes(id))
    || id.startsWith('styles.create') || id.startsWith('styles.modify') || id.startsWith('styles.update') || id.startsWith('styles.delete')
    || ['edit.pasteFormat', 'table.shading', 'table.borders', 'table.borderPainter', 'table.cellAlign', 'table.cellMargins', 'table.textDirection',
      'table.properties', 'table.rowHeight', 'table.newStyle', 'table.modifyStyle', 'table.deleteStyle', 'tools.updateStyles', 'styles.copyFrom'].includes(id)
    || (id === 'tools.attachTemplate' && p?.update === true);
  if (direct) throw disabled(`${id}: formatting is limited to the document's styles`);
}

/**
 * What a protected document lets command `id` do before it runs: throws to refuse it; true lets it
 * run as long as it only changes the exceptions (checked afterwards with outsideUnchanged) (check_before).
 */
export function checkBefore(d, author, id, p) {
  const mode = d.c.settings?.protection;
  if (!mode || alwaysAllowed(id, p)) return false;
  if (id === 'file.setAuthor') throw disabled('file.setAuthor: stop protection before changing the user name');
  if (id === 'developer.properties' && (p?.lockEdit !== undefined || p?.lockDelete !== undefined)) throw disabled(`${id}: stop protection before changing a content control's locks`);
  if (id === 'file.properties') throw disabled(`${id}: stop protection before changing the document's properties`);
  if (id === 'file.privacyOptions') throw disabled(`${id}: stop protection before changing the privacy options`);
  if (id === 'file.inspect') throw disabled(`${id}: stop protection before removing content with the inspector`);
  const why = greyedOut(d, author, id);
  if (why) throw disabled(`${id}: ${why}`);
  if (d.c.settings.protectFormatting) checkFormatting(d, id, p);
  if (mode === 'comments' && commentOk(id)) return false;
  return mode === 'readOnly' || mode === 'forms' || mode === 'comments';
}

/** Everything outside the editable regions, in order (outside + structure). */
function outside(d, author, forms) {
  const editable = forms ? new Set() : new Set(d.permRanges().filter(r => editableBy(r, author)).map(r => r.id));
  const out = [];
  for (const story of [BODY, ...Object.keys(d.c.parts ?? {}).map(Number).sort((a, b) => a - b)]) {
    const open = [], fillable = [];
    const paired = new Set();
    if (forms) { try { for (const r of d.controlRanges(story)) { paired.add(`${r.start.path.join('.')}:${r.start.off}`); paired.add(`${r.end.path.join('.')}:${r.end.off}`); } } catch { /* none */ } }
    const inHole = () => (forms ? fillable[fillable.length - 1] === true : open.length > 0);
    const protectedPaths = new Set(), holding = new Set();
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p) continue;
      const before = out.length;
      let k = 0;
      for (const [s, e, props] of P.runRanges(p)) {
        let piece = '';
        const flush = () => { if (piece && !inHole()) out.push(['t', piece, props]); piece = ''; };
        for (let i = s; i < e; i++) {
          const c = p.text[i];
          if (c === P.OBJ) {
            const o = p.objects?.[k++];
            let boundary = false;
            if (!forms && (o?.type === 'permStart' || o?.type === 'permEnd') && editable.has(o.id)) {
              flush();
              if (o.type === 'permStart') open.push(o.id); else { const j = open.lastIndexOf(o.id); if (j >= 0) open.splice(j, 1); }
              boundary = true;
            } else if (forms && (o?.type === 'controlStart' || o?.type === 'controlEnd') && paired.has(`${path.join('.')}:${i}`)) {
              flush();
              if (o.type === 'controlStart') fillable.push(lockCanEdit(o.control?.lock)); else fillable.pop();
              boundary = true;
            }
            if (!boundary && !inHole()) { flush(); out.push(['o', o ?? null]); }
            continue;
          }
          if (!inHole()) piece += c;
        }
        flush();
      }
      if (!inHole()) out.push(['m', p.props ?? {}, p.mark ?? {}]);
      const ancestors = [];
      for (let n = 1; n < path.length; n++) ancestors.push(path.slice(0, n).join('.'));
      if (out.length > before) for (const a of ancestors) protectedPaths.add(a);
      for (const a of ancestors) holding.add(a);
    }
    const list = d.story(story);
    if (list) structure(list.toArray(), [], protectedPaths, holding, out, 0);
  }
  return out;
}

function structure(blocks, prefix, prot, holding, out, depth) {
  if (depth > 16) { if (blocks.length) out.push(['deep', JSON.stringify(blocks)]); return; }
  const guarded = at => prot.has(at.join('.')) || !holding.has(at.join('.'));
  blocks.forEach((b, i) => {
    if (b.kind !== 'table') return;
    prefix.push(i);
    if (guarded(prefix)) out.push(['table', b.props ?? {}, b.grid]);
    b.rows.forEach((row, r) => {
      prefix.push(r);
      if (guarded(prefix)) out.push(['row', row.props ?? {}]);
      row.cells.forEach((cell, c) => {
        prefix.push(c);
        if (guarded(prefix)) out.push(['cell', cell.props ?? {}]);
        structure(cell.blocks, prefix, prot, holding, out, depth + 1);
        prefix.pop();
      });
      prefix.pop();
    });
    prefix.pop();
  });
}

const sectionsOf = d => d.paraPaths(BODY).map(path => d.para(BODY, path)?.section).filter(Boolean);

/** Did a command leave everything outside the editable regions as it was? (outside_unchanged) */
export function outsideUnchanged(before, after, author) {
  const forms = before.c.settings?.protection === 'forms';
  const b = before.c.styles, a = after.c.styles;
  const getStyle = (sh, id) => sh.styles.find(x => x.id === id);
  return deepEq(before.c.lastSection, after.c.lastSection)
    && deepEq(sectionsOf(before), sectionsOf(after))
    && deepEq(b.defaultChr, a.defaultChr) && deepEq(b.defaultPara, a.defaultPara)
    && b.styles.every(st => deepEq(getStyle(a, st.id), st))
    && deepEq(before.c.settings, after.c.settings)
    && deepEq(before.c.core, after.c.core)
    && deepEq(before.c.customProps, after.c.customProps)
    && Object.entries(before.c.comments ?? {}).every(([id, c]) => after.c.comments?.[id] && !!after.c.comments[id].resolved === !!c.resolved)
    && (before.c.numbering?.abstracts ?? []).every(x => (after.c.numbering?.abstracts ?? []).some(y => deepEq(x, y)))
    && (before.c.numbering?.nums ?? []).every(x => (after.c.numbering?.nums ?? []).some(y => deepEq(x, y)))
    && (before.c.sources ?? []).every(x => (after.c.sources ?? []).some(y => deepEq(x, y)))
    && deepEq(outside(before, author, forms), outside(after, author, forms));
}

/** The first editable range after `from` (wrapping), for Find Next Region I Can Edit (next_region). */
export function nextRegion(d, author, from, cmp) {
  if (d.c.settings?.protection === 'forms') {
    const ranges = [];
    for (const story of [BODY, ...Object.keys(d.c.parts ?? {}).map(Number)]) {
      try { for (const r of d.controlRanges(story)) if (lockCanEdit(r.control?.lock)) ranges.push([{...r.start, off: r.start.off + 1}, r.end]); } catch { /* none */ }
    }
    ranges.sort((x, y) => cmp(x[0], y[0]));
    return ranges.find(r => cmp(r[0], from) > 0) ?? ranges[0] ?? null;
  }
  const ranges = d.permRanges().filter(r => editableBy(r, author));
  const next = ranges.find(r => cmp(r.start, from) > 0) ?? ranges[0];
  return next ? [next.start, next.end] : null;
}
