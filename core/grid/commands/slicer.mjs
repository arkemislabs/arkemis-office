// Slicers (Insert > Slicer, Table Design > Insert Slicer, the Slicer tab): on-sheet widgets that filter one column of a table by
// clicking value tiles. A slicer is a thin front end over the AutoFilter: its selection is written as a values criterion into the
// sheet's autofilter over the table's range and the rows that fail are hidden. A new slicer selects everything (no filter).
// Translated from gridcraft crates/engine/src/cmd/slicer.rs at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A slicer is stored on its sheet (sheet.slicers[]): {id, table, column, caption, anchor, selected: null | [values], columns}.
// A slicer on a PivotTable field (Excel's PivotTable slicers, not in gridcraft: not checked against upstream) is {id, pivot, pivots, field, column
// (the field, for the caption), caption, anchor, selected, columns, style}: its selection is the field's report filter in each PivotTable it is connected to
// (Report Connections, Filter Connections). Slicer Styles are Excel's names (`style`, drawn by lib/slicer.mjs `slicerLook`).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2} from '../lib/edit-targets.mjs';
import {bad, failed, baseDoc, setRowsHidden} from '../lib/data-common.mjs';
import {a1, parseCell, parseRange, MAX_COLS, MAX_ROWS} from '../lib/addr.mjs';
import {readSource} from '../lib/pivot.mjs';
import {tableByName, tableRanges} from '../model/sheet.mjs';
import {columnValues, slicerItems, pivotByName, pivotFieldItems, isPivotSlicer, slicerPivots, SLICER_STYLES, SLICER_DEFAULT_STYLE, TIME_STYLES} from '../lib/slicer.mjs';
import {inAxes} from '../lib/pivot.mjs';
import {slicerLook} from '../lib/slicer.mjs';
import {update as updatePivot} from './pivot.mjs';
import {computeFilter} from '../lib/data-filter.mjs';
import {protectionOf} from '../lib/format-ranges.mjs';
import {nextObjectId, selectedObject, objectSelection} from '../lib/objects.mjs';
import {guardObjects} from './insert/charts.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/slicer.rs']};
const SLICER = s.optional(s.integer({min: 0}));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The slicer a call names (by id on any sheet), else the selected one, else the last on the active sheet: [sheet, index]. */
export function findSlicer(ctx, p) {
  const content = baseDoc(ctx);
  const find = id => { for (let si = 0; si < content.sheets.length; si++) { const i = (content.sheets[si].slicers ?? []).findIndex(x => x.id === id); if (i >= 0) return [si, i]; } return null; };
  if (Number.isInteger(p.slicer)) return find(p.slicer) ?? (() => { throw bad('slicer', 'no slicer ' + p.slicer); })();
  const sel = selectedObject(content, ctx.selection);
  if (sel?.kind === 'slicer') { const hit = find(sel.id); if (hit) return hit; }
  const active = gridSel(ctx).sheet;
  const list = content.sheets[active].slicers ?? [];
  if (list.length) return [active, list.length - 1];
  throw bad('slicer', 'no slicer on this sheet');
}
/** [sheet, index, pivot] of the PivotTable whose report holds the active cell, or null. */
export function pivotUnderSelection(ctx) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const list = content.sheets[sel.sheet]?.pivots ?? [];
  const pi = list.findIndex(pt => { const r = pt.lastRange && parseRange(pt.lastRange); return r && sel.active.row >= r.start.row && sel.active.row <= r.end.row && sel.active.col >= r.start.col && sel.active.col <= r.end.col; });
  return pi >= 0 ? [sel.sheet, pi, list[pi]] : null;
}
export const slicerState = ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  return ctx.doc.sheets.some(sh => (sh.slicers ?? []).length) ? {enabled: true} : {enabled: false, reason: 'there is no slicer'};
};
export const selectedSlicer = ctx => { try { const [si, i] = findSlicer(ctx, {}); return ctx.doc.sheets[si].slicers[i]; } catch { return null; } };

