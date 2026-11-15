// Formulas tab: Use in Formula, Apply Names, the Watch Window and the Circular References list of Error Checking.
// Translated from gridcraft crates/engine/src/cmd/extra/cells.rs (`use_in_formula`: asks the editor to insert the name at the caret, as
// Paste Names does), crates/engine/src/cmd/extra/window.rs (`watch_window`: the watched cells with their value and formula, add and remove) and
// crates/engine/src/cmd/formulas.rs (`error_checking`'s circular list) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Apply Names is not in gridcraft: Excel's own behaviour, not checked against upstream. It rewrites the formulas of the selection (of the sheet
// when one cell is selected): a reference that is what a chosen name refers to becomes the name; with "Use row and column names" a cell that is
// the crossing of a chosen column name and a chosen row name becomes their intersection (`Q1 Sales`), leaving out the column or the row name when
// the formula is in that column or row and Excel's "Omit" options say so. The watch list is kept in each sheet (sheet.watches) and saved with the file as cellWatches.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, targetSheet, targetRanges, requireSchema2, setGridSelection, selectionAt} from '../../lib/edit-targets.mjs';
import {bad, failed, baseDoc} from '../../lib/data-common.mjs';
import {a1, parseCell, quoteSheet} from '../../lib/addr.mjs';
import {parse, parseName, print, mapExpr, refRange, sameName} from '../../lib/formula.mjs';
import {pasteableNames} from '../../lib/formulas-names.mjs';
import {nameBody} from '../../lib/formulas-names.mjs';
import {cellAt, forEachCell, writeCell} from '../../model/store.mjs';
import {engineFor} from '../../model/calc.mjs';
import {displayAt} from '../../model/index.mjs';
import {sheetIndex} from '../../model/sheet.mjs';
import {lockedCellError} from '../edit/cell.mjs';
import {valueJson} from '../../lib/formulas-names.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/extra/cells.rs', 'crates/engine/src/cmd/extra/window.rs', 'crates/engine/src/cmd/formulas.rs']};
const FLAG = s.optional(s.boolean());
const MAX_WATCHES = 500;
let seq = 0;

// ---------------------------------------------------------------- Use in Formula

/** The names Use in Formula lists (the ones Paste Names lists). */
const pasteable = ctx => pasteableNames(baseDoc(ctx), gridSel(ctx).sheet).map(([name, refersTo]) => ({id: name, label: name, value: name, refersTo}));

function useInFormula(ctx, p) {
  const name = String(p.name ?? '').trim();
  if (!name) throw bad('formulas.useInFormula', 'missing `name`', {path: '/name'});
  const hit = pasteableNames(baseDoc(ctx), gridSel(ctx).sheet).find(([n]) => sameName(n, name));
  if (!hit) throw failed(`There's no name "${name}" to paste.`);
  ctx.setView({insertNameRequest: {seq: ++seq + (ctx.view?.insertNameRequest?.seq ?? 0), name: hit[0]}});
  return {name: hit[0]};
}

// ---------------------------------------------------------------- Apply Names

/** What a chosen name refers to when that is one reference: {sheet (index), rect, abs flags} or null. */
function nameTarget(content, n, defaultSheet) {
  let e;
  try { e = parseName(nameBody(n)); } catch { return null; }
  if (e.t !== 'ref' || e.sheet.k === 'span') return null;
  const si = e.sheet.k === 'named' ? sheetIndex(content, e.sheet.name) : n.scope ? Math.max(0, content.sheets.findIndex(x => x.id === n.scope)) : defaultSheet;
  if (si < 0) return null;
  const a = e.kind.a ?? {}, b = e.kind.b ?? e.kind.a ?? {};
  return {sheet: si, rect: refRange(e), abs: {a: [!!a.rowAbs, !!a.colAbs], b: [!!b.rowAbs, !!b.colAbs], k: e.kind.k}};
}
const sameRect = (x, y) => x.start.row === y.start.row && x.start.col === y.start.col && x.end.row === y.end.row && x.end.col === y.end.col;
const holds = (r, row, col) => row >= r.start.row && row <= r.end.row && col >= r.start.col && col <= r.end.col;
const flagsOf = e => {
  const a = e.kind.a ?? {}, b = e.kind.b ?? e.kind.a ?? {};
  return {a: [!!a.rowAbs, !!a.colAbs], b: [!!b.rowAbs, !!b.colAbs], k: e.kind.k};
};
const sameFlags = (x, y) => x.k === y.k && x.a.join() === y.a.join() && x.b.join() === y.b.join();

