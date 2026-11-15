// Add Constraint / Change Constraint dialog model (Cell Reference, relation, Constraint).
// Excel's Add Constraint over gridcraft's constraint syntax (cmd/solver/model.rs `split_constraint`: `B5 <= 10`,
// `B2:B4 >= C2:C4`, `B2 int`, `B3 bin`) at 146161b4b450a56e5e59a083ba0478582d1e602b; upstream adds a constraint from three
// boxes of the Solver form. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Opened over Solver Parameters (the nested dialog hands `value` = {text, index} to its field `constraintEdit`). Values:
// lhs, op, rhs, index (the constraint being changed, -1 for a new one), value (the hand-over). `dif` (all different) is
// not offered: no solving method here has it.

import {defineDialog} from '../../kernel/dialog.mjs';
import {constraintText, isRefList, takesValue, RELATIONS} from '../lib/solver-dialog.mjs';
import {numText2} from '../lib/solver-model.mjs';

/** What OK hands to Solver Parameters: the constraint line and the place it takes (null while it is incomplete). */
export const handOver = v => {
  const lhs = String(v.lhs ?? '').trim();
  if (!lhs) return null;
  if (takesValue(v.op) && !String(v.rhs ?? '').trim()) return null;
  return {text: constraintText(lhs, v.op, v.rhs), index: Number.isInteger(v.index) ? v.index : -1};
};

export default defineDialog({
  id: 'dialog.addConstraint',
  title: 'Add Constraint',
  init: () => ({lhs: '', op: '<=', rhs: '', index: -1, value: null}),
  derive: v => ({value: handOver(v)}),
  validate(v) {
    const out = [];
    if (!String(v.lhs ?? '').trim()) out.push({field: 'lhs', message: 'Enter the cell reference.'});
    else if (!isRefList(String(v.lhs))) out.push({field: 'lhs', message: 'Reference is not valid.'});
    if (!RELATIONS.some(r => r.value === v.op)) out.push({field: 'op', message: 'Choose a relation from the list.'});
    else if (takesValue(v.op)) {
      const rhs = String(v.rhs ?? '').trim().replace(/^=+/, '').trim();
      if (!rhs) out.push({field: 'rhs', message: 'Enter a number or a cell reference for the constraint.'});
      else if (numText2(rhs) === null && !isRefList(rhs)) out.push({field: 'rhs', message: 'Reference is not valid.'});
    }
    return out;
  },
  toCommand: () => null,
});
