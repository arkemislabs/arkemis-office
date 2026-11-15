// Data > Forecast > What-If Analysis > Scenario Manager: Add, Show, Delete and Summary.
// Translated from gridcraft crates/engine/src/cmd/whatif/scenarios.rs (`Scenario`, `load_scenarios`,
// `store_scenarios`, `scenario_list`, `scenario_add`, `scenario_show`, `scenario_delete`,
// `scenario_summary`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The scenarios of a workbook live in one hidden workbook-scope name `_sc_scenarios` holding them as
// a JSON string (written as "..."&"..." pieces of at most 250 characters, Excel's string-literal limit),
// so they are saved to and reopened from .xlsx with the workbook. A scenario is {name, sheet,
// changing: 'B2,B4', values: [..], comment}; at most 32 changing cells and 1000 scenarios.
// Show writes the scenario's values into its changing cells; Summary inserts a "Scenario Summary"
// sheet with the changing cells and the result cells for the current values and for each scenario.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, colToLetters} from '../../lib/addr.mjs';
import {CellError} from '../../lib/value.mjs';
import {parseInput} from '../../lib/parse.mjs';
import {engineFor} from '../../model/calc.mjs';
import {inputToCell, putCell, jsonToInput} from '../../model/input.mjs';
import {writeCell} from '../../model/store.mjs';
import {sheetIndex} from '../../model/sheet.mjs';
import {styleIdAt} from '../../model/workbook.mjs';
import {resolveStyle, styleById, deriveStyle} from '../../model/style.mjs';
import {hasDoc, gridSel, setGridSelection, selectionAt} from '../../lib/edit-targets.mjs';
import {Trial, cellList, valueOf, bad, failed, baseDoc} from '../../lib/data-common.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/whatif.rs', 'crates/engine/src/cmd/whatif/scenarios.rs']};
export const SCENARIO_NAME = '_sc_scenarios';
const MAX_SCENARIO_CELLS = 32;
const MAX_SCENARIOS = 1000;
/** A defined name's formula holds at most this many characters. */
const MAX_STORE = 8000;

const isStore = n => !n.scope && String(n.name).toLowerCase() === SCENARIO_NAME;

/** Concatenates the string literals of a `"a"&"b""c"` formula. */
function stringLiterals(f) {
  let out = '', inStr = false;
  const t = [...String(f)];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) { if (c === '"') inStr = true; continue; }
    if (c === '"') { if (t[i + 1] === '"') { out += '"'; i++; } else inStr = false; } else out += c;
  }
  return out;
}

/** The scenarios of a workbook content. */
export function loadScenarios(content) {
  const n = (content.names ?? []).find(isStore);
  if (!n) return [];
  try { const list = JSON.parse(stringLiterals(n.formula)); return Array.isArray(list) ? list : []; } catch { return []; }
}

function storeScenarios(ctx, content, list) {
  const rest = (ctx.change.get(['names']) ?? content.names ?? []).filter(n => !isStore(n));
  if (list.length) {
    const text = JSON.stringify(list);
    const chars = [...text];
    const parts = [];
    for (let i = 0; i < chars.length; i += 250) parts.push(`"${chars.slice(i, i + 250).join('').replaceAll('"', '""')}"`);
    const formula = parts.join('&');
    if (formula.length > MAX_STORE) throw failed('There are too many scenarios to keep in the workbook.');
    rest.push({name: SCENARIO_NAME, formula, comment: 'Arkemis Grid Scenario Manager data', hidden: true});
  }
  ctx.change.set(['names'], rest);
}

const scenarioJson = sc => ({name: sc.name, sheet: sc.sheet, changing: sc.changing, values: sc.values, comment: sc.comment ?? ''});
const valueJson = v => (v === null || v === undefined ? null : v instanceof CellError ? v.text : v);
/** What a JSON value typed into a cell is, as a constant. */
function jsonValue(v, sys) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') { const r = parseInput(v, sys).value; return r instanceof CellError ? {e: r.text} : r; }
  return String(v);
}

function list(ctx, p) {
  const content = baseDoc(ctx);
  const sheet = typeof p.sheet === 'string' ? p.sheet : content.sheets[gridSel(ctx).sheet]?.name ?? '';
  return {scenarios: loadScenarios(content).filter(sc => sheet === '*' || sc.sheet.toLowerCase() === sheet.toLowerCase()).map(scenarioJson)};
}

