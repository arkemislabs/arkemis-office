// A Word chart in a .docx (core/quill/formats/docx-write.mjs, docx-read.mjs): the chart part (word/charts/chartN.xml) and the workbook Word edits its data in
// (word/embeddings/*.xlsx), written from the chart model (core/quill/model/chart.mjs) and read back into it.
//
// Reuses Grid's chart code instead of translating it again: the chart part is written by Grid's chartXml
// (core/grid/lib/xlsx-drawing.mjs, gridcraft crates/xlsx chart.rs) from a one-sheet Grid workbook that holds the chart's
// data table, so every series is a reference into the embedded sheet with its values cached (Word's Edit Data opens that
// workbook), and the workbook is written by Grid's xlsx writer. Reading takes the cached points (or the literal lists) of a
// chart part: the kinds Word's Insert Chart draws as c:chart (the six `cx` kinds come back through the Arkemis marker Grid
// writes), series colours that are plain RGB, titles, legend, data labels, gridlines and axis titles. A chart with any other
// plot (3-D, bubble, filled radar, of-pie, mixed groups that are not columns plus lines) is left to the caller to keep whole.
//
// Where it differs from wordcraft crates/docx/src/chart_spec.rs (literal data in the part, no workbook, `spec_of` reading back
// only what writing again reproduces): the data is in an embedded workbook, as Word writes it, and a chart read from a file
// keeps its own part until a command edits it (graphic.raw, see docx-read.mjs `readChartFrame`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM; JSZip only through Grid's writer.

import {chartXml} from '../../grid/lib/xlsx-drawing.mjs';
import {writeXlsx} from '../../grid/formats/xlsx-write.mjs';
import {newSheet} from '../../grid/model/workbook.mjs';
import {colToLetters} from '../../grid/lib/addr.mjs';
import {BLOCK_ROWS} from '../../grid/model/store.mjs';
import {DEFAULT_THEME} from '../../grid/model/style.mjs';
import {gridKind, sanitizedChart, chartTable, MAX_POINTS} from '../model/chart.mjs';
import {gridTheme} from './chart-draw.mjs';

export const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
export const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const REL_PACKAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package';
const HEX = /^#[0-9A-F]{6}$/;

/** The chart's data table as a one-sheet Grid workbook (`Sheet1`: A1 empty, the series names across, the categories down). */
function workbookOf(spec, theme) {
  const sheet = newSheet('s1', 'Sheet1');
  const rows = chartTable(spec);
  const put = (r, c, v) => {
    if (v === null || v === undefined || v === '') return;
    const key = colToLetters(c) + (r + 1);
    const block = String(Math.floor(r / BLOCK_ROWS));
    (sheet.blocks[block] ??= {})[key] = {v};
  };
  sheet.blocks = {};
  rows.forEach((row, r) => row.forEach((v, c) => put(r, c, v)));
  return {sheets: [sheet], activeSheetId: 's1', styles: [{}], names: [], theme};
}

/** Grid's chart object over the sheet: every series a reference into it (the first row names it, the first column the categories). */
function gridChartOver(spec) {
  const n = spec.categories.length;
  const last = n + 1;
  const scatter = spec.type === 'scatter' || spec.type === 'scatterLines';
  return {
    kind: gridKind(spec.type), title: spec.title ?? '', legend: spec.legend ?? 'none', dataLabels: !!spec.dataLabels, gridlines: spec.gridlines !== false,
    ...(spec.xTitle ? {xTitle: spec.xTitle} : {}), ...(spec.yTitle ? {yTitle: spec.yTitle} : {}), ...(spec.style ? {style: spec.style} : {}), byRows: false,
    series: spec.series.map((s, i) => {
      const col = colToLetters(i + 1);
      return {name: `Sheet1!$${col}$1`, values: `Sheet1!$${col}$2:$${col}$${last}`, ...(n && (!scatter || spec.categories.every(c => c !== '' && Number.isFinite(Number(c)))) ? {categories: `Sheet1!$A$2:$A$${last}`} : {}),
        ...(HEX.test(s.color ?? '') ? {color: s.color} : {})};
    }),
  };
}

