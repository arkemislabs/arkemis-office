// Move Chart dialog model (submit: chart.move): the sheet the chart goes to and its top-left cell.
// gridcraft moves a chart with `chart.move {sheet, at}` (cmd/extra/chart.rs `move_chart`) and has no dialog; Excel's
// Move Chart asks where to place it (Object in a sheet). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: chart (its id), toSheet (a sheet name; empty keeps the sheet), at (a cell; empty keeps the position).

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {findChart} from '../commands/insert/charts.mjs';

export default defineDialog({
  id: 'dialog.moveChart',
  title: 'Move Chart',
  command: 'chart.move',
  init(ctx) {
    const hit = findChart(ctx, {});
    return {chart: hit.object.id, toSheet: baseDoc(ctx).sheets[gridSel(ctx).sheet].name, at: hit.object.anchor.cell};
  },
  validate: () => [],
  toCommand: v => ({command: 'chart.move', params: {chart: v.chart, ...(String(v.toSheet ?? '').trim() ? {toSheet: String(v.toSheet).trim()} : {}), ...(String(v.at ?? '').trim() ? {at: String(v.at).trim()} : {})}}),
});
