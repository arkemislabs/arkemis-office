// Shape Format › WordArt Styles: the styles gallery, Text Fill, Text Outline and Text Effects › Transform.
//
// Translated from wordcraft crates/engine/src/cmd/wordart.rs (`wordArt.style`, `wordArt.textFill`,
// `wordArt.textOutline`, `wordArt.transform`, and `text_effects`, `apply`, `box_story`, `parse_fill`,
// `parse_outline`, `warp_target`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// The effects are run properties (`textEffects`); with a shape selected or the caret in a text box they apply to
// the whole box's text, as WordArt is formatted. A Transform is the shape's text warp (`extra.warp`). Text Effects ›
// Shadow, Glow and Reflection are Home › Font's `format.textEffects`; Bevel and 3-D Rotation have no engine upstream
// and stay hidden.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {parseRgb} from '../model/props.mjs';
import {THEME_COLORS} from '../model/content.mjs';
import {BODY} from '../model/document.mjs';
import {artStyle, ART_STYLES, sanitizedTextEffects, textEffectsIsEmpty, defaultTextOutline, defaultReflection, sanitizedTextFill, textWarp, setWarpAdj, DRAWN_WARPS, WARP_PRESETS, MAX_STOPS} from '../model/wordart.mjs';
import {selectedIn, editAt, finish, open, ready, disabled} from '../lib/object-edit.mjs';
import {applyChar} from '../lib/format-target.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {parseShadow, parseGlow} from './objects/shape.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/wordart.rs']};
const NO_TARGET = 'select a shape or WordArt first';
const COLOR = s.string({min: 1, max: 16});
const bad = m => new CommandError('invalid_params', m);
const themeOf = d => (d.c.settings?.themeColors?.length ? d.c.settings.themeColors : THEME_COLORS);

/** The text box story the effects format as a whole: the selected shape's, or the one the caret is in (box_story). */
function boxStory(S) {
  const hit = selectedIn(S.d, S.sel);
  if (hit?.obj?.type === 'shape' && hit.obj.story != null && S.d.c.parts[hit.obj.story]?.kind === 'textBox') return hit.obj.story;
  const st = S.sel.focus.story;
  const collapsed = S.sel.anchor.off === S.sel.focus.off && S.sel.anchor.path.join('.') === S.sel.focus.path.join('.') && S.sel.anchor.story === S.sel.focus.story;
  return st !== BODY && collapsed && S.d.c.parts[st]?.kind === 'textBox' ? st : null;
}
const targetState = ctx => ready(ctx);

function parseFill(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  // The palette's No Color arrives as `auto`: hollow text.
  if (v === 'none' || /^auto(matic)?$/i.test(String(v))) return {type: 'none'};
  if (typeof v === 'string') { const c = parseRgb(v); if (!c) throw bad('`fill`: a colour, "none", an object or null'); return {type: 'solid', color: c, transparency: 0}; }
  if (typeof v === 'object' && Array.isArray(v.gradient)) {
    const cols = v.gradient.filter(x => typeof x === 'string').map(parseRgb).filter(Boolean).slice(0, MAX_STOPS);
    const n = Math.max(cols.length, 2) - 1;
    return sanitizedTextFill({type: 'gradient', stops: cols.map((color, i) => ({pos: (100 * i) / n, color, transparency: 0})), angle: Number.isFinite(v.angle) ? v.angle : 90});
  }
  if (typeof v === 'object') { const c = parseRgb(v.color); if (!c) throw bad('`fill`: a colour, "none", an object or null'); return {type: 'solid', color: c, transparency: Number.isFinite(v.transparency) ? v.transparency : 0}; }
  throw bad('`fill`: a colour, "none", an object or null');
}
/** What an outline request changes: undefined (nothing), null (taken off: the run's own look) or the fields set (a weight alone keeps the colour). */
function parseOutline(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string') {
    if (/^auto(matic)?$/i.test(v)) return null;
    if (/^none$/i.test(v)) return {color: null};
    const c = parseRgb(v);
    if (!c) throw bad('`outline`: a colour');
    return {color: c};
  }
  if (typeof v === 'object') {
    const out = {};
    if (v.color !== undefined) out.color = v.color === null || /^none$/i.test(String(v.color)) ? null : parseRgb(v.color) ?? defaultTextOutline().color;
    if (Number.isFinite(v.width)) out.width = v.width;
    if (Number.isFinite(v.transparency)) out.transparency = v.transparency;
    return out;
  }
  throw bad('`outline`: a colour, "none", an object or null');
}

