// Select Data Source (submit: chart.selectData): the range of the chart's worksheet (headers included) its series and categories are read
// from, and Switch Row/Column. PowerPoint opens the embedded workbook to pick a range with the mouse; here the range is typed, and it
// refers to the worksheet Edit Data shows (A1 is its top left cell). Layout as PowerPoint, not checked against upstream.

import {defineDialog} from '../../kernel/dialog.mjs';
import {isSchema2} from '../model/doc.mjs';
import {selectedShapes} from '../lib/format-text.mjs';
import {sheetOf, parseSheetRange, rangeText} from '../lib/chart.mjs';

const chartOf = ctx => (isSchema2(ctx?.doc) ? selectedShapes(ctx).find(s => s.kind?.type === 'chart') ?? null : null);
const wholeOf = c => { const t = sheetOf(c); return rangeText({r1: 0, c1: 0, r2: Math.max(0, t.length - 1), c2: Math.max(1, ...t.map(r => r.length)) - 1}); };

export default defineDialog({
  id: 'dialog.selectData',
  title: 'Select Data Source',
  command: 'chart.selectData',
  init(ctx) {
    const c = chartOf(ctx)?.kind;
    return {range: c ? c.range ?? wholeOf(c) : 'A1:B2', whole: c ? wholeOf(c) : 'A1:B2', switchRowColumn: false};
  },
  validate(v) {
    const r = parseSheetRange(v.range);
    if (!r) return [{field: 'range', message: 'Enter a range such as A1:D5.'}];
    const w = parseSheetRange(v.whole);
    if (w && (r.r2 > w.r2 || r.c2 > w.c2)) return [{field: 'range', message: `The worksheet is ${v.whole}: the range goes outside it.`}];
    if (r.r1 === r.r2 || r.c1 === r.c2) return [{field: 'range', message: 'The range needs a header row and a first column besides the values.'}];
    return [];
  },
  toCommand(v) {
    const select = {command: 'chart.selectData', params: {range: rangeText(parseSheetRange(v.range))}};
    return v.switchRowColumn ? {batch: [select, {command: 'chart.data', params: {switchRowColumn: true}}]} : select;
  },
});
