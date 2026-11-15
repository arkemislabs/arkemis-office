// Slicers and timelines in .xlsx: the slicer and timeline parts of each sheet, the slicer and timeline caches of the workbook, the drawing frames that place them,
// written from sheet.slicers[] (a timeline is a slicer-list entry with `timeline: true`) and read back into it.
// Not in gridcraft (its slicers are not saved): the structure follows Excel's own parts (MS-XLSX 2.6.x slicers, 2.6.x timelines), not checked against upstream.
// No DOM, no Node built-ins.
//
// Writing: a PivotTable slicer is a slicer part entry (name, cache, caption, columns, style) plus a cache whose items are the shared items of the PivotTable's
// cache field (`x`) with `s="1"` for the shown ones; a table slicer's cache names the table and column (its selection is the table's own filter, as in Excel);
// a timeline has a timeline part entry and a timeline cache with its period (selection) and the bounds of the dates. Each is placed in the sheet's drawing by a
// graphic frame (with the shape Excel 2007 shows as its fallback), listed in the sheet's extLst (slicerList, timelineRefs) and the workbook's (slicerCaches,
// timelineCacheRefs), with a defined name (Slicer_..., NativeTimeline_...) per cache as Excel writes.
// Where a slicer filters several PivotTables they are listed in its cache; our PivotTables each have a cache of their own, so the cache names the first one's.
//
// Reading: the caches by name, the parts of each sheet, the frames' anchors; selections are the items with s="1" (every item on is no filter), the table's own
// AutoFilter criteria, and the timeline's selection dates.

import {parseRange, a1} from './addr.mjs';
import {serialFromYmd, datetimeFromSerial} from './date.mjs';
import {pivotByName, SLICER_DEFAULT_STYLE, isPivotSlicer, slicerPivots} from './slicer.mjs';
import {TIME_LEVELS, TIME_LEVEL_LABEL, dateSpan} from './timeline.mjs';
import {itemLabels, labelsOf} from './xlsx-pivot.mjs';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const NS_X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const NS_X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_SLICER = 'http://schemas.microsoft.com/office/2007/relationships/slicer';
const REL_SLICER_CACHE = 'http://schemas.microsoft.com/office/2007/relationships/slicerCache';
const REL_TIMELINE = 'http://schemas.microsoft.com/office/2011/relationships/timeline';
const REL_TIMELINE_CACHE = 'http://schemas.microsoft.com/office/2011/relationships/timelineCache';
const CT_SLICER = 'application/vnd.ms-excel.slicer+xml';
const CT_SLICER_CACHE = 'application/vnd.ms-excel.slicerCache+xml';
const CT_TIMELINE = 'application/vnd.ms-excel.timeline+xml';
const CT_TIMELINE_CACHE = 'application/vnd.ms-excel.timelineCache+xml';
const URI = {
  slicerList: '{A8765BA9-456A-4dab-B4F3-ACF838C121DE}', slicerListTable: '{3A4CF648-6AED-40f4-86FF-DC5316D8AED3}', timelineRefs: '{7E03D99C-DC04-49d9-9315-930204A7B6E9}',
  slicerCaches: '{BBE1A952-AA13-448e-AADC-164F8A28A991}', slicerCachesTable: '{46BE6895-7355-4a93-B00E-2C351335B9C9}', timelineCacheRefs: '{D0CA8CA8-9F24-4464-BF8E-62219DCF47F9}',
  tableSlicerCache: '{2F2917AC-EB37-4324-AD4E-5DD8C200BD13}',
};
const EMU = 9525;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ident = s => String(s).replace(/[^\p{L}\p{N}_.]/gu, '_').replace(/^(?=\d)/, '_');
const nameOf = s => String(s).replace(/[^\p{L}\p{N}_ .-]/gu, '').trim() || 'Slicer';
const isoDate = (sys, serial) => { const d = datetimeFromSerial(sys, Math.floor(serial)); return d ? `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}T00:00:00` : null; };
const serialOfIso = (sys, t) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t ?? '')); return m ? serialFromYmd(sys, Number(m[1]), Number(m[2]), Number(m[3])) : null; };
const sysOf = content => (content.dateSystem === 1904 ? 1904 : 1900);

