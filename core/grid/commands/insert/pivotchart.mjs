// Insert > Recommended PivotTables, Insert > PivotChart and the Scatter menu's smooth and straight-line variants.
// Translated from gridcraft crates/engine/src/cmd/pivot/charts.rs (`insert_pivot_chart`, `chart_pivot`, `suggestions`,
// `recommended`) and crates/engine/src/pivot/charts.rs (the PivotChart's series from the report) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/insert.
//
// A PivotChart is an ordinary chart (a floating object) with `pivot: 'Sheet2!PivotTable1'`: its series are the report's item
// columns, rebuilt whenever the report is written again (core/grid/lib/pivot-chart.mjs, called by refreshPivot), and it saves
// into .xlsx with the chart's pivotSource. Recommended PivotTables lists up to five layouts that suit the data and, with `apply`,
// creates the one picked through insert.pivotTable. Differences kept on purpose: PivotChart on a PivotTable with no fields yet
// makes an empty chart that fills as fields are added (Excel), where gridcraft refuses; with no PivotTable under the selection
// Create PivotChart asks for a source and makes a blank PivotTable with its chart.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2} from '../../lib/edit-targets.mjs';
import {bad, baseDoc, failed} from '../../lib/data-common.mjs';
import {a1, parseRange, rangeA1, MAX_COLS} from '../../lib/addr.mjs';
import {nextObjectId, objectSelection, topZ, ANCHOR_MODES} from '../../lib/objects.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import * as pv from '../../lib/pivot.mjs';
import {chartLink, chartSeries} from '../../lib/pivot-chart.mjs';
import {chartKind} from '../../lib/chart-build.mjs';
import {findPivot, defaultSource} from '../pivot.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/pivot/charts.rs', 'crates/engine/src/pivot/charts.rs']};
const PIVOT = s.optional(s.union([s.string({min: 1, max: 255}), s.integer({min: 0})]));

/** The layouts that suit a source (charts.rs `suggestions`): up to five, each {index, title, rows, columns, values}. */
export function suggestions(content, src) {
  const n = src.headers.length;
  const h = i => src.headers[i] ?? '';
  const records = Math.max(1, src.rows.length);
  const isNum = i => !!src.numeric[i], isDate = i => !!src.dates[i];
  const distinct = i => pv.distinctLabels(content, src, i, 'none', 1001).length;
  // Category columns: text with repeats.
  const cats = [], nums = [], dates = [];
  for (let i = 0; i < n; i++) {
    if (!isNum(i)) { const d = distinct(i); if (d >= 1 && (d < records || records <= 2) && d <= 1000) cats.push(i); }
    if (isNum(i) && !isDate(i)) nums.push(i);
    if (isDate(i)) dates.push(i);
  }
  const out = [];
  const push = (title, rows, columns, values) => { if (out.length < 5) out.push({index: out.length, title, rows, columns, values}); };
  const sum = i => ({field: h(i), func: 'sum'});
  if (cats.length && nums.length) push(`Sum of ${h(nums[0])} by ${h(cats[0])}`, [h(cats[0])], [], [sum(nums[0])]);
  if (cats.length > 1 && nums.length) push(`Sum of ${h(nums[0])} by ${h(cats[0])} and ${h(cats[1])}`, [h(cats[0])], [h(cats[1])], [sum(nums[0])]);
  if (dates.length && nums.length) push(`Sum of ${h(nums[0])} by ${h(dates[0])} (quarters)`, [{field: h(dates[0]), group: 'quarters'}], [], [sum(nums[0])]);
  if (cats.length && nums.length > 1) push(`Sum of ${h(nums[0])} and ${h(nums[1])} by ${h(cats[0])}`, [h(cats[0])], [], [sum(nums[0]), sum(nums[1])]);
  if (cats.length) push(`Count of ${h(cats[0])} by ${h(cats[0])}`, [h(cats[0])], [], [{field: h(cats[0]), func: 'count'}]);
  if (cats.length > 1 && nums.length) push(`Average of ${h(nums[0])} by ${h(cats[1])}`, [h(cats[1])], [], [{field: h(nums[0]), func: 'average'}]);
  if (!cats.length && !dates.length && nums.length) push(`Sum of ${h(nums[0])}`, [], [], [sum(nums[0])]);
  return out;
}

/** The `source` of a command: the param (a bare range gets the active sheet's name), else the table or region at the selection. */
export function sourceOf(ctx, p) {
  const t = String(p.source ?? '').trim().replace(/^=/, '');
  if (!t) return defaultSource(ctx);
  const bare = !t.includes('!') && parseRange(t.replace(/\$/g, ''));
  return bare ? pv.rangeText(baseDoc(ctx).sheets[gridSel(ctx).sheet].name, bare) : t;
}

function listFor(ctx, p) {
  const content = baseDoc(ctx);
  const source = sourceOf(ctx, p);
  let src;
  try { src = pv.readSource(content, source, gridSel(ctx).sheet); } catch (e) { throw failed(e.message); }
  return {source, list: suggestions(content, src)};
}

