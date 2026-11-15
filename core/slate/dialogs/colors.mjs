// Colors (Font Color › More Colors...; submit: format.fontColor). Office's Colors dialog: the
// Standard tab's honeycomb of 127 colours and 15 greys, the Custom tab's RGB / HSL spinners and
// Hex box, New / Current preview. HSL uses Office's 0–255 scales. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {schema} from '../schema.mjs';
import {markAttr, textRange} from '../lib/format-text.mjs';

const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export function fromHex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** RGB 0–255 -> Office HSL 0–255. */
export function rgbToHsl(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 255), Math.round(s * 255), Math.round(l * 255)];
}
/** Office HSL 0–255 -> RGB 0–255. */
export function hslToRgb(h, s, l) {
  const H = h / 255, S = s / 255, L = l / 255;
  if (S === 0) return [L, L, L].map(x => Math.round(x * 255));
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S, p = 2 * L - q;
  const f = t => {
    const u = ((t % 1) + 1) % 1;
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
  };
  return [f(H + 1 / 3), f(H), f(H - 1 / 3)].map(x => Math.round(x * 255));
}

/** The Standard tab's honeycomb: 127 colours in 13 rows (7 to 13 to 7 cells), then 15 greys from white to black. */
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

function fromRgb(r, g, b) {
  const [hue, saturation, luminance] = rgbToHsl(r, g, b);
  const hex = toHex(r, g, b);
  return {red: r, green: g, blue: b, hue, saturation, luminance, hex, color: hex, palette: hex};
}

export default defineDialog({
  id: 'dialog.colors',
  title: 'Colors',
  command: 'format.fontColor',
  init(ctx) {
    const r = textRange(ctx);
    const cur = (r && markAttr(r.doc, r.from, r.to, schema.marks.textStyle, 'color')) || '#000000';
    // `comb` is the drawn palette's rows (the Standard tab); `spectrum` the Custom tab's {hue, saturation, luminance} pick.
    return {...fromRgb(...(fromHex(cur) ?? [0, 0, 0])), colorModel: 'RGB', current: cur, comb: honeycomb(), spectrum: null};
  },
  derive(v, changed) {
    const f = changed[0];
    if (f === 'palette' || f === 'hex' || f === 'color') { const rgb = fromHex(v[f]); return rgb ? fromRgb(...rgb) : {}; }
    if (f === 'spectrum' && v.spectrum && typeof v.spectrum === 'object') {
      const clamp = n => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
      const hsl = [clamp(v.spectrum.hue), clamp(v.spectrum.saturation), clamp(v.spectrum.luminance ?? v.luminance)];
      return {...fromRgb(...hslToRgb(...hsl)), hue: hsl[0], saturation: hsl[1], luminance: hsl[2]};
    }
    if (['red', 'green', 'blue'].includes(f)) return fromRgb(Number(v.red) || 0, Number(v.green) || 0, Number(v.blue) || 0);
    if (['hue', 'saturation', 'luminance'].includes(f)) {
      const hsl = [Number(v.hue) || 0, Number(v.saturation) || 0, Number(v.luminance) || 0];
      return {...fromRgb(...hslToRgb(...hsl)), hue: hsl[0], saturation: hsl[1], luminance: hsl[2]};
    }
    return {};
  },
  validate(v) {
    const out = [];
    for (const k of ['red', 'green', 'blue', 'hue', 'saturation', 'luminance']) {
      const n = Number(v[k]);
      if (!(Number.isInteger(n) && n >= 0 && n <= 255)) out.push({field: k, message: 'Enter a whole number from 0 to 255.'});
    }
    if (!fromHex(v.hex)) out.push({field: 'hex', message: 'Enter a colour as #RRGGBB.'});
    return out;
  },
  preview: (ctx, v) => ({type: 'colors', new: v.hex, current: v.current}),
  toCommand: v => ({command: 'format.fontColor', params: {color: toHex(...fromHex(v.hex))}}),
});
