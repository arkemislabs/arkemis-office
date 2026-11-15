// Edit Data (submit: chart.data): the chart's data as one grid, the first row naming the series and the first column the
// categories (deckcraft crates/ui-egui/src/dialogs/body.rs `dlg_chart_data` with its + Row and + Series buttons, which
// the dialog body does in the grid). PowerPoint opens an embedded worksheet instead; a chart saved by Arkemis carries its
// values in the chart part, with no workbook behind it.

import {defineDialog} from '../../kernel/dialog.mjs';
import {isSchema2} from '../model/doc.mjs';
import {selectedShapes} from '../lib/format-text.mjs';
import {dataTable} from '../lib/chart.mjs';

export default defineDialog({
  id: 'dialog.chartData',
  title: 'Chart Data',
  command: 'chart.data',
  init(ctx) {
    const sh = isSchema2(ctx?.doc) ? selectedShapes(ctx).find(s => s.kind?.type === 'chart') : null;
    return {table: sh ? dataTable(sh.kind) : [['', 'Series 1'], ['', '']]};
  },
  validate(v) {
    const t = v.table;
    if (!Array.isArray(t) || t.length < 2 || !t.every(Array.isArray) || Math.max(...t.map(r => r.length)) < 2) {
      return [{field: 'table', message: 'Give the chart at least one series and one category.'}];
    }
    return [];
  },
  toCommand: v => ({command: 'chart.data', params: {table: v.table.map(r => r.map(c => String(c ?? '')))}}),
});
