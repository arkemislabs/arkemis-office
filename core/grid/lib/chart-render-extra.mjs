// Chart kinds Excel has and gridcraft does not draw: 3-D Pie, Pie of Pie, Bar of Pie, Pareto and 3-D Bubble.
// Not checked against upstream (gridcraft draws none of them): they follow Excel's own look, built on the pieces of
// chart-render.mjs. U:grid/insert. No DOM, no Node built-ins.
//
//   pie3d     the pie seen from above and in front: elliptical top faces over a wall of fixed depth.
//   pieOfPie  the smallest slices (the last three by position, Excel's default split) join into one "Other" slice of the
//   barOfPie  main pie, which a second pie or one stacked bar breaks down, joined by two connector lines.
//   pareto    the first series sorted from the largest, columns with a cumulative percent line on a 0-100% axis.
//   bubble3d  bubbles drawn as shaded spheres (the plain bubble layout with a highlight on each).

import {Fmt, clean, niceScale, fixedScale} from './chart-axis.mjs';
import {frame, on, catLabel, pointColor, TEXT, WHITE, GRID, LABEL_SIZE, MAX_CATS, MAX_LABELS, TAU} from './chart-render.mjs';

/** The pie family drawn here (they colour by point and list the categories in the legend). */
export const PIE_EXTRA_KINDS = Object.freeze(['pie3d', 'pieOfPie', 'barOfPie']);
export const EXTRA_KINDS = Object.freeze([...PIE_EXTRA_KINDS, 'pareto', 'bubble3d']);

const OTHER = [0xA5, 0xA5, 0xA5, 0xFF];
const shade = (c, f) => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f), c[3] ?? 255];
const absVals = s => s.values.slice(0, MAX_CATS).map(v => (v === null || !Number.isFinite(v) ? 0 : Math.abs(v)));

// ---------------------------------------------------------------- 3-D pie

const TILT = 0.55;
const DEPTH = 0.18;

export function pie3d(ctx, chart, data, area) {
  const s = data.series[0];
  if (!s) return;
  const vals = absVals(s);
  const total = vals.reduce((a, b) => a + b, 0);
  if (!(Number.isFinite(total) && total > 0)) return;
  const rx = Math.min(area.w / 2, area.h / (2 * TILT + DEPTH)) * 0.92;
  if (rx < 4) return;
  const ry = rx * TILT, depth = rx * DEPTH;
  const cx = area.cx, cy = area.cy - depth / 2;
  const at = (a, dy = 0) => [cx + rx * Math.sin(a), cy - ry * Math.cos(a) + dy];
  const arc = (a0, a1, dy) => {
    const n = Math.max(2, Math.ceil((a1 - a0) / 0.08));
    return Array.from({length: n + 1}, (_, i) => at(a0 + (a1 - a0) * i / n, dy));
  };
  const f = new Fmt(s.numberFormat);
  const slices = [];
  let a = 0;
  vals.forEach((v, j) => {
    const sweep = v / total * TAU;
    if (sweep > 1e-4) slices.push({j, a0: a, a1: Math.min(a + sweep, TAU), fill: pointColor(data, j)});
    a += sweep;
  });
  // The wall first (only the front half of the rim shows), then the top faces.
  for (const sl of slices) {
    const lo = Math.max(sl.a0, Math.PI / 2), hi = Math.min(sl.a1, Math.PI * 1.5);
    if (hi <= lo) continue;
    const pts = [...arc(lo, hi, 0), ...arc(lo, hi, depth).reverse()];
    ctx.out.push({t: 'poly', pts, fill: shade(sl.fill, 0.72), stroke: [WHITE, 0.75]});
  }
  const labels = [];
  for (const sl of slices) {
    ctx.out.push({t: 'poly', pts: [[cx, cy], ...arc(sl.a0, sl.a1, 0)], fill: sl.fill, stroke: [WHITE, 1.25]});
    if (chart.dataLabels && vals.length <= MAX_LABELS) {
      const mid = (sl.a0 + sl.a1) / 2, t = f.format(s.values[sl.j] ?? 0);
      if (ctx.tw(t, LABEL_SIZE) <= (sl.a1 - sl.a0) * rx * 0.65 + 8) labels.push([cx + rx * 0.62 * Math.sin(mid), cy - ry * 0.62 * Math.cos(mid), t, on(sl.fill)]);
    }
  }
  for (const [x, y, t, c] of labels) ctx.text(x, y, t, LABEL_SIZE, c, ['center', 'middle']);
}

