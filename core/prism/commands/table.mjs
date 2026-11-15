// Table Design and Table Layout: table style and its options, shading, borders and the pen,
// rows and columns (insert, delete, sizes, distribute), merge and split, cell alignment, text
// direction and margins, the table's own size, the pencil and the eraser, and selecting cells.
// Translated from deckcraft crates/engine/src/cmd/table.rs, crates/engine/src/drawtable.rs and the
// ribbon crates/ui-egui/src/ribbon/table.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not in deckcraft, so not checked against upstream: `table.split` with a number of columns and rows
// (PowerPoint's Split Cells dialog), `table.textDirection` (a cell's text direction),
// `table.size` (Table Size: the table's rows and columns scale together), `table.background`
// (Shading > Table Background), `table.pen` (Pen Style, Weight and Color, which deckcraft keeps in
// the ribbon), `table.gridlines` (View Gridlines) and `table.selectCells` with `mode`.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {findShape} from '../model/presentation.mjs';
import {isSchema2, selectedShapeIds, currentSlideId, textSelection, slideById, shapeChain, shapeAddress} from '../model/doc.mjs';
import {ctxForSlide} from '../model/resolve.mjs';
import {insertRow, insertCol, deleteRow, deleteCol, merge, split, normalizeTable, tableStyles, tableWidth, tableHeight} from '../model/table.mjs';
import {drawLine, eraseAt, splitCell} from '../model/table-draw.mjs';
import {styleArt} from '../model/table-style.mjs';
import {colorRgb, colorScheme, colorWith, fillSolid, fillNone, lineSolid, lineNone, resolveColor} from '../model/style.mjs';
import {requestedFill} from './shape.mjs';
import {hex as hexOf, BLACK} from '../model/color.mjs';
import {UPSTREAM_COMMIT, bad, currentSlide, editShapes, colorValue, str, num, bool, clamp} from '../lib/shape-common.mjs';
import {idParam, idOf, optIndex, cellParam} from '../lib/text-session.mjs';
import {cellSelection, selectCellsOf, cellBlock, selectedRange, currentCell, MIN_COLUMN_WIDTH} from '../lib/table-sel.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/table.rs', 'crates/engine/src/drawtable.rs', 'crates/ui-egui/src/ribbon/table.rs']};

const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const id = s.optional(ID);
const cellS = s.array(s.integer({min: 0, max: 100000}), {min: 2, max: 2});
const cells = s.optional(s.array(cellS, {max: 100000}));
const anyOpt = d => s.optional(s.any({description: d}));

const OPTION_KEYS = Object.freeze({headerRow: 'firstRow', totalRow: 'lastRow', bandedRows: 'bandRow', firstColumn: 'firstCol', lastColumn: 'lastCol', bandedColumns: 'bandCol'});
const BORDER_SIDES = ['all', 'outside', 'inside', 'insideH', 'insideV', 'top', 'bottom', 'left', 'right', 'diagDown', 'diagUp', 'none'];
export const PEN_WEIGHTS = Object.freeze([0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6]);
export const PEN_STYLES = Object.freeze([['Solid', 'solid'], ['Dash', 'dash'], ['Dot', 'sysDot'], ['Dash Dot', 'dashDot'], ['Long Dash', 'lgDash']]);
const DIRS = Object.freeze({horizontal: 'horizontal', rotate90: 'vertical', rotate270: 'vertical270', stacked: 'stacked'});
const NOT_TABLE = {enabled: false, reason: 'select a table'};
const noDoc = {enabled: false, reason: 'no presentation open'};

// ---------------------------------------------------------------------------------------------
// Finding the table

/** The table a command acts on: `id`, the table being edited, the selected cells, or the first selected shape. */
function target(ctx, p, cmd) {
  if (!isSchema2(ctx.doc)) throw bad(cmd, 'no presentation open');
  const sl = currentSlide(ctx, cmd);
  let tid = idParam(p, 'id', cmd);
  if (tid === undefined) {
    const t = textSelection(ctx.doc, ctx.selection);
    tid = (t?.cell && !t.notes ? t.shape : null) ?? cellSelection(ctx.doc, ctx.selection)?.shape ?? selectedShapeIds(ctx.doc, ctx.selection)[0];
  }
  if (tid === undefined || tid === null) throw bad(cmd, 'select a table');
  const sh = findShape(sl.shapes, tid);
  if (!sh) throw bad(cmd, 'no such shape');
  if (sh.kind?.type !== 'table') throw bad(cmd, 'not a table');
  return {sl, sh, id: tid};
}

/** The selected table for a command's state: {sl, sh, t} or null. */
function selectedTable(ctx, p) {
  if (!isSchema2(ctx.doc)) return null;
  const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
  const t = textSelection(ctx.doc, ctx.selection);
  const tid = idOf(p?.id) ?? (t?.cell && !t.notes ? t.shape : null) ?? cellSelection(ctx.doc, ctx.selection)?.shape ?? selectedShapeIds(ctx.doc, ctx.selection)[0];
  const sh = tid ? findShape(sl?.shapes, tid) : null;
  return sh?.kind?.type === 'table' ? {sl, sh, t: sh.kind} : null;
}
const inTable = (ctx, p) => {
  if (!isSchema2(ctx.doc)) return noDoc;
  if (selectedTable(ctx, p)) return {enabled: true};
  const named = idOf(p?.id);
  return named && findShape(slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection))?.shapes, named) ? {enabled: false, reason: 'not a table'} : NOT_TABLE;
};

/** The row and column to act on: params, the edited cell, or the selected cells' first. */
function at(ctx, p, cmd, tid) {
  const cur = currentCell(ctx.doc, ctx.selection);
  const mine = cur && cur.shape === tid ? cur.cell : null;
  return [optIndex(p, 'row', cmd) ?? mine?.[0] ?? 0, optIndex(p, 'col', cmd) ?? mine?.[1] ?? 0];
}

