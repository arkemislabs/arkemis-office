// Page Layout > Arrange: Bring Forward, Bring to Front, Send Backward, Send to Back, the Selection Pane, Align (and Distribute, Snap),
// Group (Regroup, Ungroup) and Rotate (Flip), for floating objects (chart, picture, shape, text box, icon).
//
// The stack: objects are ordered by their `z`; moving one renumbers the sheet's objects 0, 1, 2... back to
// front, so charts, pictures and shapes interleave as they do in Excel and in the drawing part of the saved
// file (core/grid/lib/objects.mjs). gridcraft keeps one list per kind and moves an object within its own
// list (cmd/extra/objects.rs `arrange`); ours stacks all kinds together, as Excel does.
//
// Translated from gridcraft crates/engine/src/cmd/extra/objects.rs (`selection_pane`, `align`, `rotate`) at
// fb1e59f: the Selection Pane list, Align (left, center, right, top, middle, bottom, of two or more objects of
// a kind given by id), Group given ids (as gridcraft: the objects' left edges are aligned) and Rotate given no
// direction (a 90 degree turn swaps width and height). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Beyond gridcraft, following Excel (not checked against upstream): several objects are picked together (Shift or Ctrl click, a
// group is picked whole) and Align, Distribute, Group, Regroup, Ungroup, Rotate Right/Left 90, Rotate to an angle and Flip work on
// the picked ones; Align needs two objects and Distribute three, as Excel; a group is `group: n` on its members and Ungroup leaves
// `regroup: n` so Regroup brings it back; the Selection Pane names objects (`name`) and hides them (`hidden`); Snap to Grid and
// Snap to Shape are window view flags the drag follows.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {gridSel} from '../../lib/edit-targets.mjs';
import {baseDoc, bad} from '../../lib/data-common.mjs';
import {sheetObjects, selectedObject, selectedObjects, objectsSelection, objectSelection, listName, objectRect, anchorAt, findObject} from '../../lib/objects.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/extra/objects.rs', 'crates/engine/src/cmd/extra.rs']};
const KINDS = ['chart', 'image', 'shape'];

function selected(ctx) {
  const content = baseDoc(ctx);
  const picked = selectedObject(content, ctx.selection);
  return picked && picked.kind !== 'slicer' ? {content, ...picked} : null;
}
const hasBook = ctx => Array.isArray(ctx.doc?.sheets) && ctx.doc.sheets.length;
const state = ctx => {
  if (!hasBook(ctx)) return {enabled: false, reason: 'no workbook open'};
  return selected(ctx) ? {enabled: true} : {enabled: false, reason: 'select a chart, picture or shape first'};
};

/** Moves the selected object `by` places up (+) or down (-) the stack, or to an end (Infinity / -Infinity). */
function move(ctx, by, cmd) {
  const sel = selected(ctx);
  if (!sel) throw bad(cmd, 'select a chart, picture or shape first');
  const sheet = sel.content.sheets[sel.si];
  const order = sheetObjects(sheet);
  const at = order.findIndex(o => o.kind === sel.kind && o.object.id === sel.id);
  if (at < 0) throw bad(cmd, 'the selected object is not on the sheet');
  const to = Math.max(0, Math.min(order.length - 1, by === Infinity ? order.length - 1 : by === -Infinity ? 0 : at + by));
  if (to === at && order.every((o, i) => o.object.z === i)) return {z: at};
  const [item] = order.splice(at, 1);
  order.splice(to, 0, item);
  const lists = {};
  order.forEach(({kind, object}, z) => { (lists[kind] ??= new Map()).set(object.id, z); });
  for (const [kind, zs] of Object.entries(lists)) {
    const name = listName(kind);
    ctx.change.set(['sheets', sel.si, name], sheet[name].map(o => ({...o, z: zs.get(o.id)})));
  }
  return {z: to};
}

const anchorOf = o => o.anchor ?? o;

