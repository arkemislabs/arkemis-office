// Extract pages (submit: page.extract): Pages (typed ranges; empty takes the selection, shown as the
// hint), "N pages selected.", File name, Delete pages after extracting, Extract pages as separate
// files. Extract writes through the system Save dialog.
// Translated from printcraft crates/ui-egui/src/dialogs.rs:1031 (dialog_extract) and
// workflows/files.rs (ExtractDraft::pages_to_extract, the name) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {parseRanges, targetPages} from '../commands/page.mjs';
import {stem, isPlainFileName, fileStemFromUser} from '../lib/page-files.mjs';

/** combine_ui.rs `range_of`: pages as "1-3, 5" (1-based). */
export function rangeOf(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < sorted.length;) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > k ? `${sorted[k] + 1}-${sorted[j] + 1}` : `${sorted[k] + 1}`);
    k = j + 1;
  }
  return out.join(', ');
}
let draft = {delete: false, separate: false};

/** How many pages the ranges typed (or else the selection) take, as the read-only Selected value. */
function selectedText(v, doc) {
  let n = Number(v.__selected) || 0;
  try { if (String(v.pages ?? '').trim()) n = parseRanges(v.pages, Number(v.__count) || (doc?.pages ?? []).length).length; } catch { return 'Type page numbers and ranges such as 1-3, 5'; }
  return n === 1 ? '1 page selected.' : `${n} pages selected.`;
}

export default defineDialog({
  id: 'dialog.extract',
  title: 'Extract pages',
  command: 'page.extract',
  init(ctx) {
    const n = (ctx.doc?.pages ?? []).length;
    const sel = targetPages(ctx);
    return {pages: '', 'file-name': stem(ctx.doc?.sourceName || ctx.file?.title || 'Document'), delete: draft.delete, separate: draft.separate,
      __count: n, __hint: rangeOf(sel), __selected: sel.length, selected: selectedText({pages: '', __selected: sel.length}, ctx.doc)};
  },
  validate(v) {
    const out = [];
    if (String(v.pages ?? '').trim()) {
      try { if (!parseRanges(v.pages, Number(v.__count) || 1).length) out.push({field: 'pages', message: 'No pages to extract'}); }
      catch (e) { out.push({field: 'pages', message: e.message}); }
    }
    const name = fileStemFromUser(v['file-name']);
    if (name && !isPlainFileName(`${name}.pdf`)) out.push({field: 'file-name', message: 'Type a file name without a folder or the characters \\ / : * ? " < > |'});
    return out;
  },
  derive: v => ({selected: selectedText(v, null)}),
  toCommand(v) {
    draft = {delete: !!v.delete, separate: !!v.separate};
    return {command: 'page.extract', params: {...(String(v.pages ?? '').trim() ? {ranges: String(v.pages)} : {}),
      ...(fileStemFromUser(v['file-name']) ? {fileName: fileStemFromUser(v['file-name'])} : {}), delete: !!v.delete, separate: !!v.separate}};
  },
});
