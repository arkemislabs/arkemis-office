// Table Layout › Merge › Split Cells (submit: table.split).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/table.rs (`SplitCellsForm`:
// read (defaults twice the selected columns and the selected rows; Merge cells before split offered
// and on for several cells or one merged across columns), set_merge, check (Word's "The number
// must be between 1 and n." / "a divisor of n"), params) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {splitTargets} from '../commands/table.mjs';
import {cellAtGrid, cellSpan, verticalExtent} from '../model/table.mjs';

const int = v => (typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10));

export default defineDialog({
  id: 'dialog.splitCells',
  title: 'Split Cells',
  command: 'table.split',
  init(ctx) {
    const S = T.open(ctx);
    const [tp] = T.cell(S);
    const cells = [...new Map(T.selectedCells(S).map(c => [`${c[0]},${c[1]}`, c])).values()];
    const rows = [...new Set(cells.map(([r]) => r))];
    const perRow = Math.max(1, ...rows.map(r => cells.filter(c => c[0] === r).length));
    const targets = splitTargets(S);
    const t = S.d.table(S.sel.focus.story, tp);
    let span = 1, height = 1;
    if (targets.length === 1 && t) {
      const [top, g] = targets[0];
      const ci = cellAtGrid(t, top, g);
      if (ci !== null && ci !== undefined) { span = cellSpan(t.rows[top]?.cells[ci]); height = verticalExtent(t, top, ci)?.[1] ?? 1; }
    }
    // Word offers Merge for one cell merged across columns too.
    const several = targets.length > 1 || span > 1;
    const maxRows = targets.length > 1 ? Math.max(1, Math.min(rows.length, 63)) : 1;
    const defaultColumns = Math.max(2, Math.min(perRow * 2, 63));
    return {cols: defaultColumns, rows: maxRows, merge: several, several, cells: Math.max(1, targets.length), height: Math.max(1, height), maxRows, defaultColumns};
  },
  derive(v, changed) {
    // Unticked, each cell splits into two columns in its own row, as Word resets the boxes (set_merge).
    if (!changed.includes('merge')) return {};
    const on = !!v.merge && !!v.several;
    return on ? {merge: true, cols: v.defaultColumns, rows: v.maxRows} : {merge: false, cols: 2, rows: 1};
  },
  validate(v) {
    const out = [];
    const c = int(v.cols), r = int(v.rows);
    if (!(c >= 1 && c <= 63)) out.push({field: 'cols', message: 'The number must be between 1 and 63.'});
    if (!(r >= 1 && r <= 63)) { out.push({field: 'rows', message: 'The number must be between 1 and 63.'}); return out; }
    const limit = v.cells > 1 && v.merge ? v.maxRows : v.cells <= 1 && v.height > 1 ? v.height : null;
    if (limit !== null && r > limit) out.push({field: 'rows', message: `The number must be between 1 and ${limit}.`});
    else if (v.cells <= 1 && v.height > 1 && r > 1 && v.height % r !== 0) out.push({field: 'rows', message: `The number must be a divisor of ${v.height}.`});
    return out;
  },
  toCommand(v) {
    return {command: 'table.split', params: {columns: int(v.cols), rows: int(v.rows), mergeFirst: !!(v.several && v.merge)}};
  },
});
