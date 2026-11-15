// Password security on a PDF: opening an encrypted file (decrypting every string and stream into the
// plain working copy the model edits), protecting with passwords and permissions, and writing the
// encrypted file on Save.
//
// printcraft keeps the file's security beside the document and applies it at Save ("Security will be
// removed when you save"; pending protection is "written by the next save, which is a full rewrite"):
// crates/cos/src/security.rs (transform: what is and is not encrypted), crates/cos/src/document/open.rs
// (unlock, set_encryption, remove_encryption), crates/engine/src/protection.rs (Protection,
// permission_bits, validate, SecuritySummary, unrestricted) at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt). Ours does the same: the model's
// `sourceBase64` stays the plain working copy; `content.security` is what Save encrypts it with.
//
// Passwords are used to open or to derive keys and are never kept: the security record holds the
// encryption dictionary values and the file key only (the plain working copy is in the model anyway).
// pdf-lib parses and writes; no DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFParser, PDFName, PDFNumber, PDFBool, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFStream, PDFRef} from 'pdf-lib';
import {Algorithm, Auth, Method, SecurityHandler, CryptError, createEncryption, fileId, effectivePassword, encryptDict, hexOf, bytesOfHex, permissionsOf, modelPermissions, randomSeed, unrestricted} from './crypt.mjs';

export class PasswordError extends Error {
  /** @param {'password_required'|'wrong_password'} code */
  constructor(code, message) { super(message); this.name = 'PasswordError'; this.code = code; }
}

const latin1 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };

// ── reading the /Encrypt dictionary ────────────────────────────────────────────────────────────

const numberOf = v => (v instanceof PDFNumber ? v.asNumber() : undefined);
const bytesOf = v => (v instanceof PDFString || v instanceof PDFHexString ? v.asBytes() : undefined);
const nameOf = v => (v instanceof PDFName ? v.decodeText() : undefined);

/** The raw values encryptDict (crypt.mjs) reads, from an /Encrypt dictionary. */
function rawEncrypt(context, d) {
  const get = k => context.lookup(d.get(PDFName.of(k)));
  const cf = {};
  let cfLength;
  const cfDict = get('CF');
  if (cfDict instanceof PDFDict) {
    for (const [k, v] of cfDict.entries()) {
      const f = context.lookup(v);
      if (!(f instanceof PDFDict)) continue;
      cf[nameOf(k)] = nameOf(context.lookup(f.get(PDFName.of('CFM'))));
      if (nameOf(k) === 'StdCF') cfLength = numberOf(context.lookup(f.get(PDFName.of('Length'))));
    }
  }
  const meta = get('EncryptMetadata');
  return {
    Filter: nameOf(get('Filter')), V: numberOf(get('V')), R: numberOf(get('R')), Length: numberOf(get('Length')),
    O: bytesOf(get('O')), U: bytesOf(get('U')), OE: bytesOf(get('OE')), UE: bytesOf(get('UE')), Perms: bytesOf(get('Perms')), P: numberOf(get('P')),
    EncryptMetadata: meta instanceof PDFBool ? meta.asBoolean() : undefined, CF: cf, CFLength: cfLength,
    StmF: nameOf(get('StmF')), StrF: nameOf(get('StrF')), EFF: nameOf(get('EFF')),
  };
}

const firstId = context => {
  const id = context.lookup(context.trailerInfo.ID);
  return id instanceof PDFArray ? bytesOf(context.lookup(id.get(0))) ?? new Uint8Array(0) : new Uint8Array(0);
};

// ── the parser that decrypts as it reads ───────────────────────────────────────────────────────

const isSignatureDict = d => {
  if (d.has(PDFName.of('Subtype'))) return false;
  const t = d.get(PDFName.of('Type'));
  if (t) return ['Sig', 'DocTimeStamp'].includes(nameOf(t) ?? '');
  return d.get(PDFName.of('Contents')) instanceof PDFString && d.get(PDFName.of('ByteRange')) instanceof PDFArray
    || d.get(PDFName.of('Contents')) instanceof PDFHexString && d.get(PDFName.of('ByteRange')) instanceof PDFArray;
};

