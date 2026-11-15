// Find text and redact (submit: redact.search): a single word or phrase, a list of them, or a pattern
// (phone numbers, email addresses, credit card numbers, social security numbers, dates); every match is marked.
// Translated from printcraft crates/ui-egui/src/tools/redact_ui.rs (SearchDraft, SearchMode, search_body,
// redact_search) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {wordList} from '../lib/redact-patterns.mjs';

const MODES = ['Single word or phrase', 'Multiple words or phrases', 'Patterns'];

/** What the search does, as the read-only Note value. */
function noteText(v) {
  if (v.mode === MODES[1]) return `${wordList(v.words).length} word(s) or phrase(s). Text in images is not found: recognise text (OCR) first.`;
  return 'Every match is marked for redaction. Text in images is not found: recognise text (OCR) first.';
}

export default defineDialog({
  id: 'dialog.redact-search',
  title: 'Find text and redact',
  command: 'redact.search',
  init() { const v = {mode: MODES[0], text: '', words: '', whole: false, case: false, pattern: 'Phone Numbers'}; return {...v, result: noteText(v)}; },
  derive: v => ({result: noteText(v)}),
  validate(v) {
    if (v.mode === MODES[0] && !String(v.text ?? '').trim()) return [{field: 'text', message: 'Type the text to find'}];
    if (v.mode === MODES[1] && !wordList(v.words).length) return [{field: 'words', message: 'Type a word or phrase on each line'}];
    return [];
  },
  toCommand(v) {
    const base = {mode: v.mode, wholeWords: !!v.whole, caseSensitive: !!v.case};
    if (v.mode === MODES[0]) return {command: 'redact.search', params: {...base, text: v.text}};
    if (v.mode === MODES[1]) return {command: 'redact.search', params: {...base, words: v.words}};
    return {command: 'redact.search', params: {mode: v.mode, pattern: v.pattern}};
  },
});
