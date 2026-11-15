// Create New Theme Colors (submit: design.colors {name, colors}): the twelve theme colours as
// swatch + hex fields, a name, and a sample. Cancel keeps the theme.
// Translated from deckcraft crates/ui-egui/src/dialogs/theme_colors.rs and design/colors.rs
// (`scheme_dialog_params`, `next_scheme`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {THEME_SLOTS, schemeGet, css} from '../model/color.mjs';
import {masterIndexOf} from '../commands/design.mjs';
import {currentSlideId, slideById} from '../model/doc.mjs';

/** The field id of each stored slot (spec dialog.themeColors). */
export const COLOR_FIELDS = Object.freeze({dk1: 'text-background-dark-1', lt1: 'text-background-light-1', dk2: 'text-background-dark-2', lt2: 'text-background-light-2',
  hlink: 'hyperlink', folHlink: 'followed-hyperlink', accent1: 'accent-1', accent2: 'accent-2', accent3: 'accent-3', accent4: 'accent-4', accent5: 'accent-5', accent6: 'accent-6'});

const current = ctx => {
  const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
  return ctx.doc.masters?.[masterIndexOf(ctx.doc, sl)]?.theme?.colors ?? null;
};

export default defineDialog({
  id: 'dialog.themeColors',
  title: 'Create New Theme Colors',
  command: 'design.colors',
  init(ctx) {
    const sc = current(ctx);
    const out = {name: 'Custom'};
    for (const k of THEME_SLOTS) out[COLOR_FIELDS[k]] = sc ? css(schemeGet(sc, k)) : '#000000';
    return out;
  },
  validate(v) {
    const out = [];
    for (const k of THEME_SLOTS) if (!/^#[0-9a-f]{6}$/i.test(String(v[COLOR_FIELDS[k]] ?? ''))) out.push({field: COLOR_FIELDS[k], message: 'A colour like #RRGGBB'});
    if (!String(v.name ?? '').trim()) out.push({field: 'name', message: 'Give the colours a name'});
    return out;
  },
  preview: (_ctx, v) => ({bg: v[COLOR_FIELDS.lt1], bg2: v[COLOR_FIELDS.lt2], text: v[COLOR_FIELDS.dk1], text2: v[COLOR_FIELDS.dk2], hlink: v[COLOR_FIELDS.hlink], folHlink: v[COLOR_FIELDS.folHlink],
    accents: [1, 2, 3, 4, 5, 6].map(i => v[COLOR_FIELDS[`accent${i}`]])}),
  toCommand(v) {
    const colors = {};
    for (const k of THEME_SLOTS) colors[k] = String(v[COLOR_FIELDS[k]]).toLowerCase();
    return {command: 'design.colors', params: {name: String(v.name).trim(), colors}};
  },
});
