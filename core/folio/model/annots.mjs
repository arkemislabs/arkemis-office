// Comments (annotations): building them and the edits a comment goes through.
//
// Translated from printcraft crates/annot/src/create.rs (rect_for, base_dict, add_annotation,
// validate_style, set_redaction_properties, callout_attach), crates/annot/src/modify.rs
// (delete_annotation, with_replies_and_popups, set_contents, fitted_box, add_reply,
// set_review_state, set_locked, set_marked, move_annotation, set_rect, set_points, resize_ink,
// apply_text_box, set_style, set_font_size, set_fill, ensure_ending_room, erase_ink, touch) and
// crates/annot/src/info.rs (summaries, props, set_info, line_endings_of) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream edits a comment as an object in the page's /Annots. Here a comment is a record in
// `content.pages[i].annots` (docs/architecture.md 4.2: PDF overlays per page):
//
//   {id,                 /NM (assigned and written back for comments that had none)
//    dict,               the annotation dictionary in JSON form (lib/cos.mjs), without /P /Popup /IRT /Parent
//    ap: 'build'|'source', 'build': the appearance is drawn from `dict` (model/appearance.mjs);
//                        'source': the file's own /AP (dict.AP holds its references) is kept
//    src?: [num, gen],   the object it was read from (unchanged records are written back untouched)
//    edited?: true,      changed since it was read
//    irt?: id,           /IRT: the comment it replies to (or is grouped with, /RT /Group)
//    popup?: {Rect, Open}}  its pop-up annotation
//
// Every function is pure: it returns new records; commands write them through ctx.change.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {text, textOf, nums, num, nameAt, isDict, isName, clone} from '../lib/cos.mjs';
import {finite, normalize, bounds, grow} from '../lib/geom.mjs';
import {n, textWidth, wrap} from '../lib/fonts.mjs';
import {FLAG, NOTE_SIZE, LINE_ENDINGS, subtypeOf, subjectOf, stampByName, FILL_MARKS, isCommentSubtype, HIGHLIGHTER_KEY, toolFor} from './types.mjs';
import {build, arrowSize, cloudRadius, smoothSegments, parseDa, richText, borderWidth} from './appearance.mjs';

const invalid = msg => new CommandError('invalid_params', msg);
const unsupported = subtype => new CommandError('failed', `${subtype} comments can't be restyled yet (their appearance can't be regenerated)`);
const clamp01 = x => Math.min(1, Math.max(0, x));
const rgb = c => c.map(clamp01);

/** create.rs `rect_for`: validate a new comment's geometry and compute /Rect. */
export function rectFor(shape, style) {
  const half = Math.max(style.width, 0) / 2;
  switch (shape.kind) {
    case 'Note': case 'Attachment': {
      const at = shape.at;
      if (!at || !finite(at)) throw invalid('invalid position');
      return [at[0], at[1] - NOTE_SIZE, at[0] + NOTE_SIZE, at[1]];
    }
    case 'TextMarkup': case 'Redact': {
      if (!shape.quads?.length || !shape.quads.every(q => q.length === 8 && finite(q))) throw invalid('invalid text area (no quadrilaterals)');
      const pts = shape.quads.flatMap(q => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]);
      return bounds(pts);
    }
    case 'Rectangle': case 'Oval': case 'TextBox': case 'Typewriter': case 'Stamp': case 'TypedSignature': case 'Mark': {
      const r = normalize(shape.rect);
      if (!finite(shape.rect) || r[2] - r[0] < 1 || r[3] - r[1] < 1) throw invalid('invalid rectangle (too small)');
      return r;
    }
    case 'CustomStamp': {
      const r = normalize(shape.rect);
      if (!finite(shape.rect) || r[2] <= r[0] || r[3] <= r[1]) throw invalid('invalid rectangle (empty)');
      return r;
    }
    case 'Line': {
      const {from, to} = shape;
      if (!finite(from) || !finite(to) || Math.hypot(from[0] - to[0], from[1] - to[1]) < 1) throw invalid('invalid line (too short)');
      const pad = half + (shape.start !== 'None' || shape.end !== 'None' ? arrowSize(style.width) : 0);
      return grow(bounds([from, to]), pad + 1);
    }
    case 'Ink': case 'Signature': {
      const strokes = shape.strokes ?? [];
      if (strokes.every(s => !s.length) || !strokes.flat().every(p => finite(p))) throw invalid('invalid drawing (no points)');
      const controls = strokes.filter(s => s.length > 2).flatMap(s => smoothSegments(s).flatMap(([a, b]) => [a, b]));
      return grow(bounds([...strokes.flat(), ...controls]), half + 1);
    }
    case 'Polygon': {
      const b = bounds(shape.vertices ?? []);
      if (!b || shape.vertices.length < 3 || !shape.vertices.every(p => finite(p)) || b[2] - b[0] < 1 || b[3] - b[1] < 1) throw invalid('invalid polygon (it needs three points)');
      return grow(b, half + 1 + (shape.cloud ? 1.5 * cloudRadius(style.width) : 0));
    }
    case 'PolyLine': {
      const b = bounds(shape.vertices ?? []);
      if (!b || shape.vertices.length < 2 || !shape.vertices.every(p => finite(p)) || Math.max(b[2] - b[0], b[3] - b[1]) < 1) throw invalid('invalid connected lines (they need two points)');
      const extra = shape.start !== 'None' || shape.end !== 'None' ? arrowSize(style.width) : 0;
      return grow(b, half + 1 + extra);
    }
    case 'Callout': {
      const r = normalize(shape.rect);
      if (!finite(shape.rect) || !finite(shape.knee) || !finite(shape.point) || r[2] - r[0] < 1 || r[3] - r[1] < 1) throw invalid('invalid callout');
      const pad = half + arrowSize(style.width) + 1;
      const lead = grow(bounds([shape.knee, shape.point]), pad);
      return [Math.min(r[0], lead[0]), Math.min(r[1], lead[1]), Math.max(r[2], lead[2]), Math.max(r[3], lead[3])];
    }
    case 'Caret': {
      const r = normalize(shape.rect);
      if (!finite(shape.rect) || r[2] - r[0] < 1 || r[3] - r[1] < 1) throw invalid('invalid caret');
      return r;
    }
    default: throw invalid(`unknown comment shape ${shape.kind}`);
  }
}