/** `with_table`: edit table `id`'s table (a copy), size its frame to it, keep the caret's cell in range. */
function withTable(ctx, p, cmd, f) {
  const {id: tid} = target(ctx, p, cmd);
  const slideId = currentSlideId(ctx.doc, ctx.selection);
  editShapes(ctx, {ids: [tid]}, cmd, sh => {
    const out = f(sh.kind, sh);
    const t = normalizeTable(out ?? sh.kind);
    sh.kind = {...t, type: 'table'};
    if (sh.xfrm) { sh.xfrm.w = tableWidth(t); sh.xfrm.h = tableHeight(t); }
  }, [tid]);
  keepCellInRange(ctx, slideId, tid);
}

/** The edited cell or selected range may have moved out of range: bring it back to the table. */
function keepCellInRange(ctx, slideId, tid) {
  const t = findShape(slideById(ctx.doc, slideId)?.shapes, tid)?.kind;
  if (t?.type !== 'table' || !t.rows.length) return;
  const nr = t.rows.length, nc = t.cols.length;
  const ts = textSelection(ctx.doc, ctx.selection);
  if (ts?.cell && ts.shape === tid && !ts.notes && (ts.cell[0] >= nr || ts.cell[1] >= nc)) {
    const r = Math.min(ts.cell[0], nr - 1), c = Math.min(ts.cell[1], nc - 1);
    const sl = slideById(ctx.doc, slideId);
    const base = shapeAddress(slideId, shapeChain(sl, tid) ?? [tid]);
    ctx.setSelection({ranges: [{anchor: `${base}/r:${r}/c:${c}/t:0`, focus: `${base}/r:${r}/c:${c}/t:0`}], primary: 0});
    return;
  }
  const cs = cellSelection(ctx.doc, ctx.selection);
  if (cs && cs.shape === tid) {
    const cl = ([r, c]) => [Math.min(r, nr - 1), Math.min(c, nc - 1)];
    const [a, b] = [cl(cs.from), cl(cs.to)];
    if (a.join() !== cs.from.join() || b.join() !== cs.to.join()) ctx.setSelection(selectCellsOf(ctx.doc, slideId, tid, a, b));
  }
}

/** The cells a command acts on: `cells`, else the selected range (grown over merges), else the caret's cell, else every cell. */
function targetCells(ctx, p, tid, t) {
  if (Array.isArray(p.cells)) return p.cells.filter(c => Array.isArray(c) && c.length >= 2).slice(0, 100000).map(c => [c[0], c[1]]);
  const cs = cellSelection(ctx.doc, ctx.selection);
  let a = null, b = null;
  if (cs && cs.shape === tid) { [a, b] = cellBlock(t, cs.from, cs.to); }
  else {
    const ts = textSelection(ctx.doc, ctx.selection);
    if (ts?.cell && ts.shape === tid && !ts.notes) { a = ts.cell; b = ts.cell; }
  }
  if (a) {
    const r1 = Math.min(Math.max(a[0], b[0]), Math.max(t.rows.length - 1, 0)), c1 = Math.min(Math.max(a[1], b[1]), Math.max(t.cols.length - 1, 0));
    const out = [];
    for (let r = Math.min(a[0], b[0]); r <= r1; r++) for (let c = Math.min(a[1], b[1]); c <= c1; c++) out.push([r, c]);
    return out;
  }
  const out = [];
  for (let r = 0; r < t.rows.length; r++) for (let c = 0; c < t.cols.length; c++) out.push([r, c]);
  return out;
}

const cellOf = (t, r, c) => t.rows[r]?.cells?.[c] ?? null;

// ---------------------------------------------------------------------------------------------
// Rows and columns

function rowsCols(op, name) {
  return (ctx, p) => {
    const {id: tid} = target(ctx, p, name);
    const [r, c] = at(ctx, p, name, tid);
    withTable(ctx, p, name, t => {
      switch (op) {
        case 'rowAbove': return insertRow(t, r);
        case 'rowBelow': return insertRow(t, r + 1);
        case 'colLeft': return insertCol(t, c);
        case 'colRight': return insertCol(t, c + 1);
        case 'delRow': { const o = deleteRow(t, r); if (!o) throw bad(name, "can't delete the last row"); return o; }
        default: { const o = deleteCol(t, c); if (!o) throw bad(name, "can't delete the last column"); return o; }
      }
    });
    return {};
  };
}

function mergeCells(ctx, p) {
  const C = 'table.merge';
  const {id: tid} = target(ctx, p, C);
  const cs = cellSelection(ctx.doc, ctx.selection);
  const sel = cs && cs.shape === tid ? cs : null;
  const from = cellParam({cell: p.from}) ?? sel?.from;
  const to = cellParam({cell: p.to}) ?? sel?.to;
  if (!from) throw bad(C, 'missing `from`');
  if (!to) throw bad(C, 'missing `to`');
  withTable(ctx, p, C, t => {
    const o = merge(t, from[0], from[1], to[0], to[1]);
    if (!o) throw bad(C, "can't merge those cells");
    return o;
  });
  // The merged cell is the selection afterwards.
  const slideId = currentSlideId(ctx.doc, ctx.selection);
  const t = findShape(slideById(ctx.doc, slideId).shapes, tid).kind;
  const [a, b] = cellBlock(t, from, to);
  ctx.setSelection(selectCellsOf(ctx.doc, slideId, tid, a, b));
  return {};
}

function splitCells(ctx, p) {
  const C = 'table.split';
  const {id: tid} = target(ctx, p, C);
  let cell = cellParam(p);
  if (!cell) {
    const [r, c] = at(ctx, {row: p.row, col: p.col}, C, tid);
    cell = [r, c];
  }
  const cols = p.cols, rows = p.rows;
  withTable(ctx, p, C, t => {
    if (cols === undefined && rows === undefined) {
      const o = split(t, cell[0], cell[1]);
      if (!o) throw bad(C, "that cell isn't merged");
      return o;
    }
    const o = splitCell(t, cell[0], cell[1], cols ?? 1, rows ?? 1);
    if (!o) throw bad(C, "can't split that cell");
    return o;
  });
  return {};
}

// ---------------------------------------------------------------------------------------------
// Style, options, shading, borders

