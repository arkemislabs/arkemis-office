// Design tab (U:quill/design): themes, style sets, theme colours and fonts, paragraph spacing,
// font scaling, effects, watermark, page colour and page borders, over the schema-2 model.
//
// Translated from wordcraft crates/engine/src/cmd/design.rs (`THEMES`, `specs`, `set_fonts`,
// `set_accent`, `theme`, `style_set`, `para_spacing`, `scale_font_sizes`, `watermark`,
// `page_borders`) and the Design tab's Effects button from crates/engine/src/cmd/tools/specs.rs:366
// (`design.effects`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Each command is one undoable op on the document's styles and settings. The page view reads
// them: styles reflow the text, `settings.pageColor` paints the paper, `settings.watermark` is
// drawn behind every page's text, and a section's `pageBorders` are laid out as rules around its
// pages (core/quill/layout/page.mjs pageBorderRules).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {open, finish, ready, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {builtinStyleSheet, HEADING_FONT, BODY_FONT, HEADING_BLUE} from '../model/styles.mjs';
import {parseRgb, rgbHex, border as mkBorder, bordersBox, bordersAnyVisible, BORDER_STYLES, DEFAULT_FONT_SIZE} from '../model/props.mjs';
import {defaultWatermark} from '../model/content.mjs';
import {bytesOf, base64Encode, imageExt, probe} from '../lib/insert-objects.mjs';
import {sectionOf} from '../model/section.mjs';
import {borderSides} from './para.mjs';
import {sectionIndexAt} from './page.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/design.rs', 'crates/engine/src/cmd/tools/specs.rs']};

const params = (msg, data) => new CommandError('invalid_params', msg, data);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = c => [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];

/** Our own themes: [name, heading font, body font, six accent colours] (THEMES). */
export const THEMES = Object.freeze([
  ['Craft', HEADING_FONT, BODY_FONT, ['156082', 'E97132', '196B24', '0F9ED5', 'A02B93', '4EA72E']],
  ['Studio', 'Georgia', 'Georgia', ['8C2F39', 'C98B2E', '3E5C76', '6B8F71', '9A6FB0', '4A4A4A']],
  ['Gallery', 'Helvetica Neue', 'Helvetica Neue', ['222222', 'E63946', '457B9D', '1D3557', 'A8DADC', 'F4A261']],
  ['Atelier', 'Palatino', 'Palatino', ['6D597A', 'B56576', 'E56B6F', 'EAAC8B', '355070', '8E9AAF']],
  ['Darkroom', 'Futura', 'Avenir Next', ['264653', '2A9D8F', 'E9C46A', 'F4A261', 'E76F51', '5E548E']],
  ['Sketchbook', 'Gill Sans', 'Gill Sans', ['588157', '3A5A40', 'A3B18A', 'DAD7CD', '344E41', 'BC6C25']],
].map(([name, h, b, accents]) => Object.freeze([name, h, b, Object.freeze(accents.map(hex))])));
export const THEME_NAMES = Object.freeze(THEMES.map(t => t[0]));

export const STYLE_SETS = Object.freeze(['default', 'basic', 'lines', 'shaded', 'casual', 'centered', 'minimalist', 'title']);
export const PARAGRAPH_SPACINGS = Object.freeze({
  default: [0, 8, 1.15], none: [0, 0, 1], compact: [0, 4, 1], tight: [0, 6, 1.15], open: [0, 10, 1.15], relaxed: [0, 6, 1.5], double: [0, 8, 2],
});
/** Word's watermark gallery (Design › Watermark). */
export const WATERMARKS = Object.freeze(['DRAFT', 'CONFIDENTIAL', 'DO NOT COPY', 'SAMPLE', 'ASAP', 'URGENT']);
export const EFFECTS = Object.freeze(['Office', 'Subtle Solids', 'Banded Edge', 'Smokey Glass', 'Glow Edge', 'Grunge Texture', 'Frosted Glass',
  'Top Shadow', 'Inset', 'Milk Glass', 'Riblet', 'Reflection', 'Extreme Shadow', 'Glossy', 'Subtle']);

const findTheme = name => THEMES.find(t => t[0].toLowerCase() === String(name).toLowerCase()) ?? null;

/** Run an edit of the styles and settings as one command (sel_result). */
function designEdit(ctx, f) {
  const S = open(ctx);
  const result = f(S.d, S);
  return finish(ctx, S, {edit: true, result: result ?? undefined});
}