/** The crypt filter a stream names in its /Filter chain (/Crypt with /DecodeParms /Name), or null. */
function namedCrypt(dict) {
  const f = dict.get(PDFName.of('Filter'));
  const names = f instanceof PDFArray ? f.asArray().map(nameOf) : [nameOf(f)];
  const i = names.indexOf('Crypt');
  if (i < 0) return null;
  const parms = dict.get(PDFName.of('DecodeParms'));
  const p = parms instanceof PDFArray ? parms.get(i) : i === 0 ? parms : null;
  return p instanceof PDFDict ? nameOf(p.get(PDFName.of('Name'))) ?? 'Identity' : 'Identity';
}

/** Remove /Crypt from a stream's filter chain after its data is plain. */
function dropCrypt(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (!namedCrypt(dict)) return;
  if (f instanceof PDFArray) {
    const names = f.asArray().map(nameOf);
    const i = names.indexOf('Crypt');
    f.remove(i);
    const parms = dict.get(PDFName.of('DecodeParms'));
    if (parms instanceof PDFArray && i < parms.size()) parms.remove(i);
    if (!f.size()) { dict.delete(PDFName.of('Filter')); dict.delete(PDFName.of('DecodeParms')); }
  } else { dict.delete(PDFName.of('Filter')); dict.delete(PDFName.of('DecodeParms')); }
}

/** What a stream is ciphered with: 'stream', 'embedded', or a named crypt filter; null = leave alone. */
function streamKind(h, dict, decrypting) {
  const type = nameOf(dict.get(PDFName.of('Type')));
  if ((decrypting && type === 'XRef') || (type === 'Metadata' && !h.encryptsMetadata)) return null;
  const named = namedCrypt(dict);
  if (named) return {named};
  return type === 'EmbeddedFile' ? 'embedded' : 'stream';
}

const stringOf = bytes => PDFHexString.of(hexOf(bytes));

/** Decrypt the strings and the stream data of one indirect object in place; returns the object. */
function decryptObject(h, ref, obj) {
  const num = ref.objectNumber;
  const gen = ref.generationNumber;
  const strMethod = h.methodOf(null);
  const walk = v => {
    if (v instanceof PDFString || v instanceof PDFHexString) return strMethod === Method.Identity ? v : stringOf(h.decryptSync(strMethod, num, gen, v.asBytes()));
    if (v instanceof PDFArray) { for (let i = 0; i < v.size(); i++) v.set(i, walk(v.get(i))); return v; }
    if (v instanceof PDFDict) {
      const sig = isSignatureDict(v);
      for (const [k, x] of v.entries()) if (!(sig && nameOf(k) === 'Contents')) v.set(k, walk(x));
      return v;
    }
    return v;
  };
  if (obj instanceof PDFRawStream) {
    walk(obj.dict);
    const kind = streamKind(h, obj.dict, true);
    if (kind) {
      const method = h.methodOf(kind);
      obj.contents = h.decryptSync(method, num, gen, obj.contents);
      dropCrypt(obj.dict);
    }
    return obj;
  }
  return walk(obj);
}

class DecryptingParser extends PDFParser {
  constructor(bytes, handler, skipRef) {
    super(bytes, Infinity, false, false);
    this.handler = handler;
    this.skipRef = skipRef;
    this.depth = 0;
    this.current = null;
  }

  parseIndirectObjectHeader() { const r = super.parseIndirectObjectHeader(); this.current = r; return r; }

  parseObject() {
    this.depth++;
    try {
      const o = super.parseObject();
      if (this.depth === 1 && this.handler && this.current && !(this.skipRef && this.current.objectNumber === this.skipRef.objectNumber)) return decryptObject(this.handler, this.current, o);
      return o;
    } finally { this.depth--; }
  }
}

class ProbeParser extends PDFParser {
  constructor(bytes) { super(bytes, Infinity, false, false); this.current = null; }
  parseIndirectObjectHeader() { const r = super.parseIndirectObjectHeader(); this.current = r; return r; }
  async parseIndirectObject() {
    // Encrypted object streams are garbage to the base parser; their contents are not needed to find /Encrypt.
    try { return await super.parseIndirectObject(); } catch { return this.current; }
  }
}

/** Whether the bytes name an /Encrypt dictionary at all (cheap: no parse). */
export const mentionsEncrypt = bytes => latin1(bytes).includes('/Encrypt');

/**
 * The encryption of a PDF: null when it has none, else the dictionary, the first file id and where
 * the dictionary lives (a reference, or null when it is direct in the trailer).
 */
