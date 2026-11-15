// The content interpreter of the text editor: a page's content streams read into the text-showing operators with their text, font, box and
// baseline (Shown), then joined into editable lines (TextLine) with the operators each came from.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/text/interp.rs   TextState (of, paint_ops, ops), Paint, Gs (apply), Origin, direction, to_frame, union, Ts, select_gs, dash/cap
//                                    parsing, Shown, Pen (after, continues), typical_tracking, tj_tracking, positioned_tracking, Carry,
//                                    MarkedContent (begin, end: /ActualText), show_text, interpret (BMC/BDC /PCSoft /PCHard, q/Q, cm, BT, colours,
//                                    Tf, spacing, gs, Td/TD/Tm/T*, Tj/TJ/'/")
//   crates/edit/src/text/lines.rs    fill_color, text_lines_in (a line = runs on one baseline in one stream piece), compatible_word
//   crates/edit/src/text/fallback.rs same_font, same_paint
// Differences (docs/spec/patches/folio/edit.json): the page's streams are parsed one by one and interpreted as one stream (upstream joins their
// bytes first, so an operator split between two streams is not read); form XObjects are not walked (their text is not listed); right-to-left
// reordering, Indic visual order and vertical writing are not translated, so a line with such text is listed but refused for editing.
// No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFArray, PDFRef, PDFNumber} from 'pdf-lib';
import {parseContent, mul, at, invert} from './redact-content.mjs';
import {contents, decoded} from './edit-place.mjs';
import {Metrics, fontDictOf, sameBaseFont} from './text-font.mjs';

const N = s => PDFName.of(s);
const ID = [1, 0, 0, 1, 0, 0];
const MAX_PAGE_TEXT = 16 << 20;
const MAX_DASH = 32;
const MAX_GS = 32;

export class TextError extends Error {
  constructor(message, code = 'invalid_params') { super(message); this.name = 'TextError'; this.code = code; }
}

// ── operands ───────────────────────────────────────────────────────────────────────────────────

export const numA = (op, i) => (op.args[i]?.k === 'num' ? op.args[i].v : undefined);
export const nameA = (op, i) => (op.args[i]?.k === 'name' ? op.args[i].v : undefined);
const numsOf = (op, n) => { const v = []; for (let i = 0; i < n; i++) { const x = numA(op, i); if (x === undefined) return null; v.push(x); } return v; };
export const mk = {
  num: v => ({k: 'num', v}),
  name: v => ({k: 'name', v}),
  str: b => ({k: 'str', b: b instanceof Uint8Array ? b : Uint8Array.from(b)}),
  arr: a => ({k: 'arr', a}),
  dict: entries => ({k: 'dict', entries}),
  op: (op, ...args) => ({op, args}),
};

export const direction = m => {
  const [x, y] = [m[0], m[1]];
  const length = Math.hypot(x, y);
  return Number.isFinite(length) && length > 1e-9 ? [x / length, y / length] : [1, 0];
};
export const toFrame = (dir, p) => [p[0] * dir[0] + p[1] * dir[1], p[1] * dir[0] - p[0] * dir[1]];
export const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const boxOf = points => points.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);

