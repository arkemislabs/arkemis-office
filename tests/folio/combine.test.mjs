// core/folio/commands/combine.mjs and lib/combine.mjs: Combine files.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/workflows/combine_ui*, crates/engine/src/sources.rs and
//    session/files.rs): the list holds the files to combine in order, each with the pages to take ("1-3, 6" or
//    all); files can be added, selected, moved (a block together), removed, and every change to the list can be
//    undone; a file that needs a password, has the wrong one, forbids assembling pages or can't be read stays
//    flagged and stops Combine unless it is left out ("Combine the rest"); Combine writes one PDF with one
//    bookmark per file and fields with colliding names renamed. Acrobat's Combine Files does the same.
//    Not checked against upstream: the grid view, sorting by column and duplicate warnings are not translated.
// 2. Ours does the same end to end on real PDFs: the combined bytes are read back with pdf-lib and pdf.js.
// 3. Tests below, tests/e2e/folio/combine.e2e.mjs (the window).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, StandardFonts} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/folio/schema.mjs';
import {textPdf} from '../../core/folio/fixtures.mjs';
import {saveEncrypted, protect} from '../../core/folio/lib/protect.mjs';
import {bytesOf} from '../../core/folio/lib/page-source.mjs';

const b64 = bytes => Buffer.from(bytes).toString('base64');
async function numbered(label, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([300, 300]).drawText(`${label} page ${i}`, {x: 20, y: 150, size: 18, font});
  return doc.save();
}
const empty = () => createTestSession('folio', {content: createContent()});
const list = async t => (await t.exec('combine.read', {})).result;
const textOf = async (bytes, n) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const d = await task.promise;
  const out = [];
  for (let i = 1; i <= (n ?? d.numPages); i++) out.push((await (await d.getPage(i)).getTextContent()).items.map(x => x.str).join(''));
  await task.destroy();
  return out;
};

test('Add files, take the pages of a range, move and remove with undo, combine into an empty document with one bookmark per file', async () => {
  const t = await empty();
  const [a, b, c] = [await numbered('Alpha', 3), await numbered('Beta', 2), await numbered('Gamma', 4)];
  await t.exec('page.combine', {});
  assert.equal((await list(t)).open, true);
  const r = await t.exec('combine.add', {files: [{base64: b64(a), name: 'alpha.pdf'}, {base64: b64(b), name: 'beta.pdf'}, {base64: b64(c), name: 'gamma.pdf', range: '4, 1-2'}]});
  assert.equal(r.result.added.length, 3);
  let l = await list(t);
  assert.deepEqual(l.files.map(f => [f.name, f.pages, f.range]), [['alpha.pdf', 3, ''], ['beta.pdf', 2, ''], ['gamma.pdf', 4, '4, 1-2']]);
  assert.deepEqual(l.selected, r.result.added, 'the added files are selected');
  const [ida, idb, idc] = l.files.map(f => f.id);
  await assert.rejects(t.exec('combine.range', {id: idb, range: '1-9'}), /does not exist/);
  await t.exec('combine.range', {id: idb, range: '2'});
  // Select gamma alone and move it up: it steps past beta.
  await t.exec('combine.select', {ids: [idc]});
  await t.exec('combine.move', {by: -1});
  assert.deepEqual((await list(t)).files.map(f => f.id), [ida, idc, idb]);
  assert.equal((await t.session.state(t.docId, 'combine.move', {by: -1})).enabled, true);
  await t.exec('combine.move', {by: -1});
  assert.equal((await t.session.state(t.docId, 'combine.move', {by: -1})).enabled, false, 'already first');
  // Remove alpha, then undo brings it back, redo removes it again.
  await t.exec('combine.select', {ids: [ida]});
  await t.exec('combine.remove', {});
  assert.deepEqual((await list(t)).files.map(f => f.name), ['gamma.pdf', 'beta.pdf']);
  await t.exec('combine.undo', {});
  assert.deepEqual((await list(t)).files.map(f => f.name), ['gamma.pdf', 'alpha.pdf', 'beta.pdf']);
  await t.exec('combine.redo', {});
  await t.exec('combine.undo', {});
  assert.equal((await t.session.state(t.docId, 'combine.undo', {})).enabled, true);
  // Combine: gamma pages 4,1,2 + alpha (3) + beta page 2 = 7 pages, in that order, one bookmark per file.
  const go = await t.exec('combine.go', {});
  assert.equal(go.result.opened, true);
  assert.equal(go.result.pages, 7);
  assert.equal(t.content.pages.length, 7);
  const texts = await textOf(bytesOf(t.content.sourceBase64));
  assert.deepEqual(texts, ['Gamma page 4', 'Gamma page 1', 'Gamma page 2', 'Alpha page 1', 'Alpha page 2', 'Alpha page 3', 'Beta page 2']);
  const out = await PDFDocument.load(bytesOf(t.content.sourceBase64));
  const outline = out.catalog.lookup(PDFName.of('Outlines'));
  assert.equal(outline.get(PDFName.of('Count')).asNumber(), 3, 'one bookmark per file');
  assert.equal((await list(t)).files.length, 0, 'the list is cleared once combined');
});

