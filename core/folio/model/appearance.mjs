// Appearance streams (§12.5.5) for the comment types printcraft draws.
//
// Translated from printcraft crates/annot/src/appearance.rs (build, line_end, smooth_segments,
// cloud_path, border_width, dash, parse_da, ext_gstate, caret_layout, draw_markup, draw_redaction,
// draw_box, draw_line, draw_polygon, draw_caret, draw_ink, draw_stamp, draw_free_text, draw_icon,
// undrawable_text) and crates/annot/src/appearance/symbols.rs (display_stamp, line_layout,
// line_caption, rich_plain, stamp, ellipse, attach_icon, circle_path, note_icon) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `build(d)` draws a normal appearance from the annotation dictionary alone (JSON form, lib/cos.mjs)
// and returns `{bbox, matrix?, content, resources}` or null for anything it cannot draw faithfully,
// so callers never replace an appearance with a worse one. `content` is a binary string (WinAnsi
// bytes in text operators). The same stream is written into the file (model/pdf-write.mjs) and
// painted on screen (model/paint.mjs), so what the person sees is what is saved.
//
// Arkemis addition: an Ink comment with `/AKHighlighter true` (the highlighter pen) is drawn with
// Multiply blending, as upstream draws Highlight comments.
// No DOM, no Node built-ins.

import {nums, num, int, nameAt, textOf, isDict, isName, text as textObj} from '../lib/cos.mjs';
import {n, textWidth, wrap, winAnsiBytes, literal, firstUndrawable} from '../lib/fonts.mjs';
import {needsUnicode, wrapLines} from '../lib/unicode-text.mjs';
import {viewMatrixFor} from '../lib/geom.mjs';
import {NOTE_SIZE, LINE_ENDINGS, stampByName, HIGHLIGHTER_KEY} from './types.mjs';

/** Length of an arrowhead for a line of width `w`. */
export const arrowSize = w => 6 + 3 * Math.max(w, 0);
/** Nominal radius of a cloudy border's bumps for a line of width `w` (intensity 1). */
export const cloudRadius = w => 6 + 1.5 * Math.max(w, 0);
const knownEnding = k => LINE_ENDINGS.includes(k);
const rad30 = Math.PI / 6;

const rg = c => `${n(c[0])} ${n(c[1])} ${n(c[2])} rg\n`;
const rgStroke = c => `${n(c[0])} ${n(c[1])} ${n(c[2])} RG\n`;
const lit = s => literal(winAnsiBytes(s));

/** Draw a line ending at `tip` for a line arriving from `from`; false for an unknown style. */
function lineEnd(kind, tip, from, w, out) {
  if (kind === 'None') return true;
  if (!knownEnding(kind)) return false;
  const dx = from[0] - tip[0], dy = from[1] - tip[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len)) return false;
  if (len === 0) return true;
  const s = arrowSize(w);
  const ix = dx / len, iy = dy / len;
  if (['OpenArrow', 'ClosedArrow', 'ROpenArrow', 'RClosedArrow'].includes(kind)) {
    const [ux, uy] = kind.startsWith('R') ? [-ix, -iy] : [ix, iy];
    const cos = Math.cos(rad30), sin = Math.sin(rad30);
    const a = [tip[0] + s * (ux * cos - uy * sin), tip[1] + s * (ux * sin + uy * cos)];
    const b = [tip[0] + s * (ux * cos + uy * sin), tip[1] + s * (-ux * sin + uy * cos)];
    const op = kind.endsWith('ClosedArrow') ? 'h B' : 'S';
    out.push(`${n(a[0])} ${n(a[1])} m ${n(tip[0])} ${n(tip[1])} l ${n(b[0])} ${n(b[1])} l ${op}\n`);
  } else if (kind === 'Square' || kind === 'Circle' || kind === 'Diamond') {
    const h = s / 2;
    if (kind === 'Square') out.push(`${n(tip[0] - h)} ${n(tip[1] - h)} ${n(s)} ${n(s)} re h B\n`);
    else if (kind === 'Circle') out.push(ellipse(tip[0] - h, tip[1] - h, tip[0] + h, tip[1] + h) + 'B\n');
    else {
      const px = -iy, py = ix;
      const v = (along, across) => [tip[0] + ix * along + px * across, tip[1] + iy * along + py * across];
      const [a, b, d, e] = [v(h, 0), v(0, h), v(-h, 0), v(0, -h)];
      out.push(`${n(a[0])} ${n(a[1])} m ${n(b[0])} ${n(b[1])} l ${n(d[0])} ${n(d[1])} l ${n(e[0])} ${n(e[1])} l h B\n`);
    }
  } else {
    const px = -iy, py = ix;
    let sx = px, sy = py;
    if (kind === 'Slash') { const q = Math.SQRT1_2; sx = px * q - py * q; sy = px * q + py * q; }
    const h = s / 2;
    out.push(`${n(tip[0] - sx * h)} ${n(tip[1] - sy * h)} m ${n(tip[0] + sx * h)} ${n(tip[1] + sy * h)} l S\n`);
  }
  return true;
}

/** Catmull-Rom Bézier segments through every point (ink is drawn so, as Acrobat draws it). */
export function smoothSegments(pts) {
  if (!pts.length) return [];
  const last = pts[pts.length - 1];
  const at = i => pts[i] ?? last;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(Math.max(0, i - 1)), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    out.push([[p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return out;
}
const smoothCurve = pts => smoothSegments(pts).map(([a, b, e]) => `${n(a[0])} ${n(a[1])} ${n(b[0])} ${n(b[1])} ${n(e[0])} ${n(e[1])} c\n`).join('');

export const MAX_CLOUD_BUMPS = 20000;

/** A closed cloudy outline through `pts` (§12.5.4 /BE /S /C). */
export function cloudPath(pts, r) {
  let area = 0, perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const sign = area >= 0 ? 1 : -1;
  r = Math.max(r, perimeter / (2 * MAX_CLOUD_BUMPS));
  let c = '';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (i === 0) c += `${n(a[0])} ${n(a[1])} m\n`;
    if (len < 1e-6) continue;
    const k = Math.min(10000, Math.max(1, Math.round(len / (2 * r))));
    const step = len / k, ux = dx / len, uy = dy / len, nx = sign * uy, ny = -sign * ux, h = (4 / 3) * step / 2;
    for (let j = 0; j < k; j++) {
      const p0 = [a[0] + ux * step * j, a[1] + uy * step * j], p1 = [a[0] + ux * step * (j + 1), a[1] + uy * step * (j + 1)];
      c += `${n(p0[0] + nx * h)} ${n(p0[1] + ny * h)} ${n(p1[0] + nx * h)} ${n(p1[1] + ny * h)} ${n(p1[0])} ${n(p1[1])} c\n`;
    }
  }
  return c + 'h\n';
}

/** `/C`-style colour arrays: undefined when absent (→ none), null when malformed, else RGB or 'none'. */
function color(d, key) {
  const v = d[key];
  if (v === undefined) return {ok: true, rgb: null};
  if (!Array.isArray(v) || v.some(x => typeof x !== 'number')) return {ok: false};
  switch (v.length) {
    case 0: return {ok: true, rgb: null};
    case 1: return {ok: true, rgb: [v[0], v[0], v[0]]};
    case 3: return {ok: true, rgb: [v[0], v[1], v[2]]};
    case 4: return {ok: true, rgb: [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])]};
    default: return {ok: false};
  }
}
const interiorColor = (d, fallback) => { const c = color(d, 'IC'); return (c.ok ? c.rgb : null) ?? fallback; };

