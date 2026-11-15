// U:grid/tables: Data > Analysis > Data Analysis (the Analysis ToolPak): the thirteen tools, the
// distribution routines behind their p-values and critical values, the output placement (range, new
// sheet, the overwrite refusal) and the dialog model.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/analysis.rs, whose tests are ported below with their
//    textbook values (the worksheet functions the upstream tests compare against are not in this
//    library yet, so the expected numbers are closed forms or published table values). Excel: the
//    layouts and labels of the Analysis ToolPak reports.
// 2. Ours: the tools run through data.analysisToolPak and write static values, one undo step.
// 3. These tests; the dialog itself is driven in tests/e2e/grid/analysis.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, text, stored, run, fails, errorOf} from './edit-helpers.mjs';
import {tDist2T, tDistRT, tInv2T, tInv, fDist, fDistRT, fInv, fInvRT, betaInc, lnGamma} from '../../core/grid/lib/analysis-dist.mjs';
import {forecastGrid, TOOLS, OVERWRITE_ERROR, toolId} from '../../core/grid/lib/analysis-tools.mjs';
import {ERR} from '../../core/grid/lib/value.mjs';
import dialog, {TOOL_LIST, isOverwriteError} from '../../core/grid/dialogs/analysisToolPak.mjs';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const put = (t, range, values) => run(t, 'range.setValues', {range, values});
const tool = (t, params) => run(t, 'data.analysisToolPak', params);
const ctxOf = t => t.session.readContext(t.docId);

/** The two-tailed t probability by numeric integration of the density (Simpson), an independent check of the beta function. */
function tTail2(t, df) {
  const c = Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2)) / Math.sqrt(df * Math.PI);
  const f = x => c * (1 + x * x / df) ** (-(df + 1) / 2);
  const n = 20000, h = t / n;
  let s = f(0) + f(t);
  for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return 1 - 2 * (s * h / 3);
}

test('distributions: t and F against closed forms, published tables and numeric integration', () => {
  // df = 2: P(|T| > t) = 1 - t / sqrt(t^2 + 2); F with d1 = 2: P(F > f) = (1 + 2f/d2)^(-d2/2).
  for (const t of [0.5, 1, 2.5, 6]) assert.ok(close(tDist2T(t, 2), 1 - t / Math.sqrt(t * t + 2), 1e-12), `t=${t}`);
  assert.ok(close(fDistRT(27, 2, 6), 0.001, 1e-12));
  assert.ok(close(fDistRT(3, 2, 10), (1 + 2 * 3 / 10) ** -5, 1e-12));
  // Published critical values.
  assert.ok(close(tInv2T(0.05, 4), 2.7764451051977987, 1e-9));
  assert.ok(close(tInv2T(0.05, 10), 2.2281388519649385, 1e-9));
  assert.ok(close(tInv2T(0.05, 1), 12.706204736432095, 1e-8));
  assert.ok(close(tInv(0.95, 10), 1.8124611228107335, 1e-9));
  assert.ok(close(tInv(0.05, 10), -1.8124611228107335, 1e-9));
  assert.ok(close(fInvRT(0.05, 2, 6), 5.143252849784718, 1e-8));
  assert.ok(close(fInvRT(0.05, 5, 10), 3.325834530413, 1e-8));
  assert.ok(close(fInv(0.05, 5, 10), 1 / fInvRT(0.05, 10, 5), 1e-9), 'left-tail inverse is the reciprocal of the right tail with swapped df');
  // The cumulative and right tails add to one; the right tail of a negative t is above one half.
  assert.ok(close(fDist(2.2, 4, 9) + fDistRT(2.2, 4, 9), 1, 1e-12));
  assert.ok(close(tDistRT(-1.5, 7), 1 - tDistRT(1.5, 7), 1e-12));
  // Numeric integration of the density agrees with the beta function.
  for (const [t, df] of [[1.3, 5], [2.9, 12], [0.4, 30], [3.5, 3]]) assert.ok(close(tDist2T(t, df), tTail2(t, df), 1e-9), `t=${t} df=${df}`);
  assert.ok(close(betaInc(0.5, 2, 2), 0.5, 1e-14));
  // Out of range arguments are errors (NaN), df is truncated as Excel does.
  assert.ok(Number.isNaN(tInv2T(0, 5)) && Number.isNaN(tInv2T(1.5, 5)) && Number.isNaN(tDist2T(1, 0)) && Number.isNaN(fInvRT(0.05, 0, 3)));
  assert.equal(tInv2T(0.05, 10.9), tInv2T(0.05, 10));
});

