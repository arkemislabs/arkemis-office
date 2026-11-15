// Quill schema-2 content → PDF: what File > Export > Create PDF and Save As > PDF write.
//
// Translated from wordcraft crates/pdf/src/lib.rs, export.rs, exporter.rs, exporter/text.rs,
// exporter/draw.rs, exporter/nav.rs, paint.rs, picture.rs and metadata.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c): the document is laid out by core/quill/layout (the same
// pages, lines and page numbers as Print Layout) and each page's display list (layout pageDisplay)
// is drawn into a PDF page: text as real, selectable text; fills, rules and underlines (solid,
// dotted, dashed, double, wave); pictures with cropping and opacity; shapes; the page colour; link
// annotations for hyperlinked runs (URLs and internal #bookmark links); document properties.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What differs (docs/behaviour-fidelity.md), and why:
// * Fonts. Upstream embeds the document's own faces, subsetted. pdf-lib cannot embed TrueType
//   without fontkit (not a dependency), so text is set in the PDF standard faces (Helvetica, Times,
//   Courier, each with bold/italic; serif and monospace families map to Times and Courier) and the
//   document is laid out with those faces' metrics: pages, lines and page breaks are those of this
//   PDF. When the caller hands over the layout it painted (`opts.layout`, made with the renderer's
//   shaper) every run is scaled horizontally to the width it was laid out at, so the PDF pages
//   match the screen's exactly. Characters outside the standard encoding (WinAnsi) print as "?".
// * Not yet: the document outline from headings (exporter/nav.rs), tagged-PDF structure
//   (tags.rs), Print Markup comment balloons, WMF/EMF pictures (drawn as a grey box, upstream's
//   fallback for an undecodable picture).
// pdf-lib is allowed in core/*/formats (architecture 5.3). No DOM, no Node built-ins.

import {PDFDocument, StandardFonts, PDFOperator, PDFNumber, PDFName, PDFString, rgb, pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, showText, setTextMatrix, setFillingColor, rectangle, clip, endPath, concatTransformationMatrix, setGraphicsState} from 'pdf-lib';
import {systemFonts, textsOf} from '../../common/lib/pdf-fonts.mjs';
import {layout as layOut, pageDisplay} from '../layout/index.mjs';
import {base64Decode, sniffImage} from './_flow.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
  files: ['crates/pdf/src/export.rs', 'crates/pdf/src/exporter.rs', 'crates/pdf/src/exporter/text.rs', 'crates/pdf/src/exporter/draw.rs', 'crates/pdf/src/paint.rs',
    'crates/pdf/src/picture.rs', 'crates/pdf/src/metadata.rs']});

const FACES = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};
const SERIF = /times|georgia|cambria|garamond|book|palatino|minion|serif|roman|mincho|song|batang|constantia/i;
const MONO = /courier|mono|consolas|menlo|code|monaco|lucida console/i;
/** The standard face family a document font is set in. */
export const familyClass = family => (MONO.test(family ?? '') ? 'mono' : SERIF.test(family ?? '') && !/sans/i.test(family ?? '') ? 'serif' : 'sans');

/**
 * The 12 standard faces embedded in `pdf`, with a shaper measuring with them. Text the standard faces cannot encode (Cyrillic, Greek, Indic, CJK...)
 * is set in a system font (common/lib/pdf-fonts.mjs) run by run, so only a character no installed font has prints as "?". `texts` are the strings
 * the document will print: their fonts are found before the layout measures anything.
 */
