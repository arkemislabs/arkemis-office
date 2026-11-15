// PivotTables in .xlsx: pivot cache definitions and records (ECMA-376 Part 1 18.10.1) and PivotTable definitions (18.10.1.73),
// written from sheet.pivots[] and read back into them.
// Translated from gridcraft crates/xlsx/src/pivot.rs, pivot/write.rs and pivot/read.rs at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Writing: one cache per PivotTable with a records snapshot of the source list (left out, with saveData="0", for very large
// sources) and refreshOnLoad="1" so a reader computes the report again from the source on open. Fields used on an axis get shared
// items (or, for date grouping, fieldGroup group items) so the table's <items> can name them. The report cells stay on the sheet
// as plain cells.
//
// Reading: the cache's source and field names plus the table's areas, functions, show-values-as, layout flags, grand totals and
// style become a sheet.pivots[] entry. What gridcraft's model has no place for (OLAP sources, calculated fields, numeric grouping)
// becomes a warning and the report stays as plain cells. Not translated here (the model has no place yet): Σ Values in rows,
// calculated fields.

import {parseRange, rangeA1, quoteSheet, a1} from './addr.mjs';
import {CellError, numberToText} from './value.mjs';
import {datetimeFromSerial, serialFromYmd} from './date.mjs';
import {resolveSource, readSource, rangeText, funcCaption, styleOptions} from './pivot.mjs';
import {BUILTIN_FORMATS} from '../formats/xlsx-read.mjs';

