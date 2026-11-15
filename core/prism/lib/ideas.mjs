// Design Ideas: arrangements of what is on the current slide (picture full-bleed with the title on
// a band, picture on one half, a framed picture, text-only layouts). An idea moves and resizes the
// slide's own shapes and crops pictures to their new box; it changes only that slide. All of it
// is computed here, offline.
// Translated from deckcraft crates/engine/src/cmd/ideas.rs (`ideas_for`, `roles`, `arrangeable`,
// `apply_idea`, `cover_crop`, `band_fill`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {ctxForSlide, xfrm as resolveXfrm, fill as resolveFill, line as resolveLine} from '../model/resolve.mjs';
import {isTitlePh} from '../model/presentation.mjs';
import {bodyText} from '../model/text.mjs';
import {colorRgb, colorWith, fillSolid} from '../model/style.mjs';
import {rgb} from '../model/color.mjs';

const PICTURE_IDEAS = Object.freeze([
  ['fullBleed', 'Full-bleed picture, title on a band'], ['pictureLeft', 'Picture left, text right'],
  ['pictureRight', 'Picture right, text left'], ['framed', 'Framed picture beside the title'],
]);
const TEXT_IDEAS = Object.freeze([
  ['titleColumn', 'Title column beside the text'], ['centred', 'Centred title over the text'], ['titleBottom', 'Text above, title at the foot'],
]);

const isPicture = sh => sh.kind?.type === 'picture';
const hasText = sh => !!sh.text && bodyText(sh.text).trim() !== '';
const isTitle = sh => !!sh.ph && isTitlePh(sh.ph.kind);

function roles(shapes) {
  const r = {title: null, picture: null, text: []};
  const area = j => { const x = shapes[j]?.xfrm; return x ? x.w * x.h : 0; };
  shapes.forEach((sh, i) => {
    if (sh.hidden) return;
    if (isTitle(sh) && r.title === null) r.title = i;
    else if (isPicture(sh)) { if (r.picture === null || area(i) > area(r.picture)) r.picture = i; }
    else if (hasText(sh)) r.text.push(i);
  });
  return r;
}

/** Whether the shape paints a fill or an outline once inherited and style-referenced values are resolved. */
function shows(ctx, sh) {
  const visible = f => !!f && f.kind !== 'none';
  if (!ctx) return visible(sh.fill) || visible(sh.line?.fill);
  return visible(resolveFill(ctx, sh)[0]) || visible(resolveLine(ctx, sh)[0]?.fill);
}

/** A picture, a placeholder or a plain text box may move; anything else is laid out by its own geometry. */
function arrangeable(ctx, sh) {
  if (isPicture(sh)) return true;
  if ((sh.kind?.type ?? 'shape') !== 'shape') return false;
  return (!!sh.ph || sh.textBox === true) && (isTitle(sh) || hasText(sh) || !shows(ctx, sh));
}

/** The ideas for slide `index` (none when it has nothing to arrange, or other content in the way): [[id, label]…]. */
export function ideasFor(doc, index) {
  const slide = doc.slides?.[index];
  if (!slide) return [];
  const ctx = ctxForSlide(doc, slide);
  const shapes = slide.shapes ?? [];
  if (shapes.some(sh => !sh.hidden && !arrangeable(ctx, sh))) return [];
  if (shapes.filter(sh => !sh.hidden && isPicture(sh)).length > 1) return [];
  const r = roles(shapes);
  if (r.picture !== null) return [...PICTURE_IDEAS];
  if (r.title !== null && r.text.length) return [...TEXT_IDEAS];
  return [];
}

/** Crop a picture whose source has aspect `src` (w/h) to fill a box of aspect `dst`, centred. */
export function coverCrop(src, dst) {
  if (![src, dst].every(v => Number.isFinite(v) && v > 0)) return [0, 0, 0, 0];
  if (src > dst) { const cut = (1 - dst / src) / 2; return [cut, 0, cut, 0]; }
  const cut = (1 - src / dst) / 2;
  return [0, cut, 0, cut];
}

/** The light fill behind the title in the full-bleed idea; its opacity an alpha transform, as PPTX stores it. */
export const bandFill = () => fillSolid(colorWith(colorRgb(rgb(255, 255, 255)), {op: 'alpha', val: 86274}));
const isBand = f => JSON.stringify(f) === JSON.stringify(bandFill()) || (f?.kind === 'solid' && f.color?.base?.kind === 'rgb' && f.color.base.rgb.a === 220 && !(f.color.mods ?? []).length);

