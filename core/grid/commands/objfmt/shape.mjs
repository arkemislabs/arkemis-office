// Shape Format, Chart Format and Picture Format: the commands the three tabs share on a chart, picture or shape: Shape Styles,
// Shape Effects (shadow, glow, soft edges, reflection, bevel), WordArt (the text of a shape, the text of a chart), Change Shape,
// Alt Text, Chart Elements and Reset to Match Style.
// Not in gridcraft (its ribbon draws none of these tabs; its engine has `chart.shapeFill`, `chart.shapeOutline` and `arrange.*`
// only): built from what Excel does, with Quill's effect and WordArt models (core/quill/model/effects.mjs, wordart.mjs, translated from
// wordcraft effects.rs and wordart.rs). Not checked against upstream. U:grid/object-format.
// The stored fields are in core/grid/lib/object-fx.mjs; src/apps/grid/surface/objects.ts draws them; xlsx-drawing.mjs saves them.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc} from '../../lib/edit-targets.mjs';
import {bad} from '../../lib/data-common.mjs';
import {pick, put, needs, selectedOf, KINDS} from '../../lib/object-edit.mjs';
import {resolveColor, hex as hexOf} from '../../model/style.mjs';
import {SHAPE_STYLES, sanitizedEffects, shapeEffectsIsEmpty, shadowPreset, reflectionPreset, bevelPreset, sanitizedGlow, defaultGlow} from '../../lib/object-fx.mjs';
import {sanitizedTextEffects, textEffectsIsEmpty, artStyle, ART_STYLES, defaultTextOutline, defaultReflection as defaultTextReflection, sanitizedTextFill, MAX_STOPS} from '../../../quill/model/wordart.mjs';
import {sanitizedShadow, defaultShadow, defaultReflection, sanitizedReflection} from '../../../quill/model/effects.mjs';

const UPSTREAM = {repo: 'office', commit: undefined, files: ['Excel for Windows > Shape Format, Picture Format and Chart Format (not in gridcraft)']};
const SHAPE_KINDS = ['rectangle', 'roundedRectangle', 'ellipse', 'triangle', 'line', 'arrow'];
const ID = s.optional(s.integer({min: 0}));
const KIND = s.optional(s.enum(KINDS));
const rgbHex = c => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
/** "#RRGGBB" / "RRGGBB" as [r, g, b], or null. */
const parseRgb = v => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? '').trim()); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const isAuto = v => /^auto(matic)?$/i.test(String(v));
/** The theme as Quill's WordArt styles read it: dk1, lt1, dk2, lt2, accent 1 to 6, hyperlink, followed. */
export function themeRgb(ctx) {
  const th = ctx.doc?.theme;
  const g = i => resolveColor({theme: i, tint: 0}, th) ?? [0, 0, 0];
  return [g(1), g(0), g(3), g(2), g(4), g(5), g(6), g(7), g(8), g(9), g(10), g(11)];
}
/** A stored colour as [r, g, b] (the theme applied). */
export const rgbOf = (ctx, c) => resolveColor(c, ctx.doc?.theme);

// ---- effects ------------------------------------------------------------------------------------------------------------