/** create.rs `callout_attach`: where a callout's leader meets its box. */
export function calloutAttach(rect, knee) {
  const [x0, y0, x1, y1] = normalize(rect), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (knee[0] < x0) return [x0, cy];
  if (knee[0] > x1) return [x1, cy];
  if (knee[1] > y1) return [cx, y1];
  return [cx, y0];
}

/** create.rs `base_dict` (the page reference /P is written by the writer). */
function baseDict(subtype, rect, contents, author, meta) {
  const d = {Type: '/Annot', Subtype: `/${subtype}`, Rect: rect, Contents: text(contents)};
  if (author) d.T = text(author);
  if (meta.date) { d.M = text(meta.date); d.CreationDate = text(meta.date); }
  if (meta.id) d.NM = text(meta.id);
  d.F = FLAG.PRINT;
  return d;
}

const borderStyle = w => ({W: Math.max(w, 0), S: '/S'});
const endingDraws = e => e && e !== 'None';

/**
 * create.rs `add_annotation`: a new comment record.
 * @param {{shape: object, style: {color:number[], opacity:number, width:number, fill?:number[]|null}, contents?: string, author?: string,
 *   rotation?: number}} na  rotation: the page's displayed rotation (stamps and text read upright)
 * @param {{date?: string, id: string}} meta
 */
