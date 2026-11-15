// An AutoFilter in .xlsx: <autoFilter ref> with a <filterColumn> per filtered column (values,
// custom filters, top 10, above / below average, colour filters, icon filters).
// Translated from gridcraft crates/xlsx/src/sheet_read/parts.rs (`read_autofilter`, `filter_op`) and
// crates/xlsx/src/sheet_write/parts.rs (`autofilter_xml`, `filter_operator`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Beyond upstream, the text comparisons a drop-down's Text Filters make (begins with, ends with,
// contains, does not contain) are written the way Excel stores them (an equal / not equal filter
// with a wildcard value) and read back as the same comparison. Date filters by period
// (<dynamicFilter> other than above / below average) are not supported and are dropped, as upstream.
// The element reader is xlsx-read.mjs's `El`; no DOM, no Node built-ins.

import {parseRange, rangeA1} from './addr.mjs';

const OPS = {lessThan: '<', lessThanOrEqual: '<=', notEqual: '<>', greaterThanOrEqual: '>=', greaterThan: '>', equal: '='};
const OPERATORS = {'<': 'lessThan', '<=': 'lessThanOrEqual', '<>': 'notEqual', '>=': 'greaterThanOrEqual', '>': 'greaterThan'};

/** One custom comparison as the file stores it: [operator attr or null for equal, value]. */
function fileCompare([op, val]) {
  const v = String(val ?? '');
  switch (op) {
    case 'beginsWith': return [null, `${v}*`];
    case 'endsWith': return [null, `*${v}`];
    case 'contains': return [null, `*${v}*`];
    case 'notContains': return ['notEqual', `*${v}*`];
    default: return [OPERATORS[op] ?? null, v];
  }
}

/** `<autoFilter ref>` (an El) to {range, criteria?}; null when it has no usable ref. */
export function readAutofilter(e, dxfs = []) {
  const r = parseRange(String(e.attr('ref') ?? '').replace(/\$/g, ''));
  if (!r) return null;
  const criteria = {};
  for (const fc of e.kids('filterColumn')) {
    const col = fc.num('colId');
    if (col === undefined) continue;
    let crit = null;
    const f = fc.child('filters'), cf = fc.child('customFilters'), t = fc.child('top10'), d = fc.child('dynamicFilter');
    const c = fc.child('colorFilter'), i = fc.child('iconFilter');
    if (f) crit = {type: 'values', values: f.kids('filter').map(x => x.attr('val')).filter(x => x !== undefined), blanks: f.flag('blank', false)};
    else if (cf) {
      const list = cf.kids('customFilter').map(x => [OPS[x.attr('operator') ?? 'equal'] ?? '=', x.attr('val') ?? '']);
      if (!list.length) continue;
      crit = {type: 'custom', a: list[0], and: cf.flag('and', false)};
      if (list[1]) crit.b = list[1];
    } else if (t) crit = {type: 'top10', bottom: !t.flag('top', true), percent: t.flag('percent', false), count: Math.min(Math.max(Math.trunc(t.num('val') ?? 10), 0), 1e9)};
    else if (d) {
      if (d.attr('type') === 'aboveAverage') crit = {type: 'aboveAverage', above: true};
      else if (d.attr('type') === 'belowAverage') crit = {type: 'aboveAverage', above: false};
      else continue;
    } else if (c) {
      const dxf = dxfs[c.num('dxfId')];
      if (!dxf) continue;
      crit = c.flag('cellColor', true) ? {type: 'fillColor', color: dxf.fill?.fg ?? null} : {type: 'fontColor', color: dxf.font?.color ?? null};
    } else if (i) {
      if (!i.attr('iconSet')) continue;
      crit = {type: 'icon', set: i.attr('iconSet'), ...(i.num('iconId') !== undefined ? {id: i.num('iconId')} : {})};
    } else continue;
    criteria[col] = crit;
  }
  return Object.keys(criteria).length ? {range: rangeA1(r), criteria} : {range: rangeA1(r)};
}

/** `<autoFilter>` XML of a stored filter; colour criteria add differential formats to `dxfs`. */
export function autofilterXml(af, dxfs, esc) {
  let s = `<autoFilter ref="${esc(af.range)}"`;
  const keys = Object.keys(af.criteria ?? {}).map(Number).sort((a, b) => a - b);
  if (!keys.length) return `${s}/>`;
  s += '>';
  for (const col of keys) {
    const c = af.criteria[col];
    s += `<filterColumn colId="${col}">`;
    switch (c.type) {
      case 'values':
        s += `<filters${c.blanks ? ' blank="1"' : ''}>${(c.values ?? []).map(v => `<filter val="${esc(v)}"/>`).join('')}</filters>`;
        break;
      case 'custom': {
        const list = [c.a, ...(c.b ? [c.b] : [])].map(fileCompare);
        s += `<customFilters${c.and ? ' and="1"' : ''}>${list.map(([op, v]) => `<customFilter${op ? ` operator="${op}"` : ''} val="${esc(v)}"/>`).join('')}</customFilters>`;
        break;
      }
      case 'top10': s += `<top10${c.bottom ? ' top="0"' : ''}${c.percent ? ' percent="1"' : ''} val="${c.count}"/>`; break;
      case 'aboveAverage': s += `<dynamicFilter type="${c.above ? 'aboveAverage' : 'belowAverage'}"/>`; break;
      case 'fillColor': dxfs.push({fill: {pattern: 'solid', fg: c.color}}); s += `<colorFilter dxfId="${dxfs.length - 1}"/>`; break;
      case 'fontColor': dxfs.push({font: {color: c.color}}); s += `<colorFilter dxfId="${dxfs.length - 1}" cellColor="0"/>`; break;
      case 'icon': s += `<iconFilter iconSet="${esc(c.set)}"${c.id !== undefined ? ` iconId="${c.id}"` : ''}/>`; break;
      default: break;
    }
    s += '</filterColumn>';
  }
  return `${s}</autoFilter>`;
}
