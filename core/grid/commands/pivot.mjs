// PivotTable commands (Insert > PivotTable, PivotTable Analyze, PivotTable Design, Data > Refresh All). Every change writes the
// report again as one undo step.
// Translated from gridcraft crates/engine/src/cmd/pivot.rs and pivot/{create,fields,layout,params}.rs and pivot.rs `refresh` at fb1e59f.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `pivot` names a PivotTable (name or numeric id); by default it is the one whose report holds the active cell, else the last pivot of
// the active sheet. Calculated fields, Move PivotTable and Select are in pivot/calc.mjs. Not translated (hidden with notes): Σ Values in rows.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2, setGridSelection} from '../lib/edit-targets.mjs';
import {selectionAt, currentRegion} from '../model/workbook.mjs';
import {filledAt} from './edit/selection.mjs';
import {bad, failed, baseDoc} from '../lib/data-common.mjs';
import {a1, parseCell, parseRange, rangeA1, contains, intersects, MAX_ROWS, MAX_COLS} from '../lib/addr.mjs';
import {cellAt, writeCell} from '../model/store.mjs';
import {deriveStyle, DEFAULT_THEME, hex, resolveColor} from '../model/style.mjs';
import {toJSONValue} from '../lib/value.mjs';
import {approxTextWidth} from '../lib/format-ranges.mjs';
import {formatValue} from '../lib/numfmt.mjs';
import {nextObjectId} from '../lib/objects.mjs';
import * as pv from '../lib/pivot.mjs';
import {rebindCharts} from '../lib/pivot-chart.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/pivot.rs', 'crates/engine/src/cmd/pivot/create.rs', 'crates/engine/src/cmd/pivot/fields.rs', 'crates/engine/src/cmd/pivot/layout.rs', 'crates/engine/src/pivot.rs', 'crates/engine/src/pivot/compute.rs', 'crates/ui-egui/src/grid/menus.rs']};
const PROTECTED = "The cell or chart you're trying to change is on a protected sheet.";
/** A protected sheet refuses a PivotTable change unless Protect Sheet allows "Use PivotTable & PivotChart". */
const locked = sheet => !!sheet.protection && sheet.protection.enabled !== false && sheet.protection.pivotTables !== true;
const PIVOT = s.optional(s.union([s.string({min: 1, max: 255}), s.integer({min: 0})]));
const REPLACE = s.optional(s.boolean());
const AREAS = ['rows', 'columns', 'values', 'filters'];
const FUNC = s.optional(s.enum(pv.FUNCS));

// ---------------------------------------------------------------- lookup

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const newPt = (id, name, source, anchor) => ({id, name, source, anchor, rows: [], columns: [], values: [], filters: [], layout: 'compact', enableShowDetails: true, grandTotalsRows: true,
  grandTotalsCols: true, subtotals: true, subtotalsTop: true, style: 'PivotStyleLight16', showHeaders: true, lastRange: null});

/** [sheet index, pivot index] a call targets. */
function findPivot(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const hit = pv.pivotAt(content, sel.sheet, sel.active, p.pivot);
  if (hit) return hit;
  if (p.pivot !== undefined && p.pivot !== null) throw bad('pivot', 'no PivotTable named ' + p.pivot);
  throw failed('Select a cell in a PivotTable (or pass pivot).');
}
/** The field of the cell the person is on, as {area, field, index}, or null. */
function activeField(ctx, p) {
  const [si, pi] = findPivot(ctx, p);
  const pt = ctx.doc.sheets[si].pivots[pi];
  return pv.activeFieldAt(ctx.doc, si, pt, gridSel(ctx).active);
}
const pivotState = ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const picked = ctx.doc.sheets.some(sh => (sh.pivots ?? []).length);
  return picked ? {enabled: true} : {enabled: false, reason: 'select a cell in a PivotTable'};
};

// ---------------------------------------------------------------- refresh (pivot.rs `refresh`)

