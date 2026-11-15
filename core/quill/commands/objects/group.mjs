// Arrange › Group, Ungroup, Selection Pane, Move with Text / Fix Position, Distribute, and picking several objects
// (Shift+click, select.addObject, select.objects).
//
// Translated from wordcraft crates/engine/src/cmd/objects/group.rs (`add_object`, `group`, `ungroup`),
// select.rs (`picked_objects`, `object_ref`, `all_objects`, `objects_list`, `shown_members`), arrange.rs
// (`moves_with_text`, `move_with_text`) and specs.rs (`select.addObject`, `select.objects`, `arrange.group`,
// `arrange.ungroup`, `arrange.selectionPane`, `arrange.moveWithText`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT,
// see assets/third-party-licenses/artcraft-reference.txt.
//
// Several objects selected are several ranges of the selection, each one object. Not upstream (follows Word, not
// checked against upstream): Distribute Horizontally / Vertically, `object.hide` (the Selection Pane's eye), and a
// Selection Pane that lists names. A group is saved to .docx as its members (docx-write.mjs).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {UPSTREAM_COMMIT, ready, finish, open, samePos, layoutFor} from '../../lib/caret-session.mjs';
import * as P from '../../model/para.mjs';
import {spinBounds} from '../../layout/floats.mjs';
import {pickedAll, objectHit, allObjects, selectPicks, selectedIn, editAt, target, disabled, samePlace, NO_OBJECT, stateFor, FROZEN} from '../../lib/object-edit.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/objects/group.rs', 'crates/engine/src/cmd/objects/select.rs', 'crates/engine/src/cmd/objects/arrange.rs', 'crates/engine/src/cmd/objects/specs.rs']};
const MAX_OFFSET = 31680;
const OBJ_LEN = 1;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = v => (Number.isFinite(v) ? v : 0);
const failed = m => new CommandError('failed', m);

/** The names the Selection Pane gives (objects_list): kind and name. */
export function objectName(o, i) {
  switch (o.type) {
    case 'image': return ['picture', o.alt ? o.alt : `Picture ${i + 1}`];
    case 'shape': return ['shape', `${o.kind === 'textBox' ? 'Text Box' : (o.kind ?? 'shape').replace(/^./, c => c.toUpperCase())} ${i + 1}`];
    case 'graphic': return ['graphic', `${o.graphic?.chart ? 'Chart' : o.graphic?.smartArt ? 'Diagram' : 'Graphic'} ${i + 1}`];
    case 'group': return ['group', `${P.isCanvas(o) ? 'Drawing Canvas' : 'Group'} ${i + 1}`];
    default: return ['object', `Object ${i + 1}`];
  }
}

/** The rectangle a drawing covers on the page, turned (its bounds): the layout's, or null when it isn't laid out. */
function shownRect(ctx, pos) {
  const hit = objectHit(ctx, pos);
  return hit ? {...hit, bounds: spinBounds(hit.rect, hit.rot)} : null;
}

/** moves_with_text: the vertical position follows the paragraph (anchored to it, a line or a character). */
export const movesWithText = f => !['page', 'margin', 'topMargin', 'bottomMargin', 'insideMargin', 'outsideMargin'].includes(f?.vRel ?? 'paragraph');

function pickRef(S, ref) {
  const all = allObjects(S);
  const hit = Number.isInteger(ref) ? all[ref] : all.find(h => ref && typeof ref === 'object' && h.pos.story === ref.story && h.pos.off === ref.off && h.pos.path.join('.') === (ref.path ?? []).join('.'));
  if (!hit) throw new CommandError('invalid_params', 'no picture or shape there');
  return hit.pos;
}

