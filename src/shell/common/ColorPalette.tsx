// The Office color picker: Automatic / No Color, theme colors (10 base colors with five tints and
// shades each), standard colors, recent colors and More Colors…. Used by ribbon color splits and by
// ColorField in dialogs.

import {useState} from 'react';

/** Office theme base colors (Background 1, Text 1, Background 2, Text 2, Accent 1–6). */
export const THEME = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
export const THEME_NAMES = ['White, Background 1', 'Black, Text 1', 'Light Gray, Background 2', 'Blue-Gray, Text 2', 'Blue, Accent 1', 'Orange, Accent 2',
  'Gray, Accent 3', 'Gold, Accent 4', 'Blue, Accent 5', 'Green, Accent 6'];
export const STANDARD = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];
export const STANDARD_NAMES = ['Dark Red', 'Red', 'Orange', 'Yellow', 'Light Green', 'Green', 'Light Blue', 'Blue', 'Dark Blue', 'Purple'];

const hex2rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (r: number[]) => '#' + r.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
/** Office's tint/shade rows: lighter 80/60/40% for dark colors, darker 5/15/25/35/50% for light ones. */
export function variants(base: string): {hex: string; label: string}[] {
  const rgb = hex2rgb(base);
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  const tint = (p: number) => rgb2hex(rgb.map(v => v + (255 - v) * p));
  const shade = (p: number) => rgb2hex(rgb.map(v => v * (1 - p)));
  if (lum > 0.9) return [[5, 'Darker 5%'], [15, 'Darker 15%'], [25, 'Darker 25%'], [35, 'Darker 35%'], [50, 'Darker 50%']].map(([p, l]) => ({hex: shade(Number(p) / 100), label: String(l)}));
  if (lum < 0.1) return [[50, 'Lighter 50%'], [35, 'Lighter 35%'], [25, 'Lighter 25%'], [15, 'Lighter 15%'], [5, 'Lighter 5%']].map(([p, l]) => ({hex: tint(Number(p) / 100), label: String(l)}));
  return [{hex: tint(0.8), label: 'Lighter 80%'}, {hex: tint(0.6), label: 'Lighter 60%'}, {hex: tint(0.4), label: 'Lighter 40%'},
    {hex: shade(0.25), label: 'Darker 25%'}, {hex: shade(0.5), label: 'Darker 50%'}];
}

const recent: string[] = [];
export function rememberColor(hex: string) {
  const h = hex.toUpperCase();
  const i = recent.indexOf(h);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(h);
  recent.length = Math.min(recent.length, 10);
}

export function ColorPalette({value, onPick, automatic = 'Automatic', onMore, label = 'Colors'}: {
  value?: string | null; onPick: (hex: string | null) => void; automatic?: string | null; onMore?: () => void; label?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const pick = (hex: string | null) => { if (hex) rememberColor(hex); onPick(hex); };
  const v = typeof value === 'string' ? value.toUpperCase() : null;
  const swatch = (hex: string, name: string) => <button key={hex + name} type="button" className={`shell-swatch${v === hex.toUpperCase() ? ' is-current' : ''}`}
    style={{background: hex}} aria-label={name} title={name} onMouseEnter={() => setHover(name)} onFocus={() => setHover(name)} onClick={() => pick(hex)}/>;
  return <div className="shell-palette" role="group" aria-label={label}>
    {automatic ? <button type="button" className="shell-palette-auto" role="menuitem" onClick={() => onPick(null)}>
      <span className="shell-palette-auto-chip"/>{automatic}</button> : null}
    <div className="shell-palette-heading">Theme Colors</div>
    <div className="shell-palette-theme">
      {THEME.map((base, i) => <div key={base} className="shell-palette-col">
        {swatch(base, THEME_NAMES[i])}
        <div className="shell-palette-variants">{variants(base).map(x => swatch(x.hex, `${THEME_NAMES[i]}, ${x.label}`))}</div>
      </div>)}
    </div>
    <div className="shell-palette-heading">Standard Colors</div>
    <div className="shell-palette-row">{STANDARD.map((hex, i) => swatch(hex, STANDARD_NAMES[i]))}</div>
    {recent.length ? <><div className="shell-palette-heading">Recent Colors</div><div className="shell-palette-row">{recent.map(hex => swatch(hex, hex))}</div></> : null}
    {onMore ? <button type="button" className="shell-palette-more" role="menuitem" onClick={onMore}><span className="shell-palette-wheel"/>More Colors…</button> : null}
    <div className="shell-palette-status" aria-live="polite">{hover ?? ' '}</div>
  </div>;
}

/** HSL helpers for the More Colors dialog. */
export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hex2rgb(/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000').map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}
export function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100, L = l / 100, k = (n: number) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgb2hex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