/** Writes the report of pivot `pi` of sheet `si`: recomputes it, checks where it goes, writes cells and styles. Returns the written range. */
export function refreshPivot(ctx, si, pi, replace) {
  const content = ctx.doc;
  const sheet = content.sheets[si];
  const pt = sheet.pivots?.[pi];
  if (!pt) throw failed("There's no such PivotTable.");
  let out;
  try { out = pv.compute(content, pt, si); } catch (e) { throw failed(e.message); }
  const h = Math.max(1, out.grid.length), w = Math.max(1, out.width);
  const anchor = parseRange(pt.anchor).start;
  const originRow = anchor.row >= out.bodyOffset ? anchor.row - out.bodyOffset : anchor.row;
  const endRow = originRow + h - 1, endCol = anchor.col + w - 1;
  if (endRow >= MAX_ROWS || endCol >= MAX_COLS) throw failed('The PivotTable report will not fit on the sheet. Choose a different location.');
  const area = {start: {row: originRow, col: anchor.col}, end: {row: endRow, col: endCol}};
  (sheet.pivots ?? []).forEach((other, j) => {
    if (j !== pi && other.lastRange && intersects(parseRange(other.lastRange), area)) throw failed('A PivotTable report cannot overlap another PivotTable report.');
  });
  if (locked(sheet)) throw failed(PROTECTED);
  try {
    const src = pv.resolveSource(content, pt.source, si);
    if (src.si === si && intersects(src.range, area)) throw failed("The PivotTable report can't overlap its source data. Choose a different location.");
  } catch (e) { if (e.code) throw e; }
  if ((sheet.tables ?? []).some(t => intersects(parseRange(t.range), area))) throw failed('A PivotTable report cannot overlap a table.');
  const old = pt.lastRange ? parseRange(pt.lastRange) : null;
  if (!replace) {
    for (let r = area.start.row; r <= area.end.row; r++) for (let c = area.start.col; c <= area.end.col; c++) {
      const cell = cellAt(sheet, r, c);
      if (cell && (cell.v !== undefined || cell.f !== undefined) && !(old && contains(old, {row: r, col: c}))) {
        throw failed(`There's already data in ${sheet.name}!${a1(r, c)}. Do you want to replace it? (Run again with replace: true to overwrite.)`);
      }
    }
  }
  // Styles first (the style table is workbook-wide).
  const lk = pv.look(pt.style);
  let lastHeader = -1;
  out.rowKinds.forEach((k, i) => { if (k === 'header') lastHeader = i; });
  const cache = new Map();
  const cells = [];
  const opts = pv.styleOptions(pt);
  const bodyIndex = new Map();
  { let n = 0; out.rowKinds.forEach((k, i) => { if (k === 'item' || k === 'itemParent' || k === 'subtotal') bodyIndex.set(i, n++); }); }
  out.grid.forEach((row, ri) => {
    const rk = out.rowKinds[ri] ?? 'blank';
    if (rk === 'blank') return;
    row.forEach((oc, ci) => {
      const isNull = oc.value === null || oc.value === undefined || oc.value === '';
      if ((rk === 'filter' || rk === 'placeholder') && isNull) return;
      const flag = rk === 'header' ? ri === lastHeader : rk === 'filter' ? ci === 0 : false;
      const bodyRow = rk === 'item' || rk === 'itemParent' || rk === 'subtotal';
      const band = bodyRow && ((opts.bandedRows && (bodyIndex.get(ri) ?? 0) % 2 === 0) || (opts.bandedColumns && ci >= out.labelCols && (ci - out.labelCols) % 2 === 0));
      const patch = pv.cellStyle(lk, rk, oc, flag, {...opts, band, buttons: pt.showButtons !== false});
      const key = JSON.stringify(patch);
      let id = cache.get(key);
      if (id === undefined) { id = Object.keys(patch).length ? deriveStyle(ctx.change, content, 0, patch) : 0; cache.set(key, id); }
      if (isNull && id === 0) return;
      cells.push([originRow + ri, anchor.col + ci, oc, id]);
    });
  });
  // The report's cells replace the old and the new area.
  const clear = r => { for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) if (cellAt(ctx.doc.sheets[si], row, col)) writeCell(ctx.change, ctx.doc, si, row, col, {}); };
  if (old) clear(old);
  clear(area);
  const widths = new Map();
  for (const [row, col, oc, id] of cells) {
    const v = oc.value;
    const cell = {s: id || undefined};
    if (v !== null && v !== undefined && v !== '') cell.v = toJSONValue(v);
    writeCell(ctx.change, ctx.doc, si, row, col, cell);
    if (cell.v !== undefined) {
      const text = typeof v === 'number' ? formatValue(v, oc.numFmt ?? 'General', content.dateSystem === 1904 ? 1904 : 1900).text : formatValue(v, 'General').text;
      const wpt = approxTextWidth(text, 11, false) + (oc.indent ?? 0) * 9 + 14;
      widths.set(col, Math.max(widths.get(col) ?? 0, Math.min(wpt, 320)));
    }
  }
  const cols = {...(ctx.doc.sheets[si].cols ?? {})};
  let touched = false;
  for (const [col, wpt] of widths) {
    const cur = cols[col] ?? {};
    if (!cur.hidden && wpt > (cur.size ?? 64)) { cols[col] = {...cur, size: Math.round(wpt)}; touched = true; }
  }
  if (touched) ctx.change.set(['sheets', si, 'cols'], cols);
  const text = rangeA1(area);
  ctx.change.set(['sheets', si, 'pivots', pi, 'lastRange'], text);
  // The PivotCharts of this report plot the new report (core/grid/lib/pivot-chart.mjs).
  rebindCharts(ctx, sheet.name, pt.name, area.start, out);
  return text;
}

/** Applies `f` to the targeted pivot (a copy), stores it and writes the report again. */
function update(ctx, p, f) {
  const [si, pi] = findPivot(ctx, p);
  requireSchema2(ctx, si);
  const content = ctx.doc;
  const pt = structuredClone(content.sheets[si].pivots[pi]);
  let src;
  try { src = pv.readSource(content, pt.source, si); } catch (e) { throw failed(e.message); }
  const out = f(pt, src, content) ?? {};
  ctx.change.set(['sheets', si, 'pivots', pi], pt);
  const range = refreshPivot(ctx, si, pi, p.replace === true);
  return {...out, range};
}

// ---------------------------------------------------------------- fields

const inAxes = pv.inAxes;
const canonical = (cmd, src, field) => { const c = src.col(field); if (c < 0) throw bad(cmd, `no field \`${field}\` in the source data`); return src.headers[c]; };
/** The canonical name of a source or calculated field (pivot/fields.rs `canonical_any`). */
const calcField = (pt, field) => (pt.calculatedFields ?? []).find(c => eq(c.name, String(field).trim()));
const canonicalAny = (cmd, pt, src, field) => { const c = calcField(pt, field); return c && src.col(field) < 0 ? c.name : canonical(cmd, src, field); };
const autoName = (f, field) => `${pv.funcCaption(f)} of ${field}`;
function uniqueValueName(pt, base, except) {
  const taken = n => pt.values.some((v, i) => i !== except && eq(v.name, n));
  if (!taken(base)) return base;
  for (let k = 2; k < 10_000; k++) if (!taken(`${base}${k}`)) return `${base}${k}`;
  return base;
}
function takeFromAxes(pt, field) {
  let first = null;
  for (const key of ['rows', 'columns']) {
    for (;;) {
      const i = pt[key].findIndex(f => eq(f.sourceCol, field));
      if (i < 0) break;
      const [f] = pt[key].splice(i, 1);
      first ??= f;
    }
  }
  return first;
}
const insertAt = (list, item, position) => list.splice(Math.min(position ?? list.length, list.length), 0, item);

/** Adds `field` to an area (moving it out of the other axis area). */
export function addToArea(pt, src, {cmd, field: name, area, func, name: label, position}) {
  if (src.col(name) < 0 && calcField(pt, name) && area !== 'values') throw failed('A calculated field can only be placed in the Values area.');
  const field = canonicalAny(cmd, pt, src, name);
  if (area === 'rows' || area === 'columns') {
    if (pt.rows.length + pt.columns.length >= pv.MAX_AXIS_FIELDS && !inAxes(pt, field)) throw failed(`A PivotTable can have at most ${pv.MAX_AXIS_FIELDS} row and column fields.`);
    const existing = takeFromAxes(pt, field) ?? {sourceCol: field, sort: 'asc', dateGroup: 'none', collapsedItems: []};
    // A report filter that selects nothing in particular goes away; a selection stays as the field's hidden items.
    pt.filters = pt.filters.filter(f => !(eq(f.sourceCol, field) && !f.selected));
    insertAt(pt[area], existing, position);
  } else if (area === 'values') {
    if (pt.values.length >= pv.MAX_VALUE_FIELDS) throw failed(`A PivotTable can have at most ${pv.MAX_VALUE_FIELDS} value fields.`);
    const numeric = src.col(field) < 0 || !!src.numeric[src.col(field)];
    const f = func ?? (numeric ? 'sum' : 'count');
    let base;
    if (typeof label === 'string' && label.trim()) { if (src.col(label) >= 0) throw failed('PivotTable field name already exists.'); base = label; } else base = autoName(f, field);
    insertAt(pt.values, {sourceCol: field, func: f, name: uniqueValueName(pt, base, null), showAs: 'normal', numberFormat: null}, position);
  } else {
    takeFromAxes(pt, field);
    const i = pt.filters.findIndex(f => eq(f.sourceCol, field));
    const entry = i >= 0 ? pt.filters.splice(i, 1)[0] : {sourceCol: field, selected: null};
    insertAt(pt.filters, entry, position);
  }
}

