// Insert > Charts > Create Custom Combo Chart: a combo chart with a chart type chosen for each series and,
// for each, whether it sits on the secondary axis. Not checked against upstream: gridcraft's Combo plots
// the first series as columns and the rest as lines; Excel's custom combination (Insert Chart > All Charts >
// Combo > Custom Combination) picks both per series, which the combo renderer already draws (a series'
// `kind` and `secondary`). U:grid/insert.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {objectSelection, ANCHOR_MODES} from '../../lib/objects.mjs';
import {buildChart} from './charts.mjs';

/** The types a series of a custom combination can take, as Excel lists them (the cartesian column, line and area family). */
export const COMBO_KINDS = Object.freeze([
  ['columnClustered', 'Clustered Column'], ['columnStacked', 'Stacked Column'], ['columnStacked100', '100% Stacked Column'],
  ['line', 'Line'], ['lineMarkers', 'Line with Markers'], ['lineStacked', 'Stacked Line'],
  ['area', 'Area'], ['areaStacked', 'Stacked Area'], ['areaStacked100', '100% Stacked Area'],
]);
const KIND_IDS = COMBO_KINDS.map(k => k[0]);
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

/** The default type of series `i`: columns first, lines after (the Combo chart's own default). */
export const defaultComboKind = i => (i === 0 ? 'columnClustered' : 'line');

function customCombo(ctx, p) {
  const {si, chart} = buildChart(ctx, {...p, type: 'combo', kind: 'combo'});
  requireSchema2(ctx, si);
  const types = Array.isArray(p.types) ? p.types : [];
  chart.series = chart.series.map((x, i) => {
    const t = types[i] ?? {};
    const out = {...x, kind: KIND_IDS.includes(t.kind) ? t.kind : defaultComboKind(i)};
    if (t.secondary === true) out.secondary = true; else delete out.secondary;
    return out;
  });
  const sheet = ctx.doc.sheets[si];
  setIn(ctx.change, ['sheets', si, 'charts'], [...(sheet.charts ?? []), chart]);
  ctx.setSelection(objectSelection(sheet, 'chart', chart.id));
  return {chart: chart.id, series: chart.series.map(x => ({kind: x.kind, secondary: !!x.secondary}))};
}

export default defineCommands({
  family: 'insert/charts3',
  app: 'grid',
  upstream: {repo: 'office', files: ['Excel Insert > Charts > Create Custom Combo Chart']},
  commands: [
    {id: 'insert.chartCustomCombo', label: 'Create Custom Combo Chart', risk: 'edit', dialog: 'dialog.customCombo',
      description: `Insert a combo chart of the selected data with a type for each series: \`types\`, one {kind, secondary} per series in order; kind ${KIND_IDS.join('|')} (default: columns for the first series, lines after), secondary puts the series on the secondary axis.`,
      params: s.object({range: s.optional(s.string({min: 1, max: 4096})), sheet: SHEET, types: s.optional(s.array(s.object({kind: s.optional(s.enum(KIND_IDS)), secondary: s.optional(s.boolean())}), {max: 255})),
        title: s.optional(s.string({max: 255})), at: s.optional(s.string({max: 100})), width: s.optional(s.number({min: 20, max: 10000})), height: s.optional(s.number({min: 20, max: 10000})), mode: s.optional(s.enum(ANCHOR_MODES))}),
      state: hasDoc, run: customCombo},
  ],
});
