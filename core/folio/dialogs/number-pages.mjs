// Number pages (submit: page.number): Pages from..to (the selection), Style, Prefix, Start, the label
// preview, and Acrobat's Begin new section / Extend numbering used in the preceding section.
// Translated from printcraft crates/ui-egui/src/dialogs.rs:1364 (dialog_number_pages), state.rs
// NumberDraft and commands.rs:350-356 (the draft takes the selection's first and last page) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {targetPages} from '../commands/page.mjs';
import {previewPdfLabel} from '../../pdf-page-labels.mjs';

const STYLES = {'1, 2, 3': 'decimal', 'i, ii, iii': 'lower-roman', 'I, II, III': 'upper-roman', 'a, b, c': 'lower-alpha', 'A, B, C': 'upper-alpha', 'None (prefix only)': 'none'};
const CODES = {decimal: 'D', 'lower-roman': 'r', 'upper-roman': 'R', 'lower-alpha': 'a', 'upper-alpha': 'A', none: null};
let draft = null;

/** The first labels the style gives: the dialog's message (what the pages will read) and its detail. */
function labelsText(v) {
  const style = CODES[STYLES[v.style] ?? 'decimal'];
  const start = Math.max(1, Number(v.start) || 1);
  const labels = [0, 1, 2].map(k => `${v.prefix ?? ''}${style ? previewPdfLabel(style, start + k) : ''}`);
  return {message: `Labels: ${labels.join(', ')}…`, detail: 'Later pages keep their labels.'};
}

export default defineDialog({
  id: 'dialog.number-pages',
  title: 'Number pages',
  command: 'page.number',
  init(ctx) {
    const sel = targetPages(ctx);
    return {from: sel[0] + 1, to: sel[sel.length - 1] + 1, style: draft?.style ?? '1, 2, 3', prefix: draft?.prefix ?? '', start: draft?.start ?? 1,
      mode: 'Begin new section', __count: (ctx.doc?.pages ?? []).length, ...labelsText({style: draft?.style ?? '1, 2, 3', prefix: draft?.prefix ?? '', start: draft?.start ?? 1})};
  },
  validate(v) {
    const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
    if (!(Number.isInteger(a) && a >= 1 && a <= n)) return [{field: 'from', message: `Type a page number from 1 to ${n}`}];
    if (!(Number.isInteger(b) && b >= a && b <= n)) return [{field: 'to', message: `Type a page number from ${a} to ${n}`}];
    if (!(Number.isInteger(Number(v.start)) && Number(v.start) >= 1)) return [{field: 'start', message: 'Type a start number of 1 or more'}];
    return [];
  },
  derive: v => labelsText(v),
  toCommand(v) {
    draft = {style: v.style, prefix: v.prefix, start: v.start};
    return {command: 'page.number', params: {from: Number(v.from), to: Number(v.to), style: STYLES[v.style] ?? 'decimal', prefix: String(v.prefix ?? ''),
      start: Number(v.start) || 1, ...(v.mode && v.mode !== 'Begin new section' ? {extend: true} : {})}};
  },
});
