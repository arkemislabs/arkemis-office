// Prism schema-2 content → PDF: what File > Export > Create PDF and Save As > PDF write.
//
// Translated from deckcraft crates/pdf/src/lib.rs (export, plan_pages, build_outline, notes_frames,
// notes_slide_box, master_texts, handout_boxes, raster_scale, Exporter::slide / links / paragraphs /
// note_lines / page_texts / footer, PAPERS, paper_size) at deckcraft commit
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// As upstream: each slide is drawn by the slide renderer at print resolution (so the PDF looks
// exactly like the slide, effects included) and overlaid with an invisible layer of real text, so
// the text can be searched, selected and copied; hyperlinks and shape actions become link
// annotations (web and mail links, and jumps to other slides); slide titles become bookmarks.
// Layouts: one slide per page, notes pages (the slide above its speaker notes) and handouts (1, 2,
// 3, 4, 6 or 9 slides per page, with ruled lines beside each slide for 3 per page), with the notes
// or handout master's header, date, footer and page number.
//
// The slide renderer is Prism's own (src/apps/prism/surface/SlideView.tsx, the SVG the editing
// surface draws), run in a hidden window by the host and handed in as `opts.render(index, size)`
// (or pre-rendered as `opts.rasters[index]`): it returns `{image}` (PNG or JPEG bytes of the slide at
// `size` pixels) and, for the text layer and links, `texts` ([{x, y, size, width, text}] in slide
// points, y the baseline) and `links` ([{rect: [x0, y0, x1, y1], link}] in slide points). Without
// a renderer this module refuses (a PDF drawn some other way would not look like the slide).
//
// What differs (docs/behaviour-fidelity.md), and why:
// * Text layer fonts: upstream embeds subsets of the deck's own faces for the invisible text. pdf-lib
//   embeds a system font (common/lib/pdf-fonts.mjs, through fontkit) for the characters Helvetica cannot encode, and sets the invisible
//   text in Helvetica where it can, squeezed to the width the renderer measured; search, selection and
//   copy behave the same (the glyphs are never painted). Only a character no installed font has is left out.
// * Notes text and master texts (header, date, footer, page number) are set in the PDF standard faces
//   matching the master's family class, at the master's size, colour, weight and slant
//   (upstream `master_texts`, the variant it uses without glyph access).
// No DOM, no Node built-ins; pdf-lib is allowed in core/*/formats (architecture 5.3).

import {PDFDocument, StandardFonts, PDFName, PDFString, PDFHexString, PDFNumber, PDFArray, PDFNull, rgb as pdfRgb, pushGraphicsState, popGraphicsState,
  beginText, endText, setFontAndSize, showText, setTextMatrix, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze} from 'pdf-lib';
import {ctxForSlide, ctxForMaster, ctxColor, xfrm as resolveXfrm, run as resolveRun} from '../model/resolve.mjs';
import {themeFont} from '../model/theme.mjs';
import {systemFonts, textsOf} from '../../common/lib/pdf-fonts.mjs';
import {safeUrl, bodyText} from '../model/text.mjs';
import {slideTitle, notesText} from '../model/presentation.mjs';
import {base64Decode} from './pptx-read.mjs';

export const UPSTREAM = Object.freeze({repo: 'deckcraft', commit: 'f893f6af7d36a5409fd804e81a34fd895cfefedf', files: ['crates/pdf/src/lib.rs']});

export class PdfError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/** Paper sizes the Print page offers: [id, label, [width, height] in points, portrait]. */
export const PAPERS = Object.freeze([['letter', 'Letter (8.5 × 11 in)', [612, 792]], ['a4', 'A4 (210 × 297 mm)', [595.28, 841.89]],
  ['legal', 'Legal (8.5 × 14 in)', [612, 1008]], ['a3', 'A3 (297 × 420 mm)', [841.89, 1190.55]]]);
