// How a table is drawn: the look of each cell from its table style (the built-in presets, or a
// style the file defines), the cell's own overrides, the text it gets, the rows' drawn heights and
// the cells' rectangles.
// Translated from deckcraft crates/render/src/table.rs (`look_def`, `look_with_def`, `style_fill`,
// `fill_color`, `border_look`, the preset looks, `cell_body_with_def`, `row_heights_with_def`,
// `cell_rects`) at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Colours are {r, g, b, a} (0-255). A look is {fill, text, bold, border: [rgba, width] | null,
// sides: [left, right, top, bottom] of [rgba, width] | null, paint: [fill, ph] | null}.

import {BLACK, WHITE, TRANSPARENT, apply as applyTransforms, contrast} from './color.mjs';
import {ctxColor} from './resolve.mjs';
import {colorScheme, colorRgb, fillSolid} from './style.mjs';
import {layoutText} from './textlayout.mjs';

export const TABLE_PARTS = Object.freeze(['wholeTbl', 'band1H', 'band2H', 'band1V', 'band2V', 'lastCol', 'firstCol', 'lastRow', 'firstRow', 'seCell', 'swCell', 'neCell', 'nwCell']);

const isCovered = c => !!(c?.hMerge || c?.vMerge);
const spanOf = (c, k) => Math.max(c?.[k] ?? 1, 1);

