// Table layout: the grid, cell margins and borders, table style regions, row heights, vertical
// merges and vertical alignment; and `splitRow`, which cuts a row at a page bottom.
//
// Translated from wordcraft crates/layout/src/table.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: AutoFit to contents
// (`column_content`/`autofit`: columns keep the file's grid, scaled to a set table width),
// turned cell text (`text_direction` down/up lays out horizontally), percentage widths relative to
// another section's footer (`pct_base`).
import {borderVisible, cellResolvedMargins, tableLook} from '../model/props.mjs';
import {partsOfCell, tableStyle, tableStylePart} from '../model/styles.mjs';
import {cellSpan, rowFirstGrid, rowGridAfter, tableCols} from '../model/table.mjs';
import {layoutBox, shadingColor} from './boxes.mjs';
import {itemBottom, rect, vSpan} from './placed.mjs';

const DEFAULT_MARGINS = [0, 5.4, 0, 5.4];
const MAX_WIDTH_SHARE = 10;

const band = b => (borderVisible(b) ? Math.max(0, Math.min(12, b.width)) : 0);

/** The table style's formatting for cells, regions keyed by their parts. */
function regionOf(t, style, ri, g, span, ncols) {
  if (!style) return null;
  const look = tableLook(t.props);
  const bs = style.parts.bandSize ?? 1, cs = style.parts.colBandSize ?? 1;
  return partsOfCell(look, [bs, cs], [ri, t.rows.length], [g, span, ncols]);
}
/** What the style gives a region (region_text / region_look): text formatting, fill, borders, vertical alignment. */
function regionLook(style, parts) {
  let chr = {}, fill = null, borders = {}, vAlign = null;
  const para = {...style.para};
  for (const p of parts) {
    const f = tableStylePart(style, p);
    chr = {...chr, ...f.chr};
    if (f.fill) fill = f.fill;
    if (f.borders) borders = {...borders, ...f.borders};
    if (f.vAlign) vAlign = f.vAlign;
    if (f.align && p !== 'wholeTable') para.align = f.align;
  }
  return {text: {para, chr}, fill, borders, vAlign};
}

/** Cell margins of the table (default_margins). */
function defaultMargins(t, style) {
  return t.props.cellMargins ?? style?.parts?.cellMargins ?? DEFAULT_MARGINS;
}

/** The left margin of the first cell (first_cell_left_margin). */
export function firstCellLeftMargin(ctx, t) {
  const style = t.props.style ? tableStyle(ctx.doc.styles, t.props.style) : null;
  const c = t.rows[0]?.cells[0];
  return c ? cellResolvedMargins(c.props, defaultMargins(t, style))[1] : defaultMargins(t, style)[1];
}

/** The table's columns and where it starts (table_frame). */
function tableFrame(ctx, t, avail, style) {
  const ncols = Math.max(tableCols(t), 1);
  let grid = t.grid.length === ncols ? t.grid.map(w => (!Number.isFinite(w) ? 72 : w <= 0 ? 4 : w)) : new Array(ncols).fill(avail / ncols);
  applyCellWidths(t, grid);
  let total = grid.reduce((s, w) => s + w, 0);
  const p = t.props;
  const target = p.widthPct > 0 ? avail * Math.min(p.widthPct / 100, MAX_WIDTH_SHARE) : p.width > 0 ? p.width : null;
  if (target !== null) {
    if (total > 0 && total < 1) grid = grid.map(w => (w / total) * target);
    else { const k = target / Math.max(total, 1); grid = grid.map(w => w * k); }
    total = target;
  }
  if (target === null && total > avail * 1.5 && !p.fixed) {
    const k = avail / Math.max(total, 1);
    grid = grid.map(w => w * k);
    total = avail;
  }
  const colx = [];
  let acc = 0;
  for (const w of grid) { colx.push(acc); acc += w; }
  colx.push(acc);
  const marginsDef = defaultMargins(t, style);
  const indent = p.indent ?? 0;
  const tborders = {...(style?.parts?.borders ?? {}), ...(p.borders ?? {})};
  const first = t.rows[0]?.cells[0];
  const rtl = !!p.bidiVisual;
  let startOffset;
  if ((ctx.doc.settings.compatMode ?? 15) >= 15) {
    const b = first?.props?.borders?.left ?? tborders.left;
    startOffset = indent + (borderVisible(b) ? Math.max(0, Math.min(12, b.width)) / 2 : 0);
  } else startOffset = indent - (first ? cellResolvedMargins(first.props, marginsDef)[1] : marginsDef[1]);
  let x;
  if (p.align === 'center') x = (avail - total) / 2;
  else if (p.align === 'right') x = rtl ? 0 : avail - total;
  else x = rtl ? avail - total - startOffset : startOffset;
  return {ncols, colx, acc, total, marginsDef, tborders, rtl, x};
}