function recommended(ctx, p) {
  const {source, list} = listFor(ctx, p);
  if (!Number.isInteger(p.apply)) return {source, suggestions: list};
  const pick = list[p.apply];
  if (!pick) throw bad('insert.recommendedPivotTables', 'no suggestion with that index');
  const q = {source, rows: pick.rows, columns: pick.columns, values: pick.values};
  if (p.destination !== undefined) q.destination = p.destination;
  if (p.replace !== undefined) q.replace = p.replace;
  const res = ctx.run('insert.pivotTable', q);
  return {...(res && typeof res === 'object' ? res : {}), suggestion: pick};
}

const nextSeq = ctx => (ctx.view?.dialogRequest?.seq ?? 0) + 1;
const MAX_CHART_AT = MAX_COLS - 1;

function pivotChart(ctx, p) {
  let hit = null;
  if (p.withTable !== true && p.source === undefined) { try { hit = findPivot(ctx, p); } catch { hit = null; } }
  if (!hit) {
    // Create PivotChart: where the data is and where the report goes; then a blank PivotTable and its chart.
    if (p.source === undefined) { ctx.setView({dialogRequest: {seq: nextSeq(ctx), id: 'dialog.createPivotChart', init: {withTable: p.withTable === true}}}); return null; }
    const made = ctx.run('insert.pivotTable', {source: p.source, destination: p.destination ?? 'new'});
    if (!made || typeof made.name !== 'string') throw failed('The PivotTable could not be created.');
    const si = ctx.doc.sheets.findIndex(sh => sh.name === made.sheet);
    const pi = (ctx.doc.sheets[si]?.pivots ?? []).findIndex(x => x.name === made.name);
    if (si < 0 || pi < 0) throw failed('The PivotTable could not be created.');
    hit = [si, pi];
  }
  const [si, pi] = hit;
  requireSchema2(ctx, si);
  // The document as the nested insert.pivotTable left it.
  const content = ctx.doc;
  const sheet = content.sheets[si];
  const pt = sheet.pivots[pi];
  if (!pt.lastRange) throw failed('Refresh the PivotTable before adding a PivotChart.');
  const area = parseRange(pt.lastRange);
  let out;
  try { out = pv.compute(content, pt, si); } catch (e) { throw failed(e.message); }
  const series = chartSeries(sheet.name, area.start, out);
  const kind = chartKind(p.type ?? 'column', p.subtype ?? '');
  const at = typeof p.at === 'string' && parseRange(p.at.replace(/\$/g, '')) ? parseRange(p.at.replace(/\$/g, '')).start : {row: area.start.row, col: Math.min(MAX_CHART_AT, area.end.col + 2)};
  const pie = kind === 'pie' || kind === 'doughnut';
  const id = nextObjectId(content);
  const chart = {
    id, kind, ...topZ(sheet),
    anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: p.width ?? 480, height: p.height ?? 288, mode: ANCHOR_MODES.includes(p.mode) ? p.mode : 'moveAndSize'},
    series, legend: pie ? 'right' : 'bottom', dataLabels: false, gridlines: !['pie', 'doughnut', 'treemap', 'sunburst', 'funnel'].includes(kind), style: 1, byRows: false,
    pivot: chartLink(sheet.name, pt.name),
  };
  if (typeof p.title === 'string') chart.title = p.title; else if (series.length) chart.title = series.length === 1 ? 'Total' : 'Chart Title';
  setIn(ctx.change, ['sheets', si, 'charts'], [...(ctx.doc.sheets[si].charts ?? []), chart]);
  ctx.setSelection(objectSelection(sheet, 'chart', id));
  return {chart: id, pivot: pt.name, series: series.length, range: rangeA1(area)};
}

export default defineCommands({
  family: 'insert/pivotchart',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.recommendedPivotTables', label: 'Recommended PivotTables', risk: 'edit', dialog: 'dialog.recommendedPivotTables',
      description: 'The PivotTable layouts that suit the data (`source`, default the table or region at the selection): up to five {index, title, rows, columns, values}. With `apply` (an index) the layout is created as a new PivotTable (`destination`, `replace` as insert.pivotTable).',
      params: s.object({source: s.optional(s.string({max: 4096})), apply: s.optional(s.integer({min: 0, max: 4})), destination: s.optional(s.string({max: 300})), replace: s.optional(s.boolean())}),
      state: hasDoc, run: recommended},
    {id: 'insert.pivotChart', label: 'PivotChart', risk: 'edit', dialog: 'dialog.createPivotChart',
      description: 'Insert a PivotChart of a PivotTable (`pivot`: its name or a cell of its report; default the one at the selection): `type` and `subtype` as insert.chart, `at`, `width`, `height`, `title`. With no PivotTable under the selection, or `withTable`, it asks for a `source` (and `destination` new or a cell) and makes a blank PivotTable with its chart.',
      params: s.object({pivot: PIVOT, type: s.optional(s.string({max: 20})), subtype: s.optional(s.string({max: 20})), at: s.optional(s.string({max: 100})), width: s.optional(s.number({min: 10, max: 10000})),
        height: s.optional(s.number({min: 10, max: 10000})), title: s.optional(s.string({max: 255})), mode: s.optional(s.enum(ANCHOR_MODES)), source: s.optional(s.string({max: 4096})),
        destination: s.optional(s.string({max: 300})), withTable: s.optional(s.boolean())}),
      state: hasDoc, run: pivotChart},
  ],
});