const ownStyles = d => d.updateField('styles', sh => ({...sh, defaultChr: {...(sh.defaultChr ?? {})}, defaultPara: sh.defaultPara,
  styles: sh.styles.map(st => ({...st, chr: st.chr ? {...st.chr} : st.chr, para: st.para ? {...st.para} : st.para}))}));

/** set_fonts: the theme fonts, the default font, and every style's font onto heading / body. */
function setFonts(d, heading, body) {
  d.updateField('settings', st => { st.majorFont = heading; st.minorFont = body; });
  const sh = ownStyles(d);
  sh.defaultChr.font = body;
  for (const st of sh.styles) {
    const f = st.chr?.font;
    if (f !== undefined && f !== null && (f === HEADING_FONT || st.id.startsWith('Heading') || st.id === 'Title')) st.chr.font = heading;
    else if (f !== undefined && f !== null && f !== heading) st.chr.font = body;
  }
}

/** set_accent: Heading 1–5 and the intense styles take the accent (their lines too); accent1 is it. */
function setAccent(d, accent) {
  const sh = ownStyles(d);
  for (const st of sh.styles) {
    const heading15 = /^Heading[1-5]$/.test(st.id);
    if (heading15 || st.id === 'IntenseQuote' || st.id === 'IntenseEmphasis' || st.id === 'IntenseReference') {
      st.chr = {...(st.chr ?? {}), color: {Rgb: [...accent]}};
      if (st.para?.borders) {
        const b = {...st.para.borders};
        for (const k of ['top', 'bottom']) if (b[k]) b[k] = {...b[k], color: [...accent]};
        st.para.borders = b;
      }
    }
  }
  d.updateField('settings', st => {
    const colors = (st.themeColors ?? []).map(c => [...c]);
    if (colors.length > 4) colors[4] = [...accent];
    st.themeColors = colors;
  });
}

function theme(ctx, p) {
  const t = findTheme(p.name);
  if (!t) throw params(`unknown theme \`${p.name}\``, {path: '/name'});
  return designEdit(ctx, d => {
    setFonts(d, t[1], t[2]);
    setAccent(d, t[3][0]);
    d.updateField('settings', st => {
      st.themeName = t[0];
      const colors = (st.themeColors ?? []).map(c => [...c]);
      t[3].forEach((c, i) => { if (4 + i < colors.length) colors[4 + i] = [...c]; });
      st.themeColors = colors;
    });
  });
}

function styleSet(ctx, p) {
  const name = p.name;
  return designEdit(ctx, d => {
    const accent = d.settings.themeColors?.[4] ? [...d.settings.themeColors[4]] : [...HEADING_BLUE];
    const fresh = builtinStyleSheet();
    const line = mkBorder('single', 0.75, accent, 1);
    for (const st of fresh.styles) {
      const heading = st.id.startsWith('Heading') || st.id === 'Title';
      st.chr = {...st.chr}; st.para = {...st.para};
      if (name === 'basic' && heading) { st.chr.color = {Rgb: [0x26, 0x26, 0x26]}; st.chr.bold = true; }
      else if (name === 'lines' && (st.id === 'Heading1' || st.id === 'Title')) st.para.borders = {bottom: {...line}};
      else if (name === 'shaded' && st.id === 'Heading1') { st.para.shading = [...accent]; st.chr.color = {Rgb: [255, 255, 255]}; }
      else if (name === 'casual' && heading) st.chr.italic = true;
      else if (name === 'centered' && heading) st.para.align = 'center';
      else if (name === 'minimalist' && heading) { st.chr.caps = true; st.chr.spacing = 1; st.chr.color = {Rgb: [0x40, 0x40, 0x40]}; }
      else if (name === 'title' && st.id === 'Title') st.chr.size = 36;
    }
    // Overlay the set onto the document's sheet: every other style, the latent styles and the
    // document defaults stay as they are (no set defines its own defaults).
    d.updateField('styles', sh => {
      const styles = sh.styles.slice();
      for (const st of fresh.styles) {
        const i = styles.findIndex(x => x.id === st.id);
        if (i < 0) { styles.push(st); continue; }
        const old = styles[i];
        const next = {...st};
        for (const k of ['default', 'locked', 'builtin']) { if (k in old) next[k] = old[k]; else delete next[k]; }
        styles[i] = next;
      }
      return {...sh, styles};
    });
    setFonts(d, d.settings.majorFont ?? HEADING_FONT, d.settings.minorFont ?? BODY_FONT);
    setAccent(d, accent);
    d.updateField('settings', st => { st.styleSet = name; });
  });
}

