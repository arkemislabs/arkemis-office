// Contextual tab flags for Prism (docs/architecture.md 8.6): which contextual tabs show for the
// current selection. Flag names are the spec's contextual tab ids (`contextFor`). The `when` rules
// come from the spec (docs/spec/prism.json ribbon[].when, from deckcraft
// crates/ui-egui/src/ribbon.rs contextual tab conditions at f893f6af7d36a5409fd804e81a34fd895cfefedf).
// Foundation-owned (F:prism). No DOM, no Node built-ins.

import {isSchema2, currentSlideId, selectedShapeIds, textSelection, slideById} from './model/doc.mjs';
import {findShape, isGroup} from './model/presentation.mjs';

export const flags = Object.freeze(['shape-format', 'picture-format', 'table-design', 'layout', 'chart-design', 'format', 'smart-art-design',
  'video-format', 'playback', 'slide-master', 'handout-master', 'notes-master']);

/**
 * Flags for the selection. The master views (slide-master, handout-master, notes-master) are view
 * state the surface reports through its own contextFlags() (SurfaceHandle), not the document.
 */
export function evaluate(content, selection) {
  const out = {};
  if (!isSchema2(content)) {
    // Schema 1: any selected element is a shape.
    if ((selection?.ranges ?? []).some(r => /\/sl:[^/]+\/sp:/.test(r.anchor))) out['shape-format'] = true;
    return out;
  }
  const slideId = currentSlideId(content, selection);
  const sl = slideById(content, slideId);
  if (!sl) return out;
  const t = textSelection(content, selection);
  const ids = t && !t.notes ? [t.shape] : selectedShapeIds(content, selection);
  for (const id of ids) {
    const sh = findShape(sl.shapes, id);
    if (!sh) continue;
    const k = sh.kind?.type;
    // "a shape, group or connector is selected, or text is being edited"
    if (k === 'shape' || k === 'connector' || isGroup(sh) || (t && !t.cell)) out['shape-format'] = true;
    if (k === 'picture') out['picture-format'] = true;
    if (k === 'table') { out['table-design'] = true; out.layout = true; }
    if (k === 'chart') { out['chart-design'] = true; out.format = true; }
    if (sh.diagram) out['smart-art-design'] = true;
    if (k === 'media') { if (sh.kind.video) out['video-format'] = true; out.playback = true; }
  }
  return out;
}
