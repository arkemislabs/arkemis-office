// Insert dialog model (Home › Cells › Insert › Insert Cells…; submit: home.insertCells {shift}).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:217 (Shift cells right / Shift cells down /
// Entire row / Entire column) at 146161b4b450a56e5e59a083ba0478582d1e602b. Like Excel it proposes
// Shift cells down, or Entire row / Entire column when whole lines are selected.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {currentArea} from '../model/workbook.mjs';
import {isFullRows, isFullCols} from '../lib/addr.mjs';

export const SHIFTS = Object.freeze(['right', 'down', 'row', 'column']);

export default defineDialog({
  id: 'dialog.insertCells',
  title: 'Insert',
  command: 'home.insertCells',
  init(ctx) {
    const r = currentArea(gridSel(ctx));
    return {shift: isFullRows(r) ? 'row' : isFullCols(r) ? 'column' : 'down'};
  },
  validate: v => (SHIFTS.includes(v.shift) ? [] : [{field: 'shift', message: 'Choose how to insert.'}]),
  toCommand: v => ({command: 'home.insertCells', params: {shift: v.shift}}),
});
