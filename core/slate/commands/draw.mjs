// Draw tab: Tools, Pens, Shapes, Edit (Insert Space, Delete, Arrange, Rotate) and Convert
// (Ink to Shape, Ink Replay) (U:slate/draw).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `draw.*`,
// `ink.*`, `shape.*`, `object.*` and `edit.delete`; behaviour is OneNote's Draw tab:
//   * Tools: Type (the default), Lasso Select (drag a loop round ink to select it, click a stroke to
//     select it, drag the selection to move it), Eraser (the stroke eraser removes whole strokes; the
//     small, medium and large erasers rub out the parts they pass over), Panning Hand;
//   * Pens: a tray of pens, a pencil, galaxy and rainbow pens and highlighters; Add Pen adds one,
//     Remove Pen takes the selected one out, Color & Thickness changes it; Ruler and Draw with Touch
//     are modes of the page;
//   * Shapes: a gallery of lines, arrows, polygons, solids and graph axes drawn by dragging; a shape is
//     ink in the current pen (strokes that move together); Lock Drawing Mode keeps the shape tool on;
//   * Edit: Delete removes the selection, Arrange orders ink and note containers, Rotate turns or flips
//     the selected ink;
//   * Convert: Ink to Shape turns a drawn line, triangle, rectangle, diamond or oval into the shape;
//     Ink Replay plays the strokes again in the order they were drawn.
// Ink to Text, Math and Ink Editor need a handwriting recogniser the app does not have and are not
// offered. The ink is page data (`pages[id].ink`), saved with the notebook.

import {Fragment} from '@tiptap/pm/model';
import {Transform} from '@tiptap/pm/transform';
import {joinForward} from '@tiptap/pm/commands';
import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf} from '../schema.mjs';
import {selectPage} from '../model/notebook.mjs';
import {containersOf} from '../model/page.mjs';
import {applySteps, deleteContainer, pageDoc} from '../model/canvas.mjs';
import {ensureIds, editPage, runPmCommand, textRange} from '../lib/format-text.mjs';
import {DEFAULT_PENS, PENS_PREF, clean, erasePoints, findPen, flipped, inkSelection, inkState, lassoHits, moved, newPen, pageOf, pageState, penName,
  penTool, pensOf, rotated, selectedInk, withGroups, MM} from '../lib/ink.mjs';
import {addStrokes, newStrokeId, setInk, shapeStrokes} from '../lib/ink-edit.mjs';
import {SHAPES} from '../lib/shapes.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/draw.*', 'docs/spec/slate.json#commands/ink.*', 'docs/spec/slate.json#commands/shape.*',
  'docs/spec/slate.json#commands/object.*', 'docs/spec/slate.json#commands/edit.delete']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const colorParam = s.string({pattern: '^#[0-9a-fA-F]{6}$', description: '#RRGGBB'});
const pageParam = s.optional(s.string({min: 1, max: 80, description: 'Page id (default: the current page)'}));
const flat = s.array(s.number(), {min: 2, max: 200000});

export const TOOLS = Object.freeze(['type', 'lasso', 'eraser', 'pan', 'pen']);
export const ERASER_SIZES = Object.freeze({small: 4, medium: 10, large: 20, stroke: 6});
export const SHAPE_LABELS = Object.freeze({line: 'Line', arrow: 'Arrow', 'double-arrow': 'Double-headed Arrow', rectangle: 'Rectangle', oval: 'Oval', circle: 'Circle', triangle: 'Triangle',
  'right-triangle': 'Right Triangle', parallelogram: 'Parallelogram', diamond: 'Diamond', pentagon: 'Pentagon', hexagon: 'Hexagon', trapezoid: 'Trapezoid', cube: 'Cube',
  cylinder: 'Cylinder', cone: 'Cone', pyramid: 'Pyramid', 'graph-xy': 'Graph: X-Y Axis', 'graph-xyz': 'Graph: X-Y-Z Axis', 'graph-quadrant': 'Graph: First Quadrant',
  'graph-four-quadrant': 'Graph: Four Quadrants'});

const view = ctx => ctx.view ?? {};
const tool = ctx => view(ctx).ink ?? null;
const dark = hex => { const n = Number.parseInt(hex.slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) < 50; };