const wrap = (tag, ns, body, attrs = '') => `${XML_DECL}<${tag} xmlns="${ns}" xmlns:mc="${NS_MC}" mc:Ignorable="x" xmlns:x="${NS_X}"${attrs}>${body}</${tag}>`;

// ================================================================ writing

export class SlicerWriter {
  constructor(content) {
    this.content = content;
    this.entries = [];
    const names = new Set(), caches = new Set();
    const unique = (set, base) => { let n = base, k = 1; while (set.has(n.toLowerCase())) n = `${base}${++k}`; set.add(n.toLowerCase()); return n; };
    content.sheets.forEach((sheet, si) => (sheet.slicers ?? []).forEach(sl => {
      const kind = sl.timeline ? 'timeline' : isPivotSlicer(sl) ? 'pivot' : 'table';
      const field = sl.field ?? sl.column ?? 'Slicer';
      this.entries.push({si, sl, kind, name: unique(names, nameOf(sl.caption ?? field)), cache: unique(caches, `${kind === 'timeline' ? 'NativeTimeline_' : 'Slicer_'}${ident(field)}`)});
    }));
    this.slicerParts = 0; this.timelineParts = 0;
  }

  /** The entry of a slicer object of sheet `si`, or null. */
  entryOf(si, sl) { return this.entries.find(e => e.si === si && e.sl === sl) ?? null; }

  /** The drawing entry of a slicer or timeline: {type, object, frame(id, anchor)}; null when it cannot be saved. */
  drawingObject(si, sl) {
    const e = this.entryOf(si, sl);
    if (!e) return null;
    const timeline = e.kind === 'timeline';
    return {type: timeline ? 'timeline' : 'slicer', object: sl, frame: (id, a) => frameXml(e.name, id, a, timeline)};
  }

  /** Writes the sheet's slicer and timeline parts; returns the <ext> elements of its extLst ('' when none). */
  sheetParts(si, out, rels) {
    const mine = this.entries.filter(e => e.si === si);
    let ext = '';
    const slicers = mine.filter(e => e.kind !== 'timeline');
    for (const kindGroup of [slicers.filter(e => e.kind === 'pivot'), slicers.filter(e => e.kind === 'table')]) {
      if (!kindGroup.length) continue;
      const n = ++this.slicerParts;
      let body = '';
      for (const e of kindGroup) body += `<slicer name="${escAttr(e.name)}" cache="${escAttr(e.cache)}" caption="${escAttr(e.sl.caption ?? e.sl.field ?? e.sl.column)}"${(e.sl.columns ?? 1) > 1 ? ` columnCount="${e.sl.columns}"` : ''} style="${escAttr(e.sl.style ?? SLICER_DEFAULT_STYLE)}" rowHeight="241300"/>`;
      out.part(`xl/slicers/slicer${n}.xml`, CT_SLICER, wrap('slicers', NS_X14, body));
      const rid = rels.add(REL_SLICER, `../slicers/slicer${n}.xml`);
      ext += kindGroup[0].kind === 'pivot'
        ? `<ext uri="${URI.slicerList}" xmlns:x14="${NS_X14}"><x14:slicerList><x14:slicer r:id="${rid}"/></x14:slicerList></ext>`
        : `<ext uri="${URI.slicerListTable}" xmlns:x15="${NS_X15}"><x15:slicerList xmlns:x14="${NS_X14}"><x14:slicer r:id="${rid}"/></x15:slicerList></ext>`;
    }
    const lines = mine.filter(e => e.kind === 'timeline');
    if (lines.length) {
      const n = ++this.timelineParts;
      let body = '';
      for (const e of lines) {
        const level = Math.max(0, TIME_LEVELS.indexOf(e.sl.level ?? 'months'));
        body += `<timeline name="${escAttr(e.name)}" cache="${escAttr(e.cache)}" caption="${escAttr(e.sl.caption ?? e.sl.field)}" level="${level}" selectionLevel="${level}" scrollPosition="${isoDate(sysOf(this.content), e.sl.from ?? dateSpan(this.content, e.sl.pivot, e.sl.field)?.min ?? 0) ?? '1900-01-01T00:00:00'}" style="${escAttr(e.sl.style ?? 'TimeSlicerStyleLight1')}"/>`;
      }
      out.part(`xl/timelines/timeline${n}.xml`, CT_TIMELINE, wrap('timelines', NS_X15, body));
      const rid = rels.add(REL_TIMELINE, `../timelines/timeline${n}.xml`);
      ext += `<ext uri="${URI.timelineRefs}" xmlns:x15="${NS_X15}"><x15:timelineRefs><x15:timelineRef r:id="${rid}"/></x15:timelineRefs></ext>`;
    }
    return ext;
  }

