// Mailings › Finish & Merge › Edit Individual Documents…: which records to merge (All, Current record,
// or From and To by record number). OK runs mailings.finish; an empty range is reported by the command
// before anything is made.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`merge_records_dialog`) and
// dialogs.rs (`mergeRecords`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Print Documents is not offered (no printing).

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf, mergeRange} from '../lib/mailings-merge.mjs';

/** The mailings.finish params the dialog's choice stands for (null: the numbers aren't numbers). */
export function recordParams(v) {
  if (v.choice === 'current') return {records: 'current'};
  if (v.choice === 'range') {
    const [f, t] = [String(v.from ?? '').trim(), String(v.to ?? '').trim()];
    return /^\d+$/.test(f) && /^\d+$/.test(t) ? {from: Number(f), to: Number(t)} : null;
  }
  return {records: 'all'};
}

export default defineDialog({
  id: 'dialog.mergeRecords',
  title: 'Merge to New Document',
  command: 'mailings.finish',
  init: ctx => { const n = mergeOf(ctx).rows.length; return {choice: 'all', from: '1', to: String(n), count: n}; },
  validate(v) {
    const p = recordParams(v);
    if (!p) return [{field: 'from', message: 'Enter a number.'}];
    // An empty range is reported here, before the merge starts.
    try { mergeRange({rows: new Array(Number(v.count) || 0), record: 0}, p); } catch (e) { return [{field: 'from', message: e.message}]; }
    return [];
  },
  toCommand: v => ({command: 'mailings.finish', params: recordParams(v)}),
});
