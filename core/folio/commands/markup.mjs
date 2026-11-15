// Text markup (Highlight, Underline, Strikethrough, Squiggly), freehand drawing with the pen and
// the highlighter, and the edits every comment goes through on the page (move, resize, reshape,
// restyle, change its text, delete).
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:258-262   catalog ids and labels comment.highlight, .underline,
//                                           .strikeout, .squiggly, .ink, needs Annotate
//   crates/ui-egui/src/commands.rs:452-470  picking a comment tool: the tool becomes the quick tool,
//                                           and a text selection made before picking a markup tool
//                                           is marked right away, then cleared
//   crates/ui-egui/src/tools/comments/input.rs:317 (page_after_text) a markup tool turns a finished
//                                           selection into a comment; draw_shape: Ink strokes
//   crates/ui-egui/src/canvas/selection.rs:57 selection_quads: one view rect per selected piece of
//                                           a line → a user-space quad (view_rect_to_quad)
//   crates/annot/src/create.rs, modify.rs   add_annotation, move_annotation, set_rect, set_points,
//                                           set_style, set_contents, delete_annotation (+ replies)
//   crates/engine/src/edit/labels.rs:199-221 undo labels ("Add highlight", "Move comment", ...)
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: Highlight text etc. are tools; with text selected they mark it at once, one quad per
//    line (QuadPoints in Acrobat's order), as a real Highlight/Underline/StrikeOut/Squiggly
//    annotation with a generated appearance (Highlight drawn with Multiply), listed in the comments
//    list; colour and opacity are edited later (set_style). Acrobat does the same. Draw freehand
//    makes an Ink annotation with smoothed strokes. Acrobat's highlighter pen is that ink drawn
//    with Multiply at a fixed broad nib; ours is Ink with /AKHighlighter, Multiply in its
//    appearance, width 12 pt, pressure-insensitive.
// 2. Same here, end to end: the commands write comment records (model/annots.mjs), the surface
//    paints them from the same appearance stream the writer saves (model/pdf-write.mjs).
// 3. Proved by tests/folio/markup*.test.mjs (engine, save → reopen → dictionaries) and
//    tests/e2e/folio/surface-markup.e2e.mjs (window, bridge, capture).
//
// Geometry in params is in the bridge convention (docs/architecture.md 14.5): points, origin at
// the top-left of the displayed page (crop box, rotation applied).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {parseTextRange} from '../../kernel/address.mjs';
import {createAnnotation, findAnnot, moveAnnotation, setRect, setPoints, setStyle, setContents, withReplies, summaries, props, isLocked,
  subtypeOfRecord, rectOf} from '../model/annots.mjs';
import {defaultStyle, MARKUP, HIGHLIGHTER_WIDTH} from '../model/types.mjs';
import {annotateState, meta, author, toolStyle, rangeQuads, pageText} from '../model/index.mjs';
import {viewToUser, viewRectToQuad, pageRotation, userRectToView} from '../lib/geom.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/comments/input.rs',
    'crates/ui-egui/src/canvas/selection.rs', 'crates/annot/src/create.rs', 'crates/annot/src/modify.rs', 'crates/annot/src/info.rs',
    'crates/engine/src/edit/labels.rs']};