  /** Writes the caches. `pivots` is the PivotWriter (cache ids by PivotTable name), `tableIds` maps a table's name to its id in the file. Returns {names, ext}. */
  finish(out, wbRels, pivots, tableIds) {
    let names = '';
    const pivotRefs = [], tableRefs = [], lineRefs = [];
    let cacheNo = 0, lineNo = 0;
    const sys = sysOf(this.content);
    for (const e of this.entries) {
      const sl = e.sl;
      if (e.kind === 'pivot') {
        const live = slicerPivots(sl).map(n => [n, pivots.byName.get(n)]).filter(([, v]) => v);
        if (!live.length) continue;
        const first = live[0][1];
        const fi = first.cache.fields.findIndex(f => same(f.name, sl.field));
        if (fi < 0) continue;
        const f = first.cache.fields[fi];
        const labels = itemLabels(f);
        const on = label => sl.selected === null || sl.selected === undefined || sl.selected.some(x => same(x, label));
        const items = labels.map((l, i) => `<i x="${i}"${on(l) ? ' s="1"' : ''}/>`).join('');
        const n = ++cacheNo;
        out.part(`xl/slicerCaches/slicerCache${n}.xml`, CT_SLICER_CACHE, wrap('slicerCacheDefinition', NS_X14, `<pivotTables>${live.map(([name, v]) => `<pivotTable tabId="${v.tabId}" name="${escAttr(name)}"/>`).join('')}</pivotTables><data><tabular pivotCacheId="${first.n}"><items count="${labels.length}">${items}</items></tabular></data>`, ` name="${escAttr(e.cache)}" sourceName="${escAttr(f.name)}"`));
        pivotRefs.push(wbRels.add(REL_SLICER_CACHE, `slicerCaches/slicerCache${n}.xml`));
        names += `<definedName name="${escAttr(e.cache)}">#N/A</definedName>`;
      } else if (e.kind === 'table') {
        const tid = tableIds.get(String(sl.table).toLowerCase());
        const table = this.content.sheets.flatMap(sh => sh.tables ?? []).find(t => same(t.name, sl.table));
        const ci = table ? (table.columns ?? []).findIndex(c => same(c.name, sl.column)) : -1;
        if (tid === undefined || ci < 0) continue;
        const n = ++cacheNo;
        out.part(`xl/slicerCaches/slicerCache${n}.xml`, CT_SLICER_CACHE, wrap('slicerCacheDefinition', NS_X14, `<extLst><ext uri="${URI.tableSlicerCache}" xmlns:x15="${NS_X15}"><x15:tableSlicerCache tableId="${tid}" column="${ci + 1}"/></ext></extLst>`, ` name="${escAttr(e.cache)}" sourceName="${escAttr(table.columns[ci].name)}"`));
        tableRefs.push(wbRels.add(REL_SLICER_CACHE, `slicerCaches/slicerCache${n}.xml`));
        names += `<definedName name="${escAttr(e.cache)}">#N/A</definedName>`;
      } else {
        const live = slicerPivots(sl).map(n => [n, pivots.byName.get(n)]).filter(([, v]) => v);
        if (!live.length) continue;
        const span = dateSpan(this.content, sl.pivot, sl.field);
        if (!span) continue;
        const n = ++lineNo;
        const from = isoDate(sys, sl.from ?? span.min), to = isoDate(sys, (sl.until ?? span.max + 1) - 1);
        out.part(`xl/timelineCaches/timelineCache${n}.xml`, CT_TIMELINE_CACHE, wrap('timelineCacheDefinition', NS_X15, `<pivotTables>${live.map(([name, v]) => `<pivotTable tabId="${v.tabId}" name="${escAttr(name)}"/>`).join('')}</pivotTables><state minimalRefreshVersion="6" lastRefreshVersion="6" pivotCacheId="${live[0][1].n}" filterType="dateBetween"><selection startDate="${from}" endDate="${to}"/><bounds startDate="${isoDate(sys, span.min)}" endDate="${isoDate(sys, span.max)}"/></state>`, ` name="${escAttr(e.cache)}" sourceName="${escAttr(sl.field)}"`));
        lineRefs.push(wbRels.add(REL_TIMELINE_CACHE, `timelineCaches/timelineCache${n}.xml`));
        names += `<definedName name="${escAttr(e.cache)}">#N/A</definedName>`;
      }
    }
    let ext = '';
    if (pivotRefs.length) ext += `<ext uri="${URI.slicerCaches}" xmlns:x14="${NS_X14}"><x14:slicerCaches>${pivotRefs.map(r => `<x14:slicerCache r:id="${r}"/>`).join('')}</x14:slicerCaches></ext>`;
    if (tableRefs.length) ext += `<ext uri="${URI.slicerCachesTable}" xmlns:x15="${NS_X15}"><x15:slicerCaches xmlns:x14="${NS_X14}">${tableRefs.map(r => `<x14:slicerCache r:id="${r}"/>`).join('')}</x15:slicerCaches></ext>`;
    if (lineRefs.length) ext += `<ext uri="${URI.timelineCacheRefs}" xmlns:x15="${NS_X15}"><x15:timelineCacheRefs>${lineRefs.map(r => `<x15:timelineCacheRef r:id="${r}"/>`).join('')}</x15:timelineCacheRefs></ext>`;
    return {names, ext: ext ? `<extLst>${ext}</extLst>` : ''};
  }
}

