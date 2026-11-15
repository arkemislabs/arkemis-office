// Comments: the Comments panel, sticky notes, text boxes and callouts, shapes (line, arrow,
// rectangle, oval, polygon, connected lines, cloud), Insert / Replace text, file attachments,
// the eraser, stamps (standard, dynamic, Sign Here and custom from an image), reply threads,
// status, check marks, locking and properties; Flatten, Hide all, Summarize, Export and Import.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:255-282   catalog ids, labels, Needs (Annotate, HasComments,
//                                           Modification, Document)
//   crates/ui-egui/src/commands.rs:440-570  what each id does: a tool becomes the quick tool and
//                                           the Comments panel opens; flatten; import; stamp palette;
//                                           export; summarize dialog; hide all
//   crates/ui-egui/src/tools/comments/input.rs, composer.rs, paint.rs (drawn_shape, erase),
//                                           geometry.rs (text_box_rect, drawn_text_box_rect,
//                                           caret_snap, CARET_SIZE): what a gesture makes
//   crates/annot/src/create.rs, modify.rs   add_annotation, add_text_replacement, add_reply,
//                                           set_review_state, set_marked, set_locked, set_info,
//                                           set_fill, set_font_size, set_style (endings)
//   crates/engine/src/edit/run.rs:329        AddCustomStamp (picture fitted, 200 pt natural size)
//   crates/engine/src/edit/labels.rs:199-331 undo labels
//   crates/ui-egui/src/panels/comments_panel.rs  list, search, filter, sort, threads
//   crates/edit/src/flatten.rs, crates/xfdf, crates/engine/src/comments.rs (lib/comment-pdf.mjs)
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/comment.test.mjs.
//
// Geometry in params is in the bridge convention (docs/architecture.md 14.5): page view points,
// origin at the top-left of the displayed page (crop box, rotation applied).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {createAnnotation, isLocked, rectOf, subtypeOfRecord, replyTo, markReply, setLocked, setInfo, setFill, setFontSize, setStyle,
  eraseInk, withReplies, props, summaries, lineEndingsOf} from '../model/annots.mjs';
import {STAMPS, stampByName, NOTE_ICONS, LINE_ENDINGS, REVIEW_STATES, defaultStyle} from '../model/types.mjs';
import {annotateState, meta, author, toolStyle, pageText} from '../model/index.mjs';
import {viewToUser, userToView, userRectToView, pageRotation, viewSize} from '../lib/geom.mjs';
import {textOf, nameAt, text as pdfText} from '../lib/cos.mjs';
import {pagesOf, pageAt, currentPage, commentAt, annotAddress, rgbOf, textBoxRect, textBoxAt, uprightBox,
  pointParam, rectParam, colorParam, opacityParam, pageParam, annotationParam} from '../lib/comment-geometry.mjs';
import {appendToSource, embedPicture, embedFile, fileSpec, jsonRef, flattenPages, commentSummary, summaryPdf, SUMMARY_SORTS,
  exportXfdf, readXfdf} from '../lib/comment-pdf.mjs';
import {commentThreads, SORTS, STATUSES} from '../lib/comment-panel.mjs';
import {readOther, writeOther, interactive, readState, writeState, stem, baseName} from '../lib/page-files.mjs';
import {materialize, commit} from '../lib/page-source.mjs';
import {readSource} from '../model/pdf-read.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/comments/input.rs',
    'crates/ui-egui/src/tools/comments/composer.rs', 'crates/ui-egui/src/tools/comments/paint.rs', 'crates/ui-egui/src/tools/comments/geometry.rs',
    'crates/annot/src/create.rs', 'crates/annot/src/modify.rs', 'crates/annot/src/info.rs', 'crates/engine/src/edit/run.rs',
    'crates/engine/src/edit/labels.rs', 'crates/ui-egui/src/panels/comments_panel.rs', 'crates/ui-egui/src/tools/stamps_ui.rs',
    'crates/edit/src/flatten.rs', 'crates/xfdf/src/xfdf.rs', 'crates/engine/src/comments.rs']};

/** geometry.rs `CARET_SIZE`. */
const CARET_SIZE = 8;

// ── states (commands.rs Needs) ──────────────────────────────────────────────────────────────

const hasComments = ctx => summaries(ctx.doc ?? {}).some(a => !a.inReplyTo);
/** Needs::HasComments: the document has comments and allows changes. */
function hasCommentsState(ctx) {
  const st = annotateState(ctx.doc ?? {});
  if (!st.enabled) return st;
  return hasComments(ctx) ? {enabled: true} : {enabled: false, reason: 'the document has no comments'};
}
/** Needs::Document. */
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : {enabled: false, reason: 'no PDF open'});
/** Needs::Modification. */
function modificationState(ctx) {
  const st = annotateState(ctx.doc ?? {});
  if (!st.enabled) return st;
  if (ctx.doc?.permissions && ctx.doc.permissions.modify === false) return {enabled: false, reason: "this PDF's permissions don't allow changes"};
  return {enabled: true};
}
const toolChecked = (ctx, id) => ctx.view?.tool === id;

/**
 * commands.rs:451: picking a comment tool makes it the quick tool and opens the Comments panel
 * (unless the person closed it). Returns the result the bridge sees.
 */
function pickTool(ctx, id) {
  ctx.setView({tool: id, highlighter: false});
  if (!ctx.view?.rightPanel && !ctx.view?.commentsPanelClosed) ctx.setView({rightPanel: 'comments'});
  return {tool: id};
}

function addRecord(ctx, pi, page, record, label) {
  ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
  ctx.setUndoLabel(label);
  ctx.setSelection({ranges: [{anchor: annotAddress(page, record), focus: annotAddress(page, record)}], primary: 0});
  return {id: record.id, annotation: annotAddress(page, record), subtype: subtypeOfRecord(record), rect: userRectToView(page, rectOf(record))};
}

function newComment(ctx, pi, page, tool, shape, contents, p = {}, label) {
  const style = toolStyle(ctx, tool, shape);
  if (p.color) style.color = rgbOf(p.color);
  if (p.opacity != null) style.opacity = p.opacity;
  if (p.width != null) style.width = p.width;
  if (p.fill !== undefined) style.fill = p.fill ? rgbOf(p.fill) : null;
  const record = createAnnotation({shape, style, contents: contents ?? '', author: author(ctx), rotation: pageRotation(page)}, meta(ctx));
  return addRecord(ctx, pi, page, record, label);
}