/** Writes the slicer's selection into the sheet filter over its table and hides the rows that fail it. */
function reapply(ctx, sl, selected) {
  const content = baseDoc(ctx);
  const tb = tableByName(content, sl.table);
  if (!tb) return;
  const [tsi, t] = tb;
  const ci = (t.columns ?? []).findIndex(c => eq(c.name, sl.column));
  if (ci < 0) return;
  const g = tableRanges(t);
  const sheet = content.sheets[tsi];
  const af = ctx.change.get(['sheets', tsi, 'autofilter']) ?? sheet.autofilter ?? {range: t.range};
  const off = g.range.start.col + ci - (typeof af.range === 'string' ? parseCol(af.range) : g.range.start.col);
  const criteria = {...(af.criteria ?? {})};
  delete criteria[off];
  if (selected) criteria[off] = {type: 'values', values: [...selected], blanks: false};
  const next = {range: af.range};
  if (Object.keys(criteria).length) next.criteria = criteria;
  ctx.change.set(['sheets', tsi, 'autofilter'], next);
  setRowsHidden(ctx.change, baseDoc(ctx), tsi, computeFilter(baseDoc(ctx), tsi, next));
}
const parseCol = range => { const c = parseCell(String(range).split(':')[0]); return c ? c.col : 0; };

/** A PivotTable's report filter on `field`: the shown items, or null for all (pivot.filter's rules). */
function setFilterOn(pt, src, field, selected) {
  const c = src.col(field);
  if (c < 0) return;
  const name = src.headers[c];
  const i = pt.filters.findIndex(f => eq(f.sourceCol, name));
  if (i >= 0 && selected === null) { if (inAxes(pt, name)) pt.filters.splice(i, 1); else pt.filters[i].selected = null; }
  else if (i >= 0) pt.filters[i].selected = selected;
  else if (selected) pt.filters.push({sourceCol: name, selected});
}

/** A timeline's period on a PivotTable: the date field kept to [from, until), or every date again when `from` is null. */
export function setDateFilter(pt, src, field, from, until) {
  const c = src.col(field);
  if (c < 0) return;
  const name = src.headers[c];
  const rest = (pt.dateFilters ?? []).filter(d => !eq(d.field, name));
  if (from !== null && from !== undefined) rest.push({field: name, from, until: until ?? null});
  if (rest.length) pt.dateFilters = rest; else delete pt.dateFilters;
}
/** What a slicer or timeline filters on a PivotTable now / no longer. */
const applyOn = (pt, src, sl) => (sl.timeline ? setDateFilter(pt, src, sl.field, sl.from ?? null, sl.until ?? null) : setFilterOn(pt, src, sl.field, sl.selected ?? null));
const clearOn = (pt, src, sl) => (sl.timeline ? setDateFilter(pt, src, sl.field, null, null) : setFilterOn(pt, src, sl.field, null));
const filtering = sl => (sl.timeline ? sl.from !== null && sl.from !== undefined : !!sl.selected);
/** Writes a timeline's period into every PivotTable it is connected to. */
export function applyTimeline(ctx, tl) {
  for (const name of slicerPivots(tl)) {
    if (!pivotByName(ctx.doc, name)) continue;
    updatePivot(ctx, {pivot: name}, (pt, src) => { setDateFilter(pt, src, tl.field, tl.from ?? null, tl.until ?? null); return {}; });
  }
}

/** Writes a slicer's selection where it filters: the sheet filter over its table, or the field's filter in each connected PivotTable. */
function apply(ctx, sl, selected) {
  if (sl.timeline) { applyTimeline(ctx, {...sl, from: null, until: null}); return; }
  if (!isPivotSlicer(sl)) { reapply(ctx, sl, selected); return; }
  for (const name of slicerPivots(sl)) {
    if (!pivotByName(ctx.doc, name)) continue;
    updatePivot(ctx, {pivot: name}, (pt, src) => { setFilterOn(pt, src, sl.field, selected); return {}; });
  }
}
const itemsOf = (content, si, sl) => (isPivotSlicer(sl) ? pivotFieldItems(content, sl.pivot, sl.field) : columnValues(content, si, sl.table, sl.column));

function refuseFilter(sheet) {
  const pr = protectionOf(sheet);
  if (pr && !pr.autofilter) throw failed("Filtering isn't allowed on this protected sheet (Review > Unprotect Sheet).");
}

// ---------------------------------------------------------------- commands

