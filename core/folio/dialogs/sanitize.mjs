// Sanitize document confirmation (submit: redact.sanitize). Translated from printcraft
// crates/ui-egui/src/tools/redact_ui.rs (sanitize_body) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

const SAYS = 'Sanitizing removes hidden information from the document: metadata, file attachments, comments, form fields (flattened), hidden text and layers, bookmarks, links, actions and scripts, and private application data. Save the document afterwards; saving rewrites the whole file so nothing removed stays in it.';

export default defineDialog({
  id: 'dialog.sanitize',
  title: 'Sanitize document',
  command: 'redact.sanitize',
  init: () => ({message: 'Sanitize this document?', detail: SAYS}),
  validate: () => [],
  toCommand: () => ({command: 'redact.sanitize', params: {}}),
});
