// Format Cells as a conditional-format rule asks for it (New Formatting Rule > Format..., Custom Format... in
// the Highlight Cells dialogs): Number, Font, Border and Fill pages with nothing set, collected as the
// rule's differential format.
// Translated from gridcraft crates/ui-egui/src/dialogs/format_cells.rs (the same pages and settings) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's conditional Format Cells (no Alignment or Protection
// page; Font has Font style, Underline, Color and Strikethrough only). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The dialog is opened by the rule dialogs to gather values (`collectDialog`); its values become `dxf`
// ({font?, fill?, borders?, numFmt?}) through `dxfFromValues`, and a rule's `dxf` fills it through `valuesFromDxf`.
// Pure: no DOM.

import {defineDialog} from '../../kernel/dialog.mjs';
import formatCells, {categoryOf, codeFor, EDGES} from './formatCells.mjs';

const BORDER_EDGES = ['top', 'bottom', 'left', 'right', 'diagDown', 'diagUp'];
const fontStyleOf = (bold, italic) => (bold && italic ? 'Bold Italic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular');
const colorText = c => (typeof c === 'string' ? c : c && typeof c === 'object' ? '#808080' : 'auto');

/** The settings of a blank conditional Format Cells (nothing changes until a page sets it). */
export function blankValues() {
  const edgeColors = Object.fromEntries(BORDER_EDGES.map(e => [e, 'auto']));
  return {
    ...categoryOf('General'),
    font: 'Calibri', size: 11, fontStyle: 'Regular', bold: false, italic: false, underline: 'none', color: 'auto', strike: false, vert: 'baseline', normalFont: false,
    lineStyle: 'thin', lineColor: 'auto', multi: false,
    top: 'none', bottom: 'none', left: 'none', right: 'none', insideHorizontal: 'none', insideVertical: 'none', diagDown: 'none', diagUp: 'none', edgeColors,
    background: 'none', patternColor: 'auto', patternStyle: 'none', sampleValue: 1234.5,
  };
}

/** What a rule's differential format sets, as the dialog's values. */
export function valuesFromDxf(dxf) {
  const v = blankValues();
  const d = dxf ?? {};
  if (d.numFmt) Object.assign(v, categoryOf(d.numFmt));
  const f = d.font ?? {};
  if (f.bold) { v.bold = true; }
  if (f.italic) { v.italic = true; }
  v.fontStyle = fontStyleOf(v.bold, v.italic);
  if (f.underline && f.underline !== 'none') v.underline = f.underline;
  if (f.strike) v.strike = true;
  if (f.color) v.color = colorText(f.color);
  for (const e of BORDER_EDGES) {
    const b = d.borders?.[e];
    if (b?.style && b.style !== 'none') { v[e] = b.style; v.edgeColors[e] = colorText(b.color); }
  }
  const fill = d.fill;
  if (fill && fill.pattern && fill.pattern !== 'none') {
    if (fill.pattern === 'solid') v.background = colorText(fill.fg);
    else { v.patternStyle = fill.pattern; v.patternColor = colorText(fill.fg); v.background = colorText(fill.bg ?? null); if (v.background === 'auto') v.background = 'none'; }
  }
  return v;
}

/** The differential format the dialog's values make (only what the pages set). */
export function dxfFromValues(v) {
  const dxf = {};
  const code = v.category === 'Custom' ? String(v.code ?? 'General') : codeFor(v);
  if (code && code !== 'General') dxf.numFmt = code;
  const font = {};
  if (v.bold) font.bold = true;
  if (v.italic) font.italic = true;
  if (v.underline && v.underline !== 'none') font.underline = v.underline;
  if (v.strike) font.strike = true;
  if (v.color && v.color !== 'auto') font.color = v.color;
  if (Object.keys(font).length) dxf.font = font;
  const borders = {};
  for (const e of BORDER_EDGES) {
    if (v[e] && v[e] !== 'none') {
      const c = v.edgeColors?.[e];
      borders[e] = {style: v[e], ...(c && c !== 'auto' ? {color: c} : {})};
    }
  }
  if (Object.keys(borders).length) dxf.borders = borders;
  const bg = v.background && v.background !== 'none' && v.background !== 'auto' ? v.background : null;
  if (v.patternStyle && v.patternStyle !== 'none') dxf.fill = {pattern: v.patternStyle, ...(v.patternColor && v.patternColor !== 'auto' ? {fg: v.patternColor} : {}), ...(bg ? {bg} : {})};
  else if (bg) dxf.fill = {pattern: 'solid', fg: bg};
  return dxf;
}

export default defineDialog({
  id: 'dialog.cfFormatCells',
  title: 'Format Cells',
  command: 'home.conditionalFormat',
  init: (ctx, args) => valuesFromDxf(args?.dxf ?? null),
  derive: formatCells.derive,
  validate: v => formatCells.validate({...v, size: 11, indent: 0, rotation: 0}).filter(p => !['size', 'indent', 'rotation'].includes(p.field)),
  preview: formatCells.preview,
  // The values go back to the rule dialog that opened this one; nothing runs from here.
  toCommand: () => ({batch: []}),
});

export {EDGES};
