// core/folio/commands/combine_view.mjs: the Combine files grid view.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) combine_ui/view.rs and combine_grid.rs: Grid view and List view; Expand all is enabled while a file with more than
//    one page is not expanded and Collapse all while any is; the page size goes 0.6 to 5 in ZOOM_STEPS, the end of the range stays put, 100 % resets.
//    Acrobat's Combine files thumbnails view works the same way.
// 2. Ours does the same on real PDFs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/folio/schema.mjs';
import {zoomStep, ZOOM_STEPS} from '../../core/folio/commands/combine_view.mjs';

const b64 = bytes => Buffer.from(bytes).toString('base64');
async function pdf(pages) { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([300, 300]); return d.save(); }
const st = (t, args) => t.session.state(t.docId, 'combine.view', args);
const view = t => t.doc.view.combine;

test('zoom steps: the next step, the ends stay put', () => {
  assert.equal(zoomStep(1, true), 1.25);
  assert.equal(zoomStep(1, false), 0.8);
  assert.equal(zoomStep(5, true), 5);
  assert.equal(zoomStep(0.6, false), 0.6);
  assert.equal(zoomStep(1.1, false), 1);
  assert.deepEqual([ZOOM_STEPS[0], ZOOM_STEPS.at(-1)], [0.6, 5]);
});

test('the grid view: toggling, Expand all and Collapse all by what can be expanded, the page size', async () => {
  const t = await createTestSession('folio', {content: createContent()});
  assert.equal((await st(t, {mode: 'toggle'})).enabled, false, 'Combine files is not open');
  await t.exec('page.combine', {});
  assert.equal((await st(t, {mode: 'toggle'})).checked, false, 'the list is the view that opens');
  await t.exec('combine.add', {files: [{base64: b64(await pdf(3)), name: 'three.pdf'}, {base64: b64(await pdf(1)), name: 'one.pdf'}]});
  assert.equal((await st(t, {expand: 'all'})).enabled, false, 'not in the grid');
  await t.exec('combine.view', {mode: 'toggle'});
  assert.equal(view(t).grid, true);
  assert.equal((await st(t, {mode: 'toggle'})).checked, true);
  assert.equal((await st(t, {expand: 'all'})).enabled, true);
  assert.equal((await st(t, {expand: 'none'})).enabled, false, 'nothing is expanded');
  await t.exec('combine.view', {expand: 'all'});
  const [three, one] = (await t.exec('combine.read', {})).result.files;
  assert.deepEqual(view(t).expanded, [three.id], 'a one-page file has no pages to show');
  assert.equal((await st(t, {expand: 'all'})).enabled, false, 'every file with pages is expanded');
  await t.exec('combine.view', {expand: 'none'});
  assert.deepEqual(view(t).expanded, []);
  await assert.rejects(t.exec('combine.expand', {id: one.id}), /no pages to show/);
  await t.exec('combine.expand', {id: three.id});
  assert.deepEqual(view(t).expanded, [three.id]);
  await t.exec('combine.expand', {id: three.id});
  assert.deepEqual(view(t).expanded, [], 'a second click folds it');
  // The page size.
  assert.equal((await st(t, {})).value, 100, 'the spinner shows the page size in percent');
  await t.exec('combine.view', {zoom: 'larger'});
  assert.equal(view(t).zoom, 1.25);
  await t.exec('combine.view', {percent: 250});
  assert.equal(view(t).zoom, 2.5);
  await t.exec('combine.view', {zoom: 'reset'});
  assert.equal(view(t).zoom, 1);
  await t.exec('combine.view', {percent: 60});
  assert.equal((await st(t, {zoom: 'smaller'})).enabled, false, 'at the smallest');
  await t.exec('combine.view', {percent: 500});
  assert.equal((await st(t, {zoom: 'larger'})).enabled, false, 'at the largest');
  await assert.rejects(t.exec('combine.view', {}), /give a mode/);
  await t.exec('combine.view', {mode: 'list'});
  assert.equal(view(t).grid, false);
  // The list keeps working on the same list after the grid has been used.
  await t.exec('combine.select', {ids: [three.id]});
  assert.deepEqual(view(t).selected, [three.id]);
});
