// Insert Function (Shift+F3, Formulas › Insert Function): search for a function or pick a
// category, select one; OK starts it in the active cell and opens Function Arguments, as Excel does.
// Translated from gridcraft crates/ui-egui/src/dialogs/insert_function.rs (search over names and
// descriptions, at most 300 hits, the selected function's signature and description, OK starting
// `=NAME(`) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's "Or select a category"
// list (Most Recently Used first) and Go. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {functionsFor, functionInfo, INSERT_FUNCTION_CATEGORIES, recentFunctions} from '../lib/formulas-catalog.mjs';

export default defineDialog({
  id: 'dialog.insertFunction',
  title: 'Insert Function',
  command: 'formulas.insertFunction',
  init(ctx) {
    const recent = recentFunctions(ctx.prefs);
    return {search: '', query: '', category: 'Most Recently Used', function: recent[0] ?? 'SUM', categories: [...INSERT_FUNCTION_CATEGORIES], recent: [...recent]};
  },
  derive(v, changed) {
    // Picking a category lists its functions and selects the first, as Excel does.
    if (changed.includes('category')) {
      const first = functionsFor({category: String(v.category), prefs: {gridRecentFunctions: v.recent}})[0];
      return {query: '', function: first?.name ?? null};
    }
    return null;
  },
  validate: v => (functionInfo(v.function) ? [] : [{field: 'function', message: 'Select a function'}]),
  buttons: {
    // Go runs the search typed in "Search for a function" (the body lists its hits).
    Go: () => null,
  },
  toCommand: v => ({command: 'formulas.insertFunction', params: {name: String(v.function).toUpperCase(), next: 'arguments'}}),
});
