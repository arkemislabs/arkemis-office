// Check Accessibility dialog model (command review.checkAccessibility): the issues found. gridcraft shows the
// command's JSON in a monospaced box (crates/ui-egui/src/dialogs/show.rs); the body
// (src/apps/grid/dialogs/accessibility.tsx) lists them as Excel's Accessibility Checker does. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Values: result (the issues).

import {defineDialog} from '../../kernel/dialog.mjs';
import {accessibility} from '../commands/review.mjs';

export default defineDialog({
  id: 'dialog.accessibility',
  title: 'Accessibility',
  command: 'review.checkAccessibility',
  init: ctx => ({result: accessibility(ctx)}),
  validate: () => [],
  toCommand: () => ({command: 'review.checkAccessibility', params: {}}),
});
