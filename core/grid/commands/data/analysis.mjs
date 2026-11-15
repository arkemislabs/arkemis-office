// Data > Analysis > Data Analysis (the Analysis ToolPak): statistical tools that compute a report from
// input ranges and write it as a static table (values, not formulas) to an output range or a new worksheet.
// Translated from gridcraft crates/engine/src/cmd/analysis.rs (`run`, `write_report`, `specs`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every tool is one `tool` value of `data.analysisToolPak`; the tools themselves are in
// lib/analysis-tools.mjs. The report is written at `output` (refusing to overwrite data unless
// `overwrite`) or on a new sheet (`newSheet`, default the next free name). Excel's "New Workbook" output
// is not offered (one workbook per window).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {MAX_ROWS, MAX_COLS, rangeOf, rangeA1} from '../../lib/addr.mjs';
import {CellError} from '../../lib/value.mjs';
import {engineFor} from '../../model/calc.mjs';
import {forEachCell, hasContent, writeCell} from '../../model/store.mjs';
import {checkSheetName, nextSheetName} from '../../model/sheet.mjs';
import {styleIdAt} from '../../model/workbook.mjs';
import {deriveStyle} from '../../model/style.mjs';
import {hasDoc, gridSel, setGridSelection, selectionAt} from '../../lib/edit-targets.mjs';
import {parseRangeText, valueOf, bad, failed, baseDoc} from '../../lib/data-common.mjs';
import {CMD, TOOLS, MAX_OUTPUT_CELLS, OVERWRITE_ERROR, text, flag, toolId, runTool} from '../../lib/analysis-tools.mjs';

export {OVERWRITE_ERROR, TOOLS};

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/analysis.rs']};
/** Most cells whose spill membership is checked one by one before a report is written. */
const SPILL_CHECK_CELLS = 200_000;

/** Writes the report at `output` (refusing to overwrite data unless `overwrite`) or on a new sheet. */
function writeReport(ctx, content, p, tool, g) {
  const [r0, c0] = g.extent();
  const rows = Math.max(r0, 1), cols = Math.max(c0, 1);
  if (rows * cols > MAX_OUTPUT_CELLS) throw bad(CMD, 'the report is too large');
  const active = gridSel(ctx).sheet;
  const outputTo = typeof p.outputTo === 'string' ? p.outputTo.toLowerCase() : null;
  let target;
  if (outputTo === 'newsheet') target = null;
  else if (outputTo === 'range') {
    target = text(p, ['output', 'outputRange']);
    if (target === null) throw bad(CMD, 'missing `output` (the output range)');
  } else target = text(p, ['output', 'outputRange']);
  let si, at, newName = null;
  if (target !== null) {
    const r = parseRangeText(content, target, CMD, active);
    si = r.sheet;
    at = r.range.start;
  } else {
    newName = typeof p.newSheet === 'string' && p.newSheet.trim() ? p.newSheet.trim() : nextSheetName(content);
    const err = checkSheetName(content, newName);
    if (err) throw failed(err);
    si = content.sheets.length;
    at = {row: 0, col: 0};
  }
  const endRow = at.row + rows - 1, endCol = at.col + cols - 1;
  if (endRow >= MAX_ROWS || endCol >= MAX_COLS) throw failed("The report doesn't fit on the sheet below and right of the output cell.");
  const rect = rangeOf(at.row, at.col, endRow, endCol);
  // Existing content inside the report's rectangle.
  const occupied = [];
  if (newName === null) {
    const sheet = content.sheets[si];
    forEachCell(sheet, rect.start.row, rect.start.col, rect.end.row, rect.end.col, (row, col, cell) => {
      if (hasContent(cell)) occupied.push([row, col, cell]);
    });
    if (!occupied.length && rows * cols <= SPILL_CHECK_CELLS) {
      const engine = engineFor(content);
      outer: for (let row = rect.start.row; row <= rect.end.row; row++) {
        for (let col = rect.start.col; col <= rect.end.col; col++) {
          if (engine.spillAnchorOf(si, row, col) !== null) { occupied.push([row, col, null]); break outer; }
        }
      }
    }
  }
  if (occupied.length && !flag(p, 'overwrite')) throw failed(`The output range ${rangeA1(rect)} ${OVERWRITE_ERROR}; pass overwrite: true to replace it.`);
  let sheetName = newName ?? content.sheets[si].name;
  if (newName !== null) {
    const made = ctx.run('home.insertSheet', {name: newName, before: content.sheets.length});
    si = made.index;
    sheetName = made.name ?? newName;
  }
  const sheet = content.sheets[si];
  const styleOf = (row, col) => (newName === null ? styleIdAt(sheet, row, col) : 0);
  for (const [row, col, cell] of occupied) {
    if (cell) writeCell(ctx.change, ctx.doc, si, row, col, cell.s ? {s: cell.s} : null);
  }
  const pct = new Set(g.pct.map(([r, c]) => `${r},${c}`));
  const pctStyles = new Map();
  for (const [r, c, v] of g.entries()) {
    const row = at.row + r, col = at.col + c;
    let st = styleOf(row, col);
    if (pct.has(`${r},${c}`)) {
      if (!pctStyles.has(st)) pctStyles.set(st, deriveStyle(ctx.change, ctx.doc, st, {numFmt: '0.00%'}));
      st = pctStyles.get(st);
    }
    const cell = {v: v instanceof CellError ? {e: v.text} : v};
    if (st) cell.s = st;
    writeCell(ctx.change, ctx.doc, si, row, col, cell);
  }
  if (newName !== null) setGridSelection(ctx, selectionAt(si, {row: 0, col: 0}));
  return {tool, sheet: sheetName, range: rangeA1(rect), rows, cols};
}

