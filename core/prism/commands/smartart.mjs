// SmartArt: Insert > SmartArt and the SmartArt Design tab (Add Shape, Promote, Demote, Layouts, Change Colors, SmartArt Styles, Picture, Convert,
// Text Pane), and Convert to SmartArt.
// Translated from deckcraft crates/engine/src/cmd/smartart.rs and smartart/edit.rs (`insert`, `nodes`, `set_nodes`, `add_node`,
// `remove_node`, `promote`, `demote`, `change_layout`, `change_colors`, `change_style`, `set_picture`, `from_text`, `to_text`,
// `to_shapes`) at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt. The shapes and the outline are core/prism/lib/smartart.mjs.
//
// The graphic is a group shape with `diagram` set; the Text Pane (src/apps/prism/panes/smartart.tsx) edits its nodes through
// smartArt.setNodes. A new graphic fills the slide's empty content placeholder (PowerPoint replaces it) or, with none, the area below the title
// (deckcraft puts it at a fixed place on the slide: not checked against upstream). Text typed straight into a diagram shape is read back into
// the nodes (deckcraft `sync_text`) before any command works on the graphic, and when it is saved; an imported graphic keeps its drawing until it is edited.
// Move Up / Move Down, Right to Left, the Layout drop-down (organization chart branches: Standard, Both, Left Hanging, Right Hanging) and Reset Graphic
// are not in deckcraft: not checked against upstream, done as PowerPoint does them.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {
  UPSTREAM_COMMIT, bad, hasSlide, rectParam, addShape, currentSlide, writeShape, newId, selectIds, mediaBytes, contentType, imageDimensions, addMedia,
} from '../lib/shape-common.mjs';
import {selectedShapes} from '../lib/format-text.mjs';
import {isSchema2, slideById, slidePath, xfrmOf, currentSlideId, selectedShapeIds} from '../model/doc.mjs';
import {findShape, shape as newShape} from '../model/presentation.mjs';
import {bodyEmpty, bodyText} from '../model/text.mjs';
import {resolveColor} from '../model/style.mjs';
import {
  LAYOUTS, LAYOUT_IDS, COLORS, STYLES, STYLE_IDS, MAX_NODES, MAX_LEVEL, defaultNodes, normalize, nodesFromLines, addNode, removeNode, promote, demote, build,
  layoutName, thumb, sampleNodes, colorRef, syncText, moveNode, BRANCHES, ORG_KINDS,
} from '../lib/smartart.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/smartart.rs', 'crates/engine/src/cmd/smartart/edit.rs', 'crates/engine/src/cmd/smartart/nodes.rs']};
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const NODES = s.optional(s.array(s.object({text: s.optional(s.string({max: 2000})), level: s.optional(s.integer({min: 0, max: MAX_LEVEL})), title: s.optional(s.string({max: 2000})),
  assistant: s.optional(s.boolean())}), {max: MAX_NODES}));

/** The SmartArt group the selection is, or is inside (a shape of the diagram selected on the slide). */
function diagramGroup(shapes, id, depth = 0) {
  for (const sh of shapes ?? []) {
    if (sh.diagram && (sh.id === id || findShape(sh.kind?.children, id))) return sh;
    if (sh.kind?.type === 'group' && depth < 16) { const g = diagramGroup(sh.kind.children, id, depth + 1); if (g) return g; }
  }
  return null;
}
/** The graphic with the text typed into its shapes read back into its nodes. */
const synced = sh => (sh?.diagram ? {...sh, diagram: {...sh.diagram, nodes: syncText(sh.diagram, sh.kind?.children)}} : sh);
const graphicOf = ctx => {
  if (!isSchema2(ctx.doc)) return null;
  const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
  for (const id of selectedShapeIds(ctx.doc, ctx.selection)) { const g = diagramGroup(sl?.shapes, id); if (g) return synced(g); }
  return null;
};
const onGraphic = ctx => (graphicOf(ctx) ? {enabled: true} : {enabled: false, reason: 'select a SmartArt graphic'});