function removeFromArea(cmd, pt, field, area) {
  if (area === 'rows' || area === 'columns') {
    const i = pt[area].findIndex(f => eq(f.sourceCol, field));
    if (i < 0) throw bad(cmd, `\`${field}\` isn't in the ${area} area`);
    const [f] = pt[area].splice(i, 1);
    pt.filters = pt.filters.filter(x => !eq(x.sourceCol, f.sourceCol));
    return f.sourceCol;
  }
  if (area === 'values') {
    let i = pt.values.findIndex(v => eq(v.name, field));
    if (i < 0) i = pt.values.findIndex(v => eq(v.sourceCol, field));
    if (i < 0) throw bad(cmd, `\`${field}\` isn't in the values area`);
    return pt.values.splice(i, 1)[0].sourceCol;
  }
  const i = pt.filters.findIndex(f => eq(f.sourceCol, field) && !inAxes(pt, f.sourceCol));
  if (i < 0) throw bad(cmd, `\`${field}\` isn't in the filters area`);
  return pt.filters.splice(i, 1)[0].sourceCol;
}

const areaOf = (cmd, v) => {
  const a = String(v ?? '').toLowerCase();
  if (['rows', 'row'].includes(a)) return 'rows';
  if (['columns', 'column', 'cols'].includes(a)) return 'columns';
  if (['values', 'value', 'data'].includes(a)) return 'values';
  if (['filters', 'filter'].includes(a)) return 'filters';
  throw bad(cmd, a ? `unknown area \`${a}\` (rows|columns|values|filters)` : 'missing `area` (rows|columns|values|filters)');
};

// ---------------------------------------------------------------- insert

/** The default source: the table at the selection, else the selected block or the current region. */
function defaultSource(ctx) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const sheet = content.sheets[sel.sheet];
  const t = (sheet.tables ?? []).find(x => contains(parseRange(x.range), sel.active));
  if (t) return t.name;
  const cur = sel.ranges[sel.ranges.length - 1];
  const single = cur.start.row === cur.end.row && cur.start.col === cur.end.col;
  const r = single ? currentRegion(filledAt(content, sel.sheet), sel.active) : cur;
  if (!r || (single && r.start.row === r.end.row && r.start.col === r.end.col && !cellAt(sheet, r.start.row, r.start.col))) throw failed("The reference isn't valid. Select a cell in a range with labeled columns, or pass `source`.");
  return pv.rangeText(sheet.name, r);
}
function sourceParam(ctx, p) {
  const t = (p.source ?? p.range ?? '').trim?.().replace(/^=/, '') ?? '';
  if (!t) return defaultSource(ctx);
  const bare = !t.includes('!') && parseRange(t.replace(/\$/g, ''));
  if (bare) return pv.rangeText(baseDoc(ctx).sheets[gridSel(ctx).sheet].name, bare);
  return t;
}
const nextPivotName = content => { for (let n = 1; ; n++) { const name = `PivotTable${n}`; if (!content.sheets.some(sh => (sh.pivots ?? []).some(p => eq(p.name, name)))) return name; } };
const nextPivotId = content => Math.max(nextObjectId(content), 1 + Math.max(0, ...content.sheets.flatMap(sh => (sh.pivots ?? []).map(p => p.id))));

function insertPivot(ctx, p) {
  const content = baseDoc(ctx);
  if (content.protection?.structure && (p.destination === undefined || p.destination === 'new')) throw failed('The workbook is protected and cannot be changed.');
  const source = sourceParam(ctx, p);
  const active = gridSel(ctx).sheet;
  let src;
  try { src = pv.readSource(content, source, active); } catch (e) { throw failed(e.message); }
  let name = typeof p.name === 'string' ? p.name.trim() : '';
  if (name) { if (content.sheets.some(sh => (sh.pivots ?? []).some(x => eq(x.name, name)))) throw failed('A PivotTable with that name already exists.'); } else name = nextPivotName(content);
  const dest = String(p.destination ?? p.location ?? 'new').trim();
  let target = null;
  if (dest && !eq(dest, 'new')) {
    const i = dest.lastIndexOf('!');
    const sn = i < 0 ? null : dest.slice(0, i).replace(/^'(.*)'$/, '$1');
    const si = sn === null ? active : content.sheets.findIndex(x => eq(x.name, sn));
    if (si < 0) throw bad('insert.pivotTable', `no sheet named \`${sn}\``);
    const r = parseRange((i < 0 ? dest : dest.slice(i + 1)).replace(/\$/g, ''));
    if (!r) throw bad('insert.pivotTable', `not a cell: \`${dest}\``);
    target = {si, at: r.start};
  }
  const id = nextPivotId(content);
  let si, anchor;
  if (target) ({si, at: anchor} = target);
  else {
    // A new sheet before the current one, the report at A3.
    ctx.run('home.insertSheet', {before: active});
    si = active; anchor = {row: 2, col: 0};
  }
  requireSchema2(ctx, si);
  const pt = newPt(id, name, source, a1(anchor.row, anchor.col));
  const add = (list, area) => {
    for (const f of Array.isArray(list) ? list.slice(0, 512) : typeof list === 'string' ? [list] : []) {
      if (typeof f === 'string') { addToArea(pt, src, {cmd: 'insert.pivotTable', field: f, area}); continue; }
      if (!f || typeof f.field !== 'string') throw bad('insert.pivotTable', 'fields are names or {field, func?, name?}');
      addToArea(pt, src, {cmd: 'insert.pivotTable', field: f.field, area, func: f.func, name: f.name});
      if (f.group && f.group !== 'none' && (area === 'rows' || area === 'columns') && src.numeric[src.col(f.field)]) {
        const af = [...pt.rows, ...pt.columns].find(x => eq(x.sourceCol, f.field));
        if (af) af.dateGroup = f.group;
      }
    }
  };
  add(p.rows, 'rows'); add(p.columns, 'columns'); add(p.values, 'values'); add(p.filters, 'filters');
  const sheet = ctx.doc.sheets[si];
  ctx.change.set(['sheets', si, 'pivots'], [...(sheet.pivots ?? []), pt]);
  const pi = (sheet.pivots ?? []).length;
  const area = refreshPivot(ctx, si, pi, p.replace === true);
  setGridSelection(ctx, selectionAt(si, anchor));
  ctx.setView({pivotPane: true});
  return {id, name, sheet: ctx.doc.sheets[si].name, anchor: a1(anchor.row, anchor.col), range: area, source, fields: src.headers};
}

