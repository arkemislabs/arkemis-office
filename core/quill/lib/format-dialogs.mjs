// Shared pieces of the U:quill/format unit's dialog models (Font, Enclose Characters, Paragraph,
// Tabs, Create/Modify/Manage Styles, Sort Text, Define New Multilevel List, Define New Bullet /
// Number Format, Set Numbering Value): what a selection or a style holds, as the dialogs show it.
// Translated from wordcraft crates/ui-egui/src/dialogs/{font.rs,paragraph.rs,dispatch.rs} helpers
// (`preview_size`, `east_asian_char`, the forms' read/changes split) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Lengths the dialogs show are inches (Word's default measurement unit, as the table dialogs);
// the commands take points. Pure: no DOM.

import {resolvedRuns, peek, ordered, selectedPaths, focusOf} from './format-target.mjs';
import {resolvePara, resolveChar, getStyle, findStyle} from '../model/styles.mjs';
import {rgbHex} from '../model/props.mjs';

export const IN = 72;
/** A length in points as the dialogs show it: inches, two decimals. */
export const toIn = pt => Math.round((pt / IN) * 100) / 100;
/** Inches typed in a dialog back to points (rounded to a twentieth of a point, a twip). */
export const fromIn = inch => Math.round(inch * IN * 20) / 20;
export const r2 = x => Math.round(x * 100) / 100;
export const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const num = v => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim().replace(/\s*(pt|%|")$/i, ''))) ? Number(v.trim().replace(/\s*(pt|%|")$/i, '')) : null);

/** Every value equal → that value; mixed → null (Word leaves the field blank). */
export function common(list, f) {
  if (!list.length) return null;
  const k0 = JSON.stringify(f(list[0]));
  return list.every(x => JSON.stringify(f(x)) === k0) ? f(list[0]) : null;
}
/** A check box over many runs or paragraphs: all on true, all off false, mixed null. */
export function tri(list, f) {
  if (!list.length) return false;
  const on = list.filter(f).length;
  return on === list.length ? true : on === 0 ? false : null;
}

/** A colour field's value from a resolved text colour: "#RRGGBB" or "auto". */
export function colorValue(c) {
  if (!c || c === 'Auto') return 'auto';
  if (Array.isArray(c)) return `#${rgbHex(c)}`;
  if (Array.isArray(c.Rgb)) return `#${rgbHex(c.Rgb)}`;
  return 'auto';
}
/** A colour field's value as the commands take it: "RRGGBB", "Auto" (text) or null (underline/none). */
export function colorParam(v, auto = 'Auto') {
  if (typeof v !== 'string') return auto;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? m[1].toUpperCase() : auto;
}

/** Is `c` Chinese, Japanese or Korean text (font.rs `east_asian_char`)? */
export function eastAsianChar(c) {
  const u = c.codePointAt(0);
  return (u >= 0x1100 && u <= 0x11ff) || (u >= 0x2e80 && u <= 0x9fff) || (u >= 0xa960 && u <= 0xa97f) || (u >= 0xac00 && u <= 0xd7ff)
    || (u >= 0xf900 && u <= 0xfaff) || (u >= 0xfe30 && u <= 0xfe4f) || (u >= 0xff00 && u <= 0xffef) || (u >= 0x20000 && u <= 0x3ffff);
}

/** The selected text (the caret's paragraph when collapsed), capped. */
export function selectionText(ctx, cap = 2000) {
  const d = peek(ctx);
  const [a, b] = ordered(ctx, d);
  const paths = d.pathsBetween ? d.pathsBetween(a, b) : [a.path];
  let out = '';
  paths.forEach((path, i) => {
    const p = d.para(a.story, path);
    if (!p) return;
    const from = i === 0 ? a.off : 0;
    const to = i === paths.length - 1 ? b.off : p.text.length;
    out += (i ? '\n' : '') + p.text.slice(from, Math.max(from, to));
  });
  return out.slice(0, cap);
}

/** The resolved runs the Font dialog reads (the word at a caret, as the format commands target). */
export function runsAt(ctx) {
  try { return resolvedRuns(ctx, peek(ctx)); } catch { return []; }
}

/** The resolved paragraph properties of every selected paragraph. */
export function parasAt(ctx) {
  const d = peek(ctx);
  const [a] = ordered(ctx, d);
  const out = [];
  for (const path of selectedPaths(ctx, d)) {
    const p = d.para(a.story, path);
    if (p) out.push(resolvePara(d.styles, p.props ?? {}));
  }
  if (!out.length) {
    const p = d.paraAt(focusOf(ctx, d));
    if (p) out.push(resolvePara(d.styles, p.props ?? {}));
  }
  return out;
}

/** The caret paragraph's style id. */
export function caretStyle(ctx) {
  const d = peek(ctx);
  return d.paraAt(focusOf(ctx, d))?.props?.style ?? 'Normal';
}

/**
 * Styles a Style based on / following paragraph / Link level box lists: [{value: id, label: name}] by name.
 * @param {any} sheet
 * @param {{kinds?: string[], hidden?: boolean, none?: string | null}} [opts]
 */
export function styleOptions(sheet, {kinds = ['paragraph'], hidden = false, none = null} = {}) {
  const list = (sheet?.styles ?? []).filter(st => kinds.includes(st.kind) && (hidden || !st.hidden)).map(st => ({value: st.id, label: st.name || st.id}));
  list.sort((x, y) => x.label.localeCompare(y.label, 'en', {sensitivity: 'base'}));
  return none ? [{value: '', label: none}, ...list] : list;
}