function add(ctx, p) {
  const content = baseDoc(ctx);
  { const pr = content.sheets[gridSel(ctx).sheet]?.protection; if (pr && pr.enabled !== false && !pr.scenarios) throw failed("The cell or chart you're trying to change is on a protected sheet."); }
  const name = String(p.name ?? '').trim();
  if (!name) throw bad('data.scenarioAdd', 'missing `name`');
  if ([...name].length > 255) throw bad('data.scenarioAdd', 'the name is too long (255 characters max)');
  if (typeof p.changing !== 'string' || !p.changing.trim()) throw bad('data.scenarioAdd', 'missing `changing`');
  const active = gridSel(ctx).sheet;
  const {sheet: si, cells} = cellList(content, p.changing, 'data.scenarioAdd', MAX_SCENARIO_CELLS, active);
  if (!cells.length) throw bad('data.scenarioAdd', 'no changing cells');
  const engine = engineFor(content);
  let values;
  if (Array.isArray(p.values)) {
    if (p.values.length !== cells.length) throw bad('data.scenarioAdd', `${p.values.length} values for ${cells.length} changing cells`);
    values = p.values;
  } else values = cells.map(c => valueJson(valueOf(engine, si, c.row, c.col)));
  const sc = {name, sheet: content.sheets[si].name, changing: cells.map(c => a1(c.row, c.col)).join(','), values, comment: p.comment ?? ''};
  const all = loadScenarios(content);
  const i = all.findIndex(x => x.name.toLowerCase() === name.toLowerCase() && x.sheet.toLowerCase() === sc.sheet.toLowerCase());
  if (i >= 0) {
    if (p.replace !== true) throw failed(`A scenario named '${name}' already exists on this sheet.`);
    all[i] = sc;
  } else {
    if (all.length >= MAX_SCENARIOS) throw bad('data.scenarioAdd', 'too many scenarios');
    all.push(sc);
  }
  storeScenarios(ctx, content, all);
  return scenarioJson(sc);
}

function find(content, p, cmd, active) {
  const name = p.name;
  if (typeof name !== 'string' || !name) throw bad(cmd, 'missing `name`');
  const all = loadScenarios(content);
  const here = content.sheets[active]?.name ?? '';
  const i = all.findIndex(x => x.name.toLowerCase() === name.toLowerCase() && x.sheet.toLowerCase() === here.toLowerCase());
  const j = i >= 0 ? i : all.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
  if (j < 0) throw bad(cmd, `no scenario named \`${name}\``);
  return {all, i: j};
}

function show(ctx, p) {
  const content = baseDoc(ctx);
  { const pr = content.sheets[gridSel(ctx).sheet]?.protection; if (pr && pr.enabled !== false && !pr.scenarios) throw failed("The cell or chart you're trying to change is on a protected sheet."); }
  const {all, i} = find(content, p, 'data.scenarioShow', gridSel(ctx).sheet);
  const sc = all[i];
  const si = sheetIndex(content, sc.sheet);
  if (si < 0) throw bad('data.scenarioShow', `the scenario's sheet \`${sc.sheet}\` no longer exists`);
  const {cells} = cellList(content, sc.changing, 'data.scenarioShow', MAX_SCENARIO_CELLS, si);
  cells.forEach((c, k) => {
    const v = sc.values[k];
    // Stored numbers are values, not typed text: typing them would apply percent entry to a percent-formatted cell.
    const cell = typeof v === 'number' ? {v, ...(styleIdAt(content.sheets[si], c.row, c.col) ? {s: styleIdAt(content.sheets[si], c.row, c.col)} : {})}
      : inputToCell(ctx.change, ctx.doc, si, c.row, c.col, jsonToInput(v));
    putCell(ctx.change, ctx.doc, si, c.row, c.col, cell, jsonToInput(v));
  });
  return scenarioJson(sc);
}

function remove(ctx, p) {
  const content = baseDoc(ctx);
  { const pr = content.sheets[gridSel(ctx).sheet]?.protection; if (pr && pr.enabled !== false && !pr.scenarios) throw failed("The cell or chart you're trying to change is on a protected sheet."); }
  const {all, i} = find(content, p, 'data.scenarioDelete', gridSel(ctx).sheet);
  const [gone] = all.splice(i, 1);
  storeScenarios(ctx, content, all);
  return {deleted: gone.name};
}

