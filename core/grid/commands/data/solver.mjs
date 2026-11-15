// Data > Analysis > Solver: finds values for variable cells that maximise, minimise or hit a value in an
// objective cell, subject to constraints, and writes the Answer and Limits reports on new sheets.
// Translated from gridcraft crates/engine/src/cmd/solver.rs (`run`, `report` and the specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b; the methods are in lib/solver-{problem,model,lp,nlp,evo,run,
// reports}.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The workbook is the model: every evaluation sets the variable cells on a trial copy and recalculates their
// dependents, so any formula works (Simplex LP linearises it and checks linearity, GRG Nonlinear is an
// augmented-Lagrangian method, Evolutionary a genetic search). Work is bounded by an evaluation budget. The model
// is saved as hidden sheet-scoped names (`solver_opt`, `solver_adj`, `solver_lhs1`...) so it travels with the
// workbook through XLSX. The solution, the saved model and the report sheets are one undo step.
//
// Not in gridcraft (Excel's Solver Results dialog): `review` on data.solver opens Solver Results instead of writing
// the solution, and `data.solverKeep` is that dialog's OK (keep or restore the values, reports, back to Solver Parameters).
// Not checked against upstream.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, parseCell} from '../../lib/addr.mjs';
import {engineFor} from '../../model/calc.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {deriveStyle} from '../../model/style.mjs';
import {hasDoc, gridSel, setGridSelection} from '../../lib/edit-targets.mjs';
import {Trial, valueOf, bad, failed, baseDoc} from '../../lib/data-common.mjs';
import {guardWrite} from '../edit/cell.mjs';
import {DEFAULT_EVALS, MAX_EVALS, Evaluator, asNum, buildProblem, cellKey} from '../../lib/solver-problem.mjs';
import {parseModel, savedModel, savedNames, modelParams} from '../../lib/solver-model.mjs';
import {optimise} from '../../lib/solver-run.mjs';
import {reportKinds, prepareReports} from '../../lib/solver-reports.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/solver.rs', 'crates/engine/src/cmd/solver/problem.rs', 'crates/engine/src/cmd/solver/model.rs', 'crates/engine/src/cmd/solver/lp.rs', 'crates/engine/src/cmd/solver/nlp.rs', 'crates/engine/src/cmd/solver/evolutionary.rs', 'crates/engine/src/cmd/solver/reports.rs', 'crates/engine/src/cmd/solver/tests.rs']};
const CMD = 'data.solver', REPORT_CMD = 'data.solverReport';

const budgetOf = p => {
  const v = p.maxEvaluations;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(Math.trunc(v), MAX_EVALS) : DEFAULT_EVALS;
};
const numOrNull = v => (Number.isFinite(v) ? v : null);
const nextSeq = ctx => (ctx.view?.dialogRequest?.seq ?? 0) + 1;

/** Writes prepared reports on new sheets before sheet `at`; the sheet that was active stays active. Returns the sheet names. */
function writeReports(ctx, at, built) {
  const names = built.map(b => b.name);
  if (!built.length) return names;
  const prev = gridSel(ctx);
  const prevId = ctx.doc.sheets[prev.sheet]?.id ?? ctx.doc.activeSheetId;
  const bold = deriveStyle(ctx.change, ctx.doc, 0, {font: {bold: true}});
  built.forEach((b, i) => {
    const made = ctx.run('home.insertSheet', {name: b.name, before: at + i});
    const ni = made.index;
    for (const [row, col, v, isBold] of b.lines) {
      const cell = {};
      if (v !== null && v !== undefined) cell.v = v;
      if (isBold) cell.s = bold;
      writeCell(ctx.change, ctx.doc, ni, row, col, Object.keys(cell).length ? cell : null);
    }
    ctx.change.set(['sheets', ni, 'cols'], {0: {size: 14}, 1: {size: 110}, 2: {size: 140}, 3: {size: 120}, 4: {size: 120}, 5: {size: 120}, 6: {size: 120}, 7: {size: 120}});
  });
  // The sheet that was active keeps its place and selection.
  const index = ctx.doc.sheets.findIndex(x => x.id === prevId);
  if (index >= 0) {
    ctx.change.set(['activeSheetId'], prevId);
    setGridSelection(ctx, {...prev, sheet: index});
  }
  return names;
}

