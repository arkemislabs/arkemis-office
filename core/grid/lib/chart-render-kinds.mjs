// Chart kinds drawn apart from the cartesian family: histogram, waterfall, funnel, pie, doughnut and
// sunburst, treemap, radar, box and whisker, stock.
// Translated from gridcraft crates/chart/src/render/kinds.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {Fmt, clean, niceScale} from './chart-axis.mjs';
import {
  Bx, frame, on, valueRange, catLabel, pointColor, TEXT, WHITE, GRID, AXIS, UP, DOWN, STOCK, LABEL_SIZE, MAX_CATS, MAX_LABELS, MAX_MARKERS, TAU,
} from './chart-render.mjs';

// ---------------------------------------------------------------- histogram

export function histogram(ctx, chart, data, area) {
  const s = data.series[0];
  if (!s) return;
  const vals = s.values.filter(v => v !== null);
  const r = valueRange(vals);
  if (!r) return;
  const [lo, hi] = r;
  const n = vals.length, span = hi - lo;
  let bins = Math.min(100, Math.max(1, Math.ceil(Math.sqrt(n))));
  if (!(Number.isFinite(span) && span > 0)) bins = 1;
  const width = bins === 1 && !(span > 0) ? 1 : span / bins;
  // Upper edge of each bin, exactly as shown in the labels. Bins are right-inclusive (the first is closed on both sides).
  const edges = Array.from({length: bins}, (_, b) => (b + 1 === bins ? Math.max(hi, lo + b * width) : lo + (b + 1) * width));
  const counts = new Array(bins).fill(0);
  for (const v of vals) {
    let b = edges.findIndex(e => !(e < v));
    if (b < 0) b = bins;
    counts[Math.min(b, bins - 1)] += 1;
  }
  const f = new Fmt(s.numberFormat);
  const labels = Array.from({length: bins}, (_, b) => {
    const a = lo + b * width, e = edges[b] ?? a;
    return `${b === 0 ? '[' : '('}${f.format(a, width / 10)}, ${f.format(e, width / 10)}]`;
  });
  const maxc = Math.max(0, ...counts);
  const ys = niceScale(0, maxc, true);
  const plot = frame(ctx, area, {labels, outer: []}, {scale: ys, fmt: new Fmt('General')}, null, false, chart.gridlines !== false);
  if (!plot.ok()) return;
  const cw = plot.w / bins;
  counts.forEach((c, b) => {
    const top = plot.bottom - ys.frac(c) * plot.h, x = plot.x + b * cw;
    ctx.rect(x, top, cw, plot.bottom - top, s.color, [WHITE, 0.75]);
    if (chart.dataLabels) ctx.text(x + cw / 2, top - 2, String(c), LABEL_SIZE, TEXT, ['center', 'bottom']);
  });
}

// ---------------------------------------------------------------- waterfall