/** Line spacing as the Paragraph dialog's two boxes show it: rule and At (lines or points). */
export function lineFields(ls) {
  const rule = ls?.rule ?? 'multiple';
  const v = isNum(ls?.value) ? ls.value : 1;
  if (rule === 'atLeast') return {lineRule: 'atLeast', lineAt: null, lineAtPt: r2(v)};
  if (rule === 'exactly' || rule === 'exact') return {lineRule: 'exactly', lineAt: null, lineAtPt: r2(v)};
  if (Math.abs(v - 1) < 1e-6) return {lineRule: 'single', lineAt: 1, lineAtPt: null};
  if (Math.abs(v - 1.5) < 1e-6) return {lineRule: 'onePointFive', lineAt: 1.5, lineAtPt: null};
  if (Math.abs(v - 2) < 1e-6) return {lineRule: 'double', lineAt: 2, lineAtPt: null};
  return {lineRule: 'multiple', lineAt: r2(v), lineAtPt: null};
}
/** The Paragraph dialog's line spacing boxes back to a LineSpacing (null when blank). */
export function lineSpacingOf(v) {
  switch (v.lineRule) {
    case 'single': return {rule: 'multiple', value: 1};
    case 'onePointFive': return {rule: 'multiple', value: 1.5};
    case 'double': return {rule: 'multiple', value: 2};
    case 'multiple115': return {rule: 'multiple', value: 1.15};
    case 'multiple': return isNum(v.lineAt) ? {rule: 'multiple', value: v.lineAt} : null;
    case 'atLeast': return isNum(v.lineAtPt) ? {rule: 'atLeast', value: v.lineAtPt} : null;
    case 'exactly': return isNum(v.lineAtPt) ? {rule: 'exactly', value: v.lineAtPt} : null;
    default: return null;
  }
}

/** A style's resolved character and paragraph formatting (what Modify Style shows). */
export function styleLook(sheet, id) {
  const st = getStyle(sheet, id);
  const para = st && st.kind !== 'character' ? resolvePara(sheet, {style: id}) : resolvePara(sheet, {});
  const chr = st?.kind === 'character' ? resolveChar(sheet, null, {style: id}) : resolveChar(sheet, st ? id : null, {});
  return {st, para, chr};
}

/** The Create/Modify Style dialogs' formatting values for a resolved look. */
export function styleFields(sheet, id) {
  const {st, para, chr} = styleLook(sheet, id);
  const ls = lineFields(para.lineSpacing);
  const kind = st?.kind === 'character' ? 'character' : st?.kind === 'table' ? 'table' : st?.linked ? 'linked' : 'paragraph';
  return {
    name: st?.name ?? id, styleType: kind, basedOn: st?.basedOn ?? '', next: st?.next ?? (st?.kind === 'paragraph' ? st.id : ''),
    font: chr.font ?? '', size: isNum(chr.size) ? String(chr.size) : '', color: colorValue(chr.color),
    bold: !!chr.bold, italic: !!chr.italic, underline: (chr.underline ?? 'none') !== 'none',
    alignment: ['left', 'center', 'right', 'justify'].includes(para.align) ? para.align : 'left',
    lineRule: ['single', 'onePointFive', 'double'].includes(ls.lineRule) ? ls.lineRule : Math.abs((para.lineSpacing?.value ?? 0) - 1.15) < 1e-6 && para.lineSpacing?.rule === 'multiple' ? 'multiple115' : 'keep',
    before: r2(para.spaceBefore ?? 0), after: r2(para.spaceAfter ?? 0),
    addToGallery: !!st?.quick,
  };
}

/** Text describing a style as Word's Manage Styles and Modify Style show it ("Font: Aptos, 12 pt, Bold, Left, Space After: 8 pt, Based on: Normal"). */
export function describeStyle(sheet, id) {
  const {st, para, chr} = styleLook(sheet, id);
  if (!st) return '';
  const bits = [];
  bits.push(`Font: ${chr.font ?? 'Aptos'}`, `${chr.size ?? 11} pt`);
  if (chr.bold) bits.push('Bold');
  if (chr.italic) bits.push('Italic');
  if ((chr.underline ?? 'none') !== 'none') bits.push('Underline');
  if (chr.color && chr.color !== 'Auto') bits.push(`Font color: ${colorValue(chr.color).toUpperCase()}`);
  if (st.kind !== 'character') {
    bits.push(para.align === 'justify' ? 'Justified' : para.align === 'center' ? 'Centered' : para.align === 'right' ? 'Right' : 'Left');
    const ls = para.lineSpacing;
    if (ls) bits.push(ls.rule === 'multiple' ? (ls.value === 1 ? 'Line spacing: single' : `Line spacing: Multiple ${r2(ls.value)} li`) : `Line spacing: ${ls.rule === 'atLeast' ? 'At least' : 'Exactly'} ${r2(ls.value)} pt`);
    if (para.spaceBefore) bits.push(`Space Before: ${r2(para.spaceBefore)} pt`);
    if (para.spaceAfter) bits.push(`After: ${r2(para.spaceAfter)} pt`);
    if (para.keepNext) bits.push('Keep with next');
    if (para.outlineLevel !== null && para.outlineLevel !== undefined && para.outlineLevel < 9) bits.push(`Level ${para.outlineLevel + 1}`);
  }
  const kind = st.kind === 'character' ? 'Character' : st.kind === 'table' ? 'Table' : st.linked ? 'Linked' : 'Paragraph';
  const extra = [`Style: ${st.quick ? 'Show in the Styles gallery' : 'Hide from the Styles gallery'}`, kind];
  if (st.basedOn) extra.push(`Based on: ${getStyle(sheet, st.basedOn)?.name ?? st.basedOn}`);
  if (st.kind === 'paragraph' && st.next && st.next !== st.id) extra.push(`Following style: ${getStyle(sheet, st.next)?.name ?? st.next}`);
  return `${bits.join(', ')}\n${extra.join(', ')}`;
}

export {findStyle, getStyle};
