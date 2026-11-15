// Chart Design › Data › Edit Data: the chart's embedded sheet (Word opens it in a small spreadsheet window): a grid of cells, the first
// row naming the series (A1 is empty), the first column the categories, a column of values for each series; Add Row, Add Series and
// removing a row or series. OK runs chart.editData with the `rows`. The cells are kept as text and read as numbers where they are one.
// Over wordcraft crates/ui-egui/src/dialogs/dialogs_chart.rs (the data grid). MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Drawn by src/apps/quill/dialogs/chartData.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {chartTable, MAX_POINTS, MAX_SERIES} from '../model/chart.mjs';
import {selectedObjects} from '../context.mjs';
import {selectionPositions} from '../address.mjs';
import {ordered} from '../lib/caret-session.mjs';

const text = v => (v === null || v === undefined ? '' : String(v));

/** The selected chart's table as text cells. */
export function tableOf(ctx) {
  const ranges = selectionPositions(ctx.doc, ctx.selection);
  const r = ranges[ctx.selection?.primary ?? 0] ?? ranges[0];
  const [a, b] = ordered({anchor: r.anchor, focus: r.focus});
  const hit = selectedObjects(ctx.doc, a, b, 1, o => o?.type === 'graphic' && !!o.graphic?.chart)[0];
  return hit ? chartTable(hit.obj.graphic.chart).map(row => row.map(text)) : [['', 'Series 1'], ['Category 1', '']];
}

export default defineDialog({
  id: 'dialog.chartData',
  title: 'Edit Data',
  command: 'chart.editData',
  init(ctx) { let rows; try { rows = tableOf(ctx); } catch { rows = [['', 'Series 1']]; } return {rows}; },
  validate(v) {
    const rows = v.rows ?? [];
    if ((rows[0]?.length ?? 0) < 2) return [{field: 'grid', message: 'A chart needs at least one series.'}];
    if (rows.length < 2) return [{field: 'grid', message: 'A chart needs at least one category.'}];
    if (rows.length - 1 > MAX_POINTS || rows[0].length - 1 > MAX_SERIES) return [{field: 'grid', message: 'That is more data than a chart holds.'}];
    return [];
  },
  toCommand: v => ({command: 'chart.editData', params: {rows: v.rows}}),
});
