// core/folio/commands/combine_more.mjs, lib/combine.mjs options and electron/folder-files.cjs: Combine files sorting, dragging, columns, options and Add folder.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/ui-egui/src/workflows/combine_ui: a click on a column sorts the list (a second click reverses it; names in natural order, unknown times last,
//    ties by name, Warnings puts what can't be combined first), sorting is one undo step, a file dragged to a place takes the selection along and a hand-made order is not sorted any
//    more, Reset columns puts the columns back, Add folder adds the PDFs of a folder in natural order (and of its subfolders when asked). Acrobat's Combine Files works the same way.
//    The Combine options (bookmarks, a blank page after an odd file, the file size) are Acrobat's: not checked against upstream.
// 2. Ours does the same on real PDFs; the folder reading runs against a real temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/folio/schema.mjs';
import {natural, sorted, movedToGap, COLUMNS} from '../../core/folio/commands/combine_more.mjs';
import combineOptions from '../../core/folio/dialogs/combine-options.mjs';

const require = createRequire(import.meta.url);
const folderFiles = require('../../electron/folder-files.cjs');
const b64 = bytes => Buffer.from(bytes).toString('base64');
async function numbered(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  return doc.save();
}
const empty = () => createTestSession('folio', {content: createContent()});
const names = async t => (await t.exec('combine.read', {})).result.files.map(f => f.name);
async function withFiles(spec) {
  const t = await empty();
  await t.exec('page.combine', {files: await Promise.all(spec.map(async ([name, pages, modified]) => ({name, base64: b64(await numbered(pages)), ...(modified ? {modified} : {})})))});
  return t;
}

test('natural order: case-insensitive, numbers by value', () => {
  assert.deepEqual(['scan10.pdf', 'Scan2.pdf', 'scan1.pdf', 'b.pdf', 'A.pdf'].sort(natural), ['A.pdf', 'b.pdf', 'scan1.pdf', 'Scan2.pdf', 'scan10.pdf']);
  assert.equal(natural('a007', 'a7'), 0);
  assert.equal(natural('a', 'ab'), -1);
});

test('sorted: by pages and size, unknown times last either way, the problem files first by warnings, ties by name', () => {
  const f = (id, name, pages, size, modified, problem) => ({id, name, pages, size, modified, problem});
  const list = [f(1, 'c.pdf', 3, 10, 300), f(2, 'a.pdf', 3, 30, null), f(3, 'b.pdf', 1, 20, 100, 'password')];
  assert.deepEqual(sorted(list, 'pages', true).map(x => x.id), [3, 2, 1]);
  assert.deepEqual(sorted(list, 'pages', false).map(x => x.id), [2, 1, 3]);
  assert.deepEqual(sorted(list, 'size', true).map(x => x.id), [1, 3, 2]);
  assert.deepEqual(sorted(list, 'modified', true).map(x => x.id), [3, 1, 2]);
  assert.deepEqual(sorted(list, 'modified', false).map(x => x.id), [1, 3, 2], 'unknown times stay last');
  assert.deepEqual(sorted(list, 'warnings', true).map(x => x.id), [3, 2, 1]);
});

test('movedToGap keeps the moving files together and in order', () => {
  const l = [1, 2, 3, 4, 5].map(id => ({id}));
  const ids = x => x.map(f => f.id);
  assert.deepEqual(ids(movedToGap(l, [2, 4], 0)), [2, 4, 1, 3, 5]);
  assert.deepEqual(ids(movedToGap(l, [2, 4], 5)), [1, 3, 5, 2, 4]);
  assert.deepEqual(ids(movedToGap(l, [1], 3)), [2, 3, 1, 4, 5]);
  assert.deepEqual(ids(movedToGap(l, [5], 1)), [1, 5, 2, 3, 4]);
});

test('combine.sort: names in natural order, a second click reverses it, it is one undo step, moving by hand ends it', async () => {
  const t = await withFiles([['scan10.pdf', 1], ['scan2.pdf', 3], ['scan1.pdf', 2]]);
  const r = (await t.exec('combine.sort', {key: 'name'})).result;
  assert.deepEqual(r.sort, {key: 'name', ascending: true});
  assert.deepEqual(await names(t), ['scan1.pdf', 'scan2.pdf', 'scan10.pdf']);
  assert.deepEqual((await t.exec('combine.sort', {key: 'name'})).result.sort, {key: 'name', ascending: false});
  assert.deepEqual(await names(t), ['scan10.pdf', 'scan2.pdf', 'scan1.pdf']);
  await t.exec('combine.sort', {key: 'pages'});
  assert.deepEqual(await names(t), ['scan10.pdf', 'scan1.pdf', 'scan2.pdf']);
  await t.exec('combine.undo', {});
  assert.deepEqual(await names(t), ['scan10.pdf', 'scan2.pdf', 'scan1.pdf']);
  await t.exec('combine.select', {ids: [(await t.exec('combine.read', {})).result.files[0].id]});
  await t.exec('combine.move', {by: 1});
  assert.equal(t.session.get(t.docId).view.combine.sort, null, 'a hand-made order is not sorted');
});

