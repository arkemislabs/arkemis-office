// Inheritance: effective position, fill, line, body and text properties of a shape, following
// slide → layout placeholder → master placeholder → master text styles → theme.
// Translated from deckcraft crates/model/src/resolve.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {TRANSPARENT, BLACK} from './color.mjs';
import {resolveColor, colorScheme, fillSolid, fillNone, inheritLine, lineNone} from './style.mjs';
import {inheritBody, inheritPara, inheritRun, listLevel} from './text.mjs';
import {themeFont} from './theme.mjs';
import {drawnHeights} from './table-style.mjs';
import {masterFor, mapSlot, schemeWith, masterScheme, isTitlePh} from './presentation.mjs';

/** Where a shape lives, for resolving inherited values: 'slide' | 'layout' | 'master'. */
export function ctxForSlide(pres, sl) {
  const ml = masterFor(pres, sl);
  if (!ml) return null;
  const [master, layout] = ml;
  const map = sl?.colorMap ?? layout?.colorMap ?? master.colorMap ?? [];
  return {pres, master, layout, owner: 'slide', scheme: schemeWith(master, map), colorMap: map};
}
export function ctxForLayout(pres, master, layout) {
  const map = layout.colorMap ?? master.colorMap ?? [];
  return {pres, master, layout, owner: 'layout', scheme: schemeWith(master, map), colorMap: map};
}
export const ctxForMaster = (pres, master) => ({pres, master, layout: null, owner: 'master', scheme: masterScheme(master), colorMap: master.colorMap ?? []});

/** Resolve a colour in this context (bg1/tx1/bg2/tx2 through the colour map in force). */
export function ctxColor(ctx, c, ph) {
  let ref = c;
  const slot = c?.base?.kind === 'scheme' ? c.base.slot : null;
  if (slot === 'bg1' || slot === 'tx1' || slot === 'bg2' || slot === 'tx2') ref = {base: {kind: 'scheme', slot: mapSlot(ctx.colorMap, slot)}, mods: c.mods};
  return resolveColor(ref, ctx.master.theme.colors, ph);
}

const TITLES = new Set(['title', 'ctrTitle']);
const BODYISH = new Set(['subTitle', 'body', 'obj', 'chart', 'table', 'clipArt', 'diagram', 'media', 'picture']);
const NOT_FOR_BODY = new Set(['title', 'ctrTitle', 'date', 'footer', 'slideNum', 'header']);
function compatible(slideKind, other) {
  if (TITLES.has(slideKind)) return TITLES.has(other);
  if (BODYISH.has(slideKind)) return !NOT_FOR_BODY.has(other);
  return slideKind === other;
}

function findPh(shapes, sh, byIdx) {
  const ph = sh.ph;
  if (!ph) return null;
  const list = shapes ?? [];
  if (byIdx && ph.idx !== 0) {
    const s = list.find(x => x.ph && x.ph.idx === ph.idx && compatible(ph.kind, x.ph.kind));
    if (s) return s;
  }
  return list.find(x => x.ph && x.ph.kind === ph.kind && (!byIdx || ph.idx === 0 || x.ph.idx === ph.idx || isTitlePh(ph.kind)))
    ?? list.find(x => x.ph && x.ph.kind === ph.kind)
    ?? list.find(x => x.ph && compatible(ph.kind, x.ph.kind))
    ?? null;
}

function masterPh(master, kind) {
  const want = kind === 'title' || kind === 'ctrTitle' ? 'title' : ['date', 'footer', 'slideNum', 'header'].includes(kind) ? kind : 'body';
  return (master.shapes ?? []).find(s => s.ph?.kind === want) ?? null;
}

/** The layout and master placeholders a shape inherits from: [layoutPh, masterPh]. */
export function parents(ctx, sh) {
  const ph = sh?.ph;
  if (!ph) return [null, null];
  if (ctx.owner === 'slide') {
    const lp = ctx.layout ? findPh(ctx.layout.shapes, sh, true) : null;
    const kind = lp?.ph?.kind ?? ph.kind;
    return [lp, masterPh(ctx.master, kind)];
  }
  if (ctx.owner === 'layout') return [null, masterPh(ctx.master, ph.kind)];
  return [null, null];
}