function summarizeTable(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const tables = content.sheets.flatMap(sh => sh.tables ?? []);
  const t = typeof p.table === 'string' ? tables.find(x => eq(x.name, p.table)) : (content.sheets[sel.sheet].tables ?? []).find(x => contains(parseRange(x.range), sel.active));
  if (!t) throw failed('Select a cell in a table.');
  return insertPivot(ctx, {...p, source: t.name, table: undefined});
}

// ---------------------------------------------------------------- field commands

const NAME = s.string({min: 1, max: 255});
const POS = s.optional(s.integer({min: 0, max: 1000}));

function fieldsQuery(ctx, p) {
  const [si, pi] = findPivot(ctx, p);
  const content = baseDoc(ctx);
  const pt = content.sheets[si].pivots[pi];
  const out = pv.describe(content, si, pt);
  const af = pv.activeFieldAt(content, si, pt, gridSel(ctx).active);
  return af ? {...out, active: af} : out;
}
const listQuery = ctx => { const content = baseDoc(ctx); return content.sheets.flatMap((sh, si) => (sh.pivots ?? []).map(pt => pv.describe(content, si, pt))); };

const addField = (ctx, p) => update(ctx, p, (pt, src) => {
  addToArea(pt, src, {cmd: 'pivot.addField', field: p.field, area: areaOf('pivot.addField', p.area), func: p.func, name: p.name, position: p.position});
  return {field: canonicalAny('pivot.addField', pt, src, p.field), area: areaOf('pivot.addField', p.area)};
});
const removeField = (ctx, p) => update(ctx, p, pt => {
  if (p.area !== undefined) removeFromArea('pivot.removeField', pt, p.field, areaOf('pivot.removeField', p.area));
  else {
    let any = false;
    for (const a of AREAS) { try { removeFromArea('pivot.removeField', pt, p.field, a); any = true; } catch { /* not there */ } }
    if (!any) throw bad('pivot.removeField', `\`${p.field}\` isn't in the PivotTable`);
  }
  return {};
});
const moveField = (ctx, p) => update(ctx, p, (pt, src) => {
  const C = 'pivot.moveField';
  const from = areaOf(C, p.from), to = areaOf(C, p.to);
  if (from === to) {
    if (from === 'rows' || from === 'columns') {
      const i = pt[from].findIndex(f => eq(f.sourceCol, p.field));
      if (i < 0) throw bad(C, `\`${p.field}\` isn't in the ${from} area`);
      const [f] = pt[from].splice(i, 1);
      insertAt(pt[from], f, p.position);
    } else if (from === 'values') {
      let i = pt.values.findIndex(v => eq(v.name, p.field));
      if (i < 0) i = pt.values.findIndex(v => eq(v.sourceCol, p.field));
      if (i < 0) throw bad(C, `\`${p.field}\` isn't in the values area`);
      const [v] = pt.values.splice(i, 1);
      insertAt(pt.values, v, p.position);
    } else {
      const i = pt.filters.findIndex(f => eq(f.sourceCol, p.field));
      if (i < 0) throw bad(C, `\`${p.field}\` isn't in the filters area`);
      const [f] = pt.filters.splice(i, 1);
      insertAt(pt.filters, f, p.position);
    }
    return {};
  }
  // Keep axis settings (sort, grouping) when moving between rows and columns.
  const kept = [...pt.rows, ...pt.columns].find(f => eq(f.sourceCol, p.field));
  const hidden = pt.filters.find(f => eq(f.sourceCol, p.field));
  const field = removeFromArea(C, pt, p.field, from);
  addToArea(pt, src, {cmd: C, field, area: to, position: p.position});
  if (to === 'rows' || to === 'columns') {
    const slot = pt[to].findIndex(f => eq(f.sourceCol, field));
    if (kept && slot >= 0) pt[to][slot] = kept;
    if (hidden?.selected && !pt.filters.some(f => eq(f.sourceCol, field))) pt.filters.push(hidden);
  }
  return {field, to};
});

const valueSettings = (ctx, p) => update(ctx, p, (pt, src) => {
  const C = 'pivot.valueSettings';
  let i;
  if (Number.isInteger(p.index)) i = p.index;
  else if (typeof p.field === 'string') {
    i = pt.values.findIndex(v => eq(v.name, p.field));
    if (i < 0) i = pt.values.findIndex(v => eq(v.sourceCol, p.field));
    if (i < 0) throw bad(C, `\`${p.field}\` isn't in the values area`);
  } else if (pt.values.length === 1) i = 0;
  else { const af = activeField(ctx, p); i = af?.area === 'values' ? af.index : 0; }
  const cur = pt.values[i];
  if (!cur) throw bad(C, 'no value field at that index');
  const v = {...cur};
  if (p.func) {
    v.func = p.func;
    // An automatic caption follows the function.
    const auto = autoName(cur.func, cur.sourceCol);
    if (eq(cur.name, auto) || (cur.name.startsWith(auto) && /^\d+$/.test(cur.name.slice(auto.length)))) v.name = uniqueValueName(pt, autoName(p.func, cur.sourceCol), i);
  }
  if (typeof p.name === 'string') {
    const n = p.name.trim();
    if (!n) throw failed("The name isn't valid.");
    if (src.col(n) >= 0 || pt.values.some((x, j) => j !== i && eq(x.name, n))) throw failed('PivotTable field name already exists.');
    v.name = n;
  }
  if (p.showAs) v.showAs = p.showAs;
  if (p.numberFormat !== undefined) v.numberFormat = typeof p.numberFormat === 'string' && p.numberFormat ? p.numberFormat : null;
  pt.values[i] = v;
  return {name: v.name};
});

