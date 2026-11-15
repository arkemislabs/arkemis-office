// Grid foundation benchmark (docs/architecture.md 19, phase 1: "1M cells"): load a workbook of
// one million cells, recalculate, read a screen of display text, edit one cell through the kernel
// (structural sharing copies one 256-row block), and run a 20,000-formula recalculation chain.
//
// Numbers measured on a Windows 11 development machine (Node 24.21), 2026-10-30, file run alone
// (other agents' test suites were running on the machine at the same time):
//   build 1M stored cells (391 blocks of 256 rows) ......... 1.1-1.6 s
//   validateContent .......................................... 1.3-2.5 s
//   engine load (graph + values, no formulas) ................ 1.1-1.3 s
//   one screen of display text (60 x 30 cells) ............... 11-37 ms
//   one cell edit through the kernel (commit + recalc) ....... 45-103 ms
//   20,000-formula chain: full recalculation ................. 209-272 ms
//   chain: edit A1, incremental recalculation ................ 101-110 ms (all 19,999 dependents)
// (createTestSession's structuredClone of the 1M-cell content, ~7 s, is outside the timed steps.)
// The limits asserted below are loose (CI machines and parallel test files are slower); the
// numbers above are what the surface sees. Recalculation in a worker above a size threshold is not
// in this build (see openIssues): the main thread pays these costs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import {apps} from '../../core/generated/apps.mjs';
import {validateContent} from '../../core/grid/schema.mjs';
import * as model from '../../core/grid/model/index.mjs';
import {a1} from '../../core/grid/lib/addr.mjs';

const family = defineCommands({
  family: 'test-bench', app: 'grid', upstream: {repo: 'gridcraft', files: ['crates/engine/src/cmd/edit/cell.rs']},
  commands: [{id: 'test.cellSet', label: 'Set cell', risk: 'edit', params: s.object({row: s.integer(), col: s.integer(), input: s.string()}),
    run(ctx, p) { ctx.model.enterInput(ctx.change, ctx.doc, 0, p.row, p.col, p.input); return {}; }}],
});

const ms = t0 => Math.round(performance.now() - t0);

test('1M cells: load, validate, recalculate, read a screen, edit one cell', async () => {
  let t0 = performance.now();
  const ROWS = 100_000, COLS = 10;
  const blocks = {};
  for (let r = 0; r < ROWS; r++) {
    const b = (blocks[model.blockOf(r)] ??= {});
    for (let c = 0; c < COLS; c++) b[a1(r, c)] = c === 0 ? {v: `Row ${r + 1}`} : {v: r * COLS + c};
  }
  const content = {sheets: [{id: 's1', name: 'Sheet1', blocks}], activeSheetId: 's1', styles: [{}, {numFmt: '#,##0.00'}]};
  const build = ms(t0);
  t0 = performance.now();
  validateContent(content);
  const validate = ms(t0);
  t0 = performance.now();
  const engine = model.engineFor(content);
  const load = ms(t0);
  assert.equal(model.cellCount(content.sheets[0]), 1_000_000);
  assert.equal(engine.sheetValue(0, 99_999, 9), 999_999);
  t0 = performance.now();
  let chars = 0;
  for (let r = 50_000; r < 50_060; r++) for (let c = 0; c < 30; c++) chars += model.displayAt(content, 0, r, c).text.length;
  const screen = ms(t0);
  assert.ok(chars > 0);
  // createTestSession clones the content; the session's copy gets its engine before the timed edit.
  const t = await createTestSession('grid', {modules: [family], foundation: apps.grid, content});
  const before = t.content.sheets[0].blocks;
  model.engineFor(t.content);
  t0 = performance.now();
  await t.exec('test.cellSet', {row: 70_000, col: 3, input: '=SUM(B70001:C70001)'});
  const v = t.read('/sh:s1/D70001', 'values');
  const edit = ms(t0);
  assert.equal(v, 700_001 + 700_002);
  const after = t.content.sheets[0].blocks;
  const sharedBlocks = Object.keys(after).filter(k => after[k] === before[k]).length;
  assert.equal(sharedBlocks, Object.keys(before).length - 1, 'only the edited 256-row block is copied');
  console.log(`[bench] 1M cells: build ${build} ms, validate ${validate} ms, engine load ${load} ms, screen ${screen} ms, edit+recalc ${edit} ms`);
  assert.ok(load < 20_000 && screen < 2_000 && edit < 5_000, 'within loose limits');
});

test('recalculation chain: 20,000 dependent formulas', async () => {
  const N = 20_000;
  const blocks = {};
  blocks[0] = {A1: {v: 1}};
  for (let r = 1; r < N; r++) (blocks[model.blockOf(r)] ??= {})[a1(r, 0)] = {f: `A${r}+1`};
  const content = {sheets: [{id: 's1', name: 'Sheet1', blocks}], activeSheetId: 's1', styles: [{}]};
  let t0 = performance.now();
  const engine = model.engineFor(content);
  const full = ms(t0);
  assert.equal(engine.sheetValue(0, N - 1, 0), N);
  const t = await createTestSession('grid', {modules: [family], foundation: apps.grid, content});
  t0 = performance.now();
  await t.exec('test.cellSet', {row: 0, col: 0, input: '100'});
  const value = t.read(`/sh:s1/A${N}`, 'values');
  const incremental = ms(t0);
  assert.equal(value, N + 99);
  console.log(`[bench] chain of ${N}: full recalculation ${full} ms, edit A1 + incremental ${incremental} ms (${model.engineFor(t.content).lastRecalcCells} cells)`);
  assert.ok(full < 20_000 && incremental < 20_000, 'within loose limits');
});
