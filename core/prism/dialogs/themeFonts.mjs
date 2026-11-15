// Create New Theme Fonts (submit: design.fonts {name, major, minor}): the Heading and Body faces,
// a name, and a sample.
// Translated from deckcraft crates/ui-egui/src/dialogs/theme_fonts.rs and design/colors.rs
// (`font_dialog_params`, `next_font_scheme`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {masterIndexOf} from '../commands/design.mjs';
import {currentSlideId, slideById} from '../model/doc.mjs';

export default defineDialog({
  id: 'dialog.themeFonts',
  title: 'Create New Theme Fonts',
  command: 'design.fonts',
  init(ctx) {
    const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
    const f = ctx.doc.masters?.[masterIndexOf(ctx.doc, sl)]?.theme?.fonts;
    return {major: f?.major?.latin ?? 'Inter', minor: f?.minor?.latin ?? 'Inter', name: 'Custom'};
  },
  validate(v) {
    const out = [];
    if (!String(v.major ?? '').trim()) out.push({field: 'major', message: 'Choose the heading font'});
    if (!String(v.minor ?? '').trim()) out.push({field: 'minor', message: 'Choose the body font'});
    if (!String(v.name ?? '').trim()) out.push({field: 'name', message: 'Give the fonts a name'});
    return out;
  },
  preview: (_ctx, v) => ({font: String(v.major ?? ''), text: 'Heading'}),
  toCommand: v => ({command: 'design.fonts', params: {name: String(v.name).trim(), major: String(v.major).trim(), minor: String(v.minor).trim()}}),
});
