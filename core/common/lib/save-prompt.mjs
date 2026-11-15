// The "Do you want to save changes?" message box every app shows when a modified document closes
// (section 9.4: message boxes are registered dialogs, so the bridge can see and answer them).
// Upstream: wordcraft crates/ui-egui/src/dialogs/dispatch.rs (saveChanges), gridcraft
// crates/ui-egui/src/dialogs/show.rs (saveChanges), deckcraft crates/ui-egui/src/dialogs/body.rs
// (close), printcraft crates/ui-egui/src/dialogs/prompts.rs (save-changes).
//
// Save -> file.close {save: true}; Don't Save -> file.close {force: true}; Cancel closes the box.

import {defineDialog} from '../../kernel/dialog.mjs';

export function savePrompt(id, title) {
  return defineDialog({
    id,
    title,
    command: 'file.close',
    init(ctx) {
      const name = ctx.file?.title ?? 'this document';
      return {name, message: `Do you want to save the changes you made to “${name}”?`, detail: "Your changes will be lost if you don't save them."};
    },
    validate: () => [],
    buttons: {
      save: () => ({command: 'file.close', params: {save: true}}),
      'dont-save': () => ({command: 'file.close', params: {force: true}}),
    },
    toCommand: () => ({command: 'file.close', params: {save: true}}),
  });
}