export async function readEncryption(bytes) {
  if (!mentionsEncrypt(bytes)) return null;
  const context = await new ProbeParser(bytes).parseDocument();
  const enc = context.trailerInfo.Encrypt;
  if (!enc) return null;
  const d = context.lookup(enc);
  if (!(d instanceof PDFDict)) return null;
  return {dict: encryptDict(rawEncrypt(context, d)), id0: firstId(context), ref: enc instanceof PDFRef ? enc : null};
}

const labelOf = d => {
  const stream = d.cryptFilters.find(([n]) => n === d.stmF)?.[1];
  if (d.v >= 1 && d.v <= 3) return d.lengthBits <= 40 ? 'RC4, 40-bit' : 'RC4, 128-bit';
  if (stream === Method.Rc4) return 'RC4, 128-bit';
  if (stream === Method.Aes128) return 'AES, 128-bit';
  if (stream === Method.Aes256) return 'AES, 256-bit';
  return 'Attachments only';
};

// ── the security record kept in content.security ───────────────────────────────────────────────

const CFM = {[Method.Rc4]: 'V2', [Method.Aes128]: 'AESV2', [Method.Aes256]: 'AESV3'};

/** A SecurityHandler's values as JSON (hex strings): what the model keeps. No password is in it. */
export function recordOf(h, id0, {pending = false} = {}) {
  const d = h.dict;
  return {
    v: d.v, r: d.r, length: d.lengthBits, o: hexOf(d.o), u: hexOf(d.u), oe: hexOf(d.oe), ue: hexOf(d.ue), perms: hexOf(d.perms), p: d.p, encryptMetadata: d.encryptMetadata,
    cf: d.cryptFilters.map(([n, m]) => [n, CFM[m] ?? 'None']), stmF: d.stmF, strF: d.strF, effF: d.effF,
    id0: hexOf(id0), key: hexOf(h.key), owner: h.auth === Auth.Owner, label: labelOf(d), pending,
  };
}

/** The handler a record describes. */
export function handlerOf(rec) {
  const dict = encryptDict({
    Filter: 'Standard', V: rec.v, R: rec.r, Length: rec.length, O: bytesOfHex(rec.o), U: bytesOfHex(rec.u), OE: bytesOfHex(rec.oe), UE: bytesOfHex(rec.ue), Perms: bytesOfHex(rec.perms),
    P: rec.p, EncryptMetadata: rec.encryptMetadata, CF: Object.fromEntries(rec.cf), CFLength: rec.v >= 5 ? 32 : rec.v === 4 ? 16 : undefined, StmF: rec.stmF, StrF: rec.strF, EFF: rec.effF,
  });
  return new SecurityHandler(dict, bytesOfHex(rec.key), rec.owner ? Auth.Owner : Auth.User);
}

/** The model's permissions (content.permissions) for a record: null when the session owns the file. */
export const permissionsOfRecord = rec => (rec ? modelPermissions(permissionsOf(rec.p, rec.owner)) : null);

// ── opening ────────────────────────────────────────────────────────────────────────────────────

/**
 * Open PDF bytes: the plain working copy, plus the security record when the file was encrypted.
 * An unencrypted file comes back as it is. A file that needs a password the person has not given
 * throws PasswordError('password_required'); a wrong one 'wrong_password'.
 * @returns {Promise<{bytes: Uint8Array, security: object|null}>}
 */
export async function openPdf(bytes, password = '') {
  const enc = await readEncryption(bytes);
  if (!enc) return {bytes, security: null};
  let h;
  try { h = await SecurityHandler.open(enc.dict, enc.id0, password); } catch (e) {
    if (e instanceof CryptError && e.code === 'wrong_password') throw new PasswordError(password ? 'wrong_password' : 'password_required', password ? 'The password is incorrect.' : 'This PDF needs a password to open.');
    throw e;
  }
  const context = await new DecryptingParser(bytes, h, enc.ref).parseDocument();
  context.trailerInfo.Encrypt = undefined;
  if (enc.ref) context.delete(enc.ref);
  const doc = new PDFDocument(context, true, false);
  const plain = await doc.save({updateFieldAppearances: false});
  return {bytes: plain, security: recordOf(h, enc.id0)};
}

