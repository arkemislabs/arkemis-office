// PivotCharts: a chart that plots a PivotTable's report. Its link to the table (`Sheet2!PivotTable1`), the series
// the report gives it and how they are rebuilt when the report is written again.
// Translated from gridcraft crates/engine/src/pivot/charts.rs (`chart_link`, `parse_chart_link`, `links_to`,
// `rows_ref`, `chart_series`, `rebind_charts`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {quoteSheet, colToLetters} from './addr.mjs';

/** The link a PivotChart stores to its PivotTable: `Sheet2!PivotTable1`. */
export const chartLink = (sheetName, pivotName) => `${quoteSheet(sheetName)}!${pivotName}`;

/** [sheet name, PivotTable name] of a PivotChart link; a leading `[Book.xlsx]` is ignored. */
export function parseChartLink(link) {
  let t = String(link ?? '').trim();
  if (t.startsWith('[')) { const i = t.indexOf(']'); t = i < 0 ? t.slice(1) : t.slice(i + 1); }
  const bang = t.lastIndexOf('!');
  if (bang < 0) return null;
  let sheet = t.slice(0, bang).trim();
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  const name = t.slice(bang + 1).trim();
  return sheet && name ? [sheet, name] : null;
}

/** Whether a PivotChart link points at `pivotName` on `sheetName`. */
export function linksTo(link, sheetName, pivotName) {
  const p = parseChartLink(link);
  return !!p && p[0].toLowerCase() === sheetName.toLowerCase() && p[1].toLowerCase() === pivotName.toLowerCase();
}

/** An absolute reference to column `col` of the report over grid `rows` (runs of rows joined as a union), or null. */
function rowsRef(sheetName, origin, col, rows) {
  const q = quoteSheet(sheetName);
  const letters = colToLetters(origin.col + col);
  const parts = [];
  for (let i = 0; i < rows.length; i++) {
    const start = rows[i];
    let end = start;
    while (i + 1 < rows.length && rows[i + 1] === end + 1) { end += 1; i += 1; }
    const a = origin.row + start + 1, b = origin.row + end + 1;
    parts.push(a === b ? `${q}!$${letters}$${a}` : `${q}!$${letters}$${a}:$${letters}$${b}`);
  }
  return parts.length === 0 ? null : parts.length === 1 ? parts[0] : `(${parts.join(',')})`;
}

/** Most category rows a PivotChart plots. */
const MAX_CHART_ROWS = 10_000;

/**
 * A PivotChart's series for a report written at `origin` ({row, col}): categories are the innermost row items, one series per item
 * column (column items by value fields); totals are left out. `out` is the computed report (chartRows, chartCols, labelCol).
 */
export function chartSeries(sheetName, origin, out) {
  const rows = (out.chartRows ?? []).slice(0, MAX_CHART_ROWS);
  const categories = out.labelCol === null || out.labelCol === undefined ? null : rowsRef(sheetName, origin, out.labelCol, rows);
  const series = [];
  for (const [col, name] of out.chartCols ?? []) {
    const values = rowsRef(sheetName, origin, col, rows);
    if (!values) continue;
    const s = {name: `"${String(name).replaceAll('"', '""')}"`, values};
    if (categories) s.categories = categories;
    series.push(s);
  }
  return series;
}

/** Sets the series of every PivotChart of a PivotTable after its report was written (through `ctx.change`). */
export function rebindCharts(ctx, sheetName, pivotName, origin, out) {
  const content = ctx.doc;
  let series = null;
  (content.sheets ?? []).forEach((sheet, si) => {
    (sheet.charts ?? []).forEach((chart, ci) => {
      if (!chart.pivot || !linksTo(chart.pivot, sheetName, pivotName)) return;
      series ??= chartSeries(sheetName, origin, out);
      ctx.change.set(['sheets', si, 'charts', ci, 'series'], series.map(x => ({...x})));
    });
  });
}
