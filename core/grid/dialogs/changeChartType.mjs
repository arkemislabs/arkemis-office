// Change Chart Type dialog model (submit: chart.changeType): the types the Insert Chart dialog lists under All Charts.
// gridcraft's list (crates/ui-egui/src/dialogs/charts.rs `ALL_CHARTS`) at fb1e59f; Excel's dialog is the same list over the
// chart. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: chart (its id), choice ("column", "column|stacked": the type and subtype).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findChart} from '../commands/insert/charts.mjs';

/** Every chart type of All Charts: [type, subtype, label]. */
export const ALL_CHARTS = Object.freeze([
  ['column', '', 'Clustered Column'], ['column', 'stacked', 'Stacked Column'], ['column', 'stacked100', '100% Stacked Column'],
  ['bar', '', 'Clustered Bar'], ['bar', 'stacked', 'Stacked Bar'], ['bar', 'stacked100', '100% Stacked Bar'],
  ['line', '', 'Line'], ['line', 'markers', 'Line with Markers'], ['line', 'stacked', 'Stacked Line'],
  ['pie', '', 'Pie'], ['doughnut', '', 'Doughnut'],
  ['area', '', 'Area'], ['area', 'stacked', 'Stacked Area'], ['area', 'stacked100', '100% Stacked Area'],
  ['scatter', '', 'Scatter'], ['scatter', 'lines', 'Scatter with Lines'], ['radar', '', 'Radar'],
  ['histogram', '', 'Histogram'], ['waterfall', '', 'Waterfall'], ['funnel', '', 'Funnel'], ['combo', '', 'Combo'],
]);
const key = (t, s) => `${t}|${s}`;

export default defineDialog({
  id: 'dialog.changeChartType',
  title: 'Change Chart Type',
  command: 'chart.changeType',
  init(ctx) {
    const hit = findChart(ctx, {});
    return {chart: hit.object.id, choice: key('column', ''), kind: hit.object.kind};
  },
  validate: v => (ALL_CHARTS.some(([t, s]) => key(t, s) === v.choice) ? [] : [{field: 'choice', message: 'Choose a chart type.'}]),
  toCommand: v => { const [type, subtype] = String(v.choice).split('|'); return {command: 'chart.changeType', params: {chart: v.chart, type, subtype}}; },
});
