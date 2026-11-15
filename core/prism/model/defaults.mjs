// A new presentation: one master with the standard set of layouts, master text styles, and a first
// title slide. Positions and sizes are deckcraft's own (16:9 at 960 × 540 pt, 4:3 scaled).
// Translated from deckcraft crates/model/src/defaults.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {colorScheme, colorWith, fillSolid} from './style.mjs';
import {listSet, paragraph} from './text.mjs';
import {defaultTheme} from './theme.mjs';
import {shape, slide as newSlideObj, layoutById, allocId, isFooterPh, defaultShowSettings, defaultHeaderFooter, defaultProperties} from './presentation.mjs';

export const WIDE = Object.freeze({width: 960, height: 540});
export const STANDARD = Object.freeze({width: 720, height: 540});

/** Slide size presets for Design › Slide Size (label, width, height in points). */
export const SLIDE_SIZES = Object.freeze([
  ['Widescreen (16:9)', 960, 540], ['Standard (4:3)', 720, 540], ['On-screen Show (16:10)', 720, 450], ['Letter Paper (8.5x11 in)', 720, 540],
  ['Ledger Paper (11x17 in)', 960, 720], ['A3 Paper (297x420 mm)', 1008, 756], ['A4 Paper (210x297 mm)', 780, 540], ['B4 (ISO) Paper (250x353 mm)', 852, 639],
  ['B5 (ISO) Paper (176x250 mm)', 598, 448.5], ['35mm Slides', 810, 540], ['Overhead', 720, 540], ['Banner', 576, 72],
  ['Widescreen (13.333x7.5 in)', 960, 540], ['Square (1:1)', 540, 540], ['Portrait (9:16)', 540, 960],
]);

const ph = (kind, idx) => ({kind, idx, vertical: false, size: null, hasCustomPrompt: false});
const shrink = () => ({kind: 'shrink', fontScale: 1, lineReduction: 0});
const bodyWith = (anchor, autofit) => ({body: {anchor, autofit}, paragraphs: []});
const tx1 = () => fillSolid(colorScheme('tx1'));

function level(size, margin, indent, before) {
  return {
    para: {align: 'left', marginLeft: margin, indent, lineSpacing: {kind: 'pct', v: 0.9}, spaceBefore: {kind: 'pts', v: before}, bullet: {kind: 'char', char: '•'}, bulletFont: 'Arial'},
    run: {size, font: '+mn-lt', fill: tx1(), kern: 12},
  };
}

/** Master text styles: title, body (bulleted levels) and other. */
export function masterStyles() {
  let title = {levels: []};
  title = listSet(title, 0, {
    para: {align: 'left', lineSpacing: {kind: 'pct', v: 0.9}, spaceBefore: {kind: 'pts', v: 0}, bullet: {kind: 'none'}},
    run: {size: 44, font: '+mj-lt', fill: tx1(), kern: 12},
  });
  let body = {levels: []};
  [28, 24, 20, 18, 18, 18, 18, 18, 18].forEach((sz, i) => { body = listSet(body, i, level(sz, 18 + 36 * i, -18, i === 0 ? 10 : 5)); });
  let other = {levels: []};
  for (let i = 0; i < 9; i++) other = listSet(other, i, {para: {marginLeft: 36 * i, align: 'left'}, run: {size: 18, font: '+mn-lt', fill: tx1(), kern: 12}});
  return [title, body, other];
}

/** Presentation default text style for free shapes and text boxes. */
export function defaultTextStyle() {
  let s = {levels: []};
  for (let i = 0; i < 9; i++) s = listSet(s, i, {para: {marginLeft: 36 * i, align: 'left'}, run: {size: 18, font: '+mn-lt', fill: tx1(), kern: 12}});
  return s;
}

/**
 * The master and its eleven standard layouts for a slide size, with ids starting after `firstId`.
 * Returns [master, nextFreeId].
 */