function parseShadow(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === 'none') return null;
  if (v === true) return defaultShadow();
  const preset = id => { const sh = shadowPreset(id); if (!sh) throw bad('shape.effects', `unknown shadow preset \`${id}\``); return sh; };
  if (typeof v === 'string') return preset(v);
  if (typeof v === 'object') {
    const sh = typeof v.preset === 'string' ? preset(v.preset) : defaultShadow();
    if (v.color !== undefined) sh.color = parseRgb(v.color) ?? sh.color;
    for (const k of ['transparency', 'blur', 'distance', 'angle']) if (Number.isFinite(v[k])) sh[k] = v[k];
    return sanitizedShadow(sh);
  }
  throw bad('shape.effects', '`shadow` is a preset name, an object or null');
}
function parseGlow(v, accent = null) {
  if (v === undefined) return undefined;
  if (v === null || v === 'none') return null;
  if (typeof v === 'number') return sanitizedGlow({...defaultGlow(), ...(accent ? {color: accent} : {}), size: v});
  if (typeof v === 'object') return sanitizedGlow({color: parseRgb(v.color) ?? accent ?? defaultGlow().color, size: Number.isFinite(v.size) ? v.size : defaultGlow().size, transparency: Number.isFinite(v.transparency) ? v.transparency : defaultGlow().transparency});
  throw bad('shape.effects', '`glow` is a size in points, an object or null');
}
function parseReflection(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === 'none') return null;
  if (typeof v === 'string') { const r = reflectionPreset(v); if (!r) throw bad('shape.effects', `unknown reflection preset \`${v}\` (tight, half, full)`); return r; }
  if (typeof v === 'object') return sanitizedReflection({...defaultReflection(), ...v});
  throw bad('shape.effects', '`reflection` is a preset, an object or null');
}
function parseBevel(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === 'none') return null;
  const b = typeof v === 'string' ? bevelPreset(v) : bevelPreset(v?.preset) && {...bevelPreset(v.preset), ...v};
  if (!b) throw bad('shape.effects', `unknown bevel \`${typeof v === 'string' ? v : v?.preset}\``);
  return sanitizedEffects({bevel: b}).bevel;
}

/** Shape Effects on the selected chart, picture or shape: shadow, glow, soft edges, reflection and bevel, each null to take it off. */
function effects(ctx, p) {
  const t = pick(ctx, p, 'shape.effects');
  if (t.kind === 'shape' && ['line', 'arrow'].includes(t.object.kind)) throw bad('shape.effects', 'a line takes no shape effects');
  const accent = rgbOf(ctx, {theme: 4, tint: 0});
  const shadow = parseShadow(p.shadow), glow = parseGlow(p.glow, accent), refl = parseReflection(p.reflection), bevel = parseBevel(p.bevel);
  const soft = p.softEdge === undefined ? undefined : p.softEdge === null ? null : Number(p.softEdge);
  const e = {...(t.object.fx ?? {})};
  for (const [k, v] of [['shadow', shadow], ['glow', glow], ['softEdge', soft], ['reflection', refl], ['bevel', bevel]]) if (v !== undefined) { if (v === null) delete e[k]; else e[k] = v; }
  const fx = sanitizedEffects(e);
  const next = {...t.object};
  if (shapeEffectsIsEmpty(fx)) delete next.fx; else next.fx = fx;
  put(ctx, t, next);
  return {effects: next.fx ?? {}};
}

// ---- shape styles -------------------------------------------------------------------------------------------------------

/** The Shape Styles gallery's tile for style `i`: the fill and outline in the theme's colours. */
const styleTile = (ctx, st, selected) => {
  const th = ctx.doc?.theme;
  const rgb = c => (c === 'auto' ? null : resolveColor(c, th));
  return {id: `style${st.id}`, label: st.label, value: st.id, selected, iconOnly: true, art: {kind: 'shapeStyle', fill: rgb(st.fill), line: rgb(st.line), lineWidth: st.lineWidth, shadow: st.shadow}};
};

