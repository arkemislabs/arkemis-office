// PivotTables: reading the source list, grouping and aggregating, laying out the report, and the report as a grid of cells.
// Translated from gridcraft crates/engine/src/pivot.rs and pivot/{items,compute,output}.rs at fb1e59f (behaviour follows
// Excel's PivotTable model: rows, columns, values and filters, Compact, Outline and Tabular layouts, subtotals, grand totals, show
// values as). MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// A PivotTable is stored on its sheet (sheet.pivots[]): {id, name, source, anchor 'A3', rows: [{sourceCol, sort: asc|desc|none,
// dateGroup: none|years|quarters|months|days, collapsedItems}], columns, values: [{sourceCol, func, name, showAs, numberFormat}],
// filters: [{sourceCol, selected: null | [labels]}], layout: compact|outline|tabular, enableShowDetails, grandTotalsRows,
// grandTotalsCols, subtotals, subtotalsTop, style, showHeaders, lastRange 'A3:D10'}. The report itself is plain values and styles on the
// sheet, written again on every refresh.
//
// Calculated fields are in pivot-calc.mjs. Not translated (hidden with notes): Σ Values in rows.

import {engineFor} from '../model/calc.mjs';
import {displayAt} from '../model/index.mjs';
import {styleAt} from '../model/workbook.mjs';
import {cellAt, usedBounds} from '../model/store.mjs';
import {parseRange, rangeA1, quoteSheet, colToLetters, isFullRows, isFullCols, a1, MAX_ROWS, MAX_COLS} from './addr.mjs';
import {formatValue, parseFormat} from './numfmt.mjs';
import {datetimeFromSerial} from './date.mjs';
import {CellError, ERR, GArray, toJSONValue} from './value.mjs';
import {tableByName, tableRanges, sheetIndex} from '../model/sheet.mjs';
import {CalcSet} from './pivot-calc.mjs';

/** Largest source block read (cells); largest report written (cells); most axis and value fields. */
export const MAX_SOURCE_CELLS = 10_000_000, MAX_OUTPUT_CELLS = 2_000_000, MAX_AXIS_FIELDS = 32, MAX_VALUE_FIELDS = 256;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const FUNCS = Object.freeze(['sum', 'count', 'average', 'max', 'min', 'product', 'countNumbers', 'stdDev', 'stdDevP', 'var', 'varP']);
export const SHOW_AS = Object.freeze(['normal', 'percentOfGrandTotal', 'percentOfColumnTotal', 'percentOfRowTotal', 'runningTotal', 'rank']);

// ---------------------------------------------------------------- source

/** Absolute reference text for a range on a sheet: `Sheet1!$A$1:$E$20`. */
export function rangeText(sheetName, r) {
  const abs = c => `$${colToLetters(c.col)}$${c.row + 1}`;
  return `${quoteSheet(sheetName)}!${abs(r.start)}:${abs(r.end)}`;
}