/** Slicers on the fields of a PivotTable (`pivot`, default the one at the selection): one for each name in `column`. */
function insertPivotSlicer(ctx, p, hit) {
  const content = baseDoc(ctx);
  const [psi, , pt] = hit;
  requireSchema2(ctx, psi);
  guardObjects(content.sheets[psi]);
  let src;
  try { src = readSource(content, pt.source, psi); } catch (e) { throw failed(e.message); }
  const wanted = Array.isArray(p.column) ? p.column : typeof p.column === 'string' ? [p.column] : [];
  const names = [];
  for (const c of wanted) {
    const k = src.col(c);
    if (k < 0) throw bad('insert.slicer', 'the PivotTable has no field ' + c);
    if (!names.includes(src.headers[k])) names.push(src.headers[k]);
  }
  if (!names.length) { if (!src.headers.length) throw bad('insert.slicer', 'the PivotTable has no fields'); names.push(src.headers[0]); }
  const area = pt.lastRange ? parseRange(pt.lastRange) : null;
  let at = area ? {row: area.start.row, col: Math.min(MAX_COLS - 1, area.end.col + 2)} : {row: 0, col: 0};
  if (typeof p.at === 'string' && p.at.trim()) {
    const c = parseCell(p.at.replace(/^.*!/, '').replace(/\$/g, ''));
    if (!c || c.row >= MAX_ROWS || c.col >= MAX_COLS) throw bad('insert.slicer', 'not a cell: ' + p.at);
    at = c;
  }
  const columns = Math.min(10, Math.max(1, Number.isInteger(p.columns) ? p.columns : 1));
  const width = Math.min(10000, Math.max(60, Number.isFinite(p.width) ? p.width : 168));
  const height = Math.min(10000, Math.max(60, Number.isFinite(p.height) ? p.height : 200));
  let id = nextObjectId(content);
  const made = names.map((name, k) => ({id: id++, pivot: pt.name, pivots: [pt.name], field: name, column: name, caption: name, style: SLICER_DEFAULT_STYLE,
    anchor: {cell: a1(at.row, at.col), dx: 4 + k * (width + 12), dy: 4, width, height, mode: 'moveOnly'}, selected: null, columns}));
  ctx.change.set(['sheets', psi, 'slicers'], [...(content.sheets[psi].slicers ?? []), ...made]);
  ctx.setSelection(objectSelection(ctx.doc.sheets[psi], 'slicer', made[made.length - 1].id));
  const ids = made.map(m => m.id);
  return ids.length === 1 ? {slicer: ids[0]} : {slicer: ids[0], slicers: ids};
}

function insertSlicer(ctx, p) {
  const content = baseDoc(ctx);
  // A cell in a PivotTable's report (and no table named) gives PivotTable slicers.
  const named = typeof p.pivot === 'string' && p.pivot.trim() ? pivotByName(content, p.pivot.trim()) : null;
  if (typeof p.pivot === 'string' && p.pivot.trim() && !named) throw bad('insert.slicer', 'no PivotTable named ' + p.pivot);
  if (named) return insertPivotSlicer(ctx, p, named);
  if (!(typeof p.table === 'string' && p.table.trim())) {
    const there = pivotUnderSelection(ctx);
    if (there) return insertPivotSlicer(ctx, p, there);
  }
  let si, t;
  if (typeof p.table === 'string' && p.table.trim()) {
    const hit = tableByName(content, p.table.trim());
    if (!hit) throw bad('insert.slicer', 'no table named ' + p.table);
    [si, t] = hit;
  } else {
    const sel = gridSel(ctx);
    si = sel.sheet;
    t = (content.sheets[si].tables ?? []).find(x => { const r = tableRanges(x).range; return sel.active.row >= r.start.row && sel.active.row <= r.end.row && sel.active.col >= r.start.col && sel.active.col <= r.end.col; });
    if (!t) throw failed('Select a cell inside a table first, or pass table.');
  }
  requireSchema2(ctx, si);
  guardObjects(content.sheets[si]);
  const g = tableRanges(t);
  const names = [];
  const wanted = Array.isArray(p.column) ? p.column : typeof p.column === 'string' ? [p.column] : [];
  for (const c of wanted) {
    const hit = (t.columns ?? []).find(x => eq(x.name, c));
    if (!hit) throw bad('insert.slicer', 'table has no column ' + c);
    if (!names.includes(hit.name)) names.push(hit.name);
  }
  if (!names.length) {
    const sel = gridSel(ctx);
    const idx = sel.sheet === si && sel.active.col >= g.range.start.col && sel.active.col - g.range.start.col < (t.columns ?? []).length ? sel.active.col - g.range.start.col : 0;
    const first = t.columns?.[idx]?.name;
    if (!first) throw bad('insert.slicer', 'the table has no columns');
    names.push(first);
  }
  let at = {row: g.range.start.row, col: Math.min(MAX_COLS - 1, g.range.end.col + 2)};
  if (typeof p.at === 'string' && p.at.trim()) {
    const c = parseCell(p.at.replace(/^.*!/, '').replace(/\$/g, ''));
    if (!c || c.row >= MAX_ROWS || c.col >= MAX_COLS) throw bad('insert.slicer', 'not a cell: ' + p.at);
    at = c;
  }
  const columns = Math.min(10, Math.max(1, Number.isInteger(p.columns) ? p.columns : 1));
  const width = Math.min(10000, Math.max(60, Number.isFinite(p.width) ? p.width : 168));
  const height = Math.min(10000, Math.max(60, Number.isFinite(p.height) ? p.height : 200));
  const ids = [];
  let id = nextObjectId(content);
  const made = names.map((name, k) => ({id: id++, table: t.name, column: name, caption: name,
    anchor: {cell: a1(at.row, at.col), dx: 4 + k * (width + 12), dy: 4, width, height, mode: 'moveOnly'}, selected: null, columns}));
  ctx.change.set(['sheets', si, 'slicers'], [...(content.sheets[si].slicers ?? []), ...made]);
  for (const m of made) ids.push(m.id);
  ctx.setSelection(objectSelection(ctx.doc.sheets[si], 'slicer', ids[ids.length - 1]));
  return ids.length === 1 ? {slicer: ids[0]} : {slicer: ids[0], slicers: ids};
}