/** The objects of the active sheet in stacking order, back to front (`selection_pane`); the pane also shows each one's name and whether it is hidden. */
function selectionPane(ctx, p) {
  const content = baseDoc(ctx);
  const sheet = content.sheets[gridSel(ctx).sheet];
  const list = sheetObjects(sheet).map(({kind, object}) => {
    const a = anchorOf(object);
    const base = {kind, id: object.id, at: a.cell, anchorMode: a.mode ?? 'moveAndSize', hidden: object.hidden === true, ...(Number.isInteger(object.group) ? {group: object.group} : {})};
    if (kind === 'chart') return {...base, name: object.name || `Chart ${object.id}`, title: object.title ?? ''};
    if (kind === 'image') return {...base, name: object.name || `Picture ${object.id}`};
    return {...base, name: object.name || `${object.kind ?? 'Shape'} ${object.id}`};
  });
  // The ribbon button toggles the pane (`on` sets it); the list is returned either way.
  if (p.list !== true) ctx.setView({selectionPane: typeof p.on === 'boolean' ? p.on : !ctx.view?.selectionPane});
  return list;
}

// ---------------------------------------------------------------------------------------------
// The objects a command acts on: the ids it is given (gridcraft), else the ones picked on the sheet.

/** [{kind, id, object}] on the active sheet: `p.ids` of `p.kind`, else the picked objects of the sheet (a slicer is not arranged). */
function targets(ctx, p) {
  const content = baseDoc(ctx);
  if (Array.isArray(p.ids)) {
    const sheet = content.sheets[gridSel(ctx).sheet];
    const kind = p.kind ?? 'shape';
    const set = new Set(p.ids);
    return {si: gridSel(ctx).sheet, items: (sheet[listName(kind)] ?? []).filter(o => set.has(o.id)).map(object => ({kind, id: object.id, object})), byIds: true};
  }
  const picked = selectedObjects(content, ctx.selection).filter(o => o.kind !== 'slicer');
  if (!picked.length) return {si: gridSel(ctx).sheet, items: [], byIds: false};
  const si = picked[0].si;
  const sheet = content.sheets[si];
  const items = picked.filter(o => o.si === si).map(o => ({kind: o.kind, id: o.id, object: findObject(sheet, o.kind, o.id)?.object})).filter(o => o.object);
  return {si, items, byIds: false};
}

/** The rectangles of items in sheet pixels. */
const rectsOf = (sheet, items) => items.map(it => ({...it, ...objectRect(sheet, anchorOf(it.object))}));

/** Writes new positions {kind, id, x, y} back as anchors, one list at a time. */
function place(ctx, si, sheet, moves) {
  const byKind = {};
  for (const m of moves) (byKind[m.kind] ??= new Map()).set(m.id, m);
  for (const [kind, ms] of Object.entries(byKind)) {
    const name = listName(kind);
    ctx.change.set(['sheets', si, name], (sheet[name] ?? []).map(o => {
      const m = ms.get(o.id);
      if (!m) return o;
      const a = anchorOf(o);
      const next = anchorAt(sheet, m.x, m.y, a.width, a.height, a.mode);
      return {...o, anchor: {...a, cell: next.cell, dx: next.dx, dy: next.dy}};
    }));
  }
}

const TO = {
  left: 'left', alignleft: 'left', center: 'center', aligncenter: 'center', right: 'right', alignright: 'right', top: 'top', aligntop: 'top', middle: 'middle', alignmiddle: 'middle',
  bottom: 'bottom', alignbottom: 'bottom', distributehorizontally: 'distributeH', distributeh: 'distributeH', distributevertically: 'distributeV', distributev: 'distributeV',
};

/**
 * Aligns two or more objects to their common bounds, or spreads three or more evenly (`how`); fewer do nothing (`align`).
 * Distribute keeps the outermost two where they are and gives the gaps between the objects one size.
 */
