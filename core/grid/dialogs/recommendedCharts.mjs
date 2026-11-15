// Insert Chart dialog model (submit: insert.chart).
// Excel's Insert Chart (Recommended Charts and All Charts tabs, with a preview of the chart on the
// selected data) on gridcraft's chart dialog (crates/ui-egui/src/dialogs/charts.rs) and
// cmd/insert/chart.rs (`recommend_charts`, `build_chart`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: recommendations (the chosen entry of the Recommended Charts list), types (the chosen type
// on All Charts), pick (which of the two was chosen last), list (the recommended labels).

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {engineFor} from '../model/calc.mjs';
import {recommendCharts, chartAreasFor} from '../lib/chart-build.mjs';
import {resolveChart} from '../lib/chart-resolve.mjs';
import {render} from '../lib/chart-render.mjs';
import {buildChart} from '../commands/insert/charts.mjs';
import {chartKind} from '../lib/chart-build.mjs';
import {sampleChart} from '../lib/chart-sample.mjs';

/** The All Charts list: label, type, subtype. */
export const ALL_CHARTS = Object.freeze([
  ['Clustered Column', 'column', ''], ['Stacked Column', 'column', 'stacked'], ['100% Stacked Column', 'column', 'stacked100'],
  ['Clustered Bar', 'bar', ''], ['Stacked Bar', 'bar', 'stacked'], ['100% Stacked Bar', 'bar', 'stacked100'],
  ['Line', 'line', ''], ['Line with Markers', 'line', 'markers'], ['Stacked Line', 'line', 'stacked'],
  ['Pie', 'pie', ''], ['Pie of Pie', 'pie', 'ofPie'], ['Bar of Pie', 'pie', 'barOfPie'], ['3-D Pie', 'pie', '3d'], ['Doughnut', 'doughnut', ''],
  ['Area', 'area', ''], ['Stacked Area', 'area', 'stacked'], ['100% Stacked Area', 'area', 'stacked100'],
  ['Scatter', 'scatter', ''], ['Scatter with Smooth Lines and Markers', 'scatter', 'smooth'], ['Scatter with Straight Lines and Markers', 'scatter', 'linesMarkers'], ['Scatter with Lines', 'scatter', 'lines'], ['Bubble', 'bubble', ''], ['3-D Bubble', 'bubble', '3d'],
  ['Radar', 'radar', ''], ['Histogram', 'histogram', ''], ['Pareto', 'pareto', ''], ['Waterfall', 'waterfall', ''], ['Funnel', 'funnel', ''], ['Combo', 'combo', ''],
  ['Stock', 'stock', ''], ['Treemap', 'treemap', ''], ['Sunburst', 'sunburst', ''], ['Box & Whisker', 'boxWhisker', ''],
]);

/** The All Charts rail: category, the charts under it, and what the category is for (shown under the preview). */
export const CATEGORIES = Object.freeze([
  ['Column', ['Clustered Column', 'Stacked Column', '100% Stacked Column'], 'Use this chart type to compare values across a few categories.'],
  ['Line', ['Line', 'Line with Markers', 'Stacked Line'], 'Use this chart type to show trends over time or ordered categories.'],
  ['Pie', ['Pie', 'Pie of Pie', 'Bar of Pie', '3-D Pie', 'Doughnut'], 'Use this chart type to show the parts of a whole when there are few categories.'],
  ['Bar', ['Clustered Bar', 'Stacked Bar', '100% Stacked Bar'], 'Use this chart type to compare values when the category names are long.'],
  ['Area', ['Area', 'Stacked Area', '100% Stacked Area'], 'Use this chart type to show how the total changes and what makes it up.'],
  ['X Y (Scatter)', ['Scatter', 'Scatter with Smooth Lines and Markers', 'Scatter with Straight Lines and Markers', 'Scatter with Lines', 'Bubble', '3-D Bubble'], 'Use this chart type to compare pairs of values; a bubble adds a third value as its size.'],
  ['Stock', ['Stock'], 'Use this chart type to show the open, high, low and close of a price.'],
  ['Radar', ['Radar'], 'Use this chart type to compare several values around a centre.'],
  ['Treemap', ['Treemap'], 'Use this chart type to show a hierarchy as nested rectangles.'],
  ['Sunburst', ['Sunburst'], 'Use this chart type to show a hierarchy as rings.'],
  ['Histogram', ['Histogram', 'Pareto'], 'Use this chart type to show how often values fall in each range; a Pareto adds the running total.'],
  ['Box & Whisker', ['Box & Whisker'], 'Use this chart type to show the spread of values and their quartiles.'],
  ['Waterfall', ['Waterfall'], 'Use this chart type to show a running total as values are added and taken away.'],
  ['Funnel', ['Funnel'], 'Use this chart type to show values falling through stages.'],
  ['Combo', ['Combo'], 'Use this chart type to draw some series as columns and others as lines.'],
]);

const find = label => ALL_CHARTS.find(([l]) => l === label) ?? null;

function choice(v) {
  const label = v.pick === 'types' ? v.types : v.recommendations;
  const hit = find(label) ?? find(v.recommendations) ?? find(v.types);
  return hit ? {type: hit[1], subtype: hit[2]} : {type: 'column', subtype: ''};
}

export default defineDialog({
  id: 'dialog.recommendedCharts',
  title: 'Insert Chart',
  command: 'insert.chart',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    let list = [];
    try { list = recommendCharts(content, sel.sheet, chartAreasFor(content, sel.sheet, sel, null), engineFor(content)).map(([, , label]) => label); } catch { list = []; }
    const first = list[0] ?? 'Clustered Column';
    // With no data to recommend from the dialog opens on All Charts, where the previews use sample data (Excel's own).
    return {recommendations: first, types: first, pick: list.length ? 'recommendations' : 'types', list, hasData: list.length > 0, tab: list.length ? 0 : 1};
  },
  derive: (v, changed) => (changed.includes('types') ? {pick: 'types'} : changed.includes('recommendations') ? {pick: 'recommendations'} : {}),
  validate: v => (v.hasData === false ? [{field: 'recommendations', message: 'Select the data for the chart first; the previews use sample data.'}] : v.list?.length || v.pick === 'types' ? [] : [{field: 'recommendations', message: 'Select data for the chart first.'}]),
  preview(ctx, v) {
    try {
      const {type, subtype} = choice(v);
      const {si, chart} = buildChart(ctx, {type, subtype});
      const content = baseDoc(ctx);
      const w = 300, h = 190;
      return {w, h, prims: render(chart, resolveChart(content, si, chart), w, h)};
    } catch {
      try {
        const {type, subtype} = choice(v);
        const {chart, data} = sampleChart(chartKind(type, subtype));
        return {w: 300, h: 190, prims: render(chart, data, 300, 190)};
      } catch { return null; }
    }
  },
  toCommand: v => ({command: 'insert.chart', params: choice(v)}),
});