/** fill_color: the RGB a fill operator list sets. */
export function fillColor(fill) {
  const op = [...fill].reverse().find(o => ['g', 'rg', 'k', 'sc', 'scn'].includes(o.op));
  if (!op) return [0, 0, 0];
  const c = i => Math.min(1, Math.max(0, numA(op, i) ?? 0));
  let space = op.op;
  if (op.op === 'sc' || op.op === 'scn') space = op.args.length === 1 ? 'g' : op.args.length === 3 ? 'rg' : op.args.length === 4 ? 'k' : null;
  if (space === 'g') { const v = c(0); return [v, v, v]; }
  if (space === 'rg') return [c(0), c(1), c(2)];
  if (space === 'k') { const [cc, m, y, k] = [numA(op, 0) ?? 0, numA(op, 1) ?? 0, numA(op, 2) ?? 0, numA(op, 3) ?? 0]; return [(1 - cc) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }
  return [0, 0, 0];
}

// ── states ─────────────────────────────────────────────────────────────────────────────────────

const sameOps = (a, b) => a.length === b.length && a.every((o, i) => o.op === b[i].op && JSON.stringify(o.args) === JSON.stringify(b[i].args));
const sameDash = (a, b) => a[1] === b[1] && a[0].length === b[0].length && a[0].every((v, i) => v === b[0][i]);

/** TextState::of: the text and graphics state captured for rewriting. */
export function textStateOf(ts) {
  return {
    font: ts.font ? [ts.fontName, ts.size] : null, charSpacing: ts.charSpacing, wordSpacing: ts.wordSpacing, scale: ts.scale, leading: ts.leading, rise: ts.rise,
    fill: ts.fill.slice(), renderMode: ts.renderMode, stroke: ts.stroke.slice(), lineWidth: ts.lineWidth, extGState: ts.extGState.slice(), dash: [ts.dash[0].slice(), ts.dash[1]], lineCap: ts.lineCap,
  };
}

/** TextState::paint_ops: what changes how text is painted from `current` to `state` (ExtGStates, stroke colour, width, a visible mode). */
export function paintOps(state, current) {
  const v = [];
  let shared = 0;
  while (shared < state.extGState.length && shared < current.extGState.length && state.extGState[shared] === current.extGState[shared]) shared++;
  for (const name of state.extGState.slice(shared)) v.push(mk.op('gs', mk.name(name)));
  const reselected = v.length > 0;
  if (!sameOps(state.stroke, current.stroke)) {
    if (!state.stroke.length) v.push(mk.op('G', mk.num(0)));
    else v.push(...state.stroke);
  }
  const width = state.lineWidth ?? 1;
  if (reselected || width !== (current.lineWidth ?? 1)) v.push(mk.op('w', mk.num(width)));
  if (state.renderMode >= 0 && state.renderMode <= 2 && state.renderMode !== current.renderMode) v.push(mk.op('Tr', mk.num(state.renderMode)));
  return v;
}

/** TextState::ops: the operators that set this state inside a text object. */
export function stateOps(state) {
  const v = [];
  if (state.font) v.push(mk.op('Tf', mk.name(state.font[0]), mk.num(state.font[1])));
  v.push(mk.op('Tc', mk.num(state.charSpacing)), mk.op('Tw', mk.num(state.wordSpacing)), mk.op('Tz', mk.num(state.scale * 100)),
    mk.op('TL', mk.num(state.leading)), mk.op('Ts', mk.num(state.rise)), ...state.fill);
  return v;
}

const newTs = () => ({
  ctm: ID, fill: [], font: null, fontName: null, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0, renderMode: 0,
  gs: {fillAlpha: 1, strokeAlpha: 1, blend: 'Normal', softMask: null}, vertical: null, unreadable: null, stroke: [], lineWidth: null, extGState: [], dash: [[], 0], lineCap: 0,
});
const cloneTs = ts => ({...ts, fill: ts.fill.slice(), stroke: ts.stroke.slice(), gs: {...ts.gs}, extGState: ts.extGState.slice(), dash: [ts.dash[0].slice(), ts.dash[1]]});

function selectGs(list, name) {
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  if (list.length >= MAX_GS) list.shift();
  list.push(name);
}

const dashOf = (context, array, phase) => {
  const a = array instanceof PDFArray ? array.asArray().map(x => { const v = context.lookup(x); return v instanceof PDFNumber ? v.asNumber() : NaN; }) : null;
  const p = context.lookup(phase);
  if (!a || a.length > MAX_DASH || a.some(x => !Number.isFinite(x)) || !(p instanceof PDFNumber)) return null;
  return [a, p.asNumber()];
};

function applyGs(context, ts, params) {
  const num = k => { const v = context.lookup(params.get(N(k))); return v instanceof PDFNumber && Number.isFinite(v.asNumber()) ? v.asNumber() : undefined; };
  if (num('ca') !== undefined) ts.gs.fillAlpha = num('ca');
  if (num('CA') !== undefined) ts.gs.strokeAlpha = num('CA');
  const bm = context.lookup(params.get(N('BM')));
  const first = bm instanceof PDFName ? bm.decodeText() : bm instanceof PDFArray ? bm.asArray().map(x => context.lookup(x)).find(x => x instanceof PDFName)?.decodeText() : undefined;
  if (first) ts.gs.blend = first === 'Compatible' ? 'Normal' : first;
  const raw = params.get(N('SMask'));
  if (raw !== undefined) {
    const resolved = context.lookup(raw);
    if (resolved instanceof PDFName) ts.gs.softMask = null;
    else if (raw instanceof PDFRef) ts.gs.softMask = `ref:${raw.objectNumber}`;
    else if (resolved instanceof PDFDict) ts.gs.softMask = 'dict';
  }
  const lw = num('LW');
  if (lw !== undefined) ts.lineWidth = lw;
  const d = context.lookup(params.get(N('D')));
  if (d instanceof PDFArray) { const dash = dashOf(context, context.lookup(d.get(0)), d.get(1)); if (dash) ts.dash = dash; }
  const lc = num('LC');
  if (lc !== undefined && lc >= 0 && lc <= 2 && Number.isInteger(lc)) ts.lineCap = lc;
}

const paintKey = (layers, gs) => JSON.stringify([layers, gs.fillAlpha, gs.strokeAlpha, gs.blend, gs.softMask]);

// ── runs ───────────────────────────────────────────────────────────────────────────────────────

/** Where the previous run of a line ended (Pen::after). */
function penAfter(s) {
  const [dir, , end, across] = spanOf(s);
  return {bt: s.bt, dir, across, end, size: Math.max(s.size, 1), vertical: s.state.vertical !== null};
}
function spanOf(s) {
  const m = mul(s.tm, s.state.ctm);
  const dir = s.state.vertical !== null ? direction([m[2] * Math.sign(s.state.vertical), m[3] * Math.sign(s.state.vertical), 0, 0, 0, 0]) : direction(m);
  const [start, across] = toFrame(dir, [s.startX, s.baseline]);
  return [dir, start, toFrame(dir, [s.endX, s.endY])[0], across];
}
/** Pen::continues: could `s` continue the line on geometry alone (same baseline, at most `reach` sizes after the end)? Also the gap. */
function penContinues(pen, s, reach) {
  const [dir, start, , across] = spanOf(s);
  const gap = start - pen.end;
  let same = Math.abs(dir[0] - pen.dir[0]) < 1e-3 && Math.abs(dir[1] - pen.dir[1]) < 1e-3;
  same = same && pen.vertical === (s.state.vertical !== null);
  return [same && Math.abs(across - pen.across) < pen.size * 0.3 && gap > -pen.size && gap < pen.size * reach, gap];
}

function typicalTracking(gaps, limit) {
  if (gaps.length < 3) return 0;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const v = sorted[Math.floor(gaps.length / 3)];
  return Number.isFinite(v) && v <= limit ? Math.max(v, 0) : 0;
}

function tjTracking(pieces, m, size, scale) {
  const gaps = [];
  let previous = false, gap = 0;
  for (const piece of pieces) {
    if (piece.k === 'str') {
      for (const {code, len} of m.codes(piece.b)) {
        const t = m.textOf(code);
        const blank = m.isSpace(code, len) || (t !== null && t !== '' && /^\s+$/.test(t));
        if (previous && !blank) gaps.push(gap);
        previous = !blank;
        gap = 0;
      }
    } else if (piece.k === 'num') gap += -piece.v / 1000 * size * scale;
  }
  return typicalTracking(gaps, size * Math.abs(scale) * 0.5);
}

function positionedTracking(shown) {
  let start = 0;
  while (start < shown.length) {
    let end = start + 1;
    while (end < shown.length) {
      const [prev, next] = [shown[end - 1], shown[end]];
      if (prev.glyphCount !== 1 || next.glyphCount !== 1 || prev.font !== next.font || prev.scope !== next.scope || Math.abs(prev.size - next.size) > 0.01
        || prev.state.charSpacing !== next.state.charSpacing || prev.state.scale !== next.state.scale || !penContinues(penAfter(prev), next, 1.5)[0]) break;
      end++;
    }
    const run = shown.slice(start, end);
    if (run.length > 1) {
      const gaps = [];
      for (let k = 1; k < run.length; k++) if (run[k - 1].text.trim() && run[k].text.trim()) gaps.push(penContinues(penAfter(run[k - 1]), run[k], 0)[1]);
      const tracking = typicalTracking(gaps, run[0].size * Math.abs(run[0].state.scale) * 0.5);
      for (let k = 1; k < run.length; k++) run[k].tracking = tracking;
    }
    start = end;
  }
}

/** The text-showing operator at `i`, read into a Shown (show_text). `st` holds the running matrices. */
function showText(op, i, st) {
  const {ts} = st;
  if (op.op === "'" || op.op === '"') {
    if (op.op === '"') { ts.wordSpacing = numA(op, 0) ?? ts.wordSpacing; ts.charSpacing = numA(op, 1) ?? ts.charSpacing; }
    st.tlm = mul([1, 0, 0, 1, 0, -ts.leading], st.tlm);
    st.tm = st.tlm;
  }
  if (!ts.font) return;
  const m = ts.font;
  const pieces = op.op === 'TJ' ? (op.args.at(-1)?.k === 'arr' ? op.args.at(-1).a : []) : (op.args.length ? [op.args.at(-1)] : []);
  const tracking = op.op === 'TJ' ? tjTracking(pieces, m, ts.size, ts.scale) : 0;
  const trm0 = mul(st.tm, ts.ctm);
  const start = at(trm0, 0, ts.rise);
  let text = '', decodable = true, xText = 0, yText = 0, half = 0, inWord = false, glyphCount = 0;
  const vertical = ts.vertical;
  const words = [];
  for (const p of pieces) {
    if (p.k === 'str') {
      for (const {code, len} of m.codes(p.b)) {
        glyphCount++;
        const shown = m.textOf(code);
        const blank = m.isSpace(code, len) || (shown !== null && shown !== '' && /^\s+$/.test(shown));
        if (shown !== null) {
          st.carry.textLeft -= shown.length;
          if (st.carry.textLeft < 0) throw new TextError("the page's text is too large to read");
          text += shown;
        } else decodable = false;
        const spacing = ts.charSpacing + (m.isSpace(code, len) ? ts.wordSpacing : 0);
        if (vertical !== null) {
          half = Math.max(half, Math.abs(m.width(code) * ts.size * ts.scale) / 2);
          if (!blank) {
            const inkEnd = yText + vertical * ts.size;
            const [lo, hi] = [Math.min(yText, inkEnd), Math.max(yText, inkEnd)];
            if (inWord && words.length) words[words.length - 1] = [Math.min(words.at(-1)[0], lo), Math.max(words.at(-1)[1], hi)]; else words.push([lo, hi]);
          }
          inWord = !blank;
          yText += vertical * ts.size + spacing;
          continue;
        }
        if (!blank) {
          const inkEnd = xText + m.width(code) * ts.size * ts.scale;
          const [lo, hi] = [Math.min(xText, inkEnd), Math.max(xText, inkEnd)];
          if (inWord && words.length) words[words.length - 1] = [Math.min(words.at(-1)[0], lo), Math.max(words.at(-1)[1], hi)]; else words.push([lo, hi]);
        }
        inWord = !blank;
        xText += (m.width(code) * ts.size + ts.charSpacing + (m.isSpace(code, len) ? ts.wordSpacing : 0)) * ts.scale;
      }
    } else if (p.k === 'num') {
      if (vertical !== null) {
        const dy = -p.v / 1000 * ts.size;
        if (-dy > ts.size * 0.2 && !text.endsWith(' ')) text += ' ';
        if (Math.abs(dy) > Math.abs(ts.size) * 0.2) inWord = false;
        yText += dy;
        continue;
      }
      const dx = -p.v / 1000 * ts.size * ts.scale;
      const em = Math.abs(ts.size * ts.scale);
      if (dx - tracking > em * 0.2 && !text.endsWith(' ')) text += ' ';
      if (dx - tracking > em * 0.2 || dx < -em * 0.2) inWord = false;
      xText += dx;
    }
  }
  st.tm = mul([1, 0, 0, 1, xText, yText], st.tm);
  const end = at(mul(st.tm, ts.ctm), 0, ts.rise);
  const span = (a, b) => (vertical !== null
    ? [at(trm0, -half, ts.rise + a), at(trm0, half, ts.rise + a), at(trm0, -half, ts.rise + b), at(trm0, half, ts.rise + b)]
    : [at(trm0, a, ts.rise + m.descent * ts.size), at(trm0, b, ts.rise + m.descent * ts.size), at(trm0, a, ts.rise + m.ascent * ts.size), at(trm0, b, ts.rise + m.ascent * ts.size)]);
  const corners = span(0, vertical !== null ? yText : xText);
  const rect = boxOf(corners);
  const dir = direction(trm0);
  const frame = boxOf(corners.map(p => toFrame(dir, p)));
  const ink = words.map(([a, b]) => boxOf(span(a, b)));
  const sizeUser = Math.hypot(trm0[2], trm0[3]) * ts.size;
  if (!pieces.some(p => p.k === 'str' && p.b.length)) return;
  const tmStart = [st.tm[0], st.tm[1], st.tm[2], st.tm[3], st.tm[4] - xText * st.tm[0] - yText * st.tm[2], st.tm[5] - xText * st.tm[1] - yText * st.tm[3]];
  st.out.push({
    op: i, extraOps: [], glyphCount, advance: vertical !== null ? yText * ts.scale : xText, tracking: 0, tm: tmStart, tlm: st.tlm.slice(),
    state: cloneTs(ts), btOp: st.atBt.op, btState: st.atBt.state, text, rect, frame, ink, baseline: start[1], startX: start[0], endX: end[0], endY: end[1], bt: st.bt,
    font: ts.fontName, baseFont: m.baseFont, size: sizeUser > 0 ? sizeUser : ts.size, bold: m.bold, italic: m.italic, decodable,
    scope: st.marked.regions.at(-1) ?? null, paint: paintKey(st.marked.layers.filter(Boolean), ts.gs), logicalOrder: false, actualText: false,
    softBreak: st.softBreak, hardBreak: st.hardBreak, softGap: st.softGap,
  });
}

/** MarkedContent: the regions, optional-content layers and /ActualText replacements around the runs. */
class MarkedContent {
  constructor() { this.regions = []; this.layers = []; this.actual = []; }

  begin(context, op, index, properties, shownCount, wantLogical = true) {
    const region = ['P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH'].includes(nameA(op, 0));
    this.regions.push(region ? index : this.regions.at(-1) ?? null);
    const layer = op.op === 'BDC' && nameA(op, 0) === 'OC';
    this.layers.push(layer ? (nameA(op, 1) ?? `@${index}`) : null);
    let list = null;
    if (properties) {
      const a = op.args[1];
      if (a?.k === 'name') { const d = context.lookup(properties.get(N(a.v))); list = d instanceof PDFDict ? d : null; }
    }
    let logical = null;
    if (!wantLogical) logical = null;
    else if (op.args[1]?.k === 'dict') { const e = op.args[1].entries.find(([k]) => k === 'ActualText'); if (e?.[1]?.k === 'str') logical = textOfString(e[1].b); }
    else if (list) { const v = context.lookup(list.get(N('ActualText'))); if (v && typeof v.decodeText === 'function') logical = v.decodeText(); }
    this.actual.push(logical === null ? null : {start: shownCount, open: index, text: logical});
  }

  end(index, shown) {
    this.regions.pop();
    this.layers.pop();
    const a = this.actual.pop();
    if (!a) return;
    const tail = shown.splice(Math.min(a.start, shown.length));
    if (!tail.length) return;
    const first = tail[0];
    for (const item of tail.slice(1)) {
      first.glyphCount += item.glyphCount;
      first.extraOps.push(item.op, ...item.extraOps);
      first.rect = union(first.rect, item.rect);
      first.frame = union(first.frame, item.frame);
      first.ink.push(...item.ink);
    }
    first.extraOps.push(a.open, index);
    first.logicalOrder = /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(a.text);
    first.actualText = true;
    first.text = a.text;
    first.startX = first.rect[0];
    first.endX = first.rect[2];
    first.endY = first.baseline;
    first.advance = (first.endX - first.startX) / Math.max(Math.abs(mul(first.tm, first.state.ctm)[0]), 1e-6);
    shown.push(first);
  }
}

/** A PDF text string (PDFDocEncoding or UTF-16BE with a BOM) as text. */
function textOfString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { let s = ''; for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]); return s; }
  return new TextDecoder('windows-1252').decode(bytes);
}

