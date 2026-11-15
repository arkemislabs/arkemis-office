// Selection pane: picking objects from the list (groups' members too), Show All and Hide All.
// The pane's other actions are ordinary commands of other families: `shape.visible` (eye),
// `shape.lock` (padlock), `shape.rename`, `arrange.bringForward` / `arrange.sendBackward`
// (arrows) and `arrange.reorder` (drag and drop).
// Translated from deckcraft crates/engine/src/cmd/selection.rs (`specs`, `select`, `show_all`,
// `hide_all`) at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {parentOf, findShape, walk} from '../model/presentation.mjs';
import {slidePath} from '../model/doc.mjs';
import {bad, hasSlide, selectionOf, idsParam, idOf, selectShapeIds, mapShapes, UPSTREAM_COMMIT} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/selection.rs', 'crates/engine/src/cmd/selection_tests.rs']};
const shapeId = s.union([s.string({min: 1, max: 64}), s.integer({min: 0, max: 4294967295})]);

/** Is shape `id` inside a group (true), top-level (false), or absent (null)? deckcraft `parent_of(...).map(is_some)`. */
function inGroup(shapes, id) {
  if (!findShape(shapes, id)) return null;
  return !!parentOf(shapes, id);
}

export default defineCommands({
  family: 'selection',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'selection.select', label: 'Select', risk: 'edit',
      description: 'Selection pane click: select objects by id (objects in groups too); `toggle` is Ctrl+click, `add` adds. Objects in groups and top-level objects are not mixed (the other kind is ignored); picking a hidden object shows it.',
      params: s.object({ids: s.optional(s.array(shapeId, {max: 5000})), id: s.optional(shapeId), toggle: s.optional(s.boolean()), add: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        const ids = idsParam(p, 'ids') ?? (p.id !== undefined && idOf(p.id) ? [idOf(p.id)] : []);
        const sel = selectionOf(ctx);
        const shapes = sel.slide?.shapes ?? [];
        let valid = ids.filter(i => inGroup(shapes, i) !== null);
        if (!valid.length) throw bad('selection.select', 'no such shape', {path: '/ids'});
        const kind = inGroup(shapes, valid[0]);
        valid = valid.filter(i => inGroup(shapes, i) === kind);
        let keep = [];
        if (p.toggle || p.add) {
          const current = sel.text && !sel.text.notes ? [sel.text.shape] : sel.shapes;
          // Can't mix objects in groups with top-level ones: nothing changes.
          if (current.length && inGroup(shapes, current[0]) !== kind) return {selected: current};
          keep = [...current];
        }
        const next = keep;
        for (const i of valid) {
          const k = next.indexOf(i);
          if (k >= 0) { if (p.toggle) next.splice(k, 1); } else next.push(i);
        }
        const reveal = next.filter(i => valid.includes(i) && findShape(shapes, i)?.hidden);
        if (reveal.length) {
          const sp = slidePath(ctx.doc, sel.slideId);
          ctx.change.set([...sp, 'shapes'], mapShapes(shapes, x => (reveal.includes(x.id) ? {...x, hidden: false} : x)));
        }
        selectShapeIds(ctx, sel.slideId, next);
        return {selected: next};
      },
    },
    {
      id: 'selection.showAll', label: 'Show All', risk: 'edit',
      description: 'Show All (Selection pane): show every object on the slide, inside groups too.',
      params: s.object({}), state: hasSlide,
      run(ctx) {
        const sel = selectionOf(ctx);
        let any = false;
        walk(sel.slide?.shapes ?? [], x => { if (x.hidden) any = true; });
        if (!any) return {};
        ctx.change.set([...slidePath(ctx.doc, sel.slideId), 'shapes'], mapShapes(sel.slide.shapes, x => (x.hidden ? {...x, hidden: false} : x)));
        return {};
      },
    },
    {
      id: 'selection.hideAll', label: 'Hide All', risk: 'edit',
      description: 'Hide All (Selection pane): hide every top-level object on the slide.',
      params: s.object({}), state: hasSlide,
      run(ctx) {
        const sel = selectionOf(ctx);
        const list = sel.slide?.shapes ?? [];
        if (list.every(x => x.hidden)) return {};
        ctx.change.set([...slidePath(ctx.doc, sel.slideId), 'shapes'], list.map(x => (x.hidden ? x : {...x, hidden: true})));
        return {};
      },
    },
  ],
});
