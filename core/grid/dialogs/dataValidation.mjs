// Data Validation dialog model (submit: data.validation; Clear All runs it with clear).
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`validation_defaults`: the rule on the
// active cell, so OK without edits keeps it, a list rule when the cell has none;
// `data_validation_fields`: Allow, Data, the bounds labelled by Allow and Data, Ignore blank, In-cell
// dropdown, Input message, Error style and message) at 146161b4b450a56e5e59a083ba0478582d1e602b, with
// Excel's three tabs (Settings, Input Message, Error Alert). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {formatValue} from '../lib/numfmt.mjs';
import {parseNumberText} from '../lib/parse.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {selectionText} from '../lib/data-dialog.mjs';
import {validationAt, normalizeOp} from '../lib/data-validation.mjs';
import {baseDoc} from '../lib/data-common.mjs';

/** The labels of the criterion boxes: they follow Allow and Data (data_validation_fields). */
export function criterionLabels(type, operator) {
  const two = operator === 'between' || operator === 'notBetween';
  const lower = operator === 'greater' || operator === 'greaterThan' || operator === 'greaterOrEqual' || operator === 'greaterThanOrEqual';
  const upper = operator === 'less' || operator === 'lessThan' || operator === 'lessOrEqual' || operator === 'lessThanOrEqual';
  if (type === 'list') return ['Source:', ''];
  if (type === 'custom') return ['Formula:', ''];
  const [a, b, c, d] = type === 'date' ? ['Start date:', 'End date:', 'Date:', 'End date:'] : type === 'time' ? ['Start time:', 'End time:', 'Time:', 'End time:'] : ['Minimum:', 'Maximum:', 'Value:', 'Maximum:'];
  return [two || lower ? a : upper ? b : c, d];
}

/** A stored bound as a person reads it: a list literal without its quotes, a serial date as a date. */
function shown(type, f) {
  if (f === undefined || f === null) return '';
  const t = String(f);
  if (type === 'list') return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replaceAll('""', '"') : t;
  if ((type === 'date' || type === 'time') && /^-?\d+(\.\d+)?$/.test(t)) return formatValue(Number(t), type === 'date' ? 'm/d/yyyy' : 'h:mm AM/PM', 1900).text;
  return type === 'custom' ? `=${t}` : t;
}

export default defineDialog({
  id: 'dialog.dataValidation',
  title: 'Data Validation',
  command: 'data.validation',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const rule = validationAt(content.sheets[sel.sheet], sel.active);
    const base = {range: selectionText(ctx), type: 'any', operator: 'between', formula1: '', formula2: '', ignoreBlank: true, dropdown: true, showInput: true,
      inputTitle: '', inputMessage: '', showError: true, errorStyle: 'stop', errorTitle: '', errorMessage: '', applyToSame: false};
    if (!rule) return base;
    return {...base, type: rule.type ?? 'any', operator: normalizeOp(rule.operator), formula1: shown(rule.type, rule.formula1), formula2: shown(rule.type, rule.formula2),
      ignoreBlank: rule.allowBlank === true, dropdown: rule.inCellDropdown !== false, showInput: rule.showInputMessage !== false,
      inputTitle: rule.promptTitle ?? '', inputMessage: rule.prompt ?? '', showError: rule.showErrorMessage !== false, errorStyle: rule.errorStyle ?? 'stop',
      errorTitle: rule.errorTitle ?? '', errorMessage: rule.error ?? ''};
  },
  validate(v) {
    const out = [];
    const [first] = criterionLabels(v.type, v.operator);
    const need = v.type !== 'any';
    if (need && !String(v.formula1 ?? '').trim()) out.push({field: 'formula1', message: v.type === 'list' ? 'The Source is currently empty.' : `Enter a value for ${first.replace(':', '')}.`});
    if ((v.type === 'whole' || v.type === 'decimal' || v.type === 'date' || v.type === 'time' || v.type === 'textLength') && (v.operator === 'between' || v.operator === 'notBetween')
      && !String(v.formula2 ?? '').trim()) out.push({field: 'formula2', message: 'Enter a value for the upper bound.'});
    for (const k of ['formula1', 'formula2']) {
      if ((v.type === 'date' || v.type === 'time') && String(v[k] ?? '').trim() && !String(v[k]).trim().startsWith('=') && parseNumberText(String(v[k])) === null) {
        out.push({field: k, message: `${v.type === 'date' ? 'Date' : 'Time'} not understood: ${v[k]}`});
      }
    }
    return out;
  },
  toCommand(v) {
    const p = {range: v.range, type: v.type, ignoreBlank: v.ignoreBlank !== false, showInput: v.showInput !== false, showError: v.showError !== false,
      errorStyle: v.errorStyle ?? 'stop'};
    if (v.type !== 'any') p.formula1 = String(v.formula1 ?? '').trim();
    if (v.type !== 'any' && v.type !== 'list' && v.type !== 'custom') { p.operator = normalizeOp(v.operator); if (p.operator === 'between' || p.operator === 'notBetween') p.formula2 = String(v.formula2 ?? '').trim(); }
    if (v.type === 'list') p.dropdown = v.dropdown !== false;
    if (v.applyToSame === true) p.applyToSame = true;
    if (v.inputTitle) p.inputTitle = v.inputTitle;
    if (v.inputMessage) p.inputMessage = v.inputMessage;
    if (v.errorTitle) p.errorTitle = v.errorTitle;
    if (v.errorMessage) p.errorMessage = v.errorMessage;
    return {command: 'data.validation', params: p};
  },
  buttons: {'Clear All': (ctx, v) => ({command: 'data.validation', params: {range: v.range, clear: true}})},
});