/** The page's content streams as operator lists (each op tagged with its stream) and the shown runs. */
function* interpretSteps(context, ops, resources, {actualText = true} = {}) {
  const fontCache = new Map();
  const states = resources instanceof PDFDict ? context.lookup(resources.get(N('ExtGState'))) : null;
  const properties = resources instanceof PDFDict ? context.lookup(resources.get(N('Properties'))) : null;
  const out = [];
  let ts = newTs();
  const carry = {textLeft: MAX_PAGE_TEXT};
  let atBt = {op: 0, state: cloneTs(ts)};
  const stack = [];
  const st = {ts, tm: ID, tlm: ID, atBt, bt: 0, marked: new MarkedContent(), carry, out, softBreak: false, hardBreak: false, softGap: 1};
  for (let i = 0; i < ops.length; i++) {
    // A large page is read in slices: the caller may let the window breathe between them.
    if (i > 0 && i % SLICE === 0) yield;
    const op = ops[i];
    switch (op.op) {
      case 'BMC': case 'BDC':
        if (nameA(op, 0) === 'PCSoft') {
          st.softBreak = true; st.hardBreak = false;
          const d = op.args[1]?.k === 'dict' ? op.args[1].entries.find(([k]) => k === 'N')?.[1] : null;
          st.softGap = d?.k === 'num' && Number.isInteger(d.v) && d.v >= 0 ? d.v : 1;
          carry.textLeft -= st.softGap;
          if (carry.textLeft < 0) throw new TextError("the page's text is too large to read");
        } else if (nameA(op, 0) === 'PCHard') { st.hardBreak = true; st.softBreak = false; }
        st.marked.begin(context, op, i, actualText && properties instanceof PDFDict ? properties : null, out.length, actualText);
        break;
      case 'EMC': st.marked.end(i, out); break;
      case 'q': stack.push([cloneTs(st.ts), st.tm, st.tlm]); break;
      case 'Q': { const s = stack.pop(); if (s) { st.ts = s[0]; st.tm = s[1]; st.tlm = s[2]; } break; }
      case 'cm': { const v = numsOf(op, 6); if (v) st.ts.ctm = mul(v, st.ts.ctm); break; }
      case 'BT': st.tm = ID; st.tlm = ID; st.bt++; st.atBt = {op: i, state: cloneTs(st.ts)}; break;
      case 'g': case 'rg': case 'k': case 'cs': st.ts.fill = [op]; break;
      case 'sc': case 'scn': st.ts.fill = st.ts.fill.filter(o => o.op === 'cs'); st.ts.fill.push(op); break;
      case 'G': case 'RG': case 'K': case 'CS': st.ts.stroke = [op]; break;
      case 'SC': case 'SCN': st.ts.stroke = st.ts.stroke.filter(o => o.op === 'CS'); st.ts.stroke.push(op); break;
      case 'w': { const v = numA(op, 0); if (v !== undefined && Number.isFinite(v)) st.ts.lineWidth = v; break; }
      case 'd': { const dash = dashOf(context, arrToPdf(context, op.args[0]), context.obj(numA(op, 1) ?? NaN)); if (dash) st.ts.dash = dash; break; }
      case 'J': { const v = numA(op, 0); if (v !== undefined && Number.isInteger(v) && v >= 0 && v <= 2) st.ts.lineCap = v; break; }
      case 'Tf': {
        st.ts.size = numA(op, 1) ?? st.ts.size;
        const name = nameA(op, 0);
        if (name !== undefined) {
          if (!fontCache.has(name)) {
            const dict = fontDictOf(context, resources, name);
            let metrics;
            try { metrics = dict ? Metrics.fromDict(context, dict) : Metrics.fallback(); } catch { metrics = Metrics.fallback(); }
            fontCache.set(name, metrics);
          }
          const metrics = fontCache.get(name);
          st.ts.font = metrics;
          st.ts.fontName = name;
          st.ts.vertical = metrics.vertical;
          st.ts.unreadable = metrics.unreadable;
        }
        break;
      }
      case 'Tc': st.ts.charSpacing = numA(op, 0) ?? 0; break;
      case 'Tw': st.ts.wordSpacing = numA(op, 0) ?? 0; break;
      case 'Tz': st.ts.scale = (numA(op, 0) ?? 100) / 100; break;
      case 'TL': st.ts.leading = numA(op, 0) ?? 0; break;
      case 'Ts': st.ts.rise = numA(op, 0) ?? 0; break;
      case 'Tr': st.ts.renderMode = op.args[0]?.k === 'num' && Number.isInteger(op.args[0].v) ? op.args[0].v : -1; break;
      case 'gs': {
        const name = nameA(op, 0);
        if (name !== undefined) {
          selectGs(st.ts.extGState, name);
          const params = states instanceof PDFDict ? context.lookup(states.get(N(name))) : null;
          if (params instanceof PDFDict) applyGs(context, st.ts, params);
        }
        break;
      }
      case 'Td': case 'TD': {
        const v = numsOf(op, 2);
        if (v) { if (op.op === 'TD') st.ts.leading = -v[1]; st.tlm = mul([1, 0, 0, 1, v[0], v[1]], st.tlm); st.tm = st.tlm; }
        break;
      }
      case 'Tm': { const v = numsOf(op, 6); if (v) { st.tlm = v; st.tm = v; } break; }
      case 'T*': st.tlm = mul([1, 0, 0, 1, 0, -st.ts.leading], st.tlm); st.tm = st.tlm; break;
      case 'Tj': case 'TJ': case "'": case '"': {
        const before = out.length;
        showText(op, i, st);
        if (out.length > before) { st.softBreak = false; st.hardBreak = false; st.softGap = 1; }
        break;
      }
      default: break;
    }
  }
  positionedTracking(out);
  return out;
}

