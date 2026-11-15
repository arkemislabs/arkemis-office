// Data > Outline > Group, Ungroup, Subtotal, Show Detail, Hide Detail and Settings, and the outline
// bar's level buttons (Show Outline Levels).
// Translated from gridcraft crates/engine/src/cmd/data/grouping.rs (`outline_lines`, `group`, `detail`,
// `set_hidden`, `show_levels`, `move_marks`, `outline_settings`, `subtotal`) and cmd/data.rs (specs)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Each line of a group carries its outline level (1 to 7); the summary line beside the group holds
// the - / + button (`collapsed` marks +). Hiding detail hides the lines and marks the summary line,
// showing keeps inner groups that were collapsed on their own collapsed. Subtotal inserts a total row
// (SUBTOTAL) under each run of equal values in a column, groups each run, and ends with a grand total.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, rangeA1, rangeOf} from '../../lib/addr.mjs';
import {display} from '../../lib/value.mjs';
import {engineFor} from '../../model/calc.mjs';
import {hasDoc, gridSel, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {parseLines} from '../../lib/format-lines.mjs';
import {dataTarget, colParam, valueOf, bad, baseDoc} from '../../lib/data-common.mjs';
import {MAX_LEVEL, groupsWith, groupSummary, groupHasSummary, groupContains, summaryBefore} from '../../lib/data-outline.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/data.rs', 'crates/engine/src/cmd/data/grouping.rs', 'crates/engine/src/outline.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const LINES = s.optional(s.string({min: 1, max: 4096}));

/** outline_lines: {sheet, rows, a, b}: the lines a command works on, from `rows`/`cols` or the selection. */
function outlineLines(ctx, p, cmd) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['rows', 'cols']);
  const sel = gridSel(ctx);
  const explicit = typeof p.rows === 'string' && p.rows ? 'rows' : typeof p.cols === 'string' && p.cols ? 'cols' : null;
  if (explicit) {
    const {spans} = parseLines(content, p[explicit], explicit === 'rows', explicit);
    return {sheet: si, rows: explicit === 'rows', a: Math.min(...spans[0]), b: Math.max(...spans[0])};
  }
  // The selection belongs to the active sheet, so another sheet needs its lines.
  if (si !== sel.sheet) throw bad(cmd, 'missing `rows` or `cols`: the selection is on the active sheet');
  const r = sel.ranges[sel.ranges.length - 1];
  const fullCols = r.start.row === 0 && r.end.row === 1_048_575, fullRows = r.start.col === 0 && r.end.col === 16_383;
  const rows = p.by === 'rows' ? true : p.by === 'cols' || p.by === 'columns' ? false : !(fullCols && !fullRows);
  return {sheet: si, rows, a: rows ? r.start.row : r.start.col, b: rows ? r.end.row : r.end.col};
}

const mapOf = (ctx, si, rows) => ({...(ctx.change.get(['sheets', si, rows ? 'rows' : 'cols']) ?? baseDoc(ctx).sheets[si][rows ? 'rows' : 'cols'] ?? {})});
const putMap = (ctx, si, rows, map) => ctx.change.set(['sheets', si, rows ? 'rows' : 'cols'], map);
const sheetOf = (ctx, si) => baseDoc(ctx).sheets[si];

/** Hides or shows an outline line; a line shown with a zero size gets the default size back, as Unhide does. */
function setHidden(e, hidden) {
  const next = {...e};
  if (hidden) next.hidden = true; else delete next.hidden;
  if (!hidden && next.size === 0) delete next.size;
  return next;
}
const clean = e => (Object.keys(e).length ? e : undefined);

