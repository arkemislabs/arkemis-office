// Home › Styles › (right-click a style) Modify… → Modify Style (submit: styles.modify, one undo step).
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `modify_style_dialog` (name,
// font, size, colour, space before/after, bold, italic → `styles.modify {style, name, chr, para}`)
// and `Dialog::modify_style` at aadb077e072b7de05f724e359d8db82e151f125c, with Word's Properties
// (Style based on, Style for following paragraph) and Formatting (underline, alignment, line
// spacing) fields; only what changed is sent. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {caretStyle, styleFields, describeStyle, num} from '../lib/format-dialogs.mjs';
import {formattingParams} from './newStyle.mjs';

/** The values Modify Style opens with for style `id` (the Styles gallery's right-clicked tile, Manage Styles' pick). */
export function modifyValues(sheet, id) {
  const f = styleFields(sheet, id);
  return {...f, style: id, _basis: {...f}};
}

export default defineDialog({
  id: 'dialog.modifyStyle',
  title: 'Modify Style',
  command: 'styles.modify',
  init(ctx) {
    // Opened on a style (the gallery's right-clicked tile passes {style}); otherwise the caret's.
    return modifyValues(ctx.doc.styles, caretStyle(ctx));
  },
  validate(v) {
    const out = [];
    if (typeof v.name !== 'string' || !v.name.trim()) out.push({field: 'name', message: 'Type a name for the style.'});
    if (v.size !== null && v.size !== undefined && String(v.size).trim() !== '' && (num(v.size) === null || num(v.size) < 1 || num(v.size) > 1638)) out.push({field: 'size', message: 'The number must be between 1 and 1638.'});
    if (v.basedOn && v.basedOn === v.style) out.push({field: 'basedOn', message: 'A style cannot be based on itself.'});
    return out;
  },
  preview(ctx, v) {
    return {kind: 'style', font: v.font || null, size: num(v.size) ?? 11, bold: v.bold === true, italic: v.italic === true, underline: v.underline === true,
      color: typeof v.color === 'string' && v.color.startsWith('#') ? v.color : null, align: v.alignment ?? 'left',
      text: 'Sample Text Sample Text Sample Text', description: describeStyle(ctx.doc.styles, v.style)};
  },
  toCommand(v) {
    const b = v._basis ?? {};
    const character = v.styleType === 'character';
    const {chr, para} = formattingParams(v, b, {character});
    const params = {style: v.style};
    if (typeof v.name === 'string' && v.name.trim() !== b.name) params.name = v.name.trim();
    if ((v.basedOn ?? '') !== (b.basedOn ?? '')) params.basedOn = v.basedOn || null;
    if (!character && (v.next ?? '') !== (b.next ?? '') && v.next) params.next = v.next;
    if (v.addToGallery !== b.addToGallery) params.gallery = !!v.addToGallery;
    if (Object.keys(chr).length) params.chr = chr;
    if (!character && Object.keys(para).length) params.para = para;
    // Nothing changed: OK only closes.
    return Object.keys(params).length > 1 ? {command: 'styles.modify', params} : null;
  },
});