/** Operators interpreted between two chances to yield. */
export const SLICE = 20_000;
/** The runs of the page's operators, all at once. */
export function interpret(context, ops, resources, options) {
  const run = interpretSteps(context, ops, resources, options);
  for (let r = run.next(); ; r = run.next()) if (r.done) return r.value;
}
/** The same, in slices: `tick` (default: a timer) is awaited between them, so a large page does not freeze the window. */
export async function interpretAsync(context, ops, resources, options, tick = nextTick) {
  const run = interpretSteps(context, ops, resources, options);
  for (let r = run.next(); ; r = run.next()) { if (r.done) return r.value; await tick(); }
}
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

const arrToPdf = (context, arg) => (arg?.k === 'arr' ? context.obj(arg.a.map(x => (x.k === 'num' ? x.v : NaN))) : null);

// ── lines ──────────────────────────────────────────────────────────────────────────────────────

const sameFont = (line, s) => line.font === s.font || sameBaseFont(line.baseFont, s.baseFont);
const sameStatePaint = (line, ts) => {
  const a = line.origin.state;
  const visible = m => m >= 0 && m <= 2;
  const sameMode = a.renderMode === ts.renderMode || !visible(a.renderMode) || !visible(ts.renderMode);
  const stroked = (a.renderMode === 1 || a.renderMode === 2) && (ts.renderMode === 1 || ts.renderMode === 2);
  const outline = sameOps(a.stroke, ts.stroke) && a.lineWidth === ts.lineWidth && sameDash(a.dash, ts.dash) && a.lineCap === ts.lineCap;
  return sameMode && (!stroked || outline);
};

