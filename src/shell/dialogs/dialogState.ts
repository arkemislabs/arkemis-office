// Dialog state (docs/architecture.md section 9): the values object a dialog's fields edit, shared by
// the person (GlassDialog) and the bridge (`ui.dialog.get/set/submit`), so both drive the same thing.
//
// Pure: no DOM, no React. Imports only kernel .mjs modules and types, so `node --test` can run it.

import {CommandError} from '../../../core/kernel/errors.mjs';
import type {DialogModel, Values, FieldProblem, CommandCall} from '../../../core/kernel/dialog.mjs';
import type {SpecDialog, SpecField, SpecOption} from '../../generated/spec-types';

export type {Values, FieldProblem};

/** Field kinds that hold no value of their own. */
const NO_VALUE = new Set(['preview', 'button', 'label']);
export const hasValue = (f: SpecField) => !NO_VALUE.has(f.kind);

/** A placeholder option such as "<palette>" or "<percent>" stands for free entry, not a choice. */
export const isPlaceholder = (o: SpecOption | string) => /^<[^>]+>$/.test(String(typeof o === 'string' ? o : o.value));
export const realOptions = (f: SpecField) => (f.options ?? []).filter(o => !isPlaceholder(o));

/** The value a field starts with when neither the model nor the spec gives one. */
export function emptyValue(f: SpecField): unknown {
  if (f.default !== undefined) return f.default;
  switch (f.kind) {
    case 'checkbox': return false;
    case 'radio': return realOptions(f)[0]?.value ?? null;
    case 'text': return '';
    case 'list': return null;
    default: return null;
  }
}

export function allFields(spec: SpecDialog): SpecField[] { return spec.tabs.flatMap(t => t.fields); }

/** Initial values: spec defaults, then whatever the model's init() read from the selection. */
export function initialValues(spec: SpecDialog, init?: Values | null): Values {
  const out: Values = {};
  for (const f of allFields(spec)) if (hasValue(f) && !(f.id in out)) out[f.id] = emptyValue(f);
  return {...out, ...(init ?? {})};
}

/** The spec's defaults only ("Reset", "Set As Default" baseline). */
export function defaultValues(spec: SpecDialog): Values { return initialValues(spec, null); }

/**
 * `visibleWhen` expressions the specs use: "field==value", "field!=value", "field in a|b|c",
 * "field" (truthy), "!field". Unknown shapes keep the field visible.
 */
export function fieldVisible(f: SpecField, values: Values): boolean {
  return holds(typeof f.visibleWhen === 'string' ? f.visibleWhen : '', values);
}

/** `enabledWhen` (same expressions as visibleWhen): the field stays in place, greyed out, while the expression is false. */
export function fieldEnabled(f: SpecField, values: Values): boolean {
  const expr = (f as {enabledWhen?: unknown}).enabledWhen;
  return holds(typeof expr === 'string' ? expr : '', values);
}

function holds(raw: string, values: Values): boolean {
  const expr = raw.trim();
  if (!expr) return true;
  let m = /^([A-Za-z0-9_.-]+)\s*(==|!=)\s*(.+)$/.exec(expr);
  if (m) {
    const v = String(values[m[1]] ?? '');
    const eq = m[3].split('|').map(s => s.trim()).includes(v);
    return m[2] === '==' ? eq : !eq;
  }
  m = /^([A-Za-z0-9_.-]+)\s+(not\s+in|in)\s+(.+)$/.exec(expr);
  if (m) {
    const inside = m[3].split(/[|,]/).map(s => s.trim()).includes(String(values[m[1]] ?? ''));
    return m[2] === 'in' ? inside : !inside;
  }
  m = /^(!?)([A-Za-z0-9_.-]+)$/.exec(expr);
  if (m && m[2] in values) return m[1] ? !values[m[2]] : !!values[m[2]];
  return true;
}

// ---------------------------------------------------------------------------------------------
// Units ("12 pt", "2.54 cm"): shown and parsed by NumberField.

const PER_POINT: Record<string, number> = {pt: 1, in: 72, inch: 72, '"': 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, px: 0.75, li: 12};