export async function standardFaces(pdf, texts = []) {
  const faces = {};
  for (const [cls, names] of Object.entries(FACES)) faces[cls] = await Promise.all(names.map(n => pdf.embedFont(n)));
  const system = await systemFonts(pdf);
  await system.prepare(texts);
  const faceOf = font => faces[familyClass(font?.family)][(font?.bold ? 1 : 0) + (font?.italic ? 2 : 0)];
  const mixes = new Map();
  /** The standard face of a font with the system font that stands in for what it cannot encode. */
  const mixOf = font => { const std = faceOf(font), key = `${std.name}|${font?.bold ? 1 : 0}${font?.italic ? 1 : 0}`; let m = mixes.get(key); if (!m) { m = system.mixed(std, {bold: !!font?.bold, italic: !!font?.italic}); mixes.set(key, m); } return m; };
  /** [{face, text}]: the text cut into runs, each set in the document's own standard face when it can encode it, else in a system font. */
  const runs = (font, text) => mixOf(font).runs(String(text ?? '').replace(/‑/g, '-')).map(r => ({face: r.pdfFont, text: r.text}));
  const width = (font, text, size) => runs(font, text).reduce((w, r) => w + r.face.widthOfTextAtSize(r.text, size), 0);
  const shaper = {
    key: 'pdf-standard-14',
    metrics(font) {
      const f = faceOf(font), size = font.size || 11;
      const ascent = f.heightAtSize(size, {descender: false});
      return {ascent, descent: Math.max(0, f.heightAtSize(size) - ascent)};
    },
    advance(text, font) { return width(font, text, font.size || 11); },
  };
  return {faces, faceOf, runs, width, shaper};
}

const clampColor = c => (Array.isArray(c) ? rgb(...c.map(v => Math.max(0, Math.min(255, Number(v) || 0)) / 255)) : rgb(0, 0, 0));
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

function opacityState(pdf, page, alpha, cache) {
  if (alpha === undefined || alpha === null || alpha >= 1) return null;
  const a = Math.max(0, Math.min(1, alpha));
  const key = a.toFixed(3);
  if (!cache.has(key)) cache.set(key, pdf.context.register(pdf.context.obj({Type: 'ExtGState', ca: a, CA: a})));
  return page.node.newExtGState('GS', cache.get(key));
}

function dashOf(stroke, width) {
  if (stroke === 'dot') return [Math.max(width, 0.5), Math.max(width, 0.5) * 2];
  if (stroke === 'dash') return [Math.max(width, 0.5) * 4, Math.max(width, 0.5) * 2];
  return undefined;
}

function drawLine(page, it, H) {
  const color = clampColor(it.color), w = Math.max(0.1, fin(it.width, 0.5)), opacity = it.alpha ?? 1;
  const seg = (dy) => page.drawLine({start: {x: it.x0, y: H - (it.y0 + dy)}, end: {x: it.x1, y: H - (it.y1 + dy)}, thickness: w, color, opacity, dashArray: dashOf(it.stroke, w)});
  if (it.stroke === 'double') { seg(-w); seg(w); return; }
  if (it.stroke === 'wave') {
    const amp = Math.max(w, 0.75), step = amp * 2;
    const len = Math.hypot(it.x1 - it.x0, it.y1 - it.y0);
    if (len <= 0) return;
    let d = `M 0 0`;
    for (let x = 0, up = true; x < len; x += step, up = !up) d += ` Q ${x + step / 2} ${up ? -amp : amp} ${Math.min(x + step, len)} 0`;
    page.drawSvgPath(d, {x: it.x0, y: H - it.y0, borderColor: color, borderWidth: w, borderOpacity: opacity});
    return;
  }
  seg(0);
}

function drawShape(page, it, H) {
  const r = it.rect, opacity = it.alpha ?? 1;
  const opts = {color: it.fill ? clampColor(it.fill) : undefined, borderColor: it.stroke ? clampColor(it.stroke) : undefined,
    borderWidth: it.stroke ? Math.max(0, fin(it.strokeWidth, 0.75)) : 0, opacity, borderOpacity: opacity, rotate: undefined};
  if (it.kind === 'ellipse' || it.kind === 'flowchartOr') page.drawEllipse({x: r.x + r.w / 2, y: H - (r.y + r.h / 2), xScale: r.w / 2, yScale: r.h / 2, ...opts});
  else if (it.kind === 'line' || it.kind === 'straightConnector') page.drawLine({start: {x: r.x, y: H - r.y}, end: {x: r.x + r.w, y: H - (r.y + r.h)}, thickness: opts.borderWidth || 0.75, color: opts.borderColor ?? rgb(0, 0, 0), opacity});
  else page.drawRectangle({x: r.x, y: H - (r.y + r.h), width: Math.max(0, r.w), height: Math.max(0, r.h), ...opts});
}

