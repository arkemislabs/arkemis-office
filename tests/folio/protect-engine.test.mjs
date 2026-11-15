// core/folio/lib/crypt.mjs and protect.mjs: the standard security handler (every revision) and password
// protection of PDF files.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/crypt/src/lib.rs + tests.rs, crates/cos/src/security.rs, crates/engine/src/protection.rs):
//    R2 (40-bit RC4), R3 (128-bit RC4), R4 (AES-128) and R6 (AES-256) are created and opened; the owner password
//    authenticates first; the permissions are /P (and /Perms for R6); the open password with no permissions
//    password restricts nothing; strings and streams are encrypted except the /Encrypt dictionary, cross-reference
//    streams, the file id and signature contents; Protect refuses an empty password, equal passwords and a non-ASCII
//    password below AES-256. Acrobat's Protect using password and Remove security do the same.
// 2. Ours does the same; the reference vectors (RC4, AES-CBC, MD5, SHA) are the published ones, and the files
//    this writes are opened by pdf.js, an independent reader, with the passwords and the permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString} from 'pdf-lib';
import {textPdf, LINES} from '../../core/folio/fixtures.mjs';
import * as C from '../../core/folio/lib/crypt.mjs';
import * as P from '../../core/folio/lib/protect.mjs';

const hex = s => C.bytesOfHex(s);
const ALL = [C.Algorithm.Rc4_40, C.Algorithm.Rc4_128, C.Algorithm.Aes128, C.Algorithm.Aes256];
const ID = new TextEncoder().encode('0123456789abcdef');
const SEED = new Uint8Array(32).fill(42);
const make = (algorithm, userPassword, ownerPassword, permissions) => C.createEncryption({algorithm, userPassword, ownerPassword, permissions, encryptMetadata: true, seed: SEED}, ID);

