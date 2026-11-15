// Table Layout › Data › Sort (submit: table.sort).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/table.rs (`SortForm::read`:
// column 0, ascending, a header row when the first row repeats as a header; `column_label`: the
// header text when the list has a header row, else "Column n"; `params`) at
// aadb077e072b7de05f724e359d8db82e151f125c. Word's Type box is not offered: table.sort puts numbers
// first, numerically, then text in the column's language, whatever the column holds (upstream).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';

/** A column's name in Sort by: its header text, or "Column n" (column_label). */
export function columnLabel(headers, header, i) {
  const h = headers[i];
  return header && h ? h : `Column ${i + 1}`;
}
export const columnOptions = (headers, header) => headers.map((_, i) => ({value: i, label: columnLabel(headers, header, i)}));

export default defineDialog({
  id: 'dialog.tableSort',
  title: 'Sort',
  command: 'table.sort',
  init(ctx) {
    const S = T.open(ctx);
    const [tp] = T.cell(S);
    const first = S.d.table(S.sel.focus.story, tp)?.rows[0];
    const headers = (first?.cells ?? []).map(c => T.cellText(c).replace(/\n/g, ' ').trim());
    return {column: 0, order: 'ascending', header: first?.props?.header ? 'yes' : 'no', headers};
  },
  validate(v) {
    const n = (v.headers ?? []).length;
    return Number.isInteger(v.column) && v.column >= 0 && v.column < Math.max(n, 1) ? [] : [{field: 'column', message: 'Choose a column to sort by.'}];
  },
  toCommand(v) {
    return {command: 'table.sort', params: {column: v.column, descending: v.order === 'descending', header: v.header === 'yes'}};
  },
});
