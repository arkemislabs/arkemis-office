// Home › Font › Font dialog (Ctrl+D; submit: format.set, one undo step).
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `font_dialog` and
// crates/ui-egui/src/dialogs/font.rs (`preview_size`, `font_props`, `east_asian_char`,
// `apply_font`: only the properties that changed, the Latin font for complex script too) at
// aadb077e072b7de05f724e359d8db82e151f125c, with Word's Font and Advanced pages (Font style,
// Underline style and colour, Double strikethrough, Scale, Spacing/Position by, Kerning).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {runsAt, selectionText, eastAsianChar, common, tri, colorValue, colorParam, num, isNum, r2} from '../lib/format-dialogs.mjs';

const UNDERLINES = ['none', 'words', 'single', 'double', 'thick', 'dotted', 'dash', 'dotDash', 'dotDotDash', 'wave', 'doubleWave'];

/** The Font dialog preview's size: 6–72 pt, else 12 (font.rs `preview_size`, #3663). */
export function previewSize(size) {
  const n = num(size);
  return n === null ? 12 : Math.max(6, Math.min(72, n));
}

/** Values the dialog shows for the selection; mixed values are blank (null). */
export function fontValues(ctx) {
  const runs = runsAt(ctx);
  const text = selectionText(ctx, 400);
  const asian = [...text].some(eastAsianChar) || runs.some(r => !!r.fontEa && r.fontEa !== r.font);
  const bold = tri(runs, r => r.bold), italic = tri(runs, r => r.italic);
  const fontStyle = bold === null || italic === null ? null : bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
  const spacing = common(runs, r => r.spacing ?? 0);
  const position = common(runs, r => r.position ?? 0);
  const kern = common(runs, r => r.kern ?? 0);
  const scale = common(runs, r => r.scale ?? 100);
  const size = common(runs, r => r.size);
  return {
    asian,
    font: common(runs, r => r.font) ?? '',
    fontEastAsia: common(runs, r => r.fontEa ?? '') ?? '',
    fontStyle,
    size: isNum(size) ? String(size) : '',
    color: common(runs, r => colorValue(r.color)),
    underlineStyle: common(runs, r => (UNDERLINES.includes(r.underline) ? r.underline : 'none')),
    underlineColor: common(runs, r => (r.underlineColor ? colorValue(r.underlineColor) : 'auto')),
    strike: tri(runs, r => r.strike), doubleStrike: tri(runs, r => r.doubleStrike),
    superscript: tri(runs, r => r.vertAlign === 'superscript'), subscript: tri(runs, r => r.vertAlign === 'subscript'),
    smallCaps: tri(runs, r => r.smallCaps), allCaps: tri(runs, r => r.caps), hidden: tri(runs, r => r.hidden),
    shadow: tri(runs, r => r.shadow), outline: tri(runs, r => r.outline), emboss: tri(runs, r => r.emboss), engrave: tri(runs, r => r.engrave),
    scale: isNum(scale) ? `${scale}%` : '',
    spacingType: spacing === null ? null : spacing > 0 ? 'expanded' : spacing < 0 ? 'condensed' : 'normal',
    spacingBy: spacing === null ? null : r2(Math.abs(spacing)),
    position: position === null ? null : position > 0 ? 'raised' : position < 0 ? 'lowered' : 'normal',
    positionBy: position === null ? null : r2(Math.abs(position)),
    kerning: kern === null ? null : kern > 0,
    kerningAt: kern !== null && kern > 0 ? kern : 12,
    sample: text.split('\n')[0].trim().slice(0, 60),
  };
}

/** The character properties the fields stand for (font.rs `font_props`, Word's fields); blank fields are left out. */
export function fontProps(v) {
  const props = {};
  if (typeof v.font === 'string' && v.font.trim()) { props.font = v.font.trim(); props.fontCs = v.font.trim(); }
  if (v.asian && typeof v.fontEastAsia === 'string' && v.fontEastAsia.trim()) props.fontEa = v.fontEastAsia.trim();
  if (v.fontStyle) { props.bold = v.fontStyle === 'bold' || v.fontStyle === 'boldItalic'; props.italic = v.fontStyle === 'italic' || v.fontStyle === 'boldItalic'; }
  const size = num(v.size);
  if (size !== null) props.size = size;
  if (v.color !== null && v.color !== undefined) props.color = colorParam(v.color, 'Auto');
  if (v.underlineStyle) props.underline = v.underlineStyle;
  if (v.underlineStyle && v.underlineStyle !== 'none' && v.underlineColor !== null && v.underlineColor !== undefined) {
    const c = colorParam(v.underlineColor, null);
    if (c) props.underlineColor = c;
  }
  for (const [k, p] of [['strike', 'strike'], ['doubleStrike', 'doubleStrike'], ['smallCaps', 'smallCaps'], ['allCaps', 'caps'], ['hidden', 'hidden'], ['shadow', 'shadow'], ['outline', 'outline'], ['emboss', 'emboss'], ['engrave', 'engrave']]) {
    if (typeof v[k] === 'boolean') props[p] = v[k];
  }
  if (typeof v.superscript === 'boolean' || typeof v.subscript === 'boolean') {
    if (v.superscript === true) props.vertAlign = 'superscript';
    else if (v.subscript === true) props.vertAlign = 'subscript';
    else if (v.superscript === false && v.subscript === false) props.vertAlign = 'baseline';
  }
  const scale = num(v.scale);
  if (scale !== null) props.scale = scale;
  if (v.spacingType) {
    const by = num(v.spacingBy) ?? 0;
    props.spacing = v.spacingType === 'normal' ? 0 : v.spacingType === 'condensed' ? -by : by;
  }
  if (v.position) {
    const by = num(v.positionBy) ?? 0;
    props.position = v.position === 'normal' ? 0 : v.position === 'lowered' ? -by : by;
  }
  if (v.kerning === true) props.kern = Math.max(1, Math.min(1638, num(v.kerningAt) ?? 1));
  else if (v.kerning === false) props.kern = 0;
  return props;
}

