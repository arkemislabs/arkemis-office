// Insert › Illustrations › SmartArt and the SmartArt Design tab: insert a graphic, edit its items (the Text Pane, Add Shape, Add Bullet,
// Promote, Demote, Move Up, Move Down), change its layout, colours and style, mirror it (Right to Left), reset it, size it.
//
// Translated from wordcraft crates/engine/src/cmd/smart_art.rs (`insert.smartArt`, `smartArt.items`, `smartArt.textPane`,
// `smartArt.addShape`, `smartArt.promote`, `smartArt.demote`, `smartArt.layout`, `smartArt.colors`, `smartArt.reset`, `edit`,
// `item_at`, `items_of`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// What Word adds (U:quill/smartart), reusing PowerPoint's engine (core/prism/lib/smartart.mjs, deckcraft smartart*) instead of
// translating upstream's eight layouts: all 45 layouts, the 17 Change Colors schemes, the nine SmartArt Styles, Add Shape Before /
// Above / Below / Assistant and the outline operations. Move Up, Move Down and Right to Left are Word's (not in either upstream:
// not checked against upstream).
//
// A SmartArt graphic is an inline `graphic` object whose `graphic.smartArt` is the model (core/quill/lib/smartart-word.mjs); the page
// view draws it (layout/floats.mjs) and a save writes it as Word's diagram parts (lib/docx-smartart.mjs, on core/prism/lib/dgm.mjs), which read back
// into the model; a diagram without a readable data part is kept whole (`opaque`) and these commands never see it.
// Not here (hidden): Layout (organization chart layouts), Convert to Text / Convert to Shapes (no engine in Word's upstream).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {selectedObjects} from '../context.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {
  LAYOUT_IDS, LAYOUTS, STYLES, COLORS, MAX_NODES, MAX_LEVEL, layoutFromId, colorsFromId, styleFromId, cleanSpec, newSpec, schemeOf, moveItem,
} from '../lib/smartart-word.mjs';
import {addNode, removeNode, promote, demote, thumb, sampleNodes, colorRef} from '../../prism/lib/smartart.mjs';
import {resolveColor} from '../../prism/model/style.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/smart_art.rs']};

/** A new graphic's size: 6 x 3.5 inches, points (narrower when the text column is). */
export const DEFAULT_W = 432;
export const DEFAULT_H = 252;

const bad = m => new CommandError('invalid_params', m);
const disabled = m => new CommandError('disabled', m);
const isSmart = o => o?.type === 'graphic' && !!o.graphic?.smartArt;
const POSITIONS = ['after', 'before', 'above', 'below', 'assistant'];
const ITEMS = '[string | {"text": string, "level"?: 0-8}] (a string\'s leading tabs are its level)';

/** The SmartArt graphic in the selection (or just before the caret): {pos, obj}, or null. */
function pick(S) {
  const [a, b] = T.ordered(S.sel);
  if (a.story !== b.story) return null;
  return selectedObjects(S.d.content, a, b, 1, isSmart)[0] ?? null;
}

function smartState(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  try { return pick(T.open(ctx)) ? {enabled: true} : {enabled: false, reason: 'select a SmartArt graphic first'}; } catch { return {enabled: false, reason: 'select a SmartArt graphic first'}; }
}
/** The selected graphic's model, or null (for galleries and checks). */
function modelOf(ctx) { try { return pick(T.open(ctx))?.obj.graphic.smartArt ?? null; } catch { return null; } }

/** The item the person is on in the Text Pane (smartArt.focus), clamped to the outline; the last item without one. */
const focusOf = (ctx, spec) => {
  const i = ctx.view?.smartArtItem;
  return Number.isInteger(i) && i >= 0 && i < spec.items.length ? i : spec.items.length - 1;
};