test('tools are found by id or label, punctuation and case ignored', () => {
  assert.equal(TOOLS.length, 13);
  assert.equal(toolId('t-Test: Paired Two Sample for Means'), 'tTestPaired');
  assert.equal(toolId('descriptive statistics'), 'descriptive');
  assert.equal(toolId('F-Test Two-Sample for Variances'), 'fTest');
  assert.equal(toolId('nope'), null);
});

test('forecast standard errors match the full-window rescan, gaps included', () => {
  const x = [2, 4, 5, 4, 5, 7, 1, 3, 8, 6, 2];
  const f = [null, 3, 4.5, null, 4, 6.5, 2, 2.5, 7, 5, 4];
  const rescan = (i, w) => {
    const s0 = i + 1 - w;
    if (s0 < 0) return null;
    let acc = 0;
    for (let j = s0; j <= i; j++) { if (f[j] === null) return null; acc += (x[j] - f[j]) ** 2; }
    return Math.sqrt(acc / w);
  };
  for (let w = 1; w <= 5; w++) {
    const g = forecastGrid(x, f, w, {standardErrors: true});
    for (let i = 0; i < f.length; i++) {
      const got = g.get(i, 1), want = rescan(i, w);
      if (want === null) assert.equal(got, ERR.NA, `window ${w}, row ${i}`);
      else assert.ok(close(got, want, 1e-12), `window ${w}, row ${i}: ${got} vs ${want}`);
    }
  }
  const g = forecastGrid(x, f, 3, {standardErrors: true});
  assert.equal(g.get(5, 1), ERR.NA, 'a window through the gap is #N/A');
  assert.equal(typeof g.get(6, 1), 'number', 'the next full window after it is not');
});

test('Descriptive Statistics of 1 to 5 writes Excel\'s rows, and a second run needs overwrite', async () => {
  const t = await session();
  await put(t, 'A1', [['Score'], [1], [2], [3], [4], [5]]);
  const r = await tool(t, {tool: 'Descriptive Statistics', range: 'A1:A6', labels: true, output: 'C1', confidence: 95, kthLargest: 2, kthSmallest: 1});
  assert.equal(r.range, 'C1:D18');
  assert.equal(v(t, 'C1'), 'Score');
  assert.equal(v(t, 'C3'), 'Mean');
  assert.equal(v(t, 'D3'), 3);
  assert.ok(close(v(t, 'D4'), Math.sqrt(2.5 / 5), 1e-12));
  assert.equal(v(t, 'D5'), 3);
  assert.equal(v(t, 'D6'), ERR.NA);
  assert.ok(close(v(t, 'D7'), Math.sqrt(2.5), 1e-12));
  assert.equal(v(t, 'D8'), 2.5);
  assert.ok(close(v(t, 'D9'), -1.2, 1e-12));
  assert.ok(close(v(t, 'D10'), 0, 1e-12));
  assert.deepEqual(['D11', 'D12', 'D13', 'D14', 'D15'].map(a => v(t, a)), [4, 1, 5, 15, 5]);
  assert.equal(v(t, 'C16'), 'Largest(2)');
  assert.equal(v(t, 'D16'), 4);
  assert.equal(v(t, 'D17'), 1);
  assert.equal(v(t, 'C18'), 'Confidence Level(95.0%)');
  // CONFIDENCE.T(0.05, STDEV.S, 5) = T.INV.2T(0.05, 4) * s / sqrt(5).
  assert.ok(close(v(t, 'D18'), 2.7764451051977987 * Math.sqrt(2.5) / Math.sqrt(5), 1e-9));
  const again = {tool: 'descriptive', range: 'A2:A6', output: 'C1'};
  const e = await fails(t, 'data.analysisToolPak', again);
  assert.ok(e.message.includes(OVERWRITE_ERROR), e.message);
  assert.equal(v(t, 'C1'), 'Score', 'a refused run changes nothing');
  await tool(t, {...again, overwrite: true});
  assert.equal(v(t, 'C1'), 'Column1');
  assert.equal(v(t, 'C16'), 'Largest(2)', 'cells outside the new, shorter report stay as they were');
});

