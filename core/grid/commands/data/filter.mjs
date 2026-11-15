// Data > Sort & Filter > Filter (AutoFilter on/off), Clear and Reapply, and Filter Column (what a
// header drop-down's OK, Filter by Selected Cell's Value and the text, number and date filters run).
// Translated from gridcraft crates/engine/src/cmd/data/filter.rs (`toggle_filter`, `install_filter`,
// `filter_by`, `apply_filter`, `clear_filter`, `reapply`) and cmd/data.rs (specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Behaviour as Excel: Filter on a data region puts a drop-down button in each header cell; filtering
// hides the rows that fail and the row numbers turn blue; Filter again removes the buttons and shows
// the rows the filter hid (rows hidden by hand or by a collapsed group stay hidden); a table's Filter
// toggles its own buttons. Protect Sheet > Use AutoFilter is respected.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {parseRange, rangeA1, rangeOf} from '../../lib/addr.mjs';
import {jsonToInput} from '../../model/input.mjs';
import {hasDoc, gridSel, requireSchema2} from '../../lib/edit-targets.mjs';
import {protectionOf} from '../../lib/format-ranges.mjs';
import {dataTarget, colParam, tableAtCell, regionAround, setRowsHidden, valueOf, textOf, bad, failed, baseDoc} from '../../lib/data-common.mjs';
import {computeFilter, criteriaOf, filterBlank} from '../../lib/data-filter.mjs';
import {engineFor} from '../../model/calc.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/data.rs', 'crates/engine/src/cmd/data/filter.rs']};
const RANGE = s.optional(s.string({min: 1, max: 4096}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

function refuseUnlessAllowed(sheet) {
  const pr = protectionOf(sheet);
  if (pr && !pr.autofilter) throw failed("Filtering isn't allowed on this protected sheet (Review › Unprotect Sheet).");
}

/** Rows the filter hid: hidden rows below the header of a filter that has criteria. */
function filteredRows(sheet) {
  const af = sheet.autofilter;
  const r = af?.range ? parseRange(af.range) : null;
  if (!r || !af.criteria || !Object.keys(af.criteria).length) return [];
  return Object.keys(sheet.rows ?? {}).map(Number).filter(row => sheet.rows[row]?.hidden && row > r.start.row && row <= r.end.row);
}

function installFilter(ctx, p) {
  const {sheet: si, range} = dataTarget(ctx, p, 'data.filter');
  let r = range;
  // A selected header row filters the data below it.
  if (!(typeof p.range === 'string' && p.range) && r.end.row === r.start.row) {
    const below = regionAround(baseDoc(ctx), si, r.start).end.row;
    if (below > r.end.row) r = rangeOf(r.start.row, r.start.col, below, r.end.col);
  }
  ctx.change.set(['sheets', si, 'autofilter'], {range: rangeA1(r)});
  return {filter: true, range: rangeA1(r)};
}

function toggleFilter(ctx, p) {
  const content = baseDoc(ctx);
  const {sheet: si, range: r} = dataTarget(ctx, p, 'data.filter');
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  refuseUnlessAllowed(sheet);
  const at = si === gridSel(ctx).sheet ? gridSel(ctx).active : r.start;
  const tb = tableAtCell(sheet, at);
  if (tb) {
    const idx = sheet.tables.indexOf(tb.table);
    const on = tb.table.autoFilter === false;
    ctx.change.set(['sheets', si, 'tables', idx, 'autoFilter'], on);
    if (!on && sheet.autofilter?.range === tb.table.range) {
      setRowsHidden(ctx.change, content, si, new Map(filteredRows(sheet).map(row => [row, false])));
      ctx.change.delete(['sheets', si, 'autofilter']);
    }
    return {filter: on};
  }
  if (sheet.autofilter) {
    // Reveal only rows the filter hid; rows hidden by hand or by a collapsed group stay hidden.
    setRowsHidden(ctx.change, content, si, new Map(filteredRows(sheet).map(row => [row, false])));
    ctx.change.delete(['sheets', si, 'autofilter']);
    return {filter: false};
  }
  return installFilter(ctx, p);
}

/** Hides the rows that fail the criteria of the filter and shows the rest. */
function applyFilter(ctx, si, af) {
  const content = baseDoc(ctx);
  const map = computeFilter(content, si, af);
  setRowsHidden(ctx.change, content, si, map);
}

/** The criterion a `data.filterBy` call describes (undefined clears the column's). */
function criterionOf(p) {
  if (p.clear === true) return undefined;
  if (Array.isArray(p.values)) return {type: 'values', values: p.values.map(jsonToInput), blanks: p.blanks === true};
  if (p.custom && typeof p.custom === 'object') {
    const c = p.custom;
    const out = {type: 'custom', a: [String(c.op ?? '='), c.value === undefined ? '' : jsonToInput(c.value)], and: c.and !== false};
    if (typeof c.op2 === 'string') out.b = [c.op2, c.value2 === undefined ? '' : jsonToInput(c.value2)];
    return out;
  }
  if (p.top && typeof p.top === 'object') {
    return {type: 'top10', bottom: p.top.bottom === true, percent: p.top.percent === true, count: Number.isInteger(p.top.count) ? p.top.count : 10};
  }
  if (typeof p.aboveAverage === 'boolean') return {type: 'aboveAverage', above: p.aboveAverage};
  return undefined;
}

function filterBy(ctx, p) {
  const content0 = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  refuseUnlessAllowed(content0.sheets[si]);
  let af = ctx.change.get(['sheets', si, 'autofilter']) ?? content0.sheets[si].autofilter;
  if (!af) {
    installFilter(ctx, typeof p.range === 'string' && p.range ? {range: p.range} : {});
    af = ctx.change.get(['sheets', si, 'autofilter']);
    if (!af) throw failed('no filter');
  }
  const r = parseRange(af.range);
  const active = gridSel(ctx).active;
  const col = p.byCell === true && p.column === undefined ? active.col : colParam(p.column, r.start.col);
  if (col === null && p.column !== undefined && Number.isInteger(p.column)) throw bad('data.filterBy', 'column outside the filter range');
  if (col === null) throw bad('data.filterBy', 'missing `column`');
  if (col < r.start.col || col > r.end.col) throw bad('data.filterBy', 'column outside the filter range');
  const off = col - r.start.col;
  let crit = criterionOf(p);
  // Filter by Selected Cell's Value: the shown text of the active cell (blank cells filter for blanks).
  if (p.byCell === true && p.clear !== true && !crit) {
    const v = valueOf(engineFor(content0), si, active.row, active.col);
    crit = filterBlank(v) ? {type: 'values', values: [], blanks: true} : {type: 'values', values: [textOf(content0, si, active.row, active.col, v)], blanks: false};
  }
  const criteria = {...(af.criteria ?? {})};
  delete criteria[off];
  if (crit) criteria[off] = crit;
  const next = {range: af.range};
  if (Object.keys(criteria).length) next.criteria = criteria;
  ctx.change.set(['sheets', si, 'autofilter'], next);
  applyFilter(ctx, si, next);
  const rows = ctx.change.get(['sheets', si, 'rows']) ?? {};
  return {hiddenRows: Object.values(rows).filter(x => x?.hidden).length};
}

function activeFilter(ctx) {
  const si = gridSel(ctx).sheet;
  return {si, af: baseDoc(ctx).sheets[si]?.autofilter ?? null};
}

function clearFilter(ctx) {
  const {si, af} = activeFilter(ctx);
  if (!af) return null;
  const next = {range: af.range};
  ctx.change.set(['sheets', si, 'autofilter'], next);
  applyFilter(ctx, si, next);
  return null;
}
function reapply(ctx) {
  const {si, af} = activeFilter(ctx);
  if (!af) return null;
  applyFilter(ctx, si, af);
  return null;
}

const filterState = need => ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const sheet = ctx.doc.sheets[gridSel(ctx).sheet];
  const af = sheet?.autofilter;
  if (!af) return {enabled: false, reason: 'No filter is applied'};
  if (need === 'criteria' && !criteriaOf(af).length) return {enabled: false, reason: 'No filter is applied'};
  return {enabled: true};
};

export default defineCommands({
  family: 'data/filter',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.filter', label: 'Filter', risk: 'edit', shortcut: 'Mod+Shift+L',
      description: 'Toggle AutoFilter on the data region around the active cell (or `range`); a table toggles its own filter buttons.',
      params: s.object({range: RANGE, sheet: SHEET}),
      state(ctx) {
        const base = hasDoc(ctx);
        if (!base.enabled) return base;
        const sel = gridSel(ctx);
        const sheet = ctx.doc.sheets[sel.sheet];
        const tb = tableAtCell(sheet, sel.active);
        return {enabled: true, checked: tb ? tb.table.autoFilter !== false : !!sheet?.autofilter};
      },
      run: toggleFilter,
    },
    {
      id: 'data.filterBy', label: 'Filter Column', risk: 'edit',
      description: 'Filter one column of the AutoFilter (installed when absent): values?: [..] with blanks?, custom?: {op, value, op2?, value2?, and?}, top?: {count, bottom?, percent?}, aboveAverage?: bool, or clear: true.',
      params: s.object({
        column: s.optional(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})], {description: 'Column letter, or 0-based offset into the filter range (default with byCell: the active cell column)'})),
        byCell: s.optional(s.boolean({description: 'Filter by the shown value of the active cell (Filter by Selected Cell Value); with clear, clears its column'})),
        range: s.optional(s.string({max: 600, description: 'The list to install the filter over when the sheet has none (a table data range)'})),
        values: s.optional(s.array(s.any(), {max: 1_000_000})), blanks: s.optional(s.boolean()),
        custom: s.optional(s.object({op: s.optional(s.string({max: 20})), value: s.optional(s.any()), op2: s.optional(s.string({max: 20})), value2: s.optional(s.any()), and: s.optional(s.boolean())})),
        top: s.optional(s.object({count: s.optional(s.integer({min: 0})), bottom: s.optional(s.boolean()), percent: s.optional(s.boolean())})),
        aboveAverage: s.optional(s.boolean()), clear: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: filterBy,
    },
    {
      id: 'data.clearFilter', label: 'Clear', risk: 'edit',
      description: 'Remove the filtering of every column and show the rows it hid (the drop-down buttons stay).',
      params: s.object({}), state: filterState('criteria'), run: clearFilter,
    },
    {
      id: 'data.reapply', label: 'Reapply', risk: 'edit',
      description: 'Apply the filter\'s criteria again, after the data changed.',
      params: s.object({}), state: filterState('any'), run: reapply,
    },
  ],
});