/** Cell widths that disagree with the grid set it (apply_cell_widths): only unambiguous single-span widths. */
function applyCellWidths(t, grid) {
  const want = new Array(grid.length).fill(null);
  for (const r of t.rows) {
    let g = rowFirstGrid(r);
    for (const c of r.cells) {
      const span = cellSpan(c);
      const w = c.props?.width;
      if (span === 1 && Number.isFinite(w) && w > 0 && g < grid.length) {
        if (want[g] === null) want[g] = w; else if (Math.abs(want[g] - w) > 0.5) want[g] = NaN;
      }
      g += span;
    }
  }
  want.forEach((w, g) => { if (w !== null && Number.isFinite(w) && Math.abs(grid[g] - w) > 0.5) grid[g] = w; });
}

/** Lay out table `t` `avail` wide (layout_table): {x, width, rows: RowLayout[]}. */
export function layoutTable(ctx, story, t, path, avail, depth) {
  const style = t.props.style ? tableStyle(ctx.doc.styles, t.props.style) : null;
  const {ncols, colx, acc, total, marginsDef, tborders, rtl, x} = tableFrame(ctx, t, avail, style);
  const nrows = t.rows.length;
  const looks = new Map();
  const lookOf = parts => {
    if (!parts) return null;
    const k = parts.join(',');
    let l = looks.get(k);
    if (!l) { l = regionLook(style, parts); looks.set(k, l); }
    return l;
  };
  const rows = [], heights = [], bottoms = [], edges = [];
  for (let ri = 0; ri < nrows; ri++) {
    const row = t.rows[ri];
    let g = rowFirstGrid(row);
    const cells = [];
    let rh = 0, rowInsets = 0, rowBelow = 0, rowEdge = 0, collapsed = true;
    let rowTop = 0, rowBottom = 0;
    for (const c of row.cells) { const m = cellResolvedMargins(c.props, marginsDef); rowTop = Math.max(rowTop, m[0]); rowBottom = Math.max(rowBottom, m[2]); }
    for (let ci = 0; ci < row.cells.length; ci++) {
      const cell = row.cells[ci];
      const cp = cell.props ?? {};
      const span = cellSpan(cell);
      let x0 = colx[g] ?? acc, x1 = colx[Math.min(g + span, ncols)] ?? acc;
      if (rtl) [x0, x1] = [Math.max(acc - x1, 0), Math.max(acc - x0, 0)];
      const m = cellResolvedMargins(cp, marginsDef);
      const margins = rtl ? [rowTop, m[3], rowBottom, m[1]] : [rowTop, m[1], rowBottom, m[3]];
      const cw = Math.max(x1 - x0 - margins[1] - margins[3], 4);
      const look = lookOf(regionOf(t, style, ri, g, span, ncols));
      const fill = shadingColor(cp.shading) ?? look?.fill ?? null;
      const text = look ? look.text : null;
      const cpath = path.concat([ri, ci]);
      const cb = cp.borders ?? {};
      const rowB = row.props?.exceptions?.borders ?? {};
      const firstG = g === rowFirstGrid(row), lastG = g + span >= ncols - rowGridAfter(row);
      const rb = look?.borders ?? {};
      const edge = (own, outer, outerB, innerB) => own ?? (outer ? outerB : innerB) ?? null;
      const borders = {
        top: edge(cb.top ?? (ri === 0 ? rowB.top : rowB.between) ?? (ri === 0 ? rb.top : rb.between ?? rb.insideH ?? rb.top), ri === 0, tborders.top, tborders.between ?? tborders.insideH),
        bottom: edge(cb.bottom ?? (ri + 1 === nrows ? rowB.bottom : rowB.between) ?? (ri + 1 === nrows ? rb.bottom : rb.between ?? rb.insideH ?? rb.bottom), ri + 1 === nrows, tborders.bottom, tborders.between ?? tborders.insideH),
        left: edge(cb.left ?? (firstG ? rowB.left : rowB.inside_v) ?? (firstG ? rb.left : rb.inside_v), firstG, tborders.left, tborders.inside_v),
        right: edge(cb.right ?? (lastG ? rowB.right : rowB.inside_v) ?? (lastG ? rb.right : rb.inside_v), lastG, tborders.right, tborders.inside_v),
      };
      // Diagonal lines across the cell (Table Design > Borders > Diagonal Down and Up Border): not part of any style or the table's own borders.
      borders.diagDown = cb.diagDown ?? null;
      borders.diagUp = cb.diagUp ?? null;
      if (rtl) [borders.left, borders.right] = [borders.right, borders.left];
      let bandT = band(borders.top);
      const bandB = ri + 1 === nrows ? band(borders.bottom) : 0;
      if (!(bandT > 0 || cp.vmerge === 'continue')) {
        for (const above of rows[rows.length - 1] ?? []) if (above.g < g + span && g < above.g + above.span && above.vmerge === 'none') bandT = Math.max(bandT, band(above.borders.bottom));
      }
      const insets = margins[0] + margins[2] + bandT + bandB;
      let items = [], h = 0;
      if (cp.vmerge !== 'continue') {
        const laid = layoutBox(ctx, {story, blocks: cell.blocks, prefix: cpath, width: cw, cell: text, depth});
        let height = laid.height;
        const lastB = cell.blocks[cell.blocks.length - 1];
        if (cp.hideMark && lastB?.kind === 'para' && lastB.text.length === 0) height = laid.lastTop; else collapsed = false;
        items = laid.items;
        for (const it of items) shiftItem(it, x0 + margins[1], margins[0] + bandT);
        h = Math.max(height, laid.floatsBottom);
      }
      h += insets;
      const end = h - margins[2] - bandB;
      if (cp.vmerge !== 'restart') rh = Math.max(rh, h);
      rowInsets = Math.max(rowInsets, insets);
      rowBelow = Math.max(rowBelow, margins[2] + bandB);
      if (ri + 1 < nrows) rowEdge = Math.max(rowEdge, band(borders.bottom));
      cells.push({items, h, x: x0, w: x1 - x0, valign: cp.valign ?? look?.vAlign ?? 'top', fill, borders, vmerge: cp.vmerge ?? 'none', margins, g, span, end});
      g += span;
    }
    const hp = row.props ?? {};
    if (hp.heightRule === 'exact' && hp.height > 0) rh = hp.height + rowBottom;
    else if (hp.height > 0) rh = Math.max(rh, hp.height + rowInsets);
    bottoms.push(rowBelow);
    edges.push(rowEdge);
    heights.push(collapsed && cells.length ? Math.max(rh, 0) : Math.max(rh, 4));
    rows.push(cells);
  }
  growVerticalMerges(t, rows, heights);
  return finishRows(t, story, path, rows, heights, bottoms, edges, x, total);
}

