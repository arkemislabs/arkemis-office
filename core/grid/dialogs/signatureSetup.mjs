// Signature Setup (submit: insert.signatureLine): Excel's dialog for a signature line, the suggested signer, the signer's title and
// e-mail, instructions for the signer, whether the signer may add comments and whether the sign date shows. Not checked against
// upstream (gridcraft has no signature lines).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.signatureSetup',
  title: 'Signature Setup',
  command: 'insert.signatureLine',
  validate: () => [],
  init: () => ({signer: '', title: '', email: '', instructions: '', comments: false, showDate: true}),
  toCommand: v => ({command: 'insert.signatureLine', params: {signer: String(v.signer ?? ''), title: String(v.title ?? ''), email: String(v.email ?? ''), instructions: String(v.instructions ?? ''), comments: v.comments === true, showDate: v.showDate !== false}}),
});
