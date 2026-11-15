// Mailings › Preview Results › Find Recipient: the text to find in the recipients' fields (any case);
// Find previews the first record that has it (mailings.findRecipient), or says there is none.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`find_recipient_dialog`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Not here: Word's Look in All fields / This field (upstream searches every field).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.findRecipient',
  title: 'Find Recipient',
  command: 'mailings.findRecipient',
  init: () => ({text: ''}),
  validate: v => (String(v.text ?? '').trim() ? [] : [{field: 'text', message: 'Type what to find.'}]),
  toCommand: v => ({command: 'mailings.findRecipient', params: {text: String(v.text).trim()}}),
});
