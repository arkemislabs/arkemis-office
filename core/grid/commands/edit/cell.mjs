// Cell entry: Enter Cell (typing into a cell or the formula bar, Ctrl+Shift+Enter legacy arrays),
// Set Values (agents and scripts writing a block) and Fill Range With Input (Ctrl+Enter).
// Translated from gridcraft crates/engine/src/cmd/edit/cell.rs (`cell_set`, `range_set_values`,
// `range_fill`, `json_to_input`) and crates/engine/src/cmd.rs (`check_protection`,
// `check_arrays`, `locked_cell_error`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What typing produces (auto formats, closing parentheses, argument counts, percent entry,
// Alt+Enter wrap) is the foundation's `inputToCell` (core/grid/model/input.mjs, a translation of
// the same cell.rs). Relative references in Ctrl+Enter fills move exactly as gridcraft's
// `shift_relative` (lib/formula.mjs). Not here: `grow_autofilter` (U:grid/data owns AutoFilter)
// and `tables::sync_headers` (U:grid/insert owns tables); see openIssues of U:grid/edit.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {MAX_ROWS, a1, rangeA1, contains, count, isSingle, intersects, parseRange, rangeCell, offset} from '../../lib/addr.mjs';
import {parse, print, shiftRelative} from '../../lib/formula.mjs';
import {inputToCell, putCell, jsonToInput} from '../../model/input.mjs';
import {cellAt, writeCell, isLegacySheet, hasContent} from '../../model/store.mjs';
import {styleIdAt, currentArea} from '../../model/workbook.mjs';
import {resolveStyle, styleById, deriveStyle} from '../../model/style.mjs';
import {engineFor} from '../../model/calc.mjs';
import {displayAt} from '../../model/index.mjs';
import {grownAutofilter} from '../../lib/data-filter.mjs';
import {
  hasDoc, gridSel, activeSheet, targetSheet, targetRanges, targetRange, cellParamOn, bad, failed, sheetPath, areaAddress, baseDoc, lazyValue,
} from '../../lib/edit-targets.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/edit/cell.rs', 'crates/engine/src/cmd.rs']};

/** Excel's message for an edit of a locked cell on a protected sheet (cmd.rs PROTECTED). */
export const PROTECTED = "The cell or chart you're trying to change is on a protected sheet.";

const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})], {description: 'Sheet: index, name or /sh:<id> (default: the active sheet)'}));
const INPUT = s.union([s.string({max: 32_767}), s.number(), s.boolean()], {nullable: true});
const RANGE = s.optional(s.string({min: 1, max: 4096, description: 'Range: /sh:<id>/A1:C9, Sheet1!A1:C9 or A1:C9 (default: the selection)'}));

/**
 * cmd.rs `locked_cell_error` / `check_protection`: a locked cell on a protected sheet refuses an
 * edit, unless an Allow Edit Range without a password (or unlocked this session) holds it.
 */
export function lockedCellError(ctx, si, row, col) {
  const sheet = ctx.doc.sheets[si];
  const prot = sheet?.protection;
  if (!prot || prot.enabled === false) return null;
  const st = resolveStyle(styleById(ctx.doc, styleIdAt(sheet, row, col)));
  if (!st.protection.locked) return null;
  let needs = null;
  for (const r of sheet.editRanges ?? []) {
    const areas = (Array.isArray(r.ranges) ? r.ranges : [r.range]).map(x => (typeof x === 'string' ? parseRange(x) : x)).filter(Boolean);
    if (!areas.some(a => contains(a, {row, col}))) continue;
    if (!r.password || (ctx.view?.unlockedRanges ?? []).some(u => u.sheet === sheet.id && u.title === r.title)) return null;
    needs ??= r.title;
  }
  return needs ? `The range "${needs}" needs its password before it can be changed (Review › Allow Edit Ranges).` : PROTECTED;
}

/** cmd.rs `check_arrays`: a cell inside a multi-cell legacy array other than its formula cell can't take content. */
export function partOfArray(content, si, row, col) {
  const a = engineFor(content).spillAnchorOf(si, row, col);
  if (!a) return false;
  const anchor = cellAt(content.sheets[si], a.row, a.col);
  if (!anchor?.a) return false;
  const r = parseRange(anchor.a);
  return !!r && !isSingle(r);
}
const ARRAY_PART = "You can't change part of an array.";

