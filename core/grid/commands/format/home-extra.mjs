// Home tab commands that sit beside the format families: Format as Table (a style on the block, or on the
// table the cell is in), Draw Border, New Cell Style and Fill > Justify.
// Translated from gridcraft crates/engine/src/cmd/insert/table.rs (`format_as_table`: inside a table it
// restyles it, else it makes one), crates/engine/src/cmd/extra/cells.rs (`draw_border`: the edge becomes a
// `home.borders` preset; `new_cell_style`: the active cell's style under a name) and cmd/extra.rs (specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Excel's Draw Border pen (Draw Border, Draw Border Grid, Erase Border, Line Color, Line Style) and Fill >
// Justify are Excel behaviour: not checked against upstream.
//
// Draw Border keeps a pen in view state (`drawBorder: {mode, style, color}`); the surface applies it to
// the cells a drag ends on. New Cell Style stores {name, style, includes} in `content.cellStyles`.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {rangeA1, contains} from '../../lib/addr.mjs';
import {hasDoc, gridSel, targetRange, requireSchema2, bad, failed, baseDoc} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {tablesOf, tableLook, styleInfo, gallery as tableStyleNames} from '../../lib/table-style.mjs';
import {RANGE, SHEET, COLOR, UPSTREAM_COMMIT, withDoc} from '../../lib/format-params.mjs';
import {colorParam, approxTextWidth} from '../../lib/format-ranges.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {colWidth} from '../../model/sheet.mjs';
import {valueAt} from '../../model/index.mjs';
import {DEFAULT_THEME, resolveColor, hex, sparseStyle} from '../../model/style.mjs';
import {styleAt} from '../../model/workbook.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/insert/table.rs', 'crates/engine/src/cmd/extra/cells.rs', 'crates/engine/src/cmd/extra.rs']};

// ---------------------------------------------------------------------------------------------
// Format as Table

const TABLE_STYLE = /^TableStyle(Light|Medium|Dark)(\d+)$/;
const LIMITS = {Light: 21, Medium: 28, Dark: 11};
export function validTableStyle(name) {
  const m = TABLE_STYLE.exec(String(name));
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= LIMITS[m[1]];
}

/** The Format as Table gallery: the sixty styles, drawn with their header, line and band colours; the current one marked. */
export function tableStyleTiles(ctx) {
  const theme = ctx.doc?.theme ?? DEFAULT_THEME;
  const hexOf = c => (c ? hex(resolveColor(c, theme)) : null);
  let current = '';
  try {
    const sel = gridSel(ctx);
    const t = tablesOf(ctx.doc.sheets[sel.sheet]).find(x => contains(x.range, sel.active));
    if (t) current = styleInfo(t.table).name;
  } catch { /* no selection */ }
  return tableStyleNames().map(name => {
    const [, fam, n] = TABLE_STYLE.exec(name);
    const lk = tableLook(name);
    return {id: name, label: `${fam} ${n}`, value: name, group: fam, selected: name === current, iconOnly: true,
      art: {kind: 'pivot', header: hexOf(lk.headerFill) ?? '#ffffff', line: hexOf(lk.line) ?? hexOf(lk.totalTop) ?? '#999999', band: hexOf(lk.bandFill) ?? '#f2f2f2', text: lk.headerFont ? '#FFFFFF' : '#222222'}};
  });
}

function formatAsTable(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const style = p.style ?? p.value ?? 'TableStyleMedium2';
  if (!validTableStyle(style)) throw bad('home.formatAsTable', `unknown table style \`${style}\` (TableStyleLight1-21, TableStyleMedium1-28, TableStyleDark1-11)`);
  let si = sel.sheet, r = null;
  if (typeof p.range === 'string' && p.range) { const t = targetRange(ctx, p); si = t.sheet; r = t.range; }
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const list = tablesOf(sheet);
  const inside = list.find(t => (r ? contains(t.range, r.start) && contains(t.range, r.end) : contains(t.range, sel.active)));
  if (inside) {
    const i = (sheet.tables ?? []).indexOf(inside.table);
    const info = styleInfo(inside.table);
    setIn(ctx.change, ['sheets', si, 'tables', i, 'style'], {name: style, showRowStripes: info.showRowStripes, showColumnStripes: info.showColumnStripes, showFirstColumn: info.showFirstColumn, showLastColumn: info.showLastColumn});
    return {table: inside.table.name, range: rangeA1(inside.range), style};
  }
  return ctx.run('insert.table', {...(r ? {range: rangeA1(r), sheet: si} : {}), style, ...(typeof p.header === 'boolean' ? {header: p.header} : {})});
}

// ---------------------------------------------------------------------------------------------
// Draw Border