const user = (page, p) => viewToUser(page, p[0], p[1]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** geometry.rs `drawn_box`: displayed top-left (user space) and displayed size of a view rect. */
function drawnBox(page, [x, y, w, h]) {
  return {at: viewToUser(page, Math.min(x, x + w), Math.min(y, y + h)), size: [Math.abs(w), Math.abs(h)]};
}

/** geometry.rs `drawn_text_box_rect`: the text wraps to the drawn width; the box grows down when it must. */
function drawnTextBoxRect(page, rect, txt, fontSize, border, wrapFn) {
  const pad = 2 + Math.max(border, 0);
  const {at, size: [w, drawn]} = drawnBox(page, rect);
  const lines = Math.max(wrapFn(txt, fontSize, Math.max(w - 2 * pad, 1)).length, 1);
  const needed = lines * fontSize * 1.2 + 2 * pad + 2;
  const [vx, vy] = userToView(page, at[0], at[1]);
  const bottom = viewSize(page).height;
  const [top, h] = needed <= drawn || needed > bottom ? [vy, drawn] : [Math.max(0, Math.min(vy, bottom - needed)), needed];
  const at2 = viewToUser(page, vx, top);
  return textBoxAt(pageRotation(page), at2, w, h) ?? [at2[0], at2[1] - h, at2[0] + w, at2[1]];
}

/** geometry.rs `caret_snap` + `snapped_caret`: the caret's tip on the baseline next to the nearest character, and its size. */
async function snappedCaret(ctx, page, vx, vy) {
  if (pageRotation(page) % 360 !== 0) return null;
  let text;
  try { text = await pageText(ctx.doc, page); } catch { return null; }
  const i = text?.nearest?.(vx, vy);
  const g = i == null ? null : text.glyphs[i];
  if (!g || !(g.direction[0] > 0 && Math.abs(g.direction[1]) <= 0.02)) return null;
  const [x0, y0, x1, y1] = g.rect, slack = (y1 - y0) / 2;
  if (!(slack > 0) || vx < x0 - slack || vx > x1 + slack || vy < y0 - slack || vy > y1 + slack) return null;
  const [q0, q1, q2, q3] = g.quad;
  const [foot, head] = vx < (q0[0] + q1[0]) / 2 ? [q0, q3] : [q1, q2];
  const em = Math.hypot(head[0] - foot[0], head[1] - foot[1]);
  if (!(em > 0)) return null;
  const base = [foot[0] + 0.2 * (head[0] - foot[0]), foot[1] + 0.2 * (head[1] - foot[1])];
  const size = Math.min(36, Math.max(4, em / 2));
  const tip = viewToUser(page, base[0], base[1]), footU = viewToUser(page, base[0], base[1] + size);
  const side = tip[1] - footU[1];
  return Number.isFinite(side) && side > 0 ? {at: tip, size: side} : null;
}

/** The comment an edit acts on, unlocked. */
function unlockedTarget(ctx, address) {
  const t = commentAt(ctx, address);
  if (isLocked(t.record)) throw new CommandError('disabled', 'the comment is locked');
  return t;
}
function targetState(ctx, address, {allowLocked = false} = {}) {
  const st = annotateState(ctx.doc ?? {});
  if (!st.enabled) return st;
  try { const t = commentAt(ctx, address); return !allowLocked && isLocked(t.record) ? {enabled: false, reason: 'the comment is locked'} : {enabled: true}; }
  catch (e) { return {enabled: false, reason: e.message}; }
}
const replaceAt = (ctx, t, next) => ctx.change.set(['pages', t.pi, 'annots', t.index], next);

// ── shape tools ────────────────────────────────────────────────────────────────────────────

/** A tool that draws from points (paint.rs `drawn_shape`). */
function shapeTool(id, label, {tool, make, minPoints, maxPoints, undoLabel, describe}) {
  return {
    id, label, risk: 'edit',
    description: `${label}: ${describe} Without points, picks the tool.`,
    params: s.object({
      page: pageParam,
      points: s.optional(s.array(pointParam('[x, y] in page view points'), {min: 1, max: 100000, description: `Points in page view points (top-left origin): ${minPoints}${maxPoints ? `–${maxPoints}` : ' or more'}`})),
      color: colorParam, opacity: opacityParam,
      width: s.optional(s.number({min: 0, max: 12, description: 'Line thickness in points'})),
      fill: s.optional(s.nullable(s.color({description: 'Fill colour (rectangles, ovals, polygons, clouds), null for none'}))),
      start: s.optional(s.enum(LINE_ENDINGS, {description: 'Line ending at the start (lines, connected lines)'})),
      end: s.optional(s.enum(LINE_ENDINGS, {description: 'Line ending at the end (lines, connected lines)'})),
      contents: s.optional(s.string({max: 100000})),
    }),
    state(ctx) { return {...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, id)}; },
    run(ctx, p) {
      if (!p.points) return pickTool(ctx, id);
      const {pi, page} = currentPage(ctx, p.page);
      if (p.points.length < minPoints) throw new CommandError('invalid_params', `${label} needs at least ${minPoints} points`, {path: '/points'});
      if (maxPoints && p.points.length > maxPoints) throw new CommandError('invalid_params', `${label} takes ${maxPoints} points`, {path: '/points'});
      const pts = p.points.map(q => user(page, q));
      const shape = make(pts, p);
      if (!shape) throw new CommandError('invalid_params', `the ${label.toLowerCase()} is too small`, {path: '/points'});
      return newComment(ctx, pi, page, tool, shape, p.contents, p, undoLabel(shape));
    },
  };
}

const lineLabel = sh => (sh.start === 'None' && sh.end === 'OpenArrow' ? 'Add arrow' : 'Add line');

// ── stamps ─────────────────────────────────────────────────────────────────────────────────

/** The stamp palette (stamps_ui.rs): standard stamps by group, custom stamps from prefs. */
function stampPalette(ctx) {
  const groups = {};
  for (const st of STAMPS) (groups[st.group] ??= []).push({name: st.name, label: st.label, kind: st.kind});
  return {dynamic: groups.Dynamic, signHere: groups.SignHere, standardBusiness: groups.StandardBusiness,
    custom: (ctx.prefs?.customStamps ?? []).map(c => ({id: c.id, name: c.name, category: c.category}))};
}

/** fit_picture (run.rs AddCustomStamp): the largest box of the picture's shape inside `rect`, centred. */
function fitPicture(rect, w, h) {
  const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
  const k = Math.min(rw / w, rh / h);
  const fw = w * k, fh = h * k, cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
  return [cx - fw / 2, cy - fh / 2, cx + fw / 2, cy + fh / 2];
}

