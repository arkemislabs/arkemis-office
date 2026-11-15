// Solver: the model (objective, goal, variable cells, constraints, method and options), its reading from
// command params and its saving as hidden sheet-scoped names (`solver_opt`, `solver_adj`, `solver_lhs1`...)
// so it travels with the workbook through XLSX.
// Translated from gridcraft crates/engine/src/cmd/solver/model.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Model: {sheet (index), objective: cell, goal: {kind, value?}, vars: [cell], varsText, cons: [{lhs: [cell],
// lhsText, rel: 'le'|'eq'|'ge'|'int'|'bin', rhs: {kind: 'none'} | {kind: 'const', value} | {kind: 'cells', cells},
// rhsText}], nonNegative, method: 'simplex'|'grg'|'evolutionary', evo: {...}}. Saved names are
// `{name, formula, scope: sheet id, comment, hidden: true}`. No DOM, no Node built-ins.

import {bad, failed} from './data-common.mjs';
import {splitRef} from './edit-targets.mjs';
import {parseRange, count as rangeCount, colToLetters, quoteSheet} from './addr.mjs';
import {parseNumberText} from './parse.mjs';
import {cellAt} from '../model/store.mjs';
import {MAX_CONSTRAINTS, MAX_POPULATION, MAX_VARS, MIN_POPULATION, sameCell} from './solver-problem.mjs';

const CMD = 'data.solver';

const strParam = (p, k) => (typeof p?.[k] === 'string' ? p[k] : null);
const numParam = (p, k) => (typeof p?.[k] === 'number' && Number.isFinite(p[k]) ? p[k] : null);
const boolParam = (p, k) => (typeof p?.[k] === 'boolean' ? p[k] : null);

/** The text of a number as Rust prints an f64. */
export const numText = v => String(v);

/** The relation symbol of a constraint. */
export const REL_TEXT = {le: '<=', eq: '=', ge: '>=', int: 'int', bin: 'bin'};
/** The relation code of the saved model (`solver_relN`), as in Solver's VBA `SolverAdd`. */
const REL_CODE = {le: 1, eq: 2, ge: 3, int: 4, bin: 5};
const REL_FROM_CODE = {1: 'le', 2: 'eq', 3: 'ge', 4: 'int', 5: 'bin'};

function relParse(s) {
  switch (String(s).trim().toLowerCase()) {
    case '<=': case '≤': case '=<': case 'le': return 'le';
    case '>=': case '≥': case '=>': case 'ge': return 'ge';
    case '=': case '==': case 'eq': return 'eq';
    case 'int': case 'integer': return 'int';
    case 'bin': case 'binary': return 'bin';
    default: return null;
  }
}

const EVO_DEFAULT = {population: 100, mutation: 0.075, seed: 0, convergence: 1e-4, stall: 50, requireBounds: true};

/** The Evolutionary method's options (Solver Options > Evolutionary). */
function evoOptions(p) {
  const d = EVO_DEFAULT;
  const num = k => {
    const v = numParam(p, k) ?? (strParam(p, k) !== null ? numText2(strParam(p, k)) : null);
    return v !== null && Number.isFinite(v) ? v : null;
  };
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const trunc = v => Math.trunc(v);
  const pop = num('populationSize'), mut = num('mutationRate'), seed = num('randomSeed'), conv = num('convergence'), stall = num('generationsWithoutImprovement');
  return {
    population: pop === null ? d.population : trunc(clamp(pop, MIN_POPULATION, MAX_POPULATION)),
    mutation: mut === null ? d.mutation : clamp(mut, 0, 1),
    seed: seed === null ? d.seed : trunc(clamp(seed, 0, 4294967295)),
    convergence: conv === null ? d.convergence : clamp(conv, 0, 1),
    stall: stall === null ? d.stall : trunc(clamp(stall, 1, 100_000)),
    requireBounds: boolParam(p, 'requireBounds') ?? d.requireBounds,
  };
}

/** Numeric text as a number (null when it isn't one or isn't finite). */
export function numText2(t) {
  const v = parseNumberText(String(t).trim());
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The sheet name part of `Sheet1!B2` is dropped (names are saved without it). */
const afterBang = t => { const i = String(t).lastIndexOf('!'); return i >= 0 ? String(t).slice(i + 1) : String(t); };

/** Cells of `"B2:B4,D1"` on one sheet (row-major per area, in order), at most `cap`: {sheet, cells}. */
function cellsOf(content, t, defaultSheet, cap) {
  let sheet = null;
  const out = [];
  for (const part of String(t).split(',').map(x => x.trim()).filter(Boolean)) {
    const split = splitRef(content, part);
    const si = split.sheet ?? defaultSheet;
    if (sheet === null) sheet = si;
    else if (sheet !== si) throw bad(CMD, 'all cells of a reference must be on one sheet');
    const r = parseRange(split.body.replace(/\$/g, '').trim());
    if (!r) throw bad(CMD, `not a reference: \`${part}\``);
    const n = rangeCount(r);
    if (n > cap || out.length + n > cap) throw bad(CMD, `too many cells (at most ${cap})`);
    for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) out.push({row, col});
  }
  if (!out.length) throw bad(CMD, `not a reference: \`${t}\``);
  return {sheet: sheet ?? defaultSheet, cells: out};
}

