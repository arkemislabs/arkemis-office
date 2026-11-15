// Create New Theme Colors (Page Layout > Colors > Customize Colors…; submit: pageLayout.themeColors {colors, name}): Excel's twelve
// colour boxes in Excel's order and the name. gridcraft's theme_colors takes twelve hex colours (crates/engine/src/cmd/extra.rs) at fb1e59f;
// the dialog is Excel's. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {DEFAULT_THEME} from '../model/style.mjs';

/** The boxes in Excel's order, and the theme slot each one sets (slots run lt1 dk1 lt2 dk2 accent1-6 hlink folHlink). */
export const COLOR_BOXES = Object.freeze([
  ['Text/Background - Dark 1', 1], ['Text/Background - Light 1', 0], ['Text/Background - Dark 2', 3], ['Text/Background - Light 2', 2],
  ['Accent 1', 4], ['Accent 2', 5], ['Accent 3', 6], ['Accent 4', 7], ['Accent 5', 8], ['Accent 6', 9], ['Hyperlink', 10], ['Followed Hyperlink', 11],
]);
const hex = n => '#' + Number(n).toString(16).padStart(6, '0').toUpperCase();

export default defineDialog({
  id: 'dialog.createThemeColors',
  title: 'Create New Theme Colors',
  command: 'pageLayout.themeColors',
  init(ctx) {
    const colors = (ctx.doc.theme ?? DEFAULT_THEME).colors ?? DEFAULT_THEME.colors;
    return {...Object.fromEntries(COLOR_BOXES.map(([, slot], i) => [`color${i}`, hex(colors[slot])])), name: 'Custom 1'};
  },
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Give the new theme colors a name.'}]),
  toCommand(v) {
    const colors = Array(12).fill('#000000');
    COLOR_BOXES.forEach(([, slot], i) => { colors[slot] = /^#[0-9a-f]{6}$/i.test(String(v[`color${i}`])) ? v[`color${i}`] : '#000000'; });
    return {command: 'pageLayout.themeColors', params: {colors, name: String(v.name).trim()}};
  },
});