/** §12.5.4 border width: /BS /W, else /Border[2], else 1. */
export function borderWidth(d) {
  const bs = isDict(d.BS) ? d.BS : null;
  const w = bs ? num(bs, 'W') : Array.isArray(d.Border) && typeof d.Border[2] === 'number' ? d.Border[2] : undefined;
  return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : 1;
}

const MAX_DASH = 64;
function dashArray(o) {
  if (!Array.isArray(o) || !o.length || o.length > MAX_DASH) return null;
  if (!o.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0) || !o.some(x => x > 0)) return null;
  return o;
}
function dash(d) {
  let arr;
  if (isDict(d.BS)) {
    if (nameAt(d.BS, 'S') !== 'D') return '';
    arr = d.BS.D === undefined ? [3] : dashArray(d.BS.D);
  } else arr = Array.isArray(d.Border) ? dashArray(d.Border[3]) : null;
  return arr ? `[${arr.map(n).join(' ')}] 0 d\n` : '';
}

/** `/DA` of a text box: [text colour, font size] (default black 12 pt). */
export function parseDa(d) {
  const da = textOf(d.DA) ?? '';
  const toks = da.trim().split(/\s+/);
  let col = [0, 0, 0], size = 12;
  const num_ = i => { const v = Number(toks[i]); return toks[i] !== undefined && toks[i] !== '' && Number.isFinite(v) ? v : undefined; };
  toks.forEach((t, i) => {
    if (t === 'rg' && i >= 3) { const r = num_(i - 3), g = num_(i - 2), b = num_(i - 1); if (r !== undefined && g !== undefined && b !== undefined) col = [r, g, b]; }
    else if (t === 'g' && i >= 1) { const g = num_(i - 1); if (g !== undefined) col = [g, g, g]; }
    else if (t === 'Tf' && i >= 1) { const s = num_(i - 1); if (s !== undefined && s > 0) size = s; }
  });
  return [col.map(x => Math.min(1, Math.max(0, x))), Math.min(size, 400)];
}

function extGState(opacity, multiply) {
  if (opacity >= 1 && !multiply) return null;
  const gs = {Type: '/ExtGState'};
  if (multiply) gs.BM = '/Multiply';
  gs.CA = opacity;
  gs.ca = opacity;
  return {GS0: gs};
}

const fontDict = base => ({Type: '/Font', Subtype: '/Type1', BaseFont: `/${base}`, Encoding: '/WinAnsiEncoding'});
const helveticaResource = () => ({Helv: fontDict('Helvetica')});

// Text in a script the standard faces cannot draw (free text, a stamp's By line): while a file is being written the shared Unicode text set (lib/unicode-text.mjs) is in
// `UNI`, and the appearance is drawn with the system font it embedded. Without it (the page view, a file with no such text) the standard faces draw what they can.
let UNI = null;
export function withUnicode(uni, fn) { const prev = UNI; UNI = uni; try { return fn(); } finally { UNI = prev; } }
const uniText = s => !!UNI && typeof s === 'string' && needsUnicode(s) && UNI.canDraw(s);
/** The fonts the Unicode text drawn so far uses, as resource entries (name -> font object). */
const uniFonts = () => Object.fromEntries(UNI.fonts().map(f => [f.name, f.ref]));
/** The width of a caption or label: in the system font where the text is drawn with it, else in Helvetica. */
const capWidth = (text, size) => (uniText(text) ? UNI.width(text, size) : textWidth(text, size));

/** /PCPictureRotate, /PCStampRotate, /PCTextRotate: 0, 90, 180 or 270. */
const quarterOf = (d, key) => { const t = ((int(d, key) ?? 0) % 360 + 360) % 360; return t - (t % 90); };

/** The first text the standard fonts can't draw: [what, character] or null. */
export function undrawableText(d) {
  const t = key => textOf(d[key]);
  const subtype = nameAt(d, 'Subtype');
  let what, s;
  if (subtype === 'FreeText') { what = "the comment's text"; s = t('Contents'); }
  else if (subtype === 'Line' && !('PCMeasureValue' in d)) { what = "the line's caption"; s = lineCaption(d); }
  else if (['Line', 'PolyLine', 'Polygon'].includes(subtype)) { what = 'the measurement label'; s = t('PCMeasureValue'); }
  else if (subtype === 'Stamp' && d.PCStamp === true) { what = 'the stamp\'s "By" line'; s = t('PCByLine'); }
  else if (subtype === 'Redact') { what = "the redaction's overlay text"; s = t('OverlayText'); }
  else return null;
  if (s == null) return null;
  if (uniText(s)) return null;
  const c = firstUndrawable(s);
  return c ? [what, c] : null;
}

/** caret_layout: the caret's box and, for /Sy /P, the pilcrow's origin and size. */
function caretLayout(d, rect) {
  const rd = nums(d, 'RD');
  const okRd = rd && rd.length === 4 && rd.every(x => x >= 0) ? rd : null;
  let caret = okRd ? [rect[0] + okRd[0], rect[1] + okRd[3], rect[2] - okRd[2], rect[3] - okRd[1]] : rect.slice();
  if (!(caret[2] > caret[0] && caret[3] > caret[1])) caret = rect.slice();
  if (nameAt(d, 'Sy') !== 'P') return [caret, null];
  let size = (caret[3] - caret[1]) * 0.6;
  const gap = size * 0.1, glyph = textWidth('¶', size), need = gap + glyph;
  let room = rect[2] - caret[2];
  if (room < need) caret[2] -= Math.min(need - room, (caret[2] - caret[0]) * 0.5);
  room = rect[2] - caret[2];
  const scale = need > room ? room / need : 1;
  size *= scale;
  if (!(Number.isFinite(size) && size > 0)) return [caret, null];
  return [caret, [caret[2] + gap * scale, caret[1] + size * 0.18, size]];
}

