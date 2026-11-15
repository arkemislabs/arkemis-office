// Spelling dialog model (Review > Spelling, F7; command review.spelling). Excel's dialog: the cell's text with the word it
// stopped on, Suggestions, Ignore Once, Ignore All, Add to Dictionary, Change, Change All, Undo Last and the dictionary language.
// Over gridcraft's crates/ui-egui/src/dialogs/spelling.rs (the misspelt word and its cell, Ignore, Add to Dictionary, Change,
// Change All) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The dialog body (src/apps/grid/dialogs/spelling.tsx) reads review.spelling again after every action and acts through commands, so
// it has no values of its own. AutoCorrect and Options are not drawn (this app has no AutoCorrect list or proofing options to open).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.spelling',
  title: 'Spelling',
  command: 'review.spelling',
  init: () => ({}),
  validate: () => [],
  toCommand: () => ({command: 'review.spelling', params: {}}),
});
