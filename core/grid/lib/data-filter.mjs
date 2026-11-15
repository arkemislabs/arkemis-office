// AutoFilter: which rows a filter's criteria hide, the distinct values a column's drop-down lists,
// and growing the filter range when a value is typed right below it.
// Translated from gridcraft crates/engine/src/cmd/data/filter.rs (`custom_ok`, `filter_blank`,
// `grow_autofilter`, `apply_filter`, `filter_values`, `sort_key`) and crates/model/src/features.rs
// (`FilterCriterion`, `AutoFilter`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored form: `sheet.autofilter = {range: 'A1:D20', criteria?: {[offset in the range]: Criterion}}` and
//   Criterion = {type: 'values', values: string[], blanks: bool}
//             | {type: 'custom', a: [op, text], b?: [op, text], and: bool}   op: = <> > < >= <= beginsWith endsWith contains notContains
//             | {type: 'top10', bottom, percent, count} | {type: 'aboveAverage', above}
//             | {type: 'fillColor', color: '#RRGGBB'|null} | {type: 'fontColor', color} | {type: 'icon', set, id?}.
// Rows the filter hides carry `hidden: true` in the sheet's `rows`. No DOM, no Node built-ins.

import {parseRange, rangeA1, contains} from './addr.mjs';
import {compareText, display, CellError} from './value.mjs';
import {parseNumberText} from './parse.mjs';
import {wildcard} from './edit-find.mjs';
import {engineFor} from '../model/calc.mjs';
import {cellAt, hasContent} from '../model/store.mjs';
import {isRowHidden} from '../model/sheet.mjs';
import {styleAt} from '../model/workbook.mjs';
import {colorHex} from '../model/style.mjs';
import {valueOf, textOf, isBlankValue} from './data-common.mjs';

/** The filter's "(Blanks)" group: truly empty cells and zero-length text such as a `=""` result. */
export const filterBlank = v => v === null || v === undefined || v === '';

const ORDERING = new Set(['<', '<=', '>', '>=']);

/** Does a value pass a custom comparison (`>`, `=*abc*`, `<>x`...)? */
export function customOk(v, text, op, crit) {
  const num = parseNumberText(crit);
  const n = typeof v === 'number' ? v : null;
  let cmp;
  if (n !== null && num !== null) cmp = n < num ? -1 : n > num ? 1 : n === num ? 0 : null;
  else if (n === null && num !== null && ORDERING.has(op)) cmp = null;
  else cmp = compareText(text, crit);
  const lt = text.toLowerCase(), lc = crit.toLowerCase();
  const wild = () => wildcard(lt, lc);
  const hasWild = /[*?]/.test(crit);
  switch (op) {
    case '=': return hasWild ? wild() : cmp === 0;
    case '<>': return hasWild ? !wild() : cmp !== 0;
    case '>': return cmp === 1;
    case '<': return cmp === -1;
    case '>=': return cmp === 1 || cmp === 0;
    case '<=': return cmp === -1 || cmp === 0;
    case 'beginsWith': return lt.startsWith(lc);
    case 'endsWith': return lt.endsWith(lc);
    case 'contains': return lt.includes(lc);
    case 'notContains': return !lt.includes(lc);
    default: return true;
  }
}

/** Excel grows an AutoFilter range when a value is entered in the row right below it, in one of its columns. */
export function grownAutofilter(sheet, at, cell) {
  const af = sheet?.autofilter;
  if (!af?.range || !cell || !(!filterBlank(cell.v ?? null) || cell.f !== undefined)) return null;
  const r = parseRange(af.range);
  if (!r || r.end.row + 1 !== at.row || at.col < r.start.col || at.col > r.end.col) return null;
  // A table's own filter is left to the table.
  if ((sheet.tables ?? []).some(t => t.range === af.range)) return null;
  return {...af, range: rangeA1({start: r.start, end: {row: at.row, col: r.end.col}})};
}

/** The criteria of a filter as sorted [offset, criterion] pairs. */
export const criteriaOf = af => Object.keys(af?.criteria ?? {}).map(Number).sort((a, b) => a - b).map(k => [k, af.criteria[k]]);

/**
 * apply_filter: Map row -> hidden for the rows below the header of the filter range. A row that
 * fails any criterion is hidden; an icon criterion keeps the row's current visibility.
 */
