// Set Alternate Text (submit: a11y.alt_text.apply): the tagged figures one by one ("Figure i of n on page p"), the Alternate text box and Decorative figure; Previous and
// Next keep what was typed; Save & Close sets the alternate text of the figures that changed in one undo step.
// Translated from printcraft crates/ui-egui/src/workflows/a11y_ui.rs `alt_body`, `start_alt_text`, `save_alt_text` at 8f16855 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). Not translated: the picture of the figure (no preview is drawn: upstream shows "No preview" when it cannot).

import {defineDialog} from '../../kernel/dialog.mjs';

const infoOf = (figures, i) => (figures.length ? `Figure ${i + 1} of ${figures.length}${figures[i]?.page != null ? ` on page ${figures[i].page + 1}` : ''}` : 'This document has no tagged figures.');

/** What is typed for the figure now showing joins the kept edits. */
function kept(v) {
  const figures = Array.isArray(v.figures) ? v.figures : [];
  const edits = {...(v.edits ?? {})};
  const f = figures[Number(v.index) || 0];
  if (f) edits[f.object] = {alt: String(v.text ?? ''), decorative: v.decorative === true};
  return edits;
}

/** The figures that changed, as a11y.alt_text items (save_alt_text: decorative first, then changed text). */
export function itemsOf(v, figures = v.figures ?? []) {
  const edits = kept({...v, figures});
  const items = [];
  for (const f of figures) {
    const e = edits[f.object];
    if (!e) continue;
    if (e.decorative) items.push({object: f.object, decorative: true});
    else if (e.alt.trim() !== String(f.alt ?? '').trim()) items.push({object: f.object, alt: e.alt});
  }
  return items;
}

export default defineDialog({
  id: 'dialog.alt-text',
  title: 'Set Alternate Text',
  command: 'a11y.alt_text.apply',
  // The command passes the figures through `openDialog`; a program (or a test) opening the dialog by its id passes them as `args.figures`.
  init(_ctx, args) {
    const figures = Array.isArray(args?.figures) ? args.figures.map(f => ({object: String(f.object), page: f.page ?? null, alt: f.alt ?? ''})) : [];
    return {figures, index: 0, text: figures[0]?.alt ?? '', decorative: false, edits: {}, info: infoOf(figures, 0), more: figures.length > 1, prev: 0, next: 0};
  },
  validate: () => [],
  derive(v, changed) {
    const figures = Array.isArray(v.figures) ? v.figures : [];
    if (!changed.includes('prev') && !changed.includes('next')) return {info: infoOf(figures, Number(v.index) || 0), more: (Number(v.index) || 0) < figures.length - 1};
    const edits = kept(v);
    const index = Math.max(0, Math.min(figures.length - 1, (Number(v.index) || 0) + (changed.includes('next') ? 1 : -1)));
    const f = figures[index];
    const e = f ? edits[f.object] : null;
    return {edits, index, text: e ? e.alt : String(f?.alt ?? ''), decorative: e ? e.decorative : false, info: infoOf(figures, index), more: index < figures.length - 1};
  },
  toCommand: v => ({command: 'a11y.alt_text.apply', params: {items: itemsOf(v)}}),
});