function summary(ctx, p) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  const sheet = content.sheets[si];
  const scenarios = loadScenarios(content).filter(x => x.sheet.toLowerCase() === sheet.name.toLowerCase());
  if (!scenarios.length) throw failed('There are no scenarios on this sheet.');
  let results = [];
  if (typeof p.resultCells === 'string' && p.resultCells.trim()) {
    const r = cellList(content, p.resultCells, 'data.scenarioSummary', 255, si);
    if (r.sheet !== si) throw bad('data.scenarioSummary', 'result cells must be on the scenarios\' sheet');
    results = r.cells;
  }
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  // Changing cells of every scenario, first-seen order; per scenario its values.
  const changing = [];
  const per = [];
  for (const sc of scenarios) {
    const {cells} = cellList(content, sc.changing, 'data.scenarioSummary', MAX_SCENARIO_CELLS, si);
    const m = new Map();
    cells.forEach((c, k) => {
      if (!changing.some(x => x.row === c.row && x.col === c.col)) changing.push(c);
      m.set(`${c.row},${c.col}`, jsonValue(sc.values[k], sys));
    });
    per.push(m);
  }
  const engine = engineFor(content);
  const current = changing.map(c => valueOf(engine, si, c.row, c.col));
  const currentResults = results.map(c => valueOf(engine, si, c.row, c.col));
  const trial = new Trial(content);
  const reads = results.map(c => ({sheet: si, row: c.row, col: c.col}));
  const scenarioResults = per.map(m => trial.run([...m].map(([k, v]) => { const [row, col] = k.split(',').map(Number); return {sheet: si, row, col, value: v}; }), reads));
  const fmtOf = c => resolveStyle(styleById(content, styleIdAt(sheet, c.row, c.col))).numFmt;
  let name = 'Scenario Summary';
  for (let n = 2; sheetIndex(content, name) >= 0 && content.sheets.some(x => x.name.toLowerCase() === name.toLowerCase()); n++) name = `Scenario Summary ${n}`;
  const made = ctx.run('home.insertSheet', {name, before: content.sheets.length});
  const ni = made.index;
  const bold = deriveStyle(ctx.change, ctx.doc, 0, {font: {bold: true}});
  const put = (row, col, v, st = 0) => {
    const cell = {};
    if (v !== null && v !== undefined) cell.v = v instanceof CellError ? {e: v.text} : v;
    if (st) cell.s = st;
    writeCell(ctx.change, ctx.doc, ni, row, col, Object.keys(cell).length ? cell : null);
  };
  const fmtStyle = fmt => (fmt && fmt !== 'General' ? deriveStyle(ctx.change, ctx.doc, 0, {numFmt: fmt}) : 0);
  const abs = c => `$${colToLetters(c.col)}$${c.row + 1}`;
  put(1, 1, 'Scenario Summary', bold);
  put(2, 2, 'Current Values:', bold);
  scenarios.forEach((sc, k) => put(2, 3 + k, sc.name, bold));
  put(3, 1, 'Changing Cells:', bold);
  let row = 4;
  changing.forEach((c, i) => {
    const st = fmtStyle(fmtOf(c));
    put(row, 1, abs(c));
    put(row, 2, current[i], st);
    per.forEach((m, k) => { const v = m.get(`${c.row},${c.col}`); put(row, 3 + k, v === undefined ? current[i] : v, st); });
    row++;
  });
  if (results.length) {
    put(row, 1, 'Result Cells:', bold);
    row++;
    results.forEach((c, i) => {
      const st = fmtStyle(fmtOf(c));
      put(row, 1, abs(c));
      put(row, 2, currentResults[i], st);
      scenarioResults.forEach((r, k) => put(row, 3 + k, r[i], st));
      row++;
    });
  }
  put(row + 1, 1, 'Notes: Current Values column represents values of changing cells at time Scenario Summary Report was created.');
  ctx.change.set(['sheets', ni, 'cols'], {1: {size: 110}, 2: {size: 100}});
  setGridSelection(ctx, selectionAt(ni, {row: 0, col: 0}));
  return {sheet: name, scenarios: scenarios.length, changingCells: changing.length, resultCells: results.length};
}

export default defineCommands({
  family: 'whatif/scenarios',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.scenarioManager', label: 'Scenario Manager…', risk: 'read', dialog: 'dialog.scenarioManager',
      description: 'The scenarios of the active sheet (`sheet: "*"` lists all): {scenarios: [{name, sheet, changing, values, comment}]}.',
      params: s.object({sheet: s.optional(s.string({max: 300}))}),
      state: hasDoc,
      run: list,
    },
    {
      id: 'data.scenarioAdd', label: 'Add Scenario', risk: 'edit',
      description: 'Save a scenario: `name`, the `changing` cells (B2:B4 or B2,B4; at most 32, one sheet), their `values` (default: the cells\' current values) and a comment; `replace` overwrites a scenario of the same name.',
      params: s.object({name: s.string({min: 1, max: 255}), changing: s.string({min: 1, max: 600}), values: s.optional(s.array(s.any(), {max: MAX_SCENARIO_CELLS})), comment: s.optional(s.string({max: 255})), replace: s.optional(s.boolean())}),
      state: hasDoc,
      run: add,
    },
    {
      id: 'data.scenarioShow', label: 'Show Scenario', risk: 'edit',
      description: 'Write a scenario\'s values into its changing cells.',
      params: s.object({name: s.string({min: 1, max: 255})}),
      state: hasDoc,
      run: show,
    },
    {
      id: 'data.scenarioDelete', label: 'Delete Scenario', risk: 'edit',
      description: 'Delete a scenario by name.',
      params: s.object({name: s.string({min: 1, max: 255})}),
      state: hasDoc,
      run: remove,
    },
    {
      id: 'data.scenarioSummary', label: 'Scenario Summary', risk: 'edit', dialog: 'dialog.scenarioSummary',
      description: 'Insert a "Scenario Summary" sheet: the changing cells and the `resultCells` (B10 or B10:B12,D4) for the current values and for each scenario of the sheet.',
      params: s.object({resultCells: s.optional(s.string({max: 2000}))}),
      state: hasDoc,
      run: summary,
    },
  ],
});