/**
 * run.rs `AddCustomStamp`: a picture as a Stamp comment (or a Fill & Sign image signature) at
 * `rect` (user space; a zero-size rect = natural size, at most 200 pt, centred there).
 * Returns the record; the picture is appended to the source.
 */
export async function pictureStamp(ctx, page, bytes, rect, {name, author: by, fillSign = false, label = null}) {
  const {sourceBase64, made} = await appendToSource(ctx.doc, doc => embedPicture(doc, bytes));
  const sw = Math.max(made.width, 1), sh = Math.max(made.height, 1);
  const rotation = pageRotation(page);
  const [dw, dh] = rotation === 90 || rotation === 270 ? [sh, sw] : [sw, sh];
  let r;
  if (rect[2] === rect[0] && rect[3] === rect[1]) {
    const k = Math.min(200 / Math.max(sw, sh), 1);
    const [w, h] = [dw * k, dh * k];
    r = [rect[0] - w / 2, rect[1] - h / 2, rect[0] + w / 2, rect[1] + h / 2];
  } else r = fitPicture(rect, dw, dh);
  const m = meta(ctx);
  const d = {Type: '/Annot', Subtype: '/Stamp', Rect: r, Contents: pdfText(''), F: 4, Name: `/${name.replace(/[^A-Za-z0-9]/g, '') || 'Picture'}`,
    PCPicture: jsonRef(made.ref), PCPictureImage: true, Subj: pdfText(label ?? 'Stamp')};
  if (by) d.T = pdfText(by);
  if (m.date) { d.M = pdfText(m.date); d.CreationDate = pdfText(m.date); }
  d.NM = pdfText(m.id);
  if (rotation) d.PCPictureRotate = rotation;
  if (fillSign) d.PCFillSign = true;
  ctx.change.set(['sourceBase64'], sourceBase64);
  return {id: m.id, dict: d, ap: 'build'};
}

// ── commands ───────────────────────────────────────────────────────────────────────────────

const statusParam = s.enum(REVIEW_STATES, {description: 'Review status: None, Accepted, Rejected, Cancelled or Completed'});

