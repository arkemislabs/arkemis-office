// PDF/A (submit: standards.pdfa.verify): the level, Verify and Save as PDF/A (src/apps/folio/dialogs/pdfa.tsx draws the body and runs them).
// Translated from printcraft crates/ui-egui/src/dialogs/standards_ui.rs at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt): upstream offers
// PDF/A-2b and PDF/A-3b.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.pdfa',
  title: 'PDF/A',
  command: 'standards.pdfa.verify',
  init: () => ({level: 'PDF/A-2b'}),
  validate: () => [],
  toCommand: v => ({command: 'standards.pdfa.verify', params: {level: v.level === 'PDF/A-3b' ? 'PDF/A-3b' : 'PDF/A-2b'}}),
});