/** appearance_context */
function context(d) {
  if ('Measure' in d && !('PCMeasureValue' in d)) return null;
  const subtype = nameAt(d, 'Subtype');
  const r = nums(d, 'Rect');
  if (!subtype || !r || r.length !== 4) return null;
  const rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  const cloudy = isDict(d.BE) && nameAt(d.BE, 'S') === 'C';
  if (cloudy && subtype !== 'Polygon') return null;
  const stroke = color(d, 'C');
  if (!stroke.ok) return null;
  const ca = num(d, 'CA');
  return {d, subtype, rect, cloudy, opacity: Math.min(1, Math.max(0, ca ?? 1)), stroke: stroke.rgb, width: borderWidth(d)};
}

/** Whether a comment is drawn with Multiply (Highlight, and the highlighter pen). */
export const multiplies = d => nameAt(d, 'Subtype') === 'Highlight' || (nameAt(d, 'Subtype') === 'Ink' && d[HIGHLIGHTER_KEY] === true);

const form = (bbox, content, resources, matrix) => ({bbox, content, resources, ...(matrix ? {matrix} : {})});

/** Draw the normal appearance of an annotation dictionary, or null if it can't be drawn faithfully. */
export function build(d) {
  const ctx = context(d);
  if (!ctx) return null;
  const drawing = {resources: {}, content: [], tail: ''};
  const gs = extGState(ctx.opacity, multiplies(d));
  if (gs) { drawing.resources.ExtGState = gs; drawing.content.push('/GS0 gs\n'); }
  switch (ctx.subtype) {
    case 'Text': return drawIcon(ctx, 'Note', [1, 0.82, 0], drawing);
    case 'FileAttachment': return drawIcon(ctx, 'PushPin', [0, 0.47, 0.84], drawing);
    case 'Stamp': return drawStamp(ctx, drawing);
    case 'FreeText': return drawFreeText(ctx, drawing);
    default: break;
  }
  const ok = {Highlight: drawMarkup, Underline: drawMarkup, StrikeOut: drawMarkup, Squiggly: drawMarkup, Redact: drawRedaction, Square: drawBox,
    Circle: drawBox, Line: drawLine, Polygon: drawPolygon, PolyLine: drawPolygon, Caret: drawCaret, Ink: drawInk}[ctx.subtype];
  if (!ok || !ok(ctx, drawing)) return null;
  return finish(ctx, drawing);
}

function finish(ctx, drawing) {
  let out = drawing.content.join('') + drawing.tail;
  const value = textOf(ctx.d.PCMeasureValue);
  if (value != null && [...value].length <= 256 && ['Line', 'PolyLine', 'Polygon'].includes(ctx.subtype)) {
    const size = 10, x = (ctx.rect[0] + ctx.rect[2] - capWidth(value, size)) * 0.5, y = ctx.rect[3] - 12;
    if (uniText(value)) {
      out += `${rg(ctx.stroke ?? [0, 0.47, 0.84])}BT ${n(x)} ${n(y)} Td ${UNI.ops(value, size)}ET\n`;
      drawing.resources.Font = uniFonts();
    } else {
      out += `${rg(ctx.stroke ?? [0, 0.47, 0.84])}BT /Helv ${n(size)} Tf ${n(x)} ${n(y)} Td ${lit(value)} Tj ET\n`;
      drawing.resources.Font = helveticaResource();
    }
  }
  return form(ctx.rect, out, drawing.resources);
}

function drawMarkup(ctx, drawing) {
  const q = nums(ctx.d, 'QuadPoints');
  if (!q || !q.length || q.length % 8 !== 0 || !ctx.stroke) return false;
  const col = ctx.stroke, c = drawing.content;
  for (let k = 0; k < q.length; k += 8) {
    const p = i => [q[k + 2 * i], q[k + 2 * i + 1]];
    const [p1, p2, p3, p4] = [p(0), p(1), p(2), p(3)];
    const h = Math.hypot(p1[0] - p3[0], p1[1] - p3[1]);
    const at = (bottom, top, t) => [bottom[0] + (top[0] - bottom[0]) * t, bottom[1] + (top[1] - bottom[1]) * t];
    if (ctx.subtype === 'Highlight') {
      c.push(rg(col));
      c.push(`${n(p1[0])} ${n(p1[1])} m ${n(p2[0])} ${n(p2[1])} l ${n(p4[0])} ${n(p4[1])} l ${n(p3[0])} ${n(p3[1])} l h f\n`);
    } else if (ctx.subtype === 'Underline' || ctx.subtype === 'StrikeOut') {
      const lw = Math.min(3, Math.max(0.5, h * 0.07));
      const t = ctx.subtype === 'Underline' ? 0.08 : 0.42;
      const a = at(p3, p1, t), b = at(p4, p2, t);
      c.push(`${rgStroke(col)}${n(lw)} w\n${n(a[0])} ${n(a[1])} m ${n(b[0])} ${n(b[1])} l S\n`);
    } else {
      const lw = Math.min(2, Math.max(0.5, h * 0.05)), amp = Math.max(h * 0.06, 0.75);
      const len = Math.hypot(p4[0] - p3[0], p4[1] - p3[1]), step = Math.max(h / 4, 1.5);
      const steps = Math.min(10000, Math.max(1, Math.ceil(len / step)));
      c.push(`${rgStroke(col)}${n(lw)} w 1 j\n`);
      const [ux, uy] = h > 0 ? [(p1[0] - p3[0]) / h, (p1[1] - p3[1]) / h] : [0, 1];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, base = [p3[0] + (p4[0] - p3[0]) * t, p3[1] + (p4[1] - p3[1]) * t];
        const up = i % 2 === 0 ? amp * 2 : 0;
        c.push(`${n(base[0] + ux * up)} ${n(base[1] + uy * up)} ${i === 0 ? 'm' : 'l'}\n`);
      }
      c.push('S\n');
    }
  }
  return true;
}

function drawRedaction(ctx, drawing) {
  const q = nums(ctx.d, 'QuadPoints');
  if (!q || !q.length || q.length % 8 !== 0) return false;
  const c = drawing.content;
  c.push(`${rgStroke(ctx.stroke ?? [0.89, 0.13, 0.13])}1 w\n`);
  for (let k = 0; k < q.length; k += 8) c.push(`${n(q[k])} ${n(q[k + 1])} m ${n(q[k + 2])} ${n(q[k + 3])} l ${n(q[k + 6])} ${n(q[k + 7])} l ${n(q[k + 4])} ${n(q[k + 5])} l h S\n`);
  return true;
}