export const PEN_STYLES = Object.freeze([['thin', 'Thin'], ['hair', 'Hair'], ['dotted', 'Dotted'], ['dashed', 'Dashed'], ['dashDot', 'Dash Dot'], ['dashDotDot', 'Dash Dot Dot'],
  ['medium', 'Medium'], ['mediumDashed', 'Medium Dashed'], ['mediumDashDot', 'Medium Dash Dot'], ['mediumDashDotDot', 'Medium Dash Dot Dot'], ['slantDashDot', 'Slanted Dash Dot'],
  ['thick', 'Thick'], ['double', 'Double']]);
const PEN_STYLE_IDS = PEN_STYLES.map(x => x[0]);
const MODES = ['border', 'grid', 'erase'];
const penOf = ctx => ctx.view?.drawBorder ?? null;

function drawBorder(ctx, p) {
  const pen = penOf(ctx) ?? {};
  const color = p.color !== undefined ? colorParam(p.color) : undefined;
  if (p.color !== undefined && color === undefined) throw bad('home.drawBorder', 'invalid `color`');
  // Draw now: a range (or edge, or apply) is the cells a drag ended on.
  if (typeof p.range === 'string' || p.apply === true || p.edge !== undefined) {
    const mode = p.mode ?? pen.mode ?? 'border';
    const edge = p.edge ?? (mode === 'grid' ? 'grid' : 'outline');
    const preset = mode === 'erase' ? 'none' : ({top: 'top', bottom: 'bottom', left: 'left', right: 'right', outline: 'outside', grid: 'all', all: 'all'})[edge];
    if (!preset) throw bad('home.drawBorder', `unknown edge \`${edge}\``);
    const params = {preset, ...(typeof p.range === 'string' ? {range: p.range} : {}), ...(p.sheet !== undefined && p.sheet !== null ? {sheet: p.sheet} : {})};
    if (mode !== 'erase') { params.style = p.style ?? pen.style ?? 'thin'; const c = color !== undefined ? color : pen.color; if (c) params.color = c; }
    ctx.run('home.borders', params);
    return {drawn: preset};
  }
  // The pen: a mode toggles it on or off, a colour or a style sets it (and draws with it from then on).
  if (p.mode !== undefined) {
    if (pen.mode === p.mode && p.style === undefined && color === undefined) { ctx.setView({drawBorder: null}); return {mode: null}; }
    ctx.setView({drawBorder: {mode: p.mode, style: p.style ?? pen.style ?? 'thin', ...(color !== undefined ? (color ? {color} : {}) : pen.color ? {color: pen.color} : {})}});
    return {mode: p.mode};
  }
  if (p.style !== undefined || color !== undefined) {
    const next = {mode: pen.mode && pen.mode !== 'erase' ? pen.mode : 'border', style: p.style ?? pen.style ?? 'thin'};
    const c = color !== undefined ? color : pen.color;
    if (c) next.color = c;
    ctx.setView({drawBorder: next});
    return {mode: next.mode, style: next.style, color: next.color ?? null};
  }
  throw bad('home.drawBorder', 'name a mode, a line style or a colour, or a range to draw on');
}

// ---------------------------------------------------------------------------------------------
// New Cell Style

export const STYLE_PARTS = Object.freeze([['numFmt', 'Number'], ['align', 'Alignment'], ['font', 'Font'], ['borders', 'Border'], ['fill', 'Fill'], ['protection', 'Protection']]);

function newCellStyle(ctx, p) {
  const content = baseDoc(ctx);
  const name = String(p.name ?? '').trim();
  if (!name) throw bad('home.newCellStyle', 'missing `name`');
  if (name.length > 255) throw bad('home.newCellStyle', 'a style name is at most 255 characters');
  const sel = gridSel(ctx);
  const si = sel.sheet;
  let at = sel.active;
  if (typeof p.fromCell === 'string') { const t = targetRange(ctx, {range: p.fromCell}); at = t.range.start; }
  const full = styleAt(content, content.sheets[si], at.row, at.col);
  const inc = {numFmt: true, align: true, font: true, borders: true, fill: true, protection: true, ...(p.includes ?? {})};
  const sparse = sparseStyle(full);
  const style = {};
  for (const [k] of STYLE_PARTS) if (inc[k] && sparse[k] !== undefined) style[k] = sparse[k];
  const includes = STYLE_PARTS.map(x => x[0]).filter(k => inc[k]);
  const list = (Array.isArray(content.cellStyles) ? content.cellStyles : []).filter(x => String(x?.name ?? '').toLowerCase() !== name.toLowerCase());
  ctx.change.set(['cellStyles'], [...list, {name, style, ...(includes.length === STYLE_PARTS.length ? {} : {includes})}]);
  return {name};
}

// ---------------------------------------------------------------------------------------------
// Fill > Justify