/** Splits `"B5 <= 10"` / `"B2 int"` into [lhs, relation, rhs]. */
function splitConstraint(t) {
  for (const op of ['<=', '>=', '=<', '=>', '≤', '≥', '==']) {
    const i = t.indexOf(op);
    if (i >= 0) return [t.slice(0, i).trim(), relParse(op), t.slice(i + op.length).trim()];
  }
  const eq = t.indexOf('=');
  if (eq >= 0) return [t.slice(0, eq).trim(), 'eq', t.slice(eq + 1).trim()];
  const lower = t.trim().toLowerCase();
  for (const [suffix, rel] of [['integer', 'int'], ['binary', 'bin'], ['int', 'int'], ['bin', 'bin']]) {
    if (lower.endsWith(suffix)) {
      const a = lower.slice(0, lower.length - suffix.length).trim();
      return [t.trim().slice(0, a.length).trim(), rel, ''];
    }
  }
  return null;
}

const sheetOnly = () => failed("Constraint cells must be on the objective cell's sheet.");

function parseConstraint(content, sheet, c) {
  let lhsText, rel, rhsJson;
  if (typeof c === 'string') {
    const parts = splitConstraint(c);
    if (!parts || !parts[1]) throw bad(CMD, `not a constraint: \`${c}\``);
    [lhsText, rel, rhsJson] = parts;
  } else if (c && typeof c === 'object' && !Array.isArray(c)) {
    lhsText = strParam(c, 'lhs') ?? strParam(c, 'cell') ?? strParam(c, 'range') ?? '';
    const op = strParam(c, 'op') ?? strParam(c, 'relation') ?? '';
    rel = relParse(op);
    if (!rel) throw bad(CMD, `unknown constraint relation \`${op}\``);
    rhsJson = c.rhs ?? c.value ?? null;
  } else throw bad(CMD, 'a constraint is a string like "B5 <= 10" or {lhs, op, rhs}');
  const l = cellsOf(content, lhsText, sheet, MAX_CONSTRAINTS);
  if (l.sheet !== sheet) throw sheetOnly();
  let rhs = {kind: 'none'}, rhsText = '';
  if (rel !== 'int' && rel !== 'bin') {
    if (typeof rhsJson === 'number') {
      if (!Number.isFinite(rhsJson)) throw bad(CMD, "the constraint's right side must be a number");
      rhs = {kind: 'const', value: rhsJson}; rhsText = numText(rhsJson);
    } else if (typeof rhsJson === 'string') {
      const t = rhsJson.trim().replace(/^=+/, '').trim();
      const v = numText2(t);
      if (v !== null) { rhs = {kind: 'const', value: v}; rhsText = t; }
      else {
        const r = cellsOf(content, t, sheet, MAX_CONSTRAINTS);
        if (r.sheet !== sheet) throw sheetOnly();
        if (r.cells.length !== 1 && r.cells.length !== l.cells.length) throw failed("The constraint's two sides must be the same size (or the right side one cell).");
        rhs = {kind: 'cells', cells: r.cells}; rhsText = t;
      }
    } else throw bad(CMD, "missing the constraint's right side");
  }
  return {lhs: l.cells, lhsText, rel, rhs, rhsText};
}