/** The accent colour a built-in style id names (`medium2-accent3`, `dark1-tx1`). */
function accent(ctx, style) {
  const slot = {accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', tx1: 'tx1'}[String(style).split('-').pop()] ?? 'accent1';
  return ctxColor(ctx, colorScheme(slot), null);
}

/** The file-defined style `t.style` names (a GUID), or null. */
export function resolveStyle(ctx, t) {
  const id = String(t.style ?? '').toLowerCase();
  return (ctx.pres?.tableStyles ?? []).find(d => String(d.id).toLowerCase() === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// A style the file defines

/** A style part's fill: a theme fill reference resolved to the theme's fill with its colour as placeholder. */
export function styleFill(ctx, ps) {
  if (ps.fillRef) {
    const [idx, col] = ps.fillRef;
    const ph = ctxColor(ctx, col, null);
    const f = ctx.master?.theme?.format?.fills?.[Math.max(idx - 1, 0)];
    if (f && idx > 0) return [f, ph];
    if (idx === 0) return [{kind: 'none'}, null];
    return [fillSolid(colorRgb(ph)), null];
  }
  return ps.fill ? [ps.fill, null] : null;
}

/** A fill's colour for a table cell (gradients and pictures by their first colour). */
function fillColor(ctx, f, ph) {
  if (!f || f.kind === 'none') return TRANSPARENT;
  if (f.kind === 'solid') return ctxColor(ctx, f.color, ph);
  if (f.kind === 'gradient') return f.stops?.[0] ? ctxColor(ctx, f.stops[0].color, ph) : null;
  if (f.kind === 'pattern') return ctxColor(ctx, f.bg, ph);
  return null;
}

/** A style border's colour and width (a transparent colour for no line). */
function borderLook(ctx, b) {
  if (b.kind === 'line') {
    const ln = b.line ?? {};
    const f = ln.fill;
    if (f?.kind === 'solid') return [ctxColor(ctx, f.color, null), ln.width ?? 0.75];
    if (f?.kind === 'gradient') return [f.stops?.[0] ? ctxColor(ctx, f.stops[0].color, null) : BLACK, ln.width ?? 0.75];
    return [TRANSPARENT, 0];
  }
  const w = ctx.master?.theme?.format?.lines?.[Math.max(b.idx - 1, 0)]?.width ?? 0.75;
  return b.idx === 0 ? [TRANSPARENT, 0] : [ctxColor(ctx, b.color, null), w];
}

const partOf = (def, name) => (def.parts ?? []).find(([k]) => k === name)?.[1] ?? null;

/**
 * The look of cell (r, c) from a style the file defines: each part that applies to the cell (whole
 * table, bands, first and last rows and columns, corners, in that order) sets the fill, text and
 * the borders on its region's edges (its inside lines within it).
 */
function lookDef(ctx, def, t, r, c) {
  const rows = t.rows.length, cols = t.cols.length;
  const cell = t.rows[r]?.cells?.[c];
  let r1 = cell ? r + spanOf(cell, 'rowSpan') - 1 : r, c1 = cell ? c + spanOf(cell, 'gridSpan') - 1 : c;
  r1 = Math.min(r1, Math.max(rows - 1, 0));
  c1 = Math.min(c1, Math.max(cols - 1, 0));
  const lastR = Math.max(rows - 1, 0), lastC = Math.max(cols - 1, 0);
  const header = !!t.firstRow && r === 0;
  const total = !!t.lastRow && r1 === lastR && rows > 1;
  const firstCol = !!t.firstCol && c === 0;
  const lastCol = !!t.lastCol && c1 === lastC && cols > 1;
  const bodyR = Math.max(r - (t.firstRow ? 1 : 0), 0), bodyC = Math.max(c - (t.firstCol ? 1 : 0), 0);
  const look = {fill: null, text: null, bold: false, border: null, sides: [null, null, null, null], paint: null};
  for (const part of TABLE_PARTS) {
    let on, region;
    switch (part) {
      case 'wholeTbl': on = true; region = [0, lastR, 0, lastC]; break;
      case 'band1H': on = t.bandRow && !header && !total && bodyR % 2 === 0; region = [r, r1, 0, lastC]; break;
      case 'band2H': on = t.bandRow && !header && !total && bodyR % 2 === 1; region = [r, r1, 0, lastC]; break;
      case 'band1V': on = t.bandCol && !firstCol && !lastCol && bodyC % 2 === 0; region = [0, lastR, c, c1]; break;
      case 'band2V': on = t.bandCol && !firstCol && !lastCol && bodyC % 2 === 1; region = [0, lastR, c, c1]; break;
      case 'lastCol': on = lastCol; region = [0, lastR, c, lastC]; break;
      case 'firstCol': on = firstCol; region = [0, lastR, 0, c1]; break;
      case 'lastRow': on = total; region = [r, lastR, 0, lastC]; break;
      case 'firstRow': on = header; region = [0, r1, 0, lastC]; break;
      case 'seCell': on = total && lastCol; region = [r, r1, c, c1]; break;
      case 'swCell': on = total && firstCol; region = [r, r1, c, c1]; break;
      case 'neCell': on = header && lastCol; region = [r, r1, c, c1]; break;
      default: on = header && firstCol; region = [r, r1, c, c1];
    }
    if (!on) continue;
    const ps = partOf(def, part);
    if (!ps) continue;
    const p = styleFill(ctx, ps);
    if (p) { look.fill = fillColor(ctx, p[0], p[1]); look.paint = p; }
    if (ps.textColor) look.text = ctxColor(ctx, ps.textColor, null);
    if (ps.bold !== null && ps.bold !== undefined) look.bold = ps.bold;
    const [r0, rr1, c0, cc1] = region;
    // Left, right, top, bottom of the cell: the part's edge or its inside line.
    const pick = [c === c0 ? 0 : 5, c1 === cc1 ? 1 : 5, r === r0 ? 2 : 4, r1 === rr1 ? 3 : 4];
    pick.forEach((i, side) => { const b = ps.borders?.[i]; if (b) look.sides[side] = borderLook(ctx, b); });
  }
  return look;
}

// ---------------------------------------------------------------------------------------------
// The built-in styles

const tint = (a, k) => applyTransforms(a, [{op: 'tint', val: k}]);
const shade = (a, k) => applyTransforms(a, [{op: 'shade', val: k}]);
const strong = p => p.header || p.total || p.firstCol || p.lastCol;
const plain = (o = {}) => ({fill: null, text: null, bold: false, border: null, sides: [null, null, null, null], paint: null, ...o});

const light1Look = (a, p, on) => { const fill = p.banded ? tint(a, 20000) : null; return plain({fill, text: fill ? on(fill) : null, bold: strong(p), border: p.header ? [a, 1] : null}); };
const light2Look = (a, p) => plain({fill: p.header ? a : null, text: p.header ? WHITE : null, bold: p.header || p.total || p.firstCol, border: [a, 1]});
const dark1Look = (a, p) => plain({fill: p.header ? BLACK : p.banded ? shade(a, 60000) : shade(a, 75000), text: WHITE, bold: p.header || p.total || p.firstCol, border: [WHITE, 1]});
const medium4Look = (a, p, on) => { const fill = p.header || p.banded ? tint(a, 40000) : tint(a, 20000); return plain({fill, text: on(fill), bold: strong(p), border: [a, 0.75]}); };
/** medium2: strong header, banded light tints, white grid. */
const medium2Look = (a, p, on) => {
  const st = strong(p);
  const fill = st ? a : p.banded ? tint(a, 40000) : tint(a, 20000);
  return plain({fill, text: st ? WHITE : on(fill), bold: st, border: [WHITE, 1]});
};

/** The look of cell (r, c): the file's style when it defines one, else a built-in one (`look_with_def`). */
export function lookOf(ctx, t, r, c, def = resolveStyle(ctx, t)) {
  if (def) return lookDef(ctx, def, t, r, c);
  const style = String(t.style ?? '');
  const a = accent(ctx, style);
  const kind = style.split('-')[0] || 'medium2';
  const header = !!t.firstRow && r === 0;
  const total = !!t.lastRow && r + 1 === t.rows.length;
  const firstCol = !!t.firstCol && c === 0;
  const lastCol = !!t.lastCol && c + 1 === t.cols.length;
  const bodyR = t.firstRow ? r - 1 : r;
  const band = !!t.bandRow && !header && !total && bodyR >= 0 && bodyR % 2 === 0;
  const bandC = !!t.bandCol && c % 2 === 0;
  const p = {header, total, firstCol, lastCol, banded: band || bandC};
  const text = ctxColor(ctx, colorScheme('tx1'), null);
  // Text on a tinted cell is the theme's dark colour (a dark theme may map tx1 away from it), or the light one when that
  // contrasts more with the fill.
  const dk1 = ctxColor(ctx, colorScheme('dk1'), null), lt1 = ctxColor(ctx, colorScheme('lt1'), null);
  const on = fill => (contrast(dk1, fill) >= contrast(lt1, fill) ? dk1 : lt1);
  switch (kind) {
    case 'none': return plain();
    case 'grid': return plain({border: [text, 0.75]});
    case 'light1': return light1Look(a, p, on);
    case 'light2': return light2Look(a, p);
    case 'dark1': return dark1Look(a, p);
    case 'medium4': return medium4Look(a, p, on);
    default: return medium2Look(a, p, on);
  }
}

// ---------------------------------------------------------------------------------------------
// Cell text, rows and rectangles

const MARGINS = Object.freeze([7.2, 7.2, 3.6, 3.6]);
export const cellMargins = cell => cell?.margins ?? MARGINS;

/** A cell's text as drawn: its margins, anchor and direction, plus the table style's text colour and bold (`cell_body_with_def`). */
export function cellBody(ctx, t, r, c, cell, def = resolveStyle(ctx, t)) {
  const lk = lookOf(ctx, t, r, c, def);
  const [ml, mr, mt, mb] = cellMargins(cell);
  const text = cell.text ?? {body: {}, paragraphs: []};
  const body = {...(text.body ?? {}), insetL: ml, insetR: mr, insetT: mt, insetB: mb, anchor: cell.anchor ?? 'top'};
  if (cell.vertical) body.vert = cell.vertical;
  const paragraphs = (text.paragraphs ?? []).map(p => ({...p, runs: (p.runs ?? []).map(run => {
    const props = {...(run.props ?? {})};
    let changed = false;
    if (!props.fill && lk.text) { props.fill = fillSolid(colorRgb(lk.text)); changed = true; }
    if (lk.bold && props.bold === undefined) { props.bold = true; changed = true; }
    if (lk.bold && props.bold === null) { props.bold = true; changed = true; }
    return changed ? {...run, props} : run;
  })}));
  return {...text, body, paragraphs};
}

/** The shape a cell's text is laid out as (deckcraft `Shape::table_cell`): a plain rectangle holding the body. */
export const cellShape = (sh, body) => ({...sh, kind: {type: 'shape'}, geom: {kind: 'preset', name: 'rect'}, ph: null, textBox: false, text: body});

/** Running edges 0, s0, s0 + s1, ... (negative sizes count as 0). */
export function edges(sizes) {
  const out = [0];
  let acc = 0;
  for (const s of sizes) { acc += Math.max(s ?? 0, 0); out.push(acc); }
  return out;
}

/**
 * Heights the rows are drawn at: a stored height is a minimum and the row grows so the text of each
 * of its cells fits, as in PowerPoint. Cells spanning several rows and vertical text keep the stored
 * height. `opts` carries the text measurer ({measure, metrics}).
 */
export function rowHeights(ctx, t, sh, opts = MEASURE, def = resolveStyle(ctx, t)) {
  const xs = edges(t.cols);
  return t.rows.map((row, ri) => {
    let h = Math.max(row.height ?? 0, 0);
    row.cells.slice(0, t.cols.length).forEach((cell, ci) => {
      if (isCovered(cell) || spanOf(cell, 'rowSpan') > 1 || (cell.vertical && cell.vertical !== 'horizontal')) return;
      if (!(cell.text?.paragraphs ?? []).length) return;
      const c1 = Math.min(ci + spanOf(cell, 'gridSpan'), t.cols.length);
      const x0 = xs[ci], x1 = xs[c1];
      if (x0 === undefined || x1 === undefined) return;
      const body = cellBody(ctx, t, ri, ci, cell, def);
      if (!body.paragraphs.length) return;
      try {
        const l = layoutText(ctx, cellShape(sh, body), body, {rect: {x0, y0: 0, x1, y1: Math.max(h, 1)}, noShrink: true, ...opts});
        const need = l.contentHeight + body.body.insetT + body.body.insetB;
        if (Number.isFinite(need)) h = Math.max(h, Math.min(need, 20000));
      } catch { /* a layout that fails keeps the stored height */ }
    });
    return h;
  });
}

/** The text metrics tables measure their rows with: the surface's canvas ones; without them the layout's own estimate. */
let MEASURE = {};
let heightCache = new WeakMap();
export function setTextMeasure(opts) { MEASURE = opts ?? {}; heightCache = new WeakMap(); }

/**
 * The drawn heights of a table shape's rows, kept while the table, its master and the file's table styles are the same objects
 * (every edit makes new ones), so hit tests, boxes and drawing do not lay the cells' text out again for each pointer move.
 */
export function drawnHeights(ctx, sh) {
  const hit = heightCache.get(sh.kind);
  if (hit && hit.master === ctx.master && hit.styles === ctx.pres?.tableStyles) return hit.heights;
  const heights = rowHeights(ctx, sh.kind, sh);
  heightCache.set(sh.kind, {master: ctx.master, styles: ctx.pres?.tableStyles, heights});
  return heights;
}

/** Cell rectangles in table space, merges honoured: [{r, c, x0, y0, x1, y1}] for the visible cells. `heights` are the drawn row heights. */
export function cellRects(t, heights) {
  const out = [];
  const xs = edges(t.cols), ys = edges(heights);
  t.rows.forEach((row, ri) => row.cells.slice(0, t.cols.length).forEach((cell, ci) => {
    if (isCovered(cell)) return;
    const c1 = Math.min(ci + spanOf(cell, 'gridSpan'), t.cols.length), r1 = Math.min(ri + spanOf(cell, 'rowSpan'), t.rows.length);
    const x0 = xs[ci], x1 = xs[c1], y0 = ys[ri], y1 = ys[r1];
    if ([x0, x1, y0, y1].some(v => v === undefined)) return;
    out.push({r: ri, c: ci, x0, y0, x1, y1});
  }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The picture of a style in the gallery

const avg = list => ({r: Math.round(list.reduce((a, c) => a + c.r, 0) / list.length), g: Math.round(list.reduce((a, c) => a + c.g, 0) / list.length), b: Math.round(list.reduce((a, c) => a + c.b, 0) / list.length), a: Math.round(list.reduce((a, c) => a + c.a, 0) / list.length)});
const css = c => (c.a === 255 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${+(c.a / 255).toFixed(3)})`);

/**
 * The gallery tile of a table style: a 3 x 4 miniature of a table in this style with the table's
 * own style options, each cell's fill, its lines and the colour of its text.
 */
export function styleArt(ctx, styleId, flags = {}, def = null) {
  const rows = 4, cols = 3;
  const t = {style: styleId, firstRow: flags.firstRow ?? true, firstCol: !!flags.firstCol, lastRow: !!flags.lastRow, lastCol: !!flags.lastCol,
    bandRow: flags.bandRow ?? true, bandCol: !!flags.bandCol, cols: Array(cols).fill(1), rows: Array.from({length: rows}, () => ({height: 1, cells: Array.from({length: cols}, () => ({gridSpan: 1, rowSpan: 1}))}))};
  const d = def ?? resolveStyle(ctx, t);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lk = lookOf(ctx, t, r, c, d);
      const sides = [0, 1, 2, 3].map(i => {
        const b = lk.sides[i] ?? lk.border;
        return b && b[0].a > 0 && b[1] > 0 ? [css(b[0]), Math.min(Math.max(b[1], 0.5), 2)] : null;
      });
      // A gradient style fill is drawn in the tile as the average of its stops.
      const g = lk.paint?.[0];
      const fillC = g?.kind === 'gradient' && g.stops?.length ? avg(g.stops.map(st => ctxColor(ctx, st.color, lk.paint[1]))) : lk.fill;
      cells.push({fill: fillC && fillC.a > 0 ? css(fillC) : null, text: lk.text ? css(lk.text) : null, bold: !!lk.bold, sides});
    }
  }
  return {kind: 'tablestyle', rows, cols, cells};
}