const filterCmd = (ctx, p) => update(ctx, p, (pt, src) => {
  const C = 'pivot.filter';
  const field = canonical(C, src, p.field);
  let selected = null;
  if (Array.isArray(p.selected)) {
    selected = p.selected.map(x => (x === null ? '(blank)' : String(x)));
    if (!selected.length) throw failed('You must select at least one item.');
  } else if (typeof p.selected === 'string') selected = [p.selected];
  const i = pt.filters.findIndex(f => eq(f.sourceCol, field));
  if (i >= 0 && selected === null) { if (inAxes(pt, field)) pt.filters.splice(i, 1); else pt.filters[i].selected = null; }
  else if (i >= 0) pt.filters[i].selected = selected;
  else if (selected) pt.filters.push({sourceCol: field, selected});
  return {field};
});
const axisField = (cmd, pt, field) => {
  const f = [...pt.rows, ...pt.columns].find(x => eq(x.sourceCol, field));
  if (!f) throw bad(cmd, `\`${field}\` isn't in the rows or columns area`);
  return f;
};
/** The row or column field a command works on: named, else the one under the active cell, else the first. */
function axisName(ctx, p, pt) {
  if (typeof p.field === 'string' && p.field) return p.field;
  const af = activeField(ctx, p);
  if (af && (af.area === 'rows' || af.area === 'columns')) return af.field;
  const first = pt.rows[0] ?? pt.columns[0];
  if (!first) throw failed('There are no row or column fields in the PivotTable.');
  return first.sourceCol;
}
const sortCmd = (ctx, p) => update(ctx, p, pt => { axisField('pivot.sort', pt, axisName(ctx, p, pt)).sort = p.order ?? 'asc'; return {}; });
const groupCmd = (ctx, p) => update(ctx, p, (pt, src) => {
  const by = p.by ?? 'months';
  const name = axisName(ctx, p, pt);
  if (by !== 'none') { const c = src.col(name); if (c < 0) throw bad('pivot.group', `no field \`${name}\` in the source data`); if (!src.numeric[c]) throw failed('Cannot group that selection.'); }
  const f = axisField('pivot.group', pt, name);
  f.dateGroup = by; f.collapsedItems = [];
  return {};
});
const collapseCmd = (ctx, p) => update(ctx, p, (pt, src, content) => {
  const on = p.collapse !== false;
  const name = axisName(ctx, p, pt);
  const f = axisField('pivot.collapse', pt, name);
  const all = Array.isArray(p.items) ? p.items.map(String) : (() => { const c = src.col(name); return c >= 0 ? pv.distinctLabels(content, src, c, f.dateGroup, 100_000) : []; })();
  f.collapsedItems ??= [];
  if (on) for (const it of all) { if (!f.collapsedItems.some(x => eq(x, it))) f.collapsedItems.push(it); }
  else if (!Array.isArray(p.items)) f.collapsedItems = [];
  else f.collapsedItems = f.collapsedItems.filter(x => !all.some(a => eq(a, x)));
  return {collapsed: f.collapsedItems};
});
const layoutCmd = (ctx, p) => update(ctx, p, pt => {
  if (p.layout) { pt.layout = p.layout; if (p.layout === 'tabular') pt.subtotalsTop = false; }
  if (p.subtotals !== undefined) {
    if (p.subtotals === true || p.subtotals === 'top') { pt.subtotals = true; if (p.subtotals === 'top') pt.subtotalsTop = true; }
    else if (p.subtotals === 'bottom') { pt.subtotals = true; pt.subtotalsTop = false; }
    else pt.subtotals = false;
  }
  if (typeof p.style === 'string') pt.style = p.style;
  if (typeof p.grandTotalsRows === 'boolean') pt.grandTotalsRows = p.grandTotalsRows;
  if (typeof p.grandTotalsCols === 'boolean') pt.grandTotalsCols = p.grandTotalsCols;
  if (typeof p.showHeaders === 'boolean') pt.showHeaders = p.showHeaders;
  return {layout: pt.layout};
});
function grandTotals(ctx, p) {
  let rows = p.rows, cols = p.cols;
  switch (String(p.mode ?? '').toLowerCase()) {
    case 'off': rows = false; cols = false; break;
    case 'on': rows = true; cols = true; break;
    case 'rows': rows = true; cols = false; break;
    case 'columns': case 'cols': rows = false; cols = true; break;
    case '': break;
    default: throw bad('pivot.grandTotals', `unknown mode \`${p.mode}\` (off|on|rows|columns)`);
  }
  return layoutCmd(ctx, {pivot: p.pivot, replace: p.replace, ...(typeof rows === 'boolean' ? {grandTotalsRows: rows} : {}), ...(typeof cols === 'boolean' ? {grandTotalsCols: cols} : {})});
}
const refreshCmd = (ctx, p) => update(ctx, p, (_pt, src) => ({records: src.rows.length}));

function refreshAll(ctx, p) {
  let n = 0;
  const errors = [];
  ctx.doc.sheets.forEach((sh, si) => (sh.pivots ?? []).forEach((pt, pi) => {
    try { refreshPivot(ctx, si, pi, p.replace === true); n += 1; } catch (e) { errors.push({pivot: pt.name, error: e.message}); }
  }));
  return {refreshed: n, errors};
}

const changeSource = (ctx, p) => {
  if (typeof (p.source ?? p.range) !== 'string') throw bad('pivot.changeSource', 'missing `source`');
  const source = sourceParam(ctx, p);
  const [si] = findPivot(ctx, p);
  let ns;
  try { ns = pv.readSource(baseDoc(ctx), source, si); } catch (e) { throw failed(e.message); }
  return update(ctx, p, pt => {
    pt.source = source;
    const dropped = [];
    const keep = name => { const ok = ns.col(name) >= 0; if (!ok) dropped.push(name); return ok; };
    pt.rows = pt.rows.filter(f => keep(f.sourceCol)); pt.columns = pt.columns.filter(f => keep(f.sourceCol));
    pt.values = pt.values.filter(f => keep(f.sourceCol)); pt.filters = pt.filters.filter(f => keep(f.sourceCol));
    return {source, dropped};
  });
};

// ---------------------------------------------------------------- Show Details (create.rs `show_details`, menus.rs `show_details_offered`)

const SHOW_DETAILS_OFF = 'Show Details is turned off for this PivotTable.';

/** The cell a Show Details call names (`cell`, default the active cell) and the PivotTable of the active sheet whose report holds it. */
function detailTarget(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  let at = sel.active;
  if (typeof p.cell === 'string') { const c = parseCell(p.cell.replace(/\$/g, '').replace(/^.*!/, '')); if (!c) throw bad('pivot.showDetails', `not a cell: \`${p.cell}\``); at = c; }
  const list = content.sheets[sel.sheet]?.pivots ?? [];
  const pi = list.findIndex(pt => pt.lastRange && contains(parseRange(pt.lastRange), at));
  return {content, si: sel.sheet, at, pi, pt: list[pi] ?? null};
}

