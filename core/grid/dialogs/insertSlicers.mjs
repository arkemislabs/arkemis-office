// Insert Slicers dialog model (submit: insert.slicer): Excel's check list of the table's columns (or, from a PivotTable, of its fields),
// one slicer for each one checked, over gridcraft's cmd/slicer.rs `insert_slicer` at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. PivotTable slicers are Excel's (not in gridcraft; not checked against upstream).
//
// Values: table (or pivot, the PivotTable's name), heads (the table's column names or the PivotTable's fields), columns (the checked names).

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';
import {tableByName, tableRanges} from '../model/sheet.mjs';
import {readSource} from '../lib/pivot.mjs';
import {pivotUnderSelection} from '../commands/slicer.mjs';

export default defineDialog({
  id: 'dialog.insertSlicers',
  title: 'Insert Slicers',
  command: 'insert.slicer',
  init(ctx, args) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    let t = null;
    if (typeof args?.table === 'string') t = tableByName(content, args.table)?.[1] ?? null;
    else {
      t = (content.sheets[sel.sheet].tables ?? []).find(x => { const r = tableRanges(x).range; return sel.active.row >= r.start.row && sel.active.row <= r.end.row && sel.active.col >= r.start.col && sel.active.col <= r.end.col; }) ?? null;
    }
    if (!t) {
      // From a PivotTable's report: its source fields.
      const hit = typeof args?.table === 'string' ? null : pivotUnderSelection(ctx);
      if (hit) {
        let heads = [];
        try { heads = readSource(content, hit[2].source, hit[0]).headers; } catch (e) { throw failed(e.message); }
        return {pivot: hit[2].name, heads, columns: heads.slice(0, 1)};
      }
      throw failed('Select a cell inside a table or a PivotTable first, or pass table.');
    }
    const heads = (t.columns ?? []).map(c => c.name);
    const at = sel.active.col - tableRanges(t).range.start.col;
    return {table: t.name, heads, columns: heads[at] !== undefined ? [heads[at]] : heads.slice(0, 1)};
  },
  validate: v => ((v.columns ?? []).length ? [] : [{field: 'columns', message: 'Select at least one column.'}]),
  toCommand: v => ({command: 'insert.slicer', params: {...(v.pivot ? {pivot: String(v.pivot)} : {table: String(v.table)}), column: (v.heads ?? []).filter(h => (v.columns ?? []).includes(h))}}),
});
