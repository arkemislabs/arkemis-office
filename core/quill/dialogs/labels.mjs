// Mailings › Create › Labels: the address (the selected text to start with) or one label per
// recipient, the label product, and a full page of the same label or a single label at a row and
// column. New Document makes the sheet of labels (mailings.labels).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/print.rs (`LabelsForm` read /
// params, `product_label`, `labels_ui`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Drawn by src/apps/quill/dialogs/labels.tsx. Not
// here: Word's Envelopes tab (its own dialog, Mailings › Envelopes), the Options… sub-dialog with
// vendors and product numbers, and Use return address (upstream lists its own sheets by size); there
// is no printing, only New Document.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {selectedText} from '../lib/references-lists.mjs';
import {mergeOf} from '../lib/mailings-merge.mjs';
import {LABEL_PRODUCTS, productLabel} from '../lib/mailings-labels.mjs';

/** `mailings.labels` params (LabelsForm::params). */
export function labelParams(v) {
  const p = {text: String(v.text ?? ''), product: LABEL_PRODUCTS[Number(v.product)]?.id ?? 'letter-3x10', fromRecipients: !!v.recipients && !v.single};
  if (v.single) p.single = {row: Number(v.row) || 1, col: Number(v.col) || 1};
  return p;
}

/** The products the form lists: [{value: index, label}] (product_label). */
export const productOptions = () => LABEL_PRODUCTS.map((p, i) => ({value: i, label: productLabel(p)}));

export default defineDialog({
  id: 'dialog.labels',
  title: 'Labels',
  command: 'mailings.labels',
  init(ctx) {
    const S = T.open(ctx);
    const hasRecipients = mergeOf(ctx).rows.length > 0;
    const sel = T.isCollapsed(S.sel) ? '' : selectedText(S).trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return {text: sel, product: 0, single: false, row: 1, col: 1, recipients: hasRecipients, hasRecipients};
  },
  derive(v, changed) {
    // The row and column stay on the sheet (LabelsForm clamps them to the product).
    const p = LABEL_PRODUCTS[Number(v.product)] ?? LABEL_PRODUCTS[0];
    const out = {};
    if (changed.includes('product') || changed.includes('row') || changed.includes('col')) {
      out.row = Math.min(p.rows, Math.max(1, Number(v.row) || 1));
      out.col = Math.min(p.cols, Math.max(1, Number(v.col) || 1));
    }
    return out;
  },
  validate(v) {
    const ready = (v.hasRecipients && v.recipients && !v.single) || String(v.text ?? '').trim() !== '';
    return ready ? [] : [{field: 'text', message: 'Type an address.'}];
  },
  toCommand: v => ({command: 'mailings.labels', params: labelParams(v)}),
});
