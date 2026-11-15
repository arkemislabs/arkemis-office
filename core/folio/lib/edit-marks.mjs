// Page marks: Acrobat's Header & Footer (with Bates numbering), Watermark and Background, added,
// updated (replaced) and removed as tagged content streams on the page.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/edit/src/marks.rs — MarkKind tags, HeaderFooter (defaults, first_undrawable, bands),
//    shrink_matrix, MarkSource, Watermark, Background, picture, add_picture_resource, Context,
//    n, rgb, expand (the <<…>> tokens), bates_start;
//  * crates/edit/src/apply.rs — add_header_footer, add_watermark, add_background, remove_marks,
//    marks_present;
//  * crates/edit/src/added/types.rs — Family (label, base_font, width);
//  * crates/engine/src/pictures.rs — mark_source (a PDF page as a form XObject, or an image);
//  * crates/engine/src/edit/run.rs — RemoveMarks refuses "there is nothing to remove".
// Marks are drawn in display space (after /Rotate) inside a /Artifact marked-content sequence and
// tagged /PCMark so Update and Remove find them without decompressing content (edit/src/lib.rs).
// No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {Font, FontNames, Encodings} from '@pdf-lib/standard-fonts';
import {PDFName, PDFRef, PDFDict} from 'pdf-lib';
import {CommandError} from '../../kernel/errors.mjs';
import {n, winAnsiByte} from './fonts.mjs';
import {unicodeFor, needsUnicode} from './unicode-text.mjs';
import {
  pageList, check, displaySize, viewMatrix, contents, streamTag, wrapperRole, isolation, pageFonts, freeFontName,
  addPageResources, addResources, placeTagged, checkOnTop, placeInsideWrapper, begin, END, undrawable, textOp, matrixNumber, str,
} from './edit-place.mjs';

export const MARK_KINDS = Object.freeze(['HeaderFooter', 'Watermark', 'Background']);

// ---------------------------------------------------------------------------------------------
// Standard faces (added/types.rs Family)

export const FAMILIES = Object.freeze(['Helvetica', 'Times', 'Courier']);
const BASE = {Helvetica: 'Helvetica', Times: 'Times-Roman', Courier: 'Courier'};
const FONT_NAME = {Helvetica: FontNames.Helvetica, Times: FontNames.TimesRoman, Courier: FontNames.Courier};
const loaded = new Map();
let names = null;
/** Family::base_font (regular). */
export const baseFont = family => BASE[family] ?? 'Helvetica';
function glyphWidth(font, code) {
  if (!names) {
    names = new Map();
    for (const [, [c, glyph]] of Object.entries(Encodings.WinAnsi.unicodeMappings)) if (!names.has(c)) names.set(c, glyph);
  }
  try { return font.getWidthOfGlyph(names.get(code) ?? 'question') ?? 0; } catch { return 0; }
}
/** Family::width: the WinAnsi advances of `s` at `size` in the family's regular face (Std14 text_width). */
export function familyWidth(family, s, size) {
  const key = FONT_NAME[family] ?? FontNames.Helvetica;
  if (!loaded.has(key)) loaded.set(key, Font.load(key));
  const font = loaded.get(key);
  let w = 0;
  for (const ch of String(s)) w += glyphWidth(font, ch === '	' ? 0x20 : winAnsiByte(ch) ?? 0x3f);
  return (w * size) / 1000;
}

/** fonts first_non_win_ansi: the first character the standard fonts can't draw (line breaks excepted by `lines()`). */
function firstNonWinAnsi(line) {
  for (const ch of line) if (ch !== '\t' && winAnsiByte(ch) === null) return ch;
  return null;
}
const linesOf = s => { const parts = String(s).split('\n').map(l => l.replace(/\r$/, '')); if (parts.at(-1) === '') parts.pop(); return parts; };

// ---------------------------------------------------------------------------------------------
// Settings (marks.rs)