function style(ctx, p) {
  const C = 'table.style';
  const name = str(p, 'style');
  if (!name) throw bad(C, 'missing `style`');
  const known = tableStyles().some(([i]) => i === name) || (ctx.doc.tableStyles ?? []).some(d => String(d.id).toLowerCase() === name.toLowerCase());
  if (!known) throw bad(C, `unknown table style \`${name}\``);
  const id0 = (ctx.doc.tableStyles ?? []).find(d => String(d.id).toLowerCase() === name.toLowerCase())?.id;
  withTable(ctx, p, C, t => { t.style = id0 ?? name; });
  return {};
}

function options(ctx, p) {
  withTable(ctx, p, 'table.options', t => {
    for (const [k, field] of Object.entries(OPTION_KEYS)) {
      const v = bool(p, k);
      if (v !== undefined) t[field] = v;
    }
    // The ribbon's check boxes send the name of the option to flip.
    if (typeof p.toggle === 'string' && OPTION_KEYS[p.toggle] && typeof p[p.toggle] !== 'boolean') t[OPTION_KEYS[p.toggle]] = !t[OPTION_KEYS[p.toggle]];
  });
  return {};
}

/**
 * What a fill command asks for: a colour (a hex or theme name; `auto` / `none` for no fill), a `gradient`, a `pattern` or a
 * `picture` (as shape.fill), or a gradient `variation` (light or dark, at an `angle`) of each cell's own colour (Shading > Gradient).
 */
async function fillOf(ctx, p, C) {
  if (p.variation !== undefined) return {variation: p.variation, angle: Number.isFinite(p.angle) ? p.angle : 90};
  if (bool(p, 'none') || p.color === 'auto' || p.color === 'none') return {fill: fillNone()};
  if (p.gradient !== undefined || p.pattern !== undefined || p.picture !== undefined) {
    const r = await requestedFill(ctx, {gradient: p.gradient, pattern: p.pattern, picture: p.picture, name: p.name});
    return {fill: r.fill};
  }
  const c = p.color === undefined ? null : colorValue(p.color);
  if (p.color !== undefined && !c) throw bad(C, 'invalid `color`');
  return {fill: c ? fillSolid(c) : null};
}

/** The gradient of a variation: from the cell's solid colour (else accent 1) to a lighter tint or a darker shade of it. */
function variationFill(cell, v) {
  const base = cell?.fill?.kind === 'solid' ? cell.fill.color : colorScheme('accent1');
  const stops = v.variation === 'dark' ? [{pos: 0, color: base}, {pos: 1, color: colorWith(base, {op: 'shade', val: 50000})}]
    : [{pos: 0, color: colorWith(base, {op: 'tint', val: 40000})}, {pos: 1, color: base}];
  return {kind: 'gradient', stops, shape: {kind: 'linear', angle: ((v.angle % 360) + 360) % 360, scaled: false}, rotateWithShape: true};
}

async function cellFill(ctx, p) {
  const C = 'table.cellFill';
  const want = await fillOf(ctx, p, C);
  const {id: tid} = target(ctx, p, C);
  withTable(ctx, p, C, t => {
    for (const [r, c] of targetCells(ctx, p, tid, t)) {
      const cell = cellOf(t, r, c);
      if (!cell) continue;
      const fill = want.variation ? variationFill(cell, want) : want.fill;
      cell.fill = fill ? structuredClone(fill) : null;
    }
  });
  return {};
}

async function background(ctx, p) {
  const C = 'table.background';
  const {fill} = await fillOf(ctx, {...p, variation: undefined}, C);
  withTable(ctx, p, C, t => { if (fill && fill.kind !== 'none') t.background = fill; else delete t.background; });
  return {};
}

/** The pen Borders and Draw Table draw with: weight, dash and colour (deckcraft `app.table_pen`, 1 pt solid black to start). */
export const penOf = ctx => ({width: 1, dash: 'solid', color: null, ...(ctx.view?.tablePen ?? {})});

const LEFT = 0, RIGHT = 1, TOP = 2, BOTTOM = 3;

function borders(ctx, p) {
  const C = 'table.borders';
  const pen = penOf(ctx);
  const which = str(p, 'which') ?? 'all';
  if (!BORDER_SIDES.includes(which)) throw bad(C, `unknown \`which\` "${which}"; one of ${BORDER_SIDES.join(', ')}`);
  const color = (p.color !== undefined ? colorValue(p.color) : null) ?? pen.color ?? colorRgb(BLACK);
  const width = clamp(Number.isFinite(num(p, 'width')) ? p.width : pen.width, 0, 100);
  let line = lineSolid(color, width);
  const dash = str(p, 'dash') ?? pen.dash;
  if (dash && dash !== 'solid') line = {...line, dash: {kind: 'preset', name: dash}};
  // "none" clears to no line, so the table style's own lines don't show through either.
  if (which === 'none') line = lineNone();
  const {id: tid} = target(ctx, p, C);
  withTable(ctx, p, C, t => {
    const list = targetCells(ctx, p, tid, t);
    if (!list.length) return;
    const r0 = Math.min(...list.map(x => x[0])), r1 = Math.max(...list.map(x => x[0])), c0 = Math.min(...list.map(x => x[1])), c1 = Math.max(...list.map(x => x[1]));
    const rows = t.rows.length, cols = t.cols.length;
    // Set one side of a cell and the facing side of its neighbour, as PowerPoint does.
    const set = (r, c, side) => {
      const cell = cellOf(t, r, c);
      if (cell) { cell.borders = [...(cell.borders ?? [null, null, null, null])]; cell.borders[side] = structuredClone(line); }
      const n = side === LEFT ? (c > 0 ? [r, c - 1, RIGHT] : null) : side === RIGHT ? (c + 1 < cols ? [r, c + 1, LEFT] : null)
        : side === TOP ? (r > 0 ? [r - 1, c, BOTTOM] : null) : (r + 1 < rows ? [r + 1, c, TOP] : null);
      const nb = n && cellOf(t, n[0], n[1]);
      if (nb) { nb.borders = [...(nb.borders ?? [null, null, null, null])]; nb.borders[n[2]] = structuredClone(line); }
    };
    for (const [r, c] of list) {
      if (r < r0 || r > r1 || c < c0 || c > c1) continue;
      const outer = [c === c0, c === c1, r === r0, r === r1];
      for (const side of [LEFT, RIGHT, TOP, BOTTOM]) {
        const horizontal = side === TOP || side === BOTTOM;
        const on = which === 'all' || which === 'none' ? true : which === 'outside' ? outer[side] : which === 'inside' ? !outer[side]
          : which === 'insideH' ? horizontal && !outer[side] : which === 'insideV' ? !horizontal && !outer[side]
            : which === 'top' ? side === TOP && outer[side] : which === 'bottom' ? side === BOTTOM && outer[side]
              : which === 'left' ? side === LEFT && outer[side] : which === 'right' ? side === RIGHT && outer[side] : false;
        if (on) set(r, c, side);
      }
      const cell = cellOf(t, r, c);
      if (cell) {
        if (which === 'diagDown') cell.diagDown = structuredClone(line);
        else if (which === 'diagUp') cell.diagUp = structuredClone(line);
        else if (which === 'none') { cell.diagDown = null; cell.diagUp = null; }
      }
    }
  });
  return {};
}