function align(ctx, p, how0) {
  const how = TO[String(how0 ?? p.to ?? p.align ?? 'left').toLowerCase()];
  if (!how) throw bad('arrange.align', 'align is left, center, right, top, middle, bottom, distributeH or distributeV');
  const {si, items} = targets(ctx, p);
  const sheet = baseDoc(ctx).sheets[si];
  const geo = rectsOf(sheet, items);
  const distribute = how.startsWith('distribute');
  if (geo.length < (distribute ? 3 : 2)) return null;
  const left = Math.min(...geo.map(g => g.x)), right = Math.max(...geo.map(g => g.x + g.w));
  const top = Math.min(...geo.map(g => g.y)), bottom = Math.max(...geo.map(g => g.y + g.h));
  const moves = [];
  if (distribute) {
    const h = how === 'distributeH';
    const sorted = [...geo].sort((a, b) => (h ? a.x - b.x : a.y - b.y));
    const size = g => (h ? g.w : g.h);
    const span = h ? right - left : bottom - top;
    const gap = (span - sorted.reduce((t, g) => t + size(g), 0)) / (sorted.length - 1);
    let at = h ? left : top;
    for (const g of sorted) { moves.push({kind: g.kind, id: g.id, x: h ? at : g.x, y: h ? g.y : at}); at += size(g) + gap; }
  } else {
    for (const g of geo) {
      let {x, y} = g;
      if (how === 'left') x = left;
      else if (how === 'right') x = right - g.w;
      else if (how === 'center') x = (left + right) / 2 - g.w / 2;
      else if (how === 'top') y = top;
      else if (how === 'bottom') y = bottom - g.h;
      else y = (top + bottom) / 2 - g.h / 2;
      moves.push({kind: g.kind, id: g.id, x, y});
    }
  }
  place(ctx, si, sheet, moves);
  return null;
}

/** Moves the picked objects (or `ids`) together by dx, dy pixels, as dragging a group does. */
function moveBy(ctx, p) {
  const {si, items} = targets(ctx, p);
  const sheet = baseDoc(ctx).sheets[si];
  const dx = Number(p.dx) || 0, dy = Number(p.dy) || 0;
  if (!items.length || (!dx && !dy)) return null;
  place(ctx, si, sheet, rectsOf(sheet, items).map(g => ({kind: g.kind, id: g.id, x: g.x + dx, y: g.y + dy})));
  return {moved: items.length};
}

// ---------------------------------------------------------------------------------------------
// Group

const groupsOf = items => new Set(items.map(i => i.object.group).filter(Number.isInteger));
const nextGroup = sheet => 1 + Math.max(0, ...sheetObjects(sheet).flatMap(({object}) => [object.group, object.regroup]).filter(Number.isInteger));

/** Sets or clears fields on every object of the sheet `test` matches. */
function patchObjects(ctx, si, sheet, test, patch) {
  for (const kind of KINDS) {
    const name = listName(kind);
    const list = sheet[name] ?? [];
    if (!list.some(o => test(o, kind))) continue;
    ctx.change.set(['sheets', si, name], list.map(o => {
      if (!test(o, kind)) return o;
      const next = {...o};
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
      return next;
    }));
  }
}

function group(ctx, p) {
  const {si, items, byIds} = targets(ctx, p);
  const sheet = baseDoc(ctx).sheets[si];
  if (p.ungroup === true) {
    const gs = groupsOf(items);
    if (!gs.size) throw bad('arrange.group', 'select a group first');
    for (const g of gs) patchObjects(ctx, si, sheet, o => o.group === g, {group: undefined, regroup: g});
    return {ungrouped: [...gs]};
  }
  if (p.regroup === true) {
    const was = new Set(items.map(i => i.object.regroup).filter(Number.isInteger));
    if (!was.size) throw bad('arrange.group', 'there is no group to put back');
    for (const g of was) patchObjects(ctx, si, sheet, o => o.regroup === g, {group: g, regroup: undefined});
    return {regrouped: [...was]};
  }
  if (items.length < 2) throw bad('arrange.group', 'select two or more objects to group');
  if (byIds) align(ctx, p, 'left');
  // The objects of the groups being joined come along (a group inside a group is not kept).
  const gs = groupsOf(items);
  const ids = new Set(items.map(i => `${i.kind}:${i.id}`));
  const id = nextGroup(sheet);
  patchObjects(ctx, si, ctx.doc.sheets[si], (o, kind) => ids.has(`${kind}:${o.id}`) || gs.has(o.group), {group: id, regroup: undefined});
  const members = sheetObjects(ctx.doc.sheets[si]).filter(o => ids.has(`${o.kind}:${o.object.id}`) || gs.has(o.object.group)).map(o => ({kind: o.kind, id: o.object.id}));
  if (!byIds) ctx.setSelection(objectsSelection(sheet, members));
  return {group: id, members: members.length};
}

