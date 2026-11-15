// Reuse Slides (submit: slide.reuse): the slides of another presentation as a checklist, "Keep source formatting".
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs `dlg_reuse_slides` at 4ce2944. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. PowerPoint uses a Reuse Slides pane with a search box and
// thumbnails; here the dialog body (src/apps/prism/dialogs/reuseSlides.tsx) browses for the file, lists its slides
// ("N  title", "(no title)" for none) and has Select All and Select None.
//
// Values: data (base64) and name of the browsed file, list ([{index, title, hidden}], filled by slide.reuseList), picked (indices), keep.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.reuseSlides',
  title: 'Reuse Slides',
  command: 'slide.reuse',
  init: () => ({data: '', name: '', list: [], picked: [], keep: false}),
  validate(v) {
    if (!v.data) return [{field: 'slides', message: 'Browse for the presentation to take slides from.'}];
    if (!Array.isArray(v.picked) || !v.picked.length) return [{field: 'slides', message: 'Check the slides to insert.'}];
    return [];
  },
  toCommand: v => ({command: 'slide.reuse', params: {data: v.data, name: v.name || 'presentation.pptx', slides: [...v.picked].sort((a, b) => a - b), keepFormatting: !!v.keep}}),
});