const paintOp = (fill, stroke) => (fill && stroke ? 'B\n' : fill ? 'f\n' : stroke ? 'S\n' : 'n\n');

function drawBox(ctx, drawing) {
  const {d, rect, stroke, width: w} = ctx, c = drawing.content;
  const fill = interiorColor(d, null);
  if (!stroke && !fill) return true;
  const inset = w / 2;
  const [x0, y0, x1, y1] = [rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset];
  if (fill) c.push(rg(fill));
  if (stroke) c.push(`${rgStroke(stroke)}${n(w)} w\n${dash(d)}`);
  c.push(ctx.subtype === 'Square' ? `${n(x0)} ${n(y0)} ${n(x1 - x0)} ${n(y1 - y0)} re\n` : ellipse(x0, y0, x1, y1));
  c.push(paintOp(!!fill, !!stroke && w > 0));
  return true;
}

function drawLine(ctx, drawing) {
  const {d, stroke: col, width: w} = ctx, c = drawing.content;
  const l = nums(d, 'L');
  if (!l || l.length !== 4 || !col) return false;
  let ends;
  if (d.LE === undefined) ends = ['None', 'None'];
  else if (Array.isArray(d.LE) && d.LE.every(isName)) ends = d.LE.map(x => x.slice(1));
  else return false;
  if (ends.length !== 2 || ends.some(e => !knownEnding(e))) return false;
  const fill = interiorColor(d, col) ?? col;
  const layout = lineLayout(d, [[l[0], l[1]], [l[2], l[3]]], w);
  const [p, q] = layout.line;
  c.push(`${rgStroke(col)}${rg(fill)}${n(w)} w 1 J 1 j\n${dash(d)}`);
  for (const [s, e] of [...layout.leaders, ...layout.strokes, ...(layout.tick ? [layout.tick] : [])]) c.push(`${n(s[0])} ${n(s[1])} m ${n(e[0])} ${n(e[1])} l S\n`);
  c.push('[] 0 d\n');
  if (!lineEnd(ends[0], p, q, w, c) || !lineEnd(ends[1], q, p, w, c)) return false;
  if (layout.caption) {
    const [txt, m] = layout.caption;
    if (uniText(txt)) {
      drawing.tail += `q 0 g BT ${m.map(n).join(' ')} Tm ${UNI.ops(txt, CAPTION_SIZE)}ET Q\n`;
      drawing.resources.Font = uniFonts();
    } else {
      drawing.tail += `q 0 g BT /Helv ${n(CAPTION_SIZE)} Tf ${m.map(n).join(' ')} Tm ${lit(txt)} Tj ET Q\n`;
      drawing.resources.Font = helveticaResource();
    }
  }
  return true;
}

