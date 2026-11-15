// Solver Parameters dialog model (submit: data.solver with `review`, which opens Solver Results).
// Excel's Solver Parameters (Set Objective, To Max / Min / Value Of, By Changing Variable Cells, Subject to the
// Constraints, Make Unconstrained Variables Non-Negative, Select a Solving Method, Options, Solve) over gridcraft's
// crates/ui-egui/src/dialogs/analysis.rs `solver` and cmd/solver.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: objective, goal (max|min|value), value, variables, constraints (lines such as `$B$2:$C$2 <= 10`), selected
// (the constraint picked, -1 none), nonNegative, method (grg|simplex|evolutionary), options (see lib/solver-dialog.mjs),
// and two hand-over fields the nested dialogs write to: constraintEdit ({text, index} from Add Constraint) and
// optionsEdit (the options from Options). The buttons live in the body (src/apps/grid/dialogs/solver.tsx).

import {defineDialog} from '../../kernel/dialog.mjs';
import {colToLetters} from '../lib/addr.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {savedModel} from '../lib/solver-model.mjs';
import {absoluteText, optionsOf, DEFAULT_OPTIONS, METHOD_HELP} from '../lib/solver-dialog.mjs';

const absoluteCell = c => `$${colToLetters(c.col)}$${c.row + 1}`;

/** The dialog's starting values: the sheet's saved model, else an empty one on the active cell (`blank`: the empty one, as Reset All leaves it). */
export function solverValues(content, sheet, active, blank = false) {
  const saved = blank ? null : savedModel(content, sheet);
  const base = {objective: absoluteCell(active), goal: 'max', value: '', variables: '', constraints: [], selected: -1, nonNegative: true, method: 'grg',
    options: {...DEFAULT_OPTIONS}, methodHelp: METHOD_HELP, constraintEdit: null, optionsEdit: null};
  if (!saved) return base;
  return {...base, objective: absoluteText(saved.objective), goal: saved.goal, value: saved.goal === 'value' ? String(saved.value) : '', variables: absoluteText(saved.variables),
    constraints: saved.constraints.map(absoluteText), nonNegative: saved.nonNegative, method: saved.method, options: optionsOf(saved)};
}

export default defineDialog({
  id: 'dialog.solver',
  title: 'Solver Parameters',
  command: 'data.solver',
  init(ctx) {
    const sel = gridSel(ctx);
    return solverValues(baseDoc(ctx), sel.sheet, sel.active);
  },
  /** The nested dialogs hand their result over here: a constraint is added or replaced, the options are taken. */
  derive(values, changed) {
    const out = {};
    if (changed.includes('constraintEdit') && values.constraintEdit) {
      const {text, index} = values.constraintEdit;
      const list = [...(values.constraints ?? [])];
      if (typeof text === 'string' && text) {
        if (Number.isInteger(index) && index >= 0 && index < list.length) list[index] = text;
        else { list.push(text); out.selected = list.length - 1; }
        out.constraints = list;
      }
      out.constraintEdit = null;
    }
    if (changed.includes('optionsEdit') && values.optionsEdit) {
      out.options = {...values.options, ...values.optionsEdit};
      out.optionsEdit = null;
    }
    if (changed.includes('method')) out.methodHelp = METHOD_HELP;
    return out;
  },
  validate(v) {
    const out = [];
    if (!String(v.objective ?? '').trim()) out.push({field: 'objective', message: 'Enter the objective cell.'});
    if (v.goal === 'value' && (String(v.value ?? '').trim() === '' || !Number.isFinite(Number(String(v.value).trim())))) out.push({field: 'value', message: 'Enter the value to reach as a number.'});
    if (!String(v.variables ?? '').trim()) out.push({field: 'variables', message: 'Enter the variable cells.'});
    return out;
  },
  /** Solve: the model, with `review` so Solver Results opens, and `keep: false` so the cells wait for Keep Solver Solution. */
  toCommand(v) {
    const o = optionsOf({...v.options});
    const params = {
      objective: String(v.objective).trim(), goal: v.goal ?? 'max', variables: String(v.variables).trim(),
      constraints: (v.constraints ?? []).map(c => String(c)), nonNegative: v.nonNegative !== false, method: v.method ?? 'grg', review: true, keep: false,
    };
    if (v.goal === 'value') params.value = Number(String(v.value).trim());
    if (o.maxEvaluations !== DEFAULT_OPTIONS.maxEvaluations) params.maxEvaluations = o.maxEvaluations;
    if (o.integerOptimality) params.integerOptimality = o.integerOptimality;
    if (params.method === 'evolutionary') {
      Object.assign(params, {populationSize: o.populationSize, mutationRate: o.mutationRate, randomSeed: o.randomSeed, convergence: o.convergence,
        generationsWithoutImprovement: o.generationsWithoutImprovement, requireBounds: o.requireBounds});
    }
    return {command: 'data.solver', params};
  },
});
