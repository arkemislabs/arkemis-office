// Output Preview (submit: standards.output_preview): src/apps/folio/dialogs/output-preview.tsx draws the inks, colour spaces and warnings it reads.
// Not checked against upstream (it has no Output Preview).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.output-preview',
  title: 'Output Preview',
  command: 'standards.output_preview',
  init: () => ({}),
  validate: () => [],
  toCommand: () => ({command: 'standards.output_preview', params: {}}),
});
