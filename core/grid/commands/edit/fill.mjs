// Home › Editing › Fill: Down, Right, Up, Left, Series…, Flash Fill, and the fill handle (AutoFill).
// Translated from gridcraft crates/engine/src/cmd/edit/fill.rs (`fill_dir`, `auto_fill`,
// `fill_series`, `flash_fill`) and crates/engine/src/cmd/edit.rs (specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The fill itself (patterns, dates, custom lists, formulas moving their relative references
// exactly as `shift_relative`) is the foundation's `fill` (core/grid/model/fill.mjs, from
// gridcraft fill.rs). Series and Flash Fill are lib/edit-series.mjs.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {count, isFullCols, isFullRows, intersection, union, rangeA1} from '../../lib/addr.mjs';
import {fill, holdsSourceInCorner, MAX_FILL_CELLS} from '../../model/fill.mjs';
import {usedBounds} from '../../model/store.mjs';
import {series, flashFill} from '../../lib/edit-series.mjs';
import {hasDoc, targetRange, targetRanges, bad, failed, setGridSelection, areaAddress, requireSchema2} from '../../lib/edit-targets.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/edit/fill.rs', 'crates/engine/src/fill.rs']};

/** edit.autoFill `mode` → the foundation's FillMode. */
export const AUTOFILL_MODES = Object.freeze({
  series: 'series', alternate: 'alternate', copy: 'copy', formats: 'formats', values: 'valuesOnly', extend: 'extend',
  days: 'dates:day', weekdays: 'dates:weekday', months: 'dates:month', years: 'dates:year',
});