// ---------------------------------------------------------------- pie of pie, bar of pie

/** How many of the last values go to the second plot (Excel splits the last three by position by default). */
export const splitCount = n => Math.min(3, Math.max(1, n - 1));

export function ofPie(ctx, chart, data, area, bar) {
  const s = data.series[0];
  if (!s) return;
  const vals = absVals(s);
  const n = vals.length;
  const total = vals.reduce((a, b) => a + b, 0);
  if (n < 2 || !(Number.isFinite(total) && total > 0)) return;
  const k = splitCount(n);
  const head = vals.slice(0, n - k), tail = vals.slice(n - k);
  const other = tail.reduce((a, b) => a + b, 0);
  const r1 = Math.min(area.w * 0.27, area.h / 2) * 0.92;
  if (r1 < 4) return;
  const r2 = r1 * 0.7;
  const c1x = area.x + area.w * 0.27, c2x = area.x + area.w * 0.78, cy = area.cy;
  const f = new Fmt(s.numberFormat);
  // The "Other" slice is centred at 3 o'clock, facing the second plot.
  const otherSweep = other / total * TAU;
  let a = Math.PI / 2 + otherSweep / 2;
  const mainSlices = [...head.map((v, i) => [v, pointColor(data, i), i]), [other, OTHER, -1]];
  let edge0 = 0, edge1 = 0;
  const labels = [];
  for (const [v, fill, idx] of mainSlices) {
    const sweep = v / total * TAU;
    if (sweep > 1e-4) {
      ctx.out.push({t: 'wedge', cx: c1x, cy, ro: r1, ri: 0, a0: a, a1: a + sweep, fill, stroke: [WHITE, 1.5]});
      if (idx < 0) { edge0 = a; edge1 = a + sweep; }
      if (chart.dataLabels) {
        const mid = a + sweep / 2, t = f.format(idx < 0 ? other : s.values[idx] ?? 0);
        if (ctx.tw(t, LABEL_SIZE) <= sweep * r1 * 0.65 + 6) labels.push([c1x + r1 * 0.65 * Math.sin(mid), cy - r1 * 0.65 * Math.cos(mid), t, on(fill)]);
      }
    }
    a += sweep;
  }
  const rim = ang => [c1x + r1 * Math.sin(ang), cy - r1 * Math.cos(ang)];
  const ink = [0x8C, 0x8C, 0x8C, 0xFF];
  if (!bar) {
    let b = 0;
    tail.forEach((v, i) => {
      const sweep = v / other * TAU;
      if (sweep > 1e-4) {
        const fill = pointColor(data, n - k + i);
        ctx.out.push({t: 'wedge', cx: c2x, cy, ro: r2, ri: 0, a0: b, a1: b + sweep, fill, stroke: [WHITE, 1.5]});
        if (chart.dataLabels) {
          const mid = b + sweep / 2, t = f.format(s.values[n - k + i] ?? 0);
          if (ctx.tw(t, LABEL_SIZE) <= sweep * r2 * 0.65 + 6) labels.push([c2x + r2 * 0.65 * Math.sin(mid), cy - r2 * 0.65 * Math.cos(mid), t, on(fill)]);
        }
      }
      b += sweep;
    });
    const [x0, y0] = rim(edge0), [x1, y1] = rim(edge1);
    // The connectors leave the Other slice's two edges for the top and bottom of the second pie.
    const topEdge = y0 < y1 ? [x0, y0] : [x1, y1], botEdge = y0 < y1 ? [x1, y1] : [x0, y0];
    ctx.line([topEdge, [c2x, cy - r2]], ink, 0.75);
    ctx.line([botEdge, [c2x, cy + r2]], ink, 0.75);
  } else {
    const bw = r2 * 0.6, bx = c2x - bw / 2, top = cy - r2, h = r2 * 2;
    let y = top;
    tail.forEach((v, i) => {
      const hh = v / other * h;
      const fill = pointColor(data, n - k + i);
      ctx.rect(bx, y, bw, hh, fill, [WHITE, 1.25]);
      if (chart.dataLabels) {
        const t = f.format(s.values[n - k + i] ?? 0);
        if (ctx.tw(t, LABEL_SIZE) <= bw && hh >= LABEL_SIZE) labels.push([c2x, y + hh / 2, t, on(fill)]);
      }
      y += hh;
    });
    const [x0, y0] = rim(edge0), [x1, y1] = rim(edge1);
    const topEdge = y0 < y1 ? [x0, y0] : [x1, y1], botEdge = y0 < y1 ? [x1, y1] : [x0, y0];
    ctx.line([topEdge, [bx, top]], ink, 0.75);
    ctx.line([botEdge, [bx, top + h]], ink, 0.75);
  }
  for (const [x, y, t, c] of labels) ctx.text(x, y, t, LABEL_SIZE, c, ['center', 'middle']);
}

