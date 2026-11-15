// Review > Performance (Check Performance) and Review > Ink (Hide Ink).
// Neither is in gridcraft: Excel's own behaviour, not checked against upstream.
//
// Check Performance lists what slows a workbook down, as Excel's pane does: cells that carry only formatting beyond the last cell with data
// (Clean Excess Cell Formatting removes it), formulas that use volatile functions (OFFSET, INDIRECT, NOW, TODAY, RAND, RANDBETWEEN, INFO,
// CELL), and formulas that refer to a whole column or a whole row. Only the first can be fixed from here; the others name the cells so the
// person can rewrite them. Hide Ink hides the strokes the Draw tab's pens left (the strokes stay in the workbook).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {failed, baseDoc} from '../../lib/data-common.mjs';
import {a1} from '../../lib/addr.mjs';
import {forEachCell, hasContent, writeCell} from '../../model/store.mjs';
import {lockedCellError} from '../edit/cell.mjs';

const UPSTREAM = {repo: 'office', files: ['Excel Review > Performance > Check Performance', 'Excel Review > Ink > Hide Ink']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const VOLATILE = /\b(OFFSET|INDIRECT|NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY|INFO|CELL)\s*\(/i;
const WHOLE_COLUMN = /(^|[^A-Za-z0-9_$.])\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![A-Za-z0-9(])/;
const WHOLE_ROW = /(^|[^A-Za-z0-9_$.])\$?\d+:\$?\d+(?![A-Za-z0-9(])/;
const SAMPLE = 5;

/** The last row and column that hold a value or formula, and the cells that hold only a format beyond them: {last, extra: [[row, col]]}. */
function scanSheet(sheet) {
  let maxRow = -1, maxCol = -1;
  const styled = [];
  const volatile = [], whole = [];
  forEachCell(sheet, 0, 0, 1_048_575, 16_383, (row, col, cell) => {
    if (hasContent(cell)) {
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      if (typeof cell.f === 'string') {
        if (VOLATILE.test(cell.f)) volatile.push([row, col]);
        if (WHOLE_COLUMN.test(cell.f) || WHOLE_ROW.test(cell.f)) whole.push([row, col]);
      }
    } else if (cell && cell.s) styled.push([row, col]);
  });
  return {maxRow, maxCol, extra: styled.filter(([r, c]) => r > maxRow || c > maxCol), volatile, whole};
}
const cellList = list => list.slice(0, SAMPLE).map(([r, c]) => a1(r, c)).join(', ') + (list.length > SAMPLE ? ', ...' : '');

/** Check Performance: [{id, kind, sheet, count, title, detail, fix?}]. */
function checkPerformance(ctx) {
  const content = baseDoc(ctx);
  const findings = [];
  content.sheets.forEach(sh => {
    const sc = scanSheet(sh);
    if (sc.extra.length) findings.push({id: `excess|${sh.name}`, kind: 'excess', sheet: sh.name, count: sc.extra.length, title: `Unused cell formatting: ${sh.name}`,
      detail: `${sc.extra.length} cell${sc.extra.length === 1 ? '' : 's'} beyond the last cell with data only carry formatting (${cellList(sc.extra)}). Clean it up to make the file smaller and faster.`, fix: 'review.cleanExcessFormatting'});
    if (sc.volatile.length) findings.push({id: `volatile|${sh.name}`, kind: 'volatile', sheet: sh.name, count: sc.volatile.length, title: `Volatile functions: ${sh.name}`,
      detail: `${sc.volatile.length} formula${sc.volatile.length === 1 ? ' uses' : 's use'} a function that recalculates every time anything changes (${cellList(sc.volatile)}).`});
    if (sc.whole.length) findings.push({id: `whole|${sh.name}`, kind: 'whole', sheet: sh.name, count: sc.whole.length, title: `Entire column or row references: ${sh.name}`,
      detail: `${sc.whole.length} formula${sc.whole.length === 1 ? ' refers' : 's refer'} to a whole column or row (${cellList(sc.whole)}). A range that covers only the data is quicker.`});
  });
  return {findings, sheets: content.sheets.length};
}

/** Clean Excess Cell Formatting: the formatted but empty cells beyond the last cell with data lose their format. */
function cleanExcess(ctx, p) {
  const content = baseDoc(ctx);
  const targets = p?.sheet !== undefined ? [targetSheet(ctx, p)] : content.sheets.map((_, i) => i);
  let cleaned = 0;
  for (const si of targets) {
    requireSchema2(ctx, si);
    const sc = scanSheet(content.sheets[si]);
    for (const [row, col] of sc.extra) {
      if (lockedCellError(ctx, si, row, col)) continue;
      writeCell(ctx.change, ctx.doc, si, row, col, {});
      cleaned += 1;
    }
  }
  if (!cleaned && p?.sheet !== undefined) throw failed('There is no unused formatting on this sheet.');
  return {cleaned};
}

export default defineCommands({
  family: 'review/checks',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'review.checkPerformance', label: 'Check Performance', risk: 'read', effect: 'view', dialog: 'dialog.checkPerformance',
      description: 'Check Performance (Review > Performance): what slows the workbook down: {findings: [{id, kind: excess|volatile|whole, sheet, count, title, detail, fix?}]}. Unused cell formatting can be cleaned with review.cleanExcessFormatting.',
      params: s.object({}), state: hasDoc, run: checkPerformance},
    {id: 'review.cleanExcessFormatting', label: 'Clean Excess Cell Formatting', risk: 'edit',
      description: 'Remove the formatting of cells that hold no data beyond the last cell with data: `sheet` (default every sheet) -> {cleaned}. Row and column formats stay; locked cells of a protected sheet are left alone.',
      params: s.object({sheet: SHEET}), state: hasDoc, run: cleanExcess},
    {id: 'review.hideInk', label: 'Hide Ink', risk: 'read', effect: 'view', description: 'Hide or show the ink strokes drawn on the sheets (`on`, default: toggle). The strokes stay in the workbook.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.hideInk} : hasDoc(ctx)),
      run: (ctx, p) => { const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.hideInk; ctx.setView({hideInk: on}); return {on}; }},
  ],
});

export {scanSheet, checkPerformance};