export function waterfall(ctx, chart, data, area) {
  const s = data.series[0];
  if (!s) return;
  let ncat = Math.min(MAX_CATS, Math.max(data.categories.length, s.values.length));
  if (ncat === 0) return;
  const labels = Array.from({length: ncat}, (_, j) => catLabel(data, j));
  const vals = Array.from({length: ncat}, (_, j) => s.values[j] ?? 0);
  const isTotal = new Array(ncat).fill(false);
  const lastTotal = labels[labels.length - 1].toLowerCase().includes('total');
  isTotal[ncat - 1] = lastTotal;
  if (!lastTotal) { labels.push('Total'); vals.push(0); isTotal.push(true); ncat += 1; }
  const bars = [];
  let cum = 0;
  vals.forEach((v, j) => {
    if (isTotal[j]) {
      const total = lastTotal && j + 1 === ncat && v !== 0 ? v : cum;
      bars.push([0, total, 0]);
      cum = total;
    } else {
      const top = clean(cum + v);
      bars.push([cum, top, v >= 0 ? 1 : 2]);
      cum = top;
    }
  });
  const [lo, hi] = valueRange(bars.flatMap(([b, t]) => [b, t])) ?? [0, 0];
  const ys = niceScale(lo, hi, true);
  const f = new Fmt(s.numberFormat);
  const plot = frame(ctx, area, {labels, outer: []}, {scale: ys, fmt: f}, null, false, chart.gridlines !== false);
  if (!plot.ok()) return;
  const cw = plot.w / ncat, bw = cw / 1.5;
  const vy = v => plot.bottom - ys.frac(v) * plot.h;
  bars.forEach(([b, t, kind], j) => {
    const color = kind === 1 ? UP : kind === 2 ? DOWN : s.color;
    const x = plot.x + (j + 0.5) * cw - bw / 2;
    const yb = vy(b), yt = vy(t);
    ctx.rect(x, Math.min(yb, yt), bw, Math.max(0.5, Math.abs(yb - yt)), color);
    if (j + 1 < bars.length && ncat <= 500) ctx.out.push({t: 'line', pts: [[x + bw, yt], [x + cw, yt]], color: AXIS, width: 0.75, dash: true});
    if (chart.dataLabels && ncat <= MAX_LABELS) ctx.text(x + bw / 2, Math.min(yb, yt) - 2, f.format(kind === 0 ? t : t - b), LABEL_SIZE, TEXT, ['center', 'bottom']);
  });
}

// ---------------------------------------------------------------- funnel

export function funnel(ctx, chart, data, area) {
  const s = data.series[0];
  if (!s) return;
  const n = Math.min(MAX_CATS, Math.max(data.categories.length, s.values.length));
  if (n === 0) return;
  const vals = Array.from({length: n}, (_, j) => Math.abs(s.values[j] ?? 0));
  const max = Math.max(0, ...vals);
  if (!(max > 0)) return;
  const labels = Array.from({length: n}, (_, j) => catLabel(data, j));
  const lw = Math.min(labels.slice(0, 2000).reduce((m, t) => Math.max(m, ctx.tw(t, LABEL_SIZE)), 0) + 8, area.w * 0.35);
  const plot = area.with({x: area.x + lw, w: area.w - lw});
  if (!plot.ok()) return;
  const slot = plot.h / n, bh = slot * 0.85;
  const f = new Fmt(s.numberFormat);
  const show = slot >= LABEL_SIZE * 0.9;
  vals.forEach((v, j) => {
    const bw = v / max * plot.w;
    const x = plot.x + (plot.w - bw) / 2, y = plot.y + j * slot + (slot - bh) / 2;
    if (bw > 0) ctx.rect(x, y, bw, bh, s.color);
    if (show) {
      const yc = y + bh / 2;
      if (chart.dataLabels) {
        const t = f.format(s.values[j] ?? 0);
        ctx.text(plot.cx, yc, t, LABEL_SIZE, ctx.tw(t, LABEL_SIZE) + 4 <= bw ? on(s.color) : TEXT, ['center', 'middle']);
      }
      ctx.text(plot.x - 6, yc, ctx.fit(labels[j] ?? '', LABEL_SIZE, lw - 8), LABEL_SIZE, TEXT, ['right', 'middle']);
    }
  });
}

// ---------------------------------------------------------------- pie, doughnut, sunburst

export function pie(ctx, chart, data, area, inner, names) {
  const s = data.series[0];
  if (!s) return;
  const vals = s.values.slice(0, MAX_CATS).map(v => (v === null ? 0 : Math.abs(v)));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!(Number.isFinite(total) && total > 0)) return;
  const cx = area.cx, cy = area.cy;
  const r = Math.min(area.w, area.h) / 2 * 0.92;
  if (r < 2) return;
  const ri = r * inner;
  const f = new Fmt(s.numberFormat);
  let a = 0;
  const labels = [];
  vals.forEach((v, j) => {
    const sweep = v / total * TAU;
    if (sweep > 1e-4) {
      const fill = pointColor(data, j);
      ctx.out.push({t: 'wedge', cx, cy, ro: r, ri, a0: a, a1: Math.min(a + sweep, TAU), fill, stroke: [WHITE, 1.5]});
      if ((chart.dataLabels || names) && vals.length <= MAX_LABELS) {
        const t = names ? catLabel(data, j) : f.format(s.values[j] ?? 0);
        const mid = a + sweep / 2;
        const rr = ri > 0 ? (r + ri) / 2 : r * 0.65;
        const room = sweep * rr;
        if (ctx.tw(t, LABEL_SIZE) <= Math.max(room, r - ri) && room >= LABEL_SIZE) labels.push([cx + rr * Math.sin(mid), cy - rr * Math.cos(mid), t, on(fill)]);
      }
    }
    a += sweep;
  });
  for (const [x, y, t, c] of labels) ctx.text(x, y, t, LABEL_SIZE, c, ['center', 'middle']);
}

