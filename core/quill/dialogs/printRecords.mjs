// Mailings › Finish & Merge › Print Documents…: which records to merge to the printer (All, Current record, or From and To by record
// number). OK runs mailings.printDocuments, which merges into a new document and opens Print for it.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`merge_records_dialog` with `print`, dialogs.rs `printRecords`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf, mergeRange} from '../lib/mailings-merge.mjs';
import {recordParams} from './mergeRecords.mjs';

export default defineDialog({
  id: 'dialog.printRecords',
  title: 'Merge to Printer',
  command: 'mailings.printDocuments',
  init: ctx => { const n = mergeOf(ctx).rows.length; return {choice: 'all', from: '1', to: String(n), count: n}; },
  validate(v) {
    const p = recordParams(v);
    if (!p) return [{field: 'from', message: 'Enter a number.'}];
    try { mergeRange({rows: new Array(Number(v.count) || 0), record: 0}, p); } catch (e) { return [{field: 'from', message: e.message}]; }
    return [];
  },
  toCommand: v => ({command: 'mailings.printDocuments', params: recordParams(v)}),
});