/** Pen Style, Pen Weight and Pen Color: what Borders and Draw Table draw with. */
function pen(ctx, p) {
  const C = 'table.pen';
  const cur = penOf(ctx);
  const next = {...cur};
  if (p.weight !== undefined) { if (!(p.weight >= 0 && p.weight <= 100)) throw bad(C, '`weight` is a width in points'); next.width = p.weight; }
  if (p.dash !== undefined) { if (!PEN_STYLES.some(([, d]) => d === p.dash) && !['lgDashDot', 'sysDash', 'dot'].includes(p.dash)) throw bad(C, `unknown pen style "${p.dash}"`); next.dash = p.dash; }
  if (p.color !== undefined) {
    const c = p.color === 'auto' || p.color === 'none' ? null : colorValue(p.color);
    if (p.color !== 'auto' && p.color !== 'none' && !c) throw bad(C, 'invalid `color`');
    next.color = c;
  }
  ctx.setView({tablePen: next});
  return {pen: next};
}

// ---------------------------------------------------------------------------------------------
// Cell margins, alignment, text direction

function cellMargins(ctx, p) {
  const C = 'table.cellMargins';
  // PowerPoint's presets (left/right, top/bottom).
  const preset = str(p, 'preset');
  const base = preset === 'none' ? [0, 0, 0, 0] : preset === 'narrow' ? [3.6, 3.6, 3.6, 3.6] : preset === 'wide' ? [14.4, 14.4, 14.4, 14.4]
    : preset === 'normal' || preset === undefined ? [7.2, 7.2, 3.6, 3.6] : null;
  if (!base) throw bad(C, `unknown preset "${preset}"; one of normal, none, narrow, wide`);
  const side = (k, i) => (Number.isFinite(num(p, k)) ? clamp(p[k], 0, 400) : base[i]);
  const m = [side('left', 0), side('right', 1), side('top', 2), side('bottom', 3)];
  const {id: tid} = target(ctx, p, C);
  // A custom dialog may also set the vertical alignment and text direction.
  const anchor = p.anchor === undefined ? undefined : alignAnchor(p.anchor, C);
  const vertical = p.direction === undefined ? undefined : DIRS[p.direction];
  if (p.direction !== undefined && vertical === undefined) throw bad(C, `unknown text direction "${p.direction}"`);
  withTable(ctx, p, C, t => {
    for (const [r, c] of targetCells(ctx, p, tid, t)) {
      const cell = cellOf(t, r, c);
      if (!cell) continue;
      cell.margins = [...m];
      if (anchor !== undefined) cell.anchor = anchor;
      if (vertical !== undefined) cell.vertical = vertical === 'horizontal' ? null : vertical;
    }
  });
  return {};
}

function alignAnchor(v, C) {
  const a = {top: 'top', t: 'top', middle: 'middle', center: 'middle', ctr: 'middle', bottom: 'bottom', b: 'bottom'}[v];
  if (!a) throw bad(C, `unknown anchor "${v}"; one of top, middle, bottom`);
  return a;
}

function cellAlign(ctx, p) {
  const C = 'table.cellAlign';
  for (const k of ['align', 'anchor']) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== 'string') throw bad(C, `\`${k}\` is a name such as ${k === 'align' ? 'left or center' : 'top or middle'}`);
  // Without `align`, the vertical anchor is the whole command (top when not given).
  const align = p.align == null ? null : {left: 'left', l: 'left', center: 'center', centre: 'center', ctr: 'center', right: 'right', r: 'right', justify: 'justify', just: 'justify'}[p.align];
  if (p.align != null && !align) throw bad(C, `unknown align "${p.align}"; one of left, center, right, justify`);
  const anchor = p.anchor == null && align ? null : alignAnchor(p.anchor ?? 'top', C);
  const {id: tid} = target(ctx, p, C);
  withTable(ctx, p, C, t => {
    for (const [r, c] of targetCells(ctx, p, tid, t)) {
      const cell = cellOf(t, r, c);
      if (!cell) continue;
      if (anchor) cell.anchor = anchor;
      if (align) cell.text = {...cell.text, paragraphs: (cell.text?.paragraphs ?? []).map(pa => ({...pa, props: {...(pa.props ?? {}), align}}))};
    }
  });
  return {};
}

function textDirection(ctx, p) {
  const C = 'table.textDirection';
  const d = DIRS[p.dir ?? 'horizontal'];
  if (!d) throw bad(C, 'dir is one of horizontal, rotate90, rotate270, stacked');
  const {id: tid} = target(ctx, p, C);
  withTable(ctx, p, C, t => {
    for (const [r, c] of targetCells(ctx, p, tid, t)) { const cell = cellOf(t, r, c); if (cell) cell.vertical = d === 'horizontal' ? null : d; }
  });
  return {};
}

// ---------------------------------------------------------------------------------------------
// Sizes