export function buildMaster(size, theme, firstId) {
  const {width: w, height: h} = size;
  const sx = w / 960, sy = h / 540;
  const r = (x, y, ww, hh) => [x * sx, y * sy, ww * sx, hh * sy];
  let next = firstId;
  const mk = (name, kind, idx, [x, y, ww, hh]) => {
    next += 1;
    return shape({id: String(next), name, xfrm: {x, y, w: ww, h: hh}, ph: ph(kind, idx), text: {body: {}, paragraphs: []}});
  };
  const footers = () => {
    const [x1, y1, w1, h1] = r(60, 500, 216, 28);
    const [x2, , w2] = r(318, 500, 324, 28);
    const [x3, , w3] = r(684, 500, 216, 28);
    const d = mk('Date Placeholder', 'date', 10, [x1, y1, w1, h1]);
    const f = mk('Footer Placeholder', 'footer', 11, [x2, y1, w2, h1]);
    const n = mk('Slide Number Placeholder', 'slideNum', 12, [x3, y1, w3, h1]);
    const small = align => listSet({levels: []}, 0, {para: {align}, run: {size: 12, fill: fillSolid(colorWith(colorScheme('tx1'), {op: 'tint', val: 75000}))}});
    for (const [s, a] of [[d, 'left'], [f, 'center'], [n, 'right']]) {
      s.text.body.anchor = 'middle';
      s.text.listStyle = small(a);
    }
    n.text.paragraphs = [{level: 0, runs: [{text: '‹#›', kind: {kind: 'field', field: 'slidenum'}}]}];
    return [d, f, n];
  };
  const titleBox = () => {
    const s = mk('Title 1', 'title', 0, r(60, 29, 840, 104));
    s.text = bodyWith('middle', shrink());
    return s;
  };
  const bodyBox = (name, idx, x, y, ww, hh) => {
    const s = mk(name, 'body', idx, r(x, y, ww, hh));
    s.text = bodyWith('top', shrink());
    return s;
  };
  const withPh = (s, kind) => { s.ph.kind = kind; return s; };

  // Master placeholders.
  const mshapes = [titleBox(), bodyBox('Text Placeholder 2', 1, 60, 144, 840, 343), ...footers()];
  for (const s of mshapes) {
    if (s.text && !s.text.paragraphs.length) {
      const prompt = s.ph.kind === 'title' ? 'Click to edit Master title style' : s.ph.kind === 'body' ? 'Click to edit Master text styles' : '';
      if (prompt) s.text.paragraphs = [paragraph(prompt)];
    }
  }

  const layouts = [];
  const lay = (name, kind, shapes) => {
    next += 1;
    layouts.push({id: String(next), name, kind, shapes, background: null, showMasterShapes: true, preserve: true});
  };
  const levelOnly = (para, run) => listSet({levels: []}, 0, {para: para ?? {}, run: run ?? {}});
  const noBullet = {marginLeft: 0, indent: 0, bullet: {kind: 'none'}};

  { // Title Slide
    const t = mk('Title 1', 'ctrTitle', 0, r(120, 88, 720, 188));
    t.text = {body: {anchor: 'bottom', autofit: shrink()}, listStyle: levelOnly({align: 'center'}, {size: 60}), paragraphs: []};
    const st = mk('Subtitle 2', 'subTitle', 1, r(120, 284, 720, 130));
    st.text = {body: {anchor: 'top', autofit: shrink()}, listStyle: levelOnly({align: 'center', ...noBullet}, {size: 24}), paragraphs: []};
    lay('Title Slide', 'title', [t, st, ...footers()]);
  }
  { // Title and Content
    const t = titleBox();
    const c = withPh(bodyBox('Content Placeholder 2', 1, 60, 144, 840, 343), 'obj');
    lay('Title and Content', 'titleAndContent', [t, c, ...footers()]);
  }
  { // Section Header
    const t = mk('Title 1', 'title', 0, r(65, 135, 830, 225));
    t.text = {body: {anchor: 'bottom'}, listStyle: levelOnly(null, {size: 60}), paragraphs: []};
    const s = bodyBox('Text Placeholder 2', 1, 65, 362, 830, 118);
    s.text.listStyle = levelOnly({...noBullet}, {size: 24, fill: fillSolid(colorWith(colorScheme('tx1'), {op: 'tint', val: 82000}))});
    lay('Section Header', 'sectionHeader', [t, s, ...footers()]);
  }
  { // Two Content
    const t = titleBox();
    const l = withPh(bodyBox('Content Placeholder 2', 1, 60, 144, 412, 343), 'obj');
    const rr = withPh(bodyBox('Content Placeholder 3', 2, 488, 144, 412, 343), 'obj');
    lay('Two Content', 'twoContent', [t, l, rr, ...footers()]);
  }
  { // Comparison
    const t = titleBox();
    const head = (name, idx, x) => {
      const s = mk(name, 'body', idx, r(x, 133, 412, 62));
      s.text = {body: {anchor: 'bottom'}, listStyle: levelOnly({...noBullet}, {size: 24, bold: true}), paragraphs: []};
      return s;
    };
    const h1 = head('Text Placeholder 2', 1, 60);
    const c1 = withPh(bodyBox('Content Placeholder 3', 2, 60, 198, 412, 289), 'obj');
    const h2 = head('Text Placeholder 4', 3, 488);
    const c2 = withPh(bodyBox('Content Placeholder 5', 4, 488, 198, 412, 289), 'obj');
    lay('Comparison', 'comparison', [t, h1, c1, h2, c2, ...footers()]);
  }
  lay('Title Only', 'titleOnly', [titleBox(), ...footers()]);
  lay('Blank', 'blank', footers());
  { // Content with Caption
    const t = mk('Title 1', 'title', 0, r(60, 36, 322, 126));
    t.text = {body: {anchor: 'bottom'}, listStyle: levelOnly(null, {size: 32}), paragraphs: []};
    const c = withPh(bodyBox('Content Placeholder 2', 1, 412, 78, 488, 384), 'obj');
    const cap = bodyBox('Text Placeholder 3', 2, 60, 162, 322, 300);
    cap.text.listStyle = levelOnly({...noBullet}, {size: 16});
    lay('Content with Caption', 'contentWithCaption', [t, c, cap, ...footers()]);
  }
  { // Picture with Caption
    const t = mk('Title 1', 'title', 0, r(60, 36, 322, 126));
    t.text = {body: {anchor: 'bottom'}, listStyle: levelOnly(null, {size: 32}), paragraphs: []};
    const p = mk('Picture Placeholder 2', 'picture', 1, r(412, 78, 488, 384));
    const cap = bodyBox('Text Placeholder 3', 2, 60, 162, 322, 300);
    cap.text.listStyle = levelOnly({...noBullet}, {size: 16});
    lay('Picture with Caption', 'pictureWithCaption', [t, p, cap, ...footers()]);
  }
  { // Title and Vertical Text
    const t = titleBox();
    const c = bodyBox('Vertical Text Placeholder 2', 1, 60, 144, 840, 343);
    c.text.body.vert = 'eaVertical';
    c.ph.vertical = true;
    lay('Title and Vertical Text', 'titleAndVerticalText', [t, c, ...footers()]);
  }
  { // Vertical Title and Text
    const t = mk('Vertical Title 1', 'title', 0, r(687, 29, 213, 458));
    t.text = {body: {vert: 'eaVertical'}, paragraphs: []};
    t.ph.vertical = true;
    const c = bodyBox('Vertical Text Placeholder 2', 1, 60, 29, 612, 458);
    c.text.body.vert = 'eaVertical';
    c.ph.vertical = true;
    lay('Vertical Title and Text', 'verticalTitleAndText', [t, c, ...footers()]);
  }

  const [titleStyle, bodyStyle, otherStyle] = masterStyles();
  next += 1;
  const master = {
    id: String(next), name: theme.name, theme, shapes: mshapes, background: {kind: 'ref', idx: 1001, color: colorScheme('bg1')},
    titleStyle, bodyStyle, otherStyle, layouts, colorMap: [], preserve: false,
  };
  return [master, next + 1];
}

