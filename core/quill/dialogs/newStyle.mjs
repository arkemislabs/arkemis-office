// Home › Styles › Create a Style → Create New Style from Formatting (submit: styles.create).
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `new_style_dialog` (name
// "Style1", based on Normal, the current paragraph's formatting) and dialogs.rs's "newStyle" opener
// at aadb077e072b7de05f724e359d8db82e151f125c, with Word's Properties (Style type, Style for
// following paragraph) and Formatting (font, size, B/I/U, colour, alignment, line spacing,
// spacing) sections; the formatting starts from the caret's and goes over it (`chr`/`para`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {runsAt, parasAt, caretStyle, colorValue, colorParam, num, isNum, r2, lineFields, lineSpacingOf, findStyle} from '../lib/format-dialogs.mjs';

/** The formatting fields for the caret (what the new style takes). */
export function caretFormatting(ctx) {
  const run = runsAt(ctx)[0] ?? {};
  const para = parasAt(ctx)[0] ?? {};
  const ls = lineFields(para.lineSpacing);
  return {
    font: run.font ?? '', size: isNum(run.size) ? String(run.size) : '', color: colorValue(run.color),
    bold: !!run.bold, italic: !!run.italic, underline: (run.underline ?? 'none') !== 'none',
    alignment: ['left', 'center', 'right', 'justify'].includes(para.align) ? para.align : 'left',
    lineRule: ['single', 'onePointFive', 'double'].includes(ls.lineRule) ? ls.lineRule
      : para.lineSpacing?.rule === 'multiple' && Math.abs(para.lineSpacing.value - 1.15) < 1e-6 ? 'multiple115' : null,
    before: r2(para.spaceBefore ?? 0), after: r2(para.spaceAfter ?? 0),
  };
}

/** The formatting fields that changed, as styles.create/modify `chr` and `para`. */
export function formattingParams(v, basis, {character = false} = {}) {
  const diff = k => JSON.stringify(v[k]) !== JSON.stringify(basis?.[k]);
  const chr = {}, para = {};
  if (diff('font') && typeof v.font === 'string' && v.font.trim()) { chr.font = v.font.trim(); chr.fontCs = v.font.trim(); }
  if (diff('size') && num(v.size) !== null) chr.size = num(v.size);
  if (diff('color') && typeof v.color === 'string') chr.color = colorParam(v.color, 'Auto');
  if (diff('bold') && typeof v.bold === 'boolean') chr.bold = v.bold;
  if (diff('italic') && typeof v.italic === 'boolean') chr.italic = v.italic;
  if (diff('underline') && typeof v.underline === 'boolean') chr.underline = v.underline ? 'single' : 'none';
  if (!character) {
    if (diff('alignment') && v.alignment) para.align = v.alignment;
    if (diff('lineRule') && v.lineRule && v.lineRule !== 'keep') { const ls = lineSpacingOf(v); if (ls) para.lineSpacing = ls; }
    if (diff('before') && isNum(v.before)) para.spaceBefore = v.before;
    if (diff('after') && isNum(v.after)) para.spaceAfter = v.after;
  }
  return {chr, para};
}

/** Word's first free "StyleN" name. */
export function freeName(sheet) {
  for (let n = 1; n < 10_000; n++) if (!findStyle(sheet, `Style${n}`)) return `Style${n}`;
  return 'Style';
}

export default defineDialog({
  id: 'dialog.newStyle',
  title: 'Create New Style from Formatting',
  command: 'styles.create',
  init(ctx) {
    const f = caretFormatting(ctx);
    const based = caretStyle(ctx);
    return {name: freeName(ctx.doc.styles), styleType: 'linked', basedOn: based, next: '', ...f, addToGallery: true, _basis: {...f}};
  },
  validate(v) {
    const out = [];
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) out.push({field: 'name', message: 'Type a name for the style.'});
    else if (/[\\{}]/.test(name)) out.push({field: 'name', message: 'A style name cannot contain \\ { or }.'});
    if (v.size !== null && v.size !== undefined && String(v.size).trim() !== '' && (num(v.size) === null || num(v.size) < 1 || num(v.size) > 1638)) out.push({field: 'size', message: 'The number must be between 1 and 1638.'});
    return out;
  },
  preview(ctx, v) {
    return {kind: 'style', font: v.font || null, size: num(v.size) ?? 11, bold: v.bold === true, italic: v.italic === true, underline: v.underline === true,
      color: typeof v.color === 'string' && v.color.startsWith('#') ? v.color : null, align: v.alignment ?? 'left', text: 'Sample Text Sample Text Sample Text'};
  },
  toCommand(v) {
    const character = v.styleType === 'character';
    const {chr, para} = formattingParams(v, v._basis, {character});
    const params = {name: String(v.name).trim(), kind: v.styleType ?? 'paragraph', gallery: v.addToGallery !== false};
    if (v.basedOn) params.basedOn = v.basedOn;
    if (!character && v.next) params.next = v.next;
    if (Object.keys(chr).length) params.chr = chr;
    if (!character && Object.keys(para).length) params.para = para;
    return {command: 'styles.create', params};
  },
});
