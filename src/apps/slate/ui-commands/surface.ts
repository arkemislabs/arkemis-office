// The page canvas's own edits (F:slate foundation; docs/architecture.md 4.4 and 16.5).
//
// Slate has no ArtCraft upstream; these are OneNote's direct-manipulation actions on the page
// surface (docs/spec/slate.json panes › page-canvas), which no ribbon control names:
//   typing and editing in a note container (ProseMirror steps from the editor),
//   typing the page title, clicking anywhere to start a note container, dragging a container by
//   its top bar, resizing its width, deleting a selected container, drawing a pen or highlighter
//   stroke and erasing strokes.
// Each runs through the kernel like every other command (one undo entry, "Automation: <label>" from
// the bridge, the same model functions the ribbon families use), so nothing on the canvas
// changes the document behind the registry's back. Typing merges into one undo entry per burst,
// as OneNote's Undo Typing does.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import * as model from '../../../../core/slate/model/index.mjs';
import {addStrokes, snapStroke} from '../../../../core/slate/lib/ink-edit.mjs';

const UPSTREAM = {repo: 'office' as const, files: ['docs/spec/slate.json#panes/page-canvas']};
const pageParam = s.string({min: 1, max: 80, description: 'Page id (the /pg:<id> of the page)'});
const point = s.string({min: 1, max: 4096, description: 'An address inside the page'});
const notebookOnly = (ctx: any) => model.notebookState(ctx);

export default defineCommands({
  family: 'surface',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'surface.edit', label: 'Typing', risk: 'edit', needs: 'view', repeatable: false,
      description: 'Apply the page editor\'s ProseMirror steps to a page (typing, deleting, pasting in a note container).',
      params: s.object({
        page: pageParam,
        steps: s.array(s.any(), {min: 1, max: 5000}),
        selection: s.optional(s.object({anchor: point, focus: point})),
        typing: s.optional(s.boolean({description: 'Merge with the previous typing on this page (one Undo Typing)'})),
        label: s.optional(s.string({min: 1, max: 60})),
      }),
      state: notebookOnly,
      run(ctx: any, p: any) {
        const n = model.applySteps(ctx, p.page, p.steps);
        if (p.selection) ctx.setSelection({ranges: [p.selection], primary: 0});
        if (p.typing) ctx.mergeUndo(`typing:${p.page}`);
        if (p.label) ctx.setUndoLabel(p.label);
        return {steps: n};
      },
    },
    {
      id: 'surface.title', label: 'Typing', risk: 'edit', needs: 'view', repeatable: false,
      description: 'Set the page title as it is typed in the title area above the date and time.',
      params: s.object({page: pageParam, title: s.string({max: model.LIMITS.titleLength}), typing: s.optional(s.boolean())}),
      state: notebookOnly,
      run(ctx: any, p: any) {
        const changed = model.setPageTitle(ctx, p.page, p.title);
        if (p.typing) ctx.mergeUndo(`title:${p.page}`);
        return {changed};
      },
    },
    {
      id: 'surface.newContainer', label: 'Note Container', risk: 'edit', needs: 'view',
      description: 'Start a note container at a point on the page (page px from the top left), optionally with text.',
      params: s.object({
        page: pageParam,
        x: s.number({min: 0, max: 50000}), y: s.number({min: 0, max: 500000}),
        width: s.optional(s.number({min: model.MIN_CONTAINER_WIDTH, max: 20000})),
        text: s.optional(s.string({max: 1_000_000})),
      }),
      state: notebookOnly,
      run(ctx: any, p: any) {
        const r = model.insertContainer(ctx, p.page, {x: p.x, y: p.y, width: p.width ?? null, text: p.text ?? ''});
        const doc = model.pageDoc(ctx, p.page);
        const block = model.blockIndex(doc).get(r.paragraph)!;
        const caret = `/pg:${p.page}/b:${r.paragraph}/t:${block.node.content.size}`;
        ctx.setSelection({ranges: [{anchor: caret, focus: caret}], primary: 0});
        return {container: `/pg:${p.page}/c:${r.container}`, paragraph: `/pg:${p.page}/b:${r.paragraph}`};
      },
    },
    {
      id: 'surface.moveContainer', label: 'Move', risk: 'edit', needs: 'view',
      description: 'Move a note container to a point on the page (dragging its top bar).',
      params: s.object({page: pageParam, container: s.string({min: 1, max: 80}), x: s.number({min: 0, max: 50000}), y: s.number({min: 0, max: 500000})}),
      state: notebookOnly,
      run(ctx: any, p: any) { return {moved: model.moveContainer(ctx, p.page, p.container, {x: p.x, y: p.y})}; },
    },
    {
      id: 'surface.resizeContainer', label: 'Resize', risk: 'edit', needs: 'view',
      description: 'Set a note container\'s width (its width handle); null lets the text size it.',
      params: s.object({page: pageParam, container: s.string({min: 1, max: 80}), width: s.nullable(s.number({min: model.MIN_CONTAINER_WIDTH, max: 20000}))}),
      state: notebookOnly,
      run(ctx: any, p: any) { return {resized: model.resizeContainer(ctx, p.page, p.container, p.width)}; },
    },
    {
      id: 'surface.deleteContainer', label: 'Delete', risk: 'edit', needs: 'view',
      description: 'Delete a selected note container with its notes.',
      params: s.object({page: pageParam, container: s.string({min: 1, max: 80})}),
      state: notebookOnly,
      run(ctx: any, p: any) {
        model.deleteContainer(ctx, p.page, p.container);
        ctx.setSelection(model.selectPage(p.page));
        return {deleted: `/pg:${p.page}/c:${p.container}`};
      },
    },
    {
      id: 'surface.ink', label: 'Ink', risk: 'edit', needs: 'view',
      description: 'Add a pen, pencil or highlighter stroke to the ink layer of the page (points are page px); with snap (Ink to Shape) a stroke that is a line, triangle, rectangle, diamond or oval becomes that shape.',
      params: s.object({
        page: pageParam,
        stroke: s.object({
          tool: s.enum(['pen', 'pencil', 'highlighter']), color: s.string({pattern: '^#[0-9a-fA-F]{6}$'}), width: s.number({min: 0.1, max: 200}),
          points: s.array(s.number(), {min: 2, max: model.LIMITS.points}), fx: s.optional(s.nullable(s.enum(['galaxy', 'rainbow']))),
        }),
        snap: s.optional(s.boolean({description: 'Ink to Shape: turn a recognised shape into its strokes'})),
      }),
      state: notebookOnly,
      run(ctx: any, p: any) {
        const stroke = p.stroke.fx ? p.stroke : {...p.stroke, fx: undefined};
        if (p.snap) {
          const {strokes, shape} = snapStroke(ctx, stroke);
          const ids = addStrokes(ctx, p.page, strokes);
          return {stroke: `/pg:${p.page}/ink:${ids[0]}`, ...(shape ? {shape, strokes: ids.length} : {})};
        }
        return {stroke: `/pg:${p.page}/ink:${model.addStroke(ctx, p.page, stroke)}`};
      },
    },
    {
      id: 'surface.erase', label: 'Erase', risk: 'edit', needs: 'view',
      description: 'Remove ink strokes from the page (the stroke eraser).',
      params: s.object({page: pageParam, strokes: s.array(s.string({min: 1, max: 80}), {min: 1, max: 20000})}),
      state: notebookOnly,
      run(ctx: any, p: any) { return {erased: model.eraseStrokes(ctx, p.page, p.strokes)}; },
    },
  ],
});