/** The chart part for `spec` and the rows of its workbook: {xml, rows}. `withData` writes the link to the embedded workbook (rId1). */
export function chartPart(spec0, themeColors, {withData = true} = {}) {
  const spec = sanitizedChart(spec0);
  const content = workbookOf(spec, gridTheme(themeColors) ?? DEFAULT_THEME);
  let xml = chartXml(content, 0, gridChartOver(spec));
  if (spec.areaFill || spec.areaLine) {
    const solid = h => `<a:solidFill><a:srgbClr val="${h.slice(1)}"/></a:solidFill>`;
    const fill = spec.areaFill ? (spec.areaFill === 'none' ? '<a:noFill/>' : solid(spec.areaFill)) : '';
    const line = spec.areaLine ? (spec.areaLine === 'none' ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="${Math.round(spec.areaLine.width * 12700)}">${solid(spec.areaLine.color)}</a:ln>`) : '';
    xml = xml.replace('</c:chart>', `</c:chart><c:spPr>${fill}${line}</c:spPr>`);
  }
  if (withData) {
    const link = '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>';
    xml = xml.includes('<c:extLst>') ? xml.replace('<c:extLst>', `${link}<c:extLst>`) : xml.replace('</c:chartSpace>', `${link}</c:chartSpace>`);
  }
  return {xml, content};
}

/** The workbook of a chart as .xlsx bytes (a promise). */
export const chartWorkbook = (spec, themeColors) => writeXlsx(workbookOf(sanitizedChart(spec), gridTheme(themeColors) ?? DEFAULT_THEME));

// ---------------------------------------------------------------------------------------------------------
// Reading. `root` is a parsed `c:chartSpace` (docx-read.mjs `El`, canonical prefixes).

const KIND_URI = 'urn:arkemis:chart-kind';
const EXTENSION_KINDS = ['histogram', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker'];
const GROUPS = ['barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart', 'scatterChart', 'radarChart', 'stockChart'];
const val = (el, name) => el?.child(name)?.attr('val') ?? null;
const numOf = t => { const s = String(t ?? '').trim(); const v = Number(s); return s !== '' && Number.isFinite(v) ? v : null; };

/** The points of a cache or literal as an array (holes are null / ''). */
function points(el, numeric) {
  if (!el) return [];
  const count = Math.min(MAX_POINTS, Math.max(0, numOf(val(el, 'c:ptCount')) ?? 0));
  const pts = el.children('c:pt');
  const n = Math.min(MAX_POINTS, Math.max(count, ...pts.map(p => (numOf(p.attr('idx')) ?? 0) + 1), 0));
  const out = Array.from({length: n}, () => (numeric ? null : ''));
  for (const p of pts) {
    const i = numOf(p.attr('idx'));
    if (i === null || i < 0 || i >= n) continue;
    const v = p.child('c:v')?.text() ?? '';
    out[i] = numeric ? numOf(v) : v;
  }
  return out;
}

/** The series data holder (`c:cat`, `c:val`, `c:xVal`, …): the cached or literal points, or null. */
function data(holder, numeric) {
  if (!holder) return null;
  const multi = holder.child('c:multiLvlStrRef')?.child('c:multiLvlStrCache');
  if (multi) return points(multi.child('c:lvl'), false);
  for (const k of ['c:numRef', 'c:strRef']) {
    const r = holder.child(k);
    if (r) return points(r.child('c:numCache') ?? r.child('c:strCache'), numeric);
  }
  for (const k of ['c:numLit', 'c:strLit']) if (holder.child(k)) return points(holder.child(k), numeric);
  return null;
}

const richTitle = t => {
  const rich = t?.child('c:tx')?.child('c:rich');
  if (!rich) return undefined;
  return rich.children('a:p').map(p => p.children('a:r').map(r => r.child('a:t')?.text() ?? '').join('')).join('\n');
};

/** Which chart type a group is, or null when the chart model cannot hold it. */
function groupType(g) {
  const grouping = val(g, 'c:grouping') ?? 'standard';
  const stacked = grouping === 'stacked', pct = grouping === 'percentStacked';
  switch (g.local()) {
    case 'barChart': {
      const bar = val(g, 'c:barDir') === 'bar';
      return bar ? (pct ? 'barStacked100' : stacked ? 'barStacked' : 'bar') : pct ? 'columnStacked100' : stacked ? 'columnStacked' : 'column';
    }
    case 'lineChart': {
      if (stacked || pct) return 'lineStacked';
      const sers = g.children('c:ser');
      const none = sers.length > 0 && sers.every(s => s.child('c:marker')?.child('c:symbol')?.attr('val') === 'none');
      return none || val(g, 'c:marker') === '0' ? 'line' : 'lineMarkers';
    }
    case 'areaChart': return pct ? 'areaStacked100' : stacked ? 'areaStacked' : 'area';
    case 'pieChart': return 'pie';
    case 'doughnutChart': return 'doughnut';
    case 'scatterChart': {
      const sers = g.children('c:ser');
      const noLines = sers.length > 0 && sers.every(s => s.child('c:spPr')?.child('a:ln')?.child('a:noFill'));
      return val(g, 'c:scatterStyle') === 'marker' || noLines ? 'scatter' : 'scatterLines';
    }
    case 'radarChart': return val(g, 'c:radarStyle') === 'filled' ? null : 'radar';
    case 'stockChart': return 'stock';
    default: return null;
  }
}

const hexOf = fill => {
  const v = fill?.child('a:srgbClr')?.attr('val');
  return v && /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : null;
};

/** The chart model of a chart part, or null when its plot is not one the model holds. */
export function readChartSpec(root) {
  const chart = root?.child('c:chart');
  const plot = chart?.child('c:plotArea');
  if (!plot) return null;
  const groups = plot.elList().filter(e => GROUPS.includes(e.local()));
  if (!groups.length) return null;
  const types = groups.map(groupType);
  if (types.some(t => t === null)) return null;
  let type = types[0];
  if (groups.length > 1) {
    const columnsThenLines = types[0] === 'column' && types.slice(1).every(t => t === 'line' || t === 'lineMarkers');
    if (!columnsThenLines) return null;
    type = 'combo';
  }
  const hint = root.child('c:extLst')?.children('c:ext').find(e => e.attr('uri') === KIND_URI)?.elList().find(e => e.local() === 'kind')?.attr('val');
  if (hint && EXTENSION_KINDS.includes(hint)) type = hint;
  const scatter = types[0] === 'scatter' || types[0] === 'scatterLines';
  let categories = [];
  const series = [];
  groups.forEach((g, gi) => {
    for (const s of g.children('c:ser')) {
      if (series.length >= 255) break;
      const tx = s.child('c:tx');
      const name = tx ? (tx.child('c:strRef') ? points(tx.child('c:strRef').child('c:strCache'), false)[0] ?? '' : tx.child('c:v')?.text() ?? '') : '';
      const vals = data(s.child(scatter ? 'c:yVal' : 'c:val'), true) ?? [];
      const color = hexOf(s.child('c:spPr')?.child('a:solidFill')) ?? hexOf(s.child('c:spPr')?.child('a:ln')?.child('a:solidFill'));
      series.push({name, values: vals, ...(color ? {color} : {})});
      if (gi === 0 && !categories.length) {
        const cat = data(s.child(scatter ? 'c:xVal' : 'c:cat'), scatter);
        if (cat) categories = scatter ? cat.map((v, i) => (v === null ? String(i + 1) : String(v))) : cat;
      }
    }
  });
  const showVal = e => e?.child('c:dLbls')?.child('c:showVal')?.attr('val') === '1' || e?.child('c:dLbls')?.child('c:showVal')?.attr('val') === 'true';
  const valAxes = plot.children('c:valAx');
  const catAx = plot.child('c:catAx') ?? plot.child('c:dateAx');
  const xAx = scatter ? valAxes.find(a => ['b', 't'].includes(val(a, 'c:axPos'))) : catAx;
  const yAx = scatter ? valAxes.find(a => ['l', 'r'].includes(val(a, 'c:axPos'))) : valAxes[0];
  const lg = chart.child('c:legend');
  const title = chart.child('c:title');
  const spec = {
    type, categories, series,
    title: title ? richTitle(title) ?? null : (val(chart, 'c:autoTitleDeleted') === '0' && series.length === 1 ? series[0].name || null : null),
    legend: lg ? ({b: 'bottom', t: 'top', l: 'left', r: 'right', tr: 'right'})[val(lg, 'c:legendPos') ?? 'r'] ?? 'right' : null,
    dataLabels: groups.some(g => showVal(g) || g.children('c:ser').some(showVal)),
  };
  if (!valAxes.some(a => a.child('c:majorGridlines'))) spec.gridlines = false;
  const xt = xAx?.child('c:title') ? richTitle(xAx.child('c:title')) : undefined;
  const yt = yAx?.child('c:title') ? richTitle(yAx.child('c:title')) : undefined;
  if (xt) spec.xTitle = xt;
  if (yt) spec.yTitle = yt;
  // The chart area's own fill and border (c:chartSpace/c:spPr).
  const area = root.child('c:spPr');
  if (area) {
    if (area.child('a:noFill')) spec.areaFill = 'none';
    else { const f = hexOf(area.child('a:solidFill')); if (f) spec.areaFill = f; }
    const ln = area.child('a:ln');
    if (ln?.child('a:noFill')) spec.areaLine = 'none';
    else { const c = hexOf(ln?.child('a:solidFill')); if (c) spec.areaLine = {color: c, width: (numOf(ln.attr('w')) ?? 9525) / 12700}; }
  }
  const style = Number(val(root, 'c:style'));
  if (Number.isInteger(style) && style >= 1 && style <= 16 && style !== 2) spec.style = style;
  return sanitizedChart(spec);
}