/** The graphic a command works on: `id` (the group), else the selected one. */
function target(ctx, p, cmd) {
  const sl = currentSlide(ctx, cmd);
  const sh = p.id !== undefined ? synced(diagramGroup(slideById(ctx.doc, sl.id).shapes, String(p.id))) : graphicOf(ctx);
  if (!sh?.diagram) throw bad(cmd, p.id !== undefined ? 'that is not a SmartArt graphic' : 'select a SmartArt graphic');
  return {sl, sh};
}

/** Write the graphic back with new diagram data, its shapes drawn again inside its own rectangle. */
function redraw(ctx, sl, sh, diagram0, cmd) {
  const x = sh.xfrm ?? {x: 0, y: 0, w: 480, h: 270};
  // The shapes are drawn again, so what an imported graphic came with is kept only where the layout, style or colours are unchanged.
  const was = sh.diagram;
  const diagram = {...diagram0, imported: false};
  if (diagram.kind !== was.kind) { delete diagram.layoutId; delete diagram.layoutXml; }
  if (diagram.style !== was.style) delete diagram.styleXml;
  if (diagram.colors !== was.colors) delete diagram.colorsXml;
  const children = build(diagram, {x: x.x, y: x.y, w: Math.max(1, x.w), h: Math.max(1, x.h)}, () => newId(ctx, cmd));
  writeShape(ctx, sl.id, {...sh, diagram, kind: {...sh.kind, children, child: {x: x.x, y: x.y, w: x.w, h: x.h}}});
  selectIds(ctx, sl.id, [sh.id]);
}

/** Where a new graphic goes: an empty content placeholder (which it replaces), else the area below the title, else most of the slide. */
export function contentArea(ctx, cmd) {
  const sl = slideById(ctx.doc, currentSlide(ctx, cmd).id);
  const size = ctx.doc.slideSize ?? {width: 960, height: 540};
  const at = sh => { const x = xfrmOf(ctx.doc, sl.id, sh); return {x: x.x, y: x.y, w: x.w, h: x.h}; };
  const ph = sl.shapes.find(sh => sh.ph && ['obj', 'diagram'].includes(sh.ph.kind) && sh.kind?.type === 'shape' && (!sh.text || bodyEmpty(sh.text)));
  if (ph) return {rect: at(ph), placeholder: ph.id};
  const title = sl.shapes.find(sh => sh.ph && ['title', 'ctrTitle'].includes(sh.ph.kind));
  if (title) {
    const t = at(title);
    const h = Math.max(size.height * 0.3, size.height * 0.92 - (t.y + t.h + size.height * 0.03));
    const y = Math.min(t.y + t.h + size.height * 0.03, size.height * 0.92 - h);
    return {rect: {x: t.x, y, w: t.w, h}};
  }
  return {rect: {x: size.width * 0.1, y: size.height * 0.15, w: size.width * 0.8, h: size.height * 0.7}};
}

function insertSmartArt(ctx, p) {
  if (!LAYOUT_IDS.includes(p.kind)) throw bad('insert.smartArt', `unknown layout \`${p.kind}\``, {layouts: LAYOUT_IDS});
  let nodes = p.nodes ? normalize(p.nodes.map(n => ({...n, text: n.text ?? '', level: n.level ?? 0}))) : p.items ? nodesFromLines(p.items) : defaultNodes();
  if (!nodes.length) nodes = defaultNodes();
  const given = rectParam(p, 'rect');
  const area = given ? {rect: given} : contentArea(ctx, 'insert.smartArt');
  const r = area.rect;
  const diagram = {kind: p.kind, nodes, colors: 'colorful', style: 'flat'};
  const children = build(diagram, r, () => newId(ctx, 'insert.smartArt'));
  if (area.placeholder !== undefined) {
    const sl = slideById(ctx.doc, currentSlide(ctx, 'insert.smartArt').id);
    ctx.change.splice([...slidePath(ctx.doc, sl.id), 'shapes'], sl.shapes.findIndex(sh => sh.id === area.placeholder), 1);
  }
  const id = addShape(ctx, 'insert.smartArt', newShape({xfrm: r, name: layoutName(p.kind), kind: {type: 'group', children, child: {...r}}, diagram}), true);
  return {id};
}