/** HeaderFooter::default: Acrobat's 8 pt black, margins 0.5 in top and bottom, 1 in left and right. */
export const defaultHeaderFooter = () => ({text: ['', '', '', '', '', ''], font: 'Helvetica', fontSize: 8, color: [0, 0, 0], underline: false,
  margins: [36, 36, 72, 72], startNumber: 1, shrink: false});
/** Watermark::default. */
export const defaultWatermark = () => ({text: '', source: null, scale: 0.5, fontSize: 0, color: [0.6, 0.6, 0.6], opacity: 0.5, rotation: 45, behind: false, offset: [0, 0]});
/** Background::default. */
/** A light yellow that still reads as a colour on screen (a near-white default looked as if nothing had happened; printcraft 8f16855 marks.rs). The backdrop replacement it gained (backdrop.rs: a white backdrop the page paints itself would hide the background) is not translated: docs/spec/patches/folio/edit.json. */
export const defaultBackground = () => ({color: [1, 0.95, 0.7], opacity: 1, source: null, scale: 1});

/** HeaderFooter::first_undrawable. */
export function hfFirstUndrawable(hf) {
  for (const t of hf.text) for (const l of linesOf(t)) { const c = firstNonWinAnsi(l); if (c) return c; }
  return null;
}
/** Watermark::first_undrawable (a picture draws no text). */
export function wmFirstUndrawable(wm) {
  if (wm.source) return null;
  for (const l of linesOf(String(wm.text).trim())) { const c = firstNonWinAnsi(l); if (c) return c; }
  return null;
}

/**
 * The Unicode text set for a header/footer's or watermark's texts, made ready on `doc` (lib/unicode-text.mjs, shaped, in reading order): null when every text is in the standard
 * faces. The page numbers, dates and Bates numbers the texts expand to are made ready too (printable ASCII).
 */
export async function markUnicode(doc, texts) {
  const list = texts.map(t => String(t ?? ''));
  if (!list.some(needsUnicode)) return null;
  return unicodeFor(doc, [`${list.join(' ')} ${String.fromCharCode(...Array.from({length: 95}, (_, i) => 32 + i))}`]);
}
/** Whether every line of a text is drawn: by the standard faces, or by the Unicode text set where it has the font. */
const markDrawable = (uni, text) => linesOf(text).every(l => !firstNonWinAnsi(l) || !!(uni && uni.canDraw(l)));

/**
 * One page's use of a Unicode text set: its font names (PCU1...) are replaced by names free in the page's font dictionary, so a mark never replaces a font the page already
 * names; `install(page)` puts the fonts used into the page's own (copied) resources.
 */
function pageUnicode(doc, page, uni) {
  const taken = pageFonts(doc, page);
  const used = new Map();
  const nameFor = setName => {
    if (!used.has(setName)) {
      let k = 1;
      while (taken.get(PDFName.of(`PCM${k}`)) !== undefined || [...used.values()].includes(`PCM${k}`)) k++;
      used.set(setName, `PCM${k}`);
    }
    return used.get(setName);
  };
  return {
    ops: (line, size) => uni.ops(line, size).replace(/\/(PCU\d+) /g, (m, name) => `/${nameFor(name)} `),
    install(target) {
      if (!used.size) return;
      const ctx = doc.context;
      const inherited = target.node.Resources();
      const res = inherited ? inherited.clone(ctx) : ctx.obj({});
      const f = res.lookup(PDFName.of('Font'));
      const fonts = f instanceof PDFDict ? f.clone(ctx) : ctx.obj({});
      for (const font of uni.fonts()) if (used.has(font.name)) fonts.set(PDFName.of(used.get(font.name)), font.ref);
      res.set(PDFName.of('Font'), fonts);
      target.node.set(PDFName.of('Resources'), res);
    },
  };
}