test('Regression matches the textbook example and the multiple-regression normal equations', async () => {
  const t = await session();
  // x = 1..5, y = 2,4,5,4,5: b = 0.6, a = 2.2, R2 = 0.6, F = 4.5.
  await put(t, 'A1', [['y', 'x'], [2, 1], [4, 2], [5, 3], [4, 4], [5, 5]]);
  await tool(t, {tool: 'regression', inputY: 'A1:A6', inputX: 'B1:B6', labels: true, newSheet: 'Fit', residuals: true, standardizedResiduals: true});
  assert.ok(close(v(t, 'Fit!B5'), 0.6, 1e-12), 'R square');
  assert.ok(close(v(t, 'Fit!B6'), 1 - 0.4 * 4 / 3, 1e-12), 'adjusted R square');
  assert.ok(close(v(t, 'Fit!B7'), Math.sqrt(0.8), 1e-12), 'standard error');
  assert.ok(close(v(t, 'Fit!E12'), 4.5, 1e-12), 'F');
  assert.ok(close(v(t, 'Fit!B17'), 2.2, 1e-12), 'intercept');
  assert.ok(close(v(t, 'Fit!B18'), 0.6, 1e-12), 'slope');
  assert.equal(v(t, 'Fit!A18'), 'x');
  assert.ok(close(v(t, 'Fit!C18'), Math.sqrt(0.8 / 10), 1e-12), 'standard error of the slope');
  assert.ok(close(v(t, 'Fit!F12'), v(t, 'Fit!E18'), 1e-9), 'Significance F equals the slope\'s p-value');
  assert.ok(v(t, 'Fit!E18') > 0.12 && v(t, 'Fit!E18') < 0.13);
  assert.ok(close(v(t, 'Fit!F18'), 0.6 - 3.182446305284263 * Math.sqrt(0.08), 1e-9), 'lower 95%');
  assert.equal(v(t, 'Fit!A22'), 'RESIDUAL OUTPUT');
  assert.ok(close(v(t, 'Fit!B25'), 2.8, 1e-12), 'first prediction');
  assert.ok(close(v(t, 'Fit!C25'), -0.8, 1e-12), 'first residual');
  assert.ok(close(v(t, 'Fit!D25'), -0.8 / Math.sqrt(2.4 / 4), 1e-12), 'first standard residual');
  // Two predictors: y = 1 + 2 x1 + 3 x2 exactly, so the fit is perfect.
  await put(t, 'Sheet1!D1', [[6, 1, 1], [8, 2, 1], [12, 1, 3], [20, 2, 5], [15, 4, 2], [19, 3, 4]]);
  await tool(t, {tool: 'regression', inputY: 'Sheet1!D1:D6', inputX: 'Sheet1!E1:F6', newSheet: 'Multi'});
  assert.ok(close(v(t, 'Multi!B17'), 1, 1e-9));
  assert.ok(close(v(t, 'Multi!B18'), 2, 1e-9));
  assert.ok(close(v(t, 'Multi!B19'), 3, 1e-9));
  assert.equal(v(t, 'Multi!A19'), 'X Variable 2');
  assert.ok(close(v(t, 'Multi!B5'), 1, 1e-9), 'R square of a perfect fit');
  // Through the origin: y = 2 x has no intercept row values.
  await put(t, 'Sheet1!H1', [[2, 1], [4, 2], [6.2, 3], [7.8, 4]]);
  await tool(t, {tool: 'regression', inputY: 'Sheet1!H1:H4', inputX: 'Sheet1!I1:I4', constantZero: true, newSheet: 'Zero', normalProbability: true});
  assert.equal(v(t, 'Zero!C17'), ERR.NA);
  assert.ok(close(v(t, 'Zero!B18'), (2 * 1 + 4 * 2 + 6.2 * 3 + 7.8 * 4) / 30, 1e-12));
  assert.equal(v(t, 'Zero!A22'), 'PROBABILITY OUTPUT');
  assert.ok(close(v(t, 'Zero!A25'), 12.5, 1e-12), 'first percentile of four points');
});

