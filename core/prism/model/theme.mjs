// Themes: colour scheme, font scheme and format scheme (the fill/line/effect "style matrix"), and
// deckcraft's original built-in themes, colour, font and effect schemes.
// Translated from deckcraft crates/model/src/theme.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {fromHex, BLACK} from './color.mjs';
import {colorRgb, colorScheme, colorWith, fillSolid, lineSolid} from './style.mjs';

const hex = s => fromHex(s) ?? BLACK;
const scheme = (name, c) => ({name, colors: c.map(hex)});
const ph = () => colorScheme('phClr');

/** The typeface the theme font set gives `script` ("Arab"), if any. */
export const fontSetScript = (set, script) => (set?.scripts ?? []).find(f => f.script.toLowerCase() === script.toLowerCase() && f.typeface)?.typeface ?? null;

/** Resolve a theme font reference (`+mj-lt`, `+mn-ea`…) to a family name. */
export function themeFont(theme, name) {
  const f = theme?.fonts ?? {};
  switch (name) {
    case '+mj-lt': return f.major?.latin ?? '';
    case '+mn-lt': return f.minor?.latin ?? '';
    case '+mj-ea': return f.major?.ea ?? '';
    case '+mn-ea': return f.minor?.ea ?? '';
    case '+mj-cs': return f.major?.cs ?? '';
    case '+mn-cs': return f.minor?.cs ?? '';
    default: return name;
  }
}

const shadowOf = (blur, dist, alpha, align) => ({
  outerShadow: {color: colorWith(colorRgb(BLACK), {op: 'alpha', val: alpha}), blur, dist, dir: 90, inner: false, sx: 1, sy: 1, kx: 0, ky: 0, align, rotateWithShape: false},
});

/** Our default format scheme: flat solid fills, a soft gradient, and a gentle shadow for "intense". */
export function defaultFormat() {
  const grad = (a, b) => ({kind: 'gradient', stops: [
    {pos: 0, color: colorWith(colorWith(ph(), {op: 'lumMod', val: a}), {op: 'satMod', val: 103000})},
    {pos: 1, color: colorWith(ph(), {op: 'lumMod', val: b})},
  ], shape: {kind: 'linear', angle: 90, scaled: false}, rotateWithShape: true});
  return {
    name: 'Arkemis',
    fills: [fillSolid(ph()), grad(110000, 92000), grad(105000, 80000)],
    lines: [lineSolid(ph(), 0.75), lineSolid(ph(), 1), lineSolid(ph(), 1.5)],
    effects: [{}, {}, shadowOf(6, 3, 40000, 't')],
    bgFills: [fillSolid(ph()), fillSolid(colorWith(colorWith(ph(), {op: 'tint', val: 95000}), {op: 'satMod', val: 170000})), grad(102000, 85000)],
  };
}

/** Names older files gave the default theme, colour scheme and effect scheme (the project this model was translated from): read as ours, never written. */
const LEGACY_NAMES = Object.freeze({deckcraft: 'Arkemis'});
export const canonicalName = name => LEGACY_NAMES[String(name ?? '').toLowerCase()] ?? name;

/** Our original built-in themes (Design › Themes). Colours and names are deckcraft's own. */
export function builtinThemes() {
  const t = (name, colors, major, minor) => ({name, colors, fonts: {name, major: {latin: major, ea: '', cs: ''}, minor: {latin: minor, ea: '', cs: ''}}, format: defaultFormat()});
  return [
    t('Arkemis', scheme('Arkemis', ['000000', 'FFFFFF', '1E2B3C', 'EDEBE7', '2E6FD8', 'F26B1D', '2EA36F', '8A5CD8', 'D83F6B', 'E3B21C', '2E6FD8', '7A5BA6']), 'Inter', 'Inter'),
    t('Harbor', scheme('Harbor', ['0B1F2A', 'FFFFFF', '12384D', 'E4EEF2', '1B7FA6', '36B3A8', 'F2C14E', 'F78154', '5D576B', '8AA29E', '1B7FA6', '5D576B']), 'Merriweather', 'Open Sans'),
    t('Ember', scheme('Ember', ['1A1A1A', 'FFFCF7', '3D2B1F', 'F6EDE3', 'D9480F', 'F59F00', 'A61E4D', '5C940D', '1971C2', '862E9C', 'D9480F', '862E9C']), 'Montserrat', 'Lato'),
    t('Meadow', scheme('Meadow', ['14281D', 'FFFFFF', '2D4A37', 'EEF5EE', '4C9A2A', 'A4C639', '2F6F4E', 'E9B44C', '9B2915', '50A2A7', '2F6F4E', '9B2915']), 'Merriweather', 'Open Sans'),
    t('Nocturne', scheme('Nocturne', ['FFFFFF', '121826', 'F2F4F8', '1E2638', '7C5CFF', '00C2A8', 'FF6B9A', 'FFC53D', '4DA3FF', 'B2F35F', '7C5CFF', 'FF6B9A']), 'Inter', 'Inter'),
    t('Paper', scheme('Paper', ['262626', 'FFFFFF', '404040', 'F2F2F2', '595959', '8C8C8C', 'C0504D', '4F81BD', '9BBB59', 'F79646', '4F81BD', '8064A2']), 'Playfair Display', 'Lato'),
    t('Coral Reef', scheme('Coral Reef', ['0F2A33', 'FFFFFF', '0E4D64', 'FDF1EC', 'FF6F59', '254441', '43AA8B', 'B2B09B', 'EF3054', '3F88C5', '3F88C5', 'EF3054']), 'Poppins', 'Nunito Sans'),
    t('Slate', scheme('Slate', ['111827', 'FFFFFF', '374151', 'F3F4F6', '6366F1', '0EA5E9', '10B981', 'F59E0B', 'EF4444', '8B5CF6', '6366F1', '8B5CF6']), 'Roboto', 'Roboto'),
  ];
}
/** `Theme::default()`: the first built-in theme. */
export const defaultTheme = () => builtinThemes()[0];

