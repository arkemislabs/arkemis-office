// Create Custom Combo Chart (submit: insert.chartCustomCombo): Excel's Custom Combination, a chart type and a Secondary Axis box for
// each series of the selected data, with a preview of the chart that results. Not checked against upstream (gridcraft's combo has no
// per-series choice).
//
// Values: names (the series' names), kinds (the chart type of each), secondary (whether each is on the secondary axis).

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {resolveChart} from '../lib/chart-resolve.mjs';
import {render} from '../lib/chart-render.mjs';
import {buildChart} from '../commands/insert/charts.mjs';
import {defaultComboKind} from '../commands/insert/charts3.mjs';

export default defineDialog({
  id: 'dialog.customCombo',
  title: 'Insert Chart',
  command: 'insert.chartCustomCombo',
  init(ctx) {
    try {
      const {si, chart} = buildChart(ctx, {type: 'combo', kind: 'combo'});
      const names = resolveChart(baseDoc(ctx), si, chart).series.map(x => x.name);
      return {names, kinds: names.map((_, i) => defaultComboKind(i)), secondary: names.map(() => false)};
    } catch { return {names: [], kinds: [], secondary: []}; }
  },
  validate: v => (Array.isArray(v.names) && v.names.length ? [] : [{field: 'names', message: 'Select data for the chart first.'}]),
  preview(ctx, v) {
    try {
      const {si, chart} = buildChart(ctx, {type: 'combo', kind: 'combo'});
      chart.series = chart.series.map((x, i) => ({...x, kind: v.kinds?.[i] ?? defaultComboKind(i), secondary: v.secondary?.[i] === true}));
      const w = 300, h = 190;
      return {w, h, prims: render(chart, resolveChart(baseDoc(ctx), si, chart), w, h)};
    } catch { return null; }
  },
  toCommand: v => ({command: 'insert.chartCustomCombo', params: {types: (v.names ?? []).map((_, i) => ({kind: v.kinds?.[i] ?? defaultComboKind(i), secondary: v.secondary?.[i] === true}))}}),
});
