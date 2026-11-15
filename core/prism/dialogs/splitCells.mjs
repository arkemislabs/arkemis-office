// Split Cells (submit: table.split): the number of columns and rows to divide the cell into.
// PowerPoint's dialog; deckcraft's table.split only undoes a merge (not checked against upstream).
// A merged cell starts with the columns and rows it spans, so OK there undoes the merge.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape} from '../model/presentation.mjs';
import {slideById, currentSlideId} from '../model/doc.mjs';
import {currentCell} from '../lib/table-sel.mjs';

const int = v => (typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10));

export default defineDialog({
  id: 'dialog.splitCells',
  title: 'Split Cells',
  command: 'table.split',
  init(ctx) {
    const cur = currentCell(ctx.doc, ctx.selection);
    const sh = cur ? findShape(slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection))?.shapes, cur.shape) : null;
    const cell = sh?.kind?.rows?.[cur.cell[0]]?.cells?.[cur.cell[1]];
    const gs = Math.max(cell?.gridSpan ?? 1, 1), rs = Math.max(cell?.rowSpan ?? 1, 1);
    return gs > 1 || rs > 1 ? {cols: gs, rows: rs} : {cols: 2, rows: 1};
  },
  validate(v) {
    const out = [];
    if (!(int(v.cols) >= 1 && int(v.cols) <= 63)) out.push({field: 'cols', message: 'Enter a number of columns from 1 to 63.'});
    if (!(int(v.rows) >= 1 && int(v.rows) <= 63)) out.push({field: 'rows', message: 'Enter a number of rows from 1 to 63.'});
    return out;
  },
  toCommand: v => ({command: 'table.split', params: {cols: int(v.cols), rows: int(v.rows)}}),
});
