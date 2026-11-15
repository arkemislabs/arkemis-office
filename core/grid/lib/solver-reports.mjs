// Solver reports: the Answer report (objective, variable cells and constraints before and after) and the
// Limits report (each variable's lowest and highest value with the others held), built as lines of cells
// for new worksheets.
// Translated from gridcraft crates/engine/src/cmd/solver/reports.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A report is {name, lines: [[row, col, value, bold]]}; a value is a number, text, null or `{e: '#VALUE!'}`.
// The sheets are written by the command (commands/data/solver.mjs). No DOM, no Node built-ins.

import {bad, failed, Trial, valueOf} from './data-common.mjs';
import {colToLetters} from './addr.mjs';
import {numberToText} from './value.mjs';
import {engineFor} from '../model/calc.mjs';
import {PRECISION, Evaluator, asNum, sameCell} from './solver-problem.mjs';
import {optimise} from './solver-run.mjs';

const ERR_VALUE = {e: '#VALUE!'}, ERR_NA = {e: '#N/A'};

const TITLE = {answer: 'Answer', limits: 'Limits'};

/** The `reports` list (null when absent): 'answer' and 'limits', each once. */
export function reportKinds(cmd, p) {
  if (p.reports === undefined || p.reports === null) return null;
  if (!Array.isArray(p.reports)) throw bad(cmd, '`reports` must be an array of answer and limits');
  const kinds = [];
  for (const k of p.reports) {
    const t = typeof k === 'string' ? k.trim().toLowerCase() : '';
    if (t !== 'answer' && t !== 'limits') throw bad(cmd, `unknown report ${JSON.stringify(k)} (answer or limits)`);
    if (!kinds.includes(t)) kinds.push(t);
  }
  return kinds;
}

const absRef = c => `$${colToLetters(c.col)}$${c.row + 1}`;
const num = v => (Number.isFinite(v) ? v : ERR_VALUE);
const methodName = m => (m === 'simplex' ? 'Simplex LP' : m === 'grg' ? 'GRG Nonlinear' : 'Evolutionary');
const relText = {le: '<=', eq: '=', ge: '>='};

/** A cell's name in the reports: the nearest text to its left and the nearest text above it. */
function cellName(read, c) {
  const text = (row, col) => { const v = read(row, col); return typeof v === 'string' && v.trim() !== '' ? v : null; };
  let left = null, top = null;
  for (let col = c.col - 1; col >= 0 && left === null; col--) left = text(c.row, col);
  for (let row = c.row - 1; row >= 0 && top === null; row--) top = text(row, c.col);
  return [left, top].filter(x => x !== null).join(' ');
}

/** Header labels in bold from column 1, then the rows below them; returns the next free row. */
function table(out, row, headers, rows) {
  headers.forEach((h, k) => out.push([row, 1 + k, h, true]));
  let r = row;
  for (const cells of rows) {
    r++;
    cells.forEach((v, k) => out.push([r, 1 + k, v, false]));
  }
  return r + 2;
}

function title(out, kind, sheetName) {
  out.push([0, 0, `Arkemis ${TITLE[kind]} Report`, true]);
  out.push([1, 0, `Worksheet: ${sheetName}`, false]);
  return 3;
}

function constraintRow(read, sheetName, c, cell, v, rhs, k) {
  let formula, status, slack;
  if (c.rel === 'int') { formula = `${absRef(cell)}=Integer`; status = 'Binding'; slack = 0; }
  else if (c.rel === 'bin') { formula = `${absRef(cell)}=Binary`; status = 'Binding'; slack = 0; }
  else {
    const b = rhs[k] ?? rhs[0] ?? NaN;
    const rhsText = c.rhs.kind === 'cells' ? absRef(c.rhs.cells[k] ?? c.rhs.cells[0]) : numberToText(b);
    const s = Math.abs(v - b);
    const binding = c.rel === 'eq' || s <= PRECISION * (1 + Math.abs(b));
    slack = binding ? 0 : s;
    formula = `${absRef(cell)}${relText[c.rel]}${rhsText}`;
    status = binding ? 'Binding' : 'Not Binding';
  }
  return [absRef(cell), cellName(read, cell), num(v), formula, status, num(slack)];
}

