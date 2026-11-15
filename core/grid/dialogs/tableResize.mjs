// Resize Table dialog model (Table Design > Properties > Resize Table; submit: table.resize).
// Excel's "Select the new data range for your table" over gridcraft's cmd/extra/data.rs
// (`table_resize`, the Resize Table dialog of crates/ui-egui/src/dialogs.rs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The command checks the headers stay in their row and the new range overlaps the old one.
//
// Values: table, range.

import {defineDialog} from '../../kernel/dialog.mjs';
import {parseRange, colToLetters, contains} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {tablesOf} from '../lib/table-style.mjs';

const abs = r => `=$${colToLetters(r.start.col)}$${r.start.row + 1}:$${colToLetters(r.end.col)}$${r.end.row + 1}`;
const text = v => String(v ?? '').replace(/[$=]/g, '').replace(/^.*!/, '').trim();

export default defineDialog({
  id: 'dialog.tableResize',
  title: 'Resize Table',
  command: 'table.resize',
  init(ctx) {
    const sel = gridSel(ctx);
    const at = tablesOf(ctx.doc.sheets[sel.sheet]).find(x => contains(x.range, sel.active));
    return {table: at?.table.name ?? '', range: at ? abs(at.range) : ''};
  },
  validate: v => (parseRange(text(v.range)) ? [] : [{field: 'range', message: 'Enter the new data range, for example A1:F20.'}]),
  toCommand: v => ({command: 'table.resize', params: {table: v.table || undefined, range: text(v.range)}}),
});
