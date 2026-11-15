// Insert > Timeline and PivotTable Analyze > Filter > Insert Timeline: a timeline over a date field of a PivotTable; clicking periods filters the report.
// Not in gridcraft (it has no timelines): Excel's behaviour, not checked against upstream.
//
// A timeline is a slicer-list entry with `timeline: true` (lib/timeline.mjs), so it is moved, sized, deleted, connected to other PivotTables (Report
// Connections, Filter Connections) and styled (TimeSlicerStyleLight1 to 6, Dark1 to 6) like a slicer. Its period is the date field's filter in each connected
// PivotTable. Time levels: years, quarters, months, days. A click on a period selects it; Shift extends the selection from the last click; the clear button shows
// all periods again (slicer.clear).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2} from '../lib/edit-targets.mjs';
import {bad, failed, baseDoc} from '../lib/data-common.mjs';
import {a1, parseCell, parseRange, MAX_COLS, MAX_ROWS} from '../lib/addr.mjs';
import {readSource} from '../lib/pivot.mjs';
import {pivotByName} from '../lib/slicer.mjs';
import {TIME_STYLES, TIME_DEFAULT_STYLE} from '../lib/slicer.mjs';
import {TIME_LEVELS, timelinePeriods, periodStart, nextStart, dateSpan} from '../lib/timeline.mjs';
import {parseInput} from '../lib/parse.mjs';
import {nextObjectId, objectSelection} from '../lib/objects.mjs';
import {guardObjects} from './insert/charts.mjs';
import {findSlicer, applyTimeline, pivotUnderSelection, slicerState} from './slicer.mjs';

const UPSTREAM = {repo: 'office', files: ['Excel PivotTable Analyze > Filter > Insert Timeline', 'Excel Timeline tab']};
const SLICER = s.optional(s.integer({min: 0}));
const sysOf = content => (content.dateSystem === 1904 ? 1904 : 1900);

/** The date fields of a PivotTable's source: [name]. */
export function dateFields(content, si, pt) {
  try { const src = readSource(content, pt.source, si); return src.headers.filter((_, c) => src.dates[c]); } catch { return []; }
}

function insertTimeline(ctx, p) {
  const content = baseDoc(ctx);
  const named = typeof p.pivot === 'string' && p.pivot.trim() ? pivotByName(content, p.pivot.trim()) : null;
  if (typeof p.pivot === 'string' && p.pivot.trim() && !named) throw bad('insert.timeline', 'no PivotTable named ' + p.pivot);
  const hit = named ?? pivotUnderSelection(ctx);
  if (!hit) throw failed('Select a cell in a PivotTable first.');
  const [psi, , pt] = hit;
  requireSchema2(ctx, psi);
  guardObjects(content.sheets[psi]);
  const dates = dateFields(content, psi, pt);
  if (!dates.length) throw failed('The PivotTable has no field that holds dates, so it cannot have a timeline.');
  const wanted = Array.isArray(p.column) ? p.column : typeof p.column === 'string' ? [p.column] : [];
  const names = [];
  for (const c of wanted) {
    const f = dates.find(d => d.toLowerCase() === String(c).toLowerCase());
    if (!f) throw failed(`${c} is not a date field of the PivotTable.`);
    if (!names.includes(f)) names.push(f);
  }
  if (!names.length) names.push(dates[0]);
  const area = pt.lastRange ? parseRange(pt.lastRange) : null;
  let at = area ? {row: area.start.row, col: Math.min(MAX_COLS - 1, area.end.col + 2)} : {row: 0, col: 0};
  if (typeof p.at === 'string' && p.at.trim()) {
    const c = parseCell(p.at.replace(/^.*!/, '').replace(/\$/g, ''));
    if (!c || c.row >= MAX_ROWS || c.col >= MAX_COLS) throw bad('insert.timeline', 'not a cell: ' + p.at);
    at = c;
  }
  const width = Math.min(10000, Math.max(120, Number.isFinite(p.width) ? p.width : 400)), height = Math.min(10000, Math.max(100, Number.isFinite(p.height) ? p.height : 130));
  let id = nextObjectId(content);
  const level = TIME_LEVELS.includes(p.level) ? p.level : 'months';
  const made = names.map((name, k) => ({id: id++, timeline: true, pivot: pt.name, pivots: [pt.name], field: name, column: name, caption: name, level, from: null, until: null, scroll: 0, style: TIME_DEFAULT_STYLE,
    anchor: {cell: a1(at.row, at.col), dx: 4, dy: 4 + k * (height + 12), width, height, mode: 'moveOnly'}, selected: null, columns: 1}));
  ctx.change.set(['sheets', psi, 'slicers'], [...(content.sheets[psi].slicers ?? []), ...made]);
  ctx.setSelection(objectSelection(ctx.doc.sheets[psi], 'slicer', made[made.length - 1].id));
  const ids = made.map(m => m.id);
  return ids.length === 1 ? {timeline: ids[0]} : {timeline: ids[0], timelines: ids};
}

const timelineOf = (ctx, p) => {
  const [si, i] = findSlicer(ctx, {slicer: p.timeline ?? p.slicer});
  const tl = baseDoc(ctx).sheets[si].slicers[i];
  if (!tl.timeline) throw failed('Select a timeline first.');
  return [si, i, tl];
};
const dateOf = (content, v) => {
  if (typeof v === 'number') return v;
  const r = parseInput(String(v ?? '').trim(), sysOf(content));
  if (typeof r.value !== 'number') throw failed(`${v} is not a date.`);
  return r.value;
};

