// Language (Review > Language > Set Proofing Language...; submit: review.setLanguage).
// "Mark selected text as" a language, or "Do not check spelling or grammar".
import {defineDialog} from '../../kernel/dialog.mjs';
import {charRange, textRange} from '../lib/format-text.mjs';
import {languageAt} from '../commands/review.mjs';

export default defineDialog({
  id: 'dialog.language',
  title: 'Language',
  command: 'review.setLanguage',
  init(ctx) {
    const range = textRange(ctx);
    const r = range ? charRange(range) ?? range : null;
    const l = r ? languageAt(range.doc, r.from, r.to) : {name: 'English (United States)', doNotCheck: false};
    return {language: l.name, doNotCheck: l.doNotCheck};
  },
  validate: v => (v.language ? [] : [{field: 'language', message: 'Choose a language.'}]),
  toCommand: v => ({command: 'review.setLanguage', params: {language: v.language, doNotCheck: v.doNotCheck === true}}),
});