export const CT_PIVOT_TABLE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml';
export const CT_PIVOT_CACHE_DEF = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml';
export const CT_PIVOT_CACHE_REC = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const EXT_X14_DATA_FIELD = '{E15A36E0-9728-4e99-A89B-3F7291B0FE68}';
const EXT_X14_TABLE = '{962EF5D1-5CA2-4c93-8EF4-DBF39C750EF9}';
const NS_X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const MAX_RECORD_CELLS = 2_000_000, MAX_ITEMS = 1_048_576, MAX_FIELDS = 16_384;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escAttr = s => esc(s).replaceAll('"', '&quot;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const num = n => (Object.is(n, -0) ? '0' : String(n));

const FUNC_NAME = {sum: 'sum', count: 'count', average: 'average', max: 'max', min: 'min', product: 'product', countNumbers: 'countNums', stdDev: 'stdDev', stdDevP: 'stdDevp', var: 'var', varP: 'varp'};
const FUNC_FROM = Object.fromEntries(Object.entries(FUNC_NAME).map(([k, v]) => [v, k]));
const GROUP_BY = {years: 'years', quarters: 'quarters', months: 'months', days: 'days'};
const GROUP_CAPTION = {years: 'Years', quarters: 'Quarters', months: 'Months', days: 'Days'};
const builtinId = code => { for (const [i, c] of BUILTIN_FORMATS) if (c === code && !(i >= 5 && i <= 8) && i !== 42 && i !== 44) return i; return null; };

// ================================================================ shared helpers

const isBlank = v => v === null || v === undefined || v === '';
const labelOf = v => (isBlank(v) ? '(blank)' : typeof v === 'number' ? numberToText(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v instanceof CellError ? v.text : String(v));
const keyOf = v => (isBlank(v) ? 'b' : typeof v === 'number' ? `n${v === 0 ? 0 : v}` : typeof v === 'boolean' ? `o${v}` : v instanceof CellError ? `e${v.text}` : `t${String(v).toLowerCase()}`);

const iso = (sys, serial) => {
  const d = datetimeFromSerial(sys, serial);
  const p = (n, w = 2) => String(n ?? 0).padStart(w, '0');
  return d ? `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}T${p(d.hour)}:${p(d.minute)}:${p(d.second)}` : null;
};
const mdy = (sys, serial) => { const d = datetimeFromSerial(sys, serial); return d ? `${d.month}/${d.day}/${d.year}` : numberToText(serial); };

function itemXml(v, sys, date) {
  if (isBlank(v)) return '<m/>';
  if (typeof v === 'number') { const d = date ? iso(sys, v) : null; return d ? `<d v="${d}"/>` : `<n v="${num(v)}"/>`; }
  if (typeof v === 'boolean') return `<b v="${v ? 1 : 0}"/>`;
  if (v instanceof CellError) return `<e v="${escAttr(v.text)}"/>`;
  return `<s v="${escAttr(v)}"/>`;
}

function groupItems(sys, by, start, end) {
  const out = [`<${mdy(sys, start)}`];
  if (by === 'years') {
    const y0 = datetimeFromSerial(sys, start)?.year ?? 1900;
    const y1 = Math.max(y0, datetimeFromSerial(sys, end - 1)?.year ?? y0);
    for (let y = y0; y <= Math.min(y1, y0 + 10_000); y++) out.push(String(y));
  } else if (by === 'quarters') for (let q = 1; q <= 4; q++) out.push(`Qtr${q}`);
  else if (by === 'months') out.push(...MONTHS);
  else {
    const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    MONTHS.forEach((m, i) => { for (let d = 1; d <= DAYS[i]; d++) out.push(`${d}-${m}`); });
  }
  out.push(`>${mdy(sys, end)}`);
  return out;
}

// ================================================================ writing

function sourceXml(content, pt, si) {
  const text = String(pt.source ?? '').trim().replace(/^=/, '').trim();
  const {si: ssi, range} = resolveSource(content, text, si);
  const tables = content.sheets.flatMap(sh => sh.tables ?? []);
  const t = tables.find(x => same(x.name, text));
  if (t && /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(t.name)) return `<worksheetSource name="${escAttr(t.name)}"/>`;
  return `<worksheetSource ref="${rangeA1(range)}" sheet="${escAttr(content.sheets[ssi].name.slice(0, 31))}"/>`;
}

/** The cache of a PivotTable's source: fields with their statistics, shared items, date groups and the records. */
function buildCache(content, pt, si) {
  let src;
  try { src = readSource(content, pt.source, si); } catch { return null; }
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const fields = src.headers.map((name, c) => ({name, c, text: false, number: false, nonInt: false, bool: false, error: false, blank: false, long: false, min: 0, max: 0, items: [], index: new Map(), itemized: false, group: null}));
  for (const rec of src.rows) {
    fields.forEach(f => {
      const v = rec[f.c];
      if (isBlank(v)) f.blank = true;
      else if (typeof v === 'number') { if (!f.number) { f.min = v; f.max = v; } f.number = true; f.min = Math.min(f.min, v); f.max = Math.max(f.max, v); if (!Number.isInteger(v)) f.nonInt = true; }
      else if (typeof v === 'boolean') f.bool = true;
      else if (v instanceof CellError) f.error = true;
      else { f.text = true; if ([...String(v)].length > 255) f.long = true; }
    });
  }
  const axis = [...pt.rows, ...pt.columns];
  const find = name => fields.findIndex(f => same(f.name, name));
  const groupable = f => f.number && !f.text && !f.bool && !f.error && datetimeFromSerial(sys, f.min) && datetimeFromSerial(sys, f.max);
  const axisMap = axis.map(a => {
    const i = find(a.sourceCol);
    if (i < 0) return null;
    const f = fields[i];
    if (a.dateGroup && a.dateGroup !== 'none' && groupable(f)) {
      const start = Math.floor(f.min), end = Math.floor(f.max) + 1;
      f.group = {by: a.dateGroup, start, end, items: groupItems(sys, a.dateGroup, start, end)};
    } else if (!f.group) f.itemized = true;
    return i;
  });
  // A field a slicer shows has shared items for the slicer cache to name.
  for (const sh of content.sheets) for (const sl of sh.slicers ?? []) {
    if (sl.timeline || !(sl.pivots ?? [sl.pivot]).some(n => same(n ?? '', pt.name))) continue;
    const i = find(sl.field ?? '');
    if (i >= 0 && !fields[i].group) fields[i].itemized = true;
  }
  for (const fl of pt.filters) {
    if (axis.some(a => same(a.sourceCol, fl.sourceCol))) continue;
    const i = find(fl.sourceCol);
    if (i >= 0 && !fields[i].group) fields[i].itemized = true;
  }
  for (const f of fields) {
    if (f.group) f.itemized = false;
    else if (f.text || f.bool || f.error) f.itemized = true;
  }
  for (const rec of src.rows) for (const f of fields) {
    if (!f.itemized) continue;
    const v = rec[f.c], k = keyOf(v);
    if (!f.index.has(k) && f.items.length < MAX_ITEMS) { f.index.set(k, f.items.length); f.items.push(v); }
  }
  let records = null;
  if (src.rows.length * fields.length <= MAX_RECORD_CELLS) {
    let s = '';
    for (const rec of src.rows) {
      s += '<r>';
      for (const f of fields) {
        const v = rec[f.c];
        if (f.itemized) { const i = f.index.get(keyOf(v)); s += i !== undefined ? `<x v="${i}"/>` : itemXml(v, sys, false); } else s += itemXml(v, sys, !!f.group);
      }
      s += '</r>';
    }
    records = {count: src.rows.length, xml: s};
  }
  // Calculated fields come after the database fields (pivot/write.rs): a formula, no shared items, databaseField="0".
  for (const cf of pt.calculatedFields ?? []) {
    const f = String(cf.formula ?? '').trim().replace(/^=/, '').trim();
    if (!String(cf.name ?? '').trim() || !f || fields.some(x => same(x.name, cf.name))) continue;
    fields.push({name: cf.name, c: -1, formula: f, items: [], index: new Map(), itemized: false, group: null});
  }
  return {fields, axisMap, sourceXml: sourceXml(content, pt, si), records, sys};
}

const itemLabels = f => (f.group ? f.group.items : f.items.map(labelOf));

function cacheXml(c, recordsRid) {
  let s = `${XML_DECL}<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"`;
  s += recordsRid && c.records ? ` r:id="${recordsRid}" recordCount="${c.records.count}"` : ' saveData="0"';
  s += ' refreshOnLoad="1" refreshedBy="Arkemis" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3">';
  s += `<cacheSource type="worksheet">${c.sourceXml}</cacheSource><cacheFields count="${c.fields.length}">`;
  c.fields.forEach((f, i) => {
    if (f.formula !== undefined) { s += `<cacheField name="${escAttr(f.name)}" numFmtId="0" formula="${escAttr(f.formula)}" databaseField="0"/>`; return; }
    s += `<cacheField name="${escAttr(f.name)}" numFmtId="${f.group ? 14 : 0}"><sharedItems`;
    const strings = f.text || f.bool || f.error;
    if (f.group) {
      s += ' containsSemiMixedTypes="0" containsNonDate="0" containsDate="1" containsString="0"';
      if (f.blank) s += ' containsBlank="1"';
      const a = iso(c.sys, f.min), b = iso(c.sys, f.max);
      if (a && b) s += ` minDate="${a}" maxDate="${b}"`;
    } else {
      if (!strings && !f.blank) s += ' containsSemiMixedTypes="0"';
      if (!strings) s += ' containsString="0"';
      if (f.blank) s += ' containsBlank="1"';
      if ((strings ? 1 : 0) + (f.number ? 1 : 0) > 1) s += ' containsMixedTypes="1"';
      if (f.number) { s += ' containsNumber="1"'; if (!f.nonInt) s += ' containsInteger="1"'; s += ` minValue="${num(f.min)}" maxValue="${num(f.max)}"`; }
      if (f.long) s += ' longText="1"';
    }
    if (f.itemized) s += ` count="${f.items.length}">${f.items.map(v => itemXml(v, c.sys, false)).join('')}</sharedItems>`;
    else s += '/>';
    if (f.group) {
      s += `<fieldGroup base="${i}"><rangePr groupBy="${GROUP_BY[f.group.by]}"`;
      const a = iso(c.sys, f.group.start), b = iso(c.sys, f.group.end);
      if (a && b) s += ` startDate="${a}" endDate="${b}"`;
      s += `/><groupItems count="${f.group.items.length}">${f.group.items.map(it => `<s v="${escAttr(it)}"/>`).join('')}</groupItems></fieldGroup>`;
    }
    s += '</cacheField>';
  });
  return `${s}</cacheFields></pivotCacheDefinition>`;
}

/** <rowFields>/<colFields>: the axis's cache field indices, with Σ Values (-2) after the last one when `values`. */
function axisFieldsXml(tag, idx, values = false) {
  const n = idx.length + (values ? 1 : 0);
  if (!n) return '';
  return `<${tag} count="${n}">${idx.map(i => `<field x="${i}"/>`).join('')}${values ? '<field x="-2"/>' : ''}</${tag}>`;
}

function tableXml(pt, idx, cacheId, c) {
  const findDb = name => c.fields.findIndex(f => same(f.name, name));
  const nRows = pt.rows.length;
  const rowFields = c.axisMap.slice(0, nRows).filter(x => x !== null);
  const colFields = c.axisMap.slice(nRows).filter(x => x !== null);
  const axisAll = [...pt.rows, ...pt.columns];
  const hidden = new Map(), pages = [];
  for (const f of pt.filters) {
    const p = axisAll.findIndex(a => same(a.sourceCol, f.sourceCol));
    if (p >= 0) { if (c.axisMap[p] !== null && c.axisMap[p] !== undefined) hidden.set(c.axisMap[p], f); }
    else { const i = findDb(f.sourceCol); if (i >= 0 && !pages.some(([j]) => j === i)) { pages.push([i, f]); hidden.set(i, f); } }
  }
  const values = pt.values.map(v => [findDb(v.sourceCol), v]).filter(([i]) => i >= 0);
  const compact = pt.layout === 'compact';
  const name = String(pt.name ?? '').trim() || `PivotTable${idx + 1}`;
  let s = `${XML_DECL}<pivotTableDefinition xmlns="${NS_MAIN}" name="${escAttr(name)}" cacheId="${cacheId}" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0"`;
  if (pt.layout === 'compact') s += ' outline="1" outlineData="1"';
  else if (pt.layout === 'outline') s += ' compact="0" compactData="0" outline="1" outlineData="1"';
  else s += ' compact="0" compactData="0"';
  if (pt.showHeaders === false) s += ' showHeaders="0"';
  if (pt.showButtons === false) s += ' showDrill="0"';
  if (pt.enableShowDetails === false) s += ' enableDrill="0"';
  // rowGrandTotals is the grand total row below the report ("On for Columns"), colGrandTotals the grand total column at its right ("On for Rows").
  if (pt.grandTotalsCols === false) s += ' rowGrandTotals="0"';
  if (pt.grandTotalsRows === false) s += ' colGrandTotals="0"';
  s += ' multipleFieldFilters="0">';
  const a = parseRange(pt.anchor)?.start ?? {row: 0, col: 0};
  const lr = pt.lastRange ? parseRange(pt.lastRange) : null;
  const end = lr ? {row: Math.max(lr.end.row, a.row), col: Math.max(lr.end.col, a.col)} : a;
  const k = values.length;
  const colValues = k > 1 ? colFields.length : null;
  const firstDataRow = colFields.length ? 1 + colFields.length + (colValues !== null ? 1 : 0) : 1;
  const rowLevels = rowFields.length;
  const firstDataCol = rowLevels === 0 && !colFields.length ? 0 : compact ? 1 : Math.max(rowLevels, 1);
  const hideValuesRow = colValues !== null && !colFields.length;
  s += `<location ref="${rangeA1({start: a, end})}" firstHeaderRow="${hideValuesRow ? 0 : 1}" firstDataRow="${firstDataRow}" firstDataCol="${firstDataCol}"`;
  if (pages.length) s += ` rowPageCount="${pages.length}" colPageCount="1"`;
  s += '/>';
  // pivotFields
  s += `<pivotFields count="${c.fields.length}">`;
  c.fields.forEach((f, i) => {
    s += '<pivotField';
    // A field's caption (Active Field box) is the pivotField name.
    const capt = [...pt.rows, ...pt.columns, ...pt.filters].find(x => same(x.sourceCol, f.name))?.caption;
    if (capt) s += ` name="${escAttr(capt)}"`;
    const isPage = pages.some(([j]) => j === i);
    const axis = rowFields.includes(i) ? 'axisRow' : colFields.includes(i) ? 'axisCol' : isPage ? 'axisPage' : null;
    if (axis) s += ` axis="${axis}"`;
    if (values.some(([j]) => j === i)) s += ' dataField="1"';
    if (pt.layout === 'outline') s += ' compact="0"';
    else if (pt.layout === 'tabular') s += ' compact="0" outline="0"';
    if (f.group) s += ' numFmtId="14"';
    const filter = hidden.get(i);
    const labels = itemLabels(f);
    let hide = filter?.selected && !(isPage && filter.selected.length === 1) ? labels.map(l => !filter.selected.some(x => same(x, l))) : labels.map(() => false);
    if (hide.length && hide.every(Boolean)) hide = hide.map(() => false);
    if (isPage && hide.some(Boolean)) s += ' multipleItemSelectionAllowed="1"';
    s += ' showAll="0"';
    const p = c.axisMap.indexOf(i);
    const af = p >= 0 ? axisAll[p] : null;
    if (af?.sort === 'asc') s += ' sortType="ascending"'; else if (af?.sort === 'desc') s += ' sortType="descending"';
    if (pt.blankRows && axis && axis !== 'axisPage') s += ' insertBlankRow="1"';
    if (!pt.subtotals) s += ' defaultSubtotal="0"';
    if (!pt.subtotalsTop) s += ' subtotalTop="0"';
    if (axis) {
      const collapsed = af?.collapsedItems ?? [];
      s += `><items count="${labels.length + (pt.subtotals ? 1 : 0)}">`;
      labels.forEach((l, x) => { s += `<item x="${x}"${hide[x] ? ' h="1"' : ''}${collapsed.some(cl => same(cl, l)) ? ' sd="0"' : ''}/>`; });
      if (pt.subtotals) s += '<item t="default"/>';
      s += '</items></pivotField>';
    } else s += '/>';
  });
  s += '</pivotFields>';
  s += axisFieldsXml('rowFields', rowFields);
  s += axisFieldsXml('colFields', colFields, colValues !== null);
  if (pages.length) {
    s += `<pageFields count="${pages.length}">`;
    for (const [i, filter] of pages) {
      s += `<pageField fld="${i}"`;
      if (filter.selected?.length === 1) { const x = itemLabels(c.fields[i]).findIndex(l => same(l, filter.selected[0])); if (x >= 0) s += ` item="${x}"`; }
      s += ' hier="-1"/>';
    }
    s += '</pageFields>';
  }
  if (values.length) {
    s += `<dataFields count="${values.length}">`;
    const used = [];
    const baseField = rowFields[0] ?? colFields[0] ?? 0;
    for (const [i, v] of values) {
      const base = String(v.name ?? '').trim() ? v.name : `${funcCaption(v.func)} of ${c.fields[i].name}`;
      let n = base, suffix = 2;
      while (used.some(e => same(e, n))) n = `${base}${suffix++}`;
      used.push(n);
      s += `<dataField name="${escAttr(n)}" fld="${i}"`;
      if (v.func !== 'sum') s += ` subtotal="${FUNC_NAME[v.func] ?? 'sum'}"`;
      switch (v.showAs) {
        case 'percentOfGrandTotal': s += ' showDataAs="percentOfTotal" baseField="0" baseItem="0"'; break;
        case 'percentOfColumnTotal': s += ' showDataAs="percentOfCol" baseField="0" baseItem="0"'; break;
        case 'percentOfRowTotal': s += ' showDataAs="percentOfRow" baseField="0" baseItem="0"'; break;
        case 'runningTotal': s += ` showDataAs="runTotal" baseField="${baseField}" baseItem="0"`; break;
        case 'rank': s += ` baseField="${baseField}" baseItem="0"`; break;
        default: s += ' baseField="0" baseItem="0"';
      }
      const fid = v.numberFormat ? builtinId(v.numberFormat) : null;
      if (fid) s += ` numFmtId="${fid}"`;
      s += v.showAs === 'rank' ? `><extLst><ext uri="${EXT_X14_DATA_FIELD}" xmlns:x14="${NS_X14}"><x14:dataField pivotShowAs="rankDescending"/></ext></extLst></dataField>` : '/>';
    }
    s += '</dataFields>';
  }
  s += '<pivotTableStyleInfo';
  if (pt.style) s += ` name="${escAttr(pt.style)}"`;
  const so = styleOptions(pt);
  s += ` showRowHeaders="${so.rowHeaders ? 1 : 0}" showColHeaders="${so.columnHeaders ? 1 : 0}" showRowStripes="${so.bandedRows ? 1 : 0}" showColStripes="${so.bandedColumns ? 1 : 0}" showLastColumn="1"/>`;
  // Timeline filters are date-between filters of the definition.
  const dfs = (pt.dateFilters ?? []).map(d => [findDb(d.field), d]).filter(([i]) => i >= 0);
  if (dfs.length) {
    s += `<filters count="${dfs.length}">`;
    dfs.forEach(([i, d], k) => {
      s += `<filter fld="${i}" type="dateBetween" evalOrder="-1" id="${k + 1}"><autoFilter ref="A1"><filterColumn colId="0"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="${d.from}"/>${d.until !== null && d.until !== undefined ? `<customFilter operator="lessThan" val="${d.until}"/>` : ''}</customFilters></filterColumn></autoFilter></filter>`;
    });
    s += '</filters>';
  }
  // Repeat All Item Labels is an Excel 2010 extension of the definition.
  if (pt.repeatLabels) s += `<extLst><ext uri="${EXT_X14_TABLE}" xmlns:x14="${NS_X14}"><x14:pivotTableDefinition fillDownLabelsDefault="1"/></ext></extLst>`;
  return `${s}</pivotTableDefinition>`;
}

const relsXml = list => `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${escAttr(target)}"/>`).join('')}</Relationships>`;

/** PivotTables being written: caches get workbook relationships, tables hang off their sheets. */
export class PivotWriter {
  constructor() { this.caches = []; this.tables = 0; this.byName = new Map(); }

  /** Writes the caches and tables of a sheet's PivotTables and adds the sheet's relationships. `out.part(name, contentType, data)` and `out.raw(name, data)` store parts. */
  addSheet(content, si, out, rels) {
    (content.sheets[si].pivots ?? []).forEach((pt, idx) => {
      let cache;
      try { cache = buildCache(content, pt, si); } catch { cache = null; }
      if (!cache) return;
      const n = this.caches.length + 1;
      let recRid = null;
      if (cache.records) {
        recRid = 'rId1';
        out.raw(`xl/pivotCache/_rels/pivotCacheDefinition${n}.xml.rels`, relsXml([[recRid, 'pivotCacheRecords', `pivotCacheRecords${n}.xml`]]));
        out.part(`xl/pivotCache/pivotCacheRecords${n}.xml`, CT_PIVOT_CACHE_REC, `${XML_DECL}<pivotCacheRecords xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" count="${cache.records.count}">${cache.records.xml}</pivotCacheRecords>`);
      }
      out.part(`xl/pivotCache/pivotCacheDefinition${n}.xml`, CT_PIVOT_CACHE_DEF, cacheXml(cache, recRid));
      this.caches.push([n, `pivotCache/pivotCacheDefinition${n}.xml`]);
      this.byName.set(pt.name, {n, cache, tabId: si + 1});
      const t = ++this.tables;
      rels.add('pivotTable', `../pivotTables/pivotTable${t}.xml`);
      out.raw(`xl/pivotTables/_rels/pivotTable${t}.xml.rels`, relsXml([['rId1', 'pivotCacheDefinition', `../pivotCache/pivotCacheDefinition${n}.xml`]]));
      out.part(`xl/pivotTables/pivotTable${t}.xml`, CT_PIVOT_TABLE, tableXml(pt, idx, n, cache));
    });
  }

  /** The workbook's <pivotCaches> element (empty when there are none); adds its relationships to `wbRels`. */
  workbookXml(wbRels) {
    if (!this.caches.length) return '';
    let s = '<pivotCaches>';
    for (const [id, target] of this.caches) s += `<pivotCache cacheId="${id}" r:id="${wbRels.add('pivotCacheDefinition', target)}"/>`;
    return `${s}</pivotCaches>`;
  }
}