test('combine.drop: a row dropped on another goes below it dragged down and above it dragged up; the selection goes along; on itself nothing happens', async () => {
  const t = await withFiles([['a.pdf', 1], ['b.pdf', 1], ['c.pdf', 1], ['d.pdf', 1]]);
  const ids = (await t.exec('combine.read', {})).result.files.map(f => f.id);
  await t.exec('combine.select', {ids: [ids[0]]});
  await t.exec('combine.drop', {file: ids[0], onto: ids[2]});
  assert.deepEqual(await names(t), ['b.pdf', 'c.pdf', 'a.pdf', 'd.pdf']);
  await t.exec('combine.select', {ids: [ids[3]]});
  await t.exec('combine.drop', {file: ids[3], onto: ids[1]});
  assert.equal((await names(t))[0], 'd.pdf', 'dragged up: above the row it fell on');
  await t.exec('combine.select', {ids: [ids[1], ids[2]]});
  assert.equal((await t.exec('combine.drop', {file: ids[1], onto: ids[2]})).result.moved, false);
  await t.exec('combine.drop', {file: ids[1], gap: 4});
  assert.deepEqual((await names(t)).slice(-2), ['b.pdf', 'c.pdf']);
  await t.exec('combine.undo', {});
  assert.notDeepEqual((await names(t)).slice(-2), ['b.pdf', 'c.pdf']);
  await assert.rejects(() => t.exec('combine.drop', {file: ids[0]}), /onto/);
});

test('combine.columns: a new order, Reset columns, and an order that leaves one out is refused', async () => {
  const t = await withFiles([['a.pdf', 1], ['b.pdf', 1]]);
  const order = ['size', 'name', 'pages', 'take', 'modified', 'warnings'];
  assert.deepEqual((await t.exec('combine.columns', {order})).result.columns, order);
  await assert.rejects(() => t.exec('combine.columns', {order: ['name', 'name', 'pages', 'take', 'size', 'modified']}), /every column once/);
  assert.deepEqual((await t.exec('combine.columns', {reset: true})).result.columns, COLUMNS);
});

test('Combine options: bookmarks off writes none, a blank page follows a file with an odd number of pages, the dialog keeps them', async () => {
  const t = await withFiles([['one.pdf', 3], ['two.pdf', 2]]);
  assert.deepEqual((await t.exec('combine.options', {bookmarks: false, blankAfterOdd: true})).result.options, {bookmarks: false, blankAfterOdd: true, size: 'default'});
  const r = (await t.exec('combine.go', {})).result;
  const doc = await PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));
  assert.equal(doc.getPageCount(), 3 + 1 + 2, 'a blank page after the 3-page file only');
  assert.equal(doc.catalog.has(PDFName.of('Outlines')), false);
  assert.equal(r.pages, 6);
  const t2 = await withFiles([['one.pdf', 1]]);
  await t2.exec('combine.go', {});
  assert.equal((await PDFDocument.load(Buffer.from(t2.content.sourceBase64, 'base64'))).catalog.has(PDFName.of('Outlines')), true, 'bookmarks are on by default');
  const v = combineOptions.init({view: {combine: {options: {size: 'smaller', bookmarks: false}}}});
  assert.deepEqual(v, {bookmarks: false, blankAfterOdd: false, size: 'smaller'});
  assert.deepEqual(combineOptions.toCommand(v).params, {bookmarks: false, blankAfterOdd: false, size: 'smaller'});
});

test('Add folder: a program passes the files; they join the list in natural order as one undo step, with their times', async () => {
  const t = await empty();
  await t.exec('page.combine', {});
  const files = [['doc10.pdf', 2, 1000], ['doc2.pdf', 1, 2000], ['sub/doc1.pdf', 1, null]];
  const r = (await t.exec('combine.add_folder', {recursive: true, files: await Promise.all(files.map(async ([name, n, modified]) => ({name, base64: b64(await numbered(n)), ...(modified ? {modified} : {})})))})).result;
  assert.equal(r.added.length, 3);
  assert.deepEqual(await names(t), ['doc2.pdf', 'doc10.pdf', 'doc1.pdf'], 'by path in natural order: the subfolder after the files above it');
  assert.equal((await t.exec('combine.read', {})).result.files.find(f => f.name === 'doc2.pdf').modified, 2000);
  await t.exec('combine.undo', {});
  assert.deepEqual(await names(t), []);
  await assert.rejects(() => t.exec('combine.add_folder', {}), /give the PDFs as `files`/);
  assert.match((await t.exec('combine.add_folder', {files: []})).result.message, /No PDFs found/);
});

test('electron listPdfs reads the PDFs of a chosen folder in natural order, subfolders only when asked, never hidden folders, and refuses a folder that was not chosen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arkemis-folder-'));
  try {
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.mkdir(path.join(dir, '.hidden'));
    const pdf = Buffer.from(await numbered(1));
    for (const f of ['b10.pdf', 'b2.PDF', 'notes.txt', 'sub/c.pdf', '.hidden/h.pdf']) await fs.writeFile(path.join(dir, f), f.endsWith('pdf') || f.endsWith('PDF') ? pdf : 'x');
    const writer = folderFiles.createFolderWriter(new Set());
    const flat = await folderFiles.listPdfs(writer.chosen, dir, false).catch(e => e);
    assert.equal(flat.code, 'forbidden', 'a folder the dialog did not return cannot be read');
    writer.allow(dir);
    const top = await folderFiles.listPdfs(writer.chosen, dir, false);
    assert.deepEqual(top.files.map(f => f.name), ['b2.PDF', 'b10.pdf']);
    assert.equal(top.more, false);
    assert.ok(top.files.every(f => f.size === pdf.length && Number.isFinite(f.modified) && Buffer.from(f.base64, 'base64').equals(pdf)));
    const deep = await folderFiles.listPdfs(writer.chosen, dir, true);
    assert.deepEqual(deep.files.map(f => f.name), ['b2.PDF', 'b10.pdf', 'sub/c.pdf']);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