function drawPolygon(ctx, drawing) {
  const {d, subtype, stroke: col, width: w, cloudy} = ctx, c = drawing.content;
  const v = nums(d, 'Vertices');
  if (!v || v.length < 4 || v.length % 2) return false;
  const pts = [];
  for (let i = 0; i < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  const closed = subtype === 'Polygon';
  const fill = closed ? interiorColor(d, null) : null;
  let ends = null;
  if (subtype === 'PolyLine' && d.LE !== undefined) {
    if (!Array.isArray(d.LE) || d.LE.length !== 2 || !d.LE.every(isName)) return false;
    ends = d.LE.map(x => x.slice(1));
    if (ends.some(e => !knownEnding(e))) return false;
  }
  if (fill) c.push(rg(fill));
  if (col) c.push(`${rgStroke(col)}${n(w)} w 1 J 1 j\n${dash(d)}`);
  if (cloudy) {
    const intensity = num(d.BE, 'I') ?? 1;
    c.push(cloudPath(pts, cloudRadius(w) * Math.min(2, Math.max(0.5, intensity))));
  } else {
    pts.forEach((p, i) => c.push(`${n(p[0])} ${n(p[1])} ${i === 0 ? 'm' : 'l'}\n`));
    if (closed) c.push('h\n');
  }
  c.push(paintOp(!!fill, !!col && w > 0));
  if (ends) {
    if (!col) return false;
    const f = interiorColor(d, col) ?? col;
    c.push(`[] 0 d\n${rg(f)}`);
    if (!lineEnd(ends[0], pts[0], pts[1], w, c) || !lineEnd(ends[1], pts[pts.length - 1], pts[pts.length - 2], w, c)) return false;
  }
  return true;
}

function drawCaret(ctx, drawing) {
  const col = ctx.stroke ?? [0, 0.47, 0.84];
  const [caret, pilcrow] = caretLayout(ctx.d, ctx.rect);
  const [x0, y0, x1, y1] = caret, cx = (x0 + x1) / 2, h = y1 - y0;
  drawing.content.push(`${rg(col)}${n(x0)} ${n(y0)} m ${n(cx - (x1 - x0) * 0.1)} ${n(y0 + h * 0.2)} ${n(cx)} ${n(y1 - h * 0.25)} ${n(cx)} ${n(y1)} c ${n(cx)} ${n(y1 - h * 0.25)} ${n(cx + (x1 - x0) * 0.1)} ${n(y0 + h * 0.2)} ${n(x1)} ${n(y0)} c h f\n`);
  if (pilcrow) {
    const [x, y, size] = pilcrow;
    drawing.tail += `BT /Helv ${n(size)} Tf ${n(x)} ${n(y)} Td (¶) Tj ET\n`;
    drawing.resources.Font = helveticaResource();
  }
  return true;
}

function drawInk(ctx, drawing) {
  const {d, stroke: col, width: w} = ctx, c = drawing.content;
  if (!col || !Array.isArray(d.InkList)) return false;
  c.push(`${rgStroke(col)}${n(w)} w 1 J 1 j\n${dash(d)}`);
  for (const s of d.InkList) {
    if (!Array.isArray(s) || s.some(x => typeof x !== 'number')) return false;
    const pts = [];
    for (let i = 0; i + 1 < s.length; i += 2) pts.push([s[i], s[i + 1]]);
    if (!pts.length) continue;
    const first = pts[0];
    c.push(`${n(first[0])} ${n(first[1])} m\n`);
    if (pts.length === 1) c.push(`${n(first[0] + 0.01)} ${n(first[1])} l\n`);
    else if (pts.length === 2) c.push(`${n(pts[1][0])} ${n(pts[1][1])} l\n`);
    else c.push(smoothCurve(pts));
    c.push('S\n');
  }
  return true;
}

function drawStamp(ctx, drawing) {
  const {d, rect, stroke, opacity} = ctx;
  const c = drawing.content;
  const res = drawing.resources;
  if (Array.isArray(d.PCOutline)) {
    const [x0, y0, x1, y1] = rect, w = x1 - x0, h = y1 - y0;
    c.push(rg(stroke ?? [0, 0, 0]));
    for (const contour of d.PCOutline) {
      const v = Array.isArray(contour) ? contour.filter(x => typeof x === 'number') : [];
      for (let i = 0; i + 1 < v.length; i += 2) c.push(`${n(x0 + v[i] * w)} ${n(y0 + v[i + 1] * h)} ${i === 0 ? 'm' : 'l'}\n`);
      if (v.length >= 6) c.push('h\n');
    }
    c.push('f\n');
    return form(rect, c.join(''), res);
  }
  if (d.PCPicture && typeof d.PCPicture === 'object' && Array.isArray(d.PCPicture.$ref)) {
    const [x0, y0, x1, y1] = rect, w = x1 - x0, h = y1 - y0;
    const image = d.PCPictureImage === true;
    let place;
    if (image) place = `${n(w)} 0 0 ${n(h)} ${n(x0)} ${n(y0)} cm`;
    else {
      const size = nums(d, 'PCPictureSize');
      if (!size || size.length !== 2 || !(size[0] > 0) || !(size[1] > 0)) return null;
      place = `${n(w / size[0])} 0 0 ${n(h / size[1])} ${n(x0)} ${n(y0)} cm`;
    }
    c.push(`q ${place} /Pic Do Q\n`);
    res.XObject = {Pic: d.PCPicture};
    const turn = quarterOf(d, 'PCPictureRotate');
    let matrix;
    if (image && turn) { const m = viewMatrixFor(turn, [0, 0, 0, 0]); matrix = [m[0], m[1], m[2], m[3], 0, 0]; }
    return form(rect, c.join(''), res, matrix);
  }
  const name = nameAt(d, 'Name');
  if (!name) return null;
  const col = stroke ?? [0, 0, 0];
  const turn = quarterOf(d, 'PCStampRotate');
  let draw = rect;
  if (turn) {
    const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
    const [dw, dh] = turn % 180 ? [rh, rw] : [rw, rh];
    if (dw < 1 || dh < 1) return null;
    draw = [0, 0, dw, dh];
  }
  const turned = f => (turn ? {...f, matrix: viewMatrixFor(turn, rect)} : f);
  const [x0, y0, x1, y1] = draw, w = x1 - x0, h = y1 - y0, lw = Math.min(w, h) * 0.12;
  switch (name) {
    case 'PCCheck': c.push(`${rgStroke(col)}${n(lw)} w 1 J 1 j\n${n(x0 + w * 0.15)} ${n(y0 + h * 0.5)} m ${n(x0 + w * 0.4)} ${n(y0 + h * 0.2)} l ${n(x0 + w * 0.88)} ${n(y0 + h * 0.85)} l S\n`); break;
    case 'PCCross': c.push(`${rgStroke(col)}${n(lw)} w 1 J\n${n(x0 + w * 0.18)} ${n(y0 + h * 0.18)} m ${n(x1 - w * 0.18)} ${n(y1 - h * 0.18)} l ${n(x0 + w * 0.18)} ${n(y1 - h * 0.18)} m ${n(x1 - w * 0.18)} ${n(y0 + h * 0.18)} l S\n`); break;
    case 'PCDot': { const r = Math.min(w, h) * 0.3; c.push(rg(col) + ellipse(x0 + w / 2 - r, y0 + h / 2 - r, x0 + w / 2 + r, y0 + h / 2 + r) + 'f\n'); break; }
    case 'PCLine': c.push(`${rgStroke(col)}${n(Math.min(2, Math.max(0.5, h)))} w 1 J\n${n(x0)} ${n(y0 + h / 2)} m ${n(x1)} ${n(y0 + h / 2)} l S\n`); break;
    default: {
      if (d.PCStamp !== true) return null;
      const kind = stampByName(name);
      if (!kind) return null;
      const by = textOf(d.PCByLine);
      return turned(stamp(kind.label, kind.group === 'SignHere', draw, stroke ?? kind.color, by, opacity, res));
    }
  }
  return turn ? turned(form(draw, c.join(''), res)) : form(rect, c.join(''), res);
}

function drawFreeText(ctx, drawing) {
  const {d, stroke} = ctx;
  let {rect} = ctx;
  const c = [];
  const res = drawing.resources;
  if (drawing.content.length) c.push(...drawing.content);
  const [textColor, size] = parseDa(d);
  const bg = stroke;
  const bw = 'BS' in d || 'Border' in d ? borderWidth(d) : 0;
  const turn = 'CL' in d ? 0 : quarterOf(d, 'PCTextRotate');
  let matrix = null;
  if (turn) {
    const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
    const [dw, dh] = turn % 180 ? [rh, rw] : [rw, rh];
    if (dw < 1 || dh < 1) return null;
    matrix = viewMatrixFor(turn, rect);
    rect = [0, 0, dw, dh];
  }
  const full = rect;
  if ('CL' in d) {
    const cl = nums(d, 'CL'), rd = nums(d, 'RD');
    if (!cl || (cl.length !== 4 && cl.length !== 6) || !rd || rd.length !== 4 || rd.some(x => x < 0)) return null;
    rect = [full[0] + rd[0], full[1] + rd[1], full[2] - rd[2], full[3] - rd[3]];
    if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) return null;
    const end = d.LE === undefined ? 'None' : isName(d.LE) ? d.LE.slice(1) : null;
    if (!end || !knownEnding(end)) return null;
    const lw = Math.max(bw, 0.5);
    const pts = [];
    for (let i = 0; i + 1 < cl.length; i += 2) pts.push([cl[i], cl[i + 1]]);
    c.push(`${rgStroke(textColor)}${rg(bg ?? [1, 1, 1])}${n(lw)} w 1 J 1 j\n`);
    pts.forEach((p, i) => c.push(`${n(p[0])} ${n(p[1])} ${i === 0 ? 'm' : 'l'}\n`));
    c.push('S\n');
    if (!lineEnd(end, pts[0], pts[1], lw, c)) return null;
  }
  if (bg) c.push(`${rg(bg)}${n(rect[0])} ${n(rect[1])} ${n(rect[2] - rect[0])} ${n(rect[3] - rect[1])} re f\n`);
  if (bw > 0) {
    const h = bw / 2;
    c.push(`${rgStroke(textColor)}${n(bw)} w\n${dash(d)}${n(rect[0] + h)} ${n(rect[1] + h)} ${n(rect[2] - rect[0] - bw)} ${n(rect[3] - rect[1] - bw)} re S\n[] 0 d\n`);
  }
  const txt = textOf(d.Contents) ?? '';
  const pad = 2 + bw, width = Math.max(rect[2] - rect[0] - 2 * pad, 1), q = int(d, 'Q') ?? 0;
  c.push(`${n(rect[0])} ${n(rect[1])} ${n(rect[2] - rect[0])} ${n(rect[3] - rect[1])} re W n\nBT\n/Helv ${n(size)} Tf\n${rg(textColor)}`);
  let y = rect[3] - pad - size * 0.9;
  const uni = uniText(txt);
  const measure = line => (uni ? UNI.width(line, size) : textWidth(line, size));
  for (const line of uni ? wrapLines(txt, width, measure) : wrap(txt, size, width)) {
    if (y < rect[1] - size) break;
    const lw = measure(line);
    const x = q === 1 ? rect[0] + pad + (width - lw) / 2 : q === 2 ? rect[2] - pad - lw : rect[0] + pad;
    c.push(`1 0 0 1 ${n(x)} ${n(y)} Tm ${uni ? UNI.ops(line, size) : `${lit(line)} Tj\n`}`);
    y -= size * 1.2;
  }
  c.push('ET\n');
  res.Font = {...helveticaResource(), ...(uni ? uniFonts() : {})};
  return form(full, c.join(''), res, matrix);
}

