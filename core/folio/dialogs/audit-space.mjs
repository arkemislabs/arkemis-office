// Space Audit (submit: optimize.audit): the table of what the file's bytes are spent on (src/apps/folio/dialogs/audit-space.tsx draws it from the command's rows).
// Translated from printcraft crates/ui-egui/src/workflows/optimize_ui.rs `audit_body` at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.audit-space',
  title: 'Space Audit',
  command: 'optimize.audit',
  init: () => ({}),
  validate: () => [],
  toCommand: () => ({command: 'optimize.audit', params: {}}),
});