/** The graphic frame of a slicer or timeline (inside its anchor), with the shape older readers show instead. */
function frameXml(name, id, a, timeline) {
  const w = Math.round((a.width ?? 0) * EMU), h = Math.round((a.height ?? 0) * EMU);
  const uri = timeline ? 'http://schemas.microsoft.com/office/drawing/2012/timeslicer' : 'http://schemas.microsoft.com/office/drawing/2010/slicer';
  const el = timeline ? `<tsle:timeslicer xmlns:tsle="${uri}" name="${escAttr(name)}"/>` : `<sle:slicer xmlns:sle="${uri}" name="${escAttr(name)}"/>`;
  const req = timeline ? 'tsle' : 'a14';
  const reqNs = timeline ? `xmlns:tsle="${uri}"` : 'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"';
  return `<mc:AlternateContent xmlns:mc="${NS_MC}"><mc:Choice ${reqNs} Requires="${req}"><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${escAttr(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
    + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${uri}">${el}</a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice>`
    + `<mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:prstClr val="white"/></a:solidFill><a:ln w="1"><a:solidFill><a:prstClr val="green"/></a:solidFill></a:ln></xdr:spPr>`
    + `<xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>This shape represents ${timeline ? 'a timeline. Timelines are' : 'a slicer. Slicers are'} supported in Excel 2010 or later.</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent>`;
}

/** Adds extra <ext> elements to a worksheet's extLst string (which may be empty). */
export function mergeExt(extLst, extra) {
  if (!extra) return extLst;
  return extLst ? extLst.replace('</extLst>', `${extra}</extLst>`) : `<extLst>${extra}</extLst>`;
}

// ================================================================ reading

/** Reads a sheet's slicer and timeline parts; they wait in `cx.slicerPending` until the caches are read. */
export async function readSheetSlicers(pkg, cx, rels, sheet) {
  for (const rel of rels.filter(r => (r.type === 'slicer' || r.type === 'timeline') && !r.external)) {
    const root = await pkg.xml(rel.target);
    if (!root) continue;
    for (const e of root.kids(rel.type)) {
      (cx.slicerPending ??= []).push({sheet, timeline: rel.type === 'timeline', name: e.attr('name'), cache: e.attr('cache'), caption: e.attr('caption'), columns: e.num('columnCount'), style: e.attr('style'),
        level: e.num('level'), scroll: e.attr('scrollPosition')});
    }
  }
}

/** The anchor of a slicer or timeline frame found while reading a sheet's drawing. */
export const noteFrame = (cx, sheet, name, anchor) => { (cx.frames ??= new Map()).set(`${sheet.name}|${name}`, anchor); };