/**
 * A chart or an equation (chart renderer primitives from the top left of the item's frame: core/quill/lib/chart-draw.mjs,
 * math-layout.mjs): rectangles, lines, polygons, wedges, circles and text set in the standard faces.
 */
function drawPrims(page, it, H, kit) {
  const ox = fin(it.rect.x), oy = fin(it.rect.y);
  const col = a => clampColor(Array.isArray(a) ? a.slice(0, 3) : null);
  const op = a => Math.max(0, Math.min(1, (fin(a?.[3], 255) / 255) * fin(it.alpha, 1)));
  const path = pts => 'M ' + pts.map(([x, y]) => x + ' ' + y).join(' L ');
  const at = {x: ox, y: H - oy};
  for (const p of it.prims ?? []) {
    try {
      if (p.t === 'rect') {
        page.drawRectangle({x: ox + p.x, y: H - (oy + p.y + p.h), width: Math.max(0, p.w), height: Math.max(0, p.h), color: p.fill ? col(p.fill) : undefined, opacity: p.fill ? op(p.fill) : undefined,
          borderColor: p.stroke ? col(p.stroke[0]) : undefined, borderWidth: p.stroke ? fin(p.stroke[1], 0.5) : 0, borderOpacity: p.stroke ? op(p.stroke[0]) : undefined});
      } else if (p.t === 'line' && p.pts?.length > 1) {
        page.drawSvgPath(path(p.pts), {...at, borderColor: col(p.color), borderWidth: Math.max(0.1, fin(p.width, 0.5)), borderOpacity: op(p.color), borderDashArray: p.dash ? [3, 2] : undefined});
      } else if (p.t === 'poly' && p.pts?.length > 2) {
        page.drawSvgPath(path(p.pts) + ' Z', {...at, color: col(p.fill), opacity: op(p.fill), borderColor: p.stroke ? col(p.stroke[0]) : undefined, borderWidth: p.stroke ? fin(p.stroke[1], 0.5) : 0});
      } else if (p.t === 'wedge') {
        const arc = (r, a0, a1) => Array.from({length: Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.1))}, (_, i, l) => { const a = a0 + (a1 - a0) * i / (l.length - 1); return [p.cx + r * Math.sin(a), p.cy - r * Math.cos(a)]; });
        const pts = p.ri > 0 ? [...arc(p.ro, p.a0, p.a1), ...arc(p.ri, p.a1, p.a0)] : [[p.cx, p.cy], ...arc(p.ro, p.a0, p.a1)];
        page.drawSvgPath(path(pts) + ' Z', {...at, color: col(p.fill), opacity: op(p.fill), borderColor: p.stroke ? col(p.stroke[0]) : undefined, borderWidth: p.stroke ? fin(p.stroke[1], 0.5) : 0});
      } else if (p.t === 'circle') {
        page.drawEllipse({x: ox + p.cx, y: H - (oy + p.cy), xScale: p.r, yScale: p.r, color: p.fill ? col(p.fill) : undefined, opacity: p.fill ? op(p.fill) : undefined,
          borderColor: p.stroke ? col(p.stroke[0]) : undefined, borderWidth: p.stroke ? fin(p.stroke[1], 0.5) : 0});
      } else if (p.t === 'text' && p.text) {
        const size = Math.max(0.5, fin(p.size, 9));
        const font = {family: it.family, size, bold: !!p.bold, italic: !!p.italic};
        const width = kit.width(font, String(p.text), size);
        const x = ox + p.x - (p.align === 'center' ? width / 2 : p.align === 'right' ? width : 0);
        const dy = p.valign === 'baseline' ? 0 : p.valign === 'middle' ? size * 0.35 : p.valign === 'bottom' ? -size * 0.2 : size * 0.8;
        drawText(page, {text: String(p.text), font, x, y: oy + p.y + dy, color: Array.isArray(p.color) ? p.color.slice(0, 3) : [0, 0, 0]}, H, kit, null);
      }
    } catch { /* a primitive the PDF cannot draw is left out */ }
  }
}