/** HeaderFooter::bands: the room the header and footer take at the top and bottom. */
export function bands(hf) {
  const size = hf.fontSize, lineH = size * 1.2;
  const lines = boxes => {
    const counts = boxes.filter(t => String(t).trim()).map(t => Math.max(1, linesOf(t).length));
    return counts.length ? Math.max(...counts) : null;
  };
  const header = lines(hf.text.slice(0, 3)), footer = lines(hf.text.slice(3));
  const top = header === null ? 0 : hf.margins[0] + size + (header - 1) * lineH + size / 2;
  const bottom = footer === null ? 0 : hf.margins[1] + size * 0.8 + (footer - 1) * lineH + size / 2;
  return [top, bottom];
}

const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** marks.rs `shrink_matrix`: the cm that shrinks the original content into the free band. */
export function shrinkMatrix(hf, [w, h], view) {
  const [top, bottom] = bands(hf);
  const free = h - top - bottom;
  if (!(Number.isFinite(free) && free >= 1 && Number.isFinite(w) && w > 0)) {
    throw new CommandError('invalid_params', 'the header and footer margins leave no room for the page content to shrink into');
  }
  const k = free / h;
  const det = view[0] * view[3] - view[1] * view[2];
  if (!(Number.isFinite(det) && Math.abs(det) > 1e-12)) throw new CommandError('invalid_params', "the page can't be shrunk: its view matrix is degenerate");
  const shrink = [k, 0, 0, k, (w - w * k) / 2, bottom];
  // kurbo: (v * shrink * v⁻¹) applies v⁻¹ first; in PDF row-vector order that is v⁻¹ · shrink · v.
  return mul(mul(invert(view), shrink), view);
}

const rgb = c => `${c.map(x => n(Math.min(1, Math.max(0, x)))).join(' ')} rg`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = v => String(v).padStart(2, '0');
const yy = y => p2(((y % 100) + 100) % 100);

/** marks.rs `expand`: the <<…>> tokens for page number `p` of `count`, Bates number `bates`, today's `date` [y, m, d]. */
export function expand(template, p, count, bates, date) {
  const [y, m, d] = date;
  let out = '', rest = String(template);
  for (;;) {
    const start = rest.indexOf('<<');
    if (start < 0) break;
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf('>>');
    if (end < 0) return out + rest.slice(start);
    const token = after.slice(0, end);
    const table = {
      '1': `${p}`, n: `${count}`, '1 of n': `${p} of ${count}`, '1/n': `${p}/${count}`, 'Page 1': `Page ${p}`, 'Page 1 of n': `Page ${p} of ${count}`,
      'm/d': `${m}/${d}`, 'm/d/yy': `${m}/${d}/${yy(y)}`, 'm/d/yyyy': `${m}/${d}/${y}`, 'mm/dd/yy': `${p2(m)}/${p2(d)}/${yy(y)}`,
      'mm/dd/yyyy': `${p2(m)}/${p2(d)}/${y}`, 'd/m/yy': `${d}/${m}/${yy(y)}`, 'd/m/yyyy': `${d}/${m}/${y}`, 'dd/mm/yyyy': `${p2(d)}/${p2(m)}/${y}`,
      'd.m.yy': `${d}.${m}.${yy(y)}`, 'd.m.yyyy': `${d}.${m}.${y}`, 'dd.mm.yy': `${p2(d)}.${p2(m)}.${yy(y)}`, 'dd.mm.yyyy': `${p2(d)}.${p2(m)}.${y}`,
      'yyyy-mm-dd': `${y}-${p2(m)}-${p2(d)}`, 'yyyy/mm/dd': `${y}/${p2(m)}/${p2(d)}`, 'yyyy/m/d': `${y}/${m}/${d}`,
      'mmmm d, yyyy': `${MONTHS[Math.min(12, Math.max(1, m)) - 1]} ${d}, ${y}`,
    };
    let value;
    if (Object.hasOwn(table, token)) value = table[token];
    else if (token.startsWith('Bates Number')) {
      const parts = token.split('#');
      const dg = Number.parseInt(parts[1], 10);
      const digits = Math.min(15, Math.max(1, Number.isFinite(dg) && /^\d+$/.test(parts[1] ?? '') ? dg : 6));
      value = `${parts[3] ?? ''}${String(bates).padStart(digits, '0')}${parts[4] ?? ''}`;
    } else value = `<<${token}>>`;
    out += value;
    rest = after.slice(end + 2);
  }
  return out + rest;
}