function toggle(ctx, p) {
  const [si, i] = findSlicer(ctx, p);
  const content = baseDoc(ctx);
  const sl = content.sheets[si].slicers[i];
  if (sl.timeline) throw failed('Click a period on the timeline instead.');
  if (!isPivotSlicer(sl)) refuseFilter(content.sheets[si]);
  if (typeof p.value !== 'string' && typeof p.value !== 'number') throw bad('slicer.toggle', 'missing value');
  const value = String(p.value);
  const all = itemsOf(content, si, sl);
  const hit = all.find(v => eq(v, value));
  if (!hit) throw bad('slicer.toggle', 'value is not in the column');
  let next;
  if (p.multi === true) {
    const set = [...(sl.selected ?? all)];
    const pos = set.findIndex(x => eq(x, value));
    if (pos >= 0) set.splice(pos, 1); else set.push(hit);
    // Everything selected is the same as no filter.
    // (Nothing selected is the same: Excel shows everything again.)
    next = !set.length || (set.length === all.length && all.every(a => set.some(x => eq(x, a)))) ? null : set;
  } else {
    // A single click shows only this value; clicking the sole selected value clears the filter.
    next = sl.selected && sl.selected.length === 1 && eq(sl.selected[0], value) ? null : [hit];
  }
  ctx.change.set(['sheets', si, 'slicers', i, 'selected'], next);
  apply(ctx, sl, next);
  return {selected: next};
}

function selectAll(ctx, p) {
  const [si, i] = findSlicer(ctx, p);
  const sl = baseDoc(ctx).sheets[si].slicers[i];
  if (sl.timeline) { ctx.change.set(['sheets', si, 'slicers', i, 'from'], null); ctx.change.set(['sheets', si, 'slicers', i, 'until'], null); applyTimeline(ctx, {...sl, from: null, until: null}); return {from: null, until: null}; }
  if (!isPivotSlicer(sl)) refuseFilter(baseDoc(ctx).sheets[si]);
  ctx.change.set(['sheets', si, 'slicers', i, 'selected'], null);
  apply(ctx, sl, null);
  return {selected: null};
}

function deleteSlicer(ctx, p) {
  const [si, i] = findSlicer(ctx, p);
  const content = baseDoc(ctx);
  const sl = content.sheets[si].slicers[i];
  guardObjects(content.sheets[si]);
  apply(ctx, sl, null);
  const rest = (ctx.doc.sheets[si].slicers ?? []).filter(x => x.id !== sl.id);
  if (rest.length) ctx.change.set(['sheets', si, 'slicers'], rest); else ctx.change.delete(['sheets', si, 'slicers']);
  return {};
}

