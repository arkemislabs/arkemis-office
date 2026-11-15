// Test documents for folio command tests (core/kernel/testing.mjs createTestSession({fixture})).
// Built with pdf-lib at test time: real PDFs with real text, so text selection, markup quads and
// save/reopen are exercised on actual files. No DOM, no Node built-ins.

import {PDFDocument, StandardFonts, rgb, PDFName, PDFString} from 'pdf-lib';
import {migrateContent} from './migrate.mjs';

export const LINES = [
  'Arkemis PDF keeps every comment as a real annotation.',
  'Highlights follow the text lines they mark, one quad per line.',
  'The quick brown fox jumps over the lazy dog.',
  'Pack my box with five dozen liquor jugs.',
];

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return globalThis.btoa(s);
}

/** A Letter-size PDF with `pages` pages of Helvetica text (LINES at 12 pt, 18 pt leading, from 72/720). */
export async function textPdf({pages = 2, rotate = 0, foreignHighlight = false} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    LINES.forEach((line, i) => page.drawText(p ? `${line} (page ${p + 1})` : line, {x: 72, y: 720 - i * 18, size: 12, font, color: rgb(0, 0, 0)}));
    if (rotate) page.setRotation({type: 'degrees', angle: rotate});
  }
  if (foreignHighlight) {
    // A highlight another program wrote, with its own appearance and no /NM.
    const page = doc.getPage(0);
    const ap = doc.context.register(doc.context.stream('1 0 0 rg 72 640 100 14 re f', {Type: 'XObject', Subtype: 'Form', BBox: [72, 640, 172, 654]}));
    const annot = doc.context.obj({Type: 'Annot', Subtype: 'Highlight', Rect: [72, 640, 172, 654], QuadPoints: [72, 654, 172, 654, 72, 640, 172, 640],
      C: [1, 0, 0], T: PDFString.of('Someone else'), Contents: PDFString.of('Imported'), AP: {N: ap}, F: 4, Custom: PDFName.of('KeepMe')});
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
  }
  return doc.save();
}

/** Schema-1 content for a PDF (as core/pdf-document.mjs createPdfContent makes it). */
export async function schema1Content(bytes, name = 'fixture.pdf') {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages().map((page, sourceIndex) => {
    const box = page.getCropBox();
    return {id: `p${sourceIndex + 1}`, sourceIndex, width: box.width, height: box.height, sourceRotation: ((page.getRotation().angle % 360) + 360) % 360, rotation: 0, overlays: []};
  });
  return {sourceBase64: base64(bytes), sourceName: name, pages, activePageId: pages[0]?.id ?? ''};
}

// Fixture names are the module's exports (createTestSession looks them up on the namespace).
/** Two pages of text, comments read (schema 2). */
export const textPages = async () => migrateContent(await schema1Content(await textPdf()));
/** One page turned 90 degrees. */
export const rotatedPage = async () => migrateContent(await schema1Content(await textPdf({pages: 1, rotate: 90})));
/** A highlight written by another program on page 1. */
export const foreignHighlight = async () => migrateContent(await schema1Content(await textPdf({foreignHighlight: true})));

/**
 * A Letter page of line work to snap to: two crossing lines and a rectangle (10 20 m 110 20 l, 60 0 m 60 80 l, 10 100 100 40 re),
 * with `attrs` added to the page dictionary (/UserUnit, /Rotate, /CropBox as name-value pairs).
 */
export async function drawingPdf({attrs = {}} = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('10 20 m 110 20 l S 60 0 m 60 80 l S 10 100 100 40 re S')));
  for (const [k, v] of Object.entries(attrs)) page.node.set(PDFName.of(k), doc.context.obj(v));
  return doc.save();
}
/** One page of line work (see drawingPdf). */
export const drawing = async () => migrateContent(await schema1Content(await drawingPdf(), 'drawing.pdf'));

export {base64};