/** Apply Shape Style `index` to the selected shape (fill, outline, effect), or to the chart area of the selected chart. */
function quickStyle(ctx, p) {
  const st = SHAPE_STYLES[p.index];
  if (!st) throw bad('shape.quickStyle', `\`index\` is 0 to ${SHAPE_STYLES.length - 1}`);
  const t = pick(ctx, p, 'shape.quickStyle', ['shape', 'chart']);
  const next = {...t.object, style: st.id};
  if (t.kind === 'chart') {
    const fill = resolveColor(st.fill, ctx.doc?.theme), line = st.line === 'auto' ? null : resolveColor(st.line, ctx.doc?.theme);
    next.area = {fill: fill ? rgbHex(fill) : '#FFFFFF', line: line ? rgbHex(line) : 'none', lineWidth: st.lineWidth};
    // The chart area's effect: only the shadow of the Moderate Effect row.
    const fx = {...(next.fx ?? {})};
    if (st.shadow) fx.shadow = shadowPreset('offsetBottomRight'); else delete fx.shadow;
    if (shapeEffectsIsEmpty(fx)) delete next.fx; else next.fx = fx;
    delete next.style;
    next.areaStyle = st.id;
  } else {
    if (t.object.kind === 'icon') throw bad('shape.quickStyle', 'an icon has no shape style');
    const flat = ['line', 'arrow'].includes(t.object.kind);
    if (!flat) next.fill = {...st.fill};
    const f = {...(t.object.format ?? {})};
    if (st.line === 'auto') { next.line = {theme: 4, tint: 0}; f.noLine = true; } else { next.line = {...st.line}; delete f.noLine; }
    if (Object.keys(f).length) next.format = f; else delete next.format;
    const fx = {...(next.fx ?? {})};
    if (st.shadow) fx.shadow = shadowPreset('offsetBottomRight'); else delete fx.shadow;
    if (shapeEffectsIsEmpty(fx)) delete next.fx; else next.fx = fx;
  }
  put(ctx, t, next);
  return {style: st.label};
}
const styleState = ctx => {
  const st = needs(['shape', 'chart'], 'a shape or chart')(ctx);
  if (!st.enabled) return st;
  const sel = selectedOf(ctx, ['shape', 'chart']);
  const cur = sel.kind === 'chart' ? sel.object.areaStyle : sel.object.style;
  return {...st, value: SHAPE_STYLES.map(x => styleTile(ctx, x, cur === x.id))};
};

function changeShape(ctx, p) {
  if (!SHAPE_KINDS.includes(p.shape)) throw bad('shape.change', `\`shape\` is one of ${SHAPE_KINDS.join(', ')}`);
  const t = pick(ctx, p, 'shape.change', ['shape']);
  if (['icon', 'textBox'].includes(t.object.kind)) throw bad('shape.change', `${t.object.kind === 'icon' ? 'an icon' : 'a text box'} is not a shape that can change`);
  const flat = p.shape === 'line' || p.shape === 'arrow';
  const a = {...t.object.anchor};
  if (!flat && !(a.height > 0)) a.height = Math.max(24, Math.round(a.width / 2));
  put(ctx, t, {...t.object, kind: p.shape, anchor: a});
  return {shape: p.shape};
}

// ---- WordArt ------------------------------------------------------------------------------------------------------------

/** The object whose text WordArt formats: the selected shape (with text), or the selected chart (all its text). */
function textTarget(ctx, p, cmd) {
  const t = pick(ctx, p, cmd, ['shape', 'chart']);
  if (t.kind === 'shape' && (['icon', 'line', 'arrow'].includes(t.object.kind))) throw bad(cmd, 'this shape has no text');
  return t;
}
function setTextFx(ctx, t, fx) {
  const next = {...t.object};
  const eff = sanitizedTextEffects(fx);
  if (textEffectsIsEmpty(eff)) delete next.textFx; else next.textFx = eff;
  put(ctx, t, next);
  return next.textFx ?? {};
}
function parseFill(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v === 'none' || isAuto(v)) return v === 'none' ? {type: 'none'} : null;
  if (typeof v === 'string') { const c = parseRgb(v); if (!c) throw bad('wordArt.textFill', '`fill` is a colour, "none", an object or null'); return {type: 'solid', color: c, transparency: 0}; }
  if (typeof v === 'object' && Array.isArray(v.gradient)) {
    const cols = v.gradient.filter(x => typeof x === 'string').map(parseRgb).filter(Boolean).slice(0, MAX_STOPS);
    const n = Math.max(cols.length, 2) - 1;
    return sanitizedTextFill({type: 'gradient', stops: cols.map((color, i) => ({pos: 100 * i / n, color, transparency: 0})), angle: Number.isFinite(v.angle) ? v.angle : 90});
  }
  if (typeof v === 'object') { const c = parseRgb(v.color); if (!c) throw bad('wordArt.textFill', '`fill` is a colour, "none", an object or null'); return {type: 'solid', color: c, transparency: Number.isFinite(v.transparency) ? v.transparency : 0}; }
  throw bad('wordArt.textFill', '`fill` is a colour, "none", an object or null');
}
function parseOutline(v) {
  if (v === undefined) return undefined;
  if (v === null || isAuto(v)) return null;
  if (typeof v === 'string') { if (/^none$/i.test(v)) return {color: null}; const c = parseRgb(v); if (!c) throw bad('wordArt.textOutline', '`outline` is a colour'); return {color: c}; }
  if (typeof v === 'object') {
    const out = {};
    if (v.color !== undefined) out.color = v.color === null || /^none$/i.test(String(v.color)) ? null : parseRgb(v.color) ?? defaultTextOutline().color;
    if (Number.isFinite(v.width)) out.width = v.width;
    return out;
  }
  throw bad('wordArt.textOutline', '`outline` is a colour, "none", an object or null');
}