/** Reads the model from `data.solver` params; `active` is the active sheet's index. */
export function parseModel(content, p, active) {
  const objText = strParam(p, 'objective') ?? strParam(p, 'setObjective') ?? strParam(p, 'set') ?? '';
  let sheet, objective;
  try {
    const r = cellsOf(content, objText, active, 1);
    sheet = r.sheet; objective = r.cells[0];
  } catch { throw failed('The objective must be a single cell.'); }
  if (!objective) throw failed('The objective must be a single cell.');
  const sh = content.sheets[sheet];
  if (cellAt(sh, objective.row, objective.col)?.f === undefined) throw failed('The objective cell must contain a formula.');
  const goalText = (strParam(p, 'goal') ?? strParam(p, 'to') ?? 'max').toLowerCase();
  let goal;
  switch (goalText) {
    case 'max': case 'maximize': case 'maximum': goal = {kind: 'max'}; break;
    case 'min': case 'minimize': case 'minimum': goal = {kind: 'min'}; break;
    case 'value': case 'valueof': case 'value of': {
      const v = numParam(p, 'value') ?? (strParam(p, 'value') !== null ? numText2(strParam(p, 'value')) : null);
      if (v === null || !Number.isFinite(v)) throw bad(CMD, 'goal `value` needs a number in `value`');
      goal = {kind: 'value', value: v};
      break;
    }
    default: throw bad(CMD, `unknown goal \`${goalText}\` (max, min or value)`);
  }
  const varsText = strParam(p, 'variables') ?? strParam(p, 'changing') ?? strParam(p, 'byChanging') ?? '';
  let vars, vsi;
  try {
    const r = cellsOf(content, varsText, sheet, MAX_VARS);
    vars = r.cells; vsi = r.sheet;
  } catch (e) {
    throw failed(String(e?.message ?? '').includes('too many') ? `Too many variable cells (at most ${MAX_VARS}).` : 'The variable cells must be a reference like B2:B4.');
  }
  if (vsi !== sheet) throw failed("The variable cells must be on the objective cell's sheet.");
  const seen = new Set();
  vars = vars.filter(c => { const k = `${c.row},${c.col}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (vars.some(c => cellAt(sh, c.row, c.col)?.f !== undefined)) throw failed('Variable cells must hold constants, not formulas.');
  const cons = [];
  let scalar = 0;
  if (p.constraints !== undefined && p.constraints !== null) {
    if (!Array.isArray(p.constraints)) throw bad(CMD, '`constraints` must be an array');
    if (p.constraints.length > MAX_CONSTRAINTS) throw failed(`Too many constraints (at most ${MAX_CONSTRAINTS}).`);
    for (const raw of p.constraints) {
      const c = parseConstraint(content, sheet, raw);
      scalar += c.lhs.length;
      if (scalar > MAX_CONSTRAINTS) throw failed(`Too many constraints (at most ${MAX_CONSTRAINTS} cells).`);
      if ((c.rel === 'int' || c.rel === 'bin') && c.lhs.some(x => !vars.some(v => sameCell(v, x)))) throw failed('Integer and binary constraints must be on variable cells.');
      cons.push(c);
    }
  }
  const nonNegative = boolParam(p, 'nonNegative') ?? true;
  const methodText = (strParam(p, 'method') ?? 'grg').toLowerCase().replace(/[ _-]/g, '');
  let method;
  switch (methodText) {
    case 'grg': case 'grgnonlinear': case 'nonlinear': method = 'grg'; break;
    case 'simplex': case 'simplexlp': case 'lp': case 'linear': method = 'simplex'; break;
    case 'evolutionary': case 'evo': case 'genetic': method = 'evolutionary'; break;
    default: throw bad(CMD, `unknown method \`${methodText}\` (grg, simplex or evolutionary)`);
  }
  return {sheet, objective, goal, vars, varsText, cons, nonNegative, method, evo: evoOptions(p)};
}

// ---------------------------------------------------------------- saved model

/** `$B$2:$B$4` per part, qualified by the sheet. */
function refText(sheetName, cells) {
  const q = quoteSheet(sheetName);
  const abs = c => `$${colToLetters(c.col)}$${c.row + 1}`;
  return String(cells).split(',').map(x => x.trim()).filter(Boolean).map(part => {
    const r = parseRange(afterBang(part).replace(/\$/g, '').trim());
    if (!r) return null;
    return r.start.row === r.end.row && r.start.col === r.end.col ? `${q}!${abs(r.start)}` : `${q}!${abs(r.start)}:${abs(r.end)}`;
  }).filter(x => x !== null).join(',');
}