function parseReflection(v) {
  if (v === undefined) return undefined;
  if (v === null || v === 'none' || v === false) return null;
  if (v === true) return defaultReflection();
  if (typeof v === 'object') return {...defaultReflection(), ...['transparency', 'size', 'distance', 'blur'].reduce((o, k) => (Number.isFinite(v[k]) ? {...o, [k]: v[k]} : o), {})};
  throw bad('`reflection`: true, "none", an object or null');
}

/** text_effects: the style, the fill, outline, shadow, glow and reflection, on every run of the target (a text box's whole text, or the selection / the caret's typing). */
function textEffects(ctx, p) {
  const S = open(ctx);
  const theme = themeOf(S.d);
  const accent = theme[4] ?? [0x15, 0x60, 0x82];
  const style = p.style === undefined ? undefined : artStyle(p.style, theme) ?? (() => { throw bad('unknown WordArt style `' + p.style + '`'); })();
  const fill = parseFill(p.fill), outline = parseOutline(p.outline), shadow = parseShadow(p.shadow), glow = parseGlow(p.glow, accent), refl = parseReflection(p.reflection);
  const f = c => {
    let fx = p.clear ? {} : {...(c.textEffects ?? {})};
    // What a file held as raw markup goes when the effects are changed here.
    delete fx.xml;
    if (style) fx = {...style};
    if (fill !== undefined) { if (fill === null) delete fx.fill; else fx.fill = fill; }
    if (outline !== undefined) { if (outline === null) delete fx.outline; else fx.outline = {...defaultTextOutline(), ...(fx.outline ?? {}), ...outline}; }
    if (shadow !== undefined) { if (shadow === null) delete fx.shadow; else fx.shadow = shadow; }
    if (glow !== undefined) { if (glow === null) delete fx.glow; else fx.glow = glow; }
    if (refl !== undefined) { if (refl === null) delete fx.reflection; else fx.reflection = refl; }
    const eff = sanitizedTextEffects(fx);
    const out = {...c};
    if (textEffectsIsEmpty(eff)) delete out.textEffects; else out.textEffects = eff;
    return out;
  };
  const story = boxStory(S);
  if (story !== null) {
    S.d.formatRange(S.d.startOf(story), S.d.endOf(story), f);
    return finish(ctx, S, {edit: true});
  }
  // The selection, or the typing at a caret (Home › Text Effects).
  return applyChar(ctx, f);
}

/** The shape a Transform applies to: the selected one, or the one whose text box the caret is in (warp_target). */
function warpTarget(S) {
  const hit = selectedIn(S.d, S.sel);
  if (hit?.obj?.type === 'shape') return hit.pos;
  const st = S.sel.focus.story;
  if (st === BODY || S.d.c.parts[st]?.kind !== 'textBox') return null;
  const at = S.d.textBoxAnchor(st);
  return at && at.off > 0 ? {...at, off: at.off - 1} : null;
}
const warpState = ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try { return warpTarget(open(ctx)) ? {enabled: true} : {enabled: false, reason: NO_TARGET}; } catch { return {enabled: false, reason: NO_TARGET}; }
};

function transform(ctx, p) {
  const S = open(ctx);
  let warp = null;
  if (p.preset !== 'none') {
    warp = textWarp(p.preset);
    if (!warp) throw bad(`unknown text warp \`${p.preset}\``);
    if (Number.isFinite(p.adj)) warp = setWarpAdj(warp, 'adj', Math.max(-1e12, Math.min(1e12, p.adj)));
  }
  const pos = warpTarget(S);
  if (!pos) throw disabled(NO_TARGET);
  const next = editAt(S, pos, o => {
    if (o?.type !== 'shape') throw disabled(NO_TARGET);
    const extra = {...(o.extra ?? {})};
    if (warp) extra.warp = warp; else delete extra.warp;
    const out = {...o};
    if (Object.keys(extra).length) out.extra = extra; else delete out.extra;
    return out;
  });
  return finish(ctx, S, {edit: true, result: {transform: warp?.preset ?? null, object: next}});
}

