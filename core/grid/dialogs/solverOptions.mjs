// Solver Options dialog model: the options the solving methods here honour. Excel's Options has All Methods,
// GRG Nonlinear and Evolutionary pages; the engine (cmd/solver/model.rs `EvoOptions`, `maxEvaluations`,
// `integerOptimality` at 146161b4b450a56e5e59a083ba0478582d1e602b) has an evaluation budget, the integer optimality gap
// and the Evolutionary options. Constraint Precision, Use Automatic Scaling, Show Iteration Results, Ignore Integer
// Constraints and the GRG Nonlinear page have no engine and are not drawn. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Opened over Solver Parameters (it hands `value`, the options, to its field `optionsEdit`).

import {defineDialog} from '../../kernel/dialog.mjs';
import {DEFAULT_OPTIONS, OPTION_KEYS, optionsOf} from '../lib/solver-dialog.mjs';

const pick = v => Object.fromEntries(OPTION_KEYS.map(k => [k, v[k]]));
const LIMITS = {
  maxEvaluations: [1, 200000, 'Max Evaluations'], integerOptimality: [0, 100, 'Integer Optimality (%)'], populationSize: [10, 1000, 'Population Size'],
  mutationRate: [0, 1, 'Mutation Rate'], randomSeed: [0, 4294967295, 'Random Seed'], convergence: [0, 1, 'Convergence'],
  generationsWithoutImprovement: [1, 100000, 'Generations without Improvement'],
};

export default defineDialog({
  id: 'dialog.solverOptions',
  title: 'Options',
  init(_ctx, args) {
    const o = optionsOf({...DEFAULT_OPTIONS, ...(args?.options ?? {})});
    return {...o, value: pick(o)};
  },
  derive: v => ({value: pick({...DEFAULT_OPTIONS, ...v})}),
  validate(v) {
    const out = [];
    for (const [k, [lo, hi, label]] of Object.entries(LIMITS)) {
      const x = v[k];
      if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) out.push({field: k, message: `${label} must be a number from ${lo} to ${hi}.`});
    }
    return out;
  },
  toCommand: () => null,
});
