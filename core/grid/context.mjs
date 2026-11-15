// Contextual flags for Grid's contextual tabs (docs/architecture.md 7.2, 8.6; F:grid).
//
// docs/spec/grid.json names ten contextual tabs; their flags (the generated `contextFor` ids) and
// when they show, per gridcraft crates/ui-egui/src/ribbon/contextual.rs and Excel:
//   table-design            the active cell is inside a table (sheet.table_at)
//   pivot-table-analyze,
//   pivot-table-design      the active cell is inside a PivotTable report
//   sparkline               the active cell holds a sparkline
//   chart-design, format    a chart is selected
//   shape-format            a shape or text box is selected
//   picture-format          a picture is selected
//   slicer                  a slicer is selected
//   header-and-footer       a header or footer is being edited in Page Layout view (the document view's `hf`)
// Objects are selected when the selection's primary range names `/sh:<id>/chart:<n>` (shape:, pic:)
// or `/slicer:<id>`. Upstream: gridcraft at 146161b4b450a56e5e59a083ba0478582d1e602b.
// No DOM, no Node built-ins.

import {fromKernelSelection} from './model/workbook.mjs';
import {tableRanges} from './model/sheet.mjs';
import {contains, parseRange} from './lib/addr.mjs';

export const flags = Object.freeze(['table-design', 'chart-design', 'format', 'pivot-table-analyze', 'pivot-table-design', 'header-and-footer',
  'sparkline', 'slicer', 'shape-format', 'picture-format']);

const NONE = Object.freeze(Object.fromEntries(flags.map(f => [f, false])));

function pivotAt(sheet, at) {
  for (const p of sheet?.pivots ?? []) {
    const r = typeof p.lastRange === 'string' ? parseRange(p.lastRange) : null;
    if (r && contains(r, at)) return true;
  }
  return false;
}

export function evaluate(content, selection, _prefs, view) {
  if (!Array.isArray(content?.sheets) || !content.sheets.length) return NONE;
  const out = {...NONE};
  // A header or footer is being edited in Page Layout view (the view's `hf`, core/grid/lib/hf-edit.mjs).
  if (view?.mode === 'pageLayout' && view.hf) out['header-and-footer'] = true;
  const primary = selection?.ranges?.[selection.primary ?? 0];
  const obj = /^\/sh:[^/]+\/(chart|shape|pic):/.exec(primary?.anchor ?? '');
  if (obj) {
    if (obj[1] === 'chart') { out['chart-design'] = true; out.format = true; }
    else if (obj[1] === 'shape') out['shape-format'] = true;
    else out['picture-format'] = true;
    return out;
  }
  if (/^\/slicer:/.test(primary?.anchor ?? '')) { out.slicer = true; return out; }
  const sel = fromKernelSelection(content, selection);
  const sheet = content.sheets[sel.sheet];
  const at = sel.active;
  for (const t of sheet?.tables ?? []) {
    try { if (contains(tableRanges(t).range, at)) { out['table-design'] = true; break; } } catch { /* a malformed table is no table */ }
  }
  if (pivotAt(sheet, at)) { out['pivot-table-analyze'] = true; out['pivot-table-design'] = true; }
  const spark = sheet?.sparklines;
  if (Array.isArray(spark) && spark.some(g => (g.items ?? g.sparklines ?? [g]).some(s => {
    const r = parseRange(s.location ?? s.cell ?? '');
    return r && contains(r, at);
  }))) out.sparkline = true;
  return out;
}