/** select.addObject (Shift+click): the first becomes the selection if none is; one already picked is taken out again. */
function addObject(ctx, p) {
  const S = open(ctx);
  const items = [...(p.objects ?? []).slice(0, 1000), ...(p.pos !== undefined ? [p.pos] : []), ...(p.index !== undefined ? [p.index] : [])];
  if (!items.length) throw new CommandError('invalid_params', '`pos`, `index` or `objects` required');
  let picks = pickedAll(S).map(h => h.pos);
  for (const ref of items) {
    const pos = pickRef(S, ref);
    if (!picks.length) picks = [pos];
    else if (samePlace(picks[0], pos)) { /* the first stays */ } else {
      const i = picks.findIndex(q => samePlace(q, pos));
      if (i >= 0) picks.splice(i, 1); else picks.push(pos);
    }
  }
  selectPicks(ctx, S, picks);
  return {selected: picks.map(q => ({story: q.story, path: q.path, off: q.off}))};
}

// ---- Group and Ungroup --------------------------------------------------------------------------------------

function group(ctx) {
  const S = open(ctx);
  const picks = pickedAll(S).sort((a, b) => (a.pos.story === b.pos.story ? a.pos.path.join('.').localeCompare(b.pos.path.join('.'), undefined, {numeric: true}) || a.pos.off - b.pos.off : 0));
  if (picks.length < 2) throw disabled('select two or more pictures or shapes first (Shift+click)');
  if (picks.some(h => h.pos.story !== picks[0].pos.story)) throw disabled("objects in different stories (body, header, footer) can't be grouped");
  const found = picks.map(h => {
    if (h.pos.path.length !== 1) throw disabled('only objects in the body text, headers and footers (not in tables) can be grouped');
    if (h.obj.type === 'graphic') throw disabled(FROZEN);
    if (P.isCanvas(h.obj)) throw disabled("a drawing canvas can't be grouped");
    if (!P.isFloating(h.obj)) throw disabled("objects in line with text can't be grouped: choose a text wrapping for them first");
    const hit = shownRect(ctx, h.pos);
    if (!hit) throw failed("the object isn't laid out");
    return {...h, hit};
  });
  if (found.some(f => f.hit.page !== found[0].hit.page)) throw disabled("objects on different pages can't be grouped");
  // The members as they show on the page; a group among them gives its members.
  const shown = [];
  for (const f of found) {
    const r = f.hit.rect;
    if (f.obj.type === 'group') for (const [[x, y, w, h], c] of P.groupRects(f.obj, r.x, r.y, r.w, r.h)) shown.push({rect: [x, y, w, h], obj: c});
    else shown.push({rect: [r.x, r.y, r.w, r.h], obj: f.obj});
  }
  if (!shown.length) throw failed('nothing to group');
  if (shown.length > P.MAX_GROUP_CHILDREN) throw disabled(`too many objects to group (at most ${P.MAX_GROUP_CHILDREN})`);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const m of shown) {
    const b = spinBounds({x: m.rect[0], y: m.rect[1], w: m.rect[2], h: m.rect[3]}, m.obj.float?.rot ?? 0);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  const w = clamp(x1 - x0, 1, MAX_OFFSET), h = clamp(y1 - y0, 1, MAX_OFFSET);
  const children = shown.map(m => {
    const f = m.obj.float ?? P.defaultFloat();
    // Each member keeps its own alt text and its turn: the group itself starts unturned.
    const own = {...P.defaultFloat(), ...(f.alt ? {alt: f.alt} : {}), ...(f.rot ? {rot: f.rot} : {}), ...(f.flipH ? {flipH: true} : {}), ...(f.flipV ? {flipV: true} : {})};
    return {x: m.rect[0] - x0, y: m.rect[1] - y0, obj: P.setObjectSize({...m.obj, float: own}, m.rect[2], m.rect[3])};
  });
  // The group takes the first member's placement, on the page where they are.
  const lead = found[0].obj.float ?? P.defaultFloat();
  const float = {...lead, hRel: 'page', vRel: 'page', x: x0, y: y0, rot: 0, flipH: false, flipV: false};
  delete float.alt; delete float.hAlign; delete float.vAlign; delete float.rot; delete float.flipH; delete float.flipV;
  if (found.length === 1 && !float.wrap) float.wrap = 'square';
  const grouped = {type: 'group', w, h, float, ch_w: w, ch_h: h, children};
  // Take the members out, last first so the earlier positions hold, and put the group where the first one was.
  for (const f of [...picks].reverse()) S.d.deleteRange(f.pos, {...f.pos, off: f.pos.off + OBJ_LEN});
  const at = S.d.clamp(picks[0].pos);
  const end = S.d.insertObject(at, grouped, {});
  S.sel = {anchor: {...at}, focus: end};
  const out = finish(ctx, S, {edit: true, result: {object: grouped}});
  return out;
}