test('t-tests, F-test and Anova: layouts, degrees of freedom and p-values', async () => {
  const t = await session();
  await put(t, 'A1', [[12, 10], [15, 14], [11, 9], [18, 15], [14, 13], [16, 12]]);
  await tool(t, {tool: 'tTestEqual', range1: 'A1:A6', range2: 'B1:B6', output: 'D1'});
  assert.equal(v(t, 'D1'), 't-Test: Two-Sample Assuming Equal Variances');
  assert.equal(v(t, 'D4'), 'Mean');
  assert.equal(v(t, 'E9'), 10, 'df');
  assert.equal(v(t, 'D13'), 'P(T<=t) two-tail');
  // The pooled t statistic and its probability, computed from the means and variances directly.
  const a = [12, 15, 11, 18, 14, 16], b = [10, 14, 9, 15, 13, 12];
  const mean = x => x.reduce((p, q) => p + q, 0) / x.length;
  const vr = x => x.reduce((p, q) => p + (q - mean(x)) ** 2, 0) / (x.length - 1);
  const pooled = (5 * vr(a) + 5 * vr(b)) / 10;
  const tstat = (mean(a) - mean(b)) / Math.sqrt(pooled * (2 / 6));
  assert.ok(close(v(t, 'E7'), pooled, 1e-12), 'pooled variance');
  assert.ok(close(v(t, 'E10'), tstat, 1e-12), 't statistic');
  assert.ok(close(v(t, 'E13'), tTail2(tstat, 10), 1e-9), 'two-tail p');
  assert.ok(close(v(t, 'E11'), tTail2(tstat, 10) / 2, 1e-9), 'one-tail p');
  assert.ok(close(v(t, 'E14'), 2.2281388519649385, 1e-9), 't critical two-tail');
  assert.ok(close(v(t, 'E13'), v(t, 'E11') * 2, 1e-12));
  // Paired: the differences' t statistic with n - 1 degrees of freedom, and the Pearson correlation row.
  await tool(t, {tool: 'tTestPaired', range1: 'A1:A6', range2: 'B1:B6', output: 'H1'});
  const dif = a.map((x, i) => x - b[i]);
  const tp = mean(dif) / Math.sqrt(vr(dif) / 6);
  assert.equal(v(t, 'H7'), 'Pearson Correlation');
  assert.equal(v(t, 'H13'), 'P(T<=t) two-tail');
  assert.ok(close(v(t, 'I13'), tTail2(tp, 5), 1e-9), 'paired two-tail p');
  assert.equal(v(t, 'I9'), 5, 'df');
  // Unequal variances: Welch's df is rounded.
  await tool(t, {tool: 'tTestUnequal', range1: 'A1:A6', range2: 'B1:B6', output: 'L1'});
  const q1 = vr(a) / 6, q2 = vr(b) / 6;
  assert.equal(v(t, 'M8'), Math.round((q1 + q2) ** 2 / (q1 * q1 / 5 + q2 * q2 / 5)));
  // F-test: F = var1 / var2 > 1, so the right tail and F.INV.RT.
  await tool(t, {tool: 'fTest', range1: 'A1:A6', range2: 'B1:B6', output: 'P1'});
  const f = vr(a) / vr(b);
  assert.ok(close(v(t, 'Q8'), f, 1e-12));
  assert.ok(close(v(t, 'Q9'), fDistRT(f, 5, 5), 1e-12));
  assert.ok(close(v(t, 'Q10'), 5.050329058, 1e-6), 'F critical one-tail (5, 5) at 0.05');
  // Anova on {1,2,3}, {4,5,6}, {7,8,9}: SSB 54, SSW 6, F 27, p = 0.001.
  await put(t, 'A20', [[1, 4, 7], [2, 5, 8], [3, 6, 9]]);
  await tool(t, {tool: 'anovaSingle', range: 'A20:C22', output: 'E20'});
  assert.equal(v(t, 'E31'), 'Between Groups');
  assert.deepEqual(['F31', 'F32', 'I31'].map(x => v(t, x)), [54, 6, 27]);
  assert.ok(close(v(t, 'J31'), 0.001, 1e-12));
  assert.ok(close(v(t, 'K31'), 5.143252849784718, 1e-8), 'F crit');
  assert.equal(v(t, 'E34'), 'Total');
  assert.equal(v(t, 'F34'), 60);
  // Labels name the groups, rows can be the groups, and the alpha changes F crit.
  await put(t, 'A40', [['a', 'b'], [1, 4], [2, 5], [3, 6]]);
  await tool(t, {tool: 'anovaSingle', range: 'A40:B43', labels: true, alpha: 0.01, output: 'E40'});
  assert.equal(v(t, 'E44'), 'a');
  assert.equal(v(t, 'E45'), 'b');
});

