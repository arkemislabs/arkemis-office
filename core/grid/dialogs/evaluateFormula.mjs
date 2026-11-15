// Evaluate Formula (Formulas › Evaluate Formula): Reference, and Evaluation showing the formula
// with the part the next Evaluate press calculates underlined; Evaluate replaces it with its
// value, Restart starts over at the end; Close.
// The steps are gridcraft's `formulas.evaluateFormula` (crates/engine/src/cmd/formulas.rs:791,
// shown as JSON by crates/ui-egui/src/dialogs.rs:969) at 146161b4b450a56e5e59a083ba0478582d1e602b,
// stepped in Excel's order (core/grid/lib/formulas-evaluate.mjs).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection} from '../model/workbook.mjs';
import {cellAt} from '../model/store.mjs';
import {colToLetters, quoteSheet} from '../lib/addr.mjs';
import {evaluationFrames} from '../lib/formulas-evaluate.mjs';

export default defineDialog({
  id: 'dialog.evaluateFormula',
  title: 'Evaluate Formula',
  command: 'formulas.evaluateFormula',
  init(ctx) {
    const sel = fromKernelSelection(ctx.doc, ctx.selection);
    const at = sel.active;
    const reference = `${quoteSheet(ctx.doc.sheets[sel.sheet].name)}!$${colToLetters(at.col)}$${at.row + 1}`;
    const c = cellAt(ctx.doc.sheets[sel.sheet], at.row, at.col);
    if (c?.f === undefined) return {reference, frames: [], step: 0, message: 'The cell currently being evaluated contains a constant.'};
    try {
      return {reference, frames: evaluationFrames(ctx.doc, sel.sheet, at, c.f), step: 0, message: null};
    } catch (e) {
      return {reference, frames: [], step: 0, message: String(e?.message ?? e)};
    }
  },
  validate: () => [],
  toCommand: () => null,
});
