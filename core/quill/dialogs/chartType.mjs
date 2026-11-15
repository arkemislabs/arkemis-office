// Insert › Illustrations › Chart (Insert Chart) and Chart Design › Type › Change Chart Type (Change Chart Type): the list of chart
// types with a preview of the chart on its sample data, drawn by the chart renderer Grid uses (so the preview is the chart that goes in).
// OK runs insert.chart / chart.type with the chosen `type`.
//
// Over wordcraft crates/ui-egui/src/dialogs/dialogs_chart.rs (the nine types it offers) and Grid's All Charts list
// (core/grid/dialogs/recommendedCharts.mjs: the kinds the renderer draws). Word's Recent and Templates tabs, Map and Surface are not offered.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Drawn by src/apps/quill/dialogs/chartType.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {sampleChart, chartTypeLabel} from '../model/chart.mjs';
import {chartPrims, gridTheme} from '../lib/chart-draw.mjs';
import {selectedObjects} from '../context.mjs';
import {selectionPositions} from '../address.mjs';
import {ordered} from '../lib/caret-session.mjs';

/** The types the list offers, in Word's order: [label, type]. */
export const CHART_LIST = Object.freeze([
  ['Clustered Column', 'column'], ['Stacked Column', 'columnStacked'], ['100% Stacked Column', 'columnStacked100'],
  ['Clustered Bar', 'bar'], ['Stacked Bar', 'barStacked'], ['100% Stacked Bar', 'barStacked100'],
  ['Line', 'line'], ['Line with Markers', 'lineMarkers'], ['Stacked Line', 'lineStacked'],
  ['Pie', 'pie'], ['Doughnut', 'doughnut'],
  ['Area', 'area'], ['Stacked Area', 'areaStacked'], ['100% Stacked Area', 'areaStacked100'],
  ['Scatter', 'scatter'], ['Scatter with Lines', 'scatterLines'],
  ['Radar', 'radar'], ['Histogram', 'histogram'], ['Waterfall', 'waterfall'], ['Funnel', 'funnel'], ['Combo', 'combo'],
  ['Stock', 'stock'], ['Treemap', 'treemap'], ['Sunburst', 'sunburst'], ['Box & Whisker', 'boxWhisker'],
]);
const typeOf = label => (CHART_LIST.find(([l]) => l === label) ?? CHART_LIST[0])[1];
const labelOf = type => (CHART_LIST.find(([, t]) => t === type) ?? [chartTypeLabel(type)])[0];

/** The preview of a chart type: {w, h, prims}. */
export function previewOf(ctx, type, w = 300, h = 190) {
  const spec = {...sampleChart(type), title: 'Chart Title'};
  return {w, h, prims: chartPrims(spec, w, h, gridTheme(ctx?.doc?.settings?.themeColors))};
}

/** Both boxes share their fields; `change` makes OK change the selected chart's type. */
function chartTypeDialog(id, title, command, change) {
  return defineDialog({
    id, title, command,
    init(ctx) {
      let type = 'column';
      if (change) { try { type = currentType(ctx) ?? 'column'; } catch { type = 'column'; } }
      return {type: labelOf(type)};
    },
    validate: () => [],
    preview: (ctx, v) => previewOf(ctx, typeOf(v.type)),
    toCommand: v => ({command, params: {type: typeOf(v.type)}}),
  });
}

/** The type of the chart the selection is on (Change Chart Type opens on it), or null. */
function currentType(ctx) {
  const ranges = selectionPositions(ctx.doc, ctx.selection);
  const r = ranges[ctx.selection?.primary ?? 0] ?? ranges[0];
  if (!r) return null;
  const [a, b] = ordered({anchor: r.anchor, focus: r.focus});
  if (a.story !== b.story) return null;
  return selectedObjects(ctx.doc, a, b, 1, o => o?.type === 'graphic' && !!o.graphic?.chart)[0]?.obj.graphic.chart.type ?? null;
}

export {chartTypeDialog};
export default chartTypeDialog('dialog.chartType', 'Change Chart Type', 'chart.type', true);