/** The pen the strokes are drawn with: the active pen tool, else the last pen used, else the black pen. */
function activePen(ctx) {
  const t = tool(ctx);
  if (t && ['pen', 'pencil', 'highlighter'].includes(t.tool)) return {tool: t.tool, color: t.color, width: t.width, fx: t.fx ?? null, penId: t.penId ?? null};
  const pens = pensOf(ctx.prefs);
  const p = pens.find(x => x.id === view(ctx).lastPen) ?? pens[0] ?? DEFAULT_PENS[0];
  return {tool: p.type, color: p.color, width: p.width, fx: p.fx ?? null, penId: p.id};
}

const iso = ctx => new Date(ctx.host.now()).toISOString();

export default defineCommands({
  family: 'draw',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Tools ------------------------------------------------------------------------------------
    {
      id: 'draw.tool', label: 'Tool', risk: 'read', effect: 'view',
      description: 'Choose the page tool: type (the default), lasso (select ink), eraser (size small, medium, large or stroke), pan (the hand) or pen (the pen last used).',
      params: s.object({tool: s.enum(TOOLS), size: s.optional(s.enum(Object.keys(ERASER_SIZES)))}),
      state(ctx, p) {
        const r = pageState(ctx);
        if (!r.enabled) return r;
        const t = tool(ctx);
        if (!p?.tool) return {enabled: true, value: t?.tool ?? 'type'};
        const on = p.tool === 'type' ? !t : p.tool === 'pen' ? !!t && ['pen', 'pencil', 'highlighter'].includes(t.tool)
          : p.tool === 'eraser' ? t?.tool === 'eraser' && (p.size === undefined || t.eraser === p.size) : t?.tool === p.tool;
        return {enabled: true, checked: on};
      },
      run(ctx, p) {
        const v = view(ctx);
        const off = {insertSpace: false};
        if (p.tool === 'type') ctx.setView({ink: null, ...off});
        else if (p.tool === 'lasso') ctx.setView({ink: {tool: 'lasso'}, ...off});
        else if (p.tool === 'pan') ctx.setView({ink: {tool: 'pan'}, ...off});
        else if (p.tool === 'eraser') ctx.setView({ink: {tool: 'eraser', eraser: p.size ?? 'medium'}, ...off});
        else {
          const pens = pensOf(ctx.prefs);
          const pen = pens.find(x => x.id === v.lastPen) ?? pens[0];
          need(pen, 'failed', 'There are no pens');
          ctx.setView({ink: penTool(pen), lastPen: pen.id, ...off});
        }
        return {tool: p.tool, ...(p.tool === 'eraser' ? {size: p.size ?? 'medium'} : {})};
      },
    },

    // --- Pens -------------------------------------------------------------------------------------
    {
      id: 'ink.selectPen', label: 'Pens', risk: 'read', effect: 'view',
      description: 'Pick a pen from the tray: the page draws with it until another tool is chosen. Without a pen the state lists the tray (id, name, icon, colour).',
      params: s.object({penId: s.optional(s.string({min: 1, max: 80})), value: s.optional(s.string({min: 1, max: 80}))}),
      state(ctx, p) {
        const r = pageState(ctx);
        if (!r.enabled) return r;
        const t = tool(ctx);
        const id = p?.penId ?? p?.value;
        if (id) return {enabled: true, checked: !!t && t.penId === id};
        return {enabled: true, value: pensOf(ctx.prefs).map(x => ({id: x.id, label: penName(x), value: x.id, icon: x.icon, accent: dark(x.color) ? '#d6d6dc' : x.color, selected: t?.penId === x.id, iconOnly: true}))};
      },
      run(ctx, p) {
        const pen = findPen(ctx.prefs, p.penId ?? p.value ?? need(false, 'invalid_params', 'Choose a pen', {path: '/penId'}));
        ctx.setView({ink: penTool(pen), lastPen: pen.id, insertSpace: false});
        return {pen: pen.id, type: pen.type, color: pen.color, width: pen.width};
      },
    },
    {
      id: 'ink.addPen', label: 'Add Pen', risk: 'edit', effect: 'prefs', undo: 'none',
      description: 'Add a pen, a pencil or a highlighter to the tray (its usual colour and width) and pick it; Color & Thickness changes it.',
      params: s.object({type: s.enum(['pen', 'pencil', 'highlighter'])}),
      state: pageState,
      run(ctx, p) {
        const pen = newPen(p.type, `pen${ctx.host.uid()}`);
        ctx.updatePrefs({[PENS_PREF]: [...pensOf(ctx.prefs).map(({icon, ...x}) => x), pen].map(({icon, ...x}) => x)});
        ctx.setView({ink: penTool(pen), lastPen: pen.id, insertSpace: false});
        return {pen: pen.id, type: pen.type};
      },
    },
    {
      id: 'ink.removePen', label: 'Remove Pen', risk: 'edit', effect: 'prefs', undo: 'none',
      description: 'Take a pen out of the tray (the selected one by default); at least one pen stays.',
      params: s.object({penId: s.optional(s.string({min: 1, max: 80}))}),
      state(ctx) {
        const r = pageState(ctx);
        if (!r.enabled) return r;
        const t = tool(ctx);
        if (!t?.penId) return {enabled: false, reason: 'Pick a pen first'};
        return pensOf(ctx.prefs).length > 1 ? {enabled: true} : {enabled: false, reason: 'The last pen stays'};
      },
      run(ctx, p) {
        const id = p.penId ?? tool(ctx)?.penId;
        need(id, 'disabled', 'Pick a pen first');
        const pens = pensOf(ctx.prefs);
        const at = pens.findIndex(x => x.id === id);
        need(at >= 0, 'not_found', `No pen ${id}`, {path: '/penId'});
        need(pens.length > 1, 'disabled', 'The last pen stays');
        const rest = pens.filter(x => x.id !== id);
        ctx.updatePrefs({[PENS_PREF]: rest.map(({icon, ...x}) => x)});
        const next = rest[Math.min(at, rest.length - 1)];
        // The pen in hand goes with it: the next pen takes over.
        if (tool(ctx)?.penId === id) ctx.setView({ink: penTool(next), lastPen: next.id});
        return {removed: id, now: next.id};
      },
    },
    {
      id: 'ink.penSettings', label: 'Color & Thickness', risk: 'edit', effect: 'prefs', undo: 'none', dialog: 'dialog.pen-color-thickness',
      description: 'Change a pen (the selected one by default): its type (pen, pencil, highlighter), thickness in mm (0.25–8), colour (#RRGGBB) and ink (galaxy, rainbow or none).',
      params: s.object({
        penId: s.optional(s.string({min: 1, max: 80})), type: s.optional(s.enum(['pen', 'pencil', 'highlighter'])),
        thickness: s.optional(s.number({min: 0.25, max: 8, description: 'mm'})), color: s.optional(colorParam), fx: s.optional(s.nullable(s.enum(['galaxy', 'rainbow']))),
      }),
      state(ctx) {
        const r = pageState(ctx);
        if (!r.enabled) return r;
        return tool(ctx)?.penId ? {enabled: true} : {enabled: false, reason: 'Pick a pen first'};
      },
      run(ctx, p) {
        const id = p.penId ?? tool(ctx)?.penId;
        need(id, 'disabled', 'Pick a pen first');
        const pens = pensOf(ctx.prefs);
        const at = pens.findIndex(x => x.id === id);
        need(at >= 0, 'not_found', `No pen ${id}`, {path: '/penId'});
        const cur = pens[at];
        const type = p.type ?? cur.type;
        const next = {...cur, type, color: (p.color ?? cur.color).toLowerCase(), width: p.thickness !== undefined ? Math.round(p.thickness * MM * 100) / 100 : cur.width,
          fx: p.fx === undefined ? cur.fx ?? null : p.fx};
        next.name = undefined;
        next.name = penName(next);
        const list = pens.map(x => (x.id === id ? next : x));
        ctx.updatePrefs({[PENS_PREF]: list.map(({icon, ...x}) => x)});
        if (tool(ctx)?.penId === id) ctx.setView({ink: penTool(next)});
        return {pen: id, type, color: next.color, width: next.width, fx: next.fx};
      },
    },
    {
      id: 'ink.ruler', label: 'Ruler', risk: 'read', effect: 'view',
      description: 'Show or hide the ruler on the page: drag it to place it, turn it with the wheel; a stroke begun along its edge runs straight along it.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const r = pageState(ctx); return r.enabled ? {enabled: true, checked: view(ctx).ruler === true} : r; },
      run(ctx, p) { const on = p.value ?? view(ctx).ruler !== true; ctx.setView({ruler: on}); return {value: on}; },
    },
    {
      id: 'ink.drawWithTouch', label: 'Draw with Touch', risk: 'read', effect: 'view',
      description: 'On (the default), a finger draws like the pen and the mouse; off, a finger scrolls the page and only the pen and mouse draw.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const r = pageState(ctx); return r.enabled ? {enabled: true, checked: view(ctx).touchDraw !== false} : r; },
      run(ctx, p) { const on = p.value ?? view(ctx).touchDraw === false; ctx.setView({touchDraw: on}); return {value: on}; },
    },

    // --- Strokes: erase, select, move ---------------------------------------------------------------
    {
      id: 'ink.erase', label: 'Eraser', risk: 'edit',
      description: 'Erase along a path (page px, x y pairs): mode stroke removes every stroke the path touches; mode point rubs out the parts within the radius of it (a stroke cut in the middle becomes two).',
      params: s.object({path: flat, radius: s.optional(s.number({min: 0.5, max: 200})), mode: s.optional(s.enum(['stroke', 'point'])), page: pageParam}),
      state: pageState,
      run(ctx, p) {
        const pageId = pageOf(ctx, p.page);
        const r = p.radius ?? ERASER_SIZES.medium;
        const ink = ctx.doc.pages[pageId].ink;
        if ((p.mode ?? 'stroke') === 'stroke') {
          const hit = new Set();
          for (let i = 0; i + 1 < p.path.length; i += 2) for (const st of ink) if (!hit.has(st.id) && strokeNear(st, p.path[i], p.path[i + 1], r)) hit.add(st.id);
          // A shape is one object: touching one of its strokes takes all of them.
          const all = new Set(withGroups(ink, [...hit]));
          if (!all.size) return {erased: 0};
          setInk(ctx, pageId, ink.filter(x => !all.has(x.id)));
          return {erased: all.size};
        }
        const {ink: next, changed} = erasePoints(ink, p.path, r, () => newStrokeId(ctx));
        if (!changed) return {erased: 0};
        setInk(ctx, pageId, next);
        return {erased: changed, strokes: next.length};
      },
    },
    {
      id: 'ink.select', label: 'Select Ink', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Select strokes by id (a shape\'s strokes come together), or every stroke on the page with all.',
      params: s.object({ids: s.optional(s.array(s.string({min: 1, max: 80}), {min: 1, max: 20000})), all: s.optional(s.boolean()), page: pageParam}),
      state: pageState,
      run(ctx, p) {
        const pageId = pageOf(ctx, p.page);
        const ink = ctx.doc.pages[pageId].ink;
        const want = p.all ? ink.map(x => x.id) : p.ids ?? [];
        for (const id of want) need(ink.some(x => x.id === id), 'not_found', `No stroke ${id}`, {address: `/pg:${pageId}/ink:${id}`});
        const ids = withGroups(ink, want);
        need(ids.length, 'invalid_params', 'Give the strokes to select (ids) or all');
        ctx.setSelection(inkSelection(pageId, ids));
        return {selected: ids.length};
      },
    },
    {
      id: 'ink.lasso', label: 'Lasso Select', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Select the strokes a loop drawn with the Lasso goes round (path: page px, x y pairs; a stroke is taken when half of it is inside); nothing inside selects the page.',
      params: s.object({path: flat, page: pageParam}),
      state: pageState,
      run(ctx, p) {
        const pageId = pageOf(ctx, p.page);
        const ink = ctx.doc.pages[pageId].ink;
        const ids = withGroups(ink, lassoHits(ink, p.path));
        ctx.setSelection(ids.length ? inkSelection(pageId, ids) : selectPage(pageId));
        return {selected: ids.length};
      },
    },
    {
      id: 'ink.move', label: 'Move', risk: 'edit',
      description: 'Move the selected strokes (or the given ids) by dx, dy px; the page\'s top and left edges stop them.',
      params: s.object({dx: s.number({min: -100000, max: 100000}), dy: s.number({min: -100000, max: 100000}), ids: s.optional(s.array(s.string({min: 1, max: 80}), {min: 1, max: 20000})), page: pageParam}),
      state: inkState,
      run(ctx, p) {
        const sel = p.ids ? byIds(ctx, pageOf(ctx, p.page), p.ids) : needInk(ctx);
        const next = moved(sel.strokes, p.dx, p.dy);
        replaceStrokes(ctx, sel.pageId, next);
        return {moved: next.length};
      },
    },

    // --- Shapes -----------------------------------------------------------------------------------
    {
      id: 'shape.insert', label: 'Shapes', risk: 'edit',
      description: 'Pick a shape to draw by dragging on the page, or draw one now from (x, y) to (x2, y2) in the current pen: lines and arrows run between the points, other shapes fill the rectangle they span.',
      params: s.object({
        shape: s.optional(s.enum(SHAPES)), value: s.optional(s.enum(SHAPES)),
        x: s.optional(s.number({min: 0, max: 50000})), y: s.optional(s.number({min: 0, max: 500000})),
        x2: s.optional(s.number({min: 0, max: 50000})), y2: s.optional(s.number({min: 0, max: 500000})), page: pageParam,
      }),
      state(ctx, p) {
        const r = pageState(ctx);
        if (!r.enabled) return r;
        const t = tool(ctx);
        const name = p?.shape ?? p?.value;
        if (name) return {enabled: true, checked: t?.tool === 'shape' && t.shape === name};
        return {enabled: true, value: SHAPES.map(n => ({id: n, label: SHAPE_LABELS[n], value: n, icon: `shape-${n}`, selected: t?.tool === 'shape' && t.shape === n, iconOnly: true}))};
      },
      run(ctx, p) {
        const name = p.shape ?? p.value;
        need(name, 'invalid_params', 'Choose a shape', {path: '/shape'});
        if (p.x2 === undefined || p.y2 === undefined) {
          // The tool: the page draws this shape in the current pen by dragging.
          const pen = activePen(ctx);
          ctx.setView({ink: {tool: 'shape', shape: name, color: pen.color, width: pen.width, ...(pen.fx ? {fx: pen.fx} : {}), ...(pen.penId ? {penId: pen.penId} : {}), pen: pen.tool}, insertSpace: false});
          return {tool: 'shape', shape: name};
        }
        need(p.x !== undefined && p.y !== undefined, 'invalid_params', 'A shape needs x, y and x2, y2', {path: '/x'});
        const pageId = pageOf(ctx, p.page);
        const pen = activePen(ctx);
        const strokes = shapeStrokes(ctx, name, {x: p.x, y: p.y}, {x: p.x2, y: p.y2}, pen);
        const ids = addStrokes(ctx, pageId, strokes);
        ctx.setSelection(inkSelection(pageId, ids));
        // One shape, then back to typing, unless Lock Drawing Mode keeps the tool.
        if (tool(ctx)?.tool === 'shape' && view(ctx).lockDrawing !== true) ctx.setView({ink: null});
        return {shape: name, strokes: ids.length, group: strokes[0].group};
      },
    },
    {
      id: 'shape.lockDrawing', label: 'Lock Drawing Mode', risk: 'read', effect: 'view',
      description: 'Keep the shape tool on after a shape is drawn, to draw another.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const r = pageState(ctx); return r.enabled ? {enabled: true, checked: view(ctx).lockDrawing === true} : r; },
      run(ctx, p) { const on = p.value ?? view(ctx).lockDrawing !== true; ctx.setView({lockDrawing: on}); return {value: on}; },
    },

    // --- Edit -------------------------------------------------------------------------------------
    {
      id: 'edit.delete', label: 'Delete', risk: 'edit',
      description: 'Delete the selection: selected ink (with its shape), a selected note container or object, the selected text, or the character after the caret.',
      params: s.object({}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return {enabled: true};
      },
      run(ctx) {
        const ink = selectedInk(ctx);
        if (ink) {
          const all = new Set(withGroups(ctx.doc.pages[ink.pageId].ink, ink.ids));
          setInk(ctx, ink.pageId, ctx.doc.pages[ink.pageId].ink.filter(x => !all.has(x.id)));
          ctx.setSelection(selectPage(ink.pageId));
          return {deleted: 'ink', count: all.size};
        }
        const c = selectedContainer(ctx);
        if (c) { deleteContainer(ctx, c.pageId, c.id); ctx.setSelection(selectPage(c.pageId)); return {deleted: 'container'}; }
        const range = textRange(ctx);
        need(range, 'disabled', 'Nothing is selected to delete');
        if (range.from !== range.to) {
          if (range.kind === 'text') {
            const ok = runPmCommand(ctx, range, (state, dispatch) => { dispatch?.(state.tr.deleteSelection()); return true; });
            return {deleted: 'text', changed: ok};
          }
          editPage(ctx, range.pageId, tr => tr.delete(range.from, range.to), range.doc);
          return {deleted: range.kind};
        }
        // A caret: the character after it, or the paragraph below joins this one.
        const $p = range.doc.resolve(range.from);
        if ($p.parent.isTextblock && $p.parentOffset < $p.parent.content.size) {
          const text = $p.parent.textBetween($p.parentOffset, Math.min($p.parent.content.size, $p.parentOffset + 2), undefined, '￼');
          const len = /^[\ud800-\udbff][\udc00-\udfff]/.test(text) ? 2 : 1;
          editPage(ctx, range.pageId, tr => tr.delete(range.from, range.from + len), range.doc);
          return {deleted: 'character'};
        }
        const joined = runPmCommand(ctx, range, joinForward);
        return {deleted: joined ? 'break' : 'nothing'};
      },
    },
    {
      id: 'object.order', label: 'Arrange', risk: 'edit',
      description: 'Change the stacking of the selected ink or note container: forward or backward one step, to the front or to the back.',
      params: s.object({to: s.enum(['forward', 'front', 'backward', 'back'])}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return selectedInk(ctx) || selectedContainer(ctx) ? {enabled: true} : {enabled: false, reason: 'Select ink, a shape or a note container first'};
      },
      run(ctx, p) {
        const sel = selectedInk(ctx);
        if (sel) {
          const ink = ctx.doc.pages[sel.pageId].ink;
          const want = new Set(withGroups(ink, sel.ids));
          const next = reorder(ink, x => want.has(x.id), p.to);
          setInk(ctx, sel.pageId, next);
          return {ordered: 'ink', to: p.to, changed: next.some((x, i) => x !== ink[i])};
        }
        const c = selectedContainer(ctx);
        need(c, 'disabled', 'Select ink, a shape or a note container first');
        const doc = pageDoc(ctx, c.pageId);
        const list = containersOf(doc);
        const order = reorder(list, x => x.id === c.id, p.to);
        if (!order.some((x, i) => x !== list[i])) return {ordered: 'container', to: p.to, changed: false};
        const tr = new Transform(doc);
        tr.replaceWith(0, doc.content.size, Fragment.from(order.map(x => x.node)));
        ensureIds(ctx, tr);
        applySteps(ctx, c.pageId, tr.steps.map(st => st.toJSON()));
        return {ordered: 'container', to: p.to, changed: true};
      },
    },
    {
      id: 'object.rotate', label: 'Rotate', risk: 'edit',
      description: 'Turn the selected ink or shape clockwise by degrees (90 or -90 on the Rotate menu) around the middle of its bounds.',
      params: s.object({degrees: s.number({min: -360, max: 360})}),
      state: inkState,
      run(ctx, p) {
        const sel = needInk(ctx);
        const group = new Set(withGroups(ctx.doc.pages[sel.pageId].ink, sel.ids));
        const strokes = ctx.doc.pages[sel.pageId].ink.filter(x => group.has(x.id));
        replaceStrokes(ctx, sel.pageId, rotated(strokes, p.degrees));
        return {rotated: strokes.length, degrees: p.degrees};
      },
    },
    {
      id: 'object.flip', label: 'Flip', risk: 'edit',
      description: 'Mirror the selected ink or shape left to right (horizontal) or top to bottom (vertical).',
      params: s.object({axis: s.enum(['horizontal', 'vertical'])}),
      state: inkState,
      run(ctx, p) {
        const sel = needInk(ctx);
        const group = new Set(withGroups(ctx.doc.pages[sel.pageId].ink, sel.ids));
        const strokes = ctx.doc.pages[sel.pageId].ink.filter(x => group.has(x.id));
        replaceStrokes(ctx, sel.pageId, flipped(strokes, p.axis));
        return {flipped: strokes.length, axis: p.axis};
      },
    },

    // --- Convert ----------------------------------------------------------------------------------
    {
      id: 'ink.toShape', label: 'Ink to Shape', risk: 'read', effect: 'view',
      description: 'Turn Ink to Shape on or off: while on, a line, triangle, rectangle, diamond or oval drawn by hand becomes the exact shape, in the same pen.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const r = pageState(ctx); return r.enabled ? {enabled: true, checked: view(ctx).inkToShape === true} : r; },
      run(ctx, p) { const on = p.value ?? view(ctx).inkToShape !== true; ctx.setView({inkToShape: on}); return {value: on}; },
    },
    {
      id: 'ink.replay', label: 'Ink Replay', risk: 'read', effect: 'view',
      description: 'Play the selected strokes (or the given ids, or the whole page) again, one after the other in the order they were drawn.',
      params: s.object({strokeIds: s.optional(s.array(s.string({min: 1, max: 80}), {min: 1, max: 20000})), page: pageParam}),
      state(ctx) {
        const r = pageState(ctx);
        if (!r.enabled) return r;
        const pageId = pageOf(ctx, undefined);
        return ctx.doc.pages[pageId].ink.length ? {enabled: true} : {enabled: false, reason: 'There is no ink on this page'};
      },
      run(ctx, p) {
        const pageId = pageOf(ctx, p.page);
        const ink = ctx.doc.pages[pageId].ink;
        need(ink.length, 'disabled', 'There is no ink on this page');
        const sel = selectedInk(ctx);
        const ids = p.strokeIds ?? (sel && sel.pageId === pageId ? sel.ids : ink.map(x => x.id));
        for (const id of ids) need(ink.some(x => x.id === id), 'not_found', `No stroke ${id}`, {address: `/pg:${pageId}/ink:${id}`});
        // The page plays them in the order they were drawn (the order of the page's ink).
        const set = new Set(ids);
        const ordered = ink.filter(x => set.has(x.id)).map(x => x.id);
        ctx.setView({replay: {page: pageId, ids: ordered, run: (view(ctx).replay?.run ?? 0) + 1, at: iso(ctx)}});
        return {strokes: ordered.length};
      },
    },
  ],
});