export function createAnnotation(na, meta) {
  const {shape, style} = na;
  const contents = na.contents ?? '', author = na.author ?? '';
  if (!style || !finite(style.color ?? []) || !Number.isFinite(style.opacity) || !Number.isFinite(style.width)) throw invalid('invalid style');
  const subtype = subtypeOf(shape);
  if (!subtype) throw invalid(`unknown comment shape ${shape.kind}`);
  const rect = rectFor(shape, style);
  const d = baseDict(subtype, rect, contents, author, meta);
  d.Subj = text(subjectOf(shape));
  const opacity = clamp01(style.opacity);
  if (opacity < 1) d.CA = opacity;
  const turn = [90, 180, 270].includes(na.rotation) ? na.rotation : 0;
  let popup = null;
  switch (shape.kind) {
    case 'Note':
      d.C = rgb(style.color);
      d.Name = `/${shape.icon ?? 'Comment'}`;
      d.F = FLAG.PRINT | FLAG.NO_ZOOM | FLAG.NO_ROTATE;
      d.Open = false;
      popup = {Rect: [rect[2] + 10, rect[3] - 120, rect[2] + 210, rect[3]], Open: false};
      break;
    case 'TextMarkup':
      d.C = rgb(style.color);
      d.QuadPoints = shape.quads.flat();
      break;
    case 'Redact': {
      d.C = rgb(style.color);
      d.IC = rgb(style.fill ?? [0, 0, 0]);
      d.QuadPoints = shape.quads.flat();
      if (shape.overlay) {
        const look = shape.look ?? {font: 'Helv', size: 0, color: [1, 0, 0], align: 1, repeat: false};
        d.OverlayText = text(shape.overlay);
        const c = rgb(look.color);
        d.DA = text(`${n(c[0])} ${n(c[1])} ${n(c[2])} rg /${look.font ?? 'Helv'} ${n(look.size > 0 ? Math.min(look.size, 400) : 0)} Tf`);
        d.Q = Math.min(look.align ?? 1, 2);
        if (look.repeat) d.Repeat = true;
      }
      break;
    }
    case 'Rectangle': case 'Oval':
      d.C = rgb(style.color);
      if (style.fill) d.IC = rgb(style.fill);
      d.BS = borderStyle(style.width);
      break;
    case 'Line':
      d.C = rgb(style.color);
      d.L = [shape.from[0], shape.from[1], shape.to[0], shape.to[1]];
      if (endingDraws(shape.start) || endingDraws(shape.end)) d.LE = [`/${shape.start ?? 'None'}`, `/${shape.end ?? 'None'}`];
      d.BS = borderStyle(style.width);
      break;
    case 'Mark':
      d.C = rgb(style.color);
      d.Name = `/${FILL_MARKS[shape.mark]?.[0] ?? 'PCCheck'}`;
      d.BS = borderStyle(style.width);
      if (turn) d.PCStampRotate = turn;
      break;
    case 'Stamp':
      d.C = rgb(style.color);
      d.Name = `/${shape.stamp}`;
      d.PCStamp = true;
      if (shape.by != null) d.PCByLine = text(shape.by);
      if (turn) d.PCStampRotate = turn;
      break;
    case 'TypedSignature':
      d.C = rgb(style.color);
      d.Name = '/PCTypedSignature';
      d.PCOutline = (shape.contours ?? []).filter(c => c.length > 2).map(c => c.flat());
      break;
    case 'Ink': case 'Signature':
      d.C = rgb(style.color);
      d.InkList = shape.strokes.filter(s => s.length).map(s => s.flat());
      d.BS = borderStyle(style.width);
      if (shape.kind === 'Ink' && shape.highlighter) d[HIGHLIGHTER_KEY] = true;
      break;
    case 'Polygon':
      d.C = rgb(style.color);
      if (style.fill) d.IC = rgb(style.fill);
      d.Vertices = shape.vertices.flat();
      if (shape.cloud) { d.IT = '/PolygonCloud'; d.BE = {S: '/C', I: 1}; }
      d.BS = borderStyle(style.width);
      break;
    case 'PolyLine':
      d.C = rgb(style.color);
      d.Vertices = shape.vertices.flat();
      if (endingDraws(shape.start) || endingDraws(shape.end)) d.LE = [`/${shape.start ?? 'None'}`, `/${shape.end ?? 'None'}`];
      d.BS = borderStyle(style.width);
      break;
    case 'Caret':
      d.C = rgb(style.color);
      d.Sy = '/None';
      break;
    case 'Callout': {
      const tb = normalize(shape.rect), attach = calloutAttach(tb, shape.knee);
      d.IT = '/FreeTextCallout';
      d.CL = [shape.point[0], shape.point[1], shape.knee[0], shape.knee[1], attach[0], attach[1]];
      d.LE = `/${shape.ending ?? 'OpenArrow'}`;
      d.RD = [tb[0] - rect[0], tb[1] - rect[1], rect[2] - tb[2], rect[3] - tb[3]];
      break;
    }
    default: break;
  }
  if (shape.kind === 'TextBox' || shape.kind === 'Typewriter' || shape.kind === 'Callout') {
    if (shape.kind === 'Typewriter') d.IT = '/FreeTextTypeWriter';
    const size = Number.isFinite(shape.fontSize) && shape.fontSize > 0 ? Math.min(400, Math.max(1, shape.fontSize)) : 12;
    const c = rgb(style.color);
    d.DA = text(`${n(c[0])} ${n(c[1])} ${n(c[2])} rg /Helv ${n(size)} Tf`);
    d.Q = 0;
    if (style.fill) d.C = rgb(style.fill);
    d.BS = borderStyle(style.width);
    richText(d);
    if (shape.kind !== 'Callout' && turn) d.PCTextRotate = turn;
  }
  if (['Mark', 'Typewriter', 'Signature', 'TypedSignature'].includes(shape.kind)) d.PCFillSign = true;
  // A redaction's overlay text is drawn when the redaction is applied (lib/redact.mjs), with a system font where the standard faces lack the script: nothing is refused here.
  if (!build(d)) throw unsupported(subtype);
  const record = {id: meta.id, dict: d, ap: 'build'};
  if (popup) record.popup = popup;
  return record;
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────

export const subtypeOfRecord = r => nameAt(r.dict, 'Subtype') ?? '';
export const rectOf = r => { const v = nums(r.dict, 'Rect'); return v && v.length === 4 ? normalize(v) : [0, 0, 0, 0]; };
export const flagsOf = r => (Number.isInteger(r.dict.F) ? r.dict.F : 0);
export const isLocked = r => (flagsOf(r) & FLAG.LOCKED) !== 0;
export const isHidden = r => (flagsOf(r) & FLAG.HIDDEN) !== 0;
const unlocked = r => { if (isLocked(r)) throw new CommandError('disabled', 'the comment is locked'); };

/** The record with an id anywhere in the document: {page, index, record}. */
export function findAnnot(content, id) {
  const pages = content?.pages ?? [];
  for (let page = 0; page < pages.length; page++) {
    const list = pages[page].annots ?? [];
    for (let index = 0; index < list.length; index++) if (list[index].id === id) return {page, index, record: list[index]};
  }
  return null;
}

/** /RT /Group: the record is grouped with its /IRT (Replace Text's caret), not a reply to it. */
export const isGrouped = r => nameAt(r.dict, 'RT') === 'Group';
/** A reply: a Text comment with /IRT that is not grouped (shows in the comments list under its parent, never on the page). */
export const isReply = r => !!r.irt && !isGrouped(r);

/** modify.rs `touch`. */
function touch(d, meta) { if (meta?.date) d.M = text(meta.date); }

/** An edited copy of a record (the dictionary copied so the session's content stays immutable). */
function edit(r, f, {redraw = true} = {}) {
  const next = {...r, dict: clone(r.dict), edited: true};
  if (redraw) next.ap = 'build';
  f(next.dict, next);
  return next;
}

/** Redraw after an edit, or refuse it (upstream `redraw_or_restore`). */
function redrawn(next) {
  if (!build(next.dict)) throw unsupported(subtypeOfRecord(next));
  // The old down and rollover appearances would show the previous look: they go with the old /N.
  if (isDict(next.dict.AP)) { const ap = {...next.dict.AP}; delete ap.D; delete ap.R; delete ap.N; next.dict.AP = ap; if (!Object.keys(ap).length) delete next.dict.AP; }
  delete next.dict.AS;
  return next;
}

/** modify.rs `move_annotation`: shift a comment (and its pop-up) by (dx, dy) points; the appearance moves with /Rect. */
export function moveAnnotation(r, dx, dy, meta) {
  if (!finite([dx, dy])) throw invalid('invalid offset');
  unlocked(r);
  const shift = (v, every) => (Array.isArray(v) ? v.map((x, i) => (typeof x === 'number' && (every || i < 4) ? x + (i % 2 === 0 ? dx : dy) : x)) : v);
  const next = edit(r, d => {
    for (const [k, every] of [['Rect', false], ['QuadPoints', true], ['L', false], ['CL', true], ['Vertices', true]]) if (Array.isArray(d[k])) d[k] = shift(d[k], every);
    if (Array.isArray(d.InkList)) d.InkList = d.InkList.map(s => shift(s, true));
    touch(d, meta);
  }, {redraw: false});
  if (next.popup) next.popup = {...next.popup, Rect: shift(next.popup.Rect, false)};
  return next;
}

/** modify.rs `set_rect`: resize a rectangle, oval, text box, stamp or drawing. */
export function setRect(r, rect, meta) {
  unlocked(r);
  const subtype = subtypeOfRecord(r);
  if (subtype === 'Stamp') {
    const nr = normalize(rect);
    if (!finite(nr) || nr[2] <= nr[0] || nr[3] <= nr[1]) throw invalid('invalid rectangle (too small)');
    return edit(r, d => { d.Rect = nr; touch(d, meta); }, {redraw: false});
  }
  if (subtype === 'Ink') return resizeInk(r, normalize(rect), meta);
  if (!['Square', 'Circle', 'FreeText'].includes(subtype)) throw invalid(`${subtype} comments can't be resized`);
  return applyTextBox(r, rect, meta);
}

/** modify.rs `resize_ink`: scale a drawing's strokes into `rect`, keeping its margins. */
function resizeInk(r, rect, meta) {
  const strokes = (r.dict.InkList ?? []).map(s => { const pts = []; for (let i = 0; i + 1 < s.length; i += 2) pts.push([s[i], s[i + 1]]); return pts; });
  const inner = bounds(strokes.flat());
  if (!inner) throw invalid('the drawing has no strokes');
  const oldV = nums(r.dict, 'Rect');
  const old = oldV && oldV.length === 4 ? normalize(oldV) : inner;
  const margin = [inner[0] - old[0], inner[1] - old[1], old[2] - inner[2], old[3] - inner[3]].map(m => Math.max(m, 0));
  const target = [rect[0] + margin[0], rect[1] + margin[1], rect[2] - margin[2], rect[3] - margin[3]];
  if (!finite(rect) || target[2] < target[0] || target[3] < target[1] || rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) throw invalid('invalid rectangle (too small)');
  const axis = (v, a0, a1, b0, b1) => (a1 > a0 ? b0 + ((v - a0) / (a1 - a0)) * (b1 - b0) : (b0 + b1) / 2);
  const scaled = strokes.map(s => s.map(p => [axis(p[0], inner[0], inner[2], target[0], target[2]), axis(p[1], inner[1], inner[3], target[1], target[3])]));
  return redrawn(edit(r, d => { d.InkList = scaled.map(s => s.flat()); d.Rect = rect; touch(d, meta); }));
}

/** modify.rs `apply_text_box`: a FreeText's text box (or a square's/oval's rectangle); callouts re-attach. */
function applyTextBox(r, rect, meta) {
  const nr = normalize(rect);
  if (!finite(nr) || nr[2] - nr[0] < 1 || nr[3] - nr[1] < 1) throw invalid('invalid rectangle (too small)');
  const cl = nums(r.dict, 'CL');
  let outer = nr, newCl = null;
  if (cl && cl.length === 6) {
    newCl = cl.slice();
    const attach = calloutAttach(nr, [cl[2], cl[3]]);
    newCl[4] = attach[0]; newCl[5] = attach[1];
    const w = borderWidthOf(r.dict);
    const lead = grow(bounds([[cl[0], cl[1]], [cl[2], cl[3]]]), w / 2 + arrowSize(w) + 1);
    outer = [Math.min(nr[0], lead[0]), Math.min(nr[1], lead[1]), Math.max(nr[2], lead[2]), Math.max(nr[3], lead[3])];
  }
  return redrawn(edit(r, d => {
    d.Rect = outer;
    if (newCl) { d.CL = newCl; d.RD = [nr[0] - outer[0], nr[1] - outer[1], outer[2] - nr[2], outer[3] - nr[3]]; } else delete d.RD;
    touch(d, meta);
  }));
}

const borderWidthOf = d => Math.max(isDict(d.BS) && typeof d.BS.W === 'number' ? d.BS.W : 1, 0);

/** info.rs `line_endings_of`. */
export function lineEndingsOf(d) {
  const sub = nameAt(d, 'Subtype');
  if (sub === 'Line' || sub === 'PolyLine') {
    if (d.LE === undefined) return ['None', 'None'];
    if (!Array.isArray(d.LE) || d.LE.length !== 2) return null;
    const e = d.LE.map(x => (isName(x) ? x.slice(1) : null));
    return e.every(x => LINE_ENDINGS.includes(x)) ? e : null;
  }
  if (sub === 'FreeText' && 'CL' in d) { const e = isName(d.LE) ? d.LE.slice(1) : 'None'; return LINE_ENDINGS.includes(e) ? [e] : null; }
  return null;
}

/** modify.rs `set_points`: reshape a line, connected lines, polygon or cloud. */
export function setPoints(r, points, meta) {
  unlocked(r);
  if ('Measure' in r.dict) throw invalid("a measurement's points are where it measured");
  if (points.length > 100000) throw invalid('at most 100000 points');
  const style = {width: borderWidthOf(r.dict), color: [0, 0, 0], opacity: 1};
  const ends = lineEndingsOf(r.dict) ?? [];
  const [start, end] = [ends[0] ?? 'None', ends[1] ?? 'None'];
  const subtype = subtypeOfRecord(r);
  let shape, key;
  if (subtype === 'Line') { if (points.length !== 2) throw invalid('a line has two ends'); shape = {kind: 'Line', from: points[0], to: points[1], start, end}; key = 'L'; }
  else if (subtype === 'PolyLine') { shape = {kind: 'PolyLine', vertices: points, start, end}; key = 'Vertices'; }
  else if (subtype === 'Polygon') { shape = {kind: 'Polygon', vertices: points, cloud: isDict(r.dict.BE) && nameAt(r.dict.BE, 'S') === 'C'}; key = 'Vertices'; }
  else throw invalid(`${subtype} comments have no points to move`);
  const rect = rectFor(shape, style);
  return redrawn(edit(r, d => { d[key] = points.flat(); d.Rect = rect; touch(d, meta); }));
}

/** modify.rs `ensure_ending_room`. */
function ensureEndingRoom(d) {
  const sub = nameAt(d, 'Subtype');
  if (sub !== 'Line' && sub !== 'PolyLine') return;
  if (!(lineEndingsOf(d) ?? []).some(endingDraws)) return;
  const v = nums(d, sub === 'Line' ? 'L' : 'Vertices');
  if (!v || v.length < 4 || v.length % 2) return;
  const pts = []; for (let i = 0; i < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  const w = borderWidthOf(d);
  const need = grow(bounds(pts), w / 2 + arrowSize(w) + 1);
  const rect = nums(d, 'Rect');
  if (!rect || rect.length !== 4) return;
  const u = [Math.min(rect[0], need[0]), Math.min(rect[1], need[1]), Math.max(rect[2], need[2]), Math.max(rect[3], need[3])];
  if (u.some((x, i) => x !== rect[i])) d.Rect = u;
}

/** modify.rs `set_style`: colour, opacity, line width and/or line endings, redrawn. */
export function setStyle(r, change, meta) {
  unlocked(r);
  const subtype = subtypeOfRecord(r);
  if (!build(r.dict)) throw unsupported(subtype);
  const {color, opacity, width, endings} = change;
  if ((color && !finite(color)) || (opacity != null && !Number.isFinite(opacity)) || (width != null && !Number.isFinite(width))) throw invalid('invalid style');
  if (endings) {
    const callout = subtype === 'FreeText' && 'CL' in r.dict, pair = subtype === 'Line' || subtype === 'PolyLine';
    if ((callout && endings.length !== 1) || (pair && endings.length !== 2) || (!callout && !pair)) throw invalid('this comment has no line endings to change');
    if (!endings.every(e => LINE_ENDINGS.includes(e))) throw invalid('unknown line ending');
  }
  const freeText = subtype === 'FreeText';
  return redrawn(edit(r, d => {
    if (color) {
      if (freeText) { const [, size] = parseDa(d); const c = rgb(color); d.DA = text(`${n(c[0])} ${n(c[1])} ${n(c[2])} rg /Helv ${n(size)} Tf`); richText(d); }
      else d.C = rgb(color);
    }
    if (opacity != null) { const o = clamp01(opacity); if (o < 1) d.CA = o; else delete d.CA; }
    if (width != null) { d.BS = {...(isDict(d.BS) ? d.BS : {}), W: Math.max(width, 0)}; delete d.Border; }
    if (endings) d.LE = endings.length === 1 ? `/${endings[0]}` : [`/${endings[0]}`, `/${endings[1]}`];
    ensureEndingRoom(d);
    touch(d, meta);
  }));
}

/** modify.rs `fitted_box`: a FreeText's box for `text`: the wrap width and top edge stay. */
function fittedBox(d, txt) {
  const [, size] = parseDa(d);
  const pad = 2 + borderWidthOf(d);
  const rect = nums(d, 'Rect');
  if (!rect || rect.length !== 4) return null;
  let tb = rect;
  if ('CL' in d) {
    const rd = nums(d, 'RD');
    if (!rd || rd.length !== 4 || rd.some(x => x < 0)) return null;
    tb = [rect[0] + rd[0], rect[1] + rd[1], rect[2] - rd[2], rect[3] - rd[3]];
  }
  const x0 = Math.min(tb[0], tb[2]), top = Math.max(tb[1], tb[3]);
  let w = tb[2] - tb[0];
  if (!(Number.isFinite(w) && w >= 1)) {
    const longest = Math.max(0, ...txt.split('\n').map(l => textWidth(l, size)));
    w = Math.min(300, Math.max(40, longest + 2 * pad + 4));
  }
  const lines = Math.max(wrap(txt, size, Math.max(w - 2 * pad, 1)).length, 1);
  return [x0, top - lines * size * 1.2 - 2 * pad - 2, x0 + w, top];
}

/** modify.rs `set_contents`: a comment's text; text boxes are redrawn and re-fitted. */
export function setContents(r, txt, meta) {
  const freeText = subtypeOfRecord(r) === 'FreeText';
  let next = edit(r, d => {
    d.Contents = text(txt);
    if (freeText) richText(d); else delete d.RC;
    touch(d, meta);
  }, {redraw: freeText});
  if (freeText) {
    const fit = fittedBox(next.dict, txt);
    next = fit ? applyTextBox({...next, dict: next.dict}, fit, meta) : redrawn(next);
  }
  return next;
}

/** modify.rs `set_font_size`. */
export function setFontSize(r, size, meta) {
  unlocked(r);
  if (subtypeOfRecord(r) !== 'FreeText') throw invalid('only text boxes, typewriter text and callouts have a font size');
  if (!Number.isFinite(size) || size < 1 || size > 400) throw invalid('font size must be 1–400 pt');
  const next = edit(r, d => { const [col] = parseDa(d); d.DA = text(`${n(col[0])} ${n(col[1])} ${n(col[2])} rg /Helv ${n(size)} Tf`); richText(d); touch(d, meta); });
  const fit = fittedBox(next.dict, textOf(next.dict.Contents) ?? '');
  if (!fit) return redrawn(next);
  const old = normalize(nums(next.dict, 'Rect'));
  return applyTextBox(next, 'CL' in next.dict ? fit : [fit[0], Math.min(fit[1], old[1]), fit[2], fit[3]], meta);
}

/** modify.rs `fillable`. */
export const fillable = subtype => ['Square', 'Circle', 'Polygon', 'FreeText'].includes(subtype);

/** modify.rs `set_fill`. */
export function setFill(r, fill, meta) {
  unlocked(r);
  const subtype = subtypeOfRecord(r);
  if (!fillable(subtype)) throw invalid('only rectangles, ovals, polygons and text boxes can be filled');
  if (!build(r.dict)) throw unsupported(subtype);
  if (fill && !finite(fill)) throw invalid('invalid fill colour');
  return redrawn(edit(r, d => { const key = subtype === 'FreeText' ? 'C' : 'IC'; if (fill) d[key] = rgb(fill); else delete d[key]; touch(d, meta); }));
}

/** modify.rs `set_locked`. */
export function setLocked(r, locked) {
  const f = locked ? flagsOf(r) | FLAG.LOCKED : flagsOf(r) & ~FLAG.LOCKED;
  return edit(r, d => { d.F = f; }, {redraw: false});
}

/** info.rs `set_info`: author, subject and (notes) icon. */
export function setInfo(r, {author, subject, icon}, meta) {
  unlocked(r);
  const isNote = subtypeOfRecord(r) === 'Text';
  if (icon != null && !isNote) throw invalid('only sticky notes have an icon');
  const next = edit(r, d => {
    if (author != null) d.T = text(author);
    if (subject != null) d.Subj = text(subject);
    if (icon != null) d.Name = `/${icon}`;
    touch(d, meta);
  }, {redraw: icon != null});
  return icon != null ? redrawn(next) : next;
}

/** modify.rs `reply` (add_reply / set_review_state): a Text comment with /IRT, an empty appearance. */
export function replyTo(parent, txt, author, meta, state = null) {
  if (subtypeOfRecord(parent) === 'Popup') throw invalid("pop-ups can't be replied to");
  const d = baseDict('Text', rectOf(parent), txt, author, meta);
  d.F = FLAG.PRINT | FLAG.NO_ZOOM | FLAG.NO_ROTATE;
  d.Name = '/Comment';
  if (parent.dict.C) d.C = clone(parent.dict.C);
  if (state) { d.State = text(state); d.StateModel = text('Review'); d.Subj = text('Status'); }
  return {id: meta.id, dict: d, ap: 'empty', irt: parent.id};
}

/** modify.rs `set_marked`: a hidden state reply /StateModel /Marked. */
export function markReply(parent, marked, author, meta) {
  const state = marked ? 'Marked' : 'Unmarked';
  const d = baseDict('Text', rectOf(parent), `${state} set by ${author || 'unknown'}`, author, meta);
  d.F = FLAG.HIDDEN | FLAG.PRINT | FLAG.NO_ZOOM | FLAG.NO_ROTATE;
  d.State = text(state);
  d.StateModel = text('Marked');
  return {id: meta.id, dict: d, ap: 'empty', irt: parent.id};
}

/** modify.rs `with_replies_and_popups`: the ids that go with deleting `doomed` (its replies, theirs). */
export function withReplies(content, doomed) {
  const hanging = new Map();
  for (const page of content.pages ?? []) for (const r of page.annots ?? []) if (r.irt) { if (!hanging.has(r.irt)) hanging.set(r.irt, []); hanging.get(r.irt).push(r.id); }
  const going = new Set(), todo = [...doomed];
  while (todo.length) { const id = todo.pop(); if (going.has(id)) continue; going.add(id); todo.push(...(hanging.get(id) ?? [])); }
  return going;
}

/** modify.rs `erase_ink`: remove the parts of a drawing within `radius` of `path`. Returns the record, null (deleted) or the same record (nothing erased). */
export function eraseInk(r, path, radius, meta) {
  unlocked(r);
  if (subtypeOfRecord(r) !== 'Ink') throw invalid('only drawings can be erased');
  if (!path.length || !path.every(p => finite(p)) || !Number.isFinite(radius) || radius <= 0) throw invalid('invalid eraser path');
  const strokes = (r.dict.InkList ?? []).map(s => { const pts = []; for (let i = 0; i + 1 < s.length; i += 2) pts.push([s[i], s[i + 1]]); return pts; });
  const near = p => {
    if (path.length === 1) return Math.hypot(p[0] - path[0][0], p[1] - path[0][1]) <= radius;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k], b = path[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= radius) return true;
    }
    return false;
  };
  const kept = [];
  let erased = false;
  for (const s of strokes) {
    const pts = [];
    for (let k = 0; k + 1 < s.length; k++) {
      const a = s[k], b = s[k + 1];
      const steps = Math.min(2000, Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (radius / 2))));
      for (let j = 0; j < steps; j++) { const t = j / steps; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    if (s.length) pts.push(s[s.length - 1]);
    let run = [];
    for (const p of pts) {
      if (near(p)) { erased = true; if (run.length >= 2) kept.push(run); run = []; } else run.push(p);
    }
    if (run.length >= 2) kept.push(run);
  }
  if (!erased) return r;
  if (!kept.length) return null;
  const width = isDict(r.dict.BS) && typeof r.dict.BS.W === 'number' ? r.dict.BS.W : 1;
  const rect = grow(bounds(kept.flat()), width / 2 + 1);
  return redrawn(edit(r, d => { d.InkList = kept.map(s => s.flat()); d.Rect = rect; touch(d, meta); }));
}

