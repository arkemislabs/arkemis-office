// Go To dialog model (submit: edit.goTo with record: true).
// Translated from gridcraft crates/ui-egui/src/dialogs/find.rs (`go_to_entries`, `go_to`: the
// names of every sheet then the recent references, Reference, Special… opens Go To Special) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection} from '../model/workbook.mjs';
import {goToNames} from '../lib/edit-goto.mjs';

/** go_to_entries: named ranges of every sheet, then the references gone to before, newest first. */
export function goToEntries(ctx) {
  const sel = fromKernelSelection(ctx.doc, ctx.selection);
  return [...goToNames(ctx.doc, sel.sheet), ...(ctx.view?.goToRecent ?? [])];
}

export default defineDialog({
  id: 'dialog.goTo',
  title: 'Go To',
  command: 'edit.goTo',
  init: ctx => ({entries: goToEntries(ctx), reference: ''}),
  validate: v => (String(v.reference ?? '').trim() ? [] : [{field: 'reference', message: 'Type a reference or pick a name'}]),
  toCommand: v => ({command: 'edit.goTo', params: {reference: String(v.reference).trim(), record: true}}),
});
