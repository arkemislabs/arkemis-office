// Font… (submit: format.fontDialog): family, style, size, colour, underline, strikethrough,
// baseline and offset, caps, character spacing and its presets, with the sample.
// Translated from deckcraft crates/ui-egui/src/dialogs/font.rs (`seed_font_fields`, `font_dialog`)
// and crates/engine/src/cmd/format/font.rs (`font_dialog_params`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's page layout (Font / Character Spacing) and Font style list; one OK is one undo step.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fontDialogParams} from '../commands/format.mjs';
import {currentRun, resolveCtx} from '../lib/format-text.mjs';
import {textColor} from '../model/resolve.mjs';
import {hex} from '../model/color.mjs';

const PRESETS = ['-3', '-1.5', '0', '3', '6'];
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const styleOf = (bold, italic) => (bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular');
export const presetOf = sp => (PRESETS.includes(String(sp)) ? String(sp) : 'custom');

/** The Font dialog's values from `font_dialog_params`; the colour shown is the text's colour as drawn. */
export function fontValues(ctx) {
  const p = fontDialogParams(ctx);
  const r = currentRun(ctx);
  const rc = resolveCtx(ctx);
  const shown = rc ? `#${hex(textColor(rc, r))}` : 'auto';
  const offset = finite(r.baseline) && r.baseline !== 0 ? Math.round(r.baseline * 100) : 0;
  return {family: p.family, style: styleOf(p.bold, p.italic), bold: p.bold, italic: p.italic, size: p.size, color: shown, colorSeed: shown,
    underline: p.underline, strike: p.strike, baseline: p.baseline, offset, caps: p.caps, spacing: p.spacing, spacingPreset: presetOf(p.spacing),
    strikeSingle: p.strike === 'sng', strikeDouble: p.strike === 'dbl', superscript: p.baseline === 'super', subscript: p.baseline === 'sub', smallCaps: p.caps === 'small', allCaps: p.caps === 'all'};
}

export function deriveFont(v, changed) {
  const out = {};
  if (changed.includes('style')) { out.bold = v.style === 'bold' || v.style === 'boldItalic'; out.italic = v.style === 'italic' || v.style === 'boldItalic'; }
  // PowerPoint's check boxes: Strikethrough / Double Strikethrough, Superscript / Subscript and Small Caps / All Caps exclude each other.
  if (changed.includes('strikeSingle')) { out.strike = v.strikeSingle ? 'sng' : 'none'; out.strikeDouble = false; }
  if (changed.includes('strikeDouble')) { out.strike = v.strikeDouble ? 'dbl' : 'none'; out.strikeSingle = false; }
  if (changed.includes('superscript')) { out.baseline = v.superscript ? 'super' : 'none'; out.offset = v.superscript ? 30 : 0; out.subscript = false; }
  if (changed.includes('subscript')) { out.baseline = v.subscript ? 'sub' : 'none'; out.offset = v.subscript ? -25 : 0; out.superscript = false; }
  if (changed.includes('smallCaps')) { out.caps = v.smallCaps ? 'small' : 'none'; out.allCaps = false; }
  if (changed.includes('allCaps')) { out.caps = v.allCaps ? 'all' : 'none'; out.smallCaps = false; }
  if (changed.includes('baseline')) out.offset = v.baseline === 'super' ? 30 : v.baseline === 'sub' ? -25 : 0;
  if (changed.includes('offset') && finite(v.offset)) {
    out.baseline = v.offset > 0 ? 'super' : v.offset < 0 ? 'sub' : 'none';
    out.superscript = v.offset > 0;
    out.subscript = v.offset < 0;
  }
  if (changed.includes('spacingPreset') && v.spacingPreset !== 'custom') out.spacing = Number(v.spacingPreset);
  if (changed.includes('spacing') && finite(v.spacing)) out.spacingPreset = presetOf(v.spacing);
  return out;
}

/** OK: every field, as deckcraft's font_dialog sends them; the colour only when it was changed. */
export function fontParams(v) {
  const params = {family: String(v.family ?? '').trim(), size: v.size, bold: !!v.bold, italic: !!v.italic, underline: v.underline ?? 'none',
    strike: v.strike ?? 'none', caps: v.caps ?? 'none', spacing: v.spacing ?? 0};
  params.baseline = v.baseline === 'none' || !finite(v.offset) ? 'none' : Math.max(-1, Math.min(1, v.offset / 100));
  if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) && v.color.toLowerCase() !== String(v.colorSeed ?? '').toLowerCase()) params.color = v.color;
  return params;
}

export default defineDialog({
  id: 'dialog.font',
  title: 'Font',
  command: 'format.fontDialog',
  init: ctx => fontValues(ctx),
  derive: deriveFont,
  validate(v) {
    const out = [];
    if (!String(v.family ?? '').trim()) out.push({field: 'family', message: 'Choose a font'});
    if (!finite(v.size)) out.push({field: 'size', message: 'Font size must be a number'});
    if (!finite(v.spacing)) out.push({field: 'spacing', message: 'Character spacing must be a number'});
    if (v.baseline !== 'none' && !finite(v.offset)) out.push({field: 'offset', message: 'Offset must be a number'});
    return out;
  },
  preview: (_ctx, v) => ({text: 'AaBbCcDd', font: v.family, size: Math.max(12, Math.min(28, finite(v.size) ? v.size : 18)),
    color: /^#[0-9a-f]{6}$/i.test(String(v.color)) ? v.color : null}),
  toCommand: v => ({command: 'format.fontDialog', params: fontParams(v)}),
});
