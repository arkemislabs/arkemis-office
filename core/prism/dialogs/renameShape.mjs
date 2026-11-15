// Rename (submit: shape.rename): the selected object's name, as the Selection Pane shows it.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (rename dialog, shape.rename
// {name, id}) at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape} from '../model/presentation.mjs';
import {currentSlideId, slideById, selectedShapeIds} from '../model/doc.mjs';

export default defineDialog({
  id: 'dialog.renameShape',
  title: 'Rename',
  command: 'shape.rename',
  init(ctx) {
    const c = ctx.doc;
    const sl = slideById(c, currentSlideId(c, ctx.selection));
    const id = selectedShapeIds(c, ctx.selection)[0] ?? null;
    const sh = sl && id ? findShape(sl.shapes, id) : null;
    return {name: sh?.name ?? '', id};
  },
  validate(v) { return String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Type a name.'}]; },
  toCommand(v) { return {command: 'shape.rename', params: {name: String(v.name).trim(), ...(v.id ? {id: v.id} : {})}}; },
});
