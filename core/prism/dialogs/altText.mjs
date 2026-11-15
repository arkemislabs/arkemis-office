// Alt Text (submit: shape.altText): the description and Mark as decorative, for the selected shapes.
// Translated from deckcraft crates/ui-egui/src/dialogs/alt_text.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's "Generate a description for me" is not offered (deckcraft has no description generator).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape} from '../model/presentation.mjs';
import {currentSlideId, slideById, selectedShapeIds} from '../model/doc.mjs';

export default defineDialog({
  id: 'dialog.altText',
  title: 'Alt Text',
  command: 'shape.altText',
  init(ctx) {
    const c = ctx.doc;
    const sl = slideById(c, currentSlideId(c, ctx.selection));
    const id = selectedShapeIds(c, ctx.selection)[0];
    const sh = sl && id ? findShape(sl.shapes, id) : null;
    return {text: sh?.descr ?? '', deco: !!sh?.decorative};
  },
  validate() { return []; },
  toCommand(v) { return {command: 'shape.altText', params: {text: String(v.text ?? ''), decorative: !!v.deco}}; },
});
