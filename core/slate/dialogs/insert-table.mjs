// Insert Table (Insert › Table › Insert Table…; submit: insert.table). OneNote's dialog: Number of
// columns (1–99) and Number of rows (1–500), 2 by 2 to start. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {MAX_COLS, MAX_ROWS} from '../lib/table.mjs';

const int = v => (typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10));

export default defineDialog({
  id: 'dialog.insert-table',
  title: 'Insert Table',
  command: 'insert.table',
  init: () => ({columns: 2, rows: 2}),
  validate(v) {
    const out = [];
    const c = int(v.columns), r = int(v.rows);
    if (!(c >= 1 && c <= MAX_COLS)) out.push({field: 'columns', message: `The number of columns must be between 1 and ${MAX_COLS}.`});
    if (!(r >= 1 && r <= MAX_ROWS)) out.push({field: 'rows', message: `The number of rows must be between 1 and ${MAX_ROWS}.`});
    return out;
  },
  toCommand: v => ({command: 'insert.table', params: {rows: int(v.rows), columns: int(v.columns)}}),
});
