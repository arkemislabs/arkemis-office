// Design tab: Themes (gallery, Browse for Themes), Variants (the four colour variations, Colors,
// Fonts, Effects, Background Styles), Slide Size, Format Background (solid, gradient, picture,
// pattern, a background style, Hide Background Graphics, Apply to All, Reset), Design Ideas.
//
// Translated from deckcraft crates/engine/src/cmd/design.rs (`theme`, `browse_theme`,
// `apply_master`, `matching_layout`), design/colors.rs (`colors`, `variant`, `variants`, `fonts`,
// `effects`, `next_scheme`, `next_font_scheme`), design/slide_background.rs (`background`,
// `hide_bg_graphics`, `apply_picture_props`), design/slide_setup.rs (`slide_size`, `scale_shapes`),
// cmd/ideas.rs (`ideas_for`, `apply_idea`) and crates/ui-egui/src/ribbon/design.rs (the tab's
// galleries and menus) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Targets: the Slides target (the current slide's own background; Apply to All also sets the
// master the slides use). Master, layout, handout and notes backgrounds belong to the Slide Master
// view, which is not translated here.

import {defineCommands} from '../../kernel/command.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2, allocIds} from '../model/doc.mjs';
import {fieldText, fromMillis, isDateField, DATE_KINDS} from '../lib/insert-datetime.mjs';
import {SLIDE_SIZES} from '../model/defaults.mjs';
import {builtinThemes, themeVariants, builtinColorSchemes, builtinFontSchemes, builtinFormatSchemes, canonicalName} from '../model/theme.mjs';
import {css, fromHex, hex as hexOf, THEME_SLOTS, schemeGet, schemeSet, rgb as mkRgb} from '../model/color.mjs';
import {resolveColor, colorScheme, colorRgb, colorWith, fillSolid} from '../model/style.mjs';
import {formatAll} from '../model/edit.mjs';
import {importTheme, importPptx} from '../formats/pptx-read.mjs';
import {isTitlePh, isFooterPh, masterFor, defaultHeaderFooter} from '../model/presentation.mjs';
import {bodyFromText, bodyText} from '../model/text.mjs';
import {bad, hasDoc, hasSlide, selectionOf, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {colorValue, gradientParam, mediaBytes, contentType, addMedia, pictureAdjustDefault, base64Decode, newId, clamp} from '../lib/shape-common.mjs';
import {ideasFor, applyIdea} from '../lib/ideas.mjs';
import {shape as newShapeObj} from '../model/presentation.mjs';
import {applyLayout, idHolder} from './slide.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/design.rs', 'crates/engine/src/cmd/design/colors.rs', 'crates/engine/src/cmd/design/slide_background.rs',
  'crates/engine/src/cmd/design/slide_setup.rs', 'crates/engine/src/cmd/ideas.rs', 'crates/ui-egui/src/ribbon/design.rs', 'crates/ui-egui/src/panels/background.rs']};
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The master the current slide uses (deckcraft `master_index`, Target::Slides). */
export function masterIndexOf(doc, slide) {
  const i = slide ? (doc.masters ?? []).findIndex(m => (m.layouts ?? []).some(l => l.id === slide.layout)) : -1;
  return i < 0 ? 0 : i;
}
/** The open master view's background target ({path, bg}), or null on the slides: a layout, the slide master, the handout or notes master. */
export function masterBackgroundTarget(ctx) {
  const m = ctx.view?.master;
  if (!m) return null;
  if (m.kind === 'handout') return {path: ['handoutMaster', 'background'], bg: ctx.doc.handoutMaster?.background ?? null};
  if (m.kind === 'notes') return {path: ['notesMaster', 'background'], bg: ctx.doc.notesMaster?.background ?? null};
  const master = ctx.doc.masters?.[m.master];
  if (m.layout !== null && m.layout !== undefined) return {path: ['masters', m.master, 'layouts', m.layout, 'background'], bg: master?.layouts?.[m.layout]?.background ?? null};
  return {path: ['masters', m.master, 'background'], bg: master?.background ?? null};
}

const masterOf = ctx => {
  const sel = selectionOf(ctx);
  const open = ctx.view?.master;
  const mi = open?.kind === 'slide' && ctx.doc.masters?.[open.master] ? open.master : masterIndexOf(ctx.doc, sel.slide);
  return {mi, master: ctx.doc.masters?.[mi] ?? null, sel};
};

// ---------------------------------------------------------------------------------------------
// What the galleries and menus show (drawn by the shell from `art`)

const hexes = c => c.colors.map(x => css(x));
/** The picture of a theme tile (paint_theme_tile): Aa in the dark text colour on the light colour, six accents below. */
export const themeArt = th => ({kind: 'theme', bg: css(schemeGet(th.colors, 'lt1')), fg: css(schemeGet(th.colors, 'dk1')), accents: hexes(th.colors).slice(4, 10), font: th.fonts?.major?.latin ?? ''});

/** The theme gallery: every built-in theme, the current one marked. */
export function themeItems(ctx) {
  const {master} = masterOf(ctx);
  const cur = canonicalName(master?.theme?.name ?? '');
  return builtinThemes().map(t => ({id: t.name, label: t.name, value: t.name, selected: t.name === cur, art: themeArt(t)}));
}
/** The variant gallery: the current theme in its four colour variations, the one in use marked. */
export function variantItems(ctx) {
  const {master} = masterOf(ctx);
  if (!master) return [];
  const th = master.theme;
  const cur = th.colors.colors.map(x => hexOf(x)).join();
  return themeVariants(th.colors ? th : th).map((c, i) => ({id: String(i), label: c.name, value: i, selected: c.colors.map(x => hexOf(x)).join() === cur, art: themeArt({...th, colors: c})}));
}
const colorRows = ctx => {
  const {master} = masterOf(ctx);
  const cur = master?.theme?.colors?.name ?? '';
  return builtinColorSchemes().map(c => ({id: c.name, label: c.name, value: c.name, checked: c.name === cur, art: {kind: 'colors', colors: hexes(c).slice(2, 10)}}));
};
const fontRows = ctx => {
  const {master} = masterOf(ctx);
  const cur = master?.theme?.fonts?.name ?? '';
  return builtinFontSchemes().map(f => ({id: f.name, label: `${f.name}`, value: f.name, checked: f.name === cur, art: {kind: 'fonts', major: f.major.latin, minor: f.minor.latin}}));
};
const effectArt = f => {
  const e = f.effects?.[2]?.outerShadow, g = f.effects?.[2]?.glow, line = f.lines?.[1]?.width ?? 1;
  return {kind: 'effect', line, shadow: e ? {blur: e.blur ?? 0, dist: e.dist ?? 0, alpha: (e.color?.mods ?? []).reduce((a, m) => (m.op === 'alpha' ? m.val / 100000 : a), 1)} : null, glow: g ? g.radius ?? 6 : null,
    flat: (f.fills ?? []).every(x => x?.kind === 'solid')};
};
const effectRows = ctx => {
  const {master} = masterOf(ctx);
  const cur = master?.theme?.format;
  return builtinFormatSchemes().map(f => ({id: f.name, label: f.name, value: f.name, checked: !!cur && same(cur, f), art: effectArt(f)}));
};

