// Go To… (Ctrl+G, F5) and Go To Special… for Grid.
// Translated from gridcraft crates/engine/src/cmd/edit/go_to.rs (`go_to`, `go_to_special`) and
// crates/engine/src/cmd/edit.rs (`coalesce`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Go To Special adds Excel's kinds upstream leaves out: Current array, Row differences, Column
// differences, Precedents and Dependents (direct only or all levels), the Numbers / Text /
// Logicals / Errors filter under Constants and Formulas, and Data validation's All / Same.
// (Objects is not here: the grid selection holds cells, not drawing objects.)

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {rangeA1, quoteSheet, count, isSingle, contains, intersects, intersection, parseRange, rangeCell, a1} from '../../lib/addr.mjs';
import {parse, references, refRange} from '../../lib/formula.mjs';
import {CellError, sameValue} from '../../lib/value.mjs';
import {cellAt, forEachCell, usedBounds} from '../../model/store.mjs';
import {isRowHidden, isColHidden, sheetIndex} from '../../model/sheet.mjs';
import {selectionBounds, isSingleCell, currentRegion} from '../../model/workbook.mjs';
import {engineFor} from '../../model/calc.mjs';
import {referenceParts, goToTarget, goToNames, GO_TO_RECENT, GO_TO_MAX_AREAS} from '../../lib/edit-goto.mjs';
import {ruleAt} from '../../lib/edit-parts.mjs';
import {hasDoc, gridSel, bad, failed, setGridSelection, splitRef, parseAreas} from '../../lib/edit-targets.mjs';
import {selectionSet, filledAt} from './selection.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/edit/go_to.rs']};

const INVALID = "Reference isn't valid.";

/** edit.rs `coalesce`: cells merged into vertical runs per column (a compact multi-area selection). */
export function coalesce(cells) {
  const sorted = [...cells].sort((a, b) => a.col - b.col || a.row - b.row);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && last.start.col === c.col && last.end.col === c.col && last.end.row + 1 === c.row) { last.end.row = c.row; continue; }
    out.push(rangeCell(c));
  }
  if (out.length > 2000) out.length = 2000;
  return out;
}

function goTo(ctx, p) {
  const content = ctx.doc;
  const sel = gridSel(ctx);
  if (p.list === true) return {names: goToNames(content, sel.sheet), recent: ctx.view?.goToRecent ?? []};
  const reference = typeof p.reference === 'string' ? p.reference : typeof p.range === 'string' ? p.range : null;
  if (reference === null) throw bad('edit.goTo', 'missing `reference`');
  let target = null, named = false;
  const areas = [];
  // Section 14.3 canonical forms from the bridge: /sh:<id>/A1:B2,D4, /sh:<id>/cols:B-D, /name:<n>, /tbl:<n>.
  const canon = /^\/(name|tbl):(.+)$/.exec(reference.trim());
  if (canon) return goTo(ctx, {...p, reference: decodeURIComponent(canon[2]), range: undefined});
  if (/^\/sh:/.test(reference.trim())) {
    const split = splitRef(content, reference);
    const list = split.body ? parseAreas(split.body) : [{start: {row: 0, col: 0}, end: {row: 0, col: 0}}];
    if (!list) throw failed(INVALID);
    const out = selectionSet(ctx, {sheet: split.sheet, range: list.map(rangeA1).join(',')});
    if (p.record === true) {
      const entry = list.map(r => `${quoteSheet(content.sheets[split.sheet].name)}!${rangeA1(r)}`).join(',');
      ctx.setView({goToRecent: [entry, ...(ctx.view?.goToRecent ?? []).filter(r => r.toLowerCase() !== entry.toLowerCase())].slice(0, GO_TO_RECENT)});
    }
    return out;
  }
  for (const part of referenceParts(reference)) {
    const t = goToTarget(content, sel.sheet, part, 0);
    if (!t) throw failed(INVALID);
    // One selection holds the areas of one sheet.
    if (target !== null && target !== t.sheet) throw failed(INVALID);
    target = t.sheet;
    named ||= t.byName;
    areas.push(...t.areas);
    if (areas.length > GO_TO_MAX_AREAS) throw failed(`Go To selects at most ${GO_TO_MAX_AREAS} areas.`);
  }
  if (target === null) throw failed(INVALID);
  const out = selectionSet(ctx, {sheet: target, range: areas.map(rangeA1).join(',')});
  if (p.record === true && !named) {
    const prefix = quoteSheet(content.sheets[target].name);
    const entry = areas.map(r => `${prefix}!${rangeA1(r)}`).join(',');
    const recent = (ctx.view?.goToRecent ?? []).filter(r => r.toLowerCase() !== entry.toLowerCase());
    recent.unshift(entry);
    ctx.setView({goToRecent: recent.slice(0, GO_TO_RECENT)});
  }
  return out;
}