// ── info.rs ─────────────────────────────────────────────────────────────────────────────────

const textValue = v => { const s = textOf(v); if (s == null) return null; const t = s.replace(/^\0+|\0+$/g, '').trim(); return t || null; };

/** info.rs `summaries`: every comment, ordered by page and then top edge. */
export function summaries(content) {
  const out = [];
  const byId = new Map();
  (content.pages ?? []).forEach((page, p) => (page.annots ?? []).forEach((r, i) => byId.set(r.id, {page: p, index: i, record: r})));
  (content.pages ?? []).forEach((page, p) => (page.annots ?? []).forEach((r, index) => {
    const d = r.dict, subtype = nameAt(d, 'Subtype');
    if (!subtype || !isCommentSubtype(subtype)) return;
    const rect = rectOf(r);
    let color = Array.isArray(d.C) && d.C.length === 3 ? d.C.slice() : null;
    if (subtype === 'FreeText' && textOf(d.DA)) color = parseDa(d)[0];
    const pts = subtype === 'Line' ? nums(d, 'L') : ['PolyLine', 'Polygon'].includes(subtype) ? nums(d, 'Vertices') : null;
    const points = []; if (pts) for (let i = 0; i + 1 < pts.length; i += 2) points.push([pts[i], pts[i + 1]]);
    const parent = r.irt ? byId.get(r.irt) : null;
    out.push({
      id: r.id, page: p, pageId: page.id, index, subtype,
      author: textValue(d.T), contents: textValue(d.Contents)?.replace(/\r\n/g, '\n').replace(/\r/g, '\n') ?? null,
      modified: textValue(d.M), name: textValue(d.NM), inReplyTo: parent ? r.irt : null,
      parent: parent ? [parent.page, parent.index] : null, grouped: isGrouped(r), rect, color, state: textValue(d.State),
      quads: (nums(d, 'QuadPoints') ?? []).reduce((a, x, i) => { if (i % 8 === 0) a.push([]); a[a.length - 1].push(x); return a; }, []),
      locked: isLocked(r), hidden: isHidden(r), intent: nameAt(d, 'IT') ?? null, fillSign: d.PCFillSign === true, noRotate: (flagsOf(r) & FLAG.NO_ROTATE) !== 0,
      points, highlighter: d[HIGHLIGHTER_KEY] === true, tool: toolFor(subtype, nameAt(d, 'IT'), d[HIGHLIGHTER_KEY] === true),
    });
  }));
  out.sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3]);
  return out;
}

