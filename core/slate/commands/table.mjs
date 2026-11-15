// Tables: Insert › Table and the Table Layout tab (U:slate/insert).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `insert.table`
// and `table.*` (Table Layout); behaviour is OneNote's:
//   * Insert › Table: the grid picker (hover to size, click) or Insert Table… (columns 1–99, rows
//     1–500, default 2 × 2) puts a table at the caret, in a note container of its own when there
//     is no caret in a note; a paragraph always follows it;
//   * Table Layout › Select: Table, Columns, Rows, Cell select what the caret's cell(s) cover;
//   * Delete: Table, Columns, Rows remove the selected ones (all of them removes the table);
//   * Insert: Above / Below / Left / Right add one row or column next to the selection (Ctrl+Enter
//     adds a row below, Ctrl+Alt+E / Ctrl+Alt+R a column left / right; Tab in the last cell adds a row);
//   * Hide Borders, Header Row (bold first row; Sort leaves it in place), Shading (a colour or none
//     on the selected cells), Sort Ascending / Descending by the column of the caret's cell.
// Convert to Excel Spreadsheet needs Excel to open the result and is not offered.
// Every edit is one undoable ProseMirror transform on the page (core/slate/lib/table.mjs).

import {Fragment} from '@tiptap/pm/model';
import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, schema} from '../schema.mjs';
import {pageDoc} from '../model/canvas.mjs';
import {blockIndex} from '../model/page.mjs';
import {editPage} from '../lib/format-text.mjs';
import {caretSelection, emptyParagraph, insertBlock, pageReady} from '../lib/insert-point.mjs';
import {MAX_COLS, MAX_ROWS, cellPos, cellRanges, colCount, needTable, newCell, newRow, newTable, rowPos, sortedRows, tableSelection, tableState} from '../lib/table.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/insert.table', 'docs/spec/slate.json#commands/table.*']};
const colorParam = s.string({pattern: '^#[0-9a-fA-F]{6}$', description: '#RRGGBB'});
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };

/** The table node of a selection in the page as it is now (after an edit). */
function freshTable(ctx, sel) {
  const doc = pageDoc(ctx, sel.pageId);
  const node = doc.nodeAt(sel.table.pos);
  return {doc, node};
}

const toggle = (id, label, attr, description) => ({
  id, label, risk: 'edit',
  description,
  params: s.object({value: s.optional(s.boolean({description: 'Turn it on (true) or off (false) instead of toggling'}))}),
  state(ctx) {
    const st = tableState(ctx);
    if (!st.enabled) return st;
    return {enabled: true, checked: tableSelection(ctx).table.node.attrs[attr] === true};
  },
  run(ctx, p) {
    const sel = needTable(ctx);
    const on = p.value ?? sel.table.node.attrs[attr] !== true;
    if ((sel.table.node.attrs[attr] === true) === on) return {value: on, changed: false};
    editPage(ctx, sel.pageId, tr => tr.setNodeAttribute(sel.table.pos, attr, on), sel.doc);
    return {value: on, changed: true};
  },
});

