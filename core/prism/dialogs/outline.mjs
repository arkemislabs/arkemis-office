// Slides from Outline dialog model (Home › New Slide › Slides from Outline…): paste or type an
// outline; unindented lines become slide titles, tab-indented lines bullets; Insert runs
// slide.fromOutline. (PowerPoint opens a file instead; deckcraft takes the text, and so do we.)
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_outline`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.outline',
  title: 'Slides from Outline',
  command: 'slide.fromOutline',
  init: () => ({text: '', hint: 'Paste or type an outline. Unindented lines become slide titles; tab-indented lines become bullets.'}),
  validate: v => (String(v.text ?? '').trim() ? [] : [{field: 'text', message: 'Type or paste an outline'}]),
  toCommand: v => ({command: 'slide.fromOutline', params: {text: String(v.text ?? '')}}),
});