function drawIcon(ctx, fallbackName, fallback, drawing) {
  const col = ctx.stroke ?? fallback;
  const icon = nameAt(ctx.d, 'Name') ?? fallbackName;
  drawing.content.push(fallbackName === 'Note' ? noteIcon(icon, col) : attachIcon(icon, col));
  return form([0, 0, NOTE_SIZE, NOTE_SIZE], drawing.content.join(''), drawing.resources);
}

// ── symbols.rs ──────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_GREY = [0.45, 0.45, 0.45];
function standardStamp(name) {
  const palette = ['Approved', 'NotApproved', 'NotForPublicRelease', 'Confidential', 'Final', 'ForComment', 'Draft', 'ForPublicRelease'];
  if (palette.includes(name)) { const k = stampByName(name); return [k.label, k.color]; }
  const like = {Experimental: ['EXPERIMENTAL', 'Draft'], AsIs: ['AS IS', 'Draft'], Expired: ['EXPIRED', 'NotApproved'], Sold: ['SOLD', 'Approved'],
    Departmental: ['DEPARTMENTAL', 'Draft'], TopSecret: ['TOP SECRET', 'Confidential']}[name];
  return like ? [like[0], stampByName(like[1]).color] : null;
}

/** symbols.rs `display_stamp`: display-only appearance of a rubber stamp written without one. */
export function displayStamp(d) {
  const own = d.PCStamp === true || 'PCPicture' in d || 'PCOutline' in d;
  if (nameAt(d, 'Subtype') !== 'Stamp' || own || 'AP' in d) return null;
  const r = nums(d, 'Rect');
  if (!r || r.length !== 4) return null;
  const rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) return null;
  const opacity = Math.min(1, Math.max(0, num(d, 'CA') ?? 1));
  const c = color(d, 'C');
  const stroke = c.ok ? c.rgb : null;
  const res = {};
  const gs = extGState(opacity, false);
  if (gs) res.ExtGState = gs;
  const intent = nameAt(d, 'IT');
  const name = nameAt(d, 'Name') ?? (intent === undefined || intent === 'Stamp' ? 'Draft' : undefined);
  const std = name ? standardStamp(name) : null;
  if (std) return stamp(std[0], false, rect, stroke ?? std[1], null, opacity, res);
  const [x0, y0, x1, y1] = rect, a0 = x0 + 0.5, b0 = y0 + 0.5, a1 = x1 - 0.5, b1 = y1 - 0.5;
  let s = opacity < 1 ? '/GS0 gs\n' : '';
  s += `${rgStroke(PLACEHOLDER_GREY)}1 w\n${n(a0)} ${n(b0)} ${n(a1 - a0)} ${n(b1 - b0)} re\n${n(a0)} ${n(b0)} m ${n(a1)} ${n(b1)} l\n${n(a0)} ${n(b1)} m ${n(a1)} ${n(b0)} l\nS\n`;
  return form(rect, s, res);
}

export const CAPTION_SIZE = 10;
const MAX_CAPTION_CHARS = 256;
const MAX_LINE_EXTENT = 14400;
const lineLength = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_LINE_EXTENT, Math.max(-MAX_LINE_EXTENT, v)) : 0);

/** symbols.rs `line_caption`. */
export function lineCaption(d) {
  if (d.Cap !== true || 'PCMeasureValue' in d) return null;
  const contents = textOf(d.Contents);
  const raw = contents && contents.trim() ? contents : textOf(d.RC) != null ? richPlain(textOf(d.RC)) : null;
  if (raw == null) return null;
  const caption = [...raw.split(/\s+/).filter(Boolean).join(' ')].filter(ch => !/[\u0000-\u001f\u007f-\u009f]/.test(ch)).slice(0, MAX_CAPTION_CHARS).join('');
  return caption || null;
}