/**
 * insert.wordArt (Insert › Text › WordArt): a floating text box without fill or line, its text in a WordArt style (and optionally bent),
 * centred on the column at the caret's paragraph; its text is selected so typing replaces it (wordart.rs `insert`).
 */
function insertWordArt(ctx, p) {
  const S = T.open(ctx);
  const theme = themeOf(S.d);
  const raw = [...String(p.text ?? 'Your text here')].filter(c => c.charCodeAt(0) >= 32).slice(0, 1000).join('');
  const text = raw.trim() ? raw : 'Your text here';
  const style = p.style ?? 'solid';
  const fx = artStyle(style, theme);
  if (!fx) throw bad('unknown WordArt style `' + style + '`');
  const warp = p.transform && p.transform !== 'none' ? textWarp(p.transform) ?? (() => { throw bad('unknown text warp `' + p.transform + '`'); })() : null;
  const size = 36;
  // A box the text fits on one line in (with the box's margins); a bent one is taller.
  const sect = S.d.sections()[0]?.[1];
  const col = sect ? Math.max(sect.pageW - sect.marginLeft - sect.marginRight - sect.gutter, 72) : 468;
  const w = Math.min(Math.max([...text].length * size * 0.58 + 24, 72), col);
  let h = size * 1.35 + 7.2;
  if (warp) h = warp.preset === 'textCircle' ? w : warp.preset === 'textArchUp' || warp.preset === 'textArchDown' ? w * 0.5 : h * 1.6;
  const id = S.d.tryAddPart('textBox', [P.paragraphWithText(text, {}, S.d.newId())]);
  // Its text: bold, 36 pt, centred, in the style.
  const para = S.d.para(id, S.d.paraPaths(id)[0]);
  const mut = S.d.paraMut(id, S.d.paraPaths(id)[0]);
  void para;
  mut.runs = mut.runs.map(r => ({...r, props: {...(r.props ?? {}), size, bold: true, textEffects: fx}}));
  mut.props = {...(mut.props ?? {}), align: 'center'};
  const obj = {type: 'shape', kind: 'textBox', w, h: Math.min(Math.max(h, 18), 2000), fill: null, stroke: null, strokeWidth: 0, story: id,
    float: {...P.defaultFloat(), wrap: 'inFrontOfText', hRel: 'margin', hAlign: 'center', vRel: 'paragraph'}, ...(warp ? {extra: {warp}} : {})};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  S.d.insertObject(at, obj, props);
  S.sel = {anchor: S.d.startOf(id), focus: S.d.endOf(id)};
  S.cells = null;
  T.finish(S);
  return {story: id};
}

/** The WordArt styles with the effects each one gives, for the gallery tiles. */
const galleryItems = d => ART_STYLES.map(([id, label]) => ({id, label, value: id, art: {kind: 'wordArt', effects: artStyle(id, themeOf(d))}, iconOnly: false}));

