// Paste Special dialog model (submit: edit.pasteSpecial): As: Use Destination Theme, Keep Source
// Formatting, Keep Text Only, with PowerPoint's Result line describing the choice. Keep Source
// Formatting needs copied shapes (deckcraft disables it otherwise).
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_paste_special`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Picture (PNG) draws the copied shapes into a picture with deckcraft's renderer (render_shape),
// which has no translation in core yet, so that choice is not offered (docs/spec/patches/prism/edit.json).

import {defineDialog} from '../../kernel/dialog.mjs';

export const AS_OPTIONS = Object.freeze(['destinationTheme', 'keepSource', 'text']);
export const RESULT = Object.freeze({
  destinationTheme: 'Pastes the contents of the Clipboard into your presentation using the destination theme.',
  keepSource: 'Pastes the contents of the Clipboard into your presentation, keeping the formatting of the source.',
  text: 'Pastes the contents of the Clipboard into your presentation as text only.',
});

const hasShapes = ctx => ctx.clipboard?.app === 'prism' && ctx.clipboard.kind === 'prism.shapes';

export default defineDialog({
  id: 'dialog.pasteSpecial',
  title: 'Paste Special',
  command: 'edit.pasteSpecial',
  init: ctx => ({as: 'destinationTheme', result: RESULT.destinationTheme, shapes: hasShapes(ctx)}),
  derive: (v, changed) => (changed.includes('as') ? {result: RESULT[v.as] ?? ''} : {}),
  validate(v) {
    if (!AS_OPTIONS.includes(v.as)) return [{field: 'as', message: 'Choose how to paste'}];
    if (v.as === 'keepSource' && v.shapes === false) return [{field: 'as', message: 'Keep Source Formatting pastes copied shapes: copy shapes first'}];
    return [];
  },
  toCommand: v => ({command: 'edit.pasteSpecial', params: {as: v.as}}),
});
