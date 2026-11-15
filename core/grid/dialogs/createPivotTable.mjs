// Create PivotTable dialog model (submit: insert.pivotTable; Table Design > Summarize with PivotTable opens it too).
// Excel's Create PivotTable (Table/Range, New Worksheet or Existing Worksheet with its Location) over gridcraft's
// cmd/pivot/create.rs (`insert_pivot_table`: the source, a new sheet at A3 or a cell) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Values: source (a range such as Sheet1!$A$1:$E$200, or a table name), destination ('new' or 'existing'), location (Sheet1!$H$3).

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultSource} from '../commands/pivot.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {a1, parseRange} from '../lib/addr.mjs';

export default defineDialog({
  id: 'dialog.createPivotTable',
  title: 'PivotTable from table or range',
  command: 'insert.pivotTable',
  init(ctx) {
    let source = '';
    try { source = defaultSource(ctx); } catch { /* the person types it */ }
    const sel = gridSel(ctx);
    const sheet = baseDoc(ctx).sheets[sel.sheet].name;
    return {source, destination: 'new', location: `'${sheet.replace(/'/g, "''")}'!${a1(sel.active.row, sel.active.col)}`};
  },
  validate(v) {
    const errors = [];
    if (!String(v.source ?? '').trim()) errors.push({field: 'source', message: "The PivotTable reference isn't valid. Enter a range or a table name."});
    if (v.destination === 'existing') {
      const at = String(v.location ?? '').replace(/^.*!/, '').replace(/\$/g, '');
      if (!parseRange(at)) errors.push({field: 'location', message: 'Enter the cell where the PivotTable report goes, for example Sheet1!$H$3.'});
    }
    return errors;
  },
  toCommand: v => ({command: 'insert.pivotTable', params: {source: String(v.source).trim(), destination: v.destination === 'existing' ? String(v.location).trim() : 'new'}}),
});