// ---------------------------------------------------------------------------------------------

function strokeNear(st, x, y, r) {
  const reach = r + st.width / 2;
  const p = st.points;
  if (p.length === 2) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= reach * reach;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1];
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / len)) : 0;
    const cx = p[i] + t * dx - x, cy = p[i + 1] + t * dy - y;
    if (cx * cx + cy * cy <= reach * reach) return true;
  }
  return false;
}

/** Selected strokes with their shapes' other strokes, or a `disabled` error. */
function needInk(ctx) {
  const sel = selectedInk(ctx);
  if (!sel) throw new CommandError('disabled', 'Select ink or a shape with the Lasso first');
  const ink = ctx.doc.pages[sel.pageId].ink;
  const all = new Set(withGroups(ink, sel.ids));
  return {pageId: sel.pageId, ids: [...all], strokes: ink.filter(x => all.has(x.id))};
}

function byIds(ctx, pageId, ids) {
  const ink = ctx.doc.pages[pageId].ink;
  for (const id of ids) need(ink.some(x => x.id === id), 'not_found', `No stroke ${id}`, {address: `/pg:${pageId}/ink:${id}`});
  const all = new Set(withGroups(ink, ids));
  return {pageId, ids: [...all], strokes: ink.filter(x => all.has(x.id))};
}