/** marks.rs `bates_start`: the start number in a <<Bates Number#digits#start#…>> template (1 when unreadable). */
export function batesStart(template) {
  const i = String(template).indexOf('<<Bates Number');
  if (i < 0) return null;
  const t = template.slice(i + 2);
  const e = t.indexOf('>>');
  if (e < 0) return null;
  const s = t.slice(0, e).split('#')[2];
  return s !== undefined && /^\d+$/.test(s) ? BigInt(s) : 1n;
}

/** marks.rs `picture`: a picture fitted to the page at `scale`, centred (plus offset), turned. */
export function picture(src, [w, h], scale, rotation, offset) {
  const sw = Math.max(src.size[0], 0.01), sh = Math.max(src.size[1], 0.01);
  const k = Math.min(w / sw, h / sh) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const dw = sw * k, dh = sh * k;
  const rad = rotation * Math.PI / 180, s = Math.sin(rad), c = Math.cos(rad);
  const cx = w / 2 + offset[0], cy = h / 2 + offset[1];
  const place = src.image ? `${n(dw)} 0 0 ${n(dh)} ${n(-dw / 2)} ${n(-dh / 2)} cm` : `${n(k)} 0 0 ${n(k)} ${n(-dw / 2)} ${n(-dh / 2)} cm`;
  return `${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(cx)} ${n(cy)} cm\n${place}\n/PCPic${src.xobject.objectNumber} Do\n`;
}

/** marks.rs `add_picture_resource`: /PCPic<num> in the page's own resources. */
function addPictureResource(doc, page, src) {
  const ctx = doc.context;
  const inherited = page.node.Resources();
  const res = inherited ? inherited.clone(ctx) : ctx.obj({});
  const x = res.lookup(PDFName.of('XObject'));
  const xo = x && typeof x.clone === 'function' ? x.clone(ctx) : ctx.obj({});
  xo.set(PDFName.of(`PCPic${src.xobject.objectNumber}`), src.xobject);
  res.set(PDFName.of('XObject'), xo);
  page.node.set(PDFName.of('Resources'), res);
}

/**
 * pictures.rs `mark_source`: a picture file (bytes) brought into `doc` — page `page` of a PDF as a
 * form XObject, or a PNG/JPEG image. Returns {xobject: PDFRef, size: [w, h], image}.
 */
export async function markSource(doc, {name = 'the file', bytes, page = 0}) {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length)));
  if (head.includes('%PDF-')) {
    let embedded;
    try {
      const {PDFDocument} = await import('pdf-lib');
      const src = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
      if (page < 0 || page >= src.getPageCount()) throw new CommandError('not_found', `page ${page + 1} does not exist`);
      const sp = src.getPage(page), cb = sp.getCropBox();
      embedded = await doc.embedPage(sp, {left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height});
    } catch (e) {
      if (e instanceof CommandError) throw e;
      throw new CommandError('failed', `${name}: ${e.message}`);
    }
    await embedded.embed();
    return {xobject: embedded.ref, size: [embedded.width, embedded.height], image: false};
  }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpg) throw new CommandError('invalid_params', `${name}: only PDF, PNG and JPEG files can be used as a picture here`);
  let img;
  try { img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); } catch (e) { throw new CommandError('failed', `${name}: ${e.message}`); }
  await img.embed();
  return {xobject: img.ref, size: [img.width, img.height], image: true};
}

