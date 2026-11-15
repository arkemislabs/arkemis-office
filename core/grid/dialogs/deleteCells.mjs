// Delete dialog model (Home › Cells › Delete › Delete Cells…; submit: home.deleteCells {shift}).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:249 (Shift cells left / Shift cells up /
// Entire row / Entire column) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {currentArea} from '../model/workbook.mjs';
import {isFullRows, isFullCols} from '../lib/addr.mjs';

export const SHIFTS = Object.freeze(['left', 'up', 'row', 'column']);

export default defineDialog({
  id: 'dialog.deleteCells',
  title: 'Delete',
  command: 'home.deleteCells',
  init(ctx) {
    const r = currentArea(gridSel(ctx));
    return {shift: isFullRows(r) ? 'row' : isFullCols(r) ? 'column' : 'up'};
  },
  validate: v => (SHIFTS.includes(v.shift) ? [] : [{field: 'shift', message: 'Choose how to delete.'}]),
  toCommand: v => ({command: 'home.deleteCells', params: {shift: v.shift}}),
});
