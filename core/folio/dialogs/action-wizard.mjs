// Action Wizard (submit: actions.run): the action chosen (a control may open it on one: `args.action`); src/apps/folio/dialogs/action-wizard.tsx draws the list of actions, the
// steps, New Action, Edit, Delete and runs the action. Translated from printcraft crates/ui-egui/src/workflows/actions_ui.rs at 8f16855 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt); the actions run on the open document (commands/actions.mjs says why).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.action-wizard',
  title: 'Action Wizard',
  command: 'actions.run',
  init: (_ctx, args) => ({action: typeof args?.action === 'string' ? args.action : ''}),
  validate: v => (String(v.action ?? '').trim() ? [] : [{field: 'action', message: 'Choose an action'}]),
  toCommand: v => ({command: 'actions.run', params: {action: String(v.action)}}),
});