/** A vertically merged cell's rows grow to hold its content (grow_vertical_merges). */
function growVerticalMerges(t, rows, heights) {
  const cont = contGrid(t);
  for (let ri = 0; ri < rows.length; ri++) {
    for (const c of rows[ri]) {
      if (c.vmerge !== 'restart') continue;
      let end = ri;
      while (cont[end + 1]?.includes(c.g)) end++;
      let sum = 0;
      for (let k = ri; k <= end; k++) sum += heights[k];
      if (c.h > sum + 0.01) heights[end] += c.h - sum;
    }
  }
}
function contGrid(t) {
  return t.rows.map(r => {
    let g = rowFirstGrid(r);
    const out = [];
    for (const c of r.cells) { if ((c.props?.vmerge ?? 'none') === 'continue') out.push(g); g += cellSpan(c); }
    return out;
  });
}

/** Second pass: cells with their row height, fills and borders (finish_table_rows). */
function finishRows(t, story, path, rows, heights, bottoms, edges, x, total) {
  const cont = contGrid(t);
  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const rh = heights[ri] ?? 0;
    const hp = t.rows[ri].props ?? {};
    const exact = hp.heightRule === 'exact' && hp.height > 0;
    const items = [], parts = [];
    rows[ri].forEach((c, ci) => {
      const first = items.length;
      let spanH = rh;
      if (c.vmerge === 'restart') for (let k = ri + 1; cont[k]?.includes(c.g); k++) spanH += heights[k] ?? 0;
      const r = rect(c.x, 0, c.w, spanH);
      if (c.vmerge !== 'continue' && c.fill) items.push({kind: 'fill', rect: r, color: c.fill});
      const dy = c.valign === 'center' ? Math.max((spanH - c.h) / 2, 0) : c.valign === 'bottom' ? Math.max(spanH - c.h, 0) : 0;
      const end = c.vmerge !== 'continue' ? c.end + dy : null;
      for (const it of c.items) items.push(shiftItem(it, 0, dy));
      const b = c.borders;
      const x0 = c.x, x1 = c.x + c.w, y0 = 0, y1 = rh;
      const half = o => (borderVisible(o) ? o.width / 2 : 0);
      const hx0 = x0 - half(b.left), hx1 = x1 + half(b.right);
      if (c.vmerge !== 'continue' && borderVisible(b.top)) items.push({kind: 'rule', x0: hx0, y0, x1: hx1, y1: y0, border: b.top});
      const lastOfMerge = c.vmerge === 'none' || !cont[ri + 1]?.includes(c.g);
      if (lastOfMerge && borderVisible(b.bottom)) items.push({kind: 'rule', x0: hx0, y0: y1, x1: hx1, y1, border: b.bottom});
      if (borderVisible(b.left)) items.push({kind: 'rule', x0, y0, x1: x0, y1, border: b.left});
      if (borderVisible(b.right)) items.push({kind: 'rule', x0: x1, y0, x1, y1, border: b.right});
      if (c.vmerge !== 'continue' && borderVisible(b.diagDown)) items.push({kind: 'rule', x0, y0, x1, y1: spanH, border: b.diagDown});
      if (c.vmerge !== 'continue' && borderVisible(b.diagUp)) items.push({kind: 'rule', x0, y0: spanH, x1, y1: y0, border: b.diagUp});
      items.push({kind: 'cell', rect: rect(c.x, 0, c.w, c.vmerge === 'continue' ? rh : spanH), covered: c.vmerge === 'continue', table: path, row: ri, cell: ci, story,
        clip: exact && c.h > spanH + 0.01});
      parts.push({top: c.margins[0] + band(b.top), items: [first, items.length], end});
    });
    out.push({height: rh, items, bottom: bottoms[ri] ?? 0, edge: edges[ri] ?? 0, cells: parts});
  }
  return {x, width: total, rows: out};
}