/** The model as hidden names scoped to its sheet, in place of any saved before; `names` is the workbook's list. Returns the new list. */
export function savedNames(content, names, m) {
  const sheet = content.sheets[m.sheet];
  if (!sheet) return names;
  const out = names.filter(n => !(n.scope === sheet.id && String(n.name).toLowerCase().startsWith('solver_')));
  const put = (name, formula) => out.push({name, formula, scope: sheet.id, comment: '', hidden: true});
  put('solver_opt', refText(sheet.name, `${colToLetters(m.objective.col)}${m.objective.row + 1}`));
  const [typ, val] = m.goal.kind === 'max' ? [1, 0] : m.goal.kind === 'min' ? [2, 0] : [3, m.goal.value];
  put('solver_typ', String(typ));
  put('solver_val', numText(val));
  put('solver_adj', refText(sheet.name, m.varsText));
  m.cons.forEach((c, i) => {
    const k = i + 1;
    put(`solver_lhs${k}`, refText(sheet.name, c.lhsText));
    put(`solver_rel${k}`, String(REL_CODE[c.rel]));
    let rhs;
    if (c.rhs.kind === 'none') rhs = c.rel === 'bin' ? '"binary"' : '"integer"';
    else if (c.rhs.kind === 'const') rhs = numText(c.rhs.value);
    else rhs = refText(sheet.name, c.rhsText);
    put(`solver_rhs${k}`, rhs);
  });
  put('solver_num', String(m.cons.length));
  put('solver_neg', m.nonNegative ? '1' : '2');
  put('solver_eng', m.method === 'grg' ? '1' : m.method === 'simplex' ? '2' : '3');
  if (m.method === 'evolutionary') {
    put('solver_ssz', String(m.evo.population));
    put('solver_mrt', numText(m.evo.mutation));
    put('solver_rsd', String(m.evo.seed));
    put('solver_rbv', m.evo.requireBounds ? '1' : '2');
  }
  put('solver_ver', '3');
  return out;
}

/** The saved model of a sheet (index) as `data.solver` params, if any. */
export function savedModel(content, sheetIndex) {
  const id = content.sheets[sheetIndex]?.id;
  const get = n => {
    const d = (content.names ?? []).find(x => String(x.name).toLowerCase() === n && (x.scope === id || !x.scope));
    return d ? String(d.formula).trim().replace(/^=+/, '') : null;
  };
  const local = t => String(t).split(',').map(p => afterBang(p.trim()).replace(/\$/g, '')).join(',');
  const opt = get('solver_opt');
  if (opt === null) return null;
  const objective = local(opt);
  if (!objective) return null;
  const typ = get('solver_typ');
  const goal = typ?.trim() === '2' ? 'min' : typ?.trim() === '3' ? 'value' : 'max';
  const value = numText2(get('solver_val') ?? '') ?? 0;
  const countRaw = numText2(get('solver_num') ?? '') ?? 0;
  const count = Math.trunc(Math.min(Math.max(countRaw, 0), MAX_CONSTRAINTS));
  const constraints = [];
  for (let k = 1; k <= count; k++) {
    const lhs = get(`solver_lhs${k}`);
    const rc = get(`solver_rel${k}`);
    const rel = rc === null ? null : REL_FROM_CODE[rc.trim()];
    if (lhs === null || !rel) continue;
    const l = local(lhs);
    if (rel === 'int' || rel === 'bin') constraints.push(`${l} ${REL_TEXT[rel]}`);
    else {
      let rhs = get(`solver_rhs${k}`) ?? '';
      rhs = numText2(rhs) !== null ? rhs : local(rhs);
      constraints.push(`${l} ${REL_TEXT[rel]} ${rhs}`);
    }
  }
  const eng = get('solver_eng')?.trim();
  const method = eng === '2' ? 'simplex' : eng === '3' ? 'evolutionary' : 'grg';
  const model = {objective, goal, value, variables: local(get('solver_adj') ?? ''), constraints, nonNegative: get('solver_neg')?.trim() !== '2', method};
  for (const [name, key] of [['solver_ssz', 'populationSize'], ['solver_mrt', 'mutationRate'], ['solver_rsd', 'randomSeed']]) {
    const v = numText2(get(name) ?? '');
    if (v !== null) model[key] = v;
  }
  const rbv = get('solver_rbv');
  if (rbv !== null) model.requireBounds = rbv.trim() !== '2';
  return model;
}

/** The model as `data.solver` params, in the form `savedModel` returns (the objective qualified by its sheet). */
export function modelParams(content, m) {
  const sheet = content.sheets[m.sheet] ? quoteSheet(content.sheets[m.sheet].name) : '';
  const [goal, value] = m.goal.kind === 'max' ? ['max', 0] : m.goal.kind === 'min' ? ['min', 0] : ['value', m.goal.value];
  const out = {
    objective: `${sheet}!${colToLetters(m.objective.col)}${m.objective.row + 1}`,
    goal, value,
    variables: m.varsText,
    constraints: m.cons.map(c => (c.rel === 'int' || c.rel === 'bin' ? `${c.lhsText} ${REL_TEXT[c.rel]}` : `${c.lhsText} ${REL_TEXT[c.rel]} ${c.rhsText}`)),
    nonNegative: m.nonNegative,
    method: m.method,
  };
  if (m.method === 'evolutionary') {
    const e = m.evo;
    Object.assign(out, {populationSize: e.population, mutationRate: e.mutation, randomSeed: e.seed, convergence: e.convergence, generationsWithoutImprovement: e.stall, requireBounds: e.requireBounds});
  }
  return out;
}

