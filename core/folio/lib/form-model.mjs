// The form in the folio model: what `content.fields` holds, how a form edit writes the source and the
// field list as one undoable change, and the field descriptions commands and the surface read.
//
// printcraft edits its COS document in place and keeps the form with it (crates/engine
// Session::apply, crates/forms). The folio model keeps the file's bytes (`sourceBase64`), so a form
// edit loads the source with pdf-lib, runs the engine (form-edit.mjs), saves it as the document's
// new source and stores the re-read field list in `content.fields`: widgets with their page ids and
// user-space rectangles. Translated against 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {PDF_MAX_BYTES} from '../../pdf-model.mjs';
import {editable, base64} from './page-source.mjs';
import {hasSignatures} from './sign-incremental.mjs';
import {readFields, modelFields} from './form-read.mjs';
import {FormError, redrawField} from './form-edit.mjs';
import {takeUnicodeNeeds, forgetUnicodeNeeds, redrawWithUnicode} from './form-appearance.mjs';
import {userRectToView, viewRectToUser, normalize} from './geom.mjs';
import {pdfBytes} from '../../pdf-model.mjs';

/** Whether the document holds signatures (editing it would break them). */
export const signedBytes = content => hasSignatures(pdfBytes(content.sourceBase64));

const errorOf = e => {
  if (e instanceof FormError) return new CommandError(e.code === 'not_found' ? 'not_found' : e.code === 'read_only' ? 'disabled' : 'invalid_params', e.message);
  return e;
};

/**
 * Run `fn(pdf)` on the document's source and store the result as one change: the new source bytes
 * and the re-read field list (and the page records when the pages had to be made their own source
 * pages first). A refused edit leaves the document as it was.
 * @param {object} ctx
 * @param {string} label undo label
 * @param {(pdf: import('pdf-lib').PDFDocument, content: object) => any} fn
 */
export async function formEdit(ctx, label, fn, {allowSigned = false} = {}) {
  const content = ctx.doc;
  if (!content?.pages?.length || !content.sourceBase64) throw new CommandError('disabled', 'no PDF open');
  if (!allowSigned && signedBytes(content)) throw new CommandError('disabled', 'This PDF is signed: changing its form would break the signature. Save a copy without the signature first.');
  const {doc: pdf, content: base} = await editable(content);
  let result;
  forgetUnicodeNeeds();
  try { result = await fn(pdf, base); } catch (e) { throw errorOf(e); }
  // Fields whose text the standard faces could not draw are drawn again in a system font embedded for them.
  const needs = takeUnicodeNeeds();
  if (needs.length) await redrawWithUnicode(pdf, needs, name => redrawField(pdf, name));
  const bytes = await pdf.save({updateFieldAppearances: false});
  if (bytes.length > PDF_MAX_BYTES) throw new CommandError('too_large', 'The PDF would exceed the 10 MB limit');
  ctx.change.set(['sourceBase64'], base64(bytes));
  if (base !== content) ctx.change.set(['pages'], base.pages);
  ctx.change.set(['fields'], modelFields(readFields(pdf), base.pages));
  ctx.setUndoLabel(label);
  return result;
}

/** The pages' index by id. */
export const pageIndexOf = (content, pageId) => content.pages.findIndex(p => p.id === pageId);

/** The source page index of a model page (after `editable`, model page i is source page i when pages were shared). */
export const sourceIndexOf = (content, pageId) => content.pages.find(p => p.id === pageId)?.sourceIndex ?? -1;

const round = v => Math.round(v * 100) / 100;

/** A field as commands and the bridge describe it (rectangles in page view points). */
export function describeField(content, f) {
  const pages = new Map((content.pages ?? []).map(p => [p.id, p]));
  return {
    name: f.name, kind: f.kind, value: f.value, defaultValue: f.defaultValue, options: f.options.map(([e, d]) => (e === d ? d : {value: e, label: d})),
    readOnly: (f.flags & 1) !== 0, required: (f.flags & 2) !== 0, tooltip: f.tooltip ?? '', maxLen: f.maxLen, quadding: f.quadding, flags: f.flags,
    multiline: f.kind === 'text' && (f.flags & (1 << 12)) !== 0, password: f.kind === 'text' && (f.flags & (1 << 13)) !== 0, comb: f.kind === 'text' && (f.flags & (1 << 24)) !== 0,
    locked: f.widgets.some(w => w.locked),
    format: f.actions.format, validate: f.actions.validate, calculate: f.actions.calculate, unsupported: f.actions.unsupported,
    widgets: f.widgets.map((w, index) => {
      const page = pages.get(w.pageId);
      return {index, page: w.pageId, rect: page ? userRectToView(page, w.rect).map(round) : null, tab: w.tab === Number.MAX_SAFE_INTEGER ? null : w.tab, hidden: w.hidden, locked: w.locked,
        exportValue: w.onState ?? null, rotation: w.rotation};
    }),
  };
}

/** A view rectangle [x, y, w, h] on `page` → a normalised user-space rectangle. */
export function userRectOf(page, [x, y, w, h]) {
  const r = viewRectToUser(page, [x, y, x + w, y + h]);
  return normalize(r);
}

/** The fields the form command acts on: the selection (`view.formSel`) or the named field. */
export function selectionOf(ctx) {
  const sel = Array.isArray(ctx.view?.formSel) ? ctx.view.formSel : [];
  const fields = ctx.doc?.fields ?? [];
  return sel.filter(s => fields.some(f => f.name === s.name && s.widget < f.widgets.length));
}

export {PDF_MAX_BYTES, modelFields};
