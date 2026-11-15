// The Formulas tab: AutoSum, Insert Function, defined names, formula auditing and calculation.
// Translated from gridcraft crates/engine/src/cmd/formulas.rs (every command of `specs()`, with
// `selection_totals`, `single_row_totals`, `block_totals`, `guessed_range`, `define_name`,
// `create_from_selection`, `paste_name`, `select_trace_cells`, `convert_to_number`,
// `error_checking`, `evaluate_formula`, `evaluate`, `calc_options`) and the Formulas ribbon's
// handling of their results in crates/ui-egui/src/ribbon/formulas.rs (trace arrows, Remove
// Arrows) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Where gridcraft pushes a UiRequest the command sets session view state the grid surface reads
// (design note U-grid-edit--F-grid--begin-edit-request): `editCellRequest` (EditCell: start
// editing the active cell with a text), `insertNameRequest` (InsertName: the name at the caret of
// the edit under way, else `=name` in the active cell) and `traceArrows` (the ribbon's
// `app.grid.trace`). Dialogs open through each command's `dialog` (the shell opens it when the UI
// runs the command without params). No DOM, no Node built-ins.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, a1, rangeA1, rangeOf, isSingle, isFullRows, intersection, colToLetters, quoteSheet} from '../lib/addr.mjs';
import {parse, parseName, print, walk, hasRelativeRefs, shiftRelativeWrapping, sameName} from '../lib/formula.mjs';
import {precedents as staticPrecedents} from '../model/eval.mjs';
import {numberStoredAsText} from '../lib/parse.mjs';
import {isError, isNumber, isEmpty} from '../lib/value.mjs';
import {cellAt, writeCell, blockEntries, sheetBlocks} from '../model/store.mjs';
import {styleIdAt, currentArea} from '../model/workbook.mjs';
import {inputToCell, parseTypedFormula, checkArgCounts} from '../model/input.mjs';
import {engineFor, key as calcKey, keySheet, keyRow, keyCol} from '../model/calc.mjs';
import {
  hasDoc, gridSel, activeSheet, targetSheet, targetRanges, targetRange, cellParamOn, bad, failed, baseDoc, sheetPath,
} from '../lib/edit-targets.mjs';
import {guardWrite} from './edit/cell.mjs';
import {
  validName, refuseStashName, holdsAppData, scopeId, scopeLabel, sameScope, pasteableNames, renameNameInFormulas,
  valueJson, nameBody,
} from '../lib/formulas-names.mjs';
import {functionList, recordRecent} from '../lib/formulas-catalog.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/formulas.rs', 'crates/engine/src/cmd/stash.rs', 'crates/ui-egui/src/ribbon/formulas.rs']};