function compatibleWord(line, s) {
  const within = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) < tol);
  const [a, b] = [line.origin.state, textStateOf(s.state)];
  const em = Math.abs(s.state.size) / 1000;
  return line.scope === s.scope && line.paint === s.paint && within(line.origin.tm.slice(0, 4), s.tm.slice(0, 4), 1e-6) && within(line.origin.ctm, s.state.ctm, 1e-6)
    && within([a.charSpacing, a.wordSpacing], [b.charSpacing, b.wordSpacing], Math.max(em, 1e-6)) && within([a.scale, a.rise], [b.scale, b.rise], 1e-6) && sameOps(a.fill, b.fill);
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const INDIC = /[ऀ-ൿ]/;

/** A reason a line can't be edited, or null. */
function refusalOf(line) {
  if (line.unreadableMode) return line.unreadableMode;
  if (line.vertical) return 'vertical (top-to-bottom) text is not edited here';
  if (RTL.test(line.text)) return 'right-to-left text is not edited here';
  if (INDIC.test(line.text) && line.visualOrder) return 'text in a legacy Indic font is not edited here';
  if (!line.decodable) return "some of this text can't be read from the file's font, so it can't be edited";
  if (line.type3) return 'text drawn with a Type 3 font is not edited here';
  return null;
}