function answerReport(content, sheetName, inp) {
  const m = inp.model;
  const trial = new Trial(content);
  const engine = engineFor(content);
  const read = (row, col) => valueOf(engine, m.sheet, row, col);
  const readAt = (x, cells) => {
    const sets = m.vars.map((c, i) => ({sheet: m.sheet, row: c.row, col: c.col, value: x[i]}));
    return trial.run(sets, cells.map(c => ({sheet: m.sheet, row: c.row, col: c.col}))).map(asNum);
  };
  const f0 = readAt(inp.original, [m.objective])[0] ?? NaN;
  // Every cell the constraints read, at the solution.
  const cells = [m.objective];
  for (const c of m.cons) {
    cells.push(...c.lhs);
    if (c.rhs.kind === 'cells') cells.push(...c.rhs.cells);
  }
  const vals = readAt(inp.solution, cells);
  let at = 0;
  const nextVal = () => vals[at++] ?? NaN;
  const f1 = nextVal();
  const out = [];
  let r = title(out, 'answer', sheetName);
  out.push([r, 0, `Result: ${inp.message}`, false]);
  out.push([r + 1, 0, `Engine: ${methodName(m.method)}`, false]);
  r += 3;
  const goal = m.goal.kind === 'max' ? 'Max' : m.goal.kind === 'min' ? 'Min' : `Value Of ${m.goal.value}`;
  out.push([r, 0, `Objective Cell (${goal})`, true]);
  r = table(out, r + 1, ['Cell', 'Name', 'Original Value', 'Final Value'], [[absRef(m.objective), cellName(read, m.objective), num(f0), num(f1)]]);
  out.push([r, 0, 'Variable Cells', true]);
  const kind = j => {
    const bin = m.cons.some(c => c.rel === 'bin' && c.lhs.some(x => sameCell(x, m.vars[j])));
    return bin ? 'Binary' : inp.prob.integer[j] ? 'Integer' : 'Contin';
  };
  const vars = m.vars.map((c, j) => [absRef(c), cellName(read, c), num(inp.original[j] ?? NaN), num(inp.solution[j] ?? NaN), kind(j)]);
  r = table(out, r + 1, ['Cell', 'Name', 'Original Value', 'Final Value', 'Integer'], vars);
  out.push([r, 0, 'Constraints', true]);
  const rows = [];
  for (const c of m.cons) {
    const lhs = c.lhs.map(() => nextVal());
    const rhs = c.rhs.kind === 'cells' ? c.rhs.cells.map(() => nextVal()) : c.rhs.kind === 'const' ? [c.rhs.value] : [];
    c.lhs.forEach((cell, k) => rows.push(constraintRow(read, sheetName, c, cell, lhs[k], rhs, k)));
  }
  table(out, r + 1, ['Cell', 'Name', 'Cell Value', 'Formula', 'Status', 'Slack'], rows);
  return out;
}

function limitsReport(content, sheetName, inp) {
  const m = inp.model;
  if (inp.prob.integer.some(b => b)) throw failed("The Limits report doesn't apply to models with integer or binary constraints.");
  if (m.method === 'evolutionary') throw failed('The Limits report is available for Simplex LP and GRG Nonlinear.');
  const n = m.vars.length;
  const x = inp.solution;
  const engine = engineFor(content);
  const read = (row, col) => valueOf(engine, m.sheet, row, col);
  // Each variable is minimised and maximised with the others held at the solution.
  const per = Math.max(Math.trunc(inp.budget / Math.max(2 * n, 1)), n + 3);
  const ev = new Evaluator({trial: new Trial(content), sheet: m.sheet, vars: m.vars, objective: m.objective, rows: inp.prob.rows, budget: 0});
  const objectiveAt = point => {
    ev.target = null;
    ev.budget = ev.evals + 1;
    return ev.evaluate(point)?.f ?? NaN;
  };
  const f = objectiveAt(x);
  const rows = [];
  m.vars.forEach((c, j) => {
    const lo = x.slice(), hi = x.slice();
    if (j < inp.prob.lo.length && j < inp.prob.hi.length) { lo[j] = inp.prob.lo[j]; hi[j] = inp.prob.hi[j]; }
    const ends = [];
    for (const kind of ['min', 'max']) {
      ev.target = j; ev.evals = 0; ev.budget = per;
      const solve = optimise(ev, m, {kind}, x, {lo, hi, integer: inp.prob.integer}, 0);
      const o = solve.outcome;
      if (o.kind === 'solved') ends.push([num(o.x[j] ?? NaN), num(objectiveAt(o.x))]);
      else if (o.kind === 'unbounded') ends.push(['Unbounded', null]);
      else ends.push([ERR_NA, null]);
    }
    const row = [absRef(c), cellName(read, c), num(x[j] ?? NaN)];
    for (const [v, o] of ends) { row.push(v); row.push(o); }
    rows.push(row);
  });
  const out = [];
  let r = title(out, 'limits', sheetName);
  r = table(out, r, ['Objective Cell', 'Name', 'Value'], [[absRef(m.objective), cellName(read, m.objective), num(f)]]);
  table(out, r, ['Variable Cell', 'Name', 'Value', 'Lower Limit', 'Objective Result', 'Upper Limit', 'Objective Result'], rows);
  return out;
}

/**
 * Builds every report before the solution or saved model can change: [{name, lines}]. `inp` is {model, prob, original, solution,
 * message, budget}; `content` is the workbook as the command found it.
 */
export function prepareReports(content, kinds, inp) {
  if (!kinds.length) return [];
  if (content.protection && content.protection.structure) throw failed('The workbook is protected and cannot be changed.');
  const sheet = content.sheets[inp.model.sheet];
  if (!sheet) throw failed('There is no workbook.');
  const built = [];
  for (const k of kinds) {
    const lines = k === 'answer' ? answerReport(content, sheet.name, inp) : limitsReport(content, sheet.name, inp);
    let name = null;
    for (let i = 1; i <= 10_000; i++) {
      const cand = `${TITLE[k]} Report ${i}`;
      if (!content.sheets.some(s => s.name.toLowerCase() === cand.toLowerCase()) && !built.some(b => b.name === cand)) { name = cand; break; }
    }
    if (!name) throw failed('Too many report sheets.');
    built.push({name, lines});
  }
  return built;
}