// ---------------------------------------------------------------------------------------------
// Rotate and flip

const norm = deg => ((Math.round(deg * 100) / 100) % 360 + 360) % 360;

/**
 * Rotate: `degrees` turns the picked pictures and shapes by that much (Rotate Right 90 is 90, Left is -90), `angle` sets it, `flip`
 * horizontal or vertical mirrors it. With none of them, gridcraft's turn: a shape (`id`, else the selected, else the last) has its
 * width and height swapped.
 */
function rotate(ctx, p) {
  const modern = p.degrees !== undefined || p.angle !== undefined || (typeof p.flip === 'string' && p.flip);
  const si0 = gridSel(ctx).sheet;
  if (!modern) {
    const sheet = baseDoc(ctx).sheets[si0];
    const shapes = sheet.shapes ?? [];
    const sel = selected(ctx);
    const id = p.id ?? (sel?.kind === 'shape' ? sel.id : shapes[shapes.length - 1]?.id);
    const at = shapes.findIndex(o => o.id === id);
    if (at < 0) throw bad('arrange.rotate', 'no such shape');
    const a = anchorOf(shapes[at]);
    ctx.change.set(['sheets', si0, 'shapes'], shapes.map((o, i) => (i === at ? {...o, anchor: {...a, width: a.height, height: a.width}} : o)));
    return {id, width: a.height, height: a.width};
  }
  const {si, items} = p.id !== undefined ? {si: si0, items: (baseDoc(ctx).sheets[si0][listName(p.kind ?? 'shape')] ?? []).filter(o => o.id === p.id).map(object => ({kind: p.kind ?? 'shape', id: object.id, object}))} : targets(ctx, p);
  const turn = items.filter(i => i.kind !== 'chart');
  if (!turn.length) throw bad('arrange.rotate', items.length ? 'charts cannot be rotated' : 'select a picture or shape first');
  const sheet = baseDoc(ctx).sheets[si];
  const flip = p.flip === 'horizontal' ? 'flipH' : p.flip === 'vertical' ? 'flipV' : null;
  if (p.flip && !flip) throw bad('arrange.rotate', 'flip is horizontal or vertical');
  const ids = new Set(turn.map(i => `${i.kind}:${i.id}`));
  for (const kind of ['image', 'shape']) {
    const name = listName(kind);
    ctx.change.set(['sheets', si, name], (sheet[name] ?? []).map(o => {
      if (!ids.has(`${kind}:${o.id}`)) return o;
      const next = {...o};
      if (flip) { if (o[flip]) delete next[flip]; else next[flip] = true; }
      if (p.angle !== undefined) next.rotation = norm(p.angle);
      else if (p.degrees !== undefined) next.rotation = norm((o.rotation ?? 0) + p.degrees);
      if (!next.rotation) delete next.rotation;
      return next;
    }));
  }
  return {rotated: turn.length};
}

// ---------------------------------------------------------------------------------------------
// The Selection Pane's own commands, and Snap

/** The object `kind` `id` of the sheet, or throws. */
function one(ctx, p, cmd) {
  const si = gridSel(ctx).sheet;
  const hit = findObject(baseDoc(ctx).sheets[si], p.kind, p.id);
  if (!hit) throw bad(cmd, 'no such object');
  return {si, name: listName(p.kind), ...hit};
}

function setHidden(ctx, p) {
  const sheet = baseDoc(ctx).sheets[gridSel(ctx).sheet];
  const si = gridSel(ctx).sheet;
  if (p.all !== undefined) {
    const hidden = p.all === false;
    patchObjects(ctx, si, sheet, () => true, {hidden: hidden ? true : undefined});
    return {hidden};
  }
  const {name, index, object} = one(ctx, p, 'arrange.setVisible');
  const hidden = typeof p.visible === 'boolean' ? !p.visible : object.hidden !== true;
  const next = {...object};
  if (hidden) next.hidden = true; else delete next.hidden;
  ctx.change.set(['sheets', si, name, index], next);
  return {hidden};
}

