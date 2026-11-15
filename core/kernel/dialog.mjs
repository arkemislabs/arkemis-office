// defineDialog(): the pure dialog model (docs/architecture.md section 9.1, part 3).
// The spec declares the fields, an optional overlay the geometry, this model the behaviour.
// Types in dialog.d.mts. No DOM, no Node built-ins.

import {CommandError} from './errors.mjs';

/** File stem for a dialog id: "dialog.font" -> "font", "prompt.save-changes" -> "prompt.save-changes". */
export const dialogStem = id => String(id).replace(/^dialog\./, '');

export function validateDialog(d, {where = 'dialog module'} = {}) {
  const errors = [];
  const err = m => errors.push(`${where}: ${m}`);
  if (!d || typeof d !== 'object') { err('default export must be defineDialog({...})'); return errors; }
  if (typeof d.id !== 'string' || !/^[a-z][A-Za-z0-9]*\.[A-Za-z0-9._-]+$/.test(d.id)) err('`id` must look like "dialog.font"');
  if (typeof d.init !== 'function') err('`init(ctx)` is required');
  if (typeof d.validate !== 'function') err('`validate(values)` is required');
  if (typeof d.toCommand !== 'function') err('`toCommand(values)` is required');
  for (const k of ['derive', 'preview', 'titleFor']) if (d[k] !== undefined && typeof d[k] !== 'function') err(`\`${k}\` must be a function`);
  if (d.buttons !== undefined) {
    if (!d.buttons || typeof d.buttons !== 'object') err('`buttons` must map button ids to handlers');
    else for (const [k, v] of Object.entries(d.buttons)) if (typeof v !== 'function') err(`button ${k} must be a function`);
  }
  if (d.command !== undefined && typeof d.command !== 'string') err('`command` (the submit command id) must be a string');
  return errors;
}

export function defineDialog(d) {
  const errors = validateDialog(d, {where: `dialog ${d?.id ?? '?'}`});
  if (errors.length) throw new TypeError(errors.join('\n'));
  return Object.freeze({...d});
}

/** Initial values for a dialog against the session's active (or given) document. */
export function openDialogModel(session, docId, dialog) {
  return dialog.init(session.readContext(docId));
}

/** Apply a field change: merge, then let derive() fill dependent fields. */
export function changeDialogValues(dialog, values, field, value) {
  const next = {...values, [field]: value};
  if (typeof dialog.derive !== 'function') return next;
  return {...next, ...(dialog.derive(next, [field]) || {})};
}

/**
 * Submit: validate, map to a command (or a batch) and run it with origin 'dialog'.
 * Throws invalid_params with `data.fields` when validation fails.
 */
export async function submitDialog(session, docId, dialog, values, {origin = 'dialog', label, approval} = {}) {
  const problems = dialog.validate(values) || [];
  if (problems.length) {
    throw new CommandError('invalid_params', problems.map(p => p.message).join('; '), {fields: problems, path: `/${problems[0].field}`});
  }
  const out = dialog.toCommand(values);
  if (!out) throw new CommandError('failed', `${dialog.id} produced no command`);
  if (Array.isArray(out.batch)) {
    return session.batch(docId, out.batch, {origin, label: label || dialog.title || dialog.id, approval});
  }
  return session.execute(docId, out.command, out.params ?? {}, {origin, approval});
}

/** Run an in-dialog button (Set As Default, Tabs..., Apply) through its handler. */
export async function pressDialogButton(session, docId, dialog, button, values, opts = {}) {
  const handler = dialog.buttons?.[button];
  if (!handler) throw new CommandError('not_found', `${dialog.id} has no button ${button}`);
  const out = handler(session.readContext(docId), values);
  if (!out) return null;
  return session.execute(docId, out.command, out.params ?? {}, {origin: opts.origin || 'dialog'});
}