/** The words of the text re-wrapped into lines of at most `width` pixels. */
export function wrapWords(text, width, size, bold) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && approxTextWidth(next, size, bold) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function justify(ctx, p) {
  const content = baseDoc(ctx);
  const t = targetRange(ctx, p);
  const si = t.sheet;
  requireSchema2(ctx, si);
  const r = t.range;
  const sheet = content.sheets[si];
  const col = r.start.col;
  const texts = [];
  for (let row = r.start.row; row <= r.end.row; row++) {
    const c = cellAt(sheet, row, col);
    if (!c || (c.v === undefined && c.f === undefined)) continue;
    if (c.f !== undefined) throw failed("Justify works on text, not on formulas. Select cells that hold only text.");
    const v = valueAt(content, si, row, col);
    if (typeof v !== 'string') throw failed('Justify works on text, not on numbers. Select cells that hold only text.');
    texts.push({row, text: v});
  }
  if (!texts.length) return {lines: 0};
  const st = styleAt(content, sheet, texts[0].row, col);
  let width = 0;
  for (let c = r.start.col; c <= r.end.col; c++) width += colWidth(sheet, c);
  const lines = wrapWords(texts.map(x => x.text).join(' '), Math.max(width - 6, 8), st.font.size, st.font.bold);
  const last = r.start.row + Math.max(lines.length, 1) - 1;
  // The lines run below the selection only into empty cells; Excel asks first, here it is refused.
  for (let row = r.end.row + 1; row <= last; row++) {
    const c = cellAt(sheet, row, col);
    if (c && (c.v !== undefined || c.f !== undefined)) throw failed('Text will extend below selected range. Make the selection taller, or move the cells below.');
  }
  const base = ctx.doc;
  for (let row = r.start.row; row <= Math.max(r.end.row, last); row++) {
    const old = cellAt(base.sheets[si], row, col);
    const line = lines[row - r.start.row];
    if (line === undefined) { if (old && (old.v !== undefined || old.f !== undefined) && row <= r.end.row) writeCell(ctx.change, base, si, row, col, {...old, v: undefined, f: undefined}); continue; }
    writeCell(ctx.change, base, si, row, col, {...(old ?? {}), v: line, f: undefined});
  }
  return {lines: lines.length, range: rangeA1({start: r.start, end: {row: Math.max(r.end.row, last), col: r.end.col}})};
}

export default defineCommands({
  family: 'format/home-extra',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'home.formatAsTable', label: 'Format as Table', risk: 'edit',
      description: 'Make the block (or `range`, or the block around the active cell) a table in a style (TableStyleLight1-21, TableStyleMedium1-28, TableStyleDark1-11; default TableStyleMedium2); inside a table it restyles that table. → {table, range}.',
      params: s.object({range: RANGE, sheet: SHEET, style: s.optional(s.string({max: 60})), value: s.optional(s.string({max: 60})), header: s.optional(s.boolean())}),
      state: ctx => withDoc(ctx, () => ({value: tableStyleTiles(ctx)})),
      run: formatAsTable,
    },
    {
      id: 'home.drawBorder', label: 'Draw Border', risk: 'edit',
      description: 'Borders > Draw Border, Draw Border Grid, Erase Border, Line Color, Line Style: a mode toggles the pen on or off, a color or a style sets it, and the surface draws with it over the cells a drag ends on. With a range (or edge: top|bottom|left|right|outline|grid, apply: true) it draws now.',
      params: s.object({range: RANGE, sheet: SHEET, mode: s.optional(s.enum(MODES)), edge: s.optional(s.enum(['top', 'bottom', 'left', 'right', 'outline', 'grid', 'all'])), apply: s.optional(s.boolean()),
        style: s.optional(s.enum(PEN_STYLE_IDS)), color: s.optional(COLOR), gallery: s.optional(s.string({max: 20}))}),
      state(ctx, p) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const pen = penOf(ctx);
        if (p?.gallery === 'lineStyles') return {enabled: true, value: PEN_STYLES.map(([id, label]) => ({id, label, value: id, art: {kind: 'line', style: id}, selected: (pen?.style ?? 'thin') === id}))};
        if (p?.mode) return {enabled: true, checked: pen?.mode === p.mode};
        return {enabled: true, value: typeof pen?.color === 'string' ? pen.color : null};
      },
      run: drawBorder,
    },
    {
      id: 'home.newCellStyle', label: 'New Cell Style…', risk: 'edit', dialog: 'dialog.style',
      description: 'Save the formatting of the active cell (or `fromCell`) as a named cell style; `includes` leaves parts out ({numFmt, align, font, borders, fill, protection}: false). A style of the same name is replaced.',
      params: s.object({name: s.optional(s.string({min: 1, max: 255})), fromCell: s.optional(s.string({max: 100})), includes: s.optional(s.record(s.boolean()))}),
      state: ctx => hasDoc(ctx),
      run: newCellStyle,
    },
    {
      id: 'edit.fillJustify', label: 'Justify', risk: 'edit',
      description: 'Fill > Justify: re-wrap the text of the first column of the range (default: the selection) into the width of the whole range, lines going down the first column. Text only.',
      params: s.object({range: RANGE, sheet: SHEET}),
      state: ctx => hasDoc(ctx),
      run: justify,
    },
  ],
});
