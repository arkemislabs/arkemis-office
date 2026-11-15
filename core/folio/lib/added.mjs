// Add content: text and images added to a page. Each item is its own content stream tagged /PCMark /Added, with its parameters (text, font, size,
// colour, alignment, box; or the image and box) kept in the stream dictionary under /PCAdded, so it stays editable (move, resize, retype, reformat,
// delete) without content-stream surgery while every viewer sees ordinary page content. Boxes are in display space (points, origin at the bottom-left of
// the page as shown, after /UserUnit and /Rotate), so items stay upright on rotated pages.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/added.rs, added/types.rs   Content, AddedText, AddedImage (new, matrix, crop_valid, clamp_crop), Family, Align, CHAR_SPACING_LIMIT
//   crates/edit/src/added/layout.rs            latin_width, wrapped (greedy words, every \n a paragraph), lines, text_rect, norm, nums
//   crates/edit/src/added/draw.rs              draw (the Latin path: q view cm, BT /PCF<face> size Tf rg, Tc, one Tm per line at the baseline 0.95 em
//                                              below the line top, justified by word spacing, the image clipped to its box), params (/PCAdded)
//   crates/edit/src/added/store.rs             parse, scan_markers, validate, write, list_added, add_content, update_content, delete_content
//   crates/engine/src/edit/run.rs              AddImage (an image with no box is centred at 80 % of the page, never enlarged)
// Not translated (docs/spec/patches/folio/edit.json): text shaped with the craft-fonts faces (Arabic, Hebrew, Thai: refused, the same message as for
// existing text), per-paragraph alignments (aligns), isolate_content, pasting. No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFHexString, PDFBool, PDFRawStream} from 'pdf-lib';
import {contents, placeTagged, checkOnTop, viewMatrix, displaySize, userUnit, matrixNumber, bin, decoded} from './edit-place.mjs';
import {n, literal, winAnsiBytes, firstUndrawable} from './fonts.mjs';
import {stdTextWidth, familyBaseFont} from './text-font.mjs';
import {TextError} from './text-interp.mjs';
import {unicodeFor, needsUnicode, wrapLines} from './unicode-text.mjs';

const N = s => PDFName.of(s);
export const TAG = 'Added';
export const CHAR_SPACING_LIMIT = 500;
export const FAMILIES = ['Helvetica', 'Times', 'Courier'];
const ALIGN_CODES = {left: 0, center: 1, right: 2, justify: 3};
const ALIGNS = ['left', 'center', 'right', 'justify'];
const MIN_CROP_KEEP = 0.05;
const CROP_ROUNDING = 1e-9;
const invalid = message => new TextError(message);

export const defaultText = () => ({kind: 'text', rect: [0, 0, 0, 0], text: '', family: 'Helvetica', bold: false, italic: false, size: 12, color: [0, 0, 0], align: 'left', charSpacing: 0});
export const norm = r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

/** The standard face a family and style mean. */
export const baseFontOf = t => familyBaseFont(t.family, t.bold, t.italic);

// Text in a script the standard faces cannot draw (Cyrillic, Devanagari, Arabic, Hebrew, Thai, Chinese...): prepareUnicode (before adding or changing an item on `doc`) embeds a
// system font for it and the layout and drawing below use it (shaped, in reading order: lib/unicode-text.mjs); the text set stays until the next prepareUnicode.
let UNI = null;
export async function prepareUnicode(doc, texts) { UNI = await unicodeFor(doc, texts.filter(t => typeof t === 'string')); }
const style = t => ({bold: !!t.bold, italic: !!t.italic});
const uniLine = s => !!UNI && needsUnicode(s) && UNI.canDraw(s);

/** latin_width: the advance of `s` in the item's standard font plus the character spacing after each character (a system font for text the standard faces cannot draw). */
export const latinWidth = (t, s) => (uniLine(s) ? UNI.width(s, t.size, style(t)) : stdTextWidth(baseFontOf(t), s, t.size)) + t.charSpacing * [...s].length;

/** wrapped: the lines of a text item after wrapping to its box width, each with its paragraph. */
export function wrapped(t) {
  const width = Math.max(t.rect[2] - t.rect[0], t.size);
  const out = [];
  String(t.text).split(String.fromCharCode(10)).forEach((para, index) => {
    if (uniLine(para)) { for (const l of wrapLines(para, width, s => latinWidth(t, s))) out.push([l, false, index]); return; }
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && latinWidth(t, candidate) > width) { out.push([line, false, index]); line = word; } else line = candidate;
    }
    out.push([line, false, index]);
  });
  return out;
}
export const lines = t => wrapped(t).map(l => l[0]);

