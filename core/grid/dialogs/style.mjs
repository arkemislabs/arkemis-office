// Style (Home > Cell Styles > New Cell Style...): the style's name and which parts of the active cell's
// formatting it includes (Number, Alignment, Font, Border, Fill, Protection), each with the formatting it
// would take. Submit: home.newCellStyle.
// Translated from gridcraft crates/engine/src/cmd/extra/cells.rs (`new_cell_style`: the active cell's style
// under a name) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Style dialog (Style Includes (By
// Example)). MIT, see assets/third-party-licenses/artcraft-reference.txt. Format... (changing the style's
// formatting from the dialog) is not translated; format the cell first, then make the style.

import {defineDialog} from '../../kernel/dialog.mjs';
import {activeStyle} from '../lib/format-ranges.mjs';
import {formatNameOf} from '../commands/format/number.mjs';

const ALIGN_H = {general: 'General', left: 'Left', center: 'Center', right: 'Right', fill: 'Fill', justify: 'Justify', centerAcross: 'Center Across Selection', distributed: 'Distributed'};
const ALIGN_V = {top: 'Top Aligned', center: 'Center Aligned', bottom: 'Bottom Aligned', justify: 'Justified', distributed: 'Distributed'};

/** What each part of a style holds, as Excel words it beside its check box. */
export function describe(st) {
  const sides = ['left', 'right', 'top', 'bottom'].filter(k => st.borders[k]);
  return {
    numFmt: formatNameOf(st.numFmt) === 'Custom' ? st.numFmt : formatNameOf(st.numFmt),
    align: `${ALIGN_H[st.align.h] ?? 'General'}, ${ALIGN_V[st.align.v] ?? 'Bottom Aligned'}${st.align.wrap ? ', Wrap Text' : ''}`,
    font: `${st.font.name} ${st.font.size}${st.font.bold ? ', Bold' : ''}${st.font.italic ? ', Italic' : ''}`,
    borders: sides.length ? `${sides.map(k => k[0].toUpperCase() + k.slice(1)).join(', ')} Border${sides.length > 1 ? 's' : ''}` : 'No Borders',
    fill: st.fill.pattern !== 'none' ? 'Shaded' : 'No Shading',
    protection: `${st.protection.locked ? 'Locked' : 'Unlocked'}${st.protection.hidden ? ', Hidden' : ''}`,
  };
}

export default defineDialog({
  id: 'dialog.style',
  title: 'Style',
  command: 'home.newCellStyle',
  init(ctx) {
    return {name: 'Style 1', numFmt: true, align: true, font: true, borders: true, fill: true, protection: true, descriptions: describe(activeStyle(ctx))};
  },
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Type a name for the style.'}]),
  toCommand: v => ({batch: [{command: 'home.newCellStyle', params: {name: String(v.name).trim(),
    includes: {numFmt: v.numFmt !== false, align: v.align !== false, font: v.font !== false, borders: v.borders !== false, fill: v.fill !== false, protection: v.protection !== false}}}]}),
});
