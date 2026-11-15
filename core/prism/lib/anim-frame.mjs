// The animation state of every animated shape (and paragraph) at one moment of a show, shaped for
// the slide renderer: `shape(id)` → AnimState (or null: untouched), `para(shapeId, index)` → the
// paragraph's state relative to its shape (or null).
// The renderer side is deckcraft crates/ui-egui/src/show.rs `state_for` (ShapeState, ParaState).
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM.

import {isIdentity} from './anim-timeline.mjs';

/**
 * @param {import('./anim-timeline.mjs').Timeline} tl
 * @param {(id: string, para: number | null) => object} stateOf the state of a shape (para null) or one of its paragraphs
 */
export function animFrame(tl, stateOf) {
  const shapes = new Map();
  const paras = new Map();
  for (const id of tl.animatedShapes()) {
    const s = stateOf(id, null);
    if (!isIdentity(s)) shapes.set(id, s);
    else shapes.set(id, null);
    const targets = tl.paragraphTargets(id);
    if (targets.length) paras.set(id, new Map(targets.map(p => [p, stateOf(id, p)])));
  }
  return {
    /** The state to draw the shape in; null when nothing is animated on it or the state is the identity. */
    shape: id => shapes.get(id) ?? null,
    para: (id, p) => paras.get(id)?.get(p) ?? null,
    animated: id => shapes.has(id),
  };
}

/** The ids of the shapes with an animation, in the order of the Animation Pane. */
export const animatedIds = slide => [...new Set((slide?.animations ?? []).map(a => a.shape))];
