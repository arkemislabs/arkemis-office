// Data > Outline > Group > Auto Outline and Ungroup > Clear Outline.
// Not in gridcraft (it has Group, Ungroup, Show and Hide Detail, but no automatic outline): Excel's own behaviour, not checked against upstream.
//
// Auto Outline reads the formulas of the sheet: a formula that refers to cells in its own column that all lie above it (below it when the sheet's
// Summary rows are set above detail) makes its row a summary row, and the rows it adds up its detail, so they become a group; a formula that
// refers to cells in its own row that all lie left of it (right of it) does the same for columns. A summary row that adds up other summary rows
// groups them with all of their detail, which gives Excel's levels: detail rows deepest, subtotals above them, the grand total outside. The
// outline that was there is replaced. Clear Outline removes every outline level and its collapse marks from the sheet's rows and columns (rows
// that were hidden stay hidden, as in Excel).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {failed, baseDoc} from '../../lib/data-common.mjs';
import {parse, references, refRange} from '../../lib/formula.mjs';
import {sheetIndex} from '../../model/sheet.mjs';
import {forEachCell} from '../../model/store.mjs';
import {MAX_LEVEL} from '../../lib/data-outline.mjs';

const UPSTREAM = {repo: 'office', files: ['Excel Data > Outline > Group > Auto Outline', 'Excel Data > Outline > Ungroup > Clear Outline']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

/**
 * The groups of one direction: the summary lines and the detail each adds up. `edges` is [[line (the summary), first, last]] for every formula
 * reference that lies wholly on one side of its cell; returns [{start, end}] groups of lines (the summary line itself excluded unless it is
 * itself detail of an outer summary).
 */
export function groupsFromEdges(edges, before) {
  // Per summary line: the detail span it adds up.
  const bySummary = new Map();
  for (const [line, a, b] of edges) {
    const cur = bySummary.get(line);
    bySummary.set(line, cur ? [Math.min(cur[0], a), Math.max(cur[1], b)] : [a, b]);
  }
  // Inner summaries first: those nearest the detail.
  const order = [...bySummary.keys()].sort((x, y) => (before ? y - x : x - y));
  const groups = new Map();
  for (const line of order) {
    let [a, b] = bySummary.get(line);
    // A reference to another summary line brings that summary's own detail into this group.
    for (const [other, g] of groups) if (other >= a && other <= b) { a = Math.min(a, g.start); b = Math.max(b, g.end); }
    const start = before ? line + 1 : a, end = before ? b : line - 1;
    if (end >= start) groups.set(line, {start, end});
  }
  return [...groups.values()];
}

/** The outline levels {line: level} the groups give: each group adds one level to every line it holds. */
export function levelsOf(groups) {
  const out = new Map();
  const seen = new Set();
  for (const g of groups) {
    const key = `${g.start}:${g.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let i = g.start; i <= g.end; i++) out.set(i, Math.min(MAX_LEVEL, (out.get(i) ?? 0) + 1));
  }
  return out;
}

/** Scans the sheet's formulas: {rows: [[summaryRow, first, last]], cols: [[summaryCol, first, last]]}. */
function scan(content, si, rowsBefore, colsBefore) {
  const sheet = content.sheets[si];
  const rows = [], cols = [];
  forEachCell(sheet, 0, 0, 1_048_575, 16_383, (row, col, cell) => {
    if (!cell || typeof cell.f !== 'string') return;
    let expr;
    try { expr = parse(cell.f); } catch { return; }
    for (const ref of references(expr)) {
      if (ref.sheet.k === 'span') continue;
      const target = ref.sheet.k === 'named' ? sheetIndex(content, ref.sheet.name) : si;
      if (target !== si || ref.kind.k === 'rows' || ref.kind.k === 'cols') continue;
      const r = refRange(ref);
      const sameCol = r.start.col <= col && col <= r.end.col, sameRow = r.start.row <= row && row <= r.end.row;
      if (sameCol && (rowsBefore ? r.start.row > row : r.end.row < row)) rows.push([row, r.start.row, r.end.row]);
      if (sameRow && (colsBefore ? r.start.col > col : r.end.col < col)) cols.push([col, r.start.col, r.end.col]);
    }
  });
  return {rows, cols};
}

function autoOutline(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const rowsBefore = sheet.summaryBelow === false, colsBefore = sheet.summaryRight === false;
  const found = scan(content, si, rowsBefore, colsBefore);
  const rowLevels = levelsOf(groupsFromEdges(found.rows, rowsBefore));
  const colLevels = levelsOf(groupsFromEdges(found.cols, colsBefore));
  if (!rowLevels.size && !colLevels.size) throw failed('Cannot create an outline.');
  for (const [key, levels] of [['rows', rowLevels], ['cols', colLevels]]) {
    // The outline that was there goes first.
    const map = {...(ctx.change.get(['sheets', si, key]) ?? sheet[key] ?? {})};
    for (const k of Object.keys(map)) {
      const {outline, collapsed, ...rest} = map[k];
      if (outline === undefined && collapsed === undefined) continue;
      if (Object.keys(rest).length) map[k] = rest; else delete map[k];
    }
    for (const [line, level] of levels) map[line] = {...(map[line] ?? {}), outline: level};
    if (Object.keys(map).length) ctx.change.set(['sheets', si, key], map); else if (sheet[key]) ctx.change.delete(['sheets', si, key]);
  }
  return {rows: rowLevels.size, columns: colLevels.size, levels: Math.max(0, ...rowLevels.values(), ...colLevels.values())};
}

function clearOutline(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  let cleared = 0;
  for (const key of ['rows', 'cols']) {
    const map = {...(sheet[key] ?? {})};
    let any = false;
    for (const k of Object.keys(map)) {
      const {outline, collapsed, ...rest} = map[k];
      if (outline === undefined && collapsed === undefined) continue;
      any = true; cleared += 1;
      if (Object.keys(rest).length) map[k] = rest; else delete map[k];
    }
    if (!any) continue;
    if (Object.keys(map).length) ctx.change.set(['sheets', si, key], map); else ctx.change.delete(['sheets', si, key]);
  }
  if (!cleared) throw failed('There is no outline to clear.');
  return {cleared};
}

export default defineCommands({
  family: 'data/autooutline',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'data.autoOutline', label: 'Auto Outline', risk: 'edit',
      description: 'Auto Outline (Data > Outline > Group): groups the rows and columns that the formulas of the sheet add up (rows above a formula in its column, columns left of it in its row; the other side when the outline settings put summaries above or left), replacing the outline that was there. -> {rows, columns, levels}.',
      params: s.object({sheet: SHEET}), state: hasDoc, run: autoOutline},
    {id: 'data.clearOutline', label: 'Clear Outline', risk: 'edit',
      description: 'Clear Outline (Data > Outline > Ungroup): removes every outline level and collapse mark of the sheet\'s rows and columns; rows that were hidden stay hidden. -> {cleared}.',
      params: s.object({sheet: SHEET}),
      state: ctx => {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        return {enabled: true};
      }, run: clearOutline},
  ],
});