// ── protecting ─────────────────────────────────────────────────────────────────────────────────

export const PRINTING = ['None', 'Low Resolution (150 dpi)', 'High Resolution'];
export const CHANGES = ['None', 'Inserting, deleting, and rotating pages', 'Filling in form fields and signing existing signature fields',
  'Commenting, filling in form fields, and signing existing signature fields', 'Any except extracting pages'];
export const COMPATIBILITY = ['Acrobat X and later (256-bit AES)', 'Acrobat 7.0 and later (128-bit AES)', 'Acrobat 5.0 and later (128-bit RC4)', 'Acrobat 3.0 and later (40-bit RC4)'];
const ALGORITHMS = [Algorithm.Aes256, Algorithm.Aes128, Algorithm.Rc4_128, Algorithm.Rc4_40];
export const algorithmOf = label => ALGORITHMS[Math.max(0, COMPATIBILITY.indexOf(label))];

/** Protection.permission_bits (engine/src/protection.rs): the /P value for the choices. */
export function permissionBits({permissionsPassword, printing = PRINTING[2], changes = CHANGES[0], copy = false, accessibility = true}) {
  if (!permissionsPassword) return -1;   // nothing restricted without a permissions password
  const bit = n => 1 << (n - 1);
  let p = 0;
  if (printing === PRINTING[1]) p |= bit(3);
  else if (printing === PRINTING[2]) p |= bit(3) | bit(12);
  p |= [0, bit(11), bit(9), bit(6) | bit(9), bit(4) | bit(6) | bit(9)][Math.max(0, CHANGES.indexOf(changes))];
  if (copy) p |= bit(5) | bit(10);
  if (accessibility) p |= bit(10);
  return p;
}

/** Protection.validate: why these choices cannot be applied, or null. */
export function protectionProblem({openPassword, permissionsPassword, algorithm}) {
  if (openPassword == null && permissionsPassword == null) return 'Enter a password to open the document, a permissions password, or both.';
  if (openPassword != null && permissionsPassword != null && openPassword === permissionsPassword) return 'The open password and the permissions password must be different.';
  if ([openPassword, permissionsPassword].some(p => p === '')) return "Passwords can't be empty.";
  if (algorithm !== Algorithm.Aes256 && [openPassword, permissionsPassword].some(p => p != null && /[^\x20-\x7e]/.test(p))) return 'This compatibility level supports only plain ASCII passwords: use AES-256 (Acrobat X and later).';
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const eff = p => (p == null ? null : effectivePassword(algorithm, p));
  const empty = effectivePassword(algorithm, '');
  const [open, perms] = [eff(openPassword), eff(permissionsPassword)];
  if ([open, perms].some(p => p && same(p, empty))) return "Passwords can't be empty or made only of characters that passwords ignore, such as soft hyphens.";
  if (open && perms && same(open, perms)) return 'The open password and the permissions password must be different (PDF readers treat these two as the same password).';
  return null;
}

/** The password strength meter of the dialog (protect.rs strength). */
export function strength(pw) {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  const n = Array.from(pw).length;
  return n >= 12 && classes >= 3 ? 'Strong' : n >= 8 && classes >= 2 ? 'Medium' : 'Weak';
}

/**
 * New protection: a pending security record for `bytes` (the plain working copy).
 * @param {{openPassword?: string|null, permissionsPassword?: string|null, compatibility?: string, encryptMetadata?: boolean,
 *   printing?: string, changes?: string, copy?: boolean, accessibility?: boolean}} p
 */
export async function protect(bytes, p) {
  const algorithm = algorithmOf(p.compatibility);
  const problem = protectionProblem({openPassword: p.openPassword, permissionsPassword: p.permissionsPassword, algorithm});
  if (problem) throw new PasswordError('invalid', problem);
  const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const seed = randomSeed();
  let id0 = firstId(doc.context);
  if (id0.length !== 16) id0 = await fileId(seed);
  const metadata = algorithm === Algorithm.Rc4_40 || algorithm === Algorithm.Rc4_128 ? true : p.encryptMetadata !== false;
  const h = await createEncryption({algorithm, userPassword: p.openPassword ?? '', ownerPassword: p.permissionsPassword ?? '', permissions: permissionBits(p), encryptMetadata: metadata, seed}, id0);
  return recordOf(h, id0, {pending: true});
}