/** Writes the variable cells (checked against protection and arrays first, so a refusal writes nothing). */
function writeVariables(ctx, model, x) {
  const base = baseDoc(ctx);
  const cells = model.vars.map((c, i) => ({c, cell: {v: x[i], ...(cellAt(base.sheets[model.sheet], c.row, c.col)?.s ? {s: cellAt(base.sheets[model.sheet], c.row, c.col).s} : {})}}));
  for (const {c, cell} of cells) guardWrite(ctx, model.sheet, c.row, c.col, cell);
  for (const {c, cell} of cells) writeCell(ctx.change, ctx.doc, model.sheet, c.row, c.col, cell);
}

function storeModel(ctx, content, model) {
  const current = ctx.change.get(['names']) ?? content.names ?? [];
  ctx.change.set(['names'], savedNames(content, current, model));
}

/** The params a report command takes over a saved model: the given model as is, else the saved one with the params over it. */
function reportParams(content, active, p) {
  if (p.model && typeof p.model === 'object' && !Array.isArray(p.model)) return p.model;
  if (p.model === null || p.model === undefined) return {...(savedModel(content, active) ?? {}), ...p};
  throw bad(REPORT_CMD, '`model` must be data.solver params');
}

function solve(ctx, p) {
  const content = baseDoc(ctx);
  const active = gridSel(ctx).sheet;
  let params = p;
  if (p.saved === true) {
    const saved = savedModel(content, active);
    if (!saved) throw failed('This sheet has no saved Solver model.');
    params = {...saved, ...p};
  }
  const has = ['objective', 'setObjective', 'set'].some(k => typeof params[k] === 'string' && params[k].trim() !== '');
  if (!has) {
    // No objective: the saved model, and the Solver Parameters dialog.
    ctx.setView({dialogRequest: {seq: nextSeq(ctx), id: 'dialog.solver', init: {}}});
    return {model: savedModel(content, active)};
  }
  const model = parseModel(content, params, active);
  const budget = budgetOf(params);
  const gapRaw = params.integerOptimality;
  const gap = typeof gapRaw === 'number' && Number.isFinite(gapRaw) ? Math.min(Math.max(gapRaw, 0), 100) / 100 : 0;
  const keep = params.keep !== false;
  const save = params.saveModel !== false;
  const review = params.review === true;
  const kinds = reportKinds(CMD, params);
  const prob = buildProblem(model);
  const engine = engineFor(content);
  const x0 = model.vars.map(c => { const v = asNum(valueOf(engine, model.sheet, c.row, c.col)); return Number.isFinite(v) ? v : 0; });
  const ev = new Evaluator({trial: new Trial(content), sheet: model.sheet, vars: model.vars, objective: model.objective, rows: prob.rows, budget});
  if (model.method === 'evolutionary' && model.evo.requireBounds && [...prob.lo, ...prob.hi].some(b => !Number.isFinite(b))) {
    throw failed('The Evolutionary method needs a lower and an upper bound on every variable cell (constraints such as "A1:A3 <= 10"), or requireBounds: false.');
  }
  const {outcome, notLinear, evoEnd} = optimise(ev, model, model.goal, x0, {lo: prob.lo, hi: prob.hi, integer: prob.integer}, gap);
  let status, message, solution = null;
  const simplex = model.method === 'simplex';
  if (notLinear) { status = 'notLinear'; message = "The model isn't linear in the variable cells, so Simplex LP can't solve it. Try GRG Nonlinear."; }
  else if (outcome.kind === 'solved' && outcome.converged && model.method === 'evolutionary') {
    solution = outcome.x;
    if (evoEnd === 'stalled') { status = 'cannotImprove'; message = 'Solver stopped when the best solution stopped improving. All constraints are satisfied.'; }
    else { status = 'converged'; message = 'The population converged. The best solution found satisfies all constraints.'; }
  } else if (outcome.kind === 'solved' && outcome.converged) {
    solution = outcome.x;
    status = simplex ? 'optimal' : 'converged';
    message = simplex ? 'Solver found an optimal solution. All constraints are satisfied.' : 'Solver converged to a locally optimal solution. All constraints are satisfied.';
  } else if (outcome.kind === 'solved') {
    solution = outcome.x; status = 'iterationLimit'; message = 'Solver stopped at its evaluation limit; the best solution found satisfies the constraints.';
  } else if (outcome.kind === 'limit') { status = 'iterationLimit'; message = 'Solver stopped at its evaluation limit without finding a feasible solution.'; }
  else if (outcome.kind === 'infeasible') { status = 'infeasible'; message = 'Solver could not find a solution that satisfies all constraints.'; }
  else { status = 'unbounded'; message = 'The objective can grow without limit: the problem is unbounded.'; }
  const evaluations = ev.evals;
  // The objective's value at the solution.
  let objective = null;
  if (solution) { ev.budget = ev.budget + 1; objective = numOrNull(ev.evaluate(solution)?.f ?? NaN); }
  const values = {}, original = {};
  if (solution) model.vars.forEach((c, i) => { values[a1(c.row, c.col)] = solution[i]; });
  model.vars.forEach((c, i) => { original[a1(c.row, c.col)] = x0[i]; });
  // A review leaves the cells to Solver Results (Keep Solver Solution / Restore Original Values).
  const changed = keep && !review && solution !== null;
  const built = kinds && solution && !review ? prepareReports(content, kinds, {model, prob, original: x0, solution, message, budget}) : [];
  const out = {status, message, objective, values, original, model: modelParams(content, model), evaluations, changed};
  let names = [];
  if (changed || save || built.length) {
    if (changed) writeVariables(ctx, model, solution);
    if (save) storeModel(ctx, content, model);
    names = writeReports(ctx, model.sheet, built);
  }
  if (kinds && solution && !review) out.reports = names;
  if (review) ctx.setView({dialogRequest: {seq: nextSeq(ctx), id: 'dialog.solverResults', init: {status, message, objective, values, original, model: out.model, evaluations}}});
  return out;
}

