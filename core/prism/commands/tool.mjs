// The pointer tools the ribbon arms: Select, Draw Shape (a Shapes-gallery preset, or the curve,
// freeform and scribble tools), the Draw tab's pens, highlighter and eraser, and Insert › Table ›
// Draw Table's pencil and Table Design's eraser. Each writes the session view state the pointer
// reads (`view.tool`, design note F-prism--tool--view-state-contract); nothing is undoable.
// Translated from deckcraft crates/engine/src/tools.rs (`ToolKind`, `Session::set_tool`,
// `FREEFORM_TOOLS`, `DRAW_TABLE`, `TABLE_ERASER`) and the ribbon code that arms them,
// crates/ui-egui/src/ribbon/{galleries.rs shapes_gallery, home.rs, insert.rs, shape_format.rs,
// draw.rs, table.rs} at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// tool.transparentColor and tool.eyedropper (crates/ui-egui/src/eyedropper.rs) pick a colour from
// the rendered slide under the pointer; the slide surface has no pixel picking yet, so they are
// not registered and their controls stay hidden (design note U-prism-tool--U-prism-file--color-at).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasDoc} from '../lib/shape-common.mjs';
import {info as presetInfo, CATALOG, categoryLabel} from '../model/geom/preset/catalog.mjs';
import {build as buildPreset} from '../model/geom/preset/index.mjs';
import {fromHex} from '../model/color.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/tools.rs', 'crates/ui-egui/src/ribbon/draw.rs',
  'crates/ui-egui/src/ribbon/galleries.rs', 'crates/ui-egui/src/ribbon/table.rs']};

/** Shape-gallery names that draw a freeform path instead of a preset. */
export const FREEFORM_TOOLS = Object.freeze([['curve', 'Curve'], ['freeform', 'Freeform: Shape'], ['scribble', 'Freeform: Scribble']]);
export const DRAW_TABLE = 'drawTable';
export const TABLE_ERASER = 'tableEraser';

const current = ctx => ctx.view?.tool ?? {kind: 'select'};
const setTool = (ctx, tool) => { ctx.setView({tool, toolDrag: null}); return {tool}; };
/** Armed with the same tool already: the ribbon button toggles it off (Table Design's Draw Table / Eraser). */
const isShapeTool = (t, preset) => t?.kind === 'shape' && t.preset === preset;

function rgbaParam(v) {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return fromHex(v) ?? null;
  if (v && typeof v === 'object' && ['r', 'g', 'b'].every(k => Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= 255)) {
    return {r: v.r, g: v.g, b: v.b, a: Number.isInteger(v.a) && v.a >= 0 && v.a <= 255 ? v.a : 255};
  }
  return null;
}
const sameColor = (a, b) => !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && (a.a ?? 255) === (b.a ?? 255);

const f1 = v => Math.round(v * 10) / 10;
/** SVG path data of a preset's outline in a 20×20 tile (the gallery draws it, as deckcraft `paint_preset`). */
export function presetTilePath(name) {
  let g;
  try { g = buildPreset(name, 20, 20, []); } catch { return null; }
  if (!g) return null;
  const out = [];
  for (const sp of g.paths ?? []) {
    for (const e of sp.path ?? []) {
      if (e.t === 'M' || e.t === 'L') out.push(`${e.t}${f1(e.p.x)} ${f1(e.p.y)}`);
      else if (e.t === 'C') out.push(`C${f1(e.p1.x)} ${f1(e.p1.y)} ${f1(e.p2.x)} ${f1(e.p2.y)} ${f1(e.p.x)} ${f1(e.p.y)}`);
      else if (e.t === 'Q') out.push(`Q${f1(e.p1.x)} ${f1(e.p1.y)} ${f1(e.p.x)} ${f1(e.p.y)}`);
      else if (e.t === 'Z') out.push('Z');
    }
  }
  return out.join(' ') || null;
}
let SHAPES_GALLERY = null;
/** deckcraft `shapes_gallery`: every preset by category, the freeform tools after the lines. */
export function shapesGallery() {
  if (SHAPES_GALLERY) return SHAPES_GALLERY;
  const out = [];
  for (const i of CATALOG) {
    out.push({id: i.name, label: i.label, value: i.name, group: categoryLabel(i.category), path: presetTilePath(i.name)});
    if (i === CATALOG.filter(c => c.category === 'lines').at(-1)) {
      for (const [name, label] of FREEFORM_TOOLS) out.push({id: name, label, value: name, group: categoryLabel('lines'), path: null});
    }
  }
  SHAPES_GALLERY = Object.freeze(out);
  return SHAPES_GALLERY;
}

