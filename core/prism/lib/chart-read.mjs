// Reads a chart part (ppt/charts/chartN.xml) into the chart model of core/prism/lib/chart.mjs.
// Translated in outline from deckcraft crates/pptx (chart reading) at 4ce2944; the chart types it reads are the ones
// the shared chart engine draws, and a chart with any other plot (3-D, surface, filled radar, of-pie, mixed groups that
// are not columns plus lines) is left to the caller to keep as an opaque object. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// `root` is a parsed `c:chartSpace` element in the reader's own tree (core/prism/formats/pptx-read.mjs `El`).

import {blankChart} from './chart.mjs';

const MAX_POINTS = 20000;
const GROUPS = ['barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart', 'scatterChart', 'bubbleChart', 'radarChart', 'stockChart'];
const SCHEME_SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink', 'bg1', 'tx1', 'bg2', 'tx2'];
const PALETTE_URI = '{6A1F3C52-2D64-4C57-9C1E-0D2B6F6E3A11}';

const numOf = t => { const v = Number(String(t ?? '').trim()); return String(t ?? '').trim() !== '' && Number.isFinite(v) ? v : null; };

/** The points of a cache or literal element as an array (holes are null / ''), ptCount long. */
function points(el, numeric) {
  if (!el) return [];
  const count = Math.min(MAX_POINTS, Math.max(0, el.child('ptCount')?.u32('val') ?? 0));
  const pts = el.childrenNamed('pt');
  const n = Math.max(count, ...pts.map(p => (p.u32('idx') ?? 0) + 1), 0);
  const out = Array.from({length: Math.min(n, MAX_POINTS)}, () => (numeric ? null : ''));
  for (const p of pts) {
    const i = p.u32('idx');
    if (i === null || i >= out.length) continue;
    const v = p.child('v')?.text() ?? '';
    out[i] = numeric ? numOf(v) : v;
  }
  return out;
}

/** The series data holder (`c:cat`, `c:val`, `c:xVal`…) as {values, levels}: the cached or literal points. */
function data(holder, numeric) {
  if (!holder) return null;
  const multi = holder.child('multiLvlStrRef')?.child('multiLvlStrCache');
  if (multi) {
    const lvls = multi.childrenNamed('lvl').map(l => points(l, false));
    return {values: lvls[0] ?? [], levels: lvls.slice(1)};
  }
  for (const k of ['numRef', 'strRef']) {
    const r = holder.child(k);
    if (r) return {values: points(r.child('numCache') ?? r.child('strCache'), numeric), levels: []};
  }
  for (const k of ['numLit', 'strLit']) {
    const l = holder.child(k);
    if (l) return {values: points(l, numeric), levels: []};
  }
  return null;
}

/** A DrawingML colour element's colour reference (RGB, or a scheme slot with its luminance steps), or null. */
export function colorRef(fillEl) {
  const e = fillEl?.elements()[0];
  if (!e) return null;
  if (e.is('srgbClr')) {
    const v = (e.attr('val') ?? '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
    return {base: {kind: 'rgb', rgb: {r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16), a: 255}}, mods: []};
  }
  if (e.is('schemeClr')) {
    const slot = e.attr('val');
    if (!SCHEME_SLOTS.includes(slot)) return null;
    const mods = e.elements().filter(m => ['lumMod', 'lumOff', 'tint', 'shade', 'alpha'].includes(m.local) && m.u32('val') !== null).map(m => ({op: m.local, val: m.u32('val')}));
    return {base: {kind: 'scheme', slot}, mods};
  }
  return null;
}

const richTitle = t => {
  const rich = t?.child('tx')?.child('rich');
  if (!rich) return undefined;
  return rich.childrenNamed('p').map(p => p.childrenNamed('r').map(r => r.child('t')?.text() ?? '').join('')).join('\n');
};

/** Which chart type a group is, or null when the engine cannot draw it. */
function groupType(g) {
  const grouping = g.childVal('grouping') ?? 'standard';
  const stacked = grouping === 'stacked', pct = grouping === 'percentStacked';
  switch (g.local) {
    case 'barChart': {
      const bar = g.childVal('barDir') === 'bar';
      return bar ? (pct ? 'percentBar' : stacked ? 'stackedBar' : 'bar') : pct ? 'percentColumn' : stacked ? 'stackedColumn' : 'column';
    }
    case 'lineChart': {
      if (stacked || pct) return 'stackedLine';
      const sers = g.childrenNamed('ser');
      const none = sers.length > 0 && sers.every(s => s.path(['marker', 'symbol'])?.attr('val') === 'none');
      const groupMarker = g.childVal('marker');
      return none || groupMarker === '0' ? 'line' : 'lineMarkers';
    }
    case 'areaChart': return stacked || pct ? 'stackedArea' : 'area';
    case 'pieChart': return 'pie';
    case 'doughnutChart': return 'doughnut';
    case 'scatterChart': return 'scatter';
    case 'bubbleChart': return 'bubble';
    case 'radarChart': return g.childVal('radarStyle') === 'filled' ? 'filledRadar' : 'radar';
    case 'stockChart': return 'stock';
    default: return null;
  }
}