const valueKind = v => (v === null || v === undefined || v === '' ? 'blank' : typeof v === 'number' ? 'numbers' : typeof v === 'string' ? 'text'
  : typeof v === 'boolean' ? 'logicals' : v instanceof CellError ? 'errors' : 'other');

/** The cells formulas in `cells` refer to on sheet si (Excel's Precedents), one level or all. */
function precedents(content, si, start, all) {
  const sheet = content.sheets[si];
  const seen = new Set(), out = [];
  let frontier = start;
  for (let level = 0; frontier.length && level < 64; level++) {
    const next = [];
    for (const c of frontier) {
      const cell = cellAt(sheet, c.row, c.col);
      if (cell?.f === undefined) continue;
      let e;
      try { e = parse(cell.f); } catch { continue; }
      for (const ref of references(e)) {
        if (ref.sheet?.k !== 'cur' && !(ref.sheet?.k === 'named' && ref.sheet.name.toLowerCase() === sheet.name.toLowerCase())) continue;
        const r = refRange(ref);
        if (count(r) > 4_000_000) continue;
        for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) {
          const k = `${row},${col}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({row, col});
          next.push({row, col});
        }
      }
    }
    if (!all) break;
    frontier = next;
  }
  return out;
}

/** The cells whose formulas refer to `cells` on sheet si (Excel's Dependents), one level or all. */
function dependents(content, si, start, all) {
  const sheet = content.sheets[si];
  const formulas = [];
  forEachCell(sheet, 0, 0, 1_048_575, 16_383, (row, col, cell) => {
    if (cell.f === undefined) return;
    let e;
    try { e = parse(cell.f); } catch { return; }
    const rs = references(e).filter(ref => ref.sheet?.k === 'cur' || (ref.sheet?.k === 'named' && ref.sheet.name.toLowerCase() === sheet.name.toLowerCase())).map(refRange);
    if (rs.length) formulas.push({row, col, rs});
  });
  const seen = new Set(start.map(c => `${c.row},${c.col}`)), out = [];
  let frontier = start;
  for (let level = 0; frontier.length && level < 64; level++) {
    const next = [];
    for (const f of formulas) {
      const k = `${f.row},${f.col}`;
      if (seen.has(k)) continue;
      if (!frontier.some(c => f.rs.some(r => contains(r, c)))) continue;
      seen.add(k);
      out.push({row: f.row, col: f.col});
      next.push({row: f.row, col: f.col});
    }
    if (!all) break;
    frontier = next;
  }
  return out;
}

function goToSpecial(ctx, p) {
  const kind = p.kind ?? 'blanks';
  const content = ctx.doc;
  const sel = gridSel(ctx);
  const si = sel.sheet;
  const sheet = content.sheets[si];
  const eng = engineFor(content);
  const b = usedBounds(sheet);
  const used = b ? {start: {row: b.r0, col: b.c0}, end: {row: b.r1, col: b.c1}} : null;
  const scope = isSingleCell(sel) ? used ?? rangeCell(sel.active) : selectionBounds(sel);
  if (kind === 'lastCell') {
    const u = eng.usedRange(si) ?? used;
    const c = u ? u.end : {row: 0, col: 0};
    return selectionSet(ctx, {cell: a1(c.row, c.col)});
  }
  if (kind === 'currentRegion') {
    const r = currentRegion(filledAt(content, si), sel.active);
    setGridSelection(ctx, {sheet: si, active: {...sel.active}, anchor: {...r.start}, ranges: [r]});
    return {selection: rangeA1(r), count: count(r)};
  }
  if (kind === 'currentArray') {
    // Excel: the array (legacy or spilled) the active cell is in.
    const at = sel.active;
    const own = cellAt(sheet, at.row, at.col);
    let r = own?.a ? parseRange(own.a) : eng.spillRangeAt(si, at.row, at.col);
    if (!r) {
      const anchor = eng.spillAnchorOf(si, at.row, at.col);
      if (anchor) { const ac = cellAt(sheet, anchor.row, anchor.col); r = ac?.a ? parseRange(ac.a) : anchor.range; }
    }
    if (!r) throw failed('No cells were found.');
    setGridSelection(ctx, {sheet: si, active: {...at}, anchor: {...r.start}, ranges: [r]});
    return {selection: rangeA1(r), count: count(r)};
  }
  if (count(scope) > 4_000_000) throw bad('edit.goToSpecial', 'range too large');
  const types = Array.isArray(p.types) && p.types.length ? new Set(p.types) : null;
  let hits = [];
  if (kind === 'precedents' || kind === 'dependents') {
    const start = [];
    for (const r of sel.ranges) {
      if (count(r) > 4_000_000) throw bad('edit.goToSpecial', 'range too large');
      for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) start.push({row, col});
    }
    const all = p.levels === 'all';
    hits = kind === 'precedents' ? precedents(content, si, start, all) : dependents(content, si, start, all);
  } else if (kind === 'rowDifferences' || kind === 'columnDifferences') {
    // Excel: in each row (column) of the selection, the cells that differ from the one in the
    // active cell's column (row).
    const area = isSingleCell(sel) ? currentRegion(filledAt(content, si), sel.active) : selectionBounds(sel);
    const rows = kind === 'rowDifferences';
    const key = (row, col) => { const c = cellAt(sheet, row, col); return c?.f !== undefined ? `=${c.f}` : eng.sheetValue(si, row, col); };
    for (let row = area.start.row; row <= area.end.row; row++) for (let col = area.start.col; col <= area.end.col; col++) {
      const ref = rows ? {row, col: sel.active.col} : {row: sel.active.row, col};
      if (!sel.ranges.some(r => contains(r, {row, col})) && !isSingleCell(sel)) continue;
      const a = key(row, col), bb = key(ref.row, ref.col);
      if (!(a === bb || (typeof a !== 'string' && typeof bb !== 'string' && sameValue(a, bb)))) hits.push({row, col});
    }
  } else {
    let same = null;
    if (kind === 'dataValidation' && p.dvScope === 'same') same = ruleAt(sheet.validations, sel.active);
    for (let row = scope.start.row; row <= scope.end.row; row++) for (let col = scope.start.col; col <= scope.end.col; col++) {
      const c = {row, col};
      const cell = cellAt(sheet, row, col);
      const v = eng.sheetValue(si, row, col);
      let ok;
      switch (kind) {
        case 'blanks': ok = v === null || v === undefined || v === ''; break;
        case 'constants': ok = !!cell && cell.f === undefined && cell.v !== undefined && cell.v !== null && cell.v !== '' && (!types || types.has(valueKind(v))); break;
        case 'formulas': ok = cell?.f !== undefined && (!types || types.has(valueKind(v))); break;
        case 'comments': case 'notes': ok = !!(sheet.notes?.[a1(row, col)] ?? sheet.comments?.[a1(row, col)]); break;
        case 'errors': ok = v instanceof CellError; break;
        case 'numbers': ok = typeof v === 'number'; break;
        case 'text': ok = typeof v === 'string' && v !== ''; break;
        case 'visible': ok = !isRowHidden(sheet, row) && !isColHidden(sheet, col); break;
        case 'conditionalFormats': ok = !!ruleAt(sheet.conditionalFormats, c); break;
        case 'dataValidation': { const rule = ruleAt(sheet.validations, c); ok = same ? rule === same : !!rule; break; }
        default: throw bad('edit.goToSpecial', `unknown kind \`${kind}\``);
      }
      if (ok) hits.push(c);
    }
  }
  if (!hits.length) throw failed('No cells were found.');
  const ranges = coalesce(hits);
  const first = hits[0];
  setGridSelection(ctx, {sheet: si, active: {...first}, anchor: {...first}, ranges});
  return {selection: ranges.map(rangeA1).join(','), count: hits.length};
}