/** `{cell: number}` maps over the variable cells; cells they leave out keep `current`. */
function pointOf(model, current, p, key) {
  const x = current.slice();
  const map = p[key];
  if (map === undefined || map === null) return x;
  if (typeof map !== 'object' || Array.isArray(map)) throw bad(REPORT_CMD, `\`${key}\` must map cells to numbers`);
  const index = new Map(model.vars.map((c, j) => [cellKey(c), j]));
  for (const [cell, v] of Object.entries(map)) {
    const c = parseCell(cell.replace(/\$/g, '').trim());
    if (!c) throw bad(REPORT_CMD, `not a cell: \`${cell}\``);
    const j = index.get(cellKey(c));
    if (j === undefined) throw bad(REPORT_CMD, `\`${cell}\` is not a variable cell`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(REPORT_CMD, `\`${key}.${cell}\` must be a number`);
    x[j] = v;
  }
  return x;
}
/** The reports of a solution of a model: {model, prob, original, solution, message, budget} from `data.solverReport` params. */
function reportInput(content, active, p) {
  const params = reportParams(content, active, p);
  const model = parseModel(content, params, active);
  const prob = buildProblem(model);
  const engine = engineFor(content);
  const current = model.vars.map(c => asNum(valueOf(engine, model.sheet, c.row, c.col)));
  const solution = pointOf(model, current, p, 'values');
  const original = p.original !== undefined && p.original !== null ? pointOf(model, current, p, 'original') : solution.slice();
  const message = typeof p.message === 'string' ? [...p.message].slice(0, 500).join('') : '';
  return {model, prob, original, solution, message, budget: budgetOf(params)};
}

function report(ctx, p) {
  const kinds = reportKinds(REPORT_CMD, p);
  if (kinds === null) throw bad(REPORT_CMD, 'missing `reports` (answer, limits)');
  if (!kinds.length) throw bad(REPORT_CMD, '`reports` is empty (answer, limits)');
  const content = baseDoc(ctx);
  const inp = reportInput(content, gridSel(ctx).sheet, p);
  const built = prepareReports(content, kinds, inp);
  return {sheets: writeReports(ctx, inp.model.sheet, built)};
}

/** Solver Results' OK: keep the solution or restore the original values, write reports, go back to Solver Parameters. */
function keep(ctx, p) {
  const content = baseDoc(ctx);
  const active = gridSel(ctx).sheet;
  const kinds = reportKinds('data.solverKeep', p) ?? [];
  const wantsBack = p.returnToParams === true;
  const inp = reportInput(content, active, p);
  const keepIt = p.restore !== true;
  const built = kinds.length ? prepareReports(content, kinds, inp) : [];
  let wrote = false;
  if (keepIt && p.values && typeof p.values === 'object' && Object.keys(p.values).length) { writeVariables(ctx, inp.model, inp.solution); wrote = true; }
  const sheets = writeReports(ctx, inp.model.sheet, built);
  if (wantsBack) ctx.setView({dialogRequest: {seq: nextSeq(ctx), id: 'dialog.solver', init: {}}});
  return {kept: wrote, sheets};
}

const MODEL_PARAMS = {
  objective: s.optional(s.string({max: 600})), goal: s.optional(s.string({max: 20})), value: s.optional(s.any()), variables: s.optional(s.string({max: 4000})),
  constraints: s.optional(s.array(s.any(), {max: 1000})), nonNegative: s.optional(s.boolean()), method: s.optional(s.string({max: 40})),
};

export default defineCommands({
  family: 'data/solver',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.solver', label: 'Solver…', risk: 'edit', dialog: 'dialog.solver',
      description: 'Solver (Data > Analysis): find values for the `variables` cells (≤200 constants on one sheet) that make the `objective` formula cell max, min or a value (`goal`, `value`), subject to `constraints` (["B5 <= 10", "B2:B4 >= C2:C4", "B2 int", "B3 bin", {lhs, op, rhs}]). `nonNegative` (default true), `method` grg (default), simplex or evolutionary (with populationSize, mutationRate, randomSeed, convergence, generationsWithoutImprovement, requireBounds), `keep` (default true; false restores the original values), `saveModel` (default true: hidden solver_* names), `maxEvaluations` (20000), `integerOptimality` percent, `saved` (solve the sheet\'s saved model; other params override), `reports` [answer|limits] written on new sheets, `review` (open Solver Results instead of writing the solution). → {status: optimal|converged|cannotImprove|iterationLimit|infeasible|unbounded|notLinear, message, objective, values, original, model, evaluations, changed, reports?}. No `objective` → {model: the saved model} and the dialog opens.',
      params: s.object({...MODEL_PARAMS, populationSize: s.optional(s.any()), mutationRate: s.optional(s.any()), randomSeed: s.optional(s.any()), convergence: s.optional(s.any()),
        generationsWithoutImprovement: s.optional(s.any()), requireBounds: s.optional(s.boolean()), keep: s.optional(s.boolean()), saveModel: s.optional(s.boolean()),
        maxEvaluations: s.optional(s.number()), integerOptimality: s.optional(s.number()), saved: s.optional(s.boolean()), reports: s.optional(s.array(s.any(), {max: 4})),
        review: s.optional(s.boolean()), setObjective: s.optional(s.string({max: 600})), set: s.optional(s.string({max: 600})), to: s.optional(s.string({max: 20})),
        changing: s.optional(s.string({max: 4000})), byChanging: s.optional(s.string({max: 4000}))}),
      state: hasDoc,
      run: solve,
    },
    {
      id: 'data.solverReport', label: 'Solver Reports', risk: 'edit',
      description: 'Write Answer and Limits reports on new sheets before the model\'s sheet: `reports` [answer|limits], `values` ({cell: number}, the solution; default the variable cells\' current values), `original` ({cell: number}), `message` (the result line), `model` (data.solver params; default the sheet\'s saved model, with any data.solver params given here over it). Limits needs Simplex LP or GRG Nonlinear and no integer constraints. data.solver\'s result can be passed as is. → {sheets: [names]}.',
      params: s.object({reports: s.optional(s.any()), values: s.optional(s.any()), original: s.optional(s.any()), message: s.optional(s.string({max: 2000})), model: s.optional(s.any())}, {additional: true}),
      state: hasDoc,
      run: report,
    },
    {
      id: 'data.solverKeep', label: 'Keep Solver Solution', risk: 'edit',
      description: 'Solver Results\' OK: write the solution `values` ({cell: number}) into the variable cells (Keep Solver Solution) unless `restore` is true (Restore Original Values), write the `reports` [answer|limits] of that solution, and with `returnToParams` open Solver Parameters again. `original`, `message` and `model` as in data.solverReport. → {kept, sheets}.',
      params: s.object({reports: s.optional(s.any()), values: s.optional(s.any()), original: s.optional(s.any()), message: s.optional(s.string({max: 2000})), model: s.optional(s.any()),
        restore: s.optional(s.boolean()), returnToParams: s.optional(s.boolean())}, {additional: true}),
      state: hasDoc,
      run: keep,
    },
  ],
});
