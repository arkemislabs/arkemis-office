// Home > Styles > Conditional Formatting: Highlight Cells Rules, Top/Bottom Rules, Data Bars, Color
// Scales, Icon Sets, New Rule, Clear Rules and the Rules Manager.
// Translated from gridcraft crates/engine/src/cmd/insert/cond_format.rs (`add_cf`, `clear_cf`,
// `manage_cf`) and cmd/insert.rs (specs) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's
// menus and Rules Manager. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A new rule takes precedence over the older ones (priority 1, the others move down), as in
// Excel. Rules live on their sheet (`conditionalFormats`, lib/cond-format.mjs); the file keeps them.
// What the menus offer is the command's state: `{gallery: 'dataBars' | 'colorScales' | 'iconSets'}`.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, parseRange, rangeA1} from '../../lib/addr.mjs';
import {hasDoc, gridSel, targetRanges, requireSchema2, bad, failed, baseDoc} from '../../lib/edit-targets.mjs';
import {removeRuleCells, setIn} from '../../lib/edit-parts.mjs';
import {tableAt} from '../../lib/table-style.mjs';
import {buildRule, describeRule, COLOR_SCALES, DATA_BAR_COLORS, ICON_SETS} from '../../lib/cond-format.mjs';
import {RANGE, SHEET, UPSTREAM_COMMIT} from '../../lib/format-params.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/insert/cond_format.rs', 'crates/engine/src/cf.rs']};

const listOf = (content, si) => (Array.isArray(content.sheets[si]?.conditionalFormats) ? content.sheets[si].conditionalFormats : []);
const byPriority = list => list.map((e, i) => [e, i]).sort((x, y) => (x[0].priority ?? x[1] + 1) - (y[0].priority ?? y[1] + 1) || x[1] - y[1]).map(x => x[0]);
const areaText = r => (r.start.row === r.end.row && r.start.col === r.end.col ? a1(r.start.row, r.start.col) : rangeA1(r));
const uid = ctx => ctx.host?.uid?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/** The art the ribbon draws for a menu entry: a scale, a bar or an icon row (src/shell/ribbon/TileArt.tsx `cf`). */
const art = (mode, data) => ({kind: 'cf', mode, ...data});

/** The lists the Data Bars, Color Scales and Icon Sets menus show. */
export function galleryItems(gallery) {
  if (gallery === 'dataBars') {
    return [true, false].flatMap(gradient => DATA_BAR_COLORS.map(([id, label, color]) => ({
      id: `${id}.${gradient ? 'gradient' : 'solid'}`, label: `${gradient ? 'Gradient Fill' : 'Solid Fill'}: ${label} Data Bar`, value: `dataBar.${id}${gradient ? '' : '.solid'}`,
      group: gradient ? 'Gradient Fill' : 'Solid Fill', art: art('dataBar', {color, gradient}),
    })));
  }
  if (gallery === 'colorScales') {
    return COLOR_SCALES.map(([id, label, colors]) => ({id, label, value: `colorScale.${id}`, art: art('colorScale', {colors})}));
  }
  if (gallery === 'iconSets') {
    return ICON_SETS.map(([id, group, label]) => ({id, label, value: `iconSet.${id}`, group, art: art('iconSet', {set: id})}));
  }
  return [];
}

function addRule(ctx, p) {
  const content = baseDoc(ctx);
  const {sheet: si, areas} = targetRanges(ctx, p);
  requireSchema2(ctx, si);
  if (!areas.length) throw bad('home.conditionalFormat', 'select cells to format');
  const spec = typeof p.rule === 'object' && p.rule ? p.rule : typeof p.preset === 'string' ? {preset: p.preset} : null;
  if (!spec) throw bad('home.conditionalFormat', 'missing `rule` (or a `preset`)');
  const at = a1(areas[0].start.row, areas[0].start.col);
  let rule;
  try { rule = buildRule(spec, at); } catch (e) { if (e.cfInvalid) throw bad('home.conditionalFormat', e.message); throw e; }
  const existing = byPriority(listOf(content, si)).map((e, i) => ({...e, priority: i + 2}));
  const entry = {id: `cf${uid(ctx)}`, ranges: areas.map(areaText), priority: 1, rule};
  if (spec.stopIfTrue === true) entry.stopIfTrue = true;
  setIn(ctx.change, ['sheets', si, 'conditionalFormats'], [entry, ...existing]);
  return {rules: existing.length + 1, id: entry.id, ranges: entry.ranges};
}