function paragraphSpacing(ctx, p) {
  const [before, after, line] = PARAGRAPH_SPACINGS[p.value] ?? PARAGRAPH_SPACINGS.default;
  return designEdit(ctx, d => {
    d.updateField('styles', sh => ({...sh, defaultPara: {...sh.defaultPara, spaceBefore: before, spaceAfter: after, lineSpacing: {rule: 'multiple', value: line}}}));
  });
}

/**
 * Grow or shrink every style's font size at once. Only explicit style sizes change (including
 * table style parts); styles that inherit one follow, and runs keep their direct formatting.
 */
function scaleFontSizes(ctx, p) {
  const delta = p.delta, percent = p.percent;
  if ((delta === undefined) === (percent === undefined)) throw params('give exactly one of `delta` (points) or `percent`');
  if ((delta !== undefined && (!(delta >= -1638 && delta <= 1638) || delta === 0)) || (percent !== undefined && (!(percent >= -99 && percent <= 1000) || percent === 0))) {
    throw params('`delta` must be non-zero within ±1638 pt and `percent` non-zero within -99..1000');
  }
  const factor = 1 + (percent ?? 0) / 100;
  const scale = sz => Math.round(clamp(sz * factor + (delta ?? 0), 1, 1638) * 2) / 2;
  const scaleChr = c => {
    if (!c) return c;
    const out = {...c};
    if (isNum(out.size)) out.size = scale(out.size);
    if (isNum(out.sizeCs)) out.sizeCs = scale(out.sizeCs);
    return out;
  };
  return designEdit(ctx, d => {
    d.updateField('styles', sh => {
      const defaultChr = {...sh.defaultChr, size: scale(isNum(sh.defaultChr?.size) ? sh.defaultChr.size : DEFAULT_FONT_SIZE)};
      if (isNum(sh.defaultChr?.sizeCs)) defaultChr.sizeCs = scale(sh.defaultChr.sizeCs);
      const styles = sh.styles.map(st => {
        const next = {...st, chr: scaleChr(st.chr)};
        if (st.table) {
          const t = {...st.table};
          for (const k of ['headerChr', 'bandChr', 'firstColChr', 'lastColChr', 'totalChr', 'colBandChr']) if (t[k]) t[k] = scaleChr(t[k]);
          if (t.regions) t.regions = Object.fromEntries(Object.entries(t.regions).map(([k, f]) => [k, {...f, chr: scaleChr(f.chr)}]));
          next.table = t;
        }
        return next;
      });
      return {...sh, defaultChr, styles};
    });
  });
}

function watermark(ctx, p) {
  return designEdit(ctx, d => {
    if (p.remove) { d.updateField('settings', st => { st.watermark = null; }); return {watermark: null}; }
    let wm = {...defaultWatermark(), ...(d.settings.watermark ?? {})};
    // Picture watermark (Word's Picture watermark: Select Picture, Scale, Washout): the picture is kept as media, drawn behind the text on every page.
    if (typeof p.image === 'string') {
      const bytes = bytesOf(p.image);
      const pr = probe(bytes);
      if (pr.refused || pr.notPicture || !pr.width || !pr.height) throw new CommandError('failed', pr.refused ?? 'not a supported image (PNG, JPEG, GIF, WebP, BMP)');
      const media = d.addMedia(base64Encode(bytes), imageExt(bytes));
      wm = {picture: {media, w: pr.width * 0.75, h: pr.height * 0.75}, text: '', font: wm.font, color: wm.color, diagonal: false, semitransparent: true, scale: 0, washout: true};
    } else if (wm.picture && p.text === undefined) {
      // Scale and Washout alone change the picture already there.
    } else if (wm.picture) { wm = {...defaultWatermark(), ...wm}; delete wm.picture; delete wm.scale; delete wm.washout; wm.text = defaultWatermark().text; }
    if (wm.picture) {
      if (typeof p.scale === 'number' && p.scale >= 0) wm.scale = Math.min(500, Math.round(p.scale));
      if (typeof p.washout === 'boolean') wm.washout = p.washout;
      d.updateField('settings', st => { st.watermark = wm; });
      return {watermark: wm};
    }
    if (typeof p.text === 'string') wm.text = [...p.text].slice(0, 200).join('');
    if (typeof p.diagonal === 'boolean') wm.diagonal = p.diagonal;
    if (typeof p.color === 'string') { const c = parseRgb(p.color); if (c) wm.color = c; }
    // Custom Watermark's Font and Semitransparent (Word's Printed Watermark; the text fills its box).
    if (typeof p.font === 'string' && p.font.trim()) wm.font = p.font.trim().slice(0, 200);
    if (typeof p.semitransparent === 'boolean') wm.semitransparent = p.semitransparent;
    d.updateField('settings', st => { st.watermark = wm; });
    return {watermark: wm};
  });
}

