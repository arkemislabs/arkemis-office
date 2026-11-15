// Outline groups (Data > Group) of a sheet's rows or columns: the runs of lines at or above each
// outline level, as the grid draws them (brackets, - / + buttons, level buttons) and the Show and
// Hide Detail commands act on them. Summary rows sit below their detail and summary columns right
// of it, or above / left of it when the sheet's outline settings say so (`summaryBelow`,
// `summaryRight`, both true when absent).
// Translated from gridcraft crates/engine/src/outline.rs (`OutlineGroup`, `summary_before`,
// `max_level`, `groups_with`, `group_at`, with its tests) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A sheet's `rows` / `cols` are maps from a 0-based line index to {outline?, hidden?, collapsed?, ...}.
// No DOM, no Node built-ins.

/** The deepest outline level XLSX allows. */
export const MAX_LEVEL = 7;

/** Sorted [index, info] pairs of a line map. */
const entries = lines => Object.keys(lines ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b).map(i => [i, lines[i]]);

/** Whether the sheet's summary rows (`rows`) or summary columns sit before their detail. */
export const summaryBefore = (sheet, rows) => (rows ? sheet?.summaryBelow === false : sheet?.summaryRight === false);

/** The deepest outline level used by these lines (0 = no outline). */
export function maxLevel(lines) {
  let m = 0;
  for (const k in lines ?? {}) m = Math.max(m, Math.min(lines[k]?.outline ?? 0, MAX_LEVEL));
  return m;
}

/** The summary line of a group: just after `end` (before `start` when summaryBefore). */
export const groupSummary = g => (g.summaryBefore ? Math.max(g.start - 1, 0) : g.end + 1);
export const groupContains = (g, line) => line >= g.start && line <= g.end;
/** Whether the summary line exists: a group at the first line (summary before) or the last has none. */
export const groupHasSummary = g => !groupContains(g, groupSummary(g));

/**
 * Every group, ordered by where it ends (inner groups before the group around them), with its
 * summary line before the detail when `before` is set. {level, start, end, collapsed, summaryBefore}.
 */
export function groupsWith(lines, before = false) {
  const out = [];
  // Open group per level (index level - 1): start line and whether all its lines are hidden.
  const open = new Array(MAX_LEVEL).fill(null);
  let prev = null;
  const closeFrom = (from, end) => {
    for (let level = MAX_LEVEL; level >= from; level--) {
      const slot = open[level - 1];
      if (slot) { open[level - 1] = null; out.push({level, start: slot.start, end, collapsed: slot.hidden, summaryBefore: before}); }
    }
  };
  for (const [i, info] of entries(lines)) {
    if (!(info?.outline > 0)) continue;
    const level = Math.min(info.outline, MAX_LEVEL);
    // A gap ends every group.
    if (prev !== null && prev + 1 !== i) closeFrom(1, prev);
    else if (prev !== null && level < MAX_LEVEL) closeFrom(level + 1, prev);
    for (let k = 0; k < level; k++) {
      if (open[k]) open[k].hidden = open[k].hidden && !!info.hidden;
      else open[k] = {start: i, hidden: !!info.hidden};
    }
    prev = i;
  }
  if (prev !== null) closeFrom(1, prev);
  return out;
}

/** Every group with its summary line after the detail. */
export const groups = lines => groupsWith(lines, false);

/** The group at `level` that holds `line`. */
export const groupAt = (lines, line, level) => groups(lines).find(g => g.level === level && groupContains(g, line)) ?? null;

/** The outline of one direction for painting: {levels, groups}. */
export function axisOf(sheet, rows) {
  const lines = rows ? sheet?.rows : sheet?.cols;
  return {levels: maxLevel(lines), groups: groupsWith(lines, summaryBefore(sheet, rows))};
}