export function shiftItem(it, dx, dy) {
  if (it.kind === 'lines') { it.x += dx; it.y += dy; } else if (it.kind === 'rule') { it.x0 += dx; it.x1 += dx; it.y0 += dy; it.y1 += dy; } else if (it.rect) it.rect = {...it.rect, x: it.rect.x + dx, y: it.rect.y + dy};
  if (it.kind === 'object' && it.origin) it.origin = {x: it.origin.x + dx, y: it.origin.y + dy};
  return it;
}
const clone = it => ({...it});

/** The first line of a paragraph piece that moves on past `limit` (line_split), widow/orphan control applied. */
function lineSplit(para, l0, l1, y, limit, end) {
  const n = para.lines.length;
  let k = l0;
  while (k < l1) {
    let bottom = itemBottom(y, para, l0, k + 1);
    if (bottom === null) break;
    if (k + 1 === n && end !== null) bottom = Math.max(end, bottom);
    if (bottom > limit + 0.01) break;
    k++;
  }
  if (para.rp.widowControl && k > l0 && k < l1) {
    if (n - k === 1) k--;
    if (l0 === 0 && k === 1) k = 0;
  }
  return k;
}

/** Cut a row at `cut` below its top (split_row): [the part left on the page, the rest] or null. */
export function splitRow(row, cut) {
  if (!(cut > 0 && cut < row.height)) return null;
  const limit = cut - Math.max(0, Math.min(row.bottom, cut));
  const fits = b => b <= limit + 0.01;
  const cells = row.cells.map(c => row.items.slice(c.items[0], c.items[1]));
  let ownDepth = Infinity;
  for (const it of row.items) if (it.kind === 'cell') ownDepth = Math.min(ownDepth, it.table.length);
  const splits = cells.map((items, ci) => {
    const c = row.cells[ci];
    let lowest = -Infinity;
    for (const it of items) if (it.kind === 'lines') lowest = Math.max(lowest, itemBottom(it.y, it.para, it.l0, it.l1) ?? -Infinity);
    return items.map(it => {
      if (it.kind !== 'lines') return 0;
      const last = it.l1 === it.para.lines.length && (itemBottom(it.y, it.para, it.l0, it.l1) ?? -Infinity) >= lowest - 0.01;
      return lineSplit(it.para, it.l0, it.l1, it.y, limit, last ? c.end : null);
    });
  });
  // A cell widow/orphan control leaves empty, though its first line would fit, takes the row on.
  for (let ci = 0; ci < cells.length; ci++) {
    const idx = cells[ci].findIndex(it => it.kind === 'lines');
    if (idx < 0) continue;
    const it = cells[ci][idx], split = splits[ci][idx];
    const pa = it.para;
    if (split === it.l0 && pa.rp.widowControl && it.l1 - it.l0 > 1 && !fits(itemBottom(it.y, pa, it.l0, it.l1) ?? 0)) {
      const l = pa.lines[it.l0];
      if (fits(it.y + l.height)) return null;
    }
  }
  let keptAny = false;
  const moved = cells.map(() => Infinity);
  cells.forEach((items, ci) => items.forEach((it, i) => {
    const split = splits[ci][i];
    let top = null;
    if (it.kind === 'lines') {
      keptAny ||= split > it.l0;
      const base = it.para.lines[it.l0]?.top ?? 0;
      if (split < it.l1) top = it.para.lines[split] ? it.y + it.para.lines[split].top - base : it.y;
    } else if (it.kind === 'image' || it.kind === 'shape') {
      if (fits(it.rect.y + it.rect.h)) keptAny = true; else top = it.rect.y;
    } else if (it.kind === 'cell' && it.table.length > ownDepth && it.rect.y < cut && it.rect.y + it.rect.h > cut + 0.01) top = cut;
    if (top !== null) moved[ci] = Math.min(moved[ci], top);
  }));
  const firstMoved = Math.min(...moved);
  if (!keptAny || firstMoved === Infinity) return null;
  const shifts = moved.map((m, ci) => Math.max((m < Infinity ? m : firstMoved) - row.cells[ci].top, 0));
  const full = Math.max(row.height - Math.min(...shifts), 4);
  let need = row.height - cut;
  row.cells.forEach((c, ci) => { if (moved[ci] < Infinity) need = Math.max(need, (c.end === null ? row.height : c.end + row.bottom) - shifts[ci]); });
  const height = Math.max(4, Math.min(need, full));
  const rest = Math.max(row.height - height, 0);
  const geo = (bottom, s) => (bottom >= row.height - 0.01 ? rest : s);
  const a = [], b = [], parts = [];
  cells.forEach((items, ci) => {
    const start = b.length;
    const s = shifts[ci];
    items.forEach((it, i) => {
      const split = splits[ci][i];
      switch (it.kind) {
        case 'lines': {
          const base = it.para.lines[it.l0]?.top ?? 0;
          if (split > it.l0) a.push({...it, l1: split});
          if (split < it.l1) { const top = it.para.lines[split] ? it.y + it.para.lines[split].top - base : it.y; b.push({...it, l0: split, y: top - s}); }
          break;
        }
        case 'image': case 'shape': case 'object':
          if (fits(it.rect.y + it.rect.h)) a.push(clone(it)); else b.push(shiftItem(clone(it), 0, -s));
          break;
        case 'fill': case 'cell': {
          const [above, below] = splitRect(it.rect, cut, geo(it.rect.y + it.rect.h, s));
          if (above) a.push({...it, rect: above});
          if (below) b.push({...it, rect: below});
          break;
        }
        case 'rule': {
          if (Math.abs(it.y0 - it.y1) < 0.01) {
            if (it.y0 <= 0.01) { a.push(clone(it)); b.push({...it, y0: 0, y1: 0}); } else if (it.y0 >= row.height - 0.01) { a.push({...it, y0: cut, y1: cut}); b.push({...it, y0: it.y0 - rest, y1: it.y1 - rest}); } else if (it.y0 <= cut) a.push(clone(it));
            else b.push({...it, y0: it.y0 - s, y1: it.y1 - s});
          } else {
            const t0 = Math.min(it.y0, it.y1), bt = Math.max(it.y0, it.y1);
            if (t0 < cut) a.push({...it, y0: t0, y1: Math.min(bt, cut)});
            if (bt > cut) { const sh = geo(bt, s); b.push({...it, y0: Math.max(t0 - sh, 0), y1: bt - sh}); }
          }
          break;
        }
        default: a.push(clone(it));
      }
    });
    const c = row.cells[ci];
    parts.push({top: c.top, items: [start, b.length], end: c.end === null ? null : c.end - s});
  });
  return [{height: cut, items: a, bottom: row.bottom, edge: 0, cells: []}, {height, items: b, bottom: row.bottom, edge: row.edge, cells: parts}];
}

function splitRect(r, cut, shift) {
  const above = r.y < cut ? rect(r.x, r.y, r.w, Math.min(r.y + r.h, cut) - r.y) : null;
  const below = r.y + r.h > cut ? rect(r.x, Math.max(r.y, cut) - shift, r.w, r.y + r.h - Math.max(r.y, cut)) : null;
  return [above && above.h > 0 ? above : null, below && below.h > 0 ? below : null];
}
export {vSpan};
