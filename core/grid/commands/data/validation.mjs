// Data > Data Tools > Data Validation (the dialog's Settings, Input Message and Error Alert tabs,
// Clear All), Circle Invalid Data, and the check a typed value goes through.
// Translated from gridcraft crates/engine/src/cmd/data/validation.rs (`validation`,
// `validate_cmd`, `circle_invalid`) and cmd/data.rs (specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A rule applies to the cells of the ranges it is set on and replaces the rules those cells had.
// What is typed is checked by the surface through `data.validate` before it is entered (Stop refuses
// it, Warning and Information ask), a list shows an in-cell drop-down, the Input Message shows when
// the cell is selected, and Circle Invalid Data marks the cells whose values break their rule.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, containsRange} from '../../lib/addr.mjs';
import {parseNumberText} from '../../lib/parse.mjs';
import {editText} from '../../model/input.mjs';
import {hasDoc, gridSel, targetRanges, targetSheet, cellParamOn, requireSchema2} from '../../lib/edit-targets.mjs';
import {removeRuleCells, addRule, ruleRanges} from '../../lib/edit-parts.mjs';
import {bad, baseDoc} from '../../lib/data-common.mjs';
import {checkValidation, listSource, normalizeOp, invalidCells, validationAt, OPERATOR_NAMES} from '../../lib/data-validation.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/data.rs', 'crates/engine/src/cmd/data/validation.rs']};
const RANGE = s.optional(s.string({min: 1, max: 100_000}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const TYPES = ['any', 'whole', 'decimal', 'list', 'date', 'time', 'textLength', 'custom'];

/** A bound typed into a date or time box is stored as the serial number Excel keeps; formulas and plain numbers stay as typed. */
function bound(type, text) {
  const t = String(text ?? '').trim();
  if (!t) return undefined;
  if (t.startsWith('=')) return t.slice(1);
  if (type === 'date' || type === 'time') { const n = parseNumberText(t); if (n !== null) return String(n); }
  return t;
}

function validation(ctx, p) {
  baseDoc(ctx);
  const {sheet: si, areas: picked} = targetRanges(ctx, p);
  let areas = picked;
  requireSchema2(ctx, si);
  if (p.clear === true) {
    for (const r of areas) removeRuleCells(ctx.change, si, 'validations', r);
    return null;
  }
  if (typeof p.type !== 'string') throw bad('data.validation', 'missing `type`');
  if (!TYPES.includes(p.type)) throw bad('data.validation', `unknown type \`${p.type}\` (${TYPES.join(', ')})`);
  if (p.operator !== undefined && !OPERATOR_NAMES.includes(p.operator)) throw bad('data.validation', `unknown operator \`${p.operator}\` (${OPERATOR_NAMES.join(', ')})`);
  if (p.type === 'list' && !String(p.formula1 ?? '').trim().replace(/^=/, '')) throw bad('data.validation', 'a list validation needs `formula1`');
  // "Apply these changes to all other cells with the same settings" (Office; not in gridcraft, not checked against upstream): the rules of
  // the sheet that equal the rule of the active cell (type, operator, bounds) are replaced along with the selection.
  if (p.applyToSame === true) {
    const sheet = ctx.doc.sheets[si];
    const old = validationAt(sheet, gridSel(ctx).active);
    const same = r => ['type', 'operator', 'formula1', 'formula2'].every(k => (r[k] ?? null) === (old[k] ?? null));
    if (old) {
      const all = [...areas, ...(sheet.validations ?? []).filter(same).flatMap(ruleRanges)];
      // The selection may lie inside the old rule's cells: keep each cell once.
      areas = all.filter((r, i) => !all.some((o, j) => j !== i && containsRange(o, r) && (!containsRange(r, o) || j < i)));
    }
  }
  const style = p.errorStyle ?? 'stop';
  const rule = {id: `dv${ctx.host?.uid?.() ?? Date.now().toString(36)}`, ranges: areas.map(r => (r.start.row === r.end.row && r.start.col === r.end.col ? a1(r.start.row, r.start.col) : `${a1(r.start.row, r.start.col)}:${a1(r.end.row, r.end.col)}`)), type: p.type};
  if (p.type !== 'any' && p.type !== 'list' && p.type !== 'custom') rule.operator = normalizeOp(p.operator);
  const f1 = p.type === 'list' ? listSource(String(p.formula1 ?? '')) : bound(p.type, p.formula1);
  if (f1 !== undefined) rule.formula1 = f1;
  const f2 = p.type === 'list' || p.type === 'custom' ? undefined : bound(p.type, p.formula2);
  if (f2 !== undefined && (rule.operator === 'between' || rule.operator === 'notBetween')) rule.formula2 = f2;
  rule.allowBlank = p.ignoreBlank !== false;
  if (p.dropdown === false) rule.inCellDropdown = false;
  rule.showInputMessage = p.showInput !== false;
  if (p.inputTitle) rule.promptTitle = p.inputTitle;
  if (p.inputMessage) rule.prompt = p.inputMessage;
  rule.showErrorMessage = p.showError !== false;
  if (style !== 'stop') rule.errorStyle = style;
  if (p.errorTitle) rule.errorTitle = p.errorTitle;
  if (p.errorMessage) rule.error = p.errorMessage;
  for (const r of areas) removeRuleCells(ctx.change, si, 'validations', r);
  addRule(ctx.change, si, 'validations', rule);
  return null;
}

function validate(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const si = targetSheet(ctx, p, ['cell']);
  const at = cellParamOn(ctx, p, 'cell', si) ?? sel.active;
  const r = checkValidation(content, si, at, String(p.input ?? ''));
  if (!r) return {ok: true};
  return {ok: false, message: r.message, title: r.title, style: r.style};
}

function circleInvalid(ctx, p) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  if (p.clear === true) { ctx.setView({circles: null}); return {invalid: []}; }
  const cells = invalidCells(content, si, (row, col) => editText(content, si, row, col));
  const invalid = cells.map(c => a1(c.row, c.col));
  ctx.setView({circles: {sheet: content.sheets[si].id, cells: invalid}});
  return {invalid};
}

export default defineCommands({
  family: 'data/validation',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.validation', label: 'Data Validation…', risk: 'edit', dialog: 'dialog.dataValidation',
      description: 'Set (or with clear: true remove) the data validation of a range: type any|whole|decimal|list|date|time|textLength|custom, operator, formula1/formula2, ignoreBlank, dropdown, input message and error alert.',
      params: s.object({
        range: RANGE, sheet: SHEET, type: s.optional(s.enum(TYPES)), operator: s.optional(s.enum(OPERATOR_NAMES)),
        formula1: s.optional(s.string({max: 8192})), formula2: s.optional(s.string({max: 8192})),
        ignoreBlank: s.optional(s.boolean()), dropdown: s.optional(s.boolean()),
        showInput: s.optional(s.boolean()), inputTitle: s.optional(s.string({max: 32})), inputMessage: s.optional(s.string({max: 255})),
        showError: s.optional(s.boolean()), errorStyle: s.optional(s.enum(['stop', 'warning', 'information'])),
        errorTitle: s.optional(s.string({max: 32})), errorMessage: s.optional(s.string({max: 255})),
        clear: s.optional(s.boolean()), applyToSame: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: validation,
    },
    {
      id: 'data.validate', label: 'Check Value Against Validation', risk: 'read',
      description: 'Would typing `input` into the cell pass its data validation? → {ok, message?, title?, style?}.',
      params: s.object({cell: s.optional(s.string({max: 600})), sheet: SHEET, input: s.optional(s.string({max: 32_767}))}),
      state: hasDoc,
      run: validate,
    },
    {
      id: 'data.circleInvalid', label: 'Circle Invalid Data', risk: 'edit', undo: 'none', effect: 'view',
      description: 'Mark the cells whose values break their data validation with red circles; clear: true removes the circles. → {invalid: cells}.',
      params: s.object({clear: s.optional(s.boolean())}),
      state: hasDoc,
      run: circleInvalid,
    },
  ],
});
