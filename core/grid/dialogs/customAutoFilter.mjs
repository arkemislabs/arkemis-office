// Custom AutoFilter dialog model (submit: data.filterBy {custom}): the dialog behind a drop-down's
// Text Filters, Number Filters and Date Filters.
// Excel's Custom AutoFilter (Show rows where: an operator and a value, and a second pair joined by And
// or Or) over gridcraft's FilterCriterion::Custom {a, b, and} (cmd/data/filter.rs `custom_ok`:
// = <> > < >= <= and the text comparisons begins with, ends with, contains, does not contain) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: column (a letter), title (the heading), kind (text|number|date), op1, val1, op2, val2, join (and|or).
// The surface opens it with the column and a preset (its init values) from the filter menu.

import {defineDialog} from '../../kernel/dialog.mjs';
import {parseNumberText} from '../lib/parse.mjs';

export const OPERATORS = Object.freeze([
  ['=', 'equals'], ['<>', 'does not equal'], ['>', 'is greater than'], ['>=', 'is greater than or equal to'], ['<', 'is less than'], ['<=', 'is less than or equal to'],
  ['beginsWith', 'begins with'], ['endsWith', 'ends with'], ['contains', 'contains'], ['notContains', 'does not contain'],
]);

const value = (kind, text) => {
  const t = String(text ?? '');
  if (kind === 'date' && t.trim() !== '') { const n = parseNumberText(t); if (n !== null) return String(n); }
  return t;
};

export default defineDialog({
  id: 'dialog.customAutoFilter',
  title: 'Custom AutoFilter',
  command: 'data.filterBy',
  init: () => ({column: 'A', title: '', kind: 'text', op1: '=', val1: '', op2: '', val2: '', join: 'and'}),
  validate(v) {
    const out = [];
    const needs = op => op !== '=' && op !== '<>';
    if (v.op1 && needs(v.op1) && String(v.val1 ?? '') === '') out.push({field: 'val1', message: 'Enter a value to compare with.'});
    if (v.op2 && String(v.val2 ?? '') === '' && needs(v.op2)) out.push({field: 'val2', message: 'Enter a value to compare with.'});
    if (v.kind === 'date') {
      for (const [op, k] of [[v.op1, 'val1'], [v.op2, 'val2']]) if (op && String(v[k] ?? '') !== '' && parseNumberText(String(v[k])) === null) out.push({field: k, message: `Date not understood: ${v[k]}`});
    }
    return out;
  },
  toCommand(v) {
    const custom = {op: v.op1 || '=', value: value(v.kind, v.val1), and: v.join !== 'or'};
    if (v.op2) { custom.op2 = v.op2; custom.value2 = value(v.kind, v.val2); }
    return {command: 'data.filterBy', params: {column: v.column, custom}};
  },
});
