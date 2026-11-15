// Bridge contract for real files (docs/architecture.md 17.4; docs/behaviour-fidelity.md "File > Save"):
// the test transport + rpc router + headless host + the file service (electron/store.cjs
// createFiles) + the real format worker (electron/format-worker.cjs in a worker thread). No
// Electron, no dialogs: programmatic calls pass paths.
//
// 1. ArtCraft: gridcraft/deckcraft crates/engine/src/cmd/file.rs file.save {path, format} writes
//    the file (missing path -> error, programmatic calls never open dialogs); Office: a document is
//    its file on disk, Recent lists real paths, an open file opened again comes forward.
// 2. Ours: documents.create gives Document1/Book1/Presentation1 with no path; file.save without a
//    path names the missing path; with a path it asks approval (a new file on disk), writes through
//    the worker, binds the document to the file and adds it to Recent; documents.open {path} reads
//    the file back into the same content; Save As CSV rebinds; Save a Copy does not; closing with
//    changes the file lacks saves them or (save:false) needs approval.
// 3. These tests, plus tests/kernel/file-lifecycle.test.mjs and tests/e2e/common/file-*.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {createHeadlessHost} from '../../electron/headless-host.mjs';

const require = createRequire(import.meta.url);
const {startTestRpcServer} = require('../../electron/test-rpc-server.cjs');
const {createStore, createFiles} = require('../../electron/store.cjs');
const {createRpcRouter} = require('../../electron/rpc-router.cjs');
const JSZip = require('jszip');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The format worker exactly as main.cjs runs it (one thread per operation). */
function worker(data) {
  return new Promise((resolve, reject) => {
    const thread = new Worker(path.join(root, 'electron/format-worker.cjs'), {workerData: data});
    thread.once('message', m => { thread.terminate(); m.ok ? resolve(m.result) : reject(new Error(m.error)); });
    thread.once('error', reject);
  });
}