const RANGE = s.optional(s.string({min: 1, max: 4096, description: 'Range: /sh:<id>/A1:C9, Sheet1!A1:C9 or A1:C9 (default: the selection)'}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

const usedRange = sheet => { const b = usedBounds(sheet); return b ? {start: {row: b.r0, col: b.c0}, end: {row: b.r1, col: b.c1}} : null; };

/** fill.rs `fill_dir`: Fill Down/Right/Up/Left copy the first row/column of the range over the rest. */
function fillDir(ctx, p, dr, dc) {
  const t = targetRange(ctx, p);
  const sheet = t.sheet;
  let r = t.range;
  requireSchema2(ctx, sheet);
  // Whole rows or columns fill only where the sheet has content (nothing on an empty sheet).
  if (isFullCols(r) || isFullRows(r)) {
    const u = usedRange(ctx.doc.sheets[sheet]);
    const x = u ? intersection(r, u) : null;
    if (!x) return {cells: 0};
    r = x;
  }
  if (count(r) > MAX_FILL_CELLS) throw bad('edit.fill', 'range too large');
  // With one row selected, Fill Down copies from the row above (Excel behaviour).
  r = {start: {...r.start}, end: {...r.end}};
  if (dr === 1 && r.start.row === r.end.row) r.start.row = Math.max(0, r.start.row - 1);
  if (dc === 1 && r.start.col === r.end.col) r.start.col = Math.max(0, r.start.col - 1);
  const src = dr === 1 ? {start: {...r.start}, end: {row: r.start.row, col: r.end.col}}
    : dr === -1 ? {start: {row: r.end.row, col: r.start.col}, end: {...r.end}}
      : dc === 1 ? {start: {...r.start}, end: {row: r.end.row, col: r.start.col}}
        : {start: {row: r.start.row, col: r.end.col}, end: {...r.end}};
  const n = fill(ctx.change, ctx.doc, sheet, src, r, 'copy');
  return {cells: n, range: areaAddress(ctx.doc, sheet, r)};
}

function autoFill(ctx, p) {
  const srcT = p.source ? targetRange(ctx, p, ['source']) : targetRange(ctx, p);
  const sheet = srcT.sheet;
  const src = srcT.range;
  if (!p.target) throw bad('edit.autoFill', 'missing `target`');
  const target = targetRanges(ctx, {target: p.target, ...(p.sheet !== undefined ? {sheet: p.sheet} : {})}, ['target']).areas[0];
  requireSchema2(ctx, sheet);
  const mode = AUTOFILL_MODES[p.mode ?? 'series'] ?? 'series';
  if (count(target) > MAX_FILL_CELLS || count(src) > MAX_FILL_CELLS) throw bad('edit.autoFill', 'range too large');
  // Excel refuses a target that doesn't hold the source in a corner.
  if (!holdsSourceInCorner(src, target)) throw bad('edit.autoFill', 'the target must contain the source in one of its corners');
  const n = fill(ctx.change, ctx.doc, sheet, src, target, mode);
  const all = union(target, src);
  setGridSelection(ctx, {sheet, active: {...src.start}, anchor: {...src.start}, ranges: [all]});
  return {cells: n, range: areaAddress(ctx.doc, sheet, all)};
}

function fillSeries(ctx, p) {
  const {sheet, range: r} = targetRange(ctx, p);
  requireSchema2(ctx, sheet);
  const width = r.end.col - r.start.col + 1, height = r.end.row - r.start.row + 1;
  const rows = p.direction ? p.direction === 'rows' : width > height;
  const kind = (p.type ?? 'linear').toLowerCase();
  const stop = p.stop === undefined || p.stop === null || p.stop === '' ? null : Number(p.stop);
  if (stop !== null && !Number.isFinite(stop)) throw bad('edit.fillSeries', 'the stop value is a number');
  const n = series(ctx.change, ctx.doc, sheet, {range: r, rows, kind, step: p.step ?? 1, stop, unit: p.dateUnit ?? 'day', trend: !!p.trend});
  return {cells: n, range: areaAddress(ctx.doc, sheet, r)};
}

function flash(ctx, p) {
  const {sheet, range: r} = targetRange(ctx, p);
  requireSchema2(ctx, sheet);
  const n = flashFill(ctx.change, ctx.doc, sheet, r.start);
  if (n === 0) throw failed("We looked at all the data next to your selection and didn't see a pattern for filling in values for you.");
  return {filled: n};
}

const dirCmd = (id, label, dr, dc, shortcut) => ({
  id, label, risk: 'edit', ...(shortcut ? {shortcut} : {}),
  description: `${label}: copy the ${dr === 1 ? 'top row' : dr === -1 ? 'bottom row' : dc === 1 ? 'left column' : 'right column'} of the selection (or range) over the rest; one row or column takes it from the neighbour.`,
  params: s.object({range: RANGE, sheet: SHEET}),
  state: hasDoc,
  run: (ctx, p) => fillDir(ctx, p, dr, dc),
});

export default defineCommands({
  family: 'edit/fill',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    dirCmd('edit.fillDown', 'Fill Down', 1, 0, 'Mod+D'),
    dirCmd('edit.fillRight', 'Fill Right', 0, 1, 'Mod+R'),
    dirCmd('edit.fillUp', 'Fill Up', -1, 0),
    dirCmd('edit.fillLeft', 'Fill Left', 0, -1),
    {
      id: 'edit.autoFill', label: 'AutoFill', risk: 'edit',
      description: 'The fill handle: fill target (which holds source in a corner) from source. mode: series (drag), alternate (Ctrl+drag), copy, formats, values (Fill Without Formatting), extend (Fill Series), days, weekdays, months, years.',
      params: s.object({
        source: s.optional(s.string({min: 1, max: 4096, description: 'The range the handle is dragged from (default: the selection)'})),
        target: s.string({min: 1, max: 4096, description: 'The range the drag covers, source included'}),
        mode: s.optional(s.enum(Object.keys(AUTOFILL_MODES))),
        range: RANGE, sheet: SHEET,
      }),
      state: hasDoc,
      run: autoFill,
    },
    {
      id: 'edit.fillSeries', label: 'Series…', risk: 'edit', dialog: 'dialog.series',
      description: 'Fill the selection with a linear, growth or date series from its first cells (Excel: AutoFill type and Trend too), up to an optional stop value.',
      params: s.object({
        range: RANGE, sheet: SHEET,
        direction: s.optional(s.enum(['columns', 'rows'])),
        type: s.optional(s.enum(['linear', 'growth', 'date', 'autofill', 'autoFill'])),
        step: s.optional(s.number()),
        stop: s.optional(s.union([s.number(), s.string({max: 64})], {nullable: true})),
        dateUnit: s.optional(s.enum(['day', 'weekday', 'month', 'year'])),
        trend: s.optional(s.boolean({description: 'Excel: a best-fit trend through the starting values'})),
      }),
      state: hasDoc,
      run: fillSeries,
    },
    {
      id: 'edit.flashFill', label: 'Flash Fill', shortcut: 'Mod+E', risk: 'edit',
      description: 'Fill the column from the examples typed beside the data to its left (words, initials, case, literal separators).',
      params: s.object({range: RANGE, sheet: SHEET}),
      state: hasDoc,
      run: flash,
    },
  ],
});

export {rangeA1};