/** A printed form with no fields: underscore blanks, a rule, a box, a small square, a comb row. */
export async function blankFormPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Full name: ____________________', {x: 72, y: 700, size: 12, font});
  page.drawText('Email', {x: 72, y: 650, size: 12, font});
  page.drawLine({start: {x: 120, y: 648}, end: {x: 300, y: 648}, thickness: 1, color: rgb(0, 0, 0)});
  page.drawRectangle({x: 72, y: 560, width: 12, height: 12, borderWidth: 1, borderColor: rgb(0, 0, 0)});
  page.drawText('I agree', {x: 92, y: 562, size: 12, font});
  page.drawText('Comments', {x: 72, y: 520, size: 12, font});
  page.drawRectangle({x: 72, y: 440, width: 300, height: 60, borderWidth: 1, borderColor: rgb(0, 0, 0)});
  for (let i = 0; i < 5; i++) page.drawRectangle({x: 72 + i * 18, y: 380, width: 18, height: 24, borderWidth: 1, borderColor: rgb(0, 0, 0)});
  doc.addPage([612, 792]).drawText('Second page', {x: 72, y: 700, size: 12, font});
  return doc.save();
}
/** A blank printed form, comments read (schema 2). */
export const blankForm = async () => migrateContent(await schema1Content(await blankFormPdf()));

/**
 * A report page for editing its text: a bold heading, a three-row Times paragraph (set with a leading, as word processors do), a blue Helvetica
 * line below it and a grey footer. Every run is one text object with its own font resource, as real producers write them.
 */
export async function editPdf() {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold), times = await doc.embedFont(StandardFonts.TimesRoman), helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('Resources'), doc.context.obj({Font: {FB: bold.ref, FT: times.ref, FH: helv.ref}}));
  const content = [
    'BT /FB 22 Tf 72 730 Td (Quarterly Report) Tj ET',
    'BT 0.15 0.15 0.15 rg /FT 12 Tf 14.4 TL 72 660 Td (Revenue grew steadily across every region this quarter,) Tj T* (led by the new subscription plans. Costs stayed flat while) Tj T* (support tickets fell by a third.) Tj ET',
    'BT /FH 11 Tf 0 0 0.6 rg 72 580 Td (Outlook: expect a similar pattern in the next quarter.) Tj ET',
    'BT /FH 9 Tf 0.4 g 72 60 Td (Confidential - for the board only) Tj ET',
    'BT /FT 12 Tf 0 g 72 480 Td (Mixed styles: ) Tj /FB 12 Tf 0.8 0 0 rg (bold red) Tj /FT 12 Tf 0 g ( and plain words.) Tj ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  return doc.save();
}
/** One page of editable text (see editPdf), comments read (schema 2). */
export const editText = async () => migrateContent(await schema1Content(await editPdf(), 'report.pdf'));

/** A 1 x 1 red PNG (the picture a replacement brings). */
export const REPLACEMENT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The report page with a picture beside the paragraph: a 16 x 12 gradient drawn 140 x 100 points at (400, 590). */
export async function editImagePdf() {
  const bytes = await editPdf();
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const w = 16, h = 12;
  const rgb8 = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb8.set([Math.round(255 * x / (w - 1)), Math.round(255 * y / (h - 1)), 160], (y * w + x) * 3);
  const image = doc.context.register(doc.context.stream(rgb8, {Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8}));
  const res = page.node.Resources();
  res.set(PDFName.of('XObject'), doc.context.obj({Im1: image}));
  const content = doc.context.lookup(page.node.Contents());
  const old = new TextDecoder('latin1').decode(content.getContents());
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`${old}\nq 140 0 0 100 400 590 cm /Im1 Do Q`)));
  return doc.save();
}
/** The report page with a picture (see editImagePdf), comments read (schema 2). */
export const editImage = async () => migrateContent(await schema1Content(await editImagePdf(), 'report.pdf'));