function setSlicer(ctx, p) {
  const [si, i] = findSlicer(ctx, p);
  const content = baseDoc(ctx);
  guardObjects(content.sheets[si]);
  const sl = content.sheets[si].slicers[i];
  const base = ['sheets', si, 'slicers', i];
  if (typeof p.caption === 'string') {
    const c = p.caption.trim();
    if (!c) throw failed('Enter a caption for the slicer.');
    ctx.change.set([...base, 'caption'], c);
  }
  if (Number.isInteger(p.columns)) ctx.change.set([...base, 'columns'], Math.min(10, Math.max(1, p.columns)));
  if (Number.isFinite(p.width)) ctx.change.set([...base, 'anchor', 'width'], Math.min(10000, Math.max(60, p.width)));
  if (Number.isFinite(p.height)) ctx.change.set([...base, 'anchor', 'height'], Math.min(10000, Math.max(60, p.height)));
  return {slicer: sl.id};
}

const valueState = pick => ctx => {
  const st = slicerState(ctx);
  if (!st.enabled) return st;
  const sl = selectedSlicer(ctx);
  return sl ? {enabled: true, value: pick(sl)} : {enabled: false, reason: 'select a slicer'};
};

/** Report Connections: the PivotTables a slicer filters become `pivots`; the ones dropped lose its filter, the new ones take it. */
function reportConnections(ctx, p) {
  const [si, i] = findSlicer(ctx, p);
  const content = baseDoc(ctx);
  const sl = content.sheets[si].slicers[i];
  if (!isPivotSlicer(sl)) throw failed('Report Connections is for slicers on a PivotTable field.');
  const names = [];
  for (const n of Array.isArray(p.pivots) ? p.pivots : []) {
    const hit = pivotByName(content, String(n));
    if (!hit) throw bad('slicer.reportConnections', 'no PivotTable named ' + n);
    if (!names.includes(hit[2].name)) names.push(hit[2].name);
  }
  if (!names.length) throw failed('Select at least one PivotTable for the slicer to filter.');
  const before = slicerPivots(sl);
  const base = ['sheets', si, 'slicers', i];
  ctx.change.set([...base, 'pivots'], names);
  ctx.change.set([...base, 'pivot'], names[0]);
  for (const n of before) if (!names.some(x => eq(x, n)) && pivotByName(ctx.doc, n)) updatePivot(ctx, {pivot: n}, (pt, src) => { clearOn(pt, src, sl); return {}; });
  if (filtering(sl)) for (const n of names) if (!before.some(x => eq(x, n))) updatePivot(ctx, {pivot: n}, (pt, src) => { applyOn(pt, src, sl); return {}; });
  return {pivots: names};
}

/** Filter Connections: the slicers (of the same source field as a PivotTable has) that filter this PivotTable. */
function filterConnections(ctx, p) {
  const content = baseDoc(ctx);
  const hit = typeof p.pivot === 'string' ? pivotByName(content, p.pivot) : pivotUnderSelection(ctx);
  if (!hit) throw failed('Select a cell in a PivotTable first.');
  const pt = hit[2];
  const want = new Set((Array.isArray(p.slicers) ? p.slicers : []).map(Number));
  let changed = 0;
  content.sheets.forEach((sh, si) => (sh.slicers ?? []).forEach((sl, i) => {
    if (!isPivotSlicer(sl)) return;
    const now = slicerPivots(sl);
    const has = now.some(n => eq(n, pt.name));
    if (want.has(sl.id) && !has) {
      const next = [...now, pt.name];
      ctx.change.set(['sheets', si, 'slicers', i, 'pivots'], next);
      if (filtering(sl)) updatePivot(ctx, {pivot: pt.name}, (q, src) => { applyOn(q, src, sl); return {}; });
      changed += 1;
    } else if (!want.has(sl.id) && has) {
      const next = now.filter(n => !eq(n, pt.name));
      if (!next.length) throw failed(`The slicer ${sl.caption ?? sl.field} must keep at least one PivotTable; use Report Connections to move it.`);
      ctx.change.set(['sheets', si, 'slicers', i, 'pivots'], next);
      if (eq(sl.pivot, pt.name)) ctx.change.set(['sheets', si, 'slicers', i, 'pivot'], next[0]);
      updatePivot(ctx, {pivot: pt.name}, (q, src) => { clearOn(q, src, sl); return {}; });
      changed += 1;
    }
  }));
  return {changed};
}