function distribute(rows) {
  return (ctx, p) => {
    withTable(ctx, p, 'table.distribute', t => {
      if (rows) { const h = tableHeight(t) / Math.max(t.rows.length, 1); t.rows.forEach(r => { r.height = h; }); }
      else { const w = tableWidth(t) / Math.max(t.cols.length, 1); t.cols = t.cols.map(() => w); }
    });
    return {};
  };
}

function columnWidth(ctx, p) {
  const C = 'table.columnWidth';
  const {id: tid} = target(ctx, p, C);
  const [, c] = at(ctx, p, C, tid);
  if (!Number.isFinite(num(p, 'width'))) throw bad(C, 'missing `width`');
  const w0 = clamp(p.width, 4, 4000);
  const keep = p.keepTotal === true;
  withTable(ctx, p, C, t => {
    // Keeping the table's width, the column to the right gives or takes the difference (dragging an inner border).
    // The last column has none: the table gets wider or narrower.
    const pair = t.cols[c] !== undefined && t.cols[c + 1] !== undefined ? Math.max(t.cols[c], 0) + Math.max(t.cols[c + 1], 0) : null;
    if (keep && pair !== null && Number.isFinite(pair)) {
      const min = Math.min(MIN_COLUMN_WIDTH, pair / 2);
      const w = Math.min(Math.max(w0, min), pair - min);
      t.cols[c] = w;
      t.cols[c + 1] = pair - w;
    } else if (t.cols[c] !== undefined) t.cols[c] = w0;
  });
  return {};
}

function rowHeight(ctx, p) {
  const C = 'table.rowHeight';
  const {id: tid} = target(ctx, p, C);
  const [r] = at(ctx, p, C, tid);
  if (!Number.isFinite(num(p, 'height'))) throw bad(C, 'missing `height`');
  const h = clamp(p.height, 4, 4000);
  withTable(ctx, p, C, t => { if (t.rows[r]) t.rows[r].height = h; });
  return {};
}

/** Table Size: scale the table's columns and rows together (Height and Width, with the aspect ratio locked or not). */
function tableSize(ctx, p) {
  const C = 'table.size';
  const {sh} = target(ctx, p, C);
  const w0 = tableWidth(sh.kind), h0 = tableHeight(sh.kind);
  const lock = p.lockAspect ?? !!sh.kind.lockAspect;
  let w = Number.isFinite(num(p, 'w')) ? clamp(p.w, 1, 15840) : undefined;
  let h = Number.isFinite(num(p, 'h')) ? clamp(p.h, 1, 15840) : undefined;
  if (w === undefined && h === undefined) throw bad(C, 'give `w` or `h`');
  if (lock && w !== undefined && h === undefined) h = w0 > 0 ? (h0 * w) / w0 : h0;
  else if (lock && h !== undefined && w === undefined) w = h0 > 0 ? (w0 * h) / h0 : w0;
  const kx = w !== undefined && w0 > 0 ? w / w0 : 1, ky = h !== undefined && h0 > 0 ? h / h0 : 1;
  withTable(ctx, p, C, t => {
    t.cols = t.cols.map(c => c * kx);
    t.rows.forEach(r => { r.height *= ky; });
  });
  return {};
}

function lockAspect(ctx, p) {
  const C = 'table.lockAspect';
  const {sh} = target(ctx, p, C);
  const on = p.on ?? !sh.kind.lockAspect;
  withTable(ctx, p, C, t => { if (on) t.lockAspect = true; else delete t.lockAspect; });
  return {on};
}

// ---------------------------------------------------------------------------------------------
// Draw Table, Table Eraser

/** The table under slide point `at` (frontmost) or the one named by `id`: {sh, ox, oy}. */
function tableAtPoint(ctx, p, point, C) {
  const sl = currentSlide(ctx, C);
  const want = idParam(p, 'id', C);
  for (const sh of [...sl.shapes].reverse()) {
    const x = sh.xfrm;
    if (!x || sh.kind?.type !== 'table' || sh.hidden) continue;
    const inside = point[0] >= x.x && point[1] >= x.y && point[0] <= x.x + tableWidth(sh.kind) && point[1] <= x.y + tableHeight(sh.kind);
    if (want === undefined ? inside : want === sh.id) return {sh, ox: x.x, oy: x.y};
  }
  return null;
}
const pointParam = (p, k) => {
  const a = p?.[k];
  return Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]) ? [a[0], a[1]] : null;
};

function drawLineCmd(ctx, p) {
  const C = 'table.drawLine';
  const from = pointParam(p, 'from'), to = pointParam(p, 'to');
  if (!from) throw bad(C, 'missing `from`');
  if (!to) throw bad(C, 'missing `to`');
  const hit = tableAtPoint(ctx, p, from, C);
  if (!hit) throw bad(C, 'no table there');
  const a = [from[0] - hit.ox, from[1] - hit.oy], b = [to[0] - hit.ox, to[1] - hit.oy];
  withTable(ctx, {id: hit.sh.id}, C, t => {
    const o = drawLine(t, a, b);
    if (!o) throw bad(C, "the line doesn't divide any cell");
    return o;
  });
  return {};
}

function eraseLineCmd(ctx, p) {
  const C = 'table.eraseLine';
  const point = pointParam(p, 'at');
  if (!point) throw bad(C, 'missing `at`');
  const tol = Number.isFinite(p.tol) ? clamp(p.tol, 0.5, 50) : 6;
  const hit = tableAtPoint(ctx, p, point, C);
  if (!hit) throw bad(C, 'no table there');
  const q = [point[0] - hit.ox, point[1] - hit.oy];
  withTable(ctx, {id: hit.sh.id}, C, t => {
    const o = eraseAt(t, q, tol);
    if (!o) throw bad(C, 'no border to erase there');
    return o;
  });
  return {};
}

// ---------------------------------------------------------------------------------------------
// Selecting cells