export default defineCommands({
  family: 'table',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'insert.table', label: 'Table', risk: 'edit', dialog: 'dialog.insert-table',
      description: 'Insert a table of empty cells (columns 1–99, rows 1–500, default 2 by 2) at the caret, or in a new note container; the caret goes to its first cell.',
      params: s.object({
        rows: s.optional(s.number({min: 1, max: MAX_ROWS, integer: true, description: 'Number of rows (default 2)'})),
        columns: s.optional(s.number({min: 1, max: MAX_COLS, integer: true, description: 'Number of columns (default 2)'})),
        x: s.optional(s.number({min: 0, max: 50000})), y: s.optional(s.number({min: 0, max: 500000})),
      }),
      state: pageReady,
      run(ctx, p) {
        const rows = p.rows ?? 2, columns = p.columns ?? 2;
        const node = newTable(ctx, rows, columns);
        const {pageId, pos} = insertBlock(ctx, node, {x: p.x, y: p.y});
        const doc = pageDoc(ctx, pageId);
        ctx.setSelection(caretSelection(pageId, doc, pos + 4));
        return {table: `/pg:${pageId}/b:${node.attrs.id}`, rows, columns};
      },
    },
    {
      id: 'table.select', label: 'Select', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Select the table, the columns or rows of the selected cells, or the cell the caret is in (cell addresses, one range per cell).',
      params: s.object({scope: s.enum(['table', 'columns', 'rows', 'cell'])}),
      state: tableState,
      run(ctx, p) {
        const sel = needTable(ctx);
        const t = sel.table.node;
        const cells = [];
        if (p.scope === 'table') {
          const a = `/pg:${sel.pageId}/b:${t.attrs.id}`;
          ctx.setSelection({ranges: [{anchor: a, focus: a}], primary: 0});
          return {scope: 'table', cells: t.childCount * colCount(t)};
        }
        const rows = p.scope === 'rows' ? sel.rows : p.scope === 'cell' ? [sel.focus.row] : [...Array(t.childCount).keys()];
        const cols = p.scope === 'columns' ? sel.cols : p.scope === 'cell' ? [sel.focus.col] : [...Array(colCount(t)).keys()];
        for (const r of rows) for (const c of cols) cells.push([r, c]);
        ctx.setSelection(cellRanges(sel.pageId, t, cells));
        return {scope: p.scope, cells: cells.length};
      },
    },
    {
      id: 'table.delete', label: 'Delete', risk: 'edit',
      description: 'Delete the table, or the columns or rows the selection covers (deleting all of them deletes the table).',
      params: s.object({scope: s.enum(['table', 'columns', 'rows'])}),
      state: tableState,
      run(ctx, p) {
        const sel = needTable(ctx);
        const t = sel.table.node;
        const all = p.scope === 'table' || (p.scope === 'rows' && sel.rows.length >= t.childCount) || (p.scope === 'columns' && sel.cols.length >= colCount(t));
        if (all) {
          editPage(ctx, sel.pageId, tr => {
            const at = sel.table.pos;
            const $t = tr.doc.resolve(at);
            const only = $t.parent.childCount === 1;
            tr.delete(at, at + t.nodeSize);
            // A note container (or a cell) never stays empty.
            if (only) tr.insert(at, emptyParagraph(ctx));
          }, sel.doc);
          const doc = pageDoc(ctx, sel.pageId);
          ctx.setSelection(caretSelection(sel.pageId, doc, Math.min(sel.table.pos + 1, doc.content.size)));
          return {deleted: 'table'};
        }
        if (p.scope === 'rows') {
          editPage(ctx, sel.pageId, tr => {
            for (const r of [...sel.rows].reverse()) { const at = rowPos(t, sel.table.pos, r); tr.delete(at, at + t.child(r).nodeSize); }
          }, sel.doc);
        } else {
          editPage(ctx, sel.pageId, tr => {
            for (let r = t.childCount - 1; r >= 0; r--) {
              for (const c of [...sel.cols].reverse()) { const at = cellPos(t, sel.table.pos, r, c); tr.delete(at, at + t.child(r).child(c).nodeSize); }
            }
          }, sel.doc);
        }
        const {doc, node} = freshTable(ctx, sel);
        const r = Math.min(sel.rows[0], node.childCount - 1), c = Math.min(sel.cols[0], colCount(node) - 1);
        ctx.setSelection(caretSelection(sel.pageId, doc, cellPos(node, sel.table.pos, r, c) + 2));
        return {deleted: p.scope, count: p.scope === 'rows' ? sel.rows.length : sel.cols.length};
      },
    },
    {
      id: 'table.insert', label: 'Insert', risk: 'edit',
      description: 'Insert one row above or below, or one column left or right, of the selected cells; the caret goes to the new cell.',
      params: s.object({where: s.enum(['above', 'below', 'left', 'right'])}),
      state(ctx, p) {
        const st = tableState(ctx);
        if (!st.enabled) return st;
        const t = tableSelection(ctx).table.node;
        if ((p?.where === 'above' || p?.where === 'below') && t.childCount >= MAX_ROWS) return {enabled: false, reason: `A table has at most ${MAX_ROWS} rows`};
        if ((p?.where === 'left' || p?.where === 'right') && colCount(t) >= MAX_COLS) return {enabled: false, reason: `A table has at most ${MAX_COLS} columns`};
        return {enabled: true};
      },
      run(ctx, p) {
        const sel = needTable(ctx);
        const t = sel.table.node;
        let row = sel.focus.row, col = sel.focus.col;
        if (p.where === 'above' || p.where === 'below') {
          need(t.childCount < MAX_ROWS, 'invalid_params', `A table has at most ${MAX_ROWS} rows`);
          const at = p.where === 'above' ? sel.rows[0] : sel.rows[sel.rows.length - 1] + 1;
          editPage(ctx, sel.pageId, tr => tr.insert(rowPos(t, sel.table.pos, at), newRow(ctx, colCount(t))), sel.doc);
          row = at;
          col = 0;
        } else {
          need(colCount(t) < MAX_COLS, 'invalid_params', `A table has at most ${MAX_COLS} columns`);
          const at = p.where === 'left' ? sel.cols[0] : sel.cols[sel.cols.length - 1] + 1;
          editPage(ctx, sel.pageId, tr => {
            for (let r = t.childCount - 1; r >= 0; r--) tr.insert(cellPos(t, sel.table.pos, r, at), newCell(ctx));
          }, sel.doc);
          col = at;
        }
        const {doc, node} = freshTable(ctx, sel);
        ctx.setSelection(caretSelection(sel.pageId, doc, cellPos(node, sel.table.pos, row, col) + 2));
        return {where: p.where, row, column: col};
      },
    },
    toggle('table.hideBorders', 'Hide Borders', 'hideBorders', 'Hide or show the table\'s borders (the cells keep their shading).'),
    toggle('table.headerRow', 'Header Row', 'headerRow', 'Make the first row a header row: its text is bold, and Sort leaves it in place.'),
    toggle('table.sortHeaderRow', 'Header Row', 'sortHeader', 'Sort: leave the first row where it is when sorting the table.'),
    {
      id: 'table.shading', label: 'Shading', risk: 'edit', dialog: 'dialog.colors',
      description: 'Shade the selected cells (the cell the caret is in) in a colour (default yellow); null (No Color) removes the shading.',
      params: s.object({color: s.optional(s.nullable(colorParam))}),
      state(ctx) {
        const st = tableState(ctx);
        if (!st.enabled) return st;
        const sel = tableSelection(ctx);
        return {enabled: true, value: sel.table.node.child(sel.focus.row).child(sel.focus.col).attrs.shading ?? null};
      },
      run(ctx, p) {
        const sel = needTable(ctx);
        const t = sel.table.node;
        const color = p.color === undefined ? '#ffff00' : p.color === null ? null : p.color.toLowerCase();
        let changed = 0;
        editPage(ctx, sel.pageId, tr => {
          for (const key of sel.cells) {
            const [r, c] = key.split(',').map(Number);
            if ((t.child(r).child(c).attrs.shading ?? null) === color) continue;
            tr.setNodeAttribute(cellPos(t, sel.table.pos, r, c), 'shading', color);
            changed++;
          }
        }, sel.doc);
        return {color, changed};
      },
    },
    {
      id: 'table.sort', label: 'Sort', risk: 'edit',
      description: 'Sort the table\'s rows by the column of the caret\'s cell: numbers by value, text in locale order, empty cells last; the header row (when set) stays first.',
      params: s.object({order: s.enum(['ascending', 'descending'])}),
      state: tableState,
      run(ctx, p) {
        const sel = needTable(ctx);
        const t = sel.table.node;
        const skip = t.attrs.headerRow === true || t.attrs.sortHeader === true;
        const rows = sortedRows(t, sel.focus.col, p.order === 'descending', skip);
        const same = rows.every((r, i) => r === t.child(i));
        if (same) return {order: p.order, column: sel.focus.col, changed: false};
        const keep = t.child(sel.focus.row).child(sel.focus.col).child(0).attrs.id;
        editPage(ctx, sel.pageId, tr => tr.replaceWith(sel.table.pos + 1, sel.table.pos + t.nodeSize - 1, Fragment.from(rows)), sel.doc);
        // The rows were rebuilt: the caret stays in the cell it was in.
        const after = pageDoc(ctx, sel.pageId);
        const hit = blockIndex(after).get(keep);
        if (hit) ctx.setSelection(caretSelection(sel.pageId, after, hit.pos + 1));
        return {order: p.order, column: sel.focus.col, changed: true, headerRowKept: skip};
      },
    },
  ],
});

void isNotebook; void schema;