function ungroup(ctx) {
  const {S, pos, obj} = target(ctx, o => (o.type === 'group' ? (P.isCanvas(o) ? "a drawing canvas can't be ungrouped" : null) : 'select a group first'), 'select a group first');
  const hit = shownRect(ctx, pos);
  if (!hit) throw failed("the object isn't laid out");
  const float = obj.float ?? P.defaultFloat();
  const wrap = (float.wrap ?? 'inline') === 'inline' ? 'square' : float.wrap;
  // Each member where the group shows it, on the page.
  const members = P.groupRects(obj, hit.rect.x, hit.rect.y, hit.rect.w, hit.rect.h).map(([[x, y, w, h], c]) => {
    const own = c.float ?? P.defaultFloat();
    const f = {...P.defaultFloat(), ...float, wrap, hRel: 'page', vRel: 'page', x: clamp(x, -MAX_OFFSET, MAX_OFFSET), y: clamp(y, -MAX_OFFSET, MAX_OFFSET),
      ...(own.alt ? {alt: own.alt} : {}), ...(own.rot ? {rot: own.rot} : {}), ...(own.flipH ? {flipH: true} : {}), ...(own.flipV ? {flipV: true} : {})};
    delete f.hAlign; delete f.vAlign;
    if (!own.rot) delete f.rot;
    if (!own.flipH) delete f.flipH;
    if (!own.flipV) delete f.flipV;
    if (!own.alt) delete f.alt;
    return P.setObjectSize({...c, float: f}, Math.max(w, 4), Math.max(h, 4));
  });
  if (!members.length) throw failed('the group is empty');
  S.d.deleteRange(pos, {...pos, off: pos.off + OBJ_LEN});
  let at = S.d.clamp(pos);
  const placed = [];
  for (const m of members) { placed.push({...at, path: [...at.path]}); at = S.d.insertObject(at, m, {}); }
  const out = finish(ctx, S, {edit: true, result: {objects: members.length}});
  // They stay selected, so Group puts them back together.
  const S2 = open(ctx);
  selectPicks(ctx, S2, placed);
  return out;
}

// ---- Selection Pane, Move with Text, Distribute ----------------------------------------------------------------

function objectList(ctx) {
  const S = open(ctx);
  const picked = pickedAll(S).map(h => h.pos);
  return allObjects(S).map(({pos, obj}, index) => {
    const [kind, name] = objectName(obj, index);
    return {index, kind, name, pos: {story: pos.story, path: pos.path, off: pos.off}, size: [obj.w ?? 0, obj.h ?? 0], hidden: !!obj.float?.hidden, selected: picked.some(q => samePlace(q, pos))};
  });
}

/** The top of the paragraph an object is anchored in: its first line on the page (the hit's origin when it isn't found). */
function paragraphTop(ctx, pos, hit) {
  const page = layoutFor(ctx)?.pages?.[hit.page];
  const first = page?.items.find(it => it.kind === 'lines' && it.story === pos.story && it.l0 === 0 && it.path.length === pos.path.length && it.path.every((v, i) => v === pos.path[i]));
  return first ? first.y : hit.origin.y;
}

