// Create a PDF from nothing, images or text, and the file kinds Create takes.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/create/src/lib.rs        blank (3 to 14,400 points a side, up to 10,000 pages), the image pages (a page the size of the picture at its
//                                   own resolution: a JFIF density or a PNG pHYs, 72 dpi when it has none), text pages
//   crates/engine/src/sources.rs    source_kind: what Create converts (PDF, an image, text)
//   crates/ui-egui/src/workflows/create_ui.rs   the resolution choice: the image's own, 72 dpi, or a custom dpi
// Not translated: images other than JPEG and PNG (the library embeds those two), ICC profiles, CCITT/JBIG2 packing of black-and-white pictures,
// JPEG 2000 and TIFF. No DOM, no Node built-ins.

import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import {textFace, wrapLines} from './unicode-text.mjs';
import {looksLikePdf} from './page-source.mjs';

export const LETTER = [612, 792];
const MAX_SIDE = 14_400;
const MIN_SIDE = 3;

const fail = message => { const e = new Error(message); e.code = 'invalid_params'; return e; };

/** A blank document of `pages` pages of width x height points. */
export async function blankPdf(width = LETTER[0], height = LETTER[1], pages = 1) {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width >= MIN_SIDE && width <= MAX_SIDE && height >= MIN_SIDE && height <= MAX_SIDE) || !(pages >= 1 && pages <= 10_000)) throw fail('invalid page size or count');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width, height]);
  doc.setProducer('Arkemis PDF');
  return doc.save();
}

/** What a file is to Create: by its bytes first, then its name. */
export function sourceKind(name, bytes) {
  if (looksLikePdf(bytes)) return 'pdf';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (/\.(txt|text|log|md|csv)$/i.test(name) && !bytes.subarray(0, 4096).includes(0)) return 'text';
  return null;
}
export const isImage = kind => kind === 'jpeg' || kind === 'png';

/** The picture's own resolution in dots per inch (JFIF density, PNG pHYs), or null. */
export function imageDpi(kind, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'png') {
    let i = 8;
    while (i + 12 <= bytes.length) {
      const len = dv.getUint32(i), type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      if (type === 'pHYs' && len >= 9 && bytes[i + 16] === 1) { const x = dv.getUint32(i + 8) * 0.0254, y = dv.getUint32(i + 12) * 0.0254; return x > 1 && y > 1 ? [x, y] : null; }
      if (type === 'IDAT') break;
      i += 12 + len;
    }
    return null;
  }
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker === 0xDA || marker === 0xD9) break;
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = dv.getUint16(i + 2);
    if (len < 2) break;
    if (marker === 0xE0 && len >= 14 && String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'JFIF') {
      const unit = bytes[i + 11], x = dv.getUint16(i + 12), y = dv.getUint16(i + 14);
      if (x > 0 && y > 0 && unit === 1) return [x, y];
      if (x > 0 && y > 0 && unit === 2) return [x * 2.54, y * 2.54];
      return null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * A PDF with one page per image, each the size of its picture at the chosen resolution: mode 'image' (its own, 72 when it has none), 'dpi72'
 * (one point a pixel) or 'custom' (`dpi`). The resolution only sets the printed size; the picture is not resampled.
 * @param {{name: string, bytes: Uint8Array}[]} images
 */
export async function imagesPdf(images, {mode = 'image', dpi = 72} = {}) {
  if (!images.length) throw fail('There are no images to create a PDF from.');
  if (mode === 'custom' && !(dpi >= 1 && dpi <= 1200)) throw fail('the resolution must be 1 to 1200 dpi');
  const doc = await PDFDocument.create();
  for (const {name, bytes} of images) {
    const kind = sourceKind(name, bytes);
    if (!isImage(kind)) throw fail(`${name}: only JPEG and PNG pictures can be made into pages`);
    let picture;
    try { picture = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); } catch (e) { throw fail(`${name}: ${e.message}`); }
    const own = imageDpi(kind, bytes) ?? [72, 72];
    const [dx, dy] = mode === 'custom' ? [dpi, dpi] : mode === 'dpi72' ? [72, 72] : own;
    const w = picture.width * 72 / dx, h = picture.height * 72 / dy;
    if (!(w >= MIN_SIDE && h >= MIN_SIDE && w <= MAX_SIDE && h <= MAX_SIDE)) throw fail(`${name}: the page would be ${Math.round(w)} x ${Math.round(h)} points, outside PDF's 3 to 14,400`);
    doc.addPage([w, h]).drawImage(picture, {x: 0, y: 0, width: w, height: h});
  }
  doc.setProducer('Arkemis PDF');
  return doc.save();
}

/** Text pages: Helvetica 11 pt on Letter with 54 pt margins, long lines wrapped, one new page when a page is full. */
export async function textPdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 11, lead = 14, margin = 54, width = LETTER[0] - 2 * margin;
  // Text in a script the standard face lacks (Cyrillic, Greek, Devanagari, Chinese...) is set in a system font embedded for it (lib/unicode-text.mjs).
  const own = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const face = await textFace(doc, font, [own]);
  const safe = face.unicode ? own : own.replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?');
  const lines = face.unicode ? wrapLines(safe, width, s => face.width(s, size)) : [];
  for (const para of face.unicode ? [] : safe.split('\n')) {
    if (!para.length) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(/(?<= )/)) {
      if (font.widthOfTextAtSize(line + word, size) <= width) { line += word; continue; }
      if (line) lines.push(line.replace(/ +$/, ''));
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
        lines.push(rest.slice(0, n)); rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line.replace(/ +$/, ''));
  }
  const perPage = Math.floor((LETTER[1] - 2 * margin) / lead);
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) {
    const page = doc.addPage(LETTER);
    lines.slice(i, i + perPage).forEach((l, k) => { if (l) face.draw(page, l, {x: margin, y: LETTER[1] - margin - size - k * lead, size, color: rgb(0, 0, 0)}); });
  }
  doc.setProducer('Arkemis PDF');
  return doc.save();
}

/** Any source Create takes, as PDF bytes: {kind, bytes}; null for a file it does not understand. */
export async function convertToPdf(name, bytes, options) {
  const kind = sourceKind(name, bytes);
  if (kind === 'pdf') return {kind, bytes};
  if (isImage(kind)) return {kind, bytes: await imagesPdf([{name, bytes}], options)};
  if (kind === 'text') return {kind, bytes: await textPdf(new TextDecoder().decode(bytes))};
  return null;
}
