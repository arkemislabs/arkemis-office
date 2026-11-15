// Filter Connections dialog model (PivotTable Analyze > Filter > Filter Connections; submit: pivot.filterConnections): Excel's list
// of the PivotTable slicers with a check box for each one that filters this PivotTable. Not in gridcraft: Excel's own behaviour,
// not checked against upstream.
//
// Values: pivot (name), slicers ([{id, caption, field, sheet, on}]), connected (checked slicer ids).

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';
import {isPivotSlicer, slicerPivots} from '../lib/slicer.mjs';
import {pivotUnderSelection} from '../commands/slicer.mjs';

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export default defineDialog({
  id: 'dialog.filterConnections',
  title: 'Filter Connections',
  command: 'pivot.filterConnections',
  init(ctx) {
    const hit = pivotUnderSelection(ctx);
    if (!hit) throw failed('Select a cell in a PivotTable first.');
    const pt = hit[2];
    const slicers = baseDoc(ctx).sheets.flatMap(sh => (sh.slicers ?? []).filter(isPivotSlicer).map(sl => ({id: sl.id, caption: sl.caption ?? sl.field, field: sl.field, sheet: sh.name, on: slicerPivots(sl).some(n => eq(n, pt.name))})));
    return {pivot: pt.name, slicers, connected: slicers.filter(x => x.on).map(x => x.id)};
  },
  validate: () => [],
  toCommand: v => ({command: 'pivot.filterConnections', params: {pivot: String(v.pivot), slicers: (v.connected ?? []).map(Number)}}),
});
