// Contextual flags for Quill's contextual ribbon tabs.
// Translated from wordcraft crates/ui-egui/src/ribbon/tabs.rs (`contextual_tabs`,
// `has_picture_selected`, `has_shape_selected`), crates/engine/src/cmd/objects/select.rs
// (`selected_all`), crates/engine/src/cmd/chart.rs (`selected_chart`) and
// crates/engine/src/cmd/smart_art.rs (`selected_smart_art`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Flag ids are the spec's contextual tab ids (docs/spec/quill.json, kebab-cased labels). Upstream
// shows: Table Design + Table Layout while the caret is in a table cell; Picture Format when the
// selected object is a picture; Shape Format for a shape, text box or drawing canvas; SmartArt
// Design / Chart Design for an editable SmartArt graphic / chart; Equation while an equation is
// being edited; Outlining in Outline view; Immersive Reader while Word's Immersive Reader is on. Header & Footer is shown while the selection is in a
// header or footer story (Word's tab; upstream shows "Editing header/footer" in the status bar).
// No DOM, no Node built-ins.

import {isQuill2} from './model/content.mjs';
import {Document, cmpPath, samePath} from './model/document.mjs';
import * as P from './model/para.mjs';
import {selectionPositions} from './address.mjs';

export const flags = Object.freeze(['table-design', 'table-layout', 'header-and-footer', 'picture-format', 'shape-format', 'equation',
  'chart-design', 'chart-format', 'smart-art-design', 'outlining', 'immersive-reader']);

/** The pictures and shapes in the selection (at most `max`), or the one just before / at a collapsed caret (selected_all). */
export function selectedObjects(content, a, b, max = 1, want = P.isDrawing) {
  const out = [];
  const d = new Document(content);
  const collapsed = a.story === b.story && samePath(a.path, b.path) && a.off === b.off;
  if (collapsed) max = 1;
  const paths = collapsed ? [a.path] : d.pathsBetween(a, b);
  for (const path of paths) {
    const p = d.para(a.story, path);
    if (!p) continue;
    for (const [off, o] of P.objectsWithOffsets(p)) {
      const inside = collapsed ? off + 1 === a.off || off === a.off
        : (!samePath(path, a.path) || off >= a.off) && (!samePath(path, b.path) || off < b.off);
      if (!inside || !want(o)) continue;
      out.push({pos: {story: a.story, path, off}, obj: o});
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Which contextual flags are on for a selection. `view` is the document's view state ({mode}). */
export function evaluate(content, selection, prefs = {}, view = null) {
  const on = {};
  for (const f of flags) on[f] = false;
  const mode = view?.mode ?? prefs?.viewMode ?? null;
  if (mode === 'outline' && !view?.readMode && !view?.immersive) on.outlining = true;
  // View › Immersive Reader shows Word's Immersive Reader tab (U:quill/view).
  if (view?.immersive) on['immersive-reader'] = true;
  if (!isQuill2(content)) return on;
  let ranges;
  try { ranges = selectionPositions(content, selection); } catch { return on; }
  const r = ranges[selection?.primary ?? 0] ?? ranges[0];
  if (!r) return on;
  const [a, b] = cmpPos(r.anchor, r.focus) <= 0 ? [r.anchor, r.focus] : [r.focus, r.anchor];
  // The caret (the selection's focus) in a table cell.
  if (r.focus.path.length >= 4) { on['table-design'] = true; on['table-layout'] = true; }
  const kind = r.focus.story === 'body' ? null : content.parts[r.focus.story]?.kind;
  if (kind === 'header' || kind === 'footer') on['header-and-footer'] = true;
  const sel = selectedObjects(content, a, b, 1)[0]?.obj ?? null;
  if (sel?.type === 'image') on['picture-format'] = true;
  if (sel && (sel.type === 'shape' || P.isCanvas(sel))) on['shape-format'] = true;
  if (sel?.type === 'graphic' && sel.graphic?.smartArt) on['smart-art-design'] = true;
  if (sel?.type === 'graphic' && sel.graphic?.chart) { on['chart-design'] = true; on['chart-format'] = true; }
  // An equation being edited: the caret at (or the selection on) an equation object.
  if (view?.math || selectedObjects(content, a, b, 1, o => o.type === 'equation').length) on.equation = true;
  return on;
}

const cmpPos = (x, y) => (x.story === y.story ? cmpPath(x.path, y.path) || x.off - y.off : 0);
