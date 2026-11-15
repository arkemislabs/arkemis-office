// Create PivotChart dialog model (submit: insert.pivotChart).
// Excel's Create PivotChart (Table/Range, New Worksheet or Existing Worksheet with its Location): the same questions as Create
// PivotTable, the answer a blank PivotTable and its chart (core/grid/commands/insert/pivotchart.mjs; gridcraft charts an existing
// PivotTable only). Not checked against upstream.
//
// Values: source (a range such as Sheet1!$A$1:$E$200, or a table name), destination ('new' or 'existing'), location (Sheet1!$H$3).

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultSource} from '../commands/pivot.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {a1, parseRange} from '../lib/addr.mjs';

export default defineDialog({
  id: 'dialog.createPivotChart',
  title: 'Create PivotChart',
  command: 'insert.pivotChart',
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
  toCommand: v => ({command: 'insert.pivotChart', params: {source: String(v.source).trim(), destination: v.destination === 'existing' ? String(v.location).trim() : 'new', withTable: true}}),
});