// ---------------------------------------------------------------- treemap

function worst(row, side) {
  const s = row.reduce((a, b) => a + b, 0);
  if (s <= 0 || side <= 0) return Infinity;
  const mn = Math.min(...row), mx = Math.max(...row);
  const s2 = s * s, w2 = side * side;
  return Math.max(w2 * mx / s2, s2 / (w2 * mn));
}

/** Squarified treemap layout of [index, area] items, sorted descending, into `r`. */
function squarify(items, r) {
  const total = items.reduce((a, i) => a + i[1], 0);
  const area = r.w * r.h;
  if (!(total > 0 && area > 0)) return [];
  const scale = area / total;
  const out = [];
  let rem = r;
  let row = [];
  const layout = () => {
    const s = row.reduce((a, x) => a + x[1], 0);
    if (s <= 0) return;
    if (rem.w >= rem.h) {
      const cw = s / Math.max(rem.h, 1e-6);
      let y = rem.y;
      for (const [j, a] of row) { const h = a / Math.max(cw, 1e-6); out.push([j, new Bx(rem.x, y, cw, h)]); y += h; }
      rem = new Bx(rem.x + cw, rem.y, Math.max(0, rem.w - cw), rem.h);
    } else {
      const rh = s / Math.max(rem.w, 1e-6);
      let x = rem.x;
      for (const [j, a] of row) { const w = a / Math.max(rh, 1e-6); out.push([j, new Bx(x, rem.y, w, rh)]); x += w; }
      rem = new Bx(rem.x, rem.y + rh, rem.w, Math.max(0, rem.h - rh));
    }
    row = [];
  };
  let i = 0;
  while (i < items.length) {
    const [j, v] = items[i];
    const a = v * scale, side = Math.min(rem.w, rem.h);
    const cur = row.map(x => x[1]);
    if (!row.length || worst([...cur, a], side) <= worst(cur, side)) { row.push([j, a]); i += 1; } else layout();
  }
  if (row.length) layout();
  return out;
}

export function treemap(ctx, chart, data, area) {
  const s = data.series[0];
  if (!s) return;
  const items = [];
  s.values.slice(0, MAX_MARKERS).forEach((v, j) => { if (v !== null && v > 0) items.push([j, v]); });
  items.sort((a, b) => b[1] - a[1]);
  const f = new Fmt(s.numberFormat);
  for (const [j, b] of squarify(items, area)) {
    const fill = pointColor(data, j);
    ctx.rect(b.x, b.y, b.w, b.h, fill, [WHITE, 1.5]);
    if (b.w > 24 && b.h > LABEL_SIZE * 1.6) {
      ctx.text(b.x + 4, b.y + 4, ctx.fit(catLabel(data, j), LABEL_SIZE, b.w - 8), LABEL_SIZE, on(fill), ['left', 'top']);
      if (chart.dataLabels && b.h > LABEL_SIZE * 3.2) {
        const v = items.find(x => x[0] === j)?.[1] ?? 0;
        ctx.text(b.x + 4, b.y + 4 + LABEL_SIZE * 1.4, ctx.fit(f.format(v), LABEL_SIZE, b.w - 8), LABEL_SIZE, on(fill), ['left', 'top']);
      }
    }
  }
}

// ---------------------------------------------------------------- radar