export default defineCommands({
  family: 'comment',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'comment.list', label: 'Comments panel', risk: 'read', undo: 'none',
      description: 'Show the Comments panel and list its threads: comments with replies, status and check mark, after search, filter (values to hide) and sort (Page, Author, Date, Type, Color).',
      params: s.object({
        open: s.optional(s.boolean({description: 'Show (true) or hide (false) the panel; default: toggle'})),
        search: s.optional(s.string({max: 1000})),
        sort: s.optional(s.enum(SORTS)),
        filter: s.optional(s.object({
          types: s.optional(s.array(s.string({max: 100}), {max: 100})), authors: s.optional(s.array(s.string({max: 500}), {max: 1000})),
          statuses: s.optional(s.array(s.enum(STATUSES), {max: 5})), colors: s.optional(s.array(s.string({max: 6}), {max: 1000})),
          checks: s.optional(s.array(s.enum(['Checked', 'Unchecked']), {max: 2})),
        })),
      }),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.rightPanel === 'comments'}),
      run(ctx, p) {
        if (!pagesOf(ctx).length) throw new CommandError('disabled', 'no PDF open');
        const shown = ctx.view?.rightPanel === 'comments';
        const open = p.open ?? (p.search != null || p.sort || p.filter ? true : !shown);
        ctx.setView({rightPanel: open ? 'comments' : null, commentsPanelClosed: !open, ...(p.sort ? {commentSort: p.sort} : {})});
        const sort = p.sort ?? ctx.view?.commentSort ?? 'Page';
        const t = commentThreads(ctx.doc, {search: p.search ?? '', filter: p.filter ?? {}, sort});
        const addr = c => annotAddress(pagesOf(ctx)[c.page], c);
        return {open, sort, count: t.count, replyCount: t.replyCount, authors: t.authors, types: t.types, colors: t.colors,
          threads: t.roots.map(r => ({address: addr(r.comment), page: r.comment.page + 1, kind: r.kind, heading: r.heading, author: r.comment.author,
            contents: r.comment.contents, modified: r.comment.modified, status: r.status, marked: r.marked, locked: r.comment.locked,
            replies: r.replies.map(x => ({address: addr(x), author: x.author, contents: x.contents, modified: x.modified})), history: r.history}))};
      },
    },
    {
      id: 'comment.note', label: 'Add a sticky note', risk: 'edit',
      description: 'Add a sticky note at `at` (page view points) with `text`, as the composer posts it (Shape::Note, Comment icon). Without `at`, picks the tool.',
      params: s.object({page: pageParam, at: s.optional(pointParam('[x, y] in page view points')), text: s.optional(s.string({max: 100000})),
        icon: s.optional(s.enum(NOTE_ICONS)), color: colorParam, opacity: opacityParam}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, 'comment.note')}),
      run(ctx, p) {
        if (!p.at) return pickTool(ctx, 'comment.note');
        const {pi, page} = currentPage(ctx, p.page);
        return newComment(ctx, pi, page, 'comment.note', {kind: 'Note', at: user(page, p.at), icon: p.icon ?? 'Comment'}, (p.text ?? '').trimEnd(), p, 'Add sticky note');
      },
    },
    {
      id: 'comment.freetext', label: 'Add a text box', risk: 'edit',
      description: 'Add a text box with `text`: at `at` it fits its text (at most 300 pt wide); with `rect` [x,y,w,h] the text wraps to that width and the box grows down when it must (composer.rs TextBox, 12 pt). Without either, picks the tool.',
      params: s.object({page: pageParam, at: s.optional(pointParam('Top-left corner [x, y] in page view points')), rect: s.optional(rectParam()),
        text: s.optional(s.string({max: 100000})), color: colorParam, opacity: opacityParam,
        fontSize: s.optional(s.number({min: 1, max: 400, description: 'Font size in points (default 12)'}))}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, 'comment.freetext')}),
      async run(ctx, p) {
        if (!p.at && !p.rect) return pickTool(ctx, 'comment.freetext');
        const {pi, page} = currentPage(ctx, p.page);
        const txt = (p.text ?? '').trimEnd();
        if (!txt.trim()) throw new CommandError('invalid_params', 'type the text first', {path: '/text'});
        const size = p.fontSize ?? 12;
        const border = toolStyle(ctx, 'comment.freetext', {kind: 'TextBox'}).width;
        const {wrap} = await import('../lib/fonts.mjs');
        const rect = p.rect ? drawnTextBoxRect(page, p.rect, txt, size, border, wrap) : textBoxRect(user(page, p.at), txt, size, pageRotation(page));
        return newComment(ctx, pi, page, 'comment.freetext', {kind: 'TextBox', rect, fontSize: size}, txt, p, 'Add text box');
      },
    },
    {
      id: 'comment.callout', label: 'Add a callout', risk: 'edit',
      description: 'Add a callout: `point` is what it points at, `at` the text box\'s top-left; the knee sits halfway, level with the box (composer.rs Callout, 10 pt, open arrow). Without them, picks the tool.',
      params: s.object({page: pageParam, point: s.optional(pointParam('[x, y] the leader points at')), at: s.optional(pointParam('Text box top-left [x, y]')),
        text: s.optional(s.string({max: 100000})), color: colorParam, opacity: opacityParam}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, 'comment.callout')}),
      run(ctx, p) {
        if (!p.point || !p.at) return pickTool(ctx, 'comment.callout');
        const {pi, page} = currentPage(ctx, p.page);
        const point = user(page, p.point), at = user(page, p.at);
        if (dist(point, at) < 8) throw new CommandError('invalid_params', 'drag farther: the callout needs room for its leader', {path: '/at'});
        const txt = (p.text ?? '').trimEnd();
        if (!txt.trim()) throw new CommandError('invalid_params', 'type the text first', {path: '/text'});
        const rect = textBoxRect(at, txt, 10, 0);
        const side = point[0] < rect[0] ? rect[0] : point[0] > rect[2] ? rect[2] : (rect[0] + rect[2]) / 2;
        const knee = [(point[0] + side) / 2, (rect[1] + rect[3]) / 2];
        return newComment(ctx, pi, page, 'comment.callout', {kind: 'Callout', rect, knee, point, fontSize: 10, ending: 'OpenArrow'}, txt, p, 'Add callout');
      },
    },
    shapeTool('comment.line', 'Draw a line', {tool: 'comment.line', minPoints: 2, maxPoints: 2, describe: 'a Line comment from the first point to the second.',
      make: (pts, p) => (dist(pts[0], pts[1]) >= 2 ? {kind: 'Line', from: pts[0], to: pts[1], start: p.start ?? 'None', end: p.end ?? 'None'} : null), undoLabel: lineLabel}),
    shapeTool('comment.arrow', 'Draw an arrow', {tool: 'comment.arrow', minPoints: 2, maxPoints: 2, describe: 'a Line comment with an open arrow at its end.',
      make: (pts, p) => (dist(pts[0], pts[1]) >= 2 ? {kind: 'Line', from: pts[0], to: pts[1], start: p.start ?? 'None', end: p.end ?? 'OpenArrow'} : null), undoLabel: lineLabel}),
    shapeTool('comment.square', 'Draw a rectangle', {tool: 'comment.square', minPoints: 2, maxPoints: 2, describe: 'a Square comment between two opposite corners.',
      make: pts => { const r = [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])]; return r[2] - r[0] >= 2 && r[3] - r[1] >= 2 ? {kind: 'Rectangle', rect: r} : null; },
      undoLabel: () => 'Add rectangle'}),
    shapeTool('comment.circle', 'Draw an oval', {tool: 'comment.circle', minPoints: 2, maxPoints: 2, describe: 'a Circle comment inside the box between two opposite corners.',
      make: pts => { const r = [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])]; return r[2] - r[0] >= 2 && r[3] - r[1] >= 2 ? {kind: 'Oval', rect: r} : null; },
      undoLabel: () => 'Add oval'}),
    shapeTool('comment.polygon', 'Draw a polygon', {tool: 'comment.polygon', minPoints: 3, describe: 'a closed Polygon through the points.',
      make: pts => ({kind: 'Polygon', vertices: pts, cloud: false}), undoLabel: () => 'Add polygon'}),
    shapeTool('comment.polyline', 'Draw connected lines', {tool: 'comment.polyline', minPoints: 2, describe: 'a PolyLine through the points.',
      make: (pts, p) => ({kind: 'PolyLine', vertices: pts, start: p.start ?? 'None', end: p.end ?? 'None'}), undoLabel: () => 'Add connected lines'}),
    shapeTool('comment.cloud', 'Draw a cloud', {tool: 'comment.cloud', minPoints: 3, describe: 'a Polygon with a cloudy border (/IT /PolygonCloud).',
      make: pts => ({kind: 'Polygon', vertices: pts, cloud: true}), undoLabel: () => 'Add cloud'}),
    {
      id: 'comment.caret', label: 'Insert text', risk: 'edit', needs: 'worker',
      description: 'Insert text: a Caret comment holding `text` at `at`; next to text it snaps to the nearer edge of the character, on the baseline, sized to the text (geometry.rs caret_snap). Without `at`, picks the tool.',
      params: s.object({page: pageParam, at: s.optional(pointParam('[x, y] in page view points')), text: s.optional(s.string({max: 100000})), color: colorParam}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, 'comment.caret')}),
      async run(ctx, p) {
        if (!p.at) return pickTool(ctx, 'comment.caret');
        const {pi, page} = currentPage(ctx, p.page);
        const txt = (p.text ?? '').trimEnd();
        if (!txt.trim()) throw new CommandError('invalid_params', 'type the text to insert first', {path: '/text'});
        const snapped = await snappedCaret(ctx, page, p.at[0], p.at[1]);
        const {at, size} = snapped ?? {at: user(page, p.at), size: CARET_SIZE};
        const half = size / 2;
        return newComment(ctx, pi, page, 'comment.caret', {kind: 'Caret', rect: [at[0] - half, at[1] - size, at[0] + half, at[1]]}, txt, p, 'Add inserted text');
      },
    },
    {
      id: 'comment.replace', label: 'Replace text', risk: 'edit', needs: 'worker',
      description: 'Replace text: strike out the selected text (or `text`) and add a caret at its end holding the replacement, grouped with the strikeout (/IRT + /RT /Group) so they move, list and delete as one (modify.rs add_text_replacement). Without a selection, picks the tool.',
      params: s.object({text: s.optional(s.address('text', {description: 'Page text range /pg:<id>/chars:<from>-<to> (default: the text selection)'})),
        replacement: s.optional(s.string({max: 100000}))}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, 'comment.replace')}),
      async run(ctx, p) {
        const {textTarget} = await import('./markup.mjs');
        const target = textTarget(ctx, p.text);
        if (!target || p.replacement == null) { if (!p.text) pickTool(ctx, 'comment.replace'); if (!target) return {tool: 'comment.replace'}; }
        if (p.replacement == null) return {tool: 'comment.replace', composer: 'Replacement text'};
        const {pi, page} = pageAt(ctx, target.pageId);
        const {rangeQuads} = await import('../model/index.mjs');
        const text = await pageText(ctx.doc, page);
        const g = text.glyphRange(target.from, target.to);
        if (!g) throw new CommandError('invalid_params', 'select the text to replace first', {path: '/text'});
        const quads = rangeQuads(page, text, g[0], g[1]);
        const last = quads[quads.length - 1];
        const by = author(ctx);
        const strike = createAnnotation({shape: {kind: 'TextMarkup', markup: 'StrikeOut', quads}, style: toolStyle(ctx, 'comment.replace', {kind: 'TextMarkup', markup: 'StrikeOut'}),
          contents: '', author: by, rotation: pageRotation(page)}, meta(ctx));
        strike.dict.IT = '/StrikeOutTextEdit';
        const xs = [last[0], last[2], last[4], last[6]], ys = [last[1], last[3], last[5], last[7]];
        const x = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const h = Math.min(24, Math.max(4, (y1 - y0) * 0.6));
        const caret = createAnnotation({shape: {kind: 'Caret', rect: [x - h / 2, y0 - h * 0.6, x + h / 2, y0 + h * 0.4]}, style: toolStyle(ctx, 'comment.caret', {kind: 'Caret'}),
          contents: p.replacement.trimEnd(), author: by, rotation: pageRotation(page)}, meta(ctx));
        caret.irt = strike.id;
        caret.dict.RT = '/Group';
        caret.dict.Subj = pdfText('Replace Text');
        const n = (page.annots ?? []).length;
        ctx.change.splice(['pages', pi, 'annots'], n, 0, strike, caret);
        ctx.setSelection({ranges: [], primary: 0});
        ctx.setUndoLabel('Replace text');
        return {id: strike.id, annotation: annotAddress(page, strike), caret: annotAddress(page, caret)};
      },
    },
    {
      id: 'comment.attach', label: 'Attach a file', risk: 'edit',
      description: 'Attach a file as a comment (FileAttachment, push-pin icon) at `at`: `path` or `base64` + `name`; from the window, the system Open dialog asks for the file. Without `at`, picks the tool.',
      params: s.object({page: pageParam, at: s.optional(pointParam('[x, y] in page view points')), path: s.optional(s.string({min: 1, max: 4096})),
        base64: s.optional(s.string({max: 45_000_000})), name: s.optional(s.string({min: 1, max: 255})),
        icon: s.optional(s.enum(['PushPin', 'Paperclip', 'Graph', 'Tag'])), description: s.optional(s.string({max: 10000}))}),
      state(ctx) { const st = annotateState(ctx.doc ?? {}); return st.enabled ? {...readState(ctx), checked: toolChecked(ctx, 'comment.attach')} : st; },
      async run(ctx, p) {
        if (!p.at) return pickTool(ctx, 'comment.attach');
        const {pi, page} = currentPage(ctx, p.page);
        const file = await readOther(ctx, p, {title: 'Add Attachment', filters: [{name: 'All Files', extensions: ['*']}]});
        if (!file) return {canceled: true};
        const name = p.name ?? file.name;
        const m = meta(ctx);
        const {sourceBase64, made} = await appendToSource(ctx.doc, doc => embedFile(doc, file.bytes, {name, date: m.date}));
        ctx.change.set(['sourceBase64'], sourceBase64);
        const at = user(page, p.at);
        const style = toolStyle(ctx, 'comment.attach', {kind: 'Attachment'});
        const record = createAnnotation({shape: {kind: 'Attachment', at}, style, contents: p.description ?? name, author: author(ctx), rotation: pageRotation(page)}, m);
        record.dict.FS = fileSpec(name, made.ref, p.description);
        record.dict.Name = `/${p.icon ?? 'PushPin'}`;
        record.dict.C = style.color;
        record.dict.F = 4 | 8 | 16;
        return {...addRecord(ctx, pi, page, record, 'Add file attachment'), name};
      },
    },
    {
      id: 'comment.eraser', label: 'Erase drawings', risk: 'edit',
      description: 'Erase drawings along `path` (page view points): the parts of every freehand drawing on the page within `width` × 1.5 points of it are removed, strokes split where cut, one undo step (paint.rs erase). Without a path, picks the tool.',
      params: s.object({page: pageParam, path: s.optional(s.array(pointParam('[x, y]'), {min: 1, max: 100000})),
        width: s.optional(s.number({min: 0.5, max: 12, description: 'Eraser thickness in points (default 2)'}))}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: toolChecked(ctx, 'comment.eraser')}),
      run(ctx, p) {
        if (!p.path) return pickTool(ctx, 'comment.eraser');
        const {pi, page} = currentPage(ctx, p.page);
        const path = p.path.map(q => user(page, q));
        // paint.rs eraser_radius_px: 3 px per point of thickness at 100 % zoom (1 px = 0.75 pt).
        const radius = 3 * Math.min(12, Math.max(0.5, p.width ?? 2)) * 0.75;
        const list = page.annots ?? [];
        const out = [];
        const gone = [];
        let erased = 0;
        for (const r of list) {
          if (subtypeOfRecord(r) !== 'Ink' || isLocked(r)) { out.push(r); continue; }
          const next = eraseInk(r, path, radius, meta(ctx));
          if (next === r) out.push(r); else if (next) { out.push(next); erased++; } else gone.push(r.id);
        }
        if (!erased && !gone.length) return {erased: 0, deleted: 0};
        // A drawing with nothing left is deleted with its pop-up and replies (modify.rs erase_ink).
        const going = gone.length ? withReplies(ctx.doc, gone) : new Set();
        ctx.change.set(['pages', pi, 'annots'], out.filter(r => !going.has(r.id)));
        for (const [qi, pg] of pagesOf(ctx).entries()) {
          if (qi === pi || !going.size) continue;
          const keep = (pg.annots ?? []).filter(r => !going.has(r.id));
          if (keep.length !== (pg.annots ?? []).length) ctx.change.set(['pages', qi, 'annots'], keep);
        }
        const deleted = gone.length;
        ctx.setUndoLabel('Erase');
        return {erased, deleted};
      },
    },
    {
      id: 'comment.flatten', label: 'Flatten comments', risk: 'edit', needs: 'worker',
      description: 'Flatten comments: draw every comment\'s appearance into its page and remove the comments (links, pop-ups and form fields stay; flatten.rs). `pages` (1-based) limits it.',
      params: s.object({pages: s.optional(s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000}))}),
      state: hasCommentsState,
      async run(ctx, p) {
        const all = pagesOf(ctx);
        const indices = p.pages ? [...new Set(p.pages.map(n => n - 1))].filter(i => i >= 0 && i < all.length) : all.map((_, i) => i);
        const {doc, content} = await materialize(ctx.doc);
        const {removed, drawn} = flattenPages(doc, indices, 'comments');
        const pages = content.pages.map(pg => ({...pg, annots: Array.isArray(pg.annots) ? pg.annots.filter(r => !(r.src && removed.has(`${r.src[0]} ${r.src[1]}`))) : pg.annots}));
        await commit(ctx, doc, content, {pages});
        ctx.setSelection({ranges: [], primary: 0});
        ctx.setUndoLabel('Flatten comments');
        return {flattened: drawn, removed: removed.size};
      },
    },
    {
      id: 'comment.import', label: 'Import comments…', risk: 'edit', needs: 'worker', dialog: 'system.open-file',
      description: 'Import comments from an XFDF data file or another PDF (`path` or `base64`): a comment whose name already exists is replaced, replies are linked by name (xfdf.rs import_xfdf). From the window, the system Open dialog asks.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 45_000_000})), name: s.optional(s.string({max: 255}))}),
      state(ctx) { const st = modificationState(ctx); return st.enabled ? readState(ctx) : st; },
      async run(ctx, p) {
        const file = await readOther(ctx, p, {title: 'Import Comments', filters: [{name: 'All Supported Formats', extensions: ['xfdf', 'pdf']}, {name: 'Acrobat XFDF Files', extensions: ['xfdf']}, {name: 'Adobe PDF Files', extensions: ['pdf']}]});
        if (!file) return {canceled: true};
        const head = new TextDecoder().decode(file.bytes.subarray(0, 1024));
        let incoming;
        if (head.includes('%PDF-')) {
          const src = await readSource(file.bytes);
          incoming = src.pages.flatMap((pg, page) => (pg.annots ?? []).map(r => {
            const parent = r.irt ? (pg.annots ?? []).find(x => x.id === r.irt) : null;
            const dict = {...r.dict};
            delete dict.AP;
            return {page, dict, nm: textOf(r.dict.NM) ?? r.id, inReplyTo: parent ? textOf(parent.dict.NM) ?? parent.id : null, popup: r.popup ?? null};
          }));
        } else incoming = readXfdf(new TextDecoder().decode(file.bytes));
        const pages = pagesOf(ctx).map(pg => ({...pg, annots: [...(pg.annots ?? [])]}));
        const byName = new Map();
        for (const pg of pages) for (const r of pg.annots) byName.set(textOf(r.dict.NM) ?? r.id, r.id);
        let count = 0;
        const later = [];
        for (const it of incoming) {
          const pg = pages[it.page];
          if (!pg) continue;
          const m = meta(ctx);
          const nm = it.nm ?? m.id;
          const idx = pg.annots.findIndex(r => (textOf(r.dict.NM) ?? r.id) === nm);
          const protectedOne = idx >= 0 && (isLocked(pg.annots[idx]) || ['Redact', 'Widget'].includes(subtypeOfRecord(pg.annots[idx])));
          const id = idx >= 0 && !protectedOne ? pg.annots[idx].id : m.id;
          const dict = {...it.dict};
          if (protectedOne) delete dict.NM; else dict.NM = pdfText(idx >= 0 ? textOf(pg.annots[idx].dict.NM) ?? id : nm);
          delete dict.P; delete dict.Popup; delete dict.IRT; delete dict.Parent;
          const record = {id, dict, ap: 'build', edited: true};
          if (it.popup) record.popup = it.popup;
          if (idx >= 0 && !protectedOne) pg.annots[idx] = record; else pg.annots.push(record);
          if (!protectedOne) byName.set(nm, id);
          if (it.inReplyTo) later.push([record, it.inReplyTo]);
          count++;
        }
        for (const [record, parentName] of later) { const parent = byName.get(parentName); if (parent && parent !== record.id) record.irt = parent; }
        if (!count) throw new CommandError('failed', 'nothing in the file matches this document');
        ctx.change.set(['pages'], pages);
        ctx.setUndoLabel('Import comments');
        return {imported: count, from: file.name};
      },
    },
    {
      id: 'comment.stamp', label: 'Add a stamp', risk: 'edit', needs: 'worker',
      description: 'Add a stamp at `at` (page view points): a standard, dynamic or Sign Here stamp by `stamp` (/Name, e.g. Approved, PCDynApproved, PCSignHere), or a custom stamp (`custom` id from the palette, or `base64` PNG/JPEG). Dynamic stamps carry "By <author> at <date>". Without `at`, opens the stamp palette and returns it.',
      params: s.object({page: pageParam, at: s.optional(pointParam('Centre [x, y] in page view points')), rect: s.optional(rectParam()),
        stamp: s.optional(s.string({min: 1, max: 64, description: 'Standard stamp /Name (types.rs StampKind)'})),
        custom: s.optional(s.string({min: 1, max: 64, description: 'A custom stamp id from the palette'})),
        base64: s.optional(s.string({max: 6_000_000, description: 'A PNG or JPEG picture'})), name: s.optional(s.string({max: 120})),
        color: colorParam, opacity: opacityParam}),
      state: ctx => ({...annotateState(ctx.doc ?? {}), checked: ctx.view?.leftPanel === 'stamp'}),
      async run(ctx, p) {
        if (!p.at && !p.rect) {
          ctx.setView({leftPanel: 'stamp', tool: p.stamp || p.custom ? 'comment.stamp' : ctx.view?.tool ?? null, stamp: p.stamp ?? p.custom ?? ctx.view?.stamp ?? null});
          return {palette: stampPalette(ctx)};
        }
        const {pi, page} = currentPage(ctx, p.page);
        const rot = pageRotation(page);
        if (p.custom || p.base64) {
          let bytes;
          let label = p.name ?? 'Stamp';
          if (p.custom) {
            const c = (ctx.prefs?.customStamps ?? []).find(x => x.id === p.custom);
            if (!c) throw new CommandError('not_found', `there is no custom stamp ${p.custom}`, {path: '/custom'});
            bytes = Uint8Array.from(globalThis.atob(c.base64), ch => ch.charCodeAt(0));
            label = c.name;
          } else bytes = Uint8Array.from(globalThis.atob(p.base64), ch => ch.charCodeAt(0));
          const r = p.rect ? (() => { const a = user(page, [p.rect[0], p.rect[1]]), b = user(page, [p.rect[0] + p.rect[2], p.rect[1] + p.rect[3]]); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; })()
            : (() => { const c = user(page, p.at); return [c[0], c[1], c[0], c[1]]; })();
          const record = await pictureStamp(ctx, page, bytes, r, {name: label, author: author(ctx), label: 'Stamp'});
          return addRecord(ctx, pi, page, record, 'Add stamp');
        }
        const kind = stampByName(p.stamp ?? ctx.view?.stamp ?? 'Approved');
        if (!kind) throw new CommandError('invalid_params', `unknown stamp ${p.stamp}`, {path: '/stamp'});
        // types.rs: a stamp is 150 x 40 points as displayed, centred where it is placed.
        const [w, h] = [150, 40];
        let rect;
        if (p.rect) { const a = user(page, [p.rect[0], p.rect[1]]), b = user(page, [p.rect[0] + p.rect[2], p.rect[1] + p.rect[3]]); rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; }
        else { const c = user(page, p.at); const left = viewToUser(page, p.at[0] - w / 2, p.at[1]); rect = uprightBox(rot, left, w, h) ?? [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2]; }
        const by = kind.group === 'Dynamic' ? `By ${author(ctx) || 'Unknown'} at ${new Date(typeof ctx.host?.now === 'function' ? ctx.host.now() : Date.now()).toLocaleString('en-US', {hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric'})}` : null;
        return newComment(ctx, pi, page, 'comment.stamp', {kind: 'Stamp', stamp: kind.name, rect, by}, '', p, 'Add stamp');
      },
    },
    {
      id: 'comment.stamp.custom.create', label: 'Create custom stamp…', risk: 'read', undo: 'none', dialog: 'dialog.create-stamp',
      description: 'Create Custom Stamp: save a PNG or JPEG (`path`/`base64`, or chosen in the system Open dialog) under a category and name in the stamp palette (stamps_ui.rs).',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 6_000_000})),
        category: s.optional(s.string({max: 120})), name: s.string({min: 1, max: 120})}),
      state: readState,
      async run(ctx, p) {
        const file = await readOther(ctx, p, {title: 'Select Image for Custom Stamp', filters: [{name: 'Images', extensions: ['png', 'jpg', 'jpeg']}]});
        if (!file) return {canceled: true};
        if (file.bytes.length > 4 << 20) throw new CommandError('too_large', 'Choose a PNG or JPEG image of up to 4 MB');
        const isImg = (file.bytes[0] === 0x89 && file.bytes[1] === 0x50) || (file.bytes[0] === 0xff && file.bytes[1] === 0xd8);
        if (!isImg) throw new CommandError('invalid_params', 'Choose a PNG or JPEG image');
        const {base64} = await import('../lib/page-source.mjs');
        const id = `c${String(typeof ctx.host?.uid === 'function' ? ctx.host.uid() : Date.now())}`;
        const list = [...(ctx.prefs?.customStamps ?? []), {id, name: p.name.trim(), category: (p.category ?? 'My stamps').trim() || 'My stamps', base64: base64(file.bytes)}];
        ctx.updatePrefs({customStamps: list});
        return {id, name: p.name.trim()};
      },
    },
    {
      id: 'comment.stamp.custom.delete', label: 'Delete stamp', risk: 'read', undo: 'none',
      description: 'Delete a custom stamp from the stamp palette (stamps_ui.rs).',
      params: s.object({custom: s.string({min: 1, max: 64})}),
      run(ctx, p) {
        const list = ctx.prefs?.customStamps ?? [];
        if (!list.some(c => c.id === p.custom)) throw new CommandError('not_found', `there is no custom stamp ${p.custom}`);
        ctx.updatePrefs({customStamps: list.filter(c => c.id !== p.custom)});
        return {deleted: p.custom};
      },
    },
    {
      id: 'comment.export', label: 'Export all comments to data file…', risk: 'read', undo: 'none', dialog: 'system.save-file',
      description: 'Export all comments to an XFDF data file (xfdf.rs export_xfdf): to `path`, chosen in the system Save dialog from the window, or returned as `xfdf` text.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state(ctx) { const st = hasCommentsState(ctx); return st.enabled ? writeState(ctx) : st; },
      async run(ctx, p) {
        const name = ctx.file?.title ?? ctx.file?.name ?? 'Untitled';
        const xml = exportXfdf(ctx.doc, `${stem(name) || 'Untitled'}.pdf`);
        const bytes = new TextEncoder().encode(xml);
        const out = await writeOther(ctx, p, bytes, {title: 'Export Comments', name: `${stem(name) || 'Untitled'}.xfdf`, filters: [{name: 'Acrobat XFDF Files', extensions: ['xfdf']}]});
        if (out.canceled) return {canceled: true};
        return out.path ? {path: out.path, comments: summaries(ctx.doc).length} : {xfdf: xml, comments: summaries(ctx.doc).length};
      },
    },
    {
      id: 'comment.hide_all', label: 'Hide all comments', risk: 'read', undo: 'none',
      description: 'Hide all comments (or show them again): the pages show no comments until shown (Session::set_hide_comments; the file is unchanged).',
      params: s.object({hide: s.optional(s.boolean())}),
      state: ctx => ({...documentState(ctx), checked: !!ctx.view?.commentsHidden}),
      run(ctx, p) {
        if (!pagesOf(ctx).length) throw new CommandError('disabled', 'no PDF open');
        const hide = p.hide ?? !ctx.view?.commentsHidden;
        ctx.setView({commentsHidden: hide});
        return {hidden: hide};
      },
    },
    {
      id: 'comment.summarize', label: 'Summarize comments', risk: 'read', undo: 'none', dialog: 'dialog.summarize-comments',
      description: 'Create PDF Comment Summary: the comments (Comments only layout) sorted by Page, Author, Date or Type, as a new PDF of text pages (session/view.rs summarize_comments) saved to `path`, chosen in the system Save dialog, or returned as base64.',
      params: s.object({sort: s.optional(s.enum(SUMMARY_SORTS)), path: s.optional(s.string({min: 1, max: 4096}))}),
      state(ctx) { const st = hasCommentsState(ctx); return st.enabled ? writeState(ctx) : st; },
      async run(ctx, p) {
        const name = ctx.file?.title ?? ctx.file?.name ?? 'Untitled';
        const text = commentSummary(baseName(name).replace(/\.pdf$/i, '') + '.pdf', ctx.doc, p.sort ?? 'Page');
        const bytes = await summaryPdf(text, `Summary of Comments on ${stem(name) || 'Untitled'}`);
        const out = await writeOther(ctx, p, bytes, {title: 'Save Comment Summary', name: `Summary of Comments on ${stem(name) || 'Untitled'}.pdf`});
        if (out.canceled) return {canceled: true};
        return out.path ? {path: out.path, text} : {base64: out.base64, text};
      },
    },
    // ── threads, status, check marks, lock, properties (comments_panel.rs card actions) ──
    {
      id: 'annot.reply', label: 'Reply', risk: 'edit',
      description: 'Reply to a comment (a Text comment with /IRT, listed under it; modify.rs add_reply).',
      params: s.object({annotation: annotationParam, text: s.string({min: 1, max: 100000})}),
      state: (ctx, p) => targetState(ctx, p?.annotation, {allowLocked: true}),
      run(ctx, p) {
        const t = commentAt(ctx, p.annotation);
        if (!p.text.trim()) throw new CommandError('invalid_params', 'type a reply first', {path: '/text'});
        const r = replyTo(t.record, p.text.trimEnd(), author(ctx), meta(ctx));
        ctx.change.splice(['pages', t.pi, 'annots'], (t.page.annots ?? []).length, 0, r);
        ctx.setUndoLabel('Reply');
        return {id: r.id, annotation: annotAddress(t.page, r), inReplyTo: annotAddress(t.page, t.record)};
      },
    },
    {
      id: 'annot.set_status', label: 'Set status', risk: 'edit',
      description: "Set a comment's review status (None, Accepted, Rejected, Cancelled, Completed): a status reply /StateModel /Review (modify.rs set_review_state).",
      params: s.object({annotation: annotationParam, status: statusParam}),
      state: (ctx, p) => targetState(ctx, p?.annotation, {allowLocked: true}),
      run(ctx, p) {
        const t = commentAt(ctx, p.annotation);
        const by = author(ctx);
        const r = replyTo(t.record, `${p.status} set by ${by || 'unknown'}`, by, meta(ctx), p.status);
        ctx.change.splice(['pages', t.pi, 'annots'], (t.page.annots ?? []).length, 0, r);
        ctx.setUndoLabel(`Set status ${p.status}`);
        return {id: r.id, status: p.status};
      },
    },
    {
      id: 'annot.mark', label: 'Mark with checkmark', risk: 'edit',
      description: 'Mark a comment with a check mark, or remove it (`marked: false`): a hidden /StateModel /Marked reply (modify.rs set_marked).',
      params: s.object({annotation: annotationParam, marked: s.optional(s.boolean())}),
      state: (ctx, p) => targetState(ctx, p?.annotation, {allowLocked: true}),
      run(ctx, p) {
        const t = commentAt(ctx, p.annotation);
        const thread = summaries(ctx.doc).filter(a => a.inReplyTo === t.record.id && (a.state === 'Marked' || a.state === 'Unmarked'));
        const now = thread.length ? thread[thread.length - 1].state === 'Marked' : false;
        const marked = p.marked ?? !now;
        const r = markReply(t.record, marked, author(ctx), meta(ctx));
        ctx.change.splice(['pages', t.pi, 'annots'], (t.page.annots ?? []).length, 0, r);
        ctx.setUndoLabel(marked ? 'Mark with checkmark' : 'Remove checkmark');
        return {marked};
      },
    },
    {
      id: 'annot.lock', label: 'Lock comment', risk: 'edit',
      description: 'Lock a comment so it cannot be moved, changed or deleted, or unlock it (`locked: false`; modify.rs set_locked).',
      params: s.object({annotation: annotationParam, locked: s.optional(s.boolean())}),
      state: (ctx, p) => targetState(ctx, p?.annotation, {allowLocked: true}),
      run(ctx, p) {
        const t = commentAt(ctx, p.annotation);
        const locked = p.locked ?? !isLocked(t.record);
        replaceAt(ctx, t, setLocked(t.record, locked));
        ctx.setUndoLabel(locked ? 'Lock comment' : 'Unlock comment');
        return {locked};
      },
    },
    {
      id: 'comment.properties', label: 'Change comment properties', risk: 'edit', dialog: 'dialog.comment-properties',
      description: "Comment Properties in one step: colour, fill, opacity, thickness, font size, line endings, note icon, author, subject and lock (info.rs set_info, modify.rs set_style/set_fill/set_font_size/set_locked). `makeDefault` also saves the look as the tool's default.",
      params: s.object({annotation: annotationParam, color: colorParam, fill: s.optional(s.nullable(s.color())), opacity: s.optional(s.number({min: 0, max: 1})),
        width: s.optional(s.number({min: 0, max: 100})), fontSize: s.optional(s.number({min: 1, max: 400})),
        start: s.optional(s.enum(LINE_ENDINGS)), end: s.optional(s.enum(LINE_ENDINGS)), icon: s.optional(s.enum(NOTE_ICONS)),
        author: s.optional(s.string({max: 500})), subject: s.optional(s.string({max: 500})), locked: s.optional(s.boolean()), makeDefault: s.optional(s.boolean())}),
      state: (ctx, p) => targetState(ctx, p?.annotation, {allowLocked: true}),
      run(ctx, p) {
        const t = commentAt(ctx, p.annotation);
        let r = t.record;
        const m = meta(ctx);
        if (p.locked === false && isLocked(r)) r = setLocked(r, false);
        const looks = p.color != null || p.opacity != null || p.width != null || p.start || p.end;
        if (looks) {
          const cur = lineEndingsOf(r.dict);
          const endings = p.start || p.end ? [p.start ?? cur?.[0] ?? 'None', p.end ?? cur?.[1] ?? 'None'] : null;
          r = setStyle(r, {color: p.color ? rgbOf(p.color) : null, opacity: p.opacity ?? null, width: p.width ?? null, endings}, m);
        }
        if (p.fill !== undefined) r = setFill(r, p.fill ? rgbOf(p.fill) : null, m);
        if (p.fontSize != null) r = setFontSize(r, p.fontSize, m);
        if (p.icon != null || p.author != null || p.subject != null) r = setInfo(r, {author: p.author ?? null, subject: p.subject ?? null, icon: p.icon ?? null}, m);
        if (p.locked === true && !isLocked(r)) r = setLocked(r, true);
        if (r !== t.record) replaceAt(ctx, t, r);
        if (p.makeDefault) {
          // comments_panel.rs "Make Current Properties Default": the tool that makes such comments keeps this look.
          const pr = props(r);
          const tool = summaries({pages: [{...t.page, annots: [r]}]})[0]?.tool;
          if (tool) ctx.updatePrefs({commentStyles: {...(ctx.prefs?.commentStyles ?? {}), [tool]: {color: pr.color, opacity: pr.opacity, ...(pr.width != null ? {width: pr.width} : {}), fill: pr.fill}}});
        }
        ctx.setUndoLabel('Change comment properties');
        return {annotation: annotAddress(t.page, r), props: props(r)};
      },
    },
  ],
});

export {CARET_SIZE, stampPalette, defaultStyle};