const nodesOf = (ctx, p) => { const {sh} = target(ctx, p, 'smartArt.nodes'); return {id: sh.id, kind: sh.diagram.kind, nodes: sh.diagram.nodes}; };

function setNodes(ctx, p) {
  const cmd = 'smartArt.setNodes';
  const {sl, sh} = target(ctx, p, cmd);
  let nodes;
  if (p.nodes) nodes = normalize(p.nodes.map(n => ({...n, text: n.text ?? '', level: n.level ?? 0})));
  else if (p.lines) nodes = nodesFromLines(p.lines);
  else if (p.index !== undefined && (typeof p.text === 'string' || typeof p.title === 'string')) {
    if (p.index < 0 || p.index >= sh.diagram.nodes.length) throw bad(cmd, `there is no node ${p.index}`);
    nodes = sh.diagram.nodes.map((n, i) => (i === p.index ? {...n, ...(typeof p.text === 'string' ? {text: p.text} : {}), ...(typeof p.title === 'string' ? {title: p.title} : {})} : n));
  } else throw bad(cmd, 'give `nodes`, `lines`, or `index` with `text` or `title`');
  if (nodes.length > MAX_NODES) throw bad(cmd, `a graphic holds at most ${MAX_NODES} nodes`);
  if (!nodes.length) nodes = [{text: '', level: 0}];
  redraw(ctx, sl, sh, {...sh.diagram, nodes}, cmd);
  return {nodes: nodes.length};
}

function edit(cmd, f) {
  return (ctx, p) => {
    const {sl, sh} = target(ctx, p, cmd);
    const index = p.index ?? sh.diagram.nodes.length - 1;
    const out = f(sh.diagram.nodes, {...p, index});
    if (!out) throw bad(cmd, 'not possible for that node');
    const nodes = out.nodes ?? out;
    if (nodes.length > MAX_NODES) throw bad(cmd, `a graphic holds at most ${MAX_NODES} nodes`);
    redraw(ctx, sl, sh, {...sh.diagram, nodes}, cmd);
    return {index: out.index ?? index, nodes: nodes.length};
  };
}

function setField(cmd, field, valid, label) {
  return (ctx, p) => {
    if (!valid.includes(p[field])) throw bad(cmd, `unknown ${label} \`${p[field]}\``);
    const {sl, sh} = target(ctx, p, cmd);
    redraw(ctx, sl, sh, {...sh.diagram, [field === 'kind' ? 'kind' : field]: p[field]}, cmd);
    return {};
  };
}

/** A node's picture: the picture placeholder of the layouts that have one; a sub-point's picture is its top-level node's. */
async function picture(ctx, pIn) {
  const cmd = 'smartArt.picture';
  let p = pIn;
  const {sl, sh} = target(ctx, p, cmd);
  const nodes = sh.diagram.nodes;
  const i = p.index ?? 0;
  if (i < 0 || i >= nodes.length) throw bad(cmd, 'no such node');
  let media = null;
  if (!p.reset) {
    if (p.path === undefined && p.data === undefined && ctx.origin !== 'bridge' && typeof ctx.host?.pickImage === 'function') {
      const url = await ctx.host.pickImage();
      if (!url) return {canceled: true};
      p = {...p, data: String(url), name: p.name ?? 'Picture'};
    }
    const {name, bytes} = await mediaBytes(ctx, p, cmd);
    const ct = contentType(name, bytes);
    if (!ct.startsWith('image/')) throw bad(cmd, `${name} is not a picture`);
    if (ct !== 'image/svg+xml' && ct !== 'image/tiff' && !imageDimensions(bytes)) throw new CommandError('failed', `${name}: the picture can't be read`);
    media = addMedia(ctx, cmd, name, ct, bytes);
  }
  let top = i;
  while (top > 0 && nodes[top].level !== 0) top -= 1;
  const next = nodes.map((n, k) => {
    if (k !== top) return n;
    const {picture: _old, ...rest} = n;
    return media ? {...rest, picture: media} : rest;
  });
  redraw(ctx, sl, sh, {...sh.diagram, nodes: next}, cmd);
  return {};
}

