// Keyboard shortcuts (opened by help.shortcuts): the list of keys is drawn from the spec's shortcuts by src/apps/folio/dialogs/shortcuts.tsx.
// Translated from printcraft crates/ui-egui/src/dialogs.rs (Help > Keyboard shortcuts) at 8f16855. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.shortcuts',
  title: 'Keyboard shortcuts',
  command: 'help.shortcuts',
  init: () => ({list: null}),
  validate: () => [],
  toCommand: () => ({command: 'help.shortcuts', params: {}}),
});
