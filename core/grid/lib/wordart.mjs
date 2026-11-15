// WordArt styles for a sheet's text objects (Insert > Text > WordArt): fill, outline and shadow in the workbook's theme colours.
// Not checked against upstream (gridcraft has no WordArt): the fifteen styles follow the layout of Excel's gallery (three rows of five:
// solid fills with shadow, fills with outline, gradient fills). `artEffects` gives a style's effects the way the ribbon's tile art
// and the sheet painter read them: fill {type: solid|gradient|none, color|stops}, outline {color, width}, shadow, glow (RGB triples).
// No DOM, no Node built-ins.

/** Theme slots in a workbook theme's colour list (lt1 dk1 lt2 dk2 accent1-6 hlink folHlink). */
const SLOT = {light1: 0, dark1: 1, light2: 2, dark2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9};

/** [id, label] in gallery order. */
export const WORDART_STYLES = Object.freeze([
  ['black-shadow', 'Fill: Black, Text color 1; Shadow'],
  ['accent1-shadow', 'Fill: Blue, Accent color 1; Shadow'],
  ['accent2-outline', 'Fill: Orange, Accent color 2; Outline: Orange, Accent color 2'],
  ['white-outline-shadow', 'Fill: White; Outline: Blue, Accent color 1; Shadow'],
  ['accent4-fill', 'Fill: Gold, Accent color 4; Soft Bevel'],
  ['gray-gradient', 'Gradient Fill: Gray; Outline: Gray'],
  ['accent1-gradient', 'Gradient Fill: Blue, Accent color 1; Outline: Blue, Accent color 1'],
  ['accent4-gradient', 'Gradient Fill: Gold, Accent color 4; Outline: Gold, Accent color 4'],
  ['black-hard-shadow', 'Fill: Black, Text color 1; Outline: White, Background color 1; Hard Shadow: Blue, Accent color 1'],
  ['accent1-hard-shadow', 'Fill: Blue, Accent color 1; Outline: White, Background color 1; Hard Shadow: Blue, Accent color 1'],
  ['accent2-hard-shadow', 'Fill: Orange, Accent color 2; Outline: White, Background color 1; Hard Shadow: Orange, Accent color 2'],
  ['outline-dark', 'Fill: White; Outline: Black, Text color 1'],
  ['accent3-fill', 'Fill: Green, Accent color 3; Shadow'],
  ['accent6-outline', 'Fill: White; Outline: Green, Accent color 6; Glow'],
  ['dark2-fill', 'Fill: Dark Blue, Text color 2; Shadow'],
].map(Object.freeze));
export const WORDART_IDS = Object.freeze(WORDART_STYLES.map(s => s[0]));
export const DEFAULT_WORDART = 'accent1-shadow';

const rgb = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (c, to, f) => c.map((v, i) => Math.round(v + (to[i] - v) * f));

/** The effects of a style in the colours of `theme` (a list of twelve 0xRRGGBB, as the workbook keeps it); null for an unknown id. */
export function artEffects(id, theme) {
  const c = name => rgb((theme ?? [])[SLOT[name]] ?? [0xFFFFFF, 0x000000, 0xE8E8E8, 0x0E2841, 0x156082, 0xE97132, 0x196B24, 0x0F9ED5, 0xA02B93, 0x4EA72E][SLOT[name]]);
  const solid = color => ({type: 'solid', color});
  const grad = (a, b) => ({type: 'gradient', stops: [{pos: 0, color: a}, {pos: 100, color: b}]});
  const line = (color, width) => ({color, width});
  const soft = {blur: 3, dist: 2, alpha: 0.5};
  const hard = {blur: 0, dist: 3, alpha: 1};
  switch (id) {
    case 'black-shadow': return {fill: solid(c('dark1')), shadow: soft};
    case 'accent1-shadow': return {fill: solid(c('accent1')), shadow: soft};
    case 'accent2-outline': return {fill: solid(c('accent2')), outline: line(c('accent2'), 1)};
    case 'white-outline-shadow': return {fill: solid(c('light1')), outline: line(c('accent1'), 1.25), shadow: soft};
    case 'accent4-fill': return {fill: solid(c('accent4')), outline: line(mix(c('accent4'), [0, 0, 0], 0.25), 0.5)};
    case 'gray-gradient': return {fill: grad([0xD9, 0xD9, 0xD9], [0x7F, 0x7F, 0x7F]), outline: line([0x7F, 0x7F, 0x7F], 1)};
    case 'accent1-gradient': return {fill: grad(mix(c('accent1'), [255, 255, 255], 0.45), c('accent1')), outline: line(c('accent1'), 1)};
    case 'accent4-gradient': return {fill: grad(mix(c('accent4'), [255, 255, 255], 0.45), c('accent4')), outline: line(c('accent4'), 1)};
    case 'black-hard-shadow': return {fill: solid(c('dark1')), outline: line(c('light1'), 1), shadow: {...hard, color: c('accent1')}};
    case 'accent1-hard-shadow': return {fill: solid(c('accent1')), outline: line(c('light1'), 1), shadow: {...hard, color: c('accent1')}};
    case 'accent2-hard-shadow': return {fill: solid(c('accent2')), outline: line(c('light1'), 1), shadow: {...hard, color: c('accent2')}};
    case 'outline-dark': return {fill: solid(c('light1')), outline: line(c('dark1'), 1.25)};
    case 'accent3-fill': return {fill: solid(c('accent3')), shadow: soft};
    case 'accent6-outline': return {fill: solid(c('light1')), outline: line(c('accent6'), 1.25), glow: {color: c('accent6'), size: 6}};
    case 'dark2-fill': return {fill: solid(c('dark2')), shadow: soft};
    default: return null;
  }
}