const CELL = s.optional(s.string({min: 1, max: 600, description: 'Cell: /sh:<id>/B2, Sheet1!B2 or B2 (default: the active cell)'}));
const RANGE = s.optional(s.string({min: 1, max: 4096, description: 'Range: /sh:<id>/A1:C9, Sheet1!A1:C9 or A1:C9 (default: the selection)'}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const SCOPE = s.optional(s.string({min: 1, max: 300, description: '"Workbook" or a sheet name'}));

let seq = 0;
const nextSeq = () => ++seq;

/** Start editing the active cell with `text` (gridcraft UiRequest::EditCell). */
function requestEdit(ctx, text) {
  const sel = gridSel(ctx);
  ctx.setView({editCellRequest: {seq: nextSeq(), sheet: ctx.doc.sheets[sel.sheet].id, row: sel.active.row, col: sel.active.col, text}});
}

// ---------------------------------------------------------------------------------------------
// AutoSum

const value = (content, si, row, col) => engineFor(content).sheetValue(si, row, col);
const blank = (content, si, row, col) => isEmpty(value(content, si, row, col));
const numeric = (content, si, row, col) => isNumber(value(content, si, row, col));
const sumFormula = (func, r0, c0, r1, c1) => `=${func}(${rangeA1(rangeOf(r0, c0, r1, c1))})`;

/** formulas.rs `single_row_totals`: the row's total in its last cell when empty, else just after it. */
function singleRowTotals(content, si, sel, used, func) {
  const row = sel.start.row;
  const lastCol = Math.min(used.end.col, sel.end.col);
  const endCol = isFullRows(sel) ? lastCol : sel.end.col;
  const [dataEnd, out] = endCol > sel.start.col && blank(content, si, row, endCol) ? [endCol - 1, endCol] : [endCol, endCol + 1];
  if (out >= MAX_COLS) throw failed("There's no room to the right of the selection for the total.");
  return [[{row, col: out}, sumFormula(func, row, sel.start.col, row, dataEnd)]];
}

/** formulas.rs `block_totals`: each column's total below it, each row's in an empty last column. */
function blockTotals(content, si, sel, used, func) {
  const writes = [];
  const lastCol = Math.min(used.end.col, sel.end.col);
  const rowsEnd = Math.min(sel.end.row, used.end.row);
  let rightBlank = !isFullRows(sel) && sel.end.col > sel.start.col;
  if (rightBlank) for (let r = sel.start.row; r <= rowsEnd; r++) if (!blank(content, si, r, sel.end.col)) { rightBlank = false; break; }
  const dataEndCol = rightBlank ? sel.end.col - 1 : lastCol;
  let lastRowBlank = true;
  for (let c = sel.start.col; c <= lastCol; c++) if (!blank(content, si, sel.end.row, c)) { lastRowBlank = false; break; }
  const [dataEndRow, outRow] = lastRowBlank ? [Math.max(0, sel.end.row - 1), sel.end.row] : [sel.end.row, sel.end.row + 1];
  if (lastRowBlank || !rightBlank) {
    if (outRow >= MAX_ROWS) throw failed("There's no room below the selection for the totals.");
    for (let c = sel.start.col; c <= Math.min(dataEndCol, lastCol); c++) writes.push([{row: outRow, col: c}, sumFormula(func, sel.start.row, c, dataEndRow, c)]);
  }
  if (rightBlank) {
    for (let r = sel.start.row; r <= Math.min(dataEndRow, rowsEnd); r++) writes.push([{row: r, col: sel.end.col}, sumFormula(func, r, sel.start.col, r, dataEndCol)]);
    if (lastRowBlank) writes.push([{row: sel.end.row, col: sel.end.col}, sumFormula(func, sel.start.row, sel.start.col, dataEndRow, dataEndCol)]);
  }
  return writes;
}

/** formulas.rs `guessed_range`: the numbers above the cell, else the numbers to its left. */
export function guessedRange(content, si, at) {
  const num = (r, c) => numeric(content, si, r, c);
  let range = null;
  if (at.row > 0 && (num(at.row - 1, at.col) || at.col === 0 || !num(at.row, at.col - 1))) {
    let top = at.row - 1;
    while (top > 0 && (num(top - 1, at.col) || (blank(content, si, top - 1, at.col) && top > 1 && num(top - 2, at.col)))) top--;
    if (num(at.row - 1, at.col)) range = rangeOf(top, at.col, at.row - 1, at.col);
  }
  if (!range && at.col > 0 && num(at.row, at.col - 1)) {
    let left = at.col - 1;
    while (left > 0 && num(at.row, left - 1)) left--;
    range = rangeOf(at.row, left, at.row, at.col - 1);
  }
  return range;
}

function autoSum(ctx, p) {
  const func = String(p.function ?? 'SUM').toUpperCase();
  const content = baseDoc(ctx);
  const si = activeSheet(ctx);
  const sel = p.range ? targetRange(ctx, p, ['range']).range : currentArea(gridSel(ctx));
  if (!isSingle(sel)) {
    const used = engineFor(content).usedRange(si);
    if (!used) return {};
    const writes = sel.start.row === sel.end.row ? singleRowTotals(content, si, sel, used, func) : blockTotals(content, si, sel, used, func);
    for (const [c, f] of writes) {
      const cell = inputToCell(ctx.change, ctx.doc, si, c.row, c.col, f) ?? {};
      guardWrite(ctx, si, c.row, c.col, cell);
      writeCell(ctx.change, ctx.doc, si, c.row, c.col, cell);
    }
    return {cells: writes.map(([c]) => a1(c.row, c.col))};
  }
  const at = sel.start;
  const r = guessedRange(content, si, at);
  if (!r) { requestEdit(ctx, `=${func}()`); return {}; }
  const text = `=${func}(${rangeA1(r)})`;
  if (p.enter === false) { requestEdit(ctx, text); return {formula: text}; }
  ctx.run('cell.set', {cell: `${sheetPath(ctx.doc, si)}/${a1(at.row, at.col)}`, input: text});
  return {formula: text};
}

// ---------------------------------------------------------------------------------------------
// Insert Function

function insertFunction(ctx, p) {
  if (typeof p.name !== 'string' || !p.name) {
    // The UI opens dialog.insertFunction (this command's dialog); a bridge call says so.
    return {dialog: 'dialog.insertFunction'};
  }
  const name = p.name.toUpperCase();
  recordRecent(ctx, name);
  if (Array.isArray(p.args)) {
    // Function Arguments › OK: the formula is entered in the active cell, as Excel does.
    let n = p.args.length;
    while (n > 0 && String(p.args[n - 1] ?? '').trim() === '') n--;
    const text = `=${name}(${p.args.slice(0, n).map(a => String(a ?? '').trim()).join(',')})`;
    const at = gridSel(ctx).active;
    ctx.run('cell.set', {cell: `${sheetPath(ctx.doc, activeSheet(ctx))}/${a1(at.row, at.col)}`, input: text});
    return {formula: text};
  }
  requestEdit(ctx, `=${name}(`);
  // Insert Function › OK: Excel opens Function Arguments over the cell being edited.
  if (p.next === 'arguments') ctx.setView({dialogRequest: {seq: nextSeq(), id: 'dialog.functionArguments', init: {function: name, args: [], focus: 0}}});
  return {formula: `=${name}(`};
}

function listFunctions(_ctx, p) {
  const cat = typeof p.category === 'string' ? p.category.toLowerCase() : null;
  const q = typeof p.search === 'string' ? p.search.toLowerCase() : null;
  return functionList().filter(f => (!cat || f.category.toLowerCase() === cat)
    && (!q || f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)));
}

// ---------------------------------------------------------------------------------------------
// Defined names

const absCell = c => `$${colToLetters(c.col)}$${c.row + 1}`;
/** `Sheet1!$A$1:$B$2` of the current selection (define_name's default). */
export function selectionRefersTo(ctx) {
  const sel = gridSel(ctx);
  const r = currentArea(sel);
  const body = isSingle(r) ? absCell(r.start) : `${absCell(r.start)}:${absCell(r.end)}`;
  return `${quoteSheet(ctx.doc.sheets[sel.sheet].name)}!${body}`;
}

function defineName(ctx, p) {
  const content = ctx.doc;
  if (typeof p.name !== 'string') return {dialog: 'dialog.defineName'};
  const name = p.name;
  if (!validName(name)) throw failed('The name that you entered is not valid.');
  for (const n of [name, p.oldName]) if (typeof n === 'string') refuseStashName(content, p, n);
  const scope = scopeId(content, p.scope, 'formulas.defineName');
  let refers;
  if (typeof p.refersTo === 'string') {
    const body = p.refersTo.replace(/^=+/, '');
    let e = null;
    try { e = parseName(body); } catch { e = null; }
    if (e && hasRelativeRefs(e)) {
      // As in Excel, relative references are relative to the active cell; names keep them
      // relative to A1, as files do.
      const at = gridSel(ctx).active;
      refers = print(shiftRelativeWrapping(e, -at.row, -at.col));
    } else refers = body;
  } else refers = selectionRefersTo(ctx);
  try { parseName(refers); } catch { throw failed("There's a problem with this formula."); }
  const comment = typeof p.comment === 'string' ? p.comment : '';
  const names = content.names ?? [];
  let old = null;
  if (typeof p.oldName === 'string') {
    const oldScope = scopeId(content, p.oldScope, 'formulas.defineName');
    if (!names.some(n => n.name.toLowerCase() === p.oldName.toLowerCase() && sameScope(n.scope, oldScope))) throw bad('formulas.defineName', 'no such name to edit');
    const same = p.oldName.toLowerCase() === name.toLowerCase() && sameScope(oldScope, scope);
    if (!same && names.some(n => n.name.toLowerCase() === name.toLowerCase() && sameScope(n.scope, scope))) {
      throw failed('The name entered already exists. Enter a unique name.');
    }
    old = {name: p.oldName, scope: oldScope};
  }
  let list = [...(ctx.change.get(['names']) ?? names)];
  if (old) {
    list = list.filter(n => !(n.name.toLowerCase() === old.name.toLowerCase() && sameScope(n.scope, old.scope)));
    ctx.change.set(['names'], list);
    if (old.name.toLowerCase() !== name.toLowerCase()) renameNameInFormulas(ctx.change, content, old.name, old.scope, name);
    list = [...ctx.change.get(['names'])];
  }
  list = list.filter(n => !(n.name.toLowerCase() === name.toLowerCase() && sameScope(n.scope, scope)));
  list.push({name, formula: refers, ...(scope ? {scope} : {}), ...(comment ? {comment} : {})});
  ctx.change.set(['names'], list);
  return {name, refersTo: `=${refers}`};
}

function deleteName(ctx, p) {
  const content = ctx.doc;
  if (typeof p.name !== 'string') throw bad('formulas.deleteName', 'missing `name`');
  refuseStashName(content, p, p.name);
  const any = p.scope === undefined || p.scope === null;
  const scope = any ? null : scopeId(content, p.scope, 'formulas.deleteName');
  const names = content.names ?? [];
  const kept = names.filter(n => !(n.name.toLowerCase() === p.name.toLowerCase() && (any || sameScope(n.scope, scope))));
  if (kept.length === names.length) throw bad('formulas.deleteName', 'no such name');
  ctx.change.set(['names'], kept);
  return null;
}

/** A name's expression as cell formula text: a top-level union (`A1,B2`) parsed as one is parenthesised. */
const cellText = e => print(e.t === 'binary' && e.op === ',' ? {t: 'paren', x: e} : e);

/** formulas.rs `name_manager`: the visible names with their value, refers-to, scope and comment. */
export function nameManagerList(content) {
  const eng = engineFor(content);
  const si = Math.max(0, content.sheets.findIndex(s => s.id === content.activeSheetId));
  return (content.names ?? []).filter(n => !n.hidden).map(n => {
    const sheet = n.scope ? Math.max(0, content.sheets.findIndex(s => s.id === n.scope)) : si;
    let v;
    try { v = valueJson(eng.evaluate(sheet, {row: 0, col: 0}, cellText(parseName(nameBody(n))))); } catch { v = {error: '#NAME?'}; }
    return {name: n.name, refersTo: `=${nameBody(n)}`, scope: scopeLabel(content, n), value: v, comment: n.comment ?? ''};
  });
}

/** Excel's Create Names cleaning of a label (formulas.rs `create_from_selection` `clean`). */
const cleanLabel = t => {
  let n = [...String(t).trim()].map(c => (/[\p{L}\p{N}]/u.test(c) || c === '.' ? c : '_')).join('');
  if (n && !validName(n)) n = `_${n}`;
  return validName(n) ? n : '';
};

function createFromSelection(ctx, p) {
  const {sheet: si, range: r} = targetRange(ctx, p, ['range']);
  const top = p.top ?? true, left = p.left ?? false, bottom = p.bottom ?? false, right = p.right ?? false;
  const content = baseDoc(ctx);
  const eng = engineFor(content);
  const sh = content.sheets[si];
  const q = quoteSheet(sh.name);
  const abs = (r0, c0, r1, c1) => `${q}!$${colToLetters(c0)}$${r0 + 1}:$${colToLetters(c1)}$${r1 + 1}`;
  const shown = (row, col) => {
    const v = eng.sheetValue(si, row, col);
    return v === null || v === undefined ? '' : isError(v) ? v.text : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  };
  const r0 = r.start.row + (top ? 1 : 0), r1 = r.end.row - (bottom ? 1 : 0);
  const c0 = r.start.col + (left ? 1 : 0), c1 = r.end.col - (right ? 1 : 0);
  const made = [];
  if (r0 <= r1 && c0 <= c1) {
    for (const [on, row] of [[top, r.start.row], [bottom, r.end.row]]) {
      if (!on) continue;
      for (let c = c0; c <= c1; c++) { const n = cleanLabel(shown(row, c)); if (n) made.push([n, abs(r0, c, r1, c)]); }
    }
    for (const [on, col] of [[left, r.start.col], [right, r.end.col]]) {
      if (!on) continue;
      for (let row = r0; row <= r1; row++) { const n = cleanLabel(shown(row, col)); if (n) made.push([n, abs(row, c0, row, c1)]); }
    }
  }
  const names = content.names ?? [];
  const exists = n => names.some(x => x.name.toLowerCase() === n.toLowerCase() && !x.scope);
  const ours = n => p.force !== true && holdsAppData(content, n);
  const keep = [], skipped = [];
  for (const m of made) (!ours(m[0]) && (p.replace === true || !exists(m[0])) ? keep : skipped).push(m);
  let list = [...names];
  for (const [name, f] of keep) {
    list = list.filter(x => !(x.name.toLowerCase() === name.toLowerCase() && !x.scope));
    list.push({name, formula: f});
  }
  if (keep.length) ctx.change.set(['names'], list);
  return {created: keep.length, skipped: skipped.map(m => m[0])};
}

function pasteName(ctx, p) {
  const content = ctx.doc;
  const si = activeSheet(ctx);
  const names = pasteableNames(content, si);
  const listed = names.map(([name, refersTo]) => ({name, refersTo}));
  if (p.list !== true) {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (name) {
      const hit = names.find(([n]) => sameName(n, name));
      if (!hit) throw failed(`There's no name "${name}" to paste.`);
      ctx.setView({insertNameRequest: {seq: nextSeq(), name: hit[0]}});
    }
    return {names: listed};
  }
  if (!names.length) throw failed('This workbook has no names to paste.');
  const at = cellParamOn(ctx, p, 'at', si) ?? gridSel(ctx).active;
  if (at.row + names.length > MAX_ROWS || at.col + 2 > MAX_COLS) throw failed("There isn't room on the sheet for the list of names.");
  names.forEach(([name, refers], i) => {
    for (const [col, text] of [[at.col, name], [at.col + 1, refers]]) {
      const row = at.row + i;
      const style = styleIdAt(ctx.doc.sheets[si], row, col);
      // The second column holds the refers-to text as a text value, with no formula.
      const cell = {v: text, ...(style ? {s: style} : {})};
      guardWrite(ctx, si, row, col, cell);
      writeCell(ctx.change, ctx.doc, si, row, col, cell);
    }
  });
  return {names: listed, range: rangeA1(rangeOf(at.row, at.col, at.row + names.length - 1, at.col + 1))};
}

// ---------------------------------------------------------------------------------------------
// Auditing

/**
 * The precedent areas of a cell's formula: [{sheet (index), range}] — the calculation graph's,
 * and the ranges the defined names it uses refer to (the graph treats names as dynamic, Excel's
 * Trace Precedents draws arrows from what they name).
 */
export function precedentAreas(content, si, at) {
  const eng = engineFor(content);
  const out = [...eng.graph.precedentsOf(calcKey(si, at.row, at.col))];
  const f = cellAt(content.sheets[si], at.row, at.col)?.f;
  if (f !== undefined) {
    let e = null;
    try { e = parse(f); } catch { e = null; }
    const seen = new Set();
    if (e) walk(e, x => {
      if (x.t !== 'name' || seen.has(String(x.v).toLowerCase())) return;
      seen.add(String(x.v).toLowerCase());
      const n = eng.wb.name(String(x.v), si);
      if (!n) return;
      let ne = null;
      try { ne = parseName(nameBody(n)); } catch { ne = null; }
      if (!ne) return;
      const scope = n.scope ? Math.max(0, content.sheets.findIndex(sh => sh.id === n.scope)) : si;
      for (const a of staticPrecedents(eng.wb, scope, ne)[0]) out.push(a);
    });
  }
  const keys = new Set();
  return out.filter(a => { const k = `${a.sheet}|${rangeA1(a.range)}`; if (keys.has(k)) return false; keys.add(k); return true; });
}
/** The formulas that read a cell: [{sheet, row, col}]. */
export function dependentCells(content, si, at) {
  const out = [];
  engineFor(content).graph.dependents(si, at.row, at.col, out);
  const seen = new Set();
  return out.filter(k => !seen.has(k) && seen.add(k)).sort((a, b) => a - b).map(k => ({sheet: keySheet(k), row: keyRow(k), col: keyCol(k)}));
}

function setTrace(ctx, si, at, kind, targets) {
  const traced = {sheet: ctx.doc.sheets[si].id, row: at.row, col: at.col};
  const prev = ctx.view?.traceArrows;
  const kept = prev && prev.sheet === traced.sheet && prev.row === at.row && prev.col === at.col ? prev : null;
  ctx.setView({traceArrows: {
    ...traced,
    precedents: kind === 'precedents' ? targets : (kept?.precedents ?? []),
    dependents: kind === 'dependents' ? targets : (kept?.dependents ?? []),
  }});
}

function tracePrecedents(ctx, p) {
  const content = ctx.doc;
  const si = activeSheet(ctx);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  let areas = precedentAreas(content, si, at);
  if (p.errors === true) {
    // Error Checking › Trace Error: only the precedents that hold an error (Excel's red arrows).
    const eng = engineFor(content);
    if (!isError(eng.sheetValue(si, at.row, at.col))) throw failed('The active cell does not contain an error.');
    areas = areas.filter(a => {
      const sh = content.sheets[a.sheet];
      if (!sh) return false;
      for (const [row, col] of storedIn(sh, a.range)) if (isError(eng.sheetValue(a.sheet, row, col))) return true;
      return false;
    });
  }
  const out =areas.map(a => ({sheet: content.sheets[a.sheet]?.name ?? null, range: rangeA1(a.range)}));
  setTrace(ctx, si, at, 'precedents', areas.map(a => ({sheet: content.sheets[a.sheet]?.id ?? null, range: rangeA1(a.range)})));
  return out;
}

function traceDependents(ctx, p) {
  const content = ctx.doc;
  const si = activeSheet(ctx);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const deps = dependentCells(content, si, at);
  setTrace(ctx, si, at, 'dependents', deps.map(d => ({sheet: content.sheets[d.sheet]?.id ?? null, range: a1(d.row, d.col)})));
  return deps.map(d => ({sheet: content.sheets[d.sheet]?.name ?? null, cell: a1(d.row, d.col)}));
}

function removeArrows(ctx, p) {
  const t = ctx.view?.traceArrows;
  if (!t) return {};
  if (p.kind === 'precedents' || p.kind === 'dependents') {
    const next = {...t, [p.kind]: []};
    ctx.setView({traceArrows: next.precedents.length || next.dependents.length ? next : null});
  } else ctx.setView({traceArrows: null});
  return {};
}

/** formulas.rs `select_trace_cells` (Ctrl+[ / Ctrl+] and with Shift every level). */
function selectTraceCells(ctx, p, precedents) {
  const content = ctx.doc;
  const eng = engineFor(content);
  const sheet = activeSheet(ctx);
  const at = cellParamOn(ctx, p, 'cell', sheet) ?? gridSel(ctx).active;
  const all = p.all === true;
  const found = new Map();   // `${si}|${a1}` -> [si, a1]
  const seen = new Set([calcKey(sheet, at.row, at.col)]);
  const frontier = [[sheet, at]];
  while (frontier.length) {
    const [ks, kc] = frontier.pop();
    if (precedents) {
      for (const a of eng.graph.precedentsOf(calcKey(ks, kc.row, kc.col))) {
        if (all) {
          const sh = content.sheets[a.sheet];
          if (!sh) continue;
          for (const [row, col, cell] of storedIn(sh, a.range)) {
            if (cell.v === undefined && cell.f === undefined) continue;
            if (cell.f === undefined && (cell.v === null)) continue;
            const k = calcKey(a.sheet, row, col);
            if (seen.has(k)) continue;
            seen.add(k);
            found.set(`${a.sheet}|${a1(row, col)}`, [a.sheet, a1(row, col)]);
            if (cell.f !== undefined) frontier.push([a.sheet, {row, col}]);
          }
        } else found.set(`${a.sheet}|${rangeA1(a.range)}`, [a.sheet, rangeA1(a.range)]);
      }
    } else {
      const deps = [];
      eng.graph.dependents(ks, kc.row, kc.col, deps);
      for (const k of deps) {
        const k2 = [keySheet(k), {row: keyRow(k), col: keyCol(k)}];
        if (all) {
          if (seen.has(k)) continue;
          seen.add(k);
          found.set(`${k2[0]}|${a1(k2[1].row, k2[1].col)}`, [k2[0], a1(k2[1].row, k2[1].col)]);
          frontier.push(k2);
        } else found.set(`${k2[0]}|${a1(k2[1].row, k2[1].col)}`, [k2[0], a1(k2[1].row, k2[1].col)]);
      }
    }
    if (!all) break;
  }
  found.delete(`${sheet}|${a1(at.row, at.col)}`);
  const entries = [...found.values()].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const name = precedents ? 'precedent' : 'dependent';
  const onSheet = entries.find(e => e[0] === sheet) ?? entries[0];
  if (!onSheet) throw bad('cell', `No ${name} cells.`);
  const si = onSheet[0];
  const params = {range: entries.filter(e => e[0] === si).map(e => e[1]).join(',')};
  if (si !== sheet) params.sheet = si;
  return ctx.run('selection.set', params);
}

/** Stored cells of a sheet inside a range, row-major: [row, col, cell]. */
function* storedIn(sheet, r) {
  const blocks = sheetBlocks(sheet);
  const b0 = Math.floor(r.start.row / 256), b1 = Math.floor(r.end.row / 256);
  const keys = Object.keys(blocks).map(Number).filter(b => b >= b0 && b <= b1).sort((x, y) => x - y);
  for (const b of keys) {
    const e = blockEntries(blocks[b]);
    for (let i = 0; i < e.cells.length; i++) {
      const row = e.rows[i], col = e.cols[i];
      if (row >= r.start.row && row <= r.end.row && col >= r.start.col && col <= r.end.col) yield [row, col, e.cells[i]];
    }
  }
}

function showFormulas(ctx, p) {
  const si = activeSheet(ctx);
  const cur = ctx.doc.sheets[si]?.showFormulas === true;
  const on = typeof p.on === 'boolean' ? p.on : !cur;
  if (on) ctx.change.set(['sheets', si, 'showFormulas'], true);
  else if (ctx.doc.sheets[si].showFormulas !== undefined) ctx.change.delete(['sheets', si, 'showFormulas']);
  return {on};
}

/** formulas.rs `number_stored_as_text`: a constant whose text would be a number if typed. */
export function numberStoredAsTextCell(cell) {
  return cell && cell.f === undefined && typeof cell.v === 'string' ? numberStoredAsText(cell.v) : null;
}

function convertToNumber(ctx, p) {
  const si = targetSheet(ctx, p, ['range']);
  const {areas} = targetRanges(ctx, p, ['range']);
  const content = baseDoc(ctx);
  const used = engineFor(content).usedRange(si);
  let converted = 0;
  for (const area of areas) {
    const r = used ? intersection(area, used) : null;
    if (!r) continue;
    const found = [];
    for (const [row, col, cell] of storedIn(content.sheets[si], r)) {
      const n = numberStoredAsTextCell(cell);
      if (n !== null && n !== undefined) found.push([row, col, cell, n]);
    }
    for (const [row, col, cell, n] of found) {
      const next = {...cell, v: n};
      guardWrite(ctx, si, row, col, next);
      writeCell(ctx.change, ctx.doc, si, row, col, next);
    }
    converted += found.length;
  }
  return {converted};
}

/** formulas.rs `error_checking`: every cell showing an error, and the circular references. */
export function errorCells(content) {
  const eng = engineFor(content);
  const errors = [];
  content.sheets.forEach((sh, si) => {
    if (errors.length >= 10_000) return;
    const blocks = sheetBlocks(sh);
    for (const b of Object.keys(blocks).map(Number).sort((x, y) => x - y)) {
      const e = blockEntries(blocks[b]);
      for (let i = 0; i < e.cells.length && errors.length < 10_000; i++) {
        const v = eng.sheetValue(si, e.rows[i], e.cols[i]);
        if (isError(v) && !(sh.ignoredErrors ?? []).includes(a1(e.rows[i], e.cols[i]))) errors.push({sheet: sh.name, cell: a1(e.rows[i], e.cols[i]), error: v.text, formula: e.cells[i].f !== undefined ? `=${e.cells[i].f}` : null});
      }
    }
  });
  const circular = eng.circularCells().map(c => `${quoteSheet(content.sheets[c.sheet]?.name ?? '')}!${a1(c.row, c.col)}`);
  return {errors, circular};
}

/** formulas.rs `evaluate_formula`: each call, operation and reference (innermost first) with its value. */
export function evaluationSteps(content, si, at, text) {
  let expr;
  try { expr = parseName(text); } catch (e) { throw failed(String(e?.message ?? e)); }
  const eng = engineFor(content);
  const nodes = [];
  walk(expr, e => { if (e.t === 'call' || e.t === 'binary' || e.t === 'ref') nodes.push(e); });
  const steps = [];
  for (const e of nodes.reverse().slice(0, 200)) {
    const t = print(e);
    steps.push({expression: t, value: valueJson(eng.evaluate(si, at, t))});
  }
  return {formula: `=${text}`, steps, result: valueJson(eng.evaluate(si, at, cellText(expr)))};
}

function evaluateFormula(ctx, p) {
  const content = ctx.doc;
  const si = activeSheet(ctx);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  let text;
  if (typeof p.formula === 'string') text = p.formula.replace(/^=/, '');
  else {
    const c = cellAt(content.sheets[si], at.row, at.col);
    if (c?.f === undefined) throw failed('The cell has no formula.');
    text = c.f;
  }
  return {cell: `${quoteSheet(content.sheets[si].name)}!${absCell(at)}`, ...evaluationSteps(content, si, at, text)};
}

function evaluate(ctx, p) {
  if (typeof p.formula !== 'string') throw bad('formulas.evaluate', 'missing `formula`');
  const si = activeSheet(ctx);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const body = p.formula.startsWith('=') ? p.formula.slice(1) : p.formula;
  const expr = parseTypedFormula(body);
  checkArgCounts(expr);
  return valueJson(engineFor(ctx.doc).evaluate(si, at, print(expr)));
}

function calculateNow(ctx) {
  const eng = engineFor(ctx.doc);
  eng.recalcAll();
  // The values live in the engine, not the document: the surface repaints on this view change.
  ctx.setView({calcVersion: (ctx.view?.calcVersion ?? 0) + 1});
  return {cells: eng.formulas.size};
}

const MODES = {automatic: 'auto', automaticExceptTables: 'autoNoTables', manual: 'manual'};
const MODE_NAMES = {auto: 'Automatic', autoNoTables: 'AutomaticExceptTables', manual: 'Manual'};
export const calcSettings = content => ({
  mode: MODE_NAMES[content.calc?.mode ?? 'auto'] ?? 'Automatic',
  iterative: content.calc?.iterative === true,
  maxIterations: content.calc?.maxIterations ?? 100,
  maxChange: content.calc?.maxChange ?? 0.001,
});

function calculationOptions(ctx, p) {
  const before = {...(ctx.doc.calc ?? {})};
  const next = {...before};
  if (typeof p.mode === 'string' && MODES[p.mode]) next.mode = MODES[p.mode];
  if (typeof p.iterative === 'boolean') next.iterative = p.iterative;
  if (Number.isFinite(p.maxIterations)) next.maxIterations = Math.min(32767, Math.max(1, Math.trunc(p.maxIterations)));
  if (Number.isFinite(p.maxChange)) next.maxChange = Math.abs(p.maxChange);
  if (next.mode === 'auto') delete next.mode;
  if (JSON.stringify(next) !== JSON.stringify(before)) {
    if (Object.keys(next).length) ctx.change.set(['calc'], next);
    else ctx.change.delete(['calc']);
  }
  return calcSettings({calc: next});
}

const modeState = (ctx, p) => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  const cur = calcSettings(ctx.doc);
  return {enabled: true, value: cur.mode, ...(typeof p?.mode === 'string' ? {checked: MODES[p.mode] === (ctx.doc.calc?.mode ?? 'auto')} : {})};
};

