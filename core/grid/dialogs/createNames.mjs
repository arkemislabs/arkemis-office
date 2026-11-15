// Create Names from Selection (Ctrl+Shift+F3): "Create names from values in the" Top row, Left
// column, Bottom row, Right column; the boxes start checked where the selection's edges hold labels.
// Excel's dialog over gridcraft crates/engine/src/cmd/formulas.rs `create_from_selection` at
// 146161b4b450a56e5e59a083ba0478582d1e602b (gridcraft's ribbon runs it with Top row only).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection, currentArea} from '../model/workbook.mjs';
import {engineFor} from '../model/calc.mjs';

/** Excel's guess: text labels across the top row → Top row; down the left column → Left column. */
export function guessEdges(content, si, r) {
  const eng = engineFor(content);
  const isText = (row, col) => typeof eng.sheetValue(si, row, col) === 'string';
  let top = false, left = false;
  if (r.end.row > r.start.row) {
    for (let c = r.start.col + (r.end.col > r.start.col ? 1 : 0); c <= r.end.col; c++) if (isText(r.start.row, c)) { top = true; break; }
  }
  if (r.end.col > r.start.col) {
    for (let row = r.start.row + (r.end.row > r.start.row ? 1 : 0); row <= r.end.row; row++) if (isText(row, r.start.col)) { left = true; break; }
  }
  if (!top && !left) top = true;
  return {top, left, bottom: false, right: false};
}

export default defineDialog({
  id: 'dialog.createNames',
  title: 'Create Names from Selection',
  command: 'formulas.createFromSelection',
  init(ctx) {
    const sel = fromKernelSelection(ctx.doc, ctx.selection);
    return guessEdges(ctx.doc, sel.sheet, currentArea(sel));
  },
  validate: v => (v.top || v.left || v.bottom || v.right ? [] : [{field: 'top', message: 'Choose where the labels are'}]),
  toCommand: v => ({command: 'formulas.createFromSelection', params: {top: !!v.top, left: !!v.left, bottom: !!v.bottom, right: !!v.right}}),
});