function moveWithText(ctx, p) {
  const withText = p.value ?? true;
  const {S, pos, obj} = target(ctx, o => (P.isFloating(o) ? (o.type === 'graphic' && !o.graphic?.chart ? FROZEN : null) : 'select a floating picture or shape first'), 'select a floating picture or shape first');
  const f0 = obj.float ?? P.defaultFloat();
  if (movesWithText(f0) === withText) return finish(ctx, S, {result: {object: obj}});
  const hit = objectHit(ctx, pos);
  if (!hit) throw failed("the object isn't laid out");
  // Paragraph offsets start at the paragraph's top, page offsets at the page's.
  const y = withText ? hit.rect.y - paragraphTop(ctx, pos, hit) : hit.rect.y;
  const next = editAt(S, pos, o => {
    const f = {...(o.float ?? P.defaultFloat()), vRel: withText ? 'paragraph' : 'page', y: clamp(y, -MAX_OFFSET, MAX_OFFSET)};
    delete f.vAlign;
    return {...o, float: f};
  });
  return finish(ctx, S, {edit: true, result: {object: next}});
}

/** Distribute Horizontally / Vertically: three or more objects spaced evenly between the outer two. */
function distribute(ctx, p) {
  const S = open(ctx);
  const picks = pickedAll(S);
  if (picks.length < 3) throw disabled('select three or more pictures or shapes first (Shift+click)');
  const horiz = p.axis !== 'vertical';
  const rects = picks.map(h => {
    const hit = shownRect(ctx, h.pos);
    if (!hit) throw failed("an object isn't laid out");
    if (!P.isFloating(h.obj)) throw disabled('objects in line with text can\'t be distributed: choose a text wrapping for them first');
    return {...h, hit};
  });
  const key = r => (horiz ? r.hit.rect.x : r.hit.rect.y), size = r => (horiz ? r.hit.rect.w : r.hit.rect.h);
  rects.sort((a, b) => key(a) - key(b));
  const start = key(rects[0]), end = key(rects[rects.length - 1]) + size(rects[rects.length - 1]);
  const gap = (end - start - rects.reduce((n, r) => n + size(r), 0)) / (rects.length - 1);
  let at = start;
  for (const r of rects) {
    const to = at;
    at += size(r) + gap;
    editAt(S, r.pos, o => {
      const f = {...(o.float ?? P.defaultFloat()), hRel: 'page', vRel: 'page', x: r.hit.rect.x, y: r.hit.rect.y};
      delete f.hAlign; delete f.vAlign;
      if (horiz) f.x = to; else f.y = to;
      return {...o, float: f};
    });
  }
  const out = finish(ctx, S, {edit: true, result: {distributed: rects.length}});
  selectPicks(ctx, open(ctx), picks.map(h => h.pos));
  return out;
}

const groupState = ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try { return pickedAll(open(ctx)).length >= 2 ? {enabled: true} : {enabled: false, reason: 'select two or more pictures or shapes first (Shift+click)'}; } catch { return {enabled: false, reason: NO_OBJECT}; }
};
const NONE = s.object({});
const POS = s.any();

