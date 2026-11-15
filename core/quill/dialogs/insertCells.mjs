// Table Layout › Rows & Columns launcher › Insert Cells (Word's dialog; submit: table.insertRowAbove
// or table.insertColumnLeft).
// Word offers Shift cells right / Shift cells down / Insert entire row / Insert entire column, an
// entire row going above the selection and an entire column left of it. wordcraft
// (aadb077e072b7de05f724e359d8db82e151f125c, crates/engine/src/cmd/table/structure.rs `row`/`col`)
// has whole rows and columns only, so the two shift choices are not offered (behaviour fidelity).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';

const COMMANDS = {row: 'table.insertRowAbove', column: 'table.insertColumnLeft'};

export default defineDialog({
  id: 'dialog.insertCells',
  title: 'Insert Cells',
  command: 'table.insertRowAbove',
  init(ctx) {
    T.cell(T.open(ctx));
    return {mode: 'row'};
  },
  validate(v) { return COMMANDS[v.mode] ? [] : [{field: 'mode', message: 'Choose what to insert.'}]; },
  toCommand(v) { return {command: COMMANDS[v.mode], params: {}}; },
});