/** The Draw tab's pens (ribbon/draw.rs): label, mode, colour, width. */
export const PENS = Object.freeze([
  ['Black Pen', 'pen', {r: 20, g: 20, b: 20, a: 255}, 1.5],
  ['Red Pen', 'pen', {r: 0xd8, g: 0x3f, b: 0x3f, a: 255}, 1.5],
  ['Blue Pen', 'pen', {r: 0x2e, g: 0x6f, b: 0xd8, a: 255}, 1.5],
  ['Pencil', 'pen', {r: 90, g: 90, b: 90, a: 255}, 1],
  ['Highlighter', 'highlighter', {r: 255, g: 230, b: 0, a: 255}, 10],
]);

export default defineCommands({
  family: 'tool',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'tool.shape', label: 'Draw Shape', risk: 'read', effect: 'view',
      description: '{preset} (shape preset from the Shapes gallery, or curve|freeform|scribble); sticky?: bool keeps the tool after one use (double-click: lock drawing mode)',
      params: s.object({preset: s.string({min: 1, max: 64}), sticky: s.optional(s.boolean())}),
      state(ctx) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const t = current(ctx);
        return {enabled: true, checked: t.kind === 'shape' && t.preset !== DRAW_TABLE && t.preset !== TABLE_ERASER, value: shapesGallery()};
      },
      run(ctx, p) {
        const ok = presetInfo(p.preset) || FREEFORM_TOOLS.some(f => f[0] === p.preset);
        if (!ok) throw bad('tool.shape', `unknown preset \`${p.preset}\``);
        return setTool(ctx, {kind: 'shape', preset: p.preset, ...(p.sticky ? {sticky: true} : {})});
      }},
    {id: 'tool.drawTable', label: 'Draw Table', risk: 'read', effect: 'view', description: '{}', params: s.object({}),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? {enabled: true, checked: isShapeTool(current(ctx), DRAW_TABLE)} : st; },
      run: ctx => setTool(ctx, isShapeTool(current(ctx), DRAW_TABLE) ? {kind: 'select'} : {kind: 'shape', preset: DRAW_TABLE, sticky: true})},
    {id: 'tool.tableEraser', label: 'Table Eraser', risk: 'read', effect: 'view', description: '{}', params: s.object({}),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? {enabled: true, checked: isShapeTool(current(ctx), TABLE_ERASER)} : st; },
      run: ctx => setTool(ctx, isShapeTool(current(ctx), TABLE_ERASER) ? {kind: 'select'} : {kind: 'shape', preset: TABLE_ERASER, sticky: true})},
    {id: 'tool.lasso', label: 'Lasso Select', risk: 'read', effect: 'view', description: '{}: draw a loop to select the objects and ink inside it (PowerPoint\'s Draw > Lasso Select; not in deckcraft)', params: s.object({}),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? {enabled: true, checked: current(ctx).kind === 'lasso'} : st; },
      run: ctx => setTool(ctx, current(ctx).kind === 'lasso' ? {kind: 'select'} : {kind: 'lasso', sticky: true})},
    {id: 'tool.select', label: 'Select', risk: 'read', effect: 'view', description: '{}', params: s.object({}),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? {enabled: true, checked: current(ctx).kind === 'select'} : st; },
      run: ctx => setTool(ctx, {kind: 'select'})},
    {id: 'tool.ink', label: 'Ink Pen', risk: 'read', effect: 'view', description: '{mode: pen|highlighter|eraser, color, width}',
      params: s.object({mode: s.enum(['pen', 'highlighter', 'eraser']), color: s.optional(s.any({description: '#RRGGBB or {r, g, b, a}'})),
        width: s.optional(s.number({min: 0.1, max: 100}))}),
      state(ctx, p) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const t = current(ctx);
        const c = rgbaParam(p?.color);
        const on = t.kind === 'ink' && (!p?.mode || t.mode === p.mode) && (p?.mode === 'eraser' || !c || sameColor(t.color, c));
        return {enabled: true, checked: on};
      },
      run(ctx, p) {
        const c = rgbaParam(p.color);
        if (c === null) throw bad('tool.ink', '`color` must be #RRGGBB or {r, g, b, a}');
        const black = {r: 0, g: 0, b: 0, a: 255};
        return setTool(ctx, {kind: 'ink', mode: p.mode, color: c ?? black, width: p.width ?? (p.mode === 'highlighter' ? 10 : p.mode === 'eraser' ? 2 : 1.5)});
      }},
  ],
});
