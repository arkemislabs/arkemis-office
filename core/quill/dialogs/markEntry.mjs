// References › Index › Mark Entry (Alt+Shift+X; Mark Index Entry). Mark marks the selection, Mark
// All every paragraph's first whole-word match. Translated from wordcraft crates/ui-egui/src/dialogs/
// dialogs_refs/index.rs (`MarkForm` read/params, `mark_entry_ui`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {selectedText} from '../lib/references-lists.mjs';

/** references.markEntry parameters (MarkForm::params). */
export function markParams(v, all = false) {
  const p = {entry: String(v.entry ?? '').trim()};
  if (String(v.subentry ?? '').trim()) p.subentry = String(v.subentry).trim();
  if (v.option === 'see' && String(v.crossReference ?? '').trim()) p.crossReference = String(v.crossReference).trim();
  if (v.option === 'range' && v.bookmark) p.bookmark = v.bookmark;
  if (v.bold) p.bold = true;
  if (v.italic) p.italic = true;
  if (all) { p.all = true; p.text = p.entry; }
  return p;
}

export default defineDialog({
  id: 'dialog.markEntry',
  title: 'Mark Index Entry',
  command: 'references.markEntry',
  init(ctx) {
    const S = T.open(ctx);
    const text = selectedText(S).trim().split('\n')[0] ?? '';
    return {entry: text, subentry: '', option: 'page', crossReference: 'See ', bookmark: null,
      bookmarks: S.d.bookmarks().map(([n]) => n).filter(n => !n.startsWith('_')), bold: false, italic: false};
  },
  validate: v => (String(v.entry ?? '').trim() ? [] : [{field: 'entry', message: 'Type the main entry.'}]),
  buttons: {markAll: (_ctx, v) => (String(v.entry ?? '').trim() ? {command: 'references.markEntry', params: markParams(v, true)} : null)},
  toCommand: v => ({command: 'references.markEntry', params: markParams(v)}),
});
