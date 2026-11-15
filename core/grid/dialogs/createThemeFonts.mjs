// Create New Theme Fonts (Page Layout > Fonts > Customize Fonts…; submit: pageLayout.themeFonts {major, minor}): Excel's Heading font
// and Body font and the name. gridcraft's theme_fonts takes {major, minor} (crates/engine/src/cmd/extra.rs) at fb1e59f; the dialog is
// Excel's. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {DEFAULT_THEME} from '../model/style.mjs';

export default defineDialog({
  id: 'dialog.createThemeFonts',
  title: 'Create New Theme Fonts',
  command: 'pageLayout.themeFonts',
  init(ctx) {
    const t = ctx.doc.theme ?? DEFAULT_THEME;
    return {headingFont: t.majorFont ?? DEFAULT_THEME.majorFont, bodyFont: t.minorFont ?? DEFAULT_THEME.minorFont, name: 'Custom 1'};
  },
  validate: v => [...(String(v.headingFont ?? '').trim() ? [] : [{field: 'headingFont', message: 'Choose a heading font.'}]), ...(String(v.bodyFont ?? '').trim() ? [] : [{field: 'bodyFont', message: 'Choose a body font.'}])],
  toCommand: v => ({command: 'pageLayout.themeFonts', params: {major: String(v.headingFont).trim(), minor: String(v.bodyFont).trim()}}),
});