/** The shapes of slide `index` after idea `id`; throws when the idea does not apply. */
export function applyIdea(doc, index, id) {
  if (!ideasFor(doc, index).some(i => i[0] === id)) throw new Error(`no idea \`${id}\` for this slide (see design.ideas)`);
  const sw = Math.max(doc.slideSize.width, 1), sh = Math.max(doc.slideSize.height, 1);
  const slide = doc.slides[index];
  const shapes = structuredClone(slide.shapes);
  const ctx = ctxForSlide(doc, slide);
  const r = roles(shapes);
  const boxes = shapes.map(s => (ctx ? resolveXfrm(ctx, s) : s.xfrm) ?? {x: 0, y: 0, w: 0, h: 0});
  const m = Math.min(sw, sh) * 0.06;
  const place = [];
  const box = (x, y, w, h) => ({x, y, w, h});
  const stack = b => {
    const n = Math.max(r.text.length, 1), gap = m * 0.4;
    const h = Math.max((b.h - gap * (n - 1)) / n, 1);
    r.text.forEach((i, k) => place.push([i, box(b.x, b.y + k * (h + gap), b.w, h)]));
  };
  let band = false;
  switch (id) {
    case 'fullBleed':
      if (r.picture !== null) place.push([r.picture, box(0, 0, sw, sh)]);
      if (r.title !== null) { place.push([r.title, box(m, sh * 0.68, sw - 2 * m, sh * 0.2)]); band = true; }
      stack(box(m, sh * 0.06, sw * 0.45, sh * 0.5));
      break;
    case 'pictureLeft': case 'pictureRight': {
      const left = id === 'pictureLeft', half = sw * 0.5;
      const [px, tx] = left ? [0, half + m] : [half, m];
      if (r.picture !== null) place.push([r.picture, box(px, 0, half, sh)]);
      const tw = half - 2 * m;
      if (r.title !== null) place.push([r.title, box(tx, m, tw, sh * 0.24)]);
      stack(box(tx, m + sh * 0.28, tw, sh - 2 * m - sh * 0.28));
      break;
    }
    case 'framed': {
      if (r.picture !== null) place.push([r.picture, box(sw * 0.42, m * 1.5, sw * 0.58 - m * 1.5, sh - 3 * m)]);
      const tw = sw * 0.42 - 2 * m;
      if (r.title !== null) place.push([r.title, box(m, m * 1.5, tw, sh * 0.3)]);
      stack(box(m, m * 1.5 + sh * 0.34, tw, sh - 3 * m - sh * 0.34));
      break;
    }
    case 'titleColumn':
      if (r.title !== null) place.push([r.title, box(m, m, sw * 0.32, sh - 2 * m)]);
      stack(box(sw * 0.36, m, sw * 0.64 - m, sh - 2 * m));
      break;
    case 'centred':
      if (r.title !== null) place.push([r.title, box(sw * 0.1, m, sw * 0.8, sh * 0.26)]);
      stack(box(sw * 0.18, m + sh * 0.3, sw * 0.64, sh - 2 * m - sh * 0.3));
      break;
    case 'titleBottom':
      stack(box(m, m, sw - 2 * m, sh * 0.62));
      if (r.title !== null) place.push([r.title, box(m, sh * 0.72, sw - 2 * m, sh * 0.2)]);
      break;
    default: throw new Error(`no idea \`${id}\``);
  }
  for (const [i, x] of place) {
    const s = shapes[i], old = boxes[i];
    if (!s || !old) continue;
    if (isPicture(s)) {
      const fill = s.kind.fill;
      const c = fill.crop ?? [0, 0, 0, 0];
      const fw = Math.max(1 - c[0] - c[2], 0.01), fh = Math.max(1 - c[1] - c[3], 0.01);
      const src = (old.w / fw) / Math.max(old.h / fh, 1e-6);
      fill.crop = coverCrop(src, x.w / Math.max(x.h, 1e-6));
    }
    s.xfrm = {...x, rot: 0};
  }
  // The picture goes to the back, so text over it stays readable.
  if (r.picture !== null && r.picture < shapes.length) { const [pic] = shapes.splice(r.picture, 1); shapes.unshift(pic); }
  const t = shapes.find(x => !x.hidden && isTitle(x));
  if (t) {
    if (band) t.fill = bandFill();
    else if (t.fill && isBand(t.fill)) t.fill = null;
  }
  return shapes;
}