/** A new presentation with one title slide. */
export const newPresentation = theme => blankPresentation(WIDE, theme ?? defaultTheme(), true);

export function blankPresentation(size, theme, titleSlide) {
  const [master, next] = buildMaster(size, theme, 1);
  const firstLayout = master.layouts[0]?.id ?? '0';
  let p = {
    slideSize: {width: size.width, height: size.height}, notesSize: {width: 540, height: 720}, slides: [], masters: [master], notesMaster: null,
    handoutMaster: null, sections: [], customShows: [], show: defaultShowSettings(), headerFooter: defaultHeaderFooter(), props: defaultProperties(),
    defaultTextStyle: defaultTextStyle(), media: [], firstSlideNumber: 1, nextId: Math.max(next, 256), embeddedFonts: [],
  };
  if (titleSlide) {
    const made = newSlide(p, firstLayout);
    if (made) p = {...made.pres, slides: [made.slide]};
  }
  return p;
}

/**
 * A slide for `layout` with its placeholders instantiated (empty, inheriting position). Returns
 * `{slide, nextId, pres}` (`pres` with nextId advanced) or null when the deck has used every id.
 */
export function newSlide(pres, layout) {
  let p = pres;
  const take = () => {
    const a = allocId(p);
    if (!a) return null;
    p = {...p, nextId: a[1]};
    return a[0];
  };
  const id = take();
  if (id === null) return null;
  const shapes = [];
  for (const ls of layoutById(p, layout)?.[1]?.shapes ?? []) {
    if (!ls.ph || isFooterPh(ls.ph.kind)) continue;
    const sid = take();
    if (sid === null) return null;
    shapes.push(shape({id: sid, name: ls.name, ph: {...ls.ph}, text: {body: {}, paragraphs: []}}));
  }
  return {slide: newSlideObj({id, layout, shapes}), nextId: p.nextId, pres: p};
}

/** Layout of a kind in the first master. */
export const layoutOfKind = (p, kind) => p.masters?.[0]?.layouts?.find(l => l.kind === kind)?.id ?? null;