/** The text style group (title / body / other) a shape draws from. */
export function masterListStyle(ctx, sh) {
  if (sh?.kind?.type === 'table') return ctx.master.otherStyle;
  const k = sh?.ph?.kind;
  if (k === 'title' || k === 'ctrTitle') return ctx.master.titleStyle;
  if (BODYISH.has(k)) return ctx.master.bodyStyle;
  if (k) return ctx.master.otherStyle;
  return ctx.pres.defaultTextStyle;
}

/**
 * The shape's box. A table's box is at least as tall as its rows are drawn (rows grow to fit their text), so its handles and hit
 * tests match what is shown (deckcraft `cmd::xfrm_of`).
 */
export function xfrm(ctx, sh) {
  const x = ownXfrm(ctx, sh);
  if (sh.kind?.type !== 'table') return x;
  let drawn = 0;
  try { drawn = drawnHeights(ctx, sh).reduce((a, b) => a + b, 0); } catch { drawn = 0; }
  return Number.isFinite(drawn) && drawn > x.h ? {...x, h: drawn} : x;
}
function ownXfrm(ctx, sh) {
  if (sh.xfrm) return sh.xfrm;
  const [lp, mp] = parents(ctx, sh);
  const x = lp?.xfrm ?? mp?.xfrm;
  if (x) return x;
  const sz = ctx.pres.slideSize;
  return {x: sz.width * 0.1, y: sz.height * 0.1, w: sz.width * 0.8, h: sz.height * 0.2};
}

/** Effective fill and the style colour (phClr) to resolve it with: [fill|null, ph|null]. */
export function fill(ctx, sh) {
  const [lp, mp] = parents(ctx, sh);
  const fmt = ctx.master.theme.format ?? {};
  const styleFill = s => {
    if (!s.style) return null;
    const [idx, col] = s.style.fillRef;
    const phc = ctxColor(ctx, col, null);
    const f = idx === 0 ? fillNone() : idx >= 1001 ? fmt.bgFills?.[idx - 1001] ?? null : fmt.fills?.[idx - 1] ?? null;
    return [f, phc];
  };
  for (const s of [sh, lp, mp]) {
    if (!s) continue;
    if (s.fill) {
      // A gradient without stops takes them from the gradient its style refers to.
      if (s.fill.kind === 'gradient' && !(s.fill.stops ?? []).length) {
        const r = styleFill(s);
        if (r && r[0]?.kind === 'gradient') return [{...s.fill, stops: r[0].stops}, r[1]];
      }
      return [s.fill, null];
    }
    const r = styleFill(s);
    if (r) return r;
  }
  if (sh.textBox) return [fillNone(), null];
  return [null, null];
}

/** Effective line and its style colour: [line, ph|null]. */
export function line(ctx, sh) {
  const [lp, mp] = parents(ctx, sh);
  const fmt = ctx.master.theme.format ?? {};
  let out = {};
  let ph = null;
  for (const s of [sh, lp, mp]) {
    if (!s) continue;
    if (s.line) out = inheritLine(out, s.line);
    if (s.style) {
      const [idx, col] = s.style.lineRef;
      if (ph === null) ph = ctxColor(ctx, col, null);
      if (idx === 0) out = inheritLine(out, lineNone());
      else if (fmt.lines?.[idx - 1]) out = inheritLine(out, fmt.lines[idx - 1]);
      break;
    }
  }
  return [out, ph];
}

export function effects(ctx, sh) {
  const [lp, mp] = parents(ctx, sh);
  for (const s of [sh, lp, mp]) {
    if (!s) continue;
    if (s.effects) return [s.effects, null];
    if (s.style) {
      const [idx, col] = s.style.effectRef;
      if (idx === 0) return [null, null];
      return [ctx.master.theme.format?.effects?.[idx - 1] ?? null, ctxColor(ctx, col, null)];
    }
  }
  return [null, null];
}

/** Body properties with defaults filled in. */
export function body(ctx, sh) {
  const [lp, mp] = parents(ctx, sh);
  let b = {...(sh.text?.body ?? {})};
  for (const s of [lp, mp]) if (s?.text) b = inheritBody(b, s.text.body);
  return inheritBody(b, {
    insetL: 7.2, insetT: 3.6, insetR: 7.2, insetB: 3.6,
    anchor: !sh.ph && !sh.textBox && sh.kind?.type !== 'table' ? 'middle' : 'top',
    anchorCtr: false, wrap: true, autofit: sh.textBox ? {kind: 'shape'} : {kind: 'none'}, vert: 'horizontal', rot: 0, columns: 1, colSpacing: 0,
    rtlCol: false, upright: false, spaceFirstLast: false,
  });
}

