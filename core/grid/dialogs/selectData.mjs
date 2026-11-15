// Select Data Source dialog model (submit: chart.selectData): the chart data range, the horizontal axis labels, the
// series to drop, and Switch Row/Column. gridcraft's dialog (crates/ui-egui/src/dialogs/charts.rs `select_data`,
// dialogs.rs `selectData`) lists the range, each series with a keep box and the category range, and runs
// `chart.selectData` when something changed. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range, categories, series (the series names, for the list), remove (the numbers of the series to drop,
// as typed: "2, 3"), chart (its id).

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {findChart} from '../commands/insert/charts.mjs';
import {resolveChart} from '../lib/chart-resolve.mjs';

export default defineDialog({
  id: 'dialog.selectData',
  title: 'Select Data Source',
  command: 'chart.selectData',
  init(ctx) {
    const hit = findChart(ctx, {});
    let names = [];
    try { names = resolveChart(baseDoc(ctx), hit.si, hit.object).series.map(x => x.name); } catch { names = (hit.object.series ?? []).map((x, i) => x.name || `Series${i + 1}`); }
    const first = (hit.object.series ?? []).find(x => x.categories)?.categories ?? '';
    return {chart: hit.object.id, range: hit.object.source ?? '', categories: first, series: names, remove: ''};
  },
  validate: v => {
    const bad = String(v.remove ?? '').split(/[,\s]+/).filter(Boolean).find(x => !/^\d+$/.test(x) || Number(x) < 1 || Number(x) > (v.series ?? []).length);
    return bad ? [{field: 'remove', message: `There is no series ${bad}.`}] : [];
  },
  toCommand: v => ({
    command: 'chart.selectData',
    params: {chart: v.chart,
      ...(String(v.range ?? '').trim() ? {range: String(v.range).trim()} : {}),
      categories: String(v.categories ?? '').trim(),
      ...(String(v.remove ?? '').trim() ? {removeSeries: String(v.remove).split(/[,\s]+/).filter(Boolean).map(x => Number(x) - 1)} : {})},
  }),
});
