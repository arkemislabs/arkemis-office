// Layout › Arrange (and the same controls on Picture Format / Shape Format): wrap text, wrap sides,
// position, bring forward, send backward, align and rotate the selected picture, shape or text box.
//
// Translated from wordcraft crates/engine/src/cmd/objects/specs.rs (`arrange.rotate`,
// `arrange.rotation`, `arrange.wrap`, `arrange.wrapText`, `arrange.position`,
// `arrange.bringForward`, `arrange.sendBackward`, `arrange.align`) and objects/select.rs
// (`has_object`, `has_movable`, `FROZEN`, `selected`, `obj_size`, `with_obj`, `edit_obj`,
// `with_float`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Each command changes the selected object's float (one undoable op); the page view lays the
// object out again (core/quill/layout/floats.mjs: every anchor, square/top-and-bottom/behind/in
// front wrapping, wrap sides, rotated bounds). As upstream, Bring Forward puts the object in front
// of the text and Send Backward behind it.
//
// arrange.moveWithText, selectionPane, group, ungroup and distribute are in objects/group.mjs. Not registered
// (hidden): arrange.bounds / copyTo / nudge (the surface's drag handles). Align takes `to`: margin (upstream's),
// page, or objects (the selected ones to each other: Word's Align Selected Objects, not in wordcraft).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {open, finish, ready, ordered, UPSTREAM_COMMIT} from '../../lib/caret-session.mjs';
import {selectedObjects} from '../../context.mjs';
import * as P from '../../model/para.mjs';
import {Spin, normalizeDegrees} from '../../lib/geom.mjs';
import {sectAt} from '../page.mjs';
import {pickedAll, objectHit, selectPicks} from '../../lib/object-edit.mjs';
import {spinBounds} from '../../layout/floats.mjs';
import {textWidth, textHeight} from '../../model/section.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/objects/specs.rs', 'crates/engine/src/cmd/objects/select.rs']};

/** Diagrams made by another program are kept whole and can't be moved, resized or arranged. Charts and SmartArt made here are. */
export const FROZEN = "diagrams can't be moved or resized yet";
const MAX_OFFSET = 31680;
export const POSITIONS = Object.freeze(['topLeft', 'topCenter', 'topRight', 'middleLeft', 'middleCenter', 'middleRight', 'bottomLeft', 'bottomCenter', 'bottomRight']);
export const ROTATIONS = Object.freeze(['right', 'left', 'flipVertical', 'flipHorizontal', 'flipH', 'flipV']);

const disabled = reason => new CommandError('disabled', reason);

/** The first picture or shape in the selection, or just before / at a collapsed caret (selected). */
function selected(d, sel) {
  const [a, b] = ordered(sel);
  if (a.story !== b.story) return null;
  return selectedObjects(d.content, a, b, 1)[0] ?? null;
}

/** has_movable: a picture, shape, text box or group is selected (charts and diagrams are frozen). */
function movableReason(d, sel) {
  const hit = selected(d, sel);
  if (!hit) return 'select a picture or shape first';
  if (hit.obj.type === 'graphic' && !hit.obj.graphic?.chart && !hit.obj.graphic?.smartArt) return FROZEN;
  return null;
}

function stateMovable(ctx) {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try {
    const d = ctx.model.open(ctx);
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    const reason = movableReason(d, {anchor: r.anchor, focus: r.focus});
    return reason ? {enabled: false, reason} : {enabled: true};
  } catch { return {enabled: false, reason: 'select a picture or shape first'}; }
}

/** with_float: change the selected object's float; a newly wrapped object gets Word's 0.125" side distance. */
function withFloat(ctx, f) {
  const S = open(ctx);
  const reason = movableReason(S.d, S.sel);
  if (reason) throw disabled(reason);
  const {pos, obj} = selected(S.d, S.sel);
  const size = [obj.w ?? 0, obj.h ?? 0];
  const para = S.d.paraMut(pos.story, pos.path);
  const cur = P.objectAt(para, pos.off);
  if (!cur) throw new CommandError('failed', 'object vanished');
  const float = {...P.defaultFloat(), ...(cur.float ?? {})};
  const wasInline = float.wrap === 'inline';
  f(float, size, S);
  if (wasInline && float.wrap !== 'inline' && !float.dist) float.dist = 9;
  const next = {...cur, float};
  P.setObjectAt(para, pos.off, next);
  return finish(ctx, S, {edit: true, result: {object: next}});
}