export const SPECIAL_KINDS = Object.freeze(['blanks', 'constants', 'formulas', 'comments', 'notes', 'lastCell', 'currentRegion', 'visible', 'conditionalFormats',
  'dataValidation', 'errors', 'numbers', 'text', 'currentArray', 'rowDifferences', 'columnDifferences', 'precedents', 'dependents']);

export default defineCommands({
  family: 'edit/go_to',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.goTo', label: 'Go To…', shortcut: ['Mod+G', 'F5'], risk: 'read', effect: 'view', undo: 'none', dialog: 'dialog.goTo', repeatable: false,
      description: 'Select a reference, defined name or table (several, comma-separated, on one sheet); record keeps it among the recent ones; list returns the dialog\'s names and recent references.',
      params: s.object({
        reference: s.optional(s.string({min: 1, max: 1_000_000})), range: s.optional(s.string({min: 1, max: 1_000_000})),
        record: s.optional(s.boolean()), list: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: goTo,
    },
    {
      id: 'edit.goToSpecial', label: 'Go To Special…', risk: 'read', effect: 'view', undo: 'none', dialog: 'dialog.goToSpecial', repeatable: false,
      description: 'Select the cells of a kind in the selection (or the used range): blanks, constants, formulas, notes, errors, numbers, text, visible, conditional formats, data validation, last cell, current region, current array, row/column differences, precedents, dependents.',
      params: s.object({
        kind: s.enum(SPECIAL_KINDS),
        types: s.optional(s.array(s.enum(['numbers', 'text', 'logicals', 'errors']), {max: 4})),
        levels: s.optional(s.enum(['direct', 'all'])),
        dvScope: s.optional(s.enum(['all', 'same'])),
      }),
      state: hasDoc,
      run: goToSpecial,
    },
  ],
});

export {sheetIndex, intersects, intersection, isSingle};