function group(ctx, p, on) {
  const {sheet: si, rows, a, b: b0} = outlineLines(ctx, p, on ? 'data.group' : 'data.ungroup');
  const sheet = sheetOf(ctx, si);
  requireSchema2(ctx, si);
  const before = summaryBefore(sheet, rows);
  const map = mapOf(ctx, si, rows);
  const b = Math.min(b0, a + 1_048_575);
  for (let i = a; i <= b; i++) {
    const e = {...(map[i] ?? {})};
    const level = e.outline ?? 0;
    const next = on ? Math.min(level + 1, MAX_LEVEL) : Math.max(level - 1, 0);
    if (next) e.outline = next; else delete e.outline;
    if (!on && next === 0) delete e.hidden;
    const c = clean(e);
    if (c) map[i] = c; else delete map[i];
  }
  // A summary line whose group is gone has nothing left to collapse.
  const summary = before ? (a > 0 ? a - 1 : null) : b + 1;
  if (!on && summary !== null && map[summary]?.collapsed
    && !groupsWith(map, before).some(g => (before ? g.start === a : g.end === b))) {
    const {collapsed, ...rest} = map[summary];
    if (Object.keys(rest).length) map[summary] = rest; else delete map[summary];
  }
  putMap(ctx, si, rows, map);
  return null;
}

/** Hide Detail / Show Detail: the innermost group (or the one at `level`) holding the lines, or the one they summarise. */
function detail(ctx, p, hide) {
  const {sheet: si, rows, a, b} = outlineLines(ctx, p, hide ? 'data.hideDetail' : 'data.showDetail');
  const want = Number.isInteger(p.level) ? Math.min(p.level, MAX_LEVEL) : null;
  const sheet = sheetOf(ctx, si);
  const before = summaryBefore(sheet, rows);
  const map = mapOf(ctx, si, rows);
  const all = groupsWith(map, before);
  const levelOk = g => want === null || g.level === want;
  const pick = hit => {
    const hits = all.filter(g => levelOk(g) && hit(g));
    const deepest = Math.max(0, ...hits.map(g => g.level));
    return hits.filter(g => g.level === deepest);
  };
  let chosen = pick(g => g.start <= b && g.end >= a);
  if (!chosen.length) chosen = pick(g => groupHasSummary(g) && groupSummary(g) >= a && groupSummary(g) <= b);
  for (const g of chosen) {
    // Inner groups collapsed on their own (their summary marked), before this one changes.
    const inner = all.filter(o => o.level > g.level && o.start >= g.start && o.end <= g.end && groupHasSummary(o) && groupSummary(o) !== groupSummary(g))
      .filter(o => map[groupSummary(o)]?.collapsed);
    for (let i = g.start; i <= g.end; i++) if (map[i]) map[i] = setHidden(map[i], hide || inner.some(o => groupContains(o, i)));
    if (!groupHasSummary(g)) continue;
    const sm = groupSummary(g);
    if (hide) map[sm] = {...(map[sm] ?? {}), collapsed: true};
    else if (map[sm]) { const {collapsed, ...rest} = map[sm]; if (Object.keys(rest).length) map[sm] = rest; else delete map[sm]; }
  }
  putMap(ctx, si, rows, map);
  return null;
}

/** The outline's level buttons: show lines down to outline level n (1 = only the top-level summaries). */
function showLevels(ctx, p) {
  const level = k => (Number.isInteger(p[k]) ? Math.min(Math.max(p[k], 1), MAX_LEVEL + 1) : null);
  const [rowsN, colsN] = [level('rows'), level('cols')];
  if (rowsN === null && colsN === null) throw bad('data.showLevels', 'give `rows` or `cols`: the outline level to show (1 = top-level summaries only)');
  const si = gridSel(ctx).sheet;
  const sheet = sheetOf(ctx, si);
  for (const [rows, n] of [[true, rowsN], [false, colsN]]) {
    if (n === null) continue;
    const before = summaryBefore(sheet, rows);
    const map = mapOf(ctx, si, rows);
    const groups = groupsWith(map, before);
    for (const k of Object.keys(map)) if (map[k].outline > 0) map[k] = setHidden(map[k], map[k].outline >= n);
    // Inner groups come first, so a summary line shared with the group around it ends up as that outer group says.
    for (const g of groups.filter(groupHasSummary)) {
      const sm = groupSummary(g);
      const e = {...(map[sm] ?? {})};
      if (g.level >= n) e.collapsed = true; else delete e.collapsed;
      const c = clean(e);
      if (c) map[sm] = c; else delete map[sm];
    }
    putMap(ctx, si, rows, map);
  }
  return null;
}