/** Change the selected graphic's model with `f(spec, S)` (edits the copy it is given), as one undo step. */
function edit(ctx, f, extra = () => ({})) {
  const S = T.open(ctx);
  const hit = pick(S);
  if (!hit) throw disabled('select a SmartArt graphic first');
  const spec = structuredClone(hit.obj.graphic.smartArt);
  const out = f(spec, S);
  const next = cleanSpec(out ?? spec);
  const para = S.d.paraMut(hit.pos.story, hit.pos.path);
  P.setObjectAt(para, hit.pos.off, {...hit.obj, graphic: {...hit.obj.graphic, kind: 'diagram', smartArt: next}});
  return T.finish(S, {smartArt: next, ...extra(next)});
}

function itemsOf(v) {
  if (!Array.isArray(v)) throw bad(`\`items\`: ${ITEMS}`);
  const items = v.slice(0, MAX_NODES).map(it => {
    if (typeof it === 'string') { const tabs = /^\t*/.exec(it)[0].length; return {text: it.slice(tabs), level: Math.min(tabs, MAX_LEVEL)}; }
    if (it && typeof it === 'object') return {text: typeof it.text === 'string' ? it.text : it.text === undefined || it.text === null ? '' : String(it.text), level: Math.max(0, Math.min(MAX_LEVEL, Math.trunc(Number(it.level) || 0))),
      ...(it.assistant ? {assistant: true} : {}), ...(typeof it.title === 'string' ? {title: it.title} : {})};
    throw bad(`\`items\`: ${ITEMS}`);
  });
  if (!items.length) throw bad('`items` needs at least one item');
  return items;
}

function insertSmartArt(ctx, p) {
  const layout = p.layout === undefined || p.layout === null ? 'blockList' : layoutFromId(p.layout);
  if (!layout) throw bad(`unknown layout \`${p.layout}\`: ${LAYOUT_IDS.join('|')}`);
  const over = {};
  if (p.colors !== undefined) { over.colors = colorsFromId(p.colors); if (!over.colors) throw bad(`unknown colours \`${p.colors}\``); }
  if (p.style !== undefined) { over.style = styleFromId(p.style); if (!over.style) throw bad(`unknown style \`${p.style}\``); }
  const spec = newSpec(layout, over);
  if (p.items !== undefined && p.items !== null) spec.items = cleanSpec({...spec, items: itemsOf(p.items)}).items;
  const S = T.open(ctx);
  // Fitted to the text width, as a new graphic is.
  const maxW = Math.max(T.firstTextWidth(S), 36);
  const w = Math.min(Math.max(36, Math.min(2000, p.width ?? DEFAULT_W)), maxW);
  const h = Math.max(36, Math.min(2000, p.height ?? DEFAULT_H));
  const obj = {type: 'graphic', w, h, alt: '', float: P.defaultFloat(), graphic: {kind: 'diagram', items: [], w, h, smartArt: spec}};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, obj, props);
  S.sel = {anchor: T.clonePos(at), focus: end};
  S.cells = null;
  return T.finish(S, {smartArt: spec, width: w, height: h});
}

/** Add Shape (and Add Bullet): a new item after, before, above or below item `index`, or an assistant. */
function addShape(spec, ctx, p) {
  if (spec.items.length >= MAX_NODES) throw new CommandError('failed', `a SmartArt graphic holds at most ${MAX_NODES} items`);
  const position = p.position ?? (p.below ? 'below' : p.before !== undefined ? 'before' : 'after');
  const at = p.index ?? p.after ?? p.before ?? focusOf(ctx, spec);
  if (at >= spec.items.length) throw bad(`no item ${at}: the graphic has ${spec.items.length} items`);
  const out = addNode(spec.items, at, position, typeof p.text === 'string' ? p.text : '');
  spec.items = out.items ?? out.nodes;
  return out.index;
}

/** The index an item command works on: `index`, else the item the Text Pane is on, else the last. */
function indexOf(ctx, spec, p) {
  const i = p.index ?? focusOf(ctx, spec);
  if (!Number.isInteger(i) || i < 0 || i >= spec.items.length) throw bad(`no item ${i}: the graphic has ${spec.items.length} items`);
  return i;
}

