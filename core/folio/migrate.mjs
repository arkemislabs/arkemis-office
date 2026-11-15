// Schema 1 → schema 2 for PDF content: read the file's comments into pages[].annots, record the
// crop boxes and the form fields, and turn the old build's drawn overlays into the comments they
// stood for (the old "highlight" rectangle becomes a Highlight annotation over that area, as
// Acrobat's area highlight is; a text overlay a text box; a rectangle a Square; a signature an Ink
// signature), so nothing the person made is lost.
//
// Comment records follow printcraft crates/annot (create.rs add_annotation: subjects, flags,
// /BS, rich text) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Reading the file is asynchronous (pdf-lib); `migrateContent` is what a host runs when it opens
// a schema-1 folio document. No DOM, no Node built-ins.

import {pdfBytes} from '../pdf-model.mjs';
import {readSource} from './model/pdf-read.mjs';
import {createAnnotation} from './model/annots.mjs';
import {defaultStyle} from './model/types.mjs';
import {SCHEMA, validateContent} from './schema.mjs';
import {modelFields} from './lib/form-read.mjs';

export const needsMigration = content => !!content && typeof content === 'object' && content.folio !== SCHEMA;

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);

/** The comment an old overlay stood for (overlay coordinates: points from the top-left of the unturned page). */
export function overlayRecord(overlay, page, box) {
  const [x0, , , y1] = box;
  const rect = [x0 + overlay.x, y1 - overlay.y - overlay.height, x0 + overlay.x + overlay.width, y1 - overlay.y];
  const meta = {id: `ov-${overlay.id}`};
  const color = /^#[0-9a-f]{6}$/i.test(overlay.color ?? '') ? hex(overlay.color) : null;
  switch (overlay.type) {
    case 'highlight': {
      const shape = {kind: 'TextMarkup', markup: 'Highlight', quads: [[rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]]};
      return createAnnotation({shape, style: {...defaultStyle(shape), color: color ?? defaultStyle(shape).color}}, meta);
    }
    case 'rectangle': {
      const shape = {kind: 'Rectangle', rect};
      return createAnnotation({shape, style: {...defaultStyle(shape), color: color ?? [0.89, 0.13, 0.13], width: 1.5}}, meta);
    }
    case 'text': {
      const shape = {kind: 'TextBox', rect, fontSize: overlay.fontSize ?? 12};
      return createAnnotation({shape, style: {...defaultStyle(shape), color: color ?? [0, 0, 0]}, contents: overlay.text ?? ''}, meta);
    }
    case 'signature': {
      const strokes = (overlay.strokes ?? []).map(s => s.map(p => [rect[0] + p.x * (rect[2] - rect[0]), rect[3] - p.y * (rect[3] - rect[1])]));
      const shape = {kind: 'Signature', strokes};
      return createAnnotation({shape, style: {...defaultStyle(shape), color: color ?? [0, 0, 0]}}, meta);
    }
    default: return null;
  }
}

/**
 * Migrate PDF content to schema 2 (idempotent; schema-2 content is returned as it is).
 * @param {object} content
 * @param {{read?: (bytes: Uint8Array) => Promise<{pages: object[], fields: object[]}>}} [opts]
 */
export async function migrateContent(content, {read = readSource} = {}) {
  if (!needsMigration(content)) return content;
  if (!content.pages?.length || !content.sourceBase64) return validateContent({...content, folio: SCHEMA});
  const source = await read(pdfBytes(content.sourceBase64));
  const used = new Set();
  const pages = content.pages.map(page => {
    const src = source.pages[page.sourceIndex];
    const box = src?.box ?? [0, 0, page.width, page.height];
    // A duplicated page carries copies of its source page's comments, with ids of their own.
    const first = content.pages.find(p => p.sourceIndex === page.sourceIndex) === page;
    const annots = (src?.annots ?? []).map(r => {
      if (first) { used.add(r.id); return r; }
      const id = `${r.id}-${page.id.slice(0, 8)}`;
      used.add(id);
      return {...r, id, src: undefined, popupSrc: undefined, edited: true, dict: {...r.dict, NM: {$t: id}}};
    }).map(r => JSON.parse(JSON.stringify(r)));
    if (!first) {
      const map = new Map((src?.annots ?? []).map(r => [r.id, `${r.id}-${page.id.slice(0, 8)}`]));
      for (const r of annots) if (r.irt) r.irt = map.get(r.irt) ?? r.irt;
    }
    for (const overlay of page.overlays ?? []) {
      const r = overlayRecord(overlay, page, box);
      if (r && !used.has(r.id)) { used.add(r.id); annots.push(r); }
    }
    return {...page, box, overlays: [], annots};
  });
  const fields = modelFields(source.fields ?? [], content.pages);
  return validateContent({...content, pages, fields, folio: SCHEMA});
}

/** Migrate a stored file (schema 1 or 2) whose kind is folio. */
export async function migrateFile(file, opts) {
  if (file?.kind !== 'folio' || !needsMigration(file.content)) return file;
  return {...file, content: await migrateContent(file.content, opts)};
}