function wordArtStyle(ctx, p) {
  const t = textTarget(ctx, p, 'wordArt.style');
  const style = artStyleAny(p.style, themeRgb(ctx));
  if (!style) throw bad('wordArt.style', `unknown WordArt style \`${p.style}\``);
  return setTextFx(ctx, t, {...style});
}
function wordArtFill(ctx, p) {
  const t = textTarget(ctx, p, 'wordArt.textFill');
  const fill = parseFill(p.fill);
  const fx = {...(t.object.textFx ?? {})};
  if (fill === undefined || fill === null) delete fx.fill; else fx.fill = fill;
  return setTextFx(ctx, t, fx);
}
function wordArtOutline(ctx, p) {
  const t = textTarget(ctx, p, 'wordArt.textOutline');
  const o = parseOutline(p.outline);
  const fx = {...(t.object.textFx ?? {})};
  if (o === undefined || o === null) delete fx.outline; else fx.outline = {...defaultTextOutline(), ...(fx.outline ?? {}), ...o};
  return setTextFx(ctx, t, fx);
}
/** Text Effects > Shadow, Glow and Reflection of the shape's text (each null to take it off). */
function wordArtEffect(ctx, p) {
  const t = textTarget(ctx, p, 'wordArt.textEffect');
  const accent = rgbOf(ctx, {theme: 4, tint: 0});
  const shadow = parseShadow(p.shadow), glow = parseGlow(p.glow, accent);
  const refl = p.reflection === undefined ? undefined : p.reflection === null || p.reflection === 'none' ? null : p.reflection === true ? defaultTextReflection() : {...defaultTextReflection(), ...(typeof p.reflection === 'object' ? p.reflection : {})};
  const fx = {...(t.object.textFx ?? {})};
  for (const [k, v] of [['shadow', shadow], ['glow', glow], ['reflection', refl]]) if (v !== undefined) { if (v === null) delete fx[k]; else fx[k] = v; }
  return setTextFx(ctx, t, fx);
}

// ---- Alt Text, Chart Elements -------------------------------------------------------------------------------------------

function setAlt(ctx, p) {
  const t = pick(ctx, p, 'object.setAlt');
  const next = {...t.object};
  const alt = String(p.alt ?? '');
  if (p.decorative === true) { next.alt = ''; next.decorative = true; } else { next.alt = alt; delete next.decorative; }
  if (t.kind !== 'image' && !next.alt) delete next.alt;
  put(ctx, t, next);
  return {alt: next.alt ?? '', decorative: next.decorative === true};
}

/** The elements of the selected chart Chart Elements picks: the chart area, the plot area, each series. */
export function chartElements(chart) {
  const out = [{id: 'chartArea', label: 'Chart Area'}];
  if (!['pie', 'doughnut', 'treemap', 'sunburst', 'funnel', 'radar'].includes(chart.kind)) out.push({id: 'plotArea', label: 'Plot Area'});
  (chart.series ?? []).forEach((x, i) => out.push({id: `series${i}`, label: `Series "${x.nameText ?? x.name ?? i + 1}"`.replace(/Sheet\d*!\$?[A-Z]+\$?\d+/, `${i + 1}`)}));
  return out;
}
function selectElement(ctx, p) {
  const t = pick(ctx, p, 'chart.selectElement', ['chart']);
  const list = chartElements(t.object);
  // The Chart Elements box names its choices "Chart Area", "Plot Area", "Series 1"...; the ids chartArea, plotArea, series0 work as well.
  const want = String(p.element ?? '').trim().toLowerCase();
  const m = /^series\s+(\d+)$/.exec(want);
  const el = list.find(x => x.id.toLowerCase() === want || x.label.toLowerCase() === want) ?? (m ? list.find(x => x.id === 'series' + (Number(m[1]) - 1)) : null) ?? (want ? null : list[0]);
  if (!el) throw bad('chart.selectElement', 'no such part of the chart: ' + p.element);
  ctx.setView({chartElement: {chart: t.object.id, element: el.id}});
  return {element: el.id};
}
/** The element Format commands act on for chart `c`: from view.chartElement, else the chart area. */
export const elementOf = (ctx, c) => (ctx.view?.chartElement?.chart === c.id ? ctx.view.chartElement.element : 'chartArea');

