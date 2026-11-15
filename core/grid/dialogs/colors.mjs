// Colors (Fill Color or Font Color > More Colors...): Office's Colors dialog with its Standard tab (a honeycomb
// of 127 colours and a strip of 15 greys) and Custom tab (hue and saturation square, lightness, Hex and RGB),
// New and Current preview. Submit: home.fillColor or home.fontColor, by the `target` the menu names.
// Excel behaviour; Grid's gridcraft has no such dialog (not checked against upstream).

import {defineDialog} from '../../kernel/dialog.mjs';
import {activeStyle} from '../lib/format-ranges.mjs';
import {colorHex} from '../model/style.mjs';

const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
function hslToRgb(h, s, l) {
  const H = h / 255, S = s / 255, L = l / 255;
  if (S === 0) return [L, L, L].map(x => Math.round(x * 255));
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S, p = 2 * L - q;
  const f = t => { const u = ((t % 1) + 1) % 1; return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p; };
  return [f(H + 1 / 3), f(H), f(H - 1 / 3)].map(x => Math.round(x * 255));
}

/** The Standard tab: 127 colours in 13 rows of 7 to 13 to 7 hexagons, then 15 greys from white to black. */
export function honeycomb() {
  const rows = [];
  for (let r = 0; r < 13; r++) {
    const n = 7 + Math.min(r, 12 - r);
    const row = [];
    for (let i = 0; i < n; i++) {
      const x = i - (n - 1) / 2, y = r - 6;
      const dist = Math.min(1, Math.hypot(x, y * 0.866) / 6.2);
      const hue = (((Math.atan2(y, x) / (2 * Math.PI)) * 255) + 255) % 255;
      row.push(toHex(...hslToRgb(hue, dist < 0.05 ? 0 : 255, 255 - Math.round(dist * 160))));
    }
    rows.push(row);
  }
  const greys = Array.from({length: 15}, (_, i) => toHex(255 - (i * 255) / 14, 255 - (i * 255) / 14, 255 - (i * 255) / 14));
  return {rows, greys};
}

export default defineDialog({
  id: 'dialog.colors',
  title: 'Colors',
  command: 'home.fillColor',
  init(ctx, args) {
    const target = args?.target === 'fill' ? 'fill' : 'font';
    let cur = null;
    try {
      const st = activeStyle(ctx);
      cur = target === 'fill' ? (st.fill.pattern === 'solid' ? colorHex(st.fill.fg, ctx.doc?.theme) : null) : colorHex(st.font.color, ctx.doc?.theme);
    } catch { cur = null; }
    const color = cur ?? (target === 'fill' ? '#FFFF00' : '#000000');
    return {target, color, current: cur ?? '', hasCurrent: cur !== null};
  },
  validate: v => (/^#[0-9a-f]{6}$/i.test(String(v.color ?? '')) ? [] : [{field: 'color', message: 'Choose a color.'}]),
  preview: (ctx, v) => ({new: v.color, current: v.current || null, comb: honeycomb()}),
  toCommand: v => ({batch: [{command: v.target === 'fill' ? 'home.fillColor' : 'home.fontColor', params: {color: String(v.color).toUpperCase()}}]}),
});
