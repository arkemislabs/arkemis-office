// Review › Word Count (and the status bar's word count): Word's Word Count dialog — Statistics:
// Pages, Words, Characters (no spaces), Characters (with spaces), Paragraphs, Lines, and Include
// textboxes, footnotes and endnotes; Close. Counts the selection, else the document.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs:760 (`word_count` dialog over
// review.wordCount, crates/engine/src/cmd/review/proofing.rs `word_count`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {Document} from '../model/document.mjs';
import {isQuill2} from '../model/content.mjs';
import {layoutFor} from '../lib/caret-session.mjs';
import {wordCount} from '../lib/review-proofing.mjs';

const FIELDS = ['pages', 'words', 'characters', 'charactersWithSpaces', 'paragraphs', 'lines'];
const shown = c => Object.fromEntries(FIELDS.map(k => [k, Number(c[k] ?? 0).toLocaleString('en-US')]));

/** Both counts (with and without text boxes and notes), so the check box switches at once. */
export function countsOf(ctx) {
  if (!isQuill2(ctx?.doc)) return {false: {}, true: {}};
  const d = new Document(ctx.doc);
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  const sel = {anchor: d.clamp(r.anchor), focus: d.clamp(r.focus)};
  const lay = layoutFor(ctx, ctx.doc);
  return {false: wordCount(d, sel, lay, false), true: wordCount(d, sel, lay, true)};
}

export default defineDialog({
  id: 'dialog.wordCount',
  title: 'Word Count',
  command: 'review.wordCount',
  init(ctx) {
    const counts = countsOf(ctx);
    const inc = !!ctx.prefs?.countNotes;
    return {...shown(counts[inc]), includeTextBoxes: inc, _counts: counts};
  },
  derive(v, changed) {
    if (!changed.includes('includeTextBoxes') || !v._counts) return {};
    return shown(v._counts[!!v.includeTextBoxes]);
  },
  validate: () => [],
  toCommand: v => ({command: 'review.wordCount', params: {includeTextBoxes: !!v.includeTextBoxes}}),
});
