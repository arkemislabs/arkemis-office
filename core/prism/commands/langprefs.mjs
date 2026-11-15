// Review > Language > Language Preferences: the preferred editing language, kept per profile in the settings (`editingLanguage`).
// PowerPoint's behaviour, not checked against upstream (deckcraft has the Language dialog only): the languages are the local list the Language
// dialog offers; nothing is downloaded and no account is needed. The preferred language is the one the Language dialog starts on for text that has
// none (core/prism/dialogs/language.mjs); the spelling checker still has the US English dictionary only (core/common/lib/spelling.mjs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {bad, hasDoc, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {LANGUAGES, languageLabel} from '../lib/languages.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/dialogs/body.rs']};
export const preferredLanguage = ctx => (LANGUAGES.some(l => l.value === ctx?.prefs?.editingLanguage) ? ctx.prefs.editingLanguage : 'en-US');

export default defineCommands({
  family: 'langprefs',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'review.languagePreferences', label: 'Language Preferences', risk: 'read', effect: 'prefs', dialog: 'dialog.languagePreferences', state: hasDoc,
      description: '{language?: a language tag from the Language list (en-US, fr-FR…)} → {language, label}: Language Preferences: the preferred editing language, kept in the settings; without `language` it answers the current one. Not checked against upstream.',
      params: s.object({language: s.optional(s.string({max: 35}))}),
      run(ctx, p) {
        if (p.language === undefined) { const language = preferredLanguage(ctx); return {language, label: languageLabel(language)}; }
        if (!LANGUAGES.some(l => l.value === p.language)) throw bad('review.languagePreferences', `\`language\` is one of the Language list: ${LANGUAGES.slice(0, 4).map(l => l.value).join(', ')}…`);
        ctx.updatePrefs({editingLanguage: p.language});
        return {language: p.language, label: languageLabel(p.language)};
      },
    },
  ],
});
