// Table Design › Borders (Line Style, Line Weight, Pen Color, Border Painter), Table Design › Table Styles › Clear, Table Layout › Table ›
// View Gridlines and Table Layout › Alignment › Cell Margins.
//
// Translated from wordcraft crates/engine/src/cmd/tools/specs.rs (`table.cellMargins`, `table.borderPainter`) and crates/engine/src/cmd/view.rs
// (`table.viewGridlines`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Word's pen (U:quill/table_misc, not in wordcraft: not checked against upstream): Line Style, Line Weight and Pen Color set the pen the
// Borders menu and the Border Painter draw with (kept in the document view, `tablePen`); the Border Painter draws it on the cells' edges
// (wordcraft's does a table.borders call, which a table style's borders can hide), where Word turns a painting cursor on. Clear takes the table's style off.
// Not here (hidden): Border Sampler and Border Styles (no engine), diagonal borders (the layout does not draw them).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import {withTable, tableProps, cellProps} from './table.mjs';
import {border as mkBorder, parseRgb} from '../model/props.mjs';
import {tableStyle} from '../model/styles.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/tools/specs.rs', 'crates/engine/src/cmd/view.rs']};
export const PEN_STYLES = ['none', 'single', 'double', 'dotted', 'dashed', 'dotDash', 'thick', 'triple', 'wave'];
export const PEN_WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const DEFAULT_PEN = {style: 'single', width: 0.5, color: null};
/** wordcraft's table default (default_margins): top, left, bottom, right in points. */
const DEFAULT_MARGINS = [0, 5.4, 0, 5.4];

const bad = m => new CommandError('invalid_params', m);
const NOT_IN_TABLE = "the cursor isn't in a table";

/** The pen as the view keeps it. */
export const penOf = view => ({...DEFAULT_PEN, ...(view?.tablePen ?? {})});

function inTable(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  try {
    const all = ctx.model.selection(ctx);
    const f = (all[ctx.selection?.primary ?? 0] ?? all[0])?.focus;
    return f && f.path.length >= 4 ? {enabled: true} : {enabled: false, reason: NOT_IN_TABLE};
  } catch { return {enabled: false, reason: NOT_IN_TABLE}; }
}

function cellMargins(S, p) {
  const [tp] = T.cell(S);
  const t = S.d.table(S.sel.focus.story, tp);
  if (!t) throw T.failed('no table');
  const style = t.props?.style ? tableStyle(S.d.c.styles, t.props.style) : null;
  const cur = t.props?.cellMargins ?? style?.parts?.cellMargins ?? DEFAULT_MARGINS;
  const val = (k, i) => {
    if (p[k] === undefined || p[k] === null) return cur[i];
    const x = Number(p[k]);
    if (!Number.isFinite(x)) throw bad(`\`${k}\`: a measurement in points`);
    return Math.max(0, Math.min(144, x));
  };
  const m = [val('top', 0), val('left', 1), val('bottom', 2), val('right', 3)];
  return withTable(S, t0 => tableProps(t0, {cellMargins: m}));
}

/** The edges of cell (r, c) of an nr x nc table that a Border Painter `kind` draws (a merged cell counts as one). */
function paintedEdges(kind, r, nr, c, nc) {
  const first = r === 0, last = r === nr - 1, left = c === 0, right = c === nc - 1;
  switch (kind) {
    case 'all': case 'none': return ['top', 'bottom', 'left', 'right'];
    case 'outside': return [...(first ? ['top'] : []), ...(last ? ['bottom'] : []), ...(left ? ['left'] : []), ...(right ? ['right'] : [])];
    case 'inside': return [...(first ? [] : ['top']), ...(last ? [] : ['bottom']), ...(left ? [] : ['left']), ...(right ? [] : ['right'])];
    case 'insideH': return [...(first ? [] : ['top']), ...(last ? [] : ['bottom'])];
    case 'insideV': return [...(left ? [] : ['left']), ...(right ? [] : ['right'])];
    case 'top': return first ? ['top'] : [];
    case 'bottom': return last ? ['bottom'] : [];
    case 'left': return left ? ['left'] : [];
    case 'right': return right ? ['right'] : [];
    default: return [];
  }
}