// ================================================================ reading

/** The caches of a workbook, by id, parsed once: build with the workbook XML and its relationships. */
export class CachesIn {
  constructor(wbXml, wbRels) {
    this.byId = new Map();
    this.parsed = new Map();
    this.nextId = 1;
    for (const c of wbXml.child('pivotCaches')?.kids('pivotCache') ?? []) {
      const id = c.num('cacheId'), rid = c.attr('r:id') ?? c.attr('id');
      const r = wbRels.find(x => x.id === rid);
      if (id !== undefined && r) this.byId.set(id, r.target);
    }
  }
}

function itemLabelEl(e, sys) {
  const v = e.attr('v') ?? '';
  switch (e.name) {
    case 'm': return '(blank)';
    case 'n': { const n = Number(String(v).trim()); return Number.isFinite(n) ? numberToText(n) : v; }
    case 'b': return ['1', 'true'].includes(String(v).trim()) ? 'TRUE' : 'FALSE';
    case 'd': {
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(v);
      const serial = m ? serialFromYmd(sys, Number(m[1]), Number(m[2]), Number(m[3])) : null;
      return serial === null || serial === undefined ? v : numberToText(serial + (m[4] ? (Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6])) / 86400 : 0));
    }
    default: return v;
  }
}

async function readCache(pkg, part, sheetName, warn, sys) {
  const x = await pkg.xml(part);
  if (!x) return null;
  const root = x.name === 'pivotCacheDefinition' ? x : x.child('pivotCacheDefinition');
  if (!root) { warn(`${part} is not a pivot cache definition; its PivotTable was kept as plain cells`); return null; }
  const src = root.child('cacheSource');
  const ty = src?.attr('type') ?? 'worksheet';
  if (ty !== 'worksheet') { warn(`PivotTables with a ${ty} data source are not supported; kept as plain cells`); return null; }
  const w = src?.child('worksheetSource');
  let source;
  if (w && String(w.attr('name') ?? '').trim()) source = String(w.attr('name')).trim();
  else if (w) {
    if (w.attr('id') !== undefined) warn("a PivotTable's source is in another workbook; its source reference may not resolve");
    const r = w.attr('ref') ? parseRange(String(w.attr('ref')).replace(/\$/g, '')) : null;
    if (!r) { warn("a PivotTable's source reference is missing or invalid; kept as plain cells"); return null; }
    source = rangeText(w.attr('sheet') || sheetName, r);
  } else { warn("a PivotTable's cache has no worksheet source; kept as plain cells"); return null; }
  const fields = [];
  for (const f of (root.child('cacheFields')?.kids('cacheField') ?? []).slice(0, MAX_FIELDS)) {
    const items = (f.child('sharedItems')?.children ?? []).map(e => itemLabelEl(e, sys));
    const g = f.child('fieldGroup');
    const group = g ? {
      base: g.num('base'),
      by: {years: 'years', quarters: 'quarters', months: 'months', days: 'days'}[g.child('rangePr')?.attr('groupBy') ?? 'range'] ?? null,
      items: (g.child('groupItems')?.children ?? []).map(e => itemLabelEl(e, sys)),
    } : null;
    fields.push({name: f.attr('name') ?? '', database: f.flag('databaseField', true), items, group, formula: f.attr('formula')});
  }
  if (!fields.length) { warn("a PivotTable's cache has no fields; kept as plain cells"); return null; }
  return {source, fields};
}