/** The first unit a spec unit string names ("in|cm (preference)" -> "in"). */
export function primaryUnit(unit: string | undefined | null): string {
  const u = String(unit ?? '').trim();
  if (!u) return '';
  return u.split(/[|\s(]/)[0];
}

/**
 * Parse a typed number with an optional unit into the field's unit: "1 in" in a pt field is 72.
 * Returns null when it does not parse. Percent and degree fields accept a trailing % / °.
 */
export function parseNumber(text: unknown, unit?: string | null): number | null {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const s = String(text ?? '').trim().replace(',', '.');
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))\s*([a-z"%°]*)\.?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const typed = m[2].toLowerCase();
  const target = primaryUnit(unit).toLowerCase();
  if (!typed || typed === target || typed === '%' || typed === '°' || !(typed in PER_POINT) || !(target in PER_POINT)) return n;
  return round(n * PER_POINT[typed] / PER_POINT[target], 4);
}

export const round = (n: number, places = 2) => { const f = 10 ** places; return Math.round(n * f) / f; };

/** Display text for a number in its unit ("12 pt", "2.54 cm", "50%"). */
export function formatNumber(n: unknown, unit?: string | null): string {
  if (n === null || n === undefined || n === '') return '';
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return String(n);
  const u = primaryUnit(unit);
  const text = String(round(v, 2));
  if (!u) return text;
  if (u === '%' || u === '°') return text + u;
  return `${text} ${u}`;
}

/** Arrow keys and the wheel: one step up or down, clamped to min/max. */
export function stepNumber(value: unknown, f: Pick<SpecField, 'min' | 'max' | 'step'>, dir: 1 | -1, big = false): number {
  const step = (f.step && f.step > 0 ? f.step : 1) * (big ? 10 : 1);
  const v = typeof value === 'number' && Number.isFinite(value) ? value : (f.min ?? 0);
  const next = round(Math.round((v + dir * step) / step) * step, 4);
  return clamp(next, f);
}
export const clamp = (n: number, f: Pick<SpecField, 'min' | 'max'>) => Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));

// ---------------------------------------------------------------------------------------------
// The state object

export interface DialogState {
  /** Stack key (a dialog can be opened twice, e.g. More Colors from two fields). */
  key: string;
  id: string;
  spec: SpecDialog;
  tab: number;
  values: Values;
  initial: Values;
  errors: FieldProblem[];
  /** The last submission's error (shown in the dialog's message row). */
  message: string | null;
  busy: boolean;
  /** No model and no registered submit command: shown in development, OK disabled. */
  pending: boolean;
  /** Where the dialog was opened from: run results go back to the opener (nested dialogs). */
  parent: string | null;
  /** For a nested dialog opened by a field: the field of the parent that receives the result. */
  target: {dialog: string; field: string} | null;
  /** Fixed params the opener passed (a control's args); merged under the dialog's own params. */
  args: Record<string, unknown> | null;
  origin: 'ui' | 'bridge' | 'shortcut';
}

let seq = 0;
export function createDialogState(spec: SpecDialog, opts: {init?: Values | null; pending?: boolean; parent?: string | null;
  target?: DialogState['target']; args?: Record<string, unknown> | null; origin?: DialogState['origin']; key?: string} = {}): DialogState {
  const values = initialValues(spec, opts.init);
  return {
    key: opts.key ?? `${spec.id}#${++seq}`, id: spec.id, spec, tab: 0, values, initial: values, errors: [], message: null, busy: false,
    pending: !!opts.pending, parent: opts.parent ?? null, target: opts.target ?? null, args: opts.args ?? null, origin: opts.origin ?? 'ui',
  };
}

/** Set a field (parsing numbers with units), then let the model derive dependent fields. */
export function setValue(state: DialogState, fieldId: string, raw: unknown, model?: DialogModel | null): DialogState {
  const field = allFields(state.spec).find(f => f.id === fieldId);
  if (!field && !(fieldId in state.values)) throw new CommandError('not_found', `${state.id} has no field ${fieldId}`, {field: fieldId});
  let value = raw;
  if (field?.kind === 'number' || field?.kind === 'slider') {
    if (raw === null || raw === '') value = null;
    else {
      const n = parseNumber(raw, field.unit);
      if (n === null) throw new CommandError('invalid_params', `${field.label || fieldId}: enter a number`, {field: fieldId});
      value = n;
    }
  } else if (field?.kind === 'checkbox') {
    value = raw === 'mixed' ? null : !!raw;
  }
  let values: Values = {...state.values, [fieldId]: value};
  if (model?.derive) values = {...values, ...(model.derive(values, [fieldId]) ?? {})};
  return {...state, values, errors: state.errors.filter(e => e.field !== fieldId), message: null};
}