/** Whether a float has the selected wrap (for the menus' check marks). */
function wrapState(ctx, p, test) {
  const st = stateMovable(ctx);
  if (!st.enabled || !p) return st;
  try {
    const d = ctx.model.open(ctx);
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    const hit = selected(d, {anchor: r.anchor, focus: r.focus});
    return {enabled: true, checked: !!(hit && test(hit.obj.float ?? P.defaultFloat()))};
  } catch { return st; }
}

/** Align Selected Objects: the picked objects' edges (or centres) to each other, on the page (not in wordcraft: follows Word). */
function alignObjects(ctx, h, vertical) {
  const S = open(ctx);
  const picks = pickedAll(S);
  if (picks.length < 2) throw disabled('select two or more pictures or shapes first (Shift+click)');
  const rects = picks.map(k => {
    const hit = objectHit(ctx, k.pos);
    if (!hit) throw new CommandError('failed', "an object isn't laid out");
    return {...k, hit, b: spinBounds(hit.rect, hit.rot)};
  });
  const lo = Math.min(...rects.map(r => (vertical ? r.b.y : r.b.x))), hi = Math.max(...rects.map(r => (vertical ? r.b.y + r.b.h : r.b.x + r.b.w)));
  for (const r of rects) {
    const size = vertical ? r.b.h : r.b.w, start = vertical ? r.b.y : r.b.x;
    const want = h === 'left' || h === 'top' ? lo : h === 'right' || h === 'bottom' ? hi - size : (lo + hi) / 2 - size / 2;
    const d = want - start;
    const S2 = S;
    const para = S2.d.paraMut(r.pos.story, r.pos.path);
    const cur = P.objectAt(para, r.pos.off);
    const float = {...P.defaultFloat(), ...(cur.float ?? {}), hRel: 'page', vRel: 'page', x: r.hit.rect.x, y: r.hit.rect.y};
    delete float.hAlign; delete float.vAlign;
    if (float.wrap === 'inline') float.wrap = 'square';
    if (vertical) float.y += d; else float.x += d;
    P.setObjectAt(para, r.pos.off, {...cur, float});
  }
  const out = finish(ctx, S, {edit: true, result: {aligned: rects.length}});
  selectPicks(ctx, open(ctx), picks.map(k => k.pos));
  return out;
}