export function radar(ctx, chart, data, area) {
  const ncat = Math.min(1000, Math.max(data.categories.length, ...data.series.map(s => s.values.length), 0));
  if (ncat === 0) return;
  const labels = Array.from({length: ncat}, (_, j) => catLabel(data, j));
  const lw = Math.min(labels.reduce((m, t) => Math.max(m, ctx.tw(t, LABEL_SIZE)), 0), area.w * 0.2);
  const r = Math.max(0, Math.min(area.w - 2 * (lw + 8), area.h - 2 * (LABEL_SIZE * 1.4 + 6)) / 2);
  if (r < 5) return;
  const cx = area.cx, cy = area.cy;
  const [lo, hi] = valueRange(data.series.flatMap(s => s.values.filter(v => v !== null))) ?? [0, 0];
  const sc = niceScale(lo, hi, true);
  const f = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const ang = j => j / ncat * TAU;
  const pt = (a, rr) => [cx + rr * Math.sin(a), cy - rr * Math.cos(a)];
  const ticks = sc.ticks();
  const spacing = r / Math.max(1, ticks.length - 1);
  const every = Math.max(1, Math.ceil(LABEL_SIZE * 1.3 / Math.max(1e-3, spacing)));
  ticks.forEach((t, ti) => {
    const rr = sc.frac(t) * r;
    if (rr > 0.5 && chart.gridlines !== false) {
      let ring = Array.from({length: ncat}, (_, j) => pt(ang(j), rr));
      if (ncat < 3) ring = Array.from({length: 49}, (_, k) => pt(k / 48 * TAU, rr));
      else ring.push(ring[0]);
      ctx.line(ring, GRID, 0.75);
    }
    if (ti % every === 0) ctx.text(cx - 3, cy - rr, f.format(t, sc.step), LABEL_SIZE * 0.9, TEXT, ['right', 'middle']);
  });
  const step = Math.max(1, Math.ceil(ncat / 72));
  for (let j = 0; j < ncat; j += step) {
    const a = ang(j);
    ctx.line([[cx, cy], pt(a, r)], GRID, 0.75);
    const p = pt(a, r + 6);
    const sa = Math.sin(a), ca = Math.cos(a);
    const align = sa > 0.1 ? 'left' : sa < -0.1 ? 'right' : 'center';
    const valign = ca > 0.1 ? 'bottom' : ca < -0.1 ? 'top' : 'middle';
    ctx.text(p[0], p[1], ctx.fit(labels[j] ?? '', LABEL_SIZE, Math.max(lw, 20)), LABEL_SIZE, TEXT, [align, valign]);
  }
  for (const s of data.series) {
    const pts = Array.from({length: ncat}, (_, j) => pt(ang(j), sc.frac(s.values[j] ?? sc.min) * r));
    pts.push(pts[0]);
    ctx.line(pts, s.color, 2);
  }
}

// ---------------------------------------------------------------- box & whisker

export function quantile(sorted, q, method) {
  const n = sorted.length;
  if (n === 0) return 0;
  const pos = method === 'inclusive' ? q * (n - 1) : Math.min(n - 1, Math.max(0, q * (n + 1) - 1));
  const i = Math.floor(pos), frac = pos - i;
  const a = sorted[i] ?? 0, b = sorted[i + 1] ?? a;
  return a + (b - a) * frac;
}

