// Subtotal dialog model (submit: data.subtotal).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Subtotal: At each change in, Use function,
// Add subtotal to) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's column drop-down and
// check list. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range, header, heads (column headings), startCol, groupBy (a column letter), function,
// columns (the checked column letters).

import {defineDialog} from '../../kernel/dialog.mjs';
import {colToLetters} from '../lib/addr.mjs';
import {regionInfo} from '../lib/data-dialog.mjs';

export default defineDialog({
  id: 'dialog.subtotal',
  title: 'Subtotal',
  command: 'data.subtotal',
  init(ctx) {
    const r = regionInfo(ctx);
    return {range: r.a1, header: r.header, heads: r.heads, startCol: r.startCol, groupBy: colToLetters(r.startCol), function: 'sum', columns: [colToLetters(r.range.end.col)]};
  },
  validate: v => ((v.columns ?? []).length ? [] : [{field: 'columns', message: 'Select at least one column to subtotal.'}]),
  toCommand: v => ({command: 'data.subtotal', params: {range: v.range, header: v.header !== false, groupBy: v.groupBy, function: v.function ?? 'sum', columns: v.columns}}),
});