export function computeFilter(content, si, af) {
  const out = new Map();
  const r = parseRange(af?.range ?? '');
  if (!r) return out;
  const sheet = content.sheets[si];
  const engine = engineFor(content);
  const theme = content.theme;
  const crit = criteriaOf(af);
  // Per-criterion top-N threshold and average, once.
  const stats = new Map();
  crit.forEach(([off, c], i) => {
    if (c.type !== 'top10' && c.type !== 'aboveAverage') return;
    const col = r.start.col + off;
    const nums = [];
    for (let row = r.start.row + 1; row <= r.end.row; row++) { const v = valueOf(engine, si, row, col); if (typeof v === 'number') nums.push(v); }
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    let thr = null;
    if (c.type === 'top10') {
      nums.sort((a, b) => (c.bottom ? a - b : b - a));
      const k0 = c.percent ? Math.ceil(nums.length * c.count / 100) : c.count;
      const k = Math.min(Math.max(k0, 1), Math.max(nums.length, 1));
      thr = nums.length >= k ? nums[k - 1] : null;
    }
    stats.set(i, {thr, avg});
  });
  for (let row = r.start.row + 1; row <= r.end.row; row++) {
    let visible = true;
    for (let i = 0; i < crit.length && visible; i++) {
      const [off, c] = crit[i];
      const col = r.start.col + off;
      const v = valueOf(engine, si, row, col);
      const text = textOf(content, si, row, col, v);
      let ok;
      switch (c.type) {
        case 'values':
          if (filterBlank(v)) ok = !!c.blanks;
          else { const dv = v instanceof CellError ? v.text : display(v); ok = (c.values ?? []).some(x => { const l = String(x).toLowerCase(); return l === text.toLowerCase() || l === dv.toLowerCase(); }); }
          break;
        case 'custom': {
          const x = customOk(v, text, c.a[0], c.a[1]);
          ok = c.b ? (c.and ? x && customOk(v, text, c.b[0], c.b[1]) : x || customOk(v, text, c.b[0], c.b[1])) : x;
          break;
        }
        case 'top10': {
          const st = stats.get(i);
          if (typeof v === 'number' && st) { const thr = st.thr ?? v; ok = c.bottom ? v <= thr : v >= thr; } else ok = false;
          break;
        }
        case 'aboveAverage': {
          const st = stats.get(i);
          ok = typeof v === 'number' && st ? (c.above ? v > st.avg : v < st.avg) : false;
          break;
        }
        case 'fillColor': ok = colorHex(styleAt(content, sheet, row, col).fill.fg, theme) === (c.color ?? null); break;
        case 'fontColor': ok = colorHex(styleAt(content, sheet, row, col).font.color, theme) === (c.color ?? null); break;
        // Icons are not evaluated: the row keeps its current visibility.
        case 'icon': ok = !isRowHidden(sheet, row); break;
        default: ok = true;
      }
      if (!ok) visible = false;
    }
    out.set(row, !visible);
  }
  return out;
}

/** sort_key of a value: [kind, number key, lowercase text]. */
export function sortKey(v) {
  if (v === null || v === undefined) return [9, 0, ''];
  if (typeof v === 'number') return [0, Math.trunc(v * 1e6), ''];
  if (typeof v === 'string') return [1, 0, v.toLowerCase()];
  if (typeof v === 'boolean') return [2, v ? 1 : 0, ''];
  return [3, 0, v instanceof CellError ? v.text : display(v)];
}
const cmpKey = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

/** Distinct display values of a filter column for the drop-down: [{text, on}] in sort order (blanks last as "(Blanks)"). */
export function filterValues(content, si, col, af = content.sheets[si]?.autofilter) {
  const r = parseRange(af?.range ?? '');
  if (!r) return [];
  const engine = engineFor(content);
  const off = Math.max(col - r.start.col, 0);
  const sel = af.criteria?.[off];
  const seen = new Map();
  for (let row = r.start.row + 1; row <= Math.min(r.end.row, r.start.row + 1_000_000); row++) {
    const v = valueOf(engine, si, row, col);
    const blank = filterBlank(v);
    const t = blank ? '(Blanks)' : textOf(content, si, row, col, v);
    let on = true;
    if (sel?.type === 'values') on = blank ? !!sel.blanks : (sel.values ?? []).some(x => String(x).toLowerCase() === t.toLowerCase());
    else if (sel) on = true;
    const key = blank ? sortKey(null) : sortKey(v);
    const id = `${key[0]}\u0000${key[1]}\u0000${key[2]}\u0000${t}`;
    if (!seen.has(id)) seen.set(id, {key, text: t, on});
  }
  return [...seen.values()].sort((a, b) => cmpKey(a.key, b.key) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).map(({text, on}) => ({text, on}));
}

/** Whether (row, col) holds a filter button: the header row of the sheet's AutoFilter, or of a table that shows them. */
export function hasFilterButton(sheet, row, col) {
  const af = sheet?.autofilter;
  if (af?.range) { const r = parseRange(af.range); if (r && r.start.row === row && contains(r, {row, col})) return true; }
  for (const t of sheet?.tables ?? []) {
    if (t.headerRow === false || t.autoFilter === false) continue;
    const r = parseRange(t.range);
    if (r && r.start.row === row && contains(r, {row, col})) return true;
  }
  return false;
}

/** Whether a column of the sheet's AutoFilter (or of its table) is filtered. */
export function isColumnFiltered(sheet, row, col) {
  const af = sheet?.autofilter;
  const r = af?.range ? parseRange(af.range) : null;
  return !!(r && r.start.row === row && contains(r, {row, col}) && af.criteria?.[col - r.start.col]);
}

export {isBlankValue, hasContent, cellAt};