function tableRange(content, si, sel) {
  const hit = tableAt(content.sheets[si], sel.active.row, sel.active.col);
  if (!hit) throw failed('Select a cell in a table first.');
  return hit.range;
}
function pivotRange(content, si, sel) {
  for (const pv of content.sheets[si]?.pivots ?? []) {
    const r = typeof pv.lastRange === 'string' ? parseRange(pv.lastRange) : null;
    if (r && sel.active.row >= r.start.row && sel.active.row <= r.end.row && sel.active.col >= r.start.col && sel.active.col <= r.end.col) return r;
  }
  throw failed('Select a cell in a PivotTable first.');
}

function clearRules(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  if (p.sheet === true) {
    const si = sel.sheet;
    requireSchema2(ctx, si);
    const n = listOf(content, si).length;
    if (n) ctx.change.set(['sheets', si, 'conditionalFormats'], []);
    return {cleared: n};
  }
  const q = typeof p.sheet === 'boolean' ? {...p, sheet: undefined} : p;
  const inTable = p.table === true, inPivot = p.pivot === true;
  const t = inTable || inPivot ? {sheet: sel.sheet, areas: []} : targetRanges(ctx, q);
  const si = t.sheet;
  requireSchema2(ctx, si);
  const before = listOf(content, si).length;
  const areas = inTable ? [tableRange(content, si, sel)] : inPivot ? [pivotRange(content, si, sel)] : t.areas;
  for (const r of areas) removeRuleCells(ctx.change, si, 'conditionalFormats', r);
  const left = ctx.change.get(['sheets', si, 'conditionalFormats']);
  return {cleared: before - (Array.isArray(left) ? left.length : before)};
}

/** What the Rules Manager lists for a sheet: the rules in priority order. */
export function rulesOf(content, si) {
  return byPriority(listOf(content, si)).map(e => ({id: e.id, ranges: [...(e.ranges ?? [])], text: describeRule(e.rule), type: e.rule?.type, stopIfTrue: e.stopIfTrue === true, dxf: e.rule?.dxf ?? null,
    ...(e.rule?.colorScale ? {colors: e.rule.colorScale.colors} : {}), ...(e.rule?.dataBar ? {color: e.rule.dataBar.color} : {}), ...(e.rule?.iconSet ? {set: e.rule.iconSet.iconSet} : {})}));
}

