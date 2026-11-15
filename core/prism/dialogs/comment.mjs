// New Comment (submit: comment.add {text}): the comment text, posted to the current slide; the
// Comments pane then shows it.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_comment`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.comment',
  title: 'New Comment',
  command: 'comment.add',
  init: () => ({text: ''}),
  validate: v => (String(v.text ?? '').trim() ? [] : [{field: 'text', message: 'Type the comment'}]),
  toCommand: v => ({command: 'comment.add', params: {text: String(v.text)}}),
});
