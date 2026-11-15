// Contextual flags for the PDF window (docs/architecture.md 8.6).
//
// The contextual panels and bars of docs/spec/pdf.json (printcraft crates/ui-egui: Organize pages,
// Measure objects, Add a stamp, Calculation order, Find, Enhance camera image, Combine files,
// Compare, Notice bars) open with a tool or a view state, which the surface reports
// (src/apps/folio/surface, SurfaceHandle.contextFlags); from the document and selection alone
// they are off. `annotation` and `text-selection` say what the selection holds.
// Translated against printcraft 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). No DOM, no Node built-ins.

export const flags = ['organize-pages', 'measure-objects', 'add-a-stamp', 'calculation-order', 'find', 'enhance-camera-image', 'combine-files',
  'compare', 'notice-bars', 'annotation', 'text-selection', 'page-selection'];

export function evaluate(content, selection) {
  const out = Object.fromEntries(flags.map(f => [f, false]));
  for (const r of selection?.ranges ?? []) {
    const a = String(r.anchor ?? '');
    if (/^\/pg:[^/]+\/annot:/.test(a)) out.annotation = true;
    else if (/^\/pg:[^/]+\/chars:/.test(a) && r.focus !== r.anchor) out['text-selection'] = true;
    else if (/^\/pg:[^/]+$/.test(a)) out['page-selection'] = true;
  }
  if (!Array.isArray(content?.pages) || !content.pages.length) out['page-selection'] = false;
  return out;
}