/** Generic checks the spec allows (number ranges) plus the model's validate(). */
export function validateState(state: DialogState, model?: DialogModel | null): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const f of allFields(state.spec)) {
    if (!fieldVisible(f, state.values)) continue;
    const v = state.values[f.id];
    if ((f.kind === 'number' || f.kind === 'slider') && typeof v === 'number') {
      if (f.min !== undefined && v < f.min) problems.push({field: f.id, message: `${clean(f.label)} must be at least ${formatNumber(f.min, f.unit)}`});
      else if (f.max !== undefined && v > f.max) problems.push({field: f.id, message: `${clean(f.label)} must be at most ${formatNumber(f.max, f.unit)}`});
    }
  }
  if (model) for (const p of model.validate(state.values) ?? []) if (!problems.some(x => x.field === p.field)) problems.push(p);
  return problems;
}

export const clean = (label: string) => String(label ?? '').replace(/\s+\/\s+.*$/, '').replace(/[:：]\s*$/, '').trim();

/** Params for a dialog without a model: each value field under its `param` (or id), nulls left out. */
export function genericParams(state: DialogState): Record<string, unknown> {
  const params: Record<string, unknown> = {...(state.args ?? {})};
  for (const f of allFields(state.spec)) {
    if (!hasValue(f) || !fieldVisible(f, state.values)) continue;
    const v = state.values[f.id];
    if (v === null || v === undefined || v === '') continue;
    params[typeof f.param === 'string' && f.param ? f.param : f.id] = v;
  }
  return params;
}

/** What OK runs: the model's toCommand(), or the spec's submit command with the generic params. */
export function submission(state: DialogState, model?: DialogModel | null): CommandCall | {batch: CommandCall[]} | null {
  if (model) {
    const out = model.toCommand(state.values);
    if (out && 'command' in out && state.args) return {command: out.command, params: {...state.args, ...(out.params ?? {})}};
    return out;
  }
  const command = state.spec.command;
  return command ? {command, params: genericParams(state)} : null;
}

/** Field ids whose values differ from the initial ones (Apply enables when anything changed). */
export function changedFields(state: DialogState): string[] {
  return Object.keys(state.values).filter(k => JSON.stringify(state.values[k]) !== JSON.stringify(state.initial[k]));
}

/** Which tab holds a field (errors switch to it). */
export function tabOf(state: DialogState, fieldId: string): number {
  const i = state.spec.tabs.findIndex(t => t.fields.some(f => f.id === fieldId));
  return i < 0 ? state.tab : i;
}

/** Bridge-facing snapshot of a dialog (`ui.dialog.get`, `ui.inspect`). */
export function snapshot(state: DialogState) {
  return {
    id: state.id, key: state.key, title: state.spec.title, tab: state.spec.tabs[state.tab]?.name ?? null, tabs: state.spec.tabs.map(t => t.name),
    values: state.values, errors: state.errors, message: state.message, pending: state.pending, busy: state.busy,
    buttons: state.spec.buttons.map(b => ({id: b.id, label: b.label, role: b.role})),
    fields: allFields(state.spec).map(f => ({id: f.id, label: clean(f.label), kind: f.kind, visible: fieldVisible(f, state.values)})),
  };
}

/** A built-in dialog spec (shell dialogs such as More Colors and message boxes have no spec entry). */
export function builtinSpec(id: string, title: string, fields: SpecField[], buttons: SpecDialog['buttons'] = [
  {id: 'ok', label: 'OK', role: 'ok', command: null}, {id: 'cancel', label: 'Cancel', role: 'cancel', command: null}]): SpecDialog {
  return {id, title, command: null, presentation: 'modal', tabs: [{name: '', fields}], buttons, relatedCommands: [], sourceRef: null};
}
