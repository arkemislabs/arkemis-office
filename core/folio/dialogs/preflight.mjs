// Preflight (submit: standards.preflight): the profile (src/apps/folio/dialogs/preflight.tsx draws the body and runs the analysis). A control may open it with a
// profile (`args.profile`: Check PDF/UA and Check PDF/X open it on theirs). Not checked against upstream except the two PDF/A profiles.

import {defineDialog} from '../../kernel/dialog.mjs';

const PROFILES = ['pdfa-2b', 'pdfa-3b', 'pdfua-1', 'pdfx-4', 'fonts', 'colour'];

export default defineDialog({
  id: 'dialog.preflight',
  title: 'Preflight',
  command: 'standards.preflight',
  init: (_ctx, args) => ({profile: PROFILES.includes(args?.profile) ? args.profile : 'pdfa-2b'}),
  validate: () => [],
  toCommand: v => ({command: 'standards.preflight', params: {profile: PROFILES.includes(v.profile) ? v.profile : 'pdfa-2b'}}),
});
