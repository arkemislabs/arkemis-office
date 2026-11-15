// Preferences (submit: app.preferences): Identity (the name comments are made under), the secured-document notice, Fill & Sign text size.
// Translated from printcraft crates/ui-egui/src/dialogs.rs (Preferences) at 8f16855; the other preferences are not translated (see
// core/folio/commands/app_prefs.mjs). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {MIN_TEXT_SIZE, MAX_TEXT_SIZE, TEXT_SIZE} from '../lib/sign-fill.mjs';
import {identityName} from '../commands/app_prefs.mjs';

export default defineDialog({
  id: 'dialog.preferences',
  title: 'Preferences',
  command: 'app.preferences',
  init: ctx => ({name: identityName(ctx.prefs), secured: ctx.prefs?.hideSecuredNotice !== true, fillTextSize: ctx.prefs?.fillSign?.textSize ?? TEXT_SIZE}),
  validate(v) {
    const n = Number(v.fillTextSize);
    return n >= MIN_TEXT_SIZE && n <= MAX_TEXT_SIZE ? [] : [{field: 'fillTextSize', message: `Type a size from ${MIN_TEXT_SIZE} to ${MAX_TEXT_SIZE} pt`}];
  },
  toCommand: v => ({command: 'app.preferences', params: {name: String(v.name ?? ''), secured: v.secured === true, fillTextSize: Number(v.fillTextSize)}}),
});
