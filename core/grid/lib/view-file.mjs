// The view a workbook is saved with and opened in (U:grid/view): the active sheet's zoom (`zoomScale`)
// and view (`sheetView view`: Normal, Page Break Preview, Page Layout). Showing a sheet another way is
// never an edit (gridcraft `set_view` and `zoom` neither record an undo step nor mark a clean workbook
// changed): the view goes into the file only when it is saved.
//
// Translated from gridcraft crates/engine/src/cmd/extra/window.rs (`set_view`) and cmd/view.rs (`zoom`)
// at fb1e59f; the session view holds what the sheet had (the kernel keeps one view per document, so
// every sheet shows at the one zoom while open). MIT, see assets/third-party-licenses/artcraft-reference.txt.

const MODES = ['pageBreakPreview', 'pageLayout'];

const activeOf = c => c.sheets.find(s => s.id === c.activeSheetId) ?? c.sheets[0];

/** The view an opened workbook starts in: the active sheet's zoom and view mode. */
export function initialView(file) {
  const c = file?.content;
  if (!c || !Array.isArray(c.sheets) || !c.sheets.length) return {};
  const sh = activeOf(c);
  const out = {};
  if (Number.isInteger(sh?.zoom)) { out.zoom = Math.min(400, Math.max(10, sh.zoom)); out.fit = null; }
  if (MODES.includes(sh?.view)) out.mode = sh.view;
  return out;
}

/** The file as it is written: the active sheet carries the zoom and view mode the workbook is shown with. */
export function fileForSave(file, view) {
  const c = file?.content;
  if (!c || !Array.isArray(c.sheets) || !c.sheets.length) return file;
  const sh = activeOf(c);
  const z = Number(view?.zoom);
  const zoom = Number.isFinite(z) ? Math.round(Math.min(400, Math.max(10, z))) : 100;
  const mode = MODES.includes(view?.mode) ? view.mode : null;
  const nextMode = mode;
  if ((sh.zoom ?? 100) === zoom && (sh.view ?? null) === nextMode) return file;
  const next = {...sh};
  if (zoom === 100) delete next.zoom; else next.zoom = zoom;
  if (nextMode) next.view = nextMode; else delete next.view;
  return {...file, content: {...c, sheets: c.sheets.map(x => (x === sh ? next : x))}};
}
