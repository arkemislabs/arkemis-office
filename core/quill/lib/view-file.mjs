// The view a document is saved with and opened in (U:quill/view), as Word keeps it in
// settings.xml: the zoom (`w:zoom`: a percent, or a fit) and the view (`w:view`: web, outline,
// normal for Draft; Print Layout is the default and is not written). Showing a document another
// way is never an edit: the view goes into the file only when it is saved, and the document is
// not marked changed by a zoom or a view switch.
//
// Translated from wordcraft crates/engine/src/cmd/view.rs (`saved_zoom`, `restore_zoom`) and
// crates/engine/src/session/history.rs (`stamp_save`: the document keeps the zoom it is shown at)
// at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c; `w:view` is Word's (upstream keeps
// the original element). MIT, see assets/third-party-licenses/artcraft-reference.txt.

const SAVED_FITS = ['onePage', 'pageWidth', 'textWidth'];

/** The zoom a document is saved with (saved_zoom): the fit, else the percent; null at 100%. */
export function savedZoom(view) {
  const fit = SAVED_FITS.includes(view?.fit) ? view.fit : null;
  const z = Number(view?.zoom);
  const percent = Number.isFinite(z) ? Math.round(Math.min(500, Math.max(10, z))) : 100;
  return percent !== 100 || fit ? {percent, fit} : null;
}

/** The view a document is saved in (Word's w:view): 'web', 'outline' or 'draft'; null for Print Layout. */
export function savedView(view) {
  const m = view?.mode;
  return m === 'web' || m === 'outline' || m === 'draft' ? m : null;
}

/** The file as it is written: the content's settings carry the zoom and view the document is shown with. */
export function fileForSave(file, view) {
  const c = file?.content;
  if (!c || typeof c !== 'object' || !c.settings) return file;
  const zoom = savedZoom(view), v = savedView(view);
  if (JSON.stringify(c.settings.zoom ?? null) === JSON.stringify(zoom) && (c.settings.view ?? null) === v) return file;
  return {...file, content: {...c, settings: {...c.settings, zoom, view: v}}};
}

/** The view an opened document starts in (restore_zoom, and Word's w:view). */
export function initialView(file) {
  const s = file?.content?.settings;
  const out = {};
  const z = s?.zoom;
  if (z && typeof z === 'object') {
    out.zoom = Math.min(500, Math.max(10, Number(z.percent) || 100));
    out.fit = SAVED_FITS.includes(z.fit) ? z.fit : null;
    out.multiPage = false;
    out.singleColumn = out.fit === 'onePage' || out.fit === 'pageWidth';
  }
  if (['web', 'outline', 'draft'].includes(s?.view)) out.mode = s.view;
  return out;
}