/** text_rect: the box a text item occupies (the height follows its lines). */
export function textRect(t) {
  const r = norm(t.rect);
  const h = Math.max(lines(t).length, 1) * t.size * 1.2;
  return [r[0], r[3] - h, r[2], r[3]];
}

/** first_undrawable, for the standard fonts: the first character they can't draw (Arabic, Hebrew and Thai are refused as for existing text). */
export const undrawable = t => String(t.text).split(String.fromCharCode(10)).map(line => (uniLine(line) ? null : firstUndrawable(line))).find(Boolean) ?? null;

// ── images ─────────────────────────────────────────────────────────────────────────────────────

const cropValid = c => {
  const [l, b, r, t] = c;
  const most = 1 - MIN_CROP_KEEP;
  return c.every(v => Number.isFinite(v) && v >= 0 && v < 1) && l + r <= most + CROP_ROUNDING && b + t <= most + CROP_ROUNDING;
};
export const clampCrop = crop => {
  const most = 1 - MIN_CROP_KEEP;
  const [l, b, r, t] = crop.map(v => (Number.isFinite(v) ? Math.max(v, 0) : 0));
  const fit = (a, c) => { const half = a / 2 + c / 2; return half > (most + CROP_ROUNDING) / 2 ? [a / 2 / half * most, c / 2 / half * most] : [a, c]; };
  const [[l2, r2], [b2, t2]] = [fit(l, r), fit(b, t)];
  return [l2, b2, r2, t2];
};
const mulM = (m, c) => [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
/** AddedImage::matrix: image space (the unit square) → display space: crop, flip, rotate (quarter turns counterclockwise), then fill the box. */
export function imageMatrix(i) {
  const [l, b, r, t] = clampCrop(i.crop ?? [0, 0, 0, 0]);
  const [cw, ch] = [1 - l - r, 1 - b - t];
  let m = [1 / cw, 0, 0, 1 / ch, -l / cw, -b / ch];
  if (i.flipH) m = mulM(m, [-1, 0, 0, 1, 1, 0]);
  if (i.flipV) m = mulM(m, [1, 0, 0, -1, 0, 1]);
  for (let q = 0; q < ((i.rotation ?? 0) % 4); q++) m = mulM(m, [0, 1, -1, 0, 1, 0]);
  const [x0, y0, x1, y1] = norm(i.rect);
  return mulM(m, [x1 - x0, 0, 0, y1 - y0, x0, y0]);
}

// ── drawing ────────────────────────────────────────────────────────────────────────────────────

/** `placed`: where line `i` starts in the box and its word spacing (justified: every line of a paragraph but its last fills the box). */
function placed(t, r, paras, i, w, spaces) {
  const ends = paras[i + 1] !== paras[i];
  const tw = t.align === 'justify' && !ends && spaces > 0 ? Math.max((r[2] - r[0]) - w, 0) / spaces : 0;
  const x = t.align === 'center' ? r[0] + ((r[2] - r[0]) - w) / 2 : t.align === 'right' ? r[2] - w : r[0];
  return [x, tw];
}

/** draw: the content of an item and its resources; `view` maps display space to user space. */
export function draw(doc, c, view) {
  const ctx = doc.context;
  let out = `q ${view.map(matrixNumber).join(' ')} cm\n`;
  const res = {};
  if (c.kind === 'text') {
    const base = baseFontOf(c);
    const name = `PCF${base.replace(/-/g, '')}`;
    const ascii = [...c.text].every(ch => ch.codePointAt(0) < 128);
    const font = {Type: 'Font', Subtype: 'Type1', BaseFont: base};
    if (c.family !== 'Courier' || !ascii) font.Encoding = 'WinAnsiEncoding';
    res.Font = {[name]: ctx.obj(font)};
    const r = textRect(c);
    const [cr, cg, cb] = c.color.map(v => Math.min(Math.max(v, 0), 1));
    out += `BT /${name} ${n(c.size)} Tf ${n(cr)} ${n(cg)} ${n(cb)} rg\n`;
    if (c.charSpacing !== 0) out += `${n(c.charSpacing)} Tc\n`;
    const all = wrapped(c);
    const paras = all.map(l => l[2]);
    all.forEach(([line], i) => {
      const w = latinWidth(c, line);
      const y = r[3] - (i * 1.2 + 0.95) * c.size;
      const [x, tw] = placed(c, r, paras, i, w, line.split(' ').length - 1);
      out += uniLine(line) ? `1 0 0 1 ${n(x)} ${n(y)} Tm ${UNI.ops(line, c.size, style(c))}` : `1 0 0 1 ${n(x)} ${n(y)} Tm ${n(tw)} Tw ${literal(winAnsiBytes(line))} Tj\n`;
    });
    out += 'ET\n';
    if (UNI) for (const f of UNI.fonts()) res.Font[f.name] = f.ref;
  } else {
    const name = `PCImg${c.image.objectNumber}`;
    res.XObject = {[name]: c.image};
    const r = norm(c.rect);
    const m = imageMatrix(c);
    out += `${n(r[0])} ${n(r[1])} ${n(r[2] - r[0])} ${n(r[3] - r[1])} re W n ${n(m[0])} ${n(m[1])} ${n(m[2])} ${n(m[3])} ${n(m[4])} ${n(m[5])} cm /${name} Do\n`;
  }
  return {content: out + 'Q\n', res};
}

/** params: the item as its /PCAdded dictionary. */
function params(doc, c, unit) {
  const ctx = doc.context;
  const d = {};
  const arr = v => ctx.obj(v);
  if (c.kind === 'text') {
    d.Kind = 'Text';
    d.Text = PDFHexString.fromText(c.text);
    d.Font = baseFontOf(c);
    d.Size = c.size;
    d.Color = arr(c.color);
    d.Align = ALIGN_CODES[c.align] ?? 0;
    d.Rect = arr(textRect(c));
    if (c.charSpacing !== 0) d.CharSpacing = c.charSpacing;
  } else {
    d.Kind = 'Image';
    d.Image = c.image;
    d.Rect = arr(norm(c.rect));
    if ((c.rotation ?? 0) % 4) d.Rotate = (c.rotation % 4) * 90;
    if (c.flipH) d.FlipH = PDFBool.True;
    if (c.flipV) d.FlipV = PDFBool.True;
    if (c.crop && c.crop.some(v => v !== 0)) d.Crop = arr(c.crop);
  }
  if (unit !== 1) d.UserUnit = unit;
  return ctx.obj(d);
}

function validate(c) {
  const r = c.rect;
  if (!r.every(Number.isFinite)) throw invalid('invalid position');
  if (c.kind === 'text') {
    if (!String(c.text).trim()) throw invalid('type some text first');
    if (!(Number.isFinite(c.size) && c.size >= 1 && c.size <= 500)) throw invalid('the font size must be between 1 and 500 points');
    if (!(Number.isFinite(c.charSpacing) && Math.abs(c.charSpacing) <= CHAR_SPACING_LIMIT)) throw invalid(`the character spacing must be between -${CHAR_SPACING_LIMIT} and ${CHAR_SPACING_LIMIT} points`);
    if (Math.abs(r[2] - r[0]) < 1) throw invalid('the text box is too narrow');
    const bad = undrawable(c);
    if (bad) throw invalid(`the standard fonts can't draw "${bad}" (U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}); only Western European characters can be added as text for now`);
  } else if (Math.abs(r[2] - r[0]) < 1 || Math.abs(r[3] - r[1]) < 1) throw invalid('the image is too small');
  else if (c.crop && !cropValid(c.crop)) throw invalid('the crop would leave less than 5 % of the image');
}

/** The page gets its own copy of its resources with the item's fonts and images added. */
function addResources(doc, page, res) {
  const ctx = doc.context;
  const inherited = page.node.Resources();
  const out = inherited ? inherited.clone(ctx) : ctx.obj({});
  for (const [kind, entries] of Object.entries(res)) {
    const sub = out.lookup(N(kind));
    const copy = sub instanceof PDFDict ? sub.clone(ctx) : ctx.obj({});
    for (const [name, obj] of Object.entries(entries)) copy.set(N(name), obj);
    out.set(N(kind), copy);
  }
  page.node.set(N('Resources'), out);
}

const arrayOf = (doc, v) => {
  const a = doc.context.lookup(v);
  if (!(a instanceof PDFArray)) return [];
  return a.asArray().map(x => doc.context.lookup(x)).filter(x => x instanceof PDFNumber).map(x => x.asNumber());
};
const nameOf = v => (v instanceof PDFName ? v.decodeText() : null);

/** parse: an item from its /PCAdded dictionary. */
function parse(doc, d) {
  const ctx = doc.context;
  const rect = arrayOf(doc, d.get(N('Rect')));
  if (rect.length !== 4) return null;
  const kind = nameOf(ctx.lookup(d.get(N('Kind'))));
  if (kind === 'Text') {
    const base = nameOf(ctx.lookup(d.get(N('Font')))) ?? 'Helvetica';
    const family = base.startsWith('Times') ? 'Times' : base.startsWith('Courier') ? 'Courier' : 'Helvetica';
    const color = arrayOf(doc, d.get(N('Color')));
    const t = ctx.lookup(d.get(N('Text')));
    const num = (k, dflt) => { const v = ctx.lookup(d.get(N(k))); return v instanceof PDFNumber && Number.isFinite(v.asNumber()) ? v.asNumber() : dflt; };
    return {kind: 'text', rect, text: t && typeof t.decodeText === 'function' ? t.decodeText() : '', family, bold: base.includes('Bold'), italic: /Italic|Oblique/.test(base), size: num('Size', 12),
      color: color.length === 3 ? color : [0, 0, 0], align: ALIGNS[num('Align', 0)] ?? 'left', charSpacing: num('CharSpacing', 0)};
  }
  if (kind === 'Image') {
    const image = d.get(N('Image'));
    if (!(image instanceof PDFRef)) return null;
    const rot = ctx.lookup(d.get(N('Rotate')));
    const crop = arrayOf(doc, d.get(N('Crop')));
    return {kind: 'image', rect, image, rotation: rot instanceof PDFNumber ? ((((rot.asNumber() % 360) + 360) % 360) / 90) | 0 : 0, flipH: ctx.lookup(d.get(N('FlipH'))) === PDFBool.True,
      flipV: ctx.lookup(d.get(N('FlipV'))) === PDFBool.True, crop: crop.length === 4 ? crop : [0, 0, 0, 0]};
  }
  return null;
}

/** list_added: the page's added items in drawing order: {ref, content}. */
export function listAdded(doc, page) {
  const out = [];
  const unit = userUnit(page);
  for (const ref of contents(doc, page)) {
    const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    const dict = s?.dict;
    if (!(dict instanceof PDFDict) || nameOf(dict.get(N('PCMark'))) !== TAG) continue;
    const p = doc.context.lookup(dict.get(N('PCAdded')));
    if (!(p instanceof PDFDict)) continue;
    const content = parse(doc, p);
    if (!content) continue;
    const w = doc.context.lookup(p.get(N('UserUnit')));
    const written = w instanceof PDFNumber && Number.isFinite(w.asNumber()) && w.asNumber() >= 1 ? w.asNumber() : 1;
    const k = unit / written;
    out.push({ref, objectNumber: ref instanceof PDFRef ? ref.objectNumber : null, content: k === 1 ? content : {...content, rect: content.rect.map(v => v * k), ...(content.kind === 'text' ? {size: content.size * k, charSpacing: content.charSpacing * k} : {})}});
  }
  return out;
}

/** Whether a content stream belongs to an added item (the text editor leaves those to the item's own editing). */
export const isAddedStream = (doc, ref) => {
  const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  return s?.dict instanceof PDFDict && nameOf(s.dict.get(N('PCMark'))) === TAG;
};

const bytesOfString = s => bin(s);

/** write: an item's stream (new, or replacing `ref`) with its resources on the page. */
function write(doc, page, c, ref, extra) {
  validate(c);
  const ctx = doc.context;
  const view = viewMatrix(page, extra);
  const {content, res} = draw(doc, c, view);
  if (!ref) checkOnTop(doc, page);
  addResources(doc, page, res);
  const unit = userUnit(page);
  const pc = params(doc, c, unit);
  if (!ref) {
    const r = placeTagged(doc, page, TAG, content, false);
    ctx.lookup(r).dict.set(N('PCAdded'), pc);
    return r;
  }
  const stream = ctx.flateStream(bytesOfString(content), {PCMark: TAG, PCAdded: pc});
  ctx.assign(ref, stream);
  return ref;
}

/** add_content: add an item to a page; returns its stream's reference. */
// The text set stays until the next prepareUnicode (the command lays the item out again to select it).
const written = fn => fn();
export const addContent = (doc, page, c, extra = 0) => written(() => write(doc, page, c, null, extra));
/** update_content: replace item `ref`. */
export function updateContent(doc, page, ref, c, extra = 0) { return written(() => write(doc, page, c, ref, extra)); }
/** delete_content: remove item `ref` from the page. */
export function deleteContent(doc, page, ref) {
  const list = contents(doc, page).filter(o => !(o instanceof PDFRef && ref instanceof PDFRef && o.objectNumber === ref.objectNumber));
  page.node.set(N('Contents'), doc.context.obj(list));
}

/** AddImage's box when none is given: centred, 80 % of the page at most, never enlarged. Display space. */
export function centredBox(page, extra, natural) {
  const [pw, ph] = displaySize(page, extra);
  const k = Math.min(pw * 0.8 / natural[0], ph * 0.8 / natural[1], 1);
  const [w, h] = [natural[0] * k, natural[1] * k];
  return [(pw - w) / 2, (ph - h) / 2, (pw + w) / 2, (ph + h) / 2];
}

export {PDFRawStream, decoded};
