// Report Connections dialog model (Slicer > Slicer > Report Connections; submit: slicer.reportConnections): Excel's list of the
// workbook's PivotTables with a check box for each one the slicer filters. Not in gridcraft (its slicers filter tables): Excel's own
// behaviour, not checked against upstream.
//
// Values: slicer (id), caption, pivots (every PivotTable: {name, sheet}), connected (the checked names).

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';
import {selectedObject} from '../lib/objects.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {isPivotSlicer, slicerPivots} from '../lib/slicer.mjs';

export default defineDialog({
  id: 'dialog.reportConnections',
  title: 'Report Connections',
  command: 'slicer.reportConnections',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = selectedObject(content, ctx.selection);
    const list = sel?.kind === 'slicer' ? content.sheets[sel.si].slicers : content.sheets[gridSel(ctx).sheet].slicers;
    const sl = sel?.kind === 'slicer' ? list.find(x => x.id === sel.id) : list?.[list.length - 1];
    if (!sl || !isPivotSlicer(sl)) throw failed('Select a slicer on a PivotTable first.');
    const pivots = content.sheets.flatMap(sh => (sh.pivots ?? []).map(pt => ({name: pt.name, sheet: sh.name})));
    return {slicer: sl.id, caption: sl.caption ?? sl.field, pivots, connected: slicerPivots(sl)};
  },
  validate: v => ((v.connected ?? []).length ? [] : [{field: 'connected', message: 'Select at least one PivotTable.'}]),
  toCommand: v => ({command: 'slicer.reportConnections', params: {slicer: Number(v.slicer), pivots: v.connected}}),
});