const labelsOf = f => (f.group?.items?.length ? f.group.items : f.items);

function fieldRef(cache, i, warn) {
  const f = cache.fields[i];
  if (!f) return null;
  if (f.formula !== undefined) { warn('calculated PivotTable fields are not supported'); return null; }
  if (f.group) {
    let by = f.group.by;
    if (!by) { warn(`PivotTable grouping of "${f.name}" is not supported; the field is ungrouped`); by = 'none'; }
    const baseName = f.database ? f.name : cache.fields[f.group.base ?? -1]?.name;
    return baseName === undefined ? null : [baseName, by];
  }
  if (!f.database) { warn(`PivotTable field "${f.name}" (grouped items) is not supported`); return null; }
  return [f.name, 'none'];
}

const dataItems = e => (e.child('items')?.kids('item') ?? []).filter(i => i.attr('t') === undefined || i.attr('t') === 'data');

function readTable(x, cache, id, warn, numFmts) {
  const pt = {id, name: String(x.attr('name') ?? '').trim() || `PivotTable${id}`, source: cache.source, anchor: 'A1', rows: [], columns: [], values: [], filters: [], layout: 'compact',
    enableShowDetails: true, grandTotalsRows: true, grandTotalsCols: true, subtotals: true, subtotalsTop: true, style: 'PivotStyleLight16', showHeaders: true, lastRange: null};
  const loc = x.child('location')?.attr('ref') ? parseRange(String(x.child('location').attr('ref')).replace(/\$/g, '')) : null;
  if (!loc) { warn(`PivotTable "${pt.name}" has no valid location; kept as plain cells`); return null; }
  const pfs = x.child('pivotFields')?.kids('pivotField') ?? [];
  const idxList = (name, attr) => (x.child(name)?.children ?? []).map(f => f.num(attr)).filter(n => n !== undefined);
  const rowX = idxList('rowFields', 'x'), colX = idxList('colFields', 'x');
  const pages = x.child('pageFields')?.kids('pageField') ?? [];
  const firstAxis = [...rowX, ...colX].find(i => i >= 0);
  const fa = firstAxis !== undefined ? pfs[firstAxis] : null;
  const compact = fa ? fa.flag('compact', true) : x.flag('compact', true);
  const outline = fa ? fa.flag('outline', true) : x.flag('outline', false);
  pt.layout = compact ? 'compact' : outline ? 'outline' : 'tabular';
  if (fa) { pt.subtotals = fa.flag('defaultSubtotal', true); pt.subtotalsTop = fa.flag('subtotalTop', true); }
  pt.grandTotalsRows = x.flag('colGrandTotals', true);
  pt.grandTotalsCols = x.flag('rowGrandTotals', true);
  pt.showHeaders = x.flag('showHeaders', true);
  if (!x.flag('showDrill', true)) pt.showButtons = false;
  pt.enableShowDetails = x.flag('enableDrill', true);
  pt.style = x.child('pivotTableStyleInfo')?.attr('name') ?? '';
  const si = x.child('pivotTableStyleInfo');
  if (si) {
    const so = {rowHeaders: si.flag('showRowHeaders', true), columnHeaders: si.flag('showColHeaders', true), bandedRows: si.flag('showRowStripes', false), bandedColumns: si.flag('showColStripes', false)};
    if (!so.rowHeaders || !so.columnHeaders || so.bandedRows || so.bandedColumns) pt.styleOptions = so;
  }
  if (fa && fa.flag('insertBlankRow', false)) pt.blankRows = true;
  for (const f of x.child('filters')?.kids('filter') ?? []) {
    if (f.attr('type') !== 'dateBetween') continue;
    const i = f.num('fld');
    const name = i === undefined ? null : cache.fields[i]?.name;
    const cf = f.path(['autoFilter', 'filterColumn', 'customFilters'])?.kids('customFilter') ?? [];
    const lo = cf.find(c => c.attr('operator') === 'greaterThanOrEqual'), hi = cf.find(c => ['lessThan', 'lessThanOrEqual'].includes(c.attr('operator')));
    const from = Number(lo?.attr('val'));
    if (name && Number.isFinite(from)) (pt.dateFilters ??= []).push({field: name, from, until: hi && Number.isFinite(Number(hi.attr('val'))) ? Number(hi.attr('val')) + (hi.attr('operator') === 'lessThanOrEqual' ? 1 : 0) : null});
  }
  for (const l of x.child('extLst')?.kids('ext') ?? []) if (l.child('pivotTableDefinition')?.flag('fillDownLabelsDefault', false)) pt.repeatLabels = true;
  if (x.child('calculatedItems') || (x.child('filters')?.kids('filter') ?? []).some(f => f.attr('type') !== 'dateBetween')) warn(`PivotTable "${pt.name}": calculated items and label/value filters are not supported`);
  if (x.flag('dataOnRows', false) || rowX.includes(-2)) warn(`PivotTable "${pt.name}": values in rows are not supported; they are in columns`);
  const axisFilters = [];
  const axis = list => {
    const out = [];
    for (const i of list) {
      if (i < 0) continue;
      const ref = fieldRef(cache, i, warn);
      if (!ref) continue;
      const [name, group] = ref;
      const labels = labelsOf(cache.fields[i]);
      const f = {sourceCol: name, sort: 'none', dateGroup: group, collapsedItems: []};
      const e = pfs[i];
      if (e && e.attr('name') && !same(e.attr('name'), name)) f.caption = String(e.attr('name'));
      if (e) {
        f.sort = e.attr('sortType') === 'ascending' ? 'asc' : e.attr('sortType') === 'descending' ? 'desc' : 'none';
        const items = dataItems(e);
        const lab = it => (it.num('x') !== undefined ? labels[it.num('x')] : undefined);
        f.collapsedItems = items.filter(it => !it.flag('sd', true)).map(lab).filter(l => l !== undefined);
        if (items.some(it => it.flag('h', false))) {
          const shown = items.filter(it => !it.flag('h', false)).map(lab).filter(l => l !== undefined);
          if (!axisFilters.some(ff => same(ff.sourceCol, name))) axisFilters.push({sourceCol: name, selected: shown});
        }
      }
      out.push(f);
    }
    return out;
  };
  const pageFilters = [];
  for (const p of pages) {
    const i = p.num('fld');
    if (i === undefined || i < 0) continue;
    const ref = fieldRef(cache, i, warn);
    if (!ref) continue;
    const labels = labelsOf(cache.fields[i]);
    let selected = null;
    if (p.num('item') !== undefined) { const l = labels[p.num('item')]; selected = l === undefined ? null : [l]; }
    else if (pfs[i]) {
      const items = dataItems(pfs[i]);
      if (items.some(it => it.flag('h', false))) selected = items.filter(it => !it.flag('h', false)).map(it => labels[it.num('x')]).filter(l => l !== undefined);
    }
    pageFilters.push({sourceCol: ref[0], selected});
  }
  pt.rows = axis(rowX);
  pt.columns = axis(colX);
  pt.filters = [...pageFilters, ...axisFilters];
  for (const d of x.child('dataFields')?.kids('dataField') ?? []) {
    const i = d.num('fld');
    const f = i === undefined ? null : cache.fields[i];
    if (!f) continue;
    let func = 'sum';
    if (d.attr('subtotal') !== undefined) { func = FUNC_FROM[d.attr('subtotal')]; if (!func) { warn(`PivotTable function ${d.attr('subtotal')} is not supported; using Sum`); func = 'sum'; } }
    let ext = null;
    for (const l of d.child('extLst')?.kids('ext') ?? []) { const e = l.child('dataField'); if (e?.attr('pivotShowAs')) ext = e.attr('pivotShowAs'); }
    let showAs = 'normal';
    const sda = d.attr('showDataAs');
    if (ext === 'rankDescending') showAs = 'rank';
    else if (ext) warn(`PivotTable show-values-as ${ext} is not supported`);
    else if (sda === 'percentOfTotal') showAs = 'percentOfGrandTotal';
    else if (sda === 'percentOfCol') showAs = 'percentOfColumnTotal';
    else if (sda === 'percentOfRow') showAs = 'percentOfRowTotal';
    else if (sda === 'runTotal') showAs = 'runningTotal';
    else if (sda && sda !== 'normal') warn(`PivotTable show-values-as ${sda} is not supported`);
    const fid = d.num('numFmtId');
    const numberFormat = fid ? numFmts.get(fid) ?? BUILTIN_FORMATS.get(fid) ?? null : null;
    pt.values.push({sourceCol: f.name, func, name: d.attr('name') ?? `${funcCaption(func)} of ${f.name}`, showAs, numberFormat});
  }
  // Calculated fields of the cache (pivot/read.rs): each PivotTable on it can use them.
  for (const f of cache.fields) {
    if (f.formula === undefined || !String(f.name).trim() || (pt.calculatedFields ?? []).some(c => same(c.name, f.name))) continue;
    const formula = String(f.formula).trim();
    (pt.calculatedFields ??= []).push({name: f.name, formula: formula.startsWith('=') ? formula : `=${formula}`});
  }
  pt.anchor = a1(loc.start.row, loc.start.col);
  const above = pages.length ? pages.length + 1 : 0;
  pt.lastRange = rangeA1({start: {row: Math.max(0, loc.start.row - above), col: loc.start.col}, end: loc.end});
  return pt;
}

