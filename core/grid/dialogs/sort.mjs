// Sort dialog model (submit: data.sort).
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`sort`: the header toggle, a row per
// level with column / sort on / order, + Add Level, remove a level, OK builds `data.sort`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Sort dialog: Delete, Copy, Move Up/Down,
// Options (case sensitive, top to bottom or left to right) and custom list orders.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range, header, heads (the headings of the range's columns), rowHeads (of its rows), startCol,
// startRow, levels [{column, by: values|cellColor|fontColor, order: asc|desc|list:<n>}] (column is a
// column letter, or a row number when sorting left to right), selected, options {caseSensitive,
// orientation}, lists [{label, list}].

import {defineDialog} from '../../kernel/dialog.mjs';
import {colToLetters} from '../lib/addr.mjs';
import {regionInfo, sortLists} from '../lib/data-dialog.mjs';

export default defineDialog({
  id: 'dialog.sort',
  title: 'Sort',
  command: 'data.sort',
  init(ctx) {
    const r = regionInfo(ctx);
    const col = Math.min(Math.max(r.active.col, r.range.start.col), r.range.end.col);
    return {
      range: r.a1, header: r.header, heads: r.heads, rowHeads: r.rowHeads, startCol: r.startCol, startRow: r.startRow,
      levels: [{column: colToLetters(col), by: 'values', order: 'asc'}], selected: 0,
      options: {caseSensitive: false, orientation: 'rows'}, lists: sortLists(ctx.doc),
    };
  },
  derive(values, changed) {
    // Sorting left to right names rows, not columns: the levels start over on the first row.
    if (!changed.includes('options')) return {};
    const rows = values.options?.orientation === 'columns';
    const first = (values.levels ?? [])[0];
    if (first && (rows ? !/^\d+$/.test(String(first.column)) : /^\d+$/.test(String(first.column)))) {
      return {levels: [{column: rows ? String(values.startRow + 1) : colToLetters(values.startCol), by: 'values', order: 'asc'}], selected: 0};
    }
    return {};
  },
  validate(v) {
    const levels = v.levels ?? [];
    if (!levels.length) return [{field: 'levels', message: 'Add a level to sort by.'}];
    const seen = new Set();
    for (const l of levels) {
      if (!l.column) return [{field: 'levels', message: 'Choose a column for every level.'}];
      const k = String(l.column);
      if (seen.has(k)) return [{field: 'levels', message: 'Each sort level needs a different column.'}];
      seen.add(k);
    }
    return [];
  },
  toCommand(v) {
    const byRows = v.options?.orientation === 'columns';
    const keys = (v.levels ?? []).map(l => {
      const key = byRows ? {row: Number(l.column)} : {column: String(l.column)};
      const order = String(l.order ?? 'asc');
      key.by = l.by ?? 'values';
      if (order.startsWith('list:')) { key.order = 'asc'; key.customList = (v.lists?.[Number(order.slice(5))]?.list) ?? []; } else key.order = order === 'desc' ? 'desc' : 'asc';
      return key;
    });
    return {command: 'data.sort', params: {range: v.range, header: !!v.header, keys, ...(byRows ? {orientation: 'columns'} : {}), ...(v.options?.caseSensitive ? {matchCase: true} : {})}};
  },
});
