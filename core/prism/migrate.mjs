// Prism schema 1 → schema 2 (docs/architecture.md 16.1 migration rule, applied to Prism).
// Schema 1 (core/model.mjs, core/prism-content.mjs): `slides[{id, background '#rrggbb', elements[{id,
// type: text|shape|image, x, y, w, h, rotation, flipH, flipV, text, runs, fontSize, fontFamily, bold,
// italic, underline, color, align, fill, geometry, stroke, strokeWidth, dash, headArrow, tailArrow,
// src, placeholder}], notes, hidden, name, layout}], activeSlideId`.
// Schema 2: a deckcraft Presentation (core/prism/model). Slide and element ids are kept, so
// `/sl:<id>` and `/sl:<id>/sp:<id>` addresses stay valid. Every visual property is written
// explicitly (positions, fills, lines, run formatting), so a migrated slide looks as it did.
// Foundation-owned (F:prism). No DOM, no Node built-ins.

import {newPresentation, layoutOfKind} from './model/defaults.mjs';
import {shape, slide, presetGeom, ID_RE} from './model/presentation.mjs';
import {fromHex} from './model/color.mjs';
import {colorRgb, fillSolid, fillNone} from './model/style.mjs';
import {bodyFromText} from './model/text.mjs';
import {validateContent} from './schema.mjs';

export const FROM = 1;
export const TO = 2;

const rgbRef = hex => colorRgb(fromHex(hex) ?? {r: 0, g: 0, b: 0, a: 255});
const PH = {title: 'title', ctrTitle: 'ctrTitle', subTitle: 'subTitle', body: 'body', pic: 'picture', obj: 'obj'};
const LAYOUT_KINDS = new Set(['title', 'titleAndContent', 'sectionHeader', 'twoContent', 'comparison', 'titleOnly', 'blank', 'contentWithCaption', 'pictureWithCaption']);

function runProps(r) {
  const p = {};
  if (r.fontFamily !== undefined) p.font = r.fontFamily;
  if (r.fontSize !== undefined) p.size = r.fontSize;
  if (r.bold !== undefined) p.bold = r.bold;
  if (r.italic !== undefined) p.italic = r.italic;
  if (r.underline !== undefined) p.underline = r.underline ? 'sng' : 'none';
  if (r.color !== undefined) p.fill = fillSolid(rgbRef(r.color));
  return p;
}

/** Schema-1 element text (with runs) as a deckcraft TextBody; `\n` separates paragraphs. */
function textBody(e) {
  const runs = e.runs?.length ? e.runs : [{text: e.text ?? '', fontFamily: e.fontFamily, fontSize: e.fontSize, bold: e.bold, italic: e.italic, underline: e.underline, color: e.color}];
  const paragraphs = [{level: 0, runs: []}];
  const base = runProps(e);
  for (const r of runs) {
    const props = {...base, ...runProps(r)};
    String(r.text ?? '').split('\n').forEach((part, i) => {
      if (i > 0) paragraphs.push({level: 0, runs: [], endProps: props});
      if (part) paragraphs[paragraphs.length - 1].runs.push(Object.keys(props).length ? {text: part, props} : {text: part});
    });
  }
  const align = e.align === 'center' ? 'center' : e.align === 'right' ? 'right' : e.align === 'justify' ? 'justify' : e.align === 'left' ? 'left' : null;
  for (const p of paragraphs) {
    if (align) p.props = {align};
    if (!p.runs.length && !p.endProps && Object.keys(base).length) p.endProps = base;
  }
  return {body: {wrap: true, autofit: {kind: 'none'}, anchor: 'top'}, paragraphs};
}

function dataUrlMedia(src, id) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(src ?? ''));
  if (!m) return null;
  const ext = m[1].split('/')[1]?.replace('jpeg', 'jpg').replace(/\+xml$/, '') ?? 'bin';
  return {id, name: `image${id}.${ext}`, contentType: m[1], data: m[2], link: null};
}

/** Convert one schema-1 element to a deckcraft Shape (and the media it needs). */
function element(e, media, nextId) {
  const x = {x: e.x, y: e.y, w: e.w, h: e.h};
  if (e.rotation) x.rot = e.rotation;
  if (e.flipH) x.flipH = true;
  if (e.flipV) x.flipV = true;
  const id = ID_RE.test(String(e.id)) ? String(e.id) : nextId();
  const ph = e.placeholder && PH[e.placeholder] ? {kind: PH[e.placeholder], idx: e.placeholder === 'title' || e.placeholder === 'ctrTitle' ? 0 : 1, vertical: false, size: null, hasCustomPrompt: false} : null;
  if (e.type === 'image') {
    const mid = nextId();
    const item = dataUrlMedia(e.src, mid);
    if (item) media.push(item);
    return shape({id, name: e.name ?? 'Picture', xfrm: x, ph, kind: {type: 'picture', fill: {media: item ? mid : '0', crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {brightness: 0, contrast: 0, saturation: null, grayscale: false, duotone: null, clearColor: null, sharpen: 0}}}});
  }
  const isShape = e.type === 'shape';
  const sh = shape({
    id, name: e.name ?? (isShape ? 'Shape' : ph ? 'Placeholder' : 'TextBox'), xfrm: x, ph,
    geom: presetGeom(isShape ? e.geometry ?? 'rect' : 'rect'),
    textBox: !isShape && !ph,
    fill: isShape ? (e.fill ? fillSolid(rgbRef(e.fill)) : fillNone()) : fillNone(),
    line: e.stroke || isShape ? {fill: e.stroke ? fillSolid(rgbRef(e.stroke)) : fillNone(), width: e.strokeWidth ?? 1,
      ...(e.dash && e.dash !== 'solid' ? {dash: {kind: 'preset', name: e.dash}} : {}),
      ...(e.headArrow && e.headArrow !== 'none' ? {head: {kind: e.headArrow, w: 'med', len: 'med'}} : {}),
      ...(e.tailArrow && e.tailArrow !== 'none' ? {tail: {kind: e.tailArrow, w: 'med', len: 'med'}} : {})} : {fill: fillNone()},
  });
  if (e.text !== undefined || e.runs?.length || !isShape) sh.text = textBody(e);
  if (isShape && sh.text) sh.text.body.anchor = 'middle';
  return sh;
}

/** Migrate schema-1 content to a validated schema-2 presentation. */
export function migrate(content) {
  const p = newPresentation();
  let next = p.nextId;
  const nextId = () => String(++next);
  const media = [];
  const blank = layoutOfKind(p, 'blank');
  const slides = (content?.slides ?? []).map(s1 => {
    const layoutKind = LAYOUT_KINDS.has(s1.layout) ? s1.layout : null;
    const sl = slide({
      id: ID_RE.test(String(s1.id)) ? String(s1.id) : nextId(),
      layout: (layoutKind && layoutOfKind(p, layoutKind)) || blank,
      name: s1.name ?? '',
      hidden: !!s1.hidden,
      shapes: (s1.elements ?? []).map(e => element(e, media, nextId)),
      notes: bodyFromText(String(s1.notes ?? '')),
    });
    if (s1.background) sl.background = {kind: 'fill', fill: fillSolid(rgbRef(s1.background))};
    return sl;
  });
  const out = {...p, slides, media, nextId: next};
  if (content?.activeSlideId && slides.some(s => s.id === content.activeSlideId)) out.activeSlideId = content.activeSlideId;
  return validateContent(out);
}

/** A schema-1 file → a schema-2 file (same id, title, revision, links). */
export function migrateFile(file) {
  if (file?.schema === 2) return file;
  return {...file, schema: 2, content: migrate(file.content)};
}