/** A tile of a layout: the sample outline drawn small, in the graphic's colours and style. A layout drawn only in pale tints (the picture and text layouts) would be a blank white tile: its shapes take the accent itself. */
const layoutArt = (k, spec) => {
  const items = thumb(k, sampleNodes(k), spec.colors, spec.style);
  const solid = items.filter(i => i.fill && !i.pale).length;
  return {kind: 'diagram', items: solid < 2 ? items.map(i => (i.pale ? {...i, pale: false} : i)) : items};
};
const hexOf = c => `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
const NONE = s.object({});
const INDEX = s.object({index: s.optional(s.integer({min: 0}))});

function galleryState(list, current, art, spec, st, grouped = false) {
  // Layouts come under their category (List, Process, Cycle…), as Word's layout list names them.
  return {...st, value: list.map(([id, label, group]) => ({id, label, value: id, checked: current === id, selected: current === id, art: art(id, spec), ...(grouped && group ? {group} : {})}))};
}

export default defineCommands({
  family: 'smartart',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.smartArt', label: 'SmartArt', risk: 'edit', state: T.ready,
      description: `SmartArt (Insert › Illustrations): a SmartArt graphic at the caret (\`layout\` ${LAYOUT_IDS.join('|')}, default basicList's block list; \`items\` ${ITEMS}; \`colors\`; \`style\`; \`width\`, \`height\` in points); with no items, sample items for the layout.`,
      params: s.object({layout: s.optional(s.string({max: 40})), items: s.optional(s.array(s.any())), colors: s.optional(s.string({max: 24})), style: s.optional(s.string({max: 24})),
        width: s.optional(s.number()), height: s.optional(s.number())}),
      run: insertSmartArt},
    {id: 'smartArt.items', label: 'Edit Items', risk: 'edit', state: smartState,
      description: `Edit Items (SmartArt Design › Create Graphic): replace the outline. \`items\`: ${ITEMS}.`,
      params: s.object({items: s.array(s.any())}),
      run: (ctx, p) => { const items = itemsOf(p.items); return edit(ctx, c => { c.items = items; }); }},
    {id: 'smartArt.outline', label: 'SmartArt Outline', risk: 'read', state: smartState,
      description: 'The selected graphic\'s outline: {layout, items: [{text, level}], colors, style, active}.',
      params: NONE,
      run: ctx => {
        const S = T.open(ctx);
        const hit = pick(S);
        if (!hit) throw disabled('select a SmartArt graphic first');
        const m = hit.obj.graphic.smartArt;
        return {layout: m.layout, items: m.items, colors: m.colors, style: m.style ?? 'flat', rtl: !!m.rtl, active: focusOf(ctx, m)};
      }},
    {id: 'smartArt.textPane', label: 'Text Pane', risk: 'read', effect: 'view', state: ctx => { const st = smartState(ctx); return st.enabled ? {...st, checked: !!ctx.view?.smartArtPane} : st; },
      description: 'Text Pane (SmartArt Design › Create Graphic): shows or hides the pane where the graphic\'s items are typed; `value` sets it.',
      params: s.object({value: s.optional(s.boolean())}),
      run(ctx, p) { const on = p.value ?? !ctx.view?.smartArtPane; ctx.setView({smartArtPane: on}); return {value: on}; }},
    {id: 'smartArt.focus', label: 'Select Item', risk: 'read', effect: 'view', state: smartState,
      description: 'The item the Text Pane is on (Add Shape, Promote, Demote, Move Up and Move Down work on it).',
      params: s.object({index: s.integer({min: 0})}),
      run(ctx, p) { ctx.setView({smartArtItem: p.index}); return {index: p.index}; }},
    {id: 'smartArt.addShape', label: 'Add Shape', risk: 'edit', state: smartState,
      description: `Add Shape (SmartArt Design › Create Graphic): a new item \`position\` ${POSITIONS.join('|')} the item at \`index\` (default: the item the Text Pane is on, else the last); \`text\`. A new item below is a sub-item; an assistant is a sub-item of an organization chart.`,
      params: s.object({position: s.optional(s.enum(POSITIONS)), index: s.optional(s.integer({min: 0})), text: s.optional(s.string({max: 255})), below: s.optional(s.boolean()),
        after: s.optional(s.integer({min: 0})), before: s.optional(s.integer({min: 0}))}),
      run: (ctx, p) => {
        let at = 0;
        return edit(ctx, c => { at = addShape(c, ctx, p); ctx.setView({smartArtItem: at}); }, () => ({index: at}));
      }},
    {id: 'smartArt.removeItem', label: 'Remove Item', risk: 'edit', state: smartState,
      description: 'Remove the item at `index` (default: the item the Text Pane is on); its sub-items move up a level. The graphic keeps at least one item.',
      params: INDEX,
      run: (ctx, p) => edit(ctx, c => {
        const i = indexOf(ctx, c, p);
        if (c.items.length < 2) throw new CommandError('failed', 'a SmartArt graphic keeps at least one item');
        c.items = removeNode(c.items, i);
      })},
    {id: 'smartArt.promote', label: 'Promote', risk: 'edit', state: smartState,
      description: 'Promote (SmartArt Design › Create Graphic): the item at `index` (default: the Text Pane\'s) and the items under it move up a level.',
      params: INDEX,
      run: (ctx, p) => edit(ctx, c => {
        const out = promote(c.items, indexOf(ctx, c, p));
        if (!out) throw new CommandError('failed', 'this item is already at the top level');
        c.items = out;
      })},
    {id: 'smartArt.demote', label: 'Demote', risk: 'edit', state: smartState,
      description: 'Demote (SmartArt Design › Create Graphic): the item at `index` (default: the Text Pane\'s) and the items under it move down a level, under the item before it.',
      params: INDEX,
      run: (ctx, p) => edit(ctx, c => {
        const out = demote(c.items, indexOf(ctx, c, p));
        if (!out) throw new CommandError('failed', "this item can't go down a level (it needs an item before it at its level)");
        c.items = out;
      })},
    {id: 'smartArt.moveUp', label: 'Move Up', risk: 'edit', state: smartState,
      description: 'Move Up (SmartArt Design › Create Graphic): the item at `index` (default: the Text Pane\'s) with its sub-items goes above the item before it on its level.',
      params: INDEX,
      run: (ctx, p) => edit(ctx, c => {
        const out = moveItem(c.items, indexOf(ctx, c, p), -1);
        if (!out) throw new CommandError('failed', 'this item is first on its level');
        c.items = out.items;
        ctx.setView({smartArtItem: out.index});
      })},
    {id: 'smartArt.moveDown', label: 'Move Down', risk: 'edit', state: smartState,
      description: 'Move Down (SmartArt Design › Create Graphic): the item at `index` (default: the Text Pane\'s) with its sub-items goes below the item after it on its level.',
      params: INDEX,
      run: (ctx, p) => edit(ctx, c => {
        const out = moveItem(c.items, indexOf(ctx, c, p), 1);
        if (!out) throw new CommandError('failed', 'this item is last on its level');
        c.items = out.items;
        ctx.setView({smartArtItem: out.index});
      })},
    {id: 'smartArt.rtl', label: 'Right to Left', risk: 'edit',
      state: ctx => { const st = smartState(ctx); return st.enabled ? {...st, checked: !!modelOf(ctx)?.rtl} : st; },
      description: 'Right to Left (SmartArt Design › Create Graphic): the graphic mirrored; `value` sets it, no value switches.',
      params: s.object({value: s.optional(s.boolean())}),
      run: (ctx, p) => edit(ctx, c => { const on = p.value ?? !c.rtl; if (on) c.rtl = true; else delete c.rtl; })},
    {id: 'smartArt.layout', label: 'Change Layout', risk: 'edit',
      state: ctx => {
        const st = smartState(ctx);
        const m = st.enabled ? modelOf(ctx) : null;
        return m ? galleryState(LAYOUTS, m.layout, layoutArt, m, st, true) : st;
      },
      description: `Change Layout (SmartArt Design › Layouts): the graphic takes another \`layout\` (${LAYOUT_IDS.join('|')}); the items stay.`,
      params: s.object({layout: s.string({max: 40})}),
      run: (ctx, p) => { const layout = layoutFromId(p.layout); if (!layout) throw bad(`unknown layout \`${p.layout}\`: ${LAYOUT_IDS.join('|')}`); return edit(ctx, c => { c.layout = layout; }); }},
    {id: 'smartArt.colors', label: 'Change Colors', risk: 'edit',
      state: ctx => {
        const st = smartState(ctx);
        const m = st.enabled ? modelOf(ctx) : null;
        if (!m) return st;
        const scheme = schemeOf(ctx.doc?.settings?.themeColors);
        return galleryState(COLORS, m.colors, id => ({kind: 'colors', colors: [0, 1, 2, 3, 4, 5].map(i => hexOf(resolveColor(colorRef(id, i), scheme)))}), m, st);
      },
      description: `Change Colors (SmartArt Design › SmartArt Styles): \`colors\` (or \`variant\`) ${COLORS.map(c => c[0]).join('|')}.`,
      params: s.object({colors: s.optional(s.string({max: 24})), variant: s.optional(s.string({max: 24}))}),
      run: (ctx, p) => {
        const id = p.colors ?? p.variant;
        const colors = colorsFromId(id);
        if (!colors) throw bad(`unknown colours \`${id}\`: ${COLORS.map(c => c[0]).join('|')}`);
        return edit(ctx, c => { c.colors = colors; });
      }},
    {id: 'smartArt.style', label: 'SmartArt Styles', risk: 'edit',
      state: ctx => {
        const st = smartState(ctx);
        const m = st.enabled ? modelOf(ctx) : null;
        return m ? galleryState(STYLES, m.style ?? 'flat', (id, spec) => ({kind: 'diagram', style: id, items: thumb(spec.layout === 'basicList' ? 'blockList' : spec.layout, sampleNodes(spec.layout), spec.colors, id)}), m, st) : st;
      },
      description: `SmartArt Styles (SmartArt Design): \`style\` ${STYLES.map(x => x[0]).join('|')}.`,
      params: s.object({style: s.string({max: 24})}),
      run: (ctx, p) => { const style = styleFromId(p.style); if (!style) throw bad(`unknown style \`${p.style}\``); return edit(ctx, c => { c.style = style; }); }},
    {id: 'smartArt.reset', label: 'Reset Graphic', risk: 'edit', state: smartState,
      description: 'Reset Graphic (SmartArt Design › Reset): back to the default colours and style, not mirrored; the items and layout stay.',
      params: NONE,
      run: ctx => edit(ctx, c => { c.colors = 'accent1'; c.style = 'flat'; delete c.rtl; })},
    {id: 'smartArt.size', label: 'SmartArt Size', risk: 'edit',
      state: (ctx, p) => {
        const st = smartState(ctx);
        if (!st.enabled) return st;
        try { const o = pick(T.open(ctx)).obj; return {...st, value: Math.round((p?.width !== undefined ? o.w : o.h) * 100) / 100}; } catch { return st; }
      },
      description: "Size (SmartArt Design): the selected graphic's `width` and `height` in points (36 to 2000); the shapes are laid out again at the new size.",
      params: s.object({width: s.optional(s.number({min: 36, max: 2000})), height: s.optional(s.number({min: 36, max: 2000}))}),
      run: (ctx, p) => {
        if (p.width === undefined && p.height === undefined) throw bad('`width` or `height` is required');
        const S = T.open(ctx);
        const hit = pick(S);
        if (!hit) throw disabled('select a SmartArt graphic first');
        const w = p.width ?? hit.obj.w, h = p.height ?? hit.obj.h;
        P.setObjectAt(S.d.paraMut(hit.pos.story, hit.pos.path), hit.pos.off, {...hit.obj, w, h, graphic: {...hit.obj.graphic, w, h}});
        return T.finish(S, {width: w, height: h});
      }},
  ],
});
