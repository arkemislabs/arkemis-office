// Foundation benchmark (docs/architecture.md 19, phase 1: "1,000-page PDF"), headless half: what
// opening and scrolling cost in the model, without a window. The window half (pdf.js rasters,
// virtualization, scrolling) is tests/e2e/folio/surface-benchmark.e2e.mjs.
//
// Measured on a Windows 11 development machine (2026-10-30, Node 24), 1,000 Letter pages of text:
//   schema 1 → 2 (read every page's comments and crop box with pdf-lib):   304 ms
//   lay out 1,000 pages + 10,000 visible-range / current-page queries:     5 ms
//   document.inspect of 1,000 pages (enumerate, depth 2):                  1 ms
//   page text of page 500 through pdf.js, cold (loads the 1,000-page file): 699 ms
// The assertions hold with wide margins.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {textPdf, schema1Content} from '../../core/folio/fixtures.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {layoutPages, visiblePages, currentPage} from '../../core/folio/lib/pageview.mjs';
import {enumerate} from '../../core/folio/address.mjs';
import {pageText, releaseTextSources} from '../../core/folio/model/page-text.mjs';

after(() => releaseTextSources());

test('1,000-page PDF: migrate, lay out, query the view and read a page\'s text', {timeout: 120_000}, async () => {
  const s1 = await schema1Content(await textPdf({pages: 1000}), 'thousand.pdf');
  const numbers = {};
  let t = performance.now();
  const c = await migrateContent(s1);
  numbers.migrateMs = Math.round(performance.now() - t);
  assert.equal(c.pages.length, 1000);

  t = performance.now();
  const layout = layoutPages(c.pages, 100, 1400);
  let sum = 0;
  for (let k = 0; k < 10000; k++) {
    const top = (k * 7919) % layout.height;
    const r = visiblePages(layout, top, 900, 900);
    sum += r[1] - r[0] + currentPage(layout, top, 900);
  }
  numbers.layoutAndQueriesMs = Math.round(performance.now() - t);
  assert.ok(sum > 0);
  const r = visiblePages(layout, layout.tops[500], 900, 900);
  assert.ok(r[1] - r[0] <= 3, `only a few pages near the view: ${r}`);

  t = performance.now();
  const nodes = enumerate(c, null, {depth: 2, limit: 2000}).nodes;
  numbers.enumerateMs = Math.round(performance.now() - t);
  assert.equal(nodes.filter(n => n.kind === 'page').length, 1000);

  t = performance.now();
  const text = await pageText(c, c.pages[499]);
  numbers.pageTextMs = Math.round(performance.now() - t);
  assert.ok(text.plainText().includes('(page 500)'));
  console.log('folio foundation benchmark', JSON.stringify(numbers));

  assert.ok(numbers.migrateMs < 20_000, `migrate: ${numbers.migrateMs} ms`);
  assert.ok(numbers.layoutAndQueriesMs < 2_000, `layout: ${numbers.layoutAndQueriesMs} ms`);
  assert.ok(numbers.enumerateMs < 2_000, `enumerate: ${numbers.enumerateMs} ms`);
});