/** Convert to SmartArt: the selected text shape's paragraphs become the nodes of a new graphic in the shape's place. */
function fromText(ctx, p) {
  const cmd = 'smartArt.fromText';
  const kind = LAYOUT_IDS.includes(p.kind) ? p.kind : 'list';
  const sl = slideById(ctx.doc, currentSlide(ctx, cmd).id);
  const sh = p.id !== undefined ? findShape(sl.shapes, String(p.id)) : selectedShapes(ctx).find(x => x.text && bodyText(x.text).trim());
  if (!sh) throw bad(cmd, 'select a text box');
  const paragraphs = (sh.text?.paragraphs ?? []).map(pa => ({text: (pa.runs ?? []).map(r => r.text ?? '').join('').trim(), level: Math.min(pa.level ?? 0, MAX_LEVEL)})).filter(n => n.text);
  if (!paragraphs.length) throw bad(cmd, 'the shape has no text');
  const nodes = normalize(paragraphs);
  const size = ctx.doc.slideSize ?? {width: 960, height: 540};
  const x0 = xfrmOf(ctx.doc, sl.id, sh);
  // A placeholder keeps its frame; a small free text box takes the slide's content frame (the area below the title), as PowerPoint
  // places a converted graphic; a big one keeps its own.
  const small = !sh.ph && (x0.w < size.width * 0.5 || x0.h < size.height * 0.35);
  const base = small ? contentArea(ctx, cmd).rect : {x: x0.x, y: x0.y, w: x0.w, h: x0.h};
  const w = Math.min(size.width, Math.max(base.w, size.width * 0.5)), h = Math.min(size.height, Math.max(base.h, size.height * 0.35));
  const r = {x: Math.max(0, Math.min(base.x, size.width - w)), y: Math.max(0, Math.min(base.y, size.height - h)), w, h};
  const diagram = {kind, nodes, colors: 'colorful', style: 'flat'};
  const children = build(diagram, r, () => newId(ctx, cmd));
  const group = newShape({id: newId(ctx, cmd), xfrm: r, name: layoutName(kind), kind: {type: 'group', children, child: {...r}}, diagram});
  const at = sl.shapes.findIndex(x => x.id === sh.id);
  if (at < 0) throw bad(cmd, 'select a text box on the slide');
  ctx.change.set([...slidePath(ctx.doc, sl.id), 'shapes', at], group);
  selectIds(ctx, sl.id, [group.id]);
  return {id: group.id};
}

/** Convert to Text: the graphic becomes a text box of its outline, a bulleted paragraph per node at its level. */
function toText(ctx, p) {
  const {sl, sh} = target(ctx, p, 'smartArt.toText');
  const paragraphs = sh.diagram.nodes.map(n => ({level: n.level, props: {bullet: {kind: 'char', char: '•'}, marginLeft: 18 * (n.level + 1), indent: -14}, runs: [{text: n.text}]}));
  const box = newShape({id: sh.id, name: 'TextBox', textBox: true, xfrm: sh.xfrm, text: {body: {autofit: {kind: 'shrink', fontScale: 1, lineReduction: 0}}, paragraphs}});
  writeShape(ctx, sl.id, box);
  selectIds(ctx, sl.id, [sh.id]);
  return {id: sh.id};
}

/** Convert to Shapes: the graphic stays a group of its shapes; the outline is dropped. */
function toShapes(ctx, p) {
  const {sl, sh} = target(ctx, p, 'smartArt.toShapes');
  const {diagram, ...rest} = sh;
  void diagram;
  writeShape(ctx, sl.id, rest);
  return {id: sh.id};
}