/** Page borders of the caret's section (or every section with `applyTo: "document"`). */
function pageBorders(ctx, p) {
  let borders;
  if (p.sides !== undefined) {
    borders = borderSides(p.sides, 24, 24);
    if (!bordersAnyVisible(borders)) borders = null;
  } else {
    const kind = p.kind ?? 'box';
    const width = clamp(p.width ?? 1, 0.25, 6);
    const color = typeof p.color === 'string' ? parseRgb(p.color) : null;
    const style = p.style ?? 'single';
    borders = kind !== 'none' ? bordersBox(mkBorder(style, width, color, 24)) : null;
  }
  return designEdit(ctx, (d, S) => {
    const ends = d.sections().map(([e]) => e);
    const blocks = p.applyTo === 'document' ? ends : [ends[sectionIndexAt(d, S.sel.focus)] ?? 0];
    for (const e of blocks) d.updateSection(e, cur => ({...sectionOf(cur), pageBorders: borders ? structuredClone(borders) : null}));
    return {pageBorders: borders};
  });
}

const st = ctx => ready(ctx);
const settingCheck = (ctx, test) => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  return {enabled: true, checked: !!test(ctx.doc.settings ?? {})};
};

export default defineCommands({
  family: 'design',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'design.theme', label: 'Themes', risk: 'edit',
      description: `Themes (Design › Themes): ${THEME_NAMES.join(', ')} — the theme fonts and colours, and the headings' accent.`,
      params: s.object({name: s.string({min: 1, max: 64})}),
      state: (ctx, p) => (p?.name ? settingCheck(ctx, x => String(x.themeName ?? '').split(' (')[0].toLowerCase() === String(p.name).toLowerCase()) : st(ctx)),
      run: theme,
    },
    {
      id: 'design.themes', label: 'Theme List', risk: 'read',
      description: 'The themes Design › Themes offers.',
      params: s.object({}), state: st,
      run: () => [...THEME_NAMES],
    },
    {
      id: 'design.themeFonts', label: 'Fonts', risk: 'edit',
      description: 'Fonts (Design › Document Formatting): the heading and body theme fonts; every style follows (body defaults to heading).',
      params: s.object({heading: s.string({min: 1, max: 200}), body: s.optional(s.string({min: 1, max: 200}))}),
      state: (ctx, p) => (p?.heading ? settingCheck(ctx, x => x.majorFont === p.heading && x.minorFont === (p.body ?? p.heading)) : st(ctx)),
      run: (ctx, p) => designEdit(ctx, d => { setFonts(d, p.heading, p.body ?? p.heading); }),
    },
    {
      id: 'design.themeColors', label: 'Colors', risk: 'edit',
      description: `Colors (Design › Document Formatting): a theme's colours (${THEME_NAMES.join(', ')}) as the accent of the headings and intense styles.`,
      params: s.object({name: s.string({min: 1, max: 64})}),
      state: (ctx, p) => {
        if (!p?.name) return st(ctx);
        const t = findTheme(p.name);
        return settingCheck(ctx, x => t && x.themeColors?.[4] && rgbHex(x.themeColors[4]) === rgbHex(t[3][0]));
      },
      run(ctx, p) {
        const t = findTheme(p.name);
        if (!t) throw params(`unknown colours \`${p.name}\``, {path: '/name'});
        return designEdit(ctx, d => { setAccent(d, t[3][0]); });
      },
    },
    {
      id: 'design.styleSet', label: 'Style Set', risk: 'edit',
      description: `Style Set (Design › Document Formatting): ${STYLE_SETS.join(', ')} — the built-in heading and title styles in that look, keeping the theme fonts and accent.`,
      params: s.object({name: s.enum(STYLE_SETS)}),
      state(ctx) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        return {enabled: true, value: STYLE_SETS.map(id => ({id, label: id === 'default' ? 'Default' : id[0].toUpperCase() + id.slice(1), value: id}))};
      },
      run: styleSet,
    },
    {
      id: 'design.paragraphSpacing', label: 'Paragraph Spacing', risk: 'edit',
      description: 'Paragraph Spacing (Design › Document Formatting): default, none, compact, tight, open, relaxed or double — the document default space before/after and line spacing.',
      params: s.object({value: s.enum(Object.keys(PARAGRAPH_SPACINGS))}),
      state(ctx, p) {
        if (!p?.value) return st(ctx);
        const r = ready(ctx);
        if (!r.enabled) return r;
        const dp = ctx.doc.styles?.defaultPara ?? {};
        const [b, a, l] = PARAGRAPH_SPACINGS[p.value] ?? [];
        return {enabled: true, checked: (dp.spaceBefore ?? 0) === b && (dp.spaceAfter ?? 0) === a && dp.lineSpacing?.rule === 'multiple' && dp.lineSpacing?.value === l};
      },
      run: paragraphSpacing,
    },
    {
      id: 'design.scaleFontSizes', label: 'Scale Font Sizes', risk: 'edit',
      description: 'Scale Font Sizes: every style\'s explicit size by `delta` points (±1638, not 0) or `percent` (-99..1000, not 0); exactly one.',
      params: s.object({delta: s.optional(s.number()), percent: s.optional(s.number())}),
      state: st,
      run: scaleFontSizes,
    },
    {
      id: 'design.effects', label: 'Effects', risk: 'edit',
      description: 'Effects (Design › Document Formatting): the theme\'s effect set (Subtle when none is named), recorded in the theme name.',
      params: s.object({name: s.optional(s.string({min: 1, max: 64}))}),
      state: st,
      run: (ctx, p) => designEdit(ctx, d => {
        d.updateField('settings', x => { x.themeName = `${String(x.themeName ?? 'Craft').split(' (')[0] || 'Craft'} (${p.name ?? 'Subtle'})`; });
        return {themeName: d.settings.themeName};
      }),
    },
    {
      id: 'design.watermark', label: 'Watermark', risk: 'edit',
      description: 'Watermark (Design › Page Background): text (up to 200 characters), diagonal or horizontal, color RRGGBB, font, semitransparent; or a picture (image: a data URI, scale: percent or 0 for Auto, washout); or remove. Drawn behind the text on every page.',
      params: s.object({
        text: s.optional(s.string({max: 1000})), remove: s.optional(s.boolean()), diagonal: s.optional(s.boolean()),
        color: s.optional(s.string({max: 32})), font: s.optional(s.string({max: 200})), semitransparent: s.optional(s.boolean()),
        image: s.optional(s.string({max: 8_000_000})), scale: s.optional(s.number()), washout: s.optional(s.boolean()),
      }),
      state(ctx, p) {
        if (!p || (p.text === undefined && !p.remove)) return st(ctx);
        return settingCheck(ctx, x => (p.remove ? !x.watermark : x.watermark?.text === p.text));
      },
      run: watermark,
    },
    {
      id: 'design.pageColor', label: 'Page Color', risk: 'edit',
      description: 'Page Color (Design › Page Background): the paper colour RRGGBB, or null / "auto" for none.',
      params: s.object({color: s.optional(s.nullable(s.string({max: 32})))}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const c = ctx.doc.settings?.pageColor;
        const value = c ? `#${rgbHex(c)}` : null;
        if (p && 'color' in p && p.color === null) return {enabled: true, checked: !c, value};
        return {enabled: true, value};
      },
      run: (ctx, p) => designEdit(ctx, d => {
        const c = typeof p.color === 'string' ? parseRgb(p.color) : null;
        d.updateField('settings', x => { x.pageColor = c; x.pagePicture = null; });
        return {pageColor: c ? rgbHex(c) : null};
      }),
    },
    {
      id: 'design.pageBorders', label: 'Page Borders', risk: 'edit', dialog: 'dialog.borders',
      description: 'Page Borders (Design › Page Background): kind box|none with width (0.25–6 pt), color RRGGBB and style; or `sides` {top|left|bottom|right: {style, width, color} | null} for exactly those sides; applyTo section (default) or document.',
      params: s.object({
        kind: s.optional(s.enum(['box', 'none'])), width: s.optional(s.number()), color: s.optional(s.string({max: 32})),
        style: s.optional(s.enum(BORDER_STYLES.filter(x => x !== 'none'))), sides: s.optional(s.record(s.any())),
        applyTo: s.optional(s.enum(['section', 'document'])),
      }),
      state: st,
      run: pageBorders,
    },
    {
      id: 'design.setDefault', label: 'Set as Default', risk: 'read',
      description: 'Set as Default (Design › Document Formatting): the current theme, style set and spacing become the default for new documents.',
      params: s.object({}), state: st,
      run(ctx) {
        // Upstream only reports it (status "These settings will be used for new documents.").
        const x = ctx.doc.settings ?? {};
        return {status: 'These settings will be used for new documents.', theme: x.themeName ?? 'Craft'};
      },
    },
  ],
});