test('a document that is open gets the combined file written, not replaced: the bytes come back to a program', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await t.exec('combine.add', {files: [{base64: b64(await numbered('One', 1)), name: 'one.pdf'}, {base64: b64(await numbered('Two', 2)), name: 'two.pdf'}]});
  const go = await t.exec('combine.go', {});
  assert.equal(go.result.opened, undefined);
  assert.equal(t.content.pages.length, 2, 'the open document is untouched');
  const bytes = Buffer.from(go.result.base64, 'base64');
  assert.deepEqual(await textOf(bytes), ['One page 1', 'Two page 1', 'Two page 2']);
});

test('a locked file stays flagged and stops Combine; Unlock with its password fixes it; "Combine the rest" leaves it out; a wrong password changes nothing', async () => {
  const t = await empty();
  const plain = await numbered('Open', 2);
  const doc = await PDFDocument.load(await numbered('Secret', 2), {updateMetadata: false});
  const rec = await protect(await doc.save(), {openPassword: 'pw1', permissionsPassword: 'pw2', printing: 'None', changes: 'None'});
  const locked = await saveEncrypted(doc, rec);
  await t.exec('combine.add', {files: [{base64: b64(plain), name: 'open.pdf'}, {base64: b64(locked), name: 'secret.pdf'}, {base64: b64(new TextEncoder().encode('not a pdf')), name: 'broken.pdf'}]});
  const l = await list(t);
  assert.deepEqual(l.files.map(f => f.problem), [null, 'password', 'not-pdf']);
  assert.match(l.files[1].warning, /needs a password/);
  await assert.rejects(t.exec('combine.go', {}), /needs a password/);
  await assert.rejects(t.exec('combine.unlock', {id: l.files[1].id, password: 'nope'}), /incorrect/);
  assert.equal((await list(t)).files[1].problem, 'password');
  const u = await t.exec('combine.unlock', {id: l.files[1].id, password: 'pw1'});
  assert.equal(u.result.unlocked, false, 'the open password is a user: its permissions forbid assembling pages');
  assert.equal((await list(t)).files[1].problem, 'not-permitted');
  const owner = await t.exec('combine.unlock', {id: l.files[1].id, password: 'pw2'});
  assert.equal(owner.result.unlocked, true, 'the permissions password lifts it');
  assert.equal((await list(t)).files[1].pages, 2);
  await assert.rejects(t.exec('combine.go', {}), /not a PDF/);
  const go = await t.exec('combine.go', {skipUnreadable: true});
  assert.equal(go.result.pages, 4);
  assert.deepEqual(go.result.skipped, ['broken.pdf']);
  assert.deepEqual(await textOf(bytesOf(t.content.sourceBase64)), ['Open page 1', 'Open page 2', 'Secret page 1', 'Secret page 2']);
  assert.ok(!JSON.stringify(t.doc.view).includes('pw1') && !JSON.stringify(t.doc.view).includes('pw2'), 'no password in the view');
});

test('fields with colliding names are renamed, never merged', async () => {
  const t = await empty();
  const withField = async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField('name').addToPage(page, {x: 20, y: 200, width: 100, height: 20});
    return doc.save();
  };
  await t.exec('combine.add', {files: [{base64: b64(await withField()), name: 'a.pdf'}, {base64: b64(await withField()), name: 'b.pdf'}]});
  const go = await t.exec('combine.go', {});
  assert.deepEqual(go.result.renamedFields, [['name', 'name-1']]);
  assert.deepEqual(t.content.fields.map(f => f.name).sort(), ['name', 'name-1']);
});

test('Combine needs files; Add files needs paths or bytes from a program; selection works like files in a file manager', async () => {
  const t = await empty();
  assert.equal((await t.session.state(t.docId, 'combine.go', {})).enabled, false);
  await assert.rejects(t.exec('combine.add', {}), /files is required/);
  const f = i => ({base64: b64(new Uint8Array(0)), name: `x${i}.pdf`});
  void f;
  const [one, two, three] = await Promise.all([numbered('A', 1), numbered('B', 1), numbered('C', 1)]);
  await t.exec('combine.add', {files: [one, two, three].map((x, i) => ({base64: b64(x), name: `f${i}.pdf`}))});
  const ids = (await list(t)).files.map(x => x.id);
  await t.exec('combine.select', {ids: [ids[0]]});
  await t.exec('combine.select', {ids: [ids[2]], mode: 'range'});
  assert.deepEqual((await list(t)).selected, ids);
  await t.exec('combine.select', {ids: [ids[1]], mode: 'toggle'});
  assert.deepEqual((await list(t)).selected, [ids[0], ids[2]]);
  await t.exec('combine.select', {mode: 'all'});
  assert.deepEqual((await list(t)).selected, ids);
  await t.exec('page.combine', {});
  await t.exec('combine.close', {});
  assert.equal((await list(t)).open, false);
  assert.equal((await list(t)).files.length, 3, 'the list is kept');
  void textPdf;
});
