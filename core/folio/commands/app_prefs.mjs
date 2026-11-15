// Preferences and Keyboard shortcuts.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/chrome.rs:290,309      the tab strip's Preferences (Ctrl+,) and Keyboard shortcuts buttons
//   crates/ui-egui/src/dialogs.rs (Preferences, Shortcuts)   Preferences > Identity (the name comments are made under), the notices, Fill & Sign;
//                                              Help > Keyboard shortcuts lists every key and what it does
// The preferences this window has are the ones its commands read: the name comments and replies are made under (`prefs.identity.name`, what
// printcraft's Identity sets), whether the secured-document notice shows (the notice bar's Don't show again turns it off here), and the size of
// Fill & Sign text (`prefs.fillSign.textSize`). Not translated: the interface language, size, tools-panel side, title bar, animation, theme and the
// default view (page display, zoom, units), which this shell does not offer or does not read from preferences (docs/spec/patches/folio/tools.json).
// The shortcut list is drawn by src/apps/folio/dialogs/shortcuts.tsx from the spec's shortcuts.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/app-prefs.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {MIN_TEXT_SIZE, MAX_TEXT_SIZE, TEXT_SIZE} from '../lib/sign-fill.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/chrome.rs', 'crates/ui-egui/src/dialogs.rs']};

export const identityName = prefs => String(prefs?.identity?.name ?? prefs?.author ?? '');

export default defineCommands({
  family: 'app_prefs',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'app.preferences', label: 'Preferences…', risk: 'edit', effect: 'prefs', scope: 'app', dialog: 'dialog.preferences',
      description: 'Preferences: `name` the comments and replies are made under (Identity), `secured` whether the secured-document notice shows, `fillTextSize` the size of Fill & Sign text (4 to 300 pt). Without parameters it reports them (the window opens the dialog).',
      params: s.object({name: s.optional(s.string({max: 120})), secured: s.optional(s.boolean()), fillTextSize: s.optional(s.number({min: MIN_TEXT_SIZE, max: MAX_TEXT_SIZE}))}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const patch = {};
        if (p.name !== undefined) patch.identity = {...(ctx.prefs?.identity ?? {}), name: p.name.trim()};
        if (p.secured !== undefined) patch.hideSecuredNotice = !p.secured;
        if (p.fillTextSize !== undefined) patch.fillSign = {...(ctx.prefs?.fillSign ?? {}), textSize: p.fillTextSize};
        if (Object.keys(patch).length) ctx.updatePrefs(patch);
        const prefs = {...ctx.prefs, ...patch};
        return {name: identityName(prefs), secured: prefs.hideSecuredNotice !== true, fillTextSize: prefs.fillSign?.textSize ?? TEXT_SIZE};
      },
    },
    {
      id: 'help.shortcuts', label: 'Keyboard shortcuts', risk: 'read', effect: 'view', undo: 'none', dialog: 'dialog.shortcuts',
      description: 'Show the keyboard shortcuts: every key and the command it runs (the window opens the list).',
      params: s.object({}),
      state: () => ({enabled: true}),
      run() { return {shown: 'shortcuts'}; },
    },
  ],
});