/** Enter the permissions (owner) password: the record upgraded to owner access, or a wrong-password error. */
export async function unlock(rec, password) {
  const h = handlerOf(rec);
  try {
    const owner = await h.authenticateOwner(bytesOfHex(rec.id0), password);
    return recordOf(owner, bytesOfHex(rec.id0), {pending: rec.pending});
  } catch (e) {
    if (e instanceof CryptError && e.code === 'wrong_password') throw new PasswordError('wrong_password', 'The permissions password is incorrect.');
    throw e;
  }
}

/** Whether security may be changed without entering a password (printcraft allows_security_change). */
export const mayChangeSecurity = rec => !rec || rec.owner || unrestricted(permissionsOf(rec.p, false));
/** Whether a permissions password would lift restrictions (printcraft can_unlock). */
export const canUnlock = rec => !!rec && !rec.owner && !unrestricted(permissionsOf(rec.p, false));

// ── writing ────────────────────────────────────────────────────────────────────────────────────

/**
 * Encrypt `doc` (a plain pdf-lib document) with the record, in place: every string and stream except what the
 * specification leaves in the clear, then the /Encrypt dictionary and the file id. Save the document with
 * `{useObjectStreams: false}` (an object stream is encrypted as a whole; the strings in it are not).
 */
export async function encryptDocument(doc, rec) {
  const h = handlerOf(rec);
  await doc.flush();
  const context = doc.context;
  context.trailerInfo.Encrypt = undefined;
  const strMethod = h.methodOf(null);
  const walk = async (v, num, gen) => {
    if (v instanceof PDFString || v instanceof PDFHexString) return strMethod === Method.Identity ? v : stringOf(await h.encryptString(num, gen, v.asBytes()));
    if (v instanceof PDFArray) { for (let i = 0; i < v.size(); i++) v.set(i, await walk(v.get(i), num, gen)); return v; }
    if (v instanceof PDFDict) {
      const signature = isSignatureDict(v);
      for (const [k, x] of v.entries()) if (!(signature && nameOf(k) === 'Contents')) v.set(k, await walk(x, num, gen));
      return v;
    }
    return v;
  };
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    const num = ref.objectNumber;
    const gen = ref.generationNumber;
    if (obj instanceof PDFStream) {
      await walk(obj.dict, num, gen);
      const type = nameOf(obj.dict.get(PDFName.of('Type')));
      if (type === 'XRef') continue;
      const kind = streamKind(h, obj.dict, false);
      if (!kind) continue;
      if (!(obj instanceof PDFRawStream)) obj.updateDict();
      const data = obj instanceof PDFRawStream ? obj.contents : obj.getContents();
      const enc = await h.apply(h.methodOf(kind), num, gen, data, true);
      context.assign(ref, PDFRawStream.of(obj.dict, enc));
    } else await walk(obj, num, gen);
  }
  const hexs = b => PDFHexString.of(hexOf(b));
  const d = h.dict;
  const e = {Filter: PDFName.of('Standard'), V: PDFNumber.of(d.v), R: PDFNumber.of(d.r), Length: PDFNumber.of(d.lengthBits), O: hexs(d.o), U: hexs(d.u), P: PDFNumber.of(d.p)};
  if (d.v >= 4) {
    const std = context.obj({Type: 'CryptFilter', CFM: d.v >= 5 ? 'AESV3' : 'AESV2', Length: d.v >= 5 ? 32 : 16, AuthEvent: 'DocOpen'});
    e.CF = context.obj({StdCF: std});
    e.StmF = PDFName.of('StdCF');
    e.StrF = PDFName.of('StdCF');
    if (!d.encryptMetadata) e.EncryptMetadata = PDFBool.False;
  }
  if (d.v >= 5) { e.OE = hexs(d.oe); e.UE = hexs(d.ue); e.Perms = hexs(d.perms); }
  const encRef = context.register(context.obj(e));
  context.trailerInfo.Encrypt = encRef;
  const id = hexs(bytesOfHex(rec.id0));
  context.trailerInfo.ID = context.obj([id, id]);
}

/** Bytes of `doc` encrypted with the record. */
export async function saveEncrypted(doc, rec) {
  await encryptDocument(doc, rec);
  return doc.save({useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false});
}

export {unrestricted, permissionsOf, Algorithm};
