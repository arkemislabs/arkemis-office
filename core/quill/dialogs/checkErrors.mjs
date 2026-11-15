// Mailings › Preview Results › Check for Errors: the merge fields that are not in the recipient list,
// and how many recipients there are. Close closes.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`check_errors_dialog`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Not here: Word's choice of simulating or completing the merge (upstream checks the field names).

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf, mergeFields} from '../lib/mailings-merge.mjs';
import {Document} from '../model/document.mjs';

export default defineDialog({
  id: 'dialog.checkErrors',
  title: 'Checking and Reporting Errors',
  command: 'mailings.checkErrors',
  init(ctx) {
    const m = mergeOf(ctx);
    const unknown = mergeFields(new Document(ctx.doc)).filter(f => !m.headers.some(h => h.toLowerCase() === f.toLowerCase()));
    return {unknown, records: m.rows.length};
  },
  validate: () => [],
  toCommand: () => null,
});