/** The merged level style (paragraph + run defaults) for paragraphs at `level` in `sh`. */
export function levelStyle(ctx, sh, level) {
  const [lp, mp] = sh?.kind?.type === 'table' ? [null, null] : parents(ctx, sh);
  let out = {para: {}, run: {}};
  const add = ls => { if (ls) out = {para: inheritPara(out.para, ls.para), run: inheritRun(out.run, ls.run)}; };
  if (sh.text) add(listLevel(sh.text.listStyle, level));
  for (const s of [lp, mp]) if (s?.text) add(listLevel(s.text.listStyle, level));
  // Shape style font reference (theme font + colour) sits above the defaults.
  const st = sh.style ?? lp?.style;
  if (st) {
    const font = st.fontRef[0] === 'major' ? '+mj-lt' : st.fontRef[0] === 'minor' ? '+mn-lt' : undefined;
    out.run = inheritRun(out.run, {font, fill: st.fontRef[1] ? fillSolid(st.fontRef[1]) : undefined});
  }
  add(listLevel(masterListStyle(ctx, sh), level));
  add(listLevel(ctx.pres.defaultTextStyle, level));
  // Last resort.
  out.run = inheritRun(out.run, {size: 18, font: '+mn-lt', bold: false, italic: false});
  out.para = inheritPara(out.para, {marginLeft: 0, indent: 0, align: 'left'});
  return out;
}

/** Fully resolved run properties for `runProps` in paragraph `para` (explicit → paragraph style). */
export function run(ctx, sh, para, runProps = {}) {
  let r = inheritRun(runProps, para.defProps);
  r = inheritRun(r, levelStyle(ctx, sh, para.level ?? 0).run);
  // Hyperlinked text is drawn in the theme's hyperlink colour and underlined, unless the run itself
  // sets a colour or an underline. Colours and underlines from list styles don't count.
  if (r.link) {
    const fromDef = !runProps.link;
    if (runProps.fill == null && !(fromDef && para.defProps?.fill != null)) r.fill = fillSolid(colorScheme('hlink'));
    if (runProps.underline == null && !(fromDef && para.defProps?.underline != null)) r.underline = 'sng';
  }
  return r;
}

export function para(ctx, sh, p) {
  return inheritPara(p.props ?? {}, levelStyle(ctx, sh, p.level ?? 0).para);
}

/** Concrete font family for a run (theme references resolved). */
export function fontFamily(ctx, r) {
  const name = themeFont(ctx.master.theme, r.font ?? '+mn-lt');
  return name || ctx.master.theme.fonts?.minor?.latin || '';
}

/** Text colour of resolved run props. */
export function textColor(ctx, r) {
  const f = r.fill;
  if (f?.kind === 'solid') return ctxColor(ctx, f.color, null);
  if (f?.kind === 'gradient') return f.stops?.[0] ? ctxColor(ctx, f.stops[0].color, null) : BLACK;
  if (f?.kind === 'none') return TRANSPARENT;
  return ctxColor(ctx, colorScheme('tx1'), null);
}

/** The background fill (and its style colour) of a slide: [fill, ph|null]. */
export function background(ctx, sl) {
  const bg = sl?.background ?? ctx.layout?.background ?? ctx.master.background;
  if (bg?.kind === 'fill') return [bg.fill, null];
  if (bg?.kind === 'ref') {
    const ph = ctxColor(ctx, bg.color, null);
    const fmt = ctx.master.theme.format ?? {};
    const f = bg.idx >= 1001 ? fmt.bgFills?.[bg.idx - 1001] : fmt.fills?.[Math.max(bg.idx - 1, 0)];
    return [f ?? fillSolid({base: {kind: 'rgb', rgb: ph}}), ph];
  }
  return [fillSolid(colorScheme('bg1')), null];
}

/** Should the layout/master graphics (non-placeholder shapes) show behind this slide? [layout, master]. */
export function showMasterShapes(sl, layout) {
  const showLayout = sl.showMasterShapes !== false;
  return [showLayout, showLayout && (!layout || layout.showMasterShapes !== false)];
}