export function boxWhisker(ctx, chart, data, area) {
  const labels = data.series.map(s => s.name);
  const r = valueRange(data.series.flatMap(s => s.values.filter(v => v !== null)));
  if (!r) return;
  const ys = niceScale(r[0], r[1], false);
  const f = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const plot = frame(ctx, area, {labels, outer: []}, {scale: ys, fmt: f}, null, false, chart.gridlines !== false);
  if (!plot.ok()) return;
  const n = Math.max(1, data.series.length), cw = plot.w / n, bw = Math.min(cw * 0.4, 80);
  const vy = v => plot.bottom - ys.frac(v) * plot.h;
  data.series.forEach((s, i) => {
    const v = s.values.filter(x => x !== null).sort((a, b) => a - b);
    if (!v.length) return;
    const method = chart.series?.[i]?.quartiles ?? 'exclusive';
    const q1 = quantile(v, 0.25, method), med = quantile(v, 0.5, method), q3 = quantile(v, 0.75, method);
    const iqr = q3 - q1, flo = q1 - 1.5 * iqr, fhi = q3 + 1.5 * iqr;
    const wlo = v.find(x => x >= flo) ?? q1;
    const whi = [...v].reverse().find(x => x <= fhi) ?? q3;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const c = plot.x + (i + 0.5) * cw;
    ctx.vline(c, vy(whi), vy(q3), s.color, 1.25);
    ctx.vline(c, vy(q1), vy(wlo), s.color, 1.25);
    ctx.hline(c - bw / 4, c + bw / 4, vy(whi), s.color, 1.25);
    ctx.hline(c - bw / 4, c + bw / 4, vy(wlo), s.color, 1.25);
    const yt = vy(q3), yb = vy(q1);
    ctx.rect(c - bw / 2, yt, bw, Math.max(0.5, yb - yt), s.color);
    ctx.hline(c - bw / 2, c + bw / 2, vy(med), WHITE, 1.5);
    const my = vy(mean), d = 3;
    ctx.line([[c - d, my - d], [c + d, my + d]], WHITE, 1.25);
    ctx.line([[c - d, my + d], [c + d, my - d]], WHITE, 1.25);
    for (const o of v.filter(x => x < flo || x > fhi).slice(0, MAX_MARKERS)) ctx.out.push({t: 'circle', cx: c, cy: vy(o), r: 2.5, fill: null, stroke: [s.color, 1]});
  });
}

// ---------------------------------------------------------------- stock

export function stock(ctx, chart, data, area) {
  const ncat = Math.min(MAX_CATS, Math.max(data.categories.length, ...data.series.map(s => s.values.length), 0));
  if (ncat === 0) return;
  const labels = Array.from({length: ncat}, (_, j) => catLabel(data, j));
  const r = valueRange(data.series.flatMap(s => s.values.filter(v => v !== null)));
  if (!r) return;
  const ys = niceScale(r[0], r[1], false);
  const f = new Fmt(data.series[0]?.numberFormat ?? 'General');
  const plot = frame(ctx, area, {labels, outer: []}, {scale: ys, fmt: f}, null, false, chart.gridlines !== false);
  if (!plot.ok()) return;
  const ser = k => data.series[k] ?? null;
  let open = null, high = null, low = null, close = null;
  switch (data.series.length) {
    case 0: return;
    case 1: close = ser(0); break;
    case 2: high = ser(0); low = ser(1); break;
    case 3: high = ser(0); low = ser(1); close = ser(2); break;
    default: open = ser(0); high = ser(1); low = ser(2); close = ser(3);
  }
  const get = (s, j) => (s ? s.values[j] ?? null : null);
  const cw = plot.w / ncat, tick = Math.max(1, cw * 0.25);
  const vy = v => plot.bottom - ys.frac(v) * plot.h;
  for (let j = 0; j < ncat; j++) {
    const c = plot.x + (j + 0.5) * cw;
    const h = get(high, j), l = get(low, j), o = get(open, j), cl = get(close, j);
    if (h !== null && l !== null) ctx.vline(c, vy(h), vy(l), STOCK, 1.25);
    if (o !== null && cl !== null) {
      const yo = vy(o), yc = vy(cl), bw = Math.max(1, cw * 0.5);
      ctx.rect(c - bw / 2, Math.min(yo, yc), bw, Math.max(0.75, Math.abs(yo - yc)), cl >= o ? WHITE : STOCK, [STOCK, 1]);
    } else if (o === null && cl !== null) {
      if (high) ctx.hline(c, c + tick, vy(cl), STOCK, 1.25);
      else ctx.out.push({t: 'circle', cx: c, cy: vy(cl), r: 2.5, fill: STOCK, stroke: null});
    }
  }
}