/** The Slicer Styles gallery: each style drawn with its header, frame and tile colours. */
function styleTiles(ctx) {
  const sel = selectedSlicer(ctx);
  const cur = sel?.style ?? SLICER_DEFAULT_STYLE;
  return (sel?.timeline ? TIME_STYLES : SLICER_STYLES).map(name => {
    const lk = slicerLook(name);
    const label = name.replace('TimeSlicerStyle', '').replace('SlicerStyle', '').replace(/(\D+)(\d)/, '$1 $2');
    return {id: name, label, value: name, group: name.includes('Light') ? 'Light' : name.includes('Dark') ? 'Dark' : 'Other', selected: name === cur, iconOnly: true, art: {kind: 'slicer', ...lk}};
  });
}

export {columnValues, slicerItems};

export default defineCommands({
  family: 'slicer',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.slicer', label: 'Slicer', risk: 'edit', dialog: 'dialog.insertSlicers',
      description: 'Insert a slicer on a table column, or on a field of a PivotTable (`pivot`; a cell in the report of a PivotTable picks it): `table` (default the table at the selection), `column` (a name, or a list for one slicer each; default the active cell column), `columns` (tile columns), `at` (top-left cell), `width`, `height`. Returns {slicer}.',
      params: s.object({table: s.optional(s.string({max: 255})), pivot: s.optional(s.string({max: 255})), column: s.optional(s.union([s.string({max: 255}), s.array(s.string({max: 255}), {max: 64})])), columns: s.optional(s.integer({min: 1, max: 10})),
        at: s.optional(s.string({max: 100})), width: s.optional(s.number({min: 60, max: 10000})), height: s.optional(s.number({min: 60, max: 10000}))}),
      state: hasDoc, run: insertSlicer},
    {id: 'table.insertSlicer', label: 'Insert Slicer', risk: 'edit', dialog: 'dialog.insertSlicers', description: 'Insert a slicer on a column of a table (same as insert.slicer).',
      params: s.object({table: s.optional(s.string({max: 255})), column: s.optional(s.union([s.string({max: 255}), s.array(s.string({max: 255}), {max: 64})])), columns: s.optional(s.integer({min: 1, max: 10})),
        at: s.optional(s.string({max: 100})), width: s.optional(s.number({min: 60, max: 10000})), height: s.optional(s.number({min: 60, max: 10000}))}),
      state: hasDoc, run: insertSlicer},
    {id: 'slicer.toggle', label: 'Toggle Slicer Value', risk: 'edit', description: 'Click a tile: show only `value`, or with `multi` add or remove it from the shown values.',
      params: s.object({slicer: SLICER, value: s.union([s.string({max: 1000}), s.number()]), multi: s.optional(s.boolean())}), state: slicerState, run: toggle},
    {id: 'slicer.selectAll', label: 'Clear Slicer Filter', risk: 'edit', description: 'Select every tile: no filter from this slicer.', params: s.object({slicer: SLICER}), state: slicerState, run: selectAll},
    {id: 'slicer.clear', label: 'Clear Slicer Filter', risk: 'edit', description: 'Clear the slicer filter.', params: s.object({slicer: SLICER}), state: slicerState, run: selectAll},
    {id: 'slicer.delete', label: 'Delete Slicer', risk: 'edit', description: 'Delete a slicer and the filter it set.', params: s.object({slicer: SLICER}), state: slicerState, run: deleteSlicer},
    {id: 'slicer.set', label: 'Slicer Settings', risk: 'edit', dialog: 'dialog.slicerSettings', description: 'Slicer settings: `caption`, `columns` (tile columns 1 to 10), `width`, `height`.',
      params: s.object({slicer: SLICER, caption: s.optional(s.string({max: 255})), columns: s.optional(s.integer({min: 1, max: 10})), width: s.optional(s.number({min: 60, max: 10000})), height: s.optional(s.number({min: 60, max: 10000}))}),
      state: slicerState, run: setSlicer},
    {id: 'slicer.caption', label: 'Slicer Caption', risk: 'edit', description: 'The header caption of the selected slicer.', params: s.object({slicer: SLICER, caption: s.string({min: 1, max: 255})}),
      state: valueState(sl => sl.caption ?? sl.column), run: setSlicer},
    {id: 'slicer.columns', label: 'Slicer Columns', risk: 'edit', description: 'The number of tile columns of the selected slicer.', params: s.object({slicer: SLICER, columns: s.integer({min: 1, max: 10})}),
      state: valueState(sl => sl.columns ?? 1), run: setSlicer},
    {id: 'slicer.height', label: 'Slicer Height', risk: 'edit', description: 'The height of the selected slicer in points.', params: s.object({slicer: SLICER, height: s.number({min: 45, max: 7500})}),
      state: valueState(sl => Math.round((sl.anchor?.height ?? 200) * 0.75 * 100) / 100), run: (ctx, p) => setSlicer(ctx, {...p, height: p.height / 0.75})},
    {id: 'slicer.width', label: 'Slicer Width', risk: 'edit', description: 'The width of the selected slicer in points.', params: s.object({slicer: SLICER, width: s.number({min: 45, max: 7500})}),
      state: valueState(sl => Math.round((sl.anchor?.width ?? 168) * 0.75 * 100) / 100), run: (ctx, p) => setSlicer(ctx, {...p, width: p.width / 0.75})},
    {id: 'slicer.style', label: 'Slicer Styles', risk: 'edit', description: 'The style of the selected slicer: SlicerStyleLight1 to 6, SlicerStyleDark1 to 6, SlicerStyleOther1 or 2.',
      params: s.object({slicer: SLICER, style: s.enum([...SLICER_STYLES, ...TIME_STYLES])}),
      state: ctx => { const st = slicerState(ctx); return st.enabled ? (selectedSlicer(ctx) ? {...st, value: styleTiles(ctx)} : {enabled: false, reason: 'select a slicer'}) : st; },
      run: (ctx, p) => { const [si, i] = findSlicer(ctx, p); guardObjects(baseDoc(ctx).sheets[si]); ctx.change.set(['sheets', si, 'slicers', i, 'style'], p.style); return {style: p.style}; }},
    {id: 'slicer.reportConnections', label: 'Report Connections', risk: 'edit', dialog: 'dialog.reportConnections',
      description: 'Choose the PivotTables a PivotTable slicer filters: `pivots` (names; at least one). The slicer\'s selection is applied to the new ones and cleared from the others.',
      params: s.object({slicer: SLICER, pivots: s.array(s.string({max: 255}), {max: 256})}),
      state: ctx => { const st = slicerState(ctx); if (!st.enabled) return st; const sl = selectedSlicer(ctx); return sl && isPivotSlicer(sl) ? st : {enabled: false, reason: 'select a PivotTable slicer'}; }, run: reportConnections},
    {id: 'pivot.filterConnections', label: 'Filter Connections', risk: 'edit', dialog: 'dialog.filterConnections',
      description: 'Choose which PivotTable slicers filter a PivotTable (default the one at the selection): `slicers` (ids; the others are disconnected from it).',
      params: s.object({pivot: s.optional(s.string({max: 255})), slicers: s.array(s.integer({min: 0}), {max: 256})}),
      state: (ctx, p) => {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        if (typeof p?.pivot !== 'string' && !pivotUnderSelection(ctx)) return {enabled: false, reason: 'select a cell in a PivotTable'};
        return ctx.doc.sheets.some(sh => (sh.slicers ?? []).some(isPivotSlicer)) ? {enabled: true} : {enabled: false, reason: 'there is no PivotTable slicer'};
      }, run: filterConnections},
    {id: 'slicer.list', label: 'Slicers', risk: 'read', description: 'Every slicer of the workbook: {id, sheet, table, column, caption, selected, items:[{value, on}]}.', params: s.object({}), state: hasDoc,
      run: ctx => baseDoc(ctx).sheets.flatMap((sh, si) => (sh.slicers ?? []).map(sl => ({id: sl.id, sheet: sh.name, table: sl.table, ...(isPivotSlicer(sl) ? {pivot: sl.pivot, pivots: slicerPivots(sl), field: sl.field} : {}), style: sl.style ?? SLICER_DEFAULT_STYLE, column: sl.column, caption: sl.caption, selected: sl.selected ?? null, columns: sl.columns ?? 1, items: slicerItems(baseDoc(ctx), si, sl)})))},
  ],
});