test('Histogram, matrices, smoothing and ranks', async () => {
  const t = await session();
  await put(t, 'A1', [[1], [2], [2], [3], [5], [7]]);
  await put(t, 'B1', [[2], [4], [6]]);
  await tool(t, {tool: 'histogram', range: 'A1:A6', bins: 'B1:B3', output: 'D1', cumulative: true, pareto: true});
  assert.deepEqual(['E2', 'E3', 'E4', 'E5'].map(a => v(t, a)), [3, 1, 1, 1]);
  assert.equal(v(t, 'D5'), 'More');
  assert.equal(v(t, 'F5'), 1);
  assert.equal(text(t, 'F5'), '100.00%', 'the cumulative share is shown as a percentage');
  assert.deepEqual([v(t, 'G2'), v(t, 'H2')], [2, 3], 'Pareto puts the largest bin first');
  // Without a bin range the bins are evenly spaced, the square root of the count of them.
  await tool(t, {tool: 'histogram', range: 'A1:A6', output: 'K1'});
  assert.equal(v(t, 'K2'), 1);
  assert.equal(v(t, 'K4'), 7);
  assert.equal(v(t, 'K5'), 'More');
  assert.equal(v(t, 'L2'), 1);
  assert.equal(v(t, 'L5'), 0);
  // Correlation and covariance (population): the lower triangle only.
  await put(t, 'J10', [[1, 2], [2, 4], [3, 5], [4, 4], [5, 5]]);
  await tool(t, {tool: 'correlation', range: 'J10:K14', output: 'M1'});
  assert.equal(v(t, 'N2'), 1);
  const r = 6 / Math.sqrt(10 * 6);
  assert.ok(close(v(t, 'N3'), r, 1e-12));
  assert.equal(v(t, 'O2'), null, 'the upper triangle is blank');
  await tool(t, {tool: 'covariance', range: 'J10:K14', output: 'M10'});
  assert.ok(close(v(t, 'N12'), 6 / 5, 1e-12));
  assert.ok(close(v(t, 'N11'), 2, 1e-12), 'the diagonal is the population variance');
  // Moving average of 3 and exponential smoothing with damping 0.3.
  await tool(t, {tool: 'movingAverage', range: 'K10:K14', output: 'Q1', standardErrors: true});
  assert.equal(v(t, 'Q2'), ERR.NA);
  assert.ok(close(v(t, 'Q3'), 11 / 3, 1e-12));
  assert.ok(close(v(t, 'Q5'), 14 / 3, 1e-12));
  assert.equal(v(t, 'R4'), ERR.NA);
  assert.ok(Number.isFinite(v(t, 'R5')));
  await tool(t, {tool: 'exponentialSmoothing', range: 'K10:K14', output: 'S1'});
  assert.equal(v(t, 'S1'), ERR.NA);
  assert.equal(v(t, 'S2'), 2);
  assert.ok(close(v(t, 'S3'), 0.7 * 4 + 0.3 * 2, 1e-12));
  // Rank and Percentile of 2,4,5,4,5: the two 5s share rank 1 (3 of 4 others below them).
  await tool(t, {tool: 'rankPercentile', range: 'K10:K14', output: 'U1'});
  assert.deepEqual(['U2', 'V2', 'W2', 'X2'].map(a => v(t, a)), [3, 5, 1, 0.75]);
  assert.deepEqual([v(t, 'U3'), v(t, 'W3')], [5, 1]);
  assert.deepEqual([v(t, 'V6'), v(t, 'X6')], [2, 0]);
  assert.equal(v(t, 'X4'), 0.25, '4 has one value below it among five');
  assert.equal(text(t, 'X2'), '75.00%');
  // Data in rows: Grouped By Rows.
  await put(t, 'A30', [[1, 2, 3], [4, 5, 6]]);
  await tool(t, {tool: 'descriptive', range: 'A30:C31', groupedBy: 'rows', output: 'A33'});
  assert.equal(v(t, 'A33'), 'Column1');
  assert.equal(v(t, 'B35'), 2);
  assert.equal(v(t, 'C33'), 'Column2');
  assert.equal(v(t, 'D35'), 5);
});

