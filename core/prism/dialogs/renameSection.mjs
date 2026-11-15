// Rename Section dialog model: Name: (the section of the current slide, as PowerPoint renames the
// section the selection is in); Rename runs section.rename.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_rename_section`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentSlideId} from '../model/doc.mjs';

/** The section holding the current slide: {index, name} (index -1 when the deck has no sections). */
export function currentSection(ctx) {
  const id = currentSlideId(ctx.doc, ctx.selection);
  const index = (ctx.doc?.sections ?? []).findIndex(s => s.slides.includes(id));
  return {index, name: index >= 0 ? ctx.doc.sections[index].name : ''};
}

export default defineDialog({
  id: 'dialog.renameSection',
  title: 'Rename Section',
  command: 'section.rename',
  init(ctx) {
    const sec = currentSection(ctx);
    return {index: sec.index, name: sec.name};
  },
  validate: v => (Number.isInteger(v.index) && v.index >= 0 ? [] : [{field: 'name', message: 'Add a section first (Home › Section › Add Section)'}]),
  toCommand: v => ({command: 'section.rename', params: {index: v.index, name: String(v.name ?? '')}}),
});