export default defineCommands({
  family: 'objects/arrange',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'arrange.wrap', label: 'Wrap Text', risk: 'edit',
      description: 'Wrap Text (Layout › Arrange): inline, square, tight, through, topAndBottom, behindText or inFrontOfText for the selected picture, shape or text box.',
      params: s.object({wrap: s.optional(s.enum(P.WRAPS))}),
      state: (ctx, p) => (p?.wrap ? wrapState(ctx, p, f => (f.wrap ?? 'inline') === p.wrap) : stateMovable(ctx)),
      run: (ctx, p) => withFloat(ctx, f => { f.wrap = p.wrap ?? 'square'; }),
    },
    {
      id: 'arrange.wrapText', label: 'Wrap Text Sides', risk: 'edit',
      description: 'Wrap Text Sides: bothSides, left, right or largest — the sides of the selected Square, Tight or Through object text flows on.',
      params: s.object({side: s.optional(s.enum(P.WRAP_TEXTS))}),
      state: (ctx, p) => (p?.side ? wrapState(ctx, p, f => (f.wrapText ?? 'bothSides') === p.side) : stateMovable(ctx)),
      run: (ctx, p) => withFloat(ctx, f => { f.wrapText = p.side ?? 'bothSides'; }),
    },
    {
      id: 'arrange.position', label: 'Position', risk: 'edit',
      description: 'Position (Layout › Arrange): the selected object on the page at a preset (topLeft … bottomRight, default middleCenter) with square wrapping, relative to the margins, or at x/y points from them.',
      params: s.object({preset: s.optional(s.enum(POSITIONS)), x: s.optional(s.number()), y: s.optional(s.number())}),
      state: stateMovable,
      run(ctx, p) {
        const preset = p.preset ?? 'middleCenter';
        return withFloat(ctx, (f, [w, h], S) => {
          const sect = sectAt(S.d, S.sel);
          if (f.wrap === 'inline') f.wrap = 'square';
          f.hRel = 'margin'; f.vRel = 'margin';
          delete f.hAlign; delete f.vAlign;
          const tw = textWidth(sect), th = textHeight(sect);
          const col = preset.endsWith('Left') ? 0 : preset.endsWith('Right') ? tw - w : (tw - w) / 2;
          const row = preset.startsWith('top') ? 0 : preset.startsWith('bottom') ? th - h : (th - h) / 2;
          f.x = Number.isFinite(p.x) ? p.x : col;
          f.y = Number.isFinite(p.y) ? p.y : row;
        });
      },
    },
    {
      id: 'arrange.bringForward', label: 'Bring Forward', risk: 'edit',
      description: 'Bring Forward (Layout › Arrange): the selected object in front of the text.',
      params: s.object({toFront: s.optional(s.boolean())}),
      state: stateMovable,
      run: ctx => withFloat(ctx, f => { f.wrap = 'inFrontOfText'; }),
    },
    {
      id: 'arrange.sendBackward', label: 'Send Backward', risk: 'edit',
      description: 'Send Backward (Layout › Arrange): the selected object behind the text.',
      params: s.object({toBack: s.optional(s.boolean())}),
      state: stateMovable,
      run: ctx => withFloat(ctx, f => { f.wrap = 'behindText'; }),
    },
    {
      id: 'arrange.align', label: 'Align', risk: 'edit',
      description: 'Align (Layout › Arrange): the selected object at the left, centre or right of the margins (it floats with square wrapping); top, middle and bottom place it at the top, middle or bottom. `to`: margin (default), page, or objects (several selected objects aligned to each other).',
      params: s.object({value: s.optional(s.enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])), to: s.optional(s.enum(['margin', 'page', 'objects']))}),
      state: stateMovable,
      run(ctx, p) {
        const h = p.value ?? 'center';
        const vertical = h === 'top' || h === 'middle' || h === 'bottom';
        const to = p.to ?? ctx.view?.alignTo ?? (pickedAll(open(ctx)).length >= 2 ? 'objects' : 'margin');
        if (to === 'objects') return alignObjects(ctx, h, vertical);
        const page = to === 'page';
        return withFloat(ctx, (f, [w, oh], S) => {
          const sect = sectAt(S.d, S.sel);
          if (f.wrap === 'inline') f.wrap = 'square';
          if (vertical) {
            // Word's Align Top/Middle/Bottom: the vertical counterpart of upstream's left/centre/right.
            const th = page ? sect.pageH : textHeight(sect);
            f.vRel = page ? 'page' : 'margin';
            delete f.vAlign;
            f.y = h === 'top' ? 0 : h === 'bottom' ? th - oh : (th - oh) / 2;
            return;
          }
          const tw = page ? sect.pageW : textWidth(sect);
          f.hRel = page ? 'page' : 'margin';
          delete f.hAlign;
          f.x = h === 'left' ? 0 : h === 'right' ? tw - w : (tw - w) / 2;
        });
      },
    },
    {
      id: 'arrange.layout', label: 'Layout', risk: 'edit',
      description: 'Layout dialog (More Layout Options…): the selected object\'s wrapping (`wrap`, `wrapText`), distances from text (`dist` left and right, `distTop`, `distBottom`) and position, in one step: horizontally either aligned (`hAlign` start, center, end, inside, outside) or at `x` points, both from `hRel` (margin, page, column, character, leftMargin, rightMargin, insideMargin, outsideMargin); vertically `vAlign` or `y` from `vRel` (margin, page, paragraph, line, topMargin, bottomMargin, insideMargin, outsideMargin). The position is left alone while the object is in line with text.',
      params: s.object({wrap: s.optional(s.enum(P.WRAPS)), wrapText: s.optional(s.enum(P.WRAP_TEXTS)), dist: s.optional(s.number({min: 0, max: 1584})), distTop: s.optional(s.number({min: 0, max: 1584})), distBottom: s.optional(s.number({min: 0, max: 1584})),
        hRel: s.optional(s.enum(P.ANCHORS)), hAlign: s.optional(s.enum(P.FLOAT_ALIGNS)), x: s.optional(s.number({min: -MAX_OFFSET, max: MAX_OFFSET})),
        vRel: s.optional(s.enum(P.ANCHORS)), vAlign: s.optional(s.enum(P.FLOAT_ALIGNS)), y: s.optional(s.number({min: -MAX_OFFSET, max: MAX_OFFSET}))}),
      state: stateMovable,
      run: (ctx, p) => withFloat(ctx, f => {
        if (p.wrap !== undefined) f.wrap = p.wrap;
        if (p.wrapText !== undefined) f.wrapText = p.wrapText;
        for (const k of ['dist', 'distTop', 'distBottom']) if (p[k] !== undefined) f[k] = p[k];
        if (f.wrap === 'inline') return;
        if (p.hRel !== undefined) f.hRel = p.hRel;
        if (p.hAlign !== undefined) { f.hAlign = p.hAlign; } else if (p.x !== undefined) { delete f.hAlign; f.x = p.x; }
        if (p.vRel !== undefined) f.vRel = p.vRel;
        if (p.vAlign !== undefined) { f.vAlign = p.vAlign; } else if (p.y !== undefined) { delete f.vAlign; f.y = p.y; }
      }),
    },
    {
      id: 'arrange.alignTo', label: 'Align To', risk: 'read', effect: 'view',
      description: 'Align to Page / Align to Margin / Align Selected Objects (Layout › Arrange › Align): what the Align commands align to from now on (`to`: page, margin or objects).',
      params: s.object({to: s.enum(['margin', 'page', 'objects'])}),
      state: (ctx, p) => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: (ctx.view?.alignTo ?? null) === (p?.to ?? null)} : r; },
      run(ctx, p) { ctx.setView({alignTo: p.to}); return {to: p.to}; },
    },
    {
      id: 'arrange.rotate', label: 'Rotate', risk: 'edit',
      description: 'Rotate (Layout › Arrange): turn the selected picture, shape or text box 90° right or left, or mirror it (its pixels are kept).',
      params: s.object({direction: s.optional(s.enum(ROTATIONS))}),
      state: stateMovable,
      run(ctx, p) {
        const dir = p.direction ?? 'right';
        const by = dir === 'left' ? new Spin(270, false, false) : dir === 'flipHorizontal' || dir === 'flipH' ? new Spin(0, true, false)
          : dir === 'flipVertical' || dir === 'flipV' ? new Spin(0, false, true) : new Spin(90, false, false);
        return withFloat(ctx, f => {
          const cur = new Spin(f.rot ?? 0, !!f.flipH, !!f.flipV);
          const next = cur.within(by);
          f.rot = normalizeDegrees(next.deg);
          if (next.flipH) f.flipH = true; else delete f.flipH;
          if (next.flipV) f.flipV = true; else delete f.flipV;
        });
      },
    },
    {
      id: 'arrange.rotation', label: 'Rotation', risk: 'edit',
      description: 'Rotation: the exact clockwise angle of the selected picture, shape or text box (normalised to 0–360), and its flips.',
      params: s.object({degrees: s.number(), flipH: s.optional(s.boolean()), flipV: s.optional(s.boolean())}),
      state(ctx) {
        const st = stateMovable(ctx);
        if (!st.enabled) return st;
        try {
          const all = ctx.model.selection(ctx);
          const r = all[ctx.selection?.primary ?? 0] ?? all[0];
          const hit = selected(ctx.model.open(ctx), {anchor: r.anchor, focus: r.focus});
          return {enabled: true, value: normalizeDegrees(hit?.obj?.float?.rot ?? 0)};
        } catch { return st; }
      },
      run: (ctx, p) => withFloat(ctx, f => {
        f.rot = normalizeDegrees(p.degrees);
        const fh = p.flipH ?? !!f.flipH, fv = p.flipV ?? !!f.flipV;
        if (fh) f.flipH = true; else delete f.flipH;
        if (fv) f.flipV = true; else delete f.flipV;
      }),
    },
  ],
});
