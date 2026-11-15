// Replace Font dialog model (Home › Editing › Replace › Replace Fonts…): Replace: a font the
// presentation uses (font.used), With: a font name (the field lists the installed families);
// Replace runs font.replace and the dialog stays open reporting “Replaced “a” with “b”.” (or
// “a” isn't used explicitly.), so several fonts can be replaced in a row; Close.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_replace_fonts`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {usedFonts, replaceFont} from '../commands/text.mjs';

export default defineDialog({
  id: 'dialog.replaceFonts',
  title: 'Replace Font',
  command: 'font.replace',
  init(ctx) {
    const used = usedFonts(ctx.doc);
    // A deck that names no font uses its theme's: Replace starts on the body font, With on the other one.
    const f = ctx.doc.masters?.[0]?.theme?.fonts;
    const theme = [f?.minor?.latin, f?.major?.latin].filter(x => typeof x === 'string' && x);
    const from = used[0] ?? theme[0] ?? '';
    return {from, to: [...used, ...theme].find(x => x !== from) ?? (from === 'Arial' ? 'Calibri' : 'Arial'), used, result: ''};
  },
  validate(v) {
    const out = [];
    if (!String(v.from ?? '')) out.push({field: 'from', message: 'Choose the font to replace'});
    if (!String(v.to ?? '').trim()) out.push({field: 'to', message: 'Type or choose the font to use'});
    return out;
  },
  buttons: {
    replace(ctx, v) {
      const from = String(v.from ?? ''), to = String(v.to ?? '').trim();
      if (!from || !to) return null;
      const n = replaceFont(ctx.doc, from, to).n;
      v.result = n ? `Replaced “${from}” with “${to}”.` : `“${from}” isn't used explicitly.`;
      return {command: 'font.replace', params: {from, to}};
    },
  },
  toCommand: v => ({command: 'font.replace', params: {from: String(v.from ?? ''), to: String(v.to ?? '').trim()}}),
});