/** The page size for a paper id (case-insensitive), turned on its side when `landscape`; null for an unknown id. */
export function paperSize(id, landscape) {
  const p = PAPERS.find(x => x[0].toLowerCase() === String(id).trim().toLowerCase());
  if (!p) return null;
  const [w, h] = p[2];
  return landscape ? [h, w] : [w, h];
}
/** deckcraft `PdfOptions::default()`. */
export const defaultPdfOptions = () => ({layout: {kind: 'slides'}, dpi: 200, slides: null, includeHidden: false, textLayer: true, frameSlides: true, title: null, paper: [612, 792]});

const rect = (x0, y0, x1, y1) => ({x0, y0, x1, y1});
const rw = r => r.x1 - r.x0, rh = r => r.y1 - r.y0;
/** The slide box on a notes page: an inch of margin at the sides, the slide at most half the page tall. */
export function notesSlideBox([pw, ph], aspect) {
  let w = Math.max(pw - 2 * 72, 1);
  let h = w / Math.max(aspect, 0.01);
  const maxH = Math.max(ph * 0.5 - 54, 1);
  if (h > maxH) { h = maxH; w = h * aspect; }
  const x = (pw - w) / 2;
  return rect(x, 54, x + w, 54 + h);
}
function masterRect(pres, m, kind, paper) {
  const x = (m.shapes ?? []).find(s => s.ph?.kind === kind)?.xfrm;
  if (!x) return null;
  const kx = paper[0] / Math.max(pres.notesSize?.width ?? 540, 1), ky = paper[1] / Math.max(pres.notesSize?.height ?? 720, 1);
  const r = rect(x.x * kx, x.y * ky, (x.x + x.w) * kx, (x.y + x.h) * ky);
  return rw(r) > 1 && rh(r) > 1 ? r : null;
}
/** A notes page's slide box and notes area: where the notes master puts them, or the default layout. */
export function notesFrames(pres, paper) {
  const [pw, ph] = paper;
  const aspect = Math.max(pres.slideSize.width, 1) / Math.max(pres.slideSize.height, 1);
  const nm = pres.notesMaster ?? null;
  const f = nm ? masterRect(pres, nm, 'slideImage', paper) : null;
  let slide;
  if (f) {
    const [w, h] = rw(f) / rh(f) > aspect ? [rh(f) * aspect, rh(f)] : [rw(f), rw(f) / aspect];
    const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
    slide = rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
  } else slide = notesSlideBox(paper, aspect);
  const notes = (nm ? masterRect(pres, nm, 'body', paper) : null) ?? rect(72, slide.y1 + 36, pw - 72, ph - 54);
  return [slide, notes];
}
/** Slide boxes for a handout page. */
export function handoutBoxes(perPage, [pw, ph], aspect) {
  const [mx, top, bottom] = [54, 54, 54];
  const [cols, rows, notes] = perPage <= 1 ? [1, 1, false] : perPage === 2 ? [1, 2, false] : perPage === 3 ? [1, 3, true] : perPage === 4 ? [2, 2, false] : perPage === 6 ? [2, 3, false] : [3, 3, false];
  const gap = 18;
  const aw = notes ? (pw - 2 * mx) * 0.5 : pw - 2 * mx;
  const ah = ph - top - bottom - 18;
  const cw = (aw - gap * (cols - 1)) / cols, ch = (ah - gap * (rows - 1)) / rows;
  const [w, h] = cw / ch > aspect ? [ch * aspect, ch] : [cw, cw / aspect];
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let cx = mx + c * (cw + gap) + (cw - w) / 2;
      const cy = top + r * (ch + gap) + (ch - h) / 2;
      if (notes) cx = mx;
      out.push(rect(cx, cy, cx + w, cy + h));
    }
  }
  return out;
}
const MAX_RASTER_PIXELS = 64_000_000;
/** Render scale for a slide drawn `boxWidth` points wide at `dpi`, the pixel count capped. */
export function rasterScale(boxWidth, [sw, sh], dpi) {
  const scale = (boxWidth / 72 * Math.min(Math.max(dpi, 36), 600)) / sw;
  const pixels = sw * scale * sh * scale;
  return pixels > MAX_RASTER_PIXELS ? scale * Math.sqrt(MAX_RASTER_PIXELS / pixels) : scale;
}
/** Pages to write: for each, the slides on it and their boxes (page points, y down). */
export function planPages(pres, opts, slides) {
  const sw = Math.max(pres.slideSize.width, 1), sh = Math.max(pres.slideSize.height, 1);
  const L = opts.layout ?? {kind: 'slides'};
  if (L.kind === 'notes') { const b = notesFrames(pres, opts.paper)[0]; return slides.map(i => [[i, b]]); }
  if (L.kind === 'handouts') {
    const boxes = handoutBoxes(L.perPage ?? 6, opts.paper, sw / sh);
    const out = [];
    for (let k = 0; k < slides.length; k += boxes.length) out.push(slides.slice(k, k + boxes.length).map((i, j) => [i, boxes[j]]));
    return out;
  }
  return slides.map(i => [[i, rect(0, 0, sw, sh)]]);
}

