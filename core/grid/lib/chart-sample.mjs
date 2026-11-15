// A sample chart of any kind, drawn from made-up data: what Excel's Insert Chart shows on its All Charts tab before any data is chosen
// (and for the kinds the chosen data does not suit). Not checked against upstream. No DOM, no Node built-ins.

import {CHART_KINDS} from './chart-render.mjs';

const PAL = Object.freeze([[0x15, 0x60, 0x82, 255], [0xE9, 0x71, 0x32, 255], [0x19, 0x6B, 0x24, 255], [0x0F, 0x9E, 0xD5, 255], [0xA0, 0x2B, 0x93, 255], [0x4E, 0xA7, 0x2E, 255]]);
const CATS = ['Category 1', 'Category 2', 'Category 3', 'Category 4', 'Category 5'];
const ONE = new Set(['pie', 'doughnut', 'pie3d', 'pieOfPie', 'barOfPie', 'treemap', 'sunburst', 'funnel', 'pareto']);
const NO_GRID = new Set(['pie', 'doughnut', 'pie3d', 'pieOfPie', 'barOfPie', 'treemap', 'sunburst', 'funnel']);

/** {chart, data} for `render(chart, data, w, h)`; `kind` is a stored chart kind (anything else draws as a clustered column chart). */
export function sampleChart(kind) {
  const k = CHART_KINDS.includes(kind) ? kind : 'columnClustered';
  const mk = (name, values, i, extra = {}) => ({name, values, x: null, sizes: null, color: PAL[i % PAL.length], kind: k, secondary: false, smooth: false, trendlines: [], numberFormat: 'General', ...extra});
  let series;
  if (k === 'pareto') series = [mk('Series 1', [42, 27, 16, 9, 6], 0)];
  else if (ONE.has(k)) series = [mk('Series 1', [4.3, 2.5, 3.5, 4.5, 2.1], 0)];
  else if (k === 'histogram') series = [mk('Series 1', [1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5, 5, 6, 7, 7, 8, 9], 0)];
  else if (k === 'boxWhisker') series = [mk('Series 1', [2, 3, 4, 4, 5, 5, 6, 7, 8, 9, 12], 0), mk('Series 2', [1, 2, 3, 5, 6, 6, 7, 8, 8, 9, 10], 1)];
  else if (k === 'waterfall') series = [mk('Series 1', [100, -30, 45, -20, 95], 0)];
  else if (k === 'scatter' || k === 'scatterLines') series = [mk('Series 1', [2.4, 4.1, 3.3, 5.6, 4.9], 0, {x: [1, 2, 3, 4, 5]}), mk('Series 2', [1.2, 2.2, 3.9, 3.1, 4.4], 1, {x: [1.5, 2.5, 3.2, 4.4, 5.1]})];
  else if (k === 'bubble' || k === 'bubble3d') series = [mk('Series 1', [2.4, 4.1, 3.3, 5.6, 4.9], 0, {x: [1, 2, 3, 4, 5], sizes: [6, 12, 4, 9, 7]})];
  else if (k === 'stock') series = ['Open', 'High', 'Low', 'Close'].map((n, i) => mk(n, [[40, 42, 41, 45, 44], [46, 47, 46, 49, 48], [38, 40, 39, 43, 41], [42, 41, 45, 44, 47]][i], i));
  else if (k === 'combo') series = [mk('Series 1', [4.3, 2.5, 3.5, 4.5, 3.1], 0, {kind: 'columnClustered'}), mk('Series 2', [2.4, 4.4, 1.8, 2.8, 3.6], 1, {kind: 'line'})];
  else if (k === 'radar') series = [mk('Series 1', [4.3, 2.5, 3.5, 4.5, 3.1], 0), mk('Series 2', [2.4, 4.4, 1.8, 2.8, 3.6], 1)];
  else series = [mk('Series 1', [4.3, 2.5, 3.5, 4.5, 3.2], 0), mk('Series 2', [2.4, 4.4, 1.8, 2.8, 3.6], 1), mk('Series 3', [2, 2, 3, 5, 4.1], 2)];
  const chart = {kind: k, title: 'Chart Title', legend: ['pie', 'doughnut', 'pie3d', 'pieOfPie', 'barOfPie', 'treemap', 'sunburst'].includes(k) ? 'right' : 'bottom', gridlines: !NO_GRID.has(k), dataLabels: false, style: 1, series: series.map(() => ({}))};
  return {chart, data: {categories: CATS, categoryLevels: [], series, palette: PAL.map(c => [...c])}};
}
