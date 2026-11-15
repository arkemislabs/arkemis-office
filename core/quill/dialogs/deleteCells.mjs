// Table Layout › Rows & Columns › Delete › Delete Cells… (Word's dialog; submit: table.deleteCells,
// table.deleteRow or table.deleteColumn).
// Word offers Shift cells left / Shift cells up / Delete entire row / Delete entire column. wordcraft
// crates/engine/src/cmd/table/structure.rs (aadb077e072b7de05f724e359d8db82e151f125c) deletes the
// caret's cell with the row's other cells moving left (`table.deleteCells`), whole rows and whole
// columns; Shift cells up has no upstream command, so it is not offered (behaviour fidelity: a
// choice that can't do the real thing stays out). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';

const COMMANDS = {left: 'table.deleteCells', row: 'table.deleteRow', column: 'table.deleteColumn'};

export default defineDialog({
  id: 'dialog.deleteCells',
  title: 'Delete Cells',
  command: 'table.deleteCells',
  init(ctx) {
    T.cell(T.open(ctx));
    return {mode: 'left'};
  },
  validate(v) { return COMMANDS[v.mode] ? [] : [{field: 'mode', message: 'Choose what to delete.'}]; },
  toCommand(v) { return {command: COMMANDS[v.mode], params: {}}; },
});
