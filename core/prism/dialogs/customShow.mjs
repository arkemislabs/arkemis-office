// Custom Shows dialog model (Slide Show › Custom Slide Show): the presentation's custom shows with Show,
// Edit, Copy and Remove, and a definition below them: the show's name, the slides in the presentation
// and the slides in the show (Add, Remove, Move Up, Move Down). Save runs show.customShow {name, slides};
// a renamed show is a delete of the old name and a create of the new one in one step.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_custom_show`: the list with Show and
// Delete, a name and the slide numbers, Create) at f893f6af7d36a5409fd804e81a34fd895cfefedf, with
// PowerPoint's Edit, Copy and slide lists in place of typed slide numbers. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The body is src/apps/prism/dialogs/customShow.tsx.
//
// Values: name, orig (the show being edited, or ''), chosen (0-based slide indices, in show order), existing (names).

import {defineDialog} from '../../kernel/dialog.mjs';

const cmd = (name, slides) => ({command: 'show.customShow', params: {name, slides}});

export default defineDialog({
  id: 'dialog.customShow',
  title: 'Custom Shows',
  command: 'show.customShow',
  init: ctx => ({name: `Custom Show ${(ctx.doc?.customShows ?? []).length + 1}`, orig: '', chosen: [], existing: (ctx.doc?.customShows ?? []).map(c => c.name)}),
  validate(v) {
    const name = String(v.name ?? '').trim();
    if (!name) return [{field: 'name', message: 'Give the slide show a name'}];
    if (name !== v.orig && (v.existing ?? []).includes(name)) return [{field: 'name', message: 'A custom show with that name already exists'}];
    if (!Array.isArray(v.chosen) || !v.chosen.length) return [{field: 'chosen', message: 'Add at least one slide to the show'}];
    return [];
  },
  toCommand(v) {
    const name = String(v.name).trim();
    const make = cmd(name, v.chosen);
    return v.orig && v.orig !== name ? {batch: [{command: 'show.customShow', params: {name: v.orig, delete: true}}, make]} : make;
  },
});