/** Only what changed since the dialog opened (`apply_font`). */
export function changedProps(v) {
  const now = fontProps(v);
  const was = v._basis ? fontProps(v._basis) : {};
  const out = {};
  for (const [k, x] of Object.entries(now)) if (JSON.stringify(was[k]) !== JSON.stringify(x)) out[k] = x;
  // A new Latin font is the complex-script font too (apply_font).
  if (out.font !== undefined) out.fontCs = out.font; else delete out.fontCs;
  return out;
}

export default defineDialog({
  id: 'dialog.font',
  title: 'Font',
  command: 'format.set',
  init(ctx) {
    const v = fontValues(ctx);
    return {...v, _basis: {...v}};
  },
  derive(v, changed) {
    // Word: Superscript and Subscript exclude each other; so do Strikethrough and Double strikethrough,
    // and Small caps and All caps.
    const out = {};
    const pairs = [['superscript', 'subscript'], ['strike', 'doubleStrike'], ['smallCaps', 'allCaps'], ['emboss', 'engrave']];
    for (const [a, b] of pairs) {
      if (changed.includes(a) && v[a] === true) out[b] = false;
      if (changed.includes(b) && v[b] === true) out[a] = false;
    }
    if (changed.includes('spacingType') && v.spacingType === 'normal') out.spacingBy = 0;
    if (changed.includes('spacingType') && v.spacingType !== 'normal' && !num(v.spacingBy)) out.spacingBy = 1;
    if (changed.includes('position') && v.position === 'normal') out.positionBy = 0;
    if (changed.includes('position') && v.position !== 'normal' && !num(v.positionBy)) out.positionBy = 3;
    if (changed.includes('spacingBy') && num(v.spacingBy) && v.spacingType === 'normal') out.spacingType = 'expanded';
    if (changed.includes('positionBy') && num(v.positionBy) && v.position === 'normal') out.position = 'raised';
    return out;
  },
  validate(v) {
    const out = [];
    if (v.size !== null && v.size !== undefined && String(v.size).trim() !== '') {
      const n = num(v.size);
      if (n === null || n < 1 || n > 1638) out.push({field: 'size', message: 'The number must be between 1 and 1638.'});
    }
    if (v.scale !== null && v.scale !== undefined && String(v.scale).trim() !== '') {
      const n = num(v.scale);
      if (n === null || n < 1 || n > 600) out.push({field: 'scale', message: 'The number must be between 1 and 600.'});
    }
    if (v.spacingBy !== null && v.spacingBy !== undefined && (!isNum(num(v.spacingBy)) || num(v.spacingBy) < 0 || num(v.spacingBy) > 100)) out.push({field: 'spacingBy', message: 'The number must be between 0 pt and 100 pt.'});
    if (v.positionBy !== null && v.positionBy !== undefined && (!isNum(num(v.positionBy)) || num(v.positionBy) < 0 || num(v.positionBy) > 1584)) out.push({field: 'positionBy', message: 'The number must be between 0 pt and 1584 pt.'});
    if (v.kerning === true && (!isNum(num(v.kerningAt)) || num(v.kerningAt) < 1 || num(v.kerningAt) > 1638)) out.push({field: 'kerningAt', message: 'The number must be between 1 and 1638.'});
    return out;
  },
  preview(ctx, v) {
    const style = v.fontStyle ?? '';
    return {
      text: v.sample || (typeof v.font === 'string' && v.font.trim()) || 'AaBbYyZz',
      font: v.font || null, size: previewSize(v.size),
      bold: style === 'bold' || style === 'boldItalic', italic: style === 'italic' || style === 'boldItalic',
      color: typeof v.color === 'string' && v.color.startsWith('#') ? v.color : null,
      underline: v.underlineStyle && v.underlineStyle !== 'none' ? v.underlineStyle : null,
      underlineColor: typeof v.underlineColor === 'string' && v.underlineColor.startsWith('#') ? v.underlineColor : null,
      strike: v.strike === true, doubleStrike: v.doubleStrike === true,
      superscript: v.superscript === true, subscript: v.subscript === true,
      smallCaps: v.smallCaps === true, allCaps: v.allCaps === true, hidden: v.hidden === true,
      shadow: v.shadow === true, outline: v.outline === true, emboss: v.emboss === true, engrave: v.engrave === true,
      spacing: fontProps(v).spacing ?? 0, position: fontProps(v).position ?? 0, scale: num(v.scale) ?? 100,
    };
  },
  toCommand(v) {
    const props = changedProps(v);
    // Nothing changed: OK only closes (`apply_font` runs nothing).
    if (!Object.keys(props).length) return null;
    return {command: 'format.set', params: {props}};
  },
});