/** Reset to Match Style: the chart area, plot area, series colours and effects back to the chart's style. */
function resetStyle(ctx, p) {
  const t = pick(ctx, p, 'chart.resetStyle', ['chart']);
  const next = {...t.object};
  for (const k of ['area', 'plot', 'fx', 'textFx', 'areaStyle']) delete next[k];
  next.series = (next.series ?? []).map(x => { const {color: _c, line: _l, ...rest} = x; return rest; });
  delete next.palette;
  put(ctx, t, next);
  ctx.setView({chartElement: null});
  return {reset: true};
}

/** Seven more styles beside Quill's eight, so the gallery has Excel's fifteen. */
const EXTRA_ART = [['plain', 'Plain Dark'], ['outlineDark', 'Outline Dark'], ['goldGlow', 'Gold with Glow'], ['blueShadow', 'Gradient with Shadow'], ['redHollow', 'Red Hollow'], ['grayReflected', 'Gray with Reflection'], ['greenGradient', 'Green Gradient']];
const ALL_ART = [...ART_STYLES, ...EXTRA_ART];
function artStyleAny(id, theme) {
  const q = artStyle(id, theme);
  if (q) return q;
  const solid = c => ({type: 'solid', color: c, transparency: 0}), line = (c, w) => ({color: c, width: w, transparency: 0});
  const grad = (a, b) => ({type: 'gradient', stops: [{pos: 0, color: a, transparency: 0}, {pos: 100, color: b, transparency: 0}], angle: 90});
  switch (id) {
    case 'plain': return {fill: solid(theme[0] ?? [0, 0, 0])};
    case 'outlineDark': return {fill: solid(theme[1] ?? [255, 255, 255]), outline: line(theme[0] ?? [0, 0, 0], 1.5)};
    case 'goldGlow': return {fill: solid([255, 192, 0]), glow: {color: [255, 192, 0], size: 8, transparency: 60}};
    case 'blueShadow': return {fill: grad(theme[4], theme[8]), shadow: defaultShadow()};
    case 'redHollow': return {fill: {type: 'none'}, outline: line([192, 0, 0], 1.5)};
    case 'grayReflected': return {fill: solid([89, 89, 89]), reflection: defaultTextReflection()};
    case 'greenGradient': return {fill: grad(theme[9], theme[2]), outline: line(theme[0] ?? [0, 0, 0], 0.5)};
    default: return null;
  }
}
const artTile = ctx => ALL_ART.map(([id, label]) => ({id, label, value: id, iconOnly: true, art: {kind: 'wordArt', effects: artStyleAny(id, themeRgb(ctx))}}));