/** Offered (the context menu shows Show Details) only on a value, subtotal or grand total cell of a report whose option is on. */
function showDetailsState(ctx, p = {}) {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  let target;
  try { target = detailTarget(ctx, p ?? {}); } catch (e) { return {enabled: false, reason: e.message}; }
  const {content, si, at, pt} = target;
  if (!pt) return {enabled: false, hidden: true, reason: pv.NOT_A_VALUE_CELL};
  if (!pt.enableShowDetails) return {enabled: false, hidden: true, reason: SHOW_DETAILS_OFF};
  const o = parseRange(pt.lastRange).start;
  let cells = null;
  try { cells = pv.detailCells(content, pt, si); } catch { /* stale or unreadable: offered, and running it says why */ }
  return !cells || cells.has(`${at.row - o.row},${at.col - o.col}`) ? {enabled: true} : {enabled: false, hidden: true, reason: pv.NOT_A_VALUE_CELL};
}

/** Show Details: the source records behind a value cell, under the source headers, on a new sheet before the current one. */
function showDetails(ctx, p) {
  const {content, si, at, pt} = detailTarget(ctx, p);
  if (!pt) throw failed(pv.NOT_A_VALUE_CELL);
  const o = parseRange(pt.lastRange).start;
  let found, error = null;
  try { found = pv.detailRecords(content, pt, si, at.row - o.row, at.col - o.col); } catch (e) { error = e; }
  // With the option off, a stale report or an unreadable source reports the option; a cell that is not a value cell keeps its own message.
  if (!pt.enableShowDetails && !(error === null && found === null)) throw failed(SHOW_DETAILS_OFF);
  if (error) throw failed(error.message);
  if (!found) throw failed(pv.NOT_A_VALUE_CELL);
  if (content.protection?.structure) throw failed('The workbook is protected and cannot be changed.');
  const {src, records} = found;
  ctx.run('home.insertSheet', {before: si});
  const ns = si;
  requireSchema2(ctx, ns);
  const ds = content.dateSystem === 1904 ? 1904 : 1900;
  const styles = src.formats.map(f => (f && f !== 'General' ? deriveStyle(ctx.change, ctx.doc, 0, {numFmt: f}) : 0));
  // Columns wide enough for their text, as the report's are (dates would show as ####); the first rows are enough to judge.
  const widths = src.headers.map((h, c) => {
    let w = approxTextWidth(h, 11, false);
    for (const i of records.slice(0, 1000)) { const v = src.rows[i]?.[c]; if (v !== null && v !== undefined && v !== '') w = Math.max(w, approxTextWidth(formatValue(v, src.formats[c] ?? 'General', ds).text, 11, false)); }
    return Math.min(w + 14, 320);
  });
  const cols = {...(ctx.doc.sheets[ns].cols ?? {})};
  widths.forEach((w, c) => { if (w > (cols[c]?.size ?? 64)) cols[c] = {...(cols[c] ?? {}), size: Math.round(w)}; });
  ctx.change.set(['sheets', ns, 'cols'], cols);
  src.headers.forEach((h, c) => writeCell(ctx.change, ctx.doc, ns, 0, c, {v: h}));
  records.forEach((i, r) => (src.rows[i] ?? []).forEach((v, c) => {
    const empty = v === null || v === undefined || v === '';
    if (empty && !styles[c]) return;
    const cell = {s: styles[c] || undefined};
    if (!empty) cell.v = toJSONValue(v);
    writeCell(ctx.change, ctx.doc, ns, r + 1, c, cell);
  }));
  setGridSelection(ctx, selectionAt(ns, {row: 0, col: 0}));
  return {sheet: ctx.doc.sheets[ns].name, records: records.length};
}

/** PivotTable slicers follow a renamed PivotTable (`next`), or lose a deleted one (`next` null; a slicer left with none is deleted). */
function relinkSlicers(ctx, old, next) {
  ctx.doc.sheets.forEach((sh, sj) => {
    if (!(sh.slicers ?? []).some(sl => typeof sl.pivot === 'string')) return;
    const out = [];
    for (const sl of sh.slicers) {
      if (typeof sl.pivot !== 'string') { out.push(sl); continue; }
      const now = Array.isArray(sl.pivots) && sl.pivots.length ? sl.pivots : [sl.pivot];
      if (!now.some(n => eq(n, old))) { out.push(sl); continue; }
      const pivots = next === null ? now.filter(n => !eq(n, old)) : now.map(n => (eq(n, old) ? next : n));
      if (pivots.length) out.push({...sl, pivots, pivot: pivots[0]});
    }
    if (out.length) ctx.change.set(['sheets', sj, 'slicers'], out); else ctx.change.delete(['sheets', sj, 'slicers']);
  });
}

function options(ctx, p) {
  const [si, pi] = findPivot(ctx, p);
  const pt = baseDoc(ctx).sheets[si].pivots[pi];
  if (typeof p.name === 'string' && p.name.trim() && !eq(p.name.trim(), pt.name)) {
    const n = p.name.trim();
    if (baseDoc(ctx).sheets.some(sh => (sh.pivots ?? []).some(x => eq(x.name, n)))) throw failed('A PivotTable with that name already exists.');
    ctx.change.set(['sheets', si, 'pivots', pi, 'name'], n);
    relinkSlicers(ctx, pt.name, n);
  }
  if (typeof p.enableShowDetails === 'boolean' && p.enableShowDetails !== pt.enableShowDetails) ctx.change.set(['sheets', si, 'pivots', pi, 'enableShowDetails'], p.enableShowDetails);
  return {enableShowDetails: typeof p.enableShowDetails === 'boolean' ? p.enableShowDetails : pt.enableShowDetails};
}

function deletePivot(ctx, p) {
  const [si, pi] = findPivot(ctx, p);
  requireSchema2(ctx, si);
  const content = ctx.doc;
  const sheet = content.sheets[si];
  const pt = sheet.pivots[pi];
  if (locked(sheet)) throw failed(PROTECTED);
  if (pt.lastRange) {
    const r = parseRange(pt.lastRange);
    for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) if (cellAt(sheet, row, col)) writeCell(ctx.change, ctx.doc, si, row, col, {});
  }
  const rest = (ctx.doc.sheets[si].pivots ?? []).filter((_, i) => i !== pi);
  if (rest.length) ctx.change.set(['sheets', si, 'pivots'], rest); else ctx.change.delete(['sheets', si, 'pivots']);
  relinkSlicers(ctx, pt.name, null);
  return {};
}

