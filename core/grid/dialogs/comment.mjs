// New Comment dialog model (submit: review.newComment).
// gridcraft's comment dialog (crates/ui-egui/src/dialogs.rs `comment`): the text box starts with the
// cell's existing comment, as Edit Comment does. Excel shows the card in the cell; upstream, a dialog.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: text.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.comment',
  title: 'New Comment',
  command: 'review.newComment',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const key = a1(sel.active.row, sel.active.col);
    return {text: content.sheets[sel.sheet].comments?.[key]?.text ?? ''};
  },
  validate: () => [],
  toCommand: v => ({command: 'review.newComment', params: {text: String(v.text ?? '')}}),
});