// ---------------------------------------------------------------------------------------------
// Applying (apply.rs)

const U32_MAX = 4294967295n;
const U64_MAX = 18446744073709551615n;

/**
 * apply.rs `add_header_footer` on pages (0-based source indices). `extra[i]` is the model's own
 * rotation of page i (drawn in the page's displayed orientation). `date` is today's [y, m, d].
 */
export function addHeaderFooter(doc, pages, hf, replace, date, extra = () => 0, unicode = null) {
  let all = pageList(doc);
  check(pages, all.length);
  if (hf.text.every(t => !String(t).trim())) throw new CommandError('invalid_params', 'type the header or footer text first');
  const c = hfFirstUndrawable(hf);
  if (c && !hf.text.every(t => markDrawable(unicode, t))) throw undrawable(c);
  if (!(Number.isFinite(hf.fontSize) && hf.fontSize > 0 && hf.fontSize <= 200 && hf.margins.every(m => Number.isFinite(m) && m >= 0))) {
    throw new CommandError('invalid_params', 'invalid font size or margins');
  }
  const lastNumber = BigInt(hf.startNumber) + BigInt(Math.max(0, pages.length - 1));
  if (lastNumber > U32_MAX) throw new CommandError('invalid_params', `the header start number ${hf.startNumber} leaves no room for ${pages.length} pages (page numbers stop at ${U32_MAX})`);
  let bates0 = 1n;
  for (const t of hf.text) { const b = batesStart(t); if (b !== null) { bates0 = b; break; } }
  if (bates0 + BigInt(Math.max(0, pages.length - 1)) > U64_MAX) throw new CommandError('invalid_params', `the Bates start number ${bates0} leaves no room for ${pages.length} pages (Bates numbers stop at ${U64_MAX})`);
  const shrinks = pages.map(i => (hf.shrink ? shrinkMatrix(hf, displaySize(all[i], extra(i)), viewMatrix(all[i], extra(i))) : null));
  for (const i of pages) checkOnTop(doc, all[i]);
  if (replace) removeMarks(doc, pages, 'HeaderFooter');
  all = pageList(doc);
  const count = all.length;
  pages.forEach((i, k) => {
    const page = all[i];
    const [w, h] = displaySize(page, extra(i));
    const number = hf.startNumber + k;
    const bates = bates0 + BigInt(k);
    const size = hf.fontSize;
    const [top, bottom, left, right] = hf.margins;
    const preferred = {Helvetica: 'PCHelv', Times: 'PCTimes', Courier: 'PCCour'}[hf.font] ?? 'PCHelv';
    const base = baseFont(hf.font);
    const fonts = pageFonts(doc, page);
    const resource = freeFontName(doc, fonts, preferred, base);
    const own = unicode ? pageUnicode(doc, page, unicode) : null;
    let body = `BT\n/${resource} ${n(size)} Tf\n${rgb(hf.color)}\n`;
    let underlines = '';
    hf.text.forEach((template, slot) => {
      if (!String(template).trim()) return;
      const lines = linesOf(expand(template, number, count, bates, date));
      const header = slot < 3, lineH = size * 1.2;
      lines.forEach((line, li) => {
        const uni = own && firstNonWinAnsi(line) && unicode.canDraw(line);
        const tw = uni ? unicode.width(line, size) : familyWidth(hf.font, line, size);
        const x = slot % 3 === 0 ? left : slot % 3 === 1 ? (w - tw) / 2 : w - right - tw;
        const y = header ? h - top - size * 0.8 - li * lineH : bottom + (lines.length - 1 - li) * lineH;
        if (uni) body += `1 0 0 1 ${n(x)} ${n(y)} Tm ${own.ops(line, size)}/${resource} ${n(size)} Tf\n`;
        else body += textOp(x, y, line);
        if (hf.underline) underlines += `${n(x)} ${n(y - size * 0.15)} ${n(tw)} ${n(Math.max(size * 0.06, 0.4))} re f\n`;
      });
    });
    body += 'ET\n';
    if (underlines) body += `${rgb(hf.color)}\n${underlines}`;
    const content = begin('HeaderFooter', 'Header', viewMatrix(page, extra(i))) + body + END;
    if (fonts.get(PDFName.of(resource)) === undefined) addPageResources(doc, page, null, [[resource, base]]);
    if (own) own.install(page);
    placeTagged(doc, pageList(doc)[i], 'HeaderFooter', content, false);
    const m = shrinks[k];
    if (m) placeInsideWrapper(doc, pageList(doc)[i], 'HeaderFooter', `${m.map(matrixNumber).join(' ')} cm\n`);
  });
}