/** Moves the collapsed marks of a line axis to the summary line on its new side. */
function moveMarks(map, wasBefore, on) {
  let marked = groupsWith(map, wasBefore).filter(g => groupHasSummary(g) && map[groupSummary(g)]?.collapsed);
  // A mark on a line that nested groups share moves with the outermost of them whose detail is all hidden, or the outermost when none is.
  const owner = new Map();
  for (const g of marked) {
    const key = [g.collapsed ? 0 : 1, g.level];
    const best = owner.get(groupSummary(g)) ?? key;
    owner.set(groupSummary(g), best[0] < key[0] || (best[0] === key[0] && best[1] <= key[1]) ? best : key);
  }
  marked = marked.filter(g => { const o = owner.get(groupSummary(g)); return o[0] === (g.collapsed ? 0 : 1) && o[1] === g.level; });
  for (const g of marked) { const sm = groupSummary(g); const {collapsed, ...rest} = map[sm]; if (Object.keys(rest).length) map[sm] = rest; else delete map[sm]; }
  for (const g of marked) {
    const moved = {...g, summaryBefore: !on};
    if (groupHasSummary(moved)) { const sm = groupSummary(moved); map[sm] = {...(map[sm] ?? {}), collapsed: true}; }
  }
}

function outlineSettings(ctx, p) {
  const si = targetSheet(ctx, p);
  requireSchema2(ctx, si);
  const sheet = sheetOf(ctx, si);
  const next = {summaryBelow: sheet.summaryBelow !== false, summaryRight: sheet.summaryRight !== false};
  for (const [rows, key] of [[true, 'summaryBelow'], [false, 'summaryRight']]) {
    if (typeof p[key] !== 'boolean') continue;
    const wasBefore = !next[key];
    next[key] = p[key];
    if (wasBefore === !p[key]) continue;
    const map = mapOf(ctx, si, rows);
    moveMarks(map, wasBefore, p[key]);
    putMap(ctx, si, rows, map);
  }
  for (const key of ['summaryBelow', 'summaryRight']) {
    if (typeof p[key] !== 'boolean') continue;
    if (next[key]) { if (ctx.change.get(['sheets', si, key]) !== undefined) ctx.change.delete(['sheets', si, key]); } else ctx.change.set(['sheets', si, key], false);
  }
  return next;
}

const FUNCTIONS = {sum: [9, 'Total'], count: [3, 'Count'], average: [1, 'Average'], max: [4, 'Max'], min: [5, 'Min'], product: [6, 'Product']};

function subtotal(ctx, p) {
  const content = baseDoc(ctx);
  const {sheet: si, range: r} = dataTarget(ctx, p, 'data.subtotal');
  const sheet = requireSchema2(ctx, si);
  const header = p.header !== false;
  const groupCol = colParam(p.groupBy, r.start.col) ?? r.start.col;
  const func = FUNCTIONS[p.function] ? p.function : 'sum';
  const [code, label] = FUNCTIONS[func];
  const cols = Array.isArray(p.columns) && p.columns.length ? p.columns.map(c => colParam(c, r.start.col)).filter(c => c !== null) : [r.end.col];
  const engine = engineFor(content);
  // Group boundaries (header in the first row).
  const groups = [];
  const first = r.start.row + (header ? 1 : 0);
  let start = first;
  const textAt = row => display(valueOf(engine, si, row, groupCol));
  for (let row = first; row <= r.end.row + 1; row++) {
    const cur = textAt(row), prev = textAt(start);
    if (row > r.end.row || cur !== prev) { groups.push([start, row - 1, prev]); start = row; }
  }
  // The totals go below each group, so the outline puts summary rows below their detail.
  if (sheet.summaryBelow === false) ctx.run('data.outlineSettings', {sheet: si, summaryBelow: true});
  // Insert a total row after each group, bottom-up so indices stay valid.
  let inserted = 0;
  for (const [g0, g1, name] of [...groups].reverse()) {
    ctx.run('home.insertRows', {sheet: si, rows: `${g1 + 2}:${g1 + 2}`});
    const row = g1 + 1;
    ctx.run('cell.set', {sheet: si, cell: a1(row, groupCol), input: `${name} ${label}`});
    for (const c of cols) ctx.run('cell.set', {sheet: si, cell: a1(row, c), input: `=SUBTOTAL(${code},${rangeA1(rangeOf(g0, c, g1, c))})`});
    ctx.run('home.bold', {sheet: si, range: rangeA1(rangeOf(row, r.start.col, row, r.end.col)), on: true});
    ctx.run('data.group', {sheet: si, rows: `${g0 + 1}:${g1 + 1}`});
    inserted++;
  }
  const last = r.end.row + inserted + 1;
  ctx.run('home.insertRows', {sheet: si, rows: `${last + 1}:${last + 1}`});
  ctx.run('cell.set', {sheet: si, cell: a1(last, groupCol), input: `Grand ${label}`});
  for (const c of cols) ctx.run('cell.set', {sheet: si, cell: a1(last, c), input: `=SUBTOTAL(${code},${rangeA1(rangeOf(first, c, last - 1, c))})`});
  return {groups: inserted};
}