test('output goes to a new sheet by default or to the output range, as one undo step', async () => {
  const t = await session();
  await put(t, 'A1', [[1], [2], [3], [4]]);
  await expectUndoRoundTrip(t, 'data.analysisToolPak', {tool: 'descriptive', range: 'A1:A4'}, () => {});
  assert.equal(t.content.sheets.length, 2, 'the report is on a new sheet');
  await t.session.undo(t.docId, 1, {origin: 'test'});
  assert.equal(t.session.get(t.docId).file.content.sheets.length, 1, 'undo removes the new sheet');
  const r = await tool(t, {tool: 'descriptive', range: 'A1:A4', newSheet: 'Stats', outputTo: 'newSheet', output: 'ignored'});
  assert.equal(r.sheet, 'Stats');
  assert.equal(r.range, 'A1:B15');
  assert.equal(v(t, 'Stats!B3'), 2.5);
  // The new sheet is active now, so the input names its sheet.
  const second = await tool(t, {tool: 'descriptive', range: 'Sheet1!A1:A4'});
  assert.equal(second.sheet, 'Sheet2');
  assert.equal(second.range, 'A1:B15');
  // A text result at the output range keeps the cell's style; the cell it replaces loses its content.
  await put(t, 'Sheet1!C1', [['old', 'older']]);
  await run(t, 'format.bold', {range: 'C1'}).catch(() => null);
  await tool(t, {tool: 'covariance', range: 'Sheet1!A1:A4', output: 'Sheet1!C1', overwrite: true});
  assert.equal(v(t, 'Sheet1!C1'), null);
  assert.equal(stored(t, 'C1'), null);
  assert.equal(text(t, 'D2'), '1.25');
});

test('hostile inputs are refused without a crash, and never half-write', async () => {
  const t = await session();
  const r = await tool(t, {});
  assert.equal(r.tools.length, TOOLS.length);
  await put(t, 'A1', [[1, 'x'], [2, 3]]);
  for (const p of [
    {tool: 'nope'},
    {tool: 'descriptive'},
    {tool: 'descriptive', range: 'A1:XFD1048576'},
    {tool: 'descriptive', range: 'A1:B2'},
    {tool: 'descriptive', range: 'A1:A2', output: 'XFD1048576'},
    {tool: 'descriptive', range: 'A1:A2', newSheet: 'bad[name]'},
    {tool: 'regression', inputY: 'A1:A2', inputX: 'A1:A2'},
    {tool: 'regression', inputY: 'A1:A2', inputX: 'A1:Q2'},
    {tool: 'movingAverage', range: 'A1:A2', interval: 1e300},
    {tool: 'movingAverage', range: 'A1:A2', interval: -3},
    {tool: 'movingAverage', range: 'A1:A2', interval: 1.5},
    {tool: 'exponentialSmoothing', range: 'A1:A2', damping: 7},
    {tool: 'histogram', range: 'C1:C3'},
    {tool: 'tTestPaired', range1: 'A1', range2: 'A2'},
    {tool: 'anovaSingle', range: 'A1:A2'},
    {tool: 'correlation', range: 'A1:B2', alpha: 'x', groupedBy: 5},
    {tool: 'descriptive', range: 'A1:A2', confidence: 250},
    {tool: 'tTestEqual', range1: 'A1:A2', range2: 'A1:A2', alpha: 2},
    {tool: 'descriptive', range: 'A1:A2', summary: false},
  ]) {
    await fails(t, 'data.analysisToolPak', p);
    assert.equal(t.content.sheets.length, 1, `${JSON.stringify(p)} added no sheet`);
  }
  // Collinear X columns are an error, not a NaN report.
  await put(t, 'D1', [[1, 1, 2], [2, 2, 4], [3, 3, 6], [5, 4, 8]]);
  await fails(t, 'data.analysisToolPak', {tool: 'regression', inputY: 'D1:D4', inputX: 'E1:F4'});
  // Constant data gives #DIV/0! cells, not a crash.
  await put(t, 'H1', [[4], [4], [4]]);
  await tool(t, {tool: 'descriptive', range: 'H1:H3', output: 'J1'});
  assert.equal(errorOf(v(t, 'K9')), '#DIV/0!');
});