/** The resolved style of a master placeholder's first run (upstream `master_text_style`). */
export function masterTextStyle(pres, m, sh) {
  const ctx = ctxForMaster(pres, m);
  const para = sh.text?.paragraphs?.[0] ?? {level: 0, runs: []};
  const own = para.runs?.[0]?.props ?? para.endProps ?? {};
  const r = resolveRun(ctx, sh, para, own);
  const family = r.font ? (r.font.startsWith('+') ? themeFont(m.theme, r.font) : r.font) : '';
  let color = {r: 0x60, g: 0x60, b: 0x60, a: 255};
  if (r.fill?.kind === 'solid') {
    try { color = ctxColor(ctx, r.fill.color, null); } catch { /* keep grey */ }
  }
  return {family, size: Math.min(Math.max(r.size ?? 12, 1), 400), bold: r.bold === true, italic: r.italic === true, color};
}
/** The header, date, footer and page-number texts a master puts on page `n` (upstream `master_texts`). */
export function masterTexts(pres, m, paper, n) {
  const out = [];
  for (const kind of ['header', 'date', 'footer', 'slideNum']) {
    const r = masterRect(pres, m, kind, paper);
    const sh = (m.shapes ?? []).find(s => s.ph?.kind === kind);
    if (!r || !sh) continue;
    const text = kind === 'slideNum' ? String(n) : (sh.text ? bodyText(sh.text) : '').trim();
    if (!text) continue;
    const align = sh.text?.paragraphs?.[0]?.props?.align;
    const right = align ? align === 'right' : kind === 'date' || kind === 'slideNum';
    const style = masterTextStyle(pres, m, sh);
    style.size *= paper[1] / Math.max(pres.notesSize?.height ?? 720, 1);
    out.push([r, text, right, style]);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Drawing helpers (pdf-lib, y up)

const SERIF = /times|georgia|cambria|garamond|book|palatino|minion|serif|roman|mincho|song|batang|constantia|merriweather|playfair/i;
const MONO = /courier|mono|consolas|menlo|code|monaco|lucida console/i;
const FACES = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};
const familyClass = f => (MONO.test(f ?? '') ? 'mono' : SERIF.test(f ?? '') && !/sans/i.test(f ?? '') ? 'serif' : 'sans');
const grey = v => pdfRgb(v / 255, v / 255, v / 255);
const isPng = b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;

/** Shape-level click actions on slide `i` as link areas (slide points), when the renderer gives none. */
function shapeLinks(pres, i) {
  const sl = pres.slides[i];
  const ctx = ctxForSlide(pres, sl);
  const out = [];
  for (const sh of sl.shapes ?? []) {
    if (!sh.click || sh.hidden) continue;
    const x = ctx ? resolveXfrm(ctx, sh) : sh.xfrm;
    if (!x) continue;
    const a = ((x.rot ?? 0) * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const bw = x.w * c + x.h * s, bh = x.w * s + x.h * c;
    const cx = x.x + x.w / 2, cy = x.y + x.h / 2;
    out.push({rect: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], link: sh.click});
  }
  return out;
}

/**
 * Export `pres` as PDF bytes (deckcraft `pdf::export`). `opts` as `defaultPdfOptions()` plus
 * `render` / `rasters` (the slide renderer, see the header).
 */
export async function exportPdf(pres, options = {}) {
  const opts = {...defaultPdfOptions(), ...options};
  const n = (pres.slides ?? []).length;
  const slides = Array.isArray(opts.slides) ? opts.slides.filter(i => Number.isInteger(i) && i >= 0 && i < n)
    : [...Array(n).keys()].filter(i => opts.includeHidden || !pres.slides[i].hidden);
  if (!slides.length) throw new PdfError('NoPages', 'nothing to export (no slides in range)');
  const render = typeof opts.render === 'function' ? opts.render
    : Array.isArray(opts.rasters) ? async i => opts.rasters[i] ?? null : null;
  if (!render) throw new PdfError('Write', 'PDF writer: the slide renderer is needed to export slides as PDF');
  const pdf = await PDFDocument.create();
  const title = opts.title ?? pres.props?.title ?? '';
  if (String(title).trim()) pdf.setTitle(String(title));
  if (String(pres.props?.author ?? '').trim()) pdf.setAuthor(pres.props.author);
  pdf.setCreator('Arkemis Prism');
  pdf.setProducer('Arkemis Prism');
  const sw = Math.max(pres.slideSize.width, 1), sh = Math.max(pres.slideSize.height, 1);
  const pages = planPages(pres, opts, slides);
  const pageOf = new Map();
  pages.forEach((v, p) => v.forEach(([i]) => pageOf.set(i, p)));
  const fonts = {};
  for (const [cls, names] of Object.entries(FACES)) fonts[cls] = await Promise.all(names.map(nm => pdf.embedFont(nm)));
  // Text the standard faces cannot encode is set in a system font (common/lib/pdf-fonts.mjs), found for every string of the deck first.
  const system = await systemFonts(pdf);
  await system.prepare(textsOf(pres), [{}, {bold: true}, {italic: true}, {bold: true, italic: true}]);
  const helv = fonts.sans[0];
  const helvMix = system.mixed(helv, {});
  const L = opts.layout ?? {kind: 'slides'};
  const pdfPages = [];
  const pendingLinks = [];
  for (const v of pages) {
    const [pw, ph] = L.kind === 'slides' ? [sw, sh] : opts.paper;
    const page = pdf.addPage([pw, ph]);
    pdfPages.push(page);
    for (const [i, b] of v) {
      const k = rw(b) / sw;
      const scale = rasterScale(rw(b), [sw, sh], opts.dpi);
      const size = {width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)), scale};
      const out = await render(i, size);
      const bytes = out?.image instanceof Uint8Array ? out.image : out?.image ? new Uint8Array(out.image) : typeof out?.png === 'string' ? base64Decode(out.png) : out?.png ?? null;
      if (!bytes || !bytes.length) throw new PdfError('Write', `PDF writer: slide ${i + 1} could not be drawn`);
      const img = isPng(bytes) ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      page.drawImage(img, {x: b.x0, y: ph - b.y1, width: rw(b), height: rh(b)});
      if (opts.frameSlides && L.kind !== 'slides') page.drawRectangle({x: b.x0, y: ph - b.y1, width: rw(b), height: rh(b), borderColor: grey(0x80), borderWidth: 0.5});
      if (opts.textLayer) {
        for (const t of out.texts ?? []) {
          if (!String(t.text ?? '').trim() || !(t.size > 0)) continue;
          await system.prepare([t.text], [{}]);
          const runs = helvMix.runs(t.text);
          const size2 = t.size * k;
          const natural = helvMix.widthOfTextAtSize(t.text, size2);
          const squeeze = t.width > 0 && natural > 0 ? Math.min(Math.max((t.width * k) / natural * 100, 1), 1000) : 100;
          let x = b.x0 + t.x * k;
          page.pushOperators(pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(squeeze));
          for (const run of runs) {
            page.pushOperators(setFontAndSize(page.node.newFontDictionary(run.pdfFont.name, run.pdfFont.ref), size2), setTextMatrix(1, 0, 0, 1, x, ph - (b.y0 + t.y * k)), showText(run.pdfFont.encodeText(run.text)));
            x += run.pdfFont.widthOfTextAtSize(run.text, size2) * squeeze / 100;
          }
          page.pushOperators(endText(), popGraphicsState());
        }
      }
      const links = Array.isArray(out.links) ? out.links : shapeLinks(pres, i);
      for (const l of links) pendingLinks.push({page, ph, i, b, k, l});
    }
    if (L.kind === 'notes') {
      const i = v[0][0];
      const [, area] = notesFrames(pres, opts.paper);
      paragraphs(page, ph, notesText(pres.slides[i]), area, 12, helvMix);
      pageTexts(page, pw, ph, pres, pres.notesMaster ?? null, opts.paper, i + 1, fonts, system);
    } else if (L.kind === 'handouts') {
      if ((L.perPage ?? 6) === 3) for (const [, b] of v) noteLines(page, ph, rect(b.x1 + 24, b.y0, pw - 54, b.y1));
      pageTexts(page, pw, ph, pres, pres.handoutMaster ?? null, opts.paper, (pageOf.get(v[0][0]) ?? 0) + 1, fonts, system);
    }
  }
  // Link annotations (after every page exists, so jumps can name any page).
  for (const {page, ph, i, b, k, l} of pendingLinks) {
    const r = l.rect ?? [0, 0, 0, 0];
    const x0 = Math.max(b.x0 + r[0] * k, b.x0), y0 = Math.max(b.y0 + r[1] * k, b.y0), x1 = Math.min(b.x0 + r[2] * k, b.x1), y1 = Math.min(b.y0 + r[3] * k, b.y1);
    if (!(x1 > x0 && y1 > y0)) continue;
    const a = l.link?.action ?? {};
    const goto = s => (s === null || s === undefined || !pageOf.has(s) ? null : pdfPages[pageOf.get(s)]);
    let dict = null;
    const base = {Type: 'Annot', Subtype: 'Link', Rect: [x0, ph - y1, x1, ph - y0], Border: [0, 0, 0]};
    const dest = target => pdf.context.obj([target.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(target.getHeight()), PDFNull]);
    if (a.kind === 'url' && safeUrl(a.url)) dict = {...base, A: {Type: 'Action', S: 'URI', URI: PDFString.of(a.url)}};
    else {
      const idx = pres.slides.findIndex(s => s.id === a.slide);
      const target = a.kind === 'slide' ? goto(idx >= 0 ? idx : null) : a.kind === 'nextSlide' ? goto(i + 1) : a.kind === 'previousSlide' ? goto(i - 1)
        : a.kind === 'firstSlide' ? goto(0) : a.kind === 'lastSlide' ? goto(pres.slides.length - 1) : null;
      if (target) dict = {...base, Dest: dest(target)};
    }
    if (!dict) continue;
    const annot = pdf.context.obj(dict);
    if (l.link?.tooltip) annot.set(PDFName.of('Contents'), PDFHexString.fromText(l.link.tooltip));
    const ref = pdf.context.register(annot);
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) annots.push(ref); else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
  }
  buildOutline(pdf, pres, pages, pdfPages);
  return pdf.save({useObjectStreams: false});
}

