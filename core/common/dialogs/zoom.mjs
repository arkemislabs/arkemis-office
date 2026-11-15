// Zoom dialog model for every app (submit: view.zoom).
// Fields differ by app (spec dialog.zoom): Quill (Word's dialog) {preset: 200% / 100% / 75% / Page
// width / Text width / Whole page / Many pages, percent, preview}, Grid {preset: 200..25 | fit |
// custom, percent 10–400}, Prism {mode: Fit | 400%..33%, percent}. One model covers all three: the
// values object carries every field and the renderer shows the ones the app's spec lists.
// Upstream: wordcraft crates/ui-egui/src/dialogs/dispatch.rs (zoom), gridcraft and deckcraft
// crates/ui-egui/src/dialogs/zoom.rs.

import {defineDialog} from '../../kernel/dialog.mjs';

const pct = v => {
  if (typeof v === 'number') return v;
  const m = /^(\d{1,3}(?:\.\d+)?)\s*%?$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) : null;
};
/** Word's Zoom to choices that are fits (the zoom follows the window), not a percent. */
const FITS = ['pageWidth', 'textWidth', 'onePage', 'multiplePages'];

export default defineDialog({
  id: 'dialog.zoom',
  title: 'Zoom',
  command: 'view.zoom',
  init(ctx) {
    const zoom = ctx.view?.zoom ?? 100;
    const fit = ctx.view?.fit ?? null;
    const label = `${zoom}%`;
    // Word: a fit mode is the chosen option; else 200% / 100% / 75% when the zoom is one of them.
    const quillPreset = ctx.app === 'quill' && FITS.includes(fit) ? fit : ['200%', '100%', '75%'].includes(label) ? label : null;
    return {
      percent: zoom,
      fit,
      preset: ctx.app === 'grid' ? (['200', '100', '75', '50', '25'].includes(String(zoom)) ? String(zoom) : 'custom') : quillPreset,
      mode: fit === 'fit' ? 'Fit' : ['400%', '200%', '150%', '100%', '75%', '66%', '50%', '33%'].includes(label) ? label : null,
    };
  },
  derive(values, changed) {
    const field = changed[0];
    if (field === 'preset' && values.preset && values.preset !== 'custom' && values.preset !== 'fit' && !FITS.includes(values.preset)) {
      const p = pct(values.preset);
      if (p) return {percent: p, mode: null};
    }
    if (field === 'mode' && values.mode && values.mode !== 'Fit') {
      const p = pct(values.mode);
      if (p) return {percent: p, preset: null};
    }
    // Typing a percent picks no option (Word clears the radio buttons), except the matching one.
    if (field === 'percent') {
      const p = pct(values.percent);
      const match = ['200%', '100%', '75%'].find(l => pct(l) === p) ?? null;
      return {preset: values.preset === 'fit' ? 'custom' : FITS.includes(values.preset) || pct(values.preset) !== null ? match : values.preset, mode: values.mode === 'Fit' ? null : values.mode};
    }
    return {};
  },
  validate(values) {
    if (values.preset === 'fit' || values.mode === 'Fit' || FITS.includes(values.preset)) return [];
    const p = pct(values.percent);
    if (p === null || p < 10 || p > 500) return [{field: 'percent', message: 'Enter a zoom between 10% and 500%'}];
    return [];
  },
  /** What the preview draws (Word's monitor with the page at the zoom, and the sample text): the page and its text width, in points. */
  preview(ctx, values) {
    const s = ctx.doc?.lastSection ?? null;
    const pageW = Number.isFinite(s?.pageW) ? s.pageW : 612, pageH = Number.isFinite(s?.pageH) ? s.pageH : 792;
    const textW = Math.max(36, pageW - (s?.marginLeft ?? 72) - (s?.marginRight ?? 72));
    return {pageW, pageH, textW, percent: pct(values.percent) ?? 100, fit: FITS.includes(values.preset) ? values.preset : null};
  },
  buttons: {
    pageWidth: () => ({command: 'view.zoom', params: {value: 'pageWidth'}}),
    wholePage: () => ({command: 'view.zoom', params: {value: 'onePage'}}),
    manyPages: () => ({command: 'view.zoom', params: {value: 'multiplePages'}}),
  },
  toCommand(values) {
    if (values.preset === 'fit') return {command: 'view.zoomToSelection', params: {}};
    if (FITS.includes(values.preset)) return {command: 'view.zoom', params: {value: values.preset}};
    if (values.mode === 'Fit') return {command: 'view.zoom', params: {value: 'fit'}};
    if (values.textWidth === true) return {command: 'view.zoom', params: {value: 'textWidth'}};
    return {command: 'view.zoom', params: {percent: pct(values.percent)}};
  },
});