/** Timeline Select: the periods `index` (and, with `extend`, everything between the last pick and it), or the dates \`from\` up to \`until\`. */
function selectPeriod(ctx, p) {
  const content = baseDoc(ctx);
  const [si, i, tl] = timelineOf(ctx, p);
  const base = ['sheets', si, 'slicers', i];
  let from, until, pick = tl.pick ?? null;
  if (p.from !== undefined) {
    from = dateOf(content, p.from);
    const lvl = TIME_LEVELS.includes(tl.level) ? tl.level : 'months';
    from = periodStart(sysOf(content), from, lvl);
    until = p.until !== undefined ? nextStart(sysOf(content), periodStart(sysOf(content), dateOf(content, p.until) - 1e-9, lvl), lvl) : nextStart(sysOf(content), from, lvl);
  } else {
    const periods = timelinePeriods(content, tl);
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= periods.length) throw bad('timeline.select', 'give `index` of a period, or `from` and `until` dates', {path: '/index'});
    const a = p.extend === true && pick !== null && pick < periods.length ? Math.min(pick, p.index) : p.index;
    const b = p.extend === true && pick !== null && pick < periods.length ? Math.max(pick, p.index) : p.index;
    from = periods[a].start; until = periods[b].end;
    if (p.extend !== true) pick = p.index;
  }
  ctx.change.set([...base, 'from'], from);
  ctx.change.set([...base, 'until'], until);
  ctx.change.set([...base, 'pick'], pick);
  applyTimeline(ctx, {...tl, from, until});
  return {from, until};
}

function setLevel(ctx, p) {
  const content = baseDoc(ctx);
  const [si, i, tl] = timelineOf(ctx, p);
  const level = p.level ?? TIME_LEVELS[(TIME_LEVELS.indexOf(tl.level ?? 'months') + 1) % TIME_LEVELS.length];
  if (!TIME_LEVELS.includes(level)) throw bad('timeline.level', '`level` is years, quarters, months or days', {path: '/level'});
  const base = ['sheets', si, 'slicers', i];
  ctx.change.set([...base, 'level', ], level);
  ctx.change.set([...base, 'scroll'], 0);
  ctx.change.set([...base, 'pick'], null);
  // The period that was selected is kept, snapped to the new level.
  if (tl.from !== null && tl.from !== undefined) {
    const sys = sysOf(content);
    const from = periodStart(sys, tl.from, level);
    const until = nextStart(sys, periodStart(sys, (tl.until ?? tl.from + 1) - 1e-9, level), level);
    ctx.change.set([...base, 'from'], from);
    ctx.change.set([...base, 'until'], until);
    applyTimeline(ctx, {...tl, level, from, until});
  }
  return {level};
}

function scroll(ctx, p) {
  const content = baseDoc(ctx);
  const [si, i, tl] = timelineOf(ctx, p);
  const total = timelinePeriods(content, tl).length;
  const next = Math.min(Math.max(0, (tl.scroll ?? 0) + (Number.isInteger(p.by) ? p.by : 1)), Math.max(0, total - 1));
  ctx.change.set(['sheets', si, 'slicers', i, 'scroll'], next);
  return {scroll: next};
}

export default defineCommands({
  family: 'timeline',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.timeline', label: 'Timeline', risk: 'edit', dialog: 'dialog.insertTimelines',
      description: 'Insert a timeline over a date field of a PivotTable: `pivot` (default the one at the selection), `column` (a date field name, or a list for one timeline each; default the first date field), `level` (years, quarters, months, days), `at`, `width`, `height`. Returns {timeline}.',
      params: s.object({pivot: s.optional(s.string({max: 255})), column: s.optional(s.union([s.string({max: 255}), s.array(s.string({max: 255}), {max: 64})])), level: s.optional(s.enum(TIME_LEVELS)),
        at: s.optional(s.string({max: 100})), width: s.optional(s.number({min: 120, max: 10000})), height: s.optional(s.number({min: 100, max: 10000}))}),
      state: hasDoc, run: insertTimeline},
    {id: 'timeline.select', label: 'Timeline Period', risk: 'edit',
      description: 'Pick the period of a timeline: `index` (a period of its level; with `extend` everything from the last pick), or `from` and `until` dates (each snapped to a whole period). The report of every connected PivotTable keeps those dates. Clear it with slicer.clear.',
      params: s.object({timeline: SLICER, slicer: SLICER, index: s.optional(s.integer({min: 0, max: 100000})), extend: s.optional(s.boolean()), from: s.optional(s.union([s.string({max: 64}), s.number()])), until: s.optional(s.union([s.string({max: 64}), s.number()]))}),
      state: slicerState, run: selectPeriod},
    {id: 'timeline.level', label: 'Time Level', risk: 'edit', description: 'The time level of a timeline: years, quarters, months or days (default: the next one). The selected period is kept, snapped to the new level.',
      params: s.object({timeline: SLICER, slicer: SLICER, level: s.optional(s.enum(TIME_LEVELS))}), state: slicerState, run: setLevel},
    {id: 'timeline.scroll', label: 'Scroll Timeline', risk: 'edit', description: 'Scroll the periods of a timeline by `by` periods (default 1).',
      params: s.object({timeline: SLICER, slicer: SLICER, by: s.optional(s.integer({min: -100000, max: 100000}))}), state: slicerState, run: scroll},
  ],
});

export {TIME_STYLES, dateSpan};