async function drawImage(pdf, page, it, H, media, images) {
  const r = it.rect;
  const b64 = media[it.media];
  let img = null;
  if (b64 !== undefined) {
    if (!images.has(it.media)) {
      const bytes = base64Decode(b64);
      const t = bytes ? sniffImage(bytes) : null;
      let e = null;
      try { e = t === 'png' ? await pdf.embedPng(bytes) : t === 'jpeg' ? await pdf.embedJpg(bytes) : null; } catch { e = null; }
      images.set(it.media, e);
    }
    img = images.get(it.media);
  }
  const [cl, ct, cr, cb] = (it.crop ?? [0, 0, 0, 0]).map(v => Math.max(0, Math.min(0.99, fin(v))));
  if (!img) {
    // picture.rs: a grey box stands in for a picture that can't be decoded.
    page.drawRectangle({x: r.x, y: H - (r.y + r.h), width: Math.max(0, r.w), height: Math.max(0, r.h), color: rgb(0.85, 0.85, 0.85), opacity: it.alpha ?? 1});
    return;
  }
  // Cropping: the whole picture scaled so the kept part fills the frame, clipped to the frame.
  const fw = r.w / Math.max(0.01, 1 - cl - cr), fh = r.h / Math.max(0.01, 1 - ct - cb);
  page.pushOperators(pushGraphicsState());
  if (it.rot) {
    const cx = r.x + r.w / 2, cy = H - (r.y + r.h / 2), a = -fin(it.rot) * Math.PI / 180;
    page.pushOperators(concatTransformationMatrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), cx - cx * Math.cos(a) + cy * Math.sin(a), cy - cx * Math.sin(a) - cy * Math.cos(a)));
  }
  page.pushOperators(rectangle(r.x, H - (r.y + r.h), Math.max(0, r.w), Math.max(0, r.h)), clip(), endPath());
  page.drawImage(img, {x: r.x - cl * fw, y: H - (r.y + r.h) - cb * fh, width: fw, height: fh, opacity: it.alpha ?? 1});
  page.pushOperators(popGraphicsState());
}

function drawText(page, it, H, kit, scaleTo) {
  const size = Math.max(0.5, fin(it.font?.size, 11));
  const runs = kit.runs(it.font, it.text);
  if (!runs.length) return null;
  let sx = fin(it.xScale, 1) || 1;
  const natural = runs.reduce((w, r) => w + r.face.widthOfTextAtSize(r.text, size), 0) * sx;
  if (scaleTo !== null && natural > 0 && scaleTo > 0) sx *= scaleTo / natural;
  const gs = it.alpha !== undefined && it.alpha < 1 ? it.gs : null;
  page.pushOperators(pushGraphicsState());
  if (gs) page.pushOperators(setGraphicsState(gs));
  page.pushOperators(beginText(), setFillingColor(clampColor(it.color)));
  let x = it.x;
  for (const run of runs) {
    page.pushOperators(setFontAndSize(page.node.newFontDictionary(run.face.name, run.face.ref), size));
    if (it.spacing) {
      // Tab leaders: one character per step.
      for (const c of run.text) { page.pushOperators(setTextMatrix(sx, 0, 0, 1, x, H - it.y), showText(run.face.encodeText(c))); x += it.spacing; }
    } else {
      page.pushOperators(setTextMatrix(sx, 0, 0, 1, x, H - it.y), showText(run.face.encodeText(run.text)));
      x += run.face.widthOfTextAtSize(run.text, size) * sx;
    }
  }
  page.pushOperators(endText(), popGraphicsState());
  return x - it.x;
}

function linkAnnot(pdf, page, rect, H, link, dests) {
  const r = [rect.x, H - (rect.y + rect.h), rect.x + rect.w, H - rect.y];
  let action;
  if (link.startsWith('#')) {
    const dest = dests.get(link.slice(1));
    if (!dest) return null;
    action = pdf.context.obj({Type: 'Action', S: 'GoTo', D: [dest.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(dest.y), PDFNumber.of(0)]});
  } else if (/^(https?:|mailto:)/i.test(link)) action = pdf.context.obj({Type: 'Action', S: 'URI', URI: PDFString.of(link)});
  else return null;
  return pdf.context.register(pdf.context.obj({Type: 'Annot', Subtype: 'Link', Rect: r, Border: [0, 0, 0], A: action}));
}

