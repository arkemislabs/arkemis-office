// New Note dialog model (submit: review.newNote).
// gridcraft's note dialog (crates/ui-egui/src/dialogs.rs, the comment arm with threaded false): the
// text starts with the cell's existing note. Excel edits a note in a box on the sheet.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: text.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.note',
  title: 'New Note',
  command: 'review.newNote',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    return {text: content.sheets[sel.sheet].notes?.[a1(sel.active.row, sel.active.col)]?.text ?? ''};
  },
  validate: () => [],
  toCommand: v => ({command: 'review.newNote', params: {text: String(v.text ?? '')}}),
});