/** Reads the workbook's caches and gives every pending slicer and timeline its place in its sheet. */
export async function resolveSlicers(pkg, cx, wbRels) {
  const pending = cx.slicerPending ?? [];
  if (!pending.length) return;
  const caches = new Map();
  for (const rel of wbRels.filter(r => (r.type === 'slicerCache' || r.type === 'timelineCache') && !r.external)) {
    const root = await pkg.xml(rel.target);
    if (root) caches.set(root.attr('name'), {kind: rel.type, x: root});
  }
  const sys = cx.dateSystem === 1904 ? 1904 : 1900;
  for (const p of pending) {
    const c = caches.get(p.cache);
    if (!c) { cx.warn(`slicer ${p.name} has no cache and was skipped`); continue; }
    const anchor = cx.frames?.get(`${p.sheet.name}|${p.name}`) ?? {cell: 'A1', dx: 4, dy: 4, width: 168, height: 200, mode: 'moveOnly'};
    const base = {id: cx.nextObjectId(), anchor, caption: p.caption ?? c.x.attr('sourceName') ?? p.name, selected: null, columns: Math.max(1, Math.min(10, p.columns ?? 1))};
    const tables = (c.x.child('pivotTables')?.kids('pivotTable') ?? []).map(t => t.attr('name')).filter(Boolean);
    if (c.kind === 'timelineCache') {
      const state = c.x.child('state');
      const sel = state?.child('selection');
      const from = serialOfIso(sys, sel?.attr('startDate')), end = serialOfIso(sys, sel?.attr('endDate'));
      const bounds = [serialOfIso(sys, state?.child('bounds')?.attr('startDate')), serialOfIso(sys, state?.child('bounds')?.attr('endDate'))];
      const all = from === null || (bounds[0] !== null && from <= bounds[0] && end !== null && bounds[1] !== null && end >= bounds[1]);
      if (!tables.length) continue;
      (p.sheet.slicers ??= []).push({...base, timeline: true, pivot: tables[0], pivots: tables, field: c.x.attr('sourceName'), column: c.x.attr('sourceName'), level: TIME_LEVELS[p.level ?? 2] ?? 'months',
        from: all ? null : from, until: all || end === null ? null : end + 1, scroll: 0, style: p.style ?? 'TimeSlicerStyleLight1', pick: null});
      continue;
    }
    const field = c.x.attr('sourceName');
    const tsc = c.x.path(['extLst', 'ext'])?.child('tableSlicerCache') ?? (c.x.child('extLst')?.kids('ext') ?? []).map(e => e.child('tableSlicerCache')).find(Boolean);
    if (tsc) {
      const hit = cx.tableIds?.get(tsc.num('tableId'));
      if (!hit) continue;
      const col = hit.columns?.[(tsc.num('column') ?? 1) - 1]?.name ?? field;
      // A table slicer's selection is the table's own filter on that column.
      const af = hit.sheet.autofilter;
      const off = (hit.columns ?? []).findIndex(x => same(x.name, col));
      const crit = af?.criteria?.[off];
      (p.sheet.slicers ??= []).push({...base, table: hit.name, column: col, selected: crit?.type === 'values' && Array.isArray(crit.values) ? [...crit.values] : null, style: p.style ?? SLICER_DEFAULT_STYLE});
      continue;
    }
    if (!tables.length) continue;
    const pc = c.x.path(['data', 'tabular']);
    const cacheId = pc?.num('pivotCacheId');
    const part = cacheId !== undefined ? cx.caches?.byId.get(cacheId) : null;
    const parsed = part ? cx.caches.parsed.get(part) : null;
    const fi = parsed ? parsed.fields.findIndex(f => same(f.name, field)) : -1;
    let selected = null;
    if (fi >= 0) {
      const labels = labelsOf(parsed.fields[fi]);
      const items = pc.child('items')?.kids('i') ?? [];
      const shown = items.filter(i => i.flag('s', false)).map(i => labels[i.num('x')]).filter(x => x !== undefined);
      if (items.length && shown.length && shown.length < items.length) selected = shown;
    }
    (p.sheet.slicers ??= []).push({...base, pivot: tables[0], pivots: tables, field, column: field, selected, style: p.style ?? SLICER_DEFAULT_STYLE});
  }
}

export {a1, parseRange, TIME_LEVEL_LABEL};
