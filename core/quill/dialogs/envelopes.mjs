// Mailings › Create › Envelopes: the delivery address (the selected text to start with), the return
// address (or Omit) and the envelope size. Add to Document puts the envelope at the start of this
// document as a section of its own; New Document makes it a document of its own
// (mailings.envelopes).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/print.rs (`EnvelopeForm`
// read / params, `envelopes_ui`, `envelope_label`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Drawn by
// src/apps/quill/dialogs/envelopes.tsx. Not here: Word's Labels tab (its own dialog, Mailings ›
// Labels), the Options… sub-dialog and electronic postage (no upstream engine); the size is chosen in
// the dialog as upstream has it, and there is no printing: New Document and Add to Document only.

import {defineDialog} from '../../kernel/dialog.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import {selectedText} from '../lib/references-lists.mjs';
import {ENVELOPE_SIZES, envelopeLabel} from '../lib/mailings-labels.mjs';

/** The selected text as an address: trimmed, one line break kind (EnvelopeForm::read). */
const addressOf = t => String(t ?? '').trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** `mailings.envelopes` params; `add` puts the envelope at the start of this document (EnvelopeForm::params). */
export function envelopeParams(v, add) {
  const size = ENVELOPE_SIZES[Number(v.size)]?.[0] ?? 'Envelope #10';
  return {delivery: String(v.delivery ?? ''), return: v.omit ? '' : String(v.ret ?? ''), size, add: !!add};
}

/** The sizes the form lists: [{value: index, label}] (envelope_label). */
export const sizeOptions = () => ENVELOPE_SIZES.map((e, i) => ({value: i, label: envelopeLabel(e)}));

const need = v => { if (!String(v.delivery ?? '').trim()) throw new CommandError('invalid_params', 'Type a delivery address.', {path: '/delivery'}); };

export default defineDialog({
  id: 'dialog.envelopes',
  title: 'Envelopes',
  command: 'mailings.envelopes',
  init(ctx) {
    const S = T.open(ctx);
    return {delivery: T.isCollapsed(S.sel) ? '' : addressOf(selectedText(S)), ret: '', omit: false, size: 0};
  },
  validate: v => (String(v.delivery ?? '').trim() ? [] : [{field: 'delivery', message: 'Type a delivery address.'}]),
  buttons: {
    newDocument: (_ctx, v) => { need(v); return {command: 'mailings.envelopes', params: envelopeParams(v, false), close: true}; },
  },
  toCommand: v => ({command: 'mailings.envelopes', params: envelopeParams(v, true)}),
});