const INVALID = "The reference isn't valid.";
const splitSheet = t => { const i = t.lastIndexOf('!'); return i < 0 ? [null, t] : [t.slice(0, i).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"), t.slice(i + 1)]; };

/** Resolves source text (a range, a table name or a defined name) to {si, range including the header}; throws an Error with Excel's wording. */
export function resolveSource(content, text, defaultSheet, depth = 0) {
  const t = String(text ?? '').trim().replace(/^=/, '').trim();
  if (!t || depth > 4) throw new Error(INVALID);
  const tb = tableByName(content, t);
  if (tb) {
    const [si, table] = tb;
    const g = tableRanges(table);
    if (!g.headerRow) throw new Error('The table needs a header row to be used as a PivotTable source.');
    return {si, range: {start: {...g.range.start}, end: {row: Math.max(g.range.start.row, g.range.end.row - (g.totalsRow ? 1 : 0)), col: g.range.end.col}}};
  }
  const [sheetName, body] = splitSheet(t);
  const r = parseRange(body.replace(/\$/g, ''));
  if (r) {
    const si = sheetName === null ? defaultSheet : sheetIndex(content, sheetName);
    if (si < 0 || !content.sheets[si]) throw new Error(INVALID);
    if (isFullCols(r) || isFullRows(r)) {
      const u = usedBounds(content.sheets[si]);
      if (!u) throw new Error(INVALID);
      const range = {start: {row: Math.max(r.start.row, u.r0), col: Math.max(r.start.col, u.c0)}, end: {row: Math.min(r.end.row, u.r1), col: Math.min(r.end.col, u.c1)}};
      if (range.end.row < range.start.row || range.end.col < range.start.col) throw new Error(INVALID);
      return {si, range};
    }
    return {si, range: r};
  }
  if (sheetName === null) {
    const n = (content.names ?? []).find(x => x.name.toLowerCase() === t.toLowerCase() && (x.scope === undefined || x.scope === content.sheets[defaultSheet]?.id));
    if (n) return resolveSource(content, n.formula, defaultSheet, depth + 1);
  }
  throw new Error(INVALID);
}

const FIELD_NAME_ERR = 'The PivotTable field name is not valid. To create a PivotTable, you must use data that is organized as a list with labeled columns.';
const scalar = v => (v instanceof GArray ? (v.data[0] instanceof GArray ? null : v.data[0] ?? null) : v ?? null);
const isEmpty = v => v === null || v === undefined || v === '';

/** Reads the source list: {si, range, headers, formats, numeric, dates, rows (records of values)}. */
export function readSource(content, text, defaultSheet) {
  const {si, range: r} = resolveSource(content, text, defaultSheet);
  const sheet = content.sheets[si];
  const w = r.end.col - r.start.col + 1, h = r.end.row - r.start.row + 1;
  if (w * h > MAX_SOURCE_CELLS) throw new Error('The source range is too large for a PivotTable.');
  const engine = engineFor(content);
  const headers = [], formats = [], taken = new Set(), nextSuffix = new Map();
  for (let c = r.start.col; c <= r.end.col; c++) {
    const head = displayAt(content, si, r.start.row, c).text.trim();
    if (!head) throw new Error(FIELD_NAME_ERR);
    const key = head.toLowerCase();
    let name = head, k = nextSuffix.get(key) ?? 2;
    while (taken.has(name.toLowerCase())) { name = `${head}${k}`; k += 1; }
    nextSuffix.set(key, k); taken.add(name.toLowerCase()); headers.push(name);
    formats.push(h > 1 ? styleAt(content, sheet, r.start.row + 1, c).numFmt ?? 'General' : 'General');
  }
  const rows = [], numeric = Array(w).fill(true), any = Array(w).fill(false);
  for (let row = r.start.row + 1; row <= r.end.row; row++) {
    const rec = [];
    for (let c = r.start.col; c <= r.end.col; c++) rec.push(scalar(engine.sheetValue(si, row, c)));
    if (rec.every(isEmpty)) continue;
    rec.forEach((v, i) => { if (!isEmpty(v)) { any[i] = true; if (typeof v !== 'number') numeric[i] = false; } });
    rows.push(rec);
  }
  for (let i = 0; i < w; i++) numeric[i] = numeric[i] && any[i];
  const dates = numeric.map((n, i) => n && parseFormat(formats[i]).isDate());
  return {si, range: r, headers, formats, numeric, dates, rows, col: name => headers.findIndex(x => x.toLowerCase() === String(name).toLowerCase())};
}

// ---------------------------------------------------------------- items

const cmpItems = (a, b) => a.cls - b.cls || a.num - b.num || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);

/** [identity key, item] for a source value under a field's date grouping. */
function makeItem(content, v0, group, fmt, first) {
  const v = scalar(v0);
  const it = (value, label, cls, num, formatted) => ({value, label, cls, num, text: label.toLowerCase(), first, formatted});
  if (isEmpty(v)) return ['b', it('(blank)', '(blank)', 4, 0, false)];
  if (typeof v === 'number') {
    if (group && group !== 'none') {
      const dt = datetimeFromSerial(content.dateSystem === 1904 ? 1904 : 1900, v);
      if (dt) {
        const mon = MONTHS[Math.max(0, dt.month - 1)] ?? 'Jan';
        let label, key;
        if (group === 'years') { label = String(dt.year); key = dt.year; }
        else if (group === 'quarters') { key = Math.floor((dt.month - 1) / 3) + 1; label = `Qtr${key}`; }
        else if (group === 'months') { label = mon; key = dt.month; }
        else { label = `${dt.day}-${mon}`; key = dt.month * 100 + dt.day; }
        return [`g${key}`, it(label, label, 0, key, false)];
      }
    }
    const label = formatValue(v, fmt, content.dateSystem === 1904 ? 1904 : 1900).text;
    return [`n${v}`, it(v, label, 0, v, true)];
  }
  if (typeof v === 'string') return [`t${v.toLowerCase()}`, it(v, v, 1, 0, false)];
  if (typeof v === 'boolean') { const l = v ? 'TRUE' : 'FALSE'; return [`l${l}`, it(v, l, 2, v ? 1 : 0, false)]; }
  if (v instanceof CellError) return [`e${v.text}`, it(v, v.text, 3, 0, false)];
  return ['b', it('(blank)', '(blank)', 4, 0, false)];
}

class FieldItems {
  constructor() { this.items = []; this.index = new Map(); }
  intern(content, v, group, fmt, first) {
    const [key, item] = makeItem(content, v, group, fmt, first);
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;
    this.items.push(item); this.index.set(key, this.items.length - 1);
    return this.items.length - 1;
  }
  get(i) { return this.items[i]; }
  label(i) { return this.items[i]?.label ?? ''; }
}

/** The label of a source value under a date grouping (for filters and the field list). */
export const itemLabel = (content, v, group, fmt) => makeItem(content, v, group, fmt, 0)[1].label;

/** Distinct item labels of a source column, sorted as the field list shows them. */
export function distinctLabels(content, src, col, group = 'none', limit = 1000) {
  const fi = new FieldItems();
  const fmt = src.formats[col] ?? 'General';
  for (let i = 0; i < src.rows.length && fi.items.length <= 100_000; i++) fi.intern(content, src.rows[i][col], group, fmt, i);
  return [...fi.items].sort(cmpItems).slice(0, limit).map(i => i.label);
}

// ---------------------------------------------------------------- aggregation

class Acc {
  constructor() { this.count = 0; this.nums = 0; this.sum = 0; this.prod = 0; this.min = 0; this.max = 0; this.mean = 0; this.m2 = 0; this.err = null; }
  add(v0) {
    const v = scalar(v0);
    if (isEmpty(v)) return;
    if (typeof v === 'number') {
      this.count += 1; this.nums += 1; this.sum += v;
      if (this.nums === 1) { this.prod = v; this.min = v; this.max = v; } else { this.prod *= v; this.min = Math.min(this.min, v); this.max = Math.max(this.max, v); }
      const d = v - this.mean;
      this.mean += d / this.nums; this.m2 += d * (v - this.mean);
    } else if (v instanceof CellError) { this.count += 1; this.err ??= v; } else this.count += 1;
  }
  result(f) {
    const n = this.nums;
    if (f === 'count') return this.count;
    if (f === 'countNumbers') return n;
    if (this.err) return this.err;
    switch (f) {
      case 'sum': return this.sum;
      case 'average': return n === 0 ? ERR.Div0 : this.sum / n;
      case 'max': return n === 0 ? 0 : this.max;
      case 'min': return n === 0 ? 0 : this.min;
      case 'product': return n === 0 ? 0 : this.prod;
      case 'stdDev': case 'var': { if (n < 2) return ERR.Div0; const v = Math.max(0, this.m2 / (n - 1)); return f === 'var' ? v : Math.sqrt(v); }
      case 'stdDevP': case 'varP': { if (n < 1) return ERR.Div0; const v = Math.max(0, this.m2 / n); return f === 'varP' ? v : Math.sqrt(v); }
      default: return null;
    }
  }
}

/** Excel's caption verb for a function ("Sum of Sales"). */
export const funcCaption = f => ({sum: 'Sum', count: 'Count', average: 'Average', max: 'Max', min: 'Min', product: 'Product', countNumbers: 'Count Numbers', stdDev: 'StdDev', stdDevP: 'StdDevp', var: 'Var', varP: 'Varp'}[f] ?? 'Sum');

// ---------------------------------------------------------------- trees

function buildTree(paths, depth, fields, items) {
  const field = fields[depth], fi = items[depth];
  if (!field || !fi) return [];
  const order = [], groups = new Map();
  for (const p of paths) {
    const it = p[depth];
    if (it === undefined) continue;
    let g = groups.get(it);
    if (!g) { g = []; groups.set(it, g); order.push(it); }
    g.push(p);
  }
  const nodes = order.map(it => ({item: it, children: buildTree(groups.get(it), depth + 1, fields, items)}));
  nodes.sort((a, b) => {
    const x = fi.get(a.item), y = fi.get(b.item);
    if (!x || !y) return 0;
    return field.sort === 'desc' ? cmpItems(y, x) : field.sort === 'none' ? x.first - y.first : cmpItems(x, y);
  });
  return nodes;
}
const isCollapsed = (field, label) => (field.collapsedItems ?? []).some(c => c.toLowerCase() === label.toLowerCase());
function collectSiblings(nodes, prefix, out) {
  out.set(prefix.join(','), nodes.map(n => n.item));
  for (const n of nodes) { prefix.push(n.item); collectSiblings(n.children, prefix, out); prefix.pop(); }
}

// ---------------------------------------------------------------- report grid

/** What a report cell and a report row are, for styling. */
const empty = () => ({value: null, kind: 'empty', indent: 0, numFmt: null});
/** The item a label cell names, for the +/- buttons: {axis: rows|columns, level, label}. */
const itemMeta = (axis, level, label) => ({axis, level, label});

class Grid {
  constructor(width) { this.rows = []; this.kinds = []; this.width = width; }
  pushRow(kind) {
    if ((this.rows.length + 1) * Math.max(1, this.width) > MAX_OUTPUT_CELLS || this.rows.length >= MAX_ROWS) throw new Error('The PivotTable report is too large.');
    this.rows.push(Array.from({length: this.width}, empty)); this.kinds.push(kind);
    return this.rows.length - 1;
  }
  set(r, c, value, kind, indent = 0, numFmt = null, meta = undefined) { if (this.rows[r]?.[c]) this.rows[r][c] = {value, kind, indent, numFmt, ...(meta ? {meta} : {})}; }
}

/** The empty row Insert Blank Line after Each Item adds after each outer item (and its subtotal). */
const BLANK_LINE = () => ({kind: 'blank', leaf: false, path: [], values: false, labels: []});

class Ctx {
  constructor(pt, rows, rowItems, rowFmts) { this.pt = pt; this.rows = rows; this.rowItems = rowItems; this.rowFmts = rowFmts; }
  labelCell(depth, item) {
    const it = this.rowItems[depth]?.get(item);
    if (!it) return [null, null, ''];
    return [it.value, it.formatted ? this.rowFmts[depth] : null, it.label];
  }
  levelCell(level) { return this.pt.layout === 'outline' ? [level, 0] : [0, Math.min(level, 250)]; }
  flatten(nodes, depth, prefix, out) {
    const n = this.rows.length;
    const [col, indent] = this.levelCell(depth);
    for (const node of nodes) {
      prefix.push(node.item);
      const [v, fmt, label] = this.labelCell(depth, node.item);
      const collapsed = depth + 1 < n && this.rows[depth] && isCollapsed(this.rows[depth], label);
      const leaf = depth + 1 >= n || collapsed || !node.children.length;
      if (leaf) {
        // Repeat All Item Labels in Outline form: a row also names the groups above it in their own columns.
        const above = this.pt.repeatLabels && this.pt.layout === 'outline' ? prefix.slice(0, -1).map((it, d) => { const [av, afmt] = this.labelCell(d, it); return [d, av, 0, afmt]; }) : [];
        out.push({kind: 'item', parent: depth + 1 < n, leaf: true, path: [...prefix], values: true, labels: [...above, [col, v, indent, fmt, itemMeta('rows', depth, label)]]});
      }
      else {
        const top = this.pt.subtotals && this.pt.subtotalsTop;
        out.push({kind: 'item', parent: true, leaf: false, path: [...prefix], values: top, labels: [[col, v, indent, fmt, itemMeta('rows', depth, label)]]});
        this.flatten(node.children, depth + 1, prefix, out);
        if (this.pt.subtotals && !this.pt.subtotalsTop) out.push({kind: 'subtotal', leaf: false, path: [...prefix], values: true, labels: [[col, `${label} Total`, indent, null]]});
      }
      prefix.pop();
      if (depth === 0 && this.pt.blankRows) out.push(BLANK_LINE());
    }
  }
  /** Tabular rows. `anc` is every label above (Repeat All Item Labels writes them again on each row; otherwise only a group's first row has them). */
  flattenTabular(nodes, depth, prefix, pending, out, anc = []) {
    const n = this.rows.length;
    nodes.forEach((node, i) => {
      prefix.push(node.item);
      const [v, fmt, label] = this.labelCell(depth, node.item);
      const own = [depth, v, 0, fmt, itemMeta('rows', depth, label)];
      const labels = i === 0 ? [...pending, own] : this.pt.repeatLabels ? [...anc, own] : [own];
      const collapsed = depth + 1 < n && this.rows[depth] && isCollapsed(this.rows[depth], label);
      if (depth + 1 >= n || collapsed || !node.children.length) out.push({kind: 'item', parent: false, leaf: true, path: [...prefix], values: true, labels});
      else {
        this.flattenTabular(node.children, depth + 1, prefix, labels, out, [...anc, own.slice(0, 4)]);
        if (this.pt.subtotals) out.push({kind: 'subtotal', leaf: false, path: [...prefix], values: true, labels: [[depth, `${label} Total`, 0, null]]});
      }
      prefix.pop();
      if (depth === 0 && this.pt.blankRows) out.push(BLANK_LINE());
    });
  }
}

function flattenCols(nodes, depth, fields, items, subtotals, prefix, out) {
  const n = fields.length;
  for (const node of nodes) {
    prefix.push(node.item);
    const label = items[depth]?.label(node.item) ?? '';
    const collapsed = depth + 1 < n && fields[depth] && isCollapsed(fields[depth], label);
    if (depth + 1 >= n || collapsed || !node.children.length) out.push({kind: 'leaf', path: [...prefix]});
    else {
      flattenCols(node.children, depth + 1, fields, items, subtotals, prefix, out);
      if (subtotals) out.push({kind: 'subtotal', path: [...prefix]});
    }
    prefix.pop();
  }
}

const key2 = (r, c) => `${r.join(',')}|${c.join(',')}`;

/** Computes a PivotTable report from a source list: {grid, rowKinds, bodyOffset, width}. `probe` (Show Details, compute.rs `Probe`) asks for
 *  the item paths of the value cell at `at` (`hit`), the paths of every record the filters let through (`paths`) and every value cell (`cells`). */
export function computeFrom(content, pt, src, probe = null) {
  const fmtOf = c => src.formats[c] ?? 'General';
  const rows = pt.rows.map(f => [src.col(f.sourceCol), f]).filter(([c]) => c >= 0);
  const cols = pt.columns.map(f => [src.col(f.sourceCol), f]).filter(([c]) => c >= 0);
  // Value fields: a source column, or a calculated field evaluated on the sums of the fields it names (pivot-calc.mjs).
  const calc = new CalcSet(pt, src.headers, content);
  const vals = pt.values.map(v => { const c = src.col(v.sourceCol); if (c >= 0) return [c, v, null]; const ci = calc.index(v.sourceCol); return ci >= 0 ? [-1, v, ci] : null; }).filter(Boolean);
  // Source columns summed for the calculated fields, accumulated after the value fields.
  const extra = [];
  for (const [, , ci] of vals) if (ci !== null) for (const name of calc.sourceRefs(ci)) { const c = src.col(name); if (c >= 0 && !extra.includes(c)) extra.push(c); }
  if (rows.length + cols.length > MAX_AXIS_FIELDS) throw new Error(`A PivotTable can have at most ${MAX_AXIS_FIELDS} row and column fields.`);
  if (vals.length > MAX_VALUE_FIELDS) throw new Error(`A PivotTable can have at most ${MAX_VALUE_FIELDS} value fields.`);
  const axisGroup = name => [...pt.rows, ...pt.columns].find(f => f.sourceCol.toLowerCase() === name.toLowerCase())?.dateGroup;
  const filters = pt.filters.map(f => { const c = src.col(f.sourceCol); if (c < 0) return null; const g = axisGroup(f.sourceCol); return {c, f, group: g ?? 'none', shown: g === undefined}; }).filter(Boolean);
  const shownFilters = filters.filter(f => f.shown);
  const k = vals.length;
  const isEmptyPivot = !rows.length && !cols.length && !vals.length;
  const rowLevels = rows.length;
  const rowFmts = rows.map(([c]) => fmtOf(c)), colFmts = cols.map(([c]) => fmtOf(c));

  // ---- aggregate
  const rowItems = rows.map(() => new FieldItems()), colItems = cols.map(() => new FieldItems());
  const aggs = new Map(), rowSet = new Map(), colSet = new Map();
  if (!isEmptyPivot) {
    // Timeline filters: a date field kept to a period, [from, until).
    const dateFilters = (pt.dateFilters ?? []).map(d => ({c: src.col(d.field), from: d.from, until: d.until})).filter(d => d.c >= 0);
    src.rows.forEach((rec, ri) => {
      for (const d of dateFilters) { const v = rec[d.c]; if (typeof v !== 'number' || v < d.from || (d.until !== null && d.until !== undefined && v >= d.until)) return; }
      for (const {c, f, group} of filters) {
        if (f.selected) {
          const label = itemLabel(content, rec[c], group, fmtOf(c));
          if (!f.selected.some(s => s.toLowerCase() === label.toLowerCase())) return;
        }
      }
      const rowPath = rows.map(([c, f], i) => rowItems[i].intern(content, rec[c], f.dateGroup, rowFmts[i], ri));
      const colPath = cols.map(([c, f], i) => colItems[i].intern(content, rec[c], f.dateGroup, colFmts[i], ri));
      if (probe?.paths) probe.paths.push([ri, rowPath, colPath]);
      for (let rd = 0; rd <= rowPath.length; rd++) for (let cd = 0; cd <= colPath.length; cd++) {
        const key = key2(rowPath.slice(0, rd), colPath.slice(0, cd));
        let accs = aggs.get(key);
        if (!accs) { accs = [...vals, ...extra].map(() => new Acc()); aggs.set(key, accs); }
        vals.forEach(([c], vi) => accs[vi].add(c >= 0 ? rec[c] : null));
        extra.forEach((c, ei) => accs[vals.length + ei].add(rec[c]));
      }
      rowSet.set(rowPath.join(','), rowPath); colSet.set(colPath.join(','), colPath);
      if (aggs.size > 5_000_000) throw new Error('The PivotTable report is too large.');
    });
  }

  // ---- axes
  const rowFields = rows.map(([, f]) => f), colFields = cols.map(([, f]) => f);
  const rowTree = buildTree([...rowSet.values()], 0, rowFields, rowItems);
  const colTree = buildTree([...colSet.values()], 0, colFields, colItems);
  const siblings = new Map();
  collectSiblings(rowTree, [], siblings);
  const level0 = rowTree.map(n => n.item);
  const ctx = new Ctx(pt, rowFields, rowItems, rowFmts);
  const lines = [];
  if (rowLevels === 0) lines.push({kind: 'item', parent: false, leaf: true, path: [], values: true, labels: []});
  else {
    if (pt.layout === 'tabular') ctx.flattenTabular(rowTree, 0, [], [], lines); else ctx.flatten(rowTree, 0, [], lines);
    if (pt.grandTotalsCols && rows.length) lines.push({kind: 'grand', leaf: false, path: [], values: true, labels: [[0, 'Grand Total', 0, null]]});
  }
  const specs = [];
  if (!cols.length) specs.push({kind: 'leaf', path: []});
  else {
    flattenCols(colTree, 0, colFields, colItems, pt.subtotals, [], specs);
    if (pt.grandTotalsRows) specs.push({kind: 'grand', path: []});
  }
  // The data columns: a spec times the value fields.
  const dataCols = [];
  specs.forEach((_, si) => {
    if (k === 0) { if (cols.length) dataCols.push([si, null]); } else for (let vi = 0; vi < k; vi++) dataCols.push([si, vi]);
    if (dataCols.length > MAX_COLS) throw new Error('The PivotTable report will not fit on the sheet.');
  });
  const compact = pt.layout === 'compact';
  const l = rowLevels === 0 && !cols.length ? 0 : compact ? 1 : Math.max(1, rowLevels);
  let width = l + dataCols.length;
  if (shownFilters.length) width = Math.max(width, 2);
  if (isEmptyPivot) width = Math.max(width, 1);
  width = Math.max(1, width);
  const g = new Grid(width);

  // ---- report filters
  for (const {c, f} of shownFilters) {
    const r = g.pushRow('filter');
    const shown = f.selected === null || f.selected === undefined ? '(All)' : f.selected.length === 1 ? f.selected[0] : '(Multiple Items)';
    g.set(r, 0, f.caption || (src.headers[c] ?? ''), 'filter'); g.set(r, 1, shown, 'filter');
  }
  if (shownFilters.length) g.pushRow('blank');
  const bodyOffset = g.rows.length;
  if (isEmptyPivot) {
    const r = g.pushRow('placeholder');
    g.set(r, 0, `${pt.name} — choose fields`, 'placeholder');
    return {width: g.width, grid: g.rows, rowKinds: g.kinds, bodyOffset};
  }

  // ---- headers
  const valName = vi => vals[vi]?.[1].name ?? '';
  const headersOn = pt.showHeaders !== false;
  const rowHeader = r => {
    if (rowLevels === 0 || !headersOn) return;
    if (compact) g.set(r, 0, 'Row Labels', 'header');
    else rowFields.forEach((f, i) => g.set(r, i, f.caption || f.sourceCol, 'header'));
  };
  if (!cols.length) {
    const r = g.pushRow('header');
    rowHeader(r);
    dataCols.forEach(([, vi], j) => { if (vi !== null) g.set(r, l + j, valName(vi), 'header'); });
  } else {
    const cap = g.pushRow('header');
    if (l > 0 && k === 1) g.set(cap, 0, valName(0), 'header');
    if (headersOn) g.set(cap, l, compact ? 'Column Labels' : colFields[0]?.caption || colFields[0]?.sourceCol || '', 'header');
    const levels = cols.length + (k > 1 ? 1 : 0);
    const first = g.rows.length;
    for (let i = 0; i < levels; i++) g.pushRow('header');
    let prev = null;
    dataCols.forEach(([si, vi], j) => {
      const spec = specs[si];
      const c = l + j;
      if (spec.kind === 'leaf') {
        spec.path.forEach((it, lv) => {
          const same = prev && prev.kind !== 'grand' && prev.path.slice(0, lv + 1).join(',') === spec.path.slice(0, lv + 1).join(',');
          if (!same) {
            const item = colItems[lv]?.get(it);
            if (item) g.set(first + lv, c, item.value, 'colLabel', 0, item.formatted ? colFmts[lv] : null, itemMeta('columns', lv, item.label));
          }
        });
        if (k > 1 && vi !== null) g.set(first + cols.length, c, valName(vi), 'colLabel');
      } else if (spec.kind === 'subtotal') {
        const lv = Math.max(0, spec.path.length - 1);
        const label = colItems[lv]?.label(spec.path[spec.path.length - 1]) ?? '';
        g.set(first + lv, c, k > 1 && vi !== null ? `${label} ${valName(vi)}` : `${label} Total`, 'colLabel');
      } else g.set(first, c, k > 1 && vi !== null ? `Total ${valName(vi)}` : 'Grand Total', 'colLabel');
      prev = spec;
    });
    rowHeader(g.rows.length - 1);
  }

  // ---- body
  const lookup = (rp, cp, vi) => {
    const accs = aggs.get(key2(rp, cp));
    if (!accs) return undefined;
    if (vals[vi][2] === null) return accs[vi].result(vals[vi][1].func);
    const sum = name => { const ei = extra.indexOf(src.col(name)); return ei >= 0 ? accs[vals.length + ei].result('sum') : 0; };
    return calc.value(vals[vi][2], sum);
  };
  const ratio = (a, b) => (a instanceof CellError ? a : b instanceof CellError ? b : typeof a === 'number' && b === 0 ? ERR.Div0 : typeof a === 'number' && typeof b === 'number' ? a / b : a);
  const showValue = (vdef, raw, rp, cp, vi) => {
    switch (vdef.showAs) {
      case 'percentOfGrandTotal': return ratio(raw, lookup([], [], vi));
      case 'percentOfColumnTotal': return ratio(raw, lookup([], cp, vi));
      case 'percentOfRowTotal': return ratio(raw, lookup(rp, [], vi));
      case 'runningTotal': {
        if (!rp.length || typeof raw !== 'number') return raw;
        let total = 0;
        for (const item of level0) { const p = [...rp]; p[0] = item; const v = lookup(p, cp, vi); total += typeof v === 'number' ? v : 0; if (item === rp[0]) break; }
        return total;
      }
      case 'rank': {
        if (!rp.length) return null;
        if (typeof raw !== 'number') return raw;
        const parent = rp.slice(0, -1);
        let rank = 1;
        for (const sib of siblings.get(parent.join(',')) ?? []) { const v = lookup([...parent, sib], cp, vi); if (typeof v === 'number' && v > raw) rank += 1; }
        return rank;
      }
      default: return raw;
    }
  };
  const dataFmt = vals.map(([c, v]) => {
    if (['percentOfGrandTotal', 'percentOfColumnTotal', 'percentOfRowTotal'].includes(v.showAs)) return v.numberFormat ?? '0.00%';
    if (v.showAs === 'rank') return v.numberFormat ?? null;
    if (v.numberFormat) return v.numberFormat;
    if (v.func === 'count' || v.func === 'countNumbers') return null;
    const f = fmtOf(c);
    return f !== 'General' ? f : null;
  });
  const labelCol = rowLevels === 0 ? null : compact ? 0 : rowLevels - 1;
  const chartRows = [];
  for (const line of lines) {
    const rk = line.kind;
    if (rk === 'blank') { g.pushRow('blank'); continue; }
    const ckLabel = rk === 'item' ? 'rowLabel' : rk === 'subtotal' ? 'subtotal' : 'grandTotal';
    const ckData = rk === 'item' ? 'data' : rk === 'subtotal' ? 'subtotal' : 'grandTotal';
    const r = g.pushRow(rk === 'item' ? (line.parent ? 'itemParent' : 'item') : rk);
    if (line.leaf && k > 0) chartRows.push(r);
    for (const [c, v, indent, fmt, meta] of line.labels) g.set(r, c, v, ckLabel, indent, fmt, meta);
    if (!line.values) continue;
    dataCols.forEach(([si, vi], j) => {
      if (vi === null) return;
      const spec = specs[si];
      const raw = lookup(line.path, spec.path, vi);
      if (raw === undefined) return;
      g.set(r, l + j, showValue(vals[vi][1], raw, line.path, spec.path, vi), ckData, 0, dataFmt[vi]);
      if (probe) {
        probe.cells?.add(`${r},${l + j}`);
        if (probe.at && probe.at[0] === r && probe.at[1] === l + j) probe.hit = [line.path, spec.path];
      }
    });
  }
  // The columns a PivotChart plots (crates/engine/src/pivot/compute.rs `chart_cols`): the item columns, named by their column items and value field.
  const chartCols = k > 0 ? dataCols.map(([si, vi], j) => {
    const spec = specs[si];
    if (spec.kind !== 'leaf') return null;
    const parts = spec.path.map((it, lv) => colItems[lv]?.label(it) ?? '');
    if (vi !== null && (k > 1 || parts.length === 0)) parts.push(valName(vi));
    else if (parts.length === 0) parts.push('Total');
    return [l + j, parts.join(' - ')];
  }).filter(Boolean) : [];
  // The +/- buttons: a label cell of an item whose field has another field inside it, collapsed when its field lists it.
  const buttons = [];
  g.rows.forEach((row, ri) => row.forEach((cell, ci) => {
    const m = cell.meta;
    if (!m || cell.value === null || cell.value === undefined) return;
    const fields = m.axis === 'rows' ? rowFields : colFields;
    if (m.level >= fields.length - 1) return;
    cell.button = true;
    buttons.push({ri, ci, axis: m.axis, level: m.level, field: fields[m.level].sourceCol, label: m.label, collapsed: isCollapsed(fields[m.level], m.label)});
  }));
  return {width: g.width, grid: g.rows, rowKinds: g.kinds, bodyOffset, chartRows, chartCols, labelCol, labelCols: l, buttons};
}

/** Computes a PivotTable report from the workbook. */
export function compute(content, pt, pivotSheet) {
  return computeFrom(content, pt, readSource(content, pt.source, pivotSheet));
}

// ---------------------------------------------------------------- Show Details (compute.rs `detail_records`, `detail_cells`)

export const NOT_A_VALUE_CELL = 'select a value cell in a PivotTable';
const stored = v => (v === null || v === undefined || v === '' ? '' : JSON.stringify(toJSONValue(v)));

/** Throws when the report on the sheet is no longer what the source computes (Excel reads its cache; without one the last refresh must still hold). */
function checkCurrent(content, pt, si, out) {
  const sheet = content.sheets[si];
  const r = pt.lastRange ? parseRange(pt.lastRange) : null;
  const ok = !!r && r.end.row - r.start.row + 1 === Math.max(1, out.grid.length) && r.end.col - r.start.col + 1 === Math.max(1, out.width)
    && out.grid.every((line, ri) => line.every((oc, ci) => stored(cellAt(sheet, r.start.row + ri, r.start.col + ci)?.v) === stored(oc.value)));
  if (!ok) throw new Error('The PivotTable report is out of date. Refresh it first.');
}

/** The source and the indices of its records behind the value cell at (`row`, `col`) of the report (relative to its top-left), in source
 *  order; null when that cell holds no value. Throws for a stale report or a source that cannot be read. */
export function detailRecords(content, pt, si, row, col) {
  const src = readSource(content, pt.source, si);
  const probe = {at: [row, col], hit: null, paths: [], cells: null};
  const out = computeFrom(content, pt, src, probe);
  checkCurrent(content, pt, si, out);
  if (!probe.hit) return null;
  const [rp, cp] = probe.hit;
  const starts = (p, pre) => pre.every((x, i) => p[i] === x);
  return {src, records: probe.paths.filter(([, r, c]) => starts(r, rp) && starts(c, cp)).map(([i]) => i)};
}

/** The report cells (`"row,col"` relative to its top-left) where detailRecords finds records: value, subtotal and grand total cells. */
export function detailCells(content, pt, si) {
  const src = readSource(content, pt.source, si);
  const probe = {at: null, hit: null, paths: null, cells: new Set()};
  const out = computeFrom(content, pt, src, probe);
  checkCurrent(content, pt, si, out);
  return probe.cells;
}

// ---------------------------------------------------------------- styling

/** Colours for a PivotTable style name (the familiar PivotStyleLight1 to 28, Medium and Dark names, our own palette). */
export function look(style) {
  const rest = String(style ?? '').replace(/^PivotStyle/, '');
  let fam = 'Light', n = 16;
  for (const f of ['Light', 'Medium', 'Dark']) if (rest.startsWith(f)) { fam = f; n = Number.parseInt(rest.slice(f.length), 10) || 16; break; }
  const k = (n - 1) % 7;
  const acc = k === 0 ? null : 3 + k;
  const tone = tint => (acc === null ? {theme: 1, tint: Math.max(-1, Math.min(1, tint / 1000))} : {theme: acc, tint: tint / 1000});
  if (fam === 'Dark') return {headerFill: {theme: 1, tint: 0}, headerFont: {theme: 0, tint: 0}, line: tone(0), filterFill: tone(600)};
  if (fam === 'Medium') return {headerFill: tone(0), headerFont: {theme: 0, tint: 0}, line: tone(0), filterFill: tone(800)};
  return {headerFill: tone(800), headerFont: null, line: tone(400), filterFill: tone(800)};
}

/** The sparse style patch of a report cell (cell_style): `lastHeader` flags the last header row (or a filter's name column). */
export function cellStyle(lk, rowKind, cell, lastHeader, opts = null) {
  const font = {}, borders = {}, align = {}, st = {};
  let fill = null;
  switch (rowKind) {
    case 'header': if (opts?.columnHeaders === false) break; font.bold = true; fill = {pattern: 'solid', fg: lk.headerFill}; if (lk.headerFont) font.color = lk.headerFont; if (lastHeader) borders.bottom = {style: 'thin', color: lk.line}; break;
    case 'filter': fill = {pattern: 'solid', fg: lk.filterFill}; font.bold = !!lastHeader; break;
    // Row Headers: a group's own label is bold (its values always are).
    case 'itemParent': if (cell.kind !== 'rowLabel' || opts?.rowHeaders !== false) font.bold = true; break;
    case 'subtotal': font.bold = true; break;
    case 'grand': font.bold = true; borders.top = {style: 'thin', color: lk.line}; break;
    case 'placeholder': font.italic = true; font.color = {theme: 1, tint: 0.5}; break;
    default: break;
  }
  // Banded Rows and Banded Columns shade every other body row, or every other value column.
  if (opts?.band && !fill) fill = {pattern: 'solid', fg: lk.filterFill};
  const isNum = typeof cell.value === 'number';
  if (['rowLabel', 'colLabel', 'subtotal', 'grandTotal'].includes(cell.kind) && !isNum) align.h = 'left';
  if (['rowLabel', 'colLabel'].includes(cell.kind) && isNum) align.h = 'left';
  // A cell with a +/- button leaves room for it.
  align.indent = Math.min(15, (cell.indent ?? 0) + (cell.button && opts?.buttons ? 2 : 0));
  if (Object.keys(font).length) st.font = font;
  if (fill) st.fill = fill;
  if (Object.keys(borders).length) st.borders = borders;
  if (align.h || align.indent) st.align = align;
  if (cell.numFmt) st.numFmt = cell.numFmt;
  return st;
}

/** A PivotTable's Style Options (PivotTable Design): Row Headers and Column Headers are on, banding off, until set. */
export const styleOptions = pt => ({rowHeaders: true, columnHeaders: true, bandedRows: false, bandedColumns: false, ...(pt.styleOptions ?? {})});

export const pivotRange = pt => (pt.lastRange ? parseRange(pt.lastRange) : null);
export {a1, rangeA1};

// ---------------------------------------------------------------- lookup and description (commands, Fields pane)

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const inAxes = (pt, field) => [...pt.rows, ...pt.columns].some(f => same(f.sourceCol, field));

/** [sheet, pivot] of the PivotTable named (or numbered) `ref`, else the one whose report holds `active` on sheet `sheet`, else that sheet's last; null if none. */
export function pivotAt(content, sheet, active, ref) {
  if (ref !== undefined && ref !== null) {
    const order = [sheet, ...content.sheets.map((_, i) => i).filter(i => i !== sheet)];
    for (const si of order) {
      const i = (content.sheets[si]?.pivots ?? []).findIndex(pt => (typeof ref === 'string' ? same(pt.name, ref) : pt.id === ref));
      if (i >= 0) return [si, i];
    }
    return null;
  }
  const list = content.sheets[sheet]?.pivots ?? [];
  const hit = active ? list.findIndex(pt => pt.lastRange && contains(parseRange(pt.lastRange), active)) : -1;
  if (hit >= 0) return [sheet, hit];
  return list.length ? [sheet, list.length - 1] : null;
}
const contains = (r, c) => c.row >= r.start.row && c.row <= r.end.row && c.col >= r.start.col && c.col <= r.end.col;

/** Plain description of a PivotTable (the pivot.fields answer), with the source fields and where each one is. */
export function describe(content, si, pt) {
  const out = {
    id: pt.id, name: pt.name, sheet: content.sheets[si].name, anchor: pt.anchor, range: pt.lastRange ?? null, source: pt.source,
    rows: pt.rows.map(f => ({field: f.sourceCol, sort: f.sort, group: f.dateGroup, collapsed: f.collapsedItems ?? []})),
    columns: pt.columns.map(f => ({field: f.sourceCol, sort: f.sort, group: f.dateGroup, collapsed: f.collapsedItems ?? []})),
    values: pt.values.map(v => ({field: v.sourceCol, func: v.func, name: v.name, showAs: v.showAs, numberFormat: v.numberFormat ?? null})),
    filters: pt.filters.map(f => ({field: f.sourceCol, selected: f.selected ?? null, report: !inAxes(pt, f.sourceCol)})),
    layout: pt.layout, grandTotalsRows: pt.grandTotalsRows, grandTotalsCols: pt.grandTotalsCols, subtotals: !pt.subtotals ? 'none' : pt.subtotalsTop ? 'top' : 'bottom',
    style: pt.style, showHeaders: pt.showHeaders, enableShowDetails: pt.enableShowDetails,
  };
  try {
    const src = readSource(content, pt.source, si);
    out.fields = src.headers.map((h, c) => {
      const areas = [];
      if (pt.rows.some(f => same(f.sourceCol, h))) areas.push('rows');
      if (pt.columns.some(f => same(f.sourceCol, h))) areas.push('columns');
      if (pt.values.some(f => same(f.sourceCol, h))) areas.push('values');
      if (pt.filters.some(f => same(f.sourceCol, h)) && !inAxes(pt, h)) areas.push('filters');
      return {name: h, numeric: !!src.numeric[c], date: !!src.dates[c], samples: distinctLabels(content, src, c, 'none', 5), areas};
    });
    // Calculated fields follow the source fields, usable in Values only.
    for (const cf of pt.calculatedFields ?? []) {
      if (src.col(cf.name) >= 0) continue;
      out.fields.push({name: cf.name, numeric: true, date: false, samples: [], areas: pt.values.some(v => same(v.sourceCol, cf.name)) ? ['values'] : [], calculated: true, formula: cf.formula});
    }
    out.records = src.rows.length;
  } catch (e) { out.fields = []; out.error = e.message; }
  return out;
}

/** The field the cell `active` of a report belongs to: {area, field, index} (index into the area), or null. Row labels give their row field (by indent in
 *  Compact, by column otherwise), column labels the column field of their header row, data cells their value field. */
export function activeFieldAt(content, si, pt, active) {
  if (!pt.lastRange || !active) return null;
  let out;
  try { out = compute(content, pt, si); } catch { return null; }
  const anchor = parseRange(pt.anchor).start;
  const originRow = anchor.row >= out.bodyOffset ? anchor.row - out.bodyOffset : anchor.row;
  const ri = active.row - originRow, ci = active.col - anchor.col;
  const cell = out.grid[ri]?.[ci];
  if (!cell) return null;
  const nr = pt.rows.length, labelCols = pt.layout === 'compact' ? 1 : Math.max(1, nr);
  const pick = (area, i) => (pt[area].length ? {area, index: Math.min(Math.max(i, 0), pt[area].length - 1), field: pt[area][Math.min(Math.max(i, 0), pt[area].length - 1)].sourceCol} : null);
  switch (cell.kind) {
    case 'rowLabel': case 'subtotal': if (ci < labelCols && nr) return pick('rows', pt.layout === 'compact' ? (cell.indent ?? 0) : ci); break;
    case 'colLabel': { const h = out.rowKinds.slice(0, ri).filter(k => k === 'header').length; return pick('columns', h); }
    case 'header': if (ci < labelCols && nr) return pick('rows', pt.layout === 'compact' ? 0 : ci); break;
    case 'data': case 'grandTotal': if (ci >= labelCols && pt.values.length) { const i = (ci - labelCols) % pt.values.length; return {area: 'values', index: i, field: pt.values[i].name}; } break;
    default: break;
  }
  return null;
}

// ---------------------------------------------------------------- +/- buttons

const buttonCache = new WeakMap();
/**
 * The expand/collapse buttons of the sheet's PivotTable reports (PivotTable Analyze > Show > +/- Buttons): [{row, col, pivot, axis, field, label, collapsed}] in sheet
 * cells. Excel draws one on each item that has another field inside it. Cached per sheet's pivot list and workbook revision.
 */
export function pivotButtons(content, si) {
  const list = content.sheets[si]?.pivots;
  if (!list?.length) return [];
  const hit = buttonCache.get(list);
  if (hit && hit.content === content) return hit.out;
  const out = [];
  for (const pt of list) {
    if (pt.showButtons === false || !pt.lastRange) continue;
    let r;
    try { r = compute(content, pt, si); } catch { continue; }
    const anchor = parseRange(pt.anchor)?.start;
    if (!anchor) continue;
    const originRow = anchor.row >= r.bodyOffset ? anchor.row - r.bodyOffset : anchor.row;
    for (const b of r.buttons ?? []) out.push({row: originRow + b.ri, col: anchor.col + b.ci, pivot: pt.name, axis: b.axis, field: b.field, label: b.label, collapsed: b.collapsed});
  }
  buttonCache.set(list, {content, out});
  return out;
}