export default defineCommands({
  family: 'objfmt/shape',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.effects', label: 'Shape Effects', risk: 'edit',
      description: 'Shape Effects of the selected chart, picture or shape: `shadow` (preset such as offsetBottomRight, or null), `glow` (points, or null), `softEdge` (points, or null), `reflection` (tight, half, full, or null), `bevel` (circle, slope, ... or null).',
      params: s.object({shadow: s.optional(s.any()), glow: s.optional(s.any()),
        softEdge: s.optional(s.any()), reflection: s.optional(s.any()),
        bevel: s.optional(s.any()), id: ID, kind: KIND}),
      state: needs(KINDS, 'an object'), run: effects},
    {id: 'shape.quickStyle', label: 'Shape Styles', risk: 'edit',
      description: 'Apply one of the 42 Shape Styles (`index` 0 to 41: six rows, Dark 1 and Accent 1 to 6) to the selected shape (fill, outline, effect) or to the chart area of the selected chart.',
      params: s.object({index: s.integer({min: 0, max: SHAPE_STYLES.length - 1}), id: ID, kind: KIND}), state: styleState, run: quickStyle},
    {id: 'shape.change', label: 'Change Shape', risk: 'edit',
      description: `Change the selected shape (\`shape\`: ${SHAPE_KINDS.join(', ')}); its text, colours and place stay.`,
      params: s.object({shape: s.enum(SHAPE_KINDS), id: ID, kind: KIND}), state: needs(['shape'], 'a shape'), run: changeShape},
    {id: 'wordArt.style', label: 'WordArt Styles', risk: 'edit',
      description: `A WordArt style for the text of the selected shape or chart (\`style\`: ${ALL_ART.map(x => x[0]).join(', ')}).`,
      params: s.object({style: s.enum(ALL_ART.map(x => x[0])), id: ID, kind: KIND}), state: ctx => { const st = needs(['shape', 'chart'], 'a shape or chart')(ctx); return st.enabled ? {...st, value: artTile(ctx)} : st; }, run: wordArtStyle},
    {id: 'wordArt.textFill', label: 'Text Fill', risk: 'edit',
      description: 'Text Fill of the selected shape\'s (or chart\'s) text: a colour ("#RRGGBB"), "none" (hollow), `{gradient: [colour, colour], angle}` or null (automatic).',
      params: s.object({fill: s.optional(s.any()), id: ID, kind: KIND}), state: needs(['shape', 'chart'], 'a shape or chart'), run: wordArtFill},
    {id: 'wordArt.textOutline', label: 'Text Outline', risk: 'edit',
      description: 'Text Outline of the selected shape\'s (or chart\'s) text: a colour, "none", `{color, width}` (a weight alone keeps the colour) or null (automatic).',
      params: s.object({outline: s.optional(s.any()), id: ID, kind: KIND}), state: needs(['shape', 'chart'], 'a shape or chart'), run: wordArtOutline},
    {id: 'wordArt.textEffect', label: 'Text Effects', risk: 'edit',
      description: 'Text Effects of the selected shape\'s (or chart\'s) text: `shadow` (preset or null), `glow` (points or null), `reflection` (true, an object or null).',
      params: s.object({shadow: s.optional(s.any()), glow: s.optional(s.any()), reflection: s.optional(s.any()), id: ID, kind: KIND}),
      state: needs(['shape', 'chart'], 'a shape or chart'), run: wordArtEffect},
    {id: 'object.setAlt', label: 'Alt Text', risk: 'edit', dialog: 'dialog.altText',
      description: 'The alternative text of a chart, picture or shape (`alt`), or mark it decorative (`decorative`).',
      params: s.object({alt: s.optional(s.string({max: 2000})), decorative: s.optional(s.boolean()), id: ID, kind: KIND}), state: needs(KINDS, 'an object'), run: setAlt},
    {id: 'chart.selectElement', label: 'Chart Elements', risk: 'read', effect: 'view',
      description: 'Pick the part of the selected chart (Chart Area, Plot Area, a series) the Format tab changes.',
      params: s.object({element: s.optional(s.string({max: 20})), id: ID}),
      state: ctx => { const st = needs(['chart'], 'a chart')(ctx); if (!st.enabled) return st; const c = selectedOf(ctx, ['chart']).object; const cur = elementOf(ctx, c); return {...st, value: cur === 'chartArea' ? 'Chart Area' : cur === 'plotArea' ? 'Plot Area' : 'Series ' + (Number(cur.slice(6)) + 1)}; }, run: selectElement},
    {id: 'chart.resetStyle', label: 'Reset to Match Style', risk: 'edit',
      description: 'Take off the formatting of the selected chart (area, plot area, series colours, effects, text) so it matches its chart style.',
      params: s.object({id: ID}), state: needs(['chart'], 'a chart'), run: resetStyle},
  ],
});

export {hexOf, hasDoc};
