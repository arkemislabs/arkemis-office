// Data Table dialog model (submit: data.dataTable): the row and column input cells of the selected table.
// Excel's Data Table dialog over gridcraft's cmd/whatif.rs (`data_table`: range, rowInput,
// columnInput) at 146161b4b450a56e5e59a083ba0478582d1e602b; upstream's menu runs the command
// without a dialog. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {rangeA1} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.dataTable',
  title: 'Data Table',
  command: 'data.dataTable',
  init(ctx) { const sel = gridSel(ctx); return {range: rangeA1(sel.ranges[sel.ranges.length - 1]), rowInput: '', columnInput: ''}; },
  validate(v) {
    return String(v.rowInput ?? '').trim() || String(v.columnInput ?? '').trim() ? [] : [{field: 'rowInput', message: 'Input cell reference is not valid.'}];
  },
  toCommand(v) {
    const p = {range: v.range};
    if (String(v.rowInput ?? '').trim()) p.rowInput = String(v.rowInput).trim();
    if (String(v.columnInput ?? '').trim()) p.columnInput = String(v.columnInput).trim();
    return {command: 'data.dataTable', params: p};
  },
});