/** The pen's line on the cells' edges (cell borders win over the table style's, so the painting always shows). */
function borderPainter(S, p) {
  const pen = penOf(S.view);
  const kind = p.kind ?? 'all';
  if (!['all', 'none', 'outside', 'inside', 'insideH', 'insideV', 'top', 'bottom', 'left', 'right'].includes(kind)) throw bad('kind: all|outside|inside|none|top|bottom|left|right|insideH|insideV');
  const style = kind === 'none' ? 'none' : p.style ?? pen.style;
  const width = Math.max(0.25, Math.min(6, p.width ?? pen.width));
  const colorOf = p.color ?? pen.color;
  const line = style === 'none' ? mkBorder('none', 0, null, 0) : mkBorder(style, width, colorOf ? parseRgb(colorOf) : null, 0);
  return withTable(S, t => ({...t, rows: t.rows.map((row, r) => ({...row, cells: row.cells.map((cell, c) => {
    const edges = paintedEdges(kind, r, t.rows.length, c, row.cells.length);
    return edges.length ? cellProps(cell, {borders: {...(cell.props?.borders ?? {}), ...Object.fromEntries(edges.map(e => [e, line]))}}) : cell;
  })}))}));
}

export default defineCommands({
  family: 'table_misc',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.viewGridlines', label: 'View Gridlines', risk: 'read', effect: 'view',
      description: 'View Gridlines (Table Layout › Table): the outlines of table cells, on screen only (never printed or exported); `value` sets it, no value switches.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const st = T.ready(ctx); return st.enabled ? {enabled: true, checked: !!ctx.view?.tableGridlines} : st; },
      run(ctx, p) { const on = p.value ?? !ctx.view?.tableGridlines; ctx.setView({tableGridlines: on}); return {value: on}; }},
    {id: 'table.pen', label: 'Table Pen', risk: 'read', effect: 'view', state: T.ready,
      description: `Line Style, Line Weight and Pen Color (Table Design › Borders): the pen the Borders menu and the Border Painter draw with. \`style\` ${PEN_STYLES.join('|')}; \`width\` in points (0.25 to 6); \`color\` "#RRGGBB" (null: automatic).`,
      params: s.object({style: s.optional(s.enum(PEN_STYLES)), width: s.optional(s.number({min: 0.25, max: 6})), color: s.optional(s.nullable(s.string({max: 9})))}),
      run(ctx, p) {
        const pen = penOf(ctx.view);
        if (p.style !== undefined) pen.style = p.style;
        if (p.width !== undefined) pen.width = p.width;
        if (p.color !== undefined) {
          if (p.color !== null && !/^#?[0-9a-fA-F]{6}$/.test(p.color)) throw bad('`color`: "#RRGGBB" or null');
          pen.color = p.color === null ? null : `#${p.color.replace('#', '').toUpperCase()}`;
        }
        ctx.setView({tablePen: pen});
        return {pen};
      }},
    {id: 'table.borderPainter', label: 'Border Painter', risk: 'edit', state: inTable,
      description: "Border Painter (Table Design › Borders): the table's cell edges drawn with the pen (`kind` all|outside|inside|none|top|bottom|left|right|insideH|insideV, default all; `width`, `color` and `style` override the pen). wordcraft's applies table.borders; the edges are the cells' own here so a table style's borders do not hide them.",
      params: s.object({kind: s.optional(s.string({max: 16})), width: s.optional(s.number({min: 0, max: 100})), color: s.optional(s.string({max: 9})), style: s.optional(s.enum(PEN_STYLES))}),
      run: (ctx, p) => borderPainter(T.open(ctx), p ?? {})},
    {id: 'table.clearStyle', label: 'Clear', risk: 'edit', state: inTable,
      description: "Clear (Table Design › Table Styles): takes the table's style off (Table Normal).",
      params: s.object({}),
      run: ctx => { const S = T.open(ctx); return withTable(S, t => tableProps(t, {style: null})); }},
    {id: 'table.cellMargins', label: 'Cell Margins', risk: 'edit', state: inTable, dialog: 'dialog.tableCellMargins',
      description: "Cell Margins (Table Layout › Alignment): the table's default cell margins in points (`top`, `left`, `bottom`, `right`, 0 to 144; what is not given stays).",
      params: s.object({top: s.optional(s.number()), left: s.optional(s.number()), bottom: s.optional(s.number()), right: s.optional(s.number())}),
      run: (ctx, p) => cellMargins(T.open(ctx), p ?? {})},
  ],
});