/**
 * Design › Variants: four colour variations of `t` (built from its built-in colours when it is a
 * built-in theme). 1: as designed; 2 and 3: the accents rotated; 4: dark (light/dark swapped).
 */
export function themeVariants(t) {
  const base = builtinThemes().find(b => b.name === canonicalName(t.name))?.colors ?? t.colors;
  const rotate = by => {
    const accents = base.colors.slice(4, 10);
    const colors = base.colors.slice();
    for (let i = 0; i < 6; i++) colors[4 + i] = accents[(i + by) % Math.max(accents.length, 1)];
    return {...base, colors};
  };
  const darkColors = base.colors.slice();
  [darkColors[0], darkColors[1]] = [darkColors[1], darkColors[0]];
  [darkColors[2], darkColors[3]] = [darkColors[3], darkColors[2]];
  const out = [{...base}, rotate(1), rotate(3), {...base, colors: darkColors}];
  return out.map((c, i) => (i === 0 ? c : {...c, name: `${base.name} ${i + 1}`}));
}

/** Named colour schemes for Design › Variants › Colors. */
export function builtinColorSchemes() {
  return [...builtinThemes().map(t => t.colors),
    scheme('Grayscale', ['000000', 'FFFFFF', '000000', 'F8F8F8', 'DDDDDD', 'B2B2B2', '969696', '808080', '5F5F5F', '4D4D4D', '5F5F5F', '919191']),
    scheme('Ocean', ['000000', 'FFFFFF', '13293D', 'E8F1F2', '006494', '247BA0', '1B98E0', '6CC1E8', '13293D', '0B3954', '1B98E0', '6CC1E8']),
    scheme('Sunset', ['2B2118', 'FFFFFF', '6F1A07', 'FFF3E6', 'FF9F1C', 'FFBF69', 'CB997E', 'E76F51', 'F4A261', '2A9D8F', 'E76F51', '2A9D8F']),
    scheme('Forest', ['1B1B1B', 'FFFFFF', '283618', 'FEFAE0', '606C38', 'DDA15E', 'BC6C25', '283618', '8A9A5B', '4F772D', '606C38', 'BC6C25']),
    scheme('Berry', ['1F0A1D', 'FFFFFF', '4A1942', 'F7E8F3', '893168', 'C6426E', 'EB6A8F', '4A1942', '7D7ABC', '56A3A6', '893168', '56A3A6'])];
}

/** Named font pairs for Design › Variants › Fonts. */
export function builtinFontSchemes() {
  const f = (name, major, minor) => ({name, major: {latin: major, ea: '', cs: ''}, minor: {latin: minor, ea: '', cs: ''}});
  return [f('Inter', 'Inter', 'Inter'), f('Classic', 'Merriweather', 'Open Sans'), f('Geometric', 'Montserrat', 'Lato'), f('Editorial', 'Playfair Display', 'Lato'),
    f('Humanist', 'Merriweather', 'Open Sans'), f('Friendly', 'Poppins', 'Nunito Sans'), f('Neutral', 'Roboto', 'Roboto'), f('Office Compatible', 'Carlito', 'Carlito'),
    f('Times / Arial', 'Liberation Serif', 'Liberation Sans')];
}

/** Named effect schemes for Design › Effects (each replaces the theme's format scheme). */
export function builtinFormatSchemes() {
  const glow = radius => ({glow: {color: colorWith(ph(), {op: 'alpha', val: 60000}), radius}});
  const sh = (b, d, a) => shadowOf(b, d, a, 'b');
  const soft = {...defaultFormat(), name: 'Soft', lines: [lineSolid(ph(), 0.5), lineSolid(ph(), 0.75), lineSolid(ph(), 1)], effects: [sh(16, 1, 18000), sh(12, 2, 22000), sh(10, 3, 28000)]};
  const crisp = {...defaultFormat(), name: 'Crisp', fills: [fillSolid(ph()), fillSolid(ph()), fillSolid(ph())],
    lines: [lineSolid(ph(), 1), lineSolid(ph(), 1.5), lineSolid(ph(), 2.25)], effects: [{}, {}, sh(0, 2, 55000)]};
  const lift = {...defaultFormat(), name: 'Lift', effects: [{}, sh(8, 6, 28000), sh(12, 10, 35000)]};
  const glowScheme = {...defaultFormat(), name: 'Glow', effects: [{}, glow(6), glow(12)]};
  const plain = {...defaultFormat(), name: 'Plain', fills: [fillSolid(ph()), fillSolid(ph()), fillSolid(ph())],
    lines: [lineSolid(ph(), 0.75), lineSolid(ph(), 0.75), lineSolid(ph(), 0.75)], effects: [{}, {}, {}]};
  return [defaultFormat(), soft, crisp, lift, glowScheme, plain];
}