/** The formula with the references that match the chosen names replaced by the names; {text, replaced} or null when nothing changed. */
function applyToFormula(content, si, host, text, targets, o) {
  let expr;
  try { expr = parse(text); } catch { return null; }
  let replaced = 0;
  const colNames = targets.filter(t => t.rect.start.col === t.rect.end.col && t.rect.end.row > t.rect.start.row);
  const rowNames = targets.filter(t => t.rect.start.row === t.rect.end.row && t.rect.end.col > t.rect.start.col);
  const out = mapExpr(expr, x => {
    if (x.t !== 'ref' || x.sheet.k === 'span' || x.kind.k === 'rows' || x.kind.k === 'cols') return x;
    const ref = {sheet: x.sheet.k === 'named' ? sheetIndex(content, x.sheet.name) : si, rect: refRange(x)};
    const direct = targets.find(t => t.sheet === ref.sheet && sameRect(t.rect, ref.rect) && (o.ignoreRelAbs || sameFlags(t.abs, flagsOf(x))));
    if (direct) { replaced += 1; return {t: 'name', v: direct.name}; }
    if (!o.useRowColumn || x.kind.k !== 'cell') return x;
    const {row, col} = ref.rect.start;
    const colName = colNames.find(t => t.sheet === ref.sheet && t.rect.start.col === col && holds(t.rect, row, col));
    const rowName = rowNames.find(t => t.sheet === ref.sheet && t.rect.start.row === row && holds(t.rect, row, col));
    if (!colName || !rowName) return x;
    replaced += 1;
    // Omit the column name when the formula is in that column, the row name when it is in that row (Excel's Options).
    if (o.omitColumn && host.col === col && host.sheet === ref.sheet) return {t: 'name', v: rowName.name};
    if (o.omitRow && host.row === row && host.sheet === ref.sheet) return {t: 'name', v: colName.name};
    const [first, second] = o.nameOrder === 'columnRow' ? [colName, rowName] : [rowName, colName];
    return {t: 'binary', op: ' ', a: {t: 'name', v: first.name}, b: {t: 'name', v: second.name}};
  });
  return replaced ? {text: print(out), replaced} : null;
}

/** Apply Names: `names` (the defined names to apply), ignoreRelAbs (default true), useRowColumn (default true), omitColumn, omitRow, nameOrder (rowColumn|columnRow). */
function applyNames(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : sel.sheet;
  requireSchema2(ctx, si);
  const wanted = Array.isArray(p.names) ? p.names.map(String) : [];
  if (!wanted.length) throw failed('Select the names to apply.');
  const usable = pasteableNames(content, si).map(([n]) => n);
  const chosen = wanted.map(n => usable.find(u => sameName(u, n)) ?? (() => { throw failed(`There's no name "${n}" to apply.`); })());
  const targets = chosen.map(name => {
    const def = (content.names ?? []).find(n => sameName(n.name, name) && n.scope === content.sheets[si].id) ?? (content.names ?? []).find(n => sameName(n.name, name) && !n.scope);
    const t = def ? nameTarget(content, def, si) : null;
    return t ? {...t, name} : null;
  }).filter(Boolean);
  if (!targets.length) throw failed('None of those names refers to a cell or a range, so there is nothing to apply.');
  const o = {ignoreRelAbs: p.ignoreRelAbs !== false, useRowColumn: p.useRowColumn !== false, omitColumn: p.omitColumn !== false, omitRow: p.omitRow !== false, nameOrder: p.nameOrder === 'columnRow' ? 'columnRow' : 'rowColumn'};
  const sheet = content.sheets[si];
  const single = sel.sheet === si && sel.ranges.length === 1 && sel.ranges[0].start.row === sel.ranges[0].end.row && sel.ranges[0].start.col === sel.ranges[0].end.col;
  const areas = typeof p.range === 'string' && p.range.trim() ? targetRanges(ctx, {...p, sheet: si}, ['range']).areas
    : sel.sheet === si && !single ? sel.ranges : [{start: {row: 0, col: 0}, end: {row: 1_048_575, col: 16_383}}];
  let cells = 0, references = 0;
  for (const a of areas) {
    forEachCell(sheet, a.start.row, a.start.col, a.end.row, a.end.col, (row, col, cell) => {
      if (!cell || typeof cell.f !== 'string') return;
      const r = applyToFormula(content, si, {row, col, sheet: si}, cell.f, targets, o);
      if (!r || lockedCellError(ctx, si, row, col)) return;
      writeCell(ctx.change, ctx.doc, si, row, col, {...cell, f: r.text});
      cells += 1; references += r.replaced;
    });
  }
  if (!cells) throw failed("Excel didn't find any references to replace with the names you chose.");
  return {cells, references};
}