/** Refuses writing `cell` at (si, row, col) when protection or a legacy array forbids it. */
export function guardWrite(ctx, si, row, col, cell) {
  const before = cellAt(ctx.doc.sheets[si], row, col);
  const same = (before?.v ?? null) === (cell?.v ?? null) && before?.f === cell?.f;
  if (same) return;
  const locked = lockedCellError(ctx, si, row, col);
  if (locked) throw failed(locked);
  if (hasContent(cell) && partOfArray(baseDoc(ctx), si, row, col)) throw failed(ARRAY_PART);
}

/** The value a cell shows after the edit (cell.rs: `sh.value(at).display()`). */
const shown = (content, si, at) => displayAt(content, si, at.row, at.col).text;

function cellSet(ctx, p) {
  const base = baseDoc(ctx);
  const sheet = targetSheet(ctx, p, ['cell']);
  const at = cellParamOn(ctx, p, 'cell', sheet) ?? gridSel(ctx).active;
  const raw = p.input !== undefined ? p.input : p.value;
  if (raw === undefined) throw bad('cell.set', 'missing `input` (or `value`)');
  const input = jsonToInput(raw);
  const locked = lockedCellError(ctx, sheet, at.row, at.col);
  if (locked) throw failed(locked);
  const content = ctx.doc;
  const sh = content.sheets[sheet];
  if (p.array) {
    if (isLegacySheet(sh)) throw new CommandError('unavailable', 'Array formulas need the new workbook format.');
    // Legacy Ctrl+Shift+Enter array over the selection when it holds the cell; a cell elsewhere
    // (or on another sheet) gets a one-cell array.
    const sel = gridSel(ctx);
    const selected = currentArea(sel);
    const range = sheet === activeSheet(ctx) && contains(selected, at) ? selected : rangeCell(at);
    if (!isSingle(range) && (sh.tables ?? []).some(t => intersects(typeof t.range === 'string' ? parseRange(t.range) : t.range, range))) {
      throw failed("Multi-cell array formulas aren't allowed in tables.");
    }
    if (count(range) > 1_000_000) throw bad('cell.set', 'range too large');
    const cell = inputToCell(ctx.change, ctx.doc, sheet, range.start.row, range.start.col, input) ?? {};
    if (cell.f !== undefined) cell.a = rangeA1(range);
    // The array takes the whole range: other cells in it lose their contents.
    for (let r = range.start.row; r <= range.end.row; r++) {
      for (let c = range.start.col; c <= range.end.col; c++) {
        if (r === range.start.row && c === range.start.col) continue;
        const old = cellAt(ctx.doc.sheets[sheet], r, c);
        if (old && hasContent(old)) writeCell(ctx.change, ctx.doc, sheet, r, c, old.s ? {s: old.s} : null);
      }
    }
    writeCell(ctx.change, ctx.doc, sheet, range.start.row, range.start.col, cell);
    return lazyValue({cell: a1(range.start.row, range.start.col), address: `${sheetPath(ctx.doc, sheet)}/${a1(range.start.row, range.start.col)}`}, 'value', ctx, doc => shown(doc, sheet, range.start));
  }
  const cell = inputToCell(ctx.change, ctx.doc, sheet, at.row, at.col, input);
  if (hasContent(cell) && partOfArray(base, sheet, at.row, at.col)) throw failed(ARRAY_PART);
  putCell(ctx.change, ctx.doc, sheet, at.row, at.col, cell, input);
  // Excel grows an AutoFilter range when a value is typed in the row right below it (U:grid/data).
  const grown = grownAutofilter(sh, at, cell);
  if (grown) ctx.change.set(['sheets', sheet, 'autofilter'], grown);
  return lazyValue({cell: a1(at.row, at.col), address: `${sheetPath(ctx.doc, sheet)}/${a1(at.row, at.col)}`}, 'value', ctx, doc => shown(doc, sheet, at));
}

