// Solver Results dialog model (submit: data.solverKeep).
// Excel's Solver Results (the outcome, Keep Solver Solution / Restore Original Values, Reports: Answer and Limits,
// Return to Solver Parameters Dialog) over gridcraft's crates/ui-egui/src/dialogs/analysis.rs `solver_results` and
// cmd/solver.rs `report` at 146161b4b450a56e5e59a083ba0478582d1e602b. Upstream's dialog writes the solution when Solve runs and
// undoes it on Restore; here Solve leaves the cells alone until OK (data.solverKeep writes them or not, so Cancel leaves
// the original values). Sensitivity and Outline Reports, Save Scenario... have no engine and are not drawn.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Opened by data.solver's `review` (its view `dialogRequest` carries the result as `init`): status, message, objective,
// values ({cell: number}, empty when no solution was found), original, model, evaluations.

import {defineDialog} from '../../kernel/dialog.mjs';

/** Whether the solve found a solution the dialog can keep. */
export const hasSolution = v => !!v.values && typeof v.values === 'object' && Object.keys(v.values).length > 0;

export default defineDialog({
  id: 'dialog.solverResults',
  title: 'Solver Results',
  command: 'data.solverKeep',
  init: () => ({status: '', message: '', objective: null, values: {}, original: {}, model: null, evaluations: 0,
    restore: false, answerReport: false, limitsReport: false, returnToParams: false}),
  validate: () => [],
  toCommand(v) {
    const solved = hasSolution(v);
    const reports = solved ? [v.answerReport ? 'answer' : null, v.limitsReport ? 'limits' : null].filter(Boolean) : [];
    const keepIt = solved && !v.restore;
    if (!keepIt && !reports.length && !v.returnToParams) return {batch: []};
    const params = {values: v.values ?? {}, original: v.original ?? {}, message: String(v.message ?? ''), restore: !keepIt};
    if (v.model) params.model = v.model;
    if (reports.length) params.reports = reports;
    if (v.returnToParams) params.returnToParams = true;
    return {command: 'data.solverKeep', params};
  },
});
