// Chart looks: the sixteen styles of Chart Design > Chart Styles, the six Quick Layouts and the Change Colors palettes.
// gridcraft stores `style` 1 to 16 on a chart, `chart.quickLayout` 1 to 6 (legend, data labels, gridlines and axis titles
// per layout) and `chart.changeColors` palettes (colorful, monochrome, accent1 to accent6) in cmd/extra/chart.rs
// (`quick_layout`, `change_colors`) at fb1e59f; it draws no difference between the sixteen styles. Here a style is a
// palette plus gridlines and data labels, so the gallery changes what the chart looks like. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

/** Quick Layout 1 to 6 (`quick_layout`): [legend, data labels, gridlines, axis titles]. */
export const QUICK_LAYOUTS = Object.freeze({
  1: ['right', false, true, false],
  2: ['top', true, false, false],
  3: ['bottom', false, true, false],
  4: ['bottom', true, false, false],
  5: ['none', false, true, true],
  6: ['right', false, true, true],
});

/** Change Colors palettes: name and label. */
export const PALETTES = Object.freeze([['colorful', 'Colorful'], ['monochrome', 'Monochrome'], ['accent1', 'Accent 1'], ['accent2', 'Accent 2'], ['accent3', 'Accent 3'],
  ['accent4', 'Accent 4'], ['accent5', 'Accent 5'], ['accent6', 'Accent 6']]);

/** A series colour of a palette: {theme, tint} (the tint in tenths of a percent as gridcraft keeps it, here a fraction), or null for the theme's own colour cycle. */
export function paletteColor(palette, i) {
  const clamp = v => Math.max(-0.8, Math.min(0.8, v));
  if (palette === 'monochrome') return {theme: 4, tint: clamp(-0.4 + i * 0.2)};
  const m = /^accent([1-6])$/.exec(palette ?? '');
  if (m) return {theme: 3 + Number(m[1]), tint: clamp(-0.5 + i * 0.25)};
  return null;
}

/** The sixteen chart styles: [palette, gridlines, data labels]. */
export const STYLES = Object.freeze([
  ['colorful', true, false], ['colorful', false, true], ['monochrome', true, false], ['accent2', true, false],
  ['accent3', true, false], ['accent4', true, false], ['accent5', true, false], ['accent6', true, false],
  ['colorful', false, false], ['monochrome', false, true], ['accent2', false, true], ['accent3', false, true],
  ['accent4', false, true], ['accent5', false, true], ['accent6', false, true], ['monochrome', false, false],
]);

/** The palette of a style number (1 to 16); style 1 and an unknown number are the theme's own colours. */
export const styleOf = n => STYLES[(Number.isInteger(n) ? Math.min(16, Math.max(1, n)) : 1) - 1];
