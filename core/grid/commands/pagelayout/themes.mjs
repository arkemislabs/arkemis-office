// Page Layout > Themes: the workbook theme, its colour set and its font pair.
// Translated from gridcraft crates/engine/src/cmd/view.rs (`themes`, `theme`) and crates/model (`Theme`:
// twelve colour slots in Excel's order lt1 dk1 lt2 dk2 accent1-6 hlink folHlink, a major and a minor font)
// at fb1e59f: GridCraft's seven themes (Craft, Slate, Meadow, Ember, Ocean, Orchid, Graphite), which set
// the name and the twelve colours and leave the fonts alone. MIT, see assets/third-party-licenses/
// artcraft-reference.txt. Excel's own Office colour sets, font pairs and the two Office themes are kept
// as well (files saved with them, and Excel's gallery).
//
// A theme is stored on the workbook (content.theme {name, colors, majorFont, minorFont}); every
// theme colour of a cell, shape or chart follows it.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {bad} from '../../lib/data-common.mjs';
import {DEFAULT_THEME} from '../../model/style.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/view.rs']};

/** GridCraft's own themes (`themes()`): name to the twelve slots (0xRRGGBB). */
export const GRIDCRAFT_THEMES = Object.freeze({
  Craft: [0xFFFFFF, 0x000000, 0xE8E8E8, 0x0E2841, 0x156082, 0xE97132, 0x196B24, 0x0F9ED5, 0xA02B93, 0x4EA72E, 0x467886, 0x96607D],
  Slate: [0xFFFFFF, 0x1F2328, 0xEEF1F4, 0x3B4652, 0x4F6D8A, 0x8AA1B8, 0xC27C4C, 0x6F9A72, 0x9D6C9B, 0xD3B25A, 0x2F6FB0, 0x7A5C8F],
  Meadow: [0xFFFFFF, 0x16241A, 0xEEF4EA, 0x2E4A33, 0x4D8B3F, 0x9BC53D, 0xE4B33A, 0x2E8C83, 0xC4643C, 0x7B6A9E, 0x2B7A57, 0x6E7F3A],
  Ember: [0xFFFFFF, 0x2A1A14, 0xF6EEE8, 0x5A2E1E, 0xD9532B, 0xF2994A, 0xF2C94C, 0x8C3B2E, 0x4A6FA5, 0x6F8F4E, 0xB5472A, 0x8C6A5A],
  Ocean: [0xFFFFFF, 0x0B1E2D, 0xE8F1F7, 0x123A5A, 0x1F78B4, 0x33A6CC, 0x52C7B8, 0x3B5BA5, 0xF2A65A, 0x8E6CB8, 0x1A6FA8, 0x6A7FB0],
  Orchid: [0xFFFFFF, 0x24152B, 0xF3EDF6, 0x4B2C5E, 0x8E44AD, 0xC56CF0, 0xF78FB3, 0x3DC1D3, 0xF5CD79, 0x63CDDA, 0x7E3FA0, 0xB066B0],
  Graphite: [0xFFFFFF, 0x111111, 0xEDEDED, 0x333333, 0x595959, 0x7F7F7F, 0xA5A5A5, 0x3C78D8, 0xCC4125, 0x6AA84F, 0x3C78D8, 0x8E7CC3],
});
/** Colour sets: name to the twelve slots (0xRRGGBB). */
export const COLOR_SETS = Object.freeze({
  ...GRIDCRAFT_THEMES,
  'Office 2013 - 2022': [0xFFFFFF, 0x000000, 0xE7E6E6, 0x44546A, 0x4472C4, 0xED7D31, 0xA5A5A5, 0xFFC000, 0x5B9BD5, 0x70AD47, 0x0563C1, 0x954F72],
  'Office 2007 - 2010': [0xFFFFFF, 0x000000, 0xEEECE1, 0x1F497D, 0x4F81BD, 0xC0504D, 0x9BBB59, 0x8064A2, 0x4BACC6, 0xF79646, 0x0000FF, 0x800080],
});
/** Font pairs: name to [heading font, body font]. */
export const FONT_PAIRS = Object.freeze({
  Office: ['Calibri Light', 'Calibri'], 'Office 2007 - 2010': ['Cambria', 'Calibri'], Calibri: ['Calibri', 'Calibri'], Arial: ['Arial', 'Arial'],
});
/** Whole themes: a colour set with a font pair. */
export const THEMES = Object.freeze({
  ...Object.fromEntries(Object.keys(GRIDCRAFT_THEMES).map(n => [n, {colors: n, fonts: null}])),
  'Office 2013 - 2022': {colors: 'Office 2013 - 2022', fonts: 'Office'},
  'Office 2007 - 2010': {colors: 'Office 2007 - 2010', fonts: 'Office 2007 - 2010'},
});

const current = ctx => ctx.doc.theme ?? DEFAULT_THEME;
const tiles = (names, active) => names.map(n => ({id: n, label: n, value: n, selected: n === active}));
const pick = (map, name, cmd) => { const hit = Object.keys(map).find(k => k.toLowerCase() === String(name).toLowerCase()); if (!hit) throw bad(cmd, `unknown \`${name}\` (${Object.keys(map).join(', ')})`); return hit; };