const BASE = {pivot: PIVOT, replace: REPLACE};
const BUILD = {source: s.optional(s.string({max: 4096})), range: s.optional(s.string({max: 4096})), destination: s.optional(s.string({max: 300})), location: s.optional(s.string({max: 300})), name: s.optional(s.string({max: 255})),
        rows: s.optional(s.array(s.union([s.string({max: 255}), s.object({field: NAME, group: s.optional(s.enum(['years', 'quarters', 'months', 'days', 'none']))})]), {max: 512})),
        columns: s.optional(s.array(s.union([s.string({max: 255}), s.object({field: NAME, group: s.optional(s.enum(['years', 'quarters', 'months', 'days', 'none']))})]), {max: 512})),
        values: s.optional(s.array(s.union([s.string({max: 255}), s.object({field: NAME, func: FUNC, name: s.optional(s.string({max: 255}))})]), {max: 512})),
        filters: s.optional(s.array(s.string({max: 255}), {max: 512})), replace: REPLACE};


export default defineCommands({
  family: 'pivot',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.pivotTable', label: 'PivotTable', risk: 'edit', dialog: 'dialog.createPivotTable',
      description: 'Insert a PivotTable: `source` (a range such as Sheet1!$A$1:$E$200 or a table name; default the table or current region of the selection), `destination` ("new", the default: a new sheet before the current one with the report at A3, or Sheet1!H3), `name`, and the fields: `rows`, `columns`, `filters` (names or {field, group}) and `values` (names or {field, func, name}). Returns {id, name, sheet, anchor, range, source, fields}.',
      params: s.object(BUILD), state: hasDoc, run: insertPivot},
    {id: 'table.summarizePivot', label: 'Summarize with PivotTable', risk: 'edit', dialog: 'dialog.createPivotTable', description: 'Create a PivotTable from a table (`table`, default the one at the selection).',
      params: s.object({...BUILD, table: s.optional(s.string({max: 255}))}), state: hasDoc, run: summarizeTable},
    {id: 'pivot.fields', label: 'PivotTable Fields', risk: 'read', description: 'The source fields (name, numeric, date, samples, areas) and the layout of a PivotTable.', params: s.object({pivot: PIVOT}), state: pivotState, run: fieldsQuery},
    {id: 'pivot.fieldList', label: 'Field List', risk: 'read', effect: 'view', description: 'Show or hide the PivotTable Fields pane (`on`).', params: s.object({pivot: PIVOT, on: s.optional(s.boolean())}),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? {...st, checked: !!ctx.view?.pivotPane} : st; },
      run: (ctx, p) => { const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.pivotPane; ctx.setView({pivotPane: on}); return {on}; }},
    {id: 'pivot.list', label: 'PivotTables', risk: 'read', description: 'Every PivotTable of the workbook.', params: s.object({}), state: hasDoc, run: listQuery},
    {id: 'pivot.addField', label: 'Add Field', risk: 'edit', description: 'Put a field in an area: `field`, `area` rows|columns|values|filters, `func`, `name`, `position`.',
      params: s.object({...BASE, field: NAME, area: s.enum(AREAS), func: FUNC, name: s.optional(s.string({max: 255})), position: POS}), state: pivotState, run: addField},
    {id: 'pivot.removeField', label: 'Remove Field', risk: 'edit', description: 'Take a field (or a value caption) out of an area, or out of every area.',
      params: s.object({...BASE, field: NAME, area: s.optional(s.enum(AREAS))}), state: pivotState, run: removeField},
    {id: 'pivot.moveField', label: 'Move Field', risk: 'edit', description: 'Move a field between areas, or within one (`position`).',
      params: s.object({...BASE, field: NAME, from: s.enum(AREAS), to: s.enum(AREAS), position: POS}), state: pivotState, run: moveField},
    {id: 'pivot.valueSettings', label: 'Value Field Settings', risk: 'edit', dialog: 'dialog.valueFieldSettings',
      description: 'Settings of a value field (`field` caption or source field, or `index`): `func`, `name`, `showAs` normal|percentOfGrandTotal|percentOfColumnTotal|percentOfRowTotal|runningTotal|rank, `numberFormat` (a code, or null).',
      params: s.object({...BASE, field: s.optional(s.string({max: 255})), index: s.optional(s.integer({min: 0})), func: FUNC, name: s.optional(s.string({max: 255})), showAs: s.optional(s.enum(pv.SHOW_AS)), numberFormat: s.optional(s.nullable(s.string({max: 255})))}),
      state: pivotState, run: valueSettings},
    {id: 'pivot.filter', label: 'Filter Items', risk: 'edit', description: 'Show only the item labels in `selected` of a field (null: all).',
      params: s.object({...BASE, field: NAME, selected: s.optional(s.nullable(s.union([s.array(s.nullable(s.union([s.string({max: 1000}), s.number()])), {max: 100000}), s.string({max: 1000})])))}), state: pivotState, run: filterCmd},
    {id: 'pivot.sort', label: 'Sort Field', risk: 'edit', description: 'Sort the items of a row or column field: asc, desc or none (source order).',
      params: s.object({...BASE, field: s.optional(NAME), order: s.optional(s.enum(['asc', 'desc', 'none']))}), state: pivotState, run: sortCmd},
    {id: 'pivot.group', label: 'Group Field', risk: 'edit', description: 'Group a date field of the rows or columns by years, quarters, months or days (none ungroups).',
      params: s.object({...BASE, field: s.optional(NAME), by: s.optional(s.enum(['years', 'quarters', 'months', 'days', 'none']))}), state: pivotState, run: groupCmd},
    {id: 'pivot.collapse', label: 'Expand/Collapse Field', risk: 'edit', description: 'Collapse (or with collapse: false expand) the items of a field (`items`, default all).',
      params: s.object({...BASE, field: s.optional(NAME), items: s.optional(s.array(s.string({max: 1000}), {max: 100000})), collapse: s.optional(s.boolean())}), state: pivotState, run: collapseCmd},
    {id: 'pivot.layout', label: 'PivotTable Layout', risk: 'edit', description: 'Layout compact|outline|tabular, grandTotalsRows, grandTotalsCols, subtotals (true, false, top, bottom, none), style, showHeaders.',
      params: s.object({...BASE, layout: s.optional(s.enum(['compact', 'outline', 'tabular'])), grandTotalsRows: s.optional(s.boolean()), grandTotalsCols: s.optional(s.boolean()),
        subtotals: s.optional(s.union([s.boolean(), s.enum(['top', 'bottom', 'none', 'off'])])), style: s.optional(s.string({max: 64})), showHeaders: s.optional(s.boolean())}), state: pivotState, run: layoutCmd},
    {id: 'pivot.grandTotals', label: 'Grand Totals', risk: 'edit', description: 'Grand totals: mode off|on|rows|columns, or rows and cols as booleans.',
      params: s.object({...BASE, mode: s.optional(s.enum(['off', 'on', 'rows', 'columns', 'cols'])), rows: s.optional(s.boolean()), cols: s.optional(s.boolean())}), state: pivotState, run: grandTotals},
    {id: 'pivot.subtotals', label: 'Subtotals', risk: 'edit', description: 'Subtotals: mode none|top|bottom.', params: s.object({...BASE, mode: s.optional(s.enum(['none', 'top', 'bottom']))}),
      state: pivotState, run: (ctx, p) => layoutCmd(ctx, {pivot: p.pivot, replace: p.replace, subtotals: p.mode ?? 'top'})},
    {id: 'pivot.reportLayout', label: 'Report Layout', risk: 'edit', description: 'Report layout compact|outline|tabular.', params: s.object({...BASE, layout: s.enum(['compact', 'outline', 'tabular'])}), state: pivotState, run: layoutCmd},
    {id: 'pivot.style', label: 'PivotTable Styles', risk: 'edit', description: 'The PivotTable style, such as PivotStyleMedium9.',
      params: s.object({...BASE, style: s.string({min: 1, max: 64})}),
      state: ctx => { const st = pivotState(ctx); return st.enabled ? {...st, value: pivotStyleTiles(ctx)} : st; }, run: layoutCmd},
    {id: 'pivot.refresh', label: 'Refresh', risk: 'edit', shortcut: 'Alt+F5', description: 'Compute the PivotTable again from its source and write the report.', params: s.object(BASE), state: pivotState, run: refreshCmd},
    {id: 'data.refreshAll', label: 'Refresh All', risk: 'edit', shortcut: 'Mod+Alt+F5', description: 'Refresh every PivotTable of the workbook.', params: s.object({replace: REPLACE}),
      state: ctx => (hasDoc(ctx).enabled && ctx.doc.sheets.some(sh => (sh.pivots ?? []).length) ? {enabled: true} : {enabled: false, reason: 'there is no PivotTable to refresh'}), run: refreshAll},
    {id: 'pivot.changeSource', label: 'Change Data Source', risk: 'edit', dialog: 'dialog.changePivotSource', description: 'Point a PivotTable at another source (fields missing from it are removed).',
      params: s.object({...BASE, source: s.optional(s.string({max: 4096})), range: s.optional(s.string({max: 4096}))}), state: pivotState, run: changeSource},
    {id: 'pivot.showDetails', label: 'Show Details', risk: 'edit',
      description: 'Show Details: the source records behind a value, subtotal or grand total cell (`cell`, default the active cell) of a PivotTable on the active sheet, on a new sheet before the current one. Returns {sheet, records}. Refused while the PivotTable Enable show details option is off, or when the report is out of date.',
      params: s.object({cell: s.optional(s.string({max: 64}))}), state: showDetailsState, run: showDetails},
    {id: 'pivot.options', label: 'PivotTable Options', risk: 'edit', description: 'Options of a PivotTable: `name`, and enableShowDetails (Data > Enable show details: Show Details and double-clicking a value cell list its records only while this is on).',
      params: s.object({pivot: PIVOT, name: s.optional(s.string({max: 255})), enableShowDetails: s.optional(s.boolean())}), dialog: 'dialog.pivotTableOptions',
      state: ctx => { const st = pivotState(ctx); if (!st.enabled) return st; try { const [si, pi] = findPivot(ctx, {}); return {...st, value: ctx.doc.sheets[si].pivots[pi].name}; } catch { return st; } }, run: options},
    {id: 'pivot.clear', label: 'Clear All', risk: 'edit', description: 'Take every field out of the PivotTable (it stays, empty).', params: s.object(BASE), state: pivotState,
      run: (ctx, p) => update(ctx, p, pt => { pt.rows = []; pt.columns = []; pt.values = []; pt.filters = []; return {}; })},
    {id: 'pivot.clearFilters', label: 'Clear Filters', risk: 'edit', description: 'Show every item again: clears the item selections of all fields.', params: s.object(BASE), state: pivotState,
      run: (ctx, p) => update(ctx, p, pt => { pt.filters = pt.filters.filter(f => !inAxes(pt, f.sourceCol)).map(f => ({...f, selected: null})); return {}; })},
    {id: 'pivot.fieldHeaders', label: 'Field Headers', risk: 'edit', description: 'Show or hide the field captions of the report (`on`).', params: s.object({...BASE, on: s.optional(s.boolean())}),
      state: ctx => {
        const st = pivotState(ctx);
        if (!st.enabled) return st;
        let on = true;
        try { const [si, pi] = findPivot(ctx, {}); on = ctx.doc.sheets[si].pivots[pi].showHeaders !== false; } catch { /* none */ }
        return {...st, checked: on};
      },
      run: (ctx, p) => { const [si, pi] = findPivot(ctx, p); const cur = ctx.doc.sheets[si].pivots[pi].showHeaders !== false; return layoutCmd(ctx, {pivot: p.pivot, replace: p.replace, showHeaders: typeof p.on === 'boolean' ? p.on : !cur}); }},
    {id: 'pivot.delete', label: 'Delete PivotTable', risk: 'edit', description: 'Clear the report and remove the PivotTable.', params: s.object({pivot: PIVOT}), state: pivotState, run: deletePivot},
  ],
});

/** The PivotTable Styles gallery: the 28 Light, 28 Medium and 28 Dark styles, each drawn with its header, line and band colours. */
function pivotStyleTiles(ctx) {
  let current = '';
  try { const [si, pi] = findPivot(ctx, {}); current = ctx.doc.sheets[si].pivots[pi].style; } catch { /* none */ }
  const theme = ctx.doc?.theme ?? DEFAULT_THEME;
  const hexOf = c => (c ? hex(resolveColor(c, theme)) : null);
  const out = [];
  for (const fam of ['Light', 'Medium', 'Dark']) for (let n = 1; n <= 28; n++) {
    const name = 'PivotStyle' + fam + n;
    const lk = pv.look(name);
    out.push({id: name, label: fam + ' ' + n, value: name, group: fam, selected: name === current, iconOnly: true,
      art: {kind: 'pivot', header: hexOf(lk.headerFill), line: hexOf(lk.line), band: hexOf(lk.filterFill), text: lk.headerFont ? '#FFFFFF' : '#222222'}});
  }
  return out;
}

export {findPivot, activeField, defaultSource, update, insertPivot, sourceParam, calcField, canonicalAny, pivotState};
