// Benchmark (docs/architecture.md 19, phase 1: "1,000-page PDF"): open a 1,000-page PDF in the
// window and scroll through it. The page view keeps only the pages near the view mounted
// (canvas.rs paints the visible pages; cache.rs keeps at most 24 page rasters), so the cost of
// opening and of each jump does not grow with the page count.
//
// Measured on a Windows 11 development machine (2026-10-30, Electron 44, test mode, inactive
// window), 1,000 Letter pages of text with the thumbnails panel open (/PageMode /UseThumbs):
//   open → first page painted (bridge wall clock): 1.48 s; surface mount → first raster: 0.85 s
//   (the open includes reading the file's comments into the model: pdf-lib parses all 1,000 pages)
//   pages mounted at any time: at most 3 (of 1,000)
//   jump to a page → its raster painted: median 59 ms, worst 111 ms (40 jumps over the document)
//   100 scroll steps of 400 px sent back to back, then the last page painted: 0.97 s
// The assertions below hold with wide margins for slower machines.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const PAGES = 1000;

test(`folio surface benchmark: open and scroll a ${PAGES}-page PDF`, {timeout: 300_000}, async () => {
  const pdf = await PDFDocument.load(await textPdf({pages: PAGES}));
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseThumbs'));
  const file = createFile('folio', 'Thousand pages');
  file.id = 'folio-thousand';
  file.content = await schema1Content(await pdf.save(), 'thousand.pdf');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/surface-benchmark', files: [file], renderer});
  const doc = file.id;
  const view = async () => (await app.rpc('engine.execute', {doc, command: 'surface.view', params: {}})).result;
  const numbers = {};
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000});
    const t0 = Date.now();
    await app.rpc('documents.open', {doc, show: true});
    const opened = await app.until(async () => { const v = await view(); return v.renders.count > 0 && !v.migrating ? v : null; }, {timeout: 120_000, interval: 25});
    numbers.openToFirstPaintMs = Date.now() - t0;
    numbers.mountToFirstRasterMs = Math.round(opened.firstPaintMs);
    assert.equal(opened.pages, PAGES);
    assert.ok(opened.mounted <= 4, `virtualized: ${opened.mounted} pages mounted`);
    await app.capture('opened');

    const jumps = [];
    let maxMounted = opened.mounted;
    for (let k = 0; k < 40; k++) {
      const page = 1 + Math.round((k * 997 + 13) % PAGES);
      const before = (await view()).renders.count;
      const t = Date.now();
      await app.rpc('engine.execute', {doc, command: 'surface.scroll', params: {page}});
      const v = await app.until(async () => { const x = await view(); return x.current === page - 1 && x.renders.count > before ? x : null; }, {timeout: 20_000, interval: 10});
      jumps.push(Date.now() - t);
      maxMounted = Math.max(maxMounted, v.mounted);
      if (k === 20) await app.capture(`page-${page}`);
    }
    jumps.sort((a, b) => a - b);
    numbers.jumpMedianMs = jumps[jumps.length >> 1];
    numbers.jumpWorstMs = jumps[jumps.length - 1];
    numbers.maxMounted = maxMounted;

    // Continuous scrolling: 100 steps of 400 px as fast as the bridge sends them, then settle.
    const startView = await view();
    const start = startView.scrollTop;
    // Sampled BEFORE the steps: the pages can finish painting while the last steps are still being sent,
    // so a count taken after them can already be the final one.
    const after = startView.renders.count;
    const t1 = Date.now();
    for (let k = 1; k <= 100; k++) await app.rpc('engine.execute', {doc, command: 'surface.scroll', params: {top: start + k * 400}});
    const target = start + 100 * 400;
    let last = null;
    const settled = await app.until(async () => {
      const x = await view();
      last = {top: x.scrollTop, target, renders: x.renders.count, after, rasters: x.rasters, max: x.scrollHeight};
      return Math.abs(x.scrollTop - target) < 2 && x.renders.count > after && x.rasters.stage === '' ? x : null;
    }, {timeout: 60_000, interval: 25}).catch(e => { throw new Error(e.message + ' ' + JSON.stringify(last)); });
    numbers.scroll100StepsMs = Date.now() - t1;
    assert.ok(settled.mounted <= 4, `still virtualized after scrolling: ${settled.mounted}`);
    await app.capture('scrolled');
    console.log('folio benchmark', JSON.stringify(numbers));

    assert.ok(numbers.openToFirstPaintMs < 15_000, `open: ${numbers.openToFirstPaintMs} ms`);
    assert.ok(numbers.jumpMedianMs < 2_000, `jump median: ${numbers.jumpMedianMs} ms`);
    assert.ok(numbers.maxMounted <= 4, `mounted: ${numbers.maxMounted}`);
    assert.ok(numbers.scroll100StepsMs < 30_000, `scroll: ${numbers.scroll100StepsMs} ms`);
  } finally {
    await app.close();
  }
});