/** metadata.rs: the document properties as PDF Info (title and author may be overridden). */
function setMetadata(pdf, content, opts) {
  const core = content.core ?? {};
  const title = opts.title ?? core.title;
  if (title) pdf.setTitle(title, {showInWindowTitleBar: true});
  const author = opts.author ?? core.creator;
  if (author) pdf.setAuthor(author);
  if (core.subject) pdf.setSubject(core.subject);
  if (core.keywords) pdf.setKeywords(core.keywords.split(/[,;]\s*/).filter(Boolean));
  pdf.setProducer('Arkemis Quill');
  pdf.setCreator('Arkemis Quill');
  const created = core.created ? new Date(core.created) : null;
  if (created && !Number.isNaN(created.getTime())) pdf.setCreationDate(created);
  const lang = content.styles?.defaultChr?.lang;
  if (lang && /^[\x20-\x7e]+$/.test(lang)) pdf.catalog.set(PDFName.of('Lang'), PDFString.of(lang));
}

/**
 * Lay out `content` (or use `opts.layout`) and write it as PDF (export / export_layout).
 * opts: {pages: 0-based page indexes, title, author, includeMarkup, layout, shaper}.
 */
export async function exportPdf(content, opts = {}) {
  const pdf = await PDFDocument.create();
  const kit = await standardFaces(pdf, textsOf(content));
  const lay = opts.layout ?? layOut(content, {view: 'print', shaper: kit.shaper, hideDeleted: !opts.includeMarkup});
  const all = lay.pages ?? [];
  const pages = opts.pages ?? all.map((_, i) => i);
  if (!pages.length) throw new Error('the document has no pages to export');
  const bad = pages.find(p => p < 0 || p >= all.length);
  if (bad !== undefined) throw new Error(`page ${bad + 1} does not exist`);
  setMetadata(pdf, content, opts);
  // A run laid out by another shaper is scaled to the width it was laid out at.
  const measure = opts.layout && opts.shaper ? (it => (it.end !== undefined ? it.end - it.x : null)) : () => null;
  const gsCache = new Map(), images = new Map();
  const pageColor = content.settings?.pageColor ?? null;
  const out = [];
  for (const pi of pages) {
    const pg = all[pi];
    const W = fin(pg.w, 612), H = fin(pg.h, 792);
    const page = pdf.addPage([W, H]);
    out.push({page, pg, H});
    if (pageColor) page.drawRectangle({x: 0, y: 0, width: W, height: H, color: clampColor(pageColor)});
  }
  // Bookmarks: where each named destination lands (for internal links).
  const dests = new Map();
  const linkRuns = [];
  for (const {page, pg, H} of out) {
    for (const it of pageDisplay(pg, {marks: false})) {
      if (it.type === 'fill') {
        const r = it.rect;
        if (r.w > 0 && r.h > 0) page.drawRectangle({x: r.x, y: H - (r.y + r.h), width: r.w, height: r.h, color: clampColor(it.color), opacity: it.alpha ?? 1});
      } else if (it.type === 'line') drawLine(page, it, H);
      else if (it.type === 'shape') drawShape(page, it, H);
      else if (it.type === 'image') await drawImage(pdf, page, it, H, content.media ?? {}, images);
      else if (it.type === 'chart' || it.type === 'math') drawPrims(page, it, H, kit);
      else if (it.type === 'text') {
        it.gs = opacityState(pdf, page, it.alpha, gsCache);
        const w = drawText(page, it, H, kit, measure(it));
        if (w !== null && it.link) linkRuns.push({page, H, link: it.link, rect: {x: it.x, y: it.y - fin(it.font?.size, 11) * 0.8, w, h: fin(it.font?.size, 11)}});
      }
    }
    for (const b of pg.bookmarks ?? []) if (!dests.has(b.name)) dests.set(b.name, {ref: page.ref, y: H - fin(b.y)});
  }
  for (const {page, H, link, rect} of linkRuns) {
    const a = linkAnnot(pdf, page, rect, H, link, dests);
    if (a) page.node.addAnnot(a);
  }
  return pdf.save({useObjectStreams: true});
}

/** formats-v2 contract: the .pdf bytes of `file` (opts as exportPdf). */
export async function write(file, opts = {}) {
  return exportPdf(file.content ?? file, opts);
}
