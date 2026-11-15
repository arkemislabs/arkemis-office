// What a click in the slide show lands on: the slide's shapes in drawing order (a group before its
// children), each with its own action and whether the pointer is inside its box; fed to
// ShowState.click / target (core/prism/lib/show-state.mjs).
// Follows deckcraft crates/ui-egui/src/show.rs (`links`: PlacedShape lists the shapes with their
// actions). MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM.

import {xfrmAffine, groupChildAffine} from '../model/geom/index.mjs';
import {affChain, affInverse, apply, IDENTITY} from '../model/geom/kurbo.mjs';
import {ctxForSlide, xfrm as resolveXfrm} from '../model/resolve.mjs';
import {isGroup} from '../model/presentation.mjs';

/**
 * Shapes of `slide` back to front as [{id, parent, isGroup, link, underPointer}]. `at` is the
 * pointer in slide points. A shape's action is its click action (shape.click), as a hyperlink
 * `{action: {kind, ...}}`.
 */
export function hitShapes(pres, slide, at) {
  const ctx = ctxForSlide(pres, slide);
  const out = [];
  const walk = (list, parent, parentM, top) => {
    for (const sh of list ?? []) {
      if (sh.hidden) continue;
      const x = top ? (ctx ? resolveXfrm(ctx, sh) : sh.xfrm) : sh.xfrm;
      if (!x) continue;
      const m = affChain(parentM, xfrmAffine(x));
      let under = false;
      const inv = affInverse(m);
      if (inv) {
        const p = apply(inv, at);
        under = p.x >= 0 && p.y >= 0 && p.x <= x.w && p.y <= x.h;
      }
      const index = out.length;
      out.push({id: sh.id, parent, isGroup: isGroup(sh), link: sh.click?.action ? sh.click : null, underPointer: under});
      if (isGroup(sh)) {
        const c = sh.kind.child ?? {x: 0, y: 0, w: x.w, h: x.h};
        walk(sh.kind.children, index, affChain(parentM, groupChildAffine(x, {x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h})), false);
      }
    }
  };
  walk(slide.shapes, null, IDENTITY, true);
  return out;
}