export default defineCommands({
  family: 'objects/group',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'select.addObject', label: 'Add Object to Selection', risk: 'read', effect: 'view', state: ctx => ready(ctx),
      description: 'Add Object to Selection (Shift+click a picture or shape): `pos`, `index` (its Selection Pane index) or `objects`; the first becomes the selection if no object is; one already picked is taken out again.',
      params: s.object({pos: s.optional(POS), index: s.optional(s.integer({min: 0})), objects: s.optional(s.array(POS, {max: 1000}))}),
      run: addObject},
    {id: 'select.objects', label: 'Select Objects', risk: 'read', effect: 'view', state: ctx => ready(ctx),
      description: 'Select Objects: the drawing with Selection Pane `index` (default 0).',
      params: s.object({index: s.optional(s.integer({min: 0}))}),
      run(ctx, p) {
        const S = open(ctx);
        const hit = allObjects(S)[p.index ?? 0];
        if (!hit) throw failed('no such object');
        selectPicks(ctx, S, [hit.pos]);
        return {selected: 1};
      }},
    {id: 'arrange.group', label: 'Group', risk: 'edit', state: groupState,
      description: 'Group (Layout › Arrange): the selected floating pictures, shapes and text boxes (Shift+click, select.addObject) become one floating group where the first was, in the box around them; they keep their places and sizes.',
      params: NONE, run: group},
    {id: 'arrange.ungroup', label: 'Ungroup', risk: 'edit', state: stateFor(o => (o.type === 'group' ? (P.isCanvas(o) ? "a drawing canvas can't be ungrouped" : null) : 'select a group first'), 'select a group first'),
      description: 'Ungroup (Layout › Arrange): the selected group splits back into its pictures and shapes, where it shows them; they stay selected.',
      params: NONE, run: ungroup},
    {id: 'arrange.selectionPane', label: 'Selection Pane', risk: 'read', effect: 'view',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.selectionPane} : r; },
      description: 'Selection Pane (Layout › Arrange): shows or hides the pane (`value` sets it) and lists the pictures and shapes: [{index, kind, name, pos, size, hidden, selected}].',
      params: s.object({value: s.optional(s.boolean())}),
      run(ctx, p) {
        const on = p.value ?? !ctx.view?.selectionPane;
        ctx.setView({selectionPane: on});
        return {value: on, objects: objectList(ctx)};
      }},
    {id: 'arrange.objects', label: 'Objects', risk: 'read', effect: 'view', state: ctx => { const r = ready(ctx); return r.enabled ? {...r, value: (() => { try { return objectList(ctx); } catch { return []; } })()} : r; },
      description: 'The pictures and shapes of the body in the Selection Pane\'s order: [{index, kind, name, pos, size, hidden, selected}].',
      params: NONE, run: objectList},
    {id: 'object.hide', label: 'Show or Hide Object', risk: 'edit',
      state: ctx => ready(ctx),
      description: 'Selection Pane eye: `index` (its Selection Pane index) is hidden or shown (`value`, default toggles). Not in wordcraft.',
      params: s.object({index: s.integer({min: 0}), value: s.optional(s.boolean())}),
      run(ctx, p) {
        const S = open(ctx);
        const hit = allObjects(S)[p.index];
        if (!hit) throw failed('no such object');
        const hide = p.value ?? !hit.obj.float?.hidden;
        const next = editAt(S, hit.pos, o => { const f = {...(o.float ?? P.defaultFloat())}; if (hide) f.hidden = true; else delete f.hidden; return {...o, float: f}; });
        return finish(ctx, S, {edit: true, result: {object: next, hidden: hide}});
      }},
    {id: 'arrange.moveWithText', label: 'Move with Text', risk: 'edit',
      state: stateFor(o => (P.isFloating(o) ? null : 'select a floating picture or shape first'), 'select a floating picture or shape first', o => ({checked: movesWithText(o.float)})),
      description: 'Move with Text / Fix Position on Page (Layout › Arrange › Wrap Text): `value` true anchors the floating object\'s vertical position to its paragraph, false to the page; it stays where it is.',
      params: s.object({value: s.optional(s.boolean())}),
      run: moveWithText},
    {id: 'arrange.distribute', label: 'Distribute', risk: 'edit', state: groupState,
      description: 'Distribute Horizontally / Vertically (Layout › Arrange › Align): three or more selected floating objects spaced evenly (`axis` horizontal or vertical) between the outer two. Not in wordcraft.',
      params: s.object({axis: s.optional(s.enum(['horizontal', 'vertical']))}),
      run: distribute},
  ],
});
void samePos; void selectedIn; void fin;