function selectCells(ctx, p) {
  const C = 'table.selectCells';
  const {sl, sh, id: tid} = target(ctx, {id: p.id}, C);
  const t = sh.kind;
  const cur = currentCell(ctx.doc, ctx.selection);
  const here = cur && cur.shape === tid ? cur.cell : [0, 0];
  let from = cellParam({cell: p.from}), to = cellParam({cell: p.to});
  const nr = t.rows.length, nc = t.cols.length;
  if (p.mode === 'row') { from = [here[0], 0]; to = [here[0], nc - 1]; }
  else if (p.mode === 'column') { from = [0, here[1]]; to = [nr - 1, here[1]]; }
  else if (p.mode === 'table') { from = [0, 0]; to = [nr - 1, nc - 1]; }
  else if (p.mode === 'cell') { from = here; to = here; }
  from ??= [0, 0];
  to ??= from;
  ctx.setSelection(selectCellsOf(ctx.doc, sl.id, tid, from, to));
  return {};
}

/** Delete with a range of cells selected: the text in those cells goes and the cells stay, each keeping its first paragraph's formatting. */
function clearCells(ctx, p) {
  const C = 'table.clearCells';
  const {id: tid} = target(ctx, p, C);
  withTable(ctx, p, C, t => {
    const range = selectedRange(cellSelection(ctx.doc, ctx.selection), tid, t);
    t.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
      if (range && !(r >= range[0][0] && r <= range[1][0] && c >= range[0][1] && c <= range[1][1])) return;
      const first = cell.text?.paragraphs?.[0];
      cell.text = {...(cell.text ?? {body: {}}), paragraphs: first ? [{...first, runs: []}] : []};
    }));
  });
  return {};
}

/** Shift+arrow with a range of cells selected: the cell the range was extended to moves by (dr, dc), on past a merged cell until the range changes. The cell it started from stays. */
function extendCells(ctx, p) {
  const C = 'table.extendCells';
  const {sl, sh, id: tid} = target(ctx, p, C);
  const cs = cellSelection(ctx.doc, ctx.selection);
  if (!cs || cs.shape !== tid) return {extended: false};
  const t = sh.kind;
  const nr = t.rows.length, nc = t.cols.length;
  const dr = Math.trunc(p.dr ?? 0), dc = Math.trunc(p.dc ?? 0);
  const old = cellBlock(t, cs.from, cs.to).join('|');
  let end = cs.to;
  while (cellBlock(t, cs.from, end).join('|') === old) {
    const r = end[0] + dr, c = end[1] + dc;
    if (r < 0 || r >= nr || c < 0 || c >= nc) break;
    end = [r, c];
  }
  ctx.setSelection(selectCellsOf(ctx.doc, sl.id, tid, cs.from, end));
  return {extended: true};
}

// ---------------------------------------------------------------------------------------------
// States and the gallery

/** The caret's cell, else the selected range's first, else the table's first cell. */
function curCell(ctx, tid) {
  const c = currentCell(ctx.doc, ctx.selection);
  return c && c.shape === tid ? c.cell : [0, 0];
}

const hex = c => `#${hexOf(c)}`;

/** The Table Styles gallery: every built-in style drawn in miniature with the table's options, then the file's own. */
function styleGallery(ctx, st) {
  const rc = ctxForSlide(ctx.doc, st.sl);
  if (!rc) return [];
  const t = st.t;
  const flags = {firstRow: t.firstRow, firstCol: t.firstCol, lastRow: t.lastRow, lastCol: t.lastCol, bandRow: t.bandRow, bandCol: t.bandCol};
  const out = [];
  const quick = new Set(tableStyles().filter(([i]) => i.startsWith('medium2') || i === 'none' || i === 'grid').slice(0, 8).map(x => x[0]));
  const groups = [['Best Match for Document', i => quick.has(i)], ['Light', i => i.startsWith('light')], ['Medium', i => i.startsWith('medium') && !quick.has(i)], ['Dark', i => i.startsWith('dark')]];
  const cur = String(t.style ?? '').toLowerCase();
  const add = (i, label, group, inline, def) => out.push({id: i, label, value: i, group, inline, selected: cur === String(i).toLowerCase(), art: styleArt(rc, i, flags, def)});
  for (const [g, pred] of groups) for (const [i, label] of tableStyles()) if (pred(i)) add(i, label, g, g === 'Best Match for Document');
  for (const d of ctx.doc.tableStyles ?? []) add(d.id, d.name || d.id, 'Custom', false, d);
  return out;
}