/** apply.rs `add_watermark` (text, or the picture in `wm.source`). */
export function addWatermark(doc, pages, wm, replace, extra = () => 0, unicode = null) {
  const all = pageList(doc);
  check(pages, all.length);
  const text = String(wm.text ?? '').trim();
  if (!text && !wm.source) throw new CommandError('invalid_params', 'type the watermark text first');
  const c = wmFirstUndrawable(wm);
  if (c && !markDrawable(unicode, text)) throw undrawable(c);
  if (!(Number.isFinite(wm.opacity) && Number.isFinite(wm.rotation) && Number.isFinite(wm.fontSize) && wm.fontSize >= 0 && wm.offset.every(Number.isFinite))) {
    throw new CommandError('invalid_params', 'invalid watermark settings');
  }
  if (!wm.behind) for (const i of pages) checkOnTop(doc, all[i]);
  if (replace) removeMarks(doc, pages, 'Watermark');
  const opacity = Math.min(1, Math.max(0, wm.opacity));
  const gs = `/PCGS${Math.round(opacity * 100)} gs\n`;
  const lines = linesOf(text);
  for (const i of pages) {
    const page = pageList(doc)[i];
    const [w, h] = displaySize(page, extra(i));
    if (wm.source) {
      const content = begin('Watermark', 'Watermark', viewMatrix(page, extra(i))) + gs + picture(wm.source, [w, h], wm.scale, wm.rotation, wm.offset) + END;
      addResources(doc, page, opacity, null);
      addPictureResource(doc, pageList(doc)[i], wm.source);
      placeTagged(doc, pageList(doc)[i], 'Watermark', content, wm.behind);
      continue;
    }
    const own = unicode ? pageUnicode(doc, page, unicode) : null;
    const isOwn = l => !!own && !!firstNonWinAnsi(l) && unicode.canDraw(l);
    const widthOf = (l, sz) => (isOwn(l) ? unicode.width(l, sz) : familyWidth('Helvetica', l, sz));
    const widest = Math.max(0.01, ...lines.map(l => widthOf(l, 1)));
    const size = wm.fontSize > 0 ? wm.fontSize : Math.min(300, Math.max(6, Math.sqrt(w * w + h * h) * 0.5 / widest));
    const rad = wm.rotation * Math.PI / 180, s = Math.sin(rad), co = Math.cos(rad);
    const cx = w / 2 + wm.offset[0], cy = h / 2 + wm.offset[1];
    let content = begin('Watermark', 'Watermark', viewMatrix(page, extra(i)));
    content += `${gs}${n(co)} ${n(s)} ${n(-s)} ${n(co)} ${n(cx)} ${n(cy)} cm\nBT\n/PCHelv ${n(size)} Tf\n${rgb(wm.color)}\n`;
    const lineH = size * 1.15, total = lineH * (lines.length - 1);
    lines.forEach((line, li) => {
      const tw = widthOf(line, size);
      if (isOwn(line)) content += `1 0 0 1 ${n(-tw / 2)} ${n(total / 2 - li * lineH - size * 0.35)} Tm ${own.ops(line, size)}/PCHelv ${n(size)} Tf\n`;
      else content += textOp(-tw / 2, total / 2 - li * lineH - size * 0.35, line);
    });
    content += 'ET\n' + END;
    addResources(doc, page, opacity, null);
    if (own) own.install(page);
    placeTagged(doc, pageList(doc)[i], 'Watermark', content, wm.behind);
  }
}