/** The twelve Background Styles: three background fills of the theme (as Office lists them) by four colours. */
const BG_SLOTS = ['bg1', 'bg2', 'tx2', 'tx1'];
export function bgStyleItems(ctx) {
  const {master} = masterOf(ctx);
  if (!master) return [];
  const th = master.theme;
  const items = [];
  for (let i = 0; i < 12; i++) {
    const group = Math.floor(i / 4);
    const ph = resolveColor(colorScheme(BG_SLOTS[i % 4]), th.colors, null);
    const f = th.format?.bgFills?.[group] ?? fillSolid(colorScheme('phClr'));
    const col = c => css(resolveColor(c, th.colors, ph));
    const art = f.kind === 'gradient' ? {kind: 'bgstyle', stops: f.stops.map(st => [st.pos, col(st.color)]), angle: f.shape?.angle ?? 90}
      : {kind: 'bgstyle', color: f.kind === 'solid' ? col(f.color) : css(ph)};
    items.push({id: String(i + 1), label: `Style ${i + 1}`, value: i + 1, art});
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Colours, fonts, effects

const SLOT_KEYS = new Set(THEME_SLOTS);
/** `parse_color_slots`: the twelve stored slots only, each `#RRGGBB`. */
function colorSlots(v) {
  if (v === undefined) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('design.colors', '`colors` must be an object');
  const keys = Object.keys(v);
  if (!keys.length) throw bad('design.colors', '`colors` is empty');
  return keys.map(k => {
    if (!SLOT_KEYS.has(k)) throw bad('design.colors', Object.hasOwn({bg1: 1, bg2: 1, tx1: 1, tx2: 1}, k) ? `\`${k}\` is not a theme colour` : `unknown colour \`${k}\``);
    const c = typeof v[k] === 'string' ? fromHex(v[k]) : null;
    if (!c) throw bad('design.colors', `\`${k}\` needs a colour like #RRGGBB`);
    return [k, c];
  });
}
/** `next_scheme`: a built-in `name` first, then `colors` laid over it; `Custom` when only colours come. */
export function nextScheme(current, given, slots) {
  let next = current;
  if (given !== null) {
    const builtin = builtinColorSchemes().find(c => c.name.toLowerCase() === String(canonicalName(given)).toLowerCase());
    if (builtin) next = builtin;
    else if (!slots) throw bad('design.colors', `no colour scheme \`${given}\``);
    next = {...next, name: given};
  }
  if (slots) {
    for (const [k, c] of slots) next = schemeSet(next, k, c);
    if (given === null) next = {...next, name: 'Custom'};
  }
  return next;
}
const face = (key, v) => {
  if (v === undefined) return null;
  if (typeof v !== 'string') throw bad('design.fonts', `\`${key}\` must be a string`);
  if (!v.trim()) throw bad('design.fonts', `\`${key}\` is empty`);
  return v.trim();
};
/** `next_font_scheme`: a built-in `name` first, then `major` / `minor` replace the Latin faces only. */
export function nextFontScheme(current, given, major, minor) {
  let next = structuredClone(current);
  if (given !== null) {
    const builtin = builtinFontSchemes().find(f => f.name.toLowerCase() === given.toLowerCase());
    if (builtin) next = structuredClone(builtin);
    if (!builtin && major === null && minor === null) throw bad('design.fonts', `no font scheme \`${given}\``);
    if (major !== null || minor !== null || !builtin) next.name = given;
  }
  if (given === null) {
    if (major !== null) { next.major = {...next.major, latin: major}; if (minor === null) next.minor = {...next.minor, latin: major}; }
    if (minor !== null) next.minor = {...next.minor, latin: minor};
    next.name = 'Custom';
  } else {
    if (major !== null) next.major = {...next.major, latin: major};
    if (minor !== null) next.minor = {...next.minor, latin: minor};
  }
  return next;
}

const nameParam = (cmd, v) => {
  if (v === undefined) return null;
  if (typeof v !== 'string') throw bad(cmd, '`name` must be a string');
  if (!v.trim()) throw bad(cmd, 'name is empty');
  return v.trim();
};

// ---------------------------------------------------------------------------------------------
// Slide size (slide_setup.rs)

/** `scale_shapes`: a shape's box scaled by (sx, sy) and moved by (ox, oy); its text sizes by `k`. */
export function scaleShapes(shapes, sx, sy, k, ox, oy) {
  return (shapes ?? []).map(sh => {
    let n = sh;
    if (sh.xfrm) n = {...n, xfrm: {...sh.xfrm, x: sh.xfrm.x * sx + ox, y: sh.xfrm.y * sy + oy, w: sh.xfrm.w * sx, h: sh.xfrm.h * sy}};
    if (sh.text) n = {...n, text: formatAll(sh.text, r => { if (typeof r.size === 'number') r.size = Math.max(r.size * k, 1); return r; })};
    return n;
  });
}
export function slideSizeFor(p) {
  let w, h;
  if (typeof p.preset === 'string') {
    const k = p.preset.toLowerCase();
    const found = SLIDE_SIZES.find(([l]) => l.toLowerCase().startsWith(k) || l.toLowerCase().includes(k));
    if (!found) throw bad('design.slideSize', `unknown preset \`${p.preset}\``);
    [, w, h] = found;
  } else {
    if (typeof p.w !== 'number') throw bad('design.slideSize', 'missing `w`');
    if (typeof p.h !== 'number') throw bad('design.slideSize', 'missing `h`');
    w = clamp(p.w, 72, 4032); h = clamp(p.h, 72, 4032);
  }
  if (p.orientation === 'portrait' && w > h) [w, h] = [h, w];
  else if (p.orientation === 'landscape' && h > w) [w, h] = [h, w];
  return {width: w, height: h};
}

// ---------------------------------------------------------------------------------------------
// Backgrounds (slide_background.rs)

const bgOf = (doc, slide) => slide?.background ?? null;
const usedMasters = doc => {
  const out = new Set();
  for (const sl of doc.slides ?? []) { if (doc.masters?.length) out.add(masterIndexOf(doc, sl)); }
  return [...out];
};
function setTransparency(c, t) {
  const mods = (c.mods ?? []).filter(m => m.op !== 'alpha');
  const tt = clamp(t, 0, 1);
  if (tt > 0) mods.push({op: 'alpha', val: Math.round((1 - tt) * 100000)});
  const out = {...c, mods};
  if (!mods.length) delete out.mods;
  return out;
}
/** Picture-fill options for Format Background (tile, offsets, scale, alignment, mirror, stretch). */
export function applyPictureProps(pfIn, pp) {
  const pf = structuredClone(pfIn);
  const f = k => (typeof pp[k] === 'number' && Number.isFinite(pp[k]) ? pp[k] : null);
  if (typeof pp.rotateWithShape === 'boolean') pf.upright = !pp.rotateWithShape;
  if (pp.tile === true && pf.mode?.kind !== 'tile') pf.mode = {kind: 'tile', tx: 0, ty: 0, sx: 1, sy: 1, flip: 'none', align: 'tl'};
  else if (pp.tile === false && pf.mode?.kind !== 'stretch') pf.mode = {kind: 'stretch', fillRect: [0, 0, 0, 0]};
  const m = pf.mode;
  if (m?.kind === 'tile') {
    if (f('offsetX') !== null) m.tx = clamp(f('offsetX'), -4000, 4000);
    if (f('offsetY') !== null) m.ty = clamp(f('offsetY'), -4000, 4000);
    if (f('scaleX') !== null) m.sx = clamp(f('scaleX'), 0.01, 10);
    if (f('scaleY') !== null) m.sy = clamp(f('scaleY'), 0.01, 10);
    if (['none', 'x', 'y', 'xy'].includes(pp.mirror)) m.flip = pp.mirror;
    if (['tl', 't', 'tr', 'l', 'ctr', 'r', 'bl', 'b', 'br'].includes(pp.align)) m.align = pp.align;
  } else if (m?.kind === 'stretch' && Array.isArray(pp.stretch)) {
    pp.stretch.slice(0, 4).forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) m.fillRect[i] = clamp(v, -10, 0.99); });
  }
  return pf;
}
const bgFill = bg => (bg?.kind === 'fill' ? bg.fill : null);
const setPictureTransparency = (pf, t) => { const a = 1 - clamp(t, 0, 1); return {...pf, alpha: a < 1 ? a : null}; };
const adjustBackground = (bg, props, t) => {
  const f = bgFill(bg);
  if (f?.kind === 'picture') {
    let pf = f;
    if (props) pf = applyPictureProps(pf, props);
    if (t !== null) pf = setPictureTransparency(pf, t);
    return {kind: 'fill', fill: pf};
  }
  if (f?.kind === 'solid' && t !== null) return {kind: 'fill', fill: {...f, color: setTransparency(f.color, t)}};
  return bg;
};