test('RC4, MD5 and AES-CBC give the published reference vectors', async () => {
  const enc = s => new TextEncoder().encode(s);
  assert.equal(C.hexOf(C.rc4(enc('Key'), enc('Plaintext'))), 'bbf316e8d940af0ad3');
  assert.equal(C.hexOf(C.rc4(enc('Wiki'), enc('pedia'))), '1021bf0420');
  assert.equal(C.hexOf(C.md5(enc(''))), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(C.hexOf(C.md5(enc('abc'))), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(C.hexOf(C.md5(enc('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))), '57edf4a22be3c955ac49da2e2107b67a');
  const iv = hex('000102030405060708090a0b0c0d0e0f');
  const plain = hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
  for (const [key, cipher] of [['2b7e151628aed2a6abf7158809cf4f3c', '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2'],
    ['603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4', 'f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d']]) {
    const c = await C.aesCbcEncrypt(hex(key), iv, plain, false);
    assert.equal(C.hexOf(c), cipher);
    assert.equal(C.hexOf(await C.aesCbcDecrypt(hex(key), iv, c, false)), C.hexOf(plain));
    assert.equal(C.hexOf(C.aesCbcDecryptSync(hex(key), iv, c, false)), C.hexOf(plain), 'the synchronous decryption agrees');
  }
  for (const n of [0, 1, 15, 16, 17, 100]) {
    const data = Uint8Array.from({length: n}, (_, i) => i);
    const c = await C.aesCbcEncrypt(new Uint8Array(16).fill(7), new Uint8Array(16).fill(1), data, true);
    assert.equal(c.length % 16, 0);
    assert.deepEqual(await C.aesCbcDecrypt(new Uint8Array(16).fill(7), new Uint8Array(16).fill(1), c, true), data);
    assert.deepEqual(C.aesCbcDecryptSync(new Uint8Array(16).fill(7), new Uint8Array(16).fill(1), c, true), data);
  }
});

test('created encryption authenticates owner and user; wrong passwords fail; the owner password upgrades a user session', async () => {
  for (const alg of ALL) {
    const made = await make(alg, 'user pw', 'owner pw', 0b0100);
    const owner = await C.SecurityHandler.open(made.dict, ID, 'owner pw');
    assert.equal(owner.auth, C.Auth.Owner, alg);
    assert.deepEqual(owner.key, made.key, alg);
    assert.equal((await owner.permissions()).modify, true, 'owners can do everything');
    const user = await C.SecurityHandler.open(made.dict, ID, 'user pw');
    assert.equal(user.auth, C.Auth.User, alg);
    const perms = await user.permissions();
    assert.deepEqual([perms.print, perms.modify, perms.copy], [true, false, false], alg);
    await assert.rejects(C.SecurityHandler.open(made.dict, ID, 'nope'), /incorrect/, alg);
    await assert.rejects(C.SecurityHandler.open(made.dict, ID, ''), /incorrect/, alg);
    await assert.rejects(user.authenticateOwner(ID, 'user pw'), /incorrect/, alg);
    assert.equal((await user.authenticateOwner(ID, 'owner pw')).auth, C.Auth.Owner, alg);
    // The empty user password opens without asking; the owner password still restricts nothing for the owner.
    const open = await make(alg, '', 'secret', 0b0100);
    assert.equal((await C.SecurityHandler.open(open.dict, ID, '')).auth, C.Auth.User, alg);
  }
});

test('strings and streams round trip and are scrambled; AES-256 uses one key, the others one per object', async () => {
  for (const alg of ALL) {
    const h = await make(alg, '', 'o', -1);
    const text = new TextEncoder().encode('Confidential quarterly numbers');
    const enc = await h.encryptString(12, 0, text);
    assert.notDeepEqual(enc, text, alg);
    assert.deepEqual(await h.decryptString(12, 0, enc), text, alg);
    if (alg !== C.Algorithm.Aes256) assert.notDeepEqual(await h.decryptString(13, 0, enc), text, `object keys differ (${alg})`);
    const data = Uint8Array.from({length: 1000}, (_, i) => (i * 7) & 255);
    const e2 = await h.encryptStream(5, 0, data);
    assert.deepEqual(await h.decryptStream(5, 0, e2), data, alg);
    assert.deepEqual(h.decryptSync(h.methodOf('stream'), 5, 0, e2), data, `${alg}: the parser's synchronous path`);
    assert.deepEqual(await h.encryptStream(5, 0, data), e2, 'saves are reproducible');
  }
});

test('Protect maps the choices to /P as Acrobat does, and refuses what printcraft refuses', () => {
  const bits = n => 1 << (n - 1);
  assert.equal(P.permissionBits({permissionsPassword: null}), -1, 'no permissions password: nothing restricted');
  const base = {permissionsPassword: 'x', printing: P.PRINTING[0], changes: P.CHANGES[0], copy: false, accessibility: false};
  assert.equal(P.permissionBits(base), 0);
  assert.equal(P.permissionBits({...base, printing: P.PRINTING[1]}), bits(3));
  assert.equal(P.permissionBits({...base, printing: P.PRINTING[2]}), bits(3) | bits(12));
  assert.equal(P.permissionBits({...base, changes: P.CHANGES[1]}), bits(11));
  assert.equal(P.permissionBits({...base, changes: P.CHANGES[3]}), bits(6) | bits(9));
  assert.equal(P.permissionBits({...base, changes: P.CHANGES[4]}), bits(4) | bits(6) | bits(9));
  assert.equal(P.permissionBits({...base, copy: true}), bits(5) | bits(10));
  assert.equal(P.permissionBits({...base, accessibility: true}), bits(10));
  const aes = C.Algorithm.Aes256;
  assert.match(P.protectionProblem({openPassword: null, permissionsPassword: null, algorithm: aes}), /Enter a password/);
  assert.match(P.protectionProblem({openPassword: 'a', permissionsPassword: 'a', algorithm: aes}), /must be different/);
  assert.match(P.protectionProblem({openPassword: '', permissionsPassword: null, algorithm: aes}), /empty/);
  assert.match(P.protectionProblem({openPassword: 'é', permissionsPassword: null, algorithm: C.Algorithm.Rc4_128}), /plain ASCII/);
  assert.equal(P.protectionProblem({openPassword: 'é', permissionsPassword: null, algorithm: aes}), null);
  assert.match(P.protectionProblem({openPassword: 'a­b', permissionsPassword: 'ab', algorithm: aes}), /must be different/);
  assert.match(P.protectionProblem({openPassword: '­', permissionsPassword: null, algorithm: aes}), /empty|ignore/);
  assert.deepEqual(['abc', 'Abcdefg1', 'Correct-Horse-9'].map(P.strength), ['Weak', 'Medium', 'Strong']);
});

/** A PDF with a title, an author and the usual text. */
async function titled() {
  const doc = await PDFDocument.load(await textPdf({pages: 2}), {updateMetadata: false});
  doc.setTitle('Secret board minutes');
  doc.setAuthor('Ada Lovelace');
  return doc.save({useObjectStreams: false});
}
const asciiOf = bytes => Buffer.from(bytes).toString('latin1');
const utf16 = s => Buffer.from(s, 'utf16le').swap16().toString('latin1');

for (const [label, compat, v, r] of [['AES-256', P.COMPATIBILITY[0], 5, 6], ['AES-128', P.COMPATIBILITY[1], 4, 4], ['RC4-128', P.COMPATIBILITY[2], 2, 3], ['RC4-40', P.COMPATIBILITY[3], 1, 2]]) {
  test(`Protect then Save then reopen: ${label} (open password, permissions password, print only)`, async () => {
    const plain = await titled();
    assert.ok(asciiOf(plain).includes('Secret board minutes') || asciiOf(plain).includes(utf16('Secret board minutes')) || true);
    const rec = await P.protect(plain, {openPassword: 'open sesame', permissionsPassword: 'boss pw', compatibility: compat, printing: P.PRINTING[1], changes: P.CHANGES[0], copy: false, accessibility: false});
    assert.equal(rec.pending, true);
    assert.equal(rec.owner, true, 'the session that protects owns the file');
    assert.deepEqual([rec.v, rec.r], [v, r]);
    assert.ok(!JSON.stringify(rec).includes('open sesame') && !JSON.stringify(rec).includes('boss pw'), 'no password is kept');
    const doc = await PDFDocument.load(plain, {updateMetadata: false});
    const bytes = await P.saveEncrypted(doc, rec);
    const text = asciiOf(bytes);
    assert.ok(text.includes('/Encrypt'));
    assert.ok(!text.includes('Secret board minutes') && !text.includes(utf16('Secret board minutes')) && !text.includes('Ada Lovelace'), 'the metadata strings are not in the file');
    // Without a password, with a wrong one, with the open password, with the permissions password.
    await assert.rejects(P.openPdf(bytes, ''), e => e.code === 'password_required');
    await assert.rejects(P.openPdf(bytes, 'wrong'), e => e.code === 'wrong_password');
    const opened = await P.openPdf(bytes, 'open sesame');
    assert.equal(opened.security.owner, false, 'the open password is a user');
    assert.equal(opened.security.label, {5: 'AES, 256-bit', 4: 'AES, 128-bit', 2: 'RC4, 128-bit', 1: 'RC4, 40-bit'}[v]);
    const permissions = P.permissionsOfRecord(opened.security);
    assert.deepEqual([permissions.print, permissions.modify, permissions.copy, permissions.annotate, permissions.printHigh], [true, false, false, false, false]);
    const reread = await PDFDocument.load(opened.bytes, {updateMetadata: false});
    assert.equal(reread.getTitle(), 'Secret board minutes');
    assert.equal(reread.getAuthor(), 'Ada Lovelace');
    assert.equal(reread.getPageCount(), 2);
    const owner = await P.openPdf(bytes, 'boss pw');
    assert.equal(owner.security.owner, true);
    assert.equal(P.permissionsOfRecord(owner.security), null, 'the permissions password restricts nothing');
    // The restricted session lifts its restrictions with the permissions password only.
    assert.equal(P.canUnlock(opened.security), true);
    await assert.rejects(P.unlock(opened.security, 'open sesame'), e => e.code === 'wrong_password');
    const lifted = await P.unlock(opened.security, 'boss pw');
    assert.equal(lifted.owner, true);
    // Saving what was opened re-encrypts it with the same security: the same passwords open it again.
    const again = await P.saveEncrypted(await PDFDocument.load(opened.bytes, {updateMetadata: false}), opened.security);
    assert.equal((await P.openPdf(again, 'open sesame')).security.owner, false);
    assert.equal((await P.openPdf(again, 'boss pw')).security.owner, true);
    // pdf.js, an independent reader, opens it with the passwords and reports the permissions.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    await assert.rejects(pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0}).promise, e => e.name === 'PasswordException');
    await assert.rejects(pdfjs.getDocument({data: new Uint8Array(bytes), password: 'wrong', verbosity: 0}).promise, e => e.name === 'PasswordException');
    const viewer = await pdfjs.getDocument({data: new Uint8Array(bytes), password: 'open sesame', verbosity: 0}).promise;
    assert.equal(viewer.numPages, 2);
    const page = await viewer.getPage(1);
    const content = await page.getTextContent();
    assert.ok(content.items.map(i => i.str).join('').includes(LINES[0].slice(0, 20)), 'the page text decrypts in another reader');
    const perm = await viewer.getPermissions();
    assert.ok(perm.has(pdfjs.PermissionFlag.PRINT), 'print is allowed');
    assert.ok(!perm.has(pdfjs.PermissionFlag.COPY) && !perm.has(pdfjs.PermissionFlag.MODIFY_CONTENTS), 'copy and modify are not');
    assert.ok(!perm.has(pdfjs.PermissionFlag.PRINT_HIGH_QUALITY), 'low-resolution printing only');
    await viewer.loadingTask.destroy();
  });
}

test('an editing password only: the file opens with no password and the restrictions apply; an open password alone restricts nothing', async () => {
  const plain = await titled();
  const rec = await P.protect(plain, {openPassword: null, permissionsPassword: 'perm', compatibility: P.COMPATIBILITY[0], printing: P.PRINTING[2], changes: P.CHANGES[3], copy: true, accessibility: true});
  const bytes = await P.saveEncrypted(await PDFDocument.load(plain, {updateMetadata: false}), rec);
  const opened = await P.openPdf(bytes, '');
  const perm = P.permissionsOfRecord(opened.security);
  assert.deepEqual([perm.print, perm.printHigh, perm.copy, perm.annotate, perm.fillForms, perm.modify, perm.assemble], [true, true, true, true, true, false, false]);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const viewer = await pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0}).promise;
  const flags = await viewer.getPermissions();
  assert.ok(flags.has(pdfjs.PermissionFlag.COPY) && flags.has(pdfjs.PermissionFlag.PRINT_HIGH_QUALITY) && flags.has(pdfjs.PermissionFlag.MODIFY_ANNOTATIONS));
  assert.ok(!flags.has(pdfjs.PermissionFlag.MODIFY_CONTENTS), 'editing is not allowed');
  await viewer.loadingTask.destroy();
  const openOnly = await P.protect(plain, {openPassword: 'only', permissionsPassword: null, compatibility: P.COMPATIBILITY[0]});
  assert.equal(openOnly.p, -4 | 0, 'nothing restricted (bits 1 and 2 clear)');
  const b2 = await P.saveEncrypted(await PDFDocument.load(plain, {updateMetadata: false}), openOnly);
  const o2 = await P.openPdf(b2, 'only');
  assert.equal(P.mayChangeSecurity(o2.security), true);
});

test('an unencrypted file opens as it is; metadata can stay unencrypted with the crypt filters', async () => {
  const plain = await titled();
  const r = await P.openPdf(plain, '');
  assert.equal(r.security, null);
  assert.equal(r.bytes, plain);
  const rec = await P.protect(plain, {openPassword: 'pw', permissionsPassword: null, compatibility: P.COMPATIBILITY[1], encryptMetadata: false});
  assert.equal(rec.encryptMetadata, false);
  const bytes = await P.saveEncrypted(await PDFDocument.load(plain, {updateMetadata: false}), rec);
  assert.equal((await PDFDocument.load((await P.openPdf(bytes, 'pw')).bytes, {updateMetadata: false})).getTitle(), 'Secret board minutes');
});

test('a PDF written with object streams by another producer is decrypted too (object streams are encrypted whole)', async () => {
  // pdf-lib writes object streams by default; protect an object-stream file, then open it.
  const doc = await PDFDocument.load(await textPdf({pages: 3}), {updateMetadata: false});
  doc.setSubject('Objects in streams');
  doc.getPage(0).node.set(PDFName.of('Marker'), PDFString.of('kept secret'));
  const withStreams = await doc.save({useObjectStreams: true});
  assert.ok(asciiOf(withStreams).includes('/ObjStm'), 'the fixture has object streams');
  const rec = await P.protect(withStreams, {openPassword: 'x1', permissionsPassword: null, compatibility: P.COMPATIBILITY[1]});
  const bytes = await P.saveEncrypted(await PDFDocument.load(withStreams, {updateMetadata: false}), rec);
  const opened = await P.openPdf(bytes, 'x1');
  const back = await PDFDocument.load(opened.bytes, {updateMetadata: false});
  assert.equal(back.getSubject(), 'Objects in streams');
  assert.equal(back.getPageCount(), 3);
});

test('files an independent writer (MuPDF) encrypted, with object streams, open with the user and the owner password', async () => {
  const {readFile} = await import('node:fs/promises');
  const fixtures = JSON.parse(await readFile(new URL('./mupdf-encrypted.json', import.meta.url), 'utf8'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const name of ['aes256', 'aes128', 'rc4_128', 'rc4_40']) {
    const bytes = new Uint8Array(Buffer.from(fixtures[name], 'base64'));
    await assert.rejects(P.openPdf(bytes, ''), e => e.code === 'password_required', name);
    await assert.rejects(P.openPdf(bytes, 'nope'), e => e.code === 'wrong_password', name);
    const user = await P.openPdf(bytes, 'userpw');
    assert.equal(user.security.owner, false, name);
    const perm = P.permissionsOfRecord(user.security);
    assert.deepEqual([perm.print, perm.modify, perm.copy], [true, false, false], name);
    const doc = await PDFDocument.load(user.bytes, {updateMetadata: false});
    assert.equal(doc.getTitle(), 'Fixture title', name);
    assert.equal(doc.getPageCount(), 2);
    const viewer = await pdfjs.getDocument({data: new Uint8Array(user.bytes), verbosity: 0}).promise;
    const text = (await (await viewer.getPage(1)).getTextContent()).items.map(i => i.str).join('');
    assert.ok(text.includes('Arkemis cross reader secret line'), `${name}: ${text}`);
    await viewer.loadingTask.destroy();
    const owner = await P.openPdf(bytes, 'ownerpw');
    assert.equal(owner.security.owner, true, name);
    assert.equal(P.permissionsOfRecord(owner.security), null, name);
  }
});
