// Create Table dialog model (submit: insert.table).
// Excel's Create Table (Where is the data for your table? and My table has headers) on gridcraft's
// cmd/insert/table.rs (`insert_table`: the block, the header guess) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range (the block, as the selection or its region), header.

import {defineDialog} from '../../kernel/dialog.mjs';
import {parseRange, rangeA1, isSingle, colToLetters} from '../lib/addr.mjs';
import {engineFor} from '../model/calc.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {regionAround, valueOf, baseDoc} from '../lib/data-common.mjs';

const absolute = r => `$${colToLetters(r.start.col)}$${r.start.row + 1}:$${colToLetters(r.end.col)}$${r.end.row + 1}`;

export default defineDialog({
  id: 'dialog.createTable',
  title: 'Create Table',
  command: 'insert.table',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const cur = sel.ranges[sel.ranges.length - 1];
    const r = isSingle(cur) ? regionAround(content, sel.sheet, sel.active) : cur;
    const engine = engineFor(content);
    const header = r.end.row > r.start.row && Array.from({length: r.end.col - r.start.col + 1}, (_, i) => valueOf(engine, sel.sheet, r.start.row, r.start.col + i)).every(v => typeof v === 'string');
    return {range: absolute(r), header};
  },
  validate(v) {
    const r = parseRange(String(v.range ?? '').replace(/\$/g, '').replace(/^.*!/, ''));
    return r ? [] : [{field: 'range', message: 'Enter the range of cells for the table, for example A1:D20.'}];
  },
  toCommand(v) {
    return {command: 'insert.table', params: {range: String(v.range).replace(/\$/g, ''), header: v.header === true}};
  },
});