export default defineCommands({
  family: 'data/outline',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.group', label: 'Group', risk: 'edit', shortcut: 'Alt+Shift+Right',
      description: 'Group the selected rows (or `rows`/`cols`; by: rows|cols for a block of cells, rows by default): one outline level deeper, to level 7.',
      params: s.object({rows: LINES, cols: LINES, by: s.optional(s.enum(['rows', 'cols', 'columns'])), sheet: SHEET}),
      state: hasDoc,
      run: (ctx, p) => group(ctx, p, true),
    },
    {
      id: 'data.ungroup', label: 'Ungroup', risk: 'edit', shortcut: 'Alt+Shift+Left',
      description: 'Ungroup the selected rows or columns: one outline level shallower.',
      params: s.object({rows: LINES, cols: LINES, by: s.optional(s.enum(['rows', 'cols', 'columns'])), sheet: SHEET}),
      state: hasDoc,
      run: (ctx, p) => group(ctx, p, false),
    },
    {
      id: 'data.hideDetail', label: 'Hide Detail', risk: 'edit',
      description: 'Collapse the innermost group holding the lines (or the one at `level`), or the one they summarise.',
      params: s.object({rows: LINES, cols: LINES, by: s.optional(s.enum(['rows', 'cols', 'columns'])), level: s.optional(s.integer({min: 1, max: MAX_LEVEL})), sheet: SHEET}),
      state: hasDoc,
      run: (ctx, p) => detail(ctx, p, true),
    },
    {
      id: 'data.showDetail', label: 'Show Detail', risk: 'edit',
      description: 'Expand the innermost group holding the lines (or the one at `level`), or the one they summarise.',
      params: s.object({rows: LINES, cols: LINES, by: s.optional(s.enum(['rows', 'cols', 'columns'])), level: s.optional(s.integer({min: 1, max: MAX_LEVEL})), sheet: SHEET}),
      state: hasDoc,
      run: (ctx, p) => detail(ctx, p, false),
    },
    {
      id: 'data.showLevels', label: 'Show Outline Levels', risk: 'edit',
      description: 'The outline\'s level buttons: show rows and/or columns down to outline level n (1 shows only the top-level summaries).',
      params: s.object({rows: s.optional(s.integer({min: 1, max: MAX_LEVEL + 1})), cols: s.optional(s.integer({min: 1, max: MAX_LEVEL + 1}))}),
      state: hasDoc,
      run: showLevels,
    },
    {
      id: 'data.outlineSettings', label: 'Outline Settings', risk: 'edit', dialog: 'dialog.outlineSettings',
      description: 'Whether summary rows sit below their detail and summary columns right of it (off puts them above / left). → {summaryBelow, summaryRight}.',
      params: s.object({sheet: SHEET, summaryBelow: s.optional(s.boolean()), summaryRight: s.optional(s.boolean())}),
      state: hasDoc,
      run: outlineSettings,
    },
    {
      id: 'data.subtotal', label: 'Subtotal', risk: 'edit', dialog: 'dialog.subtotal',
      description: 'Insert a SUBTOTAL row under each run of equal values of the `groupBy` column (function: sum|count|average|max|min|product over `columns`), group each run and add a grand total.',
      params: s.object({
        range: s.optional(s.string({min: 1, max: 4096})), sheet: SHEET, groupBy: s.optional(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})])),
        function: s.optional(s.enum(['sum', 'count', 'average', 'max', 'min', 'product'])),
        columns: s.optional(s.array(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})]), {max: 16_384})), header: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: subtotal,
    },
  ],
});
