// U:prism/export: File > Export as PDF (file.exportPdf): slides, notes pages and handouts, handouts honouring Slides Per Page.
//
// 1. deckcraft: crates/engine/src/cmd/file.rs (`pdf_options`) and crates/pdf (handout_boxes). PowerPoint: Export > Create Handouts.
// 2. Ours: core/prism/commands/export.mjs, formats/pdf-write.mjs (layout), commands/master.mjs (handout.perPage).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import exportCmds from '../../core/prism/commands/export.mjs';
import master from '../../core/prism/commands/master.mjs';
import fileCommands from '../../core/common/commands/file.mjs';
import {withNew} from './upstream/text_deck.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A deck of `n` slides whose host draws every slide as a 1x1 PNG. */
async function deck(n = 5) {
  const t = await withNew({extra: [exportCmds, master, fileCommands]});
  for (let i = 1; i < n; i++) await t.exec('slide.new', {layout: 'titleOnly', title: `Slide ${i + 1}`});
  t.host.renderSlides = async (doc, indexes) => indexes.map(() => `data:image/png;base64,${PNG.toString('base64')}`);
  return t;
}
const pages = async out => (await PDFDocument.load(Buffer.from((out.result ?? out).data, 'base64'))).getPageCount();

test('slides: one page per slide; hidden slides stay out unless asked for', async () => {
  const t = await deck(5);
  assert.equal(await pages(await t.exec('file.exportPdf', {})), 5);
  assert.equal(await pages(await t.exec('file.exportPdf', {slides: [0, 2]})), 2);
  await t.exec('slide.hide', {index: 1});
  assert.equal(await pages(await t.exec('file.exportPdf', {})), 4);
  assert.equal(await pages(await t.exec('file.exportPdf', {includeHidden: true})), 5);
});

test('handouts: the slides per page decide the page count (1, 2, 3, 4, 6, 9)', async () => {
  const t = await deck(9);
  const expected = {1: 9, 2: 5, 3: 3, 4: 3, 6: 2, 9: 1};
  for (const [per, n] of Object.entries(expected)) {
    const out = await t.exec('file.exportPdf', {layout: 'handouts', perPage: Number(per)});
    assert.equal(await pages(out), n, `${per} slides per page`);
    assert.equal((out.result ?? out).perPage, Number(per));
  }
});

test('handouts default to the Slides Per Page chosen on the Handout Master tab, else 6', async () => {
  const t = await deck(9);
  assert.equal(await pages(await t.exec('file.exportPdf', {layout: 'handouts'})), 2, 'six to a page by default');
  await t.exec('view.handoutMaster', {});
  await t.exec('handout.perPage', {n: 3});
  const out = await t.exec('file.exportPdf', {layout: 'handouts'});
  assert.equal((out.result ?? out).perPage, 3);
  assert.equal(await pages(out), 3);
});

test('notes pages; refusals: unknown layout, bad perPage, a host that cannot draw slides', async () => {
  const t = await deck(3);
  assert.equal(await pages(await t.exec('file.exportPdf', {layout: 'notes'})), 3);
  await assert.rejects(t.exec('file.exportPdf', {layout: 'poster'}), /layout/);
  await assert.rejects(t.exec('file.exportPdf', {layout: 'handouts', perPage: 5}), /perPage/);
  delete t.host.renderSlides;
  await assert.rejects(t.exec('file.exportPdf', {}), /drawn with the document open/);
});

/** A host file service that can write other files: the picked path, the bytes written. */
function writer(picked) {
  const wrote = [];
  const asked = [];
  const files = {
    binding: () => ({doc: 'd', path: null, format: null, name: 'Quarterly', autosave: false, savedHere: false}),
    pickDataSave: async req => { asked.push(req); return picked ? {path: picked, format: 'pdf'} : null; },
    pickSave: async req => { asked.push(req); return picked ? {path: picked, format: 'pdf'} : null; },
    writeFile: async (doc, req) => { wrote.push(req); return {path: req.path}; },
  };
  return {files, wrote, asked};
}

test('Create PDF asks for a file in the Save dialog and writes the PDF there; Cancel writes nothing', async () => {
  const t = await deck(3);
  const w = writer('C:\out\Quarterly.pdf');
  t.host.files = w.files;
  const out = await t.exec('file.exportPdf', {layout: 'handouts', perPage: 2}, {origin: 'ui'});
  const r = out.result ?? out;
  assert.equal(r.path, 'C:\out\Quarterly.pdf');
  assert.equal(r.data, undefined, 'the bytes went to the file');
  assert.equal(w.asked[0].name, 'Quarterly.pdf', 'the Save dialog suggests the document\'s name');
  assert.equal(w.asked[0].filters[0].extensions[0], 'pdf');
  assert.equal((await PDFDocument.load(Buffer.from(w.wrote[0].base64, 'base64'))).getPageCount(), 2);
  const none = writer(null);
  t.host.files = none.files;
  const c = await t.exec('file.exportPdf', {}, {origin: 'ui'});
  assert.equal((c.result ?? c).canceled, true);
  assert.equal(none.wrote.length, 0);
});

test('Save As with the PDF type goes through file.exportPdf and leaves the document as it is', async () => {
  const t = await deck(3);
  const w = writer(null);
  t.host.files = w.files;
  const out = await t.exec('file.saveAs', {path: 'C:\out\Deck.pdf'});
  const r = out.result ?? out;
  assert.deepEqual([r.saved, r.format, r.bound], [true, 'pdf', false]);
  assert.equal(w.wrote.length, 1);
  assert.equal(w.wrote[0].path, 'C:\out\Deck.pdf');
});
