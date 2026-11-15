// Password Protection pane (Review > Section > Password; submit: none, it is a pane of buttons).
// OneNote's pane: the current section and whether it is protected, Set / Change / Remove Password
// (each its own dialog), Lock All, Notes on Passwords and Password Options. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {isLocked, isProtected} from '../lib/protect.mjs';

const NOTES = 'A password protects one section: its pages are encrypted in the notebook folder and cannot be read without the password. '
  + 'If you lose the password nobody can recover the section, so keep it somewhere safe. Locked sections are not searched or shown. '
  + 'Ctrl+Alt+L locks every protected section.';

export default defineDialog({
  id: 'dialog.password-protection',
  title: 'Password Protection',
  init(ctx) { return {sectionId: currentLocation(ctx.doc, ctx.selection).sectionId}; },
  validate: () => [],
  preview(ctx, v) {
    const s = v.sectionId ? ctx.doc.sections[v.sectionId] : null;
    const state = !s ? 'No section is open.' : isLocked(s) ? 'password protected and locked' : isProtected(s) ? 'password protected and unlocked' : 'not password protected';
    return {currentSection: s ? `${s.name}: ${state}` : state, notes: NOTES};
  },
  buttons: {lockAll: () => ({command: 'password.lockAll', params: {}})},
  toCommand: () => ({batch: []}),
});
