// Arrange: order, group, align, distribute, rotate and flip; drawing guides.
// Translated from deckcraft crates/engine/src/cmd/arrange.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {
  UPSTREAM_COMMIT, bad, hasDoc, hasSlide, hasSelection, hasTwo, num, str, usize, clamp, targets, idOf, editGeometry, currentSlide,
  writeShapes, selectIds, newId,
} from '../lib/shape-common.mjs';
import {findShape, walk, isGroup, parentOf, childrenOf} from '../model/presentation.mjs';
import {xfrmBounds, groupChildAffine, cleanXfrm} from '../model/geom/index.mjs';
import {apply as affApply, pt, rectUnion, rectCenter, rect as mkRect} from '../model/geom/kurbo.mjs';
import {slideById, xfrmOf} from '../model/doc.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/arrange.rs']};

const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const ids = s.optional(s.array(ID, {max: 5000}));
const idsOnly = s.object({ids, id: s.optional(ID)});

// ---------------------------------------------------------------------------------------------
// Order (bring/send)

/** Every shape id with its depth, in tree order. */
const stacking = list => { const out = []; walk(list, (sh, d) => out.push(`${sh.id}@${d}`)); return out.join(','); };

function orderList(list, set, how) {
  if (how === 2) return [...list.filter(x => !set.has(x.id)), ...list.filter(x => set.has(x.id))];
  if (how === -2) return [...list.filter(x => set.has(x.id)), ...list.filter(x => !set.has(x.id))];
  const out = [...list];
  if (how === 1) {
    for (let i = out.length - 2; i >= 0; i--) {
      if (set.has(out[i].id) && !set.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (!set.has(out[i - 1].id) && set.has(out[i].id)) [out[i - 1], out[i]] = [out[i], out[i - 1]];
    }
  }
  return out;
}
/** `order_tree`: restack `ids` among their siblings in every list of the tree (a group's child stays in its group). */
function orderTree(list, set, how, depth = 0) {
  if (depth > 64) return list;
  const here = list.some(x => set.has(x.id)) ? orderList(list, set, how) : list;
  return here.map(sh => (isGroup(sh) ? {...sh, kind: {...sh.kind, children: orderTree(sh.kind.children ?? [], set, how, depth + 1)}} : sh));
}

function order(ctx, p, how) {
  const set = new Set(targets(ctx, p, 'arrange'));
  const sl = currentSlide(ctx, 'arrange');
  const next = orderTree(sl.shapes, set, how);
  // Already in place (front of its group, say): no change and no undo step.
  if (stacking(next) === stacking(sl.shapes)) return null;
  writeShapes(ctx, sl.id, next);
  return null;
}

/** `reorder`: move one shape to `index` among its siblings (0 = back): the Selection pane's drag and drop. */
function reorder(ctx, p) {
  const C = 'arrange.reorder';
  const i = idOf(p.id);
  if (i === null) throw bad(C, 'missing `id`');
  const to = usize(p, 'index');
  if (to === undefined) throw bad(C, 'missing `index`');
  const sl = currentSlide(ctx, C);
  const parent = parentOf(sl.shapes, i);
  if (parent === undefined) throw bad(C, 'no such shape');
  const siblings = parent === null ? sl.shapes : childrenOf(findShape(sl.shapes, parent));
  const from = siblings.findIndex(x => x.id === i);
  if (from < 0) throw bad(C, 'no such shape');
  if (from === Math.min(to, Math.max(siblings.length - 1, 0))) return {index: from};
  const rest = siblings.filter(x => x.id !== i);
  const at = Math.min(to, rest.length);
  rest.splice(at, 0, siblings[from]);
  const rec = (list, depth) => (depth > 64 ? list : list.map(sh => (isGroup(sh) && sh.id === parent
    ? {...sh, kind: {...sh.kind, children: rest}}
    : isGroup(sh) ? {...sh, kind: {...sh.kind, children: rec(sh.kind.children ?? [], depth + 1)}} : sh)));
  writeShapes(ctx, sl.id, parent === null ? rest : rec(sl.shapes, 0));
  return {index: at};
}

// ---------------------------------------------------------------------------------------------
// Group, ungroup, regroup

/** `union_bounds`: bounds of shapes (rotation included). */
export function unionBounds(xs) {
  if (!xs.length) return null;
  return xs.map(xfrmBounds).reduce((a, b) => rectUnion(a, b));
}
/** How deep groups may nest (deckcraft `MAX_GROUP_DEPTH`). */
export const MAX_GROUP_DEPTH = 32;
function groupDepth(list) {
  let d = 0;
  walk(list, (sh, depth) => { if (isGroup(sh)) d = Math.max(d, depth + 1); });
  return d;
}

function group(ctx, p) {
  const want = new Set(targets(ctx, p, 'arrange.group'));
  const sl = currentSlide(ctx, 'arrange.group');
  const members = sl.shapes.filter(x => want.has(x.id)).map(m => structuredClone(m));
  if (members.length < 2) throw bad('arrange.group', 'select two or more objects on the slide');
  if (groupDepth(members) + 1 > MAX_GROUP_DEPTH) throw bad('arrange.group', `groups can be nested at most ${MAX_GROUP_DEPTH} deep`);
  for (const m of members) {
    if (!m.xfrm) m.xfrm = cleanXfrm(xfrmOf(ctx.doc, sl.id, m));
    // Placeholders lose their link when grouped (PowerPoint keeps them out of groups).
    m.ph = null;
  }
  const b = unionBounds(members.map(m => m.xfrm).filter(Boolean));
  if (!b) throw bad('arrange.group', 'nothing to group');
  const gx = {x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0};
  const gid = newId(ctx, 'arrange.group');
  const g = {id: gid, name: `Group ${sl.shapes.length + 1}`, xfrm: gx, kind: {type: 'group', children: members, child: {...gx}}, geom: {kind: 'preset', name: 'rect'},
    ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false,
    click: null, hover: null};
  const list = [...sl.shapes];
  let at = -1;
  list.forEach((x, k) => { if (want.has(x.id)) at = k; });
  list.splice(at < 0 ? list.length : at + 1, 0, g);
  writeShapes(ctx, sl.id, list.filter(x => !want.has(x.id)));
  selectIds(ctx, sl.id, [gid]);
  return {id: gid};
}

/** `child_to_parent`: a child's xfrm in slide space, given its group. */
export function childToParent(group, ch, c) {
  const sx = Math.abs(ch.w) > 1e-9 ? group.w / ch.w : 1;
  const sy = Math.abs(ch.h) > 1e-9 ? group.h / ch.h : 1;
  const a = groupChildAffine(group, mkRect(ch.x, ch.y, ch.x + ch.w, ch.y + ch.h));
  const center = affApply(a, pt(c.x + c.w / 2, c.y + c.h / 2));
  const w = c.w * Math.abs(sx), h = c.h * Math.abs(sy);
  let rot = (c.rot ?? 0) + (group.rot ?? 0);
  let fh = !!c.flipH, fv = !!c.flipV;
  if (group.flipH) { fh = !fh; rot = -(c.rot ?? 0) + (group.rot ?? 0); }
  if (group.flipV) { fv = !fv; rot = -rot + 2 * (group.rot ?? 0); }
  return cleanXfrm({x: center.x - w / 2, y: center.y - h / 2, w, h, rot: ((rot % 360) + 360) % 360, flipH: fh, flipV: fv});
}

function ungroup(ctx, p) {
  const want = new Set(targets(ctx, p, 'arrange.ungroup'));
  const sl = currentSlide(ctx, 'arrange.ungroup');
  const out = [];
  const sel = [];
  for (const sh of sl.shapes) {
    if (want.has(sh.id) && isGroup(sh) && sh.xfrm) {
      for (const c0 of sh.kind.children ?? []) {
        const c = structuredClone(c0);
        if (c.xfrm) c.xfrm = childToParent(sh.xfrm, sh.kind.child ?? sh.xfrm, c.xfrm);
        sel.push(c.id);
        out.push(c);
      }
      continue;
    }
    out.push(sh);
  }
  writeShapes(ctx, sl.id, out);
  selectIds(ctx, sl.id, sel);
  return {ids: sel};
}

function regroup(ctx) {
  // Regroup the most recently ungrouped objects (from the undo history): its children are the current selection when nothing else changed.
  const labels = ctx.history?.undoLabels?.() ?? [];
  if (!labels.includes('Ungroup')) throw bad('arrange.regroup', 'nothing to regroup');
  const cur = targets(ctx, {}, 'arrange.regroup');
  if (cur.length < 2) throw bad('arrange.regroup', 'nothing to regroup');
  return ctx.run('arrange.group', {ids: cur});
}

// ---------------------------------------------------------------------------------------------
// Align and distribute

/**
 * Align to Slide / Align Selected Objects (ribbon/arrange.rs `align_to_slide`): the choice ticked
 * for this same selection, else one object aligns to the slide and several to each other. The
 * choice is UI state (deckcraft `SlideApp::align_to`), kept in the view.
 */
function alignChoice(ctx) {
  const c = ctx.view?.alignTo;
  if (!c || !Array.isArray(c.ids)) return null;
  const cur = targets(ctx, {}, 'arrange.align');
  return c.ids.length === cur.length && c.ids.every((x, i) => x === cur[i]) ? !!c.slide : null;
}
const alignToSlide = (ctx, n) => alignChoice(ctx) ?? n < 2;

function align(ctx, p) {
  const edge = str(p, 'edge') ?? 'left';
  const sl = currentSlide(ctx, 'arrange.align');
  const size = ctx.doc.slideSize;
  const boxes = targets(ctx, p, 'arrange.align').map(i => findShape(sl.shapes, i)).filter(Boolean).map(sh => xfrmOf(ctx.doc, sl.id, sh));
  const toSlide = p.to === 'slide' ? true : typeof p.to === 'string' ? false : alignToSlide(ctx, boxes.length);
  const ref = toSlide ? mkRect(0, 0, size.width, size.height) : unionBounds(boxes) ?? mkRect(0, 0, 0, 0);
  return editGeometry(ctx, p, 'arrange.align', sh => {
    const x = sh.xfrm;
    if (!x) return;
    const b = xfrmBounds(x);
    let dx = 0, dy = 0;
    switch (edge) {
      case 'left': dx = ref.x0 - b.x0; break;
      case 'center': dx = rectCenter(ref).x - rectCenter(b).x; break;
      case 'right': dx = ref.x1 - b.x1; break;
      case 'top': dy = ref.y0 - b.y0; break;
      case 'middle': dy = rectCenter(ref).y - rectCenter(b).y; break;
      case 'bottom': dy = ref.y1 - b.y1; break;
      default: break;
    }
    x.x += dx;
    x.y += dy;
  });
}

function distribute(ctx, p) {
  const horiz = !String(p.dir ?? 'horizontal').startsWith('v');
  const sl = currentSlide(ctx, 'arrange.distribute');
  const size = ctx.doc.slideSize;
  const boxes = targets(ctx, p, 'arrange.distribute').map(i => [i, findShape(sl.shapes, i)]).filter(([, sh]) => sh)
    .map(([i, sh]) => [i, xfrmBounds(xfrmOf(ctx.doc, sl.id, sh))]);
  const toSlide = p.to === 'slide' || (p.to === undefined && alignChoice(ctx) === true) || (p.to !== 'selection' && alignChoice(ctx) !== false && boxes.length < 3);
  if (!boxes.length) return null;
  boxes.sort((a, b) => (horiz ? a[1].x0 - b[1].x0 : a[1].y0 - b[1].y0));
  const len = r => (horiz ? r.x1 - r.x0 : r.y1 - r.y0);
  const total = boxes.reduce((t, [, r]) => t + len(r), 0);
  let start, end;
  if (toSlide) [start, end] = horiz ? [0, size.width] : [0, size.height];
  else {
    start = Math.min(...boxes.map(([, r]) => (horiz ? r.x0 : r.y0)));
    end = Math.max(...boxes.map(([, r]) => (horiz ? r.x1 : r.y1)));
  }
  const n = boxes.length;
  const gap = n > 1 ? ((end - start) - total) / (n - 1) : 0;
  const moves = new Map();
  let cur = start;
  if (n === 1) cur = start + ((end - start) - len(boxes[0][1])) / 2;
  for (const [i, r] of boxes) {
    moves.set(i, cur - (horiz ? r.x0 : r.y0));
    cur += len(r) + gap;
  }
  return editGeometry(ctx, p, 'arrange.distribute', sh => {
    const d = moves.get(sh.id);
    if (!sh.xfrm || d === undefined) return;
    if (horiz) sh.xfrm.x += d; else sh.xfrm.y += d;
  });
}

// ---------------------------------------------------------------------------------------------
// Guides (kept on the presentation; at most 200)

const MAX_GUIDES = 200;
const guides = ctx => ctx.doc.guides ?? [];
const guideLimit = (ctx, vertical) => (vertical ? ctx.doc.slideSize.width : ctx.doc.slideSize.height);
function guideIndex(ctx, p, cmd) {
  const i = usize(p, 'index');
  if (i === undefined) throw bad(cmd, 'missing `index`');
  if (i >= guides(ctx).length) throw bad(cmd, 'no such guide');
  return i;
}

function guideAdd(ctx, p) {
  if (p.defaults === true) {
    if (guides(ctx).length) return {added: 0};
    const size = ctx.doc.slideSize;
    ctx.change.set(['guides'], [{vertical: true, pos: size.width / 2}, {vertical: false, pos: size.height / 2}]);
    return {added: 2};
  }
  const vertical = typeof p.vertical === 'boolean' ? p.vertical : true;
  const limit = guideLimit(ctx, vertical);
  const pos = clamp(num(p, 'pos') ?? limit / 2, 0, limit);
  if (guides(ctx).length >= MAX_GUIDES) throw bad('guide.add', 'too many guides');
  ctx.change.set(['guides'], [...guides(ctx), {vertical, pos}]);
  return {index: guides(ctx).length - 1};
}

function guideMove(ctx, p) {
  const i = guideIndex(ctx, p, 'guide.move');
  const vertical = !!guides(ctx)[i]?.vertical;
  if (num(p, 'pos') === undefined) throw bad('guide.move', 'missing `pos`');
  const pos = clamp(p.pos, 0, guideLimit(ctx, vertical));
  ctx.change.set(['guides', i, 'pos'], pos);
  return {index: i, pos};
}

function guideDelete(ctx, p) {
  const i = guideIndex(ctx, p, 'guide.delete');
  ctx.change.splice(['guides'], i, 1);
  return null;
}

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'arrange',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'guide.add', label: 'Add Guide', risk: 'edit', state: hasDoc,
      description: "{vertical: bool, pos?: pt (default: the slide's centre)} → {index}. `defaults: true` adds the two centre guides when there are none",
      params: s.object({vertical: s.optional(s.boolean()), pos: s.optional(s.number()), defaults: s.optional(s.boolean())}), run: guideAdd},
    {id: 'guide.move', label: 'Move Guide', risk: 'edit', state: hasDoc, description: '{index, pos: pt}',
      params: s.object({index: s.integer({min: 0}), pos: s.optional(s.nullable(s.number()))}), run: guideMove},
    {id: 'guide.delete', label: 'Delete Guide', risk: 'edit', state: hasDoc, description: '{index}',
      params: s.object({index: s.integer({min: 0})}), run: guideDelete},
    {id: 'guide.list', label: 'Guides', risk: 'read', state: hasDoc, description: '{} → [{vertical, pos}]',
      params: s.object({}), run: ctx => structuredClone(guides(ctx))},
    {id: 'arrange.bringToFront', label: 'Bring to Front', risk: 'edit', shortcut: 'Mod+Shift+]', state: hasSelection, description: '{ids?}',
      params: idsOnly, run: (ctx, p) => order(ctx, p, 2)},
    {id: 'arrange.bringForward', label: 'Bring Forward', risk: 'edit', shortcut: 'Mod+]', state: hasSelection, description: '{ids?}',
      params: idsOnly, run: (ctx, p) => order(ctx, p, 1)},
    {id: 'arrange.sendBackward', label: 'Send Backward', risk: 'edit', shortcut: 'Mod+[', state: hasSelection, description: '{ids?}',
      params: idsOnly, run: (ctx, p) => order(ctx, p, -1)},
    {id: 'arrange.sendToBack', label: 'Send to Back', risk: 'edit', shortcut: 'Mod+Shift+[', state: hasSelection, description: '{ids?}',
      params: idsOnly, run: (ctx, p) => order(ctx, p, -2)},
    {id: 'arrange.reorder', label: 'Reorder Objects', risk: 'edit', state: hasSlide,
      description: "{id, index: position among its siblings (0 = back; a group's child stays in its group)} → {index}",
      params: s.object({id: ID, index: s.integer({min: 0})}), run: reorder},
    {id: 'arrange.group', label: 'Group', risk: 'edit', shortcut: 'Mod+Alt+G', state: hasTwo, description: '{ids?}', params: idsOnly, run: group},
    {id: 'arrange.ungroup', label: 'Ungroup', risk: 'edit', shortcut: 'Mod+Alt+Shift+G', state: hasSelection, description: '{ids?}', params: idsOnly, run: ungroup},
    {id: 'arrange.regroup', label: 'Regroup', risk: 'edit', shortcut: 'Mod+Alt+J', state: hasDoc, description: '{}', params: s.object({}), run: regroup},
    {id: 'arrange.align', label: 'Align', risk: 'edit', state: hasSelection,
      description: '{edge: left|center|right|top|middle|bottom, to?: slide|selection (default: slide for one object), ids?}',
      params: s.object({edge: s.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']), to: s.optional(s.enum(['slide', 'selection'])), ids, id: s.optional(ID)}),
      run: align},
    {id: 'arrange.distribute', label: 'Distribute', risk: 'edit', state: hasSelection, description: '{dir: horizontal|vertical, to?: slide|selection, ids?}',
      params: s.object({dir: s.enum(['horizontal', 'vertical']), to: s.optional(s.enum(['slide', 'selection'])), ids, id: s.optional(ID)}),
      run: distribute},
    {id: 'arrange.alignTo', label: 'Align to Slide', risk: 'read', effect: 'view',
      description: '{slide: bool} — Align to Slide (true) or Align Selected Objects (false) for the current selection',
      params: s.object({slide: s.boolean()}),
      state(ctx, p) {
        const st = hasSelection(ctx);
        if (!st.enabled) return st;
        const n = targets(ctx, {}, 'arrange.align').length;
        return {enabled: true, checked: alignToSlide(ctx, n) === (p?.slide !== false)};
      },
      run(ctx, p) { ctx.setView({alignTo: {ids: targets(ctx, {}, 'arrange.align'), slide: p.slide}}); return {slide: p.slide}; }},
    {id: 'arrange.rotateLeft', label: 'Rotate Left 90°', risk: 'edit', state: hasSelection, description: '{ids?}', params: idsOnly,
      run: (ctx, p) => ctx.run('shape.rotate', {...p, by: -90})},
    {id: 'arrange.rotateRight', label: 'Rotate Right 90°', risk: 'edit', state: hasSelection, description: '{ids?}', params: idsOnly,
      run: (ctx, p) => ctx.run('shape.rotate', {...p, by: 90})},
    {id: 'arrange.flipHorizontal', label: 'Flip Horizontal', risk: 'edit', state: hasSelection, description: '{ids?}', params: idsOnly,
      run: (ctx, p) => ctx.run('shape.flip', {...p, axis: 'horizontal'})},
    {id: 'arrange.flipVertical', label: 'Flip Vertical', risk: 'edit', state: hasSelection, description: '{ids?}', params: idsOnly,
      run: (ctx, p) => ctx.run('shape.flip', {...p, axis: 'vertical'})},
    {id: 'arrange.nudge', label: 'Nudge', risk: 'edit', state: hasSelection, description: '{dx, dy, ids?} (arrow keys: 6 pt, with Alt 1 pt)',
      params: s.object({dx: s.optional(s.number()), dy: s.optional(s.number()), ids, id: s.optional(ID)}),
      run: (ctx, p) => ctx.run('shape.move', p)},
  ],
});
