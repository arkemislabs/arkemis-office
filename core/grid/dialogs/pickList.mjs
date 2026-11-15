// Pick From Drop-down List (Alt+Down, the cell menu): the distinct text entries of the column
// around the active cell; the one picked is entered in the cell (cell.set).
// Translated from gridcraft crates/ui-egui/src/dialogs/show.rs (pick list: the entries above and
// below in the column, sorted, without duplicates) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection} from '../model/workbook.mjs';
import {cellAt} from '../model/store.mjs';
import {a1} from '../lib/addr.mjs';
import {cellText} from '../lib/edit-clip.mjs';

/** The text entries of the contiguous run of cells above and below the active cell, sorted, unique. */
export function pickListEntries(content, si, at) {
  const sheet = content.sheets[si];
  const filled = row => { const c = cellAt(sheet, row, at.col); return !!c && (c.f !== undefined || (c.v !== undefined && c.v !== null && c.v !== '')); };
  const seen = new Map();
  const take = row => {
    const c = cellAt(sheet, row, at.col);
    if (!c || c.f !== undefined || typeof c.v !== 'string') return;
    const t = cellText(content, si, row, at.col);
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  };
  for (let r = at.row - 1; r >= 0 && filled(r); r--) take(r);
  for (let r = at.row + 1; r < 1_048_576 && filled(r); r++) take(r);
  return [...seen.values()].sort((x, y) => x.localeCompare(y, undefined, {sensitivity: 'base'}));
}

export default defineDialog({
  id: 'dialog.pickList',
  title: 'Pick From List',
  command: 'cell.set',
  init(ctx) {
    const sel = fromKernelSelection(ctx.doc, ctx.selection);
    const sheet = ctx.doc.sheets[sel.sheet];
    return {value: null, items: pickListEntries(ctx.doc, sel.sheet, sel.active), cell: `/sh:${encodeURIComponent(sheet.id)}/${a1(sel.active.row, sel.active.col)}`};
  },
  validate: v => (typeof v.value === 'string' && v.value ? [] : [{field: 'value', message: 'Pick an entry'}]),
  toCommand: v => ({command: 'cell.set', params: {cell: v.cell, input: v.value}}),
});