/** Replace strokes (same ids) in place, keeping their order. */
function replaceStrokes(ctx, pageId, strokes) {
  const by = new Map(clean(strokes).map(x => [x.id, x]));
  setInk(ctx, pageId, ctx.doc.pages[pageId].ink.map(x => by.get(x.id) ?? x));
}

/** The selected note container (a `/pg:<page>/c:<id>` selection), or null. */
function selectedContainer(ctx) {
  const r = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  const m = /^\/pg:([^/]+)\/c:([^/]+)$/.exec(r?.anchor ?? '');
  if (!m || !isNotebook(ctx.doc)) return null;
  const pageId = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
  const page = ctx.doc.pages[pageId];
  if (!page || !containersOf(nodeOf(page.body)).some(c => c.id === id)) return null;
  return {pageId, id};
}

/** Move the picked items one step or to an end of a list, keeping the others' order. */
function reorder(list, picked, to) {
  const out = list.slice();
  if (to === 'front' || to === 'back') {
    const sel = out.filter(picked), rest = out.filter(x => !picked(x));
    return to === 'front' ? [...rest, ...sel] : [...sel, ...rest];
  }
  if (to === 'forward') { for (let i = out.length - 2; i >= 0; i--) if (picked(out[i]) && !picked(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]]; }
  else for (let i = 1; i < out.length; i++) if (picked(out[i]) && !picked(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
  return out;
}

