// Folio content (schema 2): the schema-1 PDF content plus the comments read from the file.
//
//   {sourceBase64, sourceName, pages, activePageId, bookmarks?, pageLabels?   schema 1 (core/pdf-model.mjs)
//    folio: 2,                                    comments were read into pages[].annots
//    fields?: [{name, type, readOnly, required, widgets: [{pageId, rect}]}],
//    permissions?: {annotate?: boolean, assemble?: boolean, ...}}
//   page: {id, sourceIndex, width, height, sourceRotation, rotation, overlays: [], duplicateOf?,
//          box?: [x0 y0 x1 y1] crop box in user space, annots?: [comment record (model/annots.mjs)]}
//
// The schema-1 fields stay as they are, so the main process's save validation and the format
// worker keep accepting the content, and the schema-1 page commands (core/folio/commands/page.mjs)
// keep working on it. Comment records follow printcraft crates/annot (see model/annots.mjs) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {validatePdfContent, applyPdfOperation} from '../pdf-model.mjs';
import {isDict, isName} from './lib/cos.mjs';

export const SCHEMA = 2;
/** Limits: comments per document and the size of one comment dictionary (JSON characters). */
export const MAX_ANNOTS = 20000;
export const MAX_ANNOT_JSON = 2_000_000;

/** A new, empty PDF document (Acrobat's Create starts from a file; the empty content waits for one). */
export function createContent() {
  return {sourceBase64: '', sourceName: '', pages: [], activePageId: '', folio: SCHEMA};
}

const fail = message => { throw new Error(message); };

/** Validate one comment record. */
export function validateRecord(r, page) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 200) fail(`Invalid comment id on page ${page.id}.`);
  if (!isDict(r.dict) || !isName(r.dict.Subtype)) fail(`Comment ${r.id} has no subtype.`);
  const rect = r.dict.Rect;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(x => typeof x === 'number' && Number.isFinite(x))) fail(`Comment ${r.id} has no valid /Rect.`);
  if (!['build', 'source', 'empty'].includes(r.ap)) fail(`Comment ${r.id} has an unknown appearance source.`);
  if (r.src !== undefined && (!Array.isArray(r.src) || r.src.length !== 2 || !r.src.every(Number.isInteger))) fail(`Comment ${r.id} has an invalid source reference.`);
  if (r.irt !== undefined && typeof r.irt !== 'string') fail(`Comment ${r.id} has an invalid reply target.`);
  if (r.popup !== undefined && (!Array.isArray(r.popup?.Rect) || r.popup.Rect.length !== 4)) fail(`Comment ${r.id} has an invalid pop-up.`);
  if (JSON.stringify(r.dict).length > MAX_ANNOT_JSON) fail(`Comment ${r.id} is too large.`);
}

/** Validate folio content (schema 1 rules plus comment records). Returns the content. */
export function validateContent(content) {
  validatePdfContent(content);
  if (content.folio !== undefined && content.folio !== SCHEMA) fail('Unsupported PDF content version.');
  const ids = new Set();
  let count = 0;
  for (const page of content.pages) {
    if (page.box !== undefined && (!Array.isArray(page.box) || page.box.length !== 4 || !page.box.every(Number.isFinite))) fail('Invalid PDF page box.');
    if (page.annots === undefined) continue;
    if (!Array.isArray(page.annots)) fail('Invalid PDF comments.');
    for (const r of page.annots) {
      validateRecord(r, page);
      if (ids.has(r.id)) fail(`Duplicate comment id ${r.id}.`);
      ids.add(r.id);
      if (++count > MAX_ANNOTS) fail(`A PDF supports up to ${MAX_ANNOTS} comments.`);
    }
  }
  for (const page of content.pages) for (const r of page.annots ?? []) if (r.irt !== undefined && !ids.has(r.irt)) fail(`Comment ${r.id} replies to a comment that does not exist.`);
  if (content.fields !== undefined && !Array.isArray(content.fields)) fail('Invalid PDF form fields.');
  return content;
}

/** /v1 bridge commands on schema-2 folio content: the schema-1 page operations, comments kept. */
export function applyLegacyCommand(content, command) {
  if (command?.type !== 'pdf_operation') fail('Unsupported command');
  const op = command.operation;
  const next = applyPdfOperation(content, op);
  if (op?.type === 'duplicate') {
    // The copy's comments get their own ids (ids are unique in a document).
    const at = next.pages.findIndex(p => p.id === next.activePageId);
    const copy = next.pages[at];
    if (copy?.annots?.length) {
      const map = new Map(copy.annots.map(r => [r.id, `${r.id}-${copy.id.slice(0, 8)}`]));
      next.pages[at] = {...copy, annots: copy.annots.map(r => ({...r, id: map.get(r.id), src: undefined, edited: true, ...(r.irt ? {irt: map.get(r.irt) ?? r.irt} : {}),
        dict: {...r.dict, NM: {$t: map.get(r.id)}}}))};
    }
  }
  return validateContent(next);
}
