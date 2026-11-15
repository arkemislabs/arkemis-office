// Selection commands: Select (and switch sheet), Move Selection (arrows, Shift extends, Ctrl
// jumps), Next Cell in Selection (Enter/Tab inside a selection), Select All, Select Current Region,
// Select Entire Row, Select Entire Column. View state: never undoable, never dirty.
// Translated from gridcraft crates/engine/src/cmd/edit/selection.rs (`cell_selectable`,
// `selection_set`, `wb_switch_sheet`, `selection_move`, `selection_next`, `select_all`,
// `select_region`, `select_row`, `select_col`) and crates/engine/src/selection.rs (`jump`,
// `current_region`, `Selection::cycle/extend_to/expand_merges/moving_end`, through the
// foundation's model/workbook.mjs) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The surface (src/apps/grid/surface/view.ts) runs the same helpers for its own gestures, so the
// bridge and the person get the same selections.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {MAX_ROWS, MAX_COLS, rangeA1, a1, offsetClamped, rangeEquals, isSingle, rowsRange, colsRange, allRange, contains} from '../../lib/addr.mjs';
import {currentArea, movingEnd, extendTo, expandMerges, cycle, jump, currentRegion, selectionAt, fromKernelSelection} from '../../model/workbook.mjs';
import {mergeAt, isRowHidden, isColHidden} from '../../model/sheet.mjs';
import {cellAt, hasContent} from '../../model/store.mjs';
import {styleAt} from '../../model/workbook.mjs';
import {engineFor} from '../../model/calc.mjs';
import {hasDoc, gridSel, targetSheet, splitRef, parseAreas, cellParamOn, bad, failed, setGridSelection, sheetPath} from '../../lib/edit-targets.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/edit/selection.rs', 'crates/engine/src/selection.rs']};

const NOT_SELECTABLE = 'The cell you are trying to change is on a protected sheet that does not allow selecting it.';

/** selection.rs `cell_selectable`: a protected sheet can forbid selecting locked and/or unlocked cells. */
export function cellSelectable(content, si, c) {
  const sheet = content.sheets[si];
  const p = sheet?.protection;
  if (!p || p.enabled === false) return true;
  const locked = styleAt(content, sheet, c.row, c.col).protection.locked;
  return locked ? p.selectLocked !== false : p.selectUnlocked !== false;
}

/** `A1:B2,D4` of a selection, and its active cell. */
export const selectionOut = sel => ({selection: sel.ranges.map(rangeA1).join(','), active: a1(sel.active.row, sel.active.col)});

/** A cell with content or a spilled value (Ctrl+A, Ctrl+arrows and the current region read these). */
export function filledAt(content, si) {
  const eng = engineFor(content);
  const sheet = content.sheets[si];
  return (row, col) => hasContent(cellAt(sheet, row, col)) || ((v => v !== null && v !== undefined && v !== '')(eng.sheetValue(si, row, col)));
}

/** wb_switch_sheet: remember the sheet's selection, then the other sheet's (A1 the first time). */
export function switchSheet(ctx, si) {
  const cur = gridSel(ctx);
  if (si === cur.sheet) return cur;
  const content = ctx.doc;
  const memory = {...(ctx.view?.sheetSelections ?? {})};
  memory[content.sheets[cur.sheet].id] = ctx.selection;
  ctx.setView({sheetSelections: memory});
  const kept = memory[content.sheets[si].id];
  const sel = kept ? fromKernelSelection(content, kept) : null;
  return sel && sel.sheet === si ? sel : selectionAt(si, {row: 0, col: 0});
}

