// Insert Table (submit: insert.table): number of columns and rows.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs `dlg_table` (insert.table
// {rows, cols}, 5 × 2 by default, 1–75 each as cmd/insert.rs clamps) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

const int = v => (typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10));

export default defineDialog({
  id: 'dialog.table',
  title: 'Insert Table',
  command: 'insert.table',
  init() { return {cols: 5, rows: 2}; },
  validate(v) {
    const out = [];
    if (!(int(v.cols) >= 1 && int(v.cols) <= 75)) out.push({field: 'cols', message: 'Enter a number of columns from 1 to 75.'});
    if (!(int(v.rows) >= 1 && int(v.rows) <= 75)) out.push({field: 'rows', message: 'Enter a number of rows from 1 to 75.'});
    return out;
  },
  toCommand(v) { return {command: 'insert.table', params: {rows: int(v.rows), cols: int(v.cols)}}; },
});
