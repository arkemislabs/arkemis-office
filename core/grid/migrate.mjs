// Schema 1 → schema 2 for Grid workbooks (docs/architecture.md 16.2; F:grid).
//
// Schema 1 (the legacy editor, core/model.mjs): sheets[i] = {id, name, cells: {A1: {value: typed
// text, valueType?: 'text', bold?, italic?, underline?, strike?, fontFamily?, fontSize?, color?,
// background?, align?, verticalAlign?, wrap?, rotation?, indent?, numFmt?, borders?}}, rows, columns,
// xlsxLayout?: {rowHeights (points, 1-based), columnWidths (characters, 1-based), merges, freeze:
// {xSplit, ySplit}}, tables?, pivot?}, activeSheetId, dateSystem?, namedRanges?: {name, reference,
// sheetId?}[].
// Schema 2: model/workbook.mjs. Typed text becomes what gridcraft stores for that input (the
// value, or the formula, with the automatic number format), inline styles are interned once per
// distinct style (model/style.mjs), row heights convert from points to 96-dpi pixels and column
// widths from characters (Column Width units) to pixels exactly as gridcraft's
// points_to_chars/chars_to_pixels; `rows`/`columns` (the old editor's visible extent) are dropped:
// a sheet is always 1,048,576 by 16,384.
// No DOM, no Node built-ins.

import {fromLegacyCell} from './model/store.mjs';
import {blockOf} from './model/store.mjs';
import {charsToPixels} from './model/sheet.mjs';
import {sparseStyle, resolveStyle, styleKey} from './model/style.mjs';

export const FROM = 1;
export const TO = 2;

/** Whether workbook content is schema 1 (sheets hold `cells`). */
export const isSchema1 = content => Array.isArray(content?.sheets) && content.sheets.some(s => s && s.cells && !s.blocks);

/** Migrates schema-1 workbook content to schema 2 (a new object; the input is not changed). */
export function migrate(content) {
  if (!isSchema1(content)) return content;
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const styles = [{}];
  const index = new Map([[styleKey({}), 0]]);
  const intern = st => {
    if (!st) return 0;
    const sparse = sparseStyle(resolveStyle(st));
    const k = styleKey(sparse);
    let id = index.get(k);
    if (id === undefined) { id = styles.length; styles.push(sparse); index.set(k, id); }
    return id;
  };
  const sheets = content.sheets.map(sh => {
    const blocks = {};
    for (const [key, legacy] of Object.entries(sh.cells ?? {})) {
      const k = key.replace(/\$/g, '').toUpperCase();
      const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(k);
      if (!m) continue;
      const row = Number(m[2]) - 1;
      const n = fromLegacyCell(legacy, sys);
      const style = n.style ? {...n.style} : null;
      const fmt = n.autoFmt && !style?.numFmt ? n.autoFmt : null;
      const s = intern(fmt ? {...(style ?? {}), numFmt: fmt} : style);
      const cell = {};
      if (n.v !== undefined) cell.v = n.v;
      if (n.f !== undefined) cell.f = n.f;
      if (s) cell.s = s;
      if (!Object.keys(cell).length) continue;
      (blocks[blockOf(row)] ??= {})[k] = cell;
    }
    const out = {id: sh.id, name: sh.name, blocks};
    const layout = sh.xlsxLayout;
    if (layout?.rowHeights && Object.keys(layout.rowHeights).length) {
      out.rows = {};
      for (const [r, pt] of Object.entries(layout.rowHeights)) out.rows[Number(r) - 1] = pt === 0 ? {hidden: true} : {size: Math.round((pt * 4) / 3), custom: true};
    }
    if (layout?.columnWidths && Object.keys(layout.columnWidths).length) {
      out.cols = {};
      for (const [c, ch] of Object.entries(layout.columnWidths)) out.cols[Number(c) - 1] = ch === 0 ? {hidden: true} : {size: charsToPixels(ch)};
    }
    if (layout?.merges?.length) out.merges = layout.merges.map(m => m.toUpperCase());
    if (layout?.freeze && (layout.freeze.xSplit || layout.freeze.ySplit)) out.freeze = {rows: layout.freeze.ySplit ?? 0, cols: layout.freeze.xSplit ?? 0};
    if (Array.isArray(sh.tables) && sh.tables.length) {
      out.tables = sh.tables.map(t => ({name: t.name, range: t.range, headerRow: t.headerRow !== false, totalsRow: !!t.totalsRow,
        columns: (t.columns ?? []).map(c => ({name: c.name, ...(c.totalsRowFunction ? {totalsRowFunction: c.totalsRowFunction} : {}),
          ...(c.totalsRowLabel ? {totalsRowLabel: c.totalsRowLabel} : {}), ...(c.totalsRowFormula ? {totalsRowFormula: c.totalsRowFormula} : {}),
          ...(c.calculatedColumnFormula ? {calculatedColumnFormula: c.calculatedColumnFormula} : {})})),
        ...(t.style ? {style: t.style} : {})}));
    }
    if (sh.pivot !== undefined) out.pivot = sh.pivot;
    return out;
  });
  const next = {sheets, activeSheetId: content.activeSheetId, styles,
    names: (content.namedRanges ?? []).map(n => ({name: n.name, formula: String(n.reference).replace(/^=/, ''), ...(n.sheetId ? {scope: n.sheetId} : {})}))};
  if (content.dateSystem === 1904) next.dateSystem = 1904;
  return next;
}

/** Migrates a schema-1 file to schema 2 (other files are returned unchanged). */
export function migrateFile(file) {
  if (!file || file.kind !== 'grid' || file.schema !== 1) return file;
  return {...file, schema: 2, content: migrate(file.content)};
}