const read = extra => ({risk: 'read', undo: 'none', ...extra});
const noUndoView = extra => ({risk: 'read', undo: 'none', effect: 'view', repeatable: false, ...extra});

export default defineCommands({
  family: 'formulas',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'formulas.autoSum', label: 'AutoSum', risk: 'edit', shortcut: ['Alt+=', 'Mod+Shift+T'],
      description: 'AutoSum: a total of the numbers above (or to the left of) the active cell, or totals below and beside a selected block.',
      params: s.object({
        function: s.optional(s.enum(['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'sum', 'average', 'count', 'max', 'min'])),
        range: RANGE,
        enter: s.optional(s.boolean({description: 'false: start editing the guessed formula instead of entering it'})),
      }),
      state: hasDoc,
      run: autoSum,
    },
    {
      id: 'formulas.insertFunction', label: 'Insert Function…', risk: 'edit', shortcut: 'Shift+F3', dialog: 'dialog.insertFunction',
      description: 'Insert Function: with a name, starts =NAME( in the active cell (with args, enters =NAME(args) as Function Arguments › OK does); without, the UI opens the dialog.',
      params: s.object({
        name: s.optional(s.string({min: 1, max: 255})),
        args: s.optional(s.array(s.string({max: 8192}), {max: 255, description: 'Function Arguments: one text per argument; enters the formula'})),
        next: s.optional(s.enum(['arguments'], {description: 'Insert Function › OK: Function Arguments opens next'})),
      }),
      state: hasDoc,
      run: insertFunction,
    },
    read({
      id: 'formulas.functions', label: 'List Functions',
      description: 'The worksheet functions: [{name, category, signature, description}], by category and/or a search of names and descriptions.',
      params: s.object({category: s.optional(s.string({max: 100})), search: s.optional(s.string({max: 255}))}),
      run: listFunctions,
    }),
    {
      id: 'formulas.defineName', label: 'Define Name…', risk: 'edit', dialog: 'dialog.defineName',
      description: 'Define (or, with oldName, edit) a name: refersTo defaults to the selection; scope is Workbook or a sheet name.',
      params: s.object({
        name: s.optional(s.string({min: 1, max: 255})), refersTo: s.optional(s.string({min: 1, max: 8192})), scope: SCOPE,
        comment: s.optional(s.string({max: 255})), oldName: s.optional(s.string({min: 1, max: 255})), oldScope: SCOPE,
        force: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: defineName,
    },
    {
      id: 'formulas.deleteName', label: 'Delete Name', risk: 'edit',
      description: 'Delete a defined name (in one scope, or every scope it has).',
      params: s.object({name: s.string({min: 1, max: 255}), scope: SCOPE, force: s.optional(s.boolean())}),
      state: hasDoc,
      run: deleteName,
    },
    read({
      id: 'formulas.nameManager', label: 'Name Manager', shortcut: 'Mod+F3', dialog: 'dialog.nameManager',
      description: 'Name Manager: the defined names with value, refers-to, scope and comment.',
      params: s.object({}),
      state: hasDoc,
      run: ctx => nameManagerList(ctx.doc),
    }),
    {
      id: 'formulas.createFromSelection', label: 'Create from Selection', risk: 'edit', shortcut: 'Mod+Shift+F3', dialog: 'dialog.createNames',
      description: 'Create names from the labels in the top row, left column, bottom row and/or right column of a range.',
      params: s.object({
        range: RANGE, top: s.optional(s.boolean()), left: s.optional(s.boolean()), bottom: s.optional(s.boolean()), right: s.optional(s.boolean()),
        replace: s.optional(s.boolean()), force: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: createFromSelection,
    },
    {
      id: 'formulas.pasteName', label: 'Paste Names…', risk: 'edit', shortcut: 'F3', dialog: 'dialog.pasteName',
      description: 'Paste Names: the names to paste; name puts one at the caret (or starts =name); list writes every name and what it refers to.',
      params: s.object({name: s.optional(s.string({min: 1, max: 255})), list: s.optional(s.boolean()), at: CELL}),
      state: hasDoc,
      run: pasteName,
    },
    noUndoView({
      id: 'formulas.tracePrecedents', label: 'Trace Precedents',
      description: 'The ranges the active cell\'s formula reads; the sheet shows arrows from them.',
      params: s.object({cell: CELL, errors: s.optional(s.boolean())}),
      state: hasDoc,
      run: tracePrecedents,
    }),
    noUndoView({
      id: 'formulas.traceDependents', label: 'Trace Dependents',
      description: 'The formulas that read the active cell; the sheet shows arrows to them.',
      params: s.object({cell: CELL}),
      state: hasDoc,
      run: traceDependents,
    }),
    noUndoView({
      id: 'formulas.selectPrecedents', label: 'Select Precedents', shortcut: 'Mod+[',
      description: 'Select the cells the active cell\'s formula reads (all: every level).',
      params: s.object({cell: CELL, all: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => selectTraceCells(ctx, p, true),
    }),
    noUndoView({
      id: 'formulas.selectDependents', label: 'Select Dependents', shortcut: 'Mod+]',
      description: 'Select the formulas that read the active cell (all: every level).',
      params: s.object({cell: CELL, all: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => selectTraceCells(ctx, p, false),
    }),
    noUndoView({
      id: 'formulas.removeArrows', label: 'Remove Arrows',
      description: 'Remove the trace arrows (kind: only the precedent or dependent ones).',
      params: s.object({kind: s.optional(s.enum(['precedents', 'dependents']))}),
      state: hasDoc,
      run: removeArrows,
    }),
    {
      id: 'formulas.showFormulas', label: 'Show Formulas', risk: 'edit', shortcut: 'Mod+`',
      description: 'Show each cell\'s formula instead of its result on the active sheet.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => ({...hasDoc(ctx), checked: ctx.doc?.sheets?.[activeSheetSafe(ctx)]?.showFormulas === true}),
      run: showFormulas,
    },
    {
      id: 'formulas.convertToNumber', label: 'Convert to Number', risk: 'edit',
      description: 'Each number stored as text in the range (default: the selection) becomes that number, keeping the cell\'s format.',
      params: s.object({range: RANGE, sheet: SHEET}),
      state: hasDoc,
      run: convertToNumber,
    },
    read({
      id: 'formulas.errorChecking', label: 'Error Checking', dialog: 'dialog.errorChecking',
      description: 'Every cell that shows an error ({sheet, cell, error, formula}) and the circular references.',
      params: s.object({}),
      state: hasDoc,
      run: ctx => errorCells(ctx.doc),
    }),
    read({
      id: 'formulas.evaluateFormula', label: 'Evaluate Formula', dialog: 'dialog.evaluateFormula',
      description: 'The steps of a formula\'s calculation (each call, operation and reference, innermost first) and its result.',
      params: s.object({cell: CELL, formula: s.optional(s.string({min: 1, max: 8192}))}),
      state: hasDoc,
      run: evaluateFormula,
    }),
    read({
      id: 'formulas.evaluate', label: 'Evaluate',
      description: 'The value typing the formula into a cell would show, without changing the sheet; a formula a cell would refuse is an error.',
      params: s.object({formula: s.string({min: 1, max: 8192}), cell: CELL}),
      state: hasDoc,
      run: evaluate,
    }),
    noUndoView({
      id: 'formulas.calculateNow', label: 'Calculate Now', shortcut: 'F9',
      description: 'Recalculate every formula in the workbook.',
      params: s.object({}),
      state: hasDoc,
      run: calculateNow,
    }),
    noUndoView({
      id: 'formulas.calculateSheet', label: 'Calculate Sheet', shortcut: 'Shift+F9',
      description: 'Recalculate the formulas (the whole workbook is recalculated).',
      params: s.object({}),
      state: hasDoc,
      run: calculateNow,
    }),
    {
      id: 'formulas.calculationOptions', label: 'Calculation Options', risk: 'edit',
      description: 'Automatic, Automatic Except for Data Tables or Manual calculation, and iterative calculation; stored in the workbook.',
      params: s.object({
        mode: s.optional(s.enum(['automatic', 'automaticExceptTables', 'manual'])),
        iterative: s.optional(s.boolean()),
        maxIterations: s.optional(s.integer({min: 1, max: 32767})),
        maxChange: s.optional(s.number()),
      }),
      state: modeState,
      run: calculationOptions,
    },
  ],
});

function activeSheetSafe(ctx) {
  try { return activeSheet(ctx); } catch { return 0; }
}
