// Chart Format tab: Current Selection (the chart element the Format Selection button and the Format pane act on) and Shape Styles (the chart
// area's fill and border from the same 42 styles as Shape Format), plus the formatting of the chart area and of a series.
//
// wordcraft has no Chart Format formatting (its chart has a title, legend and data labels only); Word's behaviour, not checked against
// upstream. The styles are Shape Format's (shape.quickStyle's `quickStyle`, deckcraft quick_style_for). The chart area's fill and border are
// `areaFill` and `areaLine` on the chart (drawn on the chart's background, saved as c:chartSpace/c:spPr); a series colour is the series'
// own `color`. Format Selection opens the Format pane (view.formatShapePane), which shows the formatting of the chosen element.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/caret-session.mjs';
import {pickChart, chartState, edit} from './chart.mjs';
import {quickStyle} from './objects/shape.mjs';
import {rgbHex} from '../model/props.mjs';
import {open} from '../lib/caret-session.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: T.UPSTREAM_COMMIT, files: []};
const bad = m => new CommandError('invalid_params', m);
const COLOR = s.string({min: 1, max: 16});
const QS_ROWS = ['Colored Outline', 'Colored Fill', 'Light 1 Outline, Colored Fill', 'Subtle Effect', 'Moderate Effect', 'Intense Effect'];
const QS_NAMES = ['Dark 1', 'Accent 1', 'Accent 2', 'Accent 3', 'Accent 4', 'Accent 5', 'Accent 6'];
const hex = c => `#${String(c).replace('#', '').toUpperCase()}`;

/** The elements of a chart Current Selection lists: [{id, label}]. */
export function elementsOf(c) {
  return [{id: 'chartArea', label: 'Chart Area'}, ...(c.title ? [{id: 'title', label: 'Chart Title'}] : []), ...(c.legend ? [{id: 'legend', label: 'Legend'}] : []),
    ...c.series.map((x, i) => ({id: `series:${i}`, label: x.name || `Series ${i + 1}`}))];
}
/** The element the view has picked, if the chart still has it, else the chart area. */
export const elementOf = (c, view) => elementsOf(c).find(e => e.id === view?.chartElement) ?? elementsOf(c)[0];

const chartOf = ctx => { try { return pickChart(open(ctx))?.obj.graphic.chart ?? null; } catch { return null; } };

export default defineCommands({
  family: 'chart-format',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'chart.element', label: 'Chart Elements', risk: 'read', effect: 'view',
      state: ctx => { const st = chartState(ctx); const c = st.enabled ? chartOf(ctx) : null; return c ? {...st, value: elementOf(c, ctx.view).label, options: elementsOf(c).map(e => e.label)} : st; },
      description: 'Current Selection (Chart Format): `element` picks the chart element Format Selection acts on, by name: Chart Area, Chart Title, Legend or a series name (Series 1 …).',
      params: s.object({element: s.optional(s.string({max: 255}))}),
      run(ctx, p) {
        const c = chartOf(ctx);
        if (!c) throw new CommandError('disabled', 'select a chart first');
        const want = String(p.element ?? 'Chart Area').trim().toLowerCase();
        const hit = elementsOf(c).find(e => e.label.toLowerCase() === want || e.id.toLowerCase() === want);
        if (!hit) throw bad(`no chart element \`${p.element}\`: ${elementsOf(c).map(e => e.label).join(', ')}`);
        T.ready(ctx);
        ctx.setView({chartElement: hit.id});
        return {element: hit.label, id: hit.id};
      }},
    {id: 'chart.formatSelection', label: 'Format Selection', risk: 'read', effect: 'view', state: chartState,
      description: 'Format Selection (Chart Format › Current Selection): opens the Format pane on the chosen chart element (Fill & Line for the chart area and a series).',
      params: s.object({}),
      run(ctx) { T.ready(ctx); ctx.setView({formatShapePane: true, formatPaneTab: 'fill'}); return {}; }},
    {id: 'chart.areaFill', label: 'Chart Area Fill', risk: 'edit', state: chartState,
      description: 'Shape Fill for the chart area (Format Chart Area › Fill): `color` RRGGBB, or null for no fill; `auto` puts the default (white) back.',
      params: s.object({color: s.optional(s.nullable(COLOR)), auto: s.optional(s.boolean())}),
      run: (ctx, p) => edit(ctx, c => { if (p.auto) delete c.areaFill; else c.areaFill = p.color ? hex(p.color) : 'none'; })},
    {id: 'chart.areaOutline', label: 'Chart Area Border', risk: 'edit', state: chartState,
      description: 'Shape Outline for the chart area (Format Chart Area › Border): `color` RRGGBB, or null for no line, `width` in points (0–72, default 0.75); `auto` puts the default back.',
      params: s.object({color: s.optional(s.nullable(COLOR)), width: s.optional(s.number({min: 0, max: 72})), auto: s.optional(s.boolean())}),
      run: (ctx, p) => edit(ctx, c => {
        if (p.auto) { delete c.areaLine; return; }
        if (p.color === null) { c.areaLine = 'none'; return; }
        const own = c.areaLine && c.areaLine !== 'none' ? c.areaLine : {color: '#D9D9D9', width: 0.75};
        c.areaLine = {color: p.color ? hex(p.color) : own.color, width: p.width ?? own.width};
      })},
    {id: 'chart.seriesColor', label: 'Series Color', risk: 'edit', state: chartState,
      description: 'Fill for a data series (Format Data Series › Fill): `series` (0-based) takes the colour `color` RRGGBB; null puts the style\'s colour back.',
      params: s.object({series: s.integer({min: 0, max: 254}), color: s.optional(s.nullable(COLOR))}),
      run: (ctx, p) => edit(ctx, c => {
        if (!c.series[p.series]) throw bad(`no series ${p.series}`);
        if (p.color) c.series[p.series].color = hex(p.color); else delete c.series[p.series].color;
      })},
    {id: 'chart.shapeStyle', label: 'Shape Styles', risk: 'edit',
      state: ctx => {
        const st = chartState(ctx);
        if (!st.enabled) return st;
        const theme = ctx.doc?.settings?.themeColors;
        return {...st, value: Array.from({length: 42}, (_, i) => { const q = quickStyle(i, theme); return {id: String(i), label: QS_ROWS[Math.floor(i / 7)] + ' - ' + QS_NAMES[i % 7], group: QS_ROWS[Math.floor(i / 7)], value: i, art: {kind: 'shapeStyle', fill: q.fill, line: q.stroke, lineWidth: q.strokeWidth, shadow: !!q.effects?.shadow}, iconOnly: true}; })};
      },
      description: 'Shape Styles (Chart Format): `index` 0–41, the same styles as Shape Format; the chart area takes the style\'s fill and border (its shadow is not drawn on a chart).',
      params: s.object({index: s.optional(s.integer({min: 0, max: 41}))}),
      run: (ctx, p) => {
        const q = quickStyle(Math.min(Math.max(Math.trunc(p.index ?? 1), 0), 41), ctx.doc?.settings?.themeColors);
        return edit(ctx, c => {
          c.areaFill = hex(rgbHex(q.fill));
          c.areaLine = q.stroke ? {color: hex(rgbHex(q.stroke)), width: q.strokeWidth} : 'none';
        });
      }},
  ],
});