export default defineCommands({
  family: 'table',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.insertRowAbove', label: 'Insert Above', risk: 'edit', state: inTable, description: '{row?, id?}', params: s.object({row: s.optional(s.integer({min: 0})), id}), run: rowsCols('rowAbove', 'table.insertRowAbove')},
    {id: 'table.insertRowBelow', label: 'Insert Below', risk: 'edit', state: inTable, description: '{row?, id?}', params: s.object({row: s.optional(s.integer({min: 0})), id}), run: rowsCols('rowBelow', 'table.insertRowBelow')},
    {id: 'table.insertColumnLeft', label: 'Insert Left', risk: 'edit', state: inTable, description: '{col?, id?}', params: s.object({col: s.optional(s.integer({min: 0})), id}), run: rowsCols('colLeft', 'table.insertColumnLeft')},
    {id: 'table.insertColumnRight', label: 'Insert Right', risk: 'edit', state: inTable, description: '{col?, id?}', params: s.object({col: s.optional(s.integer({min: 0})), id}), run: rowsCols('colRight', 'table.insertColumnRight')},
    {id: 'table.deleteRow', label: 'Delete Rows', risk: 'edit', state: inTable, description: '{row?, id?}', params: s.object({row: s.optional(s.integer({min: 0})), id}), run: rowsCols('delRow', 'table.deleteRow')},
    {id: 'table.deleteColumn', label: 'Delete Columns', risk: 'edit', state: inTable, description: '{col?, id?}', params: s.object({col: s.optional(s.integer({min: 0})), id}), run: rowsCols('delCol', 'table.deleteColumn')},
    {id: 'table.merge', label: 'Merge Cells', risk: 'edit', description: '{from: [r, c], to: [r, c], id?} (default: the selected cells)', params: s.object({from: s.optional(cellS), to: s.optional(cellS), id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        if (p?.from && p?.to) return {enabled: true};
        const cs = cellSelection(ctx.doc, ctx.selection);
        if (!cs || cs.shape !== st.sh.id) return {enabled: false, reason: 'select two or more cells to merge'};
        const [a, b] = cellBlock(st.t, cs.from, cs.to);
        return a[0] === b[0] && a[1] === b[1] ? {enabled: false, reason: 'select two or more cells to merge'} : {enabled: true};
      }, run: mergeCells},
    {id: 'table.split', label: 'Split Cells…', risk: 'edit', state: inTable, dialog: 'dialog.splitCells',
      description: '{cell?: [r, c] (else the edited cell), id?} undoes a merge; {cols?, rows?} also divides the cell into that many columns and rows (PowerPoint\'s Split Cells)',
      params: s.object({cell: s.optional(cellS), row: s.optional(s.integer({min: 0})), col: s.optional(s.integer({min: 0})), cols: s.optional(s.integer({min: 1, max: 63})), rows: s.optional(s.integer({min: 1, max: 63})), id}), run: splitCells},

    {id: 'table.style', label: 'Table Styles', risk: 'edit', description: '{style: medium2-accent1|light1-accent2|dark1-tx1|grid|none… or a style of the file, id?}',
      params: s.object({style: s.string({min: 1, max: 80}), id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        return {enabled: true, value: styleGallery(ctx, st)};
      }, run: style},
    {id: 'table.options', label: 'Table Style Options', risk: 'edit',
      description: '{headerRow?, totalRow?, bandedRows?, firstColumn?, lastColumn?, bandedColumns?: bool, toggle?: one of those names to flip, id?}',
      params: s.object({...Object.fromEntries(Object.keys(OPTION_KEYS).map(k => [k, s.optional(s.boolean())])), toggle: s.optional(s.enum(Object.keys(OPTION_KEYS))), id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        const k = p?.toggle ?? Object.keys(OPTION_KEYS).find(x => p && x in p);
        return {enabled: true, ...(k ? {checked: !!st.t[OPTION_KEYS[k]]} : {}), value: Object.fromEntries(Object.entries(OPTION_KEYS).map(([n, f]) => [n, !!st.t[f]]))};
      }, run: options},
    {id: 'table.cellFill', label: 'Shading', risk: 'edit', description: '{color? | none? | gradient? | pattern? | picture? (base64) | variation?: light|dark (+ angle), cells?: [[r, c], ...] (default: the selected cells or all), id?}',
      params: s.object({color: anyOpt('#RRGGBB | accent1... | auto = no fill'), none: s.optional(s.boolean()), gradient: anyOpt('{stops: [[0, color], [1, color]], kind?, angle?} as shape.fill'), pattern: anyOpt('{preset, fg, bg} as shape.fill'),
        picture: s.optional(s.string({max: 100000000})), name: s.optional(s.string({max: 260})), variation: s.optional(s.enum(['light', 'dark'])), angle: s.optional(s.number()), cells, id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        const [r, c] = curCell(ctx, st.sh.id);
        const f = cellOf(st.t, r, c)?.fill;
        const rc = ctxForSlide(ctx.doc, st.sl);
        const col = f?.kind === 'solid' && rc ? resolveColor(f.color, rc.master.theme.colors) : null;
        return {enabled: true, value: col ? hex(col) : null};
      }, run: cellFill},
    {id: 'table.background', label: 'Table Background', risk: 'edit', state: inTable, description: '{color? | none?, id?}: the fill behind the whole table',
      params: s.object({color: anyOpt('#RRGGBB | accent1... | auto = no fill'), none: s.optional(s.boolean()), gradient: anyOpt('as shape.fill'), pattern: anyOpt('as shape.fill'), picture: s.optional(s.string({max: 100000000})), name: s.optional(s.string({max: 260})), id}), run: background},
    {id: 'table.borders', label: 'Borders', risk: 'edit', state: inTable,
      description: '{which: all|outside|inside|insideH|insideV|top|bottom|left|right|diagDown|diagUp|none, color?, width?: pt, dash?: solid|dash|sysDot|dashDot|lgDash, cells?, id?} (the pen when color, width or dash are left out)',
      params: s.object({which: s.optional(s.enum(BORDER_SIDES)), color: anyOpt('#RRGGBB | accent1...'), width: s.optional(s.number({min: 0, max: 100})), dash: s.optional(s.string({max: 32})), cells, id}), run: borders},
    {id: 'table.pen', label: 'Pen', risk: 'read', effect: 'view', description: '{weight?: pt, dash?: solid|dash|sysDot|dashDot|lgDash, color?}: the pen Borders and Draw Table draw with',
      params: s.object({weight: s.optional(s.number({min: 0, max: 100})), dash: s.optional(s.string({max: 32})), color: anyOpt('#RRGGBB | accent1... | auto = black')}),
      state(ctx, p) {
        if (!isSchema2(ctx.doc)) return noDoc;
        const pn = penOf(ctx);
        let checked;
        if (p?.weight !== undefined) checked = pn.width === p.weight;
        else if (p?.dash !== undefined) checked = (pn.dash ?? 'solid') === p.dash;
        const rc = ctxForSlide(ctx.doc, slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection)));
        const col = pn.color && rc ? hex(resolveColor(pn.color, rc.master.theme.colors)) : '#000000';
        return {enabled: true, ...(checked === undefined ? {value: col} : {checked})};
      }, run: pen},
    {id: 'table.cellMargins', label: 'Cell Margins', risk: 'edit', state: inTable, dialog: 'dialog.cellMargins',
      description: '{preset?: normal|none|narrow|wide, left?, right?, top?, bottom?: pt, anchor?: top|middle|bottom, direction?: horizontal|rotate90|rotate270|stacked, cells?, id?}',
      params: s.object({preset: s.optional(s.enum(['normal', 'none', 'narrow', 'wide'])), left: s.optional(s.number()), right: s.optional(s.number()), top: s.optional(s.number()), bottom: s.optional(s.number()),
        anchor: s.optional(s.enum(['top', 'middle', 'bottom'])), direction: s.optional(s.enum(Object.keys(DIRS))), cells, id}),
      run: cellMargins},
    {id: 'table.cellAlign', label: 'Align Cell Text', risk: 'edit', description: '{anchor?: top|middle|bottom (vertical; top when neither anchor nor align is given), align?: left|center|right|justify, cells?, id?}',
      params: s.object({anchor: s.optional(s.string({max: 16})), align: s.optional(s.string({max: 16})), cells, id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        const [r, c] = curCell(ctx, st.sh.id);
        const cell = cellOf(st.t, r, c);
        return {enabled: true, ...(p?.anchor ? {checked: (cell?.anchor ?? 'top') === alignAnchor(p.anchor, 'table.cellAlign')} : {})};
      }, run: cellAlign},
    {id: 'table.textDirection', label: 'Text Direction', risk: 'edit', description: '{dir: horizontal|rotate90|rotate270|stacked, cells?, id?}: the direction of the text in the selected cells',
      params: s.object({dir: s.optional(s.enum(Object.keys(DIRS))), cells, id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        const [r, c] = curCell(ctx, st.sh.id);
        const v = cellOf(st.t, r, c)?.vertical ?? 'horizontal';
        return {enabled: true, ...(p?.dir ? {checked: (DIRS[p.dir] ?? 'horizontal') === v} : {})};
      }, run: textDirection},
    {id: 'table.distributeRows', label: 'Distribute Rows', risk: 'edit', state: inTable, description: '{id?}', params: s.object({id}), run: distribute(true)},
    {id: 'table.distributeColumns', label: 'Distribute Columns', risk: 'edit', state: inTable, description: '{id?}', params: s.object({id}), run: distribute(false)},
    {id: 'table.columnWidth', label: 'Table Column Width', risk: 'edit', description: '{col, width: pt, keepTotal?: bool (the next column absorbs the change), id?}',
      params: s.object({col: s.optional(s.integer({min: 0})), width: s.number({min: 0, max: 100000}), keepTotal: s.optional(s.boolean()), id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        return {enabled: true, value: Math.round((st.t.cols[curCell(ctx, st.sh.id)[1]] ?? 0) * 10) / 10};
      }, run: columnWidth},
    {id: 'table.rowHeight', label: 'Table Row Height', risk: 'edit', description: '{row, height: pt, id?}',
      params: s.object({row: s.optional(s.integer({min: 0})), height: s.number({min: 0, max: 100000}), id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        return {enabled: true, value: Math.round((st.t.rows[curCell(ctx, st.sh.id)[0]]?.height ?? 0) * 10) / 10};
      }, run: rowHeight},
    {id: 'table.size', label: 'Table Size', risk: 'edit', description: '{w?, h?: pt, lockAspect?: bool, id?}: scale the table (every column and row together); `dim` names the one a spinner shows',
      params: s.object({w: s.optional(s.number({min: 0, max: 100000})), h: s.optional(s.number({min: 0, max: 100000})), dim: s.optional(s.enum(['width', 'height'])), lockAspect: s.optional(s.boolean()), id}),
      state(ctx, p) {
        const st = selectedTable(ctx, p);
        if (!st) return isSchema2(ctx.doc) ? NOT_TABLE : noDoc;
        return {enabled: true, value: Math.round(((p?.dim ?? (p?.w !== undefined ? 'width' : 'height')) === 'width' ? tableWidth(st.t) : tableHeight(st.t)) * 10) / 10};
      }, run: tableSize},
    {id: 'table.lockAspect', label: 'Lock Aspect Ratio', risk: 'edit', description: '{on?: bool, id?}',
      params: s.object({on: s.optional(s.boolean()), id}),
      state(ctx, p) { const st = selectedTable(ctx, p); return st ? {enabled: true, checked: !!st.t.lockAspect} : isSchema2(ctx.doc) ? NOT_TABLE : noDoc; }, run: lockAspect},
    {id: 'table.drawLine', label: 'Draw Table', risk: 'edit', state: ctx => (isSchema2(ctx.doc) && ctx.doc.slides.length ? {enabled: true} : noDoc),
      description: '{from: [x, y], to: [x, y] slide pt, id?: table (default: the one under `from`)} splits the cells the line crosses',
      params: s.object({from: s.array(s.number(), {min: 2, max: 2}), to: s.array(s.number(), {min: 2, max: 2}), id}), run: drawLineCmd},
    {id: 'table.eraseLine', label: 'Table Eraser', risk: 'edit', state: ctx => (isSchema2(ctx.doc) && ctx.doc.slides.length ? {enabled: true} : noDoc),
      description: '{at: [x, y] slide pt, id?, tol?: pt (default 6)} merges the two cells on either side of the nearest border',
      params: s.object({at: s.array(s.number(), {min: 2, max: 2}), id, tol: s.optional(s.number())}), run: eraseLineCmd},
    {id: 'table.selectCells', label: 'Select Cells', risk: 'read', effect: 'view', state: inTable,
      description: '{from: [r, c], to: [r, c], id?} | {mode: cell|row|column|table}: select cells of a table',
      params: s.object({from: s.optional(cellS), to: s.optional(cellS), mode: s.optional(s.enum(['cell', 'row', 'column', 'table'])), id}), run: selectCells},
    {id: 'table.clearCells', label: 'Clear Cells', risk: 'edit', state: inTable, description: '{id?}: delete the text of the selected cells (the cells stay)', params: s.object({id}), run: clearCells},
    {id: 'table.extendCells', label: 'Extend Cell Selection', risk: 'read', effect: 'view', state: inTable, description: '{dr, dc}: Shift+arrow: move the end of the selected range of cells',
      params: s.object({dr: s.optional(s.integer({min: -1000, max: 1000})), dc: s.optional(s.integer({min: -1000, max: 1000})), id}), run: extendCells},
    {id: 'table.gridlines', label: 'View Gridlines', risk: 'read', effect: 'view', description: '{on?: bool}: show the cell borders of tables as dotted lines',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => (!isSchema2(ctx.doc) ? noDoc : {enabled: true, checked: !!ctx.view?.tableGridlines}),
      run(ctx, p) { const on = p.on ?? !ctx.view?.tableGridlines; ctx.setView({tableGridlines: on}); return {on}; }},
  ],
});

