// Color & Thickness (Draw › Pens › Color & Thickness...; submit: ink.penSettings). OneNote's dialog
// for the pen in hand: its Type (pen, highlighter, pencil), Thickness from nine widths in mm and
// Color from the swatches (Galaxy and Rainbow are inks, not colours) or "More colors". Slate has
// no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {MM, PEN_COLORS, PEN_FX, THICKNESSES, findPen} from '../lib/ink.mjs';

const TYPES = {Pen: 'pen', Highlighter: 'highlighter', Pencil: 'pencil'};
const typeLabel = t => Object.keys(TYPES).find(k => TYPES[k] === t) ?? 'Pen';
export const thicknessLabel = mm => `${mm} mm`;
const nearest = w => THICKNESSES.reduce((a, b) => (Math.abs(b * MM - w) < Math.abs(a * MM - w) ? b : a));
const hexOf = c => String(c ?? '').toLowerCase();

export default defineDialog({
  id: 'dialog.pen-color-thickness',
  title: 'Color & Thickness',
  command: 'ink.penSettings',
  init(ctx) {
    const penId = ctx.view?.ink?.penId;
    if (!penId) return {penType: 'Pen', thickness: thicknessLabel(0.5), color: 'Black', customColor: '#000000', penId: null};
    const p = findPen(ctx.prefs, penId);
    const fxName = Object.keys(PEN_FX).find(k => PEN_FX[k] === p.fx);
    const named = fxName ?? Object.keys(PEN_COLORS).find(k => !PEN_FX[k] && PEN_COLORS[k] === hexOf(p.color)) ?? null;
    return {penId, penType: typeLabel(p.type), thickness: thicknessLabel(nearest(p.width)), color: named, customColor: hexOf(p.color)};
  },
  derive(v, changed) {
    // Picking a swatch sets the custom colour to it; a custom colour clears the swatch choice.
    if (changed.includes('color') && v.color && PEN_COLORS[v.color]) return {customColor: PEN_COLORS[v.color]};
    if (changed.includes('customColor')) return {color: Object.keys(PEN_COLORS).find(k => !PEN_FX[k] && PEN_COLORS[k] === hexOf(v.customColor)) ?? null};
    return {};
  },
  validate(v) {
    if (!v.penId) return [{field: 'penType', message: 'Pick a pen first.'}];
    return /^#[0-9a-f]{6}$/i.test(hexOf(v.color ? PEN_COLORS[v.color] : v.customColor)) ? [] : [{field: 'customColor', message: 'Choose a colour.'}];
  },
  toCommand(v) {
    const hex = v.color && PEN_COLORS[v.color] ? PEN_COLORS[v.color] : hexOf(v.customColor);
    return {command: 'ink.penSettings', params: {penId: v.penId, type: TYPES[v.penType] ?? 'pen', thickness: Number.parseFloat(v.thickness), color: hex, fx: v.color && PEN_FX[v.color] ? PEN_FX[v.color] : null}};
  },
});