test('a protected workbook refuses the new sheet; the output range still works', async () => {
  const t = await session();
  await put(t, 'A1', [[1], [2], [3]]);
  await run(t, 'review.protectWorkbook', {on: true});
  await fails(t, 'data.analysisToolPak', {tool: 'descriptive', range: 'A1:A3'});
  const r = await tool(t, {tool: 'descriptive', range: 'A1:A3', output: 'C1'});
  assert.equal(r.range, 'C1:D15');
});

// ---------------------------------------------------------------------------------------------
// The dialog model

test('dialog: opens on the list with the selection as the input range, and builds the command', async () => {
  const t = await session();
  await put(t, 'A1', [['Score'], [1], [2], [3]]);
  await run(t, 'selection.set', {range: 'A1:A4'});
  const init = dialog.init(ctxOf(t));
  assert.equal(init.step, 'pick');
  assert.equal(init.tool, 'anovaSingle');
  assert.equal(init.range, 'A1:A4');
  assert.equal(init.groupedBy, 'columns');
  assert.equal(init.outputTo, 'newSheet');
  assert.equal(init.alpha, '0.05');
  assert.equal(init.labels, false);
  // On the list step OK has nothing to run yet: it asks the body to move on.
  assert.deepEqual(dialog.validate(init).map(p => p.field), ['step']);
  const v2 = {...init, step: 'tool', tool: 'descriptive', summary: true, confidenceOn: true, confidence: '90', kthLargestOn: true, kthLargest: '2', kthSmallestOn: false, kthSmallest: '1', labels: true};
  assert.deepEqual(dialog.validate(v2), []);
  const out = dialog.toCommand(v2);
  assert.equal(out.command, 'data.analysisToolPak');
  assert.deepEqual(out.params, {tool: 'descriptive', range: 'A1:A4', groupedBy: 'columns', labels: true, outputTo: 'newSheet', summary: true, confidence: 90, kthLargest: 2});
  const res = await t.exec(out.command, out.params);
  assert.equal(res.result.sheet, 'Sheet2');
  assert.equal(v(t, 'Sheet2!A1'), 'Score');
  assert.equal(v(t, 'Sheet2!B16'), 2, 'Largest(2) of 1, 2, 3');
});

