// Review › Compare › Compare… / Combine…: Word's Compare Documents dialog — Original document
// (this document), Revised document (Browse…), Label changes with, More >> Comparison settings
// (the comparison options), Show changes at Word / Character level, Show changes in. OK runs
// review.compare (or review.combine) with the revised document's bytes.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_review.rs (`CompareForm`,
// `COMPARE_SETTINGS`, `compare_dialog`, `CompareForm::params`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The Original document is always this one (the Original's Browse… needs a second open file the
// session can't hold); the Revised document is picked with the system Open dialog
// (src/apps/quill/dialogs/compare.tsx) and only its bytes are passed on. Show changes in: the
// result goes into this document (Original document); a separate result window is not offered.

import {defineDialog} from '../../kernel/dialog.mjs';
import {author} from '../lib/caret-session.mjs';

/** Comparison settings (More >>): [param, label], as Word lists them (COMPARE_SETTINGS). */
export const COMPARE_SETTINGS = Object.freeze([
  ['insertions', 'Insertions and deletions'], ['moves', 'Moves'], ['comments', 'Comments'], ['formatting', 'Formatting'], ['caseChanges', 'Case changes'],
  ['whiteSpace', 'White space'], ['tables', 'Tables'], ['headersFooters', 'Headers and footers'], ['footnotes', 'Footnotes and endnotes'],
  ['textBoxes', 'Text boxes'], ['fields', 'Fields'],
]);

export function compareParams(v) {
  const p = {};
  if (typeof v.revisedData === 'string' && v.revisedData) { p.data = v.revisedData; if (v.revisedFormat) p.format = String(v.revisedFormat); }
  else if (typeof v.revisedText === 'string' && v.revisedText) p.text = v.revisedText;
  if (typeof v.label === 'string' && v.label.trim()) p.author = v.label.trim();
  const on = new Set(Array.isArray(v.settings) ? v.settings : []);
  for (const [k] of COMPARE_SETTINGS) if (k !== 'insertions') p[k] = on.has(k);
  p.level = v.level === 'character' ? 'character' : 'word';
  p.showIn = 'original';
  return p;
}

export default defineDialog({
  id: 'dialog.compare',
  title: 'Compare Documents',
  command: 'review.compare',
  init: ctx => ({original: 'this', revised: '', revisedData: '', revisedFormat: '', revisedText: '', label: author(ctx.prefs),
    settings: COMPARE_SETTINGS.map(([k]) => k), level: 'word', showIn: 'original'}),
  validate(v) {
    if (!(v.revisedData || v.revisedText)) return [{field: 'revised', message: 'Choose the revised document (Browse…).'}];
    return [];
  },
  toCommand: v => ({command: 'review.compare', params: compareParams(v)}),
});
