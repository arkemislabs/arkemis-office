// Mailings › Select Recipients › Type a New List… / Edit Recipient List: the Recipient List dialog,
// an editable table of the fields and records (Add Field, New Entry, × remove, Find in list, Show only
// records that will be merged), Use an Existing List…, and Filter and Sort. OK loads the list
// (mailings.recipients) and applies the filter and sort (mailings.filterRecipients).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/mailings.rs (`NEW_LIST_FIELDS`,
// `recipient_table`, `RecipientFilter` (`from_session`, `engine`, `params`), `visible_recipients`,
// `recipient_list`) and dialogs.rs (the `recipientList` / `newRecipientList` openers) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Drawn by src/apps/quill/dialogs/recipientList.tsx. Not here: Word's per-record check boxes, Find
// duplicates and Validate addresses (no upstream engine).

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf, selectRecords, rulesJson} from '../lib/mailings-merge.mjs';

/** The fields a new recipient list starts with (NEW_LIST_FIELDS). */
export const NEW_LIST_FIELDS = Object.freeze(['First Name', 'Last Name', 'Address', 'City', 'Postal Code']);

/** A typed recipient list ready for `mailings.recipients`: field names trimmed, blank rows dropped; an error says what to fix (recipient_table). */
export function recipientTable(fields, rows) {
  const f = fields.map(x => String(x).trim());
  if (!f.length) return {error: 'Add at least one field.'};
  if (f.some(x => x === '')) return {error: 'Every field needs a name.'};
  for (let i = 0; i < f.length; i++) if (f.slice(i + 1).some(g => g.toLowerCase() === f[i].toLowerCase())) return {error: 'Field names must be different.'};
  const kept = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (!kept.length) return {error: 'Type at least one recipient.'};
  return {fields: f, rows: kept};
}

/** The filter rules and sort keys on `fields` (a rule on a field renamed or removed in the table drops) (RecipientFilter::engine). */
export function engineFilter(v) {
  const names = (v.fields ?? []).map(x => String(x).trim().toLowerCase());
  const known = f => String(f ?? '').trim() !== '' && names.includes(String(f).trim().toLowerCase());
  const rules = (v.rules ?? []).filter(r => known(r.field)).map(r => ({field: r.field, op: r.op, value: r.value ?? '', or: !!r.or}));
  const sort = (v.sort ?? []).filter(k => known(k.field)).map(k => ({field: k.field, descending: !!k.descending}));
  return {rules, sort};
}

/** Each record's place in the merge (null: filtered out), or null when there is no filter or sort (merge_order). */
export function mergeOrder(v) {
  const {rules, sort} = engineFilter(v);
  if (!rules.length && !sort.length) return null;
  const order = (v.rows ?? []).map(() => null);
  selectRecords(v.fields ?? [], v.rows ?? [], rules, sort).forEach((i, n) => { order[i] = n + 1; });
  return order;
}

const norm = x => String(x ?? '').toLowerCase();
/** The grid's rows (real indices, in list order) matching `find` and, with `onlyMerged`, kept by the filter (visible_recipients). */
export function visibleRecipients(rows, order, find, onlyMerged) {
  const needle = norm(find).trim();
  return rows.map((r, i) => [r, i]).filter(([r, i]) => (!onlyMerged || !order || order[i] !== null) && (!needle || r.some(c => norm(c).includes(needle)))).map(([, i]) => i);
}

const blankSort = () => [0, 1, 2].map(() => ({field: '', descending: false}));

function initFor(ctx, fresh) {
  const m = mergeOf(ctx);
  if (!fresh && m.headers.length) {
    // Every record (not only the filtered ones), with the filter to edit.
    const sort = blankSort();
    m.sort.slice(0, 3).forEach((k, i) => { sort[i] = {field: k.field, descending: !!k.descending}; });
    const rules = rulesJson(m).map(r => ({field: r.field, op: r.op, value: r.value, or: r.join === 'or'}));
    return {fields: [...m.headers], rows: m.source.map(r => [...r]), rules, sort, filterOpen: rules.length > 0 || m.sort.length > 0, find: '', onlyMerged: false};
  }
  return {fields: [...NEW_LIST_FIELDS], rows: [NEW_LIST_FIELDS.map(() => '')], rules: [], sort: blankSort(), filterOpen: false, find: '', onlyMerged: false};
}

function make(id, fresh) {
  return defineDialog({
    id,
    title: 'Recipient List',
    command: 'mailings.recipients',
    init: ctx => initFor(ctx, fresh),
    validate(v) {
      const r = recipientTable(v.fields ?? [], v.rows ?? []);
      return r.error ? [{field: 'fields', message: r.error}] : [];
    },
    toCommand(v) {
      const t = recipientTable(v.fields, v.rows);
      const batch = [{command: 'mailings.recipients', params: {fields: t.fields, rows: t.rows}}];
      // A new list starts unfiltered; the dialog's filter and sort apply to it.
      const {rules, sort} = engineFilter({fields: t.fields, rules: v.rules, sort: v.sort});
      if (rules.length || sort.length) {
        batch.push({command: 'mailings.filterRecipients', params: {rules: rules.map(r => ({field: r.field, op: r.op, value: r.value, join: r.or ? 'or' : 'and'})), sort}});
      }
      return {batch};
    },
  });
}

export const recipientListDialog = make('dialog.recipientList', false);
export const newRecipientListDialog = make('dialog.newRecipientList', true);
export default recipientListDialog;