/** selection.rs `selection_set`. */
export function selectionSet(ctx, p) {
  const content = ctx.doc;
  const refText = typeof p.range === 'string' && p.range ? p.range : typeof p.cell === 'string' && p.cell ? p.cell : null;
  let sheet = gridSel(ctx).sheet;
  let base = gridSel(ctx);
  if (p.sheet !== undefined || (refText && splitRef(content, refText).sheet !== null)) {
    sheet = targetSheet(ctx, p);
    base = switchSheet(ctx, sheet);
  }
  let ranges;
  if (refText) {
    ranges = parseAreas(splitRef(content, refText).body);
    if (!ranges) throw bad('range', `not a range: \`${refText}\``);
  } else ranges = base.ranges;
  const last = ranges[ranges.length - 1];
  const active = cellParamOn(ctx, p, 'active', sheet) ?? (refText ? {...last.start} : base.active);
  const corner = c => (c.row === last.start.row || c.row === last.end.row) && (c.col === last.start.col || c.col === last.end.col);
  // The kernel names an area by its anchor: an active cell at a corner is the anchor itself.
  const anchor = contains(last, active) && corner(active) ? {...active} : refText ? {...last.start} : base.anchor;
  let sel = {sheet, active, anchor, ranges};
  sel = expandMerges(sel, content.sheets[sheet]);
  if (!cellSelectable(content, sheet, sel.active)) throw failed(NOT_SELECTABLE);
  setGridSelection(ctx, sel);
  return {...selectionOut(sel), sheet: content.sheets[sheet].name, address: sheetPath(content, sheet)};
}

function selectionMove(ctx, p) {
  const dr = Math.trunc(p.dr ?? 0), dc = Math.trunc(p.dc ?? 0);
  const extend = !!p.extend, jmp = !!p.jump;
  const content = ctx.doc;
  const sel = gridSel(ctx);
  const si = sel.sheet;
  const sheet = content.sheets[si];
  // Extension moves the far corner, not the active cell.
  const from = extend ? movingEnd(sel) : sel.active;
  let to;
  if (jmp) {
    const eng = engineFor(content);
    const used = eng.usedRange(si);
    to = jump((r, c) => eng.sheetValue(si, r, c), used, from, Math.sign(dr), Math.sign(dc));
  } else {
    // Skip hidden rows/columns and step over merged areas.
    let t = offsetClamped(from, dr, dc);
    let guard = 0;
    while ((isRowHidden(sheet, t.row) || isColHidden(sheet, t.col)) && guard < 100_000) {
      const n = offsetClamped(t, Math.sign(dr), Math.sign(dc));
      if (n.row === t.row && n.col === t.col) break;
      t = n;
      guard++;
    }
    const m = !extend ? mergeAt(sheet, from.row, from.col) : null;
    if (m) {
      // Leaving a merged cell moves from its edge.
      if (dr > 0) t = {row: offsetClamped(m.end, dr, 0).row, col: from.col};
      else if (dc > 0) t = {row: from.row, col: offsetClamped(m.end, 0, dc).col};
    }
    to = t;
  }
  const mTo = mergeAt(sheet, to.row, to.col);
  if (mTo && !extend) to = {...mTo.start};
  if (!extend && !cellSelectable(content, si, to)) {
    // Step on to the next selectable cell in the same direction; stay put if there is none.
    const sr = Math.sign(dr), sc = Math.sign(dc);
    let t = to, found = false;
    if (!jmp && (sr || sc)) {
      for (let i = 0; i < 10_000; i++) {
        const n = offsetClamped(t, sr, sc);
        if (n.row === t.row && n.col === t.col) break;
        t = n;
        if (!isRowHidden(sheet, t.row) && !isColHidden(sheet, t.col) && cellSelectable(content, si, t)) { found = true; break; }
      }
    }
    if (!found) return selectionOut(sel);
    to = t;
  }
  let next;
  if (extend) next = expandMerges(extendTo(sel, to), sheet);
  else {
    next = selectionAt(si, to);
    const m = mergeAt(sheet, to.row, to.col);
    if (m) next.ranges = [m];
  }
  setGridSelection(ctx, next);
  return selectionOut(next);
}

function selectionNext(ctx, p) {
  const sel = gridSel(ctx);
  const next = cycle(sel, p.forward ?? true, p.byRow ?? false);
  setGridSelection(ctx, next);
  return {active: a1(next.active.row, next.active.col)};
}