// ---------------------------------------------------------------- Watch Window

const toKey = (content, si, row, col) => `${quoteSheet(content.sheets[si].name)}!${a1(row, col)}`;
/** The watched cells with what they hold: [{cell, sheet, name, address, value, formula}]. */
/** The watched cells of the workbook, sheet by sheet: ["Sheet1!B2"]. Excel keeps them in each sheet (cellWatches), so they are saved with the file. */
export const watchKeys = content => content.sheets.flatMap((sh, si) => (sh.watches ?? []).map(r => `${quoteSheet(sh.name)}!${r}`));
/** Stores a watch list back on the sheets as plain references. */
function storeWatches(ctx, list) {
  const content = baseDoc(ctx);
  const by = new Map();
  for (const key of list) {
    const bang = key.lastIndexOf('!');
    const si = sheetIndex(content, key.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"));
    if (si < 0) continue;
    if (!by.has(si)) by.set(si, []);
    by.get(si).push(key.slice(bang + 1));
  }
  content.sheets.forEach((sh, si) => {
    const next = by.get(si) ?? [];
    if (next.join() === (sh.watches ?? []).join()) return;
    requireSchema2(ctx, si);
    if (next.length) ctx.change.set(['sheets', si, 'watches'], next); else ctx.change.delete(['sheets', si, 'watches']);
  });
}
function watchRows(ctx, watches = watchKeys(baseDoc(ctx))) {
  const content = baseDoc(ctx);
  const eng = engineFor(content);
  return watches.map(w => {
    const bang = w.lastIndexOf('!');
    const sheetName = bang < 0 ? null : w.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    const si = sheetName === null ? gridSel(ctx).sheet : sheetIndex(content, sheetName);
    const c = parseCell((bang < 0 ? w : w.slice(bang + 1)).replace(/\$/g, ''));
    const sh = si >= 0 ? content.sheets[si] : null;
    if (!sh || !c) return {cell: w, sheet: sheetName ?? '', name: '', address: w, value: '#REF!', formula: ''};
    const cell = cellAt(sh, c.row, c.col);
    const nm = (content.names ?? []).find(n => { try { const t = nameTarget(content, n, si); return t && t.sheet === si && t.rect.start.row === c.row && t.rect.start.col === c.col && t.rect.end.row === c.row && t.rect.end.col === c.col; } catch { return false; } });
    return {cell: w, sheet: sh.name, name: nm?.name ?? '', address: a1(c.row, c.col), value: displayAt(content, si, c.row, c.col).text, raw: valueJson(eng.sheetValue(si, c.row, c.col)), formula: typeof cell?.f === 'string' ? `=${cell.f}` : ''};
  });
}

/** Watch Window: `on` shows or hides the window (default: toggle, unless adding or removing); `add` (a cell or range) and `remove` change the list. */
function watchWindow(ctx, p) {
  const content = baseDoc(ctx);
  let list = watchKeys(content);
  let changed = false;
  if (typeof p.add === 'string' && p.add.trim()) {
    const t = targetRanges(ctx, {range: p.add.trim()}, ['range']);
    const added = [];
    for (const area of t.areas) for (let row = area.start.row; row <= area.end.row; row++) for (let col = area.start.col; col <= area.end.col; col++) {
      if (added.length + list.length > MAX_WATCHES) throw failed(`The Watch Window holds at most ${MAX_WATCHES} cells.`);
      const key = toKey(content, t.sheet, row, col);
      if (!list.includes(key) && !added.includes(key)) added.push(key);
    }
    list = [...list, ...added];
    changed = true;
  }
  if (typeof p.remove === 'string' && p.remove) {
    const before = list.length;
    list = list.filter(x => x !== p.remove && x.replace(/^.*!/, '') !== p.remove);
    if (list.length === before) throw failed(`${p.remove} isn't being watched.`);
    changed = true;
  }
  const open = typeof p.on === 'boolean' ? p.on : changed ? true : !ctx.view?.watchPane;
  if (changed) storeWatches(ctx, list);
  ctx.setView({watchPane: open || (changed && ctx.view?.watchPane === true)});
  return {on: open, watches: watchRows(ctx, list)};
}

// ---------------------------------------------------------------- Circular References

// ---------------------------------------------------------------- Ignore Error

/** Error Checking > Ignore Error: the error in `cell` (default the active cell) is not reported again; Excel keeps it in the sheet's ignoredErrors. */
function ignoreError(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  let si = sel.sheet, at = sel.active;
  if (typeof p.cell === 'string' && p.cell.trim()) {
    const t = p.cell.trim(), bang = t.lastIndexOf('!');
    if (bang >= 0) si = sheetIndex(content, t.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"));
    at = parseCell((bang >= 0 ? t.slice(bang + 1) : t).replace(/\$/g, ''));
    if (si < 0 || !at) throw bad('formulas.ignoreError', `not a cell: ${t}`, {path: '/cell'});
  }
  requireSchema2(ctx, si);
  const ref = a1(at.row, at.col);
  const cur = content.sheets[si].ignoredErrors ?? [];
  if (!cur.includes(ref)) ctx.change.set(['sheets', si, 'ignoredErrors'], [...cur, ref]);
  return {cell: ref};
}
/** Error Checking > Options > Reset Ignored Errors: every ignored error is reported again. */
function resetIgnoredErrors(ctx) {
  let n = 0;
  baseDoc(ctx).sheets.forEach((sh, si) => { if ((sh.ignoredErrors ?? []).length) { n += sh.ignoredErrors.length; requireSchema2(ctx, si); ctx.change.delete(['sheets', si, 'ignoredErrors']); } });
  return {reset: n};
}

const circularList = ctx => {
  const content = baseDoc(ctx);
  const eng = engineFor(content);
  return eng.circularCells().slice(0, 100).map(c => `${quoteSheet(content.sheets[c.sheet]?.name ?? '')}!${a1(c.row, c.col)}`);
};

function goCircular(ctx, p) {
  const cell = String(p.cell ?? '').trim();
  const list = circularList(ctx);
  const target = cell || list[0];
  if (!target) throw failed('There are no circular references in this workbook.');
  const content = baseDoc(ctx);
  const bang = target.lastIndexOf('!');
  const si = bang < 0 ? gridSel(ctx).sheet : sheetIndex(content, target.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"));
  const c = parseCell((bang < 0 ? target : target.slice(bang + 1)).replace(/\$/g, ''));
  if (si < 0 || !c) throw bad('formulas.circularReference', `not a cell: \`${target}\``, {path: '/cell'});
  setGridSelection(ctx, selectionAt(si, c));
  return {cell: target};
}

export default defineCommands({
  family: 'formulas/extra',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'formulas.useInFormula', label: 'Use in Formula', risk: 'read', effect: 'view',
      description: 'Use in Formula: {name} is put at the caret of the formula being typed (the cell or the formula bar), as Paste Names does. The state lists the names Paste Names lists.',
      params: s.object({name: s.string({min: 1, max: 255})}),
      state: ctx => { const st = hasDoc(ctx); if (!st.enabled) return st; const list = pasteable(ctx); return list.length ? {enabled: true, value: list} : {enabled: false, reason: 'this workbook has no names'}; },
      run: useInFormula},
    {id: 'formulas.applyNames', label: 'Apply Names', risk: 'edit', dialog: 'dialog.applyNames',
      description: 'Apply Names (Formulas > Define Name): `names` (defined names) replace the references that are what they refer to, in the formulas of `range` (default the selection; one cell means the sheet). ignoreRelAbs (default true) matches $A$1 with A1; useRowColumn (default true) writes the crossing of a column name and a row name as their intersection; omitColumn and omitRow (default true) leave out the column name in that column and the row name in that row; nameOrder rowColumn (default) or columnRow. -> {cells, references}.',
      params: s.object({sheet: s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})])), range: s.optional(s.string({max: 4096})), names: s.array(s.string({min: 1, max: 255}), {max: 4096}),
        ignoreRelAbs: FLAG, useRowColumn: FLAG, omitColumn: FLAG, omitRow: FLAG, nameOrder: s.optional(s.enum(['rowColumn', 'columnRow']))}),
      state: hasDoc, run: applyNames},
    {id: 'formulas.watchWindow', label: 'Watch Window', risk: 'edit',
      description: 'Watch Window (Formulas > Formula Auditing): {on?, add?: "Sheet1!B5" (a cell or range), remove?: "Sheet1!B5"} -> {on, watches: [{cell, sheet, name, address, value, formula}]}. Shows or hides the window (default: toggle); Add and Delete change what it watches.',
      params: s.object({on: FLAG, add: s.optional(s.string({max: 4096})), remove: s.optional(s.string({max: 400}))}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.watchPane} : hasDoc(ctx)), run: watchWindow},
    {id: 'formulas.watchList', label: 'Watched Cells', risk: 'read', effect: 'view', description: 'Query: the cells in the Watch Window with their book, sheet, name, cell, value and formula.',
      params: s.object({}), state: hasDoc, run: ctx => ({watches: watchRows(ctx)})},
    {id: 'formulas.ignoreError', label: 'Ignore Error', risk: 'edit',
      description: 'Ignore Error (Formulas > Error Checking): the error in `cell` (default the active cell) is not reported by Error Checking again. Kept in the file as ignoredErrors.',
      params: s.object({cell: s.optional(s.string({max: 400}))}), state: hasDoc, run: ignoreError},
    {id: 'formulas.resetIgnoredErrors', label: 'Reset Ignored Errors', risk: 'edit', description: 'Error Checking Options > Reset Ignored Errors: every ignored error is reported again. -> {reset}.',
      params: s.object({}), state: ctx => (hasDoc(ctx).enabled ? (ctx.doc.sheets.some(sh => (sh.ignoredErrors ?? []).length) ? {enabled: true} : {enabled: false, reason: 'no errors are ignored'}) : hasDoc(ctx)), run: resetIgnoredErrors},
    {id: 'formulas.circularReference', label: 'Circular References', risk: 'read', effect: 'view',
      description: 'Circular References (Formulas > Error Checking): selects the circular reference {cell: "Sheet1!A1"} (default the first). The state lists up to 100 of them.',
      params: s.object({cell: s.optional(s.string({max: 400}))}),
      state: ctx => { const st = hasDoc(ctx); if (!st.enabled) return st; const list = circularList(ctx); return list.length ? {enabled: true, value: list.map(c => ({id: c, label: c, value: c}))} : {enabled: false, reason: 'there are no circular references'}; },
      run: goCircular},
  ],
});

export {applyToFormula, nameTarget, watchRows, circularList};