/** Move Up / Move Down: the node swaps places with its sibling (and takes its sub-points along). */
const move = dir => (ctx, p) => {
  const cmd = dir === 'up' ? 'smartArt.moveUp' : 'smartArt.moveDown';
  const {sl, sh} = target(ctx, p, cmd);
  const index = p.index ?? sh.diagram.nodes.length - 1;
  const out = moveNode(sh.diagram.nodes, index, dir);
  if (!out) throw bad(cmd, dir === 'up' ? 'there is no node above to swap with' : 'there is no node below to swap with');
  redraw(ctx, sl, sh, {...sh.diagram, nodes: out.nodes}, cmd);
  return {index: out.index};
};
const canMove = dir => ctx => {
  const g = graphicOf(ctx);
  if (!g) return {enabled: false, reason: 'select a SmartArt graphic'};
  const nodes = g.diagram.nodes;
  return nodes.some((_, i) => moveNode(nodes, i, dir)) ? {enabled: true} : {enabled: false, reason: 'nothing to swap with'};
};
const BRANCH_NAMES = [['standard', 'Standard'], ['both', 'Both'], ['left', 'Left Hanging'], ['right', 'Right Hanging']];

const common = {id: s.optional(ID)};
const theme = ctx => ctx.doc?.masters?.[0]?.theme?.colors;
const hexOf = c => `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
const swatch = (ctx, colors, i) => hexOf(resolveColor(colorRef(colors, i), theme(ctx)));
const gallery = (ctx, g, list, id, art) => list.map(([k, label]) => ({id: k, label, value: k, checked: g.diagram[id] === k, art: art(k)}));

export default defineCommands({
  family: 'smartart',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.smartArt', label: 'SmartArt', risk: 'edit', state: hasSlide, dialog: 'dialog.smartart',
      description: `{kind: ${LAYOUT_IDS.join('|')}, items?: [text] (leading tabs = sub-points), nodes?: [{text, level}], rect?: [x,y,w,h] pt (default: the empty content placeholder, else below the title)} → {id}`,
      params: s.object({kind: s.string({max: 32}), items: s.optional(s.array(s.string({max: 2000}), {max: MAX_NODES})), nodes: NODES,
        rect: s.optional(s.array(s.number(), {min: 4, max: 4}))}),
      run: insertSmartArt},
    {id: 'smartArt.nodes', label: 'SmartArt Text', risk: 'read', state: onGraphic, description: '{id?} → {id, kind, nodes: [{text, level}]} (id: the SmartArt group; default the selection)',
      params: s.object(common), run: nodesOf},
    {id: 'smartArt.setNodes', label: 'Edit SmartArt Text', risk: 'edit', state: onGraphic,
      description: '{id?, nodes?: [{text, level}], lines?: [string] (leading tabs set the level), index?, text?, title?} (index + text edits one node; title: its Name and Title box)',
      params: s.object({...common, nodes: NODES, lines: s.optional(s.array(s.string({max: 2000}), {max: MAX_NODES})), index: s.optional(s.integer({min: 0})), text: s.optional(s.string({max: 2000})),
        title: s.optional(s.string({max: 2000}))}),
      run: setNodes},
    {id: 'smartArt.addNode', label: 'Add Shape', risk: 'edit', state: onGraphic,
      description: '{id?, index?, position?: after|before|below|above|assistant, text?} → {index} (default: after the last node)',
      params: s.object({...common, index: s.optional(s.integer({min: 0})), position: s.optional(s.string({max: 16})), text: s.optional(s.string({max: 2000}))}),
      run: edit('smartArt.addNode', (nodes, p) => addNode(nodes, p.index, p.position ?? 'after', p.text ?? ''))},
    {id: 'smartArt.removeNode', label: 'Remove Node', risk: 'edit', state: onGraphic, description: '{id?, index? (default: the last node)} (its sub-points move up one level)',
      params: s.object({...common, index: s.optional(s.integer({min: 0}))}), run: edit('smartArt.removeNode', (nodes, p) => removeNode(nodes, p.index))},
    {id: 'smartArt.promote', label: 'Promote', risk: 'edit', state: onGraphic, description: '{id?, index? (default: the last node)}',
      params: s.object({...common, index: s.optional(s.integer({min: 0}))}), run: edit('smartArt.promote', (nodes, p) => promote(nodes, p.index))},
    {id: 'smartArt.demote', label: 'Demote', risk: 'edit', state: onGraphic, description: '{id?, index? (default: the last node)}',
      params: s.object({...common, index: s.optional(s.integer({min: 0}))}), run: edit('smartArt.demote', (nodes, p) => demote(nodes, p.index))},
    {id: 'smartArt.layout', label: 'Change Layout', risk: 'edit',
      state: ctx => {
        const g = graphicOf(ctx);
        return g ? {enabled: true, value: gallery(ctx, g, LAYOUTS, 'kind', k => ({kind: 'diagram', items: thumb(k, sampleNodes(k), g.diagram.colors, g.diagram.style)}))}
          : {enabled: false, reason: 'select a SmartArt graphic'};
      },
      description: `{id?, kind: ${LAYOUT_IDS.join('|')}}`, params: s.object({...common, kind: s.string({max: 32})}), run: setField('smartArt.layout', 'kind', LAYOUT_IDS, 'layout')},
    {id: 'smartArt.colors', label: 'Change Colors', risk: 'edit',
      state: ctx => {
        const g = graphicOf(ctx);
        return g ? {enabled: true, value: gallery(ctx, g, COLORS, 'colors', k => ({kind: 'colors', colors: [0, 1, 2, 3, 4, 5].map(i => swatch(ctx, k, i))}))}
          : {enabled: false, reason: 'select a SmartArt graphic'};
      },
      description: `{id?, colors: ${COLORS.map(c => c[0]).join('|')}}`, params: s.object({...common, colors: s.string({max: 16})}), run: setField('smartArt.colors', 'colors', COLORS.map(c => c[0]), 'colours')},
    {id: 'smartArt.style', label: 'SmartArt Styles', risk: 'edit',
      state: ctx => {
        const g = graphicOf(ctx);
        return g ? {enabled: true, value: gallery(ctx, g, STYLES, 'style', k => ({kind: 'diagram', style: k, items: thumb(g.diagram.kind, sampleNodes(g.diagram.kind), g.diagram.colors, k)}))}
          : {enabled: false, reason: 'select a SmartArt graphic'};
      },
      description: `{id?, style: ${STYLE_IDS.join('|')}}`, params: s.object({...common, style: s.string({max: 16})}), run: setField('smartArt.style', 'style', STYLE_IDS, 'style')},
    {id: 'smartArt.moveUp', label: 'Move Up', risk: 'edit', state: canMove('up'), description: '{id?, index? (default: the last node)} → {index} (the node and its sub-points swap with the sibling above)',
      params: s.object({...common, index: s.optional(s.integer({min: 0}))}), run: move('up')},
    {id: 'smartArt.moveDown', label: 'Move Down', risk: 'edit', state: canMove('down'), description: '{id?, index? (default: the last node)} → {index} (the node and its sub-points swap with the sibling below)',
      params: s.object({...common, index: s.optional(s.integer({min: 0}))}), run: move('down')},
    {id: 'smartArt.rtl', label: 'Right to Left', risk: 'edit',
      state: ctx => { const g = graphicOf(ctx); return g ? {enabled: true, checked: !!g.diagram.rtl} : {enabled: false, reason: 'select a SmartArt graphic'}; },
      description: '{id?, value?: bool (default: toggle)} (the graphic is mirrored; saved in the diagram as its direction)',
      params: s.object({...common, value: s.optional(s.boolean())}),
      run(ctx, p) {
        const {sl, sh} = target(ctx, p, 'smartArt.rtl');
        const rtl = p.value ?? !sh.diagram.rtl;
        redraw(ctx, sl, sh, {...sh.diagram, rtl}, 'smartArt.rtl');
        return {rtl};
      }},
    {id: 'smartArt.branch', label: 'Layout', risk: 'edit',
      state: ctx => {
        const g = graphicOf(ctx);
        if (!g) return {enabled: false, reason: 'select a SmartArt graphic'};
        if (!ORG_KINDS.includes(g.diagram.kind)) return {enabled: false, reason: 'the branch layouts are for organization charts'};
        return {enabled: true, value: BRANCH_NAMES.map(([k, label]) => ({id: k, label, value: k, checked: (g.diagram.hang ?? 'standard') === k}))};
      },
      description: '{id?, branch: standard|both|left|right} (an organization chart: Standard, Both, Left Hanging, Right Hanging)',
      params: s.object({...common, branch: s.string({max: 16})}),
      run(ctx, p) {
        const {sl, sh} = target(ctx, p, 'smartArt.branch');
        if (!BRANCH_NAMES.some(b => b[0] === p.branch)) throw bad('smartArt.branch', `unknown branch layout \`${p.branch}\``, {branches: BRANCH_NAMES.map(b => b[0])});
        if (!ORG_KINDS.includes(sh.diagram.kind)) throw bad('smartArt.branch', 'the branch layouts are for organization charts');
        const {hang: _old, ...rest} = sh.diagram;
        redraw(ctx, sl, sh, BRANCHES.includes(p.branch) ? {...rest, hang: p.branch} : rest, 'smartArt.branch');
        return {};
      }},
    {id: 'smartArt.reset', label: 'Reset Graphic', risk: 'edit', state: onGraphic,
      description: '{id?} (colours, style, direction and branch layout go back to the defaults and the shapes are drawn again from the outline; text, levels and pictures stay)',
      params: s.object(common),
      run(ctx, p) {
        const {sl, sh} = target(ctx, p, 'smartArt.reset');
        const {rtl: _r, hang: _h, ...rest} = sh.diagram;
        redraw(ctx, sl, sh, {...rest, colors: 'colorful', style: 'flat'}, 'smartArt.reset');
        return {};
      }},
    {id: 'smartArt.picture', label: 'Add Picture', risk: 'edit', state: onGraphic,
      description: '{id?, index?, data?: base64 | path?: string | reset?: bool} (the picture placeholder of a node in the picture layouts; with no file the person picks one)',
      params: s.object({...common, index: s.optional(s.integer({min: 0})), data: s.optional(s.string()), path: s.optional(s.string({max: 4096})), name: s.optional(s.string({max: 255})), reset: s.optional(s.boolean())}),
      run: picture},
    {id: 'smartArt.fromText', label: 'Convert to SmartArt', risk: 'edit',
      state: ctx => {
        if (!isSchema2(ctx.doc)) return {enabled: false, reason: 'no presentation'};
        const sh = selectedShapes(ctx).find(x => x.text && bodyText(x.text).trim() && !x.diagram);
        if (!sh) return {enabled: false, reason: 'select a text box'};
        const nodes = (sh.text.paragraphs ?? []).map(pa => ({text: 'x', level: pa.level ?? 0}));
        return {enabled: true, value: LAYOUTS.map(([k, label]) => ({id: k, label, value: k, art: {kind: 'diagram', items: thumb(k, k === 'list' || k === 'process' ? normalize(nodes.slice(0, 6)) : sampleNodes(k))}}))};
      },
      description: `{id?, kind?: ${LAYOUT_IDS.join('|')} (default list)} → {id} (a text box or placeholder becomes a SmartArt graphic in its place: one node per paragraph, indent levels kept)`,
      params: s.object({...common, kind: s.optional(s.string({max: 32}))}), run: fromText},
    {id: 'smartArt.toText', label: 'Convert to Text', risk: 'edit', state: onGraphic, description: '{id?} → {id} (the graphic becomes a text box of its outline)',
      params: s.object(common), run: toText},
    {id: 'smartArt.toShapes', label: 'Convert to Shapes', risk: 'edit', state: onGraphic, description: '{id?} (the graphic becomes a plain group of its shapes; the outline is dropped)',
      params: s.object(common), run: toShapes},
  ],
});