function selectAll(ctx) {
  const sel = gridSel(ctx);
  const region = currentRegion(filledAt(ctx.doc, sel.sheet), sel.active);
  const r = isSingle(region) || rangeEquals(currentArea(sel), region) ? allRange() : region;
  const next = {sheet: sel.sheet, active: {...sel.active}, anchor: {...r.start}, ranges: [r]};
  setGridSelection(ctx, next);
  return {selection: rangeA1(r)};
}
function selectRegion(ctx) {
  const sel = gridSel(ctx);
  const r = currentRegion(filledAt(ctx.doc, sel.sheet), sel.active);
  setGridSelection(ctx, {sheet: sel.sheet, active: {...sel.active}, anchor: {...r.start}, ranges: [r]});
  return {selection: rangeA1(r)};
}
function selectRow(ctx) {
  const sel = gridSel(ctx);
  const r = currentArea(sel);
  const range = rowsRange(r.start.row, r.end.row);
  setGridSelection(ctx, {sheet: sel.sheet, active: {...sel.active}, anchor: {row: r.start.row, col: 0}, ranges: [range]});
  return {selection: rangeA1(range)};
}
function selectCol(ctx) {
  const sel = gridSel(ctx);
  const r = currentArea(sel);
  const range = colsRange(r.start.col, r.end.col);
  setGridSelection(ctx, {sheet: sel.sheet, active: {...sel.active}, anchor: {row: 0, col: r.start.col}, ranges: [range]});
  return {selection: rangeA1(range)};
}

const view = (id, label, extra) => ({id, label, risk: 'read', effect: 'view', undo: 'none', repeatable: false, state: hasDoc, ...extra});

export default defineCommands({
  family: 'edit/selection',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    view('selection.set', 'Select', {
      description: 'Select cells or ranges (A1:B2,D4), optionally on another sheet (which it then shows) and with a given active cell.',
      params: s.object({
        range: s.optional(s.string({min: 1, max: 100_000})), cell: s.optional(s.string({min: 1, max: 600})),
        active: s.optional(s.string({min: 1, max: 600})),
        sheet: s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})])),
      }),
      run: selectionSet,
    }),
    view('selection.move', 'Move Selection', {
      description: 'Move the active cell by dr rows and dc columns (hidden lines and merged areas are stepped over); extend: Shift; jump: Ctrl (edge of the data).',
      params: s.object({
        dr: s.optional(s.integer({min: -MAX_ROWS, max: MAX_ROWS})), dc: s.optional(s.integer({min: -MAX_COLS, max: MAX_COLS})),
        extend: s.optional(s.boolean()), jump: s.optional(s.boolean()), page: s.optional(s.boolean()),
      }),
      run: selectionMove,
    }),
    view('selection.next', 'Next Cell in Selection', {
      description: 'Enter/Tab inside a selection: the active cell moves to the next cell of the selection (forward: false goes back; byRow: Tab order).',
      params: s.object({forward: s.optional(s.boolean()), byRow: s.optional(s.boolean())}),
      run: selectionNext,
    }),
    view('edit.selectAll', 'Select All', {
      shortcut: ['Mod+A', 'Mod+Shift+Space'],
      description: 'Select the current region, or the whole sheet when that is selected already or there is none.',
      params: s.object({}),
      run: selectAll,
    }),
    view('selection.currentRegion', 'Select Current Region', {
      shortcut: 'Mod+Shift+8',
      description: 'Select the block of data around the active cell.',
      params: s.object({}),
      run: selectRegion,
    }),
    view('selection.row', 'Select Entire Row', {
      shortcut: 'Shift+Space', description: 'Select the rows of the selection.', params: s.object({}), run: selectRow,
    }),
    view('selection.column', 'Select Entire Column', {
      shortcut: 'Mod+Space', description: 'Select the columns of the selection.', params: s.object({}), run: selectCol,
    }),
  ],
});