/** symbols.rs `rich_plain`: the text of rich text (§12.7.4.3). */
export function richPlain(rc) {
  let out = '', tag = null;
  for (const ch of [...rc].slice(0, MAX_CAPTION_CHARS * 64)) {
    if (tag === null && ch === '<') tag = '';
    else if (tag !== null && ch === '>') {
      const nm = tag.replace(/^\/+/, '').split(/[\s/]/)[0].toLowerCase();
      if (['p', 'br', 'div', 'li'].includes(nm)) out += ' ';
      tag = null;
    } else if (tag !== null) { if (tag.length < 16) tag += ch; }
    else out += ch;
  }
  return out.replace(/&([^;]{1,10});/g, (m, nm) => {
    const map = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    if (map[nm]) return map[nm];
    const num_ = nm.startsWith('#') ? (/^#[xX]/.test(nm) ? parseInt(nm.slice(2), 16) : parseInt(nm.slice(1), 10)) : NaN;
    return Number.isFinite(num_) && num_ <= 0x10ffff ? String.fromCodePoint(num_) : m;
  });
}

/** symbols.rs `line_layout`: leader lines, caption and strokes of a Line annotation. */
export function lineLayout(d, [a, b], w) {
  const plain = {line: [a, b], strokes: [[a, b]], leaders: [], tick: null, caption: null};
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len <= 0) return plain;
  const ux = dx / len, uy = dy / len;
  const out = {line: [a, b], strokes: [], leaders: [], tick: null, caption: null};
  const ll = lineLength(num(d, 'LL'));
  if (ll !== 0) {
    const s = Math.sign(ll), nx = -uy * s, ny = ux * s;
    const llo = Math.max(0, lineLength(num(d, 'LLO'))), lle = Math.max(0, lineLength(num(d, 'LLE')));
    const at = (p, k) => [p[0] + nx * k, p[1] + ny * k];
    const off = Math.abs(ll) + llo;
    out.line = [at(a, off), at(b, off)];
    out.leaders = [[at(a, llo), at(a, off + lle)], [at(b, llo), at(b, off + lle)]];
  }
  const p = out.line[0];
  const along = t => [p[0] + ux * t, p[1] + uy * t];
  let gap = null;
  const txt = lineCaption(d);
  if (txt) {
    const size = CAPTION_SIZE, width = capWidth(txt, size);
    const [tx, ty] = ux < 0 || (ux === 0 && uy < 0) ? [-ux, -uy] : [ux, uy];
    const vx = -ty, vy = tx;
    const co = nums(d, 'CO');
    const h = lineLength(co && co.length === 2 ? co[0] : undefined), v = lineLength(co && co.length === 2 ? co[1] : undefined);
    const top = nameAt(d, 'CP') === 'Top';
    const centre = len / 2 + h * (tx * ux + ty * uy);
    const mid = along(centre);
    const base = top ? Math.max(w, 0) / 2 + 2 + v : v - size * 0.35;
    const origin = [mid[0] - tx * width / 2 + vx * base, mid[1] - ty * width / 2 + vy * base];
    out.caption = [txt, [tx, ty, -ty, tx, origin[0], origin[1]]];
    if (!top && Math.abs(v) < size / 2) {
      const half = width / 2 + 2;
      gap = [Math.min(len, Math.max(0, centre - half)), Math.min(len, Math.max(0, centre + half))];
    } else if (!top) {
      const reach = v - Math.sign(v) * size * 0.4;
      out.tick = [mid, [mid[0] + vx * reach, mid[1] + vy * reach]];
    }
  }
  out.strokes = gap ? [[0, gap[0]], [gap[1], len]].filter(([s, e]) => e > s).map(([s, e]) => [along(s), along(e)]) : [out.line];
  const fin = q => Number.isFinite(q[0]) && Number.isFinite(q[1]);
  const ok = [...out.line, ...out.strokes.flat(), ...out.leaders.flat(), ...(out.tick ?? [])].every(fin) && (!out.caption || out.caption[1].every(Number.isFinite));
  return ok ? out : plain;
}

/** symbols.rs `stamp`: a rubber stamp's frame (a tag for sign-here) and label. */
export function stamp(label, signHere, rect, col, by, opacity, res) {
  const [x0, y0, x1, y1] = rect, h = y1 - y0;
  let c = opacity < 1 ? '/GS0 gs\n' : '';
  const lw = Math.min(3, Math.max(1, h * 0.07)), inset = lw / 2 + 0.5;
  if (signHere) {
    const tip = h * 0.45;
    c += `${rg(col)}${rgStroke(col)}${n(lw)} w 1 j\n${n(x0 + inset)} ${n(y0 + h / 2)} m ${n(x0 + tip)} ${n(y1 - inset)} l ${n(x1 - inset)} ${n(y1 - inset)} l ${n(x1 - inset)} ${n(y0 + inset)} l ${n(x0 + tip)} ${n(y0 + inset)} l h B\n`;
  } else {
    const r = Math.min(h * 0.2, 8), k = 0.55228475 * r;
    const [a0, b0, a1, b1] = [x0 + inset, y0 + inset, x1 - inset, y1 - inset];
    const tint = col.map(v => 1 - (1 - v) * 0.12);
    const N = (...v) => v.map(n).join(' ');
    c += `${rg(tint)}${rgStroke(col)}${n(lw)} w\n${N(a0 + r, b0)} m ${N(a1 - r, b0)} l ${N(a1 - r + k, b0, a1, b0 + r - k, a1, b0 + r)} c ${N(a1, b1 - r)} l ${N(a1, b1 - r + k, a1 - r + k, b1, a1 - r, b1)} c ${N(a0 + r, b1)} l ${N(a0 + r - k, b1, a0, b1 - r + k, a0, b1 - r)} c ${N(a0, b0 + r)} l ${N(a0, b0 + r - k, a0 + r - k, b0, a0 + r, b0)} c h B\n`;
  }
  const uni = UNI && (needsUnicode(label) || (by != null && needsUnicode(by))) && UNI.canDraw(label) && (by == null || UNI.canDraw(by)) ? UNI : null;
  const W = (s, sz, bold = false) => (uni ? uni.width(s, sz, {bold}) : textWidth(s, sz, bold));
  const [titleH, byH] = by != null ? [h * 0.5, h * 0.22] : [h * 0.52, 0];
  const area = signHere ? [x0 + h * 0.45, x1 - lw * 2] : [x0 + lw * 2, x1 - lw * 2];
  let size = titleH;
  let tw = W(label, size, true) * 1.12;
  if (tw > area[1] - area[0] - 4) size *= (area[1] - area[0] - 4) / tw;
  tw = W(label, size, true) * 1.12;
  const textCol = signHere ? [1, 1, 1] : col;
  const ty = by != null ? y0 + h * 0.48 : y0 + (h - size * 0.72) / 2;
  c += `BT\n${rg(textCol)}/HelvB ${n(size)} Tf\n1 0 0 1 ${n(area[0] + (area[1] - area[0] - tw) / 2)} ${n(ty)} Tm ${uni ? uni.ops(label, size, {bold: true}) : `${lit(label)} Tj\n`}`;
  if (by != null) {
    let s = byH, bw = W(by, s);
    if (bw > area[1] - area[0] - 4) s *= (area[1] - area[0] - 4) / bw;
    bw = W(by, s);
    c += `/Helv ${n(s)} Tf\n1 0 0 1 ${n(area[0] + (area[1] - area[0] - bw) / 2)} ${n(y0 + h * 0.18)} Tm ${uni ? uni.ops(by, s) : `${lit(by)} Tj\n`}`;
  }
  c += 'ET\n';
  res.Font = {HelvB: fontDict('Helvetica-Bold'), Helv: fontDict('Helvetica'), ...(uni ? uniFonts() : {})};
  return form(rect, c, res);
}