/** The background the slide has now as Format Background's `Apply to All` re-applies it (command params), or null. */
export function currentBackgroundParams(bg) {
  const f = bgFill(bg);
  if (!f) return null;
  if (f.kind === 'solid') return {color: colorToParam(f.color)};
  if (f.kind === 'gradient') return {gradient: gradientToParam(f)};
  if (f.kind === 'pattern') return {pattern: {preset: f.preset, fg: colorToParam(f.fg), bg: colorToParam(f.bg)}};
  return null;
}
/** A ColorRef as the command parameter colorValue reads (cref_param): {rgb | scheme | preset | system+last, <transform>: value}. */
export function colorToParam(c) {
  const b = c?.base ?? {};
  const out = b.kind === 'scheme' ? {scheme: b.slot} : b.kind === 'preset' ? {preset: b.name} : b.kind === 'system' ? {system: b.name, last: hexOf(b.last)} : {rgb: hexOf(b.rgb ?? {r: 0, g: 0, b: 0})};
  for (const m of c?.mods ?? []) out[m.op] = m.val ?? 0;
  return out;
}
/** A gradient fill as `gradient_json` writes it: stops [[pos, colour]…] with the kind and angle. */
export function gradientToParam(g) {
  const sh = g.shape ?? {kind: 'linear', angle: 90};
  const out = {stops: g.stops.map(st => [st.pos, colorToParam(st.color)])};
  if (sh.kind === 'path') { out.kind = sh.path === 'circle' ? 'radial' : sh.path === 'rect' ? 'rectangular' : 'path'; out.focus = sh.focus; } else { out.kind = 'linear'; out.angle = sh.angle ?? 90; }
  out.rotateWithShape = false;
  return out;
}


// ---------------------------------------------------------------------------------------------
// Header and Footer (slide_setup.rs header_footer)

export const dateKind = f => (DATE_KINDS.includes(f) ? f : 'datetime1');
export const dateNow = (ctx, format) => fieldText(dateKind(format), null, fromMillis(ctx.host?.now?.() ?? Date.now())) ?? '';
const phKindOf = sh => sh.ph?.kind ?? null;
export const fieldRun = (text, field, props) => ({text, ...(props ? {props} : {}), kind: {kind: 'field', field}});
const bodyOfRun = (run, base) => ({...(base ?? {body: {}}), paragraphs: [{level: 0, runs: [run]}]});

