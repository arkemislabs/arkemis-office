// Insert Timelines dialog model (submit: insert.timeline): Excel's check list of the date fields of the PivotTable, one timeline for each one checked.
// Not in gridcraft: Excel's behaviour, not checked against upstream.
//
// Values: pivot (the PivotTable's name), heads (its date fields), columns (the checked names).

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';
import {pivotUnderSelection} from '../commands/slicer.mjs';
import {dateFields} from '../commands/timeline.mjs';

export default defineDialog({
  id: 'dialog.insertTimelines',
  title: 'Insert Timelines',
  command: 'insert.timeline',
  init(ctx) {
    const hit = pivotUnderSelection(ctx);
    if (!hit) throw failed('Select a cell in a PivotTable first.');
    const heads = dateFields(baseDoc(ctx), hit[0], hit[2]);
    if (!heads.length) throw failed('The PivotTable has no field that holds dates, so it cannot have a timeline.');
    return {pivot: hit[2].name, heads, columns: heads.slice(0, 1)};
  },
  validate: v => ((v.columns ?? []).length ? [] : [{field: 'columns', message: 'Select at least one date field.'}]),
  toCommand: v => ({command: 'insert.timeline', params: {pivot: String(v.pivot), column: (v.heads ?? []).filter(h => (v.columns ?? []).includes(h))}}),
});
