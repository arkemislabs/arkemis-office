// Apply redactions confirmation (submit: redact.apply): "You are about to apply N redaction marks."
// Translated from printcraft crates/ui-egui/src/tools/redact_ui.rs (apply_body) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {marksOf} from '../lib/redact.mjs';

export default defineDialog({
  id: 'dialog.redact-apply',
  title: 'Apply redactions',
  command: 'redact.apply',
  init: () => ({}),
  validate: () => [],
  preview(ctx) {
    const n = marksOf(ctx.doc).length;
    return {text: `You are about to apply ${n} redaction mark${n === 1 ? '' : 's'}. Text, images and drawings under the marks, and comments and form fields that overlap them, are removed permanently. Save the document afterwards: saving rewrites the whole file so no trace of the removed content stays in it.`};
  },
  toCommand: () => ({command: 'redact.apply', params: {}}),
});