/** symbols.rs `ellipse`: an ellipse inscribed in a rectangle, four Bézier arcs. */
export function ellipse(x0, y0, x1, y1) {
  const k = 0.55228475, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, ox = rx * k, oy = ry * k;
  let s = `${n(cx + rx)} ${n(cy)} m\n`;
  for (const seg of [[cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry], [cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    [cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry], [cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy]]) s += `${seg.map(n).join(' ')} c\n`;
  return s + 'h\n';
}

export function attachIcon(name, col) {
  let s = `${rg(col)}${rgStroke(col)}1.2 w 1 j 1 J\n`;
  switch (name) {
    case 'Paperclip': s += '8 4 m 8 15 l 8 18 13 18 13 15 c 13 6 l 13 3 10 3 10 6 c 10 14 l S\n'; break;
    case 'Graph': s += '3 3 m 3 17 l 3 3 m 17 3 l S\n5 3 3 6 re 9 3 3 10 re 13 3 3 13 re f\n'; break;
    case 'Tag': s += '3 10 m 8 15 l 17 15 l 17 5 l 8 5 l h S\n7.3 10 m 7.3 10.7 6.7 11.3 6 11.3 c 5.3 11.3 4.7 10.7 4.7 10 c 4.7 9.3 5.3 8.7 6 8.7 c 6.7 8.7 7.3 9.3 7.3 10 c f\n'; break;
    default: s += '10 2 m 10 9 l S\n6 9 m 14 9 l 14 11 l 12 12 l 12 16 l 13.5 17 l 13.5 18.5 l 6.5 18.5 l 6.5 17 l 8 16 l 8 12 l 6 11 l h f\n';
  }
  return s;
}

function circlePath(x, y, r) {
  const k = r * 0.5523, p = n;
  return `${p(x + r)} ${p(y)} m ${p(x + r)} ${p(y + k)} ${p(x + k)} ${p(y + r)} ${p(x)} ${p(y + r)} c ${p(x - k)} ${p(y + r)} ${p(x - r)} ${p(y + k)} ${p(x - r)} ${p(y)} c ${p(x - r)} ${p(y - k)} ${p(x - k)} ${p(y - r)} ${p(x)} ${p(y - r)} c ${p(x + k)} ${p(y - r)} ${p(x + r)} ${p(y - k)} ${p(x + r)} ${p(y)} c h\n`;
}

export function noteIcon(name, col) {
  let s = `${rg(col)}0.25 0.25 0.25 RG 0.8 w 1 j 1 J\n`;
  switch (name) {
    case 'Comment':
      s += '3 18.5 m 17 18.5 l 18.5 18.5 18.5 17 18.5 17 c 18.5 8 l 18.5 6.5 17 6.5 17 6.5 c 9.5 6.5 l 5 2 l 5.5 6.5 l 3 6.5 l 1.5 6.5 1.5 8 1.5 8 c 1.5 17 l 1.5 18.5 3 18.5 3 18.5 c h B\n';
      s += '4.5 15 m 15.5 15 l 4.5 12.5 m 15.5 12.5 l 4.5 10 m 11.5 10 l S\n';
      break;
    case 'Key':
      s += circlePath(5.5, 10, 4.5) + circlePath(5, 10, 1.5);
      s += '9.5 11.2 m 18.5 11.2 l 18.5 8.8 l 17 8.8 l 17 6 l 15 6 l 15 8.8 l 13.5 8.8 l 13.5 6.8 l 11.5 6.8 l 11.5 8.8 l 9.5 8.8 l h B*\n';
      break;
    case 'Help': s += circlePath(10, 10, 8.5) + 'B\n1.6 w 7 12.8 m 7 15.6 13 15.6 13 12.8 c 13 10.6 10 10.8 10 8.2 c S\n10 5 m 10 5.1 l S\n'; break;
    case 'Insert': s += '1.5 3 m 10 18 l 18.5 3 l 14.5 3 l 10 11 l 5.5 3 l h B\n'; break;
    case 'NewParagraph': s += '3.5 9 m 10 18.5 l 16.5 9 l h B\n3 2 14 4 re B\n'; break;
    case 'Paragraph':
      s += '11 18.5 m 7 18.5 4 16.3 4 13.2 c 4 10.1 7 8 11 8 c h B\n';
      s += '11 18.5 m 16 18.5 l 16 1.5 l 14 1.5 l 14 16.5 l 13 16.5 l 13 1.5 l 11 1.5 l h B\n';
      break;
    case 'Check': s += '1.5 10.5 m 4.5 13.5 l 8 9.5 l 16 18.5 l 18.5 15.5 l 8 3.5 l h B\n'; break;
    case 'Circle': s += circlePath(10, 10, 8.5) + circlePath(10, 10, 5) + 'B*\n'; break;
    case 'Cross': s += '4 1.5 m 10 7.5 l 16 1.5 l 18.5 4 l 12.5 10 l 18.5 16 l 16 18.5 l 10 12.5 l 4 18.5 l 1.5 16 l 7.5 10 l 1.5 4 l h B\n'; break;
    case 'CrossHairs': s += circlePath(10, 10, 7) + circlePath(10, 10, 4.5) + 'B*\n1.2 w 10 0.5 m 10 19.5 l 0.5 10 m 19.5 10 l S\n'; break;
    case 'Star': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const r = i % 2 === 0 ? 9.5 : 3.9, a = Math.PI / 2 + i * Math.PI / 5; pts.push(`${n(10 + r * Math.cos(a))} ${n(9.5 + r * Math.sin(a))}`); }
      s += `${pts[0]} m ${pts.slice(1).join(' l ')} l h B\n`;
      break;
    }
    case 'RightArrow': s += '1.5 7 m 11 7 l 11 2.5 l 18.5 10 l 11 17.5 l 11 13 l 1.5 13 l h B\n'; break;
    case 'UpArrow': s += '7 1.5 m 7 11 l 2.5 11 l 10 18.5 l 17.5 11 l 13 11 l 13 1.5 l h B\n'; break;
    default:
      s += '3 19 m 13 19 l 17 15 l 17 1 l 3 1 l h B\n13 19 m 13 15 l 17 15 l S\n';
      s += '5.5 12 m 14.5 12 l 5.5 9 m 14.5 9 l 5.5 6 m 11.5 6 l S\n';
  }
  return s;
}

/** modify.rs `rich_text`: /DS and /RC written from a text box's plain /Contents, /DA and /Q. */
export function richText(d) {
  const t = textOf(d.Contents) ?? '';
  const [col, size] = parseDa(d);
  const hex = '#' + col.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).toUpperCase().padStart(2, '0')).join('');
  const align = {1: 'center', 2: 'right'}[int(d, 'Q')] ?? 'left';
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = t.split('\n').map(line => `<p dir="ltr">${esc(line.replace(/\r$/, ''))}</p>`).join('');
  const style = `font-size:${n(size)}pt;text-align:${align};color:${hex};font-weight:normal;font-style:normal;font-family:Helvetica;font-stretch:normal`;
  d.DS = textObj(`font: Helvetica ${n(size)}pt; text-align:${align}; color:${hex}`);
  d.RC = textObj(`<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:spec="2.0.2" style="${style}">${body}</body>`);
}