function readSeries(s, type) {
  const tx = s.child('tx');
  const name = tx ? (tx.child('strRef') ? points(tx.child('strRef').child('strCache'), false)[0] ?? '' : tx.child('v')?.text() ?? '') : '';
  const xy = type === 'scatter' || type === 'bubble';
  const val = data(s.child(xy ? 'yVal' : 'val'), true);
  const out = {name, values: val?.values ?? []};
  if (xy) {
    const x = data(s.child('xVal'), true);
    if (x) out.xValues = x.values;
  }
  if (type === 'bubble') {
    const b = data(s.child('bubbleSize'), true);
    if (b) out.sizes = b.values;
  }
  const sp = s.child('spPr');
  const color = colorRef(sp?.child('solidFill')) ?? colorRef(sp?.child('ln')?.child('solidFill'));
  if (color) out.color = color;
  if (s.child('smooth')?.bool('val')) out.smooth = true;
  return out;
}

/** The chart model of a chart part, or null when its plot is not one the engine draws. */
export function readChartPart(root) {
  const chart = root?.child('chart');
  const plot = chart?.child('plotArea');
  if (!plot) return null;
  const groups = plot.elements().filter(e => GROUPS.includes(e.local));
  if (!groups.length) return null;
  const types = groups.map(groupType);
  if (types.some(t => t === null)) return null;
  let chartType = types[0];
  if (groups.length > 1) {
    const colsThenLines = types[0] === 'column' && types.slice(1).every(t => t === 'line' || t === 'lineMarkers');
    if (!colsThenLines) return null;
    chartType = 'combo';
  }
  const c = blankChart(chartType);
  groups.forEach((g, gi) => {
    for (const s of g.childrenNamed('ser')) {
      const ser = readSeries(s, types[gi]);
      if (chartType === 'combo') ser.kind = gi === 0 ? 'column' : 'line';
      if (c.series.length >= 255) break;
      c.series.push(ser);
      if (gi === 0 && !c.categories.length) {
        const cat = data(s.child(chartType === 'scatter' || chartType === 'bubble' ? 'xVal' : 'cat'), false);
        if (cat && !(chartType === 'scatter' || chartType === 'bubble')) { c.categories = cat.values; c.categoryLevels = cat.levels; }
      }
    }
  });
  if (chartType === 'scatter' || chartType === 'bubble') c.categories = (c.series[0]?.xValues ?? []).map((v, i) => (v === null ? String(i + 1) : String(v)));
  if (groups.length > 1 && groups.some((g, gi) => gi > 0 && g.childrenNamed('axId').map(a => a.attr('val')).join() !== groups[0].childrenNamed('axId').map(a => a.attr('val')).join())) {
    groups.forEach((g, gi) => { if (gi > 0) for (const s of c.series.filter(x => x.kind === 'line')) s.secondaryAxis = true; });
  }
  // Title: its rich text; none when the file deletes it; the series name of a one-series chart that has none.
  const title = chart.child('title');
  if (title) c.title = richTitle(title) ?? '';
  else if (chart.child('autoTitleDeleted')?.bool('val') === false && c.series.length === 1) c.title = c.series[0].name || null;
  else c.title = null;
  const lg = chart.child('legend');
  c.legend = !lg ? null : ({b: 'bottom', t: 'top', l: 'left', r: 'right', tr: 'right'})[lg.childVal('legendPos') ?? 'r'] ?? 'right';
  const valAxes = plot.childrenNamed('valAx');
  c.gridlines = valAxes.some(a => a.child('majorGridlines'));
  const showVal = e => e?.child('dLbls')?.child('showVal')?.bool('val') === true;
  c.dataLabels = groups.some(g => showVal(g) || g.childrenNamed('ser').some(showVal));
  const catAx = plot.child('catAx') ?? plot.child('dateAx');
  const xy = chartType === 'scatter' || chartType === 'bubble';
  const xAx = xy ? valAxes.find(a => ['b', 't'].includes(a.childVal('axPos'))) : catAx;
  const yAx = xy ? valAxes.find(a => ['l', 'r'].includes(a.childVal('axPos'))) : valAxes[0];
  const xt = xAx?.child('title') ? richTitle(xAx.child('title')) : undefined;
  const yt = yAx?.child('title') ? richTitle(yAx.child('title')) : undefined;
  if (xt) c.xTitle = xt;
  if (yt) c.yTitle = yt;
  c.style = Number(root.childVal('style')) || 2;
  c.varyColors = groups.some(g => g.childVal('varyColors') === '1') && c.series.length === 1;
  const txColor = colorRef(root.child('txPr')?.find('defRPr')?.child('solidFill'));
  if (txColor) c.textColor = txColor;
  const ext = root.child('extLst')?.childrenNamed('ext').find(e => e.attr('uri') === PALETTE_URI)?.child('chart');
  if (ext) {
    const p = ext.attr('palette');
    if (p && /^[A-Za-z0-9]{1,24}$/.test(p)) c.palette = p;
    if (ext.attr('varyColors') !== null) c.varyColors = ext.attr('varyColors') === '1';
    // What this app's own chart parts say beyond the file format: an extra chart type (surface, pareto) and the chart elements.
    const type = ext.attr('type');
    if (type === 'surface' || type === 'pareto') {
      c.chartType = type;
      if (type === 'pareto') { c.series = c.series.filter(s => s.name !== 'Cumulative %'); for (const s of c.series) { delete s.kind; delete s.secondaryAxis; } }
    }
    const el = ext.attr('elements');
    if (el) { try { const o = JSON.parse(decodeURIComponent(el)); if (o && typeof o === 'object' && !Array.isArray(o)) c.elements = o; } catch { /* a part that says nothing usable */ } }
  }
  return c;
}
