// Remove Duplicates dialog model (submit: data.removeDuplicates).
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`remove_duplicates_range`: a block
// selection as given, else the table's rows or the current region) and dialogs.rs (Range, My data has
// headers, Columns) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's column check list.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range, header, heads (column headings), startCol, columns (the checked column letters).

import {defineDialog} from '../../kernel/dialog.mjs';
import {colToLetters} from '../lib/addr.mjs';
import {regionInfo} from '../lib/data-dialog.mjs';

export default defineDialog({
  id: 'dialog.removeDuplicates',
  title: 'Remove Duplicates',
  command: 'data.removeDuplicates',
  init(ctx) {
    const r = regionInfo(ctx);
    return {range: r.a1, header: r.header, heads: r.heads, startCol: r.startCol, columns: r.heads.map((_, i) => colToLetters(r.startCol + i))};
  },
  validate: v => ((v.columns ?? []).length ? [] : [{field: 'columns', message: 'Select at least one column.'}]),
  toCommand: v => ({command: 'data.removeDuplicates', params: {range: v.range, header: !!v.header, columns: v.columns}}),
});
