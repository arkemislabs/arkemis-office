// Insert › Table › Insert Table… (submit: insert.table, then table.autofit for an AutoFit choice).
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`insert_table_dialog`: columns
// 1–63, rows 1–1000, OK runs insert.table) at aadb077e072b7de05f724e359d8db82e151f125c; Word adds
// the AutoFit behavior (Fixed column width: Auto / AutoFit to contents / AutoFit to window). Word's
// "Remember dimensions for new tables" has no upstream command or option and is not offered.
// Default 5 × 2, as Word.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

const int = v => (typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10));

export default defineDialog({
  id: 'dialog.insertTable',
  title: 'Insert Table',
  command: 'insert.table',
  init(ctx) {
    void ctx;
    return {cols: 5, rows: 2, autofit: 'fixed'};
  },
  validate(v) {
    const out = [];
    const c = int(v.cols), r = int(v.rows);
    if (!(c >= 1 && c <= 63)) out.push({field: 'cols', message: 'The number must be between 1 and 63.'});
    if (!(r >= 1 && r <= 32767)) out.push({field: 'rows', message: 'The number must be between 1 and 32767.'});
    return out;
  },
  toCommand(v) {
    const params = {rows: int(v.rows), cols: int(v.cols)};
    if (v.autofit === 'contents' || v.autofit === 'window') {
      return {batch: [{command: 'insert.table', params}, {command: 'table.autofit', params: {mode: v.autofit}}]};
    }
    return {command: 'insert.table', params};
  },
});