const color = s.optional(s.color({description: 'Color like #FFF000 (default: the tool\'s color)'}));
const opacity = s.optional(s.number({min: 0.1, max: 1, description: 'Opacity 0.1–1 (10–100 %)'}));
const point = s.array(s.number(), {min: 2, max: 2});
const rgbOf = hex => { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const pages = ctx => ctx.doc?.pages ?? [];
const pageAddress = page => `/pg:${encodeURIComponent(page.id)}`;
const annotAddress = (page, r) => `${pageAddress(page)}/annot:${encodeURIComponent(r.id)}`;

function pageIndexById(ctx, id) {
  const i = pages(ctx).findIndex(p => p.id === id);
  if (i < 0) throw new CommandError('not_found', `page ${id} does not exist`, {page: id});
  return i;
}

/** The text range to mark: `/pg:<id>/chars:a-b`, else the selection's text. null when nothing is selected. */
function textTarget(ctx, address) {
  const parsePart = a => {
    const m = /^\/pg:([^/]+)\/chars:(\d+)(?:-(\d+))?$/.exec(String(a ?? ''));
    return m ? {pageId: decodeURIComponent(m[1]), ...parseTextRange(m[3] === undefined ? m[2] : `${m[2]}-${m[3]}`)} : null;
  };
  if (address) {
    const t = parsePart(address);
    if (!t) throw new CommandError('invalid_params', 'text must be a page text range /pg:<id>/chars:<from>-<to>', {path: '/text'});
    return t;
  }
  const sel = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  if (!sel) return null;
  const a = parsePart(sel.anchor), f = parsePart(sel.focus);
  if (!a || !f || a.pageId !== f.pageId) return null;
  const from = Math.min(a.from, f.from, a.to, f.to), to = Math.max(a.from, f.from, a.to, f.to);
  return to > from ? {pageId: a.pageId, from, to} : null;
}

/** canvas/selection.rs `selection_quads` for a text range. */
async function quadsForText(ctx, target) {
  const pi = pageIndexById(ctx, target.pageId);
  const page = pages(ctx)[pi];
  const text = await pageText(ctx.doc, page);
  const g = text.glyphRange(target.from, target.to);
  if (!g) throw new CommandError('invalid_params', 'the selected range holds no text', {path: '/text'});
  return {pi, page, quads: rangeQuads(page, text, g[0], g[1])};
}

const toolChecked = (ctx, id, extra = () => true) => ctx.view?.tool === id && extra(ctx.view);

function markup(id, label, kind, undoLabel) {
  return {
    id, label, risk: 'edit', needs: 'worker',
    description: `${label}: mark the selected text (or \`text\`, or \`page\` + \`rects\`) with a ${MARKUP[kind]} comment that follows the text lines; with nothing to mark, picks the tool.`,
    params: s.object({
      text: s.optional(s.address('text', {description: 'Page text range /pg:<id>/chars:<from>-<to> (default: the text selection)'})),
      page: s.optional(s.string({min: 1, max: 120, description: 'Page id, with rects'})),
      rects: s.optional(s.array(s.array(s.number(), {min: 4, max: 4}), {min: 1, max: 10000, description: 'One [x0,y0,x1,y1] per line in page view points (top-left origin)'})),
      color, opacity,
      contents: s.optional(s.string({max: 100000})),
    }),
    state(ctx) { const st = annotateState(ctx.doc); return {...st, checked: toolChecked(ctx, id)}; },
    async run(ctx, p) {
      let pi, page, quads;
      if (p.rects) {
        if (!p.page) throw new CommandError('invalid_params', 'rects need the page they are on', {path: '/page'});
        pi = pageIndexById(ctx, p.page);
        page = pages(ctx)[pi];
        quads = p.rects.map(r => viewRectToQuad(page, [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]));
      } else {
        const target = textTarget(ctx, p.text);
        // Picked from the UI (no `text`): the tool becomes the quick tool (commands.rs:452), and a
        // selection made before is marked right away; given `text`, only the text is marked.
        if (!p.text) ctx.setView({tool: id, highlighter: false});
        if (!target) return {tool: id};
        ({pi, page, quads} = await quadsForText(ctx, target));
      }
      const shape = {kind: 'TextMarkup', markup: kind, quads};
      const style = toolStyle(ctx, id, shape);
      if (p.color) style.color = rgbOf(p.color);
      if (p.opacity != null) style.opacity = p.opacity;
      const record = createAnnotation({shape, style, contents: p.contents ?? '', author: author(ctx), rotation: pageRotation(page)}, meta(ctx));
      ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
      ctx.setSelection({ranges: [], primary: 0});
      ctx.setUndoLabel(undoLabel);
      return {id: record.id, annotation: annotAddress(page, record), subtype: MARKUP[kind], quads};
    },
  };
}

/** The comment an edit acts on: `annotation`, else the selected comment. */
function target(ctx, address) {
  let addr = address;
  if (!addr) {
    const sel = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
    if (sel && /\/annot:/.test(sel.anchor)) addr = sel.anchor;
  }
  if (!addr) throw new CommandError('invalid_params', 'select a comment first (or pass annotation)', {path: '/annotation'});
  const m = /^\/pg:([^/]+)\/annot:([^/]+)$/.exec(String(addr));
  if (!m) throw new CommandError('invalid_params', 'annotation must be /pg:<id>/annot:<id>', {path: '/annotation'});
  const pi = pageIndexById(ctx, decodeURIComponent(m[1]));
  const page = pages(ctx)[pi];
  const id = decodeURIComponent(m[2]);
  const index = (page.annots ?? []).findIndex(r => r.id === id);
  if (index < 0) throw new CommandError('not_found', `annotation ${id} is not on page ${page.id}`, {address: addr});
  return {pi, page, index, record: page.annots[index]};
}

function targetState(ctx, address) {
  const st = annotateState(ctx.doc);
  if (!st.enabled) return st;
  try { const t = target(ctx, address); return isLocked(t.record) ? {enabled: false, reason: 'the comment is locked'} : {enabled: true}; }
  catch (e) { return {enabled: false, reason: e.message}; }
}

/**
 * modify.rs `deletable` (printcraft 8f16855): a comment goes with its pop-up and its replies, but not while a reply that would go with it is
 * locked (a locked reply can't be deleted on its own, so it does not go with the comment it answers either). Null when it can go.
 */
function lockedReply(ctx, record) {
  const going = withReplies(ctx.doc, [record.id]);
  for (const page of pages(ctx)) {
    for (const r of page.annots ?? []) if (r.id !== record.id && going.has(r.id) && subtypeOfRecord(r) !== 'Popup' && isLocked(r)) return 'a reply to it is locked';
  }
  return null;
}

/** Whether Delete is offered on a comment: not while it, or a reply that would go with it, is locked (modify.rs deletable). */
function deleteState(ctx, address) {
  const st = targetState(ctx, address);
  if (!st.enabled) return st;
  const reason = lockedReply(ctx, target(ctx, address).record);
  return reason ? {enabled: false, reason} : st;
}

const annotationParam = s.optional(s.address('annotation', {description: 'The comment /pg:<id>/annot:<id> (default: the selected comment)'}));
const replace = (ctx, t, next) => ctx.change.set(['pages', t.pi, 'annots', t.index], next);

/** A view-space vector → user space (rotation applied, no offset). */
function userDelta(page, dx, dy) {
  const a = viewToUser(page, 0, 0), b = viewToUser(page, dx, dy);
  return [b[0] - a[0], b[1] - a[1]];
}

export default defineCommands({
  family: 'markup',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    markup('comment.highlight', 'Highlight text', 'Highlight', 'Add highlight'),
    markup('comment.underline', 'Underline text', 'Underline', 'Add underline'),
    markup('comment.strikeout', 'Strikethrough text', 'StrikeOut', 'Add strikethrough'),
    markup('comment.squiggly', 'Squiggly underline text', 'Squiggly', 'Add squiggly underline'),
    {
      id: 'comment.ink', label: 'Draw freehand', risk: 'edit',
      description: 'Draw freehand: an Ink comment from `strokes` on `page` (view points). `highlighter: true` is the highlighter pen (Multiply, fixed 12 pt nib). Without strokes, picks the tool.',
      params: s.object({
        page: s.optional(s.string({min: 1, max: 120})),
        strokes: s.optional(s.array(s.array(point, {min: 1, max: 20000}), {min: 1, max: 500, description: 'Strokes: lists of [x,y] in page view points (top-left origin)'})),
        highlighter: s.optional(s.boolean({description: 'The highlighter pen: Multiply blending, a fixed broad nib'})),
        color, opacity,
        width: s.optional(s.number({min: 0.5, max: 12, description: 'Line width in points (the pen: 0.5–12)'})),
        contents: s.optional(s.string({max: 100000})),
      }),
      state(ctx, p) {
        const st = annotateState(ctx.doc);
        return {...st, checked: toolChecked(ctx, 'comment.ink', v => !!v.highlighter === !!p?.highlighter)};
      },
      run(ctx, p) {
        if (!p.strokes) {
          ctx.setView({tool: 'comment.ink', highlighter: !!p.highlighter});
          return {tool: 'comment.ink', highlighter: !!p.highlighter};
        }
        if (!p.page) throw new CommandError('invalid_params', 'strokes need the page they are on', {path: '/page'});
        const pi = pageIndexById(ctx, p.page);
        const page = pages(ctx)[pi];
        const strokes = p.strokes.map(st => st.map(([x, y]) => viewToUser(page, x, y)));
        const shape = {kind: 'Ink', strokes, highlighter: !!p.highlighter};
        const style = p.highlighter ? {...defaultStyle(shape), ...savedPen(ctx)} : toolStyle(ctx, 'comment.ink', shape);
        if (p.color) style.color = rgbOf(p.color);
        if (p.opacity != null) style.opacity = p.opacity;
        if (p.width != null) style.width = p.width;
        const record = createAnnotation({shape, style, contents: p.contents ?? '', author: author(ctx), rotation: pageRotation(page)}, meta(ctx));
        ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
        ctx.setUndoLabel('Add drawing');
        return {id: record.id, annotation: annotAddress(page, record), subtype: 'Ink', highlighter: !!p.highlighter};
      },
    },
    {
      id: 'annot.move', label: 'Move comment', risk: 'edit',
      description: 'Move a comment (and its pop-up) by dx, dy page view points (modify.rs move_annotation).',
      params: s.object({annotation: annotationParam, dx: s.number({min: -100000, max: 100000}), dy: s.number({min: -100000, max: 100000})}),
      state: (ctx, p) => targetState(ctx, p?.annotation),
      run(ctx, p) {
        const t = target(ctx, p.annotation);
        const [ux, uy] = userDelta(t.page, p.dx, p.dy);
        const next = moveAnnotation(t.record, ux, uy, meta(ctx));
        replace(ctx, t, next);
        return {annotation: annotAddress(t.page, next), rect: userRectToView(t.page, rectOf(next))};
      },
    },
    {
      id: 'annot.resize', label: 'Resize comment', risk: 'edit',
      description: 'Resize a rectangle, oval, text box, stamp or drawing to rect [x,y,w,h] in page view points (modify.rs set_rect).',
      params: s.object({annotation: annotationParam, rect: s.array(s.number(), {min: 4, max: 4})}),
      state: (ctx, p) => targetState(ctx, p?.annotation),
      run(ctx, p) {
        const t = target(ctx, p.annotation);
        const [x, y, w, h] = p.rect;
        const a = viewToUser(t.page, x, y), b = viewToUser(t.page, x + w, y + h);
        const next = setRect(t.record, [a[0], a[1], b[0], b[1]], meta(ctx));
        replace(ctx, t, next);
        return {annotation: annotAddress(t.page, next), rect: userRectToView(t.page, rectOf(next))};
      },
    },
    {
      id: 'annot.reshape', label: 'Reshape comment', risk: 'edit',
      description: "Move a line's ends or the corners of connected lines, a polygon or a cloud: points in page view points (modify.rs set_points).",
      params: s.object({annotation: annotationParam, points: s.array(point, {min: 2, max: 100000})}),
      state: (ctx, p) => targetState(ctx, p?.annotation),
      run(ctx, p) {
        const t = target(ctx, p.annotation);
        const next = setPoints(t.record, p.points.map(([x, y]) => viewToUser(t.page, x, y)), meta(ctx));
        replace(ctx, t, next);
        return {annotation: annotAddress(t.page, next)};
      },
    },
    {
      id: 'annot.style', label: 'Change comment properties', risk: 'edit',
      description: "A comment's color, opacity and line width (modify.rs set_style).",
      params: s.object({annotation: annotationParam, color, opacity: s.optional(s.number({min: 0, max: 1})), width: s.optional(s.number({min: 0, max: 100}))}),
      state: (ctx, p) => targetState(ctx, p?.annotation),
      run(ctx, p) {
        const t = target(ctx, p.annotation);
        if (p.color == null && p.opacity == null && p.width == null) throw new CommandError('invalid_params', 'give a colour, an opacity or a width');
        const next = setStyle(t.record, {color: p.color ? rgbOf(p.color) : null, opacity: p.opacity ?? null, width: p.width ?? null}, meta(ctx));
        replace(ctx, t, next);
        return {annotation: annotAddress(t.page, next), props: props(next)};
      },
    },
    {
      id: 'annot.set_contents', label: 'Edit comment', risk: 'edit',
      description: "Change a comment's text (text boxes are redrawn and re-fitted; modify.rs set_contents).",
      params: s.object({annotation: annotationParam, text: s.string({max: 100000})}),
      state(ctx, p) { const st = annotateState(ctx.doc); if (!st.enabled) return st; try { target(ctx, p?.annotation); return {enabled: true}; } catch (e) { return {enabled: false, reason: e.message}; } },
      run(ctx, p) {
        const t = target(ctx, p.annotation);
        const next = setContents(t.record, p.text, meta(ctx));
        replace(ctx, t, next);
        return {annotation: annotAddress(t.page, next)};
      },
    },
    {
      id: 'annot.delete', label: 'Delete comment', risk: 'edit',
      description: 'Delete a comment with its pop-up and its replies (modify.rs delete_annotation).',
      params: s.object({annotation: annotationParam}),
      state: (ctx, p) => deleteState(ctx, p?.annotation),
      run(ctx, p) {
        const t = target(ctx, p.annotation);
        if (isLocked(t.record)) throw new CommandError('disabled', 'the comment is locked');
        const reply = lockedReply(ctx, t.record);
        if (reply) throw new CommandError('disabled', reply);
        const going = withReplies(ctx.doc, [t.record.id]);
        const removed = [];
        pages(ctx).forEach((page, pi) => {
          const list = page.annots ?? [];
          for (let i = list.length - 1; i >= 0; i--) if (going.has(list[i].id)) { removed.push(list[i].id); ctx.change.splice(['pages', pi, 'annots'], i, 1); }
        });
        ctx.setSelection({ranges: [], primary: 0});
        return {deleted: removed};
      },
    },
    {
      id: 'annot.list', label: 'Comments', risk: 'read',
      description: 'Every comment in the document (the comments list): subtype, author, text, page, rectangle and replies, ordered by page and top edge.',
      params: s.object({page: s.optional(s.string({min: 1, max: 120}))}),
      run(ctx, p) {
        return summaries(ctx.doc).filter(x => !p.page || x.pageId === p.page).map(x => {
          const page = pages(ctx)[x.page];
          return {...x, address: annotAddress(page, {id: x.id}), rect: userRectToView(page, x.rect), quads: undefined, quadCount: x.quads.length};
        });
      },
    },
  ],
});

/** The highlighter pen's saved colour and opacity (prefs.commentStyles['comment.ink.highlighter']); the nib stays fixed. */
function savedPen(ctx) {
  const saved = ctx.prefs?.commentStyles?.['comment.ink.highlighter'];
  const out = {width: HIGHLIGHTER_WIDTH};
  if (Array.isArray(saved?.color) && saved.color.length === 3) out.color = saved.color;
  if (Number.isFinite(saved?.opacity)) out.opacity = Math.min(1, Math.max(0.1, saved.opacity));
  return out;
}

export {textTarget, subtypeOfRecord};
