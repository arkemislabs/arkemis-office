// Table Layout › Data › Formula (submit: table.formula).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/table.rs (`FORMULA_FUNCTIONS`,
// `FormulaForm::read` (=SUM(ABOVE) when the cell above holds a number, else =SUM(LEFT) when the cell
// left of it does, else "="), `paste`, `params`; OK only for a formula past its "=") at
// aadb077e072b7de05f724e359d8db82e151f125c. Word's dialog adds Number format (a \# picture) and
// Paste bookmark, kept as Word has them. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {parseNumber} from '../lib/table-formula.mjs';

/** The functions table.formula works out, offered by Paste function (Word's list). */
export const FORMULA_FUNCTIONS = ['ABS', 'AND', 'AVERAGE', 'COUNT', 'DEFINED', 'FALSE', 'IF', 'INT', 'MAX', 'MIN', 'MOD', 'NOT', 'OR', 'PRODUCT', 'ROUND', 'SIGN', 'SUM', 'TRUE'];
/** Word's Number format list (\# pictures). */
export const NUMBER_FORMATS = ['#,##0', '#,##0.00', '$#,##0.00;($#,##0.00)', '0', '0%', '0.00', '0.00%'];

export default defineDialog({
  id: 'dialog.tableFormula',
  title: 'Formula',
  command: 'table.formula',
  init(ctx) {
    const S = T.open(ctx);
    const [tp, r, c] = T.cell(S);
    const t = S.d.table(S.sel.focus.story, tp);
    const lang = T.defaultLang(S);
    const number = (row, col) => {
      const cell = row >= 0 && col >= 0 ? t?.rows[row]?.cells[col] : null;
      return cell ? parseNumber(T.cellText(cell).replace(/\n/g, ' ').trim(), lang) !== null : false;
    };
    const formula = number(r - 1, c) ? '=SUM(ABOVE)' : number(r, c - 1) ? '=SUM(LEFT)' : '=';
    const bookmarks = S.d.bookmarks().map(([n]) => n).filter(n => !n.startsWith('_'));
    return {formula, numberFormat: '', pasteFunction: '', pasteBookmark: '', bookmarks};
  },
  derive(v, changed) {
    // Paste function: NAME() at the end of the formula; Paste bookmark: its name.
    if (changed.includes('pasteFunction') && v.pasteFunction) return {formula: `${v.formula ?? ''}${v.pasteFunction}()`, pasteFunction: ''};
    if (changed.includes('pasteBookmark') && v.pasteBookmark) return {formula: `${v.formula ?? ''}${v.pasteBookmark}`, pasteBookmark: ''};
    return {};
  },
  validate(v) {
    const f = String(v.formula ?? '').trim();
    return f.startsWith('=') && f.length > 1 ? [] : [{field: 'formula', message: 'Type a formula that starts with = (for example =SUM(ABOVE)).'}];
  },
  toCommand(v) {
    let formula = String(v.formula ?? '').trim();
    const pic = String(v.numberFormat ?? '').trim();
    if (pic) formula = `${formula} \\# "${pic}"`;
    return {command: 'table.formula', params: {formula}};
  },
});