/** Bookmarks: one per slide, "n. Title" (or "Slide n"), each opening its page. */
function buildOutline(pdf, pres, pages, pdfPages) {
  const items = [];
  pages.forEach((v, p) => {
    for (const [i] of v) {
      const t = (slideTitle(pres.slides[i]) ?? '').split('\n')[0].trim();
      items.push([t ? `${i + 1}. ${t}` : `Slide ${i + 1}`, pdfPages[p]]);
    }
  });
  if (!items.length) return;
  const ctx = pdf.context;
  const outlineRef = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  items.forEach(([label, page], k) => {
    const d = {Title: PDFHexString.fromText(label), Parent: outlineRef, Dest: [page.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(page.getHeight()), PDFNull]};
    if (k > 0) d.Prev = refs[k - 1];
    if (k < refs.length - 1) d.Next = refs[k + 1];
    ctx.assign(refs[k], ctx.obj(d));
  });
  ctx.assign(outlineRef, ctx.obj({Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length}));
  pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Wrapped plain text (notes), upstream `Exporter::paragraphs`. */
function paragraphs(page, ph, text, area, size, mix) {
  const width = s => mix.widthOfTextAtSize(s, size);
  const lh = size * 1.3;
  let y = area.y0 + size;
  const draw = line => { let x = area.x0; for (const r of mix.runs(line)) { page.drawText(r.text, {x, y: ph - y, size, font: r.pdfFont, color: grey(0x20)}); x += r.pdfFont.widthOfTextAtSize(r.text, size); } };
  outer: for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const cand = line ? `${line} ${word}` : word;
      if (width(cand) > rw(area) && line) {
        if (y > area.y1) break outer;
        draw(line);
        y += lh;
        line = word;
      } else line = cand;
    }
    if (y > area.y1) break;
    if (line) draw(line);
    y += lh;
  }
}
/** Ruled lines for handwritten notes (3-per-page handouts). */
function noteLines(page, ph, r) {
  for (let y = r.y0 + 18; y <= r.y1; y += 22) page.drawLine({start: {x: r.x0, y: ph - y}, end: {x: r.x1, y: ph - y}, thickness: 0.5, color: grey(0xB0)});
}
/** A notes or handout page's header, date, footer and page number from its master; just the page number without one. */
function pageTexts(page, pw, ph, pres, master, paper, n, fonts, system) {
  if (!master) {
    page.drawText(String(n), {x: pw - 72, y: ph - (ph - 30), size: 9, font: fonts.sans[0], color: grey(0x60)});
    return;
  }
  for (const [r, text, right, st] of masterTexts(pres, master, paper, n)) {
    const font = fonts[familyClass(st.family)][(st.bold ? 1 : 0) + (st.italic ? 2 : 0)];
    const mix = system.mixed(font, {bold: !!st.bold, italic: !!st.italic});
    const t = text.replace(/\n/g, ' ');
    if (!mix.runs(t).length) continue;
    const w = mix.widthOfTextAtSize(t, st.size);
    const x = right ? r.x1 - w : r.x0;
    const base = (r.y0 + r.y1) / 2 + st.size * 0.35;
    const c = st.color ?? {r: 0x60, g: 0x60, b: 0x60};
    let px = x;
    for (const run of mix.runs(t)) { page.drawText(run.text, {x: px, y: ph - base, size: st.size, font: run.pdfFont, color: pdfRgb(c.r / 255, c.g / 255, c.b / 255)}); px += run.pdfFont.widthOfTextAtSize(run.text, st.size); }
  }
}

/**
 * Format-worker entry (electron/formats-v2.cjs): a schema-2 Prism file → PDF bytes. The host passes
 * the slide renderer as `opts.render` (or `file.rasters`); the PDF options of the Export page as
 * `opts.pdf` (layout, slides, paper...).
 */
export async function write(file, opts = {}) {
  const content = file?.content ?? file;
  if (!content || !Array.isArray(content.slides)) throw new PdfError('Write', 'PDF writer: not a presentation');
  return exportPdf(content, {...(opts.pdf ?? {}), render: opts.render ?? file?.render, rasters: opts.rasters ?? file?.rasters});
}