/** Point a slide's date placeholder at a fixed date (its own plain text) or, for an empty `fixed`, at an automatic date field (one it already has keeps its format). */
function setDate(ctx, sh, fixed, format) {
  const runs = (sh.text?.paragraphs ?? []).flatMap(p => p.runs ?? []);
  const fieldNow = runs.find(r => r.kind?.kind === 'field' && isDateField(r.kind.field))?.kind.field ?? null;
  const hasField = fieldNow !== null;
  const props = runs[0]?.props;
  const want = dateKind(format);
  let run;
  if (fixed === '') {
    if (fieldNow === want) return sh;
    if (hasField && format === '') return sh;
    run = fieldRun(dateNow(ctx, format), want, props);
  } else {
    if (!hasField && sh.text && bodyText(sh.text) === fixed) return sh;
    run = {text: fixed, ...(props ? {props} : {})};
  }
  return {...sh, text: bodyOfRun(run, sh.text)};
}

function headerFooter(ctx, p) {
  const hf = {...defaultHeaderFooter(), ...(ctx.doc.headerFooter ?? {})};
  if (typeof p.date === 'boolean') hf.date = p.date;
  if (typeof p.dateText === 'string') hf.dateText = p.dateText;
  if (typeof p.dateFormat === 'string') {
    // Refused rather than ignored: a format that renders nothing would leave the placeholder showing its saved text for ever.
    if (!DATE_KINDS.includes(p.dateFormat)) throw bad('design.headerFooter', 'dateFormat: one of datetime1…datetime13', {path: '/dateFormat'});
    hf.dateFormat = p.dateFormat;
  }
  if (typeof p.slideNumber === 'boolean') hf.slideNumber = p.slideNumber;
  if (typeof p.footer === 'boolean') hf.footer = p.footer;
  if (typeof p.footerText === 'string') { hf.footerText = p.footerText; hf.footer = hf.footer || p.footerText !== ''; }
  if (typeof p.hideOnTitle === 'boolean') hf.hideOnTitle = p.hideOnTitle;
  const dateGiven = typeof p.dateText === 'string', formatGiven = typeof p.dateFormat === 'string';
  const all = p.all !== false;
  const sel = selectionOf(ctx);
  const doc = ctx.doc;
  const list = all ? doc.slides.map((_, i) => i) : [sel.slideIndex];
  const ids = list.length ? allocIds(ctx, list.length * 3) : [];
  ctx.change.set(['headerFooter'], hf);
  list.forEach((i, li) => {
    const slide = doc.slides[i];
    const lay = masterFor(doc, slide)?.[1] ?? null;
    const isTitle = lay?.kind === 'title';
    const want = k => !(hf.hideOnTitle && isTitle) && (k === 'date' ? hf.date : k === 'slideNum' ? hf.slideNumber : k === 'footer' ? hf.footer : false);
    let shapes = [...(slide.shapes ?? [])];
    ['date', 'footer', 'slideNum'].forEach((k, n) => {
      const pos = shapes.findIndex(x => phKindOf(x) === k);
      const w = want(k);
      if (pos >= 0 && !w) { shapes.splice(pos, 1); return; }
      if (pos < 0 && w) {
        const lp = (lay?.shapes ?? []).find(x => phKindOf(x) === k);
        if (!lp) return;
        let text;
        if (k === 'slideNum') text = {body: {}, paragraphs: [{level: 0, runs: [fieldRun('‹#›', 'slidenum')]}]};
        else if (k === 'date' && hf.dateText === '') text = {body: {}, paragraphs: [{level: 0, runs: [fieldRun(dateNow(ctx, hf.dateFormat), dateKind(hf.dateFormat))]}]};
        else if (k === 'date') text = bodyFromText(hf.dateText);
        else text = bodyFromText(hf.footerText);
        shapes.push({...newShapeLike(ids[li * 3 + n], lp.name, structuredClone(lp.ph)), text});
        return;
      }
      if (pos >= 0 && w && k === 'footer') shapes[pos] = {...shapes[pos], text: bodyFromText(hf.footerText)};
      else if (pos >= 0 && w && k === 'date' && (dateGiven || formatGiven)) shapes[pos] = setDate(ctx, shapes[pos], hf.dateText, hf.dateFormat);
    });
    if (JSON.stringify(shapes) !== JSON.stringify(slide.shapes)) ctx.change.set(['slides', i, 'shapes'], shapes);
  });
  return {};
}

// ---------------------------------------------------------------------------------------------
// Browse for Themes (design.rs browse_theme / apply_master)