/** Writes the theme; `fonts` null keeps the workbook's fonts (GridCraft's themes change the colours only). */
function setTheme(ctx, name, colors, fonts) {
  const t = current(ctx);
  setIn(ctx.change, ['theme'], {...t, name, colors: [...colors], majorFont: fonts ? fonts[0] : t.majorFont, minorFont: fonts ? fonts[1] : t.minorFont});
}
const HEX = /^#?[0-9a-f]{6}$/i;

export default defineCommands({
  family: 'pagelayout/themes',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'pageLayout.theme', label: 'Themes', risk: 'edit',
      description: `Apply a theme (colours and fonts): ${Object.keys(THEMES).join(', ')}.`,
      params: s.object({name: s.string({min: 1, max: 80}), colors: s.optional(s.array(s.string({max: 9}), {min: 12, max: 12})), majorFont: s.optional(s.string({max: 100})), minorFont: s.optional(s.string({max: 100}))}),
      state: ctx => ({...hasDoc(ctx), value: hasDoc(ctx).enabled ? tiles(Object.keys(THEMES), current(ctx).name) : []}),
      run: (ctx, p) => {
        // gridcraft `theme`: the name picks the palette unless twelve colours are given; the fonts change only when named.
        let colors = null;
        if (p.colors) { if (!p.colors.every(c => HEX.test(c))) throw bad('pageLayout.theme', 'colors are twelve hex values'); colors = p.colors.map(c => parseInt(c.replace('#', ''), 16)); }
        const n = colors ? p.name : pick(THEMES, p.name, 'pageLayout.theme');
        const fonts = THEMES[n]?.fonts ? FONT_PAIRS[THEMES[n].fonts] : null;
        const t = current(ctx);
        setTheme(ctx, n, colors ?? COLOR_SETS[THEMES[n].colors], p.majorFont || p.minorFont ? [p.majorFont ?? fonts?.[0] ?? t.majorFont, p.minorFont ?? fonts?.[1] ?? t.minorFont] : fonts);
        return {theme: n};
      },
    },
    {
      id: 'pageLayout.themeColors', label: 'Colors', risk: 'edit',
      description: `Apply a colour set: ${Object.keys(COLOR_SETS).join(', ')}; or twelve hex colours (colors, in the order lt1 dk1 lt2 dk2 accent1-6 hlink folHlink) under a name (Customize Colors).`,
      params: s.object({name: s.optional(s.string({min: 1, max: 80})), colors: s.optional(s.array(s.string({max: 9}), {min: 12, max: 12}))}),
      state: ctx => ({...hasDoc(ctx), value: hasDoc(ctx).enabled ? tiles(Object.keys(COLOR_SETS), current(ctx).name) : []}),
      run: (ctx, p) => {
        const t = current(ctx);
        // gridcraft `theme_colors`: {name: a theme name | colors: [12 hex]}.
        if (p.colors) {
          if (!p.colors.every(c => HEX.test(c))) throw bad('pageLayout.themeColors', 'colors are twelve hex values');
          const name = String(p.name ?? 'Custom').trim() || 'Custom';
          setTheme(ctx, name, p.colors.map(c => parseInt(c.replace('#', ''), 16)), [t.majorFont, t.minorFont]);
          return {colors: name};
        }
        if (!p.name) throw bad('pageLayout.themeColors', 'give a colour set `name` or twelve `colors`');
        const n = pick(COLOR_SETS, p.name, 'pageLayout.themeColors');
        setTheme(ctx, n, COLOR_SETS[n], [t.majorFont, t.minorFont]);
        return {colors: n};
      },
    },
    {
      id: 'pageLayout.themeFonts', label: 'Fonts', risk: 'edit',
      description: `Apply a font pair: ${Object.keys(FONT_PAIRS).join(', ')}; or a heading font (major) and a body font (minor) (Customize Fonts).`,
      params: s.object({name: s.optional(s.string({min: 1, max: 80})), major: s.optional(s.string({min: 1, max: 100})), minor: s.optional(s.string({min: 1, max: 100}))}),
      state: ctx => ({...hasDoc(ctx), value: hasDoc(ctx).enabled ? tiles(Object.keys(FONT_PAIRS), Object.keys(FONT_PAIRS).find(k => FONT_PAIRS[k][1] === current(ctx).minorFont && FONT_PAIRS[k][0] === current(ctx).majorFont) ?? null) : []}),
      run: (ctx, p) => {
        const t = current(ctx);
        // gridcraft `theme_fonts`: {major, minor}.
        if (p.major || p.minor) { setTheme(ctx, t.name, t.colors, [p.major ?? t.majorFont, p.minor ?? t.minorFont]); return {fonts: [p.major ?? t.majorFont, p.minor ?? t.minorFont]}; }
        if (!p.name) throw bad('pageLayout.themeFonts', 'give a font pair `name`, or `major` and `minor`');
        const n = pick(FONT_PAIRS, p.name, 'pageLayout.themeFonts');
        setTheme(ctx, t.name, t.colors, FONT_PAIRS[n]);
        return {fonts: n};
      },
    },
  ],
});
