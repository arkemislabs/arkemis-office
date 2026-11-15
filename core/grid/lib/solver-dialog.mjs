// What Solver's dialogs share: cell references written Excel's way ($B$2:$C$2), a constraint as the one
// line the list shows, the options of the solving methods, and the texts under the method box.
// Excel's Solver Parameters, Add Constraint, Options and Solver Results over gridcraft's solver commands
// (crates/ui-egui/src/dialogs/analysis.rs `solver`, `solver_results` at 146161b4b450a56e5e59a083ba0478582d1e602b;
// not checked against upstream beyond that). MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

/** The text of cell references with every cell made absolute: `D3:D5 <= E3:E5` -> `$D$3:$D$5 <= $E$3:$E$5`. */
export function absoluteText(text) {
  return String(text ?? '').replace(/(^|[^\w$.])\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![\w(])/g, (_, pre, col, row) => `${pre}$${col.toUpperCase()}$${row}`);
}

/** The relations Add Constraint offers (Excel's list without `dif`: no solving method here has an all-different constraint). */
export const RELATIONS = [
  {value: '<=', label: '<='}, {value: '=', label: '='}, {value: '>=', label: '>='}, {value: 'int', label: 'int'}, {value: 'bin', label: 'bin'},
];
export const takesValue = op => op !== 'int' && op !== 'bin';

/** A constraint as one line: `$B$2:$C$2 <= 10`, `$B$2 int`. */
export function constraintText(lhs, op, rhs) {
  const l = absoluteText(String(lhs ?? '').trim());
  return takesValue(op) ? `${l} ${op} ${absoluteText(String(rhs ?? '').trim().replace(/^=+/, '').trim())}` : `${l} ${op}`;
}

/** Splits a constraint line back into {lhs, op, rhs}: the longest operators first (as the command reads them). */
export function splitLine(line) {
  const t = String(line ?? '').trim();
  for (const op of ['<=', '>=', '=<', '=>', '≤', '≥', '==']) {
    const i = t.indexOf(op);
    if (i >= 0) return {lhs: t.slice(0, i).trim(), op: op === '<=' || op === '=<' || op === '≤' ? '<=' : op === '>=' || op === '=>' || op === '≥' ? '>=' : '=', rhs: t.slice(i + op.length).trim()};
  }
  const eq = t.indexOf('=');
  if (eq >= 0) return {lhs: t.slice(0, eq).trim(), op: '=', rhs: t.slice(eq + 1).trim()};
  const m = /^(.*?)\s+(int|integer|bin|binary)$/i.exec(t);
  if (m) return {lhs: m[1].trim(), op: /^bin/i.test(m[2]) ? 'bin' : 'int', rhs: ''};
  return {lhs: t, op: '<=', rhs: ''};
}

const REF = String.raw`(?:(?:'(?:[^']|'')+'|[^!,:'"]+)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?`;
const REF_LIST = new RegExp(`^${REF}(?:\\s*,\\s*${REF})*$`);
/** Whether the text is one or more cell references (`B2:B4,D1`). */
export const isRefList = t => REF_LIST.test(String(t ?? '').trim());

/** The Evolutionary and All Methods options with their defaults (Solver Options). */
export const DEFAULT_OPTIONS = Object.freeze({
  maxEvaluations: 20000, integerOptimality: 0,
  populationSize: 100, mutationRate: 0.075, randomSeed: 0, convergence: 0.0001, generationsWithoutImprovement: 50, requireBounds: true,
});
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);

/** The options of a model (saved or typed) with the defaults for the rest. */
export function optionsOf(model) {
  const out = {...DEFAULT_OPTIONS};
  for (const k of OPTION_KEYS) if (model && model[k] !== undefined && model[k] !== null) out[k] = model[k];
  return out;
}

/** The sentence under the method box (Excel's text: it names all three engines whichever is picked). */
export const METHOD_HELP = 'Select the GRG Nonlinear engine for Solver Problems that are smooth nonlinear. Select the LP Simplex engine for linear Solver Problems, and select the Evolutionary engine for Solver problems that are non-smooth.';

export const METHODS = [{value: 'grg', label: 'GRG Nonlinear'}, {value: 'simplex', label: 'Simplex LP'}, {value: 'evolutionary', label: 'Evolutionary'}];

/** Whether the Limits report applies to a model ({method, constraints: lines}): Simplex LP or GRG Nonlinear with no integer or binary constraint. */
export function limitsAvailable(model) {
  if (!model || model.method === 'evolutionary') return false;
  return !(model.constraints ?? []).some(c => /\s(int|integer|bin|binary)\s*$/i.test(String(c)));
}