function manageRules(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetRanges(ctx, {sheet: p.sheet}).sheet;
  requireSchema2(ctx, si);
  const cur = byPriority(listOf(content, si));
  if (p.list === true || (p.rules === undefined && p.delete === undefined && p.moveUp === undefined && p.moveDown === undefined)) return {rules: rulesOf(content, si)};
  let next = cur.map(e => structuredClone(e));
  const find = id => { const i = next.findIndex(e => e.id === id); if (i < 0) throw bad('home.manageRules', `no rule \`${id}\``); return i; };
  if (Array.isArray(p.rules)) {
    // The whole list as the dialog leaves it: its order, the rules it kept, the edits it made.
    next = p.rules.map(r => {
      const i = next.findIndex(e => e.id === r.id);
      const base = i >= 0 ? next[i] : {id: `cf${uid(ctx)}`, ranges: [], rule: null};
      const out = {...base};
      if (Array.isArray(r.ranges)) {
        out.ranges = r.ranges.map(x => { const pr = parseRange(String(x).replace(/\$/g, '')); if (!pr) throw bad('home.manageRules', `not a range: \`${x}\``); return rangeA1(pr); });
      } else if (typeof r.ranges === 'string') {
        out.ranges = r.ranges.split(',').map(x => { const pr = parseRange(x.trim().replace(/\$/g, '')); if (!pr) throw bad('home.manageRules', `not a range: \`${x}\``); return rangeA1(pr); });
      }
      if (!out.ranges.length) throw bad('home.manageRules', 'a rule needs the cells it applies to');
      if (r.stopIfTrue !== undefined) { if (r.stopIfTrue) out.stopIfTrue = true; else delete out.stopIfTrue; }
      if (r.spec) {
        try { const first = parseRange(out.ranges[0]).start;
        out.rule = buildRule(r.spec, a1(first.row, first.col)); } catch (e) { if (e.cfInvalid) throw bad('home.manageRules', e.message); throw e; }
      }
      if (!out.rule) throw bad('home.manageRules', `rule \`${r.id}\` has no definition`);
      return out;
    });
  }
  if (p.delete !== undefined) next.splice(find(p.delete), 1);
  if (p.moveUp !== undefined) { const i = find(p.moveUp); if (i > 0) [next[i - 1], next[i]] = [next[i], next[i - 1]]; }
  if (p.moveDown !== undefined) { const i = find(p.moveDown); if (i < next.length - 1) [next[i + 1], next[i]] = [next[i], next[i + 1]]; }
  next.forEach((e, i) => { e.priority = i + 1; });
  ctx.change.set(['sheets', si, 'conditionalFormats'], next);
  return {rules: next.length};
}

export default defineCommands({
  family: 'format/conditional',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'home.conditionalFormat', label: 'Conditional Formatting', risk: 'edit', dialog: 'dialog.cfNewRule',
      description: 'Add a conditional-format rule to a range (default: the selection): rule {type: cellIs|expression|containsText|notContainsText|beginsWith|endsWith|blanks|noBlanks|errors|noErrors|duplicate|unique|top10|aboveAverage|timePeriod|colorScale|dataBar|iconSet, operator, value, value2, text, formula, rank, percent, bottom, below, period, colors, color, gradient, set, preset|style}, or preset `dataBar.blue`, `colorScale.green-yellow-red`, `iconSet.3Arrows`. A new rule goes first.',
      params: s.object({range: RANGE, sheet: SHEET, rule: s.optional(s.record(s.any())), preset: s.optional(s.string({min: 1, max: 80})), gallery: s.optional(s.string({max: 40}))}),
      state(ctx, p) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        return p?.gallery ? {enabled: true, value: galleryItems(p.gallery)} : st;
      },
      run: addRule,
    },
    {
      id: 'home.clearRules', label: 'Clear Rules', risk: 'edit',
      description: 'Clear the conditional-format rules of a range (default: the selection), of the whole sheet (sheet: true), of the table or PivotTable at the active cell.',
      params: s.object({range: RANGE, sheet: s.optional(s.union([s.boolean(), s.integer({min: 0}), s.string({min: 1, max: 300})])), table: s.optional(s.boolean()), pivot: s.optional(s.boolean())}),
      state: ctx => hasDoc(ctx),
      run: clearRules,
    },
    {
      id: 'home.manageRules', label: 'Manage Rules…', risk: 'edit', dialog: 'dialog.manageRules',
      description: 'List (list: true) or change the conditional-format rules of a sheet: delete, moveUp or moveDown a rule by id, or set the whole ordered list (`rules`: [{id, ranges, stopIfTrue, spec?}]).',
      params: s.object({sheet: SHEET, list: s.optional(s.boolean()), delete: s.optional(s.string({max: 80})), moveUp: s.optional(s.string({max: 80})), moveDown: s.optional(s.string({max: 80})),
        rules: s.optional(s.array(s.record(s.any())))}),
      state: ctx => hasDoc(ctx),
      run: manageRules,
    },
  ],
});