function rangeSetValues(ctx, p) {
  baseDoc(ctx);
  const {sheet, range} = targetRange(ctx, p);
  const start = range.start;
  const rows = p.values;
  if (!Array.isArray(rows)) throw bad('range.setValues', 'missing `values` (array of rows)');
  const parseStrings = p.parse === undefined || p.parse === null ? true : p.parse;
  if (rows.length > MAX_ROWS) throw bad('range.setValues', 'too many rows');
  let n = 0;
  const legacy = isLegacySheet(ctx.doc.sheets[sheet]);
  rows.forEach((row, ri) => {
    const cols = Array.isArray(row) ? row : [row];
    cols.forEach((v, ci) => {
      const at = offset(start, ri, ci);
      if (!at) return;
      const content = ctx.doc;
      const style = styleIdAt(content.sheets[sheet], at.row, at.col);
      let cell;
      if (typeof v === 'number') cell = {v, ...(style ? {s: style} : {})};
      else if (typeof v === 'boolean') cell = {v, ...(style ? {s: style} : {})};
      else if (typeof v === 'string' && !parseStrings && !v.startsWith('=')) {
        // Text as given: no date or number reading, a leading ' is part of the text.
        let st = style;
        if (v.includes('\n') && !resolveStyle(styleById({styles: ctx.change.get(['styles']) ?? content.styles}, st)).align.wrap) {
          st = deriveStyle(ctx.change, content, st, {align: {wrap: true}});
        }
        cell = {v, ...(st ? {s: st} : {})};
      } else cell = inputToCell(ctx.change, content, sheet, at.row, at.col, jsonToInput(v));
      guardWrite(ctx, sheet, at.row, at.col, cell);
      if (legacy) putCell(ctx.change, ctx.doc, sheet, at.row, at.col, cell, typeof v === 'string' && !parseStrings && !v.startsWith('=') && v !== '' ? v : jsonToInput(v));
      else writeCell(ctx.change, ctx.doc, sheet, at.row, at.col, cell);
      n++;
    });
  });
  return {cells: n};
}

function rangeFill(ctx, p) {
  baseDoc(ctx);
  const {sheet, areas} = targetRanges(ctx, p);
  const input = typeof p.input === 'string' ? p.input : '';
  const origin = gridSel(ctx).active;
  // Each cell gets what typing the input there gives; that depends only on the cell's style,
  // so the input is parsed once per style.
  const byStyle = new Map();
  let n = 0;
  for (const r of areas) {
    if (count(r) > 2_000_000) throw bad('range.fill', 'range too large');
  }
  for (const r of areas) {
    for (let row = r.start.row; row <= r.end.row; row++) {
      for (let col = r.start.col; col <= r.end.col; col++) {
        const content = ctx.doc;
        const style = styleIdAt(content.sheets[sheet], row, col);
        let base;
        if (byStyle.has(style)) base = byStyle.get(style);
        else { base = inputToCell(ctx.change, content, sheet, row, col, input); byStyle.set(style, base); }
        const cell = base ? {...base} : {};
        if (cell.f !== undefined) {
          let e = null;
          try { e = parse(cell.f); } catch { e = null; }
          if (e) cell.f = print(shiftRelative(e, row - origin.row, col - origin.col));
        }
        guardWrite(ctx, sheet, row, col, cell);
        putCell(ctx.change, ctx.doc, sheet, row, col, Object.keys(cell).length ? cell : null, cell.f !== undefined ? `=${cell.f}` : input);
        n++;
      }
    }
  }
  return {cells: n, ranges: areas.map(r => areaAddress(ctx.doc, sheet, r))};
}

export default defineCommands({
  family: 'edit/cell',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'cell.set', label: 'Enter Cell', risk: 'edit', dialog: 'dialog.pickList',
      description: 'Enter what a person types into a cell (text, number, date or =formula); array: true enters a legacy Ctrl+Shift+Enter array over the selection.',
      params: s.object({
        cell: s.optional(s.string({min: 1, max: 600, description: 'Cell: /sh:<id>/B2, Sheet1!B2 or B2 (default: the active cell)'})),
        input: s.optional(INPUT), value: s.optional(INPUT), sheet: SHEET,
        array: s.optional(s.boolean({description: 'Ctrl+Shift+Enter: a legacy array formula over the selection'})),
      }),
      state: hasDoc,
      run: cellSet,
    },
    {
      id: 'range.setValues', label: 'Set Values', risk: 'edit',
      description: 'Write rows of values from a top-left cell; strings go through typed input unless parse is false (then they stay the text they are; =formulas stay formulas).',
      params: s.object({
        range: RANGE, sheet: SHEET,
        values: s.array(s.any(), {max: MAX_ROWS, description: 'Rows of numbers, strings, booleans or null'}),
        parse: s.optional(s.boolean({description: 'Default true'})),
      }),
      state: hasDoc,
      run: rangeSetValues,
    },
    {
      // Ctrl+Enter belongs to the cell editor (the surface commits with range.fill); bound here it
      // would empty the selection when pressed outside the editor.
      id: 'range.fill', label: 'Fill Range With Input', risk: 'edit',
      description: 'Enter the same input in every selected cell (Ctrl+Enter in the cell editor); relative references in a formula move with each cell.',
      params: s.object({range: RANGE, sheet: SHEET, input: s.optional(s.string({max: 32_767}))}),
      state: hasDoc,
      run: rangeFill,
    },
  ],
});