/** The PivotTables related to a worksheet part. `pkg` is the package reader (`xml(part)`, `rels(part)`), `cx` the read context. */
export async function readPivots(pkg, cx, caches, sheetPart, sheetName, rels) {
  const out = [];
  for (const rel of rels.filter(r => r.type === 'pivotTable' && !r.external)) {
    const root = await pkg.xml(rel.target);
    if (!root) continue;
    const x = root.name === 'pivotTableDefinition' ? root : root.child('pivotTableDefinition');
    if (!x) { cx.warn(`${rel.target} is not a PivotTable definition; skipped`); continue; }
    const trels = await pkg.rels(rel.target);
    const cachePart = trels.find(r => r.type === 'pivotCacheDefinition' && !r.external)?.target ?? (x.num('cacheId') !== undefined ? caches.byId.get(x.num('cacheId')) : undefined);
    if (!cachePart) { cx.warn(`PivotTable in ${rel.target} has no cache; kept as plain cells`); continue; }
    if (!caches.parsed.has(cachePart)) caches.parsed.set(cachePart, await readCache(pkg, cachePart, sheetName, cx.warn, cx.dateSystem === 1904 ? 1904 : 1900));
    const cache = caches.parsed.get(cachePart);
    if (!cache) continue;
    const pt = readTable(x, cache, cx.nextObjectId ? cx.nextObjectId() : caches.nextId++, cx.warn, cx.numFmts ?? new Map());
    if (pt) out.push(pt);
  }
  return out;
}

export {quoteSheet, itemLabels, labelsOf};
