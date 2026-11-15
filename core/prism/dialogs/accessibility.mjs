// Accessibility Checker: the issues of the deck, each with Go to (the body draws them from
// review.accessibility); Close closes it.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_accessibility`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.accessibility',
  title: 'Accessibility Checker',
  command: 'review.accessibility',
  init: () => ({}),
  validate: () => [],
  toCommand: () => ({command: 'review.accessibility', params: {}}),
});