const remapMedia = (v, map, depth = 0) => {
  if (depth > 64 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => remapMedia(x, map, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = (k === 'media' || k === 'original' || k === 'poster') && typeof x === 'string' && map.has(x) ? map.get(x) : remapMedia(x, map, depth + 1);
  return out;
};
function renumber(holder, shapes) {
  return (shapes ?? []).map(sh => {
    const n = {...sh, id: holder.take()};
    if (n.kind?.children) n.kind = {...n.kind, children: renumber(holder, n.kind.children)};
    return n;
  });
}
function matchingLayout(m, from) {
  const ls = m.layouts ?? [];
  const norm = x => String(x ?? '').trim().toLowerCase();
  return ls.find(l => from.name && norm(l.name) === norm(from.name)) ?? ls.find(l => from.kind !== 'custom' && l.kind === from.kind) ?? ls.find(l => l.kind === 'titleAndContent') ?? ls[0] ?? null;
}
function copyMedia(ctx, src, map, ids) {
  const out = [];
  for (const id of ids) {
    if (map.has(id)) continue;
    const m = (src.media ?? []).find(x => x.id === id);
    if (!m) continue;
    out.push(m);
  }
  return out;
}
const mediaIdsOf = (v, out = new Set(), depth = 0) => {
  if (depth > 64 || !v || typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.forEach(x => mediaIdsOf(x, out, depth + 1)); return out; }
  for (const [k, x] of Object.entries(v)) { if ((k === 'media' || k === 'original' || k === 'poster') && typeof x === 'string') out.add(x); else mediaIdsOf(x, out, depth + 1); }
  return out;
};

async function browseTheme(ctx, p) {
  let bytes;
  if (typeof p.data === 'string') {
    bytes = base64Decode(p.data.replace(/^data:[^;,]*;base64,/, ''));
    if (!bytes) throw bad('design.browseTheme', 'invalid base64 `data`');
  } else if (typeof p.path === 'string') {
    ({bytes} = await mediaBytes(ctx, {path: p.path}, 'design.browseTheme'));
  } else if (ctx.origin !== 'bridge' && typeof ctx.host?.pickDocument === 'function') {
    const got = await ctx.host.pickDocument({all: true});
    if (!got) return null;
    bytes = base64Decode(got.data);
  } else throw bad('design.browseTheme', 'give `path` or `data`');
  let src = null;
  try { src = await importPptx(bytes); } catch { src = null; }
  if (src && src.masters?.[0]?.layouts?.length) return applyMaster(ctx, src);
  let got;
  try { got = await importTheme(bytes); } catch (e) { throw bad('design.browseTheme', `not a theme or PowerPoint file (${e?.message ?? e})`); }
  const {mi, master} = masterOf(ctx);
  if (!master) throw bad('design.browseTheme', 'no master');
  const holder = idHolder(ctx, 'design.browseTheme');
  const ids = new Map();
  const list = ctx.doc.media ?? [];
  let added = 0;
  for (const m of got.media ?? []) {
    const id = newId(ctx, 'design.browseTheme');
    ids.set(m.id, id);
    ctx.change.splice(['media'], list.length + added++, 0, {id, name: m.name, contentType: m.contentType, data: m.data, link: null});
  }
  void holder;
  const theme = ids.size ? remapMedia(got.theme, ids) : got.theme;
  ctx.change.set(['masters', mi, 'theme'], theme);
  ctx.change.set(['masters', mi, 'colorMap'], []);
  return {theme: got.theme.name};
}

function applyMaster(ctx, src) {
  const from = src.masters[0];
  const {mi, master: old, sel} = masterOf(ctx);
  if (!old) throw bad('design.browseTheme', 'no master');
  const holder = idHolder(ctx, 'design.browseTheme');
  const map = new Map();
  const needed = [...mediaIdsOf(from)];
  let doc = holder.pres;
  const media = [...(doc.media ?? [])];
  for (const id of needed) {
    const m = (src.media ?? []).find(x => x.id === id);
    if (!m) continue;
    const hit = m.link ? null : media.find(x => x.data === m.data);
    if (hit) { map.set(id, hit.id); continue; }
    const nid = holder.take();
    media.push({...m, id: nid});
    map.set(id, nid);
  }
  let m = remapMedia(structuredClone(from), map);
  m.id = holder.take();
  m.shapes = renumber(holder, m.shapes);
  const layoutMap = new Map();
  m.layouts = (m.layouts ?? []).map(l => { const id = holder.take(); layoutMap.set(l.id, id); return {...l, id, shapes: renumber(holder, l.shapes)}; });
  const size = doc.slideSize;
  const [sx, sy] = [size.width / Math.max(src.slideSize.width, 1), size.height / Math.max(src.slideSize.height, 1)];
  if (Math.abs(sx - 1) > 1e-9 || Math.abs(sy - 1) > 1e-9) {
    m = {...m, shapes: scaleShapes(m.shapes, sx, sy, 1, 0, 0), layouts: m.layouts.map(l => ({...l, shapes: scaleShapes(l.shapes, sx, sy, 1, 0, 0)}))};
  }
  const moves = [];
  (doc.slides ?? []).forEach((sl, i) => {
    const ol = (old.layouts ?? []).find(l => l.id === sl.layout);
    const target = ol ? matchingLayout(m, ol) : null;
    if (target) moves.push([i, target.id]);
  });
  const masters = [...doc.masters];
  if (old.preserve) masters.splice(mi, 0, m); else masters[mi] = m;
  holder.pres = {...holder.pres, masters, media};
  for (const [i, lid] of moves) applyLayout(holder, i, lid, 'design.browseTheme');
  const fin = holder.pres;
  ctx.change.set(['nextId'], fin.nextId);
  ctx.change.set(['media'], fin.media);
  ctx.change.set(['masters'], fin.masters);
  moves.forEach(([i]) => ctx.change.set(['slides', i], fin.slides[i]));
  void sel;
  return {theme: from.theme.name, layouts: m.layouts.length, slides: moves.length};
}

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'design',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'design.theme', label: 'Themes', risk: 'edit',
      description: 'Themes (Design › Themes): give the presentation the built-in theme `name` (its colours, fonts and effects; see design.themes). The gallery lists every theme with the current one marked.',
      params: s.object({name: s.string({min: 1, max: 255})}),
      state(ctx) { const st = hasDoc(ctx); return st.enabled ? {enabled: true, value: themeItems(ctx)} : st; },
      run(ctx, p) {
        v2('design.theme', ctx);
        const t = builtinThemes().find(x => x.name.toLowerCase() === String(canonicalName(p.name)).toLowerCase());
        if (!t) throw bad('design.theme', `no theme \`${p.name}\``, {path: '/name'});
        const {mi, master} = masterOf(ctx);
        if (!master) throw bad('design.theme', 'no master');
        ctx.change.set(['masters', mi, 'theme'], t);
        ctx.change.set(['masters', mi, 'name'], t.name);
        ctx.change.set(['masters', mi, 'colorMap'], []);
        return {theme: p.name};
      },
    },
    {
      id: 'design.browseTheme', label: 'Browse for Themes…', risk: 'edit',
      description: 'Browse for Themes… (Design › Themes): apply a .pptx or .potx\'s slide master and layouts (slides move to the matching layouts), or a .thmx\'s theme. {path} | {data: base64}; from the UI, the system Open dialog picks the file.',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 400_000_000})), name: s.optional(s.string({max: 255}))}),
      state: hasDoc,
      async run(ctx, p) { v2('design.browseTheme', ctx); return browseTheme(ctx, p); },
    },
    {
      id: 'design.themes', label: 'Theme Gallery', risk: 'read', effect: 'view',
      description: 'Query: the themes, colour schemes, font schemes and effect schemes the Design tab offers.',
      params: s.object({}),
      state: () => ({enabled: true}),
      run() {
        return {themes: builtinThemes().map(t => ({name: t.name, major: t.fonts.major.latin, minor: t.fonts.minor.latin, colors: hexes(t.colors).map(x => x.toUpperCase())})),
          colorSchemes: builtinColorSchemes().map(c => c.name), fontSchemes: builtinFontSchemes().map(f => ({name: f.name, major: f.major.latin, minor: f.minor.latin})),
          effectSchemes: builtinFormatSchemes().map(f => f.name)};
      },
    },
    {
      id: 'design.colors', label: 'Colors', risk: 'edit', dialog: 'dialog.themeColors',
      description: 'Colors (Design › Variants): {} opens Create New Theme Colors | {name} applies a colour scheme | {colors: {dk1, lt1, dk2, lt2, accent1…accent6, hlink, folHlink: #RRGGBB}} sets those slots (with `name` laid over the built-in scheme of that name).',
      params: s.object({name: s.optional(s.string({max: 255})), colors: s.optional(s.record(s.string({max: 20}), {max: 32}))}),
      state(ctx) { const st = hasDoc(ctx); return st.enabled ? {enabled: true, value: colorRows(ctx)} : st; },
      run(ctx, p) {
        v2('design.colors', ctx);
        const {mi, master} = masterOf(ctx);
        if (!master) throw bad('design.colors', 'no master');
        if (p.name === undefined && p.colors === undefined) throw bad('design.colors', 'give `name` or `colors` (the ribbon opens Create New Theme Colors)');
        const given = nameParam('design.colors', p.name);
        const next = nextScheme(master.theme.colors, given, colorSlots(p.colors));
        if (same(next, master.theme.colors)) return {};
        ctx.change.set(['masters', mi, 'theme', 'colors'], next);
        return {};
      },
    },
    {
      id: 'design.variant', label: 'Variants', risk: 'edit',
      description: 'Variants (Design › Variants): apply one of the current theme\'s four colour variations, `index` 0..3 (see design.variants).',
      params: s.object({index: s.integer({min: 0, max: 3})}),
      state(ctx) { const st = hasDoc(ctx); return st.enabled ? {enabled: true, value: variantItems(ctx)} : st; },
      run(ctx, p) {
        v2('design.variant', ctx);
        const {mi, master} = masterOf(ctx);
        if (!master) throw bad('design.variant', 'no master');
        const v = themeVariants(master.theme);
        if (!v[p.index]) throw bad('design.variant', `no variant ${p.index}; 0..${v.length - 1}`, {path: '/index'});
        ctx.change.set(['masters', mi, 'theme', 'colors'], v[p.index]);
        return {variant: p.index};
      },
    },
    {
      id: 'design.variants', label: 'Variant Gallery', risk: 'read', effect: 'view',
      description: 'Query: the current theme\'s four colour variants and which is applied.',
      params: s.object({}),
      state: hasDoc,
      run(ctx) {
        const {master} = masterOf(ctx);
        const th = master?.theme;
        if (!th) return {theme: '', current: null, variants: []};
        const v = themeVariants(th);
        const cur = th.colors.colors.map(x => hexOf(x)).join();
        const i = v.findIndex(c => c.colors.map(x => hexOf(x)).join() === cur);
        return {theme: th.name, current: i < 0 ? null : i, variants: v.map(c => ({name: c.name, colors: c.colors.map(x => `#${hexOf(x)}`)}))};
      },
    },
    {
      id: 'design.fonts', label: 'Fonts', risk: 'edit', dialog: 'dialog.themeFonts',
      description: 'Fonts (Design › Variants): {} opens Create New Theme Fonts | {name} applies a font scheme | {major, minor} set the heading and body faces (East Asian and complex-script faces stay).',
      params: s.object({name: s.optional(s.string({max: 255})), major: s.optional(s.string({max: 255})), minor: s.optional(s.string({max: 255}))}),
      state(ctx) { const st = hasDoc(ctx); return st.enabled ? {enabled: true, value: fontRows(ctx)} : st; },
      run(ctx, p) {
        v2('design.fonts', ctx);
        const {mi, master} = masterOf(ctx);
        if (!master) throw bad('design.fonts', 'no master');
        if (p.name === undefined && p.major === undefined && p.minor === undefined) throw bad('design.fonts', 'give `name`, `major` or `minor` (the ribbon opens Create New Theme Fonts)');
        const next = nextFontScheme(master.theme.fonts, nameParam('design.fonts', p.name), face('major', p.major), face('minor', p.minor));
        if (same(next, master.theme.fonts)) return {};
        ctx.change.set(['masters', mi, 'theme', 'fonts'], next);
        return {};
      },
    },
    {
      id: 'design.effects', label: 'Effects', risk: 'edit',
      description: 'Effects (Design › Variants): give the theme the built-in effect scheme `name` (see design.themes); its colours and fonts stay.',
      params: s.object({name: s.string({min: 1, max: 255})}),
      state(ctx) { const st = hasDoc(ctx); return st.enabled ? {enabled: true, value: effectRows(ctx)} : st; },
      run(ctx, p) {
        v2('design.effects', ctx);
        const scheme = builtinFormatSchemes().find(f => f.name.toLowerCase() === String(canonicalName(p.name)).toLowerCase());
        if (!scheme) throw bad('design.effects', `no effect scheme \`${p.name}\``, {path: '/name'});
        const {mi, master} = masterOf(ctx);
        if (!master) throw bad('design.effects', 'no master');
        if (!same(master.theme.format, scheme)) ctx.change.set(['masters', mi, 'theme', 'format'], scheme);
        return {name: scheme.name};
      },
    },
    {
      id: 'design.background', label: 'Format Background', risk: 'edit',
      description: 'Format Background (Design › Customize): the current slide\'s background: {color} | {gradient: {stops: [[0..1, colour]…], kind?, angle?}} | {pattern: {preset, fg, bg}} | {picture: base64 | pick: true} | {style: 1..12} (a background style of the theme) | {reset: true} (follow the layout) | {transparency: 0..1} | {pictureProps: {tile?, offsetX?, offsetY?, scaleX?, scaleY?, align?, mirror?, stretch?, rotateWithShape?}} | {copy: true} (this slide\'s background on every slide); `all` applies it to every slide and the master they use, `index` to another slide.',
      params: s.object({
        color: s.optional(s.any()), gradient: s.optional(s.any()), pattern: s.optional(s.any()), picture: s.optional(s.string({max: 400_000_000})), pick: s.optional(s.boolean()),
        name: s.optional(s.string({max: 255})), style: s.optional(s.integer({min: 1, max: 12})), reset: s.optional(s.boolean()), all: s.optional(s.boolean()),
        index: s.optional(s.integer({min: 0, max: 5000})), transparency: s.optional(s.number({min: 0, max: 1})), pictureProps: s.optional(s.any()), copy: s.optional(s.boolean()),
        field: s.optional(s.enum(['styles'])),
      }),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        return p?.field === 'styles' ? {enabled: true, value: bgStyleItems(ctx)} : {enabled: true};
      },
      async run(ctx, p) {
        v2('design.background', ctx);
        const sel = selectionOf(ctx);
        const doc = ctx.doc;
        const all = p.all === true;
        const mt = masterBackgroundTarget(ctx);
        const idx = p.index ?? sel.slideIndex;
        if (!mt && !doc.slides[idx]) throw bad('design.background', `no slide ${idx}`, {path: '/index'});
        const write = (bg, everywhere = all) => {
          if (mt) { if (!same(mt.bg, bg)) ctx.change.set(mt.path, bg); return; }
          if (everywhere && bg) {
            for (const mi of usedMasters(doc)) {
              const m = doc.masters[mi];
              ctx.change.set(['masters', mi, 'background'], bg);
              (m.layouts ?? []).forEach((l, li) => { if (l.background) ctx.change.set(['masters', mi, 'layouts', li, 'background'], null); });
            }
          }
          const list = everywhere ? doc.slides.map((_, i) => i) : [idx];
          for (const i of list) if (!same(doc.slides[i].background ?? null, bg)) ctx.change.set(['slides', i, 'background'], bg);
        };
        if (p.copy === true) {
          if (mt) throw bad('design.background', 'copy applies to slides');
          const bg = bgOf(doc, doc.slides[sel.slideIndex]);
          write(bg, true);
          return {};
        }
        const t = typeof p.transparency === 'number' ? p.transparency : null;
        let bg;
        if (p.reset === true) bg = null;
        else if (p.color !== undefined) {
          let c = colorValue(p.color);
          if (!c) throw bad('design.background', 'invalid `color`', {path: '/color'});
          if (t !== null) c = setTransparency(c, t);
          bg = {kind: 'fill', fill: fillSolid(c)};
        } else if (p.style !== undefined) {
          const i = clamp(p.style, 1, 12) - 1;
          bg = {kind: 'ref', idx: 1001 + Math.floor(i / 4), color: colorScheme(BG_SLOTS[i % 4])};
        } else if (p.gradient !== undefined) {
          const g = gradientParam(p.gradient);
          if (!g) throw bad('design.background', 'gradient needs two or more `stops`', {path: '/gradient'});
          bg = {kind: 'fill', fill: {kind: 'gradient', ...g, rotateWithShape: false}};
        } else if (p.pattern !== undefined) {
          const pt = p.pattern ?? {};
          bg = {kind: 'fill', fill: {kind: 'pattern', preset: typeof pt.preset === 'string' ? pt.preset : 'pct50', fg: colorValue(pt.fg) ?? colorScheme('accent1'), bg: colorValue(pt.bg) ?? colorScheme('bg1')}};
        } else if (p.picture !== undefined || p.pick === true) {
          let q = {data: p.picture, name: p.name};
          if (p.picture === undefined) {
            if (ctx.origin === 'bridge' || typeof ctx.host?.pickImage !== 'function') throw bad('design.background', 'give `picture` (base64)');
            const url = await ctx.host.pickImage();
            if (!url) return null;
            q = {data: String(url), name: p.name ?? 'Background'};
          }
          const {name, bytes} = await mediaBytes(ctx, q, 'design.background');
          const ct = contentType(name, bytes);
          if (!ct.startsWith('image/')) throw bad('design.background', `${name} is not a picture`);
          const media = addMedia(ctx, 'design.background', name, ct, bytes);
          let pf = {kind: 'picture', media, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: pictureAdjustDefault()};
          if (p.pictureProps && typeof p.pictureProps === 'object') pf = applyPictureProps(pf, p.pictureProps);
          if (t !== null) pf = setPictureTransparency(pf, t);
          bg = {kind: 'fill', fill: pf};
        } else if ((p.pictureProps && typeof p.pictureProps === 'object') || t !== null) {
          const cur = mt ? mt.bg : bgOf(doc, doc.slides[idx]);
          const f = bgFill(cur);
          if (p.pictureProps && f?.kind !== 'picture') throw bad('design.background', 'picture options need a picture background');
          if (t !== null && f?.kind !== 'picture' && f?.kind !== 'solid') throw bad('design.background', 'transparency needs a solid or picture background');
          const next = adjustBackground(cur, p.pictureProps && typeof p.pictureProps === 'object' ? p.pictureProps : null, t);
          if (!same(next, cur)) ctx.change.set(mt ? mt.path : ['slides', idx, 'background'], next);
          return {};
        } else throw bad('design.background', 'give `color`, `gradient`, `pattern`, `picture`, `style`, `reset`, `pictureProps`, `transparency` or `copy`');
        write(bg);
        return {};
      },
    },
    {
      id: 'design.hideBackgroundGraphics', label: 'Hide Background Graphics', risk: 'edit',
      description: 'Hide Background Graphics (Format Background): hide (default: toggle) the layout\'s and master\'s graphics on the current slide.',
      params: s.object({hide: s.optional(s.boolean())}),
      state(ctx) {
        const open = ctx.view?.master;
        if (open) {
          const l = open.kind === 'slide' && open.layout !== null && open.layout !== undefined ? ctx.doc.masters?.[open.master]?.layouts?.[open.layout] : null;
          return l ? {enabled: true, checked: l.showMasterShapes === false} : {enabled: false, reason: 'select a layout in Slide Master view', checked: false};
        }
        const st = hasSlide(ctx);
        return st.enabled ? {enabled: true, checked: selectionOf(ctx).slide?.showMasterShapes === false} : st;
      },
      run(ctx, p) {
        v2('design.hideBackgroundGraphics', ctx);
        const open = ctx.view?.master;
        if (open) {
          const l = open.kind === 'slide' && open.layout !== null && open.layout !== undefined ? ctx.doc.masters?.[open.master]?.layouts?.[open.layout] : null;
          if (!l) throw bad('design.hideBackgroundGraphics', 'select a layout in Slide Master view');
          const hideL = typeof p.hide === 'boolean' ? p.hide : l.showMasterShapes !== false;
          ctx.change.set(['masters', open.master, 'layouts', open.layout, 'showMasterShapes'], !hideL);
          return {hide: hideL};
        }
        const sel = selectionOf(ctx);
        const hide = typeof p.hide === 'boolean' ? p.hide : sel.slide.showMasterShapes !== false;
        ctx.change.set(['slides', sel.slideIndex, 'showMasterShapes'], !hide);
        return {hide};
      },
    },
    {
      id: 'design.slideSize', label: 'Slide Size', risk: 'edit', dialog: 'dialog.slideSize',
      description: 'Slide Size (Design › Customize): {preset: widescreen | standard | … (a name from the Slide Size dialog), orientation?: portrait | landscape, scale?: maximize | ensureFit | none} or {w, h: points, …}. Masters and layouts stretch to the new size; slides scale their content by `scale` (default ensureFit).',
      params: s.object({preset: s.optional(s.string({max: 100})), w: s.optional(s.number({min: 1, max: 100000})), h: s.optional(s.number({min: 1, max: 100000})),
        orientation: s.optional(s.enum(['portrait', 'landscape'])), scale: s.optional(s.enum(['maximize', 'ensureFit', 'none']))}),
      state(ctx) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        return {enabled: true, value: ctx.doc.slideSize ? {width: ctx.doc.slideSize.width, height: ctx.doc.slideSize.height} : null};
      },
      run(ctx, p) {
        v2('design.slideSize', ctx);
        const size = slideSizeFor(p);
        const mode = p.scale ?? 'ensureFit';
        const old = ctx.doc.slideSize;
        const [sx0, sy0] = [size.width / Math.max(old.width, 1), size.height / Math.max(old.height, 1)];
        let sx = 1, sy = 1, k = 1, ox = 0, oy = 0;
        if (mode !== 'none') {
          k = mode === 'maximize' ? Math.max(sx0, sy0) : Math.min(sx0, sy0);
          sx = sy = k; ox = (size.width - old.width * k) / 2; oy = (size.height - old.height * k) / 2;
        }
        (ctx.doc.masters ?? []).forEach((m, mi) => {
          ctx.change.set(['masters', mi, 'shapes'], scaleShapes(m.shapes, sx0, sy0, 1, 0, 0));
          (m.layouts ?? []).forEach((l, li) => ctx.change.set(['masters', mi, 'layouts', li, 'shapes'], scaleShapes(l.shapes, sx0, sy0, 1, 0, 0)));
        });
        (ctx.doc.slides ?? []).forEach((sl, i) => ctx.change.set(['slides', i, 'shapes'], scaleShapes(sl.shapes, sx, sy, k, ox, oy)));
        ctx.change.set(['slideSize'], {width: size.width, height: size.height});
        return {w: size.width, h: size.height};
      },
    },
    {
      id: 'design.headerFooter', label: 'Header and Footer…', risk: 'edit', dialog: 'dialog.headerFooter',
      description: 'Header and Footer… (Insert › Text): {date?, dateText? (a fixed date; empty = update automatically), dateFormat? (datetime1…datetime13), slideNumber?, footer?, footerText?, hideOnTitle?: bool, all?: bool (default true: Apply to All; false: this slide)}: show or hide the date, slide number and footer placeholders of the slides and set their text.',
      params: s.object({date: s.optional(s.boolean()), dateText: s.optional(s.string({max: 1000})), dateFormat: s.optional(s.string({max: 20})), slideNumber: s.optional(s.boolean()),
        footer: s.optional(s.boolean()), footerText: s.optional(s.string({max: 10000})), hideOnTitle: s.optional(s.boolean()), all: s.optional(s.boolean())}),
      state: hasDoc,
      run(ctx, p) { v2('design.headerFooter', ctx); return headerFooter(ctx, p); },
    },
    {
      id: 'design.ideas', label: 'Design Ideas', risk: 'read', effect: 'view',
      description: 'Query: the Design Ideas for slide `slide` (default: the current one): [{id, label}]; none when it has nothing to arrange.',
      params: s.object({slide: s.optional(s.integer({min: 0, max: 5000}))}),
      state: hasSlide,
      run(ctx, p) { v2('design.ideas', ctx); return ideasFor(ctx.doc, p.slide ?? selectionOf(ctx).slideIndex).map(([id, label]) => ({id, label})); },
    },
    {
      id: 'design.applyIdea', label: 'Apply Design Idea', risk: 'edit',
      description: 'Apply Design Idea (Design › Designer): arrange the current slide\'s own shapes as idea `id` (see design.ideas); pictures are cropped to their new box and the slide alone changes.',
      params: s.object({id: s.string({min: 1, max: 60}), slide: s.optional(s.integer({min: 0, max: 5000}))}),
      state: hasSlide,
      run(ctx, p) {
        v2('design.applyIdea', ctx);
        const i = p.slide ?? selectionOf(ctx).slideIndex;
        let out;
        try { out = applyIdea(ctx.doc, i, p.id); } catch (e) { throw bad('design.applyIdea', e?.message ?? String(e), {path: '/id'}); }
        ctx.change.set(['slides', i, 'shapes'], out);
        return {slide: i, id: p.id};
      },
    },
  ],
});

// The pane commands live in design-pane.mjs (Format Background, Design Ideas).
const newShapeLike = (id, name, ph) => newShapeObj({id, name, ph});
void CommandError; void colorRgb; void colorWith; void mkRgb; void isTitlePh; void isFooterPh;