/** info.rs `props`: what Comment properties shows for one comment. */
export function props(r) {
  const d = r.dict, subtype = nameAt(d, 'Subtype') ?? '';
  const c = Array.isArray(d.C) ? d.C : [];
  const color = subtype === 'FreeText' ? parseDa(d)[0] : c.length === 3 ? c.slice() : null;
  const width = ['Square', 'Circle', 'Line', 'Ink', 'Polygon', 'PolyLine', 'FreeText'].includes(subtype)
    ? (subtype === 'FreeText' ? (!('BS' in d) && !('Border' in d) ? 0 : borderWidth(d)) : (isDict(d.BS) && typeof d.BS.W === 'number' ? d.BS.W : 1)) : null;
  const fillKey = subtype === 'FreeText' ? 'C' : 'IC';
  const fv = Array.isArray(d[fillKey]) ? d[fillKey] : null;
  const fill = !fv ? null : fv.length === 1 ? [fv[0], fv[0], fv[0]] : fv.length === 3 ? fv.slice() : fv.length === 4 ? [(1 - fv[0]) * (1 - fv[3]), (1 - fv[1]) * (1 - fv[3]), (1 - fv[2]) * (1 - fv[3])] : null;
  return {
    subtype, author: textValue(d.T) ?? '', subject: textValue(d.Subj) ?? '', color, opacity: num(d, 'CA') ?? 1, width,
    icon: subtype === 'Text' ? nameAt(d, 'Name') ?? 'Note' : null, modified: textValue(d.M), restylable: !!build(d), locked: isLocked(r),
    endings: lineEndingsOf(d), fillable: fillable(subtype), fill: fill && finite(fill) ? fill.map(clamp01) : null,
    fontSize: subtype === 'FreeText' ? parseDa(d)[1] : null, highlighter: d[HIGHLIGHTER_KEY] === true,
  };
}

/** What a comment can do on the page (comments/input.rs select_grabs): move, resize by its box, or reshape by its points. */
export function grabs(r) {
  const subtype = subtypeOfRecord(r);
  const locked = isLocked(r);
  return {
    move: !locked && subtype !== 'Popup',
    resize: !locked && ['Square', 'Circle', 'FreeText', 'Stamp', 'Ink'].includes(subtype) && !('CL' in r.dict && subtype !== 'FreeText'),
    reshape: !locked && ['Line', 'PolyLine', 'Polygon'].includes(subtype) && !('Measure' in r.dict),
  };
}

export {stampByName};