function run(ctx, p) {
  const t = text(p, ['tool']);
  if (t === null) return {tools: TOOLS.map(([id, label]) => ({id, label}))};
  const tool = toolId(t);
  if (!tool) throw bad(CMD, `unknown tool \`${t}\``);
  const content = baseDoc(ctx);
  const engine = engineFor(content);
  const env = {content, sheet: gridSel(ctx).sheet, value: (si, row, col) => valueOf(engine, si, row, col)};
  return writeReport(ctx, content, p, tool, runTool(env, p, tool));
}

const ANY = s.optional(s.any());
const STR = s.optional(s.string({max: 4096}));

export default defineCommands({
  family: 'data/analysis',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: CMD, label: 'Data Analysis…', risk: 'edit', dialog: 'dialog.analysisToolPak',
      description: 'Data Analysis (Data > Analysis): a statistical report written as static values. `tool`: anovaSingle|correlation|covariance|descriptive|exponentialSmoothing|fTest|histogram|movingAverage|rankPercentile|regression|tTestPaired|tTestEqual|tTestUnequal (or the tool\'s label). `output`: "E1" (top-left of the report; default a new sheet), `newSheet`: name, `outputTo`: range|newSheet (picks between the two), `overwrite`: true to replace non-empty output cells (else refused), `labels`: true when the first row/column holds names, `groupedBy`: columns|rows. Range tools take `range`; descriptive: summary? (default true), confidence? (95), kthLargest?, kthSmallest?; histogram: bins? (a range; default evenly spaced), pareto?, cumulative?; regression: inputY, inputX, constantZero?, confidence? (95), residuals?, standardizedResiduals?, normalProbability?; movingAverage: interval? (3), standardErrors?; exponentialSmoothing: damping? (0.3), standardErrors?; t-tests and fTest: range1, range2, alpha? (0.05), hypothesizedDifference? (0); anovaSingle: alpha?. No `tool` returns {tools}. Returns {tool, sheet, range, rows, cols}.',
      params: s.object({
        tool: STR, output: STR, outputRange: STR, newSheet: STR, outputTo: STR, overwrite: ANY, labels: ANY, groupedBy: ANY,
        range: STR, input: STR, range1: STR, range2: STR, inputY: STR, inputX: STR, y: STR, x: STR, bins: STR, binRange: STR,
        summary: ANY, confidence: ANY, kthLargest: ANY, kthSmallest: ANY, pareto: ANY, cumulative: ANY, constantZero: ANY,
        residuals: ANY, standardizedResiduals: ANY, normalProbability: ANY, interval: ANY, damping: ANY, standardErrors: ANY,
        alpha: ANY, hypothesizedDifference: ANY, difference: ANY,
      }),
      state: hasDoc,
      run,
    },
  ],
});