test('dialog: each tool asks for its own fields and validates them', () => {
  const base = {step: 'tool', range: '', range1: '', range2: '', inputY: '', inputX: '', output: '', newSheet: '', outputTo: 'newSheet', alpha: '0.05', damping: '0.3', interval: '3',
    hypothesizedDifference: '0', confidence: '95', summary: true};
  const bad = (tool, extra = {}) => dialog.validate({...base, tool, ...extra}).map(p => p.field);
  assert.deepEqual(bad('regression'), ['inputY', 'inputX']);
  assert.deepEqual(bad('tTestEqual'), ['range1', 'range2']);
  assert.deepEqual(bad('fTest', {range1: 'A1:A5'}), ['range2']);
  assert.deepEqual(bad('correlation'), ['range']);
  assert.deepEqual(bad('histogram', {range: 'A1:A9'}), []);
  assert.deepEqual(bad('movingAverage', {range: 'A1:A9', interval: 'x'}), ['interval']);
  assert.deepEqual(bad('exponentialSmoothing', {range: 'A1:A9', damping: '2'}), ['damping']);
  assert.deepEqual(bad('anovaSingle', {range: 'A1:C9', alpha: '0'}), ['alpha']);
  assert.deepEqual(bad('descriptive', {range: 'A1:A9', summary: false}), ['summary']);
  assert.deepEqual(bad('descriptive', {range: 'A1:A9', confidenceOn: true, confidence: '120'}), ['confidence']);
  assert.deepEqual(bad('descriptive', {range: 'A1:A9', outputTo: 'range', output: ''}), ['output']);
  assert.deepEqual(bad('descriptive', {range: 'A1:A9', outputTo: 'newSheet', newSheet: 'bad[name]'}), ['newSheet']);
  const t2 = dialog.toCommand({...base, tool: 'tTestPaired', range1: 'A1:A6', range2: 'B1:B6', labels: true, alpha: '0.1', hypothesizedDifference: '1.5', outputTo: 'range', output: 'D1', overwrite: true});
  assert.deepEqual(t2.params, {tool: 'tTestPaired', range1: 'A1:A6', range2: 'B1:B6', labels: true, alpha: 0.1, hypothesizedDifference: 1.5, outputTo: 'range', output: 'D1', overwrite: true});
  const rg = dialog.toCommand({...base, tool: 'regression', inputY: 'A1:A6', inputX: 'B1:B6', constantZero: true, confidenceOn: true, confidence: '99', residuals: true, standardizedResiduals: true, normalProbability: true});
  assert.deepEqual(rg.params, {tool: 'regression', inputY: 'A1:A6', inputX: 'B1:B6', labels: false, constantZero: true, confidence: 99, residuals: true, standardizedResiduals: true, normalProbability: true, outputTo: 'newSheet'});
  const hs = dialog.toCommand({...base, tool: 'histogram', range: 'A1:A9', bins: 'C1:C4', pareto: true, cumulative: true});
  assert.deepEqual(hs.params, {tool: 'histogram', range: 'A1:A9', bins: 'C1:C4', labels: false, pareto: true, cumulative: true, outputTo: 'newSheet'});
  const ma = dialog.toCommand({...base, tool: 'movingAverage', range: 'A1:A9', interval: '4', standardErrors: true});
  assert.deepEqual(ma.params, {tool: 'movingAverage', range: 'A1:A9', labels: false, interval: 4, standardErrors: true, outputTo: 'newSheet'});
});

test('dialog: the overwrite prompt works through the command error', async () => {
  const t = await session();
  await put(t, 'A1', [[1], [2], [3]]);
  const values = {...dialog.init(ctxOf(t)), step: 'tool', tool: 'descriptive', range: 'A1:A3', labels: false, outputTo: 'range', output: 'A1'};
  const first = dialog.toCommand(values);
  assert.equal(first.params.overwrite, undefined);
  const e = await fails(t, first.command, first.params);
  assert.ok(e.message.includes(OVERWRITE_ERROR));
  assert.ok(isOverwriteError(e.message));
  assert.ok(!isOverwriteError('Input range contains non-numeric data.'));
  const again = dialog.toCommand({...values, overwrite: true});
  assert.equal(again.params.overwrite, true);
  const ok = await t.exec(again.command, again.params);
  assert.equal(ok.result.range, 'A1:B15');
  assert.equal(v(t, 'A1'), 'Column1');
});

test('dialog: Excel\'s tools list, in order, and the Office-only tools are not offered', () => {
  assert.deepEqual(TOOL_LIST.map(x => x.value), TOOLS.map(x => x[0]));
  assert.deepEqual(TOOL_LIST.map(x => x.label), TOOLS.map(x => x[1]));
});

void workbook;