/** text_lines_in: the lines the page's glyphs show, in content order. */
export function buildLines(shown, ops) {
  const lines = [];
  let last = null;
  for (const s of shown) {
    const si = ops[s.op]?.stream ?? 0;
    let joins = false;
    if (last) {
      const l = lines.at(-1);
      const bt = last.pen.bt;
      const [near, gap] = penContinues(last.pen, s, bt === s.bt ? 3 : 1.5);
      const blank = !s.text.trim();
      joins = last.si === si && !!l && l.scope === s.scope && l.paint === s.paint && l.logicalOrder === s.logicalOrder
        && (bt === s.bt || compatibleWord(l, s))
        && (blank || sameFont(l, s))
        && (blank || (Math.abs(s.size - l.size) < 0.01 && s.bold === l.bold && s.italic === l.italic && fillColor(s.state.fill).every((c, k) => c === l.color[k]) && sameStatePaint(l, s.state)))
        && near && (s.state.renderMode !== 3 || gap < last.pen.size * 0.6);
    }
    if (joins) {
      const l = lines.at(-1);
      const gap = penContinues(last.pen, s, 0)[1];
      const spaced = gap - s.tracking > l.size * Math.abs(s.state.scale) * 0.2 && !l.text.endsWith(' ') && !s.text.startsWith(' ');
      if (spaced) l.text += ' ';
      l.text += s.text;
      l.rect = union(l.rect, s.rect);
      l.frame = union(l.frame, s.frame);
      l.ink.push(...s.ink);
      l.runs.push([s.text, l.ink.length, spaced]);
      l.ops.push(s.op, ...s.extraOps);
      l.decodable &&= s.decodable;
      l.actualText ||= s.actualText;
      l.clips ||= s.state.renderMode >= 4;
      l.unreadableMode ??= s.state.unreadable;
      l.vertical ||= s.state.vertical !== null;
    } else {
      const m = mul(s.tm, s.state.ctm);
      lines.push({
        text: s.text, rect: s.rect.slice(), frame: s.frame.slice(), ink: s.ink.slice(), font: s.font, baseFont: s.baseFont, size: s.size, bold: s.bold, italic: s.italic,
        color: fillColor(s.state.fill), decodable: s.decodable, visualOrder: false, stream: si, scope: s.scope, paint: s.paint, logicalOrder: s.logicalOrder,
        actualText: s.actualText, clips: s.state.renderMode >= 4, unreadableMode: s.state.unreadable, vertical: s.state.vertical !== null, type3: !!s.state.font?.type3,
        runs: [[s.text, s.ink.length, false]], softBreak: s.softBreak, hardBreak: s.hardBreak, softGap: s.softGap, ops: [s.op, ...s.extraOps],
        origin: {tm: s.tm.slice(), tlm: s.tlm.slice(), k: Math.hypot(m[2], m[3]), ctm: s.state.ctm.slice(), baseline: s.baseline, x: s.startX, state: textStateOf(s.state), btOp: s.btOp, btState: textStateOf(s.btState)},
      });
    }
    last = {si, pen: penAfter(s)};
  }
  const kept = lines.filter(l => l.text.trim());
  for (const l of kept) l.refusal = refusalOf(l);
  return kept;
}

