// Table Layout and Table Design leftovers (U:quill/rest): the table pen and eraser modes of the page view (Draw Table, Eraser) and Border Sampler.
//
// Not checked against upstream for the modes and the sampler (wordcraft's table_draw.rs has the draw and erase commands themselves, which the
// page view now runs from the pointer; the pen and sampler buttons follow Word):
// - `table.drawMode` picks what dragging on the page does: `draw` (a dragged rectangle draws a table, a dragged line splits cells), `erase`
//   (a click removes the border under it), `sample` (a click copies that border's line style, weight and colour into the table pen), or `off`.
//   Choosing the mode that is already on turns it off, as Word's toggle buttons. It is view state, never an edit.
// - `table.borderSample` reads the border under a point of a page and makes it the pen the Borders menu and Border Painter draw with.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {rgbHex, parseRgb, border as mkBorder, borderVisible} from '../model/props.mjs';
import * as T from '../lib/table-session.mjs';
import {eraseTarget} from './table_draw.mjs';
import {layoutOfS} from './table_resize.mjs';
import {penOf} from './table_misc.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/table_draw.rs']};
const MODES = ['draw', 'erase', 'sample', 'off'];
const num = () => s.number();
const failed = m => new CommandError('failed', m);
export const drawModeOf = view => (['draw', 'erase', 'sample'].includes(view?.tableDraw) ? view.tableDraw : null);

function drawMode(ctx, p) {
  const cur = drawModeOf(ctx.view);
  const next = p.mode === 'off' ? null : cur === p.mode ? null : p.mode;
  ctx.setView({tableDraw: next});
  return {mode: next};
}

/** The line a border of the cell at (r, c) on `side` draws, falling back to the cell beside it and the table's inside lines. */
function borderBeside(t, e) {
  const [r, c] = e.first, [r2, c2] = e.second;
  const a = t.rows[r]?.cells[c], b = t.rows[r2]?.cells[c2];
  const own = e.across ? 'right' : 'bottom', other = e.across ? 'left' : 'top';
  const tb = t.props?.borders ?? {};
  return [a?.props?.borders?.[own], b?.props?.borders?.[other], e.across ? tb.inside_v : tb.between].find(x => borderVisible(x)) ?? null;
}

function borderSample(ctx, p) {
  const S = T.open(ctx);
  const l = layoutOfS(S);
  if (!l?.pages[p.page]) throw new CommandError('invalid_params', `no page ${p.page}`);
  const e = eraseTarget(l, p.page, p.x, p.y);
  if (!e) throw failed('there\'s no border between two cells there');
  const t = S.d.table(e.story, e.table);
  if (!t) throw failed('the cells aren\'t there any more');
  const b = borderBeside(t, e);
  const pen = {...penOf(ctx.view)};
  if (b) { pen.style = b.style; pen.width = Math.max(0.25, Math.min(6, b.width || pen.width)); pen.color = b.color ? `#${rgbHex(b.color)}` : null; } else pen.style = 'none';
  ctx.setView({tablePen: pen, tableDraw: null});
  return {pen};
}

/** The selected cells (or the caret's): Diagonal Down and Up Border draw a line corner to corner in each, with the pen; one already there goes. */
function diagonalBorder(ctx, p) {
  const S = T.open(ctx);
  const [tp] = T.cell(S);
  const cells = T.selectedCells(S);
  const key = p.direction === 'up' ? 'diagUp' : 'diagDown';
  const t0 = S.d.table(S.sel.focus.story, tp);
  const all = cells.every(([r, c]) => borderVisible(t0?.rows[r]?.cells[c]?.props?.borders?.[key]));
  const on = typeof p.value === 'boolean' ? p.value : !all;
  const pen = penOf(ctx.view);
  const line = mkBorder(pen.style === 'none' ? 'single' : pen.style, pen.width, pen.color ? parseRgb(pen.color) : null, 0);
  S.d.updateTable(S.sel.focus.story, tp, t => {
    const rows = t.rows.slice();
    for (const [r, c] of cells) {
      const row = rows[r];
      const cell = row?.cells[c];
      if (!cell) continue;
      const borders = {...(cell.props?.borders ?? {})};
      if (on) borders[key] = line; else delete borders[key];
      const cs = row.cells.slice();
      cs[c] = {...cell, props: {...(cell.props ?? {}), borders}};
      rows[r] = {...row, cells: cs};
    }
    return {...t, rows};
  });
  return T.finish(S, {value: on});
}

const inTable = ctx => {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  try {
    const all = ctx.model.selection(ctx);
    const f = (all[ctx.selection?.primary ?? 0] ?? all[0])?.focus;
    return f && f.path.length >= 4 ? {enabled: true} : {enabled: false, reason: "the cursor isn't in a table"};
  } catch { return {enabled: false, reason: "the cursor isn't in a table"}; }
};

export default defineCommands({
  family: 'table_rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.drawMode', label: 'Table Pen', risk: 'read', effect: 'view',
      state: (ctx, p) => { const st = T.ready(ctx); return st.enabled ? {enabled: true, checked: p?.mode && p.mode !== 'off' ? drawModeOf(ctx.view) === p.mode : drawModeOf(ctx.view) !== null} : st; },
      description: 'Draw Table, Eraser and Border Sampler (Table Layout, Table Design): `mode` draw, erase or sample turns what dragging or clicking on the page does (a table or a line of cells, a border removed, a border copied into the pen); the mode already on turns it off, and `off` always does. View state, not an edit. Not checked against upstream.',
      params: s.object({mode: s.enum(MODES)}), run: drawMode},
    {id: 'table.diagonalBorder', label: 'Diagonal Border', risk: 'edit',
      state: (ctx, p) => {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        try {
          const S = T.open(ctx);
          const [tp] = T.cell(S);
          const t = S.d.table(S.sel.focus.story, tp);
          const key = p?.direction === 'up' ? 'diagUp' : 'diagDown';
          return {enabled: true, checked: T.selectedCells(S).every(([r, c]) => borderVisible(t?.rows[r]?.cells[c]?.props?.borders?.[key]))};
        } catch { return st; }
      },
      description: 'Diagonal Down Border and Diagonal Up Border (Table Design > Borders, Home > Borders): a line from corner to corner in each selected cell, drawn with the table pen; one already there goes (`value` sets it). Saved as w:tl2br and w:tr2bl. Not checked against upstream.',
      params: s.object({direction: s.enum(['down', 'up']), value: s.optional(s.boolean())}), run: diagonalBorder},
    {id: 'table.borderSample', label: 'Border Sampler', risk: 'read', effect: 'view', state: T.ready,
      description: 'Border Sampler (Table Design › Borders): the border under the point (`page`, `x`, `y` in points) becomes the table pen (line style, weight and colour); a point with no border between two cells is refused. Not checked against upstream.',
      params: s.object({page: num(), x: num(), y: num()}), run: borderSample},
  ],
});