/** apply.rs `add_background`: a solid colour (or picture) behind the page content. */
export function addBackground(doc, pages, bg, replace, extra = () => 0) {
  check(pages, pageList(doc).length);
  if (replace) removeMarks(doc, pages, 'Background');
  const opacity = Number.isFinite(bg.opacity) ? Math.min(1, Math.max(0, bg.opacity)) : 1;
  for (const i of pages) {
    const page = pageList(doc)[i];
    const [w, h] = displaySize(page, extra(i));
    let content = begin('Background', 'Background', viewMatrix(page, extra(i)));
    content += `/PCGS${Math.round(opacity * 100)} gs\n`;
    content += bg.source ? picture(bg.source, [w, h], bg.scale, 0, [0, 0]) : `${rgb(bg.color)}\n0 0 ${n(w)} ${n(h)} re f\n`;
    content += END;
    addResources(doc, page, opacity, null);
    if (bg.source) addPictureResource(doc, pageList(doc)[i], bg.source);
    placeTagged(doc, pageList(doc)[i], 'Background', content, true);
  }
}

/** apply.rs `remove_marks`: marks of `kind` off `pages`, and wrappers left with nothing after them; returns how many. */
export function removeMarks(doc, pages, kind) {
  const all = pageList(doc);
  check(pages, all.length);
  let removed = 0;
  for (const i of pages) {
    const page = all[i];
    const list = contents(doc, page);
    const before = list.length;
    let kept = list.filter(o => streamTag(doc, o) !== kind);
    removed += before - kept.length;
    if (before !== kept.length) {
      const iso = isolation(doc, kept);
      let wrappers;
      if (iso.kind === 'clean') wrappers = iso.wrappers;
      else {
        const opens = [];
        wrappers = [];
        kept.forEach((o, k) => {
          const role = wrapperRole(doc, o);
          if (role === true) opens.push(k);
          else if (role === false && opens.length) wrappers.push([opens.pop(), k]);
        });
      }
      const pairs = new Map(wrappers.map(([open, close]) => [close, open]));
      const discarded = new Set();
      let end = kept.length;
      while (end > 0) {
        const close = end - 1;
        if (discarded.has(close)) end = close;
        else if (pairs.has(close)) { discarded.add(pairs.get(close)); discarded.add(close); end = close; }
        else break;
      }
      kept = kept.filter((_, k) => !discarded.has(k));
    }
    if (before !== kept.length) {
      // The dropped streams are ours (tagged marks and wrappers, referenced from this page only):
      // they leave the file too, so a saved document carries no trace of a removed mark.
      const stay = new Set(kept);
      for (const o of list) if (!stay.has(o) && o instanceof PDFRef && streamTag(doc, o)) doc.context.delete(o);
      page.node.set(PDFName.of('Contents'), doc.context.obj(kept));
    }
  }
  return removed;
}

/** apply.rs `marks_present` (added/store.rs scan_markers): the kinds of marks in the document. */
export function marksPresent(doc) {
  const out = [];
  for (const page of pageList(doc)) for (const o of contents(doc, page)) {
    const t = streamTag(doc, o);
    if (MARK_KINDS.includes(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The kinds of marks in a PDF's bytes, from the stream dictionaries' /PCMark names (they are never
 * inside object streams or compressed): what state() needs synchronously.
 */
export function marksInBytes(bytes) {
  const out = [];
  const s = typeof bytes === 'string' ? bytes : str(bytes);
  for (const k of MARK_KINDS) if (new RegExp(`/PCMark\\s*/${k}(?![A-Za-z0-9])`).test(s)) out.push(k);
  return out;
}
