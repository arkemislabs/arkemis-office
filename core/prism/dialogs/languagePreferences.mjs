// Language Preferences (submit: review.languagePreferences): the preferred editing language. PowerPoint's Office language preferences, reduced to
// the one setting that works without a download: the language the Language dialog starts on for text that has none. Not checked against upstream.

import {defineDialog} from '../../kernel/dialog.mjs';
import {LANGUAGES} from '../lib/languages.mjs';
import {preferredLanguage} from '../commands/langprefs.mjs';

export default defineDialog({
  id: 'dialog.languagePreferences',
  title: 'Language Preferences',
  command: 'review.languagePreferences',
  init: ctx => ({language: preferredLanguage(ctx)}),
  validate: v => (LANGUAGES.some(l => l.value === v.language) ? [] : [{field: 'language', message: 'Choose a language'}]),
  toCommand: v => ({command: 'review.languagePreferences', params: {language: v.language}}),
});
