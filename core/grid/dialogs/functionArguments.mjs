// Function Arguments (Excel, after Insert Function › OK, or Shift+F3 in a cell whose formula is a
// function call): one box per argument with the value it gives, the function's and the current
// argument's help, and "Formula result ="; OK enters the formula in the active cell.
// Excel's dialog, over gridcraft's catalogue (crates/engine/src/cmd/formulas.rs `function_list`)
// and evaluator (`formulas.evaluate`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection} from '../model/workbook.mjs';
import {cellAt} from '../model/store.mjs';
import {parse, print} from '../lib/formula.mjs';
import {functionInfo} from '../lib/formulas-catalog.mjs';

/** The function call a cell's formula is (=NAME(args)), as {function, args}, or null. */
export function callInCell(content, si, at) {
  const c = cellAt(content.sheets[si], at.row, at.col);
  if (c?.f === undefined) return null;
  let e;
  try { e = parse(c.f); } catch { return null; }
  if (e.t !== 'call' || !functionInfo(e.name)) return null;
  return {function: functionInfo(e.name).name, args: e.args.map(a => (a.t === 'missing' ? '' : print(a)))};
}

export default defineDialog({
  id: 'dialog.functionArguments',
  title: 'Function Arguments',
  command: 'formulas.insertFunction',
  init(ctx) {
    const sel = fromKernelSelection(ctx.doc, ctx.selection);
    const here = callInCell(ctx.doc, sel.sheet, sel.active);
    return here ? {function: here.function, args: here.args, focus: 0} : {function: 'SUM', args: [], focus: 0};
  },
  validate: v => (functionInfo(v.function) ? [] : [{field: 'args', message: 'Choose a function first'}]),
  toCommand: v => ({command: 'formulas.insertFunction', params: {
    name: String(v.function).toUpperCase(),
    args: (Array.isArray(v.args) ? v.args : []).map(a => String(a ?? '')),
  }}),
});