// ---------------------------------------------------------------- pareto

/** The Pareto order of the first series: [{label, value, cumulative}] from the largest, cumulative as a fraction of the total. */
export function paretoRows(data) {
  const s = data.series[0];
  if (!s) return [];
  const n = Math.min(MAX_CATS, Math.max(data.categories.length, s.values.length));
  const rows = Array.from({length: n}, (_, j) => ({label: catLabel(data, j), value: Math.max(0, clean(s.values[j] ?? 0)), j}));
  rows.sort((a, b) => b.value - a.value || a.j - b.j);
  const total = rows.reduce((t, r) => t + r.value, 0);
  let run = 0;
  return rows.map(r => { run += r.value; return {label: r.label, value: r.value, cumulative: total > 0 ? run / total : 0}; });
}

export function pareto(ctx, chart, data, area) {
  const s = data.series[0];
  const rows = paretoRows(data);
  if (!s || !rows.length) return;
  const max = Math.max(0, ...rows.map(r => r.value));
  const ys = niceScale(0, max, true);
  const y2 = fixedScale(0, 1, 0.1);
  const plot = frame(ctx, area, {labels: rows.map(r => r.label), outer: []}, {scale: ys, fmt: new Fmt(s.numberFormat)}, {scale: y2, fmt: new Fmt('0%')}, false, chart.gridlines !== false);
  if (!plot.ok()) return;
  const n = rows.length, cw = plot.w / n, gap = cw * 0.1;
  const f = new Fmt(s.numberFormat);
  rows.forEach((r, j) => {
    const top = plot.bottom - ys.frac(r.value) * plot.h;
    ctx.rect(plot.x + j * cw + gap, top, cw - 2 * gap, plot.bottom - top, s.color);
    if (chart.dataLabels) ctx.text(plot.x + (j + 0.5) * cw, top - 2, f.format(r.value), LABEL_SIZE, TEXT, ['center', 'bottom']);
  });
  const pts = rows.map((r, j) => [plot.x + (j + 0.5) * cw, plot.bottom - y2.frac(r.cumulative) * plot.h]);
  const line = data.palette[1] ?? [0xE9, 0x71, 0x32, 0xFF];
  ctx.line(pts, line, 2);
  for (const [x, y] of pts.slice(0, 2000)) ctx.out.push({t: 'circle', cx: x, cy: y, r: 3, fill: line, stroke: [WHITE, 0.75]});
  void GRID;
}

// ---------------------------------------------------------------- 3-D bubble

/** Gives every circle `ctx.out` gained since index `from` a sphere's look: a darker rim and a highlight up and to the left. */
export function sphereShade(ctx, from) {
  const added = [];
  for (let i = from; i < ctx.out.length; i++) if (ctx.out[i].t === 'circle') added.push(ctx.out[i]);
  for (const c of added) {
    c.stroke = [shade(c.fill, 0.7), 1];
    ctx.out.push({t: 'circle', cx: c.cx - c.r * 0.3, cy: c.cy - c.r * 0.32, r: Math.max(1, c.r * 0.38), fill: [255, 255, 255, 110], stroke: null});
  }
}
