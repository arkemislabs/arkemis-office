// The prompt PowerPoint asks when the slide size changes (Standard 4:3, Widescreen 16:9): Maximize
// makes the content as large as the new size allows, Ensure Fit scales it down so it fits. The size
// the menu chose comes with the opener (`preset`).
// deckcraft: design.slideSize's `scale` (maximize | ensureFit) and the Slide Size dialog's Maximize
// check box (crates/ui-egui/src/dialogs/body.rs `dlg_slide_size`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.scaleContent',
  title: 'Microsoft PowerPoint',
  command: 'design.slideSize',
  init: () => ({scale: 'ensureFit'}),
  validate: v => (['maximize', 'ensureFit'].includes(v.scale) ? [] : [{field: 'scale', message: 'Choose Maximize or Ensure Fit'}]),
  toCommand: v => ({command: 'design.slideSize', params: {scale: v.scale}}),
});