const now = '2026-10-30T09:00:00.000Z';
const fileOf = (kind, title, content) => ({id: randomUUID(), schema: 1, kind, title, createdAt: now, updatedAt: now, revision: 0, starred: false, content, links: []});
const SEEDS = {
  quill: () => fileOf('quill', 'Letter', {doc: {type: 'doc', content: [
    {type: 'paragraph', content: [{type: 'text', text: 'Dear reader, this came back from disk.'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Second paragraph', marks: [{type: 'bold'}]}]}]}}),
  grid: () => fileOf('grid', 'Budget', {sheets: [
    {id: 's1', name: 'Sheet 1', rows: 200, columns: 26, cells: {A1: {value: 'Item'}, B1: {value: 'Cost'}, A2: {value: 'Paper'}, B2: {value: '12.5', valueType: 'number'}}},
    {id: 's2', name: 'Totals', rows: 200, columns: 26, cells: {A1: {value: 'Sum'}}}], activeSheetId: 's1'}),
  prism: () => fileOf('prism', 'Pitch', {slides: [{id: 'p1', background: '#ffffff', notes: '', elements: [
    {id: 'e1', type: 'text', x: 80, y: 100, w: 800, h: 120, text: 'Quarterly pitch', fontSize: 44, color: '#202331'}]}], activeSlideId: 'p1'}),
};

async function setup(product) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `arkemis-files-${product}-`));
  const vault = path.join(dir, 'vault');
  const store = await createStore(path.join(vault, 'documents'));
  const files = await createFiles({store, root: vault, product, worker});
  const headless = await createHeadlessHost({store, product, appVersion: '0.1.0-test', worker, files});
  const router = createRpcRouter({headless, timeoutMs: 5000});
  const bridge = await startTestRpcServer({router});
  let seq = 0;
  const call = async (method, params = {}) => {
    const r = await fetch(`http://127.0.0.1:${bridge.port}/v2/rpc`, {method: 'POST',
      headers: {Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({id: ++seq, method, params})});
    const body = await r.json();
    if (!body.ok) throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  /** engine.execute, answering an approval request once (as the person would). */
  const approve = async (doc, command, params = {}) => {
    try { return await call('engine.execute', {doc, command, params}); } catch (e) {
      if (e.code !== 'approval_required') throw e;
      return {...await call('engine.execute', {doc, command, params, approval: {nonce: e.data.nonce}}), asked: e.data};
    }
  };
  const t = {dir, store, files, headless, call, approve, out: path.join(dir, 'My Documents'),
    async close() { router.close(); await bridge.stop(); await files.shutdown(); await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }};
  await fs.mkdir(t.out);
  return t;
}

const texts = node => (node?.text ? [node.text] : []).concat(...(node?.content ?? []).map(texts));
/** Paragraph text of a Quill document in either schema: 1 (`doc`) or 2 (`body.chunks`, what Quill reads a file into since it switched to the new shell). */
const docTexts = content => (content?.body?.chunks ? content.body.chunks.flat().filter(b => b.kind === 'para').map(p => p.text).filter(Boolean) : texts(content?.doc));

test('new documents are untitled with Office names and no file; file.save without a path names it', async () => {
  for (const [product, first, second] of [['quill', 'Document1', 'Document2'], ['grid', 'Book1', 'Book2'], ['prism', 'Presentation1', 'Presentation2']]) {
    const t = await setup(product);
    try {
      const a = await t.call('documents.create', {});
      const b = await t.call('documents.create', {});
      assert.deepEqual([a.name, b.name, a.path], [first, second, null], product);
      const list = await t.call('documents.list', {});
      assert.deepEqual(list.documents.map(d => [d.name, d.path, d.untitled]).sort(), [[first, null, true], [second, null, true]]);
      await assert.rejects(t.call('engine.execute', {doc: a.doc, command: 'file.save', params: {}}),
        e => e.code === 'invalid_params' && e.message.includes(`"${first}" has not been saved yet`) && e.data.path === '/path');
    } finally { await t.close(); }
  }
  const pdf = await setup('folio');
  try {
    await assert.rejects(pdf.call('documents.create', {}), e => e.code === 'disabled' && /Create a PDF/i.test(e.message));
  } finally { await pdf.close(); }
});

test('Quill: save to a .docx asks approval, writes the text, binds; reopen from the path gives the same document', async () => {
  const t = await setup('quill');
  try {
    const seed = SEEDS.quill();
    await t.store.save(seed);
    const opened = await t.call('documents.open', {doc: seed.id});
    assert.equal(opened.path, null, 'a vault document has no file until it is saved');
    const target = path.join(t.out, 'Letter.docx');
    const r = await t.approve(seed.id, 'file.save', {path: target});
    assert.equal(r.asked.risk, 'irreversible');
    assert.equal(r.result.path, target);
    const zip = await JSZip.loadAsync(await fs.readFile(target));
    const xml = await zip.file('word/document.xml').async('string');
    assert.match(xml, /Dear reader, this came back from disk\./);
    let list = await t.call('documents.list', {});
    assert.equal(list.documents.find(d => d.id === seed.id).path, target);
    assert.equal(list.recent[0].path, target);
    assert.equal(list.recent[0].missing, false);
    // Saving again to its own file is an ordinary edit (no approval) and needs no path.
    await t.call('engine.execute', {doc: seed.id, command: 'file.save', params: {}});
    const closed = await t.call('documents.close', {doc: seed.id});
    assert.equal(closed.closed, true);
    // Reopen from disk: a new working copy bound to the same path, same text.
    const back = await t.call('documents.open', {path: target});
    assert.equal(back.path, target);
    assert.equal(back.name, 'Letter');
    assert.equal(back.alreadyOpen, false);
    const file = await t.store.get(back.doc);
    assert.deepEqual(docTexts(file.content), ['Dear reader, this came back from disk.', 'Second paragraph']);
    const again = await t.call('documents.open', {path: target.toUpperCase()});
    assert.equal(again.doc, back.doc, 'an open file comes forward instead of opening twice');
    assert.equal(again.alreadyOpen, true);
    // Recent marks a file that is gone.
    await t.call('documents.close', {doc: back.doc});
    await fs.rm(target);
    list = await t.call('documents.list', {});
    assert.equal(list.recent.find(x => x.path === target).missing, true);
    await assert.rejects(t.call('documents.open', {path: target}), e => e.code === 'not_found' && /couldn't find/.test(e.message));
  } finally { await t.close(); }
});

test('Grid: .xlsx round trip keeps cells and sheets; Save As CSV writes the active sheet and binds; Save a Copy does not', async () => {
  const t = await setup('grid');
  try {
    const seed = SEEDS.grid();
    await t.store.save(seed);
    await t.call('documents.open', {doc: seed.id});
    const xlsx = path.join(t.out, 'Budget.xlsx');
    await t.approve(seed.id, 'file.save', {path: xlsx});
    const csv = path.join(t.out, 'Budget.csv');
    const asCsv = await t.approve(seed.id, 'file.saveAs', {path: csv});
    assert.equal(asCsv.result.bound, true);
    assert.equal(t.files.binding(seed.id).path, csv);
    assert.equal(t.files.binding(seed.id).format, 'csv');
    assert.match(await fs.readFile(csv, 'utf8'), /^Item,Cost\r?\nPaper,12\.5/);
    const copy = path.join(t.out, 'Budget copy.xlsx');
    const c = await t.approve(seed.id, 'file.saveCopy', {path: copy});
    assert.equal(c.result.copy, true);
    assert.equal(t.files.binding(seed.id).path, csv, 'Save a Copy leaves the workbook on its file');
    await fs.access(copy);
    await t.call('documents.close', {doc: seed.id});
    const back = await t.call('documents.open', {path: xlsx});
    const file = await t.store.get(back.doc);
    // Grid reads a workbook into schema 2 (switched on): sheets by id, cells read back over the bridge.
    const sheets = (await t.call('document.inspect', {doc: back.doc})).nodes.filter(n => n.address.startsWith('/sh:'));
    assert.deepEqual(sheets.map(s => s.name ?? s.label ?? s.title), ['Sheet 1', 'Totals']);
    const cell = async a => (await t.call('document.read', {doc: back.doc, address: `${sheets[0].address}/${a}`, as: 'values'})).value;
    assert.equal(await cell('A1'), 'Item');
    assert.equal(String(await cell('B2')), '12.5');
    void file;
    // AutoSave over the bridge: on for a file saved in this session.
    await assert.rejects(t.call('engine.execute', {doc: back.doc, command: 'file.autosave', params: {value: true}}),
      e => e.code === 'failed' && e.data.block === 'notSavedHere');
    await t.call('engine.execute', {doc: back.doc, command: 'file.save', params: {}});
    await t.call('engine.execute', {doc: back.doc, command: 'file.autosave', params: {value: true}});
    assert.equal(t.files.binding(back.doc).autosave, true);
  } finally { await t.close(); }
});

test('Prism: .pptx round trip keeps the slide text', async () => {
  const t = await setup('prism');
  try {
    const seed = SEEDS.prism();
    await t.store.save(seed);
    await t.call('documents.open', {doc: seed.id});
    const pptx = path.join(t.out, 'Pitch.pptx');
    await t.approve(seed.id, 'file.save', {path: pptx});
    const zip = await JSZip.loadAsync(await fs.readFile(pptx));
    assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /Quarterly pitch/);
    await t.call('documents.close', {doc: seed.id});
    const back = await t.call('documents.open', {path: pptx});
    const file = await t.store.get(back.doc);
    // Prism reads a deck into schema 2 (switched on): shapes with text bodies of paragraphs and runs.
    const bodyText = b => (b?.paragraphs ?? []).map(p => (p.runs ?? []).map(r => r.text ?? '').join('')).join('\n');
    assert.ok(file.content.slides[0].shapes.some(sh => /Quarterly pitch/.test(bodyText(sh.text))));
  } finally { await t.close(); }
});

test('PDF: open a .pdf from disk, save it back in place, Save As another file; documents.close with changes', async () => {
  const t = await setup('folio');
  try {
    const {PDFDocument} = require('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]); pdf.addPage([612, 792]);
    const source = path.join(t.out, 'Contract.pdf');
    await fs.writeFile(source, await pdf.save());
    const opened = await t.call('documents.open', {path: source});
    assert.equal(opened.kind, 'folio');
    assert.equal(opened.name, 'Contract');
    // Its own file, its own format: Save is an edit (no approval, no path).
    await t.call('engine.execute', {doc: opened.doc, command: 'file.save', params: {}});
    const other = path.join(t.out, 'Contract signed.pdf');
    await t.approve(opened.doc, 'file.saveAs', {path: other});
    const bytes = await fs.readFile(other);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
    assert.equal(t.files.binding(opened.doc).path, other);
    // A change the file does not have: close saves it by default; save:false needs approval.
    await t.call('engine.execute', {doc: opened.doc, command: 'file.properties', params: {subject: 'changed'}});
    assert.equal(await t.files.modified(opened.doc), true);
    await assert.rejects(t.call('documents.close', {doc: opened.doc, save: false}), e => e.code === 'approval_required' && /discard its unsaved changes/.test(e.message));
    const closed = await t.call('documents.close', {doc: opened.doc});
    assert.deepEqual([closed.closed, closed.saved], [true, true]);
  } finally { await t.close(); }
});

test('the vault is recovery only: an old library document shows under Recover Unsaved Documents until saved', async () => {
  const t = await setup('quill');
  try {
    const old = SEEDS.quill();
    await t.store.save(old);
    const unsaved = await t.files.unsaved('quill');
    assert.deepEqual(unsaved.map(d => [d.doc, d.reason]), [[old.id, 'library']]);
    await t.call('documents.open', {doc: old.id});
    await t.approve(old.id, 'file.save', {path: path.join(t.out, 'Kept.docx')});
    await t.call('documents.close', {doc: old.id});
    assert.deepEqual(await t.files.unsaved('quill'), []);
    // A new document closed without saving (approved discard) stays recoverable, as Word keeps it.
    const made = await t.call('documents.create', {});
    await t.call('documents.open', {doc: made.doc});
    await t.call('engine.execute', {doc: made.doc, command: 'file.properties', params: {subject: 'draft'}});
    let nonce;
    try { await t.call('documents.close', {doc: made.doc, save: false}); } catch (e) { nonce = e.data.nonce; }
    await t.call('documents.close', {doc: made.doc, save: false, approval: {nonce}});
    assert.deepEqual((await t.files.unsaved('quill')).map(d => [d.name, d.reason]), [['Document1', 'closed']]);
  } finally { await t.close(); }
});