export default defineCommands({
  family: 'wordart',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'format.textEffects', label: 'Text Effects', risk: 'edit',
      state: ctx => { const st = ready(ctx); if (!st.enabled) return st; try { return {...st, value: galleryItems(open(ctx).d)}; } catch { return st; } },
      description: 'Text Effects and Typography (Home › Font) and Shape Format › WordArt Styles: `style` solid, outlined, hollow, gradient, shadowed, glowing, reflected or sunset, `clear`, `fill` RRGGBB, "none", {color, transparency?} or {gradient: [RRGGBB, …], angle?} or null, `outline` RRGGBB, "none", {color?, width?, transparency?} or null, `shadow` a preset or {color?, transparency?, blur?, distance?, angle?} or null, `glow` points or {color?, size?, transparency?} or null, `reflection` true, "none", {transparency?, size?, distance?, blur?} or null; an omitted key stays; the selection (or a text box\'s whole text).',
      params: s.object({style: s.optional(s.enum(ART_STYLES.map(x => x[0]))), clear: s.optional(s.boolean()), fill: s.optional(s.nullable(s.any())), color: s.optional(s.nullable(COLOR)),
        outline: s.optional(s.nullable(s.any())), shadow: s.optional(s.nullable(s.any())), glow: s.optional(s.nullable(s.any())), reflection: s.optional(s.nullable(s.any()))}),
      // The palette sends `color`: a fill (Automatic: the text\'s colour).
      run: (ctx, p) => textEffects(ctx, {...p, ...(p.color !== undefined && p.fill === undefined ? {fill: /^auto(matic)?$/i.test(String(p.color)) ? null : p.color} : {})})},
    {id: 'insert.wordArt', label: 'WordArt', risk: 'edit',
      state: ctx => { const st = ready(ctx); if (!st.enabled) return st; try { return {...st, value: galleryItems(open(ctx).d)}; } catch { return st; } },
      description: 'WordArt (Insert › Text): a floating text box without fill or outline at the caret, its text (`text`, default "Your text here") in a WordArt `style` and optionally bent (`transform`); the text is selected so typing replaces it.',
      params: s.object({text: s.optional(s.string({max: 4000})), style: s.optional(s.enum(ART_STYLES.map(x => x[0]))), transform: s.optional(s.enum([...WARP_PRESETS, 'none']))}),
      run: insertWordArt},
    {id: 'wordArt.style', label: 'WordArt Styles', risk: 'edit',
      state: ctx => { const st = targetState(ctx); if (!st.enabled) return st; try { return {...st, value: galleryItems(open(ctx).d)}; } catch { return st; } },
      description: 'WordArt Styles (Shape Format): `style` solid, outlined, hollow, gradient, shadowed, glowing, reflected or sunset in theme colours, on the whole text of the selected shape or text box.',
      params: s.object({style: s.optional(s.enum(ART_STYLES.map(x => x[0])))}),
      run: (ctx, p) => textEffects(ctx, {style: p.style ?? 'solid'})},
    {id: 'wordArt.textFill', label: 'Text Fill', risk: 'edit', state: targetState,
      description: 'Text Fill (Shape Format › WordArt Styles): `fill` RRGGBB, "none" (hollow), {gradient: [RRGGBB, …], angle?} or null (the run\'s colour); `color` is the same as a colour fill.',
      params: s.object({fill: s.optional(s.nullable(s.any())), color: s.optional(s.nullable(COLOR))}),
      // The palette's No Color arrives as `auto`: hollow text.
      run: (ctx, p) => textEffects(ctx, {fill: p.fill !== undefined ? p.fill : p.color !== undefined ? (/^auto(matic)?$/i.test(String(p.color)) ? 'none' : p.color) : null})},
    {id: 'wordArt.textOutline', label: 'Text Outline', risk: 'edit', state: targetState,
      description: 'Text Outline (Shape Format › WordArt Styles): `color` RRGGBB (null: none) and `width` points, or {outline: "none"} to take it off.',
      params: s.object({color: s.optional(s.nullable(COLOR)), width: s.optional(s.number({min: 0, max: 20})), outline: s.optional(s.nullable(s.any()))}),
      // The palette's Automatic arrives as `auto`: no outline set.
      run: (ctx, p) => textEffects(ctx, {outline: p.outline !== undefined ? p.outline : /^auto(matic)?$/i.test(String(p.color)) ? null : {...(p.color !== undefined ? {color: p.color} : {}), ...(p.width !== undefined ? {width: p.width} : {})}})},
    {id: 'wordArt.transform', label: 'Transform', risk: 'edit',
      state: ctx => { const st = warpState(ctx); return st.enabled ? {...st, value: [{id: 'none', label: 'No Transform', value: 'none'}, ...DRAWN_WARPS.map(([id, label]) => ({id, label, value: id}))]} : st; },
      description: 'Transform (Shape Format › WordArt Styles › Text Effects): bend the shape\'s text along `preset` (textArchUp, textArchDown, textCircle, textWave1, … any DrawingML preset warp) or straighten it with "none".',
      params: s.object({preset: s.enum([...WARP_PRESETS, 'none']), adj: s.optional(s.number())}),
      run: transform},
  ],
});