function rename(ctx, p) {
  const {si, name, index, object} = one(ctx, p, 'arrange.rename');
  const next = {...object};
  const text = String(p.name ?? '').trim();
  if (text) next.name = text; else delete next.name;
  ctx.change.set(['sheets', si, name, index], next);
  return {name: text};
}

const FLAG = {grid: 'snapToGrid', shape: 'snapToShape'};

export default defineCommands({
  family: 'pagelayout/arrange',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'arrange.bringForward', label: 'Bring Forward', risk: 'edit',
      description: 'Move the selected object one place up the stack, or to the front (toFront: true).',
      params: s.object({toFront: s.optional(s.boolean())}),
      state, run: (ctx, p) => move(ctx, p.toFront === true ? Infinity : 1, 'arrange.bringForward'),
    },
    {
      id: 'arrange.sendBackward', label: 'Send Backward', risk: 'edit',
      description: 'Move the selected object one place down the stack, or to the back (toBack: true).',
      params: s.object({toBack: s.optional(s.boolean())}),
      state, run: (ctx, p) => move(ctx, p.toBack === true ? -Infinity : -1, 'arrange.sendBackward'),
    },
    {
      id: 'arrange.selectionPane', label: 'Selection Pane', risk: 'read', effect: 'view',
      description: 'The objects on the sheet in stacking order, back to front: kind, id, name, anchor cell and mode, hidden, group. Shows or hides the Selection Pane (`on` sets it, default the other state); `list: true` only reads the list.',
      params: s.object({on: s.optional(s.boolean()), list: s.optional(s.boolean())}),
      state: ctx => (hasBook(ctx) ? {enabled: true, checked: !!ctx.view?.selectionPane} : {enabled: false, reason: 'no workbook open'}),
      run: selectionPane,
    },
    {
      id: 'arrange.setVisible', label: 'Show or Hide Object', risk: 'edit',
      description: 'Show or hide an object of the sheet (`kind`, `id`, `visible`; default the other state); `all: true` shows every object, `all: false` hides them all (the Selection Pane\'s Show All and Hide All).',
      params: s.object({kind: s.optional(s.enum(KINDS)), id: s.optional(s.integer({min: 0})), visible: s.optional(s.boolean()), all: s.optional(s.boolean())}),
      state: ctx => (hasBook(ctx) ? {enabled: true} : {enabled: false, reason: 'no workbook open'}), run: setHidden,
    },
    {
      id: 'arrange.rename', label: 'Rename Object', risk: 'edit',
      description: 'Give an object of the sheet a name (`kind`, `id`, `name`; empty restores the default name); the Selection Pane lists the names.',
      params: s.object({kind: s.enum(KINDS), id: s.integer({min: 0}), name: s.string({max: 255})}),
      state: ctx => (hasBook(ctx) ? {enabled: true} : {enabled: false, reason: 'no workbook open'}), run: rename,
    },
    {
      id: 'arrange.align', label: 'Align', risk: 'edit',
      description: 'Align the picked objects (or `ids` of a `kind`) to their common left, center, right, top, middle or bottom (`to` or `align`), or spread three or more evenly (distributeH, distributeV).',
      params: s.object({kind: s.optional(s.enum(KINDS)), ids: s.optional(s.array(s.integer({min: 1}), {max: 1000})), align: s.optional(s.string({max: 40})), to: s.optional(s.string({max: 40}))}),
      state: (ctx, p) => {
        if (!hasBook(ctx)) return {enabled: false, reason: 'no workbook open'};
        if (Array.isArray(p?.ids)) return {enabled: true};
        const n = targets(ctx, {}).items.length;
        const need = /^distribute/i.test(String(p?.to ?? p?.align ?? '')) ? 3 : 2;
        return n >= need ? {enabled: true} : {enabled: false, reason: need === 3 ? 'select three or more objects first' : 'select two or more objects first'};
      },
      run: (ctx, p) => align(ctx, p),
    },
    {
      id: 'arrange.moveBy', label: 'Move Objects', risk: 'edit',
      description: 'Move the picked objects (or `ids` of a `kind`) together by `dx`, `dy` pixels; dragging a group does this.',
      params: s.object({kind: s.optional(s.enum(KINDS)), ids: s.optional(s.array(s.integer({min: 1}), {max: 1000})), dx: s.optional(s.number()), dy: s.optional(s.number())}),
      state: (ctx, p) => (hasBook(ctx) && (Array.isArray(p?.ids) || targets(ctx, {}).items.length) ? {enabled: true} : {enabled: false, reason: 'select an object first'}),
      run: moveBy,
    },
    {
      id: 'arrange.group', label: 'Group', risk: 'edit',
      description: 'Group the picked objects (two or more) so they select and move together; `ungroup: true` splits the picked group, `regroup: true` puts the last group back. Given `kind` and `ids` it is gridcraft\'s: the objects\' left edges are aligned, and they are grouped.',
      params: s.object({kind: s.optional(s.enum(KINDS)), ids: s.optional(s.array(s.integer({min: 1}), {max: 1000})), ungroup: s.optional(s.boolean()), regroup: s.optional(s.boolean())}),
      state: (ctx, p) => {
        if (!hasBook(ctx)) return {enabled: false, reason: 'no workbook open'};
        if (Array.isArray(p?.ids)) return {enabled: true};
        const {items} = targets(ctx, {});
        const grouped = items.some(i => Number.isInteger(i.object.group)), back = items.some(i => Number.isInteger(i.object.regroup));
        if (p?.ungroup) return grouped ? {enabled: true} : {enabled: false, reason: 'select a group first'};
        if (p?.regroup) return back && !grouped ? {enabled: true} : {enabled: false, reason: 'there is no group to put back'};
        if (p && Object.keys(p).length === 0 && (grouped || back)) return {enabled: true};
        const whole = items.length > 1 && items.every(i => Number.isInteger(i.object.group)) && groupsOf(items).size === 1;
        return items.length >= 2 && !whole ? {enabled: true} : {enabled: false, reason: 'select two or more objects first'};
      },
      run: group,
    },
    {
      id: 'arrange.rotate', label: 'Rotate', risk: 'edit',
      description: 'Turn the picked pictures and shapes: `degrees` more (90 is Rotate Right, -90 Rotate Left), `angle` exactly, `flip` horizontal or vertical. With none of them, gridcraft\'s turn: a shape (`id`, default the selected) has its width and height swapped.',
      params: s.object({kind: s.optional(s.enum(['shape', 'image'])), id: s.optional(s.integer({min: 1})), degrees: s.optional(s.number({min: -3600, max: 3600})), angle: s.optional(s.number({min: -3600, max: 3600})), flip: s.optional(s.nullable(s.string({max: 20})))}),
      state: (ctx, p) => {
        if (!hasBook(ctx)) return {enabled: false, reason: 'no workbook open'};
        const modern = p?.degrees !== undefined || p?.angle !== undefined || (typeof p?.flip === 'string' && p.flip);
        const sel = selected(ctx);
        if (!modern) return sel?.kind === 'shape' || p?.id !== undefined ? {enabled: true} : targets(ctx, {}).items.some(i => i.kind !== 'chart') ? {enabled: true} : {enabled: false, reason: 'select a shape first'};
        return targets(ctx, {}).items.some(i => i.kind !== 'chart') || p?.id !== undefined ? {enabled: true} : {enabled: false, reason: 'select a picture or shape first'};
      },
      run: rotate,
    },
    {
      id: 'arrange.snap', label: 'Snap', risk: 'read', effect: 'view',
      description: 'Snap to Grid (`mode: grid`) makes dragged and sized objects line up with the cell borders; Snap to Shape (`mode: shape`) with the edges of the other objects. `on` sets it, default the other state; a window setting.',
      params: s.object({mode: s.enum(['grid', 'shape']), on: s.optional(s.boolean())}),
      state: (ctx, p) => (hasBook(ctx) ? {enabled: true, checked: !!ctx.view?.[FLAG[p?.mode] ?? 'snapToGrid']} : {enabled: false, reason: 'no workbook open'}),
      run: (ctx, p) => { const key = FLAG[p.mode]; const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.[key]; ctx.setView({[key]: on}); return {on}; },
    },
  ],
});