// TextLine's derived geometry.
export const lineDirection = l => direction(mul(l.origin.tm, l.origin.ctm));
export const lineRotation = l => { const m = mul(l.origin.tm, l.origin.ctm); return Math.atan2(m[1], m[0]) * 180 / Math.PI; };
export const lineUpright = l => { const [x, y] = lineDirection(l); return Math.abs(x - 1) < 1e-3 && Math.abs(y) < 1e-3; };
export const frameOrigin = l => toFrame(lineDirection(l), [l.origin.x, l.origin.baseline]);
export const lineWrapLeading = l => (l.origin.state.leading > 0 ? l.origin.state.leading * l.origin.k : l.size * 1.2);

// ── reading a page ─────────────────────────────────────────────────────────────────────────────

/** The page's resources (own or inherited), or null. */
export function pageResources(page) {
  try { return page.node.Resources() ?? null; } catch { return null; }
}

/** The page's content streams: [{ref, bytes}] in order (a stream that does not decode is empty). */
export function pageStreams(doc, page, {limit = 128 * 1024 * 1024} = {}) {
  const list = contents(doc, page);
  const out = [];
  let total = 0;
  for (const ref of list) {
    const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    let bytes = new Uint8Array(0);
    try { bytes = decoded(s, limit) ?? bytes; } catch { throw new TextError('the page content is too large to read', 'too_large'); }
    total += bytes.length;
    if (total > limit) throw new TextError('the page content is too large to read', 'too_large');
    out.push({ref, bytes});
  }
  return out;
}

/**
 * Everything the editor knows about a page: the streams, their operators (tagged with the stream), the runs and the lines.
 * `lines` is the TextLine list of text_lines.
 */
export function readPage(doc, page, {actualText = true} = {}) {
  const streams = pageStreams(doc, page);
  const ops = [];
  streams.forEach((s, si) => { for (const op of parseContent(s.bytes)) { op.stream = si; ops.push(op); } });
  const resources = pageResources(page);
  const shown = interpret(doc.context, ops, resources, {actualText});
  const lines = buildLines(shown, ops);
  return {streams, ops, shown, lines, resources};
}

/** readPage in slices (a stream at a time, then the interpreter in SLICE-operator steps): the window stays responsive on a large page. */
export async function readPageAsync(doc, page, {actualText = true, tick = nextTick} = {}) {
  const streams = pageStreams(doc, page);
  const ops = [];
  for (let si = 0; si < streams.length; si++) {
    for (const op of parseContent(streams[si].bytes)) { op.stream = si; ops.push(op); }
    await tick();
  }
  const resources = pageResources(page);
  const shown = await interpretAsync(doc.context, ops, resources, {actualText}, tick);
  const lines = buildLines(shown, ops);
  return {streams, ops, shown, lines, resources};
}

export {invert};
